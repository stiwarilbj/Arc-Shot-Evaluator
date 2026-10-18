import copy
import json
from pathlib import Path
import numpy as np
import pytest
from backend.jumper.correction_check import check_corrections

CASES=json.loads((Path(__file__).parent/'fixtures/jumper/correction-check.json').read_text())


@pytest.mark.parametrize('case', CASES, ids=lambda f:f['name'])
def test_shared_correction_membership(case):
    f=case
    owners=np.array(f['owners'],np.uint8).reshape(f['height'],f['width'])
    before=owners.copy(); tracks=copy.deepcopy(f['tracks'])
    assert check_corrections(f['frame'],owners,tracks)==f['expected']
    assert np.array_equal(owners,before)
    assert tracks==f['tracks']


def test_pipeline_checks_combined_ownership(tmp_path,monkeypatch):
    import cv2
    import torch
    import sam2.build_sam
    from backend.jumper import pipeline,frames,cache,resources
    class Predictor:
        def add_new_points_or_box(self,*args,**kwargs):pass
        def reset_state(self,*args):pass
        def propagate_in_video(self,*args,**kwargs):
            for frame in range(2):
                values=np.full((2,1,20,32),-1,np.float32)
                values[0,0,2:18,2:18]=2
                values[1,0,2:18,10:28]=3
                yield frame,[7,9],torch.from_numpy(values)
    monkeypatch.setattr(sam2.build_sam,'build_sam2_video_predictor',lambda *a,**k:Predictor())
    monkeypatch.setattr(frames,'bounded_state',lambda *a:{'output_dict_per_obj':{}})
    monkeypatch.setattr(resources,'check_resources',lambda *a,**k:None)
    monkeypatch.setattr(pipeline,'check_device_mask_area',lambda *a:None)
    monkeypatch.setattr(cache,'FrameCache',lambda *a:None)
    monkeypatch.setattr(cache,'cache_backbone',lambda *a,**k:None)
    paths=[]
    for i in range(2):
        path=tmp_path/f'{i}.png';cv2.imwrite(str(path),np.zeros((20,32,3),np.uint8));paths.append(path)
    job=dict(start=0,end=2/30,target_id=7,objects=[
        dict(id=7,prompts=[dict(frame=0,box=[0,0,1,1]),
                         dict(frame=1,points=[[.4,.5],[.2,.5]],labels=[1,0])]),
        dict(id=9,prompts=[dict(frame=0,box=[0,0,1,1])])])
    warnings=pipeline.track(paths,tmp_path/'masks',job,tmp_path/'weights','cpu')
    failed=[w for w in warnings if w['kind'].startswith('correction_')]
    assert failed==[
        dict(frame=1,kind='correction_include_missed',track_ids=[7]),
        dict(frame=1,kind='correction_exclude_failed',track_ids=[7])]
    labels=np.load(tmp_path/'masks'/'000001.npy')
    assert labels[10,12]==9 and labels[10,6]==7
