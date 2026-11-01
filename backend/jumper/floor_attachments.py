"""Review-only floor evidence. Keep equivalent to floorAttachments.ts; never trim."""
import math
import numpy as np


class FloorAttachments:
    def __init__(self, width, height):
        scale = min(1, 128/max(width,height))
        self.width, self.height = max(1,math.floor(width*scale)), max(1,math.floor(height*scale))
        self.pending, self.previous_frame = {}, -2
        self.y, self.x = np.indices((self.height,self.width))

    def inspect(self, frame, labels, tracks, boxes=(), reset=False):
        if reset or frame != self.previous_frame+1:
            self.pending.clear()
        h,w=labels.shape
        xs=np.floor((np.arange(self.width)+.5)*w/self.width).astype(int)
        ys=np.floor((np.arange(self.height)+.5)*h/self.height).astype(int)
        owners=labels[np.ix_(ys,xs)]
        boxes=[np.array(box)*[self.width,self.height,self.width,self.height] for box in boxes]
        warnings,next_pending=[],{}
        x,y=self.x+.5,self.y+.5
        for track in tracks:
            identity=track['id']
            if track.get('ignored') or frame < track['prompts'][0]['frame']:
                continue
            pixels=owners==identity
            supported=[]
            for box in boxes:
                l,t,r,b=box
                if r-l < 6 or b-t < 16 or b >= self.height-3:
                    continue
                core=(x>=l+(r-l)*.2)&(x<r-(r-l)*.2)&(y>=t+(b-t)*.15)&(y<b-(b-t)*.1)
                total=int(core.sum())
                if total>=12 and np.count_nonzero(core & pixels)/total>=.55:
                    supported.append(box)
            if len(supported)!=1:
                continue
            box=supported[0];l,t,r,b=box;bw,bh=r-l,b-t
            foot=math.floor(b+.5);margin=max(3,math.ceil(bh*.08))
            excluded=np.zeros(pixels.shape,dtype=bool)
            for other in boxes:
                if other is not box:
                    ol,ot,orr,ob=other
                    excluded |= (x>=ol)&(x<orr)&(y>=ot)&(y<ob)
            body_mask=pixels&(x>=l)&(x<r)&(y>=t)&(self.y<min(self.height,foot))
            body=int(body_mask.sum())
            tail_mask=pixels&(self.y>=foot+margin)&(x>=l-bw*.5)&(x<r+bw*.5)&~excluded
            tail=int(tail_mask.sum())
            if body<24 or tail<max(8,body*.08):
                continue
            bottom=int(np.nonzero(tail_mask)[0].max()+1)
            depth=(bottom-foot)/bh
            widest=int(tail_mask.sum(axis=1).max())
            foot_width=int((body_mask&(y>=b-bh*.2)).sum(axis=1).max())
            shadow=depth>=.12 and widest>=max(bw*.9,foot_width*1.4)
            intersection=union=reflected=0
            for d in range(margin,min(math.floor(bh),self.height-foot)):
                row=foot+d;above_row=foot-1-d
                valid=(x[0]>=l-bw*.1)&(x[0]<r+bw*.1)&~excluded[row]
                above=pixels[above_row] if above_row>=0 else np.zeros(self.width,dtype=bool)
                below=pixels[row]
                union+=int(np.count_nonzero((above|below)&valid))
                intersection+=int(np.count_nonzero(above&below&valid))
                reflected+=int(np.count_nonzero(below&valid))
            reflection=depth>=.3 and reflected>=max(12,body*.2) and union>0 and intersection/union>=.65
            if not shadow and not reflection:
                continue
            evidence=dict(box=box.copy(),depth=depth,ratio=tail/body)
            prior=self.pending.get(identity)
            if any(p['frame']==frame for p in track['prompts']):
                prior=None
            if prior:
                pl,pt,pr,pb=prior['box']
                if (not .7<=bh/(pb-pt)<=1.4 or np.hypot((l+r-pl-pr)/2,(t+b-pt-pb)/2)>bh*.25
                        or abs(depth-prior['depth'])>.25 or not .5<=evidence['ratio']/prior['ratio']<=2):
                    prior=None
            current=dict(**evidence,first=prior['first'] if prior else frame,count=prior['count']+1 if prior else 1)
            next_pending[identity]=current
            if current['count']>=3:
                for at in ([current['first'],current['first']+1,frame] if current['count']==3 else [frame]):
                    warnings.append(dict(frame=at,kind='floor_attachment',track_ids=[identity]))
        self.pending,self.previous_frame=next_pending,frame
        return warnings
