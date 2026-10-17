"""Private frame-based edits. Never imports or initializes a segmentation model."""

from __future__ import annotations
import math
from pathlib import Path
import subprocess
import cv2
import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from .video_validation import validate_finished_video, silhouette_proof

PROFILE = "silhouette-edited-v1"
PALETTE = "silhouette-palette-v1"


def frames(piece):
    return piece["freeze"] or math.ceil(
        (piece["end"] - piece["start"]) / piece["speed"]
    )


def length(project):
    return sum(frames(p) for p in project["pieces"])


def validate_project(p):
    def integer(n, low, high):
        return type(n) is int and low <= n <= high

    def framing(f):
        return (
            isinstance(f, dict)
            and all(
                type(f.get(k)) in (int, float) and math.isfinite(f[k])
                for k in ("zoom", "x", "y")
            )
            and 1 <= f["zoom"] <= 2
            and 0 <= f["x"] <= 1
            and 0 <= f["y"] <= 1
        )

    if not (
        isinstance(p, dict)
        and type(p.get("version")) is int
        and p["version"] == 1
        and integer(p.get("baseFrames"), 2, 1800)
        and p.get("baseMime") in ("video/mp4", "video/webm")
        and p.get("baseProfile") in ("palette", "legacy")
        and type(p.get("fadeIn")) is bool
        and type(p.get("fadeOut")) is bool
        and isinstance(p.get("pieces"), list)
        and 1 <= len(p["pieces"]) <= 100
        and isinstance(p.get("captions"), list)
        and len(p["captions"]) <= 100
    ):
        raise ValueError("Invalid edit project")
    ids = set()
    for piece in p["pieces"]:
        if not (
            isinstance(piece, dict)
            and isinstance(piece.get("id"), str)
            and 1 <= len(piece["id"]) <= 100
            and piece["id"] not in ids
            and integer(piece.get("start"), 0, p["baseFrames"] - 1)
            and integer(piece.get("end"), piece["start"] + 1, p["baseFrames"])
            and type(piece.get("speed")) in (int, float)
            and piece["speed"] in (0.5, 1, 2)
            and (
                piece.get("freeze") == 0
                and type(piece.get("freeze")) is int
                or integer(piece.get("freeze"), 15, 90)
            )
            and (not piece["freeze"] or piece["end"] == piece["start"] + 1)
            and framing(piece.get("from"))
            and framing(piece.get("to"))
        ):
            raise ValueError("Invalid timeline piece")
        ids.add(piece["id"])
    count = length(p)
    if not 2 <= count <= 1800:
        raise ValueError("Finished videos must be at most 60 seconds")
    ids = set()
    for c in p["captions"]:
        if not (
            isinstance(c, dict)
            and isinstance(c.get("id"), str)
            and 1 <= len(c["id"]) <= 100
            and c["id"] not in ids
            and isinstance(c.get("text"), str)
            and c["text"].strip()
            and len(c["text"]) <= 200
            and integer(c.get("start"), 0, count - 1)
            and integer(c.get("end"), c["start"] + 1, count)
            and c.get("size") in ("small", "medium", "large")
            and c.get("position") in ("top", "center", "bottom")
            and ("outside" not in c or type(c["outside"]) is bool)
        ):
            raise ValueError("Invalid timed caption")
        ids.add(c["id"])
    return p


def frame_state(p, index, clean=False):
    index = max(0, min(length(p) - 1, index))
    offset = 0
    for piece in p["pieces"]:
        count = frames(piece)
        if index < offset + count:
            local = index - offset
            ratio = local / (count - 1) if count > 1 else 0
            framing = {
                k: piece["from"][k] + (piece["to"][k] - piece["from"][k]) * ratio
                for k in ("zoom", "x", "y")
            }
            return {
                "source": (
                    piece["start"]
                    if piece["freeze"]
                    else min(
                        piece["end"] - 1,
                        piece["start"] + math.floor(local * piece["speed"]),
                    )
                ),
                "framing": {"zoom": 1, "x": 0.5, "y": 0.5} if clean else framing,
                "opacity": (
                    1
                    if clean
                    else min(
                        min(1, index / 7) if p["fadeIn"] else 1,
                        min(1, (length(p) - 1 - index) / 7) if p["fadeOut"] else 1,
                    )
                ),
                "captions": (
                    []
                    if clean
                    else [c for c in p["captions"] if c["start"] <= index < c["end"]]
                ),
            }
        offset += count
    raise ValueError("Missing timeline piece")


def draw_frame(image, p, index, clean=False):
    state = frame_state(p, index, clean)
    height, width = image.shape[:2]
    f = state["framing"]
    # Fractional crop in output pixel coordinates, no synthesized body motion.
    sw, sh = width / f["zoom"], height / f["zoom"]
    matrix = np.array(
        [
            [sw / width, 0, f["x"] * (width - sw)],
            [0, sh / height, f["y"] * (height - sh)],
        ],
        np.float32,
    )
    out = cv2.warpAffine(
        image,
        matrix,
        (width, height),
        flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
        borderMode=cv2.BORDER_REPLICATE,
    )
    out = np.rint(
        out.astype(np.float32) * state["opacity"] + 224 * (1 - state["opacity"])
    ).astype(np.uint8)
    if state["captions"]:
        im = Image.fromarray(out)
        draw = ImageDraw.Draw(im)
        font_path = (
            Path(__file__).resolve().parents[2]
            / "frontend/public/jumper/fonts/RobotoMono.ttf"
        )
        for c in state["captions"]:
            size = max(
                10,
                math.floor(
                    height * {"small": 0.045, "medium": 0.065, "large": 0.09}[c["size"]]
                    + 0.5
                ),
            )
            font = ImageFont.truetype(str(font_path), size)
            font.set_variation_by_axes([600])
            lines = []
            line = ""
            for char in " ".join(c["text"].splitlines()):
                if line and draw.textlength(line + char, font=font) > width * 0.88:
                    lines.append(line)
                    line = char
                else:
                    line += char
            if line:
                lines.append(line)
            lh = size * 1.25
            bh = lh * len(lines) + size * 0.5
            cy = (
                bh / 2 + height * 0.04
                if c["position"] == "top"
                else (
                    height - bh / 2 - height * 0.04
                    if c["position"] == "bottom"
                    else height / 2
                )
            )
            # Caption also shares the fade against the neutral background.
            overlay = Image.new("RGB", (width, height), (224, 224, 224))
            od = ImageDraw.Draw(overlay)
            od.rectangle(
                (width * 0.04, cy - bh / 2, width * 0.96, cy + bh / 2), fill="black"
            )
            for i, text in enumerate(lines):
                od.text(
                    (width / 2, cy + (i - (len(lines) - 1) / 2) * lh),
                    text,
                    font=font,
                    anchor="mm",
                    fill="white",
                )
            mask = Image.new("L", (width, height), 0)
            ImageDraw.Draw(mask).rectangle(
                (width * 0.04, cy - bh / 2, width * 0.96, cy + bh / 2),
                fill=round(255 * state["opacity"]),
            )
            im = Image.composite(overlay, im, mask)
            draw = ImageDraw.Draw(im)
        out = np.array(im)
    # Legacy codecs may introduce the small chroma error accepted by base
    # validation. Match the browser renderer's exact neutral output pixels.
    gray = np.rint(out.mean(axis=2)).astype(np.uint8)
    return np.repeat(gray[:, :, None], 3, axis=2)


def render(base: Path, project: dict, directory: Path, cancel, progress):
    validate_project(project)
    capture = cv2.VideoCapture(str(base))
    width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(
        capture.get(cv2.CAP_PROP_FRAME_HEIGHT)
    )
    try:
        validate_finished_video(
            base,
            width,
            height,
            project["baseFrames"],
            neutral=True,
            profile="edited" if project["baseFrames"] > 450 else project["baseProfile"],
        )
        count = length(project)
        for clean, kind in ((False, "highlight"), (True, "clean")):
            destination = directory / (kind + ".mp4")
            process = subprocess.Popen(
                [
                    imageio_ffmpeg.get_ffmpeg_exe(),
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "-s",
                    f"{width}x{height}",
                    "-r",
                    "30",
                    "-i",
                    "-",
                    "-an",
                    "-map_metadata",
                    "-1",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "fast",
                    "-crf",
                    "18",
                    "-pix_fmt",
                    "yuv420p",
                    "-movflags",
                    "+faststart",
                    str(destination),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
            proofs = []
            last = -1
            image = None
            try:
                for index in range(count):
                    if cancel.is_set():
                        raise InterruptedError("Rendering cancelled")
                    source = frame_state(project, index, clean)["source"]
                    if source != last:
                        if source != last + 1:
                            capture.set(cv2.CAP_PROP_POS_FRAMES, source)
                        ok, decoded = capture.read()
                        if not ok:
                            raise ValueError("Masked base has a missing frame")
                        image = cv2.cvtColor(decoded, cv2.COLOR_BGR2RGB)
                        last = source
                    out = draw_frame(image, project, index, clean)
                    if np.any(out.max(axis=2) != out.min(axis=2)):
                        raise ValueError("Edited frame is not neutral")
                    proofs.append(silhouette_proof(out))
                    process.stdin.write(out.tobytes())
                    progress((int(clean) * count + index + 1) / (2 * count + 2))
                process.stdin.close()
                if process.wait(timeout=60):
                    raise ValueError("Local video encoding failed")
                if destination.stat().st_size > 100 * 1024 * 1024:
                    raise ValueError("Finished video exceeds 100 MB")
                validate_finished_video(
                    destination,
                    width,
                    height,
                    count,
                    proofs,
                    neutral=True,
                    profile="edited",
                )
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
        progress(1)
    finally:
        capture.release()
