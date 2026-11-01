"""Shared per-process CPU limits for the local analysis workers."""

from __future__ import annotations

import os
import threading


def _analysis_worker_count() -> int:
    try:
        return max(1, min(4, int(os.environ.get("ARC_WORKERS", "1"))))
    except ValueError:
        return 1


def _available_cpu_count() -> int:
    process_cpu_count = getattr(os, "process_cpu_count", None)
    if process_cpu_count is not None:
        count = process_cpu_count()
        if count:
            return max(1, count)
    try:
        return max(1, len(os.sched_getaffinity(0)))
    except (AttributeError, OSError):
        return max(1, os.cpu_count() or 1)


ANALYSIS_WORKERS = _analysis_worker_count()
CPU_THREAD_BUDGET = max(1, min(4, _available_cpu_count() // ANALYSIS_WORKERS))


def _limit_environment_thread_pool(name: str, budget: int) -> None:
    configured = os.environ.get(name)
    if configured is not None:
        try:
            budget = min(budget, max(1, int(configured)))
        except ValueError:
            pass
    os.environ[name] = str(budget)


# Apply these before NumPy, OpenCV, or PyTorch are imported so their native
# worker pools all start with the same per-analysis allowance. Existing lower
# operator limits remain in effect.
for _variable in (
    "OMP_NUM_THREADS",
    "OMP_THREAD_LIMIT",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "BLIS_NUM_THREADS",
):
    _limit_environment_thread_pool(_variable, CPU_THREAD_BUDGET)


_torch_lock = threading.Lock()
_torch_configured = False


def configure_opencv_threads() -> int:
    """Apply the shared worker allowance to OpenCV's internal pool."""
    import cv2

    cv2.setNumThreads(CPU_THREAD_BUDGET)
    return CPU_THREAD_BUDGET


def configure_torch_threads() -> int:
    """Set PyTorch's process-wide pools once, before local models run."""
    global _torch_configured
    if _torch_configured:
        return CPU_THREAD_BUDGET
    with _torch_lock:
        if _torch_configured:
            return CPU_THREAD_BUDGET
        import torch

        torch.set_num_threads(CPU_THREAD_BUDGET)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            # PyTorch only permits this setting before inter-op work starts
            # Another local component may already have initialized that pool
            pass
        _torch_configured = True
    return CPU_THREAD_BUDGET
