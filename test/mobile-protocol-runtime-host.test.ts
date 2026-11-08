import {afterEach,expect,test,describe} from 'bun:test';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EffectJournal} from '../src/mobile/continuity/effect-journal';
import {ProtocolRuntimeHost,type RuntimeAdmissionRequest,type RuntimeStartRequest,type RuntimeHostOptions} from '../src/mobile/continuity/protocol/runtime-host';
import {ProtocolError,type NativeProtocolSession,type ProtocolIdentity,type ProtocolTurn,type ProtocolWire,type StagedNativeProtocolSession} from '../src/mobile/continuity/protocol/types';
import type {ProtocolEntryCandidateV2,ProtocolPilotCandidate} from '../src/mobile/continuity/protocol/entry';
const nativeId='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',turnId='00000000-0000-4000-8000-000000000003';
const roots:string[]=[],journals:EffectJournal[]=[];afterEach(()=>{for(const j of journals.splice(0))j.close();for(const d of roots.splice(0))rmSync(d,{recursive:true,force:true});});
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function fixture(agent:'codex'|'claude'='codex',resume=false){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'protocol-runtime-host-')));roots.push(root);
 const journal=new EffectJournal(join(root,'private','runtime.sqlite'));journals.push(journal);const events:string[]=[];let alive=true,exitProof=true,failTurn=false,wrongIdentity=false,pending=false,closeFails=false,denyPhase='',external=false;
 const candidate=freeze({version:2,tool:agent,model:'fixture-model',route:'direct',cwd:root,binary:'/fixture/native',session:resume?{mode:'resume',id:nativeId}:{mode:'fresh'},eligibility:{candidateOnly:true,liveEligible:false},binding:{version:2,kind:agent==='codex'?'codex-app-server-stdio':'claude-stream-json',route:'direct',model:'fixture-model',provider:agent==='codex'?'openai':'anthropic',endpoint:agent==='codex'?null:'https://api.anthropic.com',home:root,effectiveToolHome:root,homeEnvironment:{state:'absent'},cwd:root,nativeBinary:'/fixture/native',nativeSha256:'a'.repeat(64),nativeVersion:agent==='codex'?'0.164.0':'2.1.220',sessionId:resume?nativeId:null}} as ProtocolEntryCandidateV2);
 const states=(step:string)=>{const db=new Database(journal.path,{readonly:true});try{return db.query('SELECT state FROM continuity_effects WHERE step=?').all(step) as {state:string}[];}finally{db.close();}};
 const wire:ProtocolWire={messages:{async *[Symbol.asyncIterator](){}},send:async frame=>{events.push('wire:'+frame.method);},close:async()=>{events.push('wire-close');}};
 let lastPermit:any;const supervisor={launch:async(_candidate:unknown,permit:any)=>{events.push('launch');expect(states('launch').filter(x=>x.state==='dispatching')).toHaveLength(1);expect(states('launch-permit').every(x=>x.state==='acknowledged')).toBe(true);lastPermit=permit;return {wire,runtimeBirth:'fixture-child-birth',...permit,diagnostics:()=>({stderrBytes:0,stderrTruncated:false,stderr:'' as const}),assertRunning:async()=>{events.push('running');if(!alive)throw Error('not running');},cleanup:async()=>{events.push('cleanup');if(closeFails)throw Error('cleanup failed');alive=false;},observeExit:async(expected:any)=>{events.push('exit-proof');return {...expected,source:'owned-process-supervisor' as const,exit:{code:0,signal:null},inputClosed:true as const,outputClosed:exitProof as true,pendingWork:false as const};}};}};
 const admissions:RuntimeAdmissionRequest[]=[];const admit:RuntimeHostOptions['admit']=async request=>{admissions.push(request);events.push('admit:'+request.phase);if(request.phase===denyPhase)throw Error('revoked');return {source:'trusted-protocol-admission',binding:structuredClone(request.binding),externalWriter:external?'external-tui':'absent',...(request.launchReceipt?{launchReceipt:{...request.launchReceipt}}:{})};};
 let driver!:StagedNativeProtocolSession,observed:any,ready=false;
 const createDriver:NonNullable<RuntimeHostOptions['driverFactory']>=(_candidate,guarded)=>{
  const identity=():ProtocolIdentity=>({agent,nativeId:wrongIdentity?other:nativeId,model:'fixture-model',cwd:root,home:root,route:'direct'});
  const observe=()=>{const i=identity();observed={agent:i.agent,nativeId:i.nativeId,model:i.model,cwd:i.cwd};};
  const completed=(op:string):ProtocolTurn=>({operationId:op,nativeId:identity().nativeId,turnId,text:'คำตอบตัวอย่าง',state:'completed'});
  driver={get idle(){return ready;},get pendingApproval(){return pending;},get nativeObservation(){return observed;},open:async id=>{events.push('open:'+String(id));expect(states('open').filter(x=>x.state==='dispatching')).toHaveLength(1);await guarded.send({method:'fixture/open'});observe();ready=true;return identity();},prepare:async id=>{events.push('prepare:'+String(id));expect(states('prepare')).toEqual([{state:'dispatching'}]);expect(states('start')).toEqual([{state:'dispatching'}]);await guarded.send({method:'fixture/prepare'});},startTurn:async(op,text)=>{events.push('first:'+text);expect(states('first-user')).toEqual([{state:'dispatching'}]);await guarded.send({method:'fixture/first-user'});if(failTurn)throw new ProtocolError('disconnect',true);observe();ready=true;return {identity:identity(),turn:completed(op)};},turn:async(op,text)=>{events.push('turn:'+text);ready=false;await guarded.send({method:'fixture/turn'});if(failTurn)throw new ProtocolError('disconnect',true);ready=true;return completed(op);},close:async()=>{events.push('driver-close');await guarded.close();ready=false;}};return driver;
 };
 const options:RuntimeHostOptions={journal,supervisor,admit,driverFactory:createDriver};const host=new ProtocolRuntimeHost(options);
 const input:RuntimeStartRequest={roomId:'synthetic-room',operationId:'launch-op',candidate,timeoutMs:1000,writer:'owned-protocol-child',...(agent==='claude'?{firstTurn:{operationId:'first-context',text:'ข้อมูลที่ผู้ใช้อนุญาต'}}:{})};
 return {root,journal,candidate,events,admissions,host,input,options,states,get driver(){return driver;},get permit(){return lastPermit;},failTurn:()=>{failTurn=true;},wrongIdentity:()=>{wrongIdentity=true;},pending:()=>{pending=true;},dead:()=>{alive=false;},deny:(phase:string)=>{denyPhase=phase;},external:()=>{external=true;},badExit:()=>{exitProof=false;},badCleanup:()=>{closeFails=true;}};
}
describe('Runtime host durable owned-process orchestration',()=>{
 for(const agent of ['codex','claude'] as const)for(const resume of [false,true])test(`${agent} ${resume?'resume':'fresh'} persists stages before all writes and holds lifetime after turn`,async()=>{
  const f=fixture(agent,resume),result=await f.host.start(f.input);expect(result.source).toBe('live');expect(result.identity.nativeId).toBe(nativeId);expect(f.host.idle).toBe(true);expect(f.events).toContain(agent==='codex'?'open:'+String(resume?nativeId:undefined):'prepare:'+String(resume?nativeId:undefined));
  if(agent==='claude'){expect(result.firstTurn?.operationId).toBe('first-context');expect(f.admissions.find(a=>a.phase==='authorize-first-user')?.textHash).toBeString();expect(f.admissions.findIndex(a=>a.phase==='authorize-first-user')).toBeLessThan(f.admissions.findIndex(a=>a.phase==='prepare'));const prior=f.events.length;expect((await f.host.turn('first-context','ข้อมูลที่ผู้ใช้อนุญาต')).source).toBe('historical');expect(f.events.length).toBe(prior);}
  const turn=await f.host.turn('next-turn','ข้อความถัดไป');expect(turn.source).toBe('live');expect(turn.turn.nativeId).toBe(nativeId);expect(f.host.idle).toBe(true);const before=f.events.length;expect((await f.host.turn('next-turn','ข้อความถัดไป')).source).toBe('historical');expect(f.events.length).toBe(before);
  const competing=new ProtocolRuntimeHost(f.options);await expect(competing.start({...f.input,operationId:'other-host'})).rejects.toMatchObject({uncertain:true});expect(f.events.filter(x=>x==='launch')).toHaveLength(1);
  expect((await f.host.close()).state).toBe('released');expect(f.events.indexOf('cleanup')).toBeLessThan(f.events.indexOf('exit-proof'));
  const afterClose=new ProtocolRuntimeHost(f.options);expect((await afterClose.start(f.input)).source).toBe('historical');expect(f.events.filter(x=>x==='launch')).toHaveLength(1);
 });
 test('declared or observed external TUI takeover is rejected without launch',async()=>{
  const direct=fixture();await expect(direct.host.start({...direct.input,writer:'external-tui'})).rejects.toThrow('runtime_external_tui_takeover_unsupported');expect(direct.events).toEqual([]);
  const observed=fixture();observed.external();await expect(observed.host.start(observed.input)).rejects.toMatchObject({uncertain:true});expect(observed.events).not.toContain('launch');
 });
 test('v1 candidates and homeEnvironment presence changes cannot be normalized into runtime v2 authority',async()=>{
  const f=fixture();const old=freeze({...f.candidate,version:1});await expect(f.host.start({...f.input,candidate:old as any})).rejects.toThrow('protocol_entry_v2_binding_invalid');expect(f.events).toEqual([]);
  const h=fixture();h.options.admit=async request=>({source:'trusted-protocol-admission',binding:{...request.binding,homeEnvironment:{state:'present',value:request.binding.effectiveToolHome}},externalWriter:'absent'});const host=new ProtocolRuntimeHost(h.options);await expect(host.start(h.input)).rejects.toMatchObject({uncertain:true});expect(h.events).not.toContain('launch');
 });
 test('resume identity mismatch cannot fall back to a fresh open or grant lease active',async()=>{
  const f=fixture('codex',true);f.wrongIdentity();await expect(f.host.start(f.input)).rejects.toMatchObject({uncertain:true});expect(f.events.filter(e=>e.startsWith('open:'))).toEqual(['open:'+nativeId]);expect(f.states('native')).toEqual([]);await expect(f.host.turn('next','sample')).rejects.toBeInstanceOf(ProtocolError);
 });
 test('Claude cannot prepare or send synthetic bootstrap without an explicitly supplied first context',async()=>{
  const f=fixture('claude');await expect(f.host.start({...f.input,firstTurn:undefined})).rejects.toThrow('runtime_authorized_first_turn_required');expect(f.events).toEqual([]);
 });
 test('Claude requires both native init observation and valid final before any start receipt',async()=>{
  const f=fixture('claude');f.pending();await expect(f.host.start(f.input)).rejects.toMatchObject({uncertain:true});expect(f.states('start')).toEqual([{state:'uncertain'}]);expect(f.states('first-user')).toEqual([{state:'uncertain'}]);
 });
 test('disconnect in first/next user remains uncertain and restart never resends',async()=>{
  for(const first of [true,false]){const f=fixture(first?'claude':'codex');if(first)f.failTurn();else await f.host.start(f.input);if(!first)f.failTurn();await expect(first?f.host.start(f.input):f.host.turn('lost-turn','sample')).rejects.toMatchObject({uncertain:true});const writes=f.events.filter(e=>e.startsWith('wire:')).length;
   const recovered=new ProtocolRuntimeHost(f.options);if(first)await expect(recovered.start(f.input)).rejects.toMatchObject({uncertain:true});else{expect((await recovered.start(f.input)).source).toBe('historical');await expect(recovered.turn('lost-turn','sample')).rejects.toBeInstanceOf(ProtocolError);}expect(f.events.filter(e=>e.startsWith('wire:'))).toHaveLength(writes);}
 });
 test('binding pin revocation after launch prevents protocol open, retains lease until exit proof',async()=>{
  const f=fixture();f.deny('open');await expect(f.host.start(f.input)).rejects.toMatchObject({uncertain:true});expect(f.events).not.toContain('open:undefined');expect(f.events).toContain('launch');expect((await f.host.close()).state).toBe('released');
 });
 test('child death blocks next turn before wire input; bad exit/cleanup cannot release lifetime',async()=>{
  for(const kind of ['exit','cleanup']){const f=fixture();await f.host.start(f.input);if(kind==='exit')f.badExit();else f.badCleanup();await expect(f.host.close()).rejects.toMatchObject({uncertain:true});const otherHost=new ProtocolRuntimeHost(f.options);await expect(otherHost.start({...f.input,operationId:'replacement'})).rejects.toMatchObject({uncertain:true});expect(f.events.filter(e=>e==='launch')).toHaveLength(1);}
  const f=fixture();await f.host.start(f.input);f.dead();await expect(f.host.turn('dead-child-turn','sample')).rejects.toMatchObject({uncertain:true});expect(f.events.filter(e=>e.startsWith('wire:fixture/turn'))).toEqual([]);
 });
 test('historical result is read-only, does not call admission/launch or grant a new lease',async()=>{
  const f=fixture();await f.host.start(f.input);await f.host.close();const count=f.events.length;const replay=new ProtocolRuntimeHost(f.options);expect((await replay.start(f.input)).source).toBe('historical');expect(f.events.length).toBe(count);expect(replay.idle).toBe(false);await expect(replay.turn('new','sample')).rejects.toThrow('runtime_turn_invalid');
 });
});

/** Native schema fixtures run through the actual drivers; this transport never spawns. */
class FrameWire implements ProtocolWire {
 frames:Record<string,any>[]=[];onSend?:(frame:Record<string,any>)=>void;
 private queue:unknown[]=[];private waiters:((r:IteratorResult<unknown>)=>void)[]=[];private ended=false;
 messages:AsyncIterable<unknown>={[Symbol.asyncIterator]:()=>({next:()=>this.queue.length?Promise.resolve({done:false,value:this.queue.shift()}):this.ended?Promise.resolve({done:true,value:undefined}):new Promise(resolve=>this.waiters.push(resolve))})};
 push(value:unknown){const next=this.waiters.shift();if(next)next({done:false,value});else this.queue.push(value);}
 async send(frame:Record<string,any>){this.frames.push(structuredClone(frame));this.onSend?.(frame);}
 async close(){this.ended=true;for(const next of this.waiters.splice(0))next({done:true,value:undefined});}
}
for(const agent of ['codex','claude'] as const)test(`actual ${agent} driver + owned runtime + SQLite journal, native schema completion only`,async()=>{
 const f=fixture(agent,true),wire=new FrameWire(),original=f.options.supervisor.launch.bind(f.options.supervisor);
 const host=new ProtocolRuntimeHost({...f.options,driverFactory:undefined,supervisor:{launch:async(c,p)=>({...await original(c,p),wire})}});
 wire.onSend=frame=>{
  if(agent==='codex'){
   if(frame.method==='initialize')wire.push({id:frame.id,result:{codexHome:f.root,platformFamily:'unix',platformOs:'macos',userAgent:'codex/0.164.0'}});
   if(frame.method==='thread/resume'){
    expect(frame.params.threadId).toBe(nativeId);expect(frame.params.approvalPolicy).toBe('on-request');expect(frame.params.approvalsReviewer).toBe('user');expect(frame.params.sandbox).toBe('read-only');
    wire.push({id:frame.id,result:{thread:{id:nativeId,cwd:f.root,ephemeral:false,model:'fixture-model',modelProvider:'openai',status:{type:'idle'},turns:[]},cwd:f.root,model:'fixture-model',modelProvider:'openai',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}}});
   }
   if(frame.method==='turn/start'){
    wire.push({id:frame.id,result:{turn:{id:turnId,items:[],status:'inProgress',error:null,itemsView:'full'}}});
    wire.push({method:'turn/completed',params:{threadId:nativeId,turn:{id:turnId,items:[{type:'agentMessage',id:'final',text:'native final',phase:'final_answer'}],status:'completed',error:null,itemsView:'full'}}});
   }
  }else{
   if(frame.type==='control_request')wire.push({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{commands:[],models:[]}}});
   if(frame.type==='user'){
    expect(frame.session_id).toBe(nativeId);
    if(wire.frames.filter(x=>x.type==='user').length===1)wire.push({type:'system',subtype:'init',uuid:crypto.randomUUID(),session_id:nativeId,cwd:f.root,model:'fixture-model',permissionMode:'default',claude_code_version:'2.1.220'});
    wire.push({type:'assistant',uuid:crypto.randomUUID(),session_id:nativeId,parent_tool_use_id:null,message:{role:'assistant',model:'fixture-model',content:[{type:'text',text:'native final'}],stop_reason:'end_turn'}});
    wire.push({type:'result',subtype:'success',uuid:crypto.randomUUID(),session_id:nativeId,user_message_uuid:frame.uuid,num_turns:1,is_error:false,stop_reason:'end_turn',terminal_reason:'completed',permission_denials:[],result:'native final'});
   }
  }
 };
 const started=agent==='claude'?await host.startWithContext({...f.input,firstTurn:f.input.firstTurn!}):await host.open(f.input);
 expect(started.generation).toBe(1);expect(started.identity.nativeId).toBe(nativeId);if(agent==='claude')expect(started.firstTurn?.text).toBe('native final');
 const inspected=await host.inspect();expect(inspected.binding).toEqual(f.candidate.binding);expect(inspected.selection).toEqual(f.candidate.session);expect(inspected.generation).toBe(1);
 const result=await host.turn('real-driver-next','ข้อความถัดไป');expect(result.turn.text).toBe('native final');expect(result.generation).toBe(1);expect(result.identity).toEqual(started.identity);
 await host.close();await expect(host.inspect()).rejects.toMatchObject({uncertain:true});
});
test('inspection revalidates admission and child; revoked ownership cannot report live identity',async()=>{
 for(const changed of ['admission','child']){const f=fixture();await f.host.open(f.input);const writes=f.events.filter(x=>x.startsWith('wire:')).length;if(changed==='admission')f.deny('inspect');else f.dead();await expect(f.host.inspect()).rejects.toMatchObject({uncertain:true});await expect(f.host.turn('new','sample')).rejects.toMatchObject({uncertain:true});expect(f.events.filter(x=>x.startsWith('wire:'))).toHaveLength(writes);}
});
test('wire-level admission revocation blocks exact next frame even after initial open admission',async()=>{
 const f=fixture();f.deny('wire:open');await expect(f.host.open(f.input)).rejects.toMatchObject({uncertain:true});expect(f.events.filter(x=>x.startsWith('wire:'))).toEqual([]);expect(f.events).toContain('open:undefined');await f.host.close();
});
test('same native resume is locked across rooms, not merely per room',async()=>{
 const f=fixture('codex',true);await f.host.open(f.input);const second=new ProtocolRuntimeHost(f.options);await expect(second.open({...f.input,roomId:'other-room',operationId:'other-operation'})).rejects.toMatchObject({uncertain:true});expect(f.events.filter(x=>x==='launch')).toHaveLength(1);await f.host.close();
});
test('generation increments only after prior owned process exit and next verified native session',async()=>{
 const f=fixture('codex',true);expect((await f.host.open(f.input)).generation).toBe(1);await f.host.close();
 // Original fake child is closed; replace only its read-only running probe for a new owned fixture child.
 const base=f.options.supervisor.launch.bind(f.options.supervisor);const next=new ProtocolRuntimeHost({...f.options,supervisor:{launch:async(c,p)=>({...await base(c,p),assertRunning:async()=>{}})}});
 expect((await next.open({...f.input,operationId:'next-incarnation'})).generation).toBe(2);expect((await next.inspect()).generation).toBe(2);await next.close();
});
test('changed same-operation payload cannot replay an acknowledged first receipt',async()=>{
 const f=fixture('claude');await f.host.start(f.input);const before=f.events.length;const recovered=new ProtocolRuntimeHost(f.options);await expect(recovered.start({...f.input,firstTurn:{operationId:'first-context',text:'different authorized context'}})).rejects.toMatchObject({uncertain:true});expect(f.events.length).toBe(before);await f.host.close();
});
test('bounded read-only admission cannot hang launch or allow late completion to spawn',async()=>{
 const f=fixture();let resolve!:(value:any)=>void;const host=new ProtocolRuntimeHost({...f.options,admit:()=>new Promise(r=>{resolve=r;})});
 await expect(host.open({...f.input,timeoutMs:10})).rejects.toMatchObject({uncertain:true});expect(f.events).toEqual([]);
 resolve({source:'trusted-protocol-admission',binding:f.candidate.binding,externalWriter:'absent'});await Promise.resolve();expect(f.events).toEqual([]);
});
test('concurrent turn rejects before any second write and completed first turn retains runtime ownership',async()=>{
 const f=fixture();await f.host.open(f.input);const first=f.host.turn('one','sample');await expect(f.host.turn('two','sample')).rejects.toThrow('runtime_session_busy');await first;expect(f.events.filter(x=>x==='turn:sample')).toHaveLength(1);expect((await f.host.inspect()).idle).toBe(true);await f.host.close();
});
test('SQLite closed/reopened journal preserves acknowledged start and never relaunches',async()=>{
 const f=fixture();const first=await f.host.open(f.input);await f.host.close();f.journal.close();const reopened=new EffectJournal(f.journal.path);journals.push(reopened);const before=f.events.length;
 const recovered=new ProtocolRuntimeHost({...f.options,journal:reopened});expect(await recovered.open(f.input)).toEqual({...first,source:'historical'});expect(f.events.length).toBe(before);await expect(recovered.inspect()).rejects.toMatchObject({uncertain:true});
});
test('journal failure before first claim cannot launch, open, or write',async()=>{
 const f=fixture();const claim=f.journal.claim;f.journal.claim=()=>{throw Error('fixture disk failure');};await expect(f.host.open(f.input)).rejects.toMatchObject({uncertain:true});expect(f.events).toEqual([]);f.journal.claim=claim;
});

function pilotCandidate(f:ReturnType<typeof fixture>):ProtocolPilotCandidate {
 const args=['--resume',nativeId,'--safe-mode','--tools',''];
 const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const pilotPolicy={kind:'claude-context-only-safe' as const,version:1 as const};
 return freeze({...f.candidate,version:3,pilotPolicy,args,policyArgvHash:digest(args.slice(-3)),finalArgvHash:digest(args),binding:{...f.candidate.binding,version:3,pilotPolicy,policyArgvHash:digest(args.slice(-3))}});
}
test('v3 pilot preserves original policy and presence in supervisor, admission, inspection and durable journal',async()=>{
 const f=fixture('claude',true),candidate=pilotCandidate(f);let launched:unknown;
 const base=f.options.supervisor.launch.bind(f.options.supervisor),host=new ProtocolRuntimeHost({...f.options,supervisor:{launch:async(c,p)=>{launched=c;return base(c,p);}}});
 const started=await host.startWithContext({...f.input,candidate,firstTurn:f.input.firstTurn!});expect(started.source).toBe('live');expect(launched).toBe(candidate);
 for(const request of f.admissions){expect(request.binding).toEqual(candidate.binding);expect(request.binding.version).toBe(3);expect(request.launchReceipt).toEqual({finalArgvHash:candidate.finalArgvHash});expect(Object.isFrozen(request.launchReceipt)).toBe(true);expect(Object.hasOwn(request.binding,'finalArgvHash')).toBe(false);}
 expect((await host.inspect()).binding).toEqual(candidate.binding);
 const db=new Database(f.journal.path,{readonly:true});const stored=db.query("SELECT result_json FROM continuity_effects WHERE step='entry-binding'").get() as {result_json:string};db.close();
 expect(JSON.parse(stored.result_json)).toEqual({version:3,binding:candidate.binding,selection:candidate.session,finalArgvHash:candidate.finalArgvHash});
 await host.close();
 const recovered=new ProtocolRuntimeHost(f.options);expect((await recovered.open({...f.input,candidate})).source).toBe('historical');
});
test('v3 pilot rejects admission policy/version/presence drift before next frame without downgrade',async()=>{
 for(const mutation of ['policy','hash','version','presence'] as const){
  const f=fixture('claude',true),candidate=pilotCandidate(f),host=new ProtocolRuntimeHost({...f.options,admit:async request=>{
   const binding:any=structuredClone(request.binding);if(request.phase==='wire:prepare'){
    if(mutation==='policy')binding.pilotPolicy.kind='another-policy';
    if(mutation==='hash')binding.policyArgvHash='0'.repeat(64);
    if(mutation==='version')binding.version=2;
    if(mutation==='presence')binding.homeEnvironment={state:'present',value:binding.effectiveToolHome};
   }
   return {source:'trusted-protocol-admission',binding,externalWriter:'absent',...(request.launchReceipt?{launchReceipt:{...request.launchReceipt}}:{})};
  }});
  await expect(host.start({...f.input,candidate})).rejects.toMatchObject({uncertain:true});expect(f.events.filter(x=>x.startsWith('wire:'))).toEqual([]);expect(f.events.filter(x=>x==='launch')).toHaveLength(1);await host.close();
 }
});
test('v3 pilot rejects invalid policy, suffix/hash, presence and unfrozen nested policy before journal/launch',async()=>{
 for(const mutation of ['policy','suffix','hash','presence','mutable-policy'] as const){
  const f=fixture('claude',true);const raw:any=structuredClone(pilotCandidate(f));
  if(mutation==='policy')raw.pilotPolicy.kind='unsupported';
  if(mutation==='suffix')raw.args[raw.args.length-1]='Read';
  if(mutation==='hash')raw.finalArgvHash='0'.repeat(64);
  if(mutation==='presence')raw.binding.homeEnvironment={state:'present',value:f.root+'/other-home'};
  let candidate:ProtocolPilotCandidate;
  if(mutation==='mutable-policy'){freeze(raw.binding);freeze(raw.session);freeze(raw.args);raw.pilotPolicy={...raw.pilotPolicy};candidate=Object.freeze(raw);}else candidate=freeze(raw);
  await expect(f.host.open({...f.input,candidate})).rejects.toBeInstanceOf(ProtocolError);expect(f.events).toEqual([]);
 }
});
test('v3 pilot cannot reuse acknowledged v2 entry or drift final argv under same operation',async()=>{
 const f=fixture('claude',true);await f.host.open(f.input);const before=f.events.length;const pilot=pilotCandidate(f);await expect(new ProtocolRuntimeHost(f.options).open({...f.input,candidate:pilot})).rejects.toMatchObject({uncertain:true});expect(f.events.length).toBe(before);await f.host.close();
 const g=fixture('claude',true),candidate=pilotCandidate(g);await g.host.open({...g.input,candidate});const raw:any=structuredClone(candidate);raw.args.unshift('--fixture-extra');raw.finalArgvHash=createHash('sha256').update(JSON.stringify(raw.args)).digest('hex');const count=g.events.length;
 await expect(new ProtocolRuntimeHost(g.options).open({...g.input,candidate:freeze(raw)})).rejects.toMatchObject({uncertain:true});expect(g.events.length).toBe(count);await g.host.close();
});

for(const phase of ['inspect','start-return','turn-return','wire:open'] as const)test(`child exit during awaited ${phase} admission cannot return live or write next frame`,async()=>{
 const f=fixture();const base=f.options.admit;let armed=false;let entered!:()=>void,release!:()=>void;
 const waiting=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const host=new ProtocolRuntimeHost({...f.options,admit:async request=>{const result=await base(request);if(armed&&request.phase===phase){entered();await gate;}return result;}});
 if(phase==='inspect'||phase==='turn-return')await host.open(f.input);
 armed=true;const work=phase==='inspect'?host.inspect():phase==='turn-return'?host.turn('race-turn','sample'):host.open(f.input);
 const outcome=work.then(value=>({ok:true,value,error:undefined}),error=>({ok:false,value:undefined,error}));
 await waiting;const beforeRecheck=f.events.filter(x=>x==='running').length;f.dead();release();const ended=await outcome;expect(ended.ok).toBe(false);expect(ended.error).toMatchObject({uncertain:true});expect(f.events.filter(x=>x==='running').length).toBeGreaterThan(beforeRecheck);
 if(phase==='wire:open')expect(f.events.filter(x=>x.startsWith('wire:'))).toEqual([]);
 if(phase==='start-return')expect(f.states('start')).toEqual([{state:'uncertain'}]);
 if(phase==='turn-return'){const before=f.events.filter(x=>x.startsWith('wire:')).length;await expect(host.turn('race-turn','sample')).rejects.toMatchObject({uncertain:true});expect(f.events.filter(x=>x.startsWith('wire:'))).toHaveLength(before);}
 await host.close();
});
test('wire rechecks durable dispatching intent after awaited admission, not only before',async()=>{
 const f=fixture(),base=f.options.admit;const host=new ProtocolRuntimeHost({...f.options,admit:async request=>{
  const result=await base(request);if(request.phase==='wire:open'){
   const db=new Database(f.journal.path,{readonly:true});const row=db.query("SELECT room_id,operation_id FROM continuity_effects WHERE step='open'").get() as {room_id:string;operation_id:string};db.close();
   f.journal.uncertain(row.room_id,row.operation_id,'open');
  }return result;
 }});
 await expect(host.open(f.input)).rejects.toMatchObject({uncertain:true});expect(f.events.filter(x=>x.startsWith('wire:'))).toEqual([]);await host.close();
});

const pilotBoundaries=['reserve','launch','launched','authorize-first-user','prepare','wire:prepare','prepared','first-user','wire:first-user','first-user-completed','start-return','inspect','next-turn','wire:turn:' /* dynamic turn step handled below */, 'turn-return'] as const;
for(const phase of pilotBoundaries)test(`v3 per-launch receipt missing/drift rejects at ${phase}`,async()=>{
 for(const failure of ['missing','drift'] as const){
  const f=fixture('claude',true),candidate=pilotCandidate(f),base=f.options.admit;let reached=false;
  const host=new ProtocolRuntimeHost({...f.options,admit:async request=>{
   const response=await base(request);
   if(request.phase===phase||phase==='wire:turn:'&&request.phase.startsWith('wire:turn:')){
    reached=true;if(failure==='missing')delete response.launchReceipt;else response.launchReceipt={finalArgvHash:'0'.repeat(64)};
   }return response;
  }});
  const input={...f.input,candidate};
  if(['inspect','next-turn','wire:turn:','turn-return'].includes(phase)){
   await host.open(input);const frames=f.events.filter(x=>x.startsWith('wire:')).length;
   await expect(phase==='inspect'?host.inspect():host.turn('receipt-next','sample')).rejects.toMatchObject({uncertain:true});
   if(phase!=='turn-return')expect(f.events.filter(x=>x.startsWith('wire:'))).toHaveLength(frames);
  }else{
   await expect(host.open(input)).rejects.toMatchObject({uncertain:true});
   if(['reserve','launch'].includes(phase))expect(f.events.filter(x=>x==='launch')).toHaveLength(0);
   if(['launched','authorize-first-user','prepare','wire:prepare'].includes(phase))expect(f.events.filter(x=>x.startsWith('wire:'))).toHaveLength(0);
   if(['prepared','first-user','wire:first-user'].includes(phase))expect(f.events.filter(x=>x==='wire:fixture/first-user')).toHaveLength(0);
  }
  expect(reached).toBe(true);
 }
});
test('v3 launch receipt is exact and immutable; extra fields cannot silently broaden the contract',async()=>{
 const f=fixture('claude',true),candidate=pilotCandidate(f),base=f.options.admit;
 const host=new ProtocolRuntimeHost({...f.options,admit:async request=>{
  expect(Object.isFrozen(request.launchReceipt)).toBe(true);expect(request.launchReceipt?.finalArgvHash).toBe(candidate.finalArgvHash);
  expect(Reflect.set(request.launchReceipt!,'finalArgvHash','0'.repeat(64))).toBe(false);
  return {...await base(request),launchReceipt:{finalArgvHash:candidate.finalArgvHash,unexpected:true}};
 }});
 await expect(host.open({...f.input,candidate})).rejects.toMatchObject({uncertain:true});expect(f.events.filter(x=>x==='launch')).toHaveLength(0);
});
test('v2 admission remains compatible without per-launch receipt',async()=>{
 const f=fixture('claude',true);await f.host.open(f.input);await f.host.turn('v2-next','sample');await f.host.inspect();
 expect(f.admissions.every(request=>!Object.hasOwn(request,'launchReceipt'))).toBe(true);await f.host.close();
});
test('admission retains owner room and launch operation across later turns',async()=>{
 const f=fixture('claude');await f.host.start(f.input);await f.host.turn('later-turn','sample');await f.host.inspect();
 expect(f.admissions.some(r=>r.operationId==='later-turn')).toBe(true);
 for(const r of f.admissions){expect(r.roomId).toBe(f.input.roomId);expect(r.launchOperationId).toBe(f.input.operationId);expect(Object.isFrozen(r)).toBe(true);expect(Reflect.set(r,'roomId','other-room')).toBe(false);}
 await f.host.close();
});
test('same candidate cannot hide a different owner room from host admission',async()=>{
 const f=fixture();const host=new ProtocolRuntimeHost({...f.options,admit:async r=>{
  if(r.roomId!==f.input.roomId||r.launchOperationId!==f.input.operationId)throw new Error('owner_scope_denied');
  return f.options.admit(r);
 }});
 await expect(host.start({...f.input,roomId:'other-room'})).rejects.toMatchObject({uncertain:true});expect(f.events).not.toContain('launch');
});
