import json
from pathlib import Path
import numpy as np
import pytest
from backend.jumper.memory_quality import reliable_mask,MemoryQualityGate

CASES=json.loads((Path(__file__).parent/'fixtures/jumper/memory-quality.json').read_text())


def pixels(rect,value=3,strong=None):
    result=np.full((256,256),-3,np.float32)
    if rect:
        x,y,w,h=rect
        result[y:y+h,x:x+w]=value
        if strong is not None:
            for i in range(strong):result[y+i//w,x+i%w]=3
    return result


@pytest.mark.parametrize('f',CASES,ids=lambda f:f['name'])
def test_shared_admission_rules(f):
    current=pixels(f['rect'],f.get('value',3),f.get('strong'));before=current.copy()
    previous=pixels(f['previous']) if f.get('previous') else None
    assert reliable_mask(current,previous,f.get('score',1))==f['expected']
    assert np.array_equal(current,before)


@pytest.mark.parametrize('reverse',[False,True])
def test_native_memory_filter_retention_and_recovery(reverse):
    import torch
    def output(values):
        return dict(pred_masks=torch.from_numpy(values)[None,None],object_score_logits=torch.ones(1,1),
                    obj_ptr=torch.ones(1,256),maskmem_features=torch.ones(1,64,64,64))
    seed=50 if reverse else 0;direction=-1 if reverse else 1
    outputs=dict(cond_frame_outputs={},non_cond_frame_outputs={})
    state=dict(obj_idx_to_id={0:7},obj_id_to_idx={7:0},output_dict_per_obj={0:outputs})
    class Predictor:
        calls=[]
        def _prepare_memory_conditioned_features(self,frame_idx,is_init_cond_frame,output_dict,track_in_reverse=False):
            self.calls.append((frame_idx,output_dict))
            assert all(out.get('_jumper_reliable',True) for group in output_dict.values() for out in group.values())
        def _run_single_frame_inference(self,inference_state,output_dict,frame_idx,batch_size,is_init_cond_frame,
                point_inputs,mask_inputs,reverse,run_mem_encoder,prev_sam_mask_logits=None):
            self._prepare_memory_conditioned_features(frame_idx,is_init_cond_frame,output_dict,reverse)
            step=(frame_idx-seed)*direction
            values=pixels([30,80,10,10],.2 if 2<=step<=30 else 3)
            value=output(values)
            return value,value['pred_masks']
    predictor=Predictor();warnings=[]
    original=predictor._run_single_frame_inference
    with MemoryQualityGate(predictor,lambda f,i:warnings.append((f,i))) as gate:
        for step in range(42):
            at=seed+step*direction
            value,actual=predictor._run_single_frame_inference(state,outputs,at,1,step==0,
                {} if step==0 else None,None,reverse,True)
            outputs['cond_frame_outputs' if step==0 else 'non_cond_frame_outputs'][at]=value
            assert bool(value['_jumper_reliable'])==(step<2 or step>30)
            if 2<=step<=30:assert float(actual.max())==pytest.approx(.2),'Rejected footage stays actual'
            if step==25:
                filtered=predictor.calls[-1][1]
                assert seed+direction in filtered['cond_frame_outputs'],'Last reliable frame survives pruning'
                assert seed+direction not in filtered['non_cond_frame_outputs'],'Fallback pointer is not duplicated'
                assert not any(out.get('_jumper_reliable') is False for out in filtered['non_cond_frame_outputs'].values())
            for old in list(outputs['non_cond_frame_outputs']):
                if (at-old)*direction>15:del outputs['non_cond_frame_outputs'][old]
        assert len(gate.last)==1
        gate.reset_object(state,7);assert not gate.last
    assert predictor._run_single_frame_inference==original
    assert len(warnings)==29 and all(identity==7 for _,identity in warnings)


def test_no_reliable_seed_fails_recoverably():
    gate=MemoryQualityGate(object(),lambda *args:None)
    outputs=dict(cond_frame_outputs={0:dict(_jumper_reliable=False)},non_cond_frame_outputs={})
    with pytest.raises(ValueError,match='No reliable player reference at frame 2'):
        gate.prepare(lambda **args:None,dict(is_init_cond_frame=False,output_dict=outputs,frame_idx=1,track_in_reverse=False))


def test_explicit_prompt_can_reanchor_without_resetting_other_players():
    import torch
    outputs=dict(cond_frame_outputs={},non_cond_frame_outputs={})
    other=dict(cond_frame_outputs={},non_cond_frame_outputs={})
    def output(rect):
        return dict(pred_masks=torch.from_numpy(pixels(rect))[None,None],object_score_logits=torch.ones(1,1))
    outputs['cond_frame_outputs'][0]=output([20,100,20,40])
    state=dict(obj_idx_to_id={0:7,1:9},obj_id_to_idx={7:0,9:1},output_dict_per_obj={0:outputs,1:other})
    gate=MemoryQualityGate(object(),lambda *args:None)
    args=dict(frame_idx=1,reverse=False,output_dict=outputs,inference_state=state,point_inputs=None,mask_inputs=None,
              is_init_cond_frame=False)
    def infer(**args):
        value=output([100,100,20,40]);return value,value['pred_masks']
    assert not gate.infer(infer,args)[0]['_jumper_reliable']
    assert gate.infer(infer,{**args,'point_inputs':{}})[0]['_jumper_reliable']
    # Simulate an installed adapter to exercise identity-specific reset.
    gate.originals['fixture']=None
    gate.last={(id(outputs),False):(0,outputs['cond_frame_outputs'][0]),
               (id(other),False):(0,output([30,80,10,10]))}
    gate.reset_object(state,7)
    assert list(gate.last)==[(id(other),False)]


ORDER_CASES = json.loads((Path(__file__).parent/'fixtures/jumper/memory-order.json').read_text())


@pytest.mark.parametrize('case', ORDER_CASES, ids=lambda case:case['name'])
def test_native_attention_uses_only_directional_frame_identities(case):
    outputs = {name: {key: dict(_jumper_frame=frame, label=frame)
                     for key, frame in case[source]}
               for name, source in [('cond_frame_outputs','conditions'),
                                    ('non_cond_frame_outputs','recent')]}
    before = {key: dict(group) for key,group in outputs.items()}
    gate = MemoryQualityGate(object(), lambda *args: None)
    args = dict(is_init_cond_frame=False, output_dict=outputs,
                frame_idx=case['frame'], track_in_reverse=case['reverse'])
    if case.get('error'):
        with pytest.raises(ValueError, match='No reliable player reference'):
            gate.prepare(lambda **kwargs: pytest.fail('Noncausal attention ran'), args)
    else:
        filtered = gate.prepare(lambda **kwargs: kwargs['output_dict'], args)
        assert list(filtered['cond_frame_outputs']) == case['spatial'][:1]
        assert list(filtered['non_cond_frame_outputs']) == case['spatial'][1:]
        assert [at for at,_ in gate.references(outputs,case['frame'],case['reverse'])] == list(reversed(case['pointers']))
    assert outputs == before, 'Filtering must preserve stored correction anchors'


@pytest.mark.parametrize('reverse', [False, True])
def test_direction_change_does_not_reuse_wrong_side_saved_fallback(reverse):
    at = 5 if reverse else 15
    outputs = dict(cond_frame_outputs={at: {}}, non_cond_frame_outputs={})
    gate = MemoryQualityGate(object(), lambda *args: None)
    gate.last[(id(outputs),reverse)] = (at,{})
    with pytest.raises(ValueError, match='No reliable player reference'):
        gate.prepare(lambda **args: pytest.fail('Saved future memory leaked'),
                     dict(is_init_cond_frame=False,output_dict=outputs,frame_idx=10,track_in_reverse=reverse))


def test_same_frame_explicit_prompt_remains_independent():
    gate = MemoryQualityGate(object(), lambda *args: None)
    outputs = dict(cond_frame_outputs={0:{}}, non_cond_frame_outputs={})
    received = gate.prepare(lambda **args:args, dict(is_init_cond_frame=True,
                  output_dict=outputs,frame_idx=0,track_in_reverse=False))
    assert received['is_init_cond_frame'] is True
    assert received['output_dict'] is outputs


def test_later_first_selection_stays_invisible_until_its_frame():
    import torch
    outputs = dict(cond_frame_outputs={10:{}}, non_cond_frame_outputs={})
    gate = MemoryQualityGate(object(), lambda *args:pytest.fail('Unselected player warned'))
    args = dict(frame_idx=5,reverse=False,output_dict=outputs,batch_size=1,
                is_init_cond_frame=False,point_inputs=None,mask_inputs=None,
                inference_state=dict(device='cpu',storage_device='cpu'))
    output, masks = gate.infer(lambda **args:pytest.fail('Future first selection used'),args)
    assert masks.shape == (1,1,256,256)
    assert torch.all(masks < 0)
    assert output['_jumper_reliable'] is False
    assert output['_jumper_frame'] == 5
    assert output['maskmem_features'] is None
    assert output['object_score_logits'].item() < 0
    assert outputs['cond_frame_outputs'] == {10:{}}
