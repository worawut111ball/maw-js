import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {loadProtocolHostComposition,readProtocolHostConfig,normalizeProtocolNativeHistory,type ProtocolHostConfig,type ProtocolHostAuthority,type ProtocolHostMechanisms,type ProtocolNativeAttestationRequest} from '../src/mobile/continuity/protocol/host-composition';
import {parseNativeRecords,type NativeRecords} from '../src/mobile/continuity/native-records';
import type {Room,Binding,RoomEvent} from '../src/mobile/continuity/types';
import type {StagedNativeProtocolSession} from '../src/mobile/continuity/protocol/types';
const roots:string[]=[],apps:Extract<ReturnType<typeof loadProtocolHostComposition>,{kind:'configured'}>[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close().catch(()=>{});for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const jsonl=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
const nativeId='00000000-0000-4000-8000-000000000001',userId='00000000-0000-4000-8000-000000000011',turnId='00000000-0000-4000-8000-000000000021';
function nativeRows(agent:'claude'|'codex',cwd:string,uid=userId,turn=turnId){
 if(agent==='claude')return [{type:'user',uuid:uid,parentUuid:null,sessionId:nativeId,cwd,message:{role:'user',content:'synthetic user'}},{type:'assistant',uuid:turn,parentUuid:uid,sessionId:nativeId,cwd,message:{role:'assistant',model:'fixture-model',content:[{type:'text',text:'synthetic final'}],stop_reason:'end_turn'}}];
 return [{type:'session_meta',payload:{id:nativeId,session_id:nativeId,cwd}},{type:'event_msg',payload:{type:'task_started',turn_id:turn}},{type:'turn_context',payload:{turn_id:turn,cwd,model:'fixture-model'}},{type:'response_item',payload:{type:'message',id:uid,role:'user',content:[{type:'input_text',text:'synthetic user'}]}},{type:'response_item',payload:{type:'message',id:'a-'+turn,role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'synthetic final'}]}},{type:'event_msg',payload:{type:'task_complete',turn_id:turn}}];
}
function fixture(presence:'absent'|'present'='absent',version:2|3=2){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'protocol-host-composition-')));roots.push(root);mkdirSync(join(root,'.claude'));const directory=join(root,'modules');mkdirSync(directory);
 const binary=join(root,'native-fixture');writeFileSync(binary,'fixture binary bytes never executed',{mode:0o700});const sha256=hash(readFileSync(binary));
 // Temporary reviewed builder stand-in. It returns the actual input context/selection; no native execution.
 const builder=`const crypto=require('node:crypto');function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v;}function build(i){const env={HOME:i.context.home};if(i.context.homeEnvironment.state==='present')env.CLAUDE_CONFIG_DIR=i.context.homeEnvironment.value;if(i.connection)env.ANTHROPIC_AUTH_TOKEN=i.connection.token;const args=['-p',...(i.session.mode==='resume'?['--resume',i.session.id]:[]),...(i.version===3?['--safe-mode','--tools','']:[])];const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');const policy=i.version===3?{pilotPolicy:i.pilotPolicy,policyArgvHash:digest(['--safe-mode','--tools',''])}:{};return freeze({version:i.version,tool:'claude',model:i.model,route:i.route,cwd:i.context.cwd,binary:i.native.binary,session:i.session,args,env,eligibility:{candidateOnly:true,liveEligible:false},...policy,...(i.version===3?{finalArgvHash:digest(args)}:{}),binding:{version:i.version,kind:i.kind,route:i.route,model:i.model,provider:'anthropic',endpoint:'https://api.anthropic.com',home:i.context.home,effectiveToolHome:i.context.effectiveToolHome,homeEnvironment:i.context.homeEnvironment,cwd:i.context.cwd,nativeBinary:i.native.binary,nativeSha256:i.native.sha256,nativeVersion:i.native.version,sessionId:i.session.mode==='resume'?i.session.id:null,...policy}});}module.exports={buildProtocolLaunchV2:build,buildProtocolPilotLaunch:build};`;
 const sources={'local-entry.js':'module.exports={};','protocol-entry.js':'module.exports={};','protocol-entry-v2.js':builder,'protocol-entry-pilot.js':builder};const hashes:any={};for(const [name,value]of Object.entries(sources)){writeFileSync(join(directory,name),value);hashes[name]=hash(value);}
 const profile={agent:'claude' as const,version,model:'fixture-model',route:'direct' as const,provider:'anthropic',endpoint:'https://api.anthropic.com',home:root,effectiveToolHome:join(root,'.claude'),homeEnvironment:presence==='absent'?{state:'absent' as const}:{state:'present' as const,value:join(root,'.claude')},native:{binary,sha256,version:'2.1.220',versionEvidence:{version:'2.1.220',sha256}}};
 const config:ProtocolHostConfig={version:1,activation:{kind:'host-owned-protocol',mode:'pilot'},privateRoot:join(root,'private'),modulePin:{directory,hashes},actorId:'trusted-fixture-owner',timeoutMs:1000,scopes:[{id:'A',backend:'herdr',workspace:'fixture-w',room:'A',cwd:root,profiles:[profile]}]};
 const attestations:ProtocolNativeAttestationRequest[]=[],specs:any[]=[],rows=new Map<string,any[]>();let badAttestation=false,badHistory=false,launches=0;
 const authority:ProtocolHostAuthority={attestNative:async request=>{attestations.push(request);return {source:'trusted-native-host-attestation',reference:'synthetic-unit-attestation-not-live',roomId:request.roomId,launchOperationId:request.launchOperationId,operationId:request.operationId,binding:structuredClone(request.binding),launchReceipt:request.launchReceipt,externalWriter:'absent',checks:{nativePin:'verified',effectivePolicy:'verified',startup:badAttestation?'unknown':'reviewed',route:'verified'}};},
  readHistory:async({room,binding})=>({source:'trusted-full-native-history',reference:'synthetic-full-read-not-live',roomId:room.id,binding:badHistory?{...binding,generation:'wrong'}:binding,cwd:room.cwd,completeness:'bounded-from-start',records:parseNativeRecords(binding.agent,binding.nativeId,jsonl(rows.get(binding.nativeId)??[]))}),
  liveEvidence:async()=>{throw Error('pilot must not request production certification');}};
 const mechanisms:ProtocolHostMechanisms={supervisor:options=>({launch:async(c,p)=>{const spec=await options.preflight(c,p);specs.push(spec);launches++;let alive=true;return {...p,runtimeBirth:'fixture-'+p.launchId,wire:{messages:{async *[Symbol.asyncIterator](){}},send:async()=>{},close:async()=>{alive=false;}},assertRunning:async()=>{if(!alive)throw Error('not running');},cleanup:async()=>{alive=false;},observeExit:async expected=>{expect(options.pendingWork()).toBe(false);return {...expected,source:'owned-process-supervisor',exit:{code:0,signal:null},inputClosed:true,outputClosed:true,pendingWork:false};},diagnostics:()=>({stderrBytes:0,stderrTruncated:false,stderr:''})};}}),
  driver:(candidate,wire)=>{const sid=`00000000-0000-4000-8000-${String(launches).padStart(12,'0')}`,identity={agent:'claude' as const,nativeId:sid,model:candidate.model,cwd:root,home:root,route:candidate.route};let ready=false,observation:any;
   const dispatch=async(op:string,text:string)=>{await wire.send({type:'user'});const uid=crypto.randomUUID(),aid=crypto.randomUUID(),history=rows.get(sid)??[];history.push({type:'user',uuid:uid,parentUuid:history.at(-1)?.uuid??null,sessionId:sid,cwd:root,message:{role:'user',content:text}},{type:'assistant',uuid:aid,parentUuid:uid,sessionId:sid,cwd:root,message:{role:'assistant',model:candidate.model,content:[{type:'text',text:'synthetic final'}],stop_reason:'end_turn'}});rows.set(sid,history);mkdirSync(join(root,'.claude','projects','fixture'),{recursive:true});writeFileSync(join(root,'.claude','projects','fixture',sid+'.jsonl'),jsonl(history),{mode:0o600});observation={agent:'claude',nativeId:sid,model:candidate.model,cwd:root};ready=true;return {operationId:op,nativeId:sid,turnId:uid,state:'completed' as const,text:'synthetic final'};};
   const driver:StagedNativeProtocolSession={get idle(){return ready;},pendingApproval:false,get nativeObservation(){return observation;},open:async()=>identity,prepare:async()=>{await wire.send({type:'initialize'});},startTurn:async(op,text)=>({identity,turn:await dispatch(op,text)}),turn:dispatch,close:async()=>{ready=false;await wire.close();}};return driver;
  }};
 const create=()=>{const app=loadProtocolHostComposition(config,authority,mechanisms);if(app.kind!=='configured')throw Error('fixture configured');apps.push(app);return app;};
 return {root,config,profile,authority,mechanisms,create,attestations,specs,rows,get launches(){return launches;},badAttestation:()=>{badAttestation=true;},badHistory:()=>{badHistory=true;}};
}
test('default composition is disabled with no loader, service or supervisor effects',()=>{
 expect(loadProtocolHostComposition()).toMatchObject({kind:'disabled',featureOptions:undefined});expect(loadProtocolHostComposition({version:1})).toMatchObject({kind:'disabled'});
});
test('explicit private config file requires exact hash/private mode and rejects unknown browser-shaped fields',()=>{
 const f=fixture(),path=join(f.root,'host.json');writeFileSync(path,JSON.stringify(f.config),{mode:0o600});const pin={path,sha256:hash(readFileSync(path))};expect(readProtocolHostConfig(pin).scopes?.[0].id).toBe('A');expect(Object.isFrozen(readProtocolHostConfig(pin))).toBe(true);
 expect(()=>readProtocolHostConfig({...pin,sha256:'0'.repeat(64)})).toThrow('protocol_host_config_unverified');chmodSync(path,0o644);expect(()=>readProtocolHostConfig(pin)).toThrow('protocol_host_config_unverified');expect(()=>loadProtocolHostComposition({...f.config,enabled:true} as any)).toThrow('protocol_host_config_invalid');
});
for(const presence of ['absent','present'] as const)test(`concrete pinned loader/supervisor/service preserve ${presence} env and snapshot before bootstrap returns`,async()=>{
 const f=fixture(presence),app=f.create();expect(f.launches).toBe(0);const result=await app.bootstrapOwned({scopeId:'A',operationId:'boot-A',agent:'claude',firstTurn:{operationId:'first-A',text:'synthetic authorized first context'}});
 expect(f.launches).toBe(1);expect(Object.hasOwn(f.specs[0].env,'CLAUDE_CONFIG_DIR')).toBe(presence==='present');expect(Object.hasOwn(f.specs[0].env,'PATH')).toBe(false);expect(app.service.store.events('A').map(e=>e.text)).toEqual(['synthetic authorized first context','synthetic final']);
 expect(f.attestations.every(a=>a.roomId==='A'&&a.launchOperationId==='boot-A')).toBe(true);expect((await app.featureOptions.owned!.status(result.room)).capabilities.textTurn).toBe(false);expect((await app.featureOptions.capabilities()).ready).toBe(false);expect(Object.hasOwn(app.featureOptions,'resolveChannel')).toBe(false);
});
test('missing native attestation or unknown startup policy cannot launch despite valid pinned module',async()=>{
 for(const missing of [true,false]){const f=fixture();if(missing)delete f.authority.attestNative;else f.badAttestation();const app=f.create();await expect(app.bootstrapOwned({scopeId:'A',operationId:'boot-A',agent:'claude',firstTurn:{operationId:'first',text:'authorized'}})).rejects.toBeDefined();expect(f.launches).toBe(0);}
});
test('concrete Root native reader reads exact fixture file by default; missing verifier keeps production capability off',async()=>{
 const f=fixture();delete f.authority.readHistory;const app=f.create();const result=await app.bootstrapOwned({scopeId:'A',operationId:'boot',agent:'claude',firstTurn:{operationId:'first',text:'authorized native-file fixture'}});
 expect(f.launches).toBe(1);expect(app.service.store.events('A').map(e=>e.text)).toEqual(['authorized native-file fixture','synthetic final']);expect(result.room.bindings.claude?.nativeId).toBe(nativeId);
 const p=fixture();p.config.activation!.mode='production';expect((await p.create().featureOptions.capabilities()).ready).toBe(false);
});
test('V3 is pilot only and retains default-off capability without fake live evidence',async()=>{
 const f=fixture('absent',3),app=f.create();await app.bootstrapOwned({scopeId:'A',operationId:'pilot',agent:'claude',firstTurn:{operationId:'first',text:'authorized synthetic'}});expect(f.attestations.filter(a=>a.launchReceipt).length).toBeGreaterThan(0);expect((await app.featureOptions.capabilities()).ready).toBe(false);
 const p=fixture('absent',3);p.config.activation!.mode='production';expect(()=>p.create()).toThrow('protocol_host_profile_invalid');
});
test('same binding across two rooms stays scoped by exact launch metadata rather than binding lookup',async()=>{
 const f=fixture();f.config.scopes!.push({...structuredClone(f.config.scopes![0]),id:'B',room:'B'});const app=f.create();
 for(const scopeId of ['A','B'])await app.bootstrapOwned({scopeId,operationId:'boot-'+scopeId,agent:'claude',firstTurn:{operationId:'first-'+scopeId,text:'authorized '+scopeId}});
 expect(f.launches).toBe(2);expect(new Set(f.attestations.map(a=>a.roomId))).toEqual(new Set(['A','B']));expect(f.attestations.every(a=>a.launchOperationId==='boot-'+a.roomId)).toBe(true);
});
test('bad history proof cannot expose ready transport or append unverifiable reference data',async()=>{
 const f=fixture();f.badHistory();const app=f.create();await expect(app.bootstrapOwned({scopeId:'A',operationId:'boot',agent:'claude',firstTurn:{operationId:'first',text:'authorized'}})).rejects.toMatchObject({code:'protocol_host_history_unverified'});expect(app.service.store.events('A')).toEqual([]);const room=app.service.store.room('A')!;expect((await app.featureOptions.owned!.status(room)).state).toBe('unavailable');
});
for(const agent of ['claude','codex'] as const)test(`real ${agent} parser projection dedups only exact native turn identity with persisted provenance pair`,()=>{
 const cwd='/fixture/project',binding:Binding={agent,nativeId,generation:'fixture-generation',cursor:0},room:Room={id:'A',backend:'herdr',workspace:'w',room:'p',cwd,active:agent,revision:0,bindings:{[agent]:binding}};
 const records=parseNativeRecords(agent,nativeId,jsonl(nativeRows(agent,cwd))),op='owned-text',prefix='protocol-turn:'+hash(JSON.stringify([room.id,op])),metadata={operationId:op,turnId:agent==='claude'?userId:turnId,generation:binding.generation,requestHash:'a'.repeat(64)};
 const pair:RoomEvent[]=[{seq:1,sourceId:prefix+':user',agent,nativeId,role:'user',text:'synthetic user',metadata:{...metadata,provenance:'host-authorized-user'}},{seq:2,sourceId:prefix+':assistant',agent,nativeId,role:'assistant',text:'synthetic final',metadata:{...metadata,provenance:'native-protocol-final'}}];
 expect(normalizeProtocolNativeHistory(room,binding,records,pair).map(e=>e.sourceId)).toEqual(pair.map(e=>e.sourceId));
 const wrong=structuredClone(pair);wrong.forEach(e=>{e.metadata!.turnId='00000000-0000-4000-8000-000000000099';});expect(()=>normalizeProtocolNativeHistory(room,binding,records,wrong)).toThrow('protocol_history_turn_unverified');
 const changed=structuredClone(pair);changed[0].text='rewritten';expect(()=>normalizeProtocolNativeHistory(room,binding,records,changed)).toThrow('protocol_history_turn_unverified');
});
test('late older bootstrap history cannot be appended after an already persisted later pair',()=>{
 const cwd='/fixture/project',binding:Binding={agent:'claude',nativeId,generation:'gen',cursor:0},room:Room={id:'A',backend:'herdr',workspace:'w',room:'p',cwd,active:'claude',revision:0,bindings:{claude:binding}};
 const rows=nativeRows('claude',cwd);const later=nativeRows('claude',cwd,'00000000-0000-4000-8000-000000000099','00000000-0000-4000-8000-000000000098');(later[0] as any).parentUuid=(rows[1] as any).uuid;
 const records=parseNativeRecords('claude',nativeId,jsonl([...rows,...later]));const lateOnly=records.events.slice(2).map((e,i)=>({seq:i+1,sourceId:e.sourceId,agent:'claude' as const,nativeId,role:e.role,text:e.text,metadata:e.metadata}));
 expect(()=>normalizeProtocolNativeHistory(room,binding,records,lateOnly)).toThrow('protocol_history_order_unverified');
});
