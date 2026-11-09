import {afterEach,expect,test,spyOn} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,openSync,writeSync,closeSync,renameSync,rmSync,readFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {HistoryResolver} from '../src/mobile/herdr/history';
import type {ConversationRef,HistoryResult} from '../src/mobile/herdr/types';
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const msg=(text:string)=>JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text}]}})+'\n';
const meta=()=>JSON.stringify({type:'session_meta',payload:{id}})+'\n';
function setup(maxBytes=1024){const root=mkdtempSync(join(tmpdir(),'herdr-bounded-'));dirs.push(root);const file=join(root,`rollout-${id}.jsonl`);writeFileSync(file,meta());const ref:ConversationRef={agent:'codex',kind:'id',value:id,source:'herdr:codex'};return {root,file,ref,resolver:new HistoryResolver({codexRoot:root,claudeRoot:root,maxBytes})};}
async function ready(h:ReturnType<typeof setup>,query:any={},polls=200){let result:HistoryResult;let indexing=0;for(let n=0;n<polls;n++){result=await h.resolver.read(h.ref,query);expect(h.resolver.lastReadBytes).toBeLessThanOrEqual((h.resolver as any).options.maxBytes);if(result.kind==='messages')return {result,indexing};if(result.reason!=='history_indexing')throw new Error(result.reason);indexing++;}throw new Error('fixture_indexing_exhausted');}
test('>64MiB file indexes incrementally then stable pages read only requested records with exact absolute indices',async()=>{
 const h=setup(16*1024*1024),fd=openSync(h.file,'a');const padding=JSON.stringify({type:'progress',padding:'x'.repeat(1024*1024)})+'\n';
 for(let n=0;n<66;n++)writeSync(fd,padding);for(let n=0;n<14;n++)writeSync(fd,msg('message-'+n));closeSync(fd);
 const first=await ready(h,{limit:5});expect(first.indexing).toBeGreaterThan(0);expect(first.result.total).toBe(14);expect(first.result.start).toBe(9);expect(first.result.items.map(i=>i.i)).toEqual([9,10,11,12,13]);
 const older=await ready(h,{limit:5,before:9,epoch:first.result.epoch});expect(older.indexing).toBe(0);expect(older.result.items.map(i=>i.i)).toEqual([4,5,6,7,8]);expect(h.resolver.lastReadBytes).toBeLessThan(4096);
 const last=await ready(h,{limit:5,before:4,epoch:first.result.epoch});expect(last.result.items.map(i=>i.i)).toEqual([0,1,2,3]);expect(last.result.conversation).toBe(id);
});
test('resume indexing across polls, partial EOF excluded until completion and prefix-proven append preserves epoch',async()=>{
 const h=setup(512);for(let n=0;n<30;n++)appendFileSync(h.file,msg('old-'+n));appendFileSync(h.file,msg('partial').slice(0,-8));
 const first=await ready(h);expect(first.indexing).toBeGreaterThan(1);expect(first.result.total).toBe(30);
 appendFileSync(h.file,msg('partial').slice(-8));const next=await ready(h);expect(next.indexing).toBeGreaterThan(1);expect(next.result.total).toBe(31);expect(next.result.epoch).toBe(first.result.epoch);expect(next.result.items.at(-1)?.text).toBe('partial');
});
for(const append of [false,true])test('same-size prefix rewrite'+(append?' plus append':'')+' cannot inherit old epoch/cursor',async()=>{
 const h=setup(512);for(let n=0;n<20;n++)appendFileSync(h.file,msg('before-'+n));const first=await ready(h);
 writeFileSync(h.file,readFileSync(h.file,'utf8').replace('before-0','change-0')+(append?msg('added'):''));
 const next=await ready(h);expect(next.result.epoch).not.toBe(first.result.epoch);expect(next.result.total).toBe(append?21:20);
 const old=await h.resolver.read(h.ref,{before:1,epoch:first.result.epoch});expect(old.kind).toBe('none');if(old.kind==='none')expect(old.reason).toBe('history_epoch_changed');
});
test('rotation and truncation invalidate old epoch even for exact same UUID',async()=>{
 const h=setup();appendFileSync(h.file,msg('before'));const first=await ready(h);renameSync(h.file,join(h.root,'rotated.txt'));writeFileSync(h.file,meta()+msg('rotated'));const next=await ready(h);expect(next.result.epoch).not.toBe(first.result.epoch);
 writeFileSync(h.file,meta());const empty=await ready(h);expect(empty.result.total).toBe(0);expect(empty.result.epoch).not.toBe(next.result.epoch);
});
test('byte-budget pages shorten contiguously and include a record larger than the old 2MiB cap',async()=>{
 const h=setup(4*1024*1024);for(let n=0;n<3;n++)appendFileSync(h.file,msg('x'.repeat(2300*1024)+n));const first=await ready(h,{limit:150});expect(first.result.total).toBe(3);expect(first.result.start).toBe(2);expect(first.result.items.map(i=>i.i)).toEqual([2]);
 const older=await ready(h,{before:2,limit:150,epoch:first.result.epoch});expect(older.result.start).toBe(1);expect(older.result.items.map(i=>i.i)).toEqual([1]);
 const oldest=await ready(h,{before:1,limit:150,epoch:first.result.epoch});expect(oldest.result.items.map(i=>i.i)).toEqual([0]);
});
test('oversize single record fails closed with precise bounded reason',async()=>{
 const h=setup(16*1024*1024);appendFileSync(h.file,msg('x'.repeat(8*1024*1024)));const result=await h.resolver.read(h.ref);expect(result.kind).toBe('none');if(result.kind==='none')expect(result.reason).toBe('history_record_size_limit');expect(h.resolver.lastReadBytes).toBeLessThanOrEqual(16*1024*1024);
});
test('a single page item exceeding configured work budget fails precisely rather than indexing forever',async()=>{
 const h=setup(512);appendFileSync(h.file,msg('x'.repeat(800)));let result:HistoryResult;for(let n=0;n<10;n++){result=await h.resolver.read(h.ref);if(result.kind==='none'&&result.reason!=='history_indexing')break;}
 expect(result!.kind).toBe('none');if(result!.kind==='none')expect(result!.reason).toBe('history_page_size_limit');
});
test('identity verified over entire prefix rejects a late conflicting native ID',async()=>{
 const h=setup(256);appendFileSync(h.file,msg('a'.repeat(1024))+JSON.stringify({type:'session_meta',payload:{id:other}})+'\n');
 let result:HistoryResult;for(let n=0;n<20;n++){result=await h.resolver.read(h.ref);if(result.kind==='none'&&result.reason!=='history_indexing')break;}
 expect(result!.kind).toBe('none');if(result!.kind==='none')expect(result!.reason).toBe('native_metadata_mismatch');
});
test('Claude queue multiblock delivery dedup matches raw joined text; index holds no raw message text',async()=>{
 const h=setup(4096);h.ref={agent:'claude',kind:'id',value:id,source:'herdr:claude'};renameSync(h.file,join(h.root,id+'.jsonl'));h.file=join(h.root,id+'.jsonl');
 const text='unique first line\nunique second line';const rows=[{type:'queue-operation',operation:'enqueue',content:text,sessionId:id},{type:'queue-operation',operation:'dequeue',content:text,sessionId:id},{type:'user',uuid:'u',parentUuid:null,sessionId:id,message:{content:[{type:'text',text:'unique first line'},{type:'text',text:'unique second line'}]}},{type:'assistant',uuid:'a',parentUuid:'u',sessionId:id,message:{content:[{type:'text',text:'answer'}]}}];writeFileSync(h.file,rows.map(e=>JSON.stringify(e)).join('\n')+'\n');
 const result=await ready(h);expect(result.result.total).toBe(2);expect(result.result.items[0].text).toBe(text);expect(result.result.items[0].queued).toBe(false);expect(JSON.stringify([...(h.resolver as any).indexes.values()])).not.toContain('unique first line');
});
test('Claude global ancestry/branch pruning works across index budgets and missing parent fails closed',async()=>{
 const h=setup(256);h.ref={agent:'claude',kind:'id',value:id,source:'herdr:claude'};renameSync(h.file,join(h.root,id+'.jsonl'));h.file=join(h.root,id+'.jsonl');
 const row=(type:string,uuid:string,parentUuid:string|null,text:string)=>({type,uuid,parentUuid,sessionId:id,message:{content:[{type:'text',text}]}});
 writeFileSync(h.file,[row('user','u',null,'start'),row('assistant','a','u','base'),row('user','old','a','abandoned'),row('assistant','old-a','old','abandoned answer'),row('user','new','a','kept'),row('assistant','new-a','new','kept answer')].map(e=>JSON.stringify(e)).join('\n')+'\n');
 const result=await ready(h);expect(result.result.total).toBe(4);expect(result.result.items.map(i=>i.text).join(' ')).not.toContain('abandoned');
 writeFileSync(h.file,JSON.stringify(row('user','orphan','missing','no proof'))+'\n');const bad=await h.resolver.read(h.ref);expect(bad.kind).toBe('none');if(bad.kind==='none')expect(bad.reason).toBe('history_ancestry_unverified');
});
test('page tool output dependencies are range-read and linked to original call index',async()=>{
 const h=setup(4096);appendFileSync(h.file,JSON.stringify({type:'response_item',payload:{type:'function_call',call_id:'call',name:'fixture',arguments:'{"a":1}'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'function_call_output',call_id:'call',output:'fixture output'}})+'\n');
 const result=await ready(h);expect(result.result.total).toBe(1);expect(result.result.items[0].tool?.output).toBe('fixture output');
});
test('FIFO .jsonl path is rejected without blocking open',async()=>{
 const h=setup();rmSync(h.file);expect(spawnSync('mkfifo',[h.file]).status).toBe(0);const start=Date.now();const result=await h.resolver.read({...h.ref,kind:'path',value:h.file});expect(result.kind).toBe('none');expect(Date.now()-start).toBeLessThan(1000);
});
test('four active files bound discovery and a fifth cannot enter; same-file observers never release owner busy lock',async()=>{
 const h=setup(4096);appendFileSync(h.file,msg('seed'));const probe=await open(h.file,'r'),proto=Object.getPrototypeOf(probe),original=proto.read;await probe.close();
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let entered=0;
 const spy=spyOn(proto,'read').mockImplementation(async function(this:any,...args:any[]){entered++;await gate;return original.apply(this,args);});
 const refs=[h.ref];for(let n=2;n<=4;n++){const uuid=`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;writeFileSync(join(h.root,`rollout-${uuid}.jsonl`),JSON.stringify({type:'session_meta',payload:{id:uuid}})+'\n'+msg('other'));refs.push({...h.ref,value:uuid});}
 const pending=refs.map(r=>h.resolver.read(r));
 try{
  for(let n=0;n<100&&entered<4;n++)await new Promise(r=>setTimeout(r,1));expect(entered).toBe(4);
  const fifth=await h.resolver.read({...h.ref,value:'00000000-0000-4000-8000-000000000005'});expect(fifth.kind).toBe('none');if(fifth.kind==='none')expect(fifth.reason).toBe('history_indexing');expect(entered).toBe(4);
 }finally{release();await Promise.all(pending);spy.mockRestore();}
 let release2!:()=>void;const gate2=new Promise<void>(r=>release2=r);let entered2=0;
 const spy2=spyOn(proto,'read').mockImplementation(async function(this:any,...args:any[]){entered2++;await gate2;return original.apply(this,args);});
 const owner=h.resolver.read(h.ref);
 try{for(let n=0;n<100&&!entered2;n++)await new Promise(r=>setTimeout(r,1));const results=await Promise.all([h.resolver.read(h.ref),h.resolver.read(h.ref)]);expect(results.every(r=>r.kind==='none'&&r.reason==='history_indexing')).toBe(true);expect(entered2).toBe(1);expect((h.resolver as any).busy.size).toBe(1);}finally{release2();await owner;spy2.mockRestore();}
 expect((h.resolver as any).busy.size).toBe(0);expect((h.resolver as any).activeReads).toBe(0);
});
test('Claude executed queued turn inherits abandoned branch owner without losing hydration origin',async()=>{
 const h=setup(512);h.ref={agent:'claude',kind:'id',value:id,source:'herdr:claude'};renameSync(h.file,join(h.root,id+'.jsonl'));h.file=join(h.root,id+'.jsonl');
 const row=(type:string,uuid:string,parentUuid:string|null,text:string)=>({type,uuid,parentUuid,sessionId:id,message:{content:[{type:'text',text}]}});
 const rows=[row('user','u1',null,'start'),row('assistant','a1','u1','first'),{type:'queue-operation',operation:'enqueue',content:'abandoned queued user',sessionId:id},{type:'queue-operation',operation:'dequeue',content:'abandoned queued user',sessionId:id},row('user','old-u','a1','abandoned queued user'),row('assistant','old-a','old-u','abandoned answer'),row('user','new-u','a1','kept user'),row('assistant','new-a','new-u','kept answer')];
 writeFileSync(h.file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');const result=await ready(h,{limit:10});expect(result.result.total).toBe(4);let all=result.result.items,previous=result.result;while(previous.start>0){const older=await ready(h,{before:previous.start,epoch:previous.epoch,limit:10});all=[...older.result.items,...all];previous=older.result;}expect(all.map(i=>i.text)).toEqual(['start','first','kept user','kept answer']);expect(all.map(i=>i.i)).toEqual([0,1,2,3]);
});

test('81MiB ready history makes progress while the agent appends before every poll',async()=>{
 const h=setup(16*1024*1024),fd=openSync(h.file,'a');
 const padding=JSON.stringify({type:'progress',padding:'x'.repeat(1024*1024)})+'\n';
 for(let n=0;n<81;n++)writeSync(fd,padding);writeSync(fd,msg('initial'));closeSync(fd);
 const initial=(await ready(h,{limit:1})).result;
 let messages=0,lastMessagePoll=0;let previousReady:any;
 for(let n=1;n<=15;n++){
  appendFileSync(h.file,msg('append-'+n));const result=await h.resolver.read(h.ref,{limit:1});
  expect(h.resolver.lastReadBytes).toBeLessThanOrEqual(16*1024*1024);
  const index=[...(h.resolver as any).indexes.values()][0] as any;
  if(index.verify){
   expect(index.verify.previous.ready).toBe(true);
   if(previousReady)expect(index.verify.previous).toBe(previousReady);
   previousReady=index.verify.previous;
  }
  if(result.kind==='messages'){
   expect(n-lastMessagePoll).toBeLessThanOrEqual(8);lastMessagePoll=n;messages++;previousReady=undefined;
   expect(result.epoch).toBe(initial.epoch);expect(result.total).toBe(n+1);
   expect(result.items[0].text).toBe('append-'+n);expect(result.items[0].i).toBe(n);
  }else expect(result.reason).toBe('history_indexing');
 }
 expect(messages).toBeGreaterThanOrEqual(2);
});

test('same-size rewrite during prefix verification discards progress and the old epoch',async()=>{
 const h=setup(512);for(let n=0;n<20;n++)appendFileSync(h.file,msg('before-'+n));
 const initial=(await ready(h,{limit:1})).result;
 appendFileSync(h.file,msg('append'));expect((await h.resolver.read(h.ref)).kind).toBe('none');
 const pending=[...(h.resolver as any).indexes.values()][0] as any;expect(pending.verify.offset).toBeGreaterThan(0);
 writeFileSync(h.file,readFileSync(h.file,'utf8').replace('before-0','change-0'));
 const next=(await ready(h,{limit:1})).result;expect(next.epoch).not.toBe(initial.epoch);
 const old=await h.resolver.read(h.ref,{before:1,epoch:initial.epoch});
 expect(old.kind).toBe('none');if(old.kind==='none')expect(old.reason).toBe('history_epoch_changed');
});
