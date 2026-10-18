"""Conservative crop refinement; kept equivalent to smallPlayer.ts."""
import math
import numpy as np
from .model_outputs import validate_array


def small_player_crop(values, prompt=None):
    height, width = values.shape
    ys, xs = np.nonzero(values > 0)
    area = len(xs)
    if not area:
        return None
    left, top, right, bottom = (
        int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    )
    if (area > width * height * .015 or bottom - top > height * .4
            or right - left > width * .2):
        return None
    pad = max(8, math.ceil((bottom - top) * .5))
    x, y = max(0, left - pad), max(0, top - pad)
    w, h = min(width, right + pad) - x, min(height, bottom + pad) - y
    points, labels = [], []
    for part in range(3):
        first = top + (bottom - top) * part // 3
        last = top + (bottom - top) * (part + 1) // 3
        region = values[first:last, left:right]
        if region.size and region.max() > 0:
            py, px = np.unravel_index(region.argmax(), region.shape)
            points.append([
                (left + int(px) + .5 - x) / w, (first + int(py) + .5 - y) / h
            ])
            labels.append(1)
    unusable = area < 12 or bottom - top < 6 or right - left < 3
    for p, label in zip(
        (prompt or {}).get("points", []), (prompt or {}).get("labels", [])
    ):
        px, py = p[0] * width - x, p[1] * height - y
        if 0 <= px < w and 0 <= py < h:
            points.append([px / w, py / h])
            labels.append(label)
        elif label == 1:
            unusable = True
    return dict(x=x, y=y, width=w, height=h, points=points, labels=labels, unusable=unusable,
                box=[max(0, left - x - 2) / w, max(0, top - y - 2) / h,
                     min(w, right - x + 2) / w, min(h, bottom - y + 2) / h])


def source_crop(crop, width, height, source_width, source_height):
    x = math.floor(crop["x"] * source_width / width)
    y = math.floor(crop["y"] * source_height / height)
    return dict(x=x, y=y,
                width=math.ceil((crop["x"] + crop["width"]) * source_width / width) - x,
                height=math.ceil((crop["y"] + crop["height"]) * source_height / height) - y)


def accept_refinement(coarse, candidate, crop, owners, identity):
    height, width = coarse.shape
    x, y, w, h = (crop[k] for k in ("x", "y", "width", "height"))
    a, b = coarse[y:y+h, x:x+w] > 0, candidate > 0
    occupied = (owners[y:y+h, x:x+w] != 0) & (owners[y:y+h, x:x+w] != identity)
    original, refined = np.count_nonzero(a), np.count_nonzero(b)
    union, intersection = np.count_nonzero(a | b), np.count_nonzero(a & b)
    leaked = ((x > 0 and b[:, 0].any()) or (y > 0 and b[0].any()) or
              (x + w < width and b[:, -1].any()) or (y + h < height and b[-1].any()))
    if (not refined or not union or intersection / union < .6 or refined < original * .65
            or refined > original * 1.6
            or np.count_nonzero(b & ~a & occupied) > max(2, refined * .03)
            or np.count_nonzero(a & occupied) > max(2, original * .03)
            or leaked or not np.isfinite(candidate).all()):
        return None
    result = coarse.copy()
    result[y:y+h, x:x+w] = np.where(occupied, coarse[y:y+h, x:x+w], candidate)
    return result


class SmallPlayerRefiner:
    """Reuse the loaded SAM model; one crop feature set at a time, no new tracker."""
    def __init__(self, model):
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        self.predictor = SAM2ImagePredictor(model)
        # Match the video/browser PIL-bicubic path, rather than the image
        # predictor's different torchvision resize. Coordinate transforms stay native.
        self.predictor._transforms.forward = self._pixels

    def _pixels(self, image):
        import torch
        from PIL import Image
        image = np.array(Image.fromarray(image).resize((1024, 1024)))
        value = torch.from_numpy(image / 255.).permute(2, 0, 1).float()
        mean = torch.tensor([.485, .456, .406])[:, None, None]
        std = torch.tensor([.229, .224, .225])[:, None, None]
        return (value - mean) / std

    def refine(self, image, coarse, crop, owners, identity):
        height, width = coarse.shape
        region = source_crop(crop, width, height, image.shape[1], image.shape[0])
        x, y, w, h = (region[k] for k in ("x", "y", "width", "height"))
        try:
            self.predictor.set_image(image[y:y+h, x:x+w])
            masks, quality, low = self.predictor.predict(
                point_coords=np.array(crop["points"], dtype=np.float32) * [w, h],
                point_labels=np.array(crop["labels"], dtype=np.int32),
                box=np.array(crop["box"], dtype=np.float32) * [w, h, w, h],
                multimask_output=False, return_logits=True)
            validate_array(masks, (1, h, w), "refined mask")
            validate_array(quality, (1,), "refinement quality")
            validate_array(low, (1, 256, 256), "low-resolution mask")
            import torch
            candidate = torch.nn.functional.interpolate(
                torch.from_numpy(low[0])[None, None],
                size=(crop["height"], crop["width"]),
                mode="bilinear", align_corners=False)[0, 0].numpy()
            return accept_refinement(coarse, candidate, crop, owners, identity)
        finally:
            self.predictor.reset_predictor()
