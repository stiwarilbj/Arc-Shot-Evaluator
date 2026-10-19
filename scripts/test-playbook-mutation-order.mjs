import { installBrowserLocks } from './helpers/browser-locks.mjs';
import assert from 'node:assert/strict';
import { build } from '../frontend/node_modules/vite/dist/node/index.js';
import { createPlayMutationQueue } from '../frontend/src/features/playbook/playMutationQueue.ts';
import { createSharedLibraryRead } from '../frontend/src/features/playbook/sharedLibraryRead.ts';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b; }); return {promise,resolve,reject}; };
const flush = async () => { for(let i=0;i<24;i++)await Promise.resolve(); };
{
  const queue=createPlayMutationQueue(), first=deferred(), other=deferred(), events=[];
  const a=queue('one',async()=>{events.push('save');await first.promise;events.push('saved');return 1;});
  const b=queue('one',()=>{events.push('rename');return 2;});
  const c=queue('one',()=>{events.push('delete');return 3;});
  const d=queue('two',async()=>{events.push('other');await other.promise;return 4;});
  await flush();assert.deepEqual(events,['save','other'],'only the first mutation for each play starts');
  first.resolve();assert.deepEqual(await Promise.all([a,b,c]),[1,2,3]);assert.deepEqual(events,['save','other','saved','rename','delete']);
  other.resolve();assert.equal(await d,4);
  const failed=queue('one',()=>{throw new Error('write failed');});
  const retry=queue('one',()=>5);await assert.rejects(failed,/write failed/);assert.equal(await retry,5);
  const rejected=queue('one',async()=>{throw new Error('response failed');});
  const later=queue('one',()=>6);await assert.rejects(rejected,/response failed/);assert.equal(await later,6);
  for(let i=0;i<100;i++)assert.equal(await queue('one',()=>i),i,'settled identities can be reused after cleanup');
}
{
  // Readers must wait for queued work too, including its final failure.
  const queue=createPlayMutationQueue(), gate=deferred();let data='old',reads=0;
  const library=createSharedLibraryRead(()=>{reads++;return data;});
  const a=library.mutate(()=>queue('one',async()=>{await gate.promise;data='saved';}));
  const b=library.mutate(()=>queue('one',()=>{data='renamed';}));
  const c=library.mutate(()=>queue('one',()=>{throw new Error('delete failed');}));
  const failure=assert.rejects(c,/delete failed/), read=library.read();
  await flush();assert.equal(reads,0);gate.resolve();await Promise.all([a,b,failure]);assert.equal(await read,'renamed');
}
const document=(id,name='Original')=>({version:1,id,name,created_at:'2026-10-15T12:00:00Z',updated_at:'2026-10-15T12:00:00Z',defenders_visible:false,players:[{id:1,x:50,y:70}],defenders:[],ball:null,arrows:[]});
installBrowserLocks();
for(const target of ['local','github-pages']){
  const output=await build({configFile:false,logLevel:'silent',define:{'import.meta.env.VITE_DEPLOY_TARGET':JSON.stringify(target)},build:{write:false,lib:{entry:new URL('../frontend/src/features/playbook/api.ts',import.meta.url).pathname,formats:['es'],fileName:'api'},minify:false}});
  const code=(Array.isArray(output)?output[0]:output).output[0].code;
  const api=await import(`data:text/javascript;base64,${Buffer.from(code+`\n// mutation order ${target}`).toString('base64')}`);
  const one=document('play-queue-one'),two=document('play-queue-two');let library=[one,two], events=[], mode='normal';
  let gate=deferred(), bodyGate=deferred(), reads=0, revision=0;
  const window=new EventTarget();globalThis.window=window;
  window.localStorage={getItem:()=>JSON.stringify(library),setItem:(_key,value)=>{const parsed=JSON.parse(value),next=parsed.plays??parsed;const deleted=library.find(p=>!next.some(n=>n.id===p.id));events.push(deleted?`delete:${deleted.id}`:`save:${next[0].name}`);library=next;}};
  globalThis.fetch=async(url,options)=>{
    if(!options?.method){reads++;return Response.json(library);}
    const id=decodeURIComponent(url.split('/').pop());
    const method=options.method;const payload=options.body?JSON.parse(options.body):null;
    events.push(`${method}:${payload?.name??id}`);
    if(payload?.name==='Slow save'){
      await gate.promise;
      assert.equal(options.headers['If-Match'], '"legacy"');
      const value={...payload,revision:(++revision).toString(16).padStart(32,'0'),updated_at:'2026-10-15T12:01:00Z'};
      library=library.map(p=>p.id===id?value:p);
      // The response body is part of the mutation, not just the HTTP headers.
      return {ok:true,json:async()=>{await bodyGate.promise;return value;}};
    }
    if(payload?.name==='Failing save')return Response.json({detail:'Save failed'},{status:503});
    if(method==='DELETE'&&mode==='delete-fails')return Response.json({detail:'Delete failed'},{status:503});
    if(!library.some(p=>p.id===id))return Response.json({detail:'Saved play not found'},{status:404});
    if(method==='DELETE'){library=library.filter(p=>p.id!==id);return Response.json({deleted:true,id});}
    const current=library.find(p=>p.id===id);
    if(options.headers['If-Match']!==`"${current.revision??'legacy'}"`)return Response.json({detail:'This play was changed by another tab or client'},{status:409});
    const result={...payload,revision:(++revision).toString(16).padStart(32,'0')};
    library=library.map(p=>p.id===id?result:p);return Response.json(result);
  };
  if(target==='local'){
    const snapshot={...one,name:'Slow save'};
    const a=api.updatePlaybook(snapshot),b=assert.rejects(api.updatePlaybook({...one,name:'New name'}),/changed by another/),c=api.deletePlaybook(one.id),d=api.updatePlaybook({...two,name:'Other play'});
    snapshot.name='Mutated caller';snapshot.players[0].x=99;
    const pendingRead=api.fetchPlaybooks();await flush();
    assert.deepEqual(events,['PUT:Slow save','PUT:Other play'],'different identities run concurrently');assert.equal(reads,0);
    gate.resolve();await flush();assert.equal(events.length,2,'queue waits for the complete body and validation');
    bodyGate.resolve();const [firstSaved]=await Promise.all([a,b,c,d]);
    assert.equal(firstSaved.name,'Slow save');assert.equal(firstSaved.players[0].x,50,'queued operations own their captured document');
    assert.deepEqual(events,['PUT:Slow save','PUT:Other play','PUT:New name',`DELETE:${one.id}`]);
    assert.equal((await pendingRead).some(p=>p.id===one.id),false,'library waits for the queued deletion');
    assert.equal(library.find(p=>p.id===two.id).name,'Other play');
    await assert.rejects(api.updatePlaybook({...one,name:'After deletion'}),/not found/);
    assert.ok(!library.some(p=>p.id===one.id),'a queued update cannot recreate a deleted play');
    library.push(document(one.id));
    const failed=api.updatePlaybook({...document(one.id),name:'Failing save'}),next=api.updatePlaybook({...document(one.id),name:'Recovered name'});
    await assert.rejects(failed,/Save failed/);const recovered=await next;assert.equal(recovered.name,'Recovered name');
    mode='delete-fails';const deletion=api.deletePlaybook(one.id),rename=api.updatePlaybook({...recovered,name:'Retained after failure'});
    await assert.rejects(deletion,/Delete failed/);assert.equal((await rename).name,'Retained after failure');mode='normal';
    const remove=api.deletePlaybook(one.id),late=api.updatePlaybook({...document(one.id),name:'Queued after deletion'});
    const missing=assert.rejects(late,/not found/);await Promise.all([remove,missing]);assert.ok(!library.some(p=>p.id===one.id));
  }else{
    const a=api.updatePlaybook({...one,name:'First save'}),b=assert.rejects(api.updatePlaybook({...one,name:'New name'}),/changed by another/),c=api.deletePlaybook(one.id),d=api.updatePlaybook({...two,name:'Other play'});
    const pendingRead=api.fetchPlaybooks();await Promise.all([a,b,c,d]);
    assert.deepEqual(events.filter(e=>e!=='save:Other play'),['save:First save',`delete:${one.id}`]);
    assert.equal((await pendingRead).some(p=>p.id===one.id),false);assert.equal(library.find(p=>p.id===two.id).name,'Other play');
    await assert.rejects(api.updatePlaybook({...one,name:'After deletion'}),/not found/);assert.ok(!library.some(p=>p.id===one.id));
    library.push(document(one.id));
    const originalSet=window.localStorage.setItem;let fail=true;
    window.localStorage.setItem=(key,value)=>{if(fail){fail=false;throw new Error('quota');}originalSet(key,value);};
    const deletion=api.deletePlaybook(one.id),rename=api.updatePlaybook({...document(one.id),name:'Retained after failure'});
    await assert.rejects(deletion,/could not be saved/);const retained=await rename;assert.equal(retained.name,'Retained after failure');
    const first=api.updatePlaybook({...retained,name:'Before deletion'}),remove=api.deletePlaybook(one.id),late=api.updatePlaybook({...document(one.id),name:'Must not recreate'});
    const missing=assert.rejects(late,/not found/);await Promise.all([first,remove,missing]);assert.ok(!library.some(p=>p.id===one.id));
  }
  console.log(`${target}: save/rename/delete order, other-play concurrency, snapshots, read barriers, failures and no resurrection passed`);
}
console.log('Per-play mutation queue passed: FIFO results, independent keys, body completion, rejection recovery and identity reuse');
