/** Fixture-only harness regressions. These handlers are NOT createMobileApi, trusted service or native proof. */
import {test,expect,beforeAll,afterAll,describe} from 'bun:test';
import {chromium,type Browser} from '../../ui/web/node_modules/playwright';
import {acceptProtocolSwitch,requestMobileApi,inspectAcceptanceSwitch,AcceptanceSwitchStopped,type ProtocolAcceptanceHost,type ProtocolAcceptanceScenario} from './protocol-ui-acceptance';
import {mergeOwnedInventory} from '../../src/mobile/continuity/protocol/inventory';

describe.skipIf(process.env.MAW_PROTOCOL_UI_FIXTURES!=='1')('explicit fixture-only browser acceptance',()=>{
let browser:Browser;
beforeAll(async()=>{browser=await chromium.launch({headless:true});});
afterAll(async()=>{await browser?.close();});
function fixture(mode:'completed'|'switch-uncertain'|'turn-lost-ack'='completed'){
 const ws='fixture-workspace',alias='fixture-room',base='/mobile/rooms/'+ws+'/'+alias+'/continuity';
 const source={agent:'codex',nativeId:'fixture-source-native',generation:'fixture-source-generation',model:'fixture-source-model',route:'fixture-route',cursor:0};
 const target={agent:'claude',nativeId:'fixture-target-native',generation:'fixture-target-generation',model:'fixture-target-model',route:'fixture-route',cursor:0};
 const room:any={id:'fixture-logical-room',workspace:ws,room:alias,backend:'herdr',cwd:'/fixture/project',active:'codex',revision:0,bindings:{codex:source,claude:target}};
 const candidates=[
  {field:'goal',seq:1,sourceId:'fixture-goal',agent:'codex' as const,nativeId:source.nativeId,eventHash:'a'.repeat(64),value:'DEMO-17'},
  {field:'pendingTasks',seq:2,sourceId:'fixture-remaining',agent:'codex' as const,nativeId:source.nativeId,eventHash:'b'.repeat(64),value:['remaining:4']},
  {field:'constraints',seq:3,sourceId:'fixture-delivery',agent:'codex' as const,nativeId:source.nativeId,eventHash:'c'.repeat(64),value:['delivery:Tuesday']},
 ];
 let operation:any=null,receipt:any=null,disposed=0;
 const writes:{path:string;body:any}[]=[],paths:string[]=[];
 const events:any[]=candidates.map(c=>({seq:c.seq,sourceId:c.sourceId,agent:c.agent,nativeId:c.nativeId,role:'assistant',text:typeof c.value==='string'?c.value:c.value.join('\n')}));
 const status=()=>({kind:'owned-protocol' as const,roomId:room.id,revision:room.revision,binding:room.bindings[room.active],state:'idle' as const,capabilities:{textTurn:!room.operationId,attachments:false as const,keys:false as const}});
 const host:ProtocolAcceptanceHost={workspace:ws,room:alias,requestHeaders:{authorization:'Bearer fixture-only-not-secret'},setup:{runId:'fixture-only',runtime:'di',apiKind:'fixture-handler',sourcePath:import.meta.filename},dispose:async()=>{disposed++;},api:{handle:async request=>{
  const url=new URL(request.url),path=url.pathname;paths.push(path);
  if(request.headers.get('authorization')!=='Bearer fixture-only-not-secret')return Response.json({ok:false},{status:401});
  const body=request.method==='POST'?await request.json():null;if(body)writes.push({path,body});
  let out:any;
  if(path==='/mobile/version')out={v:'fixture-only'};
  else if(path==='/mobile/health')out={ok:true};
  else if(path==='/mobile/projects')out={projects:mergeOwnedInventory([],[{room,transport:status()}])};
  else if(path==='/mobile/continuity/capabilities')out={ok:true,ready:true,roomStateAvailable:true,factsSelectionAvailable:true,scope:'room-backend',models:[{agent:'claude',id:target.model,label:'Fixture target'}],backends:[{backend:'herdr',ready:true}]};
  else if(path===base)out={ok:true,room,operation,held:[]};
  else if(path===base+'/transport')out={ok:true,transport:status()};
  else if(path===base+'/events'){const after=Number(url.searchParams.get('after'));out={ok:true,items:events.filter(e=>e.seq>after).slice(0,Number(url.searchParams.get('limit')||100))};}
  else if(path===base+'/facts/preview')out={ok:true,preview:{id:'fixture-preview',roomId:room.id,roomRevision:room.revision,sourceBindingHash:'d'.repeat(64),archiveHash:'e'.repeat(64),throughSeq:3,contextText:'DEMO-17\nremaining:4\ndelivery:Tuesday',candidates,selectionRequired:true}};
  else if(path===base+'/facts/selections')out={ok:true,selection:{id:body.id,previewId:body.previewId,roomRevision:body.expectedRevision,factsHash:'f'.repeat(64)}};
  else if(path===base+'/switch'){
   operation={id:body.id,roomId:room.id,target:body.target,model:body.model,expectedRevision:room.revision,from:source,state:'waiting-safe-point',createdAt:1};room.operationId=body.id;out={ok:true,operation};
  }else if(path.endsWith('/advance')){
   if(mode==='switch-uncertain'){operation.state='uncertain';operation.reason='staged_source_target_unverified';}
   else{operation.state='ready-awaiting-user';operation.targetBinding=target;room.active='claude';room.revision++;delete room.operationId;}
   out={ok:true,operation};
  }else if(path.startsWith(base+'/operations/'))out={ok:true,operation};
  else if(path===base+'/turns'){
   receipt={id:body.id,roomId:room.id,binding:body.binding,state:'completed',source:'live',turn:{operationId:body.id,nativeId:target.nativeId,turnId:'fixture-turn',text:'fixture reply: DEMO-17; remaining 4; Tuesday',state:'completed'}};
   events.push({seq:4,sourceId:'fixture-turn-user',agent:'claude',nativeId:target.nativeId,role:'user',text:body.text,metadata:{operationId:body.id,turnId:receipt.turn.turnId,generation:target.generation}},{seq:5,sourceId:'fixture-turn-assistant',agent:'claude',nativeId:target.nativeId,role:'assistant',text:receipt.turn.text,metadata:{operationId:body.id,turnId:receipt.turn.turnId,generation:target.generation}});
   if(mode==='turn-lost-ack')return Response.json({ok:false,code:'fixture_ack_lost'},{status:500});
   out={ok:true,receipt};
  }else if(path.startsWith(base+'/turns/'))out={ok:true,receipt:{...receipt,source:'historical'}};
  else return Response.json({ok:false,code:'fixture_unexpected_route'},{status:404});
  return Response.json(out,{headers:{'cache-control':'no-store'}});
 }}};
 const scenario:ProtocolAcceptanceScenario={target:'claude',model:target.model,facts:candidates.map(({value,...p})=>p),text:'ช่วยทวนเป้าหมาย จำนวนงานที่เหลือ และกำหนดส่งจากบริบทที่ได้รับก่อนหน้า',timeoutMs:12000};
 return {host,scenario,writes,paths,disposed:()=>disposed};
}
test('fixture-only actual UI button/facts/switch/progress/composer traverses in-process handler without HTTP stubs',async()=>{
 const f=fixture(),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
 try{
  const result=await acceptProtocolSwitch(page,f.host,f.scenario);expect(result.acceptance).toBe('fixture-only');expect(result.runtime).toBe('di');
  expect(f.writes.filter(w=>w.path.endsWith('/switch'))).toHaveLength(1);expect(f.writes.filter(w=>w.path.endsWith('/turns'))).toHaveLength(1);
  expect(f.writes.find(w=>w.path.endsWith('/turns'))!.body.text).toBe(f.scenario.text);expect(f.scenario.text).not.toContain('DEMO-17');expect(f.scenario.text).not.toContain('4');
  expect(f.paths.some(p=>p.endsWith('/transport'))).toBe(true);expect(f.paths.some(p=>p.endsWith('/events'))).toBe(true);expect(result.routeEvidence.every(e=>!e.path.includes('fixture-workspace')&&!e.path.includes('fixture-room'))).toBe(true);
  expect(f.disposed()).toBe(0); // Root owns cleanup; helper does not release uncertain native locks.
 }finally{await context.close();await f.host.dispose();}
},60000);
for(const mode of ['switch-uncertain','turn-lost-ack'] as const)test(`fixture-only ${mode} fails acceptance without replay or invented completion`,async()=>{
 const f=fixture(mode),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
 try{
  let failure:Error|undefined;try{await acceptProtocolSwitch(page,f.host,f.scenario);}catch(e){failure=e as Error;}
  expect(failure?.message).toContain(mode==='switch-uncertain'?'acceptance_switch_uncertain:staged_source_target_unverified':'real turn request failed');
  expect(f.writes.filter(w=>w.path.endsWith('/switch'))).toHaveLength(1);
  expect(f.writes.filter(w=>w.path.endsWith('/turns'))).toHaveLength(mode==='switch-uncertain'?0:1);
  expect(f.writes.some(w=>/\/(send|prompt|retry|cancel)$/.test(w.path))).toBe(false);expect(f.disposed()).toBe(0);
 }finally{await context.close();await f.host.dispose();}
},60000);

// Real createMobileApi auth/health through the exact bridge, without native service setup or CLI calls.
test('actual createMobileApi.handle retains auth boundary in-process without server/native runtime',async()=>{
 const {createMobileApi}=await import('../../src/mobile/api');
 const api=createMobileApi({token:'fixture-api-token',hookToken:'fixture-hook-token',allowedLogins:[]});
 const denied=await requestMobileApi(api,{path:'/mobile/health',method:'GET'});expect(denied.status).toBe(401);
 const allowed=await requestMobileApi(api,{path:'/mobile/health',method:'GET'},{authorization:'Bearer fixture-api-token'});expect(allowed.status).toBe(200);expect((await allowed.json()).ok).toBe(true);
});

});

// Pure progress fixtures: no browser/model/transport; request sequence models deferred response arrival.
const progressPrefix='/mobile/rooms/fixture-w/fixture-p/continuity';
const progressIdentity={id:'fixture-switch',roomId:'fixture-logical',workspace:'fixture-w',room:'fixture-p',target:'claude' as const,model:'fixture-model',expectedRevision:7,from:{agent:'codex',nativeId:'fixture-native',generation:'fixture-generation',model:'source-model',route:'direct',cursor:2}};
function observation(state:string,sequence=1,reason:unknown='staged_source_target_unverified'){
 return {sequence,method:'GET',path:progressPrefix,status:200,response:{ok:true,room:{id:progressIdentity.roomId,workspace:progressIdentity.workspace,room:progressIdentity.room,revision:7,active:'codex',operationId:progressIdentity.id},operation:{id:progressIdentity.id,roomId:progressIdentity.roomId,target:progressIdentity.target,model:progressIdentity.model,expectedRevision:7,from:structuredClone(progressIdentity.from),state,reason}}};
}
for(const state of ['blocked','uncertain','failed'])test(`switch progress exact ${state} stops with safe enum immediately`,()=>{
 const record=observation(state);let caught:any;try{inspectAcceptanceSwitch([record],progressIdentity,progressPrefix);}catch(error){caught=error;}
 expect(caught).toBeInstanceOf(AcceptanceSwitchStopped);expect(caught.code).toBe('acceptance_switch_'+state);expect(caught.reasonCode).toBe('staged_source_target_unverified');expect(caught.message).toBe('acceptance_switch_'+state+':staged_source_target_unverified');expect(JSON.stringify(record)).toContain('fixture-native');expect(JSON.stringify(caught)).not.toContain('fixture-native');
});
for(const state of ['waiting-safe-point','checkpointed','preparing-target','delivering-context','retrying'])test(`switch progress ${state} remains pending without inspecting raw reason`,()=>{
 const record=observation(state,1,'private URL/auth/body');expect(inspectAcceptanceSwitch([record],progressIdentity,progressPrefix)).toBe(record);
});
for(const drift of ['id','roomId','target','model','revision','nativeId','generation','route','cursor','workspace','alias','activeOperation','http','ok','path'])test(`switch progress ignores foreign/stale ${drift}`,()=>{
 const record=observation('uncertain');const op=record.response.operation;
 if(drift==='id')op.id='other';if(drift==='roomId')op.roomId='other';if(drift==='target')op.target='codex' as any;if(drift==='model')op.model='other';if(drift==='revision')op.expectedRevision=6;
 if(drift==='nativeId')op.from.nativeId='other';if(drift==='generation')op.from.generation='other';if(drift==='route')op.from.route='other';if(drift==='cursor')op.from.cursor=3;
 if(drift==='workspace')record.response.room.workspace='other';if(drift==='alias')record.response.room.room='other';if(drift==='activeOperation')record.response.room.operationId='new-operation';
 if(drift==='http')record.status=503;if(drift==='ok')record.response.ok=false;if(drift==='path')record.path=progressPrefix+'/operations/foreign';
 expect(inspectAcceptanceSwitch([record],progressIdentity,progressPrefix)).toBeUndefined();
});
test('switch progress ignores late older terminal after newer pending evidence regardless of arrival order',()=>{
 const older=observation('uncertain',1),newer=observation('waiting-safe-point',2);
 expect(inspectAcceptanceSwitch([newer,older],progressIdentity,progressPrefix)).toBe(newer);expect(inspectAcceptanceSwitch([older,newer],progressIdentity,progressPrefix)).toBe(newer);
});
test('switch progress latest terminal wins over older ready or unrelated foreign response',()=>{
 const ready=observation('ready-awaiting-user',1),failed=observation('failed',2,'canceled_by_user'),foreign=observation('waiting-safe-point',3);foreign.response.operation.id='foreign';
 expect(()=>inspectAcceptanceSwitch([ready,failed,foreign],progressIdentity,progressPrefix)).toThrow('acceptance_switch_failed:canceled_by_user');
});
for(const path of ['/operations/fixture-switch','/operations/fixture-switch/advance','/switch'])test(`switch progress accepts exact scoped status response ${path}`,()=>{
 const record=observation('uncertain');record.path=progressPrefix+path;if(path.endsWith('/advance')||path==='/switch')record.method='POST';delete (record.response as any).room;
 expect(()=>inspectAcceptanceSwitch([record],progressIdentity,progressPrefix)).toThrow('acceptance_switch_uncertain:staged_source_target_unverified');
});
for(const reason of ['private-token/body/path', 'staged_source_target_unverified\nprivate', {message:'private'}])test('switch progress unknown reason never enters safe error text or fields',()=>{
 let caught:any;try{inspectAcceptanceSwitch([observation('uncertain',1,reason)],progressIdentity,progressPrefix);}catch(error){caught=error;}
 expect(caught.reasonCode).toBe('unclassified_reason');expect(caught.message).toBe('acceptance_switch_uncertain:unclassified_reason');expect(JSON.stringify(caught)).not.toContain('private');
});
