/** Actual working UI -> actual in-process Mobile API. Importing this module starts nothing. */
import {readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,sep} from 'node:path';
import {strict as assert} from 'node:assert';
import type {Page,Route} from '../../ui/web/node_modules/playwright';

export interface AcceptanceApi {handle(request:Request):Response|Promise<Response>}
/** Preserve request bytes and auth through the in-process Web Request boundary. No HTTP listener. */
export function requestMobileApi(api:AcceptanceApi,input:{path:string;method:string;headers?:HeadersInit;body?:Uint8Array},trustedHeaders?:HeadersInit):Promise<Response>{
  const headers=new Headers(input.headers);headers.delete('host');headers.delete('content-length');
  for(const [k,v]of new Headers(trustedHeaders))headers.set(k,v);
  const body=input.body?new ArrayBuffer(input.body.byteLength):undefined;
  if(body)new Uint8Array(body).set(input.body!);
  return Promise.resolve(api.handle(new Request('http://localhost'+input.path,{method:input.method,headers,...(body?{body}:{})})));
}
export interface FactPick {
  field:string;seq:number;sourceId:string;agent:'codex'|'claude';nativeId:string;eventHash:string;
}
export interface ProtocolAcceptanceHost {
  /** Root constructs createMobileApi(... trusted service ...) before calling this helper. No replacement handlers. */
  api:AcceptanceApi;
  workspace:string;
  room:string;
  /** Ephemeral auth for the real API. Never written to observations/report/browser logs. */
  requestHeaders?:HeadersInit;
  /** Root describes its setup; this label alone is not runtime/certification evidence. */
  setup:{runId:string;runtime:'native'|'di';apiKind:'createMobileApi'|'fixture-handler';sourcePath:string};
  /** Root owns exact lab cleanup, uncertainty/lock retention and whether native cleanup is authorized. */
  dispose():Promise<void>;
}
export interface ProtocolAcceptanceScenario {
  target:'codex'|'claude';model:string;
  /** Explicit authorized provenance, supplied by Root; helper never automatically chooses candidate facts. */
  facts:FactPick[];
  text:string;
  timeoutMs?:number;
  purpose?:'production'|'bounded-acceptance';
}
export interface ApiObservation {
  method:string;path:string;status:number;requestHash:string;responseHash:string;
}
export interface ProtocolAcceptanceResult {
  routeEvidence:ApiObservation[];
  uiHashes:Record<string,string>;
  setupHash:string;
  runtime:'native'|'di';
  /** Hashes only, to avoid putting native IDs/facts/context/prompt/auth in public artifacts. */
  switchIdHash:string;turnIdHash:string;roomIdHash:string;
  acceptance:'ui-api-completed'|'fixture-only';
  nativeExecutionVerified:false;productionCertified:false;
  draftOutcome:'cleared'|'retained-original';
  authorizationPurpose?:'production'|'bounded-acceptance';
}
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const origin='https://maw-acceptance.invalid';
const repo=resolve(import.meta.dirname,'../..');
const uiRoot=resolve(repo,'ui/mobile');
const bindingKey=(b:any)=>JSON.stringify([b?.agent,b?.nativeId,b?.generation,b?.model??null,b?.route??null,b?.cursor]);
export interface AcceptanceSwitchIdentity {
  id:string;roomId:string;workspace:string;room:string;target:'codex'|'claude';model:string;
  expectedRevision:number;from:{agent:string;nativeId:string;generation:string;model?:string;route?:string;cursor:number};
}
export interface AcceptanceSwitchObservation {sequence:number;method:string;path:string;status:number;response:any}
const stoppedSwitchStates=['blocked','uncertain','failed'] as const;
const safeSwitchReasons=[
  'staged_source_target_unverified','launch_unverified_source_preserved','resume_identity_mismatch',
  'target_identity_unverified','target_not_ready_for_context','context_receipt_unverified','target_changed_during_context',
  'backend_unavailable','capability_unavailable','agent_changed','preflight_unverifiable',
  'history_identity_changed','history_cursor_unavailable','context_facts_unavailable','context_goal_missing',
  'source_changed_during_checkpoint','history_changed_during_checkpoint','target_policy_unverified',
  'side_effect_unverified','checkpoint_unavailable','canceled_by_user',
] as const;
export class AcceptanceSwitchStopped extends Error {
  readonly code:`acceptance_switch_${typeof stoppedSwitchStates[number]}`;
  readonly reasonCode:typeof safeSwitchReasons[number]|'unclassified_reason';
  constructor(readonly state:typeof stoppedSwitchStates[number],reason:unknown){
    const reasonCode=typeof reason==='string'&&(safeSwitchReasons as readonly string[]).includes(reason)?reason as typeof safeSwitchReasons[number]:'unclassified_reason';
    const code=`acceptance_switch_${state}` as const;
    super(code+':'+reasonCode);this.name='AcceptanceSwitchStopped';this.code=code;this.reasonCode=reasonCode;
  }
}
/** Pure observation: no polling, retry, advance or transport writes. Pending states remain pending. */
export function inspectAcceptanceSwitch(observations:readonly AcceptanceSwitchObservation[],expected:AcceptanceSwitchIdentity,prefix:string){
  let latest:AcceptanceSwitchObservation|undefined;
  const exact=prefix+'/operations/'+encodeURIComponent(expected.id);
  for(const item of observations){
    const relevant=item.method==='GET'&&(item.path===prefix||item.path===exact)
      ||item.method==='POST'&&(item.path===prefix+'/switch'||item.path===exact+'/advance');
    const op=item.response?.operation;
    if(!relevant||item.status!==200||item.response?.ok!==true||!Number.isSafeInteger(item.sequence)||item.sequence<1
      ||op?.id!==expected.id||op.roomId!==expected.roomId||op.target!==expected.target||op.model!==expected.model
      ||op.expectedRevision!==expected.expectedRevision||bindingKey(op.from)!==bindingKey(expected.from))continue;
    if(item.path===prefix){
      const room=item.response.room;
      if(room?.id!==expected.roomId||room.workspace!==expected.workspace||room.room!==expected.room
        ||!Number.isSafeInteger(room.revision)||room.revision<expected.expectedRevision||room.revision>expected.expectedRevision+1
        ||room.operationId!==undefined&&room.operationId!==expected.id)continue;
    }
    // Request admission order, not response arrival order: late older HTTP must not replace newer evidence.
    if(!latest||item.sequence>latest.sequence)latest=item;
  }
  if(latest&&(stoppedSwitchStates as readonly unknown[]).includes(latest.response.operation.state))throw new AcceptanceSwitchStopped(latest.response.operation.state,latest.response.operation.reason);
  return latest;
}
const pickKey=(p:FactPick)=>JSON.stringify([p.field,p.seq,p.sourceId,p.agent,p.nativeId,p.eventHash]);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until<T>(fn:()=>T|Promise<T>,timeout:number,label:string):Promise<NonNullable<T>>{
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await fn();if(value)return value as NonNullable<T>;await sleep(100);}
  throw new Error('acceptance_timeout:'+label);
}

/** Browser controls are real; every backend response is forwarded unchanged from host.api.handle().
 * This method performs authorized switch/turn mutations. Root must supply an isolated lab, not a user pane.
 * It never constructs a runtime, spawns native CLI, opens/closes rooms, or invokes host.dispose itself.
 */
export async function acceptProtocolSwitch(page:Page,host:ProtocolAcceptanceHost,scenario:ProtocolAcceptanceScenario):Promise<ProtocolAcceptanceResult>{
  assert(host.setup.runtime==='native'||host.setup.runtime==='di','runtime label required');
  assert(host.workspace&&host.room&&scenario.model&&scenario.text.trim(),'explicit scope/model/text required');
  assert(scenario.facts.length>0&&scenario.facts.some(p=>p.field==='goal'),'explicit goal selection required');
  const timeout=scenario.timeoutMs??180_000;
  assert(Number.isSafeInteger(timeout)&&timeout>=1&&timeout<=600_000,'bounded timeout required');
  page.setDefaultTimeout(timeout);page.setDefaultNavigationTimeout(timeout);
  const prefix='/mobile/rooms/'+encodeURIComponent(host.workspace)+'/'+encodeURIComponent(host.room)+'/continuity';
  const evidence:ApiObservation[]=[],blocked:string[]=[],bridgeErrors:string[]=[];
  async function waiting<T>(fn:()=>T|Promise<T>,ms:number,label:string){return until(async()=>{if(bridgeErrors.length)throw new Error("acceptance_bridge_failure");return fn();},ms,label);}
  let requestSequence=0;
  const replies:(AcceptanceSwitchObservation&{body:any})[]=[];
  const uiHashes:Record<string,string>={};
  const source=await readFile(host.setup.sourcePath); // source hash, never expose source contents
  const setupHash=sha(source);
  // Only the requested room may mutate. Unexpected UI actions are aborted, never synthesized as success.
  const allowed=(method:string,path:string)=>{
    if(method==='GET')return ['/mobile/projects','/mobile/version','/mobile/health','/mobile/continuity/capabilities'].includes(path)
      ||path===prefix||path===prefix+'/transport'||path===prefix+'/events'||path===prefix+'/facts/preview'
      ||path.startsWith(prefix+'/operations/')&&!path.slice(prefix.length+12).includes('/')
      ||path.startsWith(prefix+'/turns/')&&!path.slice(prefix.length+7).includes('/');
    if(method!=='POST')return false;
    return [prefix+'/facts/selections',prefix+'/switch',prefix+'/turns'].includes(path)
      ||new RegExp('^'+prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/operations/[^/]+/advance$').test(path);
  };
  const dispatch=async(route:Route)=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==origin){blocked.push('external-resource');return route.abort('blockedbyclient');}
    const path=url.pathname;
    if(path.startsWith('/mobile/')){
      if(!allowed(req.method(),path)){if(path!=='/mobile/perf')blocked.push(req.method()+' '+path);return route.abort('blockedbyclient');}
      const sequence=++requestSequence;
      const body=req.postDataBuffer();
      const response=await requestMobileApi(host.api,{path:path+url.search,method:req.method(),headers:await req.allHeaders(),...(body?{body:new Uint8Array(body)}:{})},host.requestHeaders);
      const bytes=new Uint8Array(await response.arrayBuffer());
      let parsed:any;try{parsed=JSON.parse(new TextDecoder().decode(bytes));}catch{}
      let requestBody:any;try{requestBody=req.postDataJSON();}catch{}
      evidence.push({method:req.method(),path:(path.startsWith(prefix)?'/mobile/rooms/<workspace>/<room>/continuity'+path.slice(prefix.length):path).replace(/\/operations\/[^/]+/,'/operations/<id>').replace(/\/turns\/[^/]+/,'/turns/<id>'),status:response.status,requestHash:sha(body??''),responseHash:sha(bytes)});
      replies.push({sequence,method:req.method(),path,body:requestBody,response:parsed,status:response.status});
      const outHeaders=Object.fromEntries(response.headers);delete outHeaders['content-length'];delete outHeaders['content-encoding'];
      return route.fulfill({status:response.status,headers:outHeaders,body:Buffer.from(bytes)});
    }
    let asset:string|undefined;
    if(path==='/m')asset=resolve(uiRoot,'m.html');
    else if(/^\/m-ext\/[a-z0-9-]+\.js$/i.test(path))asset=resolve(uiRoot,'ext',path.slice('/m-ext/'.length));
    if(!asset)return route.abort('blockedbyclient'); // no service worker/network fallback or invented asset
    const actual=await realpath(asset);assert(actual.startsWith(await realpath(uiRoot)+sep),'asset escaped UI source');
    const bytes=await readFile(actual);uiHashes[path]=sha(bytes);
    return route.fulfill({status:200,contentType:path==='/m'?'text/html; charset=utf-8':'text/javascript; charset=utf-8',body:bytes});
  };
  const bridge=async(route:Route)=>{try{await dispatch(route);}catch{bridgeErrors.push('handler_failed');await route.abort('failed').catch(()=>{});}};
  await page.route('**/*',bridge);
  try{
    await page.goto(origin+'/m',{waitUntil:'domcontentloaded',timeout});
    const projects=await waiting(()=>replies.find(r=>r.path==='/mobile/projects'&&r.status===200)?.response?.projects,timeout,'projects');
    const matches=(projects as any[]).flatMap(p=>(p.workspaces||[]).filter((w:any)=>w.id===host.workspace&&(w.rooms||[]).some((r:any)=>r.id===host.room)).map(()=>p));
    assert.equal(matches.length,1,'scope must resolve to exactly one real inventory project');
    const clickAttribute=async(selector:string,attr:string,value:string)=>{
      const nodes=page.locator(selector);for(let i=0;i<await nodes.count();i++){const node=nodes.nth(i);if(await node.getAttribute(attr)===value){await node.click({timeout});return;}}
      throw new Error('acceptance_inventory_control_missing:'+attr);
    };
    await clickAttribute('[data-p]','data-p',matches[0].name);
    const workspaceChip=page.locator('[data-ws]');if(await workspaceChip.count())await clickAttribute('[data-ws]','data-ws',host.workspace);
    await clickAttribute('[data-r]','data-r',host.room);
    const switchButton=page.locator('header [data-continuity-switch]');await switchButton.waitFor({state:'visible',timeout});
    await waiting(()=>switchButton.isEnabled(),timeout,'switch-enabled');
    if(scenario.purpose){const c=replies.findLast(r=>r.path==='/mobile/continuity/capabilities'&&r.status===200)?.response;assert.equal(c?.authorization?.purpose,scenario.purpose,'API purpose mismatch');if(scenario.purpose==='bounded-acceptance')assert(await page.locator('.continuity-purpose').first().isVisible(),'bounded purpose missing from UI');}
    await switchButton.click();
    await page.locator('[data-continuity-provider]').waitFor({state:'visible',timeout});
    await page.locator('[data-continuity-provider]').selectOption(scenario.target);
    await page.locator('[data-continuity-model]').selectOption(scenario.model);
    const previewStart=replies.length;await page.locator('[data-continuity-preview]').click();
    const preview=await waiting(()=>replies.slice(previewStart).find(r=>r.path===prefix+'/facts/preview'&&r.status===200)?.response?.preview,timeout,'facts-preview');
    for(const pick of scenario.facts){
      const index=preview.candidates.findIndex((c:FactPick)=>pickKey(c)===pickKey(pick));assert(index>=0,'authorized fact missing in actual preview');
      await page.locator(`[data-fact="${index}"]`).check();
    }
    await page.locator('[data-continuity-confirm]').click();
    const switched=await waiting(()=>replies.find(r=>r.method==='POST'&&r.path===prefix+'/switch'),timeout,'switch-request');
    assert.equal(switched.status,200,'real switch request rejected');
    const operationId=switched.body.id;
    assert.equal(switched.body.factsSelectionId,operationId);assert.equal(switched.body.target,scenario.target);assert.equal(switched.body.model,scenario.model);
    const selection=replies.find(r=>r.method==='POST'&&r.path===prefix+'/facts/selections');
    assert.equal(selection?.status,200);assert.equal(selection?.body.id,operationId);
    assert.deepEqual(selection?.body.selections.map(pickKey).sort(),scenario.facts.map(pickKey).sort());
    const accepted=switched.response?.operation;
    assert(accepted?.id===operationId&&accepted.roomId===preview.roomId&&accepted.target===scenario.target&&accepted.model===scenario.model&&accepted.expectedRevision===switched.body.expectedRevision&&accepted.from,'acceptance_switch_receipt_mismatch');
    const expected:AcceptanceSwitchIdentity={id:operationId,roomId:preview.roomId,workspace:host.workspace,room:host.room,target:scenario.target,model:scenario.model,expectedRevision:switched.body.expectedRevision,from:structuredClone(accepted.from)};
    // Stop only on exact current evidence. GET/poll never advances; blocked needs explicit operator retry.
    const ready=await waiting(()=>{
      const current=inspectAcceptanceSwitch(replies,expected,prefix);
      return current?.path===prefix&&current.response.operation.state==='ready-awaiting-user'&&current.response.room.active===scenario.target&&!current.response.room.operationId?current:undefined;
    },timeout,'actual-switch-completion');
    assert.equal(ready.response.room.id,preview.roomId,'logical room changed');
    const transport=await waiting(()=>replies.findLast(r=>r.path===prefix+'/transport'&&r.status===200&&r.response?.transport?.kind==='owned-protocol'&&r.response.transport.state==='idle'&&r.response.transport.capabilities?.textTurn===true&&r.response.transport.roomId===preview.roomId&&r.response.transport.binding.agent===scenario.target&&r.response.transport.binding.model===scenario.model),timeout,'owned-text-ready');
    assert.equal(bindingKey(transport.response.transport.binding),bindingKey(ready.response.operation.targetBinding),'ready/transport binding mismatch');
    const afterTurn=replies.length;
    await page.locator('#msg').fill(scenario.text);await page.locator('#send').click();
    const turn=await waiting(()=>replies.find(r=>r.method==='POST'&&r.path===prefix+'/turns'),timeout,'actual-turn-receipt');
    assert.equal(turn.status,200,'real turn request failed');
    assert.equal(turn.body.text,scenario.text);assert.equal(turn.body.expectedRevision,transport.response.transport.revision);
    assert.equal(bindingKey(turn.body.binding),bindingKey(transport.response.transport.binding));
    const receipt=turn.response?.receipt;assert.equal(receipt?.id,turn.body.id);assert.equal(receipt?.roomId,preview.roomId);
    assert.equal(receipt?.state,'completed');assert.equal(receipt?.source,'live');assert.equal(bindingKey(receipt.binding),bindingKey(turn.body.binding));
    assert.equal(receipt.turn?.operationId,turn.body.id);assert.equal(receipt.turn?.nativeId,turn.body.binding.nativeId);assert.equal(receipt.turn?.state,'completed');assert.equal(typeof receipt.turn?.text,'string');
    assert.equal(replies.filter(r=>r.method==='POST'&&r.path===prefix+'/turns').length,1,'duplicate UI turn dispatch');
    assert.equal(replies.filter(r=>r.method==='POST'&&r.path===prefix+'/switch').length,1,'duplicate switch dispatch');
    assert(!blocked.some(x=>/^(POST|PUT|PATCH|DELETE) /.test(x)),'unexpected mutation attempted');
    const draftOutcome=await waiting(async()=>{const value=await page.locator('#msg').inputValue();if(value==='')return 'cleared' as const;if(value===scenario.text&&await page.locator('#screen .pend.continuity-completed').count()>0)return 'retained-original' as const;return null;},timeout,'acknowledged-draft-outcome');
    // The real stored transcript must be observed after the turn, including user + native final.
    await waiting(()=>replies.slice(afterTurn).some(r=>r.path===prefix+'/events'&&r.status===200&&r.response?.items?.some((e:any)=>e.role==='assistant'&&e.nativeId===receipt.turn.nativeId&&e.text===receipt.turn.text&&e.metadata?.operationId===turn.body.id&&e.metadata?.turnId===receipt.turn.turnId&&e.metadata?.generation===turn.body.binding.generation)),timeout,'actual-stored-assistant');
    assert(replies.slice(afterTurn).some(r=>r.path===prefix+'/events'&&r.status===200&&r.response?.items?.some((e:any)=>e.role==='user'&&e.nativeId===receipt.turn.nativeId&&e.text===scenario.text&&e.metadata?.operationId===turn.body.id&&e.metadata?.turnId===receipt.turn.turnId)),'actual stored user missing');
    await waiting(async()=>(await page.locator('#screen pre').allTextContents()).includes(receipt.turn.text),timeout,'visible-stored-native-final');
    return {draftOutcome,routeEvidence:evidence,uiHashes,setupHash,runtime:host.setup.runtime,switchIdHash:sha(operationId),turnIdHash:sha(turn.body.id),roomIdHash:sha(preview.roomId),nativeExecutionVerified:false,productionCertified:false,authorizationPurpose:replies.findLast(r=>r.path==='/mobile/continuity/capabilities'&&r.status===200)?.response?.authorization?.purpose,acceptance:host.setup.runtime==='native'&&host.setup.apiKind==='createMobileApi'?'ui-api-completed':'fixture-only'};
  }finally{await page.unroute('**/*',bridge);}
}
