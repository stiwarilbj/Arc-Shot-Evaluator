/** Versioned timing contract. Source timestamps are absolute presentation times in microseconds. */
export interface SourceFrameMap {
  version: 1;
  origin_us: number;
  start_us: number;
  end_us: number;
  frames: { source_index: number; source_us: number; duration_us: number }[];
}
export const micros = (seconds: number) => Math.round(seconds * 1_000_000);
export const frameCount = (start: number, end: number) => Math.ceil((micros(end) - micros(start)) * 30 / 1_000_000);

export function buildFrameMap(
  source: { timestamp: number; duration: number }[],
  start: number,
  end: number,
): SourceFrameMap {
  if (!Number.isFinite(start) || !Number.isFinite(end) || source.some(s => !Number.isFinite(s.timestamp) || !Number.isFinite(s.duration) || s.duration < 0))
    throw Error("The video has invalid source-frame timing");
  const sorted = source.filter(s => micros(s.timestamp) >= 0).sort((a,b) => a.timestamp-b.timestamp);
  if (!sorted.length || sorted.length > 100_000) throw Error("The video has no supported source-frame timeline");
  const frames = sorted.map((s, index) => {
    const time = micros(s.timestamp), next = sorted[index+1];
    const duration = next ? micros(next.timestamp)-time : micros(s.duration);
    if (!Number.isSafeInteger(time) || !Number.isSafeInteger(duration) || duration < 0 || (duration === 0 && next))
      throw Error("The video has duplicate or invalid frame timestamps · Try another export");
    return { source_index: index, source_us: time, duration_us: duration };
  });
  const origin = frames[0].source_us, startUS = micros(start), endUS = micros(end);
  const count = frameCount(start,end);
  if (startUS < 0 || count < 1 || count > 450 || endUS <= startUS ||
      origin+endUS > frames.at(-1)!.source_us+frames.at(-1)!.duration_us+2)
    throw Error("The selected segment extends beyond the source-frame timeline");
  let at = 0;
  const mapped: SourceFrameMap['frames'] = [];
  for(let frame=0;frame<count;frame++) {
    const time = origin+startUS+frame*1_000_000/30;
    while(at+1<frames.length && frames[at+1].source_us<=time+0.5) at++;
    mapped.push({...frames[at]});
  }
  const result: SourceFrameMap = { version:1, origin_us:origin, start_us:startUS, end_us:endUS, frames:mapped };
  if (!validFrameMap(result)) throw Error("The selected segment needs unavailable source-frame timing");
  return result;
}

export function validFrameMap(value: unknown, start?: number, end?: number): value is SourceFrameMap {
  const m=value as SourceFrameMap;
  if(!m || m.version!==1 || ![m.origin_us,m.start_us,m.end_us].every(n=>Number.isSafeInteger(n)&&n>=0) ||
     m.end_us<=m.start_us || m.end_us-m.start_us>15_000_000 ||
     (start!==undefined && m.start_us!==micros(start)) || (end!==undefined && m.end_us!==micros(end)) ||
     !Array.isArray(m.frames) || m.frames.length!==frameCount(m.start_us/1e6,m.end_us/1e6) || m.frames.length>450) return false;
  return m.frames.every((f,i)=> {
    const previous=m.frames[i-1], time=m.origin_us+m.start_us+i*1e6/30;
    return !!f && [f.source_index,f.source_us,f.duration_us].every(Number.isSafeInteger) &&
      f.source_index>=0 && f.source_index<100_000 && f.source_us>=m.origin_us && f.duration_us>0 &&
      f.source_us<=time+.5 && time<f.source_us+f.duration_us+.5 &&
      (!previous || (f.source_index>=previous.source_index && f.source_us>=previous.source_us &&
        (f.source_index===previous.source_index ? (f.source_us===previous.source_us && f.duration_us===previous.duration_us) : f.source_us>previous.source_us)));
  });
}

/** Seek just inside the mapped frame to avoid floating-point ambiguity at its leading edge. */
export function sourceFrameTime(map: SourceFrameMap, frame: number) {
  const f=map.frames[frame];
  if(!f || !Number.isInteger(frame)) throw Error("Frame is outside the source-frame map");
  return (f.source_us+Math.min(1000,f.duration_us/2))/1e6;
}
export function verifySourceFrame(map: SourceFrameMap, frame: number, sample: {timestamp:number}|null) {
  if(!sample || Math.abs(micros(sample.timestamp)-map.frames[frame].source_us)>2)
    throw Error(`Source frame ${frame+1} decoded at a different timestamp · Reload the video and retry`);
}

export function sameFrameMap(a: SourceFrameMap | undefined, b: SourceFrameMap | undefined) {
  return !!a && !!b && a.version===b.version && a.origin_us===b.origin_us &&
    a.start_us===b.start_us && a.end_us===b.end_us && a.frames.length===b.frames.length &&
    a.frames.every((f,i)=>f.source_index===b.frames[i].source_index && f.source_us===b.frames[i].source_us && f.duration_us===b.frames[i].duration_us);
}

/** Encoders and media elements round 1/30 timestamps to microseconds. */
export function outputFrameAtTime(map: SourceFrameMap, time: number) {
  return Math.max(0, Math.min(map.frames.length - 1, Math.floor((time + .000002) * 30)));
}
