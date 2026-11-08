/** Codex app-server 0.164 v2, private DI transport only. No process, HTTP or import-time I/O. */
import { isAbsolute, normalize } from 'node:path';
import { ProtocolError, type NativeProtocolSession, type ProtocolWire, type ProtocolPolicy, type ProtocolHooks, type ProtocolIdentity, type ProtocolTurn } from './types';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object=(v:any):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const token=(v:unknown,max=512):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\0\r\n]/.test(v);
const path=(v:unknown):v is string=>token(v,4096)&&isAbsolute(v)&&normalize(v)===v;
const key=(id:any)=>`${typeof id}:${id}`;
const requestId=(id:any)=>typeof id==='string'&&token(id,1024)||Number.isSafeInteger(id);
type Pending={resolve:(v:any)=>void;reject:(e:ProtocolError)=>void;timer:ReturnType<typeof setTimeout>};
type Active={operationId:string;turnId?:string;acked:boolean;pending:Map<string,string>;items:Map<string,any>;completion?:any;resolve:(v:ProtocolTurn)=>void;reject:(e:ProtocolError)=>void;timer:ReturnType<typeof setTimeout>};
const itemTypes=new Set(['userMessage','hookPrompt','agentMessage','functionCallOutput','plan','reasoning','commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentToolCall','subAgentActivity','webSearch','imageView','sleep','imageGeneration','enteredReviewMode','exitedReviewMode','contextCompaction']);
const toolTypes=new Set(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentToolCall','imageGeneration']);
const passive=new Set(['thread/started','thread/name/updated','thread/tokenUsage/updated','account/rateLimits/updated','item/agentMessage/delta','item/reasoning/textDelta','item/reasoning/summaryTextDelta','item/reasoning/summaryPartAdded','item/commandExecution/outputDelta','item/fileChange/outputDelta','item/mcpToolCall/progress','turn/diff/updated','turn/plan/updated']);
export class CodexProtocolSession implements NativeProtocolSession {
  private readonly policy:ProtocolPolicy;
  private readonly hooks:ProtocolHooks;
  private identity?:ProtocolIdentity;
  private broken?:ProtocolError;
  private opening=false;
  private pumping=false;
  private closing?:Promise<void>;
  private serial=0;
  private rpc=new Map<string,Pending>();
  private active?:Active;
  private approvals=new Set<string>();
  private approvalIds=new Set<string>();
  private operations=new Set<string>();
  constructor(private readonly wire:ProtocolWire,policy:ProtocolPolicy,hooks:ProtocolHooks={}){
    if(!policy||policy.agent!=='codex'||!path(policy.cwd)||!path(policy.home)||policy.toolHome!==undefined&&!path(policy.toolHome)||!token(policy.model)||!token(policy.route)||!token(policy.modelProvider)||!Number.isSafeInteger(policy.timeoutMs)||policy.timeoutMs<1||policy.timeoutMs>300_000)throw new ProtocolError('invalid_codex_policy');
    this.policy=structuredClone(policy);this.hooks={approve:hooks.approve};
  }
  get idle(){return !!this.identity&&!this.opening&&!this.active&&!this.broken;}
  get pendingApproval(){return this.approvals.size>0;}
  private poison(code:string,uncertain=!!this.active||this.opening){
    if(this.broken)return this.broken;
    const e=this.broken=new ProtocolError(code,uncertain);
    for(const p of this.rpc.values()){clearTimeout(p.timer);p.reject(e);}this.rpc.clear();
    if(this.active){clearTimeout(this.active.timer);this.active.reject(e);this.active=undefined;}
    this.approvals.clear();return e;
  }
  private ensure(){if(this.broken)throw this.broken;}
  private startPump(){if(this.pumping)return;this.pumping=true;void(async()=>{try{for await(const f of this.wire.messages){if(this.broken)break;this.frame(f);}if(!this.broken)this.poison('protocol_disconnected');}catch{this.poison('protocol_disconnected');}})();}
  private async request(method:string,params:Record<string,unknown>):Promise<any>{
    this.ensure();const id=`maw-${++this.serial}`;
    const promise=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>this.poison('protocol_timeout'),this.policy.timeoutMs);this.rpc.set(key(id),{resolve,reject,timer});});
    // Install the waiter before write; a DI wire or real server may respond immediately.
    void Promise.resolve().then(()=>this.wire.send({id,method,params})).catch(()=>this.poison('protocol_write_failed'));
    return promise;
  }
  async open(nativeId?:string):Promise<ProtocolIdentity>{
    this.ensure();if(nativeId!==undefined&&(!token(nativeId)||!UUID.test(nativeId)))throw new ProtocolError('invalid_native_id');
    if(this.opening||this.identity)throw new ProtocolError('session_already_open');
    this.opening=true;this.startPump();
    try{
      const init=await this.request('initialize',{clientInfo:{name:'maw-continuity',version:'1'},capabilities:{experimentalApi:false}});
      if(!object(init)||!path(init.codexHome)||this.policy.toolHome!==undefined&&init.codexHome!==this.policy.toolHome||!token(init.userAgent,4096)||!token(init.platformFamily)||!token(init.platformOs))throw this.poison('initialize_identity_mismatch');
      await this.wire.send({method:'initialized'});
      const params={model:this.policy.model,modelProvider:this.policy.modelProvider,cwd:this.policy.cwd,approvalPolicy:'on-request',sandbox:'read-only',approvalsReviewer:'user',...(nativeId?{threadId:nativeId}:{})};
      const result=await this.request(nativeId?'thread/resume':'thread/start',params),t=result?.thread;
      if(!object(result)||!object(t)||!UUID.test(t.id)||nativeId!==undefined&&t.id!==nativeId||result.model!==this.policy.model||result.cwd!==this.policy.cwd||result.modelProvider!==this.policy.modelProvider||t.cwd!==this.policy.cwd||t.modelProvider!==this.policy.modelProvider||t.model!==undefined&&t.model!==null&&t.model!==this.policy.model||t.ephemeral!==false||t.forkedFromId!=null||t.status?.type!=='idle'||!Array.isArray(t.turns)||t.turns.some((v:any)=>v.status==='inProgress'))throw this.poison('thread_identity_mismatch');
      // Fixed host pilot profile read-only-ask, not production permission parity. Never send caller config.
      if(result.approvalPolicy!=='on-request'||result.sandbox?.type!=='readOnly'||result.sandbox.networkAccess===true||result.approvalsReviewer!=='user')throw this.poison('permission_policy_unverified');
      this.identity={agent:'codex',nativeId:t.id,model:result.model,cwd:result.cwd,home:this.policy.home,route:this.policy.route};
      return structuredClone(this.identity);
    }catch(e){if(!this.broken)this.poison(e instanceof ProtocolError?e.code:'protocol_open_failed');throw this.broken!;}
    finally{this.opening=false;}
  }
  async turn(operationId:string,text:string):Promise<ProtocolTurn>{
    this.ensure();if(!this.identity||this.opening)throw new ProtocolError('session_not_open');
    if(this.active||this.pendingApproval)throw new ProtocolError('turn_in_progress');
    if(!token(operationId,128)||typeof text!=='string'||!text.trim()||text.includes('\0')||Buffer.byteLength(text)>32_000)throw new ProtocolError('invalid_turn');
    if(this.operations.has(operationId))throw new ProtocolError('operation_replay');
    if(this.operations.size>=10_000)throw new ProtocolError('operation_capacity');
    this.operations.add(operationId);
    const promise=new Promise<ProtocolTurn>((resolve,reject)=>{this.active={operationId,acked:false,pending:new Map(),items:new Map(),resolve,reject,timer:setTimeout(()=>this.poison('turn_timeout',true),this.policy.timeoutMs)};});
    const active=this.active!;
    void this.request('turn/start',{threadId:this.identity.nativeId,input:[{type:'text',text}]}).then(result=>{
      if(this.active!==active||this.broken)return;
      this.bindTurn(active,result?.turn);
      active.acked=true;this.finish(active);
    }).catch(e=>this.poison(e instanceof ProtocolError?e.code:'turn_start_failed',true));
    return promise;
  }
  private bindTurn(active:Active,turn:any){
    if(!object(turn)||!UUID.test(turn.id)||!Array.isArray(turn.items)||!['inProgress','completed'].includes(turn.status)||turn.error!=null||active.turnId&&active.turnId!==turn.id)throw this.poison('turn_identity_mismatch',true);
    active.turnId=turn.id;
    if(turn.items.length>10_000)throw this.poison('native_item_limit',true);
    for(const item of turn.items){
      if(!object(item)||!token(item.id)||!itemTypes.has(item.type)||item.error!=null||item.status!==undefined&&!['inProgress','completed'].includes(item.status))throw this.poison('invalid_native_item',true);
      if(item.status==='inProgress')active.pending.set(item.id,item.type);
    }
  }
  private frame(frame:any){
    if(!object(frame)||frame.jsonrpc!==undefined&&frame.jsonrpc!=='2.0')throw this.poison('invalid_protocol_frame');
    if(typeof frame.method==='string'){
      if(frame.id!==undefined){if(!requestId(frame.id))throw this.poison('invalid_request_id');void this.approve(frame).catch(()=>this.poison('approval_write_failed',true));return;}
      this.notification(frame.method,frame.params);return;
    }
    if(!requestId(frame.id))throw this.poison('invalid_response_id');
    const pending=this.rpc.get(key(frame.id));if(!pending)throw this.poison('unexpected_response');
    this.rpc.delete(key(frame.id));clearTimeout(pending.timer);
    if(Object.hasOwn(frame,'error')){pending.reject(new ProtocolError('native_rpc_error',!!this.active||this.opening));return;}
    if(!Object.hasOwn(frame,'result')){pending.reject(this.poison('invalid_response'));return;}
    pending.resolve(frame.result);
  }
  private scoped(params:any):Active{
    const active=this.active;
    if(!active||!object(params)||params.threadId!==this.identity?.nativeId)throw this.poison('notification_scope_mismatch',!!active);
    return active;
  }
  private notification(method:string,p:any){
    if(method==='thread/status/changed'){
      if(this.identity&&p?.threadId!==this.identity.nativeId)throw this.poison('notification_scope_mismatch');
      if(p?.status?.type==='systemError')throw this.poison('native_thread_error');return;
    }
    if(passive.has(method)){
      if(p?.threadId!==undefined&&this.identity&&p.threadId!==this.identity.nativeId)throw this.poison('notification_scope_mismatch');
      if(p?.turnId!==undefined&&this.active?.turnId&&p.turnId!==this.active.turnId)throw this.poison('notification_scope_mismatch');return;
    }
    if(method==='error'||method==='model/rerouted')throw this.poison(method==='error'?'native_turn_error':'model_rerouted');
    if(!['turn/started','turn/completed','item/started','item/completed'].includes(method))throw this.poison('unsupported_notification');
    const active=this.scoped(p);
    if(method==='turn/started'||method==='turn/completed'){
      this.bindTurn(active,p.turn);
      if(method==='turn/completed'){
        if(p.turn.status!=='completed'||active.pending.size||this.pendingApproval)throw this.poison('turn_not_safely_completed',true);
        active.completion=structuredClone(p.turn);this.finish(active);
      }return;
    }
    if(!UUID.test(p.turnId)||active.turnId&&p.turnId!==active.turnId)throw this.poison('notification_scope_mismatch',true);
    active.turnId=p.turnId;const item=p.item;
    if(!object(item)||!token(item.id)||!itemTypes.has(item.type)||active.items.size+active.pending.size>=10_000)throw this.poison('invalid_native_item',true);
    if(method==='item/started'){active.pending.set(item.id,item.type);return;}
    if(active.pending.has(item.id)&&active.pending.get(item.id)!==item.type)throw this.poison('tool_identity_mismatch',true);
    if(item.error!=null||item.status!==undefined&&item.status!=='completed')throw this.poison('native_item_failed',true);
    if(toolTypes.has(item.type))this.toolCompleted(item);
    active.pending.delete(item.id);active.items.set(item.id,structuredClone(item));
  }
  private toolCompleted(item:any){
    if(item.status!=='completed'||item.error!=null||item.success===false||item.type==='commandExecution'&&item.exitCode!==0)throw this.poison('native_tool_failed',true);
  }
  private finish(active:Active){
    if(this.active!==active||!active.acked||!active.completion)return;
    const turn=active.completion;
    if(turn.items.length>10_000||turn.itemsView!==undefined&&turn.itemsView!=='full'||active.pending.size||this.pendingApproval)throw this.poison('turn_not_safely_completed',true);
    for(const item of turn.items){if(!object(item)||!token(item.id)||!itemTypes.has(item.type)||active.items.size+active.pending.size>=10_000)throw this.poison('invalid_native_item',true);if(item.error!=null||item.status!==undefined&&item.status!=='completed')throw this.poison('native_item_failed',true);if(toolTypes.has(item.type))this.toolCompleted(item);active.items.set(item.id,item);}
    const final=[...active.items.values()].filter(i=>i.type==='agentMessage'&&(i.phase==null||i.phase==='final_answer'));
    if(!final.length||final.some(i=>typeof i.text!=='string'))throw this.poison('final_text_missing',true);
    const text=final.map(i=>i.text).join('\n');
    clearTimeout(active.timer);this.active=undefined;
    active.resolve({operationId:active.operationId,nativeId:this.identity!.nativeId,turnId:active.turnId!,text,state:'completed'});
  }
  private async approve(frame:any){
    const p=frame.params,active=this.active,id=key(frame.id);
    const known=['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(frame.method);
    if(!known){await this.wire.send({id:frame.id,error:{code:-32601,message:'Unsupported request'}});this.poison('unsupported_server_request',!!active);return;}
    if(this.approvalIds.has(id)){await this.wire.send({id:frame.id,result:{decision:'decline'}});this.poison('approval_replay',!!active);return;}
    if(this.approvalIds.size>=10_000){await this.wire.send({id:frame.id,result:{decision:'decline'}});this.poison('approval_capacity',!!active);return;}
    this.approvalIds.add(id);
    const exact=!!active&&!!active.turnId&&p?.threadId===this.identity?.nativeId&&p?.turnId===active.turnId&&token(p.itemId)&&Number.isSafeInteger(p.startedAtMs)&&p.startedAtMs>=0&&(p.cwd==null||p.cwd===this.policy.cwd)&&p.grantRoot==null;
    if(!exact){await this.wire.send({id:frame.id,result:{decision:'decline'}});this.poison('approval_scope_mismatch',!!active);return;}
    this.approvals.add(id);let decision:'accept'|'decline'='decline';
    try{if(this.hooks.approve&&await this.hooks.approve({id,nativeId:p.threadId,turnId:p.turnId,tool:frame.method,details:structuredClone(p)})==='allow')decision='accept';}catch{/* deny by default */}
    if(this.broken||this.active!==active||!this.approvals.has(id))return;
    await this.wire.send({id:frame.id,result:{decision}});this.approvals.delete(id);
  }
  close():Promise<void>{if(this.closing)return this.closing;this.poison('protocol_closed',!!this.active||this.opening);this.closing=Promise.resolve().then(()=>this.wire.close());return this.closing;}
}
