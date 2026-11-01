import copy
import json
from pathlib import Path
import numpy as np
import pytest
from backend.jumper.correction_points import correction_prompt, CorrectionConflictError
from backend.jumper.pipeline import validate_job
from backend.jumper.small_player import SmallPlayerRefiner, source_crop_prompt

CASES=json.loads((Path(__file__).parent/'fixtures/jumper/correction-points.json').read_text())


def validate_request(job):
    return validate_job(dict(source="private.mp4",event_id="private",player_id="private",player_name="Player",identity_evidence="personal selection",**job))


@pytest.mark.parametrize('case',CASES,ids=lambda f:f['name'])
def test_shared_pixel_conflicts(case):
    f=case
    prompt=dict(frame=6,anchor=False,**{k:f[k] for k in ('points','labels','box') if k in f})
    before=copy.deepcopy(prompt)
    job=dict(version=1,start=0,end=1,target_id=7,objects=[dict(id=7,prompts=[dict(frame=0,box=[0,0,1,1]),prompt])])
    if f.get('conflict'):
        with pytest.raises(CorrectionConflictError,match='frame 7, track 7'):
            correction_prompt(prompt,7)
        with pytest.raises(CorrectionConflictError):validate_request(job)
    else:
        result=correction_prompt(prompt,7)
        assert result.get('points')==([f['points'][i] for i in f['keep']] if 'points' in f else None)
        assert result.get('labels')==([f['labels'][i] for i in f['keep']] if 'points' in f else None)
        assert result.get('box')==prompt.get('box') and result['anchor'] is False
        validate_request(job)
    assert prompt==before


def test_frame_track_scopes_and_native_resize():
    prompts=[dict(frame=0,points=[[.5,.5]],labels=[1]),dict(frame=1,points=[[.5,.5]],labels=[0])]
    validate_request(dict(version=1,start=0,end=1,target_id=7,objects=[dict(id=7,prompts=prompts),dict(id=9,prompts=[dict(prompts[1],frame=0)])]))
    # Same absolute-coordinate cast, division and 1024 resize as native SAM.
    for size in ((373,281),(1280,720),(71,109)):
        points=[[n/1024,.5] for n in (511.999999,512,512.000001,513.1)]
        mapped=(np.asarray(points,np.float32)*np.asarray(size,np.float64)).astype(np.float32)/np.asarray(size,np.float32)*1024
        seen=set();keep=[]
        for i,p in enumerate(mapped):
            cell=tuple(min(1023,int(v)) for v in p)
            if cell not in seen:keep.append(i);seen.add(cell)
        result=correction_prompt(dict(frame=0,points=points,labels=[1]*4),7,size)
        assert result['points']==[points[i] for i in keep]


def test_detail_crop_conflict_precedes_inference():
    crop=dict(x=0,y=0,width=100,height=100,padding=[100,100,100,100],box=[0,0,1,1],points=[[.5,.5],[.5011,.5]],labels=[1,0],unusable=False)
    correction_prompt(dict(frame=3,points=crop['points'],labels=crop['labels']),9)
    mapped=source_crop_prompt(crop,100,100,373,281)
    with pytest.raises(CorrectionConflictError,match='detail crop'):
        correction_prompt(dict(frame=3,**mapped),9,context="detail crop")
    class NeverInfer:
        def set_image(self,*a):raise AssertionError('conflict must precede inference')
    refiner=SmallPlayerRefiner.__new__(SmallPlayerRefiner);refiner.predictor=NeverInfer()
    with pytest.raises(CorrectionConflictError,match=r'frame 4, track 9 \(detail crop\)'):
        refiner.refine(np.zeros((281,373,3),np.uint8),np.zeros((100,100),np.float32),crop,np.zeros((100,100),np.uint8),9,frame=3)


def test_native_track_conflict_precedes_model_initialization(tmp_path):
    import cv2
    from backend.jumper.pipeline import track
    source=tmp_path/'frame.png';cv2.imwrite(str(source),np.zeros((32,48,3),np.uint8))
    job=dict(start=0,end=1/30,target_id=7,objects=[dict(id=7,prompts=[dict(frame=0,points=[[.5001,.5],[.5002,.5]],labels=[1,0])])])
    with pytest.raises(CorrectionConflictError,match='frame 1, track 7'):
        track([source],tmp_path/'masks',job,tmp_path/'nonexistent-weights','cpu')


def test_native_sends_consolidated_points_but_preserves_job(tmp_path,monkeypatch):
    import cv2
    import torch
    import sam2.build_sam
    from backend.jumper import pipeline,frames,cache,resources
    sent=[]
    class Predictor:
        def add_new_points_or_box(self,*args,**kwargs):sent.append(kwargs)
        def reset_state(self,*args):pass
        def propagate_in_video(self,*args,**kwargs):
            for frame in range(2):
                values=torch.full((1,1,20,32),-1.)
                values[0,0,2:18,2:18]=2
                yield frame,[7],values
    monkeypatch.setattr(sam2.build_sam,'build_sam2_video_predictor',lambda *a,**k:Predictor())
    monkeypatch.setattr(frames,'bounded_state',lambda *a:{'output_dict_per_obj':{}})
    monkeypatch.setattr(resources,'check_resources',lambda *a,**k:None)
    monkeypatch.setattr(pipeline,'check_device_mask_area',lambda *a:None)
    monkeypatch.setattr(cache,'FrameCache',lambda *a:None)
    monkeypatch.setattr(cache,'cache_backbone',lambda *a,**k:None)
    paths=[]
    for i in range(2):
        path=tmp_path/f'{i}.png';cv2.imwrite(str(path),np.zeros((20,32,3),np.uint8));paths.append(path)
    prompt=dict(frame=1,points=[[.4,.5],[.40001,.50001],[.8,.5]],labels=[1,1,0])
    job=dict(start=0,end=2/30,target_id=7,objects=[dict(id=7,prompts=[dict(frame=0,box=[0,0,1,1]),prompt])])
    before=copy.deepcopy(job)
    pipeline.track(paths,tmp_path/'masks',job,tmp_path/'weights','cpu')
    correction=next(p for p in sent if p['frame_idx']==1)
    assert correction['labels'].tolist()==[1,0]
    np.testing.assert_allclose(correction['points'],np.asarray([prompt['points'][0],prompt['points'][2]],np.float32)*[32,20])
    assert job['objects']==before['objects']
