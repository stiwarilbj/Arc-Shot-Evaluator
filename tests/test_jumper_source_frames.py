"""Real VFR decoding and cross-target timing fixtures; no model mocks needed."""
import json
from pathlib import Path
import numpy as np
import pytest
from PIL import Image
from backend.jumper.source_frames import build_frame_map, valid_frame_map, inspect_source, extract_single
from backend.jumper.pipeline import extract, run_ffmpeg, validate_job

FIXTURES = json.loads((Path(__file__).parent/'fixtures/jumper/source-frames.json').read_text())


@pytest.mark.parametrize('f', FIXTURES, ids=lambda f:f['name'])
def test_shared_source_frame_maps(f):
    m = build_frame_map(f['source'], f['start'], f['end'])
    assert valid_frame_map(m, f['start'], f['end'])
    assert [s['source_index'] for s in m['frames']] == f['expected']
    for key, value in [('source_us', 999999999), ('duration_us', 0), ('source_index', -1)]:
        broken = json.loads(json.dumps(m));broken['frames'][0][key] = value
        assert not valid_frame_map(broken)
    assert not valid_frame_map(m, f['start']+.001, f['end'])


def make_vfr(directory, offset):
    directory.mkdir()
    times = [0, .02, .09, .14, .22, .31, .4, .46, .54, .6]
    for i in range(len(times)):
        Image.fromarray(np.full((64,96,3), 20+i*20, np.uint8)).save(directory/f'{i:03d}.png')
    source = directory/'vfr.mp4'
    manifest = directory/'frames.txt'
    manifest.write_text(''.join(
        f"file '{directory/f'{i:03d}.png'}'\noption framerate 1000\nduration {(times[i+1]-t) if i+1<len(times) else .034:.6f}\n"
        for i,t in enumerate(times)))
    run_ffmpeg(['-f','concat','-safe','0','-i',str(manifest),'-fps_mode','passthrough',
                '-c:v','libx264','-bf','2','-pix_fmt','yuv420p','-video_track_timescale','30000',
                '-output_ts_offset',str(offset),str(source)])
    return source, times


@pytest.mark.parametrize('offset', [0, 5])
def test_actual_vfr_map_selection_corrections_and_detail_frames(tmp_path, offset):
    source, times = make_vfr(tmp_path/'input',offset)
    timeline = inspect_source(source,.417)
    assert [s['timestamp'] for s in timeline] == pytest.approx([t+offset for t in times if t <= .46],abs=.000002)
    first = extract(source,tmp_path/'frames',.017,.417)
    mapping = first.frame_map
    assert mapping['origin_us'] == offset*1_000_000
    assert [f['source_index'] for f in mapping['frames']] == FIXTURES[0]['expected']
    detail = extract(source,tmp_path/'detail',.017,.417,maximum=(64,48),frame_map=mapping)
    assert detail.frame_map == mapping
    for i, entry in enumerate(mapping['frames']):
        expected = 20+entry['source_index']*20
        for paths in (first,detail):
            actual = np.asarray(Image.open(paths[i]))
            assert np.max(np.abs(actual.astype(float)-expected)) <= 3
    # A correction on output frame 3 uses the same source image as selection,
    # both processing resolutions, retry extraction, and review's mapped timestamp.
    frame = 2;entry=mapping['frames'][frame]
    preview = tmp_path/'preview.png'
    extract_single(source,preview,(entry['source_us']-mapping['origin_us']+1000)/1e6)
    np.testing.assert_array_equal(np.asarray(Image.open(preview)),np.asarray(Image.open(first[frame])))
    # A zero-duration final decoded packet uses the exact stream end, never FPS.
    full = extract(source,tmp_path/'full',0,.69)
    assert full.frame_map['frames'][-1]['source_index'] == 9
    assert full.frame_map['frames'][-1]['duration_us'] == 90000
    stale=json.loads(json.dumps(mapping));stale['frames'][0]['source_index']=1
    with pytest.raises(ValueError,match='map|disagrees'):
        extract(source,tmp_path/'stale',.017,.417,frame_map=stale)


def test_bad_source_maps_and_timing():
    with pytest.raises(ValueError):
        build_frame_map([dict(timestamp=0,duration=.1),dict(timestamp=0,duration=.1)],0,.1)
    with pytest.raises(ValueError):
        build_frame_map([dict(timestamp=0,duration=.1)],0,.2)


def test_missing_unused_tail_and_invalid_timing():
    tail = [dict(timestamp=t,duration=0) for t in (0,.1,.2)]
    assert valid_frame_map(build_frame_map(tail,0,.15))
    with pytest.raises(ValueError):
        build_frame_map(tail,0,.23)
    with pytest.raises(ValueError):
        build_frame_map(tail+[dict(timestamp=float('nan'),duration=.1)],0,.1)
    m=build_frame_map(tail,0,.15);m['frames'][1]['source_index']=1
    assert not valid_frame_map(m)
