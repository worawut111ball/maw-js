import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {loadProtocolHostComposition,protocolHostAcceptanceProfile,type ProtocolHostConfig,type ProtocolHostAuthority,type ProtocolHostMechanisms} from '../src/mobile/continuity/protocol/host-composition';
import {parseNativeRecords} from '../src/mobile/continuity/native-records';
import {prepareOneWayServerHost} from '../src/core/protocol-startup';
import type {StagedNativeProtocolSession} from '../src/mobile/continuity/protocol/types';
import {ProtocolContinuityAdapter,protocolRoomBinding,type ProtocolAdapterPorts} from '../src/mobile/continuity/protocol/adapter';
import {protocolAcceptanceProfile} from '../src/mobile/continuity/protocol/service';
import {validateOneWayProductionPolicy,oneWayRoom,oneWayBindingMatches} from '../src/mobile/continuity/protocol/production-policy';
import type {Room,Binding} from '../src/mobile/continuity/types';
// Portable identity regressions only. All processes/receipts are DI; none of these fixtures certify live production.
const sourceId='00000000-0000-4000-8000-000000000001',targetId='00000000-0000-4000-8000-000000000002';
function identityFixture(){
 const common={route:'direct',model:'fixture-model',home:'/fixture/home',homeEnvironment:{state:'absent'},cwd:'/fixture/project',nativeBinary:'/fixture/native',nativeSha256:'a'.repeat(64),nativeVersion:'fixture-version'};
 const sourceEntry:any={...common,version:2,kind:'codex-app-server-stdio',effectiveToolHome:'/fixture/home/.codex',provider:'openai',endpoint:null,sessionId:sourceId};
 const targetEntry:any={...common,version:3,kind:'claude-stream-json',effectiveToolHome:'/fixture/home/.claude',provider:'anthropic',endpoint:'https://api.anthropic.com',sessionId:targetId,pilotPolicy:{kind:'claude-context-only-safe',version:1},policyArgvHash:'b'.repeat(64)};
 const sourceIdentity={agent:'codex' as const,nativeId:sourceId,model:common.model,route:common.route},targetIdentity={agent:'claude' as const,nativeId:targetId,model:common.model,route:common.route};
 const existing=protocolRoomBinding(targetIdentity,7,targetEntry,4),source=protocolRoomBinding(sourceIdentity,3,sourceEntry,9);
 const room:Room={id:'fixture-room',backend:'herdr',workspace:'fixture-workspace',room:'fixture-pane',cwd:common.cwd,revision:2,active:'codex',operationId:'fixture-switch',bindings:{codex:source,claude:existing}};
 const order:string[]=[],starts:any[]=[];let exitFails=false;
 const from:any={inspect:async()=>({identity:sourceIdentity,generation:3,binding:sourceEntry,idle:true,pendingApproval:false}),close:async()=>{order.push('source-exit');if(exitFails)throw Error('fixture exit unverified');}};
 const to:any={startWithContext:async(input:any)=>{starts.push(input);order.push('target-start');return {source:'live',identity:targetIdentity,generation:8,firstTurn:{operationId:'fixture-switch:context',nativeId:targetId,turnId:'00000000-0000-4000-8000-000000000003',state:'completed',text:'synthetic final'}};}};
 let registered=from;
 const candidate:any={version:3,tool:'claude',cwd:common.cwd,model:common.model,route:'direct',binding:targetEntry,session:{mode:'resume',id:targetId},pilotPolicy:targetEntry.pilotPolicy,policyArgvHash:targetEntry.policyArgvHash,finalArgvHash:'c'.repeat(64)};
 const ports:ProtocolAdapterPorts={runtime:()=>registered,install:(_id,r)=>{registered=r;order.push('install');},create:()=>to,preflight:async()=>({ready:true}),candidate:async()=>candidate,history:async()=>[],verifyContext:async(_room,binding,context)=>{order.push('verify-context');return {state:'acknowledged',nativeId:binding.nativeId,hash:context.hash,throughSeq:context.throughSeq};},timeoutMs:1000};
 return {room,sourceEntry,targetEntry,sourceIdentity,targetIdentity,candidate,ports,starts,order,existing,adapter:new ProtocolContinuityAdapter(ports),exitFail:()=>{exitFails=true;}};
}
const delivery={id:'fixture-switch',text:'Synthetic context reference',hash:'d'.repeat(64),throughSeq:9};
test('Codex to existing Claude retains exact UUID/V3 policy and resumes only after owned source exit',async()=>{
 const h=identityFixture(),result=await h.adapter.launchWithContext(h.room,'claude',delivery,h.existing,'fixture-model');
 expect(h.order).toEqual(['source-exit','install','target-start','verify-context']);expect(h.starts).toHaveLength(1);
 expect(h.starts[0].candidate.version).toBe(3);expect(h.starts[0].candidate.session).toEqual({mode:'resume',id:targetId});expect(h.starts[0].candidate.binding).toEqual(h.targetEntry);
 expect(h.starts[0].candidate.pilotPolicy).toEqual({kind:'claude-context-only-safe',version:1});expect(result.binding.nativeId).toBe(targetId);expect(result.binding.generation.split(':')[2]).toBe(h.existing.generation.split(':')[2]);expect(result.binding.cursor).toBe(4);
});
for(const kind of ['fresh-fallback','wrong-uuid','wrong-agent','wrong-cwd','wrong-model'])test(`one-way target ${kind} rejects before source exit or target start`,async()=>{
 const h=identityFixture();if(kind==='fresh-fallback')h.candidate.session={mode:'fresh'};if(kind==='wrong-uuid')h.candidate.session={mode:'resume',id:sourceId};if(kind==='wrong-agent')h.candidate.tool='codex';if(kind==='wrong-cwd')h.candidate.cwd='/fixture/foreign';if(kind==='wrong-model')h.candidate.model='other-model';
 await expect(h.adapter.launchWithContext(h.room,'claude',delivery,h.existing,'fixture-model')).rejects.toMatchObject({code:'protocol_candidate_scope_mismatch'});expect(h.order).toEqual([]);expect(h.starts).toHaveLength(0);
});
for(const field of ['home','effectiveToolHome','homeEnvironment','provider','endpoint','pilotPolicy','policyArgvHash'])test(`exact Claude UUID with foreign ${field} cannot resume in the old namespace`,async()=>{
 const h=identityFixture();if(field==='homeEnvironment')h.targetEntry[field]={state:'present',value:h.targetEntry.effectiveToolHome};else if(field==='pilotPolicy')h.targetEntry[field]={kind:'foreign-policy',version:1};else h.targetEntry[field]=field==='home'||field==='effectiveToolHome'?'/fixture/foreign/'+field:'foreign-'+field;
 await expect(h.adapter.launchWithContext(h.room,'claude',delivery,h.existing,'fixture-model')).rejects.toMatchObject({code:'protocol_resume_namespace_mismatch'});expect(h.order).toEqual([]);expect(h.starts).toHaveLength(0);
});
test('unverified source exit cannot install or start a Claude target',async()=>{
 const h=identityFixture();h.exitFail();await expect(h.adapter.launchWithContext(h.room,'claude',delivery,h.existing,'fixture-model')).rejects.toThrow('fixture exit unverified');expect(h.order).toEqual(['source-exit']);expect(h.starts).toHaveLength(0);
});
test('fresh Claude path remains explicitly fresh while preserving the reviewed V3 policy',async()=>{
 const h=identityFixture();delete h.room.bindings.claude;h.candidate.session={mode:'fresh'};h.targetEntry.sessionId=null;
 const result=await h.adapter.launchWithContext(h.room,'claude',delivery,undefined,'fixture-model');expect(h.starts[0].candidate.session.mode).toBe('fresh');expect(h.starts[0].candidate.version).toBe(3);expect(result.binding.nativeId).toBe(targetId);expect(result.binding.cursor).toBe(0);
});
test('production profile fingerprints preserve full V3 pins but do not replace the separate exact UUID guard',()=>{
 const h=identityFixture(),original=protocolAcceptanceProfile(h.targetEntry);
 expect(protocolAcceptanceProfile({...h.targetEntry,sessionId:sourceId})).toEqual(original);
 expect(protocolAcceptanceProfile({...h.targetEntry,homeEnvironment:{state:'present',value:h.targetEntry.effectiveToolHome}}).hash).not.toBe(original.hash);
 expect(protocolAcceptanceProfile({...h.targetEntry,nativeSha256:'e'.repeat(64)}).hash).not.toBe(original.hash);
 expect(protocolAcceptanceProfile({...h.targetEntry,policyArgvHash:'f'.repeat(64)}).hash).not.toBe(original.hash);
});

function policyFixture(){
 const h=identityFixture();const {id,backend,workspace,room,cwd}=h.room;
 const policy=validateOneWayProductionPolicy({source:'trusted-one-way-production-policy',reference:'synthetic-policy-unit-not-live-proof',evidence:{runId:'synthetic-unit-not-native-proof',from:'codex',to:'claude'},rooms:[{room:{id,backend,workspace,room,cwd},source:protocolAcceptanceProfile(h.sourceEntry),target:protocolAcceptanceProfile(h.targetEntry)}]});return {...h,policy};
}
test('trusted one-way policy scope matches exact room aliases and preserves both full profile fingerprints',()=>{
 const h=policyFixture(),row=oneWayRoom(h.policy,h.room)!;expect(row.source).toEqual(protocolAcceptanceProfile(h.sourceEntry));expect(row.target).toEqual(protocolAcceptanceProfile(h.targetEntry));expect(oneWayBindingMatches(row.source,h.room.bindings.codex)).toBe(true);expect(oneWayBindingMatches(row.target,h.existing)).toBe(true);
});
for(const field of ['id','backend','workspace','room','cwd'] as const)test(`same production backend cannot grant a foreign room ${field}`,()=>{
 const h=policyFixture(),other={...h.room,[field]:field==='backend'?'tmux':'foreign-'+field};expect(oneWayRoom(h.policy,other as Room)).toBeUndefined();
});
for(const field of ['agent','model','route','generation'] as const)test(`source binding with foreign ${field} cannot satisfy the one-way policy`,()=>{
 const h=policyFixture(),source={...h.room.bindings.codex!};if(field==='agent')source.agent='claude';if(field==='model')source.model='other-model';if(field==='route')source.route='mind';if(field==='generation')source.generation=source.generation.replace(/:[a-f0-9]{64}:/,':'+ '0'.repeat(64)+':');expect(oneWayBindingMatches(h.policy.rooms[0].source,source)).toBe(false);
});
test('reverse source does not satisfy the Codex-only source profile even when the room/backend is identical',()=>{
 const h=policyFixture();const reverseRoom:Room={...h.room,active:'claude'};expect(oneWayRoom(h.policy,reverseRoom)).toBeDefined();expect(oneWayBindingMatches(h.policy.rooms[0].source,h.existing)).toBe(false);
});
test('evidence/permit/browser-shaped objects do not become production direction authority',()=>{
 for(const value of [null,{ready:true},{source:'trusted-live-continuity-evidence',scope:'room-backend',backends:[],models:[]},{source:'trusted-bounded-acceptance',permitId:'unit'}, {...policyFixture().policy,enabled:true}])expect(()=>validateOneWayProductionPolicy(value)).toThrow('production_policy_unverified');
});
test('foreign target agent, mismatched direction, duplicate scope and missing run reference reject policy validation',()=>{
 for(const kind of ['target','direction','duplicate','missing-run']){const h=policyFixture(),p:any=structuredClone(h.policy);if(kind==='target')p.rooms[0].target.agent='codex';if(kind==='direction')p.evidence.to='codex';if(kind==='duplicate')p.rooms.push(structuredClone(p.rooms[0]));if(kind==='missing-run')delete p.evidence.runId;expect(()=>validateOneWayProductionPolicy(p)).toThrow('production_policy_unverified');}
});

const compositionRoots:string[]=[],compositions:Extract<ReturnType<typeof loadProtocolHostComposition>,{kind:'configured'}>[]=[];
afterEach(async()=>{for(const c of compositions.splice(0))await c.close().catch(()=>{});for(const r of compositionRoots.splice(0))rmSync(r,{recursive:true,force:true});});
function productionComposition(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'one-way-identity-')));compositionRoots.push(root);const modules=join(root,'modules');mkdirSync(modules);mkdirSync(join(root,'.codex'));mkdirSync(join(root,'.claude'));const binary=join(root,'fixture-native-never-executed');writeFileSync(binary,'Synthetic native binary pin; DI never executes this file.',{mode:0o700});
 const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
 // Reviewed-builder stand-in only. Real composition/service/runtime/lease/engine/facts paths run; process and model I/O are DI.
 const builder=`const crypto=require('node:crypto');const sha=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v}function build(i){const tool=i.kind==='codex-app-server-stdio'?'codex':'claude',args=tool==='codex'?['app-server']:['-p',...(i.session.mode==='resume'?['--resume',i.session.id]:[]),'--safe-mode','--tools',''];const policy=i.version===3?{pilotPolicy:i.pilotPolicy,policyArgvHash:sha(['--safe-mode','--tools',''])}:{};return freeze({version:i.version,tool,model:i.model,route:i.route,cwd:i.context.cwd,binary:i.native.binary,args,env:{HOME:i.context.home},session:i.session,eligibility:{candidateOnly:true,liveEligible:false},...policy,...(i.version===3?{finalArgvHash:sha(args)}:{}),binding:{version:i.version,kind:i.kind,route:i.route,model:i.model,provider:tool==='codex'?'openai':'anthropic',endpoint:tool==='codex'?null:'https://api.anthropic.com',home:i.context.home,effectiveToolHome:i.context.effectiveToolHome,homeEnvironment:i.context.homeEnvironment,cwd:i.context.cwd,nativeBinary:i.native.binary,nativeSha256:i.native.sha256,nativeVersion:i.native.version,sessionId:i.session.mode==='resume'?i.session.id:null,...policy}})}module.exports={buildProtocolLaunchV2:build,buildProtocolPilotLaunch:build};`;
 const sources={'local-entry.js':'module.exports={};','protocol-entry.js':'module.exports={};','protocol-entry-v2.js':builder,'protocol-entry-pilot.js':builder},hashes:any={};for(const [name,code]of Object.entries(sources)){writeFileSync(join(modules,name),code);hashes[name]=hash(code);}
 const profiles=(['codex','claude'] as const).map(agent=>{const version=agent==='codex'?2 as const:3 as const,nativeVersion=agent==='codex'?'0.164.0':'2.1.220';return {agent,version,model:'fixture-model',route:'direct' as const,provider:agent==='codex'?'openai':'anthropic',endpoint:agent==='codex'?null:'https://api.anthropic.com',home:root,effectiveToolHome:join(root,agent==='codex'?'.codex':'.claude'),homeEnvironment:{state:'absent' as const},native:{binary,sha256:hash(readFileSync(binary)),version:nativeVersion,versionEvidence:{version:nativeVersion,sha256:hash(readFileSync(binary))}}};});
 const scope={id:'one-way-room',backend:'herdr' as const,workspace:'fixture-workspace',room:'fixture-pane',cwd:root,profiles};const {profiles:_profiles,...roomScope}=scope;
 const config:ProtocolHostConfig={version:1,activation:{kind:'host-owned-protocol',mode:'production',policy:'codex-to-claude-v1'},privateRoot:join(root,'private'),modulePin:{directory:modules,hashes},actorId:'unit-host-not-live',timeoutMs:1000,scopes:[scope]};
 let policy:any={source:'trusted-one-way-production-policy',reference:'unit-authority-not-live-proof',evidence:{runId:'unit-not-native-proof',from:'codex',to:'claude'},rooms:[{room:roomScope,source:protocolHostAcceptanceProfile(scope,profiles[0]),target:protocolHostAcceptanceProfile(scope,profiles[1])}]};let hook:(()=>Promise<void>)|undefined,inspectHook:(()=>Promise<void>)|undefined;
 const effects:string[]=[],rows=new Map<string,any[]>();let app:Extract<ReturnType<typeof loadProtocolHostComposition>,{kind:'configured'}>;
 const authority:ProtocolHostAuthority={productionPolicy:async()=>{await hook?.();return structuredClone(policy);},liveEvidence:async()=>{throw Error('Unit policy must not be promoted into native live evidence.');},
  attestNative:async r=>{if(r.phase==='inspect')await inspectHook?.();return {source:'trusted-native-host-attestation',reference:'unit-host-attestation-not-live-proof',roomId:r.roomId,launchOperationId:r.launchOperationId,operationId:r.operationId,binding:structuredClone(r.binding),launchReceipt:r.launchReceipt,externalWriter:'absent',checks:{nativePin:'verified',effectivePolicy:'verified',startup:'reviewed',route:'verified'}};},
  readHistory:async({room,binding})=>({source:'trusted-full-native-history',reference:'synthetic-full-native-records',roomId:room.id,binding,cwd:room.cwd,completeness:'bounded-from-start',records:parseNativeRecords(binding.agent,binding.nativeId,(rows.get(binding.nativeId)??[]).map(v=>JSON.stringify(v)).join('\n')+'\n')}),
  verifyContext:async(_room,binding,context,start)=>{expect(start.firstTurn?.nativeId).toBe(binding.nativeId);return {state:'acknowledged',nativeId:binding.nativeId,hash:context.hash,throughSeq:context.throughSeq};}};
 const mechanisms:ProtocolHostMechanisms={supervisor:options=>({launch:async(c:any,p)=>{await options.preflight(c,p);effects.push('launch:'+c.tool);let alive=true;return {...p,runtimeBirth:'unit-'+p.launchId,wire:{messages:{async *[Symbol.asyncIterator](){}},send:async()=>{effects.push('wire:'+c.tool);},close:async()=>{}},assertRunning:async()=>{if(!alive)throw Error('unit exit');},cleanup:async()=>{effects.push('exit:'+c.tool);alive=false;},observeExit:async e=>({...e,source:'owned-process-supervisor',exit:{code:0,signal:null},inputClosed:true,outputClosed:true,pendingWork:false}),diagnostics:()=>({stderrBytes:0,stderrTruncated:false,stderr:''})};}}),
  driver:(c,wire)=>{const sid=c.session.mode==='resume'?c.session.id:c.tool==='codex'?sourceId:targetId,identity={agent:c.tool,nativeId:sid,model:c.model,cwd:c.cwd,home:root,route:c.route};let ready=false,observation:any;
   const turn=async(op:string,text:string)=>{effects.push('turn:'+c.tool);await wire.send({method:'unit-turn'});const uid=randomUUID(),aid=randomUUID(),tid=randomUUID(),history=rows.get(sid)??[];
    if(c.tool==='codex'){if(!history.length)history.push({type:'session_meta',payload:{id:sid,session_id:sid,cwd:root}});history.push({type:'event_msg',payload:{type:'task_started',turn_id:tid}},{type:'response_item',payload:{type:'message',id:uid,role:'user',content:[{type:'input_text',text}]}},{type:'response_item',payload:{type:'message',id:aid,role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Synthetic final'}]}},{type:'event_msg',payload:{type:'task_complete',turn_id:tid}});}else history.push({type:'user',uuid:uid,parentUuid:history.at(-1)?.uuid??null,sessionId:sid,cwd:root,message:{role:'user',content:text}},{type:'assistant',uuid:aid,parentUuid:uid,sessionId:sid,cwd:root,message:{role:'assistant',model:c.model,content:[{type:'text',text:'Synthetic final'}],stop_reason:'end_turn'}});
    rows.set(sid,history);observation={agent:c.tool,nativeId:sid,model:c.model,cwd:root};ready=true;return {operationId:op,nativeId:sid,turnId:c.tool==='claude'?uid:tid,text:'Synthetic final',state:'completed' as const};};
   const d:StagedNativeProtocolSession={get idle(){return ready;},pendingApproval:false,get nativeObservation(){return observation;},open:async()=>{await wire.send({method:'unit-open'});observation={agent:c.tool,nativeId:sid,model:c.model,cwd:root};ready=true;return identity;},prepare:async()=>{await wire.send({method:'unit-initialize'});},startTurn:async(op,text)=>({identity,turn:await turn(op,text)}),turn,close:async()=>{ready=false;await wire.close();}};return d;
  }};
 const create=()=>{const value=loadProtocolHostComposition(config,authority,mechanisms);if(value.kind!=='configured')throw Error('unit configured composition expected');app=value;compositions.push(app);return app;};
 const boot=()=>app.bootstrapOwned({scopeId:scope.id,operationId:'unit-bootstrap',agent:'codex',firstTurn:{operationId:'unit-initial-facts',text:JSON.stringify({kind:'continuity-facts',version:1,facts:{goal:'Synthetic one-way regression',constraints:[],decisions:[],pendingTasks:[],fileState:[],checks:[]}})}});
 const approve=async(room:Room,op='unit-switch')=>{const preview=await app.service.factsUI.preview(room);await app.service.factsUI.approve(room,{id:op,previewId:preview.id,expectedRevision:room.revision,selections:preview.candidates.map(({value,...p})=>p)});return preview;};
 return {config,authority,mechanisms,create,boot,approve,effects,scope,get app(){return app;},get currentPolicy(){return policy;},setPolicy:(p:any)=>{policy=p;},hook:(h?:()=>Promise<void>)=>{hook=h;},inspectHook:(h?:()=>Promise<void>)=>{inspectHook=h;}};
}

test('actual production composition performs one-way Codex to V3 Claude and denies reverse before process effects',async()=>{
 const h=productionComposition(),app=h.create(),boot=await h.boot();await h.approve(boot.room);
 const op=await app.service.engine.request(boot.room.id,{id:'unit-switch',target:'claude',model:'fixture-model',expectedRevision:boot.room.revision,factsSelectionId:'unit-switch'});const result=await app.service.engine.advance(op.id);
 expect(result.state).toBe('ready-awaiting-user');const room=app.service.store.room(boot.room.id)!;expect(room.active).toBe('claude');expect(room.bindings.claude?.nativeId).toBe(targetId);
 expect(h.effects.indexOf('exit:codex')).toBeLessThan(h.effects.indexOf('launch:claude'));const caps:any=await app.featureOptions.capabilities();expect(caps.authorization?.purpose).toBe('production');expect(caps.switchDirections?.find((d:any)=>d.from==='claude')?.state).toBe('development');
 const before=h.effects.slice();const reverse=await app.service.engine.request(room.id,{id:'unit-reverse',target:'codex',expectedRevision:room.revision});
 let code:string|undefined;try{const state=await app.service.engine.advance(reverse.id);code=state.reason;}catch(e){code=(e as any).code;}
 expect(code).toBe('switch_direction_in_development');expect(h.effects).toEqual(before);
});
test('explicit production config cannot enable V3 without a trusted policy callback',()=>{
 const h=productionComposition();delete h.authority.productionPolicy;expect(()=>h.create()).toThrow('production_policy_unverified');expect(h.effects).toEqual([]);
});
for(const kind of ['null','throw','foreign-room','foreign-source-profile'])test(`production ${kind} authority cannot bootstrap a native child`,async()=>{
 const h=productionComposition();if(kind==='null')h.setPolicy(null);if(kind==='throw')h.hook(async()=>{throw Error('unit private authority failure');});if(kind==='foreign-room')h.currentPolicy.rooms[0].room.workspace='other-workspace';if(kind==='foreign-source-profile')h.currentPolicy.rooms[0].source.hash='0'.repeat(64);
 h.create();await expect(h.boot()).rejects.toBeDefined();expect(h.effects).not.toContain('launch:codex');expect(h.effects).not.toContain('launch:claude');
});
test('target full fingerprint drift is denied without exiting the verified Codex source',async()=>{
 const h=productionComposition(),app=h.create(),boot=await h.boot();await h.approve(boot.room);h.currentPolicy.rooms[0].target.hash='0'.repeat(64);const before=h.effects.slice();
 const op=await app.service.engine.request(boot.room.id,{id:'unit-switch',target:'claude',model:'fixture-model',expectedRevision:boot.room.revision,factsSelectionId:'unit-switch'});
 await app.service.engine.advance(op.id).catch(()=>{});expect(h.effects).toEqual(before);expect(h.effects).not.toContain('launch:claude');
});
test('production policy revocation during the final awaited source inspection prevents source exit and Claude launch',async()=>{
 const h=productionComposition(),app=h.create(),boot=await h.boot();await h.approve(boot.room);let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
 h.inspectHook(async()=>{if(app.service.store.latestOperation(boot.room.id)?.state==='delivering-context'){enter();await gate;}});
 const op=await app.service.engine.request(boot.room.id,{id:'unit-switch',target:'claude',model:'fixture-model',expectedRevision:boot.room.revision,factsSelectionId:'unit-switch'}),before=h.effects.slice(),running=app.service.engine.advance(op.id);
 await entered;h.setPolicy(null);release();const result=await running;expect(result.state).toBe('uncertain');expect(h.effects).toEqual(before);expect(h.effects).not.toContain('exit:codex');expect(h.effects).not.toContain('launch:claude');
});

test('explicit production startup returns actual per-instance mobile transport only after synchronized owned bootstrap',async()=>{
 const h=productionComposition();const prepared=await prepareOneWayServerHost({config:h.config,authority:h.authority,bootstrap:[{scopeId:h.scope.id,operationId:'startup-boot',agent:'codex',firstTurn:{operationId:'startup-user',text:'Synthetic startup context'}}]},h.mechanisms);
 try{expect(prepared.receipts).toHaveLength(1);const room=prepared.receipts[0].room;expect(room.bindings.codex?.nativeId).toBe(sourceId);expect(await prepared.mobile.continuity.resolveRoom(room.workspace,room.room)).toEqual(room);expect(Object.hasOwn(prepared.mobile.continuity,'resolveChannel')).toBe(false);
  const status=await prepared.mobile.continuity.owned!.status(room);expect(status.kind).toBe('owned-protocol');expect(status.state).toBe('idle');expect(status.capabilities.textTurn).toBe(true);expect(prepared.mobile.continuity.engine.store.events(room.id)).toHaveLength(2);
 }finally{await prepared.close();}
});
test('startup refuses implicit resume, non-Codex adoption and missing first-context authority before effects',async()=>{
 for(const kind of ['resume','target-agent','no-context']){const h=productionComposition(),input:any={config:h.config,authority:h.authority,bootstrap:[{scopeId:h.scope.id,operationId:'startup',agent:'codex',firstTurn:{operationId:'startup-user',text:'Synthetic authorized context'}}]};if(kind==='resume')input.bootstrap[0].resume={binding:identityFixture().room.bindings.codex};if(kind==='target-agent')input.bootstrap[0].agent='claude';if(kind==='no-context')delete input.bootstrap[0].firstTurn;await expect(prepareOneWayServerHost(input,h.mechanisms)).rejects.toThrow('production_startup_unverified');expect(h.effects).toEqual([]);}
});
