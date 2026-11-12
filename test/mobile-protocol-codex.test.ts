import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexProtocolSession, projectCodexDiagnosticFrame } from '../src/mobile/continuity/protocol/codex';
import { ProtocolError, type ProtocolPolicy, type ProtocolWire, type ProtocolHooks } from '../src/mobile/continuity/protocol/types';
// Fixture fields/enum spellings follow the 0.164.0 generated schema, not transcript/TUI formats.
const threadId='00000000-0000-4000-8000-000000000001',turnId='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003';
const policy:ProtocolPolicy={agent:'codex',cwd:'/home/example/project',home:'/home/example',model:'fixture-model',modelProvider:'openai',route:'direct',timeoutMs:250};
const init={codexHome:'/home/example/.codex',platformFamily:'unix',platformOs:'macos',userAgent:'codex/0.164.0'};
const thread=()=>({id:threadId,cliVersion:'0.164.0',createdAt:1,updatedAt:1,cwd:policy.cwd,ephemeral:false,model:policy.model,modelProvider:'openai',preview:'',projectId:null,sessionId:threadId,source:'appServer',status:{type:'idle'},turns:[]});
const opened=()=>({thread:thread(),cwd:policy.cwd,model:policy.model,modelProvider:'openai',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
const turn=(status='inProgress',items:any[]=[])=>({id:turnId,items,status,error:null,itemsView:'full'});
const finalItem=()=>({type:'agentMessage',id:'answer-item',text:'คำตอบตัวอย่าง',phase:'final_answer'});
class Wire implements ProtocolWire {
 frames:Record<string,any>[]=[];private queue:unknown[]=[];private waits:((v:IteratorResult<unknown>)=>void)[]=[];private ended=false;
 onSend?:(f:Record<string,any>)=>void|Promise<void>;
 readonly messages:AsyncIterable<unknown>={[Symbol.asyncIterator]:()=>({next:()=>this.queue.length?Promise.resolve({done:false,value:this.queue.shift()}):this.ended?Promise.resolve({done:true,value:undefined}):new Promise<IteratorResult<unknown>>(resolve=>this.waits.push(resolve))})};
 push(frame:unknown){const waiter=this.waits.shift();if(waiter)waiter({done:false,value:frame});else this.queue.push(frame);}
 async send(frame:Record<string,any>){this.frames.push(structuredClone(frame));await this.onSend?.(frame);}
 async close(){this.ended=true;for(const waiter of this.waits.splice(0))waiter({done:true,value:undefined});}
}
const sessions:CodexProtocolSession[]=[];afterEach(async()=>{for(const session of sessions.splice(0))await session.close().catch(()=>{});});
function fixture(hooks:ProtocolHooks={},over:Partial<ProtocolPolicy>={}){
 const wire=new Wire(),session=new CodexProtocolSession(wire,{...policy,...over},hooks);sessions.push(session);
 wire.onSend=f=>{if(f.method==='initialize')wire.push({id:f.id,result:init});if(f.method==='thread/start'||f.method==='thread/resume')wire.push({id:f.id,result:opened()});if(f.method==='turn/start')wire.push({id:f.id,result:{turn:turn()}});};
 return {wire,session};
}
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
const event=(wire:Wire,method:string,params:any)=>wire.push({method,params});
const complete=(wire:Wire,items=[finalItem()])=>event(wire,'turn/completed',{threadId,turn:turn('completed',items)});
function approval(wire:Wire,id:string|number='approval-1',over:any={}){wire.push({id,method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:'command-item',startedAtMs:1,cwd:policy.cwd,command:'echo example',...over}});}
async function running(h:ReturnType<typeof fixture>,operation='op-one'){await h.session.open();const pending=h.session.turn(operation,'ข้อความตัวอย่าง');pending.catch(()=>{});await tick();return {pending};}

describe('Codex 0.164 JSON RPC initialization and exact identity',()=>{
 test('construction has no wire I/O; fresh initialize/initialized/thread start uses fixed typed pilot policy',async()=>{
  const h=fixture();expect(h.wire.frames).toEqual([]);expect(h.session.idle).toBe(false);const identity=await h.session.open();expect(identity).toEqual({agent:'codex',nativeId:threadId,cwd:policy.cwd,home:policy.home,model:policy.model,route:'direct'});expect(h.session.idle).toBe(true);
  expect(h.wire.frames.map(f=>f.method)).toEqual(['initialize','initialized','thread/start']);expect(h.wire.frames[2].params).toEqual({model:policy.model,modelProvider:'openai',cwd:policy.cwd,approvalPolicy:'on-request',sandbox:'read-only',approvalsReviewer:'user'});expect(JSON.stringify(h.wire.frames)).not.toContain('developerInstructions');expect(JSON.stringify(h.wire.frames)).not.toContain('baseInstructions');
 });
 test('resume sends only exact requested ID and cannot fall back to start on response mismatch',async()=>{
  const h=fixture();await h.session.open(threadId);expect(h.wire.frames[2].method).toBe('thread/resume');expect(h.wire.frames[2].params.threadId).toBe(threadId);
  const bad=fixture();bad.wire.onSend=f=>{if(f.method==='initialize')bad.wire.push({id:f.id,result:init});else if(f.method==='thread/resume')bad.wire.push({id:f.id,result:{...opened(),thread:{...thread(),id:other}}});};await expect(bad.session.open(threadId)).rejects.toThrow('thread_identity_mismatch');expect(bad.wire.frames.some(f=>f.method==='thread/start')).toBe(false);
 });
 test.each(['cwd','model','provider','thread-cwd','thread-provider','ephemeral','fork','active','permission','sandbox','reviewer','network'])('rejects %s mismatch without turn input',async kind=>{
  const h=fixture();h.wire.onSend=f=>{if(f.method==='initialize')h.wire.push({id:f.id,result:init});else if(f.method==='thread/start'){const r:any=opened();if(kind==='cwd')r.cwd='/home/example/other';if(kind==='model')r.model='other-model';if(kind==='provider')r.modelProvider='other-provider';if(kind==='thread-cwd')r.thread.cwd='/home/example/other';if(kind==='thread-provider')r.thread.modelProvider='other-provider';if(kind==='ephemeral')r.thread.ephemeral=true;if(kind==='fork')r.thread.forkedFromId=other;if(kind==='active')r.thread.status={type:'active',activeFlags:[]};if(kind==='permission')r.approvalPolicy='untrusted';if(kind==='sandbox')r.sandbox={type:'workspaceWrite'};if(kind==='reviewer')r.approvalsReviewer='guardian';if(kind==='network')r.sandbox.networkAccess=true;h.wire.push({id:f.id,result:r});}};await expect(h.session.open()).rejects.toBeInstanceOf(ProtocolError);expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);
 });
 test('host HOME is metadata distinct from observed native codexHome; invalid initialization fails closed',async()=>{
  const h=fixture();expect((await h.session.open()).home).toBe('/home/example');const bad=fixture();bad.wire.onSend=f=>{if(f.method==='initialize')bad.wire.push({id:f.id,result:{...init,codexHome:'relative-home'}});};await expect(bad.session.open()).rejects.toThrow('initialize_identity_mismatch');
 });
 test('invalid provider/native ID/caller config data never reaches wire',async()=>{
  const wire=new Wire();expect(()=>new CodexProtocolSession(wire,{...policy,modelProvider:undefined})).toThrow('invalid_codex_policy');expect(()=>new CodexProtocolSession(wire,{...policy,agent:'claude'})).toThrow();expect(wire.frames).toEqual([]);const h=fixture();await expect(h.session.open({threadId} as any)).rejects.toThrow('invalid_native_id');expect(h.wire.frames).toEqual([]);
 });
});
describe('Turn admission is not completion',()=>{
 test('waits for exact terminal turn notification and returns only public assistant text',async()=>{
  const h=fixture(),{pending}=await running(h);let done=false;void pending.then(()=>{done=true;});expect(h.session.idle).toBe(false);await tick();expect(done).toBe(false);
  event(h.wire,'item/completed',{threadId,turnId,completedAtMs:1,item:{type:'reasoning',id:'reason-item',text:'hidden synthetic reasoning'}});complete(h.wire);expect(await pending).toEqual({operationId:'op-one',nativeId:threadId,turnId,text:'คำตอบตัวอย่าง',state:'completed'});expect(h.session.idle).toBe(true);expect(h.wire.frames.find(f=>f.method==='turn/start')?.params).toEqual({threadId,input:[{type:'text',text:'ข้อความตัวอย่าง'}]});
 });
 test('concurrent turns and repeated operation IDs never send a second turn',async()=>{
  const h=fixture(),{pending}=await running(h);await expect(h.session.turn('op-two','second')).rejects.toThrow('turn_in_progress');complete(h.wire);await pending;await expect(h.session.turn('op-one','changed')).rejects.toThrow('operation_replay');expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 test.each(['thread','turn','failed','interrupted','error','notLoaded','pending','tool-error','reroute'])('%s cannot become completed',async kind=>{
  const h=fixture(),{pending}=await running(h);if(kind==='pending')event(h.wire,'item/started',{threadId,turnId,startedAtMs:1,item:{type:'commandExecution',id:'pending-tool',command:'echo example',cwd:policy.cwd,commandActions:[],status:'inProgress'}});
  const params:any={threadId,turn:turn('completed',[finalItem()])};if(kind==='thread')params.threadId=other;if(kind==='turn')params.turn.id=other;if(kind==='failed')params.turn.status='failed';if(kind==='interrupted')params.turn.status='interrupted';if(kind==='error')params.turn.error={message:'native failure'};if(kind==='notLoaded')params.turn.itemsView='notLoaded';if(kind==='tool-error')params.turn.items.push({type:'commandExecution',id:'failed-tool',command:'false',cwd:policy.cwd,commandActions:[],status:'completed',exitCode:1});
  event(h.wire,kind==='reroute'?'model/rerouted':'turn/completed',params);await expect(pending).rejects.toMatchObject({uncertain:true});expect(h.session.idle).toBe(false);await expect(h.session.turn('new-op','retry')).rejects.toThrow();
 });
 test('observed pending item must complete, successful tool plus exact final can complete',async()=>{
  const h=fixture(),{pending}=await running(h),tool={type:'commandExecution',id:'tool-ok',command:'echo example',cwd:policy.cwd,commandActions:[],status:'inProgress'};event(h.wire,'item/started',{threadId,turnId,startedAtMs:1,item:tool});event(h.wire,'item/completed',{threadId,turnId,completedAtMs:2,item:{...tool,status:'completed',exitCode:0}});complete(h.wire);expect((await pending).state).toBe('completed');
 });
 test('notification can arrive before turn/start response but cannot complete before response binds exact ID',async()=>{
  const h=fixture();await h.session.open();let request:any;h.wire.onSend=f=>{if(f.method==='turn/start'){request=f;complete(h.wire);}};const pending=h.session.turn('early-notification','sample');let done=false;void pending.then(()=>{done=true;});await tick();expect(done).toBe(false);h.wire.push({id:request.id,result:{turn:turn()}});expect((await pending).turnId).toBe(turnId);
 });
 test('disconnect/timeout is uncertain and never auto replays',async()=>{
  for(const cause of ['disconnect','timeout']){const h=fixture({}, {timeoutMs:30}),{pending}=await running(h);if(cause==='disconnect')await h.wire.close();await expect(pending).rejects.toMatchObject({uncertain:true});await expect(h.session.turn('new-op','again')).rejects.toThrow();expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);}
 });
});
describe('Exact-turn approvals and default denial',()=>{
 test('absence of hook returns schema decline and never session-wide approval',async()=>{
  const h=fixture(),{pending}=await running(h);approval(h.wire);await tick();expect(h.wire.frames.at(-1)).toEqual({id:'approval-1',result:{decision:'decline'}});expect(h.session.pendingApproval).toBe(false);complete(h.wire);await pending;
 });
 test('explicit allow is one exact native request, not acceptForSession or policy amendment',async()=>{
  const seen:any[]=[];const h=fixture({approve:async request=>{seen.push(request);return 'allow';}}),{pending}=await running(h);approval(h.wire,7);await tick();expect(seen).toHaveLength(1);expect(seen[0]).toMatchObject({id:'number:7',nativeId:threadId,turnId,tool:'item/commandExecution/requestApproval'});expect(h.wire.frames.at(-1)).toEqual({id:7,result:{decision:'accept'}});complete(h.wire);await pending;
 });
 test.each([{threadId:other},{turnId:other},{cwd:'/home/example/other'},{grantRoot:'/home/example'}, {itemId:''}])('mismatched approval scope is denied without calling hook: %j',async over=>{
  let called=0;const h=fixture({approve:async()=>{called++;return 'allow';}}),{pending}=await running(h);approval(h.wire,'stale',over);await expect(pending).rejects.toMatchObject({uncertain:true});expect(called).toBe(0);expect(h.wire.frames.at(-1)).toEqual({id:'stale',result:{decision:'decline'}});
 });
 test('pending approval blocks completion and late hook resolution cannot approve after disconnect',async()=>{
  let release!:(value:'allow')=>void;const h=fixture({approve:()=>new Promise(resolve=>{release=resolve;})}),{pending}=await running(h);approval(h.wire);await tick();expect(h.session.pendingApproval).toBe(true);await h.wire.close();await expect(pending).rejects.toMatchObject({uncertain:true});release('allow');await tick();expect(h.wire.frames.some(f=>f.result?.decision==='accept')).toBe(false);
 });
 test('completed turn while approval still pending is not accepted',async()=>{
  const h=fixture({approve:()=>new Promise(()=>{})}),{pending}=await running(h);approval(h.wire);await tick();complete(h.wire);await expect(pending).rejects.toThrow('turn_not_safely_completed');
 });
 test('unsupported server request returns RPC error, no invented approval result',async()=>{
  const h=fixture(),{pending}=await running(h);h.wire.push({id:'unknown-approval',method:'item/permissions/requestApproval',params:{threadId,turnId}});await expect(pending).rejects.toThrow('unsupported_server_request');expect(h.wire.frames.at(-1)).toEqual({id:'unknown-approval',error:{code:-32601,message:'Unsupported request'}});
 });
});

// Portable fixtures are above. If the team's actual generated schema artifact exists, validate their shape independently.
// Optional: point MAW_CODEX_SCHEMA_ROOT at a `codex app-server generate-json-schema` output dir to run these.
const schemaRoot=process.env.MAW_CODEX_SCHEMA_ROOT||'/nonexistent/codex-schema';
function schemaCheck(value:any,s:any,root:any):boolean{
 if(s===true)return true;if(s===false)return false;if(s.$ref)return schemaCheck(value,root.definitions[s.$ref.split('/').at(-1)],root);
 if(s.enum&&!s.enum.some((x:any)=>JSON.stringify(x)===JSON.stringify(value)))return false;
 if(s.oneOf&&s.oneOf.filter((x:any)=>schemaCheck(value,x,root)).length!==1)return false;
 if(s.anyOf&&!s.anyOf.some((x:any)=>schemaCheck(value,x,root)))return false;if(s.allOf&&!s.allOf.every((x:any)=>schemaCheck(value,x,root)))return false;
 if(s.type){const types=Array.isArray(s.type)?s.type:[s.type];if(!types.some((t:string)=>t==='null'?value===null:t==='array'?Array.isArray(value):t==='object'?!!value&&typeof value==='object'&&!Array.isArray(value):t==='integer'?Number.isSafeInteger(value):typeof value===t))return false;}
 if(value&&typeof value==='object'&&!Array.isArray(value)){if(s.required?.some((k:string)=>!Object.hasOwn(value,k)))return false;for(const [k,v]of Object.entries(value))if(s.properties?.[k]&&!schemaCheck(v,s.properties[k],root))return false;}
 if(Array.isArray(value)&&s.items&&!value.every(v=>schemaCheck(v,s.items,root)))return false;return true;
}
test.skipIf(!existsSync(schemaRoot))('fixtures conform to actual generated initialize/thread/turn/approval schemas from Codex0.164',()=>{
 for(const [name,value]of [['v1/InitializeParams',{clientInfo:{name:'maw-continuity',version:'1'},capabilities:{experimentalApi:false}}],['v2/ThreadStartParams',{model:policy.model,modelProvider:'openai',cwd:policy.cwd,approvalPolicy:'on-request',sandbox:'read-only',approvalsReviewer:'user'}],['v2/ThreadResumeParams',{threadId,model:policy.model,modelProvider:'openai',cwd:policy.cwd,approvalPolicy:'on-request',sandbox:'read-only',approvalsReviewer:'user'}],['v2/TurnStartParams',{threadId,input:[{type:'text',text:'sample'}]}],['v1/InitializeResponse',init],['v2/ThreadStartResponse',opened()],['v2/TurnStartResponse',{turn:turn()}],['v2/TurnCompletedNotification',{threadId,turn:turn('completed',[finalItem()])}],['CommandExecutionRequestApprovalResponse',{decision:'decline'}],['CommandExecutionRequestApprovalParams',{threadId,turnId,itemId:'tool',startedAtMs:1,cwd:policy.cwd,command:'echo example'}]] as const){const schema=JSON.parse(readFileSync(join(schemaRoot,name+'.json'),'utf8'));expect({schema:name,valid:schemaCheck(value,schema,schema)}).toEqual({schema:name,valid:true});}
});

describe('RPC failure and replay boundaries',()=>{
 test('native RPC error on resume never starts a replacement thread',async()=>{
  const h=fixture();h.wire.onSend=f=>{if(f.method==='initialize')h.wire.push({id:f.id,result:init});if(f.method==='thread/resume')h.wire.push({id:f.id,error:{code:-32000,message:'synthetic session missing'}});};await expect(h.session.open(threadId)).rejects.toThrow('native_rpc_error');expect(h.wire.frames.filter(f=>f.method==='thread/start')).toEqual([]);
 });
 test('turn write rejection is uncertain and no automatic resend is attempted',async()=>{
  const h=fixture();await h.session.open();h.wire.onSend=f=>{if(f.method==='turn/start')throw Error('synthetic pipe write failure');};await expect(h.session.turn('lost-write','sample')).rejects.toMatchObject({code:'protocol_write_failed',uncertain:true});await expect(h.session.turn('lost-write','sample')).rejects.toBeInstanceOf(ProtocolError);expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 test('unknown RPC response ID cannot acknowledge or complete the active operation',async()=>{
  const h=fixture(),{pending}=await running(h);h.wire.push({id:'not-issued-by-client',result:{turn:turn('completed',[finalItem()])}});await expect(pending).rejects.toThrow('unexpected_response');
 });
 test('turn/start response alone marked completed is still not terminal notification evidence',async()=>{
  const h=fixture({}, {timeoutMs:30});await h.session.open();h.wire.onSend=f=>{if(f.method==='turn/start')h.wire.push({id:f.id,result:{turn:turn('completed',[finalItem()])}});};await expect(h.session.turn('ack-is-not-completion','sample')).rejects.toMatchObject({uncertain:true});
 });
 test('approval hook rejection defaults to decline rather than an approval-policy override',async()=>{
  const h=fixture({approve:async()=>{throw Error('synthetic UI unavailable');}}),{pending}=await running(h);approval(h.wire);await tick();expect(h.wire.frames.at(-1)).toEqual({id:'approval-1',result:{decision:'decline'}});complete(h.wire);await pending;
 });
 test('approval ID replay is denied, not re-approved',async()=>{
  let calls=0;const h=fixture({approve:async()=>{calls++;return 'allow';}}),{pending}=await running(h);approval(h.wire);await tick();approval(h.wire);await expect(pending).rejects.toThrow('approval_replay');expect(calls).toBe(1);expect(h.wire.frames.at(-1)).toEqual({id:'approval-1',result:{decision:'decline'}});
 });
 test('file approval uses one-shot schema response and exact binding',async()=>{
  const h=fixture(),{pending}=await running(h);h.wire.push({id:'file-approval',method:'item/fileChange/requestApproval',params:{threadId,turnId,itemId:'file-item',startedAtMs:1,grantRoot:null}});await tick();expect(h.wire.frames.at(-1)).toEqual({id:'file-approval',result:{decision:'decline'}});complete(h.wire);await pending;
 });
 test('invalid/unknown completed item and a pending non-command tool fail closed',async()=>{
  for(const type of ['unknown-tool','webSearch']){const h=fixture(),{pending}=await running(h);if(type==='webSearch')event(h.wire,'item/started',{threadId,turnId,startedAtMs:1,item:{type,id:'pending-search',query:'example'}});complete(h.wire,[finalItem(),{type,id:'extra-item'}] as any);await expect(pending).rejects.toMatchObject({uncertain:true});}
 });
});

test('pending tool observed in turn/start response cannot be dropped from completion payload',async()=>{
 const h=fixture();await h.session.open();h.wire.onSend=f=>{if(f.method==='turn/start')h.wire.push({id:f.id,result:{turn:turn('inProgress',[{type:'commandExecution',id:'ack-pending',command:'echo example',cwd:policy.cwd,commandActions:[],status:'inProgress'}])}});};const pending=h.session.turn('pending-from-admission','sample');pending.catch(()=>{});await tick();complete(h.wire);await expect(pending).rejects.toMatchObject({uncertain:true});
});
test('close is idempotent and no new wire controls are sent after it',async()=>{
 const h=fixture();let closed=0;const close=h.wire.close.bind(h.wire);h.wire.close=async()=>{closed++;await close();};await h.session.open();await Promise.all([h.session.close(),h.session.close()]);expect(closed).toBe(1);await expect(h.session.turn('after-close','sample')).rejects.toThrow('protocol_closed');
});

describe('Host selected effective toolHome binding',()=>{
 test('matching native codexHome opens while ProtocolIdentity.home remains distinct host metadata',async()=>{
  const h=fixture({}, {toolHome:init.codexHome});const identity=await h.session.open();expect(identity.home).toBe(policy.home);expect(identity.home).not.toBe(init.codexHome);expect(h.wire.frames.map(f=>f.method)).toEqual(['initialize','initialized','thread/start']);
 });
 for(const resume of [false,true])test(`wrong native codexHome rejects before initialized/start/resume (resume=${resume})`,async()=>{
  const h=fixture({}, {toolHome:'/home/example/different-selected-home'});await expect(h.session.open(resume?threadId:undefined)).rejects.toThrow('initialize_identity_mismatch');expect(h.wire.frames.map(f=>f.method)).toEqual(['initialize']);expect(h.session.idle).toBe(false);await expect(h.session.turn('home-mismatch','sample')).rejects.toBeInstanceOf(ProtocolError);
 });
 test('invalid supplied toolHome fails constructor before any frames; omitted optional field preserves compatibility',async()=>{
  const wire=new Wire();for(const toolHome of ['relative-home','/home/example/../different',''])expect(()=>new CodexProtocolSession(wire,{...policy,toolHome})).toThrow('invalid_codex_policy');expect(wire.frames).toEqual([]);const h=fixture();expect((await h.session.open()).nativeId).toBe(threadId);
 });
});

const remoteStatus=(over:Record<string,unknown>={})=>({status:'disabled',serverName:'fixture-server',installationId:'fixture-installation',environmentId:null,...over});
function startupFixture(params:unknown=remoteStatus(),method='remoteControl/status/changed'){
 const h=fixture();h.wire.onSend=f=>{if(f.method==='initialize'){h.wire.push({id:f.id,result:init});h.wire.push({method,params});}else if(f.method==='thread/start'||f.method==='thread/resume')h.wire.push({id:f.id,result:opened()});};return h;
}
for(const status of ['disabled','connecting','connected','errored'])test(`exact-pin remote-control startup ${status} is passive metadata only`,async()=>{
 const h=startupFixture(remoteStatus({status}));const identity=await h.session.open();expect(identity.nativeId).toBe(threadId);expect(identity).not.toHaveProperty('installationId');expect(h.wire.frames.map(f=>f.method)).toEqual(['initialize','initialized','thread/start']);expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);expect(h.session.pendingApproval).toBe(false);
});
for(const [name,params] of Object.entries({missingStatus:{serverName:'fixture',installationId:'fixture'},unknownStatus:remoteStatus({status:'ready'}),missingInstallation:{status:'disabled',serverName:'fixture'},wrongServer:remoteStatus({serverName:null}),wrongEnvironment:remoteStatus({environmentId:42}),foreignThread:remoteStatus({threadId:other}),foreignTurn:remoteStatus({turnId}),extraApproval:remoteStatus({approvalPolicy:'never'}),nullParams:null}))test(`malformed/scoped startup status ${name} fails closed`,async()=>{
 const h=startupFixture(params);await expect(h.session.open()).rejects.toThrow('invalid_startup_notification');expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);expect(h.session.idle).toBe(false);
});
test('remote-control status cannot stand in for a missing thread response or promote ready',async()=>{
 const h=startupFixture(remoteStatus({status:'connected'}));h.wire.onSend=f=>{if(f.method==='initialize'){h.wire.push({id:f.id,result:init});h.wire.push({method:'remoteControl/status/changed',params:remoteStatus({status:'connected'})});}};
 const opening=h.session.open();const outcome=opening.catch(e=>e);await tick();expect(h.session.idle).toBe(false);expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);await h.wire.close();expect(await outcome).toBeInstanceOf(ProtocolError);
});
test('remote-control status before initialize response is outside startup window',async()=>{
 const h=fixture();h.wire.onSend=f=>{if(f.method==='initialize')h.wire.push({method:'remoteControl/status/changed',params:remoteStatus()});};await expect(h.session.open()).rejects.toThrow('notification_scope_mismatch');expect(h.wire.frames.map(f=>f.method)).toEqual(['initialize']);
});
test('remote-control status after open cannot grant another lifecycle/turn scope',async()=>{
 const h=fixture();await h.session.open();h.wire.push({method:'remoteControl/status/changed',params:remoteStatus()});await tick();expect(h.session.idle).toBe(false);await expect(h.session.turn('after-status','sample')).rejects.toThrow('notification_scope_mismatch');expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);
});
test('remote-control status during an active turn is not an allowed turn notification',async()=>{
 const h=fixture(),{pending}=await running(h);h.wire.push({method:'remoteControl/status/changed',params:remoteStatus()});await expect(pending).rejects.toThrow('notification_scope_mismatch');
});
test('unknown startup notification remains unsupported rather than blanket ignored',async()=>{
 const h=startupFixture(remoteStatus(),'remoteControl/newUnknownStatus');await expect(h.session.open()).rejects.toThrow('unsupported_notification');expect(h.session.idle).toBe(false);
});
test('passive startup status cannot rescue mismatched initialize codexHome',async()=>{
 const h=fixture({}, {toolHome:'/fixture/wrong-home'});h.wire.onSend=f=>{if(f.method==='initialize'){h.wire.push({id:f.id,result:init});h.wire.push({method:'remoteControl/status/changed',params:remoteStatus()});}};await expect(h.session.open()).rejects.toThrow('initialize_identity_mismatch');expect(h.wire.frames.some(f=>f.method==='thread/start')).toBe(false);
});
test.skipIf(!existsSync(schemaRoot))('remote-control startup fixtures match exact-pin generated status schema',()=>{
 const schema=JSON.parse(readFileSync(join(schemaRoot,'v2/RemoteControlStatusChangedNotification.json'),'utf8'));
 for(const status of ['disabled','connecting','connected','errored'])expect(schemaCheck(remoteStatus({status}),schema,schema)).toBe(true);
 expect(schemaCheck(remoteStatus({status:'ready'}),schema,schema)).toBe(false);expect(schemaCheck(remoteStatus({environmentId:4}),schema,schema)).toBe(false);
});

const mcpStatus=(over:Record<string,unknown>={})=>({threadId,name:'synthetic-mcp',status:'ready',error:null,failureReason:null,...over});
for(const status of ['starting','ready'])test(`scoped MCP lifecycle ${status} after open remains passive, with no tool/approval/user input`,async()=>{
 const h=fixture();await h.session.open();h.wire.push({method:'mcpServer/startupStatus/updated',params:mcpStatus({status})});await tick();
 expect(h.session.idle).toBe(true);expect(h.session.pendingApproval).toBe(false);expect(h.wire.frames.map(f=>f.method)).toEqual(['initialize','initialized','thread/start']);expect(h.session.diagnostics().lastFrame).toMatchObject({method:'mcpServer/startupStatus/updated',threadScope:'matches',status});
});
test('MCP lifecycle immediately after thread response binds that response UUID before open continuation',async()=>{
 const h=fixture();h.wire.onSend=f=>{if(f.method==='initialize')h.wire.push({id:f.id,result:init});if(f.method==='thread/start'){h.wire.push({id:f.id,result:opened()});h.wire.push({method:'mcpServer/startupStatus/updated',params:mcpStatus()});}};
 expect((await h.session.open()).nativeId).toBe(threadId);await tick();expect(h.session.idle).toBe(true);expect(h.session.diagnostics().broken).toBe(false);
});
for(const thread of [undefined,null])test(`global MCP startup thread=${String(thread)} has no identity/readiness authority`,async()=>{
 const params:any=mcpStatus({threadId:thread});if(thread===undefined)delete params.threadId;
 const h=startupFixture(params,'mcpServer/startupStatus/updated');await h.session.open();expect(h.session.idle).toBe(true);expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);
});
for(const [name,over,code] of [
 ['foreign-thread',{threadId:other},'notification_scope_mismatch'],['global-after-open',{threadId:null},'notification_scope_mismatch'],
 ['bad-uuid',{threadId:'same-label'},'invalid_mcp_startup_notification'],['wrong-name',{name:4},'invalid_mcp_startup_notification'],
 ['unknown-state',{status:'connected'},'invalid_mcp_startup_notification'],['wrong-error',{error:4},'invalid_mcp_startup_notification'],
 ['unknown-failure-reason',{failureReason:'maybe'},'invalid_mcp_startup_notification'],['foreign-turn',{turnId},'invalid_mcp_startup_notification'],
 ['approval-injection',{approvalPolicy:'never'},'invalid_mcp_startup_notification'],['failed',{status:'failed'},'native_mcp_startup_failed'],
 ['cancelled',{status:'cancelled'},'native_mcp_startup_failed'],['explicit-error',{error:'SYNTHETIC_PRIVATE_ERROR'},'native_mcp_startup_failed'],
 ['reauth-required',{failureReason:'reauthenticationRequired'},'native_mcp_startup_failed'],
] as const)test(`MCP lifecycle ${name} fails closed without readiness or input`,async()=>{
 const h=fixture();await h.session.open();h.wire.push({method:'mcpServer/startupStatus/updated',params:mcpStatus(over)});await tick();expect(h.session.idle).toBe(false);await expect(h.session.turn('mcp-rejected','sample')).rejects.toThrow(code);expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);expect(h.session.diagnostics().code).toBe(code);
});
test('scoped MCP ready during active turn cannot complete it or replace native terminal evidence',async()=>{
 const h=fixture(),{pending}=await running(h);let completed=false;void pending.then(()=>{completed=true;});h.wire.push({method:'mcpServer/startupStatus/updated',params:mcpStatus()});await tick();expect(completed).toBe(false);expect(h.session.idle).toBe(false);expect(h.session.pendingApproval).toBe(false);complete(h.wire);expect((await pending).turnId).toBe(turnId);
});
test('global MCP metadata before initialize cannot establish scope',async()=>{
 const h=fixture();h.wire.onSend=f=>{if(f.method==='initialize')h.wire.push({method:'mcpServer/startupStatus/updated',params:mcpStatus({threadId:null})});};await expect(h.session.open()).rejects.toThrow('notification_scope_mismatch');expect(h.wire.frames.map(f=>f.method)).toEqual(['initialize']);
});
test('unknown MCP method still poisons after open; safe diagnostics explain idle false without leaking values',async()=>{
 const sentinel='SYNTHETIC_PRIVATE_VALUE_NEVER_EXPORT';const h=fixture();await h.session.open();h.wire.push({method:sentinel,params:{[sentinel]:sentinel,error:sentinel,threadId:other,name:sentinel,status:sentinel}});await tick();
 const diagnostic=h.session.diagnostics();expect(diagnostic).toMatchObject({phase:'open',broken:true,idle:false,code:'unsupported_notification'});expect(diagnostic.lastFrame).toMatchObject({method:'[unsupported]',threadScope:'foreign',errorType:'string',status:'[other]',unknownKeys:1});expect(JSON.stringify(diagnostic)).not.toContain(sentinel);expect(JSON.stringify(diagnostic)).not.toContain(other);
 diagnostic.lastFrame!.paramsKeys.push(sentinel);expect(JSON.stringify(h.session.diagnostics())).not.toContain(sentinel);expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);
});
test('MCP failure diagnostics never expose server name or error body',async()=>{
 const h=fixture();await h.session.open();h.wire.push({method:'mcpServer/startupStatus/updated',params:mcpStatus({name:'SYNTHETIC_PRIVATE_NAME',error:'SYNTHETIC_PRIVATE_ERROR'})});await tick();const diagnostic=JSON.stringify(h.session.diagnostics());expect(diagnostic).not.toContain('SYNTHETIC_PRIVATE');expect(diagnostic).not.toContain(threadId);expect(h.session.diagnostics().code).toBe('native_mcp_startup_failed');
});
test.skipIf(!existsSync(schemaRoot))('MCP lifecycle fixtures conform to generated exact-pin status schema',()=>{
 const schema=JSON.parse(readFileSync(join(schemaRoot,'v2/McpServerStatusUpdatedNotification.json'),'utf8'));
 for(const status of ['starting','ready','failed','cancelled'])expect(schemaCheck(mcpStatus({status}),schema,schema)).toBe(true);expect(schemaCheck(mcpStatus({status:'connected'}),schema,schema)).toBe(false);expect(schemaCheck(mcpStatus({failureReason:'unknown'}),schema,schema)).toBe(false);
});

describe('Exact-pin terminal summary hydrates full history once',()=>{
 const readResult=(items:any[]=[finalItem()])=>({thread:{...thread(),turns:[turn('completed',items)]}});
 const terminal=(wire:Wire,view:string,items:any[])=>event(wire,'turn/completed',{threadId,turn:{...turn('completed',items),itemsView:view}});
 for(const conflict of [false,true])test(`terminal duplicate during deferred hydration conflict=${conflict}`,async()=>{
  const h=fixture(),{pending}=await running(h);let read:any;h.wire.onSend=f=>{if(f.method==='thread/read')read=f;};
  terminal(h.wire,'summary',[finalItem()]);await tick();
  const item={...finalItem(),...(conflict?{text:'replacement'}:{})};terminal(h.wire,'summary',[item]);await tick();
  h.wire.push({id:read.id,result:readResult([item])});
  if(conflict){await expect(pending).rejects.toMatchObject({code:'turn_not_safely_completed',uncertain:true});expect(h.session.idle).toBe(false);}
  else expect((await pending).text).toBe(finalItem().text);
  expect(h.wire.frames.filter(f=>f.method==='thread/read')).toHaveLength(1);expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 for(const model of [undefined,null,policy.model])test(`hydrated optional configured model ${String(model)} follows open semantics`,async()=>{
  const h=fixture(),{pending}=await running(h);h.wire.onSend=f=>{if(f.method==='thread/read'){const r:any=readResult();if(model===undefined)delete r.thread.model;else r.thread.model=model;h.wire.push({id:f.id,result:r});}};
  terminal(h.wire,'summary',[finalItem()]);expect((await pending).state).toBe('completed');
 });
 for(const view of ['summary','notLoaded'])test(`${view} waits for a single exact read, not a turn replay`,async()=>{
  const h=fixture(),{pending}=await running(h);let read:any;let done=false;void pending.then(()=>{done=true;});
  h.wire.onSend=f=>{if(f.method==='thread/read')read=f;};
  event(h.wire,'item/completed',{threadId,turnId,item:finalItem()});terminal(h.wire,view,view==='summary'?[finalItem()]:[]);
  await tick();expect(done).toBe(false);expect(read.params).toEqual({threadId,includeTurns:true});
  h.wire.push({id:read.id,result:readResult()});expect((await pending).text).toBe(finalItem().text);
  expect(h.wire.frames.filter(f=>f.method==='thread/read')).toHaveLength(1);expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 test.each(['thread','turn','duplicate-turn','cwd','model','provider','active','summary','notLoaded','failed','error','missing-observed','changed-final','duplicate-item','failed-tool','pending-tool'])('hydration rejects %s without replay',async kind=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'item/completed',{threadId,turnId,item:finalItem()});
  h.wire.onSend=f=>{if(f.method!=='thread/read')return;const r:any=readResult(),t=r.thread,v=t.turns[0];
   if(kind==='thread')t.id=other;if(kind==='turn')v.id=other;if(kind==='duplicate-turn')t.turns.push(structuredClone(v));
   if(kind==='cwd')t.cwd='/home/example/other';if(kind==='model')t.model='other';if(kind==='provider')t.modelProvider='other';if(kind==='active')t.status={type:'active'};
   if(kind==='summary'||kind==='notLoaded')v.itemsView=kind;if(kind==='failed')v.status='failed';if(kind==='error')v.error={message:'synthetic'};
   if(kind==='missing-observed')v.items=[];if(kind==='changed-final')v.items[0].text='different';if(kind==='duplicate-item')v.items.push(finalItem());
   if(kind==='failed-tool'||kind==='pending-tool')v.items.push({type:'commandExecution',id:'hydrated-tool',status:kind==='failed-tool'?'completed':'inProgress',exitCode:1});
   h.wire.push({id:f.id,result:r});
  };
  terminal(h.wire,'summary',[finalItem()]);await expect(pending).rejects.toMatchObject({uncertain:true});expect(h.session.idle).toBe(false);
  await expect(h.session.turn('no-replay','sample')).rejects.toThrow();expect(h.wire.frames.filter(f=>f.method==='thread/read')).toHaveLength(1);expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 test('pending stream item cannot be cleared by a summary or a successful read',async()=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'item/started',{threadId,turnId,item:{id:'pending',type:'mcpToolCall'}});terminal(h.wire,'summary',[finalItem()]);
  await expect(pending).rejects.toMatchObject({uncertain:true});expect(h.wire.frames.some(f=>f.method==='thread/read')).toBe(false);
 });
 test('pending approval cannot be cleared by summary hydration',async()=>{
  const h=fixture({approve:()=>new Promise(()=>{})}),{pending}=await running(h);approval(h.wire);await tick();terminal(h.wire,'summary',[finalItem()]);
  await expect(pending).rejects.toMatchObject({uncertain:true});expect(h.wire.frames.some(f=>f.method==='thread/read')).toBe(false);
 });
 for(const late of ['item','approval'])test(`late ${late} while read is awaited cannot be erased by hydration`,async()=>{
  const h=fixture({approve:()=>new Promise(()=>{})}),{pending}=await running(h);let read:any;
  h.wire.onSend=f=>{if(f.method==='thread/read')read=f;};terminal(h.wire,'summary',[finalItem()]);await tick();
  if(late==='item')event(h.wire,'item/started',{threadId,turnId,item:{id:'late-pending',type:'mcpToolCall'}});else approval(h.wire);
  await tick();h.wire.push({id:read.id,result:readResult()});await expect(pending).rejects.toMatchObject({uncertain:true});
  expect(h.wire.frames.filter(f=>f.method==='thread/read')).toHaveLength(1);expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 for(const cause of ['disconnect','rpc-error','timeout'])test(`read ${cause} remains uncertain with no retry`,async()=>{
  const h=fixture({}, {timeoutMs:50}),{pending}=await running(h);
  h.wire.onSend=f=>{if(f.method==='thread/read'){if(cause==='disconnect')void h.wire.close();if(cause==='rpc-error')h.wire.push({id:f.id,error:{code:-1,message:'synthetic'}});}};
  terminal(h.wire,'summary',[finalItem()]);await expect(pending).rejects.toMatchObject({uncertain:true});expect(h.wire.frames.filter(f=>f.method==='thread/read')).toHaveLength(1);
 });
 test.skipIf(!existsSync(schemaRoot))('read params and response validate against independently generated pinned schemas',()=>{
  for(const [name,value]of [['ThreadReadParams',{threadId,includeTurns:true}],['ThreadReadResponse',readResult()]]as const){const s=JSON.parse(readFileSync(join(schemaRoot,'v2',name+'.json'),'utf8'));expect(schemaCheck(value,s,s)).toBe(true);}
 });
});

describe('Bounded exact-pin hydration deprecation notice',()=>{
 const terminal=(wire:Wire)=>event(wire,'turn/completed',{threadId,turn:{...turn('completed',[finalItem()]),itemsView:'summary'}});
 for(const details of [undefined,null,'Use paginated history.'])test(`informational notice details=${String(details)} never completes or grants readiness`,async()=>{
  const h=fixture(),{pending}=await running(h);let read:any,done=false;void pending.then(()=>{done=true;});
  h.wire.onSend=f=>{if(f.method==='thread/read')read=f;};terminal(h.wire);await tick();event(h.wire,'deprecationNotice',{summary:'Full-history hydration is deprecated.',...(details===undefined?{}:{details})});await tick();
  expect(done).toBe(false);expect(h.session.idle).toBe(false);expect(h.session.pendingApproval).toBe(false);
  h.wire.push({id:read.id,result:{thread:{...thread(),turns:[turn('completed',[finalItem()])]}}});expect((await pending).state).toBe('completed');expect(h.wire.frames.filter(f=>f.method==='thread/read')).toHaveLength(1);expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 for(const params of [{},{summary:7},{summary:''},{summary:'x',details:7},{summary:'x'.repeat(4097)},{summary:'x',details:'x'.repeat(8193)},{summary:'x\0'},{summary:'x',threadId},{summary:'x',approvalPolicy:'never'}])test('malformed or authority-bearing notice rejected: '+JSON.stringify(params).slice(0,80),async()=>{
  const h=fixture(),{pending}=await running(h);h.wire.onSend=()=>{};terminal(h.wire);await tick();event(h.wire,'deprecationNotice',params);await expect(pending).rejects.toMatchObject({uncertain:true});
 });
 test('repeated notices are bounded to one and do not extend the read',async()=>{
  const h=fixture(),{pending}=await running(h);h.wire.onSend=()=>{};terminal(h.wire);await tick();event(h.wire,'deprecationNotice',{summary:'Deprecated.'});event(h.wire,'deprecationNotice',{summary:'Deprecated.'});await expect(pending).rejects.toThrow('notification_scope_mismatch');expect(h.wire.frames.filter(f=>f.method==='thread/read')).toHaveLength(1);
 });
 test('notice before hydration fails closed; unrelated unknown method is not ignored',async()=>{
  for(const method of ['deprecationNotice','unknownDeprecationNotice']){const h=fixture(),{pending}=await running(h);event(h.wire,method,{summary:'Deprecated.'});await expect(pending).rejects.toMatchObject({uncertain:true});expect(h.wire.frames.some(f=>f.method==='thread/read')).toBe(false);}
 });
 test('notice after read response is not accepted as a global passive event',async()=>{
  const h=fixture(),{pending}=await running(h);h.wire.onSend=f=>{if(f.method==='thread/read'){h.wire.push({id:f.id,result:{thread:{...thread(),turns:[turn('completed',[finalItem()])]}}});event(h.wire,'deprecationNotice',{summary:'Late.'});}};
  terminal(h.wire);await pending.catch(()=>{});await tick();expect(h.session.diagnostics().broken).toBe(true);expect(h.session.idle).toBe(false);
 });
 test.skipIf(!existsSync(schemaRoot))('notice fixture follows saved 0.164 generated schema',()=>{const s=JSON.parse(readFileSync(join(schemaRoot,'v2/DeprecationNoticeNotification.json'),'utf8'));expect(schemaCheck({summary:'Deprecated.',details:null},s,s)).toBe(true);});
});

describe('Exact-resume startup deprecation notice window',()=>{
 test('one notice while exact thread/resume awaits response does not establish identity',async()=>{
  const h=fixture();let resume:any,done=false;h.wire.onSend=f=>{if(f.method==='initialize')h.wire.push({id:f.id,result:init});if(f.method==='thread/resume')resume=f;};
  const opening=h.session.open(threadId);void opening.then(()=>{done=true;});await tick();expect(resume.params.threadId).toBe(threadId);
  event(h.wire,'deprecationNotice',{summary:'Full-history resume deprecated.',details:null});await tick();expect(done).toBe(false);expect(h.session.idle).toBe(false);
  h.wire.push({id:resume.id,result:opened()});expect((await opening).nativeId).toBe(threadId);expect(h.wire.frames.filter(f=>f.method==='thread/resume')).toHaveLength(1);expect(h.wire.frames.some(f=>f.method==='thread/start')).toBe(false);
 });
 for(const scenario of ['fresh-start','initialize','duplicate','scope','wrong-response','after-response'])test(`resume notice ${scenario} fails closed without fallback`,async()=>{
  const h=fixture();h.wire.onSend=f=>{
   if(f.method==='initialize'){
    if(scenario==='initialize')event(h.wire,'deprecationNotice',{summary:'Early.'});
    h.wire.push({id:f.id,result:init});
   }
   if(f.method==='thread/start')event(h.wire,'deprecationNotice',{summary:'Fresh is outside this window.'});
   if(f.method==='thread/resume'){
    event(h.wire,'deprecationNotice',{summary:'Deprecated.',...(scenario==='scope'?{threadId}: {})});
    if(scenario==='duplicate')event(h.wire,'deprecationNotice',{summary:'Deprecated.'});
    h.wire.push({id:f.id,result:scenario==='wrong-response'?{...opened(),thread:{...thread(),id:other}}:opened()});
    if(scenario==='after-response')event(h.wire,'deprecationNotice',{summary:'Late.'});
   }
  };
  const opening=h.session.open(scenario==='fresh-start'?undefined:threadId);await opening.catch(()=>{});await tick();
  expect(h.session.diagnostics().broken).toBe(true);expect(h.session.idle).toBe(false);expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);
  if(scenario!=='fresh-start')expect(h.wire.frames.some(f=>f.method==='thread/start')).toBe(false);
 });
 test('resume and subsequent hydration each have their own single-notice budget',async()=>{
  const h=fixture();h.wire.onSend=f=>{
   if(f.method==='initialize')h.wire.push({id:f.id,result:init});
   if(f.method==='thread/resume'){event(h.wire,'deprecationNotice',{summary:'Resume deprecated.'});h.wire.push({id:f.id,result:opened()});}
   if(f.method==='turn/start')h.wire.push({id:f.id,result:{turn:turn()}});
   if(f.method==='thread/read'){event(h.wire,'deprecationNotice',{summary:'Read deprecated.'});h.wire.push({id:f.id,result:{thread:{...thread(),turns:[turn('completed',[finalItem()])]}}});}
  };
  await h.session.open(threadId);const pending=h.session.turn('resumed-turn','sample');await tick();event(h.wire,'turn/completed',{threadId,turn:{...turn('completed',[finalItem()]),itemsView:'summary'}});expect((await pending).state).toBe('completed');
 });
});

describe('Exact active-turn native retry errors',()=>{
 const retry=(over:any={})=>({threadId,turnId,willRetry:true,error:{message:'Synthetic transient stream interruption.',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}},...over});
 test('willRetry true is intermediate, never ACK/completion/readiness or another request',async()=>{
  const h=fixture(),{pending}=await running(h);let done=false;void pending.then(()=>{done=true;});const before=structuredClone(h.wire.frames);
  event(h.wire,'error',retry());await tick();expect(done).toBe(false);expect(h.session.idle).toBe(false);expect(h.session.diagnostics().broken).toBe(false);expect(h.wire.frames).toEqual(before);
  complete(h.wire);expect((await pending).state).toBe('completed');expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 for(const error of [{message:'synthetic'},{message:'synthetic',codexErrorInfo:null,additionalDetails:null,misalignment:null},{message:'synthetic',codexErrorInfo:'extension-class'},{message:'synthetic',misalignment:{errorType:null,detailedExplanation:'Information only',reviewTarget:null,steer:{message:'Never automatically submitted.'}}}])test('schema-valid bounded TurnError fields are informational only: '+Object.keys(error).join(','),async()=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'error',retry({error}));await tick();complete(h.wire);expect((await pending).text).toBe(finalItem().text);expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 const malformed:any[]=[{willRetry:false},{willRetry:undefined},{willRetry:'true'},{threadId:other},{turnId:other},{turnId:null},{extra:true},{error:null},{error:{}},{error:{message:4}},{error:{message:'x\0'}},{error:{message:'x'.repeat(8193)}},{error:{message:'x',additionalDetails:4}},{error:{message:'x',codexErrorInfo:7}},{error:{message:'x',misalignment:[]}},{error:{message:'x',misalignment:{steer:{}}}},{error:{message:'x',codexErrorInfo:{extension:'x'.repeat(17000)}}},{error:{message:'x',approvalPolicy:'never'}}];
 for(const over of malformed)test('false/malformed/foreign error fails closed '+JSON.stringify(over).slice(0,100),async()=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'error',retry(over));await expect(pending).rejects.toMatchObject({code:'native_turn_error',uncertain:true});await expect(h.session.turn('no-replay','sample')).rejects.toThrow();expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 test('error cannot bind an unbound native turn before turn/start response',async()=>{
  const h=fixture();await h.session.open();h.wire.onSend=()=>{};const pending=h.session.turn('unbound-retry','sample');pending.catch(()=>{});await tick();event(h.wire,'error',retry());await expect(pending).rejects.toMatchObject({uncertain:true});expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 test('retry error during open is not an active-turn error',async()=>{
  const h=fixture();h.wire.onSend=f=>{if(f.method==='initialize')event(h.wire,'error',retry());};await expect(h.session.open()).rejects.toThrow('native_turn_error');expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);
 });
 test('eight retry observations permitted; ninth fails without clearing pending work',async()=>{
  const h=fixture(),{pending}=await running(h);for(let i=0;i<8;i++)event(h.wire,'error',retry());await tick();expect(h.session.diagnostics().broken).toBe(false);event(h.wire,'error',retry());await expect(pending).rejects.toMatchObject({uncertain:true});expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 test('retry cannot erase observed pending tools',async()=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'item/started',{threadId,turnId,item:{type:'mcpToolCall',id:'pending'}});event(h.wire,'error',retry());complete(h.wire);await expect(pending).rejects.toThrow('turn_not_safely_completed');
 });
 test('retry cannot erase pending approval or approve it',async()=>{
  const h=fixture({approve:()=>new Promise(()=>{})}),{pending}=await running(h);approval(h.wire);await tick();event(h.wire,'error',retry());await tick();expect(h.session.pendingApproval).toBe(true);complete(h.wire);await expect(pending).rejects.toThrow('turn_not_safely_completed');expect(h.wire.frames.some(f=>f.result?.decision==='accept')).toBe(false);
 });
 test.each(['failed','interrupted','error','rerouted','disconnect'])('retry followed by %s cannot complete',async kind=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'error',retry());
  if(kind==='disconnect')await h.wire.close();else if(kind==='rerouted')event(h.wire,'model/rerouted',{threadId,turnId});else if(kind==='error')event(h.wire,'error',retry({willRetry:false}));else event(h.wire,'turn/completed',{threadId,turn:turn(kind,[finalItem()])});
  await expect(pending).rejects.toMatchObject({uncertain:true});expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 test('original deadline remains installed and unchanged after retry notifications',async()=>{
  const h=fixture({}, {timeoutMs:35}),{pending}=await running(h);const timer=(h.session as any).active.timer;
  for(let i=0;i<3;i++){event(h.wire,'error',retry());await tick();expect((h.session as any).active.timer).toBe(timer);}
  await expect(pending).rejects.toMatchObject({code:'turn_timeout',uncertain:true});expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 test('retry after terminal while hydration pending fails rather than reopening the turn',async()=>{
  const h=fixture(),{pending}=await running(h);h.wire.onSend=()=>{};event(h.wire,'turn/completed',{threadId,turn:{...turn('completed',[finalItem()]),itemsView:'summary'}});await tick();event(h.wire,'error',retry());await expect(pending).rejects.toMatchObject({code:'native_turn_error',uncertain:true});expect(h.wire.frames.filter(f=>f.method==='thread/read')).toHaveLength(1);
 });
 test.skipIf(!existsSync(schemaRoot))('retry fixture conforms to generated pinned ErrorNotification schema',()=>{const s=JSON.parse(readFileSync(join(schemaRoot,'v2/ErrorNotification.json'),'utf8'));expect(schemaCheck(retry(),s,s)).toBe(true);});
});

describe('Pure value-free Codex telemetry projection',()=>{
 const secret='SYNTHETIC_PRIVATE_HEADER_BODY_TOKEN';
 const error=(over:any={})=>({method:'error',params:{threadId,turnId,willRetry:true,error:{message:secret,codexErrorInfo:'serverOverloaded',additionalDetails:secret},...over}});
 test('pure projection is deterministic, does not mutate input or expose message/body/header/token/UUID',()=>{
  const frame=error({[secret]:secret,headers:{Authorization:secret},body:secret});const original=structuredClone(frame);
  const d=projectCodexDiagnosticFrame(frame,{threadId,turnId});expect(d).toMatchObject({method:'error',threadScope:'matches',turnScope:'matches',willRetry:'true',errorClass:'serverOverloaded',unknownKeys:3});
  expect(projectCodexDiagnosticFrame(frame,{threadId,turnId})).toEqual(d);expect(frame).toEqual(original);
  const encoded=JSON.stringify(d);for(const value of [secret,threadId,turnId,'Authorization','headers','body'])expect(encoded).not.toContain(value);
 });
 test.each([[true,'true'],[false,'false'],[undefined,'invalid'],['true','invalid'],[secret,'invalid']] as const)('willRetry %j maps only to enum %s',(value,expected)=>{
  expect(projectCodexDiagnosticFrame(error({willRetry:value})).willRetry).toBe(expected);
 });
 test('missing/null/foreign/unbound IDs are scope categories only, never identity evidence',()=>{
  expect(projectCodexDiagnosticFrame(error(),{threadId:other,turnId:other})).toMatchObject({threadScope:'foreign',turnScope:'foreign'});
  expect(projectCodexDiagnosticFrame(error())).toMatchObject({threadScope:'unbound',turnScope:'unbound'});
  expect(projectCodexDiagnosticFrame({method:'error',params:{threadId:null,turnId:null}})).toMatchObject({threadScope:'null',turnScope:'null',willRetry:'absent'});
  expect(projectCodexDiagnosticFrame({method:'error',params:{}})).toMatchObject({threadScope:'absent',turnScope:'absent'});
 });
 for(const [info,expected]of [['unauthorized','unauthorized'],[secret,'[other]'],[null,'null'],[{responseStreamDisconnected:{httpStatusCode:503}},'responseStreamDisconnected'],[{responseStreamDisconnected:{httpStatusCode:secret}},'[other]'],[{responseStreamDisconnected:{headers:secret}},'[other]'],[{[secret]:{message:secret}},'[other]'],[{responseStreamDisconnected:{},httpConnectionFailed:{}},'[other]'],[{activeTurnNotSteerable:{turnKind:'compact'}},'activeTurnNotSteerable'],[{activeTurnNotSteerable:{turnKind:secret}},'[other]']]as const)test('class projects fixed enum only '+String(expected),()=>{
  const d=projectCodexDiagnosticFrame(error({error:{message:secret,codexErrorInfo:info}}));expect(d.errorClass).toBe(expected);expect(JSON.stringify(d)).not.toContain(secret);
 });
 test('nested terminal status/itemsView/error and systemError status have bounded projections',()=>{
  const d=projectCodexDiagnosticFrame({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',itemsView:'summary',items:[{text:secret}],error:{message:secret,codexErrorInfo:'internalServerError'}}}},{threadId,turnId});
  expect(d).toMatchObject({turnScope:'matches',status:'completed',itemsView:'summary',errorClass:'internalServerError'});expect(JSON.stringify(d)).not.toContain(secret);
  expect(projectCodexDiagnosticFrame({method:'thread/status/changed',params:{threadId,status:{type:'systemError',message:secret}}},{threadId}).status).toBe('systemError');
  expect(projectCodexDiagnosticFrame({method:secret,params:{status:secret,turn:{status:secret,itemsView:secret}}}).status).toBe('[other]');
 });
 test('session preserves safe lastError through final completion; cloned output cannot mutate internal telemetry',async()=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'error',error().params);await tick();
  expect(h.session.diagnostics().lastError).toMatchObject({threadScope:'matches',turnScope:'matches',willRetry:'true',errorClass:'serverOverloaded'});
  complete(h.wire);await pending;const d=h.session.diagnostics();expect(d.lastTerminal).toMatchObject({status:'completed',itemsView:'full',turnScope:'matches'});expect(d.timeout).toBe('none');
  d.lastError!.paramsKeys.push(secret);expect(JSON.stringify(h.session.diagnostics())).not.toContain(secret);expect(JSON.stringify(h.session.diagnostics())).not.toContain(threadId);expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 test('foreign error remains rejected and is labelled foreign, never upgraded to an accepted retry',async()=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'error',error({threadId:other,turnId:other}).params);await expect(pending).rejects.toMatchObject({uncertain:true});expect(h.session.diagnostics().lastError).toMatchObject({threadScope:'foreign',turnScope:'foreign',willRetry:'true'});
 });
 test('systemError retains safe status and rejects; no raw error output',async()=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'thread/status/changed',{threadId,status:{type:'systemError',message:secret}});await expect(pending).rejects.toThrow('native_thread_error');expect(h.session.diagnostics().lastTerminal?.status).toBe('systemError');expect(JSON.stringify(h.session.diagnostics())).not.toContain(secret);
 });
 test('turn and RPC timeout categories contain no error text and do not change timeout behavior',async()=>{
  const h=fixture({}, {timeoutMs:25}),{pending}=await running(h);await expect(pending).rejects.toThrow('turn_timeout');expect(h.session.diagnostics().timeout).toBe('turn');
  const opening=fixture({}, {timeoutMs:25});opening.wire.onSend=()=>{};await expect(opening.session.open()).rejects.toThrow('protocol_timeout');expect(opening.session.diagnostics().timeout).toBe('rpc');
 });
});

test('current-turn diagnostics reset historical error/terminal only when a new turn is admitted',async()=>{
 const h=fixture(),{pending}=await running(h);event(h.wire,'error',{threadId,turnId,willRetry:true,error:{message:'synthetic',codexErrorInfo:'serverOverloaded'}});complete(h.wire);await pending;
 expect(h.session.diagnostics().lastError?.errorClass).toBe('serverOverloaded');expect(h.session.diagnostics().lastTerminal?.status).toBe('completed');
 await expect(h.session.turn('op-one','replay')).rejects.toThrow('operation_replay');expect(h.session.diagnostics().lastError).toBeDefined();
 h.wire.onSend=()=>{};const next=h.session.turn('second-turn','next');next.catch(()=>{});
 expect(h.session.diagnostics().lastError).toBeUndefined();expect(h.session.diagnostics().lastTerminal).toBeUndefined();expect(h.session.diagnostics().lastFrame).toBeUndefined();
 await tick();const request=h.wire.frames.at(-1)!;h.wire.push({id:request.id,result:{turn:turn()}});await tick();complete(h.wire);await next;
 expect(h.session.diagnostics().lastError).toBeUndefined();expect(h.session.diagnostics().lastTerminal?.status).toBe('completed');expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(2);
});

describe('Full pinned notification names are diagnostic-only',()=>{
 test.skipIf(!existsSync(schemaRoot))('every actual ServerNotification method enum projects without granting support',()=>{
  const schema=JSON.parse(readFileSync(join(schemaRoot,'ServerNotification.json'),'utf8'));const methods=schema.oneOf.flatMap((v:any)=>v.properties?.method?.enum??[]);
  expect(methods).toHaveLength(85);for(const method of methods)expect(projectCodexDiagnosticFrame({method,params:{threadId}},{threadId}).method).toBe(method);
  expect(projectCodexDiagnosticFrame({method:'unregistered-secret-method',params:{}}).method).toBe('[unsupported]');
 });
 test.each(['thread/archived','thread/deleted','thread/closed','thread/reverted','thread/queue/changed'])('recognizing %s in telemetry does not accept it after turn/start',async method=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,method,{threadId});await expect(pending).rejects.toMatchObject({code:'unsupported_notification',uncertain:true});
  const d=h.session.diagnostics();expect(d.lastFrame).toMatchObject({method,threadScope:'matches',turnScope:'absent'});expect(JSON.stringify(d)).not.toContain(threadId);expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 test('known lifecycle method with foreign scope is still observed as foreign and rejected',async()=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'thread/queue/changed',{threadId:other});await expect(pending).rejects.toMatchObject({uncertain:true});expect(h.session.diagnostics().lastFrame).toMatchObject({method:'thread/queue/changed',threadScope:'foreign'});
 });
});

describe('Strict informational unarchived lifecycle',()=>{
 test('verified exact-thread unarchived after turn/start does not grant completion or clear pending work',async()=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'item/started',{threadId,turnId,item:{type:'mcpToolCall',id:'pending-lifecycle'}});const before=structuredClone(h.wire.frames);
  event(h.wire,'thread/unarchived',{threadId});await tick();expect(h.session.diagnostics().broken).toBe(false);expect(h.session.idle).toBe(false);expect(h.wire.frames).toEqual(before);
  complete(h.wire);await expect(pending).rejects.toThrow('turn_not_safely_completed');
 });
 test('pending exact resume permits matching unarchived without establishing identity; all response identity checks remain',async()=>{
  const h=fixture();let resume:any;h.wire.onSend=f=>{if(f.method==='initialize')h.wire.push({id:f.id,result:init});if(f.method==='thread/resume')resume=f;};
  const opening=h.session.open(threadId);await tick();event(h.wire,'thread/unarchived',{threadId});await tick();expect(h.session.idle).toBe(false);expect(h.session.diagnostics().broken).toBe(false);
  h.wire.push({id:resume.id,result:{...opened(),thread:{...thread(),id:other}}});await expect(opening).rejects.toThrow('thread_identity_mismatch');expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);
 });
 test('unarchived observation after open permits normal exact final only',async()=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'thread/unarchived',{threadId});await tick();complete(h.wire);expect((await pending).state).toBe('completed');expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 for(const params of [{},{threadId:null},{threadId:7},{threadId:'not-uuid'},{threadId:other},{threadId,turnId},{threadId,approvalPolicy:'never'}])test('unarchived malformed/foreign/scope fields fail closed '+JSON.stringify(params),async()=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'thread/unarchived',params);await expect(pending).rejects.toMatchObject({uncertain:true});expect(h.session.idle).toBe(false);
 });
 test('no identity may be established by an event before initialize or on fresh startup before response',async()=>{
  for(const early of [true,false]){const h=fixture();h.wire.onSend=f=>{if(f.method==='initialize'){if(early)event(h.wire,'thread/unarchived',{threadId});h.wire.push({id:f.id,result:init});}if(f.method==='thread/start')event(h.wire,'thread/unarchived',{threadId});};await expect(h.session.open()).rejects.toThrow('notification_scope_mismatch');expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);}
 });
 test.skipIf(!existsSync(schemaRoot))('informational fixture validates pinned unarchived schema',()=>{const s=JSON.parse(readFileSync(join(schemaRoot,'v2/ThreadUnarchivedNotification.json'),'utf8'));expect(schemaCheck({threadId},s,s)).toBe(true);});
});

describe('Strict informational goal cleared lifecycle',()=>{
 test('observed post-resume goal-cleared frame preserves verified identity and sends no user input',async()=>{
  const h=fixture();h.wire.onSend=f=>{if(f.method==='initialize')h.wire.push({id:f.id,result:init});if(f.method==='thread/resume'){h.wire.push({id:f.id,result:opened()});event(h.wire,'thread/goal/cleared',{threadId});}};
  const identity=await h.session.open(threadId);await tick();expect(identity.nativeId).toBe(threadId);expect(h.session.diagnostics().broken).toBe(false);expect(h.session.idle).toBe(true);expect(h.session.diagnostics().lastFrame).toMatchObject({method:'thread/goal/cleared',threadScope:'matches'});
  expect(h.wire.frames.map(f=>f.method)).toEqual(['initialize','initialized','thread/resume']);
 });
 test('pending exact-resume goal-cleared is not an open ACK and cannot establish identity or waive native mismatch',async()=>{
  const h=fixture();let request:any,done=false;h.wire.onSend=f=>{if(f.method==='initialize')h.wire.push({id:f.id,result:init});if(f.method==='thread/resume')request=f;};
  const opening=h.session.open(threadId);opening.catch(()=>{});void opening.then(()=>{done=true;},()=>{});await tick();event(h.wire,'thread/goal/cleared',{threadId});await tick();expect(done).toBe(false);expect(h.session.idle).toBe(false);expect(h.session.diagnostics().broken).toBe(false);
  h.wire.push({id:request.id,result:{...opened(),thread:{...thread(),id:other}}});await expect(opening).rejects.toThrow('thread_identity_mismatch');expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);
 });
 test('active goal-cleared changes neither deadline, pending tools, wire nor completion',async()=>{
  const h=fixture(),{pending}=await running(h);let done=false;void pending.then(()=>{done=true;},()=>{});event(h.wire,'item/started',{threadId,turnId,item:{type:'mcpToolCall',id:'still-pending'}});await tick();const before=structuredClone(h.wire.frames),timer=(h.session as any).active.timer;
  event(h.wire,'thread/goal/cleared',{threadId});await tick();expect(done).toBe(false);expect(h.session.idle).toBe(false);expect((h.session as any).active.timer).toBe(timer);expect(h.wire.frames).toEqual(before);
  complete(h.wire);await expect(pending).rejects.toThrow('turn_not_safely_completed');
 });
 test('goal-cleared cannot clear an outstanding approval or grant an approval',async()=>{
  const h=fixture({approve:()=>new Promise(()=>{})}),{pending}=await running(h);approval(h.wire);await tick();event(h.wire,'thread/goal/cleared',{threadId});await tick();expect(h.session.pendingApproval).toBe(true);expect(h.wire.frames.some(f=>f.result?.decision==='accept')).toBe(false);complete(h.wire);await expect(pending).rejects.toThrow('turn_not_safely_completed');
 });
 test('goal-cleared alone has no final authority; normal exact terminal still required',async()=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'thread/goal/cleared',{threadId});await tick();expect(h.session.idle).toBe(false);complete(h.wire);expect((await pending).text).toBe(finalItem().text);expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 for(const params of [{},{threadId:null},{threadId:3},{threadId:'not-uuid'},{threadId:other},{threadId,turnId},{threadId,goal:{state:'completed'}},{threadId,ready:true},{threadId,result:'completed'},{threadId,approvalPolicy:'never'}])test('malformed/foreign/authority-bearing goal-cleared rejects '+JSON.stringify(params),async()=>{
  const h=fixture(),{pending}=await running(h);event(h.wire,'thread/goal/cleared',params);await expect(pending).rejects.toMatchObject({uncertain:true});expect(h.session.idle).toBe(false);expect(h.wire.frames.filter(f=>f.method==='turn/start')).toHaveLength(1);
 });
 test('before-initialize and unbound fresh-start windows reject goal-cleared',async()=>{
  for(const early of [true,false]){const h=fixture();h.wire.onSend=f=>{if(f.method==='initialize'){if(early)event(h.wire,'thread/goal/cleared',{threadId});h.wire.push({id:f.id,result:init});}if(f.method==='thread/start')event(h.wire,'thread/goal/cleared',{threadId});};await expect(h.session.open()).rejects.toThrow('notification_scope_mismatch');expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);}
 });
 test('unsupported goal update/unknown notifications remain rejected',async()=>{
  for(const method of ['thread/goal/updated','thread/goal/unknown']){const h=fixture(),{pending}=await running(h);event(h.wire,method,{threadId});await expect(pending).rejects.toThrow('unsupported_notification');}
 });
 test.skipIf(!existsSync(schemaRoot))('goal-cleared fixture validates the actual saved exact-pin schema',()=>{const s=JSON.parse(readFileSync(join(schemaRoot,'v2/ThreadGoalClearedNotification.json'),'utf8'));expect(schemaCheck({threadId},s,s)).toBe(true);});
});

test('goal-cleared queued after a matching resume UUID response cannot bypass response permission/model verification',async()=>{
 for(const field of ['model','approvalPolicy']){
  const h=fixture();h.wire.onSend=f=>{if(f.method==='initialize')h.wire.push({id:f.id,result:init});if(f.method==='thread/resume'){const r:any=opened();r[field]=field==='model'?'wrong-model':'never';h.wire.push({id:f.id,result:r});event(h.wire,'thread/goal/cleared',{threadId});}};
  await expect(h.session.open(threadId)).rejects.toThrow(field==='model'?'thread_identity_mismatch':'permission_policy_unverified');expect(h.session.idle).toBe(false);expect(h.wire.frames.some(f=>f.method==='turn/start')).toBe(false);
 }
});
