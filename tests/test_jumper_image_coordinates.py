"""Coordinate regressions shared with the hosted crop path, plus real rotation decoding."""
import json
from pathlib import Path
import numpy as np
import pytest
from PIL import Image
from backend.jumper.small_player import (
    small_player_crop, source_crop, source_crop_prompt, project_refinement,
)
from backend.jumper.pipeline import extract, run_ffmpeg


@pytest.mark.parametrize('f', json.loads((Path(__file__).parent / 'fixtures/jumper/image-coordinates.json').read_text()), ids=lambda f: f['name'])
def test_crop_round_trips(f):
    crop = dict(**f['crop'], points=f['points'], labels=[1]*len(f['points']), box=[.05,.1,.95,.9])
    args = crop, f['width'], f['height'], f['sourceWidth'], f['sourceHeight']
    region, prompt = source_crop(*args), source_crop_prompt(*args)
    for p, actual in zip(crop['points'], prompt['points']):
        assert (region['x'] + actual[0] * region['width']) / f['sourceWidth'] == pytest.approx((crop['x'] + p[0] * crop['width']) / f['width'])
        assert (region['y'] + actual[1] * region['height']) / f['sourceHeight'] == pytest.approx((crop['y'] + p[1] * crop['height']) / f['height'])
    for i in (0, 2):
        assert (region['x'] + prompt['box'][i] * region['width']) / f['sourceWidth'] == pytest.approx((crop['x'] + crop['box'][i] * crop['width']) / f['width'])
        assert (region['y'] + prompt['box'][i+1] * region['height']) / f['sourceHeight'] == pytest.approx((crop['y'] + crop['box'][i+1] * crop['height']) / f['height'])
    ys, xs = np.mgrid[:256, :256]
    ramp = ((xs + .5) / 256 + 2 * (ys + .5) / 256).astype(np.float32)
    result = project_refinement(ramp, *args)
    ys, xs = np.mgrid[:crop['height'], :crop['width']]
    u = ((crop['x'] + xs + .5) * f['sourceWidth'] / f['width'] - region['x']) / region['width']
    v = ((crop['y'] + ys + .5) * f['sourceHeight'] / f['height'] - region['y']) / region['height']
    np.testing.assert_allclose(result, u + 2*v, atol=1e-6)


def test_edge_prompt_is_retained():
    mask = np.full((180, 320), -3, np.float32)
    mask[167:, 315:] = 3
    crop = small_player_crop(mask, dict(points=[[1, 1]], labels=[1]))
    assert not crop['unusable']
    assert crop['points'][-1] == [1, 1]


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_native_rotated_decoding_preserves_known_locations(tmp_path, rotation):
    # Distinct color landmarks near all four edges, including an asymmetric interior.
    source = np.zeros((180, 320, 3), dtype=np.uint8)
    source[:90, :160] = [220, 20, 20]
    source[:90, 160:] = [20, 220, 20]
    source[90:, :160] = [20, 20, 220]
    source[90:, 160:] = [220, 220, 20]
    Image.fromarray(source).save(tmp_path / 'source.png')
    run_ffmpeg(['-loop', '1', '-i', str(tmp_path / 'source.png'), '-t', '0.1', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(tmp_path / 'base.mp4')])
    run_ffmpeg(['-display_rotation', str(rotation), '-i', str(tmp_path / 'base.mp4'), '-c', 'copy', str(tmp_path / 'rotated.mp4')])
    frames = extract(tmp_path / 'rotated.mp4', tmp_path / 'frames', 0, .1, maximum=(128, 72))
    actual = np.array(Image.open(frames[0]).convert('RGB'))
    expected = np.rot90(source, rotation // 90)
    # Normalized prompts refer to the upright frame; no second rotation at model input.
    assert abs(actual.shape[1]/actual.shape[0] - expected.shape[1]/expected.shape[0]) < .04
    for x, y in ((.03,.03),(.97,.03),(.03,.97),(.97,.97),(.32,.61)):
        got = actual[int(y*actual.shape[0]), int(x*actual.shape[1])]
        want = expected[int(y*expected.shape[0]), int(x*expected.shape[1])]
        np.testing.assert_allclose(got, want, atol=6)
