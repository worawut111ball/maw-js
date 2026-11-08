import { homedir } from 'node:os';
import { join } from 'node:path';
import { ContinuityArchive } from './archive';
import { buildContext, type ContextFacts } from './context';
import { ContinuityError, type Adapter, type Backend, type BeginRequest, type Binding, type Operation, type Room, type RoomEvent, type Store } from './types';

export interface EngineOptions {
  archiveRoot?: string;
  facts?: (room:Room) => Promise<ContextFacts>;
  maxContextBytes?: number;
}
const same = (a:Binding,b:Binding) => a.agent===b.agent && a.nativeId===b.nativeId && a.generation===b.generation && a.route===b.route && a.model===b.model;
const safe = (s:Awaited<ReturnType<Adapter['inspect']>>) => s.idle && !s.pendingTools && !s.pendingPermission && !s.uncertainDelivery;
/** Durable state before each irreversible boundary. Restart never blindly repeats launch/delivery. */
export class ContinuityEngine {
  private advancing = new Map<string,Promise<Operation>>();
  constructor(readonly store:Store, readonly adapters:Record<Backend,Adapter>, readonly options:EngineOptions={}) {}
  async request(roomId:string,request:BeginRequest):Promise<Operation> {
    return this.store.begin(roomId,request);
  }
  /** Explicit user retry only before launch. Uncertain effects require separate reconciliation. */
  async retry(id:string):Promise<Operation> {
    const op=this.required(id),room=this.store.room(op.roomId);
    if(!room || room.operationId!==id || op.state!=='blocked' || op.targetBinding)throw new ContinuityError('reconciliation_required');
    const live=await this.adapters[room.backend].inspect(room);
    if(!same(live.binding,op.from) || !safe(live))throw new ContinuityError('source_not_safe');
    const next={...op,state:'waiting-safe-point' as const,reason:undefined};
    if(!this.store.compareAndSave(next,'blocked'))throw new ContinuityError('operation_changed');
    return this.advance(id);
  }
  async cancel(id:string,expectedRevision:number):Promise<Room> {
    const op=this.required(id),room=this.store.room(op.roomId);
    if(op.state==='failed' && op.reason==='canceled_by_user')return this.store.cancel(id,expectedRevision);
    if(!room || room.operationId!==id || room.revision!==expectedRevision || !['waiting-safe-point','blocked'].includes(op.state) || op.targetBinding)throw new ContinuityError('reconciliation_required');
    const live=await this.adapters[room.backend].inspect(room);
    if(!same(live.binding,op.from) || !safe(live))throw new ContinuityError('source_not_safe');
    return this.store.cancel(id,expectedRevision);
  }
  advance(id:string):Promise<Operation> {
    const current=this.advancing.get(id);if(current)return current;
    const promise=this.run(id).finally(()=>this.advancing.delete(id));
    this.advancing.set(id,promise);return promise;
  }
  private required(id:string) { const op=this.store.operation(id); if(!op)throw new ContinuityError('operation_not_found',404);return op; }
  private allEvents(roomId:string):RoomEvent[] {
    const out:RoomEvent[]=[];let cursor=0;
    for(let page=0;page<2000;page++) {
      const items=this.store.events(roomId,cursor,500);
      if(!items.length)return out;
      if(items.some((e,i)=>e.seq<=(i?items[i-1].seq:cursor)))throw new ContinuityError('invalid_history_order');
      out.push(...items);cursor=items.at(-1)!.seq;
    }
    throw new ContinuityError('history_too_large_for_checkpoint');
  }
  private importCheckpoint(roomId:string,source:Binding,records:Omit<RoomEvent,'seq'>[]):number {
    if(records.some(e=>e.agent!==source.agent || e.nativeId!==source.nativeId))throw new ContinuityError('history_identity_changed');
    let count=0;
    for(let offset=0;offset<records.length;offset+=2000)count+=this.store.append(roomId,records.slice(offset,offset+2000)).length;
    return count;
  }
  private update(op:Operation,state:Operation['state'],reason?:string):Operation {
    const next={...op,state,reason};
    if(!this.store.compareAndSave(next,op.state))throw new ContinuityError('operation_changed');
    return next;
  }
  private async run(id:string):Promise<Operation> {
    let op=this.required(id);
    if(op.state!=='waiting-safe-point')return op; // durable in-flight states need explicit reconciliation, never replay
    const room=this.store.room(op.roomId);
    if(!room || room.operationId!==id)throw new ContinuityError('operation_changed');
    const adapter=this.adapters[room.backend];
    if(!adapter)return this.update(op,'blocked','backend_unavailable');
    // Read-only checks happen before the cross-process CAS claim.
    try {
      const preflight=await adapter.preflight(room,op.target,op.model);
      if(!preflight.ready)return this.update(op,'blocked',preflight.reason??'capability_unavailable');
      const live=await adapter.inspect(room);
      if(!same(live.binding,op.from))return this.update(op,'blocked','agent_changed');
      if(!safe(live))return op;
    }catch(e){
      if(e instanceof ContinuityError && e.code==='operation_changed')return this.required(id);
      return this.update(op,'blocked','preflight_unverifiable');
    }
    const claimed={...op,state:'checkpointed' as const};
    if(!this.store.compareAndSave(claimed,op.state))return this.required(id);
    op=claimed;
    try {
      const records=await adapter.checkpoint(room);
      // Reject history from a different native session instead of merging by pane/title.
      if(records.some(e=>e.agent!==op.from.agent || e.nativeId!==op.from.nativeId))return this.update(op,'blocked','history_identity_changed');
      this.importCheckpoint(room.id,op.from,records);
      const events=this.allEvents(room.id);
      const archive=new ContinuityArchive(this.options.archiveRoot??join(homedir(),'.maw','continuity','archive'));
      const archivePath=archive.snapshot(room.id,events);
      if(!this.options.facts)return this.update(op,'blocked','context_facts_unavailable');
      const facts=await this.options.facts(room);
      if(!facts.goal?.trim())return this.update(op,'blocked','context_goal_missing');
      const context=buildContext({room,binding:room.bindings[op.target],events,facts,handoffId:id,archivePath,maxBytes:this.options.maxContextBytes});
      // Events can arrive while preparing context. Revalidate the source before switching.
      const live=await adapter.inspect(room);
      if(!same(live.binding,op.from) || !safe(live))return this.update(op,'blocked','source_changed_during_checkpoint');
      const latest=await adapter.checkpoint(room);
      const inserted=this.importCheckpoint(room.id,op.from,latest);
      if(inserted)return this.update(op,'blocked','history_changed_during_checkpoint');
      op={...op,checkpointSeq:context.throughSeq,contextHash:context.hash};
      op=this.update(op,'preparing-target');
      let binding:Binding;
      try { binding=await adapter.launch(room,op.target,room.bindings[op.target],op.model); }
      catch { return this.update(op,'uncertain','launch_unverified_source_preserved'); }
      const existing=room.bindings[op.target];
      if(binding.agent!==op.target || !binding.nativeId || !binding.generation ||
        (existing && existing.nativeId!==binding.nativeId) || (op.model && binding.model!==op.model)) {
        return this.update(op,'uncertain',existing?'resume_identity_mismatch':'target_identity_unverified');
      }
      const targetRoom:Room={...room,active:op.target,bindings:{...room.bindings,[op.target]:binding}};
      const beforeDelivery=await adapter.inspect(targetRoom);
      if(!same(beforeDelivery.binding,binding) || !safe(beforeDelivery))return this.update(op,'uncertain','target_not_ready_for_context');
      op={...op,targetBinding:binding};op=this.update(op,'delivering-context');
      const receipt=await adapter.deliver(room,binding,{id,text:context.text,hash:context.hash,throughSeq:context.throughSeq});
      if(receipt.state!=='acknowledged' || receipt.nativeId!==binding.nativeId || receipt.hash!==context.hash || receipt.throughSeq!==context.throughSeq) {
        return this.update(op,'uncertain','context_receipt_unverified');
      }
      const afterDelivery=await adapter.inspect(targetRoom);
      if(!same(afterDelivery.binding,binding) || !safe(afterDelivery))return this.update(op,'uncertain','target_changed_during_context');
      this.store.complete(id,{...binding,cursor:context.throughSeq});
      return this.required(id);
    }catch(e){
      const current=this.required(id);
      if(current.state==='ready-awaiting-user')return current;
      const changed=current.state!==op.state;
      if(changed)return current;
      const afterEffect=['preparing-target','delivering-context'].includes(op.state);
      return this.update(op,afterEffect?'uncertain':'blocked',afterEffect?'side_effect_unverified':'checkpoint_unavailable');
    }
  }
}
