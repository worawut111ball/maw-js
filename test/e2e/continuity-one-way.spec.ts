/** UI contract fixtures only: actual mobile assets/browser, no native/service/server execution. */
import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium,devices,type Browser,type Page} from '../../ui/web/node_modules/playwright';
import {acceptProtocolSwitch,requestMobileApi} from './protocol-ui-acceptance';
import {mergeOwnedInventory} from '../../src/mobile/continuity/protocol/inventory';

const origin='https://maw-acceptance.invalid',ui=resolve(import.meta.dirname,'../../ui/mobile');
const directions=[
  {from:'codex',to:'claude',state:'available'},
  {from:'claude',to:'codex',state:'development',reason:'switch_direction_in_development'},
];
function fixture(active:'codex'|'claude'='codex',mode:'ready'|'uncertain'|'selection-error'='ready'){
  const workspace='one-way-fixture-workspace',alias='one-way-fixture-room';
  const base='/mobile/rooms/'+workspace+'/'+alias+'/continuity';
  const source={agent:'codex',nativeId:'fixture-codex-native',generation:'protocol:codex:'+'a'.repeat(64)+':1',model:'fixture-codex-model',route:'direct',cursor:0};
  const target={agent:'claude',nativeId:'fixture-claude-native',generation:'protocol:claude:'+'b'.repeat(64)+':1',model:'fixture-claude-model',route:'direct',cursor:0};
  const room:any={id:'one-way-fixture-logical',backend:'herdr',workspace,room:alias,cwd:'/fixture/one-way',active,revision:0,bindings:{codex:source,claude:target}};
  let operation:any=null,receipt:any=null;
  const calls:{method:string;path:string;body:any}[]=[];
  const events:any[]=[{seq:1,sourceId:'fixture-goal',agent:'codex',nativeId:source.nativeId,role:'user',text:'Synthetic fixture goal'}];
  const picks=[{field:'goal',seq:1,sourceId:'fixture-goal',agent:'codex' as const,nativeId:source.nativeId,eventHash:'c'.repeat(64)}];
  const transport=()=>({kind:'owned-protocol',roomId:room.id,revision:room.revision,binding:room.bindings[room.active],state:operation?.state==='uncertain'?'uncertain':'idle',capabilities:{textTurn:!room.operationId,attachments:false,keys:false}});
  const api={handle:async(request:Request)=>{
    const url=new URL(request.url),path=url.pathname;
    const body=request.method==='POST'?await request.json():null;
    calls.push({method:request.method,path,body});
    if(request.headers.get('authorization')!=='Bearer fixture-one-way-auth')return Response.json({ok:false},{status:401});
    let response:any;
    if(path==='/mobile/projects')response={projects:mergeOwnedInventory([],[{room,transport:transport()}] as any)};
    else if(path==='/mobile/version')response={v:'one-way-fixture-only'};
    else if(path==='/mobile/health')response={ok:true};
    else if(path==='/mobile/continuity/capabilities')response={ok:true,ready:true,roomStateAvailable:true,factsSelectionAvailable:true,scope:'room-backend',authorization:{purpose:'production'},switchDirections:directions,backends:[{backend:'herdr',ready:true}],models:[{agent:'codex',id:source.model,label:'Fixture Codex'},{agent:'claude',id:target.model,label:'Fixture Claude'}]};
    else if(path===base)response={ok:true,room,operation,held:[]};
    else if(path===base+'/transport')response={ok:true,transport:transport()};
    else if(path===base+'/events')response={ok:true,items:events.filter(e=>e.seq>Number(url.searchParams.get('after')||0))};
    else if(path===base+'/facts/preview')response={ok:true,preview:{id:'one-way-fixture-preview',roomId:room.id,roomRevision:room.revision,sourceBindingHash:'d'.repeat(64),archiveHash:'e'.repeat(64),throughSeq:1,contextText:'Synthetic fixture goal',selectionRequired:true,candidates:[{...picks[0],value:'Synthetic fixture goal'}]}};
    else if(path===base+'/facts/selections'){
      if(mode==='selection-error')return Response.json({ok:false,code:'context_receipt_unverified'},{status:503});
      response={ok:true,selection:{id:body.id,previewId:body.previewId,roomRevision:body.expectedRevision,factsHash:'f'.repeat(64)}};
    }else if(path===base+'/switch'){
      operation={id:body.id,roomId:room.id,target:body.target,model:body.model,expectedRevision:room.revision,from:structuredClone(room.bindings[room.active]),state:'waiting-safe-point',createdAt:1};room.operationId=body.id;response={ok:true,operation};
    }else if(operation&&path===base+'/operations/'+operation.id+'/advance'){
      if(mode==='uncertain'){operation.state='uncertain';operation.reason='staged_source_target_unverified';}
      else{operation.state='ready-awaiting-user';operation.targetBinding=target;room.active='claude';room.revision++;delete room.operationId;}
      response={ok:true,operation};
    }else if(operation&&path===base+'/operations/'+operation.id)response={ok:true,operation};
    else if(path===base+'/turns'){
      receipt={id:body.id,roomId:room.id,binding:body.binding,state:'completed',source:'live',turn:{operationId:body.id,nativeId:target.nativeId,turnId:'fixture-one-way-turn',text:'Synthetic fixture final',state:'completed'}};
      events.push({seq:2,sourceId:'fixture-turn-user',agent:'claude',nativeId:target.nativeId,role:'user',text:body.text,metadata:{operationId:body.id,turnId:receipt.turn.turnId,generation:target.generation}},{seq:3,sourceId:'fixture-turn-final',agent:'claude',nativeId:target.nativeId,role:'assistant',text:receipt.turn.text,metadata:{operationId:body.id,turnId:receipt.turn.turnId,generation:target.generation}});
      response={ok:true,receipt};
    }else if(path.startsWith(base+'/turns/'))response={ok:true,receipt:receipt&&{...receipt,source:'historical'}};
    else if(path==='/mobile/perf')response={ok:true};
    else return Response.json({ok:false,code:'fixture_unexpected_route'},{status:404});
    return Response.json(response,{headers:{'cache-control':'no-store'}});
  }};
  const host={api,workspace,room:alias,requestHeaders:{authorization:'Bearer fixture-one-way-auth'},setup:{runId:'one-way-browser-fixture',runtime:'di' as const,apiKind:'fixture-handler' as const,sourcePath:import.meta.filename},dispose:async()=>{}};
  return {api,host,workspace,alias,base,calls,picks,target,room,
    writes:()=>calls.filter(c=>c.method==='POST'&&c.path.startsWith(base)),
    scenario:{target:'claude' as const,model:target.model,facts:picks,text:'ช่วยทวนเป้าหมายจากบริบทที่ได้รับ',timeoutMs:10000,purpose:'production' as const}};
}
type Fixture=ReturnType<typeof fixture>;
async function bridge(page:Page,f:Fixture){
  // Remains installed after acceptance helper unroutes: no real HTTP/network fallback.
  await page.context().route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==origin)return route.abort('blockedbyclient');
    if(url.pathname.startsWith('/mobile/')){
      const body=req.postDataBuffer();
      const response=await requestMobileApi(f.api,{path:url.pathname+url.search,method:req.method(),headers:await req.allHeaders(),...(body?{body:new Uint8Array(body)}:{})},f.host.requestHeaders);
      return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    }
    const asset=url.pathname==='/m'?resolve(ui,'m.html'):/^\/m-ext\/[a-z0-9-]+\.js$/i.test(url.pathname)?resolve(ui,'ext',url.pathname.slice(7)):undefined;
    if(!asset)return route.abort('blockedbyclient');
    return route.fulfill({status:200,contentType:url.pathname==='/m'?'text/html':'text/javascript',body:await readFile(asset)});
  });
}
async function openRoom(page:Page,f:Fixture){
  await page.goto(origin+'/m',{waitUntil:'domcontentloaded'});
  await page.locator('[data-p]').filter({hasText:'one-way'}).first().click();
  const workspace=page.locator('[data-ws]').filter({hasText:f.workspace});
  if(await workspace.count())await workspace.first().click();
  await page.locator('[data-r]').filter({hasText:f.alias}).first().click();
  await page.locator('header [data-continuity-switch]').waitFor({state:'visible'});
}
async function chooseGoal(page:Page){
  await page.locator('header [data-continuity-switch]').click();
  await page.locator('[data-continuity-preview]').click();
  await page.locator('.continuity-facts input[type=radio]').first().check();
}

describe.skipIf(process.env.MAW_PROTOCOL_UI_FIXTURES!=='1')('production one-way UI contract (browser fixtures only)',()=>{
  let browser:Browser;
  beforeAll(async()=>{browser=await chromium.launch({headless:true});});
  afterAll(async()=>{await browser?.close();});
  for(const viewport of ['iphone-xr','desktop'] as const){
    const withPage=async(fn:(page:Page)=>Promise<void>)=>{
      const context=await browser.newContext(viewport==='iphone-xr'?{...devices['iPhone XR'],serviceWorkers:'block'}:{viewport:{width:1440,height:900},serviceWorkers:'block'});
      const page=await context.newPage();page.setDefaultTimeout(6000);
      try{await fn(page);}finally{await context.close();}
    };
    test(`${viewport}: Codex→Claude production direction traverses actual UI and preserves read-only history`,()=>withPage(async page=>{
      const f=fixture();await bridge(page,f);
      const result=await acceptProtocolSwitch(page,f.host,f.scenario);
      expect(result.acceptance).toBe('fixture-only');expect(result.productionCertified).toBe(false);
      expect(f.writes().filter(c=>c.path===f.base+'/switch')).toHaveLength(1);
      expect(f.writes().filter(c=>c.path===f.base+'/turns')).toHaveLength(1);
      await page.locator('[data-continuity-unavailable]').filter({hasText:'ยังพัฒนาอยู่'}).waitFor();
      expect(await page.locator('header [data-continuity-switch]').isDisabled()).toBe(true);
      expect((await page.locator('[data-continuity-unavailable]').allTextContents()).join(' ')).toContain('ยังพัฒนาอยู่');
    }),30000);
    test(`${viewport}: Claude→Codex stays disabled with visible development message, no mutation`,()=>withPage(async page=>{
      const f=fixture('claude');await bridge(page,f);await openRoom(page,f);
      await page.locator('[data-continuity-unavailable]').filter({hasText:'ยังพัฒนาอยู่'}).waitFor();
      expect(await page.locator('header [data-continuity-switch]').isDisabled()).toBe(true);
      await page.locator('header [data-continuity-switch]').evaluate((button:HTMLButtonElement)=>button.click());
      await page.reload({waitUntil:'domcontentloaded'});
      await page.locator('[data-continuity-unavailable]').filter({hasText:'ยังพัฒนาอยู่'}).waitFor();
      expect(f.writes()).toEqual([]);expect(await page.locator('[data-continuity-confirm]').count()).toBe(0);
    }),20000);
    test(`${viewport}: forward modal shows disabled Codex option instead of a silent unsupported action`,()=>withPage(async page=>{
      const f=fixture();await bridge(page,f);await openRoom(page,f);await page.locator('header [data-continuity-switch]').click();
      const option=page.locator('[data-continuity-provider] option[value=codex]');
      expect(await option.isDisabled()).toBe(true);expect(await option.textContent()).toContain('ยังพัฒนาอยู่');
      expect(await page.locator('[data-continuity-provider]').inputValue()).toBe('claude');
      expect(await page.locator('.sheet [data-continuity-unavailable]').textContent()).toContain('ยังพัฒนาอยู่');
      expect(f.writes()).toEqual([]);
    }),20000);
    test(`${viewport}: uncertain error stays visible and polling/reload never retries or resends`,()=>withPage(async page=>{
      const f=fixture('codex','uncertain');await bridge(page,f);await openRoom(page,f);
      await page.locator('#msg').fill('Synthetic draft preserved');await chooseGoal(page);await page.locator('[data-continuity-confirm]').click();
      await page.locator('[data-continuity-error]').filter({hasText:'ยังยืนยันสถานะ'}).waitFor();
      expect(await page.locator('#msg').inputValue()).toBe('Synthetic draft preserved');
      const polls=f.calls.filter(c=>c.path===f.base).length;
      await page.waitForFunction(()=>document.querySelector('.continuity-status')?.getAttribute('data-state')==='uncertain');
      await page.reload({waitUntil:'domcontentloaded'});
      await page.locator('[data-continuity-error]').filter({hasText:'ยังยืนยันสถานะ'}).waitFor();
      expect(f.calls.filter(c=>c.path===f.base).length).toBeGreaterThan(polls);
      expect(f.writes().filter(c=>c.path===f.base+'/switch')).toHaveLength(1);
      expect(f.writes().filter(c=>c.path.endsWith('/advance'))).toHaveLength(1);
      expect(f.writes().filter(c=>/\/(turns|retry|send|prompt)$/.test(c.path))).toEqual([]);
      expect(await page.getByRole('button',{name:'ลองใหม่',exact:true}).count()).toBe(0);
    }),25000);
    test(`${viewport}: API error is visible and preserves draft without starting a switch`,()=>withPage(async page=>{
      const f=fixture('codex','selection-error');await bridge(page,f);await openRoom(page,f);
      await page.locator('#msg').fill('Synthetic draft after API error');await chooseGoal(page);await page.locator('[data-continuity-confirm]').click();
      // 503 is classified by apiRaw as gateway failure before its JSON code is read.
      // The user must still see the failed stage and the no-resend warning.
      const error=page.locator('[data-continuity-error]').filter({hasText:'ยังยืนยันการบันทึก facts ไม่ได้'});
      await error.waitFor();expect(await error.textContent()).toContain('ไม่ส่งซ้ำอัตโนมัติ');
      expect(await page.locator('#msg').inputValue()).toBe('Synthetic draft after API error');
      expect(f.writes().filter(c=>c.path===f.base+'/facts/selections')).toHaveLength(1);
      expect(f.writes().filter(c=>/\/(switch|advance|turns|retry|send|prompt)$/.test(c.path))).toEqual([]);
    }),25000);
  }
});
