import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,realpathSync,rmSync,readFileSync,statSync,chmodSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProtocolContinuityService,type ProtocolServiceOptions,type ProtocolLiveEvidence,type ProtocolAcceptanceAuthority,type ProtocolAcceptancePermit,type ProtocolAcceptanceOperation,protocolAcceptanceProfile} from '../src/mobile/continuity/protocol/service';
import type {ProtocolEntryCandidateV2} from '../src/mobile/continuity/protocol/entry';
import type {Room,RoomEvent} from '../src/mobile/continuity/types';
import type {ProtocolIdentity,StagedNativeProtocolSession} from '../src/mobile/continuity/protocol/types';
const sid='00000000-0000-4000-8000-000000000001',tid='00000000-0000-4000-8000-000000000002';
const dirs:string[]=[],services:ReturnType<typeof createProtocolContinuityService>[]=[];
afterEach(async()=>{for(const s of services.splice(0))await s.close().catch(()=>{});for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function frozen<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))frozen(x);Object.freeze(v);}return v;}
function fixture(extra:{acceptancePermit?:ProtocolAcceptanceAuthority;now?:()=>number}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'protocol-service-')));dirs.push(root);
 const effects:string[]=[];const aliases=new Map([[JSON.stringify(['fixture-w','fixture-p']),'room']]);const exitFailures=new Set<string>();const cleanupHooks=new Map<string,()=>Promise<void>>();let admitHook:((request:{phase:string})=>Promise<void>)|undefined;let preflight:any={ready:true};let evidenceHook:(()=>Promise<void>)|undefined;let live:ProtocolLiveEvidence|null=null,failOpen=false,failTurn=false,turnHook:(()=>Promise<void>)|undefined,historyHook:(()=>Promise<void>)|undefined,readCount=0;
 let records:Omit<RoomEvent,'seq'>[]=[{sourceId:'goal',agent:'codex',nativeId:sid,role:'user',text:JSON.stringify({kind:'continuity-facts',version:1,facts:{goal:'ตรวจงาน synthetic fixture'}})}];
 const candidate=(agent:'codex'|'claude',existingId?:string):ProtocolEntryCandidateV2=>frozen({version:2,tool:agent,model:'fixture-model',route:'direct',cwd:root,binary:'/fixture/native',session:existingId?{mode:'resume',id:existingId}:{mode:'fresh'},eligibility:{candidateOnly:true,liveEligible:false},binding:{version:2,kind:agent==='codex'?'codex-app-server-stdio':'claude-stream-json',route:'direct',model:'fixture-model',provider:agent==='codex'?'openai':'anthropic',endpoint:null,home:root,effectiveToolHome:root,homeEnvironment:{state:'absent'},cwd:root,nativeBinary:'/fixture/native',nativeSha256:'a'.repeat(64),nativeVersion:agent==='codex'?'0.164.0':'2.1.220',sessionId:existingId??null}});
 const options:ProtocolServiceOptions={now:extra.now,privateRoot:join(root,'private'),actorId:'trusted-fixture-owner',timeoutMs:1000,
  runtime:{admit:async r=>{await admitHook?.(r);return {source:'trusted-protocol-admission',binding:structuredClone(r.binding),externalWriter:'absent',...(r.launchReceipt?{launchReceipt:r.launchReceipt}:{})};},supervisor:{launch:async(c:any,p)=>{
   effects.push('launch:'+c.tool);let alive=true;const wire={messages:{async *[Symbol.asyncIterator](){}},send:async()=>{effects.push('wire:'+c.tool);},close:async()=>{alive=false;}};
   return {...p,wire,runtimeBirth:'fixture-'+p.launchId,assertRunning:async()=>{if(!alive)throw Error('dead');},cleanup:async()=>{effects.push('exit:'+c.tool);await cleanupHooks.get(c.tool)?.();alive=false;},observeExit:async expected=>{effects.push('exit-proof:'+c.tool);if(exitFailures.has(c.tool))throw Error('fixture private exit diagnostic');return {...expected,source:'owned-process-supervisor' as const,exit:{code:0,signal:null},inputClosed:true as const,outputClosed:true as const,pendingWork:false as const};},diagnostics:()=>({stderrBytes:0,stderrTruncated:false,stderr:''})};
  }},driverFactory:(c,wire)=>{
   const nativeId=c.session.mode==='resume'?c.session.id:c.tool==='codex'?sid:tid;
   const identity:ProtocolIdentity={agent:c.tool,nativeId,model:c.model,cwd:root,home:root,route:'direct'};let ready=false,observed:any;
   const completed=(operationId:string)=>({operationId,nativeId,turnId:crypto.randomUUID(),text:'fixture final',state:'completed' as const});
   const driver:StagedNativeProtocolSession={get idle(){return ready;},pendingApproval:false,get nativeObservation(){return observed;},
    open:async()=>{if(failOpen)throw Error('fixture disconnect');await wire.send({method:'open'});observed={agent:c.tool,nativeId,model:c.model,cwd:root};ready=true;return identity;},
    prepare:async()=>{await wire.send({method:'initialize'});},startTurn:async(op,text)=>{effects.push('context:'+text);await wire.send({method:'first-user'});observed={agent:c.tool,nativeId,model:c.model,cwd:root};ready=true;return {identity,turn:completed(op)};},
    turn:async(op)=>{effects.push('turn:'+op);await wire.send({method:'turn'});await turnHook?.();if(failTurn)throw Error('lost native ACK');return completed(op);},close:async()=>{ready=false;await wire.close();}};return driver;
  }},
  host:{acceptancePermit:extra.acceptancePermit,resolveRoomId:async(ws,room)=>aliases.get(JSON.stringify([ws,room]))??null,liveEvidence:async()=>{await evidenceHook?.();return live;},
   preflight:async()=>preflight,candidate:async(_r,target,existing)=>candidate(target,existing?.nativeId),
   history:async()=>{readCount++;await historyHook?.();return structuredClone(records);},
   verifyContext:async(_r,b,c,start)=>{effects.push('verify-context');expect(start.firstTurn?.operationId).toBe(c.id+':context');return {state:'acknowledged',nativeId:b.nativeId,hash:c.hash,throughSeq:c.throughSeq};}},
 };
 const create=()=>{const s=createProtocolContinuityService(options);services.push(s);return s;};const service=create();
 const bootstrap=(backend:'herdr'|'tmux'|'superset'='herdr')=>service.bootstrapOwned({scope:{id:'room',workspace:'fixture-w',room:'fixture-p',backend,cwd:root},operationId:'bootstrap',candidate:candidate('codex'),writer:'owned-protocol-child'});
 return {root,options,service,create,bootstrap,candidate,effects,admitHook:(hook:(request:{phase:string})=>Promise<void>)=>{admitHook=hook;},alias:(ws:string,room:string,id:string)=>aliases.set(JSON.stringify([ws,room]),id),failExit:(agent:string)=>exitFailures.add(agent),cleanupHook:(agent:string,hook:()=>Promise<void>)=>cleanupHooks.set(agent,hook),setPreflight:(v:unknown)=>{preflight=v;},get readCount(){return readCount;},get records(){return records;},setRecords:(r:typeof records)=>{records=r;},hook:(h:()=>Promise<void>)=>{historyHook=h;},evidenceHook:(h:()=>Promise<void>)=>{evidenceHook=h;},turnHook:(h:()=>Promise<void>)=>{turnHook=h;},failTurn:()=>{failTurn=true;},failOpen:()=>{failOpen=true;},certify:()=>{live={source:'trusted-live-continuity-evidence',scope:'room-backend',backends:[{backend:'herdr',runId:'fixture-DI-evidence-not-live'}],models:[{agent:'claude',id:'fixture-model',label:'Fixture'}]};},evidence:(e:ProtocolLiveEvidence|null)=>{live=e;}};
}
async function approve(h:ReturnType<typeof fixture>,room:Room,id='switch-op'){
 const p=await h.service.factsUI.preview(room);const selections=p.candidates.map(({value,...pick})=>pick);
 await h.service.factsUI.approve(room,{id,previewId:p.id,expectedRevision:room.revision,selections});return p;
}
test('concrete factory capabilities default off; exact resolver reads actual stored room without adoption',async()=>{
 const h=fixture();expect((await h.service.featureOptions.capabilities()).ready).toBe(false);expect(await h.service.featureOptions.resolveRoom('fixture-w','fixture-p')).toBeNull();
 const {room}=await h.bootstrap();expect(await h.service.featureOptions.resolveRoom('fixture-w','fixture-p')).toEqual(room);expect(await h.service.featureOptions.resolveRoom('other','fixture-p')).toBeNull();
 const op=await h.service.engine.request(room.id,{id:'disabled-op',target:'claude',expectedRevision:0});expect((await h.service.engine.advance(op.id)).reason).toBe('live_continuity_not_certified');expect(h.effects.filter(x=>x==='launch:claude')).toEqual([]);
});
test('real facts preview/approval and engine share binding revision archive hash cursor and operation',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();const preview=await approve(h,room);
 const approvedSnapshot=await h.service.snapshot(room);expect(approvedSnapshot.archiveHash).toBe(preview.archiveHash);expect(approvedSnapshot.throughSeq).toBe(preview.throughSeq);expect(readFileSync(approvedSnapshot.archivePath,'utf8')).toBe(approvedSnapshot.events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 const op=await h.service.engine.request(room.id,{id:'switch-op',target:'claude',model:'fixture-model',expectedRevision:0,factsSelectionId:'switch-op'});
 const result=await h.service.engine.advance(op.id);expect(result.state).toBe('ready-awaiting-user');expect(result.contextHash).toBeString();expect(result.checkpointSeq).toBe(preview.throughSeq);
 const changed=h.service.store.room(room.id)!;expect(changed.active).toBe('claude');expect(changed.revision).toBe(1);expect(changed.bindings.claude?.cursor).toBe(preview.throughSeq);
 expect(h.effects.indexOf('exit:codex')).toBeLessThan(h.effects.indexOf('launch:claude'));expect(h.effects.some(x=>x.startsWith('context:')&&x.includes('ตรวจงาน synthetic fixture'))).toBe(true);expect(h.effects).toContain('verify-context');
});
test('selection for another operation cannot supply engine facts or close source',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();await approve(h,room,'approved-A');await h.service.engine.request(room.id,{id:'operation-B',target:'claude',expectedRevision:0});
 expect((await h.service.engine.advance('operation-B')).reason).toBe('facts_selection_missing');expect(h.effects).not.toContain('exit:codex');expect(h.effects).not.toContain('launch:claude');
});
test('history changed after approval fails facts scope before source exit or target launch',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();await approve(h,room);h.setRecords([...h.records,{sourceId:'new',agent:'codex',nativeId:sid,role:'assistant',text:'new fixture history'}]);
 await h.service.engine.request(room.id,{id:'switch-op',target:'claude',expectedRevision:0,factsSelectionId:'switch-op'});const op=await h.service.engine.advance('switch-op');expect(op.state).toBe('blocked');expect(op.reason).toMatch(/^facts_/);expect(h.effects).not.toContain('exit:codex');
});
test('history changed between preview and approve cannot persist a facts selection',async()=>{
 const h=fixture(),{room}=await h.bootstrap();const p=await h.service.factsUI.preview(room);h.setRecords([...h.records,{sourceId:'later',agent:'codex',nativeId:sid,role:'user',text:'changed'}]);
 await expect(h.service.factsUI.approve(room,{id:'op',previewId:p.id,expectedRevision:0,selections:p.candidates.map(({value,...pick})=>pick)})).rejects.toMatchObject({code:'facts_preview_changed'});
});
test('foreign native history is rejected before atomic import',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.setRecords([...h.records,{sourceId:'foreign',agent:'claude',nativeId:tid,role:'user',text:'foreign'}]);await expect(h.service.snapshot(room)).rejects.toMatchObject({code:'history_identity_changed'});expect(h.service.store.events(room.id)).toEqual([]);
});
test('room operation begins during awaited history read: stale snapshot cannot import partial data',async()=>{
 const h=fixture(),{room}=await h.bootstrap();let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);h.hook(async()=>{entered();await gate;});
 const result=h.service.snapshot(room).then(value=>({value,error:undefined}),error=>({value:undefined,error}));await waiting;h.service.store.begin(room.id,{id:'concurrent-op',target:'claude',expectedRevision:0});release();expect((await result).error).toMatchObject({code:'facts_room_changed'});expect(h.service.store.events(room.id)).toEqual([]);
});
test('snapshot rejects forged revision/binding and unmanaged store rows have no runtime ownership',async()=>{
 const h=fixture(),{room}=await h.bootstrap();await expect(h.service.snapshot({...room,revision:1})).rejects.toMatchObject({code:'facts_room_changed'});expect(h.readCount).toBe(0);
 const second=h.create();await expect(second.snapshot(room)).rejects.toMatchObject({code:'protocol_room_not_owned'});expect(h.readCount).toBe(0);
});
test('bootstrap rejects external writer or existing room without discovery, resume, or target side effects',async()=>{
 const h=fixture();const input={scope:{id:'room',workspace:'fixture-w',room:'fixture-p',backend:'herdr' as const,cwd:h.root},operationId:'bootstrap',candidate:h.candidate('codex'),writer:'external-tui'};
 await expect(h.service.bootstrapOwned(input as any)).rejects.toMatchObject({code:'protocol_bootstrap_scope_invalid'});expect(h.effects).toEqual([]);
 await h.bootstrap();const before=h.effects.length;await expect(h.bootstrap()).rejects.toMatchObject({code:'protocol_bootstrap_room_exists'});expect(h.effects.length).toBe(before);
});
test('failed bootstrap is durable uncertain and a fresh service never relaunches the same operation',async()=>{
 const h=fixture();h.failOpen();await expect(h.bootstrap()).rejects.toMatchObject({code:'protocol_bootstrap_uncertain'});const count=h.effects.filter(x=>x.startsWith('launch:')).length;
 const next=h.create();await expect(next.bootstrapOwned({scope:{id:'room',workspace:'fixture-w',room:'fixture-p',backend:'herdr',cwd:h.root},operationId:'bootstrap',candidate:h.candidate('codex'),writer:'owned-protocol-child'})).rejects.toMatchObject({code:'protocol_bootstrap_reconciliation_required'});expect(h.effects.filter(x=>x.startsWith('launch:'))).toHaveLength(count);
});
test('live evidence must be explicit, complete for all-backend scope, and backend scoped when partial',async()=>{
 const h=fixture();h.evidence({source:'trusted-live-continuity-evidence',scope:'all-backends',backends:[{backend:'herdr',runId:'fixture-proof'}],models:[]});expect((await h.service.featureOptions.capabilities()).ready).toBe(false);
 h.certify();const caps=await h.service.featureOptions.capabilities();expect(caps.ready).toBe(true);expect(caps.backends.filter(x=>x.ready).map(x=>x.backend)).toEqual(['herdr']);expect(caps.models).toEqual([{agent:'claude',id:'fixture-model',label:'Fixture'}]);
 h.evidence({source:'request-model-claim',scope:'room-backend',backends:[{backend:'herdr',runId:'not-trusted'}],models:[]} as any);expect((await h.service.featureOptions.capabilities()).ready).toBe(false);
});

function request(room:Room,id='text-one'){return {id,text:'ข้อความผู้ใช้ synthetic',expectedRevision:room.revision,binding:structuredClone(room.bindings[room.active]!)};}
test('owned methods mount through featureOptions; completed text persists atomic provenance pair and replays when gate off',async()=>{
 const h=fixture(),{room}=await h.bootstrap();expect(h.service.featureOptions.owned).toBe(h.service.owned);
 expect((await h.service.owned.status(room)).capabilities.textTurn).toBe(false);h.certify();expect((await h.service.owned.status(room)).capabilities).toEqual({textTurn:true,attachments:false,keys:false});
 const input=request(room),receipt=await h.service.owned.turn(room,input);expect(receipt.state).toBe('completed');expect(receipt.turn?.text).toBe('fixture final');expect(receipt.source).toBe('live');
 const events=h.service.store.events(room.id);expect(events).toHaveLength(2);expect(events.map(e=>e.role)).toEqual(['user','assistant']);expect(events.map(e=>e.metadata?.provenance)).toEqual(['host-authorized-user','native-protocol-final']);expect(events[0].metadata?.turnId).toBe(receipt.turn?.turnId);expect(events[1].metadata?.requestHash).toBe(events[0].metadata?.requestHash);
 h.evidence(null);const before=h.effects.length;expect(await h.service.owned.turn(room,input)).toEqual({...receipt,source:'historical'});expect(await h.service.owned.turnStatus(room,input.id)).toEqual({...receipt,source:'historical'});expect(h.effects.length).toBe(before);
 await expect(h.service.owned.turn(room,{...input,text:'different'})).rejects.toMatchObject({code:'protocol_turn_id_conflict'});expect(h.effects.length).toBe(before);
});
for(const backend of ['herdr','tmux','superset'] as const)test(`owned ${backend} fresh sends require live evidence and exact binding/revision`,async()=>{
 const h=fixture(),{room}=await h.bootstrap(backend);const input=request(room);const before=h.effects.length;
 await expect(h.service.owned.turn(room,input)).rejects.toMatchObject({code:'live_continuity_not_certified'});
 h.evidence({source:'trusted-live-continuity-evidence',scope:'room-backend',backends:[{backend,runId:'DI-proof-only'}],models:[]});
 await expect(h.service.owned.turn(room,{...input,expectedRevision:1})).rejects.toMatchObject({code:'protocol_turn_binding_changed'});
 await expect(h.service.owned.turn(room,{...input,binding:{...input.binding,generation:'foreign-generation'}})).rejects.toMatchObject({code:'protocol_turn_binding_changed'});expect(h.effects.length).toBe(before);
 expect((await h.service.owned.turn(room,input)).state).toBe('completed');
});
test('owned lost native ACK remains uncertain across new instance, blocks new IDs and never sends again',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();h.failTurn();const input=request(room);
 expect((await h.service.owned.turn(room,input)).state).toBe('uncertain');expect(h.effects.filter(x=>x==='turn:'+input.id)).toHaveLength(1);expect(h.service.store.events(room.id)).toEqual([]);
 expect((await h.service.owned.status(room)).state).toBe('uncertain');expect((await h.service.owned.turn(room,input)).source).toBe('historical');
 const next=h.create();expect((await next.owned.turnStatus(room,input.id))?.state).toBe('uncertain');expect((await next.owned.turn(room,input)).state).toBe('uncertain');expect(h.effects.filter(x=>x==='turn:'+input.id)).toHaveLength(1);
});
test('owned in-flight status reads pending without replay; concurrent second ID cannot dispatch',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);h.turnHook(async()=>{entered();await gate;});
 const input=request(room),work=h.service.owned.turn(room,input);await waiting;
 expect((await h.service.owned.status(room)).state).toBe('busy');expect((await h.service.owned.turnStatus(room,input.id))?.state).toBe('uncertain');expect((await h.service.owned.turn(room,input)).source).toBe('historical');
 await expect(h.service.owned.turn(room,request(room,'second-id'))).rejects.toBeDefined();expect(h.effects.filter(x=>x.startsWith('turn:'))).toHaveLength(1);release();expect((await work).state).toBe('completed');
});
test('room operation started during native turn prevents event import/completed receipt and no retry',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);h.turnHook(async()=>{entered();await gate;});
 const input=request(room),work=h.service.owned.turn(room,input);await waiting;h.service.store.begin(room.id,{id:'switch-mid-turn',target:'claude',expectedRevision:0});release();expect((await work).state).toBe('uncertain');expect(h.service.store.events(room.id)).toEqual([]);
 const current=h.service.store.room(room.id)!;expect((await h.service.owned.turn(current,input)).state).toBe('uncertain');expect(h.effects.filter(x=>x.startsWith('turn:'))).toHaveLength(1);
});
test('archive transaction failure cannot leave user-only history or completed receipt',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();const original=h.service.store.importHistory;
 h.service.store.importHistory=()=>{throw Error('fixture disk failure');};const input=request(room);expect((await h.service.owned.turn(room,input)).state).toBe('uncertain');h.service.store.importHistory=original;
 expect(h.service.store.events(room.id)).toEqual([]);expect((await h.service.owned.turnStatus(room,input.id))?.state).toBe('uncertain');expect(h.effects.filter(x=>x.startsWith('turn:'))).toHaveLength(1);
});
test('exact owned receipt survives new instance and changed room revision without dispatch authority',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();const input=request(room),receipt=await h.service.owned.turn(room,input);h.evidence(null);
 const op=h.service.store.begin(room.id,{id:'cancel-after-completion',target:'claude',expectedRevision:0});h.service.store.cancel(op.id,0);const current=h.service.store.room(room.id)!;expect(current.revision).toBe(1);
 const next=h.create(),before=h.effects.length;expect(await next.owned.turn(current,input)).toEqual({...receipt,source:'historical'});expect((await next.owned.status(current)).state).toBe('unavailable');expect(h.effects.length).toBe(before);
});
test('unknown owned status is read-only and invalid text never creates a turn or dispatch',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();const before=h.effects.length;expect(await h.service.owned.turnStatus(room,'unknown')).toBeNull();expect(h.effects.length).toBe(before);
 await expect(h.service.owned.turn(room,{...request(room),text:'a'.repeat(8001)})).rejects.toMatchObject({code:'protocol_turn_invalid'});expect(await h.service.owned.turnStatus(room,'text-one')).toBeNull();expect(h.effects.length).toBe(before);
});
test('scope resolver rejects a mapped foreign room, and unmapped bootstrap has zero launch',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.options.host.resolveRoomId=async()=>room.id;const next=h.create();await expect(next.featureOptions.resolveRoom('foreign','fixture-p')).rejects.toMatchObject({code:'protocol_room_scope_mismatch'});
 const before=h.effects.length;await expect(next.bootstrapOwned({scope:{...room,id:'another-id'},operationId:'wrong-scope',candidate:h.candidate('codex'),writer:'owned-protocol-child'})).rejects.toMatchObject({code:'protocol_bootstrap_scope_unmapped'});expect(h.effects.length).toBe(before);
});

test('facts provider rejects forged archive/hash/cursor and reads only the current operation selection',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();await approve(h,room);const snapshot=await h.service.snapshot(room);
 const op=await h.service.engine.request(room.id,{id:'switch-op',target:'claude',expectedRevision:0,factsSelectionId:'switch-op'});
 expect(h.service.store.compareAndSave({...op,state:'checkpointed'},'waiting-safe-point')).toBe(true);const current=h.service.store.room(room.id)!;
 expect((await h.service.engine.options.facts!(current,snapshot)).goal).toBe('ตรวจงาน synthetic fixture');
 for(const changed of [{...snapshot,archiveHash:'0'.repeat(64)},{...snapshot,throughSeq:0},{...snapshot,archivePath:join(h.root,'foreign')},{...snapshot,sourceBinding:{...snapshot.sourceBinding,generation:'foreign'}}]){
  await expect(h.service.engine.options.facts!(current,changed)).rejects.toMatchObject({code:expect.stringMatching(/^facts_/) });
 }
 expect(h.effects).not.toContain('exit:codex');
});
test('snapshot retry deduplicates imported source and preserves exact archive hash',async()=>{
 const h=fixture(),{room}=await h.bootstrap();const first=await h.service.snapshot(room),second=await h.service.snapshot(room);expect(second).toEqual(first);expect(h.service.store.events(room.id)).toHaveLength(1);
});
test('completed native turn with ledger ACK failure keeps both events and uncertain durable receipt, never replays',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();const original=h.service.store.importHistory;
 h.service.store.importHistory=(r,events)=>{
  const result=original.call(h.service.store,r,events);const db=new Database(join(h.options.privateRoot,'owned-turns.sqlite'));
  db.exec("CREATE TRIGGER fixture_fail_ack BEFORE UPDATE OF state ON protocol_owned_turns WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'fixture ACK failure'); END");db.close();return result;
 };
 const input=request(room),receipt=await h.service.owned.turn(room,input);h.service.store.importHistory=original;
 expect(receipt.state).toBe('uncertain');expect(h.service.store.events(room.id).map(e=>e.role)).toEqual(['user','assistant']);expect((await h.service.owned.turnStatus(room,input.id))?.state).toBe('uncertain');
 const before=h.effects.length;expect((await h.service.owned.turn(room,input)).state).toBe('uncertain');expect(h.effects.length).toBe(before);
});
test('owned durable claim insertion failure has zero native dispatch and no accepted receipt',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();await h.service.owned.turnStatus(room,'unknown');const db=new Database(join(h.options.privateRoot,'owned-turns.sqlite'));
 db.exec("CREATE TRIGGER fixture_fail_claim BEFORE INSERT ON protocol_owned_turns BEGIN SELECT RAISE(ABORT,'fixture claim failure'); END");db.close();const before=h.effects.filter(x=>x.startsWith('turn:')).length;
 await expect(h.service.owned.turn(room,request(room))).rejects.toBeDefined();expect(h.effects.filter(x=>x.startsWith('turn:'))).toHaveLength(before);expect(await h.service.owned.turnStatus(room,'text-one')).toBeNull();
});
test('same-id race at initial live-evidence await never produces a duplicate dispatch or false completed ACK',async()=>{
 const h=fixture(),{room}=await h.bootstrap();let entered=0,release!:()=>void,both!:()=>void;const waiting=new Promise<void>(r=>both=r),gate=new Promise<void>(r=>release=r);
 h.evidenceHook(async()=>{if(++entered<=2){if(entered===2)both();await gate;}});
 h.certify();const input=request(room),one=h.service.owned.turn(room,input),two=h.service.owned.turn(room,input);
 const settled=Promise.allSettled([one,two]);await waiting;release();
 const result=await settled;expect(h.effects.filter(x=>x==='turn:'+input.id)).toHaveLength(1);expect(result.filter(x=>x.status==='fulfilled'&&x.value.state==='completed')).toHaveLength(1);
 expect((await h.service.owned.turn(room,input)).source).toBe('historical');
});
test('owned inventory lists only host-bootstrap scopes, reads real store labels, and marks restart unavailable',async()=>{
 const h=fixture();expect(await h.service.owned.inventory()).toEqual([]);const {room}=await h.bootstrap();
 h.service.store.register({...room,id:'not-bootstrap',workspace:'unmanaged-w',room:'unmanaged-p'});
 const listed=await h.service.featureOptions.owned.inventory();expect(listed).toHaveLength(1);expect(listed[0].room).toEqual(room);expect(listed[0].transport.kind).toBe('owned-protocol');expect(listed[0].transport.state).toBe('idle');expect(listed[0].transport.capabilities.textTurn).toBe(false);
 const restarted=h.create();const after=await restarted.owned.inventory();expect(after).toHaveLength(1);expect(after[0].room).toEqual(room);expect(after[0].transport.state).toBe('unavailable');expect(after[0].transport.capabilities.textTurn).toBe(false);expect(h.effects.filter(x=>x.startsWith('launch:'))).toHaveLength(1);
});
test('inventory exposes no phantom room after failed bootstrap and never launches to repair it',async()=>{
 const h=fixture();h.failOpen();await expect(h.bootstrap()).rejects.toMatchObject({code:'protocol_bootstrap_uncertain'});const count=h.effects.length;expect(await h.service.owned.inventory()).toEqual([]);expect(h.effects.length).toBe(count);
});

test('owned fresh turn rechecks revision after deferred live evidence: zero dispatch on revocation',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);h.evidenceHook(async()=>{entered();await gate;});
 const work=h.service.owned.turn(room,request(room)).then(value=>({value,error:undefined}),error=>({value:undefined,error}));await waiting;
 const op=h.service.store.begin(room.id,{id:'cancel-during-gate',target:'claude',expectedRevision:0});h.service.store.cancel(op.id,0);release();expect((await work).error).toMatchObject({code:'facts_room_changed'});expect(h.effects.filter(x=>x.startsWith('turn:'))).toHaveLength(0);
 const current=h.service.store.room(room.id)!;expect(await h.service.owned.turnStatus(current,'text-one')).toBeNull();
});
test('private ledger files remain 0600 and non-private composition root is rejected',async()=>{
 const h=fixture(),{room}=await h.bootstrap();await h.service.owned.turnStatus(room,'unknown');expect(statSync(join(h.options.privateRoot,'owned-turns.sqlite')).mode&0o777).toBe(0o600);
 const publicRoot=join(h.root,'not-private');mkdirSync(publicRoot);chmodSync(publicRoot,0o755);expect(()=>createProtocolContinuityService({...h.options,privateRoot:publicRoot})).toThrow('protocol_service_root_not_private');
});
test('explicit owned pilot V3 bootstrap preserves policy namespace and has no implicit production capability',async()=>{
 const h=fixture(),base=h.candidate('claude',tid),args=['--resume',tid,'--safe-mode','--tools',''],digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),pilotPolicy={kind:'claude-context-only-safe' as const,version:1 as const};
 const candidate=frozen({...base,version:3 as const,pilotPolicy,args,policyArgvHash:digest(args.slice(-3)),finalArgvHash:digest(args),binding:{...base.binding,version:3 as const,pilotPolicy,policyArgvHash:digest(args.slice(-3))}});
 const result=await h.service.bootstrapOwned({scope:{id:'room',backend:'herdr',workspace:'fixture-w',room:'fixture-p',cwd:h.root},operationId:'pilot-bootstrap',candidate,writer:'owned-protocol-child',firstTurn:{operationId:'pilot-authorized-context',text:'synthetic authorized context'}});
 expect(result.room.active).toBe('claude');expect(result.start.identity.nativeId).toBe(tid);expect((await h.service.owned.status(result.room)).capabilities.textTurn).toBe(false);expect((await h.service.featureOptions.capabilities()).ready).toBe(false);
});

test('malformed trusted preflight never becomes ready and public reason excludes raw diagnostic text',async()=>{
 for(const preflight of [{ready:'true'},{ready:false,reason:'fixture raw diagnostic /private/path'}]){
  const h=fixture(),{room}=await h.bootstrap();h.certify();h.setPreflight(preflight);await h.service.engine.request(room.id,{id:'bad-preflight',target:'claude',expectedRevision:0});
  const op=await h.service.engine.advance('bad-preflight');expect(op.state).toBe('blocked');expect(op.reason).toBe('protocol_preflight_unverified');expect(h.effects).not.toContain('exit:codex');
 }
});

test('durable owned scope cannot become unmanaged when trusted alias callback forgets it',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.options.host.resolveRoomId=async()=>null;const next=h.create();expect(await next.featureOptions.resolveRoom(room.workspace,room.room)).toEqual(room);expect((await next.owned.status(room)).state).toBe('unavailable');
});
test('claimed bootstrap scope without registered room fails closed instead of resolving unmanaged',async()=>{
 const h=fixture();h.failOpen();await expect(h.bootstrap()).rejects.toMatchObject({code:'protocol_bootstrap_uncertain'});
 await expect(h.service.featureOptions.resolveRoom('fixture-w','fixture-p')).rejects.toMatchObject({code:'protocol_room_bootstrap_pending'});expect(h.effects.filter(x=>x.startsWith('launch:'))).toHaveLength(1);
});

async function secondOwnedRoom(h:ReturnType<typeof fixture>){
 h.alias('fixture-w','fixture-B','room-B');
 return (await h.service.bootstrapOwned({scope:{id:'room-B',backend:'herdr',workspace:'fixture-w',room:'fixture-B',cwd:h.root},operationId:'bootstrap-B',candidate:h.candidate('claude'),writer:'owned-protocol-child',firstTurn:{operationId:'B-authorized-first',text:'synthetic room B context'}})).room;
}
function lifetimeReservations(h:ReturnType<typeof fixture>){
 const db=new Database(join(h.options.privateRoot,'effects.sqlite'),{readonly:true});
 try{return {reservations:db.query("SELECT state,result_json FROM continuity_effects WHERE step='reservation'").all() as {state:string;result_json:string|null}[],locks:(db.query("SELECT count(*) AS n FROM continuity_effect_locks WHERE room_id LIKE 'protocol-lifetime-native:%' AND room_id NOT LIKE '%:generations'").get() as {n:number}).n};}finally{db.close();}
}
for(const failure of ['busy','exit-unavailable'] as const)test(`close attempts room B after room A ${failure}, preserves failed lease and blocks new dispatch`,async()=>{
 const h=fixture(),{room:roomA}=await h.bootstrap(),roomB=await secondOwnedRoom(h);h.certify();
 let turnWork:Promise<Awaited<ReturnType<typeof h.service.owned.turn>>>|undefined,finishTurn:(()=>void)|undefined;
 const input=request(roomA,'A-pending');
 if(failure==='busy'){
  let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>finishTurn=r);h.turnHook(async()=>{entered();await gate;});
  turnWork=h.service.owned.turn(roomA,input);await waiting;
 }else h.failExit('codex');
 let cleanupEntered!:()=>void,finishCleanup!:()=>void;const waitingCleanup=new Promise<void>(r=>cleanupEntered=r),cleanupGate=new Promise<void>(r=>finishCleanup=r);
 h.cleanupHook('claude',async()=>{cleanupEntered();await cleanupGate;});
 const closing=h.service.close().then(()=>({error:undefined}),error=>({error}));await waitingCleanup;
 expect(h.effects).toContain('exit:claude');expect(h.effects).not.toContain('exit-proof:claude');
 const before=h.effects.length;
 await expect(h.service.owned.turn(roomB,request(roomB,'during-close'))).rejects.toMatchObject({code:'protocol_service_closed'});
 await expect(h.service.bootstrapOwned({scope:{id:'C',backend:'herdr',workspace:'fixture-w',room:'C',cwd:h.root},operationId:'C',candidate:h.candidate('codex'),writer:'owned-protocol-child'})).rejects.toMatchObject({code:'protocol_service_closed'});
 await expect(h.service.close()).rejects.toMatchObject({code:'protocol_service_closing'});expect(h.effects.length).toBe(before);
 finishCleanup();const result=await closing;expect(result.error).toMatchObject({code:'protocol_service_cleanup_failed',status:503});expect(result.error.message).toBe('protocol_service_cleanup_failed');
 expect(h.effects.filter(x=>x==='exit:claude')).toHaveLength(1);expect(h.effects.filter(x=>x==='exit-proof:claude')).toHaveLength(1);
 const lifetime=lifetimeReservations(h);expect(lifetime.locks).toBe(1);
 expect(lifetime.reservations.filter(r=>r.state==='acknowledged').map(r=>JSON.parse(r.result_json!).agent)).toEqual(['claude']);
 expect(lifetime.reservations.filter(r=>r.state!=='acknowledged')).toHaveLength(1);
 await expect(h.service.owned.turn(roomB,request(roomB,'after-failed-close'))).rejects.toMatchObject({code:'protocol_service_closed'});
 expect(h.effects.filter(x=>x.startsWith('launch:'))).toHaveLength(2);
 if(turnWork){finishTurn!();expect((await turnWork).state).toBe('uncertain');
  const reopened=h.create();expect((await reopened.owned.turnStatus(roomA,input.id))?.state).toBe('uncertain');expect((await reopened.owned.turn(roomA,input)).state).toBe('uncertain');
  expect(h.effects.filter(x=>x==='turn:'+input.id)).toHaveLength(1);
 }
});

test('shutdown revokes a deferred native admission before the next wire frame, without replay',async()=>{
 const h=fixture(),{room:roomA}=await h.bootstrap();await secondOwnedRoom(h);h.certify();let entered!:()=>void,release!:()=>void;
 const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 h.admitHook(async request=>{if(request.phase.startsWith('wire:turn:')){entered();await gate;}});
 const input=request(roomA,'admission-shutdown'),work=h.service.owned.turn(roomA,input);await waiting;
 const wireCount=h.effects.filter(x=>x==='wire:codex').length;
 await expect(h.service.close()).rejects.toMatchObject({code:'protocol_service_cleanup_failed'});
 expect(h.effects).toContain('exit-proof:claude');release();expect((await work).state).toBe('uncertain');expect(h.effects.filter(x=>x==='wire:codex')).toHaveLength(wireCount);
 const reopened=h.create();expect((await reopened.owned.turn(roomA,input)).state).toBe('uncertain');expect(h.effects.filter(x=>x==='wire:codex')).toHaveLength(wireCount);expect(h.effects.filter(x=>x.startsWith('launch:'))).toHaveLength(2);
});

function acceptanceFixture(){
 let clock=Date.now(),revoked=false,mismatch=false;const permits:ProtocolAcceptancePermit[]=[],allowed=new Set<string>(),calls:ProtocolAcceptanceOperation[]=[];
 const authority:ProtocolAcceptanceAuthority={advertise:async()=>structuredClone(permits),authorize:async operation=>{
  calls.push(structuredClone(operation));if(revoked||!allowed.has(operation.kind+':'+operation.id))return null;
  const permit=permits.find(p=>p.scope.room.id===operation.room.id&&p.scope.profile.hash===operation.profile.hash&&p.scope.operations.includes(operation.kind));if(!permit)return null;
  return {permit:structuredClone(permit),operation:mismatch?{...structuredClone(operation),payloadHash:'0'.repeat(64)}:structuredClone(operation)};
 }};
 const h=fixture({acceptancePermit:authority,now:()=>clock});
 const grant=(room:Room,agent:'codex'|'claude',kinds:('switch'|'text-turn')[],maxOperations=1,permitId='accept-'+agent)=>{
  const permit:ProtocolAcceptancePermit={source:'trusted-bounded-acceptance',permitId,expiresAt:clock+10_000,maxOperations,scope:{room:{id:room.id,backend:room.backend,workspace:room.workspace,room:room.room,cwd:room.cwd},profile:protocolAcceptanceProfile(h.candidate(agent).binding),operations:kinds}};permits.push(permit);return permit;
 };
 return {...h,permits,calls,grant,allow:(kind:string,id:string)=>allowed.add(kind+':'+id),expire:()=>{clock+=20_000;},revoke:()=>{revoked=true;},mismatch:()=>{mismatch=true;}};
}
function acceptanceClaims(h:ReturnType<typeof fixture>){const db=new Database(join(h.options.privateRoot,'owned-turns.sqlite'),{readonly:true});try{return db.query('SELECT * FROM protocol_acceptance_claims').all() as {kind:string;permit_id:string;operation_hash:string}[];}finally{db.close();}}
test('bounded acceptance is separate from production and advertisements never consume budget',async()=>{
 const h=acceptanceFixture(),{room}=await h.bootstrap();h.grant(room,'codex',['text-turn'],1);h.allow('text-turn','bounded-one');
 for(let i=0;i<3;i++){const caps:any=await h.service.featureOptions.capabilities();expect(caps.ready).toBe(true);expect(caps.authorization.purpose).toBe('bounded-acceptance');expect(caps.authorization.permits[0].remaining).toBe(1);}
 expect(acceptanceClaims(h)).toEqual([]);expect((await h.service.owned.status(room)).capabilities.textTurn).toBe(true);
 expect((await h.service.owned.turn(room,request(room,'bounded-one'))).state).toBe('completed');expect(acceptanceClaims(h)).toHaveLength(1);expect(h.calls.length).toBeGreaterThan(1);
 const caps:any=await h.service.featureOptions.capabilities();expect(caps.ready).toBe(false);expect(caps.authorization.permits[0].remaining).toBe(0);
});
test('exact historical turn bypasses expired permit/budget but changed payload conflicts first',async()=>{
 const h=acceptanceFixture(),{room}=await h.bootstrap();h.grant(room,'codex',['text-turn']);h.allow('text-turn','one');const input=request(room,'one');await h.service.owned.turn(room,input);h.expire();h.revoke();
 const effects=h.effects.length,calls=h.calls.length;expect((await h.service.owned.turn(room,input)).source).toBe('historical');await expect(h.service.owned.turn(room,{...input,text:'changed'})).rejects.toMatchObject({code:'protocol_turn_id_conflict'});expect(h.calls.length).toBe(calls);expect(h.effects.length).toBe(effects);expect(acceptanceClaims(h)).toHaveLength(1);
});
test('room A permit never authorizes room B on same backend; action and profile are exact',async()=>{
 const h=acceptanceFixture(),{room}=await h.bootstrap(),b=await secondOwnedRoom(h);h.grant(room,'codex',['switch']);h.allow('text-turn','wrong-action');
 expect((await h.service.owned.status(room)).capabilities.textTurn).toBe(false);expect((await h.service.owned.status(b)).capabilities.textTurn).toBe(false);
 await expect(h.service.owned.turn(room,request(room,'wrong-action'))).rejects.toMatchObject({code:'bounded_acceptance_denied'});
 await expect(h.service.owned.turn(b,request(b,'wrong-room'))).rejects.toMatchObject({code:'bounded_acceptance_denied'});expect(acceptanceClaims(h)).toEqual([]);expect(h.effects.filter(x=>x.startsWith('turn:'))).toEqual([]);
});
test('wrong full payload hash and host revocation reject before claim/effect',async()=>{
 for(const wrong of ['payload','revoke']){const h=acceptanceFixture(),{room}=await h.bootstrap();h.grant(room,'codex',['text-turn']);h.allow('text-turn','one');if(wrong==='payload')h.mismatch();else h.revoke();await expect(h.service.owned.turn(room,request(room,'one'))).rejects.toMatchObject({code:'bounded_acceptance_denied'});expect(acceptanceClaims(h)).toEqual([]);expect(h.effects.filter(x=>x.startsWith('turn:'))).toEqual([]);}
});
test('expiry after claim cannot reset uncertainty or replay on reopen with a replacement permit',async()=>{
 const h=acceptanceFixture(),{room}=await h.bootstrap();h.grant(room,'codex',['text-turn']);h.allow('text-turn','lost');h.turnHook(async()=>{h.expire();});
 expect((await h.service.owned.turn(room,request(room,'lost'))).state).toBe('uncertain');expect(acceptanceClaims(h)).toHaveLength(1);const next=h.create();expect((await next.owned.turn(room,request(room,'lost'))).state).toBe('uncertain');
 h.grant(room,'codex',['text-turn'],5,'replacement');h.allow('text-turn','new');await expect(h.service.owned.turn(room,request(room,'new'))).rejects.toMatchObject({code:'protocol_turn_reconciliation_required'});expect(h.effects.filter(x=>x.startsWith('turn:'))).toHaveLength(1);expect(acceptanceClaims(h)).toHaveLength(1);
});
test('durable budget remains spent across independent service connections and definition changes fail closed',async()=>{
 const h=acceptanceFixture(),{room}=await h.bootstrap(),p=h.grant(room,'codex',['text-turn']);h.allow('text-turn','spent');await h.service.owned.turn(room,request(room,'spent'));
 const next=h.create();const caps:any=await next.featureOptions.capabilities();expect(caps.authorization.permits[0].remaining).toBe(0);expect(caps.ready).toBe(false);
 p.maxOperations=100;expect((await next.featureOptions.capabilities()).ready).toBe(false);expect(acceptanceClaims(h)).toHaveLength(1);
});
test('failed owned request transaction rolls acceptance budget back before any native effect',async()=>{
 const h=acceptanceFixture(),{room}=await h.bootstrap();h.grant(room,'codex',['text-turn']);h.allow('text-turn','rollback');await h.service.owned.turnStatus(room,'unknown');
 const db=new Database(join(h.options.privateRoot,'owned-turns.sqlite'));db.exec("CREATE TRIGGER acceptance_owned_insert_failure BEFORE INSERT ON protocol_owned_turns BEGIN SELECT RAISE(ABORT,'fixture failure'); END");db.close();
 await expect(h.service.owned.turn(room,request(room,'rollback'))).rejects.toBeDefined();expect(acceptanceClaims(h)).toEqual([]);expect(h.effects.filter(x=>x.startsWith('turn:'))).toEqual([]);
});
test('bounded switch consumes once before source close and target launch, with no production live evidence',async()=>{
 const h=acceptanceFixture(),{room}=await h.bootstrap();h.grant(room,'claude',['switch']);h.allow('switch','switch-op');await approve(h,room);await h.service.engine.request(room.id,{id:'switch-op',target:'claude',model:'fixture-model',expectedRevision:0,factsSelectionId:'switch-op'});
 const op=await h.service.engine.advance('switch-op');expect(op.state).toBe('ready-awaiting-user');expect(acceptanceClaims(h)).toHaveLength(1);expect(h.effects.indexOf('exit:codex')).toBeLessThan(h.effects.indexOf('launch:claude'));expect(h.calls.filter(c=>c.kind==='switch').length).toBeGreaterThan(2);
 h.expire();const before=h.effects.length;expect((await h.service.engine.request(room.id,{id:'switch-op',target:'claude',model:'fixture-model',expectedRevision:0,factsSelectionId:'switch-op'})).state).toBe('ready-awaiting-user');expect(h.effects.length).toBe(before);
});
for(const mutation of ['expiry','revoke'] as const)test(`deferred last source inspection ${mutation} blocks close and target launch without consuming twice`,async()=>{
 const h=acceptanceFixture(),{room}=await h.bootstrap();h.grant(room,'claude',['switch']);h.allow('switch','switch-op');await approve(h,room);
 let fired=false;
 h.admitHook(async request=>{if(!fired&&request.phase==='inspect'&&acceptanceClaims(h).length){fired=true;await Promise.resolve();if(mutation==='expiry')h.expire();else h.revoke();}});
 await h.service.engine.request(room.id,{id:'switch-op',target:'claude',expectedRevision:0,factsSelectionId:'switch-op'});const op=await h.service.engine.advance('switch-op');expect(fired).toBe(true);expect(op.state).toBe('uncertain');expect(h.effects).not.toContain('exit:codex');expect(h.effects).not.toContain('launch:claude');expect(acceptanceClaims(h)).toHaveLength(1);
});

test('production evidence deferred at last source-close gate rechecks actual room revision after await',async()=>{
 const h=fixture(),{room}=await h.bootstrap();h.certify();await approve(h,room);let count=0,entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 h.evidenceHook(async()=>{if(++count===4){entered();await gate;}});
 await h.service.engine.request(room.id,{id:'switch-op',target:'claude',expectedRevision:0,factsSelectionId:'switch-op'});const advancing=h.service.engine.advance('switch-op');await waiting;
 const op=h.service.store.operation('switch-op')!;expect(op.state).toBe('delivering-context');h.service.store.complete(op.id,{agent:'claude',nativeId:tid,generation:'concurrent-completion',model:'fixture-model',route:'direct',cursor:op.checkpointSeq!});
 release();await advancing;expect(h.service.store.room(room.id)?.revision).toBe(1);expect(h.effects).not.toContain('exit:codex');expect(h.effects).not.toContain('launch:claude');
});

test('atomic switch budget is idempotent across two independent service connections racing the same full operation',async()=>{
 const h=acceptanceFixture(),{room}=await h.bootstrap();h.grant(room,'claude',['switch']);h.allow('switch','race-switch');const next=h.create();
 await h.service.engine.request(room.id,{id:'race-switch',target:'claude',expectedRevision:0});const current=h.service.store.room(room.id)!;
 const context={id:'race-switch',text:'context',hash:createHash('sha256').update('context').digest('hex'),throughSeq:0};
 const first=h.service.engine.adapters.herdr.launchWithContext!(current,'claude',context);
 const second=next.engine.adapters.herdr.launchWithContext!(current,'claude',context);
 const results=await Promise.allSettled([first,second]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(acceptanceClaims(h)).toHaveLength(1);expect(h.effects.filter(x=>x==='exit:codex')).toHaveLength(1);expect(h.effects.filter(x=>x==='launch:claude')).toHaveLength(1);
});
