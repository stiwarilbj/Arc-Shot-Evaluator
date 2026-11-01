import json
from pathlib import Path
import numpy as np
import pytest
from backend.jumper.small_player import small_player_crop, source_crop, accept_refinement
from backend.jumper.pipeline import validate_job


def fill(a, rect, value):
    l, t, r, b = rect
    a[t:b, l:r] = value


def test_shared_crop_acceptance_fixtures():
    fixtures = json.loads((Path(__file__).parent / 'fixtures/jumper/small-player.json').read_text())
    for f in fixtures:
        coarse = np.full((f['height'], f['width']), -3, np.float32)
        fill(coarse, f['body'], 3)
        original = coarse.copy()
        crop = small_player_crop(coarse)
        assert crop and not crop['unusable']
        assert crop['height'] < f['height'] * .6
        candidate = np.full((crop['height'], crop['width']), -3, np.float32)
        def local(r):
            return [r[0]-crop['x'], r[1]-crop['y'], r[2]-crop['x'], r[3]-crop['y']]
        fill(candidate, local(f.get('replace', f['body'])), 3)
        if f.get('edit'):
            fill(candidate, local(f['edit']), 3)
        if f.get('edge'):
            candidate[0, 0] = 3
        if f.get('nan'):
            candidate[0, 0] = np.nan
        owners = np.zeros(coarse.shape, np.uint8)
        fill(owners, f['body'], 1)
        if f.get('occupied'):
            fill(owners, f['occupied'], 2)
        result = accept_refinement(coarse, candidate, crop, owners, 1)
        assert (result is not None) == f['expected'], f['name']
        np.testing.assert_array_equal(coarse, original)
        if result is not None:
            assert not np.shares_memory(result, coarse)
        region = source_crop(crop, f['width'], f['height'], 1920, 1080)
        assert region['x'] == crop['x'] * 6
        assert region['width'] == crop['width'] * 6
        corrected = small_player_crop(coarse, dict(points=[[.47,.4],[.42,.4]], labels=[1,0]))
        assert corrected['labels'][-1] == 0
        assert len(corrected['points']) == len(crop['points']) + 2
        assert small_player_crop(coarse, dict(points=[[.99,.99]], labels=[1]))['unusable']


def test_large_missing_and_unresolvable_players():
    values = np.full((180, 320), -3, np.float32)
    assert small_player_crop(values) is None
    fill(values, [1,1,3,3], 3)
    assert small_player_crop(values)['unusable']
    fill(values, [40,20,160,160], 3)
    assert small_player_crop(values) is None


@pytest.mark.parametrize('flag', [1, 'true', None])
def test_native_request_rejects_nonboolean_refinement(flag):
    job = dict(version=1, source='private', event_id='test', player_id='test', player_name='Test',
               identity_evidence='User selected', start=0, end=1, target_id=1, refine_small_players=flag,
               objects=[dict(id=1,prompts=[dict(frame=0,box=[.1,.1,.2,.2])])])
    with pytest.raises(ValueError, match='refinement flag'):
        validate_job(job)
