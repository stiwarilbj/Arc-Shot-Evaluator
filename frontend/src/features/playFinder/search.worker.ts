import { readCompressedJson } from "./compressedJson";
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { keywordScore, matchesClip, relevantShard } from './search';
import type { ClipManifest, PlayClip, SearchResult, WorkerRequest, WorkerResponse } from './types';
let base='', manifest: ClipManifest | null=null, generation=0;
let extractor: Promise<FeatureExtractionPipeline> | null=null;
let embeddings: Promise<Record<string, number[]>> | null=null;
const shardCache=new Map<string,PlayClip[]>();
let abort=new AbortController();
const post=(response:WorkerResponse)=>self.postMessage(response);
async function getJson(path:string, signal?:AbortSignal):Promise<unknown>{
 const response=await fetch(new URL(path,base),{signal});if(!response.ok)throw new Error(`Index download failed (${response.status})`);
 if(path.endsWith('.gz')){
  return readCompressedJson(response);
 }
 try{return await response.json();}catch{throw new Error("The NBA clip index could not be read. Retry loading the index.");}
}
async function embed(prompt:string,id:number):Promise<number[]>{
 if(!manifest)throw new Error('Index unavailable');
 if(!extractor){
  env.allowLocalModels=false;env.useBrowserCache=true;
  env.backends.onnx.wasm!.numThreads=1;
  const createPipeline = pipeline as unknown as (task: string, model: string, options: Record<string, unknown>) => Promise<FeatureExtractionPipeline>;
  extractor=createPipeline('feature-extraction',manifest.model.id,{revision:manifest.model.revision,dtype:'q8',device:'wasm',progress_callback:(info: {status: string; file?: string; progress?: number})=>{
   const progress='progress' in info?` ${Math.round(info.progress ?? 0)}%`:'';
   post({id,type:'status',message:`Preparing semantic search${progress}${'file' in info?` · ${info.file}`:''}`});
  }}) as Promise<FeatureExtractionPipeline>;
 }
 const pipe=await extractor;
 const result=await pipe(prompt,{pooling:'mean',normalize:true});return Array.from(result.data as Float32Array);
}
self.onmessage=async({data}:{data:WorkerRequest})=>{
 if(data.type==='cancel'){generation++;abort.abort();abort=new AbortController();return;}
 if(data.type==='dispose'){generation++;abort.abort();if(extractor){try{(await extractor).dispose();}catch{/* Failed initialization owns no session. */}}return;}
 if(data.type==='init'){
  base=data.base;
  try{manifest=await getJson('manifest.json') as ClipManifest;
   if(manifest.version!==2||!Array.isArray(manifest.shards)||!manifest.clips)throw new Error('No playable NBA clip index is published yet');
   post({id:data.id,type:'ready',manifest});
  }catch(error){post({id:data.id,type:'error',message:error instanceof Error?error.message:'Could not load index'});}return;
 }
 if(!manifest){post({id:data.id,type:'error',message:'Clip index is unavailable. Retry loading the index.'});return;}
 const requestGeneration=++generation;abort.abort();abort=new AbortController();const signal=abort.signal;
 const current=()=>requestGeneration===generation;
 try{
  if(data.conditions.some(c=>c.status!=='ready')){post({id:data.id,type:'results',results:[],total:0,mode:'keyword',message:'Resolve highlighted conditions to search.'});return;}
  const outside=data.conditions.find(c=>c.field==='season'&&c.operator==='equals'&&!manifest!.coverage[c.value]);
  if(outside){post({id:data.id,type:'results',results:[],total:0,mode:'keyword',message:`Season ${outside.value} is outside current indexed coverage.`});return;}
  const shards=manifest.shards.filter(s=>relevantShard(s,data.conditions,manifest!.players));
  let rows:PlayClip[]=[];
  for(let i=0;i<shards.length;i++){
   if(!current())return;const shard=shards[i];post({id:data.id,type:'status',message:`Loading NBA plays · ${i+1}/${shards.length} shards`});
   if(!shardCache.has(shard.path)){
    const loaded=await getJson(shard.path,signal) as PlayClip[];shardCache.set(shard.path,loaded);
    // Keep a bounded hot cache; the current query owns its rows independently.
    if(shardCache.size>12)shardCache.delete(shardCache.keys().next().value!);
   }
   rows.push(...shardCache.get(shard.path)!.filter(c=>matchesClip(c,data.conditions)));
  }
  if(!current())return;
  let mode:'semantic'|'keyword'='keyword',message:string|undefined;
  let vector:number[]|null=null,dictionary:Record<string,number[]>={};
  if(data.prompt.trim()&&rows.length&&data.sort==='relevance'){
   try{
    vector=await embed(data.prompt,data.id);if(!current())return;
    embeddings??=getJson(manifest.model.embeddings,signal) as Promise<Record<string,number[]>>;
    dictionary=await embeddings;mode='semantic';
   }catch(error){if(!current())return;if(extractor){try{await(await extractor).dispose();}catch{/* Initialization failed. */}}extractor=null;embeddings=null;message='Semantic model unavailable. Exact filters and keyword search are working.';}
  }
  const scores=new Map<string,number>();
  const results:SearchResult[]=rows.map(clip=>{
   let score=keywordScore(data.prompt,clip);
   if(vector&&dictionary[clip.semanticText]){
    if(!scores.has(clip.semanticText))scores.set(clip.semanticText,dictionary[clip.semanticText].reduce((sum,v,i)=>sum+v*vector![i],0));
    score=scores.get(clip.semanticText)!;
   }
   return {clip,score,why:[...data.conditions.map(c=>`${c.field}: ${c.operator==='excludes'?'excluding ':''}${c.value}`),mode==='semantic'?'Semantic description match':'Recorded NBA play']};
  });
  results.sort((a,b)=>data.sort==='date'?b.clip.date.localeCompare(a.clip.date)||b.clip.clock-a.clip.clock:b.score-a.score||b.clip.date.localeCompare(a.clip.date));
  if(current())post({id:data.id,type:'results',results:results.slice(data.page*data.pageSize,(data.page+1)*data.pageSize),total:results.length,mode,message});
 }catch(error){if(current())post({id:data.id,type:'error',message:error instanceof Error?error.message:'Search failed'});}
};
