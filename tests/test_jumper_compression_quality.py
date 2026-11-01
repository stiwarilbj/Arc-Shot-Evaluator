from contextlib import contextmanager
import threading
import cv2
import numpy as np
import pytest
from backend.jumper.compression_quality import detail_proof, validate_detail_pixels, SilhouetteCompressionError
from backend.jumper import pipeline, editing
from backend.jumper.export_checkpoint import render_with_retry


def image():
    v = np.full((96,128,3),224,np.uint8)
    v[30:80,25:50]=0
    v[18:53,49:51]=0
    v[14:18,48:53]=0
    v[22:80,54:74]=128
    v[22:80,76:96]=128
    return v


def test_details_and_codec_noise():
    v=image()
    proof=detail_proof(v)
    validate_detail_pixels(v,proof)
    validate_detail_pixels(np.minimum(v.astype(int)+12,255).astype(np.uint8),proof)
    for area in ((slice(18,38),slice(49,51),224),(slice(22,80),slice(74,76),128)):
        bad=v.copy();bad[area[0],area[1]]=area[2]
        with pytest.raises(SilhouetteCompressionError): validate_detail_pixels(bad,proof)
    assert sum(p.nbytes for p in detail_proof(np.tile(v,(8,10,1))))<=8192


def corrupt_first_encoder(monkeypatch, always=False):
    original=pipeline.encoder
    calls=[]
    @contextmanager
    def encoder(path,width,height,high_quality=False):
        calls.append(high_quality)
        with original(path,width,height,high_quality) as stream:
            class Proxy:
                def write(self,data):
                    # Keep real valid media but erase the intended thin geometry.
                    if always or not high_quality:
                        data=bytes([224])*len(data)
                    return stream.write(data)
            yield Proxy()
    monkeypatch.setattr(pipeline,'encoder',encoder)
    return calls


def sources(tmp_path):
    masks=tmp_path/'masks'; masks.mkdir()
    frames=[tmp_path/f'{i}.png' for i in range(3)]
    labels=np.zeros((96,128),np.uint8)
    v=image();labels[v[:,:,0]==0]=1;labels[v[:,:,0]==128]=2
    for i in range(3):np.save(masks/f'{i:06d}.npy',labels)
    return frames,masks


def test_real_encoding_retries_quality_from_masks_only(tmp_path,monkeypatch):
    frames,masks=sources(tmp_path) # deliberately absent source images
    before=[p.read_bytes() for p in masks.glob('*.npy')]
    calls=corrupt_first_encoder(monkeypatch)
    result=render_with_retry(pipeline.render,frames,masks,tmp_path/'out',1,'quality',start=0,silhouette=True,progress=lambda *a:None)
    assert calls==[False,True]
    assert [p.read_bytes() for p in masks.glob('*.npy')]==before
    cap=cv2.VideoCapture(str(tmp_path/'out'/result['quiz']['file']))
    try:
        ok,decoded=cap.read();assert ok
        assert decoded[25,49,0]<30
    finally:cap.release()


def test_quality_failure_not_retried_by_outer_checkpoint(tmp_path,monkeypatch):
    frames,masks=sources(tmp_path)
    calls=corrupt_first_encoder(monkeypatch,always=True)
    with pytest.raises(SilhouetteCompressionError):
        render_with_retry(pipeline.render,frames,masks,tmp_path/'out',1,'quality',start=0,silhouette=True,progress=lambda *a:None)
    assert calls==[False,True]


def test_editor_retry_is_bounded_and_cancelled(tmp_path,monkeypatch):
    calls=[]
    def attempt(*args,**kwargs):
        calls.append(kwargs.get('high_quality',False))
        raise SilhouetteCompressionError()
    monkeypatch.setattr(editing,'_render',attempt)
    cancel=threading.Event()
    with pytest.raises(SilhouetteCompressionError):editing.render(tmp_path,{},tmp_path,cancel,lambda _:None)
    assert calls==[False,True]
    calls.clear();cancel.set()
    with pytest.raises(InterruptedError):editing.render(tmp_path,{},tmp_path,cancel,lambda _:None)
    assert calls==[False]


def test_threshold_boundaries_and_size_limit(tmp_path):
    from backend.jumper.video_validation import validate_finished_video
    v=np.zeros((1,150,3),np.uint8);v[0,:3]=41
    points=np.arange(150,dtype=np.uint32)*256
    validate_detail_pixels(v,(points,np.empty(0,np.uint32)))  # exactly 2% is tolerated
    with pytest.raises(SilhouetteCompressionError):validate_detail_pixels(v,(points[:149],np.empty(0,np.uint32)))
    v[0,:3]=40
    validate_detail_pixels(v,(points[:100],np.empty(0,np.uint32)))
    large=tmp_path/'oversized.mp4'
    with large.open('wb') as f:f.truncate(100*1024*1024+1)
    with pytest.raises(ValueError,match='100 MB'):validate_finished_video(large,128,96,30)
