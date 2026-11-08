/** Runtime orchestration only: trusted DI supervisor owns processes; no spawn or launch defaults here. */
import { createHash } from 'node:crypto';
import { EffectJournal } from '../effect-journal';
import { protocolRuntimePolicy, protocolRuntimeDriver, type ProtocolRuntimeBinding, type ProtocolRuntimeCandidate } from './entry';
import { ProtocolSessionLeases, type SessionLease, type SessionReleaseReceipt } from './session-lease';
import { ProtocolTurnHost, type ProtocolTurnReceipt } from './turn-host';
import type { OwnedProtocolProcess, ProcessLaunchPermit } from './process-supervisor';
import { ProtocolError, type ProtocolHooks, type ProtocolIdentity, type ProtocolPolicy, type ProtocolWire, type NativeProtocolSession, type StagedNativeProtocolSession, type ProtocolTurn } from './types';
export type RuntimeSelection=ProtocolRuntimeCandidate['session'];
export interface RuntimeLaunchReceipt {readonly finalArgvHash:string}
export interface RuntimeAdmissionRequest {
  readonly roomId:string;
  readonly launchOperationId:string;
  readonly launchReceipt?:Readonly<RuntimeLaunchReceipt>;
  binding:Readonly<ProtocolRuntimeBinding>; selection:RuntimeSelection; phase:string;
  operationId:string; textHash?:string;
}
/** Trusted host callback evidence, never an HTTP/native/model-supplied authority object. */
export interface RuntimeAdmission {
  source:'trusted-protocol-admission'; binding:ProtocolRuntimeBinding;
  launchReceipt?:Readonly<RuntimeLaunchReceipt>;
  externalWriter:'absent'|'external-tui'|'unknown';
}
export interface RuntimeSupervisor {
  launch(candidate:unknown,permit:Readonly<ProcessLaunchPermit>):Promise<OwnedProtocolProcess>;
}
export interface RuntimeHostOptions {
  journal:EffectJournal; supervisor:RuntimeSupervisor;
  admit(request:Readonly<RuntimeAdmissionRequest>):Promise<RuntimeAdmission>;
  hooks?:ProtocolHooks;
  /** Test/host DI only, not exposed through user APIs. Defaults to the versioned real native drivers. */
  driverFactory?:(candidate:ProtocolRuntimeCandidate,wire:ProtocolWire,timeoutMs:number,hooks:ProtocolHooks)=>NativeProtocolSession;
}
export interface RuntimeStartRequest {
  roomId:string; operationId:string; candidate:ProtocolRuntimeCandidate; timeoutMs:number;
  writer:'owned-protocol-child'|'external-tui';
  /** Explicit authorized user/context text. Required for Claude; never synthesize a bootstrap prompt. */
  firstTurn?:{operationId:string;text:string};
}
export interface RuntimeStartReceipt {source:'live'|'historical';identity:ProtocolIdentity;generation:number;firstTurn?:ProtocolTurn}
export interface RuntimeTurnReceipt extends ProtocolTurnReceipt {identity:ProtocolIdentity;generation:number}
export interface RuntimeInspection {
  identity:ProtocolIdentity;generation:number;binding:ProtocolRuntimeBinding;selection:RuntimeSelection;
  idle:boolean;pendingApproval:boolean;
}
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.trim()===v&&v.length<=256&&!/[\x00-\x1f]/.test(v);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function fail(code:string,uncertain=false):never{throw new ProtocolError(code,uncertain);}
/** Only read-only admission is raced; never abandon a possibly spawning supervisor launch. */
function boundedAdmission<T>(promise:Promise<T>,ms:number):Promise<T>{
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new ProtocolError('runtime_admission_timeout',true)),ms);
    promise.then(value=>{clearTimeout(timer);resolve(value);},()=>{clearTimeout(timer);reject(new ProtocolError('runtime_admission_unverified',true));});});
}
const validText=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&!v.includes('\0')&&Buffer.byteLength(v)<=32_000;
export class ProtocolRuntimeHost {
  private readonly journal:EffectJournal;
  private readonly supervisor:RuntimeSupervisor;
  private readonly admit:RuntimeHostOptions['admit'];
  private readonly factory:NonNullable<RuntimeHostOptions['driverFactory']>;
  private readonly hooks:ProtocolHooks;
  private readonly leases:ProtocolSessionLeases;
  private lease?:SessionLease;
  private owned?:OwnedProtocolProcess;
  private driver?:NativeProtocolSession;
  private turnHost?:ProtocolTurnHost;
  private identity?:ProtocolIdentity;
  private generation?:number;
  private binding?:ProtocolRuntimeBinding;
  private launchReceipt?:Readonly<RuntimeLaunchReceipt>;
  private policy?:Readonly<ProtocolPolicy>;
  private selection?:RuntimeSelection;
  private key='';private owner='';private launchOperation='';private roomId='';
  private intent?:string;private intentOperation='';private intentTextHash?:string;
  private busy=false;private begun=false;private failed=false;private released=false;
  constructor(options:RuntimeHostOptions){
    if(!options||typeof options.admit!=='function'||typeof options.supervisor?.launch!=='function')fail('runtime_trusted_dependencies_required');
    this.journal=options.journal;this.supervisor={launch:options.supervisor.launch.bind(options.supervisor)};this.admit=options.admit;
    this.factory=options.driverFactory??protocolRuntimeDriver;this.hooks={...options.hooks};
    this.leases=new ProtocolSessionLeases(this.journal,{observeExit:async expected=>{
      if(!this.owned)fail('runtime_exit_unverified',true);return this.owned!.observeExit(expected);
    }});
  }
  get idle(){return !!this.driver?.idle&&!this.driver.pendingApproval&&!this.busy&&!this.failed&&!this.released;}
  get pendingApproval(){return this.driver?.pendingApproval??false;}
  private admission(phase:string,operationId=this.launchOperation,textHash?:string):Promise<void>{
    return (async()=>{
      const expected=this.binding!,e=await boundedAdmission(Promise.resolve().then(()=>this.admit(Object.freeze({roomId:this.roomId,launchOperationId:this.launchOperation,binding:structuredClone(expected),selection:structuredClone(this.selection!),phase,operationId,...(textHash?{textHash}:{}),...(this.launchReceipt?{launchReceipt:this.launchReceipt}:{})}))),this.policy!.timeoutMs);
      if(this.launchReceipt&&canonical(e?.launchReceipt)!==canonical(this.launchReceipt))fail('runtime_launch_receipt_unverified',!!this.owned);
      if(e?.source!=='trusted-protocol-admission'||e.externalWriter!=='absent'||canonical(e.binding)!==canonical(expected))fail(e?.externalWriter==='external-tui'?'runtime_external_tui_takeover_unsupported':'runtime_admission_unverified',!!this.owned);
    })();
  }
  private assertOwnership(){
    if(this.failed||this.released||!this.lease||!this.owned)fail('runtime_not_owned',true);
    const view=this.leases.assertOwned(this.lease);
    if(view.launchId!==this.owned.launchId||view.incarnation!==this.owned.incarnation||view.runtimeBirth!==this.owned.runtimeBirth)fail('runtime_birth_changed',true);
  }
  private async assertLive(phase:string){
    this.assertOwnership();
    await this.owned!.assertRunning();
    await this.admission(phase,this.intentOperation||this.launchOperation,this.intentTextHash);
    // Admission awaits host I/O: observations from before it no longer prove ownership/liveness.
    await this.owned!.assertRunning();this.assertOwnership();
    const native=this.driver?.nativeObservation;
    if(native&&(native.agent!==this.policy!.agent||native.model!==this.policy!.model||native.cwd!==this.policy!.cwd||this.identity&&native.nativeId!==this.identity.nativeId||this.selection!.mode==='resume'&&native.nativeId!==this.selection!.id))fail('runtime_native_changed',true);
  }
  private wire():ProtocolWire {
    const owned=this.owned!;
    return {messages:owned.wire.messages,send:async frame=>{
      if(!this.intent||this.journal.status(this.key,this.owner,this.intent).state!=='dispatching')fail('runtime_write_without_intent',true);
      const intent=this.intent;await this.assertLive('wire:'+intent);
      if(this.intent!==intent||this.journal.status(this.key,this.owner,intent).state!=='dispatching')fail('runtime_write_without_intent',true);
      await owned.wire.send(frame);
    },close:()=>owned.wire.close()};
  }
  private validateIdentity(value:ProtocolIdentity):ProtocolIdentity {
    const p=this.policy!;
    if(!value||value.agent!==p.agent||!uuid.test(value.nativeId)||value.model!==p.model||value.cwd!==p.cwd||value.home!==p.home||value.route!==p.route||this.selection!.mode==='resume'&&value.nativeId!==this.selection!.id)fail('runtime_native_identity_mismatch',true);
    if(p.agent==='claude'){
      const native=this.driver?.nativeObservation;
      if(!native||native.agent!==value.agent||native.nativeId!==value.nativeId||native.cwd!==value.cwd||native.model!==value.model)fail('runtime_claude_init_unverified',true);
    }
    return structuredClone(value);
  }
  private validateTurn(value:unknown,operationId:string):ProtocolTurn {
    const turn=value as ProtocolTurn;
    if(!turn||turn.operationId!==operationId||turn.nativeId!==this.identity!.nativeId||!id(turn.turnId)||turn.state!=='completed'||typeof turn.text!=='string'||Buffer.byteLength(turn.text)>1024*1024)fail('runtime_turn_receipt_invalid',true);
    return structuredClone(turn);
  }
  private poison(){this.failed=true;if(this.lease)try{this.leases.markUncertain(this.lease);}catch{/* Never release on uncertainty. */}}
  private async effect<T>(step:string,payload:unknown,action:()=>Promise<T>,operationId=this.launchOperation,text?:string):Promise<T>{
    const claim=this.journal.claim({roomId:this.key,operationId:this.owner,step,payload});
    if(claim.state!=='claimed')fail('runtime_stage_uncertain',true);
    this.intent=step;this.intentOperation=operationId;this.intentTextHash=text===undefined?undefined:hash(text);
    try{const result=await action();this.journal.acknowledge(this.key,this.owner,step,result);return result;}
    catch{try{this.journal.uncertain(this.key,this.owner,step);}catch{}this.poison();throw new ProtocolError('runtime_stage_uncertain',true);}
    finally{this.intent=undefined;this.intentOperation='';this.intentTextHash=undefined;}
  }
  async start(input:RuntimeStartRequest):Promise<RuntimeStartReceipt>{
    if(this.begun||this.busy)fail('runtime_already_started');
    if(!input||!id(input.roomId)||!id(input.operationId)||input.writer!=='owned-protocol-child')fail(input?.writer==='external-tui'?'runtime_external_tui_takeover_unsupported':'runtime_start_invalid');
    const candidate=input.candidate; // Do not clone or serialize candidate.env/args/credentials.
    if(!Object.isFrozen(candidate)||!Object.isFrozen(candidate?.binding)||!Object.isFrozen(candidate?.session)||!Object.isFrozen(candidate?.binding?.homeEnvironment)||candidate.version===3&&(!Object.isFrozen(candidate.pilotPolicy)||!Object.isFrozen(candidate.binding.pilotPolicy)||!Object.isFrozen(candidate.args)))fail('runtime_frozen_entry_required');
    this.policy=protocolRuntimePolicy(candidate,input.timeoutMs);
    // The versioned policy validates this hash; retain only its immutable value, never env/argv.
    this.launchReceipt=candidate.version===3?Object.freeze({finalArgvHash:candidate.finalArgvHash}):undefined;
    this.binding=structuredClone(candidate.binding);this.selection=structuredClone(candidate.session);
    if(this.selection.mode==='resume'&&!uuid.test(this.selection.id))fail('runtime_resume_invalid');
    const first=input.firstTurn===undefined?undefined:structuredClone(input.firstTurn);
    if(first&&(!id(first.operationId)||!validText(first.text))||this.policy.agent==='claude'&&!first)fail('runtime_authorized_first_turn_required');
    this.key='protocol-runtime:'+hash(input.roomId);this.owner=hash(input.operationId);this.roomId=input.roomId;this.launchOperation=input.operationId;
    const entry={version:candidate.version,binding:this.binding,selection:this.selection,...(this.launchReceipt?{finalArgvHash:this.launchReceipt.finalArgvHash}:{})};
    const payload={...entry,timeoutMs:input.timeoutMs,firstTurn:first??null};
    let claim:ReturnType<EffectJournal['claim']>;
    try{claim=this.journal.claim({roomId:this.key,operationId:this.owner,step:'start',payload});}catch{throw new ProtocolError('runtime_start_uncertain',true);}
    if(claim.state==='acknowledged'){
      const receipt=claim.result as Omit<RuntimeStartReceipt,'source'>;
      if(!receipt?.identity||!uuid.test(receipt.identity.nativeId)||receipt.identity.agent!==this.policy.agent||receipt.identity.model!==this.policy.model||receipt.identity.cwd!==this.policy.cwd||receipt.identity.home!==this.policy.home||receipt.identity.route!==this.policy.route||!Number.isSafeInteger(receipt.generation)||receipt.generation<1||this.selection.mode==='resume'&&receipt.identity.nativeId!==this.selection.id||!!first!==!!receipt.firstTurn||receipt.firstTurn&&(receipt.firstTurn.operationId!==first!.operationId||receipt.firstTurn.nativeId!==receipt.identity.nativeId||receipt.firstTurn.state!=='completed'||!id(receipt.firstTurn.turnId)||typeof receipt.firstTurn.text!=='string'))fail('runtime_historical_invalid',true);
      this.begun=true;return {...structuredClone(receipt),source:'historical'};
    }
    if(claim.state!=='claimed')fail('runtime_start_uncertain',true);
    this.begun=true;this.busy=true;
    try{
      // EffectJournal payloads are hashes: persist the original binding explicitly as private ACK data.
      const savedEntry=this.journal.claim({roomId:this.key,operationId:this.owner,step:'entry-binding',payload:entry});
      if(savedEntry.state!=='claimed')fail('runtime_entry_record_conflict',true);
      this.journal.acknowledge(this.key,this.owner,'entry-binding',entry);
      await this.admission('reserve');
      const reserved=this.leases.reserve({roomId:this.roomId,operationId:this.launchOperation,agent:this.policy.agent,toolHome:this.binding.effectiveToolHome,mode:this.selection.mode,...(this.selection.mode==='resume'?{nativeId:this.selection.id}:{})});
      if(reserved.state!=='reserved')fail('runtime_reservation_historical',true);this.lease=reserved.lease;
      const permit=this.leases.beginLaunch(this.lease);
      await this.effect('launch',{binding:this.binding,selection:this.selection,permit},async()=>{
        await this.admission('launch');const process=await this.supervisor.launch(candidate,permit);
        this.owned=process;
        if(process.incarnation!==permit.incarnation||process.launchId!==permit.launchId||!id(process.runtimeBirth)||typeof process.assertRunning!=='function')fail('runtime_launch_identity_mismatch',true);
        this.leases.bindRuntime(this.lease!,{launchId:process.launchId,runtimeBirth:process.runtimeBirth});
        await this.assertLive('launched');return {incarnation:process.incarnation,launchId:process.launchId,runtimeBirth:process.runtimeBirth};
      });
      this.driver=this.factory(candidate,this.wire(),input.timeoutMs,this.hooks);
      let firstTurn:ProtocolTurn|undefined;
      if(this.policy.agent==='codex'){
        this.identity=await this.effect('open',{binding:this.binding,selection:this.selection},async()=>{
          await this.assertLive('open');const identity=this.validateIdentity(await this.driver!.open(this.selection!.mode==='resume'?this.selection!.id:undefined));
          this.identity=identity;this.leases.verifyNative(this.lease!,{agent:identity.agent,nativeId:identity.nativeId});await this.assertLive('opened');return identity;
        });
      }else{
        const staged=this.driver as StagedNativeProtocolSession;
        if(typeof staged.prepare!=='function'||typeof staged.startTurn!=='function')fail('runtime_staged_driver_required',true);
        // Authorization/admission covers the exact first text before control preparation, not a bootstrap prompt.
        await this.admission('authorize-first-user',first!.operationId,hash(first!.text));
        await this.effect('prepare',{binding:this.binding,selection:this.selection,firstTurn:first},async()=>{
          await this.assertLive('prepare');await staged.prepare(this.selection!.mode==='resume'?this.selection!.id:undefined);await this.assertLive('prepared');return {prepared:true};
        });
        const result=await this.effect('first-user',{binding:this.binding,...first},async()=>{
          await this.assertLive('first-user');const result=await staged.startTurn(first!.operationId,first!.text);this.identity=this.validateIdentity(result.identity);
          const turn=this.validateTurn(result.turn,first!.operationId);
          if(!staged.idle||staged.pendingApproval)fail('runtime_first_turn_pending',true);
          this.leases.verifyNative(this.lease!,{agent:this.identity.agent,nativeId:this.identity.nativeId});await this.assertLive('first-user-completed');return {identity:this.identity,turn};
        },first!.operationId,first!.text);firstTurn=result.turn;
        const step='turn:'+hash(first!.operationId),payload={binding:this.binding,identity:this.identity,operationId:first!.operationId,text:first!.text};
        const stored=this.journal.claim({roomId:this.key,operationId:this.owner,step,payload});
        if(stored.state!=='claimed')fail('runtime_first_turn_record_conflict',true);
        this.journal.acknowledge(this.key,this.owner,step,firstTurn);
      }
      this.turnHost=new ProtocolTurnHost(this.journal,this.roomId,this.identity!,this.driver);
      if(first&&this.policy.agent==='codex')firstTurn=(await this.performTurn(first.operationId,first.text)).turn;
      await this.assertLive('start-return');this.generation=this.activeGeneration();const receipt={identity:this.identity!,generation:this.generation,...(firstTurn?{firstTurn}:{})};
      this.journal.acknowledge(this.key,this.owner,'start',receipt);return {...structuredClone(receipt),source:'live'};
    }catch{try{this.journal.uncertain(this.key,this.owner,'start');}catch{}this.poison();throw new ProtocolError('runtime_start_uncertain',true);}
    finally{this.busy=false;}
  }
  private async performTurn(operationId:string,text:string):Promise<RuntimeTurnReceipt>{
    if(!this.identity||!id(operationId)||!validText(text))fail('runtime_turn_invalid');
    const step='turn:'+hash(operationId),payload={binding:this.binding,identity:this.identity,operationId,text};
    const previous=this.journal.status(this.key,this.owner,step);
    if(previous.state==='acknowledged'){
      const claim=this.journal.claim({roomId:this.key,operationId:this.owner,step,payload});
      return {source:'historical',identity:structuredClone(this.identity),generation:this.generation??this.activeGeneration(),turn:this.validateTurn(claim.result,operationId)};
    }
    if(previous.state!=='unknown')fail('runtime_turn_uncertain',true);
    if(!this.lease||!this.turnHost||this.failed||this.released)fail('runtime_not_active',true);
    this.leases.assertActive(this.lease);if(!this.driver!.idle||this.driver!.pendingApproval)fail('runtime_session_busy');
    const turn=await this.effect(step,payload,async()=>{
      await this.assertLive('next-turn');const receipt=await this.turnHost!.turn(operationId,text);
      const turn=this.validateTurn(receipt.turn,operationId);await this.assertLive('turn-return');return turn;
    },operationId,text);return {source:'live',identity:structuredClone(this.identity),generation:this.activeGeneration(),turn};
  }
  async turn(operationId:string,text:string):Promise<RuntimeTurnReceipt>{
    if(this.busy)fail('runtime_session_busy');this.busy=true;try{return await this.performTurn(operationId,text);}finally{this.busy=false;}
  }
  /** Alias for a fresh/exact-resume open; Claude still requires authorized firstTurn. */
  open(input:RuntimeStartRequest):Promise<RuntimeStartReceipt>{return this.start(input);}
  startWithContext(input:RuntimeStartRequest & {firstTurn:{operationId:string;text:string}}):Promise<RuntimeStartReceipt>{
    if(!input?.firstTurn)fail('runtime_authorized_first_turn_required');return this.start(input);
  }
  private activeGeneration():number {
    if(!this.lease)fail('runtime_not_active',true);
    const generation=this.leases.assertActive(this.lease).generation;
    if(generation===undefined||!Number.isSafeInteger(generation)||generation<1)fail('runtime_generation_unverified',true);
    return generation!;
  }
  /** Live ownership inspection only: historical receipts never grant inspection authority. */
  async inspect():Promise<RuntimeInspection>{
    if(this.busy)fail('runtime_session_busy');this.busy=true;
    try{await this.assertLive('inspect');const generation=this.activeGeneration();
      if(!this.identity)fail('runtime_not_active',true);
      return {identity:structuredClone(this.identity),generation,binding:structuredClone(this.binding!),selection:structuredClone(this.selection!),idle:!!this.driver?.idle&&!this.driver.pendingApproval,pendingApproval:this.pendingApproval};
    }catch{this.poison();throw new ProtocolError('runtime_inspection_uncertain',true);}finally{this.busy=false;}
  }
  async close():Promise<SessionReleaseReceipt>{
    if(this.busy)fail('runtime_session_busy');if(!this.owned||!this.lease)fail('runtime_exit_unverified',true);
    this.busy=true;
    try{
      const claim=this.journal.claim({roomId:this.key,operationId:this.owner,step:'close',payload:{binding:this.binding,incarnation:this.owned.incarnation,launchId:this.owned.launchId,runtimeBirth:this.owned.runtimeBirth}});
      if(claim.state==='acknowledged')return structuredClone(claim.result as SessionReleaseReceipt);
      if(claim.state!=='claimed')fail('runtime_close_uncertain',true);
      await this.driver?.close();await this.owned.cleanup();
      const receipt=await this.leases.release(this.lease);this.released=true;
      this.journal.acknowledge(this.key,this.owner,'close',receipt);this.journal.release(this.key,this.owner);return receipt;
    }catch{this.poison();throw new ProtocolError('runtime_close_uncertain',true);}finally{this.busy=false;}
  }
}
