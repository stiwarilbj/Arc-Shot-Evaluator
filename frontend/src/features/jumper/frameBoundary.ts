import type { MaskWarning, Track } from "./domain.ts";
import { validHands } from "./ballAttachments.ts";

/** Source-supported severe cropping. Read-only and bounded per job. */
export class FrameBoundary {
  private previousFrame=-2;
  private streak=0;
  private first=0;
  inspect(frame:number,labels:Uint8Array,width:number,height:number,tracks:readonly Track[],target:number,
    boxes:readonly number[][]=[],hands:number[][]=[],reset=false):MaskWarning[] {
    if(reset || frame!==this.previousFrame+1) this.streak=0;
    this.previousFrame=frame;
    const track=tracks.find(o=>o.id===target && !o.ignored && o.prompts[0].frame<=frame);
    const edge=[0,0,0,0];
    if(!track) {this.streak=0;return [];}
    for(let y=0;y<height;y++) {
      edge[0]+=+(labels[y*width]===target);edge[2]+=+(labels[y*width+width-1]===target);
    }
    for(let x=0;x<width;x++) {
      edge[1]+=+(labels[x]===target);edge[3]+=+(labels[(height-1)*width+x]===target);
    }
    const supported=boxes.filter(([l,t,r,b])=>{
      let n=0,hit=0;
      for(let y=Math.ceil((t+(b-t)*.2)*height);y<(b-(b-t)*.2)*height;y+=3)
        for(let x=Math.ceil((l+(r-l)*.2)*width);x<(r-(r-l)*.2)*width;x+=3){
          n++;hit+=+(labels[y*width+x]===target);
        }
      return n>=12 && hit/n>=.55;
    });
    if(supported.length!==1){this.streak=0;return [];}
    const [l,t,r,b]=supported[0],bw=(r-l)*width,bh=(b-t)*height;
    const touched=[l<=1/width,t<=1/height,r>=1-1/width,b>=1-1/height];
    let severe=(touched[0] && edge[0]>=Math.max(4,bh*.22)) ||
      (touched[2] && edge[2]>=Math.max(4,bh*.22)) ||
      (touched[1] && edge[1]>=Math.max(3,bw*.18)) ||
      (touched[3] && edge[3]>=Math.max(4,bw*.65));
    // Wrist evidence can identify a small but important release crop. No inferred joints.
    if(validHands(hands)) for(const pose of hands){
      if(!pose.slice(0,4).every((v,i)=>Math.abs(v-supported[0][i])<1e-6)) continue;
      for(let i=4;i<10;i+=3){
        if(pose[i+2]<.6) continue;
        const x=pose[i]*width,y=pose[i+1]*height,reach=Math.max(3,Math.ceil(bh*.04));
        const near=[x<=2,y<=2,x>=width-2,y>=height-2];
        for(let side=0;side<4;side++) if(touched[side] && near[side]) {
          let count=0;
          const along=side%2 ? x:y,limit=side%2 ? width:height;
          for(let at=Math.max(0,Math.floor(along-reach));at<Math.min(limit,Math.ceil(along+reach));at++) {
            const px=side===0?0:side===2?width-1:at;
            const py=side===1?0:side===3?height-1:at;
            count+=+(labels[py*width+px]===target);
          }
          severe ||= count>=2;
        }
      }
    }
    if(!severe){this.streak=0;return [];}
    if(!this.streak) this.first=frame;
    this.streak++;
    if(this.streak<3)return [];
    return (this.streak===3 ? [this.first,this.first+1,frame]:[frame])
      .map(at=>({frame:at,kind:"frame_cropped",track_ids:[target]}));
  }
}
