import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexProtocolSession } from '../src/mobile/continuity/protocol/codex';
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
const schemaRoot='/Users/ball/oracle/ψ/incubate/Artron-Innovative-Co-Ltd/artron-cli/checks/protocol-entry-20261108/codex-schema';
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
