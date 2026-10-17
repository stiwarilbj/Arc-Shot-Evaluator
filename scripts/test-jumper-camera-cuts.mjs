import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CameraCuts} from '../frontend/src/features/jumper/cameraCuts.ts';
const fixtures=JSON.parse(readFileSync(new URL('../tests/fixtures/jumper/camera-cuts.json',import.meta.url)));
function image(f,channels=4) {
  const rgb=new Uint8Array(64*36*channels);
  for(let y=0;y<36;y++) for(let x=0;x<64;x++) {
    let h=(Math.imul(x+(f.x??0)+101,374761393)+Math.imul(y+(f.y??0)+101,668265263)+Math.imul(f.seed??1,1274126177))>>>0;
    h=Math.imul(h^(h>>>13),1274126177)>>>0;h=(h^(h>>>16))>>>0;
    const value=f.flat??Math.max(0,Math.min(255,Math.floor((32+h%160)*(f.gain??1)+(f.offset??0)+.5)));
    for(let c=0;c<channels;c++) rgb[(y*64+x)*channels+c]=c===3?255:value;
  }
  return rgb;
}
for(const f of fixtures) for(const channels of [3,4]) {
  const monitor=new CameraCuts(),cuts=[];
  for(const [i,frame] of f.frames.entries()) {
    const rgb=image(frame,channels),copy=rgb.slice();
    cuts.push(...monitor.inspect(frame.frame??i,rgb,channels).cuts);
    assert.deepEqual(rgb,copy,'thumbnail remains unchanged');
    rgb.fill(0); // retained features must not alias decoded frame storage
  }
  cuts.push(...monitor.finish());
  assert.deepEqual(cuts,f.cuts,`${f.name}, ${channels} channels`);
  assert.deepEqual(monitor.finish(),[],'flush is exactly once');
}
const temporal=new CameraCuts();
for(let i=0;i<5;i++) {
  const result=temporal.inspect(i,image(i>=2?{seed:5}:{}));
  assert.deepEqual(result.cuts,i===4?[2]:[],'confirmed cuts retain the original boundary and wait for two neighbors');
}
assert.deepEqual(temporal.finish(),[]);
console.log(`${fixtures.length} shared camera-cut fixtures passed: flashes, exposure, pans, cuts, temporal confirmation, truncated ends and immutable history`);
