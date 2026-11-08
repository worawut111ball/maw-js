import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importOldRoomHistory, type HistoryImportPorts, type HistoryImportObservation } from '../src/mobile/continuity/history-import';
import { ContinuityStore } from '../src/mobile/continuity/store';
import { parseNativeRecords, readNativeRecords, type NativeRecords } from '../src/mobile/continuity/native-records';
import type { AgentKind, Room } from '../src/mobile/continuity/types';
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',cwd='/home/example/project';
const roots:string[]=[],stores:ContinuityStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function room(agent:AgentKind='codex'):Room{return {id:'old-room-demo',workspace:'ws-demo',room:'pane-demo',backend:'herdr',cwd,revision:0,active:agent,bindings:{[agent]:{agent,nativeId:id,generation:'observed-process-original',cursor:0}}};}
function observed(r:Room):HistoryImportObservation{const {cursor:_,...binding}=r.bindings[r.active]!;return {roomId:r.id,workspace:r.workspace,room:r.room,backend:r.backend,cwd:r.cwd,binding};}
function nativeText(agent:AgentKind,turns=2,first='ข้อความเดิม'):string{
 const rows:any[]=agent==='codex'?[{type:'session_meta',payload:{id,cwd}}]:[];
 for(let i=0;i<turns;i++){
  if(agent==='claude'){
   rows.push({type:'user',uuid:'u-'+i,parentUuid:i?'a-'+(i-1):null,sessionId:id,cwd,message:{role:'user',content:i?`ข้อความตัวอย่าง ${i}`:first}});
   rows.push({type:'assistant',uuid:'a-'+i,parentUuid:'u-'+i,sessionId:id,cwd,message:{role:'assistant',content:[{type:'text',text:'คำตอบที่เหมือนกัน'}],stop_reason:'end_turn'}});
  }else{
   rows.push({type:'event_msg',payload:{type:'task_started',turn_id:'turn-'+i}},{type:'turn_context',payload:{turn_id:'turn-'+i,cwd}},
    {type:'response_item',payload:{type:'message',id:'u-'+i,role:'user',content:[{type:'input_text',text:i?`ข้อความตัวอย่าง ${i}`:first}]}},
    {type:'response_item',payload:{type:'message',id:'a-'+i,role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'คำตอบที่เหมือนกัน'}]}},
    {type:'event_msg',payload:{type:'task_complete',turn_id:'turn-'+i}});
  }
 }
 return rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
}
function fixture(agent:AgentKind='codex'){
 const root=mkdtempSync(join(tmpdir(),'continuity-history-import-'));roots.push(root);
 const path=join(root,'history.sqlite'),store=new ContinuityStore(path);stores.push(store);
 const input=room(agent);let reads=0,inspections=0,commits=0;
 const ports:HistoryImportPorts={store:{importHistory:(r,e)=>{commits++;return store.importHistory(r,e);}},inspect:async r=>{inspections++;return observed(r);},read:async request=>{reads++;expect(request.room).toEqual(input);expect(request.binding).toEqual(input.bindings[agent]!);expect(Object.keys(request).sort()).toEqual(['binding','room']);return parseNativeRecords(agent,id,nativeText(agent));}};
 return {root,path,store,input,ports,counts:()=>({reads,inspections,commits})};
}
const run=(f:ReturnType<typeof fixture>)=>importOldRoomHistory(f.input,f.ports);
describe('Host-only exact old-room import',()=>{
 for(const agent of ['codex','claude'] as const)test(`${agent}: real parser projection registers history atomically without changing routing/cursor`,async()=>{
  const f=fixture(agent);expect(existsSync(f.path)).toBe(false);const result=await run(f);
  expect(f.counts()).toEqual({reads:1,inspections:2,commits:1});expect(result.room).toEqual(f.input);expect(result.observedEvents).toBe(4);expect(result.inserted.map(e=>e.seq)).toEqual([1,2,3,4]);
  expect(result.inserted.every(e=>e.agent===agent&&e.nativeId===id&&e.sourceId.startsWith(`${agent}:${id}:message:`))).toBe(true);
  expect(result.inserted.filter(e=>e.role==='assistant')).toHaveLength(2);expect(result.inserted[1].metadata).toMatchObject({final:true,replyToSourceId:`${agent}:${id}:message:u-0`});
  expect(result.source.generation).toBe('observed-process-original');expect(result).not.toHaveProperty('ready');expect(result).not.toHaveProperty('receipt');expect(result.room.bindings[agent]?.cursor).toBe(0);
 });
 test('actual bounded full readNativeRecords integration is supplied only by trusted host closure',async()=>{
  const f=fixture('claude'),nativePath=join(f.root,id+'.jsonl');writeFileSync(nativePath,nativeText('claude'),{mode:0o600});
  f.ports.read=async request=>readNativeRecords(request.binding.agent,request.binding.nativeId,nativePath,{allowedRoot:f.root,expectedCwd:request.room.cwd});
  expect((await run(f)).inserted).toHaveLength(4);expect(f.store.events(f.input.id)).toHaveLength(4);
 });
 test('identical retry and replay after reopen deduplicate by native source IDs, preserving equal text from separate events',async()=>{
  const f=fixture('claude'),first=await run(f);expect((await run(f)).inserted).toEqual([]);f.store.close();const reopened=new ContinuityStore(f.path);stores.push(reopened);f.ports.store=reopened;
  expect((await run(f)).inserted).toEqual([]);expect(reopened.events(f.input.id)).toEqual(first.inserted);expect(reopened.events(f.input.id).filter(e=>e.text==='คำตอบที่เหมือนกัน')).toHaveLength(2);
  f.ports.read=async()=>parseNativeRecords('claude',id,nativeText('claude',3));expect((await run(f)).inserted.map(e=>e.seq)).toEqual([5,6]);
 });
 test('parallel imports from separate Store connections have one copy and no partial registration',async()=>{
  const f=fixture(),second=new ContinuityStore(f.path);stores.push(second);
  const results=await Promise.all([run(f),importOldRoomHistory(f.input,{...f.ports,store:second})]);expect(results.map(r=>r.inserted.length).sort()).toEqual([0,4]);expect(second.events(f.input.id).map(e=>e.seq)).toEqual([1,2,3,4]);
 });
 test('pre-read observation mismatches stop before reader/store calls',async()=>{
  for(const patch of [{roomId:'different'},{backend:'tmux' as const},{workspace:'other'},{room:'other'},{cwd:'/home/example/other'},{binding:{...observed(room()).binding,agent:'claude' as const}},{binding:{...observed(room()).binding,nativeId:other}},{binding:{...observed(room()).binding,generation:'replacement'}}]){
   const f=fixture();f.ports.inspect=async()=>({...observed(f.input),...patch});await expect(run(f)).rejects.toThrow('history_import_binding_changed');expect(f.counts()).toMatchObject({reads:0,commits:0});expect(existsSync(f.path)).toBe(false);
  }
 });
 test('post-read replacement/native change/cwd/model/route mismatch rejects before creating a room',async()=>{
  for(const patch of [{generation:'replacement'},{nativeId:other},{agent:'claude' as const},{model:'unobserved-model'},{route:'different-route'}]){
   const f=fixture();let count=0;f.ports.inspect=async()=>{const o=observed(f.input);return ++count===1?o:{...o,binding:{...o.binding,...patch}};};await expect(run(f)).rejects.toThrow('history_import_binding_changed');expect(f.counts().commits).toBe(0);expect(existsSync(f.path)).toBe(false);
  }
 });
 test('wrong native UUID/cwd/provider source IDs and malformed/duplicate/order projections cannot be imported',async()=>{
  for(const change of ['uuid','cwd','provider','duplicate','order','nul','partial-tail','partial-prefix']){
   const f=fixture();f.ports.read=async()=>{const data=parseNativeRecords('codex',id,nativeText('codex'));if(change==='uuid')data.nativeId=other;if(change==='cwd')data.cwd='/home/example/other';if(change==='provider')data.events[0].sourceId=data.events[0].sourceId.replace('codex:','claude:');if(change==='duplicate')data.events.push(data.events[0]);if(change==='order')data.events.reverse();if(change==='nul')data.events[0].text+='\0';if(change==='partial-tail')data.events=data.events.slice(1);if(change==='partial-prefix')data.events=data.events.slice(0,2);return data;};
   await expect(run(f)).rejects.toThrow();expect(f.counts().commits).toBe(0);expect(existsSync(f.path)).toBe(false);
  }
 });
 test('full reader error/truncated JSON and failed post-inspection leave no persistent state and can retry',async()=>{
  const f=fixture();f.ports.read=async()=>parseNativeRecords('codex',id,nativeText('codex').slice(0,-1));await expect(run(f)).rejects.toThrow('history_import_read_failed');expect(existsSync(f.path)).toBe(false);
  f.ports.read=async()=>parseNativeRecords('codex',id,nativeText('codex'));let count=0;f.ports.inspect=async()=>{if(++count===2)throw new Error('synthetic observation unavailable');return observed(f.input);};await expect(run(f)).rejects.toThrow('history_import_observation_unavailable');expect(existsSync(f.path)).toBe(false);
  f.ports.inspect=async()=>observed(f.input);expect((await run(f)).inserted).toHaveLength(4);
 });
 test('existing different revision/identity is never overwritten even if host observations still match input',async()=>{
  for(const patch of [{revision:1},{cwd:'/home/example/other'},{bindings:{codex:{...room().bindings.codex!,generation:'replacement'}}},{bindings:{codex:{...room().bindings.codex!,nativeId:other}}}]){
   const f=fixture(),stored={...f.input,...patch};f.store.register(stored);await expect(run(f)).rejects.toThrow('history_room_changed');expect(f.store.room(f.input.id)).toEqual(stored);expect(f.store.events(f.input.id)).toEqual([]);
  }
 });
 test('operation claimed while reading blocks atomic commit without changing operation or history',async()=>{
  const f=fixture();f.store.register(f.input);let count=0;f.ports.inspect=async()=>{if(++count===2)f.store.begin(f.input.id,{id:'operation-demo',target:'claude',expectedRevision:0});return observed(f.input);};
  await expect(run(f)).rejects.toThrow('operation_in_progress');expect(f.store.room(f.input.id)?.operationId).toBe('operation-demo');expect(f.store.events(f.input.id)).toEqual([]);
 });
 for(const existing of [false,true])test(`SQL failure after 2000 events rolls back all batches and ${existing?'preserves existing history':'room registration'}; retry is clean`,async()=>{
  const f=fixture('claude');if(existing)await run(f);else f.store.room('schema-only');
  const db=new Database(f.path);db.exec("CREATE TRIGGER fail_history_batch BEFORE INSERT ON continuity_events WHEN NEW.seq>2000 BEGIN SELECT RAISE(ABORT,'synthetic import failure'); END;");db.close();
  f.ports.read=async()=>parseNativeRecords('claude',id,nativeText('claude',1001));await expect(run(f)).rejects.toThrow('store_unavailable');
  if(existing){expect(f.store.events(f.input.id)).toHaveLength(4);expect(f.store.room(f.input.id)).toEqual(f.input);}else expect(f.store.room(f.input.id)).toBeNull();
  const fix=new Database(f.path);fix.exec('DROP TRIGGER fail_history_batch');fix.close();const result=await run(f);expect(result.inserted).toHaveLength(existing?1998:2002);expect(f.store.events(f.input.id,0,3000).at(-1)?.seq).toBe(2002);
 });
 test('source text collision rolls back newly seen events rather than silently rewriting old history',async()=>{
  const f=fixture('claude'),first=await run(f);f.ports.read=async()=>parseNativeRecords('claude',id,nativeText('claude',3,'ข้อความเปลี่ยน'));
  await expect(run(f)).rejects.toThrow('event_source_conflict');expect(f.store.events(f.input.id)).toEqual(first.inserted);
 });
 test('caller/reader mutation of passed Room copies cannot retarget trusted input',async()=>{
  const f=fixture();f.ports.inspect=async r=>{const correct=observed(r);(r as Room).bindings.codex!.generation='poisoned-copy';return correct;};f.ports.read=async request=>{request.room.cwd='/home/example/other';request.binding.nativeId=other;return parseNativeRecords('codex',id,nativeText('codex'));};
  expect((await run(f)).room).toEqual(f.input);expect(f.input.bindings.codex!.generation).toBe('observed-process-original');
 });
 test('a valid unfinished native turn is historical data only and does not assert switch readiness',async()=>{
  const f=fixture('claude');f.ports.read=async()=>{const rows=nativeText('claude',1).trimEnd().split('\n');return parseNativeRecords('claude',id,rows.slice(0,1).join('\n')+'\n');};const result=await run(f);expect(result.inserted).toHaveLength(1);expect(result).not.toHaveProperty('ready');expect(result.room.revision).toBe(0);
 });
 test('host invalid/active room fails before I/O; no arbitrary file path is accepted as input',async()=>{
  const f=fixture();for(const input of [{...f.input,operationId:'active'},{...f.input,path:'/home/example/arbitrary.jsonl'},{...f.input,cwd:'/home/example/../other'},{...f.input,bindings:{}},{...f.input,bindings:{codex:{...f.input.bindings.codex!,nativeId:'not-a-uuid'}}}])await expect(importOldRoomHistory(input as Room,f.ports)).rejects.toThrow();expect(f.counts()).toEqual({reads:0,inspections:0,commits:0});expect(existsSync(f.path)).toBe(false);
 });
});

test('oversized/unknown snapshot, model mismatch and invalid linked assistant fail before any Store write',async()=>{
 for(const kind of ['size','flags','model','assistant-link']){
  const f=fixture();if(kind==='model')f.input.bindings.codex!.model='expected-model';
  f.ports.read=async()=>{const data=parseNativeRecords('codex',id,nativeText('codex'));if(kind==='size')data.events=new Array(100001);if(kind==='flags')(data as any).pendingTools=undefined;if(kind==='model')data.model='different-model';if(kind==='assistant-link')data.assistantMessages[0].replyToSourceId='wrong-source';return data;};
  await expect(run(f)).rejects.toThrow();expect(f.counts().commits).toBe(0);expect(existsSync(f.path)).toBe(false);
 }
});
test('event byte limit fails before registration rather than committing a smaller prefix',async()=>{
 const f=fixture();f.ports.read=async()=>{const data=parseNativeRecords('codex',id,nativeText('codex'));data.events[0].text='x'.repeat(2*1024*1024);return data;};
 await expect(run(f)).rejects.toThrow('history_import_too_large');expect(f.counts().commits).toBe(0);expect(existsSync(f.path)).toBe(false);
});
