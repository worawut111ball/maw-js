import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContinuityStore, ContinuityError } from '../src/mobile/continuity/store';
import type { Binding, Room, RoomEvent, Operation } from '../src/mobile/continuity/types';
const stores:ContinuityStore[]=[],dirs:string[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const codex:Binding={agent:'codex',nativeId:'codex-native-a',generation:'process-a',cursor:0};
const claude:Binding={agent:'claude',nativeId:'claude-native-b',generation:'process-b',cursor:0};
const room=(id='logical-room-1',backend:Room['backend']='herdr'):Room=>({id,workspace:'workspace-demo',room:id,backend,cwd:'/home/example/project',revision:0,active:'codex',bindings:{codex:{...codex}}});
const open=(path?:string)=>{if(!path){const dir=mkdtempSync(join(tmpdir(),'continuity-store-'));dirs.push(dir);path=join(dir,'private','rooms.sqlite');}const s=new ContinuityStore(path);stores.push(s);return s;};
const req=(id='switch-1',expectedRevision=0,target:'codex'|'claude'='claude')=>({id,target,expectedRevision});
const event=(sourceId='event-1',over:Partial<Omit<RoomEvent,'seq'>>={}):Omit<RoomEvent,'seq'>=>({sourceId,agent:'codex',nativeId:codex.nativeId,role:'assistant',text:'ข้อความตัวอย่าง',...over});
function prepare(s:ContinuityStore,id='switch-1',target:Binding=claude,revision=0):Operation {
  let op=s.begin('logical-room-1',req(id,revision,target.agent));
  op={...op,state:'checkpointed',checkpointSeq:1,contextHash:'manifest-hash'};expect(s.compareAndSave(op,'waiting-safe-point')).toBe(true);
  op={...op,state:'preparing-target'};s.saveOperation(op);
  op={...op,state:'delivering-context',targetBinding:target};s.saveOperation(op);return op;
}
describe('Continuity durable room/operation state',()=>{
 test('construction/import has no filesystem side effects and records are private',()=>{const dir=mkdtempSync(join(tmpdir(),'continuity-lazy-'));dirs.push(dir);const file=join(dir,'nested','store.sqlite'),s=open(file);expect(existsSync(file)).toBe(false);s.register(room());expect(statSync(file).mode&0o777).toBe(0o600);});
 test('register is idempotent and rejects changed identity/alias without overwriting',()=>{const s=open(),r=room();s.register(r);expect(s.register({...r,bindings:{codex:{...codex}}})).toEqual(r);expect(()=>s.register({...r,cwd:'/home/example/other'})).toThrow('room_registration_conflict');expect(()=>s.register({...r,id:'another-logical'})).toThrow('room_alias_conflict');expect(s.room(r.id)).toEqual(r);});
 test('native bindings and returned records are isolated from caller mutation',()=>{const s=open(),r=room();s.register(r);r.bindings.codex!.nativeId='tampered';const read=s.room(r.id)!;read.bindings.codex!.nativeId='also-tampered';expect(s.room(r.id)?.bindings.codex?.nativeId).toBe(codex.nativeId);});
 test('registration allows same provider pane IDs on other backends and independent rooms',()=>{const s=open();s.register(room());s.register({...room('logical-room-2','tmux'),room:'logical-room-1'});expect(s.room('logical-room-2')?.backend).toBe('tmux');});
 test('begin atomically owns one room and request retries return the same operation',()=>{const s=open();s.register(room());const first=s.begin('logical-room-1',req());expect(s.room(first.roomId)?.operationId).toBe(first.id);expect(s.begin(first.roomId,req())).toEqual(first);expect(()=>s.begin(first.roomId,req('another-switch'))).toThrow('operation_in_progress');expect(()=>s.begin(first.roomId,{...req(),target:'codex'})).toThrow('request_id_conflict');});
 test('operation ID cannot be replayed against another room or different revision',()=>{const s=open();s.register(room());s.register(room('logical-room-2'));s.begin('logical-room-1',req());expect(()=>s.begin('logical-room-2',req())).toThrow('request_id_conflict');expect(()=>s.begin('logical-room-1',req('stale',9))).toThrow('stale_room_revision');});
 test('blocked and uncertain persist across reopen and retain the room lock',()=>{for(const state of ['blocked','uncertain'] as const){const s=open();s.register(room());const op={...s.begin('logical-room-1',req()),state,reason:'needs-user'};s.saveOperation(op);s.close();const reopened=open(s.path);expect(reopened.operation(op.id)?.state).toBe(state);expect(()=>reopened.begin(op.roomId,req('new'))).toThrow('operation_in_progress');}});
 test('saveOperation cannot cross room scope, replace source identity or mutate history',()=>{const s=open();s.register(room());s.register(room('logical-room-2'));const op=s.begin('logical-room-1',req());expect(()=>s.saveOperation({...op,roomId:'logical-room-2'})).toThrow();expect(()=>s.saveOperation({...op,from:{...op.from,nativeId:'wrong-session'}})).toThrow('operation_identity_conflict');expect(s.operation(op.id)).toEqual(op);});
 test('two connections compare-and-save have one winner and stale state never rewinds',()=>{const a=open();a.register(room());const op=a.begin('logical-room-1',req()),b=open(a.path),next={...op,state:'checkpointed' as const};expect(a.compareAndSave(next,'waiting-safe-point')).toBe(true);expect(b.compareAndSave(next,'waiting-safe-point')).toBe(false);expect(b.compareAndSave({...op,state:'uncertain'},'waiting-safe-point')).toBe(false);expect(a.operation(op.id)?.state).toBe('checkpointed');});
 test('independent Bun processes atomically claim the same expected state exactly once',async()=>{const s=open();s.register(room());s.begin('logical-room-1',req());const source=join(import.meta.dir,'../src/mobile/continuity/store.ts');const script=`import {ContinuityStore} from ${JSON.stringify(source)};const s=new ContinuityStore(process.argv[1]);const op=s.operation('switch-1');const won=s.compareAndSave({...op,state:'checkpointed'},'waiting-safe-point');process.stdout.write(JSON.stringify(won));s.close();`;
  const runs=Array.from({length:2},()=>Bun.spawn([process.execPath,'-e',script,s.path],{stdout:'pipe',stderr:'pipe'}));
  const results=await Promise.all(runs.map(async p=>{const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);expect(code).toBe(0);expect(err).toBe('');return JSON.parse(out);}));expect(results.sort()).toEqual([false,true]);expect(s.operation('switch-1')?.state).toBe('checkpointed');
 });
 test('complete is atomic/idempotent and preserves original native binding for return',()=>{const s=open();s.register(room());s.append('logical-room-1',[event()]);const op=prepare(s);const finished=s.complete(op.id,{...claude,cursor:1});expect(finished).toMatchObject({revision:1,active:'claude'});expect(finished.operationId).toBeUndefined();expect(finished.bindings.codex).toEqual(codex);expect(s.operation(op.id)?.state).toBe('ready-awaiting-user');expect(s.complete(op.id,{...claude,cursor:1})).toEqual(finished);expect(s.begin(op.roomId,req())).toEqual(s.operation(op.id)!);expect(()=>s.saveOperation({...op,state:'uncertain'})).toThrow('operation_not_active');});
 test('complete requires delivery stage, exact target identity and acknowledged context cursor',()=>{const s=open();s.register(room());const op=s.begin('logical-room-1',req());expect(()=>s.complete(op.id,claude)).toThrow('context_not_delivering');let x={...op,state:'checkpointed' as const,checkpointSeq:1,contextHash:'hash'};s.saveOperation(x);s.saveOperation({...x,state:'preparing-target'});s.saveOperation({...x,state:'delivering-context',targetBinding:claude});for(const target of [{...claude,nativeId:'unexpected-new'},{...claude,cursor:0},{...claude,agent:'codex' as const}])expect(()=>s.complete(op.id,target)).toThrow();expect(s.room(op.roomId)?.revision).toBe(0);expect(s.room(op.roomId)?.active).toBe('codex');});
 test('A→B→A→B preserves explicit native IDs and bumps one revision per completed switch',()=>{const s=open();s.register(room());s.append('logical-room-1',[event()]);for(const [i,target] of [claude,codex,claude].entries()){const op=prepare(s,'switch-'+(i+1),target,i);const r=s.complete(op.id,{...target,cursor:1});expect(r.revision).toBe(i+1);expect(r.bindings.codex?.nativeId).toBe(codex.nativeId);expect(r.bindings.claude?.nativeId).toBe(claude.nativeId);}expect(s.register(room()).revision).toBe(3);});
 test('return cannot silently replace an existing native session',()=>{const s=open();s.register(room());s.append('logical-room-1',[event()]);prepare(s);s.complete('switch-1',{...claude,cursor:1});const imposter={...codex,nativeId:'brand-new-hidden-session'};prepare(s,'switch-2',imposter,1);expect(()=>s.complete('switch-2',{...imposter,cursor:1})).toThrow('exact_native_session_required');expect(s.room('logical-room-1')?.active).toBe('claude');});
});
describe('Continuity event import and held messages',()=>{
 test('events deduplicate by source/native/provider/room, never by text',()=>{const s=open();s.register(room());s.register(room('second'));const a=event();expect(s.append('logical-room-1',[a,a])).toHaveLength(1);expect(s.append('logical-room-1',[a])).toEqual([]);expect(s.append('logical-room-1',[event('different-source'),event('event-1',{nativeId:'native-other'}),event('event-1',{agent:'claude'})]).map(e=>e.seq)).toEqual([2,3,4]);expect(s.append('second',[a])[0].seq).toBe(1);expect(s.events('logical-room-1',1,2).map(e=>e.seq)).toEqual([2,3]);});
 test('source collision rolls back the entire batch and does not consume sequence IDs',()=>{const s=open();s.register(room());s.append('logical-room-1',[event()]);expect(()=>s.append('logical-room-1',[event('will-rollback'),event('event-1',{text:'changed origin'})])).toThrow('event_source_conflict');expect(s.events('logical-room-1')).toHaveLength(1);expect(s.append('logical-room-1',[event('next')])[0].seq).toBe(2);});
 test('metadata property order is idempotent but independent same text is preserved',()=>{const s=open();s.register(room());const a=event('a',{metadata:{a:1,b:2}});s.append('logical-room-1',[a]);expect(s.append('logical-room-1',[{...a,metadata:{b:2,a:1}}])).toEqual([]);expect(s.append('logical-room-1',[event('b',{text:a.text})])).toHaveLength(1);});
 test('held IDs persist in insertion order, scope original generation and never auto-retarget',()=>{const s=open();s.register(room());s.register(room('second'));const a={id:'held-1',text:'พิมพ์ระหว่างสลับ',intendedGeneration:'original-a'};s.hold('logical-room-1',a);s.hold('logical-room-1',{...a,id:'held-2'});expect(s.hold('logical-room-1',a)).toEqual(a);expect(()=>s.hold('second',a)).toThrow('held_message_conflict');expect(()=>s.hold('logical-room-1',{...a,intendedGeneration:'target-b'})).toThrow('held_message_conflict');s.close();const reopened=open(s.path);expect(reopened.held('logical-room-1').map(m=>m.id)).toEqual(['held-1','held-2']);expect(reopened.held('logical-room-1')[0].intendedGeneration).toBe('original-a');});
 test('invalid events/pages and missing rooms fail without creating phantom data',()=>{const s=open();s.register(room());expect(()=>s.append('missing',[event()])).toThrow('room_not_found');expect(()=>s.events('logical-room-1',-1)).toThrow();expect(()=>s.events('logical-room-1',0,0)).toThrow();expect(()=>s.append('logical-room-1',[{...event(),seq:44} as any])).toThrow('event_sequence_is_server_owned');expect(s.events('logical-room-1')).toEqual([]);});
 test('unknown schema version fails closed without resetting existing data',()=>{const dir=mkdtempSync(join(tmpdir(),'continuity-version-'));dirs.push(dir);const path=join(dir,'unknown.sqlite'),db=new Database(path);db.exec('CREATE TABLE preserve(value TEXT); INSERT INTO preserve VALUES (\'original\'); PRAGMA user_version=99;');db.close();const s=open(path);expect(()=>s.room('anything')).toThrow('store_version_unsupported');const check=new Database(path);expect(check.query('SELECT value FROM preserve').get()).toEqual({value:'original'});check.close();});
 test('storage failures never fall back to a successful in-memory room store',()=>{const dir=mkdtempSync(join(tmpdir(),'continuity-bad-store-'));dirs.push(dir);const s=open(dir);expect(()=>s.register(room())).toThrow(ContinuityError);});
});

describe('Continuity commit boundaries and recovery guards',()=>{
 test('a failure between operation completion and room routing update rolls back both',()=>{
  const s=open();s.register(room());s.append('logical-room-1',[event()]);prepare(s);
  const injected=new Database(s.path);injected.exec("CREATE TRIGGER refuse_route BEFORE UPDATE OF revision ON continuity_rooms WHEN NEW.revision > OLD.revision BEGIN SELECT RAISE(ABORT, 'synthetic commit boundary failure'); END;");injected.close();
  expect(()=>s.complete('switch-1',{...claude,cursor:1})).toThrow('store_unavailable');
  expect(s.operation('switch-1')?.state).toBe('delivering-context');expect(s.room('logical-room-1')).toMatchObject({active:'codex',revision:0,operationId:'switch-1'});
  const remove=new Database(s.path);remove.exec('DROP TRIGGER refuse_route');remove.close();expect(s.complete('switch-1',{...claude,cursor:1}).active).toBe('claude');
 });
 test('stale save after another connection marks uncertain cannot roll back to a launchable phase',()=>{
  const s=open();s.register(room());const op=s.begin('logical-room-1',req());const checkpointed={...op,state:'checkpointed' as const};s.compareAndSave(checkpointed,'waiting-safe-point');const other=open(s.path);other.compareAndSave({...checkpointed,state:'uncertain',reason:'coordinator recovery'},'checkpointed');
  expect(()=>s.saveOperation({...checkpointed,state:'preparing-target'})).toThrow('invalid_operation_transition');expect(s.operation(op.id)?.state).toBe('uncertain');
 });
 test('two stores cannot begin separate operations on the same room revision',()=>{const first=open();first.register(room());const second=open(first.path);first.begin('logical-room-1',req('first'));expect(()=>second.begin('logical-room-1',req('second'))).toThrow('operation_in_progress');expect(second.room('logical-room-1')?.operationId).toBe('first');});
});

describe('Continuity cancel and durable operation display',()=>{
 test('latestOperation is room-scoped and survives active lock clearing and reopening',()=>{const s=open();s.register(room());s.register(room('second'));expect(s.latestOperation('logical-room-1')).toBeNull();expect(s.latestOperation('missing')).toBeNull();s.append('logical-room-1',[event()]);prepare(s);s.complete('switch-1',{...claude,cursor:1});expect(s.room('logical-room-1')?.operationId).toBeUndefined();expect(s.latestOperation('logical-room-1')).toMatchObject({id:'switch-1',state:'ready-awaiting-user'});expect(s.latestOperation('second')).toBeNull();s.begin('logical-room-1',req('switch-2',1,'codex'));expect(s.latestOperation('logical-room-1')?.id).toBe('switch-2');s.close();expect(open(s.path).latestOperation('logical-room-1')?.id).toBe('switch-2');});
 test('cancel waiting request atomically clears lock and increments revision exactly once',()=>{const s=open();s.register(room());const op=s.begin('logical-room-1',req());const canceled=s.cancel(op.id,0);expect(canceled).toMatchObject({revision:1,active:'codex'});expect(canceled.operationId).toBeUndefined();expect(canceled.bindings.codex).toEqual(codex);expect(s.operation(op.id)).toMatchObject({state:'failed',reason:'canceled_by_user'});expect(s.latestOperation(op.roomId)?.reason).toBe('canceled_by_user');expect(s.cancel(op.id,0)).toEqual(canceled);expect(()=>s.cancel(op.id,1)).toThrow('stale_room_revision');});
 test('cancel retry cannot clear a newer operation or replay a second revision increment',()=>{const s=open();s.register(room());s.begin('logical-room-1',req());s.cancel('switch-1',0);const next=s.begin('logical-room-1',req('switch-2',1));s.cancel('switch-1',0);expect(s.room(next.roomId)).toMatchObject({revision:1,operationId:'switch-2'});expect(s.operation(next.id)?.state).toBe('waiting-safe-point');expect(s.compareAndSave({...s.operation('switch-1')!,state:'waiting-safe-point'},'failed')).toBe(false);});
 test('cancel blocked before launch is allowed but blocked with target identity is not',()=>{const s=open();s.register(room());const op=s.begin('logical-room-1',req());s.saveOperation({...op,state:'blocked',reason:'launcher_not_ready'});expect(s.cancel(op.id,0).revision).toBe(1);const next=s.begin(op.roomId,req('next',1));s.saveOperation({...next,state:'checkpointed'});s.saveOperation({...next,state:'preparing-target'});s.saveOperation({...next,state:'blocked',targetBinding:claude});expect(()=>s.cancel(next.id,1)).toThrow('cancel_not_safe');expect(s.room(op.roomId)?.operationId).toBe(next.id);});
 for(const state of ['checkpointed','preparing-target','delivering-context','uncertain'] as const)test(`cancel refuses ${state} without releasing the guard`,()=>{const s=open();s.register(room());let op=s.begin('logical-room-1',req());if(state==='uncertain'){op={...op,state};s.saveOperation(op);}else{op={...op,state:'checkpointed'};s.saveOperation(op);if(state!=='checkpointed'){op={...op,state:'preparing-target'};s.saveOperation(op);}if(state==='delivering-context'){op={...op,state};s.saveOperation(op);}}expect(()=>s.cancel(op.id,0)).toThrow('cancel_not_safe');expect(s.operation(op.id)?.state).toBe(state);expect(s.room(op.roomId)).toMatchObject({revision:0,operationId:op.id});});
 test('stale revision cancel leaves source and active operation unchanged',()=>{const s=open();s.register(room());const op=s.begin('logical-room-1',req());expect(()=>s.cancel(op.id,9)).toThrow('stale_room_revision');expect(s.operation(op.id)?.state).toBe('waiting-safe-point');expect(s.room(op.roomId)?.operationId).toBe(op.id);});
 test('failed routing update rolls back cancellation journal and lock together',()=>{const s=open();s.register(room());s.begin('logical-room-1',req());const db=new Database(s.path);db.exec("CREATE TRIGGER refuse_cancel BEFORE UPDATE OF revision ON continuity_rooms WHEN NEW.revision > OLD.revision BEGIN SELECT RAISE(ABORT, 'synthetic cancel commit failure'); END;");db.close();expect(()=>s.cancel('switch-1',0)).toThrow('store_unavailable');expect(s.operation('switch-1')?.state).toBe('waiting-safe-point');expect(s.room('logical-room-1')).toMatchObject({revision:0,operationId:'switch-1'});});
 test('cross-process cancel versus CAS can only have one winner',async()=>{const s=open();s.register(room());s.begin('logical-room-1',req());const source=join(import.meta.dir,'../src/mobile/continuity/store.ts');const script=`import {ContinuityStore} from ${JSON.stringify(source)};const s=new ContinuityStore(process.argv[1]);let won=false;try{if(process.argv[2]==='cancel'){s.cancel('switch-1',0);won=true;}else{const op=s.operation('switch-1');won=s.compareAndSave({...op,state:'checkpointed'},'waiting-safe-point');}}catch{}process.stdout.write(JSON.stringify({action:process.argv[2],won}));s.close();`;
  const children=['cancel','claim'].map(action=>Bun.spawn([process.execPath,'-e',script,s.path,action],{stdout:'pipe',stderr:'pipe'}));const outcomes=await Promise.all(children.map(async p=>{const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);expect(code).toBe(0);expect(err).toBe('');return JSON.parse(out);}));expect(outcomes.filter(v=>v.won)).toHaveLength(1);const state=s.operation('switch-1')!,r=s.room('logical-room-1')!;if(state.state==='checkpointed'){expect(r.revision).toBe(0);expect(r.operationId).toBe(state.id);}else{expect(state).toMatchObject({state:'failed',reason:'canceled_by_user'});expect(r.revision).toBe(1);expect(r.operationId).toBeUndefined();}
 });
});

describe('Atomic host history import',()=>{
 test('imports registration and history together, deduplicates after reopening',()=>{
  const s=open(),r=room();expect(s.importHistory(r,[event()]).inserted).toHaveLength(1);
  s.close();const again=open(s.path);expect(again.importHistory(r,[event()]).inserted).toEqual([]);
  expect(again.events(r.id)).toHaveLength(1);expect(again.room(r.id)).toEqual(r);
 });
 test('conflict in a later batch rolls back new room and every previous batch',()=>{
  const s=open(),r=room(),records=Array.from({length:2001},(_,i)=>event('row-'+i));
  records.push(event('row-0',{text:'changed'}));
  expect(()=>s.importHistory(r,records)).toThrow('event_source_conflict');expect(s.room(r.id)).toBeNull();
  expect(s.importHistory(r,[event()]).inserted[0].seq).toBe(1);
 });
 test('later batch conflict preserves existing history and room unchanged',()=>{
  const s=open(),r=room();s.importHistory(r,[event('original')]);
  const records=Array.from({length:2001},(_,i)=>event('new-'+i));records.push(event('original',{text:'conflict'}));
  expect(()=>s.importHistory(r,records)).toThrow('event_source_conflict');expect(s.events(r.id)).toHaveLength(1);expect(s.room(r.id)).toEqual(r);
 });
 test('rejects stale revision, replacement generation and current active operation',()=>{
  const s=open(),r=room();s.register(r);
  expect(()=>s.importHistory({...r,revision:1},[event()])).toThrow('history_room_changed');
  expect(()=>s.importHistory({...r,bindings:{codex:{...codex,generation:'replacement'}}},[event()])).toThrow('history_room_changed');
  s.begin(r.id,req());expect(()=>s.importHistory(r,[event()])).toThrow('operation_in_progress');expect(s.events(r.id)).toEqual([]);
 });
 test('foreign native history and caller supplied sequence cannot create room',()=>{
  const s=open(),r=room();expect(()=>s.importHistory(r,[event('wrong',{nativeId:'another'})])).toThrow('history_identity_changed');
  expect(()=>s.importHistory(r,[{...event(),seq:8} as any])).toThrow('event_sequence_is_server_owned');expect(s.room(r.id)).toBeNull();
 });
 test('physical room coordinate alias cannot acquire a second logical history',()=>{
  const s=open(),r=room();s.importHistory(r,[event()]);expect(()=>s.importHistory({...r,id:'alias'},[event()])).toThrow('room_alias_conflict');expect(s.room('alias')).toBeNull();
 });
});

const heldRequest=(id='held-v2')=>({id,text:'ข้อความพักตัวอย่าง',intendedGeneration:codex.generation,expectedOperationId:'switch-1',expectedRevision:0});
describe('Held acceptance v2 immutable operation receipt',()=>{
 test('server derives origin/binding and never consumes, retargets or dispatches on completion',()=>{
  const s=open(),r=room();r.bindings.codex={...codex,model:'example-model',route:'example-route'};s.register(r);s.append(r.id,[event()]);prepare(s);
  const held=s.holdForOperation(r.id,heldRequest());expect(held).toEqual({id:'held-v2',text:'ข้อความพักตัวอย่าง',intendedGeneration:codex.generation,version:2,originOperationId:'switch-1',originRevision:0,intendedBinding:{agent:'codex',nativeId:codex.nativeId,generation:codex.generation,model:'example-model',route:'example-route'}});
  expect(Object.keys(held).sort()).toEqual(['id','text','intendedGeneration','version','originOperationId','originRevision','intendedBinding'].sort());expect(held.intendedBinding).not.toHaveProperty('cursor');
  s.complete('switch-1',{...claude,cursor:1});expect(s.held(r.id)).toEqual([held]);expect(s.room(r.id)).toMatchObject({active:'claude',revision:1});
 });
 for(const finish of ['complete','cancel'] as const)test(`lost hold ACK exact retry after ${finish} returns original receipt even across reopen and a newer operation`,()=>{
  const s=open(),r=room();s.register(r);if(finish==='complete'){s.append(r.id,[event()]);prepare(s);}else s.begin(r.id,req());
  const request=heldRequest(),stored=s.holdForOperation(r.id,request);
  if(finish==='complete')s.complete('switch-1',{...claude,cursor:1});else s.cancel('switch-1',0);
  s.close();const again=open(s.path),ended=again.room(r.id)!;expect(again.holdForOperation(r.id,request)).toEqual(stored);expect(again.room(r.id)).toEqual(ended);
  expect(()=>again.holdForOperation(r.id,{...request,id:'fresh-after-end'})).toThrow('no_switch_in_progress');
  again.begin(r.id,req('switch-new',1,finish==='complete'?'codex':'claude'));const current=again.room(r.id)!;
  expect(again.holdForOperation(r.id,request)).toEqual(stored);expect(again.room(r.id)).toEqual(current);expect(again.held(r.id)).toEqual([stored]);
  expect(()=>again.holdForOperation(r.id,{...request,id:'fresh-stale-origin'})).toThrow('operation_changed');
 });
 test('same ID with changed body, room, operation, revision or generation conflicts before current-state checks',()=>{
  const s=open(),r=room();s.register(r);s.register(room('second'));s.begin(r.id,req());const request=heldRequest(),stored=s.holdForOperation(r.id,request);s.cancel('switch-1',0);
  for(const patch of [{text:'เปลี่ยนข้อความ'},{intendedGeneration:'another'},{expectedOperationId:'different'},{expectedRevision:1}])expect(()=>s.holdForOperation(r.id,{...request,...patch})).toThrow('held_message_conflict');
  expect(()=>s.holdForOperation('second',request)).toThrow('held_message_conflict');expect(s.held(r.id)).toEqual([stored]);expect(s.held('second')).toEqual([]);
 });
 test('fresh requests validate active operation/revision/source generation atomically',()=>{
  const s=open(),r=room();s.register(r);expect(()=>s.holdForOperation(r.id,heldRequest())).toThrow('no_switch_in_progress');s.begin(r.id,req());
  expect(()=>s.holdForOperation(r.id,{...heldRequest(),expectedOperationId:'wrong'})).toThrow('operation_changed');expect(()=>s.holdForOperation(r.id,{...heldRequest(),expectedRevision:99})).toThrow('stale_room_revision');expect(()=>s.holdForOperation(r.id,{...heldRequest(),intendedGeneration:'wrong'})).toThrow('target_changed');expect(s.held(r.id)).toEqual([]);
 });
 test('source binding replacement cannot be accepted merely by supplying its new generation',()=>{
  for(const patch of [{nativeId:'replacement-native'},{generation:'replacement-process'},{model:'replacement-model'},{route:'replacement-route'}]){
   const s=open(),r=room();s.register(r);s.begin(r.id,req());const current=s.room(r.id)!;current.bindings.codex={...current.bindings.codex!,...patch};
   const db=new Database(s.path);db.query('UPDATE continuity_rooms SET body=? WHERE id=?').run(JSON.stringify(current),r.id);db.close();
   expect(()=>s.holdForOperation(r.id,{...heldRequest(),intendedGeneration:current.bindings.codex!.generation})).toThrow('target_changed');expect(s.held(r.id)).toEqual([]);expect(s.room(r.id)).toEqual(current);
  }
 });
 test('closed request schema and 8000-character bound prevent fake server origin and oversized text',()=>{
  const s=open(),r=room();s.register(r);s.begin(r.id,req());
  for(const patch of [{text:''},{text:'x'.repeat(8001)},{text:'invalid\0text'},{expectedRevision:-1},{originOperationId:'forged'},{intendedBinding:codex},{version:2}])expect(()=>s.holdForOperation(r.id,{...heldRequest(),...patch} as any)).toThrow('invalid_held_request');
  const exact=s.holdForOperation(r.id,{...heldRequest(),text:'ก'.repeat(8000)});expect(exact.text.length).toBe(8000);expect(s.held(r.id)).toHaveLength(1);
 });
 test('receipt/request clones are immutable from caller perspective and replay ignores field insertion order',()=>{
  const s=open(),r=room();s.register(r);s.begin(r.id,req());const request=heldRequest(),stored=s.holdForOperation(r.id,request),original=structuredClone(stored);stored.intendedBinding.nativeId='mutated';stored.originRevision=99;request.text='mutated';
  const retry={expectedRevision:0,expectedOperationId:'switch-1',intendedGeneration:codex.generation,text:'ข้อความพักตัวอย่าง',id:'held-v2'};expect(s.holdForOperation(r.id,retry)).toEqual(original);expect(s.held(r.id)).toEqual([original]);
 });
 test('legacy rows retain exact stored body/fingerprint and cannot be promoted by replaying ID through v2',()=>{
  const s=open(),r=room();s.register(r);const legacy={id:'legacy-held',text:'ข้อความเดิม',intendedGeneration:codex.generation};s.hold(r.id,legacy);
  const db=new Database(s.path),before=db.query('SELECT body,fingerprint FROM continuity_held WHERE id=?').get(legacy.id);s.begin(r.id,req());expect(()=>s.holdForOperation(r.id,{...heldRequest(),id:legacy.id,text:legacy.text})).toThrow('held_message_conflict');
  const added=s.holdForOperation(r.id,heldRequest());expect(()=>s.hold(r.id,{id:added.id,text:added.text,intendedGeneration:added.intendedGeneration})).toThrow('held_message_conflict');expect(db.query('SELECT body,fingerprint FROM continuity_held WHERE id=?').get(legacy.id)).toEqual(before);expect(s.held(r.id)[0]).toEqual(legacy);expect(s.held(r.id)[0]).not.toHaveProperty('version');db.close();
 });
 test('failed insert rolls back acceptance without changing lock/revision/history and retry succeeds once',()=>{
  const s=open(),r=room();s.register(r);s.begin(r.id,req());const previous=s.room(r.id);const db=new Database(s.path);db.exec("CREATE TRIGGER reject_held BEFORE INSERT ON continuity_held BEGIN SELECT RAISE(ABORT,'synthetic held failure'); END;");
  expect(()=>s.holdForOperation(r.id,heldRequest())).toThrow('store_unavailable');expect(s.held(r.id)).toEqual([]);expect(s.room(r.id)).toEqual(previous);expect(s.operation('switch-1')?.state).toBe('waiting-safe-point');
  db.exec('DROP TRIGGER reject_held');const stored=s.holdForOperation(r.id,heldRequest());expect(s.holdForOperation(r.id,heldRequest())).toEqual(stored);expect(s.held(r.id)).toEqual([stored]);expect(db.query('SELECT ordinal FROM continuity_held').get()).toEqual({ordinal:1});db.close();
 });
});
async function heldRace(s:ContinuityStore,actions:string[]):Promise<any[]>{
 const source=join(import.meta.dir,'../src/mobile/continuity/store.ts');
 const script=`import {ContinuityStore} from ${JSON.stringify(source)};const s=new ContinuityStore(process.argv[1]);const action=process.argv[2];let result;try{if(action.startsWith('hold'))result={action,ok:true,receipt:s.holdForOperation('logical-room-1',${JSON.stringify(heldRequest())})};else if(action==='cancel'){s.cancel('switch-1',0);result={action,ok:true};}else{s.complete('switch-1',${JSON.stringify({...claude,cursor:1})});result={action,ok:true};}}catch(e){result={action,ok:false,code:e.code};}process.stdout.write(JSON.stringify(result));s.close();`;
 const children=actions.map(action=>Bun.spawn([process.execPath,'-e',script,s.path,action],{stdout:'pipe',stderr:'pipe'}));
 return Promise.all(children.map(async p=>{const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);expect(code).toBe(0);expect(err).toBe('');return JSON.parse(out);}));
}
describe('Held v2 cross-process SQLite acceptance races',()=>{
 test('two independent processes accepting the same request return one identical immutable receipt',async()=>{
  const s=open();s.register(room());s.begin('logical-room-1',req());const results=await heldRace(s,['hold-a','hold-b']);expect(results.every(r=>r.ok)).toBe(true);expect(results[0].receipt).toEqual(results[1].receipt);expect(s.held('logical-room-1')).toEqual([results[0].receipt]);
 });
 for(const finish of ['cancel','complete'] as const)test(`hold versus ${finish} has only a stored-before-end or rejected-after-end outcome`,async()=>{
  const s=open();s.register(room());if(finish==='complete'){s.append('logical-room-1',[event()]);prepare(s);}else s.begin('logical-room-1',req());
  const results=await heldRace(s,['hold',finish]),held=results.find(r=>r.action==='hold'),ended=results.find(r=>r.action===finish);expect(ended.ok).toBe(true);const after=s.room('logical-room-1')!;expect(after.revision).toBe(1);expect(after.operationId).toBeUndefined();
  if(held.ok){expect(s.holdForOperation('logical-room-1',heldRequest())).toEqual(held.receipt);expect(s.held('logical-room-1')).toEqual([held.receipt]);expect(held.receipt.intendedBinding.nativeId).toBe(codex.nativeId);}else{expect(held.code).toBe('no_switch_in_progress');expect(s.held('logical-room-1')).toEqual([]);}
  expect(()=>s.holdForOperation('logical-room-1',heldRequest('fresh-ended'))).toThrow('no_switch_in_progress');expect(s.room('logical-room-1')).toEqual(after);
 });
});
