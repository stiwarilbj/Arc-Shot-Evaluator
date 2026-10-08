import { readCompressedJson } from "./compressedJson";
import type { PlayClip } from './types';
const cache = new Map<string, Promise<Record<string, PlayClip>>>();
export async function loadClipDetails(clip: PlayClip): Promise<PlayClip> {
 if(clip.mp4)return clip;
 const path=clip.detailPath;
 if(!path?.startsWith('details/')||path.includes('..'))throw new Error('This clip’s detail reference is unavailable');
 if(!cache.has(path))cache.set(path,(async()=>{
  const response=await fetch(`${import.meta.env.BASE_URL}nba-index/${path}`);
  if(!response.ok)throw new Error("Could not load this clip's video details");
  return readCompressedJson(response) as Promise<Record<string, PlayClip>>;
 })());
 try {const record=(await cache.get(path)!)[clip.id];if(!record?.mp4)throw new Error('This clip’s asset is unavailable');return record;}
 catch(error){cache.delete(path);throw error;}
}
