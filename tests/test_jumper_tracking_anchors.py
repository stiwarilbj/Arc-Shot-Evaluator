"""Explicit shooter recovery cannot disturb other identities or allow invalid prompts."""
import copy
import pytest
from backend.jumper.pipeline import validate_job
from backend.jumper.tracking_anchors import reset_shooter_memory


def request():
    return dict(version=1, source='private.mp4',event_id='test',player_id='test',
                player_name='Test',identity_evidence='User selection',start=0,end=.3,target_id=7,
                objects=[dict(id=7,prompts=[dict(frame=0,points=[[.5,.5]],labels=[1]),
                                          dict(frame=4,points=[[.5,.5]],labels=[1],anchor=True)]),
                         dict(id=9,prompts=[dict(frame=0,points=[[.2,.2]],labels=[1])])])


def test_anchor_request_is_optional():
    job = request()
    validate_job(job)
    del job['objects'][0]['prompts'][1]['anchor']
    validate_job(job)


@pytest.mark.parametrize('bad', ['true',1,0,None])
def test_invalid_anchor_flag(bad):
    job=request();job['objects'][0]['prompts'][1]['anchor']=bad
    with pytest.raises(ValueError,match='anchor'):validate_job(job)


@pytest.mark.parametrize('case', ['opening','other','negative'])
def test_anchor_requires_later_positive_shooter(case):
    job=request()
    if case=='opening':job['objects'][0]['prompts'][0]['anchor']=True
    elif case=='other':job['objects'][1]['prompts'].append(dict(frame=4,points=[[.5,.5]],labels=[1],anchor=True))
    else:job['objects'][0]['prompts'][1]['labels']=[0]
    with pytest.raises(ValueError,match='anchor'):validate_job(job)


def test_only_shooter_memory_is_reset():
    state=dict(obj_id_to_idx={7:0,9:1},cached_features={4:'shared'},obj_ids=[7,9])
    for key in ('output_dict_per_obj','temp_output_dict_per_obj'):
        state[key]={i:dict(cond_frame_outputs={0:'condition'},non_cond_frame_outputs={3:'recent'}) for i in (0,1)}
    for key in ('point_inputs_per_obj','mask_inputs_per_obj','frames_tracked_per_obj'):
        state[key]={i:{0:'data'} for i in (0,1)}
    original=copy.deepcopy(state)
    reset_shooter_memory(state,7)
    assert state['cached_features']==original['cached_features']
    assert state['obj_id_to_idx']==original['obj_id_to_idx']
    for key in ('output_dict_per_obj','temp_output_dict_per_obj'):
        assert state[key][0]==dict(cond_frame_outputs={},non_cond_frame_outputs={})
        assert state[key][1]==original[key][1]
    for key in ('point_inputs_per_obj','mask_inputs_per_obj','frames_tracked_per_obj'):
        assert state[key][0]=={}
        assert state[key][1]==original[key][1]
    # Incompatible predictor layouts fail before mutating anything.
    del state['frames_tracked_per_obj']
    before=copy.deepcopy(state)
    with pytest.raises(KeyError):reset_shooter_memory(state,7)
    assert state==before

@pytest.mark.parametrize('verify', [False, True])
def test_native_anchors_reseed_causally_with_or_without_audit(tmp_path, monkeypatch, verify):
    import cv2
    import numpy as np
    import torch
    import sam2.build_sam
    from backend.jumper import pipeline, frames, cache, resources, tracking_anchors

    states, resets = [], []
    class Predictor:
        def add_new_points_or_box(self,state,frame_idx,obj_id,**kwargs):
            state['prompts'][frame_idx]=obj_id
        def propagate_in_video(self,state,start_frame_idx,max_frame_num_to_track=None,reverse=False):
            end=start_frame_idx-max_frame_num_to_track if reverse else start_frame_idx
            for at in range(start_frame_idx,end+(-1 if reverse else 1),-1 if reverse else 1):
                assert max(state['prompts']) <= start_frame_idx, 'future anchor leaked'
                if not reverse and start_frame_idx>=4:
                    assert min(state['prompts'])==4, 'old shooter memory survived anchor'
                logits=np.full((1,1,20,32),-1,dtype=np.float32);logits[0,0,2:18,2:10]=1
                yield at,[7],torch.from_numpy(logits)
        def reset_state(self,state):state['released']=True
    def make_state(*args):
        state=dict(prompts={},output_dict_per_obj={});states.append(state);return state
    def reset(state,target):
        resets.append(target);state['prompts'].clear()
    monkeypatch.setattr(tracking_anchors,'reset_shooter_memory',reset)
    monkeypatch.setattr(sam2.build_sam,'build_sam2_video_predictor',lambda *a,**k:Predictor())
    monkeypatch.setattr(frames,'bounded_state',make_state)
    monkeypatch.setattr(resources,'check_resources',lambda *a,**k:None)
    monkeypatch.setattr(pipeline,'check_device_mask_area',lambda *a:None)
    monkeypatch.setattr(cache,'FrameCache',lambda *a:None)
    monkeypatch.setattr(cache,'cache_backbone',lambda *a,**k:None)
    paths=[]
    for i in range(6):
        path=tmp_path/f'{i}.png';cv2.imwrite(str(path),np.zeros((20,32,3),dtype=np.uint8));paths.append(path)
    job=request();job['end']=.2;job['verify_shooter']=verify;job['objects']=job['objects'][:1]
    pipeline.track(paths,tmp_path/'masks',job,tmp_path/'weights','cpu',lambda *a:None)
    assert resets==[7]
    assert len(states)==(2 if verify else 1)
    assert all(s['released'] for s in states)
