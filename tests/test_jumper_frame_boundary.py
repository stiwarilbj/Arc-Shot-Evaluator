import json
from pathlib import Path
import numpy as np
import pytest
from backend.jumper.frame_boundary import FrameBoundary
from backend.jumper.small_player import small_player_crop,padded_source_crop,source_crop_prompt,project_refinement,accept_refinement,SmallPlayerRefiner
from backend.jumper.mask_quality import mask_extents
from backend.jumper.mask_outline import outline_changes

CASES=json.loads((Path(__file__).parent/'fixtures/jumper/frame-boundary.json').read_text())

@pytest.mark.parametrize('f',CASES,ids=lambda f:f['name'])
def test_shared_frame_cropping(f):
    check=FrameBoundary();tracks=[dict(id=1,ignored=f.get('ignored',False),prompts=[dict(frame=f.get('start',0))])]
    for n in range(f['frames']):
        owners=np.zeros((f['height'],f['width']),np.uint8)
        for identity,l,t,r,b in f['masks']:owners[t:b,l:r]=identity
        before=owners.copy()
        boxes=[] if n in f.get('missing',[]) else [f['box']]
        if f.get('duplicate'):boxes.append(f['box'])
        hands=[[*f['box'],*f['wrists']]] if 'wrists' in f else []
        warnings=check.inspect(f.get('at',list(range(f['frames'])))[n],owners,tracks,1,boxes,hands,n in f.get('resets',[]))
        assert warnings==[dict(frame=at,kind='frame_cropped',track_ids=[1]) for at in f['expected'][n]],n
        assert np.array_equal(owners,before)
        owners.fill(0)

CROPS=[(100,100,[0,30,15,60]),(100,100,[85,30,100,60]),(100,100,[30,0,50,30]),(100,100,[30,70,50,100]),(100,100,[0,0,20,30]),(100,100,[80,70,100,100]),(60,140,[0,40,10,80])]

@pytest.mark.parametrize('width,height,rect',CROPS)
def test_padded_crop_round_trips_and_preservation(width,height,rect):
    coarse=np.full((height,width),-3,np.float32)
    l,t,r,b=rect;coarse[t:b,l:r]=3
    crop=small_player_crop(coarse)
    assert crop and not crop['unusable'] and any(crop['padding'])
    sw,sh=373,281
    region=padded_source_crop(crop,width,height,sw,sh)
    prompt=source_crop_prompt(crop,width,height,sw,sh)
    for p,q in zip(crop['points'],prompt['points']):
        assert (region['x']+q[0]*region['input_width']-region['left'])/sw==pytest.approx((crop['x']+p[0]*crop['width'])/width)
        assert (region['y']+q[1]*region['input_height']-region['top'])/sh==pytest.approx((crop['y']+p[1]*crop['height'])/height)
    ys,xs=np.indices((256,256))
    ramp=((xs+.5)/256+2*(ys+.5)/256).astype(np.float32)
    result=project_refinement(ramp,crop,width,height,sw,sh)
    y,x=np.indices((crop['height'],crop['width']))
    u=((crop['x']+x+.5)*sw/width-region['x']+region['left'])/region['input_width']
    v=((crop['y']+y+.5)*sh/height-region['y']+region['top'])/region['input_height']
    np.testing.assert_allclose(result,u+2*v,atol=1e-6)
    sx=(xs+.5)/256*region['input_width']-region['left'];sy=(ys+.5)/256*region['input_height']-region['top']
    outside=np.where((sx<0)|(sy<0)|(sx>=region['width'])|(sy>=region['height']),3,-3).astype(np.float32)
    assert np.all(project_refinement(outside,crop,width,height,sw,sh)<=0)
    x,y,cw,ch=(crop[k] for k in ['x','y','width','height'])
    candidate=coarse[y:y+ch,x:x+cw].copy();owners=(coarse>0).astype(np.uint8)
    assert accept_refinement(coarse,candidate,crop,owners,1) is not None
    if x==0:candidate[:,0]=-3
    if y==0:candidate[0]=-3
    if x+cw==width:candidate[:,-1]=-3
    if y+ch==height:candidate[-1]=-3
    assert accept_refinement(coarse,candidate,crop,owners,1) is None


def test_padding_pixels_are_neutral_and_prompts_use_same_input():
    coarse=np.full((100,100),-3,np.float32);coarse[:30,:20]=3
    crop=small_player_crop(coarse)
    image=np.full((281,373,3),[24,70,180],np.uint8)
    region=padded_source_crop(crop,100,100,373,281)
    class Predictor:
        def set_image(self,pixels):
            assert pixels.shape==(region['input_height'],region['input_width'],3)
            assert np.all(pixels[:region['top']]==114)
            assert np.all(pixels[:,:region['left']]==114)
            assert np.all(pixels[region['top']:region['top']+region['height'],region['left']:region['left']+region['width']]==[24,70,180])
        def predict(self,**kwargs):
            prompt=source_crop_prompt(crop,100,100,373,281)
            np.testing.assert_allclose(kwargs['point_coords'],np.array(prompt['points'])*[region['input_width'],region['input_height']],atol=1e-5)
            return np.full((1,region['input_height'],region['input_width']),-3,np.float32),np.ones(1,np.float32),np.full((1,256,256),-3,np.float32)
        def reset_predictor(self):pass
    refiner=SmallPlayerRefiner.__new__(SmallPlayerRefiner);refiner.predictor=Predictor()
    assert refiner.refine(image,coarse,crop,(coarse>0).astype(np.uint8),1) is None


def test_outline_only_compares_observed_pixels():
    a=np.zeros((100,100),np.uint8);b=a.copy()
    for y in range(80):
        a[y,40:(50 if y<30 else 60)]=1
        if y>=5:b[y-5,40:(50 if y<30 else 60)]=1
    assert outline_changes(a,b,1,mask_extents(a)[1],mask_extents(b)[1])==dict(outline=False,fragmented=False)
