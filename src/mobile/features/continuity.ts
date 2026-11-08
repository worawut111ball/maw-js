import { t } from 'elysia';
import type { ContinuityEngine } from '../continuity/engine';
import { ContinuityError, type Backend, type Room, type Binding } from '../continuity/types';
import type {ProtocolTurn} from '../continuity/protocol/types';

export interface OwnedTransportStatus {
  kind:'owned-protocol';roomId:string;revision:number;binding:Binding;
  state:'idle'|'busy'|'uncertain'|'unavailable';
  capabilities:{textTurn:boolean;attachments:false;keys:false};
}
export interface OwnedTurnRequest {id:string;text:string;expectedRevision:number;binding:Binding}
export interface OwnedTurnReceipt {
  id:string;roomId:string;binding:Binding;state:'completed'|'uncertain';source:'live'|'historical';turn?:ProtocolTurn;
}

export interface ContinuityCapabilities {
  ready: boolean;
  /** Explicit rollout scope; omitted retains the original all-backend gate. */
  scope?:'all-backends'|'room-backend';
  factsSelectionAvailable?:boolean;
  backends: { backend: Backend; ready: boolean; reason?: string }[];
  models: { agent: 'codex'|'claude'; id: string; label: string }[];
}
export interface ContinuityFeatureOptions {
  engine: ContinuityEngine;
  resolveRoom: (workspace:string,room:string)=>Promise<Room|null>;
  capabilities: ()=>Promise<ContinuityCapabilities>;
  /** Trusted host implementation, never constructed from request/model input. */
  factsUI?: {
    preview(room:Room):Promise<unknown>;
    approve(room:Room,request:{id:string;previewId:string;expectedRevision:number;selections:any[]}):Promise<unknown>;
    verify(room:Room,selectionId:string):Promise<void>;
  };
  owned?: {
    inventory?():Promise<{room:Room;transport:OwnedTransportStatus}[]>;
    status(room:Room):Promise<OwnedTransportStatus>;
    turn(room:Room,request:OwnedTurnRequest):Promise<OwnedTurnReceipt>;
    turnStatus(room:Room,id:string):Promise<OwnedTurnReceipt|null>;
  };
}
export const unavailableCapabilities = ():ContinuityCapabilities => ({ready:false,models:[],backends:(['herdr','tmux','superset'] as const).map(backend=>({backend,ready:false,reason:'live_continuity_not_certified'}))});
const id=t.String({minLength:1,maxLength:160,pattern:'^[a-zA-Z0-9_.:-]+$'});
const base='/rooms/:ws/:room/continuity';
/** Mounted behind the existing mobile auth hook; no filesystem/CLI activity on import. */
export function mount(app:any,options?:ContinuityFeatureOptions):void {
  const caps=async()=>options?options.capabilities():unavailableCapabilities();
  const resolve=async(params:any)=>{
    if(!options)throw new ContinuityError('continuity_not_ready',503);
    const room=await options.resolveRoom(params.ws,params.room);
    if(!room || room.workspace!==params.ws || room.room!==params.room)throw new ContinuityError('room_not_found',404);
    return room;
  };
  const guarded=(fn:(ctx:any)=>Promise<any>)=>async(ctx:any)=>{
    ctx.set.headers['cache-control']='no-store';
    try{return await fn(ctx);}catch(e){
      ctx.set.status=e instanceof ContinuityError?e.status:500;
      return {ok:false,code:e instanceof ContinuityError?e.code:'continuity_internal_error'};
    }
  };
  const ready=async(room:Room)=>{
    const c=await caps();
    if(c.scope==='room-backend') {
      if(!c.ready || !c.backends.some(b=>b.backend===room.backend&&b.ready))throw new ContinuityError('room_backend_not_ready',503);
    } else if(!c.ready || !(['herdr','tmux','superset'] as const).every(b=>c.backends.some(x=>x.backend===b&&x.ready)))throw new ContinuityError('all_backends_required',503);
    return c;
  };
  app.get('/continuity/capabilities',guarded(async()=>({ok:true,...await caps(),roomStateAvailable:Boolean(options)})));
  app.get(base,guarded(async({params})=>{
    const room=await resolve(params);
    return {ok:true,room,operation:room.operationId?options!.engine.store.operation(room.operationId):options!.engine.store.latestOperation(room.id),held:options!.engine.store.held(room.id)};
  }));
  app.get(base+'/events',guarded(async({params,query})=>{
    const room=await resolve(params);
    return {ok:true,items:options!.engine.store.events(room.id,query.after??0,query.limit??100)};
  }),{query:t.Object({after:t.Optional(t.Numeric({minimum:0,maximum:Number.MAX_SAFE_INTEGER})),limit:t.Optional(t.Numeric({minimum:1,maximum:500}))})});
  app.get(base+'/transport',guarded(async({params})=>{
    const room=await resolve(params);
    if(!options!.owned)throw new ContinuityError('owned_transport_unavailable',503);
    return {ok:true,transport:await options!.owned.status(room)};
  }));
  const ownedBinding=t.Object({agent:t.Union([t.Literal('codex'),t.Literal('claude')]),
    nativeId:t.String({minLength:1,maxLength:1024}),generation:t.String({minLength:1,maxLength:1024}),
    cursor:t.Integer({minimum:0}),model:t.Optional(t.String({minLength:1,maxLength:160})),
    route:t.Optional(t.String({minLength:1,maxLength:160}))},{additionalProperties:false});
  app.post(base+'/turns',guarded(async({params,body})=>{
    const room=await resolve(params);
    if(!options!.owned)throw new ContinuityError('owned_transport_unavailable',503);
    // Service handles durable exact replay before present-time revision/readiness checks.
    // Historical completion never grants permission to dispatch a fresh turn.
    return {ok:true,receipt:await options!.owned.turn(room,body)};
  }),{body:t.Object({id,text:t.String({minLength:1,maxLength:8000}),expectedRevision:t.Integer({minimum:0}),binding:ownedBinding},{additionalProperties:false})});
  app.get(base+'/turns/:turn',guarded(async({params})=>{
    const room=await resolve(params);
    if(!options!.owned)throw new ContinuityError('owned_transport_unavailable',503);
    const receipt=await options!.owned.turnStatus(room,params.turn);
    if(!receipt)throw new ContinuityError('turn_not_found',404);
    return {ok:true,receipt};
  }),{params:t.Object({ws:t.String(),room:t.String(),turn:id})});
  app.get(base+'/facts/preview',guarded(async({params})=>{
    const room=await resolve(params);
    if(!options!.factsUI)throw new ContinuityError('facts_selection_unavailable',503);
    return {ok:true,preview:await options!.factsUI.preview(room)};
  }));
  const reference=t.String({minLength:1,maxLength:1024,pattern:'^[^\\u0000\\r\\n]+$'});
  const pick=t.Object({field:t.Union(['goal','constraints','decisions','pendingTasks','fileState','checks'].map(x=>t.Literal(x))),seq:t.Integer({minimum:1}),sourceId:reference,agent:t.Union([t.Literal('codex'),t.Literal('claude')]),nativeId:reference,eventHash:t.String({pattern:'^[a-f0-9]{64}$'})},{additionalProperties:false});
  app.post(base+'/facts/selections',guarded(async({params,body})=>{
    const room=await resolve(params);
    if(!options!.factsUI)throw new ContinuityError('facts_selection_unavailable',503);
    if(body.expectedRevision!==room.revision)throw new ContinuityError('stale_room_revision');
    return {ok:true,selection:await options!.factsUI.approve(room,body)};
  }),{body:t.Object({id,previewId:id,expectedRevision:t.Integer({minimum:0}),selections:t.Array(pick,{minItems:1,maxItems:256})},{additionalProperties:false})});
  app.post(base+'/switch',guarded(async({params,body})=>{
    const room=await resolve(params);
    // Existing exact intent is historical; store.begin checks room+full fingerprint before
    // current revision. No fresh facts/preflight/runtime dispatch on a lost HTTP ACK retry.
    if(options!.engine.store.operation(body.id))return {ok:true,operation:await options!.engine.request(room.id,body)};
    const c=await ready(room);
    if(body.model && !c.models.some(m=>m.agent===body.target&&m.id===body.model))throw new ContinuityError('model_unavailable');
    if(options!.factsUI || body.factsSelectionId!==undefined) {
      if(!options!.factsUI)throw new ContinuityError('facts_selection_unavailable',503);
      if(body.factsSelectionId!==body.id)throw new ContinuityError('facts_selection_scope_mismatch');
      await options!.factsUI.verify(room,body.factsSelectionId);
    }
    const operation=await options!.engine.request(room.id,body);
    // Durable request accepted. Advance is explicit; GET/poll never mutates a terminal.
    return {ok:true,operation};
  }),{body:t.Object({id,target:t.Union([t.Literal('codex'),t.Literal('claude')]),model:t.Optional(t.String({minLength:1,maxLength:160})),expectedRevision:t.Integer({minimum:0}),factsSelectionId:t.Optional(id)},{additionalProperties:false})});
  app.post(base+'/operations/:operation/advance',guarded(async({params})=>{
    const room=await resolve(params);await ready(room);
    const op=options!.engine.store.operation(params.operation);
    if(!op || op.roomId!==room.id)throw new ContinuityError('operation_not_found',404);
    return {ok:true,operation:await options!.engine.advance(op.id)};
  }));
  app.get(base+'/operations/:operation',guarded(async({params})=>{
    const room=await resolve(params);
    const operation=options!.engine.store.operation(params.operation);
    if(!operation || operation.roomId!==room.id)throw new ContinuityError('operation_not_found',404);
    return {ok:true,operation}; // Historical status only; GET never advances or grants native readiness.
  }));
  app.post(base+'/operations/:operation/retry',guarded(async({params})=>{
    const room=await resolve(params);await ready(room);
    const op=options!.engine.store.operation(params.operation);
    if(!op || op.roomId!==room.id)throw new ContinuityError('operation_not_found',404);
    return {ok:true,operation:await options!.engine.retry(op.id)};
  }));
  app.post(base+'/operations/:operation/cancel',guarded(async({params,body})=>{
    const room=await resolve(params);
    const op=options!.engine.store.operation(params.operation);
    if(!op || op.roomId!==room.id)throw new ContinuityError('operation_not_found',404);
    return {ok:true,room:await options!.engine.cancel(op.id,body.expectedRevision)};
  }),{body:t.Object({expectedRevision:t.Integer({minimum:0})})});
  app.post(base+'/held',guarded(async({params,body})=>{
    // Resolve auth/scope here; the store owns atomic operation/revision/binding checks and exact replay.
    // A completed/canceled operation may still have a committed held receipt after a lost HTTP ACK.
    const room=await resolve(params);
    return {ok:true,message:options!.engine.store.holdForOperation(room.id,{
      id:body.id,text:body.text,intendedGeneration:body.intendedGeneration,
      expectedOperationId:body.expectedOperationId,expectedRevision:body.expectedRevision,
    })};
  }),{body:t.Object({id,text:t.String({minLength:1,maxLength:8000}),intendedGeneration:t.String({minLength:1,maxLength:256}),expectedOperationId:id,expectedRevision:t.Integer({minimum:0})},{additionalProperties:false})});
}
