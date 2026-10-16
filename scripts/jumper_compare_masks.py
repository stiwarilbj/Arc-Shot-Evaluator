"""Compare real browser WebGPU masks with native CPU SAM on the same fixture.

Run test-jumper-parity.mjs against the hosted dev server first. Requires locally
installed native SAM, checkpoint, NumPy and FFmpeg; never downloads footage.
"""

import argparse, json, sys, tempfile
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.jumper.pipeline import extract, track


def main(capture, checkpoint, correction=False, allow_warnings=False):
    import torch

    torch.set_num_threads(4)
    captured = json.loads(capture.read_text())
    rows = captured if isinstance(captured, list) else captured["masks"]
    if len(rows) != 9 or [row["frame"] for row in rows] != list(range(9)):
        raise ValueError("Nine ordered samples required")
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        frames = extract(
            Path(__file__).resolve().parents[1]
            / "tests/fixtures/jumper/research-short.mp4",
            root / "frames",
            0,
            0.3,
        )
        job = {
            "target_id": 1,
            "objects": [
                {
                    "id": 1,
                    "prompts": [{"frame": 0, "points": [[0.485, 0.64]], "labels": [1]}],
                }
            ],
        }
        if correction:
            job["objects"][0]["prompts"].append(
                {"frame": 4, "points": [[0.1, 0.1], [0.485, 0.64]], "labels": [0, 1]}
            )
        if isinstance(captured, dict):
            job = captured["request"]
            if "rgb" in captured:
                from PIL import Image

                if len(captured["rgb"]) != len(frames):
                    raise ValueError("Incomplete decoded frame capture")
                for row in captured["rgb"]:
                    pixels = np.asarray(row["rgb"], dtype=np.uint8).reshape(
                        row["height"], row["width"], 4
                    )
                    Image.fromarray(pixels[:, :, :3]).save(
                        frames[row["frame"]], format="PNG"
                    )
        warnings = track(frames, root / "masks", job, checkpoint, "cpu")
        if warnings and not allow_warnings:
            raise ValueError(f"Native fixture lost tracking: {warnings}")
        values = []
        for row in rows:
            native = np.load(root / "masks" / f"{row['frame']:06}.npy")
            browser = np.asarray(row["owners"], dtype=np.uint8).reshape(
                row["height"], row["width"]
            )
            for obj in job["objects"]:
                a, b = native == obj["id"], browser == obj["id"]
                union = np.count_nonzero(a | b)
                values.append(float(np.count_nonzero(a & b) / union) if union else 1.0)
        result = {
            "warnings": warnings,
            "samples": len(values),
            "mean_iou": float(np.mean(values)),
            "min_iou": min(values),
            "per_frame": values,
        }
        print(json.dumps(result, indent=2))
        if result["mean_iou"] < 0.99 or result["min_iou"] < 0.97:
            raise ValueError("Native/browser mask agreement gate failed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("--correction", action="store_true")
    parser.add_argument(
        "--allow-warnings",
        action="store_true",
        help="Compare a rejected stress fixture without approving it for publication",
    )
    parser.add_argument(
        "--checkpoint", type=Path, default=Path("models/sam2.1_hiera_tiny.pt")
    )
    args = parser.parse_args()
    main(args.capture, args.checkpoint, args.correction, args.allow_warnings)
