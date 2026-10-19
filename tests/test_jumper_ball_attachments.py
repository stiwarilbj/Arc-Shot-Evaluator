import copy
import json
from pathlib import Path
import numpy as np
import pytest
from backend.jumper.ball_attachments import BallAttachments,valid_hands

CASES=json.loads((Path(__file__).parent/'fixtures/jumper/ball-attachments.json').read_text())

@pytest.mark.parametrize('f',CASES,ids=lambda f:f['name'])
def test_shared_ball_evidence(f):
    check=BallAttachments()
    for frame in range(f['frames']):
        labels=np.zeros((f['height'],f['width']),np.uint8)
        gray=np.full(labels.shape,220,np.uint8)
        if f.get('mask_body',True):
            for key in ['body','head','arm']:
                l,t,r,b=f[key];labels[t:b,l:r]=1;gray[t:b,l:r]=80
        cx,cy,radius=f['ball']
        y,x=np.indices(labels.shape)
        disk=(x-cx)**2+(y-cy)**2<=radius**2
        if f.get('mask_ball',True):labels[disk]=f.get('ball_owner',1)
        if f.get('image_ball',True):gray[disk]=80
        else:gray.fill(220)
        hands=[[*f['box'],*f['wrist'],0,0,0]]
        if f.get('duplicate'):hands.append(hands[0].copy())
        if frame in f.get('missing',[]):hands=[]
        if f.get('invalid'):hands=[[*hands[0],float('inf')]]
        before=labels.copy();before_gray=gray.copy();before_hands=copy.deepcopy(hands)
        warnings=check.inspect(f.get('at',list(range(f['frames'])))[frame],labels,gray,1,hands,frame in f.get('resets',[]))
        assert warnings==[dict(frame=at,kind='ball_attachment',track_ids=[1]) for at in f['expected'][frame]],frame
        assert np.array_equal(before,labels);assert np.array_equal(before_gray,gray);assert hands==before_hands
        labels.fill(0);gray.fill(0)


def test_hand_validation():
    assert valid_hands([])
    assert not valid_hands([[float('nan')]])


def test_pipeline_reports_ball_evidence_without_removing_hand_pixels(tmp_path,monkeypatch):
    import cv2
    import torch
    import sam2.build_sam
    import ultralytics
    from types import SimpleNamespace
    from backend import config
    from backend.jumper import pipeline,frames,cache,resources
    f=CASES[0]
    expected=np.zeros((256,256),np.uint8)
    image=np.full((256,256,3),220,np.uint8)
    for key in ['body','head','arm']:
        l,t,r,b=f[key];expected[t:b,l:r]=1;image[t:b,l:r]=80
    cx,cy,radius=f['ball'];y,x=np.indices(expected.shape)
    disk=(x-cx)**2+(y-cy)**2<=radius**2
    expected[disk]=1;image[disk]=80
    pose=np.zeros((1,17,3),np.float32)
    pose[0,9]=[f['wrist'][0]*256,f['wrist'][1]*256,f['wrist'][2]]
    logits=np.where(expected==1,3.,-3.).astype(np.float32)[None,None]
    box=np.array([f['box']],np.float32)*256
    class Predictor:
        def add_new_points_or_box(self,*args,**kwargs):pass
        def reset_state(self,*args):pass
        def propagate_in_video(self,state,start_frame_idx=0,**kwargs):
            yield start_frame_idx,[1],torch.from_numpy(logits.copy())
    class Detector:
        def predict(self,*args,**kwargs):
            return [SimpleNamespace(boxes=SimpleNamespace(xyxy=torch.from_numpy(box)),keypoints=SimpleNamespace(data=torch.from_numpy(pose)))]
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
        path=tmp_path/f'{i}.png';cv2.imwrite(str(path),image);paths.append(path)
    job=dict(start=0,end=4/30,target_id=1,auto_detect_others=True,
        objects=[dict(id=1,prompts=[dict(frame=0,box=f['box'])])])
    warnings=pipeline.track(paths,tmp_path/'masks',job,tmp_path/'weights','cpu')
    assert [w for w in warnings if w['kind']=='ball_attachment']==[
        dict(frame=i,kind='ball_attachment',track_ids=[1]) for i in range(4)]
    for i in range(4):
        assert np.array_equal(np.load(tmp_path/'masks'/f'{i:06d}.npy'),expected)
