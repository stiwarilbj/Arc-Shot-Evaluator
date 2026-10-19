"""One explicit output-to-source presentation map, equivalent to sourceFrames.ts."""
from __future__ import annotations
import math
import json
import subprocess
import sys
from pathlib import Path

MAX_SOURCE_EDGE = 8192
MAX_SOURCE_PIXELS = 32 * 1024 * 1024
DIMENSION_ERRORS = {
    'invalid': 'The video contains invalid frame dimensions. Re-export the video and retry.',
    'oversized': 'The video contains an oversized frame. Re-export at a lower resolution and retry.',
    'changed': 'The video changes frame dimensions. Re-export at a fixed resolution and retry.',
}


class SourceFrameDimensionsError(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(DIMENSION_ERRORS[reason])


def check_frame_dimensions(width, height, expected=None):
    """Check decoded geometry before creating scaled tracking/detail images."""
    if type(width) is not int or type(height) is not int or min(width, height) < 1:
        raise SourceFrameDimensionsError('invalid')
    if max(width, height) > MAX_SOURCE_EDGE or width * height > MAX_SOURCE_PIXELS:
        raise SourceFrameDimensionsError('oversized')
    if expected is not None and (width, height) != expected:
        raise SourceFrameDimensionsError('changed')
    return width, height


def micros(seconds):
    return math.floor(seconds * 1_000_000 + .5)


def frame_count(start, end):
    return math.ceil((micros(end) - micros(start)) * 30 / 1_000_000)


def valid_frame_map(m, start=None, end=None):
    integer = lambda v: type(v) is int and 0 <= v <= 2**53-1
    if (not isinstance(m, dict) or m.get('version') != 1
            or not all(integer(m.get(k)) for k in ('origin_us', 'start_us', 'end_us'))
            or not 0 < m['end_us']-m['start_us'] <= 15_000_000
            or (start is not None and m['start_us'] != micros(start))
            or (end is not None and m['end_us'] != micros(end))
            or not isinstance(m.get('frames'), list)
            or not 1 <= len(m['frames']) <= 450
            or len(m['frames']) != frame_count(m['start_us']/1e6, m['end_us']/1e6)):
        return False
    previous = None
    for i, f in enumerate(m['frames']):
        time = m['origin_us'] + m['start_us'] + i*1e6/30
        if (not isinstance(f, dict) or not all(integer(f.get(k)) for k in ('source_index', 'source_us', 'duration_us'))
                or f['source_index'] >= 100_000 or f['source_us'] < m['origin_us'] or not f['duration_us']
                or f['source_us'] > time+.5 or time >= f['source_us']+f['duration_us']+.5):
            return False
        if previous and (f['source_index'] < previous['source_index'] or f['source_us'] < previous['source_us']
                         or (f['source_index'] == previous['source_index'] and f != previous)
                         or (f['source_index'] != previous['source_index'] and f['source_us'] == previous['source_us'])):
            return False
        previous = f
    return True


def build_frame_map(source, start, end):
    if not math.isfinite(start) or not math.isfinite(end) or any(
            not math.isfinite(s['timestamp']) or not math.isfinite(s['duration']) or s['duration'] < 0 for s in source):
        raise ValueError('The video has invalid source-frame timing')
    source = sorted((s for s in source if micros(s['timestamp']) >= 0), key=lambda s: s['timestamp'])
    if not source or len(source) > 100_000:
        raise ValueError('The video has no supported source-frame timeline')
    frames = []
    for i, s in enumerate(source):
        time = micros(s['timestamp'])
        duration = micros(source[i+1]['timestamp'])-time if i+1 < len(source) else micros(s['duration'])
        if duration < 0 or (duration == 0 and i+1 < len(source)):
            raise ValueError('The video has duplicate or invalid frame timestamps')
        frames.append(dict(source_index=i, source_us=time, duration_us=duration))
    origin, first, last = frames[0]['source_us'], micros(start), micros(end)
    count = frame_count(start, end)
    if (first < 0 or not 1 <= count <= 450 or last <= first
            or origin+last > frames[-1]['source_us']+frames[-1]['duration_us']+2):
        raise ValueError('The selected segment extends beyond the source-frame timeline')
    at, mapped = 0, []
    for frame in range(count):
        time = origin+first+frame*1e6/30
        while at+1 < len(frames) and frames[at+1]['source_us'] <= time+.5:
            at += 1
        mapped.append(frames[at].copy())
    result = dict(version=1, origin_us=origin, start_us=first, end_us=last, frames=mapped)
    if not valid_frame_map(result):
        raise ValueError('The selected segment needs unavailable source-frame timing')
    return result


def _inspect_source(source: Path, end: float):
    # Read exact decoded PTS and stream duration; average FPS and rounded
    # console metadata cannot identify the last frame of a VFR phone video.
    import av
    found = []
    dimensions = None
    try:
        with av.open(str(source)) as container:
            stream = container.streams.video[0]
            stream_end = (float((stream.start_time or 0) + stream.duration) * float(stream.time_base)
                          if stream.duration is not None else None)
            for index, frame in enumerate(container.decode(stream)):
                # Check every decoded frame, including skipped negative-PTS and
                # lookahead frames. Container opening metadata is insufficient.
                dimensions = check_frame_dimensions(frame.width, frame.height, dimensions)
                if frame.pts is None or frame.time_base is None:
                    raise ValueError('Source-frame timing is unavailable')
                timestamp = float(frame.pts * frame.time_base)
                if timestamp < 0:
                    continue
                duration = float(frame.duration * frame.time_base) if frame.duration else 0
                found.append(dict(timestamp=timestamp, duration=duration, decode_index=index))
                if len(found) > 100_000:
                    raise ValueError('Video has too many source frames')
                # A following PTS defines the preceding interval exactly.
                if timestamp > found[0]['timestamp'] + end:
                    break
            else:
                # Only use stream-end timing when decoding actually reached EOF.
                if found and stream_end is not None and stream_end > found[-1]['timestamp']:
                    found[-1]['duration'] = stream_end - found[-1]['timestamp']
    except (av.FFmpegError, IndexError) as error:
        raise ValueError('Could not decode the source-frame timeline') from error
    if not found:
        raise ValueError('Source-frame timing is unavailable')
    return found


def inspect_source(source: Path, end: float):
    # Isolate PyAV's FFmpeg libraries from OpenCV's bundled macOS libraries.
    # The probe loads no models and is bounded by both frame count and deadline.
    result = subprocess.run(
        [sys.executable, '-m', 'backend.jumper.source_frames', str(source), str(end)],
        capture_output=True, timeout=120,
    )
    if result.returncode:
        try:
            error = json.loads(result.stdout)
        except (ValueError, UnicodeError):
            error = None
        if (isinstance(error, dict) and error.get('error') == 'source_frame_dimensions'
                and isinstance(error.get('reason'), str) and error['reason'] in DIMENSION_ERRORS):
            raise SourceFrameDimensionsError(error['reason'])
        raise ValueError('Could not decode the source-frame timeline')
    return json.loads(result.stdout)


def resolve_source(source, start, end, supplied=None):
    timeline = inspect_source(source, end)
    actual = build_frame_map(timeline, start, end)
    if supplied is not None:
        if not valid_frame_map(supplied, start, end) or len(supplied['frames']) != len(actual['frames']):
            raise ValueError('Invalid source-frame map')
        for a, b in zip(actual['frames'], supplied['frames']):
            if (a['source_index'] != b['source_index']
                    or abs((a['source_us']-actual['origin_us'])-(b['source_us']-supplied['origin_us'])) > 2
                    or abs(a['duration_us']-b['duration_us']) > 2):
                raise ValueError('The local decoder disagrees with the selected source frame. Re-export the source and retry')
        actual = supplied
    return actual, timeline


def decode_selected(source, directory, mapping, timeline, maximum):
    from .pipeline import run_ffmpeg
    # Decode only unique mapped images to disk; repeated 30-fps frames are linked.
    indices = sorted({f['source_index'] for f in mapping['frames']})
    selection = '+'.join(f'eq(n\\,{timeline[i]["decode_index"]})' for i in indices)
    run_ffmpeg([
        '-copyts', '-i', str(source), '-map', '0:v:0', '-an', '-vf',
        f"select='{selection}',scale='min({maximum[0]},iw)':'min({maximum[1]},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-fps_mode', 'passthrough', '-frames:v', str(len(indices)), '-c:v', 'png',
        '-start_number', '0', str(directory / 'source-%06d.png'),
    ])
    decoded = sorted(directory.glob('source-*.png'))
    if len(decoded) != len(indices):
        raise ValueError('Could not decode every mapped source frame')
    return dict(zip(indices, decoded))


def extract_single(source, destination, time):
    import tempfile
    import shutil
    mapping, timeline = resolve_source(source, time, time+.000001)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        decoded = decode_selected(source, Path(temporary), mapping, timeline, (1280,720))
        shutil.copyfile(next(iter(decoded.values())), destination)


if __name__ == '__main__':
    try:
        print(json.dumps(_inspect_source(Path(sys.argv[1]), float(sys.argv[2]))))
    except SourceFrameDimensionsError as error:
        print(json.dumps(dict(error='source_frame_dimensions', reason=error.reason)))
        sys.exit(1)
