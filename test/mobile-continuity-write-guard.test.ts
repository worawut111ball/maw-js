import { describe, expect, test } from 'bun:test';
import { createMobileApi, type ReplyChannel } from '../src/mobile/api';
import { createContinuityWriteGuard } from '../src/mobile/continuity/write-guard';
import type { ContinuityFeatureOptions } from '../src/mobile/features/continuity';
import type { ContinuityWriteOptions } from '../src/mobile/continuity/write-guard';
import type { HerdrChannel, HerdrRuntime } from '../src/mobile/herdr/runtime';
import type { Room } from '../src/mobile/continuity/types';
const scopes={tmux:['tmux','%71'],superset:['00000000-0000-4000-8000-000000000071','terminal-demo'],herdr:['herdr:w-demo','w-demo:p1']} as const;
const reject={ok:false,code:'continuity_delivery_not_certified',state:'definitely-rejected'};
const writers=[['prompt/key',{key:'enter'}],['prompt/type',{n:1,text:'ข้อความตัวอย่าง'}],['prompt/answer',{n:1}],['mode/cycle',{}],['model',{model:'sonnet'}],['effort',{level:'high'}]] as const;
function harness(backend:Room['backend']='tmux',configured=true,unmanaged=false){
 const [ws,pane]=scopes[backend],calls:string[]=[],resolved:string[][]=[];
 const hooks:{read?:()=>Promise<void>;refresh?:()=>Promise<void>;key?:()=>Promise<void>;type?:()=>Promise<void>;pause?:()=>Promise<void>;clear?:()=>Promise<void>;wake?:(args:string[])=>Promise<void>}={};
 const room:Room={id:'logical-demo',workspace:ws,room:pane,backend,cwd:'/home/example/project',revision:0,active:'claude',bindings:{claude:{agent:'claude',nativeId:'00000000-0000-4000-8000-000000000001',generation:'synthetic-process',cursor:0}}};
 const hc:HerdrChannel={kind:'herdr',endpointId:'local',session:'default',workspaceId:'w-demo',paneId:'w-demo:p1',terminalId:'terminal-demo',label:'synthetic',agent:'claude',generation:'synthetic-process',conversation:null,continuityToken:'synthetic-continuity-token',capabilities:{screen:true,history:false,prompt:true,keys:true,answer:true,stop:true,create:false,close:false}};
 const channel:ReplyChannel=backend==='tmux'?{kind:'tmux',pane,label:'synthetic'}:backend==='superset'?{kind:'superset',workspaceId:ws,terminalId:pane,label:'synthetic'}:hc;
 let screen='─'.repeat(40)+'\n Bash command\n   echo example\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel';
 const read=async()=>{calls.push('screen');await hooks.read?.();return screen;},press=async()=>{calls.push('key');await hooks.key?.();},type=async()=>{calls.push('type');await hooks.type?.();},chan=()=>{calls.push('channel');return channel;};
 const runtime:HerdrRuntime={async refresh(){calls.push('refresh');await hooks.refresh?.();},resolve(){calls.push('resolve');return hc;},async screen(){return read();},async dispatch(_c,r){calls.push('dispatch');return {ok:true,state:'acknowledged',id:r.id,generation:hc.generation};},async listProjects(){return [];},async history(){throw Error('unexpected');},deliveryStatus(){throw Error('unexpected');},resolveDelivery(){throw Error('unexpected');},async dialog(){throw Error('unexpected');},setDialogParser(){},setDispatchGuard(){},close(){}};
 const continuity:ContinuityFeatureOptions&ContinuityWriteOptions={engine:{} as any,async resolveRoom(w,r){resolved.push([w,r]);return unmanaged?null:room;},async capabilities(){return {ready:false,backends:[],models:[]};}};
 const app=createMobileApi({token:'synthetic-token',hookToken:'synthetic-hook',allowedLogins:[]},{herdr:runtime,...(configured?{continuity}:{}),wakeIO:{run:async args=>{calls.push('wake:'+args.slice(0,2).join(':'));await hooks.wake?.(args);return JSON.stringify({workspaces:[{layout:{tabs:[{panes:[{id:'pane-demo',terminalId:pane}]}]},terminals:[]}]});}},findAgentRoom:async()=>{calls.push('findAgent');return {room:{channel},agent:{canReply:true}} as any;},sendIO:{readScreen:read,pressKey:press,typeInto:type,roomChannel:chan,clearInputBox:async()=>{calls.push('clear');await hooks.clear?.();return true;}},featureIO:{permissions:{readScreen:read,pressKey:press,roomChannel:chan,typeLiteral:type,pause:async()=>{await hooks.pause?.();}},modes:{readScreen:read,pressKey:press,typeInto:type,roomChannel:chan,wait:async()=>{await hooks.pause?.();}}}});
 const request=(path:string,body:unknown,auth=true)=>app.handle(new Request('http://local/mobile'+path,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer synthetic-token'}:{})},body:JSON.stringify(body)}));
 const base=`/rooms/${encodeURIComponent(ws)}/${encodeURIComponent(pane)}`;
 return {calls,resolved,room,channel,continuity,request,base,hooks,setScreen:(s:string)=>{screen=s;}};
}
describe('Per-instance continuity input writer guards via authenticated HTTP DI',()=>{
 for(const backend of ['tmux','superset','herdr'] as const)test(`${backend}: permission/mode/model/effort block before all channel/read/key/type/dispatch calls`,async()=>{
  const h=harness(backend);for(const [route,body] of writers){const response=await h.request(h.base+'/'+route,body);expect(response.status).toBe(409);expect(await response.json()).toMatchObject(reject);expect(h.calls).toEqual([]);}
  expect(h.resolved).toEqual(Array.from({length:6},()=>[h.room.workspace,h.room.room]));
 });
 for(const backend of ['tmux','superset','herdr'] as const)test(`${backend}: resolver throw and malformed/non-null/scope mismatch never perform legacy or Herdr effects`,async()=>{
  const h=harness(backend);for(const value of [undefined,false,{},[],{...h.room,workspace:'foreign'}]){h.continuity.resolveRoom=async()=>value as any;for(const [route,body] of writers){const r=await h.request(h.base+'/'+route,body);expect(r.status).toBe(409);expect(await r.json()).toMatchObject(reject);expect(h.calls).toEqual([]);}}
  h.continuity.resolveRoom=async()=>{throw Object.assign(new Error('private-resolver-detail'),{code:'private-code'});};for(const [route,body] of writers){const response=await h.request(h.base+'/'+route,body);expect(response.status).toBe(409);const text=await response.text();expect(text).not.toContain('private-resolver-detail');expect(text).not.toContain('private-code');expect(h.calls).toEqual([]);}
 });
 test('all exact room writers resolve the decoded exact scope once, never a latest-room alias',async()=>{
  const h=harness('herdr');await h.request('/rooms/herdr%3Aexact/exact%3Ap9/prompt/key',{key:'enter'});expect(h.resolved).toEqual([['herdr:exact','exact:p9']]);expect(h.calls).toEqual([]);
 });
 for(const backend of ['tmux','superset','herdr'] as const)test(`${backend}: configured raw agent routes without mapping block before even agent discovery`,async()=>{
  const h=harness(backend);for(const [route,body] of [['reply',{text:'ตัวอย่าง'}],['keys',{key:'enter'}]] as const){const r=await h.request('/agents/exact-agent/'+route,body);expect(r.status).toBe(409);expect(await r.json()).toMatchObject(reject);}expect(h.calls).toEqual([]);expect(h.resolved).toEqual([]);
 });
 for(const backend of ['tmux','superset','herdr'] as const)test(`${backend}: raw canonical mapper cannot authorize managed, unknown or throwing targets`,async()=>{
  const h=harness(backend);let maps=0;for(const result of [null,h.room,undefined]){h.continuity.resolveChannel=async channel=>{maps++;expect(channel).toEqual(h.channel);return result as any;};for(const [route,body] of [['reply',{text:'ตัวอย่าง'}],['keys',{key:'enter'}]] as const){expect((await h.request('/agents/exact-agent/'+route,body)).status).toBe(409);}}
  h.continuity.resolveChannel=async()=>{maps++;throw Error('private-map-detail');};const r=await h.request('/agents/exact-agent/reply',{text:'test'});expect(r.status).toBe(409);expect(await r.text()).not.toContain('private-map-detail');expect(maps).toBe(7);expect(h.calls).toEqual(Array(7).fill('findAgent'));expect(h.resolved).toEqual([]);
 });
 test('auth precedes every room and raw guard callback',async()=>{
  const h=harness();for(const [route,body] of writers)expect((await h.request(h.base+'/'+route,body,false)).status).toBe(401);expect((await h.request('/agents/id/reply',{text:'test'},false)).status).toBe(401);expect((await h.request('/agents/id/keys',{key:'enter'},false)).status).toBe(401);expect(h.calls).toEqual([]);expect(h.resolved).toEqual([]);
 });
 for(const configured of [false,true])test(`legacy default/unmanaged exact null preserves permission and slash-command paths (configured=${configured})`,async()=>{
  const h=harness('tmux',configured,true);
  for(const route of ['prompt/key','prompt/answer']){h.calls.length=0;const response=await h.request(h.base+'/'+route,route.endsWith('key')?{key:'enter'}:{n:1});expect(response.status).toBe(200);expect(h.calls).toEqual(['channel','screen','key']);}
  h.setScreen('❯\n'+'─'.repeat(40)+'\n  ⏵⏵ accept edits on (shift+tab to cycle)');
  for(const [route,body] of [['model',{model:'sonnet'}],['effort',{level:'high'}],['mode/cycle',{}]] as const){h.calls.length=0;expect((await h.request(h.base+'/'+route,body)).status).toBe(200);expect(h.calls.some(c=>c==='key'||c==='type')).toBe(true);}
 });
 test('default raw agent reply/keys preserves legacy writes without a continuity resolver',async()=>{
  const h=harness('superset',false);expect((await h.request('/agents/id/reply',{text:'test'})).status).toBe(200);expect(h.calls).toEqual(['findAgent','type']);h.calls.length=0;expect((await h.request('/agents/id/keys',{key:'enter'})).status).toBe(200);expect(h.calls).toEqual(['findAgent','key']);
 });
 test('two API instances never share a guard registry or poison default/unmanaged sends',async()=>{
  const managed=harness('herdr'),unmanaged=harness('herdr',true,true),legacy=harness('herdr',false);for(const h of [managed,unmanaged,legacy,managed]){const response=await h.request(h.base+'/prompt/key',{key:'enter'});expect(response.status).toBe(h===managed?409:200);}expect(managed.calls).toEqual([]);expect(unmanaged.calls).toEqual(['refresh','resolve','dispatch']);expect(legacy.calls).toEqual(['refresh','resolve','dispatch']);
 });
 test('null raw channel fails closed before mapping only when configured; default guard remains no-op',async()=>{
  let calls=0;const guard=createContinuityWriteGuard({resolveRoom:async()=>null,resolveChannel:async()=>{calls++;return null;}});await expect(guard.assertChannel(null)).rejects.toThrow('continuity_delivery_not_certified');expect(calls).toBe(0);await createContinuityWriteGuard().assertChannel(null);expect(calls).toBe(0);
 });
});

describe('Delivery resolution/wake/creation remain gated before lifecycle effects',()=>{
 test('delivery resolve and wake guard exact room before any provider/legacy access',async()=>{
  for(const backend of ['tmux','superset','herdr'] as const){const h=harness(backend),scope=`${encodeURIComponent(h.room.workspace)}/rooms/${encodeURIComponent(h.room.room)}`;
   for(const [path,body] of [[h.base+'/delivery/example/resolve',{confirmed:true,generation:'synthetic-process'}],[`/workspaces/${scope}/wake`,{}]] as const){const r=await h.request(path,body);expect(r.status).toBe(409);expect(await r.json()).toMatchObject(reject);expect(h.calls).toEqual([]);}
   expect(h.resolved).toEqual([[h.room.workspace,h.room.room],[h.room.workspace,h.room.room]]);
  }
 });
 test('creation has no exact room and blocks before directory lookup, delayed tmux prompt or Superset creation',async()=>{
  const h=harness();for(const ws of ['dir:synthetic-not-read','00000000-0000-4000-8000-000000000071','herdr:synthetic']){const r=await h.request(`/workspaces/${encodeURIComponent(ws)}/rooms`,{agent:'claude',prompt:'synthetic text'});expect(r.status).toBe(409);expect(await r.json()).toMatchObject(reject);}expect(h.calls).toEqual([]);expect(h.resolved).toEqual([]);
 });
});

function gate(){let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});return {started,release,block:async()=>{entered();await wait;}};}
const menuScreen=(selected=true,typed=false)=>['─'.repeat(40),' ☐ Example','', 'Choose a sample value',...(!selected?[' ❯ 2. Other sample']:[]),` ${selected?'❯':' '} 1. ${typed?'sample existing text':'Type something.'}`,'─'.repeat(40),' 3. Chat about this','Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
describe('Deferred continuity revocation between observations and input effects',()=>{
 for(const backend of ['tmux','superset'] as const)for(const [route,body] of writers)test(`${backend} ${route}: managed during pending screen prevents next key/type`,async()=>{
  const h=harness(backend,true,true),g=gate();h.setScreen(route==='prompt/type'?menuScreen():route.startsWith('prompt/')?'─'.repeat(40)+'\n Bash command\n echo example\n Do you want to proceed?\n ❯ 1. Yes\n 2. No\n Esc to cancel':'❯\n'+'─'.repeat(40)+'\n ⏵⏵ accept edits on (shift+tab to cycle)');h.hooks.read=g.block;
  const pending=h.request(h.base+'/'+route,body);await g.started;h.continuity.resolveRoom=async()=>h.room;g.release();const response=await pending;expect(response.status).toBe(409);expect(await response.json()).toMatchObject(reject);expect(h.calls).toEqual(['channel','screen']);
 });
 for(const route of ['prompt/key','prompt/type','prompt/answer','send'])test(`Herdr ${route}: resolver error during refresh prevents dispatch`,async()=>{
  const h=harness('herdr',true,true),g=gate();h.hooks.refresh=g.block;const body=route==='prompt/key'?{key:'enter'}:route==='prompt/type'?{n:1,text:'sample'}:route==='prompt/answer'?{n:1}:{text:'sample'};
  const pending=h.request(h.base+'/'+route,body);await g.started;h.continuity.resolveRoom=async()=>{throw Error('private revocation detail');};g.release();const response=await pending;expect(response.status).toBe(409);expect(await response.json()).toMatchObject(reject);expect(h.calls).toEqual(['refresh','resolve']);
 });
 test('/send: managed while pending legacy screen prevents typing; no request ID is falsely acknowledged',async()=>{
  const h=harness('tmux',true,true),g=gate();h.hooks.read=g.block;const pending=h.request(h.base+'/send',{id:'deferred-prompt',text:'sample'});await g.started;h.continuity.resolveRoom=async()=>h.room;g.release();const response=await pending;expect(response.status).toBe(409);expect(await response.json()).toMatchObject(reject);expect(h.calls).toEqual(['channel','screen']);
 });
 for(const effect of ['type','key','clear'] as const)test(`permission ${effect} then revoke during pause: partial uncertain, no next Enter/key/type`,async()=>{
  const h=harness('tmux',true,true),g=gate();
  if(effect==='key'){h.setScreen(menuScreen(false));h.hooks.key=async()=>h.setScreen(menuScreen(true));}
  else h.setScreen(menuScreen(true,effect==='clear'));
  h.hooks.pause=g.block;const pending=h.request(h.base+'/prompt/type',{n:1,text:'sample'});await g.started;h.continuity.resolveRoom=async()=>h.room;g.release();const response=await pending;expect(response.status).toBe(409);expect(await response.json()).toMatchObject({ok:false,code:'continuity_partial_write',state:'uncertain'});
  expect(h.calls).toEqual(effect==='type'?['channel','screen','type']:['channel','screen','key',...(effect==='key'?['screen']:[])]);
 });
 test('permission up followed by revoked guard never sends the requested final digit',async()=>{
  const h=harness('superset',true,true),g=gate();h.setScreen(menuScreen());h.hooks.key=async()=>h.setScreen(menuScreen(false));h.hooks.pause=g.block;const pending=h.request(h.base+'/prompt/key',{key:'1'});await g.started;h.continuity.resolveRoom=async()=>{throw Error('private');};g.release();const response=await pending;expect(response.status).toBe(409);expect(await response.json()).toMatchObject({state:'uncertain',code:'continuity_partial_write'});expect(h.calls.filter(c=>c==='key')).toHaveLength(1);
 });
 test('/send clear started then revoked: no prompt type and no definitely-rejected claim',async()=>{
  const h=harness('tmux',true,true),g=gate();h.setScreen('─'.repeat(40)+'\n\x1b[39m❯\u00a0\x1b[38;5;231mpending draft\x1b[0m\n'+'─'.repeat(40));h.hooks.clear=g.block;
  const body={id:'partial-clear-same-id',text:'new sample',clear:true};const pending=h.request(h.base+'/send',body);await g.started;h.continuity.resolveRoom=async()=>h.room;g.release();const response=await pending;expect(response.status).toBe(409);expect(await response.json()).toMatchObject({state:'uncertain',code:'continuity_partial_write'});expect(h.calls).toEqual(['channel','screen','clear']);
  h.continuity.resolveRoom=async()=>null;const retry=await h.request(h.base+'/send',body);expect(retry.status).toBe(409);expect(await retry.json()).toMatchObject({ok:false,state:'uncertain',code:'continuity_partial_write'});expect(h.calls).toEqual(['channel','screen','clear']);
 });
 for(const phase of ['snapshot','open'] as const)test(`wake revocation during ${phase} stops before next open/focus and reports prior effects honestly`,async()=>{
  const h=harness('superset',true,true),g=gate();h.hooks.wake=async args=>{if(phase==='snapshot'&&args[0]==='snapshot'||phase==='open'&&args[0]==='workspaces')await g.block();};
  const pending=h.request(`/workspaces/${h.room.workspace}/rooms/${h.room.room}/wake`,{});await g.started;h.continuity.resolveRoom=async()=>h.room;g.release();const response=await pending;expect(response.status).toBe(409);expect(await response.json()).toMatchObject(phase==='snapshot'?reject:{state:'uncertain',code:'continuity_partial_write'});expect(h.calls).toEqual(phase==='snapshot'?['wake:snapshot:--workspace']:['wake:snapshot:--workspace','wake:workspaces:open']);
 });
});

describe('Process-local configured send attempt replay',()=>{
 test('same ID while first request is awaiting a read is not acknowledged or dispatched twice',async()=>{
  const h=harness('tmux',true,true),g=gate(),body={id:'concurrent-local-send',text:'sample'};h.hooks.read=g.block;const first=h.request(h.base+'/send',body);await g.started;
  const second=await h.request(h.base+'/send',body);expect(second.status).toBe(409);expect(await second.json()).toMatchObject({ok:false,state:'uncertain'});expect(h.calls).toEqual(['channel','screen']);g.release();expect((await first).status).toBe(200);expect(h.calls).toEqual(['channel','screen','type']);
  const ack=await h.request(h.base+'/send',body);expect(await ack.json()).toMatchObject({ok:true,dup:true});expect(h.calls).toEqual(['channel','screen','type','channel']);
 });
 test('configured helper failure after type began keeps ID uncertain and cannot be replayed as success',async()=>{
  const h=harness('superset',true,true),body={id:'partial-type-helper',text:'sample'};h.hooks.type=async()=>{throw Error('synthetic helper failed after input may have begun');};
  const response=await h.request(h.base+'/send',body);expect(response.status).toBe(409);expect(await response.json()).toMatchObject({ok:false,state:'uncertain',code:'continuity_partial_write'});const before=[...h.calls];h.hooks.type=undefined;
  const retry=await h.request(h.base+'/send',body);expect(retry.status).toBe(409);expect(await retry.json()).toMatchObject({ok:false,state:'uncertain'});expect(h.calls).toEqual(before);
 });
 test('pre-effect guard rejection frees ID for an explicit later attempt; it never creates an ACK',async()=>{
  const h=harness('tmux',true,true),g=gate(),body={id:'pre-effect-revoked',text:'sample'};h.hooks.read=g.block;const first=h.request(h.base+'/send',body);await g.started;h.continuity.resolveRoom=async()=>h.room;g.release();expect(await (await first).json()).toMatchObject(reject);expect(h.calls).toEqual(['channel','screen']);
  h.continuity.resolveRoom=async()=>null;h.hooks.read=undefined;const retry=await h.request(h.base+'/send',body);expect(retry.status).toBe(200);expect(await retry.json()).not.toHaveProperty('dup');expect(h.calls).toEqual(['channel','screen','channel','screen','type']);
 });
});

test('same ID with both initial resolver calls deferred never acknowledges a dispatching competitor',async()=>{
 const h=harness('tmux',true,true),reading=gate();let enterBoth!:()=>void,releaseBoth!:()=>void,count=0;
 const both=new Promise<void>(resolve=>{enterBoth=resolve;}),release=new Promise<void>(resolve=>{releaseBoth=resolve;});
 h.continuity.resolveRoom=async()=>{if(++count<=2){if(count===2)enterBoth();await release;}return null;};h.hooks.read=reading.block;
 const body={id:'two-resolver-overlap',text:'sample'},first=h.request(h.base+'/send',body),second=h.request(h.base+'/send',body);
 await both;releaseBoth();await reading.started;const competitor=await Promise.race([first,second]);expect(competitor.status).toBe(409);expect(await competitor.json()).toMatchObject({ok:false,state:'uncertain',code:'continuity_partial_write'});expect(h.calls.filter(c=>c==='screen')).toHaveLength(1);expect(h.calls).not.toContain('type');
 reading.release();expect((await Promise.all([first,second])).map(r=>r.status).sort()).toEqual([200,409]);expect(h.calls.filter(c=>c==='type')).toHaveLength(1);
});
