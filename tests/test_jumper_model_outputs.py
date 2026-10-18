import numpy as np
import pytest
import torch
from backend.jumper.model_outputs import (
    validate_array, tracking_masks, InvalidModelOutputError,
)


@pytest.mark.parametrize('bad', [None, [], np.zeros((2, 3), np.int32),
    np.zeros((3, 2), np.float32), np.zeros((1, 2, 3), np.float32)])
def test_invalid_arrays(bad):
    with pytest.raises(InvalidModelOutputError, match='Retry processing'):
        validate_array(bad, (2, 3), 'mask')


@pytest.mark.parametrize('bad', [np.nan, np.inf, -np.inf])
def test_nonfinite_masks_in_any_track(bad):
    logits = torch.full((2, 1, 12, 16), -1024.)
    logits[1, 0, -1, -1] = float(bad)
    with pytest.raises(InvalidModelOutputError):
        tracking_masks(logits, [7, 9], 12, 16)


@pytest.mark.parametrize('shape,ids', [((1, 12, 16), [7]),
    ((1, 1, 16, 12), [7]), ((2, 1, 12, 16), [7]),
    ((0, 1, 12, 16), [])])
def test_native_rank_and_dimensions(shape, ids):
    with pytest.raises(InvalidModelOutputError):
        tracking_masks(torch.zeros(shape), ids, 12, 16)


def test_valid_empty_visibility_and_numeric_precision():
    values = tracking_masks(torch.full((2, 1, 12, 16), -1024.), [7, 9], 12, 16)
    assert values.shape == (2, 12, 16) and (values == -1024).all()
    # Finite float64 output that overflows float32 is rejected after conversion.
    with pytest.raises(InvalidModelOutputError):
        tracking_masks(torch.full((1, 1, 12, 16), 1e300, dtype=torch.float64), [7], 12, 16)


@pytest.mark.parametrize('output', ['low', 'mask', 'quality'])
@pytest.mark.parametrize('bad', [np.nan, np.inf, -np.inf, 'shape'])
def test_refinement_rejects_before_resize_and_releases_predictor(bad, output):
    from backend.jumper.small_player import SmallPlayerRefiner
    class Predictor:
        released = False
        def set_image(self, image): pass
        def predict(self, **kwargs):
            outputs = {'mask': np.zeros((1,8,8),np.float32),
                       'quality': np.ones(1,np.float32),
                       'low': np.zeros((1,256,256),np.float32)}
            if bad == 'shape': outputs[output] = outputs[output].reshape(-1)[:-1]
            else: outputs[output].flat[-1] = bad
            return outputs['mask'], outputs['quality'], outputs['low']
        def reset_predictor(self): self.released = True
    refiner = object.__new__(SmallPlayerRefiner)
    refiner.predictor = Predictor()
    crop = dict(x=0, y=0, width=8, height=8, points=[[.5,.5]], labels=[1], box=[0,0,1,1])
    with pytest.raises(InvalidModelOutputError):
        refiner.refine(np.zeros((8,8,3),np.uint8), np.zeros((8,8),np.float32), crop, np.zeros((8,8),np.uint8), 1)
    assert refiner.predictor.released


@pytest.mark.parametrize('reverse_failure', [False, True])
def test_tracking_failure_stops_and_releases_state(tmp_path, monkeypatch, reverse_failure):
    import cv2
    import sam2.build_sam
    from backend.jumper import pipeline, frames, cache, resources
    states = []
    class Predictor:
        def add_new_points_or_box(self, state, **kwargs): pass
        def reset_state(self, state): state['released'] = True
        def propagate_in_video(self, state, start_frame_idx, max_frame_num_to_track=None, reverse=False):
            end = 0 if reverse else 2
            for index in range(start_frame_idx, end + (-1 if reverse else 1), -1 if reverse else 1):
                logits = torch.full((1,1,20,32), -1.)
                logits[0,0,2:18,2:10] = 1
                if reverse == reverse_failure: logits[0,0,0,0] = float('nan')
                yield index, [7], logits
    def state(*args):
        value = {'output_dict_per_obj': {}}; states.append(value); return value
    monkeypatch.setattr(sam2.build_sam, 'build_sam2_video_predictor', lambda *a, **k: Predictor())
    monkeypatch.setattr(frames, 'bounded_state', state)
    monkeypatch.setattr(resources, 'check_resources', lambda *a, **k: None)
    monkeypatch.setattr(pipeline, 'check_device_mask_area', lambda *a: None)
    monkeypatch.setattr(cache, 'FrameCache', lambda *a: None)
    monkeypatch.setattr(cache, 'cache_backbone', lambda *a, **k: None)
    paths = []
    for index in range(3):
        path = tmp_path / f'{index}.png'
        cv2.imwrite(str(path), np.zeros((20,32,3),np.uint8)); paths.append(path)
    job = dict(version=1, source='private', event_id='test', player_id='test', player_name='Test',
        identity_evidence='User selected', start=0, end=.1, target_id=7, verify_shooter=reverse_failure,
        objects=[dict(id=7, prompts=[dict(frame=0,points=[[.2,.5]],labels=[1]),
                                    dict(frame=2,points=[[.2,.5]],labels=[1])])])
    with pytest.raises(InvalidModelOutputError):
        pipeline.track(paths, tmp_path/'masks', job, tmp_path/'weights', 'cpu', lambda *a:None)
    assert states and all(s.get('released') for s in states)
    if not reverse_failure:
        assert not list((tmp_path/'masks').glob('*.npy'))
