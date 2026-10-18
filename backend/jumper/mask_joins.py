"""Review-only pair diagnostics, equivalent to maskJoins.ts. No mask modification."""
import math
import numpy as np


class MaskJoins:
    def __init__(self, width, height):
        scale = min(1, 128 / max(width, height))
        self.width, self.height = max(1, math.floor(width*scale)), max(1, math.floor(height*scale))
        self.masks, self.previous, self.pending = {}, {}, {}
        self.previous_owners, self.previous_frame = None, -2
        self.y, self.x = np.indices((self.height,self.width))

    def begin(self):
        self.masks.clear()

    def sample(self, values):
        height,width=values.shape
        xs=np.floor((np.arange(self.width)+.5)*width/self.width).astype(int)
        ys=np.floor((np.arange(self.height)+.5)*height/self.height).astype(int)
        return values[np.ix_(ys,xs)].copy()

    def add(self, identity, values):
        pixels=self.sample(values)>0
        core=np.zeros_like(pixels)
        core[1:-1,1:-1]=(pixels[1:-1,1:-1] & pixels[1:-1,:-2] & pixels[1:-1,2:] & pixels[:-2,1:-1] & pixels[2:,1:-1])
        area=int(pixels.sum())
        ys,xs=np.nonzero(pixels)
        bounds=(int(xs.min()),int(ys.min()),int(xs.max()+1),int(ys.max()+1)) if area else (self.width,self.height,0,0)
        self.masks[identity]=dict(pixels=pixels,core=core,area=area,bounds=bounds,
                                  x=float((self.x*pixels).sum())/(area or 1),y=float((self.y*pixels).sum())/(area or 1))

    def aligned(self, values, dx, dy):
        px,py=self.x-dx,self.y-dy
        valid=(px>=0)&(px<self.width)&(py>=0)&(py<self.height)
        return values[np.clip(py,0,self.height-1),np.clip(px,0,self.width-1)]*valid

    def inspect(self, frame, labels, tracks, boxes=None, reset=False):
        if reset or frame != self.previous_frame+1:
            self.previous={};self.previous_owners=None;self.pending={}
        owners=self.sample(labels)
        active=[t for t in tracks if not t.get('ignored') and frame>=t['prompts'][0]['frame'] and t['id'] in self.masks]
        warnings,next_pending,emitted=[],{},set()
        detection_cache={}
        for a in active:
            for b in active:
                aid,bid=a['id'],b['id']
                if aid==bid:continue
                ca,cb=self.masks[aid],self.masks[bid]
                ab,bb=ca['bounds'],cb['bounds']
                if ab[2]<=bb[0] or bb[2]<=ab[0] or ab[3]<=bb[1] or bb[3]<=ab[1]:continue
                key=(aid,bid);pending=self.pending.get(key)
                baseline=pending.get('baseline') if pending else None
                if baseline is None and aid in self.previous and bid in self.previous and self.previous_owners is not None:
                    baseline=dict(a=self.previous[aid],b=self.previous[bid],owners=self.previous_owners)
                core=int(cb['core'].sum())
                shared=cb['core'] & ca['pixels']
                claimed=shared & (owners==aid)
                if core<12 or shared.sum()/core<.4 or claimed.sum()/core<.3:continue
                takeover=False
                if baseline:
                    # JavaScript Math.round semantics, including negative halves.
                    dx=math.floor(cb['x']-baseline['b']['x']+.5);dy=math.floor(cb['y']-baseline['b']['y']+.5)
                    old_b=self.aligned(baseline['b']['pixels'],dx,dy).astype(bool)
                    old_a=self.aligned(baseline['a']['pixels'],dx,dy).astype(bool)
                    old_owned=self.aligned(baseline['owners']==bid,dx,dy).astype(bool)
                    newly=int((claimed & old_b & ~old_a & old_owned).sum())
                    ax=math.floor(ca['x']-baseline['a']['x']+.5);ay=math.floor(ca['y']-baseline['a']['y']+.5)
                    retained=int((ca['pixels'] & self.aligned(baseline['a']['pixels'],ax,ay).astype(bool)).sum())
                    retained=max(retained,int((ca['pixels'] & baseline['a']['pixels']).sum()))
                    takeover=newly>=6 and newly/core>=.25 and retained/max(1,baseline['a']['area'])>=.65
                detection=detection_cache.get(aid)
                if not takeover and detection is None:
                    supported=[]
                    for box in boxes or []:
                        cx,cy=(box[0]+box[2])/2,(box[1]+box[3])/2
                        hw,hh=(box[2]-box[0])*.2,(box[3]-box[1])*.3
                        inside=((self.x+.5)/self.width>=cx-hw)&((self.x+.5)/self.width<cx+hw)&((self.y+.5)/self.height>=cy-hh)&((self.y+.5)/self.height<cy+hh)
                        count=int(inside.sum())
                        if count>=6 and (inside & ca['pixels']).sum()/count>=.6 and (inside & (owners==aid)).sum()/count>=.5:supported.append(box)
                    detection=any(abs((p[0]+p[2]-q[0]-q[2])/2)>min(p[2]-p[0],q[2]-q[0])*.6 or
                                  abs((p[1]+p[3]-q[1]-q[3])/2)>min(p[3]-p[1],q[3]-q[1])*.6
                                  for i,p in enumerate(supported) for q in supported[i+1:])
                    detection_cache[aid]=detection
                if not takeover and not detection:continue
                first=pending['first'] if pending else frame
                next_pending[key]=dict(first=first,baseline=baseline)
                if not pending:continue
                for at in ((first,frame) if frame==first+1 else (frame,)):
                    stamp=(at,*sorted((aid,bid)))
                    if stamp not in emitted:warnings.append(dict(frame=at,kind='mask_joined',track_ids=[aid,bid]))
                    emitted.add(stamp)
        self.pending=next_pending;self.previous=dict(self.masks);self.previous_owners=owners;self.previous_frame=frame
        return warnings
