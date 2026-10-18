import copy
import json
from pathlib import Path
import numpy as np
import pytest
from backend.jumper.floor_attachments import FloorAttachments

CASES=json.loads((Path(__file__).parent/'fixtures/jumper/floor-attachments.json').read_text())


@pytest.mark.parametrize('fixture',CASES,ids=lambda f:f['name'])
def test_shared_floor_evidence(fixture):
    f=fixture
    check=FloorAttachments(f['width'],f['height'])
    identity=f.get('identity',1)
    tracks=[dict(id=identity,ignored=f.get('ignored',False),prompts=[dict(frame=f.get('start',0))])]
    if f.get('correction'):
        tracks[0]['prompts'].append(dict(frame=f['correction']))
    before_tracks=copy.deepcopy(tracks)
    before_fixture=copy.deepcopy(f)
    for index,step in enumerate(f['frames']):
        owners=np.zeros((f['height'],f['width']),dtype=np.uint8)
        for track,l,t,r,b in step['masks']:
            owners[t:b,l:r]=track
        before=owners.copy()
        warnings=check.inspect(step.get('at',index),owners,tracks,step.get('boxes',f['boxes']),step.get('reset',False))
        assert warnings==[dict(frame=frame,kind='floor_attachment',track_ids=[identity]) for frame in f['expected'][index]],index
        assert np.array_equal(owners,before)
        owners.fill(0)
    assert tracks==before_tracks
    assert f==before_fixture


def test_pipeline_reports_floor_evidence_without_removing_pixels(tmp_path,monkeypatch):
    import cv2
    import torch
    import sam2.build_sam
    import ultralytics
    from types import SimpleNamespace
    from backend import config
    from backend.jumper import pipeline,frames,cache,resources
    f=CASES[0]
    expected=np.zeros((128,128),np.uint8)
    for identity,l,t,r,b in f['frames'][0]['masks']:
        expected[t:b,l:r]=identity
    logits=np.where(expected==1,3.,-3.).astype(np.float32)[None,None]
    box=np.array(f['boxes'],np.float32)*128
    class Predictor:
        def add_new_points_or_box(self,*args,**kwargs):pass
        def reset_state(self,*args):pass
        def propagate_in_video(self,state,start_frame_idx=0,**kwargs):
            yield start_frame_idx,[1],torch.from_numpy(logits.copy())
    class Detector:
        def predict(self,*args,**kwargs):
            return [SimpleNamespace(boxes=SimpleNamespace(xyxy=torch.from_numpy(box)))]
    detector_path=tmp_path/'yolo11n-pose.pt';detector_path.write_bytes(b'fixture')
    monkeypatch.setattr(config,'MODEL_WEIGHTS_DIR',tmp_path)
    monkeypatch.setattr(ultralytics,'YOLO',lambda *a:Detector())
    monkeypatch.setattr(sam2.build_sam,'build_sam2_video_predictor',lambda *a,**k:Predictor())
    monkeypatch.setattr(frames,'bounded_state',lambda *a:{'output_dict_per_obj':{}})
    monkeypatch.setattr(resources,'check_resources',lambda *a,**k:None)
    monkeypatch.setattr(cache,'FrameCache',lambda *a:None)
    monkeypatch.setattr(cache,'cache_backbone',lambda *a,**k:None)
    paths=[]
    for i in range(4):
        path=tmp_path/f'{i}.png';cv2.imwrite(str(path),np.zeros((128,128,3),np.uint8));paths.append(path)
    job=dict(start=0,end=4/30,target_id=1,auto_detect_others=True,
        objects=[dict(id=1,prompts=[dict(frame=0,box=f['boxes'][0])])])
    warnings=pipeline.track(paths,tmp_path/'masks',job,tmp_path/'weights','cpu')
    assert [w for w in warnings if w['kind']=='floor_attachment']==[
        dict(frame=i,kind='floor_attachment',track_ids=[1]) for i in range(4)]
    for i in range(4):
        assert np.array_equal(np.load(tmp_path/'masks'/f'{i:06d}.npy'),expected)
