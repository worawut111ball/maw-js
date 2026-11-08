/** Host-only composition. Import never reads config, loads builders or starts a native process. */
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {PinnedProtocolEntryLoader,type PinnedProtocolModule} from './entry-loader';
import {ProtocolProcessSupervisor,type ProcessSupervisorOptions,type OwnedProtocolProcess,type ProcessLaunchPermit} from './process-supervisor';
import {createProtocolContinuityService,type ProtocolContinuityService,type ProtocolLiveEvidence,type ProtocolBootstrapReceipt} from './service';
import {protocolRuntimeDriver,type ProtocolRuntimeCandidate,type ProtocolRuntimeBinding,type HomeEnvironment} from './entry';
import {readProtocolNativeHistory} from './native-history-reader';
import {protocolNamespace} from './adapter';
import type {RuntimeAdmissionRequest,RuntimeLaunchReceipt,RuntimeHostOptions} from './runtime-host';
import type {NativeProtocolSession,StagedNativeProtocolSession,ProtocolHooks} from './types';
import type {NativeRecords} from '../native-records';
import {factsBindingHash} from '../facts-resolver';
import {ContinuityError,type Room,type Binding,type AgentKind,type RoomEvent,type ContextDelivery,type DeliveryReceipt} from '../types';
import type {ContinuityFeatureOptions} from '../../features/continuity';

export interface ProtocolHostProfile {
  agent:AgentKind;version:2|3;model:string;route:'mind'|'direct';provider:string;endpoint:string|null;
  home:string;effectiveToolHome:string;homeEnvironment:HomeEnvironment;
  native:{binary:string;sha256:string;version:string;versionEvidence:{version:string;sha256:string}};
}
export interface ProtocolHostScope {
  id:string;backend:Room['backend'];workspace:string;room:string;cwd:string;profiles:ProtocolHostProfile[];
}
export interface ProtocolHostConfig {
  version:1;activation?:{kind:'host-owned-protocol';mode:'disabled'|'pilot'|'production'};
  modulePin?:PinnedProtocolModule;privateRoot?:string;actorId?:string;timeoutMs?:number;
  scopes?:ProtocolHostScope[];maxContextBytes?:number;
}
export interface ProtocolNativeAttestationRequest {
  scope:Readonly<ProtocolHostScope>;profile:Readonly<ProtocolHostProfile>;
  roomId:string;launchOperationId:string;operationId:string;phase:string;
  binding:Readonly<ProtocolRuntimeBinding>;selection:ProtocolRuntimeCandidate['session'];
  launchReceipt?:Readonly<RuntimeLaunchReceipt>;textHash?:string;permit?:Readonly<ProcessLaunchPermit>;
}
export interface ProtocolNativeAttestation {
  source:'trusted-native-host-attestation';reference:string;
  roomId:string;launchOperationId:string;operationId:string;
  binding:ProtocolRuntimeBinding;launchReceipt?:Readonly<RuntimeLaunchReceipt>;externalWriter:'absent'|'unknown'|'external-tui';
  checks:{nativePin:'verified'|'unknown';effectivePolicy:'verified'|'unknown';startup:'reviewed'|'unknown';route:'verified'|'unknown'};
}
export interface ProtocolHistoryAttestation {
  source:'trusted-full-native-history';reference:string;roomId:string;binding:Binding;cwd:string;
  completeness:'bounded-from-start';records:NativeRecords;
}
export interface ProtocolHostAuthority {
  attestNative?(request:Readonly<ProtocolNativeAttestationRequest>):Promise<ProtocolNativeAttestation>;
  connection?(profile:Readonly<ProtocolHostProfile>):Promise<{baseUrl:string;token:string}>;
  resumeBinding?(request:{scope:ProtocolHostScope;profile:ProtocolHostProfile;binding:Binding}):Promise<ProtocolRuntimeBinding>;
  readHistory?(request:{room:Room;binding:Binding}):Promise<ProtocolHistoryAttestation>;
  verifyContext?(room:Room,binding:Binding,context:ContextDelivery,start:ProtocolBootstrapReceipt['start']):Promise<DeliveryReceipt>;
  liveEvidence?():Promise<ProtocolLiveEvidence|null>;
  hooks?:ProtocolHooks;
}
export interface ProtocolHostMechanisms {
  /** Constructor DI for tests/trusted hosts; never selected through config/HTTP. */
  supervisor?(options:ProcessSupervisorOptions):Pick<ProtocolProcessSupervisor,'launch'>;
  driver?:NonNullable<RuntimeHostOptions['driverFactory']>;
}
export interface ProtocolHostBootstrap {
  scopeId:string;operationId:string;agent:AgentKind;model?:string;
  resume?:{binding:Binding};firstTurn?:{operationId:string;text:string};
}
export type ProtocolHostComposition={kind:'disabled';featureOptions:undefined;close():Promise<void>}|{
  kind:'configured';service:ProtocolContinuityService;featureOptions:ContinuityFeatureOptions;
  bootstrapOwned(input:ProtocolHostBootstrap):Promise<ProtocolBootstrapReceipt>;close():Promise<void>;
};
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.trim()===v&&v.length<=256&&!/[\x00-\x1f]/.test(v);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function fail(code:string):never{throw new ContinuityError(code);}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function keys(v:unknown,allowed:string[]):v is Record<string,any>{return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>allowed.includes(k))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&'value'in Object.getOwnPropertyDescriptor(v,k)!);}
/** Explicit pinned private host JSON only; never called from a route or ambient environment. */
export function readProtocolHostConfig(pin:{path:string;sha256:string}):ProtocolHostConfig {
  try{
    if(!pin||!isAbsolute(pin.path)||realpathSync(pin.path)!==pin.path||!/^[a-f0-9]{64}$/.test(pin.sha256))fail('protocol_host_config_unverified');
    const fd=openSync(pin.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const before=fstatSync(fd);if(!before.isFile()||(before.mode&0o077)!==0||before.size>256*1024)fail('protocol_host_config_unverified');
      const bytes=readFileSync(fd),after=fstatSync(fd);
      if(bytes.length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||sha(bytes)!==pin.sha256)fail('protocol_host_config_unverified');
      const config=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));validateConfig(config);return freeze(config);
    }finally{closeSync(fd);}
  }catch{return fail('protocol_host_config_unverified');}
}
function validateConfig(c:ProtocolHostConfig):void {
  if(!keys(c,['version','activation','modulePin','privateRoot','actorId','timeoutMs','scopes','maxContextBytes'])||c.version!==1)fail('protocol_host_config_invalid');
  if(c.activation!==undefined&&(!keys(c.activation,['kind','mode'])||c.activation.kind!=='host-owned-protocol'||!['disabled','pilot','production'].includes(c.activation.mode)))fail('protocol_host_config_invalid');
  if(!c.activation||c.activation.mode==='disabled')return;
  if(!c.modulePin||!id(c.privateRoot)||!isAbsolute(c.privateRoot)||!id(c.actorId)||!Number.isInteger(c.timeoutMs)||c.timeoutMs!<1||c.timeoutMs!>300_000||!Array.isArray(c.scopes)||!c.scopes.length||c.scopes.length>1000)fail('protocol_host_config_invalid');
  const ids=new Set<string>(),aliases=new Set<string>();
  for(const s of c.scopes){
    if(!keys(s,['id','backend','workspace','room','cwd','profiles'])||![s.id,s.workspace,s.room,s.cwd].every(id)||!isAbsolute(s.cwd)||!['herdr','tmux','superset'].includes(s.backend)||ids.has(s.id)||aliases.has(canonical([s.workspace,s.room]))||!Array.isArray(s.profiles)||!s.profiles.length||s.profiles.length>32)fail('protocol_host_scope_invalid');
    ids.add(s.id);aliases.add(canonical([s.workspace,s.room]));const models=new Set<string>();
    for(const p of s.profiles){
      if(!keys(p,['agent','version','model','route','provider','endpoint','home','effectiveToolHome','homeEnvironment','native'])||!['codex','claude'].includes(p.agent)||![2,3].includes(p.version)||p.version===3&&(p.agent!=='claude'||c.activation.mode!=='pilot')
        ||![p.model,p.provider,p.home,p.effectiveToolHome].every(id)||!['mind','direct'].includes(p.route)||p.endpoint!==null&&typeof p.endpoint!=='string'||!isAbsolute(p.home)||!isAbsolute(p.effectiveToolHome)
        ||!keys(p.homeEnvironment,['state','value'])||!['absent','present'].includes(p.homeEnvironment.state)||p.homeEnvironment.state==='absent'&&Object.hasOwn(p.homeEnvironment,'value')||p.homeEnvironment.state==='present'&&p.homeEnvironment.value!==p.effectiveToolHome
        ||!keys(p.native,['binary','sha256','version','versionEvidence'])||!id(p.native.binary)||!isAbsolute(p.native.binary)||!/^[a-f0-9]{64}$/.test(p.native.sha256)||!id(p.native.version)
        ||!keys(p.native.versionEvidence,['version','sha256'])||p.native.versionEvidence.version!==p.native.version||p.native.versionEvidence.sha256!==p.native.sha256||models.has(canonical([p.agent,p.model])))fail('protocol_host_profile_invalid');
      models.add(canonical([p.agent,p.model]));
    }
  }
}

/** Strict public projection: exact native turn identity plus persisted host pair proof, never text-only dedup. */
export function normalizeProtocolNativeHistory(room:Room,binding:Binding,records:NativeRecords,persisted:RoomEvent[]):Omit<RoomEvent,'seq'>[] {
  if(!records||records.nativeId!==binding.nativeId||records.cwd!==room.cwd||!records.turnComplete||records.pendingTools||records.refused||records.interrupted||!Array.isArray(records.events)||records.events.length>50_000||!Array.isArray(records.assistantMessages))fail('protocol_history_unverified');
  const existing=persisted.filter(e=>e.agent===binding.agent&&e.nativeId===binding.nativeId),byId=new Map(records.events.map(e=>[e.sourceId,e]));
  const aliases=new Map<string,Omit<RoomEvent,'seq'>>(),covered=new Set<string>();
  const positions=new Map(records.events.map((e,i)=>[e.sourceId,i])),answersByTurn=new Map<string,NativeRecords['assistantMessages']>();
  for(const answer of records.assistantMessages){if(!answer.final)continue;const key=binding.agent==='claude'?answer.replyToSourceId:answer.turnId;if(key){const group=answersByTurn.get(key)??[];group.push(answer);answersByTurn.set(key,group);}}
  const strip=(e:RoomEvent):Omit<RoomEvent,'seq'>=>{const {seq,...rest}=e;return structuredClone(rest);};
  for(let i=0;i<existing.length;i++){
    const user=existing[i];if(user.metadata?.provenance!=='host-authorized-user')continue;
    const final=existing[i+1],m=user.metadata;
    if(!id(m.operationId)||typeof m.turnId!=='string'||!uuid.test(m.turnId)||typeof m.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(m.requestHash)||!final||final.role!=='assistant'||final.metadata?.provenance!=='native-protocol-final'
      ||['operationId','turnId','generation','requestHash'].some(k=>final.metadata![k]!==m[k])||user.sourceId!=='protocol-turn:'+sha(canonical([room.id,m.operationId]))+':user'||final.sourceId!=='protocol-turn:'+sha(canonical([room.id,m.operationId]))+':assistant')fail('protocol_history_pair_unverified');
    const answers=answersByTurn.get(binding.agent==='claude'?`claude:${binding.nativeId}:message:${m.turnId}`:m.turnId)??[];
    if(answers.length!==1)fail('protocol_history_turn_unverified');
    const answer=answers[0],nativeUser=byId.get(answer.replyToSourceId),nativeFinal=byId.get(answer.sourceId);
    if(!nativeUser||nativeUser.role!=='user'||!nativeFinal||nativeFinal.role!=='assistant'||nativeUser.index!==answer.replyToIndex||nativeFinal.index!==answer.index||nativeUser.index>=nativeFinal.index||nativeUser.text!==user.text||nativeFinal.text!==final.text||answer.text!==final.text||nativeFinal.metadata?.replyToSourceId!==nativeUser.sourceId||nativeFinal.metadata?.replyToIndex!==nativeUser.index||nativeFinal.metadata?.final!==true||final.seq!==user.seq+1)fail('protocol_history_turn_unverified');
    if(positions.get(nativeFinal.sourceId)!==positions.get(nativeUser.sourceId)!+1)fail('protocol_history_intermediate_events_require_projection');
    if(covered.has(nativeUser.sourceId)||covered.has(nativeFinal.sourceId))fail('protocol_history_turn_conflict');
    covered.add(nativeUser.sourceId);covered.add(nativeFinal.sourceId);aliases.set(nativeUser.sourceId,strip(user));aliases.set(nativeFinal.sourceId,strip(final));i++;
  }
  const seen=new Set<string>();let index=-1,bytes=0;
  const projected=records.events.map(e=>{
    if(!e||typeof e.sourceId!=='string'||!e.sourceId.length||e.sourceId.length>1024||/[\x00-\x1f]/.test(e.sourceId)||seen.has(e.sourceId)||!['user','assistant','tool'].includes(e.role)||!Number.isSafeInteger(e.index)||e.index<index||typeof e.text!=='string'||e.text.includes('\0')||!e.sourceId.startsWith(`${binding.agent}:${binding.nativeId}:`))fail('protocol_history_event_invalid');
    seen.add(e.sourceId);index=e.index;
    const value=aliases.get(e.sourceId)??{sourceId:e.sourceId,agent:binding.agent,nativeId:binding.nativeId,role:e.role,text:e.text,...(e.ts!==undefined?{ts:e.ts}:{}),...(e.metadata!==undefined?{metadata:structuredClone(e.metadata)}:{})};
    bytes+=Buffer.byteLength(canonical(value));if(bytes>64*1024*1024)fail('protocol_history_limit');return value;
  });
  if(existing.length>projected.length||existing.some((e,i)=>canonical(strip(e))!==canonical(projected[i])))fail('protocol_history_order_unverified');
  return projected;
}

type LaunchRecord={scope:ProtocolHostScope;profile:ProtocolHostProfile;candidate:ProtocolRuntimeCandidate;launchOperationId:string;launched:boolean;driver?:NativeProtocolSession;calls:number;driverClosed:boolean};
/** Full loader -> supervisor -> service wiring. All policy inputs are host constructor values. */
export function loadProtocolHostComposition(config?:ProtocolHostConfig,authority:ProtocolHostAuthority={},mechanisms:ProtocolHostMechanisms={}):ProtocolHostComposition {
  if(config===undefined)return {kind:'disabled',featureOptions:undefined,close:async()=>{}};
  validateConfig(config);if(!config.activation||config.activation.mode==='disabled')return {kind:'disabled',featureOptions:undefined,close:async()=>{}};
  const cfg=freeze(structuredClone(config)),ports={attestNative:authority.attestNative?.bind(authority),connection:authority.connection?.bind(authority),resumeBinding:authority.resumeBinding?.bind(authority),readHistory:authority.readHistory?.bind(authority),verifyContext:authority.verifyContext?.bind(authority),liveEvidence:authority.liveEvidence?.bind(authority),hooks:authority.hooks};
  const loader=new PinnedProtocolEntryLoader(cfg.modulePin!),records=new Map<string,Promise<LaunchRecord>>(),candidates=new WeakMap<object,LaunchRecord>();
  const scopeFor=(room:Pick<Room,'id'|'backend'|'workspace'|'room'|'cwd'>)=>{
    const s=cfg.scopes!.find(s=>s.id===room.id);if(!s||['backend','workspace','room','cwd'].some(k=>(s as any)[k]!==(room as any)[k]))fail('protocol_host_scope_unverified');return s;
  };
  const profileFor=(s:ProtocolHostScope,agent:AgentKind,model?:string)=>{const found=s.profiles.filter(p=>p.agent===agent&&(model===undefined||p.model===model));if(found.length!==1)fail('protocol_host_profile_unavailable');return found[0];};
  const recordFor=(scope:ProtocolHostScope,profile:ProtocolHostProfile,operationId:string,existing?:Binding):Promise<LaunchRecord>=>{
    if(!id(operationId))fail('protocol_host_operation_unverified');const key=canonical([scope.id,operationId]);
    const old=records.get(key);if(old)return old.then(r=>{if(canonical(r.profile)!==canonical(profile)||r.candidate.session.mode!==(existing?'resume':'fresh')||existing&&r.candidate.binding.sessionId!==existing.nativeId)fail('protocol_host_launch_conflict');return r;});
    if(records.size>=1024)fail('protocol_host_capacity');
    const building=(async()=>{
      let previous:ProtocolRuntimeBinding|undefined;
      if(existing){if(!ports.resumeBinding)fail('protocol_host_resume_attestation_unavailable');previous=await ports.resumeBinding({scope:structuredClone(scope),profile:structuredClone(profile),binding:structuredClone(existing)});
        if(!previous||previous.version!==profile.version||previous.sessionId!==existing.nativeId||protocolNamespace(previous)!==existing.generation.split(':')[2])fail('protocol_host_resume_binding_unverified');}
      const input={version:profile.version,optIn:true,kind:profile.agent==='codex'?'codex-app-server-stdio':'claude-stream-json',route:profile.route,model:profile.model,native:structuredClone(profile.native),context:{home:profile.home,effectiveToolHome:profile.effectiveToolHome,homeEnvironment:structuredClone(profile.homeEnvironment),cwd:scope.cwd},session:existing?{mode:'resume',id:existing.nativeId}:{mode:'fresh'},...(previous?{resumeBinding:previous}:{}),...(profile.version===3?{pilotPolicy:{kind:'claude-context-only-safe',version:1}}:{}),...(profile.route==='mind'?{connection:await (ports.connection?ports.connection(profile):Promise.reject(new ContinuityError('protocol_host_connection_unavailable')))}:{})};
      const candidate=loader.build(input),b=candidate.binding;
      const expected={version:profile.version,kind:input.kind,route:profile.route,model:profile.model,provider:profile.provider,endpoint:profile.endpoint,home:profile.home,effectiveToolHome:profile.effectiveToolHome,homeEnvironment:profile.homeEnvironment,cwd:scope.cwd,nativeBinary:profile.native.binary,nativeSha256:profile.native.sha256,nativeVersion:profile.native.version,sessionId:existing?.nativeId??null};
      if(Object.keys(expected).some(k=>canonical((b as any)[k])!==canonical((expected as any)[k])))fail('protocol_host_candidate_mismatch');
      const r:LaunchRecord={scope,profile,candidate,launchOperationId:operationId,launched:false,calls:0,driverClosed:false};candidates.set(candidate,r);return r;
    })();records.set(key,building);return building;
  };
  const receipt=(r:LaunchRecord)=>r.candidate.version===3?Object.freeze({finalArgvHash:r.candidate.finalArgvHash}):undefined;
  const attest=async(r:LaunchRecord,phase:string,operationId:string,textHash?:string,permit?:Readonly<ProcessLaunchPermit>)=>{
    if(!ports.attestNative)fail('protocol_host_native_attestation_unavailable');
    const expectedReceipt=receipt(r),e=await ports.attestNative(freeze({scope:structuredClone(r.scope),profile:structuredClone(r.profile),roomId:r.scope.id,launchOperationId:r.launchOperationId,operationId,phase,binding:structuredClone(r.candidate.binding),selection:structuredClone(r.candidate.session),...(expectedReceipt?{launchReceipt:expectedReceipt}:{}),...(textHash?{textHash}:{}),...(permit?{permit:{...permit}}:{})}));
    if(!e||e.source!=='trusted-native-host-attestation'||!id(e.reference)||e.roomId!==r.scope.id||e.launchOperationId!==r.launchOperationId||e.operationId!==operationId||e.externalWriter!=='absent'||canonical(e.binding)!==canonical(r.candidate.binding)||expectedReceipt&&canonical(e.launchReceipt)!==canonical(expectedReceipt)||e.checks?.nativePin!=='verified'||e.checks.effectivePolicy!=='verified'||e.checks.startup!=='reviewed'||e.checks.route!=='verified')fail('protocol_host_native_attestation_unverified');
    return {source:'trusted-protocol-admission' as const,binding:structuredClone(r.candidate.binding),externalWriter:'absent' as const,...(expectedReceipt?{launchReceipt:expectedReceipt}:{})};
  };
  const supervisor={launch:async(candidate:unknown,permit:Readonly<ProcessLaunchPermit>):Promise<OwnedProtocolProcess>=>{
    const r=candidate&&typeof candidate==='object'?candidates.get(candidate):undefined;if(!r||r.launched)fail('protocol_host_candidate_not_owned');r.launched=true;
    const options:ProcessSupervisorOptions={preflight:async selected=>{if(selected!==r.candidate)fail('protocol_host_candidate_not_owned');await attest(r,'process-preflight',r.launchOperationId,undefined,permit);return loader.processSpec(r.candidate);},pendingWork:()=>r.calls>0||!!r.driver?.pendingApproval||!!r.driver&&!r.driverClosed&&!r.driver.idle};
    return (mechanisms.supervisor?.(options)??new ProtocolProcessSupervisor(options)).launch(r.candidate,permit);
  }};
  const driverFactory:NonNullable<RuntimeHostOptions['driverFactory']>=(candidate,wire,timeout,hooks)=>{
    const r=candidates.get(candidate);if(!r||!r.launched||r.driver)fail('protocol_host_driver_not_owned');
    const native:NativeProtocolSession=(mechanisms.driver??protocolRuntimeDriver)(candidate,wire,timeout,hooks);r.driver=native;
    const call=async<T>(fn:()=>Promise<T>)=>{r.calls++;try{return await fn();}finally{r.calls--;}};
    const wrapped:NativeProtocolSession={get idle(){return native.idle;},get pendingApproval(){return native.pendingApproval;},get nativeObservation(){return native.nativeObservation;},open:id=>call(()=>native.open(id)),turn:(id,text)=>call(()=>native.turn(id,text)),close:()=>call(async()=>{await native.close();r.driverClosed=true;})};
    const staged=native as Partial<StagedNativeProtocolSession>;
    if(typeof staged.prepare==='function'&&typeof staged.startTurn==='function')Object.assign(wrapped,{prepare:(id?:string)=>call(()=>staged.prepare!(id)),startTurn:(id:string,text:string)=>call(()=>staged.startTurn!(id,text))});
    return wrapped;
  };
  let service:ProtocolContinuityService;
  const allEvents=(roomId:string)=>{const out:RoomEvent[]=[];let cursor=0;for(let i=0;i<=200;i++){const page=service.store.events(roomId,cursor,500);if(!page.length)return out;out.push(...page);cursor=page.at(-1)!.seq;}return fail('protocol_history_limit');};
  service=createProtocolContinuityService({privateRoot:cfg.privateRoot!,actorId:cfg.actorId!,timeoutMs:cfg.timeoutMs!,maxContextBytes:cfg.maxContextBytes,runtime:{supervisor,driverFactory,hooks:ports.hooks,admit:async(request:RuntimeAdmissionRequest)=>{
    const r=await records.get(canonical([request.roomId,request.launchOperationId]));if(!r||canonical(request.binding)!==canonical(r.candidate.binding)||canonical(request.selection)!==canonical(r.candidate.session)||r.candidate.version===3&&canonical(request.launchReceipt)!==canonical(receipt(r)))fail('protocol_host_launch_unverified');
    return attest(r,request.phase,request.operationId,request.textHash);
  }},host:{
    resolveRoomId:async(ws,room)=>cfg.scopes!.find(s=>s.workspace===ws&&s.room===room)?.id??null,
    candidate:async(room,target,existing,model)=>(await recordFor(scopeFor(room),profileFor(scopeFor(room),target,model),room.operationId??fail('protocol_host_operation_unverified'),existing)).candidate,
    preflight:async(room,target,model)=>{const r=await recordFor(scopeFor(room),profileFor(scopeFor(room),target,model),room.operationId??fail('protocol_host_operation_unverified'),room.bindings[target]);await attest(r,'target-preflight',r.launchOperationId);return {ready:true};},
    history:async(room,binding)=>{
      const scope=scopeFor(room),profile=profileFor(scope,binding.agent,binding.model);
      if(profile.route!==binding.route)fail('protocol_host_history_unverified');
      let proof:ProtocolHistoryAttestation;
      if(ports.readHistory)proof=await ports.readHistory({room:structuredClone(room),binding:structuredClone(binding)});
      else {
        const records=await readProtocolNativeHistory({agent:binding.agent,nativeId:binding.nativeId,effectiveToolHome:profile.effectiveToolHome,cwd:scope.cwd});
        proof={source:'trusted-full-native-history',reference:'native-history-reader:v1',roomId:room.id,binding:structuredClone(binding),cwd:scope.cwd,completeness:'bounded-from-start',records};
      }
      if(!proof||proof.source!=='trusted-full-native-history'||!id(proof.reference)||proof.roomId!==room.id||proof.cwd!==room.cwd||proof.completeness!=='bounded-from-start'||factsBindingHash(proof.binding)!==factsBindingHash(binding))fail('protocol_host_history_unverified');
      return normalizeProtocolNativeHistory(room,binding,proof.records,allEvents(room.id));},
    verifyContext:async(room,binding,context,start)=>{if(!ports.verifyContext)fail('protocol_host_context_verifier_unavailable');const result=await ports.verifyContext(structuredClone(room),structuredClone(binding),structuredClone(context),structuredClone(start));
      if(result?.state!=='acknowledged'||result.nativeId!==binding.nativeId||result.hash!==context.hash||result.throughSeq!==context.throughSeq)fail('protocol_host_context_unverified');return result;},
    liveEvidence:async()=>cfg.activation!.mode==='production'&&ports.attestNative&&ports.verifyContext?(await ports.liveEvidence?.()??null):null,
  }});
  const pending=new Map<string,Promise<void>>(),ready=new Set<string>();
  const sync=async(room:Room)=>{
    scopeFor(room);const key=canonical([room.id,room.revision,room.bindings[room.active]]);if(ready.has(key))return;
    let p=pending.get(key);if(!p){p=(async()=>{await service.snapshot(room);ready.add(key);})().finally(()=>pending.delete(key));pending.set(key,p);}await p;
  };
  const featureOptions:ContinuityFeatureOptions={...service.featureOptions,owned:{...service.owned,
    status:async room=>{const state=await service.owned.status(room);if(state.state==='idle'&&!room.operationId)try{await sync(room);}catch{return {...state,state:'unavailable',capabilities:{textTurn:false,attachments:false,keys:false}};}return state;},
    inventory:async()=>{const rows=await service.owned.inventory();return Promise.all(rows.map(async({room})=>({room,transport:await featureOptions.owned!.status(room)})));},
    turn:async(room,request)=>{const old=await service.owned.turnStatus(room,request.id);if(old)return service.owned.turn(room,request);await service.snapshot(room);return service.owned.turn(room,request);},
  }};
  return {kind:'configured',service,featureOptions,bootstrapOwned:async input=>{
    const scope=cfg.scopes!.find(s=>s.id===input.scopeId);if(!scope)fail('protocol_host_scope_unverified');
    const profile=profileFor(scope,input.agent,input.model),r=await recordFor(scope,profile,input.operationId,input.resume?.binding);
    const result=await service.bootstrapOwned({scope,operationId:input.operationId,candidate:r.candidate,writer:'owned-protocol-child',firstTurn:input.firstTurn});await sync(result.room);return result;
  },close:()=>service.close()};
}
