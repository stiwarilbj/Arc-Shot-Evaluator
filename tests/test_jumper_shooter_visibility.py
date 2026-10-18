import json
from pathlib import Path
import numpy as np
import pytest
from backend.jumper.shooter_visibility import ShooterVisibility
from backend.jumper.mask_ownership import MaskOwnership
from backend.jumper.mask_quality import MaskQuality

CASES = json.loads((Path(__file__).parent/'fixtures/jumper/shooter-visibility.json').read_text())


def pixels(rect):
    values = np.full((256,256), -3, dtype=np.float32)
    if rect:
        x,y,w,h=rect
        values[y:y+h,x:x+w]=3
    return values


@pytest.mark.parametrize('case',CASES,ids=lambda case:case['name'])
def test_shared_occlusion_sequences(case):
    gate=ShooterVisibility()
    for frame,step in enumerate(case['frames']):
        values=pixels(step['target']); before=values.copy()
        others=[pixels(rect) for rect in step.get('others',[])]
        result=gate.inspect(frame,values,others,step.get('score',3),step.get('confirmed',False),step.get('uncertain',False))
        assert result==dict(visible=step['visible'],warning=step.get('warning')), (case['name'],frame)
        assert np.array_equal(values,before)
        if not result['visible']:
            values.fill(-1024)
        labels=MaskOwnership(256,256).resolve(list(range(1,len(others)+2)),[values,*others])
        if not result['visible']:
            assert not np.any(labels==1)
        if others and step['target'] is None:
            assert np.any(labels==2)


def test_long_absence_requires_confirmation():
    gate=ShooterVisibility()
    gate.inspect(0,pixels([40,40,20,40]),[],3)
    gate.inspect(1,pixels(None),[pixels([40,40,20,40])],-1)
    assert gate.inspect(46,pixels([40,40,20,40]),[],3)['warning']=='ambiguous_players'


def test_invisibility_only_skips_explicit_target():
    quality=MaskQuality()
    tracks=[dict(id=1,prompts=[dict(frame=0)]),dict(id=2,prompts=[dict(frame=0)])]
    warnings=quality.inspect(1,np.zeros((4,4),np.uint8),tracks,1,invisible=(1,))
    assert warnings==[dict(frame=1,kind='player_lost',track_ids=[2])]
    assert quality.inspect(2,np.zeros((4,4),np.uint8),tracks,1)[0]['kind']=='target_lost'


def test_native_pipeline_does_not_learn_or_paint_invisible_shooter(tmp_path, monkeypatch):
    """Exercise actual pipeline/gate/ownership wiring with controlled predictions."""
    import torch
    from PIL import Image
    from sam2 import build_sam
    from backend.jumper import pipeline, frames as frame_module
    sequence=CASES[0]['frames']
    paths=[]
    for index in range(len(sequence)):
        path=tmp_path/f'{index:06d}.jpg'
        Image.fromarray(np.full((256,256,3),128,np.uint8)).save(path)
        paths.append(path)
    groups=lambda:dict(cond_frame_outputs={},non_cond_frame_outputs={})
    state=dict(output_dict_per_obj={0:groups(),1:groups()},obj_id_to_idx={1:0,2:1},obj_idx_to_id={0:1,1:2})
    checked=[]
    class Predictor:
        def reset_state(self,state):
            pass
        def add_new_points_or_box(self,*args,**kwargs):
            pass
        def _prepare_memory_conditioned_features(self,frame_idx,is_init_cond_frame,output_dict,track_in_reverse=False):
            # The last reliable reference is retained; invisible frames are never
            # admitted into subsequent attention, despite usable raw logits.
            for values in output_dict.values():
                assert all(out.get('_jumper_reliable',True) for out in values.values())
            checked.append(frame_idx)
        def _run_single_frame_inference(self,inference_state,output_dict,frame_idx,batch_size,is_init_cond_frame,
                point_inputs,mask_inputs,reverse,run_mem_encoder):
            self._prepare_memory_conditioned_features(frame_idx,is_init_cond_frame,output_dict,reverse)
            step=sequence[frame_idx]
            is_target=output_dict is state['output_dict_per_obj'][0]
            rect=step['target'] if is_target else next(iter(step.get('others',[])),[160,40,20,40])
            values=pixels(rect)
            value=dict(pred_masks=torch.from_numpy(values)[None,None],object_score_logits=torch.tensor([[step.get('score',3) if is_target else 3.]]))
            return value,value['pred_masks']
        def propagate_in_video(self,state,start_frame_idx=0,**kwargs):
            for index in range(start_frame_idx,len(sequence)):
                masks=[]
                for identity in (1,2):
                    outputs=state['output_dict_per_obj'][identity-1]
                    output,mask=self._run_single_frame_inference(state,outputs,index,1,index==0,
                        {} if index==0 else None,None,False,True)
                    outputs['cond_frame_outputs' if index==0 else 'non_cond_frame_outputs'][index]=output
                    masks.append(mask)
                yield index,[1,2],torch.cat(masks)
    monkeypatch.setattr(build_sam,'build_sam2_video_predictor',lambda *a,**k:Predictor())
    monkeypatch.setattr(frame_module,'bounded_state',lambda *a:state)
    monkeypatch.setattr('backend.jumper.resources.check_resources',lambda *a,**k:None)
    # Feature caching is optional and not relevant to these controlled logits.
    monkeypatch.setattr('backend.jumper.cache.cache_backbone',lambda *a,**k:None)
    job=dict(start=0,end=len(sequence)/30,target_id=1,objects=[dict(id=i,prompts=[dict(frame=0,box=[.1,.1,.5,.8])]) for i in (1,2)])
    # An Exclude-only correction refines a mask; it does not confirm a return.
    job['objects'][0]['prompts'].append(dict(frame=3,points=[[.9,.9]],labels=[0]))
    warnings=pipeline.track(paths,tmp_path/'masks',job,tmp_path/'weights','cpu')
    assert not any(w['kind']=='target_lost' for w in warnings)
    for index,step in enumerate(sequence):
        labels=np.load(tmp_path/'masks'/f'{index:06d}.npy')
        assert bool(np.any(labels==1))==step['visible'], index
        if index in (1,2):
            assert np.any(labels==2)
        output=state['output_dict_per_obj'][0]['cond_frame_outputs' if index==0 else 'non_cond_frame_outputs'][index]
        assert bool(output['_jumper_reliable'])==step['visible']
    assert checked
