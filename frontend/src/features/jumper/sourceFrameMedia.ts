import { EncodedPacketSink, CanvasSink } from "mediabunny";
import { openVideo } from "./media";
import { buildFrameMap, sourceFrameTime, verifySourceFrame, type SourceFrameMap } from "./sourceFrames.ts";

// Timing only: never retain source pixels, decoded frames, or inference data.
const timelines = new WeakMap<Blob, {timestamp:number;duration:number}[]>();
export async function sourceFrameMap(file: Blob, start: number, end: number, signal?: AbortSignal): Promise<SourceFrameMap> {
  signal?.throwIfAborted();
  let times=timelines.get(file);
  if(!times) {
    const {input,track}=await openVideo(file);
    const abort=()=>input.dispose();
    signal?.addEventListener('abort',abort,{once:true});
    try {
      times=[];
      // Presentation timestamps, not decode order or average FPS. Decode verification
      // below rejects packets which do not correspond to the expected visible frame.
      for await(const packet of new EncodedPacketSink(track).packets(undefined,undefined,{metadataOnly:true})) {
        signal?.throwIfAborted();
        times.push({timestamp:packet.timestamp,duration:packet.duration});
        if(times.length>100_000) throw Error("Video has too many source frames. Upload a shorter source file.");
      }
      signal?.throwIfAborted();
      buildFrameMap(times,start,end);
      timelines.set(file,times);
    } finally {signal?.removeEventListener('abort',abort);input.dispose()}
  }
  return buildFrameMap(times,start,end);
}

export async function sourcePreview(file: Blob, map: SourceFrameMap, frame: number, signal?: AbortSignal): Promise<Blob> {
  const {input,track}=await openVideo(file);
  const abort=()=>input.dispose();signal?.addEventListener('abort',abort,{once:true});
  try {
    signal?.throwIfAborted();
    const sample=await new CanvasSink(track,{width:960,fit:'contain',poolSize:1}).getCanvas(sourceFrameTime(map,frame));
    verifySourceFrame(map,frame,sample);
    signal?.throwIfAborted();
    const canvas=sample!.canvas;
    return 'convertToBlob' in canvas ? await canvas.convertToBlob({type:'image/png'}) :
      await new Promise<Blob>((resolve,reject)=>canvas.toBlob(v=>v?resolve(v):reject(Error('Preview encoding failed')),'image/png'));
  } finally {signal?.removeEventListener('abort',abort);input.dispose()}
}
