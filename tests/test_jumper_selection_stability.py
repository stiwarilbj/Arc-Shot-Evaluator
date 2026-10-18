import copy
import json
from pathlib import Path
import numpy as np
import pytest
from backend.jumper.selection_stability import selection_probes, stable_selection, check_opening_selection

FIXTURES=json.loads((Path(__file__).parent/'fixtures/jumper/selection-stability.json').read_text())


def mask(rects):
    result=np.full((256,256),-4,dtype=np.float32)
    for x,y,w,h in rects:
        result[y:y+h,x:x+w]=4
    return result


@pytest.mark.parametrize('f',FIXTURES['comparisons'],ids=lambda f:f['name'])
def test_shared_comparisons(f):
    assert stable_selection(mask(f['a']),mask(f['b'])) == f['stable']


def test_nearby_prompts_preserve_user_evidence():
    baseline=mask([[70,35,80,180]])
    prompt=dict(frame=0,box=[.2,.1,.7,.9],points=[[.4,.5],[.43,.6],[.65,.2]],labels=[1,1,0])
    original=copy.deepcopy(prompt)
    probes=selection_probes(prompt,baseline)
    assert [p['points'][0] for p in probes] == FIXTURES['points']
    for probe in probes:
        assert probe['box']==prompt['box'] and probe['labels']==prompt['labels']
        assert probe['points'][1:]==prompt['points'][1:]
    probes[0]['points'][1][0]=0
    assert prompt==original
    assert selection_probes(dict(frame=0,points=[[.4,.5]],labels=[1]),baseline)==[]
    with pytest.raises(ValueError,match='another Include point'):
        selection_probes(prompt,mask([[102,128,1,1]]))
    bad=baseline.copy();bad[0,0]=np.nan
    assert not stable_selection(bad,baseline)


def test_native_probes_are_independent_and_rejected_before_propagation(monkeypatch):
    import torch
    import backend.jumper.frames as frames
    prompt=dict(frame=0,box=[.2,.1,.7,.9],points=[[.4,.5]],labels=[1])
    states=[]
    monkeypatch.setattr(frames,'bounded_state',lambda predictor,paths: states.append({}) or states[-1])
    class Predictor:
        def __init__(self,unstable=False):
            self.calls=[];self.unstable=unstable;self.resets=0
        def reset_state(self,state):
            state.clear();self.resets+=1
        def add_new_points_or_box(self,state,**kwargs):
            assert state=={} # No prediction from a different prompt can condition this one.
            self.calls.append(kwargs)
            low=mask([[70,35,80,180]] if not self.unstable or len(self.calls)==1 else [[90,80,40,60]])
            state.update(obj_id_to_idx={7:0},temp_output_dict_per_obj={0:{'cond_frame_outputs':{0:{'pred_masks':torch.tensor(low)[None,None]}}}})
    stable=Predictor()
    check_opening_selection(stable,[Path('first.jpg'),Path('later.jpg')],prompt,7,640,480)
    assert len(stable.calls)==4 and states[-1]=={}
    unstable=Predictor(True)
    with pytest.raises(ValueError,match='another Include point'):
        check_opening_selection(unstable,[Path('first.jpg')],prompt,7,640,480)
    assert len(unstable.calls)==2 and states[-1]=={}
    assert prompt['points']==[[.4,.5]]
