"""Reject changing/oversized decoded geometry before image extraction."""
from fractions import Fraction
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from backend.jumper import source_frames
from backend.jumper.pipeline import extract, run_ffmpeg


@pytest.mark.parametrize('width,height', [(1920,1080), (1080,1920), (3840,2160),
                                         (7680,4320), (4320,7680), (8192,4096), (1,1)])
def test_supported_dimensions_and_exact_limits(width, height):
    assert source_frames.check_frame_dimensions(width, height, (width,height)) == (width,height)


@pytest.mark.parametrize('width,height,reason', [
    (8193,1,'oversized'), (1,8193,'oversized'), (8192,4097,'oversized'),
    (0,1080,'invalid'), (-1,1080,'invalid'), (1920,None,'invalid'),
    (1920,float('inf'),'invalid'), (True,1080,'invalid'),
])
def test_invalid_or_excessive_dimensions(width, height, reason):
    with pytest.raises(source_frames.SourceFrameDimensionsError) as error:
        source_frames.check_frame_dimensions(width, height)
    assert error.value.reason == reason
    assert 'retry' in str(error.value)


def fake_decoder(monkeypatch, entries):
    seen, closed = [], []
    stream = SimpleNamespace(start_time=0, duration=None, time_base=Fraction(1,30))

    class Container:
        streams = SimpleNamespace(video=[stream])

        def __enter__(self):
            return self

        def __exit__(self, *args):
            closed.append(True)

        def decode(self, _):
            for width, height, pts in entries:
                seen.append(pts)
                # No array conversion or image allocation is needed for checks.
                yield SimpleNamespace(width=width, height=height, pts=pts,
                                      time_base=Fraction(1,30), duration=1)

    monkeypatch.setitem(sys.modules, 'av', SimpleNamespace(open=lambda _: Container(),
                                                         FFmpegError=type('DecodeError',(Exception,),{})))
    return seen, closed


@pytest.mark.parametrize('entries,reason', [
    ([(1920,1080,0), (8193,1080,1), (1920,1080,2)], 'oversized'),
    ([(1920,1080,0), (1280,720,1)], 'changed'),
    ([(1920,1080,0), (1080,1920,1)], 'changed'),
    ([(1920,1080,-1), (8193,1080,0)], 'oversized'),
    ([(0,1080,-1)], 'invalid'),
])
def test_probe_checks_actual_frames_and_closes_on_rejection(monkeypatch, entries, reason):
    seen, closed = fake_decoder(monkeypatch, entries)
    with pytest.raises(source_frames.SourceFrameDimensionsError) as error:
        source_frames._inspect_source(Path('source'), .01)
    assert error.value.reason == reason
    assert closed == [True]
    assert len(seen) <= 2


def test_stable_frames_keep_timing_records_unchanged(monkeypatch):
    fake_decoder(monkeypatch, [(1920,1080,-1), (1920,1080,0), (1920,1080,1)])
    assert source_frames._inspect_source(Path('source'), .01) == [
        dict(timestamp=0, duration=1/30, decode_index=1),
        dict(timestamp=1/30, duration=1/30, decode_index=2),
    ]


@pytest.mark.parametrize('maximum', [(1280,720), (2560,1440)])
@pytest.mark.parametrize('reason', ['oversized', 'changed', 'invalid'])
def test_probe_error_reaches_caller_before_image_allocation(tmp_path, monkeypatch, maximum, reason):
    response = SimpleNamespace(returncode=1, stdout=json.dumps(
        dict(error='source_frame_dimensions', reason=reason)).encode())
    monkeypatch.setattr(source_frames.subprocess, 'run', lambda *a, **k: response)
    from backend.jumper import pipeline
    monkeypatch.setattr(pipeline, 'run_ffmpeg', lambda *a: pytest.fail('Image extraction started after rejection'))
    with pytest.raises(source_frames.SourceFrameDimensionsError) as error:
        extract(tmp_path/'source', tmp_path/'frames', 0, .1, maximum=maximum)
    assert error.value.reason == reason
    assert not (tmp_path/'frames').exists()


@pytest.mark.parametrize('later_size,message', [('128x96','fixed resolution'), ('8194x16','lower resolution')])
def test_real_resolution_change_reports_recoverable_error(tmp_path, later_size, message):
    # Concatenated transport streams retain independent H.264 sequence headers.
    segments = []
    for index, size in enumerate(('96x64',later_size)):
        path = tmp_path/f'{index}.ts'
        run_ffmpeg(['-f','lavfi','-i',f'color=c=gray:s={size}:r=30:d=0.1',
                    '-c:v','libx264','-pix_fmt','yuv420p','-f','mpegts',str(path)])
        segments.append(path.read_bytes())
    source = tmp_path/'changing.ts'
    source.write_bytes(b''.join(segments))
    with pytest.raises(source_frames.SourceFrameDimensionsError, match=message):
        extract(source,tmp_path/'frames',0,.2)
    assert not (tmp_path/'frames').exists()
