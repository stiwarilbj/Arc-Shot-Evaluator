"""Source-supported severe cropping. Equivalent to frameBoundary.ts; never edits masks."""
import math
import numpy as np
from .ball_attachments import valid_hands


class FrameBoundary:
    def __init__(self):
        self.previous_frame=-2
        self.streak=0
        self.first=0

    def inspect(self,frame,labels,tracks,target,boxes=(),hands=(),reset=False):
        if reset or frame!=self.previous_frame+1:self.streak=0
        self.previous_frame=frame
        track=next((o for o in tracks if o['id']==target and not o.get('ignored') and o['prompts'][0]['frame']<=frame),None)
        if track is None:self.streak=0;return []
        height,width=labels.shape
        pixels=labels==target
        edge=[np.count_nonzero(pixels[:,0]),np.count_nonzero(pixels[0]),np.count_nonzero(pixels[:,-1]),np.count_nonzero(pixels[-1])]
        supported=[]
        for box in boxes:
            l,t,r,b=box
            ys=np.arange(math.ceil((t+(b-t)*.2)*height),math.ceil((b-(b-t)*.2)*height),3)
            xs=np.arange(math.ceil((l+(r-l)*.2)*width),math.ceil((r-(r-l)*.2)*width),3)
            core=pixels[np.ix_(ys,xs)]
            if core.size>=12 and np.count_nonzero(core)/core.size>=.55:supported.append(box)
        if len(supported)!=1:self.streak=0;return []
        l,t,r,b=supported[0];bw,bh=(r-l)*width,(b-t)*height
        touched=[l<=1/width,t<=1/height,r>=1-1/width,b>=1-1/height]
        severe=((touched[0] and edge[0]>=max(4,bh*.22)) or (touched[2] and edge[2]>=max(4,bh*.22))
                or (touched[1] and edge[1]>=max(3,bw*.18)) or (touched[3] and edge[3]>=max(4,bw*.65)))
        if valid_hands(hands):
            for pose in hands:
                if not all(abs(v-supported[0][i])<1e-6 for i,v in enumerate(pose[:4])):continue
                for i in (4,7):
                    if pose[i+2]<.6:continue
                    x,y=pose[i]*width,pose[i+1]*height
                    reach=max(3,math.ceil(bh*.04));near=[x<=2,y<=2,x>=width-2,y>=height-2]
                    for side in range(4):
                        if not touched[side] or not near[side]:continue
                        along,limit=(x,width) if side%2 else (y,height)
                        count=0
                        for at in range(max(0,math.floor(along-reach)),min(limit,math.ceil(along+reach))):
                            px=0 if side==0 else width-1 if side==2 else at
                            py=0 if side==1 else height-1 if side==3 else at
                            count+=int(pixels[py,px])
                        severe=severe or count>=2
        if not severe:self.streak=0;return []
        if not self.streak:self.first=frame
        self.streak+=1
        if self.streak<3:return []
        return [dict(frame=at,kind='frame_cropped',track_ids=[target])
                for at in ([self.first,self.first+1,frame] if self.streak==3 else [frame])]
