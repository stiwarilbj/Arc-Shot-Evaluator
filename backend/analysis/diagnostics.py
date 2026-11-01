"""Private, local-only timing records for analysis jobs."""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


class AnalysisTimingTrace:
    """Accumulate stage durations without changing public analysis results."""

    def __init__(self) -> None:
        self.trace_id = uuid.uuid4().hex
        self.started_at = time.time()
        self._started = time.perf_counter()
        self._stage_seconds: defaultdict[str, float] = defaultdict(float)
        self._lock = threading.Lock()
        self._active_stage: str | None = None
        self._last_stage: str | None = None
        self.failed_stage: str | None = None
        self.error_type: str | None = None
        self.status = "running"

    @contextmanager
    def stage(self, name: str, *, mark_failure: bool = True) -> Iterator[None]:
        """Measure a stage, adding repeated batch timings under one name."""
        started = time.perf_counter()
        with self._lock:
            previous_stage = self._active_stage
            self._active_stage = name
            self._last_stage = name
        failure: Exception | None = None
        try:
            yield
        except Exception as error:
            failure = error
            raise
        finally:
            elapsed = time.perf_counter() - started
            with self._lock:
                self._stage_seconds[name] += elapsed
                self._active_stage = previous_stage
                if failure is not None and mark_failure and self.failed_stage is None:
                    self.failed_stage = name
                    self.error_type = type(failure).__name__

    def finish(self, status: str, error: Exception | None = None) -> None:
        """Record the terminal job state without retaining exception text."""
        with self._lock:
            self.status = status
            if status == "failed" and self.failed_stage is None:
                self.failed_stage = self._active_stage or "analysis_job"
                if error is not None:
                    self.error_type = type(error).__name__

    def as_dict(self, job_id: str) -> dict:
        with self._lock:
            stages = {
                name: round(seconds * 1000, 3)
                for name, seconds in sorted(self._stage_seconds.items())
            }
            return {
                "trace_id": self.trace_id,
                "job_id": job_id,
                "started_at_unix": round(self.started_at, 3),
                "status": self.status,
                "total_elapsed_ms": round((time.perf_counter() - self._started) * 1000, 3),
                "stages_ms": stages,
                "last_stage": self._last_stage,
                "failed_stage": self.failed_stage,
                "error_type": self.error_type,
            }

    def write(self, session_dir: Path, job_id: str) -> None:
        """Atomically persist the trace outside all served session artifacts."""
        directory = session_dir / ".diagnostics"
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / "analysis-timing.json"
        temporary = directory / f".{target.name}.{uuid.uuid4().hex}.tmp"
        try:
            temporary.write_text(json.dumps(self.as_dict(job_id), indent=2))
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
