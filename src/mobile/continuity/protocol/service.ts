/** Trusted host composition only. No global registry, native defaults, discovery or TUI adoption. */
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {mkdirSync,lstatSync,realpathSync,openSync,closeSync,fchmodSync,constants} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {ContinuityStore} from '../store';
import {ContinuityArchive} from '../archive';
import {ContinuityEngine,type FactsSnapshot} from '../engine';
import {FactsSelectionStore,createFactsProvider} from '../facts-selection';
import {FactsUIService} from '../facts-ui';
import {factsBindingHash,type Snapshot} from '../facts-resolver';
import {EffectJournal} from '../effect-journal';
import {ContinuityError,type Room,type RoomEvent,type Backend,type Binding,type AgentKind,type Adapter} from '../types';
import {ProtocolContinuityAdapter,protocolRoomBinding,protocolNamespace,type ProtocolAdapterPorts} from './adapter';
import {protocolRuntimePolicy,type ProtocolRuntimeCandidate} from './entry';
import {ProtocolRuntimeHost,type RuntimeHostOptions,type RuntimeStartReceipt} from './runtime-host';
import type {ProtocolTurn} from './types';
import {validateOneWayProductionPolicy,oneWayRoom,oneWayBindingMatches,oneWaySwitchDirections,type ProtocolOneWayProductionPolicy} from './production-policy';
import type {ContinuityFeatureOptions,ContinuityCapabilities,OwnedTransportStatus,OwnedTurnRequest,OwnedTurnReceipt} from '../../features/continuity';

export interface ProtocolLiveEvidence {
  source:'trusted-live-continuity-evidence';
  scope:'all-backends'|'room-backend';
  /** A host-validated acceptance reference per certified backend, not an HTTP/model boolean. */
  backends:{backend:Backend;runId:string}[];
  models:ContinuityCapabilities['models'];
}
export type ProtocolAcceptanceKind='switch'|'text-turn';
export interface ProtocolAcceptanceProfile {
  hash:string;namespace:string;agent:AgentKind;model:string;route:string;
}
export interface ProtocolAcceptancePermit {
  source:'trusted-bounded-acceptance';permitId:string;expiresAt:number;maxOperations:number;
  scope:{room:Pick<Room,'id'|'backend'|'workspace'|'room'|'cwd'>;profile:ProtocolAcceptanceProfile;operations:ProtocolAcceptanceKind[]};
}
export interface ProtocolAcceptanceOperation {
  kind:ProtocolAcceptanceKind;id:string;payloadHash:string;
  room:Pick<Room,'id'|'backend'|'workspace'|'room'|'cwd'|'revision'>;profile:ProtocolAcceptanceProfile;
}
export interface ProtocolAcceptanceAuthority {
  advertise():Promise<ProtocolAcceptancePermit[]>;
  authorize(operation:Readonly<ProtocolAcceptanceOperation>):Promise<{permit:ProtocolAcceptancePermit;operation:ProtocolAcceptanceOperation}|null>;
}
export function protocolAcceptanceProfile(binding:import('./entry').ProtocolRuntimeBinding):ProtocolAcceptanceProfile {
  const {sessionId:_session,...profile}=binding;
  return {hash:createHash('sha256').update(canonical(profile)).digest('hex'),namespace:protocolNamespace(binding),agent:binding.kind==='codex-app-server-stdio'?'codex':'claude',model:binding.model,route:binding.route};
}
export interface ProtocolAcceptanceAdvertisement extends ProtocolAcceptancePermit {remaining:number}
export interface ProtocolServiceCapabilities extends ContinuityCapabilities {
  authorization?:{purpose:'production'}|{purpose:'bounded-acceptance';permits:ProtocolAcceptanceAdvertisement[]};
}
export interface ProtocolServiceOptions {
  /** Private durable directory; never a public share/web root. Host owns its placement. */
  privateRoot:string;
  actorId:string;
  timeoutMs:number;
  runtime:Omit<RuntimeHostOptions,'journal'>;
  host:Pick<ProtocolAdapterPorts,'preflight'|'candidate'|'history'|'verifyContext'> & {
    /** Exact host alias-to-store ID mapping; null means unmanaged. Never choose latest. */
    resolveRoomId(workspace:string,room:string):Promise<string|null>;
    /** Absent/null/error/malformed evidence means capabilities remain off. */
    liveEvidence?():Promise<ProtocolLiveEvidence|null>;
    productionPolicy?():Promise<ProtocolOneWayProductionPolicy|null>;
    acceptancePermit?:ProtocolAcceptanceAuthority;
  };
  maxContextBytes?:number;
  /** Trusted clock DI only; never a request/environment value. */
  now?:()=>number;
}
export interface ProtocolBootstrapRequest {
  scope:Pick<Room,'id'|'backend'|'workspace'|'room'|'cwd'>;
  operationId:string;
  candidate:ProtocolRuntimeCandidate;
  writer:'owned-protocol-child';
  firstTurn?:{operationId:string;text:string};
}
export interface ProtocolBootstrapReceipt {room:Room;start:RuntimeStartReceipt}
export type ProtocolOwnedTurnRequest=OwnedTurnRequest;
export type ProtocolOwnedTurnReceipt=OwnedTurnReceipt;
export type ProtocolOwnedStatus=OwnedTransportStatus;
export interface ProtocolOwnedService {
  inventory():Promise<Array<{room:Room;transport:ProtocolOwnedStatus}>>;
  status(room:Room):Promise<ProtocolOwnedStatus>;
  turn(room:Room,request:ProtocolOwnedTurnRequest):Promise<ProtocolOwnedTurnReceipt>;
  turnStatus(room:Room,id:string):Promise<ProtocolOwnedTurnReceipt|null>;
}
export interface ProtocolContinuityService {
  store:ContinuityStore;engine:ContinuityEngine;archive:ContinuityArchive;
  selections:FactsSelectionStore;factsUI:FactsUIService;
  owned:ProtocolOwnedService;
  featureOptions:ContinuityFeatureOptions & {owned:ProtocolOwnedService};
  snapshot(room:Room):Promise<Snapshot>;
  bootstrapOwned(input:ProtocolBootstrapRequest):Promise<ProtocolBootstrapReceipt>;
  /** Explicit host shutdown. Cleanup/exit proof must succeed before stores are closed. */
  close():Promise<void>;
}
const backends:Backend[]=['herdr','tmux','superset'];
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.trim()===v&&v.length<=256&&!/[\x00-\x1f]/.test(v);
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
function fail(code:string,status=409):never{throw new ContinuityError(code,status);}
function validateCandidate(candidate:ProtocolRuntimeCandidate,timeoutMs:number):void {
  protocolRuntimePolicy(candidate,timeoutMs);
  if(!Object.isFrozen(candidate)||!Object.isFrozen(candidate.binding)||!Object.isFrozen(candidate.session)||!Object.isFrozen(candidate.binding.homeEnvironment)
    ||candidate.version===3&&(!Object.isFrozen(candidate.pilotPolicy)||!Object.isFrozen(candidate.binding.pilotPolicy)||!Object.isFrozen(candidate.args)))fail('protocol_candidate_not_immutable');
}
const inactive=():ContinuityCapabilities=>({ready:false,scope:'all-backends',factsSelectionAvailable:true,models:[],backends:backends.map(backend=>({backend,ready:false,reason:'live_continuity_not_certified'}))});

/** Calling the factory provisions private archives; importing the module has no effects. */
export function createProtocolContinuityService(options:ProtocolServiceOptions):ProtocolContinuityService {
  if(!options||!isAbsolute(options.privateRoot)||resolve(options.privateRoot)!==options.privateRoot
    ||options.privateRoot.includes('\0')||!text(options.actorId)||!Number.isInteger(options.timeoutMs)
    ||options.timeoutMs<1||options.timeoutMs>300_000||typeof options.runtime?.admit!=='function'
    ||typeof options.runtime?.supervisor?.launch!=='function'
    ||['preflight','candidate','history','verifyContext','resolveRoomId'].some(k=>typeof (options.host as any)?.[k]!=='function'))fail('protocol_service_configuration_invalid',400);
  const root=options.privateRoot,timeoutMs=options.timeoutMs,maxContextBytes=options.maxContextBytes;
  mkdirSync(root,{recursive:true,mode:0o700});
  if(lstatSync(root).isSymbolicLink()||!lstatSync(root).isDirectory()||realpathSync(root)!==root||(lstatSync(root).mode&0o077)!==0)fail('protocol_service_root_not_private',400);
  const host={preflight:options.host.preflight.bind(options.host),candidate:options.host.candidate.bind(options.host),
    history:options.host.history.bind(options.host),verifyContext:options.host.verifyContext.bind(options.host),
    productionPolicy:options.host.productionPolicy?.bind(options.host),resolveRoomId:options.host.resolveRoomId.bind(options.host),liveEvidence:options.host.liveEvidence?.bind(options.host),acceptancePermit:options.host.acceptancePermit&&typeof options.host.acceptancePermit.advertise==='function'&&typeof options.host.acceptancePermit.authorize==='function'?{advertise:options.host.acceptancePermit.advertise.bind(options.host.acceptancePermit),authorize:options.host.acceptancePermit.authorize.bind(options.host.acceptancePermit)}:undefined};
  const now=options.now??Date.now;
  const store=new ContinuityStore(join(root,'rooms.sqlite'));
  const archive=new ContinuityArchive(join(root,'archive'));
  const selections=new FactsSelectionStore(join(root,'selections'));
  const journal=new EffectJournal(join(root,'effects.sqlite'));
  const trustedAdmit=options.runtime.admit.bind(options.runtime);
  const runtimeOptions={supervisor:options.runtime.supervisor,admit:async(request:Parameters<typeof trustedAdmit>[0])=>{
    open();await recheckProductionBoundary(request);await recheckAcceptanceBoundary(request);const evidence=await trustedAdmit(request);open();await recheckAcceptanceBoundary(request);await recheckProductionBoundary(request);return evidence;
  },hooks:options.runtime.hooks,driverFactory:options.runtime.driverFactory};
  const registry=new Map<string,ProtocolRuntimeHost>();
  const candidatePins=new Map<string,ReturnType<ProtocolAdapterPorts['candidate']>>();
  let closed=false,closing=false,shutdownRequested=false;
  const open=()=>{if(closed||closing||shutdownRequested)fail('protocol_service_closed',503);};
  const current=(room:Room):Room=>{
    open();const live=store.room(room.id);
    if(!live||canonical(live)!==canonical(room))fail('facts_room_changed');return live;
  };
  const allEvents=(roomId:string):RoomEvent[]=>{
    const events:RoomEvent[]=[];let cursor=0;
    for(let page=0;page<=200;page++){
      const rows=store.events(roomId,cursor,500);
      if(!rows.length)return events;
      if(rows.some((e,i)=>e.seq<=(i?rows[i-1].seq:cursor)))fail('invalid_history_order');
      events.push(...rows);if(events.length>100_000)fail('history_too_large_for_checkpoint');cursor=rows.at(-1)!.seq;
    }return fail('history_too_large_for_checkpoint');
  };
  const productionPolicies=new WeakMap<object,ProtocolOneWayProductionPolicy>();
  const capabilities=async():Promise<ProtocolServiceCapabilities>=>{
    open();
    if(host.productionPolicy){
      try{
        const policy=validateOneWayProductionPolicy(await host.productionPolicy());open();
        const models=new Map<string,ContinuityCapabilities['models'][number]>();
        for(const row of policy.rooms)for(const p of [row.source,row.target])models.set(p.agent+':'+p.model,{agent:p.agent,id:p.model,label:p.model});
        const c:ProtocolServiceCapabilities={ready:true,scope:'room-backend',factsSelectionAvailable:true,authorization:{purpose:'production'},
          switchDirections:oneWaySwitchDirections(),models:[...models.values()],backends:backends.map(backend=>({backend,ready:policy.rooms.some(r=>r.room.backend===backend)}))};
        productionPolicies.set(c,policy);return c;
      }catch{open();return {...inactive(),switchDirections:oneWaySwitchDirections().map(d=>({...d,state:'development'}))};}
    }
    let e:ProtocolLiveEvidence|null;
    try{e=await host.liveEvidence?.()??null;}catch{open();e=null;}open();
    if(!e||e.source!=='trusted-live-continuity-evidence'||!['all-backends','room-backend'].includes(e.scope)
      ||!Array.isArray(e.backends)||!e.backends.length||e.backends.length>3
      ||e.backends.some(x=>!x||!backends.includes(x.backend)||!text(x.runId))
      ||new Set(e.backends.map(x=>x.backend)).size!==e.backends.length||!Array.isArray(e.models)
      ||e.models.some(x=>!x||!['codex','claude'].includes(x.agent)||!text(x.id)||!text(x.label)))return acceptanceCapabilities();
    const ready=e.scope==='all-backends'?e.backends.length===3:e.backends.length>0;
    if(!ready)return acceptanceCapabilities();
    return {ready,scope:e.scope,authorization:{purpose:'production'},factsSelectionAvailable:true,models:ready?structuredClone(e.models):[],
      backends:backends.map(backend=>({backend,ready:ready&&e!.backends.some(x=>x.backend===backend),
        ...(!ready||!e!.backends.some(x=>x.backend===backend)?{reason:'live_continuity_not_certified'}:{})}))};
  };
  const create=()=>new ProtocolRuntimeHost({...runtimeOptions,journal});
  const verifyOwned=async(room:Room)=>{
    current(room);const runtime=registry.get(room.id);if(!runtime)fail('protocol_room_not_owned');
    const observed=await runtime.inspect().catch(()=>fail('protocol_runtime_not_safe'));current(room);
    const expected=room.bindings[room.active];
    if(!expected||observed.identity.cwd!==room.cwd||canonical(protocolRoomBinding(observed.identity,observed.generation,observed.binding,expected.cursor))!==canonical(expected)
      ||!observed.idle||observed.pendingApproval)fail('source_not_safe');
    return observed;
  };
  const history:ProtocolAdapterPorts['history']=async(room,binding)=>{
    current(room);if(factsBindingHash(binding)!==factsBindingHash(room.bindings[room.active]!))fail('history_identity_changed');
    await verifyOwned(room);const records=structuredClone(await host.history(structuredClone(room),structuredClone(binding)));
    if(!Array.isArray(records)||records.length>100_000||Buffer.byteLength(canonical(records))>64*1024*1024)fail('history_too_large_for_checkpoint');
    if(records.some(e=>!e||Object.hasOwn(e,'seq')||e.agent!==binding.agent||e.nativeId!==binding.nativeId))fail('history_identity_changed');
    await verifyOwned(room);return records;
  };
  const selectCandidate:ProtocolAdapterPorts['candidate']=async(room,target,existing,model)=>{
      current(room);const key=room.operationId?canonical([room.id,room.operationId,target,existing??null,model??null]):undefined;
      if(key&&candidatePins.has(key))return candidatePins.get(key)!;
      if(key&&candidatePins.size>=1024)fail('protocol_candidate_pin_limit');
      const selected=(async()=>{
        const candidate=await host.candidate(structuredClone(room),target,existing&&structuredClone(existing),model);
        current(room);validateCandidate(candidate,timeoutMs);
        return candidate;
      })();
      if(key)candidatePins.set(key,selected);return selected;
  };
  const baseAdapter=new ProtocolContinuityAdapter({
    runtime:id=>registry.get(id),install:(id,runtime)=>{open();registry.set(id,runtime);},create,
    timeoutMs,history,verifyContext:host.verifyContext,
    preflight:async(room,target,model)=>{
      current(room);const caps=await capabilities();current(room);
      if(host.productionPolicy&&(room.active!=='codex'||target!=='claude'))return {ready:false,reason:'switch_direction_in_development'};
      await assertProductionDirection(room,target,undefined,model);
      if(!productionAllowed(caps,room)){
        const scopes=caps.authorization?.purpose==='bounded-acceptance'?caps.authorization.permits:[];
        const prior=room.operationId?acceptanceRow('switch',room.id,room.operationId):null;
        if(!prior&&!scopes.some(p=>scopeRoomMatches(p,room)&&p.scope.operations.includes('switch')&&p.scope.profile.agent===target&&(model===undefined||p.scope.profile.model===model)&&p.remaining>0))return {ready:false,reason:host.acceptancePermit?'bounded_acceptance_required':'live_continuity_not_certified'};
        const candidate=await selectCandidate(room,target,room.bindings[target],model),profile=protocolAcceptanceProfile(candidate.binding);current(room);
        if(prior){await recheckAcceptance(prior,room,profile);}
        else if(!scopes.some(p=>permitMatches(p,room,profile,'switch')&&p.remaining>0))return {ready:false,reason:'bounded_acceptance_scope_mismatch'};
      }else if(model&&!caps.models.some(m=>m.agent===target&&m.id===model))return {ready:false,reason:'model_unavailable'};
      const result=await host.preflight(structuredClone(room),target,model);current(room);
      await assertProductionDirection(room,target,undefined,model);
      if(result?.ready===true)return {ready:true};
      return {ready:false,reason:typeof result?.reason==='string'&&/^[a-z][a-z0-9_]{0,127}$/.test(result.reason)?result.reason:'protocol_preflight_unverified'};
    },
    candidate:selectCandidate,
    beforeSourceClose:async(room,target,context,candidate)=>{
      await assertProductionDirection(room,target,candidate);
      const saved=acceptanceRow('switch',room.id,context.id);
      if(!saved){const caps=await capabilities();current(room);if(!productionAllowed(caps,room))fail('bounded_acceptance_required');return;}
      const intent=store.operation(context.id);
      if(!intent||intent.roomId!==room.id||room.operationId!==intent.id||intent.target!==target||intent.expectedRevision!==room.revision)fail('acceptance_operation_conflict');
      const operation=switchAcceptanceOperation(room,target,context,candidate,room.bindings[target],intent.model);
      if(sha(canonical(operation))!==saved.operation_hash)fail('acceptance_operation_conflict');
      await recheckAcceptance(saved,room,operation.profile);current(room);
    },
  });
  const switchAcceptanceOperation=(room:Room,target:AgentKind,context:import('../types').ContextDelivery,candidate:import('./entry').ProtocolRuntimeCandidate,existing?:Binding,model?:string)=>
    makeAcceptanceOperation('switch',context.id,room,protocolAcceptanceProfile(candidate.binding),sha(canonical({room,target,context,existing:existing??null,model:model??null,binding:candidate.binding,session:candidate.session,launchReceipt:candidate.version===3?candidate.finalArgvHash:null})));
  const adapter:Adapter={inspect:baseAdapter.inspect.bind(baseAdapter),preflight:baseAdapter.preflight.bind(baseAdapter),checkpoint:baseAdapter.checkpoint.bind(baseAdapter),targetPolicy:baseAdapter.targetPolicy.bind(baseAdapter),launch:baseAdapter.launch.bind(baseAdapter),deliver:baseAdapter.deliver.bind(baseAdapter),
    launchWithContext:async(room,target,context,existing,model)=>{
      await assertProductionDirection(room,target,undefined,model);
      if(host.productionPolicy){const candidate=await selectCandidate(room,target,existing,model);await assertProductionDirection(room,target,candidate,model);}
      const caps=await capabilities();current(room);
      if(!productionAllowed(caps,room)){
        const candidate=await selectCandidate(room,target,existing,model),profile=protocolAcceptanceProfile(candidate.binding);
        const operation=switchAcceptanceOperation(room,target,context,candidate,existing,model);
        const grant=await authorizeAcceptance(operation);current(room);
        turns().transaction(()=>consumeAcceptance(operation,grant,[sha(canonical(context.text))])).immediate();
      }
      return baseAdapter.launchWithContext(room,target,context,existing,model);
    },
  };
  const snapshot=async(room:Room):Promise<Snapshot>=>{
    current(room);if(room.operationId)fail('operation_in_progress');
    const records=await history(room,room.bindings[room.active]!);current(room);
    store.importHistory(room,records);const events=allEvents(room.id);const archivePath=archive.snapshot(room.id,events);
    current(room);
    return {roomId:room.id,roomRevision:room.revision,sourceBinding:structuredClone(room.bindings[room.active]!),
      events,throughSeq:events.at(-1)?.seq??0,archivePath,archiveHash:sha(events.map(e=>JSON.stringify(e)).join('\n')+'\n')};
  };
  const factsUI=new FactsUIService(selections,options.actorId,snapshot);
  const validateFactsSnapshot=(room:Room,s:FactsSnapshot):string=>{
    current(room);const op=room.operationId?store.operation(room.operationId):null;
    if(!op||op.roomId!==room.id||op.expectedRevision!==room.revision||op.state!=='checkpointed'
      ||factsBindingHash(op.from)!==factsBindingHash(s.sourceBinding)||s.roomId!==room.id||s.roomRevision!==room.revision
      ||factsBindingHash(room.bindings[room.active]!)!==factsBindingHash(s.sourceBinding))fail('facts_operation_scope_mismatch');
    const events=allEvents(room.id),content=events.map(e=>JSON.stringify(e)).join('\n')+'\n';
    if(canonical(events)!==canonical(s.events)||sha(content)!==s.archiveHash||s.throughSeq!==(events.at(-1)?.seq??0)
      ||archive.snapshot(room.id,events)!==s.archivePath)fail('facts_snapshot_changed');
    return op.id;
  };
  const engine=new ContinuityEngine(store,{herdr:adapter,tmux:adapter,superset:adapter},{archiveRoot:archive.root,maxContextBytes,
    facts:createFactsProvider(selections,async(room,s)=>validateFactsSnapshot(room,s))});
  const catalogRoom=(workspace:string,room:string):Room|null=>{
    const rows=turns().query('SELECT room_id FROM protocol_owned_rooms WHERE workspace=? AND runtime_room=? LIMIT 2').all(workspace,room) as {room_id:string}[];
    if(rows.length>1)fail('protocol_room_scope_ambiguous');if(!rows.length)return null;
    const found=store.room(rows[0].room_id);
    if(!found)fail('protocol_room_bootstrap_pending');
    if(found.workspace!==workspace||found.room!==room)fail('protocol_room_scope_mismatch');return found;
  };
  const resolveRoom=async(workspace:string,room:string):Promise<Room|null>=>{
    open();const known=catalogRoom(workspace,room);if(known)return known;
    const id=await host.resolveRoomId(workspace,room);open();
    const meanwhile=catalogRoom(workspace,room);if(meanwhile)return meanwhile;
    if(id===null)return null;if(!text(id))fail('protocol_room_scope_unverified');
    const found=store.room(id);if(!found)return null;
    if(found.workspace!==workspace||found.room!==room)fail('protocol_room_scope_mismatch');return found;
  };
  const bootstrapOwned=async(input:ProtocolBootstrapRequest):Promise<ProtocolBootstrapReceipt>=>{
    open();const candidate=input.candidate,operationId=input.operationId,firstTurn=input.firstTurn===undefined?undefined:structuredClone(input.firstTurn);
    const supplied=input.scope;const scope=supplied&&{id:supplied.id,backend:supplied.backend,workspace:supplied.workspace,room:supplied.room,cwd:supplied.cwd};
    if(input.writer!=='owned-protocol-child'||!text(operationId)||!scope||!text(scope.id)||!text(scope.workspace)||!text(scope.room)
      ||!backends.includes(scope.backend)||!isAbsolute(scope.cwd)||scope.cwd!==candidate?.cwd)fail('protocol_bootstrap_scope_invalid');
    validateCandidate(candidate,timeoutMs);
    if(candidate.tool==='claude'&&!firstTurn)fail('protocol_bootstrap_first_turn_required');
    const mapped=await host.resolveRoomId(scope.workspace,scope.room);open();
    if(mapped!==scope.id)fail('protocol_bootstrap_scope_unmapped');
    if(store.room(scope.id)||registry.has(scope.id))fail('protocol_bootstrap_room_exists');
    if(host.productionPolicy){
      const caps=await capabilities();open();const policy=productionPolicies.get(caps),row=policy&&oneWayRoom(policy,scope);
      if(!row||canonical(protocolAcceptanceProfile(candidate.binding))!==canonical(row.source))fail('production_policy_unverified');
    }
    const key='protocol-service-bootstrap:'+sha(scope.id),step='bootstrap';
    const receipt=journal.claim({roomId:key,operationId:operationId,step,payload:{scope,binding:candidate.binding,selection:candidate.session,firstTurn:firstTurn??null}});
    if(receipt.state!=='claimed')fail('protocol_bootstrap_reconciliation_required');
    const runtime=create();registry.set(scope.id,runtime);
    try{
      const db=turns();
      db.transaction(()=>{
        const old=db.query('SELECT scope FROM protocol_owned_rooms WHERE room_id=?').get(scope.id) as {scope:string}|null;
        if(old&&old.scope!==canonical(scope))fail('protocol_bootstrap_scope_conflict');
        if(!old)db.query('INSERT INTO protocol_owned_rooms(room_id,backend,workspace,runtime_room,scope) VALUES(?,?,?,?,?)').run(scope.id,scope.backend,scope.workspace,scope.room,canonical(scope));
      }).immediate();
      const start=await runtime.start({roomId:scope.id,operationId:operationId,candidate:candidate,writer:'owned-protocol-child',timeoutMs,firstTurn:firstTurn});
      open();if(start.source!=='live')fail('protocol_historical_not_ready');
      const observed=await runtime.inspect();
      if(observed.identity.cwd!==scope.cwd||canonical(observed.identity)!==canonical(start.identity)||observed.generation!==start.generation
        ||canonical(observed.binding)!==canonical(candidate.binding)||!observed.idle||observed.pendingApproval)fail('protocol_bootstrap_identity_unverified');
      const binding=protocolRoomBinding(start.identity,start.generation,observed.binding);
      const room=store.register({...scope,revision:0,active:binding.agent,bindings:{[binding.agent]:binding}});
      const result={room,start};journal.acknowledge(key,operationId,step,result);journal.release(key,operationId);return result;
    }catch{try{journal.uncertain(key,operationId,step);}catch{}throw new ContinuityError('protocol_bootstrap_uncertain');}
  };
  // Separate private ledger: atomic unique request + one non-expiring pending writer per room.
  // It never changes Store schema or treats an interrupted dispatch as permission to retry.
  let turnDb:Database|undefined;
  const activeTurns=new Set<string>();
  const turns=():Database=>{
    open();if(turnDb)return turnDb;
    const path=join(root,'owned-turns.sqlite');
    const fd=openSync(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
    try{fchmodSync(fd,0o600);}finally{closeSync(fd);}
    const db=new Database(path);
    try{db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS protocol_acceptance_permits (
        permit_id TEXT PRIMARY KEY,definition_hash TEXT NOT NULL,body TEXT NOT NULL,last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS protocol_acceptance_claims (
        kind TEXT NOT NULL,room_id TEXT NOT NULL,operation_id TEXT NOT NULL,permit_id TEXT NOT NULL,
        operation_hash TEXT NOT NULL,body TEXT NOT NULL,text_hashes TEXT NOT NULL,
        PRIMARY KEY(kind,room_id,operation_id));
      CREATE TABLE IF NOT EXISTS protocol_owned_rooms (
        room_id TEXT PRIMARY KEY,backend TEXT NOT NULL,workspace TEXT NOT NULL,runtime_room TEXT NOT NULL,scope TEXT NOT NULL,
        UNIQUE(backend,workspace,runtime_room));
      CREATE TABLE IF NOT EXISTS protocol_owned_turns (
        id TEXT PRIMARY KEY,room_id TEXT NOT NULL,request_hash TEXT NOT NULL,body TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('dispatching','uncertain','completed')),receipt TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS protocol_owned_room_pending ON protocol_owned_turns(room_id)
        WHERE state IN ('dispatching','uncertain');`);
    }catch(e){db.close();throw e;}turnDb=db;return db;
  };
  interface TurnRow {id:string;room_id:string;request_hash:string;body:string;state:'dispatching'|'uncertain'|'completed';receipt:string|null}
  const row=(id:string)=>turns().query('SELECT * FROM protocol_owned_turns WHERE id=?').get(id) as TurnRow|null;
  const recorded=(r:TurnRow):ProtocolOwnedTurnReceipt=>{
    try{
      const body=JSON.parse(r.body) as {roomId:string;request:ProtocolOwnedTurnRequest};
      if(body.roomId!==r.room_id||body.request.id!==r.id||sha(canonical(body))!==r.request_hash)fail('protocol_turn_ledger_corrupt');
      if(r.state!=='completed')return {id:r.id,roomId:r.room_id,binding:body.request.binding,state:'uncertain',source:'historical'};
      const receipt=JSON.parse(r.receipt! ) as ProtocolOwnedTurnReceipt;
      if(receipt.id!==r.id||receipt.roomId!==r.room_id||receipt.state!=='completed'||!receipt.turn
        ||receipt.turn.operationId!==r.id||receipt.turn.state!=='completed'||receipt.turn.nativeId!==body.request.binding.nativeId
        ||canonical(receipt.binding)!==canonical(body.request.binding))fail('protocol_turn_ledger_corrupt');
      return {...receipt,source:'historical'};
    }catch{return fail('protocol_turn_ledger_corrupt');}
  };
  const roomScope=(room:Room)=>({id:room.id,backend:room.backend,workspace:room.workspace,room:room.room,cwd:room.cwd});
  const scopeRoomMatches=(permit:ProtocolAcceptancePermit,room:Room)=>canonical(permit.scope.room)===canonical(roomScope(room));
  const permitMatches=(permit:ProtocolAcceptancePermit,room:Room,profile:ProtocolAcceptanceProfile,kind:ProtocolAcceptanceKind)=>scopeRoomMatches(permit,room)&&canonical(permit.scope.profile)===canonical(profile)&&permit.scope.operations.includes(kind);
  const productionAllowed=(caps:ProtocolServiceCapabilities,room:Room)=>{
    if(caps.authorization?.purpose!=='production'||!caps.ready||!caps.backends.some(b=>b.backend===room.backend&&b.ready))return false;
    if(!host.productionPolicy)return true;
    const policy=productionPolicies.get(caps),row=policy&&oneWayRoom(policy,room);
    return !!row&&oneWayBindingMatches(room.active==='codex'?row.source:row.target,room.bindings[room.active]);
  };
  const assertProductionDirection=async(room:Room,target:AgentKind,candidate?:ProtocolRuntimeCandidate,model?:string)=>{
    if(!host.productionPolicy)return;
    if(room.active!=='codex'||target!=='claude')fail('switch_direction_in_development',409);
    const caps=await capabilities();current(room);const policy=productionPolicies.get(caps),row=policy&&oneWayRoom(policy,room);
    if(!row||!productionAllowed(caps,room)||model!==undefined&&model!==row.target.model
      ||candidate&&canonical(protocolAcceptanceProfile(candidate.binding))!==canonical(row.target))fail('production_policy_unverified');
  };
  const recheckProductionBoundary=async(request:Parameters<typeof trustedAdmit>[0])=>{
    if(!host.productionPolicy)return;
    const caps=await capabilities(),policy=productionPolicies.get(caps),room=store.room(request.roomId);
    const saved=room?undefined:turns().query('SELECT scope FROM protocol_owned_rooms WHERE room_id=?').get(request.roomId) as {scope:string}|null|undefined;
    const fullScope=room??(saved?JSON.parse(saved.scope):null);
    const row=policy&&fullScope&&oneWayRoom(policy,fullScope);
    if(!row)fail('production_policy_unverified');
    const actual=protocolAcceptanceProfile(request.binding);
    if(!room){if(canonical(actual)!==canonical(row.source))fail('production_policy_unverified');return;}
    if(!productionAllowed(caps,room))fail('production_policy_unverified');
    const op=room.operationId?store.operation(room.operationId):null;
    const expected=op&&request.launchOperationId===op.id?row.target:room.active==='codex'?row.source:row.target;
    if(op&&request.launchOperationId===op.id&&(op.from.agent!=='codex'||op.target!=='claude'))fail('switch_direction_in_development');
    if(canonical(actual)!==canonical(expected))fail('production_policy_unverified');
  };
  const time=()=>{const value=now();if(!Number.isSafeInteger(value)||value<0)fail('acceptance_clock_unverified');return value;};
  const validPermit=(p:ProtocolAcceptancePermit):boolean=>{
    try{return !!p&&Object.keys(p).sort().join(',')==='expiresAt,maxOperations,permitId,scope,source'&&p.source==='trusted-bounded-acceptance'&&text(p.permitId)&&Number.isSafeInteger(p.expiresAt)&&p.expiresAt>time()
      &&Number.isSafeInteger(p.maxOperations)&&p.maxOperations>=1&&p.maxOperations<=1000&&!!p.scope&&Object.keys(p.scope).sort().join(',')==='operations,profile,room'
      &&canonical(Object.keys(p.scope.room).sort())===canonical(['backend','cwd','id','room','workspace'])&&Object.values(p.scope.room).every(text)&&backends.includes(p.scope.room.backend)&&isAbsolute(p.scope.room.cwd)
      &&!!p.scope.profile&&Object.keys(p.scope.profile).sort().join(',')==='agent,hash,model,namespace,route'&&/^[a-f0-9]{64}$/.test(p.scope.profile.hash)&&/^[a-f0-9]{64}$/.test(p.scope.profile.namespace)&&['codex','claude'].includes(p.scope.profile.agent)&&text(p.scope.profile.model)&&text(p.scope.profile.route)
      &&Array.isArray(p.scope.operations)&&p.scope.operations.length>0&&p.scope.operations.length<=2&&new Set(p.scope.operations).size===p.scope.operations.length&&p.scope.operations.every(k=>k==='switch'||k==='text-turn');}catch{return false;}
  };
  interface AcceptanceRow {kind:ProtocolAcceptanceKind;room_id:string;operation_id:string;permit_id:string;operation_hash:string;body:string;text_hashes:string}
  const acceptanceRow=(kind:ProtocolAcceptanceKind,roomId:string,id:string)=>turns().query('SELECT * FROM protocol_acceptance_claims WHERE kind=? AND room_id=? AND operation_id=?').get(kind,roomId,id) as AcceptanceRow|null;
  const permitRemaining=(p:ProtocolAcceptancePermit)=>{
    const old=turns().query('SELECT definition_hash,last_seen FROM protocol_acceptance_permits WHERE permit_id=?').get(p.permitId) as {definition_hash:string;last_seen:number}|null;
    if(old&&(old.definition_hash!==sha(canonical(p))||time()<old.last_seen))fail('acceptance_permit_conflict');
    const used=(turns().query('SELECT count(*) AS n FROM protocol_acceptance_claims WHERE permit_id=?').get(p.permitId) as {n:number}).n;
    if(used>p.maxOperations)fail('acceptance_ledger_corrupt');return p.maxOperations-used;
  };
  const acceptanceCapabilities=async():Promise<ProtocolServiceCapabilities>=>{
    if(!host.acceptancePermit)return inactive();let advertised:ProtocolAcceptancePermit[];
    try{advertised=structuredClone(await host.acceptancePermit.advertise());}catch{open();return inactive();}open();
    if(!Array.isArray(advertised)||advertised.length>100||new Set(advertised.map(p=>p?.permitId)).size!==advertised.length)return inactive();
    const permits:ProtocolAcceptanceAdvertisement[]=[];
    for(const p of advertised){if(!validPermit(p))continue;try{permits.push({...p,remaining:permitRemaining(p)});}catch{/* Conflicting IDs never grant authority. */}}
    const available=permits.filter(p=>p.remaining>0),models=new Map<string,ContinuityCapabilities['models'][number]>();
    for(const p of available)models.set(canonical([p.scope.profile.agent,p.scope.profile.model]),{agent:p.scope.profile.agent,id:p.scope.profile.model,label:p.scope.profile.model});
    return {ready:available.length>0,scope:'room-backend',factsSelectionAvailable:true,models:[...models.values()],backends:backends.map(backend=>({backend,ready:available.some(p=>p.scope.room.backend===backend),...(!available.some(p=>p.scope.room.backend===backend)?{reason:'bounded_acceptance_unavailable'}:{})})),authorization:{purpose:'bounded-acceptance',permits}};
  };
  const makeAcceptanceOperation=(kind:ProtocolAcceptanceKind,id:string,room:Room,profile:ProtocolAcceptanceProfile,payloadHash:string):ProtocolAcceptanceOperation=>({kind,id,room:{...roomScope(room),revision:room.revision},profile,payloadHash});
  const authorizeAcceptance=async(operation:ProtocolAcceptanceOperation)=>{
    if(!host.acceptancePermit)fail('bounded_acceptance_required');let granted:Awaited<ReturnType<ProtocolAcceptanceAuthority['authorize']>>;
    try{granted=structuredClone(await host.acceptancePermit.authorize(Object.freeze(structuredClone(operation))));}catch{return fail('bounded_acceptance_denied');}open();
    const permit=granted?.permit;
    if(!permit||!validPermit(permit)||canonical(granted!.operation)!==canonical(operation)||!permitMatches(permit,{...operation.room} as Room,operation.profile,operation.kind))fail('bounded_acceptance_denied');
    permitRemaining(permit);return permit;
  };
  const consumeAcceptance=(operation:ProtocolAcceptanceOperation,permit:ProtocolAcceptancePermit,textHashes:string[])=>{
    if(!validPermit(permit))fail('bounded_acceptance_expired');const db=turns(),fingerprint=sha(canonical(operation)),prior=acceptanceRow(operation.kind,operation.room.id,operation.id);
    if(prior){if(prior.operation_hash!==fingerprint||prior.permit_id!==permit.permitId||prior.text_hashes!==canonical(textHashes))fail('acceptance_operation_conflict');return true;}
    if(permitRemaining(permit)<1)fail('acceptance_budget_exhausted');
    db.query('INSERT OR IGNORE INTO protocol_acceptance_permits(permit_id,definition_hash,body,last_seen) VALUES(?,?,?,?)').run(permit.permitId,sha(canonical(permit)),canonical(permit),time());
    db.query('UPDATE protocol_acceptance_permits SET last_seen=? WHERE permit_id=?').run(time(),permit.permitId);
    db.query('INSERT INTO protocol_acceptance_claims(kind,room_id,operation_id,permit_id,operation_hash,body,text_hashes) VALUES(?,?,?,?,?,?,?)').run(operation.kind,operation.room.id,operation.id,permit.permitId,fingerprint,canonical(operation),canonical(textHashes));return false;
  };
  const recheckAcceptance=async(saved:AcceptanceRow,room:Room,profile:ProtocolAcceptanceProfile,textHash?:string)=>{
    let operation:ProtocolAcceptanceOperation;try{operation=JSON.parse(saved.body);if(sha(canonical(operation))!==saved.operation_hash||operation.kind!==saved.kind||operation.id!==saved.operation_id||operation.room.id!==saved.room_id||operation.room.revision!==room.revision||canonical(roomScope(room))!==canonical(roomScope(operation.room as Room))||canonical(operation.profile)!==canonical(profile)||textHash&&!JSON.parse(saved.text_hashes).includes(textHash))fail('acceptance_operation_conflict');}catch{return fail('acceptance_operation_conflict');}
    const permit=await authorizeAcceptance(operation);if(permit.permitId!==saved.permit_id)fail('acceptance_operation_conflict');return permit;
  };
  const recheckAcceptanceBoundary=async(request:Parameters<typeof trustedAdmit>[0])=>{
    if(!host.acceptancePermit)return;
    const direct=acceptanceRow('text-turn',request.roomId,request.operationId),room=store.room(request.roomId);
    if(!room)return;const source=direct??(room.operationId===request.launchOperationId?acceptanceRow('switch',request.roomId,request.launchOperationId):null);
    if(source)await recheckAcceptance(source,room,protocolAcceptanceProfile(request.binding),request.textHash);
  };
  const owned:ProtocolOwnedService={
    inventory:async()=>{
      open();const rows=turns().query('SELECT room_id,scope FROM protocol_owned_rooms ORDER BY room_id LIMIT 1025').all() as {room_id:string;scope:string}[];
      if(rows.length>1024)fail('protocol_inventory_limit');
      const out:Array<{room:Room;transport:ProtocolOwnedStatus}>=[];
      for(const row of rows){
        const room=store.room(row.room_id);if(!room)continue;
        const scope={id:room.id,backend:room.backend,workspace:room.workspace,room:room.room,cwd:room.cwd};
        if(canonical(scope)!==row.scope)fail('protocol_inventory_scope_changed');
        out.push({room,transport:await owned.status(room)});
      }return out;
    },
    status:async room=>{
      current(room);const caps=await capabilities();current(room);const binding=structuredClone(room.bindings[room.active]!);
      let state:ProtocolOwnedStatus['state']='unavailable',profile:ProtocolAcceptanceProfile|undefined;
      const pending=turns().query("SELECT id FROM protocol_owned_turns WHERE room_id=? AND state IN ('dispatching','uncertain')").get(room.id);
      if(pending)state=activeTurns.has(room.id)?'busy':'uncertain';
      else if(registry.has(room.id)){
        if(activeTurns.has(room.id))state='busy';
        else try{const observed=await registry.get(room.id)!.inspect();current(room);
          if(observed.identity.cwd!==room.cwd||canonical(protocolRoomBinding(observed.identity,observed.generation,observed.binding,binding.cursor))!==canonical(binding))state='uncertain';
          else {state=observed.idle&&!observed.pendingApproval?'idle':'busy';profile=protocolAcceptanceProfile(observed.binding);}
        }catch(e){state=(e as any)?.code==='runtime_session_busy'?'busy':'uncertain';}
      }
      current(room);
      const stillPending=turns().query("SELECT id FROM protocol_owned_turns WHERE room_id=? AND state IN ('dispatching','uncertain')").get(room.id);
      if(stillPending)state=activeTurns.has(room.id)?'busy':'uncertain';
      return {kind:'owned-protocol',roomId:room.id,revision:room.revision,binding,state,
        capabilities:{textTurn:state==='idle'&&!room.operationId&&(productionAllowed(caps,room)||!!profile&&caps.authorization?.purpose==='bounded-acceptance'&&caps.authorization.permits.some(p=>p.expiresAt>time()&&p.remaining>0&&permitMatches(p,room,profile!,'text-turn'))),attachments:false,keys:false}};
    },
    turnStatus:async(room,id)=>{
      current(room);if(!text(id))fail('protocol_turn_invalid',400);const r=row(id);
      if(!r)return null;if(r.room_id!==room.id)fail('protocol_turn_scope_mismatch');return recorded(r);
    },
    turn:async(room,request)=>{
      current(room);request=structuredClone(request);
      if(!request||!text(request.id)||typeof request.text!=='string'||!request.text.trim()||request.text.includes('\0')||request.text.length>8000||Buffer.byteLength(request.text)>32_000
        ||!Number.isSafeInteger(request.expectedRevision)||request.expectedRevision<0||!request.binding)fail('protocol_turn_invalid',400);
      const payload={roomId:room.id,request},fingerprint=sha(canonical(payload));
      const existing=row(request.id);
      if(existing){if(existing.room_id!==room.id||existing.request_hash!==fingerprint)fail('protocol_turn_id_conflict');return recorded(existing);}
      const expected=room.bindings[room.active]!;
      if(request.expectedRevision!==room.revision||canonical(request.binding)!==canonical(expected))fail('protocol_turn_binding_changed');
      if(room.operationId)fail('operation_in_progress');
      if(turns().query("SELECT id FROM protocol_owned_turns WHERE room_id=? AND state IN ('dispatching','uncertain')").get(room.id))fail('protocol_turn_reconciliation_required');
      const caps=await capabilities();current(room);
      if(!productionAllowed(caps,room)&&!host.acceptancePermit)fail('live_continuity_not_certified',503);
      const concurrent=row(request.id);if(concurrent){if(concurrent.room_id!==room.id||concurrent.request_hash!==fingerprint)fail('protocol_turn_id_conflict');return recorded(concurrent);}
      const before=await verifyOwned(room);current(room);
      const acceptanceOperation=makeAcceptanceOperation('text-turn',request.id,room,protocolAcceptanceProfile(before.binding),fingerprint);
      const acceptanceGrant=productionAllowed(caps,room)?undefined:await authorizeAcceptance(acceptanceOperation);current(room);
      const db=turns();
      const claimed=db.transaction(()=>{
        const prior=row(request.id);
        if(prior){if(prior.room_id!==room.id||prior.request_hash!==fingerprint)fail('protocol_turn_id_conflict');return prior;}
        current(room);
        if(db.query("SELECT id FROM protocol_owned_turns WHERE room_id=? AND state IN ('dispatching','uncertain')").get(room.id))fail('protocol_turn_reconciliation_required');
        if(acceptanceGrant&&consumeAcceptance(acceptanceOperation,acceptanceGrant,[sha(canonical(request.text))]))fail('acceptance_turn_reconciliation_required');
        db.query("INSERT INTO protocol_owned_turns(id,room_id,request_hash,body,state) VALUES(?,?,?,?,'dispatching')").run(request.id,room.id,fingerprint,canonical(payload));return null;
      }).immediate();
      if(claimed)return recorded(claimed);
      activeTurns.add(room.id);
      try{
        current(room);const result=await registry.get(room.id)!.turn(request.id,request.text);
        const after=await verifyOwned(room);current(room);
        if(canonical(result.identity)!==canonical(after.identity)||result.generation!==after.generation
          ||after.generation!==before.generation||result.turn.operationId!==request.id||result.turn.nativeId!==expected.nativeId||result.turn.state!=='completed')fail('protocol_turn_receipt_unverified');
        const correlation={operationId:request.id,turnId:result.turn.turnId,generation:expected.generation,requestHash:fingerprint};
        const prefix='protocol-turn:'+sha(canonical([room.id,request.id]));
        const events:Omit<RoomEvent,'seq'>[]=[
          {sourceId:prefix+':user',agent:expected.agent,nativeId:expected.nativeId,role:'user',text:request.text,metadata:{...correlation,provenance:'host-authorized-user'}},
          {sourceId:prefix+':assistant',agent:expected.agent,nativeId:expected.nativeId,role:'assistant',text:result.turn.text,metadata:{...correlation,provenance:'native-protocol-final'}},
        ];
        // Exact room/revision/binding and both events commit together. Never partial user-only import.
        store.importHistory(room,events);
        const receipt:ProtocolOwnedTurnReceipt={id:request.id,roomId:room.id,binding:structuredClone(expected),state:'completed',source:result.source,turn:structuredClone(result.turn)};
        const saved=db.query("UPDATE protocol_owned_turns SET state='completed',receipt=? WHERE id=? AND state='dispatching'").run(canonical(receipt),request.id);
        if(saved.changes!==1)fail('protocol_turn_receipt_not_persisted');
        return receipt;
      }catch{
        try{db.query("UPDATE protocol_owned_turns SET state='uncertain' WHERE id=? AND state='dispatching'").run(request.id);}catch{}
        return {id:request.id,roomId:room.id,binding:structuredClone(expected),state:'uncertain',source:'live'};
      }finally{activeTurns.delete(room.id);}
    },
  };
  return {store,engine,archive,selections,factsUI,snapshot,bootstrapOwned,owned,
    featureOptions:{engine,resolveRoom,capabilities,factsUI,owned},
    close:async()=>{
      if(closed)return;if(closing)fail('protocol_service_closing');shutdownRequested=true;closing=true;
      try{
        const failures:string[]=[];
        for(const [roomId,runtime] of registry){
          try{await runtime.close();}catch{failures.push(roomId);}
        }
        // Keep shared ledgers open for reconciliation when any owned child lacks exit proof.
        // A failed room must never prevent attempts to clean up the remaining owned rooms.
        if(failures.length)fail('protocol_service_cleanup_failed',503);
        try{store.close();journal.close();turnDb?.close();}catch{fail('protocol_service_cleanup_failed',503);}
        turnDb=undefined;candidatePins.clear();closed=true;
      }finally{closing=false;}

    }};
}
