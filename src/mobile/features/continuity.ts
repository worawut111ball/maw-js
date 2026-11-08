import { t } from 'elysia';
import type { ContinuityEngine } from '../continuity/engine';
import { ContinuityError, type Backend, type Room } from '../continuity/types';

export interface ContinuityCapabilities {
  ready: boolean;
  backends: { backend: Backend; ready: boolean; reason?: string }[];
  models: { agent: 'codex'|'claude'; id: string; label: string }[];
}
export interface ContinuityFeatureOptions {
  engine: ContinuityEngine;
  resolveRoom: (workspace:string,room:string)=>Promise<Room|null>;
  capabilities: ()=>Promise<ContinuityCapabilities>;
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
  const ready=async()=>{
    const c=await caps();
    if(!c.ready || !(['herdr','tmux','superset'] as const).every(b=>c.backends.some(x=>x.backend===b&&x.ready)))throw new ContinuityError('all_backends_required',503);
    return c;
  };
  app.get('/continuity/capabilities',guarded(async()=>({ok:true,...await caps()})));
  app.get(base,guarded(async({params})=>{
    const room=await resolve(params);
    return {ok:true,room,operation:room.operationId?options!.engine.store.operation(room.operationId):options!.engine.store.latestOperation(room.id),held:options!.engine.store.held(room.id)};
  }));
  app.get(base+'/events',guarded(async({params,query})=>{
    const room=await resolve(params);
    return {ok:true,items:options!.engine.store.events(room.id,query.after??0,query.limit??100)};
  }),{query:t.Object({after:t.Optional(t.Numeric({minimum:0,maximum:Number.MAX_SAFE_INTEGER})),limit:t.Optional(t.Numeric({minimum:1,maximum:500}))})});
  app.post(base+'/switch',guarded(async({params,body})=>{
    const room=await resolve(params),c=await ready();
    if(body.model && !c.models.some(m=>m.agent===body.target&&m.id===body.model))throw new ContinuityError('model_unavailable');
    const operation=await options!.engine.request(room.id,body);
    // Durable request accepted. Advance is explicit; GET/poll never mutates a terminal.
    return {ok:true,operation};
  }),{body:t.Object({id,target:t.Union([t.Literal('codex'),t.Literal('claude')]),model:t.Optional(t.String({minLength:1,maxLength:160})),expectedRevision:t.Integer({minimum:0})})});
  app.post(base+'/operations/:operation/advance',guarded(async({params})=>{
    const room=await resolve(params);await ready();
    const op=options!.engine.store.operation(params.operation);
    if(!op || op.roomId!==room.id)throw new ContinuityError('operation_not_found',404);
    return {ok:true,operation:await options!.engine.advance(op.id)};
  }));
  app.post(base+'/operations/:operation/retry',guarded(async({params})=>{
    const room=await resolve(params);await ready();
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
    const room=await resolve(params);
    if(!room.operationId)throw new ContinuityError('no_switch_in_progress');
    const active=room.bindings[room.active];
    if(!active || active.generation!==body.intendedGeneration)throw new ContinuityError('agent_changed');
    return {ok:true,message:options!.engine.store.hold(room.id,body)};
  }),{body:t.Object({id,text:t.String({minLength:1,maxLength:100000}),intendedGeneration:t.String({minLength:1,maxLength:256})})});
}
