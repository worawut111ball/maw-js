/** Concrete API/composition/service integration fixture. No executable native supervisor/driver or server. */
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadProtocolHostComposition,type ProtocolHostConfig,type ProtocolHostAuthority,type ProtocolHostMechanisms} from '../../src/mobile/continuity/protocol/host-composition';
import {protocolAcceptanceProfile,type ProtocolAcceptancePermit,type ProtocolAcceptanceAuthority} from '../../src/mobile/continuity/protocol/service';
import {PinnedProtocolEntryLoader} from '../../src/mobile/continuity/protocol/entry-loader';
import {parseNativeRecords} from '../../src/mobile/continuity/native-records';
import {verifyProtocolContextDelivery} from '../../src/mobile/continuity/protocol/context-delivery';
import type {StagedNativeProtocolSession} from '../../src/mobile/continuity/protocol/types';
import type {ProtocolAcceptanceHost,ProtocolAcceptanceScenario} from './protocol-ui-acceptance';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const lines=(rows:unknown[])=>rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);

export async function createCompositionAcceptanceFixture(options:{turnDelayMs?:number}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'maw-ui-api-composition-')));
 for(const dir of ['modules','.claude','.codex'])mkdirSync(join(root,dir));
 const binary=join(root,'never-executed-fixture');writeFileSync(binary,'DI-only bytes; never execute',{mode:0o700});const pin=sha(readFileSync(binary));
 // Builder is a pinned DI stand-in, not a claim about native argv/profile/account/startup policy.
 const builder=`function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v}function build(i){const tool=i.kind==='claude-stream-json'?'claude':'codex';return freeze({version:2,tool,model:i.model,route:i.route,cwd:i.context.cwd,binary:i.native.binary,session:i.session,args:['fixture-protocol-not-executed'],env:{HOME:i.context.home},eligibility:{candidateOnly:true,liveEligible:false},binding:{version:2,kind:i.kind,route:i.route,model:i.model,provider:tool==='claude'?'anthropic':'openai',endpoint:null,home:i.context.home,effectiveToolHome:i.context.effectiveToolHome,homeEnvironment:i.context.homeEnvironment,cwd:i.context.cwd,nativeBinary:i.native.binary,nativeSha256:i.native.sha256,nativeVersion:i.native.version,sessionId:i.session.mode==='resume'?i.session.id:null}})}module.exports={buildProtocolLaunchV2:build,buildProtocolPilotLaunch:build};`;
 const sources={'local-entry.js':'module.exports={};','protocol-entry.js':'module.exports={};','protocol-entry-v2.js':builder,'protocol-entry-pilot.js':builder};const hashes:any={};
 for(const [name,value]of Object.entries(sources)){writeFileSync(join(root,'modules',name),value);hashes[name]=sha(value);}
 const profile=(agent:'codex'|'claude')=>({agent,version:2 as const,model:'fixture-'+agent+'-model',route:'direct' as const,provider:agent==='claude'?'anthropic':'openai',endpoint:null,home:root,effectiveToolHome:join(root,agent==='claude'?'.claude':'.codex'),homeEnvironment:{state:'absent' as const},native:{binary,sha256:pin,version:agent==='claude'?'2.1.220':'0.164.0',versionEvidence:{version:agent==='claude'?'2.1.220':'0.164.0',sha256:pin}}});
 const source=profile('codex'),target=profile('claude'),scope={id:'fixture-owned-logical',backend:'herdr' as const,workspace:'fixture-api-workspace',room:'fixture-api-room',cwd:root,profiles:[source,target]};
 const config:ProtocolHostConfig={version:1,activation:{kind:'host-owned-protocol',mode:'pilot'},privateRoot:join(root,'private'),modulePin:{directory:join(root,'modules'),hashes},actorId:'fixture-owner',timeoutMs:2000,scopes:[scope]};
 const candidate=new PinnedProtocolEntryLoader(config.modulePin!).build({version:2,optIn:true,kind:'claude-stream-json',route:target.route,model:target.model,native:target.native,context:{home:root,effectiveToolHome:target.effectiveToolHome,homeEnvironment:target.homeEnvironment,cwd:root},session:{mode:'fresh'}});
 const {profiles,...roomScope}=scope;
 const permit:ProtocolAcceptancePermit={source:'trusted-bounded-acceptance',permitId:'fixture-actual-service-permit',expiresAt:Date.now()+300000,maxOperations:2,scope:{room:roomScope,profile:protocolAcceptanceProfile(candidate.binding),operations:['switch','text-turn']}};
 const history=new Map<string,any[]>(),effects:{kind:string;operationId?:string}[]=[];let launches=0,revoked=false,productionReads=0;
 const acceptancePermit:ProtocolAcceptanceAuthority={advertise:async()=>revoked?[]:[structuredClone(permit)],authorize:async operation=>{
  effects.push({kind:'authorize:'+operation.kind,operationId:operation.id});
  const {revision,...actualRoom}=operation.room;
  if(revoked||Date.now()>=permit.expiresAt||canonical(actualRoom)!==canonical(permit.scope.room)||canonical(operation.profile)!==canonical(permit.scope.profile)||!permit.scope.operations.includes(operation.kind))return null;
  return {permit:structuredClone(permit),operation:structuredClone(operation)};
 }};
 const authority:ProtocolHostAuthority & {acceptancePermit:ProtocolAcceptanceAuthority}={acceptancePermit,
  attestNative:async r=>({source:'trusted-native-host-attestation',reference:'DI-fixture-not-native-evidence',roomId:r.roomId,launchOperationId:r.launchOperationId,operationId:r.operationId,binding:structuredClone(r.binding),...(r.launchReceipt?{launchReceipt:r.launchReceipt}:{}),externalWriter:'absent',checks:{nativePin:'verified',effectivePolicy:'verified',startup:'reviewed',route:'verified'}}),
  readHistory:async({room,binding})=>({source:'trusted-full-native-history',reference:'DI-native-format-records-not-live',roomId:room.id,binding:structuredClone(binding),cwd:root,completeness:'bounded-from-start',records:parseNativeRecords(binding.agent,binding.nativeId,lines(history.get(binding.nativeId)??[]))}),
  verifyContext:async(room,binding,context,start)=>verifyProtocolContextDelivery({room,binding,context,start,records:parseNativeRecords(binding.agent,binding.nativeId,lines(history.get(binding.nativeId)??[]))}),
  liveEvidence:async()=>{productionReads++;return null;},
 };
 const mechanisms:ProtocolHostMechanisms={
  supervisor:options=>({launch:async(c,p)=>{await options.preflight(c,p);effects.push({kind:'supervisor-DI'});launches++;let alive=true;return {...p,runtimeBirth:'fixture-birth-'+p.launchId,wire:{messages:{async *[Symbol.asyncIterator](){}},send:async()=>{effects.push({kind:'wire-DI'});},close:async()=>{alive=false;}},assertRunning:async()=>{if(!alive)throw new Error('fixture_closed');},cleanup:async()=>{alive=false;effects.push({kind:'cleanup-DI'});},observeExit:async expected=>{if(options.pendingWork())throw new Error('fixture_pending');return {...expected,source:'owned-process-supervisor',exit:{code:0,signal:null},inputClosed:true,outputClosed:true,pendingWork:false};},diagnostics:()=>({stderrBytes:0,stderrTruncated:false,stderr:''})};}}),
  driver:(c,wire)=>{
   const nativeId=c.session.mode==='resume'?c.session.id:`00000000-0000-4000-8000-${String(launches).padStart(12,'0')}`,identity={agent:c.tool,nativeId,model:c.model,cwd:root,home:root,route:c.route};let idle=false,observation:any;
   const dispatch=async(operationId:string,text:string)=>{
    effects.push({kind:'driver-DI',operationId});await wire.send({type:'fixture-user'});if(c.tool==='claude'&&!operationId.endsWith(':context')&&options.turnDelayMs)await new Promise(r=>setTimeout(r,options.turnDelayMs));const uid=crypto.randomUUID(),aid=crypto.randomUUID(),turn=crypto.randomUUID();const rows=history.get(nativeId)??[];
    const final=c.tool==='claude'&&!operationId.endsWith(':context')?'fixture final DEMO-17 · remaining 4 · Tuesday':'fixture context final';
    if(c.tool==='claude')rows.push({type:'user',uuid:uid,parentUuid:rows.at(-1)?.uuid??null,sessionId:nativeId,cwd:root,message:{role:'user',content:text}},{type:'assistant',uuid:aid,parentUuid:uid,sessionId:nativeId,cwd:root,message:{role:'assistant',model:c.model,content:[{type:'text',text:final}],stop_reason:'end_turn'}});
    else{if(!rows.length)rows.push({type:'session_meta',payload:{id:nativeId,session_id:nativeId,cwd:root}});rows.push({type:'event_msg',payload:{type:'task_started',turn_id:turn}},{type:'turn_context',payload:{turn_id:turn,cwd:root,model:c.model}},{type:'response_item',payload:{type:'message',id:uid,role:'user',content:[{type:'input_text',text}]}},{type:'response_item',payload:{type:'message',id:aid,role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:final}]}},{type:'event_msg',payload:{type:'task_complete',turn_id:turn}});}
    history.set(nativeId,rows);observation={agent:c.tool,nativeId,model:c.model,cwd:root};idle=true;
    return {operationId,nativeId,turnId:c.tool==='claude'?uid:turn,text:final,state:'completed' as const};
   };
   const driver:StagedNativeProtocolSession={get idle(){return idle;},pendingApproval:false,get nativeObservation(){return observation;},open:async()=>{observation={agent:c.tool,nativeId,model:c.model,cwd:root};idle=true;return identity;},prepare:async()=>{await wire.send({type:'fixture-initialize'});},startTurn:async(op,text)=>({identity,turn:await dispatch(op,text)}),turn:dispatch,close:async()=>{idle=false;await wire.close();}};
   return driver;
  },
 };
 const composition=loadProtocolHostComposition(config,authority,mechanisms);if(composition.kind!=='configured')throw new Error('fixture_composition_disabled');
 try{
  const bootstrapText=JSON.stringify({kind:'continuity-facts',version:1,facts:{goal:'DEMO-17',pendingTasks:['remaining:4'],constraints:['delivery:Tuesday']}});
  const initial=await composition.bootstrapOwned({scopeId:scope.id,operationId:'fixture-bootstrap',agent:'codex',firstTurn:{operationId:'fixture-bootstrap-context',text:bootstrapText}});
  const preview=await composition.service.factsUI.preview(initial.room);
  const {createMobileApi}=await import('../../src/mobile/api');
  const api=createMobileApi({token:'fixture-actual-api-token',hookToken:'fixture-actual-hook-token',allowedLogins:[]},{projectInventory:async()=>[],continuity:composition.featureOptions});
  const host:ProtocolAcceptanceHost={api,workspace:scope.workspace,room:scope.room,requestHeaders:{authorization:'Bearer fixture-actual-api-token'},setup:{runId:'actual-api-composition-service-DI',runtime:'di',apiKind:'createMobileApi',sourcePath:import.meta.filename},dispose:async()=>{await composition.close();rmSync(root,{recursive:true,force:true});}};
  const scenario:ProtocolAcceptanceScenario={target:'claude',model:target.model,facts:preview.candidates.map(({value,...pick})=>pick),text:'ช่วยทวนเป้าหมาย จำนวนงานที่เหลือ และกำหนดส่งจากบริบทที่ได้รับก่อนหน้า',timeoutMs:20000,purpose:'bounded-acceptance'};
  return {host,scenario,composition,permit,effects,get productionReads(){return productionReads;},revoke:()=>{revoked=true;}};
 }catch(error){await composition.close().catch(()=>{});rmSync(root,{recursive:true,force:true});throw error;}
}
