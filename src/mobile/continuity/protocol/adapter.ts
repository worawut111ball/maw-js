import {ContinuityError,type Adapter,type Room,type Binding,type AgentKind,type ContextDelivery,type DeliveryReceipt,type RoomEvent} from '../types';
import type {ProtocolRuntimeCandidate} from './entry';
import type {ProtocolRuntimeHost,RuntimeStartReceipt} from './runtime-host';
import {createHash} from 'node:crypto';
import type {ProtocolRuntimeBinding} from './entry';

export interface ProtocolAdapterPorts {
  /** Host registry contains owned protocol processes only, never agents discovered by title/pane. */
  runtime(roomId:string):ProtocolRuntimeHost|undefined;
  install(roomId:string,runtime:ProtocolRuntimeHost):void;
  create():ProtocolRuntimeHost;
  preflight(room:Room,target:AgentKind,model?:string):Promise<{ready:boolean;reason?:string}>;
  candidate(room:Room,target:AgentKind,existing:Binding|undefined,model?:string):Promise<ProtocolRuntimeCandidate>;
  history(room:Room,binding:Binding):Promise<Omit<RoomEvent,'seq'>[]>;
  /** Exact native turn verification, never inferred from a model's acknowledgement text. */
  verifyContext(room:Room,binding:Binding,context:ContextDelivery,start:RuntimeStartReceipt):Promise<DeliveryReceipt>;
  timeoutMs:number;
}
export function protocolNamespace(b:ProtocolRuntimeBinding):string {
  if(!b||![2,3].includes(b.version)||!b.home?.startsWith('/')||!b.effectiveToolHome?.startsWith('/')||!b.homeEnvironment)
    throw new ContinuityError('protocol_namespace_unverified');
  return createHash('sha256').update(JSON.stringify([b.kind,b.home,b.effectiveToolHome,b.homeEnvironment.state,
    b.homeEnvironment.state==='present'?b.homeEnvironment.value:null,b.provider,b.endpoint,
    b.version===3?b.pilotPolicy:null,b.version===3?b.policyArgvHash:null])).digest('hex');
}
export const protocolRoomBinding=(identity:{agent:AgentKind;nativeId:string;model:string;route:string},generation:number,entry:ProtocolRuntimeBinding,cursor=0):Binding=>
  ({agent:identity.agent,nativeId:identity.nativeId,model:identity.model,route:identity.route,generation:`protocol:${identity.agent}:${protocolNamespace(entry)}:${generation}`,cursor});
const same=(a:Binding,b:Binding)=>a.agent===b.agent&&a.nativeId===b.nativeId&&a.generation===b.generation&&a.model===b.model&&a.route===b.route;
/** ContinuityEngine seam for owned protocol rooms. No shared-TUI takeover or implicit adoption. */
export class ProtocolContinuityAdapter implements Adapter {
  constructor(private ports:ProtocolAdapterPorts){}
  async targetPolicy(room:Room,target:AgentKind,existing?:Binding,model?:string){
    const c=await this.ports.candidate(structuredClone(room),target,existing&&structuredClone(existing),model);
    if(c.tool!==target)throw new ContinuityError('protocol_candidate_scope_mismatch');
    return {agent:target,model:c.binding.model,route:c.binding.route};
  }
  private host(room:Room){const host=this.ports.runtime(room.id);if(!host)throw new ContinuityError('protocol_room_not_owned');return host;}
  async inspect(room:Room){
    const observed=await this.host(room).inspect();
    const binding=protocolRoomBinding(observed.identity,observed.generation,observed.binding,room.bindings[room.active]?.cursor??0);
    return {binding,idle:observed.idle,pendingTools:!observed.idle,pendingPermission:observed.pendingApproval,uncertainDelivery:false};
  }
  async preflight(room:Room,target:AgentKind,model?:string){
    if(!this.ports.runtime(room.id))return {ready:false,reason:'protocol_room_not_owned'};
    return this.ports.preflight(structuredClone(room),target,model);
  }
  async checkpoint(room:Room){
    const current=await this.inspect(room),expected=room.bindings[room.active];
    if(!expected||!same(current.binding,expected)||!current.idle||current.pendingPermission)throw new ContinuityError('source_not_safe');
    return this.ports.history(structuredClone(room),structuredClone(expected));
  }
  async launch():Promise<Binding>{throw new ContinuityError('protocol_staged_launch_required');}
  async deliver():Promise<DeliveryReceipt>{throw new ContinuityError('protocol_staged_delivery_required');}
  async launchWithContext(room:Room,target:AgentKind,context:ContextDelivery,existing?:Binding,model?:string){
    if(Buffer.byteLength(context.text)>32_000)throw new ContinuityError('protocol_context_too_large');
    const preflight=await this.preflight(room,target,model);
    if(!preflight.ready)throw new ContinuityError(preflight.reason??'protocol_preflight_unverified');
    const candidate=await this.ports.candidate(structuredClone(room),target,existing&&structuredClone(existing),model);
    if(candidate.tool!==target||candidate.cwd!==room.cwd||(model&&candidate.model!==model)
      ||(existing?(candidate.session.mode!=='resume'||candidate.session.id!==existing.nativeId):candidate.session.mode!=='fresh'))
      throw new ContinuityError('protocol_candidate_scope_mismatch');
    if(existing && existing.generation.split(':')[2]!==protocolNamespace(candidate.binding))
      throw new ContinuityError('protocol_resume_namespace_mismatch');
    const source=this.host(room),before=await this.inspect(room);
    if(!room.bindings[room.active]||!same(before.binding,room.bindings[room.active]!)||!before.idle||before.pendingPermission)
      throw new ContinuityError('source_not_safe');
    // close waits for trusted exact owned exit; never infer exit from screen/EOF.
    await source.close();
    const next=this.ports.create();this.ports.install(room.id,next);
    const start=await next.startWithContext({roomId:room.id,operationId:context.id,candidate,timeoutMs:this.ports.timeoutMs,
      writer:'owned-protocol-child',firstTurn:{operationId:context.id+':context',text:context.text}});
    if(start.source!=='live'||!start.firstTurn)throw new ContinuityError('protocol_historical_not_ready');
    const binding=protocolRoomBinding(start.identity,start.generation,candidate.binding,existing?.cursor??0);
    const receipt=await this.ports.verifyContext(structuredClone(room),binding,structuredClone(context),start);
    return {binding,receipt};
  }
}
