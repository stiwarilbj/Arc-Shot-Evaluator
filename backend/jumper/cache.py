"""Disposable device-local feature/detection cache; no masks or tracking state."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import time
import uuid
import zipfile

import numpy as np

LIMIT = 256 * 1024 * 1024
TTL = 3600
MAX_ENTRIES = 1024


def identity(source, job, checkpoint, device, frames):
    from importlib.metadata import version
    from backend.jumper.pipeline import digest

    from importlib.util import find_spec
    import cv2
    import platform
    import torch

    sam_root = Path(next(iter(find_spec("sam2").submodule_search_locations)))
    code = hashlib.sha256()
    for path in sorted([*sam_root.rglob("*.py"), *sam_root.rglob("*.yaml")]):
        code.update(str(path.relative_to(sam_root)).encode())
        code.update(bytes.fromhex(digest(path)))
    for name in ("pipeline.py", "frames.py", "mps.py"):
        code.update(bytes.fromhex(digest(Path(__file__).with_name(name))))
    # Content, not filenames/mtime. Decoder, preprocessing and numerical backend
    # are deliberately part of the identity; prompts and masks are not.
    return hashlib.sha256(
        json.dumps(
            {
                "schema": "native-sam-cache-v2-strides",
                "video": digest(source)
                if source and Path(source).is_file()
                else [digest(p) for p in frames],
                "trim": [job["start"], job["end"]],
                "frames": len(frames),
                "geometry": [1280, 720, 30, 1024],
                "checkpoint": digest(checkpoint),
                "device": device,
                "torch": version("torch"),
                "numerics": [
                    torch.get_num_threads(),
                    torch.get_num_interop_threads(),
                    torch.get_float32_matmul_precision(),
                    torch.are_deterministic_algorithms_enabled(),
                    torch.backends.mkldnn.enabled,
                    str(torch.get_default_dtype()),
                ],
                "preprocessing": [cv2.__version__, version("imageio-ffmpeg")],
                "implementation": code.hexdigest(),
                "platform": platform.platform(),
                "sam": "2b90b9f5ceec907a1c18123530e92e794ad901a4",
                "detection": [640, 0.25, 0.45, "cpu", False],
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()


class FrameCache:
    def __init__(self, root: Path, scope: str, limit=LIMIT, ttl=TTL):
        self.root, self.scope, self.limit, self.ttl = root, scope, limit, ttl

    @contextmanager
    def locked(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        # A subprocess killed by cancellation releases this lock automatically.
        with (self.root / ".lock").open("a+b") as lock:
            if os.name == "nt":
                import msvcrt

                if os.fstat(lock.fileno()).st_size == 0:
                    lock.write(b"\0")
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(lock, fcntl.LOCK_EX)
            now = time.time()
            for path in self.root.glob("*"):
                if path.suffix == ".tmp" or (
                    path.suffix == ".npz" and now - path.stat().st_mtime > self.ttl
                ):
                    path.unlink(missing_ok=True)
            yield

    def path(self, name):
        key = hashlib.sha256(name.encode()).hexdigest()
        return self.root / f"{self.scope}-{key}.npz"

    def get(self, name):
        try:
            with self.locked():
                path = self.path(name)
                if not path.is_file() or path.stat().st_size > self.limit:
                    return None
                with zipfile.ZipFile(path) as compressed:
                    if (
                        len(compressed.infolist()) > 12
                        or sum(item.file_size for item in compressed.infolist())
                        > self.limit
                    ):
                        raise ValueError("Oversized cache entry")
                with np.load(path, allow_pickle=False) as archive:
                    # Our entries have at most six tensors plus their layouts; cap decoded allocation.
                    if len(archive.files) > 12:
                        raise ValueError("Invalid cache")
                    values = {k: archive[k] for k in archive.files}
                if sum(v.nbytes for v in values.values()) > self.limit:
                    raise ValueError("Oversized cache entry")
                os.utime(path, None)
                return values
        except Exception:
            return None

    def can_put(self, size):
        try:
            with self.locked():
                entries = list(self.root.glob(self.scope + "-*.npz"))
                used = sum(p.stat().st_size for p in entries)
                return len(entries) < MAX_ENTRIES and used + size + 8192 <= self.limit
        except Exception:
            return False

    def put(self, name, values):
        temporary = None
        try:
            size = sum(v.nbytes for v in values.values()) + 8192
            if size > self.limit:
                return
            with self.locked():
                path = self.path(name)
                entries = list(self.root.glob("*.npz"))
                count = sum(p != path for p in entries)
                used = sum(p.stat().st_size for p in entries if p != path)
                # Keep early frames of the active clip: a sequential LRU scan
                # otherwise evicts all of an over-budget clip before reuse.
                for old in sorted(
                    (p for p in entries if not p.name.startswith(self.scope + "-")),
                    key=lambda p: p.stat().st_mtime,
                ):
                    if used + size <= self.limit and count < MAX_ENTRIES:
                        break
                    used -= old.stat().st_size
                    count -= 1
                    old.unlink(missing_ok=True)
                if used + size > self.limit or count >= MAX_ENTRIES:
                    return
                temporary = self.root / f"{uuid.uuid4().hex}.tmp"
                with temporary.open("xb") as stream:
                    os.chmod(temporary, 0o600)
                    np.savez_compressed(stream, **values)
                if used + temporary.stat().st_size > self.limit:
                    return
                temporary.replace(path)
        except Exception:
            pass  # Denied storage or cache corruption never fails processing.
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)


def cache_backbone(predictor, cache, device="cpu"):
    """Reuse only verified encoder outputs; always rebuild temporal state.

    MPS CPU round-trips changed tracking in the real parity fixture despite
    equal values/layouts. Keep its original tensors; detector reuse is safe.
    Other native accelerators also retain their original path until verified.
    """
    if device != "cpu":
        return
    import torch

    original = predictor._get_image_feature

    def feature(state, frame_idx, batch_size):
        key = f"features:{frame_idx}"
        if frame_idx not in state["cached_features"]:
            cached = cache.get(key)
            if cached is not None:
                try:
                    groups = {}
                    for group in ("backbone_fpn", "vision_pos_enc"):
                        arrays = [cached[f"{group}{i}"] for i in range(3)]
                        expected = (
                            [(1, 32, 256, 256), (1, 64, 128, 128), (1, 256, 64, 64)]
                            if group == "backbone_fpn"
                            else [
                                (1, 256, 256, 256),
                                (1, 256, 128, 128),
                                (1, 256, 64, 64),
                            ]
                        )
                        if any(
                            a.shape != shape
                            or a.dtype != np.float32
                            or not np.isfinite(a).all()
                            for a, shape in zip(arrays, expected)
                        ):
                            raise ValueError("Invalid feature cache")
                        tensors = []
                        for i, a in enumerate(arrays):
                            shape = a.shape
                            contiguous = (
                                shape[1] * shape[2] * shape[3],
                                shape[2] * shape[3],
                                shape[3],
                                1,
                            )
                            channels_last = (
                                shape[1] * shape[2] * shape[3],
                                1,
                                shape[3] * shape[1],
                                shape[1],
                            )
                            layout = tuple(cached[f"layout_{group}{i}"])
                            if layout not in (contiguous, channels_last):
                                raise ValueError("Invalid feature layout")
                            tensors.append(
                                torch.from_numpy(a).to(
                                    state["device"],
                                    memory_format=torch.channels_last
                                    if layout == channels_last
                                    else torch.contiguous_format,
                                )
                            )
                        groups[group] = tensors
                    image = (
                        state["images"][frame_idx]
                        .to(state["device"])
                        .float()
                        .unsqueeze(0)
                    )
                    state["cached_features"] = {frame_idx: (image, groups)}
                except (KeyError, ValueError, RuntimeError):
                    cached = None
            if cached is None:
                result = original(state, frame_idx, batch_size)
                try:
                    _, backbone = state["cached_features"][frame_idx]
                    size = sum(
                        t.numel() * t.element_size()
                        for group in ("backbone_fpn", "vision_pos_enc")
                        for t in backbone[group]
                    )
                    if not cache.can_put(size):
                        return result
                    values = {
                        f"{group}{i}": t.detach().cpu().numpy().copy()
                        for group in ("backbone_fpn", "vision_pos_enc")
                        for i, t in enumerate(backbone[group])
                    }
                    values.update(
                        {
                            f"layout_{group}{i}": np.array(t.stride(), dtype=np.int64)
                            for group in ("backbone_fpn", "vision_pos_enc")
                            for i, t in enumerate(backbone[group])
                        }
                    )
                    cache.put(key, values)
                except Exception:
                    pass
                return result
        return original(state, frame_idx, batch_size)

    predictor._get_image_feature = feature
