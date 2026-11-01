"""Drain native FFmpeg diagnostics without blocking its input or growing logs."""

from contextlib import contextmanager
import subprocess
import threading

DIAGNOSTIC_BYTES = 64 * 1024


class DiagnosticTail:
    def __init__(self, stream):
        self.stream = stream
        self.data = bytearray()
        self.lock = threading.Lock()
        self.reader = threading.Thread(target=self._drain, name="jumper-ffmpeg-stderr", daemon=True)

    def _drain(self):
        try:
            while chunk := self.stream.read(8192):
                with self.lock:
                    self.data.extend(chunk)
                    if len(self.data) > DIAGNOSTIC_BYTES:
                        del self.data[:-DIAGNOSTIC_BYTES]
        finally:
            self.stream.close()

    def text(self):
        with self.lock:
            return self.data.decode("utf-8", errors="replace")

    def finish(self):
        """Call after the child exits to include diagnostics buffered at exit."""
        self.reader.join()
        return self.text()


@contextmanager
def diagnostic_process(command, *, stdin=None):
    process = subprocess.Popen(command, stdin=stdin, stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE)
    tail = DiagnosticTail(process.stderr)
    started = False
    try:
        tail.reader.start()
        started = True
        yield process, tail
    finally:
        # Kill before closing a buffered stdin: flushing it can otherwise block
        # during cancellation, a timeout, or an exception in frame production.
        if process.poll() is None:
            process.kill()
        process.wait()
        if started:
            tail.finish()
        else:
            process.stderr.close()
        if process.stdin is not None:
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass
