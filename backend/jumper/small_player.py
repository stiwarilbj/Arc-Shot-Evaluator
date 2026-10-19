"""Conservative crop refinement; kept equivalent to smallPlayer.ts."""
import math
import numpy as np
from .correction_points import correction_prompt
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
    boundary = left==0 or top==0 or right==width or bottom==height
    small = area<=width*height*.015 and bottom-top<=height*.4 and right-left<=width*.2
    bounded_edge = boundary and area<=width*height*.35 and bottom-top<=height*.95 and right-left<=width*.85
    if not small and not bounded_edge:
        return None
    pad = max(8,min(32 if boundary else math.inf,math.ceil((bottom-top)*.5)))
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
        if 0 <= px <= w and 0 <= py <= h:
            points.append([px / w, py / h])
            labels.append(label)
        elif label == 1:
            unusable = True
    return dict(x=x, y=y, width=w, height=h, points=points, labels=labels, unusable=unusable,
                padding=[max(0,pad-left),max(0,pad-top),max(0,right+pad-width),max(0,bottom+pad-height)],
                box=[max(0, left - x - 2) / w, max(0, top - y - 2) / h,
                     min(w, right - x + 2) / w, min(h, bottom - y + 2) / h])


def source_crop(crop, width, height, source_width, source_height):
    x = math.floor(crop["x"] * source_width / width)
    y = math.floor(crop["y"] * source_height / height)
    return dict(x=x, y=y,
                width=math.ceil((crop["x"] + crop["width"]) * source_width / width) - x,
                height=math.ceil((crop["y"] + crop["height"]) * source_height / height) - y)


def padded_source_crop(crop,width,height,source_width,source_height):
    region=source_crop(crop,width,height,source_width,source_height)
    padding=[math.ceil(n*(source_height/height if i%2 else source_width/width))
             for i,n in enumerate(crop.get('padding',[0,0,0,0]))]
    return dict(**region,left=padding[0],top=padding[1],
                input_width=region['width']+padding[0]+padding[2],
                input_height=region['height']+padding[1]+padding[3])


def source_crop_prompt(crop, width, height, source_width, source_height):
    """Prompts refer to the rounded source crop actually supplied to SAM."""
    region = padded_source_crop(crop, width, height, source_width, source_height)
    def point(x, y):
        return [((crop["x"] + x * crop["width"]) * source_width / width - region["x"] + region["left"]) / region["input_width"],
                ((crop["y"] + y * crop["height"]) * source_height / height - region["y"] + region["top"]) / region["input_height"]]
    return dict(points=[point(*p) for p in crop["points"]], labels=crop["labels"],
                box=point(*crop["box"][:2]) + point(*crop["box"][2:]))


def project_refinement(values, crop, width, height, source_width, source_height):
    """Bilinear sampling at coarse pixel centers, excluding rounded crop margins."""
    region = padded_source_crop(crop, width, height, source_width, source_height)
    xs = np.clip((((crop["x"] + np.arange(crop["width"]) + .5) * source_width / width
                   - region["x"] + region["left"]) / region["input_width"]) * 256 - .5, 0, 255)
    ys = np.clip((((crop["y"] + np.arange(crop["height"]) + .5) * source_height / height
                   - region["y"] + region["top"]) / region["input_height"]) * 256 - .5, 0, 255)
    x0, y0 = np.floor(xs).astype(int), np.floor(ys).astype(int)
    x1, y1 = np.minimum(255, x0 + 1), np.minimum(255, y0 + 1)
    dx, dy = xs - x0, (ys - y0)[:, None]
    a = values[y0[:, None], x0] * (1 - dx) + values[y0[:, None], x1] * dx
    b = values[y1[:, None], x0] * (1 - dx) + values[y1[:, None], x1] * dx
    return (a * (1 - dy) + b * dy).astype(np.float32)


def accept_refinement(coarse, candidate, crop, owners, identity):
    height, width = coarse.shape
    x, y, w, h = (crop[k] for k in ("x", "y", "width", "height"))
    a, b = coarse[y:y+h, x:x+w] > 0, candidate > 0
    occupied = (owners[y:y+h, x:x+w] != 0) & (owners[y:y+h, x:x+w] != identity)
    original, refined = np.count_nonzero(a), np.count_nonzero(b)
    union, intersection = np.count_nonzero(a | b), np.count_nonzero(a & b)
    leaked = ((x > 0 and b[:, 0].any()) or (y > 0 and b[0].any()) or
              (x + w < width and b[:, -1].any()) or (y + h < height and b[-1].any()))
    edge = np.zeros(b.shape,dtype=bool)
    if x==0: edge[:,0]=True
    if y==0: edge[0]=True
    if x+w==width: edge[:,-1]=True
    if y+h==height: edge[-1]=True
    lost_visible_edge = np.any(a & ~b & edge)
    if (not refined or not union or intersection / union < .6 or refined < original * .65
            or refined > original * 1.6
            or np.count_nonzero(b & ~a & occupied) > max(2, refined * .03)
            or np.count_nonzero(a & occupied) > max(2, original * .03)
            or leaked or lost_visible_edge or not np.isfinite(candidate).all()):
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

    def refine(self, image, coarse, crop, owners, identity, frame=0):
        height, width = coarse.shape
        region = padded_source_crop(crop, width, height, image.shape[1], image.shape[0])
        x, y, w, h = (region[k] for k in ("x", "y", "width", "height"))
        prompt = correction_prompt(dict(frame=frame, **source_crop_prompt(crop, width, height, image.shape[1], image.shape[0])),
                                   identity, (region["input_width"],region["input_height"]), "detail crop")
        try:
            pixels=np.full((region['input_height'],region['input_width'],3),114,dtype=np.uint8)
            pixels[region['top']:region['top']+h,region['left']:region['left']+w]=image[y:y+h,x:x+w]
            self.predictor.set_image(pixels)
            masks, quality, low = self.predictor.predict(
                point_coords=np.array(prompt["points"], dtype=np.float32) * [region["input_width"], region["input_height"]],
                point_labels=np.array(prompt["labels"], dtype=np.int32),
                box=np.array(prompt["box"], dtype=np.float32) * [region["input_width"], region["input_height"], region["input_width"], region["input_height"]],
                multimask_output=False, return_logits=True)
            validate_array(masks, (1, region["input_height"], region["input_width"]), "refined mask")
            validate_array(quality, (1,), "refinement quality")
            validate_array(low, (1, 256, 256), "low-resolution mask")
            candidate = project_refinement(
                low[0], crop, width, height, image.shape[1], image.shape[0])
            return accept_refinement(coarse, candidate, crop, owners, identity)
        finally:
            self.predictor.reset_predictor()
