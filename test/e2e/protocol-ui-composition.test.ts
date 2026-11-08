/** Actual API + actual host composition/service; only native entry/authority/driver/supervisor I/O is DI. */
import {describe,test,expect} from 'bun:test';
import {chromium} from '../../ui/web/node_modules/playwright';
import {acceptProtocolSwitch,requestMobileApi} from './protocol-ui-acceptance';
import {createCompositionAcceptanceFixture} from './protocol-ui-composition-setup';

describe.skipIf(process.env.MAW_PROTOCOL_UI_FIXTURES!=='1')('actual API bounded composition browser integration (DI only)',()=>{
 for(const turnDelayMs of [0,3500])test(`actual routes ${turnDelayMs?'with in-flight budget exhaustion ':'without delay '}consume durable bounded budget only on switch/text effects and preserve read-only history afterward`,async()=>{
  const f=await createCompositionAcceptanceFixture({turnDelayMs}),browser=await chromium.launch({headless:true}),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  const base='/mobile/rooms/'+encodeURIComponent(f.host.workspace)+'/'+encodeURIComponent(f.host.room)+'/continuity';
  const get=async(path:string)=>{const response=await requestMobileApi(f.host.api,{path,method:'GET'},f.host.requestHeaders);expect(response.status).toBe(200);return response.json();};
  try{
   const first=await get('/mobile/continuity/capabilities'),second=await get('/mobile/continuity/capabilities');
   expect(first.authorization.purpose).toBe('bounded-acceptance');expect(second.authorization.permits[0].remaining).toBe(2);expect(first.authorization).toEqual(second.authorization);expect(f.effects.filter(e=>e.kind.startsWith('authorize:'))).toHaveLength(0);
   const result=await acceptProtocolSwitch(page,f.host,f.scenario);
   expect(result.acceptance).toBe('fixture-only');expect(result.nativeExecutionVerified).toBe(false);expect(result.productionCertified).toBe(false);expect(result.authorizationPurpose).toBe('bounded-acceptance');if(turnDelayMs)expect(result.draftOutcome).toBe('retained-original');
   const final=await get('/mobile/continuity/capabilities');expect(final.ready).toBe(false);expect(final.authorization.purpose).toBe('bounded-acceptance');expect(final.authorization.permits[0].remaining).toBe(0);expect(f.productionReads).toBe(0);
   const current=await get(base),id=current.operation.id;expect(current.room.active).toBe('claude');expect(current.room.operationId).toBeUndefined();expect(current.operation.state).toBe('ready-awaiting-user');
   expect((await get(base+'/operations/'+encodeURIComponent(id))).operation.id).toBe(id);
   expect((await get(base+'/events?after=0&limit=500')).items.some((e:any)=>e.role==='assistant'&&e.text==='fixture final DEMO-17 · remaining 4 · Tuesday')).toBe(true);
   expect((await get(base+'/transport')).transport.capabilities.textTurn).toBe(false);
   expect(new Set(f.effects.filter(e=>e.kind==='authorize:switch').map(e=>e.operationId)).size).toBe(1);expect(new Set(f.effects.filter(e=>e.kind==='authorize:text-turn').map(e=>e.operationId)).size).toBe(1);
   expect(f.effects.filter(e=>e.kind==='supervisor-DI')).toHaveLength(2); // actual composition, no OS process
  }finally{await context.close();await browser.close();await f.host.dispose();}
 },90000);
});
