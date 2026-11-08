import { describe, expect, test } from 'bun:test';
import { createMobileApi, type ReplyChannel, type MobileSendIO } from '../src/mobile/api';
import type { HerdrRuntime, HerdrChannel } from '../src/mobile/herdr/runtime';
import type { ContinuityFeatureOptions } from '../src/mobile/features/continuity';
import type { Room } from '../src/mobile/continuity/types';
const token='synthetic-mobile-token';
const scopes={herdr:['herdr:w-demo','w-demo:p1'],tmux:['tmux','%71'],superset:['00000000-0000-4000-8000-000000000071','terminal-demo']} as const;
function fixture(backend:Room['backend']='herdr',managed=true,operation=false,configured=true){
 const [ws,pane]=scopes[backend],calls:string[]=[],resolutions:string[][]=[];
 const room:Room={id:'logical-room-demo',backend,workspace:ws,room:pane,cwd:'/home/example/project',revision:operation?2:0,active:'codex',bindings:{codex:{agent:'codex',nativeId:'00000000-0000-4000-8000-000000000001',generation:'generation-demo',cursor:0}},...(operation?{operationId:'operation-demo'}:{})};
 const hc:HerdrChannel={kind:'herdr',endpointId:'local',session:'default',workspaceId:'w-demo',paneId:'w-demo:p1',terminalId:'terminal-demo',label:'synthetic room',agent:'codex',generation:'generation-demo',conversation:null,continuityToken:'continuity-demo',capabilities:{screen:true,history:false,prompt:true,keys:true,answer:false,stop:true,create:false,close:false}};
 const runtime:HerdrRuntime={async refresh(){calls.push('herdr.refresh');},resolve(){calls.push('herdr.resolve');return hc;},async listProjects(){calls.push('herdr.list');return [];},async screen(){calls.push('herdr.screen');return '';},async history(){throw new Error('unexpected history');},async dispatch(_ch,request){calls.push('herdr.dispatch');return {ok:true,state:'acknowledged',id:request.id,generation:hc.generation};},deliveryStatus(){throw new Error('unexpected delivery');},resolveDelivery(){throw new Error('unexpected resolveDelivery');},async dialog(){throw new Error('unexpected dialog');},setDialogParser(){},setDispatchGuard(){},close(){}};
 const channel:ReplyChannel=backend==='tmux'?{kind:'tmux',pane,label:'synthetic room'}:backend==='superset'?{kind:'superset',workspaceId:ws,terminalId:pane,label:'synthetic room'}:hc;
 const sendIO:MobileSendIO={roomChannel(w,r){calls.push('legacy.channel');expect([w,r]).toEqual([ws,pane]);return channel;},async readScreen(){calls.push('legacy.screen');return '';},async clearInputBox(){calls.push('legacy.clear');return true;},async pressKey(){calls.push('legacy.key');},async typeInto(){calls.push('legacy.text');}};
 const continuity:ContinuityFeatureOptions={engine:{} as any,async resolveRoom(w,r){resolutions.push([w,r]);return managed?structuredClone(room):null;},async capabilities(){return {ready:false,backends:[{backend:'herdr',ready:false},{backend:'tmux',ready:false},{backend:'superset',ready:false}],models:[]};}};
 const app=createMobileApi({token,hookToken:'synthetic-hook',allowedLogins:[]},{herdr:runtime,sendIO,...(configured?{continuity}:{})});
 calls.length=0;
 const request=(body:unknown,authorized=true,w:string=ws,r:string=pane)=>app.handle(new Request(`http://local/mobile/rooms/${encodeURIComponent(w)}/${encodeURIComponent(r)}/send`,{method:'POST',headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}));
 const capabilities=()=>app.handle(new Request('http://local/mobile/continuity/capabilities',{headers:{authorization:'Bearer '+token}}));
 return {request,capabilities,room,calls,resolutions,continuity};
}
const rejection={ok:false,code:'continuity_delivery_not_certified',state:'definitely-rejected'};
describe('Authenticated send route continuity certification guard',()=>{
 for(const backend of ['herdr','tmux','superset'] as const)for(const operation of [false,true])test(`${backend}, active operation=${operation}: managed text/keys/clear/offline are rejected before all transports`,async()=>{
  const h=fixture(backend,true,operation);
  for(const body of [{text:'ข้อความตัวอย่าง'},{key:'enter'},{key:'ctrlc'},{key:'clearbox'},{text:'ล้างก่อนส่ง',clear:true},{text:'รวมก่อนส่ง',merge:true},{id:'offline-request',text:'คิวเดิม',offline:true,generation:'old'},{}]){
   const response=await h.request(body);expect(response.status).toBe(409);expect(response.headers.get('cache-control')).toContain('no-store');expect(await response.json()).toMatchObject(rejection);expect(h.calls).toEqual([]);
  }
  expect(h.resolutions).toEqual(Array.from({length:8},()=>[h.room.workspace,h.room.room]));
 });
 for(const backend of ['herdr','tmux','superset'] as const)test(`${backend}: resolver errors, invalid schemas and scope mismatches never fall through to legacy/runtime`,async()=>{
  const h=fixture(backend);let count=0;
  for(const result of [undefined,false,true,1,{},[],{...h.room,workspace:'another-workspace'},{...h.room,room:'another-room'},{...h.room,bindings:{}},{...h.room,backend:'unknown'}]){
   h.continuity.resolveRoom=async(w,r)=>{expect([w,r]).toEqual([h.room.workspace,h.room.room]);count++;return result as any;};
   const response=await h.request({key:'clearbox'});expect(response.status).toBe(409);expect(await response.json()).toMatchObject(rejection);expect(h.calls).toEqual([]);
  }
  h.continuity.resolveRoom=async()=>{count++;throw new Error('private resolver details must never be public');};const failed=await h.request({text:'test'});expect(failed.status).toBe(409);expect(await failed.json()).toMatchObject(rejection);expect(h.calls).toEqual([]);expect(count).toBe(11);
 });
 test('resolver exception text/code is not reflected in the public error',async()=>{
  const h=fixture();h.continuity.resolveRoom=async()=>{throw Object.assign(new Error('synthetic-private-path-and-details'),{code:'synthetic-internal-code'});};
  const response=await h.request({text:'test'}),body=await response.text();expect(response.status).toBe(409);expect(body).not.toContain('synthetic-private-path-and-details');expect(body).not.toContain('synthetic-internal-code');expect(h.calls).toEqual([]);
 });
 test('exact authenticated ws/room is resolved once; no latest-room or alternate scope fallback',async()=>{
  const h=fixture();h.continuity.resolveRoom=async(w,r)=>{h.resolutions.push([w,r]);return {...h.room,workspace:'other'};};
  const response=await h.request({text:'test'},true,'herdr:w-exact','w-exact:p99');expect(response.status).toBe(409);expect(h.resolutions).toEqual([['herdr:w-exact','w-exact:p99']]);expect(h.calls).toEqual([]);
 });
 test('auth rejects before resolver as well as transport access',async()=>{
  const h=fixture();expect((await h.request({text:'test'},false)).status).toBe(401);expect(h.resolutions).toEqual([]);expect(h.calls).toEqual([]);
 });
 for(const backend of ['herdr','tmux','superset'] as const)test(`${backend}: exact null means unmanaged and preserves existing send handling via DI`,async()=>{
  for(const [body,expected] of [[{text:'ข้อความตัวอย่าง'},backend==='herdr'?['herdr.refresh','herdr.resolve','herdr.dispatch']:['legacy.channel','legacy.screen','legacy.text']],[{key:'enter'},backend==='herdr'?['herdr.refresh','herdr.resolve','herdr.dispatch']:['legacy.channel','legacy.key']]] as const){const h=fixture(backend,false),response=await h.request(body);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true});expect(h.calls).toEqual([...expected]);expect(h.resolutions).toEqual([[h.room.workspace,h.room.room],[h.room.workspace,h.room.room]]);}
  if(backend!=='herdr'){const h=fixture(backend,false);expect((await h.request({key:'clearbox'})).status).toBe(200);expect(h.calls).toEqual(['legacy.channel','legacy.clear']);}
 });
 test('omitted continuity options preserves default send behavior and does not call a resolver',async()=>{
  const h=fixture('herdr',true,false,false),response=await h.request({text:'ข้อความตัวอย่าง',id:'request-demo',generation:'generation-demo'});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true});expect(h.resolutions).toEqual([]);expect(h.calls).toEqual(['herdr.refresh','herdr.resolve','herdr.dispatch']);
 });
});
describe('Host-derived roomStateAvailable capability',()=>{
 test('configured room state is advertised independently of ready/all-three readiness and cannot be overridden by provider spread',async()=>{
  const h=fixture();const caps=await h.continuity.capabilities();h.continuity.capabilities=async()=>({...caps,roomStateAvailable:false} as any);
  const response=await h.capabilities();expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true,roomStateAvailable:true,ready:false,backends:caps.backends});expect(h.calls).toEqual([]);expect(h.resolutions).toEqual([]);
 });
 test('default absent options advertises false while all backends remain uncertified',async()=>{
  const h=fixture('herdr',false,false,false),response=await h.capabilities();expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true,roomStateAvailable:false,ready:false,backends:[{backend:'herdr',ready:false},{backend:'tmux',ready:false},{backend:'superset',ready:false}]});expect(h.calls).toEqual([]);
 });
});
