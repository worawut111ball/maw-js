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
 const runtimeCalls:string[]=[];
 const fail=async():Promise<any>=>{runtimeCalls.push('runtime');throw Error('must not touch runtime');};
 const adapter:Adapter={inspect:async()=>{runtimeCalls.push('inspect');return {binding:room.bindings.codex!,idle:true,pendingTools:false,pendingPermission:false,uncertainDelivery:false};},preflight:fail,checkpoint:fail,launch:fail,deliver:fail};
 const engine=new ContinuityEngine(store,{tmux:adapter,herdr:adapter,superset:adapter});
 const options:ContinuityFeatureOptions={engine,resolveRoom:async(w,p)=>w==='w'&&p==='p'?store.room('r'):null,capabilities:async()=>({ready:true,backends:[{backend:'tmux',ready:true},{backend:'herdr',ready:true},{backend:'superset',ready}],models:[{agent:'claude',id:'fixture-model',label:'Fixture model'}]})};
 const app=new Elysia();mount(app,options);
 const req=(path:string,body?:unknown)=>app.handle(new Request('http://localhost'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})}));
 return {store,req,adapter,options,runtimeCalls};
}
const path='/rooms/w/p/continuity';
describe('owned protocol routes never fall through to legacy transport',()=>{
 test('missing transport is explicit unavailable and cross-room lookup is rejected',async()=>{
  const h=harness();
  expect((await h.req(path+'/transport')).status).toBe(503);
  expect((await h.req(path+'/turns',{id:'turn',text:'hello',expectedRevision:0,binding:room.bindings.codex})).status).toBe(503);
  expect((await h.req('/rooms/foreign/p/continuity/turns/turn')).status).toBe(404);
  expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 test('exact turn lookup is read-only and historical receipts remain readable with switch gate off',async()=>{
  const h=harness(false);let sends=0,reads=0;
  const receipt={id:'turn',roomId:'r',binding:room.bindings.codex!,state:'completed' as const,source:'historical' as const};
  h.options.owned={status:async()=>({kind:'owned-protocol',roomId:'r',revision:0,binding:room.bindings.codex!,state:'idle',capabilities:{textTurn:false,attachments:false,keys:false}}),
   turn:async(_room,request)=>{sends++;expect(request.id).toBe('turn');return receipt;},
   turnStatus:async(_room,id)=>{reads++;return id==='turn'?receipt:null;}};
  expect((await h.req(path+'/turns/turn')).status).toBe(200);
  expect((await h.req(path+'/turns/missing')).status).toBe(404);expect(reads).toBe(2);expect(sends).toBe(0);
  const response=await h.req(path+'/turns',{id:'turn',text:'hello',expectedRevision:0,binding:room.bindings.codex});
  expect(response.status).toBe(200);expect((await response.json()).receipt.source).toBe('historical');expect(sends).toBe(1);
  expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 test('turn validation rejects malformed bindings before service invocation',async()=>{
  const h=harness();let calls=0;
  h.options.owned={status:async()=>{throw Error('unused');},turnStatus:async()=>null,turn:async()=>{calls++;throw Error('unused');}};
  expect((await h.req(path+'/turns',{id:'turn',text:'hello',expectedRevision:0,binding:{...room.bindings.codex,cursor:-1}})).status).toBe(422);
  expect((await h.req(path+'/turns',{id:'turn',text:'',expectedRevision:0,binding:room.bindings.codex})).status).toBe(422);
  expect(calls).toBe(0);h.store.close();
 });
});
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
 test('real mobile auth protects disabled production capability and mutation endpoints',async()=>{
  const app=createMobileApi({token:'synthetic-token',hookToken:'synthetic-hook',allowedLogins:[]});
  const request=(path:string,auth=false,post=false)=>app.handle(new Request('http://localhost/mobile'+path,{method:post?'POST':'GET',headers:{...(auth?{authorization:'Bearer synthetic-token'}:{}),...(post?{'content-type':'application/json'}:{})},...(post?{body:JSON.stringify({id:'op',target:'claude',expectedRevision:0})}:{})}));
  expect((await request('/continuity/capabilities')).status).toBe(401);
  expect((await request(path+'/switch',false,true)).status).toBe(401);
  const r=await request('/continuity/capabilities',true);expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toContain('no-store');expect((await r.json()).ready).toBe(false);
  expect((await request(path+'/switch',true,true)).status).toBe(503);
 });
});


const heldBody={id:'held-message',text:'พักไว้ ห้ามส่งอัตโนมัติ',intendedGeneration:'g',expectedOperationId:'op',expectedRevision:0};
function beginHeld(h:ReturnType<typeof harness>){return h.store.begin('r',{id:'op',target:'claude',expectedRevision:0});}
function finishHeld(h:ReturnType<typeof harness>){
 const op=h.store.operation('op')!;
 const target={agent:'claude' as const,nativeId:'fixture-claude-native',generation:'fixture-claude-generation',cursor:0};
 const checkpoint={...op,state:'checkpointed' as const,checkpointSeq:0,contextHash:'fixture-context-hash'};
 h.store.saveOperation(checkpoint);h.store.saveOperation({...checkpoint,state:'preparing-target'});
 h.store.saveOperation({...checkpoint,state:'delivering-context',targetBinding:target});
 return h.store.complete(op.id,target);
}
describe('atomic held operation route — durable storage only',()=>{
 test('unknown workspace/room cannot create or replay a receipt',async()=>{
  const h=harness();beginHeld(h);expect((await h.req(path+'/held',heldBody)).status).toBe(200);
  for(const unknown of ['/rooms/foreign/p/continuity/held','/rooms/w/foreign/continuity/held']){
   const response=await h.req(unknown,heldBody);expect(response.status).toBe(404);expect((await response.json()).code).toBe('room_not_found');
  }
  expect(h.store.held('r')).toHaveLength(1);expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 test('resolver returning a mismatched physical scope is rejected',async()=>{
  const h=harness();beginHeld(h);h.options.resolveRoom=async()=>({...h.store.room('r')!,workspace:'foreign'});
  expect((await h.req(path+'/held',heldBody)).status).toBe(404);expect(h.store.held('r')).toEqual([]);expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 test.each([
  ['revision',{expectedRevision:1},'stale_room_revision'],['operation',{expectedOperationId:'other-op'},'operation_changed'],['generation',{intendedGeneration:'new-generation'},'target_changed'],
 ] as const)('stale %s fails without saving or dispatching',async(_kind,change,code)=>{
  const h=harness();beginHeld(h);const response=await h.req(path+'/held',{...heldBody,...change});
  expect(response.status).toBe(409);expect(await response.json()).toEqual({ok:false,code});expect(h.store.held('r')).toEqual([]);expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 test('source provenance/binding comes from server and no requested target is forwarded',async()=>{
  const h=harness(false);beginHeld(h);
  const captured:unknown[]=[];const atomic=h.store.holdForOperation.bind(h.store);
  h.store.holdForOperation=(roomId,input)=>{captured.push({roomId,input});return atomic(roomId,input);};
  const response=await h.req(path+'/held',{...heldBody,target:'claude',intendedBinding:{agent:'claude',nativeId:'forged',generation:'forged'},originOperationId:'forged',originRevision:999,version:2});
  // Elysia may strip unknown fields; none may reach the atomic store or become provenance.
  expect(response.status).toBe(200);const data=await response.json();
  expect(captured).toEqual([{roomId:'r',input:heldBody}]);expect(data.message).toMatchObject({id:heldBody.id,text:heldBody.text,intendedGeneration:'g',version:2,originOperationId:'op',originRevision:0,intendedBinding:{agent:'codex',nativeId:'a',generation:'g'}});
  expect(JSON.stringify(data.message)).not.toContain('forged');expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 for(const ending of ['cancel','complete'] as const){
  test(`exact HTTP replay after ${ending} returns original receipt, fresh ID is rejected`,async()=>{
   const h=harness(false);beginHeld(h);
   const first=await h.req(path+'/held',heldBody);expect(first.status).toBe(200);const saved=await first.json();
   if(ending==='cancel')h.store.cancel('op',0);else finishHeld(h);
   const after=h.store.room('r');expect(after?.operationId).toBeUndefined();expect(after?.revision).toBe(1);
   const replay=await h.req(path+'/held',heldBody);expect(replay.status).toBe(200);expect(await replay.json()).toEqual(saved);
   const fresh=await h.req(path+'/held',{...heldBody,id:'fresh-message'});expect(fresh.status).toBe(409);
   expect(h.store.held('r')).toHaveLength(1);expect(h.store.room('r')).toEqual(after);expect(h.runtimeCalls).toEqual([]);h.store.close();
  });
 }
 test('exact replay does not attach to or modify a newer operation',async()=>{
  const h=harness();beginHeld(h);const saved=await (await h.req(path+'/held',heldBody)).json();h.store.cancel('op',0);
  h.store.begin('r',{id:'new-op',target:'claude',expectedRevision:1});
  const replay=await h.req(path+'/held',heldBody);expect(replay.status).toBe(200);expect(await replay.json()).toEqual(saved);
  expect(h.store.room('r')?.operationId).toBe('new-op');expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 test('same held ID with changed text/generation/operation/revision conflicts rather than retargeting',async()=>{
  const h=harness();beginHeld(h);expect((await h.req(path+'/held',heldBody)).status).toBe(200);
  for(const change of [{text:'เปลี่ยนข้อความ'},{intendedGeneration:'new-gen'},{expectedOperationId:'other-op'},{expectedRevision:1}]){
   expect((await h.req(path+'/held',{...heldBody,...change})).status).toBe(409);
  }
  expect(h.store.held('r')).toHaveLength(1);expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 test('fresh held request without active operation is rejected without runtime inspection',async()=>{
  const h=harness();const response=await h.req(path+'/held',heldBody);expect(response.status).toBe(409);expect(h.store.held('r')).toEqual([]);expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 test('schema requires operation/revision, bounded text and valid IDs before atomic invocation',async()=>{
  const h=harness();beginHeld(h);let atomicCalls=0;const atomic=h.store.holdForOperation.bind(h.store);
  h.store.holdForOperation=(roomId,input)=>{atomicCalls++;return atomic(roomId,input);};
  const {expectedOperationId,...withoutOperation}=heldBody,{expectedRevision,...withoutRevision}=heldBody;
  for(const body of [withoutOperation,withoutRevision,{...heldBody,id:''},{...heldBody,id:'invalid/id'},{...heldBody,expectedOperationId:''},{...heldBody,expectedOperationId:'invalid/op'},{...heldBody,expectedRevision:-1},{...heldBody,expectedRevision:0.5},{...heldBody,text:''},{...heldBody,text:'x'.repeat(8001)}]){
   expect((await h.req(path+'/held',body)).status).toBe(422);
  }
  expect(atomicCalls).toBe(0);expect(h.store.held('r')).toEqual([]);expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 test('8000 characters are accepted with no-store response and no dispatch',async()=>{
  const h=harness(false);beginHeld(h);const response=await h.req(path+'/held',{...heldBody,text:'x'.repeat(8000)});
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');expect(h.store.held('r')).toHaveLength(1);expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 test('real mobile auth is still required for held POST and scope is not bootstrapped',async()=>{
  const app=createMobileApi({token:'synthetic-token',hookToken:'synthetic-hook',allowedLogins:[]});
  const request=(auth:boolean)=>app.handle(new Request('http://localhost/mobile'+path+'/held',{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer synthetic-token'}:{})},body:JSON.stringify(heldBody)}));
  expect((await request(false)).status).toBe(401);const response=await request(true);expect(response.status).toBe(503);expect((await response.json()).code).toBe('continuity_not_ready');
 });
});


describe('held route delegates freshness to the atomic store rather than resolver snapshots',()=>{
 test('stale scope snapshot without operation does not block valid current held acceptance',async()=>{
  const h=harness(),snapshot=h.store.room('r')!;beginHeld(h);h.options.resolveRoom=async()=>snapshot;
  const response=await h.req(path+'/held',heldBody);expect(response.status).toBe(200);const data=await response.json();
  expect(data.message.originOperationId).toBe('op');expect(data.message.intendedBinding).toEqual({agent:'codex',nativeId:'a',generation:'g'});
  expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 test('cancel after resolve snapshot rejects a fresh held ID at the store boundary',async()=>{
  const h=harness();beginHeld(h);h.options.resolveRoom=async()=>{const snapshot=h.store.room('r');h.store.cancel('op',0);return snapshot;};
  const response=await h.req(path+'/held',heldBody);expect(response.status).toBe(409);expect((await response.json()).code).toBe('no_switch_in_progress');
  expect(h.store.held('r')).toEqual([]);expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
});

describe('explicit one-backend rollout scope',()=>{
 test('selected ready backend may accept request only with explicit room-backend scope',async()=>{
  const h=harness(false);const capabilities=h.options.capabilities;
  h.options.capabilities=async()=>({...await capabilities(),scope:'room-backend'});
  const response=await h.req(path+'/switch',{id:'pilot',target:'claude',expectedRevision:0});
  expect(response.status).toBe(200);expect(h.store.operation('pilot')).not.toBeNull();
  expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 test('other ready backend cannot authorize the current room or bypass global disabled state',async()=>{
  for(const disabled of ['selected','global']){
   const h=harness();const capabilities=h.options.capabilities;
   h.options.capabilities=async()=>{const c=await capabilities();return {...c,scope:'room-backend',ready:disabled!=='global',backends:c.backends.map(b=>({...b,ready:disabled==='selected'?b.backend!=='tmux':true}))};};
   const response=await h.req(path+'/switch',{id:'blocked',target:'claude',expectedRevision:0});
   expect(response.status).toBe(503);expect((await response.json()).code).toBe('room_backend_not_ready');
   expect(h.store.operation('blocked')).toBeNull();expect(h.runtimeCalls).toEqual([]);h.store.close();
  }
 });
});

describe('explicit facts selection routes',()=>{
 test('missing facts service returns unavailable without creating runtime work',async()=>{
  const h=harness();expect((await h.req(path+'/facts/preview')).status).toBe(503);
  expect((await h.req(path+'/switch',{id:'op',target:'claude',expectedRevision:0,factsSelectionId:'op'})).status).toBe(503);
  expect(h.store.operation('op')).toBeNull();expect(h.runtimeCalls).toEqual([]);h.store.close();
 });
 test('facts verification precedes durable switch and rejects foreign selection IDs',async()=>{
  const h=harness();let verified=0;
  h.options.factsUI={preview:async()=>({id:'preview'}),approve:async(_r,b)=>({id:b.id}),verify:async(r,id)=>{verified++;expect(r.id).toBe('r');expect(id).toBe('op');expect(h.store.operation('op')).toBeNull();}};
  expect((await h.req(path+'/facts/preview')).status).toBe(200);
  expect((await h.req(path+'/switch',{id:'op',target:'claude',expectedRevision:0,factsSelectionId:'foreign'})).status).toBe(409);expect(verified).toBe(0);
  expect((await h.req(path+'/switch',{id:'op',target:'claude',expectedRevision:0,factsSelectionId:'op'})).status).toBe(200);expect(verified).toBe(1);h.store.close();
 });
});

test('exact facts switch retry after cancel returns historical operation without verifying new revision',async()=>{
 const h=harness();let verifies=0;
 h.options.factsUI={preview:async()=>null,approve:async()=>null,verify:async()=>{verifies++;if(verifies>1)throw Error('must not verify current revision on replay');}};
 const body={id:'op',target:'claude',expectedRevision:0,factsSelectionId:'op'};
 expect((await h.req(path+'/switch',body)).status).toBe(200);
 expect((await h.req(path+'/operations/op/cancel',{expectedRevision:0})).status).toBe(200);
 expect((await h.req(path+'/switch',body)).status).toBe(200);expect(verifies).toBe(1);
 expect((await h.req(path+'/switch',{...body,factsSelectionId:undefined})).status).toBe(409);
 expect((await h.req(path+'/switch',{...body,target:'codex'})).status).toBe(409);h.store.close();
});
test('source references retain slash space and 161-character identity through approval schema',async()=>{
 const h=harness();let seen:any;
 h.options.factsUI={preview:async()=>null,approve:async(_r,b)=>{seen=b;return {id:b.id};},verify:async()=>{}};
 const sourceId='source / '+ 'x'.repeat(161);
 const response=await h.req(path+'/facts/selections',{id:'op',previewId:'preview',expectedRevision:0,selections:[{field:'goal',seq:1,sourceId,agent:'codex',nativeId:'native / id',eventHash:'a'.repeat(64)}]});
 expect(response.status).toBe(200);expect(seen.selections[0].sourceId).toBe(sourceId);h.store.close();
});
