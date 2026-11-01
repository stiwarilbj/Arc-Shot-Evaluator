"""Review-only ball-shaped wrist attachments; equivalent to ballAttachments.ts."""
import math
import numpy as np


def valid_hands(hands):
    try:
        rows=np.asarray(hands,dtype=float)
        return not len(hands) or (rows.shape==(len(hands),10) and len(hands)<=20
            and np.isfinite(rows).all() and ((rows>=0)&(rows<=1)).all()
            and (rows[:,0]<rows[:,2]).all() and (rows[:,1]<rows[:,3]).all())
    except (TypeError,ValueError):
        return False


class BallAttachments:
    def __init__(self):
        self.previous=None
        self.previous_frame=-2

    def inspect(self,frame,labels,gray,target,hands,reset=False):
        if reset or frame!=self.previous_frame+1:
            self.previous=None
        prior=self.previous
        self.previous=None
        self.previous_frame=frame
        if gray.shape!=labels.shape or not valid_hands(hands):
            return []
        height,width=labels.shape
        def owned(x,y):
            return labels[math.floor(y),math.floor(x)]==target
        supported=[]
        for row in hands:
            l,t,r,b=row[:4]
            total=hit=0
            for y in range(math.ceil((t+(b-t)*.25)*height),math.ceil((b-(b-t)*.25)*height),3):
                for x in range(math.ceil((l+(r-l)*.25)*width),math.ceil((r-(r-l)*.25)*width),3):
                    total+=1
                    hit+=int(owned(x,y))
            if total>=12 and hit/total>=.6:
                supported.append(row)
        if len(supported)!=1:
            return []
        l,t,r,b,*wrists=supported[0]
        bh=(b-t)*height
        if bh<70:
            return []
        best=None
        best_score=0
        for hand in range(2):
            nx,ny,confidence=wrists[hand*3:hand*3+3]
            if confidence<.6:
                continue
            wx,wy=nx*width,ny*height
            for fraction in [.035,.05,.065]:
                radius=max(4,bh*fraction)
                for dx in [-1,0,1]:
                    for dy in [-1,0,1]:
                        x,y=wx+dx*radius,wy+dy*radius
                        if x-radius*1.3<0 or x+radius*1.3>=width or y-radius*1.3<0 or y+radius*1.3>=height:
                            continue
                        if abs(x-(l+r)*width/2)<(r-l)*width*.23 and y<(t+(b-t)*.26)*height:
                            continue
                        filled=outside=contrast=0
                        for i in range(24):
                            angle=2*math.pi*i/24
                            c,s=math.cos(angle),math.sin(angle)
                            ix,iy=x+c*radius*.7,y+s*radius*.7
                            ox,oy=x+c*radius*1.3,y+s*radius*1.3
                            filled+=int(owned(ix,iy))
                            outside+=int(not owned(ox,oy))
                            contrast+=int(abs(int(gray[math.floor(iy),math.floor(ix)])-int(gray[math.floor(oy),math.floor(ox)]))>=18)
                        score=filled+outside+contrast
                        if filled>=21 and outside>=17 and contrast>=14 and score>best_score:
                            best=dict(x=x,y=y,radius=radius,height=bh)
                            best_score=score
        if best is None:
            return []
        self.previous=best
        if prior is None or math.hypot(best['x']-prior['x'],best['y']-prior['y'])>bh*.18 or not .65<=best['radius']/prior['radius']<=1.55:
            return []
        best['flagged']=True
        return [dict(frame=at,kind='ball_attachment',track_ids=[target])
            for at in ([frame] if prior.get('flagged') else [frame-1,frame])]
