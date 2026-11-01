import json
from pathlib import Path
import numpy as np
import pytest
from backend.jumper.mask_joins import MaskJoins

FIXTURES=json.loads((Path(__file__).parent/'fixtures/jumper/mask-joins.json').read_text())

@pytest.mark.parametrize('fixture',FIXTURES,ids=lambda f:f['name'])
def test_shared_pair_fixtures(fixture):
    f=fixture
    joins=MaskJoins(f['width'],f['height'])
    tracks=[dict(id=i,ignored=i==f.get('ignored'),prompts=[dict(frame=0)]) for i in (1,2)]
    if f.get('correction'):
        tracks[0]['prompts'].append(dict(frame=f['correction']))
    for n,frame in enumerate(f['frames']):
        joins.begin()
        for identity in (1,2):
            values=np.full((f['height'],f['width']),-1,dtype=np.float32)
            for i,l,t,r,b in frame['raw']:
                if i==identity:values[t:b,l:r]=1
            joins.add(identity,values);values[:]=-100
        owners=np.zeros((f['height'],f['width']),dtype=np.uint8)
        for i,l,t,r,b in frame['owners']:owners[t:b,l:r]=i
        before=owners.copy()
        warnings=joins.inspect(frame.get('at',n),owners,tracks,f.get('boxes'),frame.get('reset',False))
        assert [w['frame'] for w in warnings]==f['expected'][n]
        assert all(w['kind']=='mask_joined' and len(w['track_ids'])==2 for w in warnings)
        assert np.array_equal(owners,before)
        owners[:]=0


def test_pipeline_records_join_without_changing_output(tmp_path,monkeypatch):
    import cv2
    import torch
    import sam2.build_sam
    from backend.jumper import pipeline,frames,cache,resources
    fixture=FIXTURES[0]
    class Predictor:
        def add_new_points_or_box(self,*args,**kwargs):pass
        def reset_state(self,*args):pass
        def propagate_in_video(self,*args,**kwargs):
            for frame in range(4):
                values=np.full((2,1,56,64),-1,dtype=np.float32)
                for identity,l,t,r,b in fixture['frames'][frame]['raw']:
                    values[identity-1,0,t:b,l:r]=(3 if frame and identity==1 else identity)
                yield frame,[1,2],torch.from_numpy(values)
    monkeypatch.setattr(sam2.build_sam,'build_sam2_video_predictor',lambda *a,**k:Predictor())
    monkeypatch.setattr(frames,'bounded_state',lambda *a:{'output_dict_per_obj':{}})
    monkeypatch.setattr(resources,'check_resources',lambda *a,**k:None)
    monkeypatch.setattr(pipeline,'check_device_mask_area',lambda *a:None)
    monkeypatch.setattr(cache,'FrameCache',lambda *a:None)
    monkeypatch.setattr(cache,'cache_backbone',lambda *a,**k:None)
    paths=[]
    for i in range(4):
        path=tmp_path/f'{i}.png';cv2.imwrite(str(path),np.zeros((56,64,3),dtype=np.uint8));paths.append(path)
    job=dict(start=0,end=4/30,target_id=1,objects=[dict(id=i,prompts=[dict(frame=0,points=[[.5,.5]],labels=[1])]) for i in (1,2)])
    warnings=pipeline.track(paths,tmp_path/'masks',job,tmp_path/'weights','cpu')
    joined=[w for w in warnings if w['kind']=='mask_joined']
    assert joined==[dict(frame=i,kind='mask_joined',track_ids=[1,2]) for i in (1,2,3)]
    # The suspect silhouette remains unchanged for review, never auto-repaired.
    labels=np.load(tmp_path/'masks'/'000002.npy')
    assert labels[20,35]==1 and labels[20,40]==2
