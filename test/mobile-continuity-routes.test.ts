import { describe,test,expect } from 'bun:test';
import { Elysia } from 'elysia';
import { mount, type ContinuityFeatureOptions } from '../src/mobile/features/continuity';
import { ContinuityStore } from '../src/mobile/continuity/store';
import { ContinuityEngine } from '../src/mobile/continuity/engine';
import { createMobileApi } from '../src/mobile/api';
import type { Room,Adapter } from '../src/mobile/continuity/types';
const room:Room={id:'r',workspace:'w',room:'p',backend:'tmux',cwd:'/project',revision:0,active:'codex',bindings:{codex:{agent:'codex',nativeId:'a',generation:'g',cursor:0}}};
function harness(ready=true){
 const store=new ContinuityStore(':memory:');store.register(room);
 const fail=async():Promise<any>=>{throw Error('must not touch runtime');};
 const adapter:Adapter={inspect:async()=>({binding:room.bindings.codex!,idle:true,pendingTools:false,pendingPermission:false,uncertainDelivery:false}),preflight:fail,checkpoint:fail,launch:fail,deliver:fail};
 const engine=new ContinuityEngine(store,{tmux:adapter,herdr:adapter,superset:adapter});
 const options:ContinuityFeatureOptions={engine,resolveRoom:async(w,p)=>w==='w'&&p==='p'?store.room('r'):null,capabilities:async()=>({ready:true,backends:[{backend:'tmux',ready:true},{backend:'herdr',ready:true},{backend:'superset',ready}],models:[{agent:'claude',id:'fixture-model',label:'Fixture model'}]})};
 const app=new Elysia();mount(app,options);
 const req=(path:string,body?:unknown)=>app.handle(new Request('http://localhost'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})}));
 return {store,req,adapter};
}
const path='/rooms/w/p/continuity';
describe('continuity route scope and rollout gate',()=>{
 test('explicit cancel before launch remains possible when release capability is disabled',async()=>{
  const h=harness(false);h.store.begin('r',{id:'op',target:'claude',expectedRevision:0});
  h.store.hold('r',{id:'draft',text:'เก็บไว้',intendedGeneration:'g'});
  const r=await h.req(path+'/operations/op/cancel',{expectedRevision:0});expect(r.status).toBe(200);
  expect((await h.req(path+'/operations/op/cancel',{expectedRevision:0})).status).toBe(200);
  expect(h.store.room('r')?.operationId).toBeUndefined();expect(h.store.room('r')?.revision).toBe(1);
  expect(h.store.held('r')).toHaveLength(1);expect(h.store.latestOperation('r')?.reason).toBe('canceled_by_user');h.store.close();
 });
 test('cancel cannot unlock after source replacement or uncertain side effects',async()=>{
  const h=harness();const op=h.store.begin('r',{id:'op',target:'claude',expectedRevision:0});
  h.adapter.inspect=async()=>({binding:{...op.from,generation:'replaced'},idle:true,pendingTools:false,pendingPermission:false,uncertainDelivery:false});
  expect((await h.req(path+'/operations/op/cancel',{expectedRevision:0})).status).toBe(409);
  h.store.saveOperation({...op,state:'uncertain'});
  expect((await h.req(path+'/operations/op/cancel',{expectedRevision:0})).status).toBe(409);
  expect((await h.req(path+'/operations/op/retry',{})).status).toBe(409);
  expect(h.store.room('r')?.operationId).toBe('op');h.store.close();
 });
 test('one uncertified backend blocks all switches before journal or runtime side effects',async()=>{
  const h=harness(false);const r=await h.req(path+'/switch',{id:'op',target:'claude',expectedRevision:0});
  expect(r.status).toBe(503);expect((await r.json()).code).toBe('all_backends_required');expect(h.store.operation('op')).toBeNull();h.store.close();
 });
 test('room revisions and request IDs survive HTTP retries without duplicating operation',async()=>{
  const h=harness();const body={id:'op',target:'claude',expectedRevision:0};
  expect((await h.req(path+'/switch',body)).status).toBe(200);expect((await h.req(path+'/switch',body)).status).toBe(200);
  expect((await h.req(path+'/switch',{...body,id:'other'})).status).toBe(409);
  expect(h.store.room('r')?.operationId).toBe('op');h.store.close();
 });
 test('other room cannot read or advance operation; model must come from capability response',async()=>{
  const h=harness();expect((await h.req(path+'/switch',{id:'op',target:'claude',model:'invented',expectedRevision:0})).status).toBe(409);
  expect((await h.req('/rooms/w/other/continuity/operations/op/advance',{})).status).toBe(404);h.store.close();
 });
 test('held message requires active operation and the intended source generation',async()=>{
  const h=harness();const message={id:'m',text:'อย่าส่งเอง',intendedGeneration:'g'};
  expect((await h.req(path+'/held',message)).status).toBe(409);
  await h.req(path+'/switch',{id:'op',target:'claude',expectedRevision:0});
  expect((await h.req(path+'/held',{...message,intendedGeneration:'wrong'})).status).toBe(409);
  expect((await h.req(path+'/held',message)).status).toBe(200);expect(h.store.held('r')).toEqual([message]);h.store.close();
 });
 test('real mobile auth protects disabled production capability and mutation endpoints',async()=>{
  const app=createMobileApi({token:'synthetic-token',hookToken:'synthetic-hook',allowedLogins:[]});
  const request=(path:string,auth=false,post=false)=>app.handle(new Request('http://localhost/mobile'+path,{method:post?'POST':'GET',headers:{...(auth?{authorization:'Bearer synthetic-token'}:{}),...(post?{'content-type':'application/json'}:{})},...(post?{body:JSON.stringify({id:'op',target:'claude',expectedRevision:0})}:{})}));
  expect((await request('/continuity/capabilities')).status).toBe(401);
  expect((await request(path+'/switch',false,true)).status).toBe(401);
  const r=await request('/continuity/capabilities',true);expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toContain('no-store');expect((await r.json()).ready).toBe(false);
  expect((await request(path+'/switch',true,true)).status).toBe(503);
 });
});
