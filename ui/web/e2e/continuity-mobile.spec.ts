import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const extension=readFileSync(resolve(import.meta.dirname,'../../mobile/ext/continuity.js'),'utf8');
const path='/rooms/w/p/continuity';
const blocked={ok:true,room:{id:'logical-p',workspace:'w',room:'p',active:'codex',revision:7,operationId:'old-op'},operation:{id:'old-op',state:'blocked'},held:[]};
async function setup(page:Page,ready=true,initial?:any){
 await page.setContent('<div id="ext-room-top"></div><button data-xk="0">Agent</button>');
 await page.addScriptTag({content:`
 var mawExt={keys:[],onRoom:[],onPoll:[],onHome:[]};var state={ws:'w',room:'p'};var calls=[];var toasts=[];
 var fixture={w:{id:'w'},room:{id:'p',agent:'codex'}};
 var capability={ok:true,ready:${JSON.stringify(ready)},backends:['herdr','tmux','superset'].map(backend=>({backend,ready:${JSON.stringify(ready)}})),models:[{agent:'claude',id:'fixture-model',label:'Fixture <model>'}]};
 var states={p:${JSON.stringify(initial??{ok:true,room:{id:'logical-p',workspace:'w',room:'p',active:'codex',revision:7},operation:null,held:[]})},q:{ok:true,room:{id:'logical-q',workspace:'w',room:'q',active:'claude',revision:2},operation:null,held:[]}};
 var toast=function(t){toasts.push(t);};var nextId=0;var requestId=function(){return 'browser-request-'+(++nextId);};
 var deferred=[];var releases={};
 window.hold=function(key,path,method='GET'){deferred.push({key,path,method});};
 window.release=function(key,value,fail=false){releases[key](value,fail);};
 var apiRaw=async function(path,opts){calls.push({path,opts});const method=opts?.method||'GET';
 const index=deferred.findIndex(d=>d.path===path&&d.method===method);
 if(index>=0){const d=deferred.splice(index,1)[0];return new Promise((resolve,reject)=>{releases[d.key]=(value,fail)=>fail?reject(new Error(value)):resolve(structuredClone(value));});}
 if(path==='/continuity/capabilities')return structuredClone(capability);
 const room=path.includes('/rooms/w/q/')?'q':'p';
 if(path.endsWith('/switch')){if(window.revokeAfterSwitch)capability.ready=false;states[room].room.operationId='op-'+room;states[room].operation={id:'op-'+room,state:'waiting-safe-point'};return {ok:true,operation:structuredClone(states[room].operation)};}
 if(path.endsWith('/advance')||path.endsWith('/retry'))return {ok:true,operation:structuredClone(states[room].operation)};
 if(path.endsWith('/cancel'))return {ok:true,room:structuredClone(states[room].room)};
 return structuredClone(states[room]);};
 `});
 await page.addScriptTag({content:extension});
 await page.evaluate(()=>{const w:any=window;w.mawExt.onRoom[0](w.fixture);});
 await expect.poll(()=>page.evaluate(()=>(window as any).calls.length)).toBeGreaterThan(0);
 if(ready)await expect(page.locator('.continuity-status')).toBeVisible();
 else await expect(page.locator('[data-xk="0"]')).toBeHidden();
}
async function open(page:Page){await page.evaluate(()=>{const w:any=window;return w.mawExt.keys[0].onClick(w.fixture);});await expect(page.locator('.sheet')).toBeVisible();}
async function poll(page:Page){await page.evaluate(()=>{const w:any=window;w.mawExt.onPoll[0](w.fixture);});}
async function changeRoom(page:Page,room='q'){await page.evaluate(room=>{const w:any=window;w.state.room=room;w.fixture={w:{id:'w'},room:{id:room}};w.mawExt.onRoom[0](w.fixture);},room);}
async function posts(page:Page){return page.evaluate(()=>(window as any).calls.filter((c:any)=>c.opts?.method==='POST'));}
async function waitDeferred(page:Page,key:string){await expect.poll(()=>page.evaluate(key=>typeof (window as any).releases[key],key)).toBe('function');}

test('uncertified production stays hidden, including programmatic open, without mutations',async({page})=>{
 await setup(page,false);await page.evaluate(()=>{const w:any=window;return w.mawExt.keys[0].onClick(w.fixture);});
 await expect(page.locator('.sheet')).toHaveCount(0);expect(await posts(page)).toEqual([]);
});
test('picker uses capability models/current revision and sends one switch plus explicit advance',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await setup(page);await open(page);
 await expect(page.locator('select option')).toHaveText('Fixture <model>');
 await page.getByRole('button',{name:'เปลี่ยนเป็น claude',exact:true}).click();
 await expect(page.locator('.continuity-status')).toContainText('รอ agent จบรอบ');
 await expect.poll(async()=>(await posts(page)).length).toBe(2);const requests=await posts(page);
 expect(JSON.parse(requests[0].opts.body)).toEqual({id:'browser-request-1',target:'claude',model:'fixture-model',expectedRevision:7});
 expect(requests[1].path).toBe(path+'/operations/op-p/advance');expect(errors).toEqual([]);
});
test('capability revocation closes modal and removes stale status/actions within old cache window',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).capability.ready=false;});await poll(page);
 await expect(page.locator('.sheet')).toHaveCount(0);await expect(page.locator('.continuity-status')).toHaveCount(0);await expect(page.locator('[data-xk="0"]')).toBeHidden();
 await page.evaluate(()=>{const w:any=window;return w.mawExt.keys[0].onClick(w.fixture);});expect(await posts(page)).toEqual([]);
});
test('ready=true with a revoked backend never opens or submits',async({page})=>{
 await setup(page);await page.evaluate(()=>{(window as any).capability.backends[1].ready=false;});
 await page.evaluate(()=>{const w:any=window;return w.mawExt.keys[0].onClick(w.fixture);});
 await expect(page.locator('.sheet')).toHaveCount(0);expect(await posts(page)).toEqual([]);
});
test('revocation immediately before confirm blocks POST without waiting for a poll',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).capability.ready=false;});
 await page.getByRole('button',{name:'เปลี่ยนเป็น claude',exact:true}).click();await expect(page.locator('.sheet')).toHaveCount(0);expect(await posts(page)).toEqual([]);
});
test('failed current refresh clears old ready data and closes stale modal',async({page})=>{
 await setup(page);await open(page);await page.evaluate(path=>{const w:any=window;w.hold('bad',path);void w.mawExt.keys[0].onClick(w.fixture);},path);
 await waitDeferred(page,'bad');await page.evaluate(()=>{(window as any).release('bad','offline',true);});
 await expect(page.locator('.sheet')).toHaveCount(0);await expect(page.locator('.continuity-status')).toHaveCount(0);expect(await posts(page)).toEqual([]);
});
test('new room loads while old GET is inflight and ignores its late response',async({page})=>{
 await setup(page);await page.evaluate(path=>{(window as any).hold('old',path);},path);await poll(page);await waitDeferred(page,'old');
 await changeRoom(page);await expect(page.locator('.continuity-status')).toHaveText('Agent: claude');
 await page.evaluate(data=>{(window as any).release('old',data);},blocked);
 await expect(page.locator('.continuity-status')).toHaveText('Agent: claude');await expect(page.getByRole('button',{name:'ลองใหม่',exact:true})).toHaveCount(0);expect(await posts(page)).toEqual([]);
});
test('room change closes modal and detached old confirm cannot POST',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).oldConfirm=document.querySelector('.sheet button');});await changeRoom(page);
 await expect(page.locator('.sheet')).toHaveCount(0);await page.evaluate(()=>{(window as any).oldConfirm.click();});expect(await posts(page)).toEqual([]);
});
test('room change during preflight prevents switch request to previous room',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).hold('caps','/continuity/capabilities');});
 await page.getByRole('button',{name:'เปลี่ยนเป็น claude',exact:true}).click();await waitDeferred(page,'caps');await changeRoom(page);
 await page.evaluate(()=>{const w:any=window;w.release('caps',w.capability);});await expect(page.locator('.continuity-status')).toHaveText('Agent: claude');expect(await posts(page)).toEqual([]);
});
test('switch response after room change does not trigger old-room advance or refresh',async({page})=>{
 await setup(page);await open(page);await page.evaluate(path=>{(window as any).hold('switch',path+'/switch','POST');},path);
 await page.getByRole('button',{name:'เปลี่ยนเป็น claude',exact:true}).click();await waitDeferred(page,'switch');await changeRoom(page);await expect(page.locator('.continuity-status')).toHaveText('Agent: claude');
 const before=await page.evaluate(()=>(window as any).calls.length);await page.evaluate(()=>{(window as any).release('switch',{ok:true,operation:{id:'op-p'}});});
 await expect(page.locator('.continuity-status')).toHaveText('Agent: claude');expect(await posts(page)).toHaveLength(1);expect(await page.evaluate(()=>(window as any).calls.length)).toBe(before);
});
test('same room ID revisited ignores earlier visit response',async({page})=>{
 await setup(page);await page.evaluate(path=>{(window as any).hold('firstVisit',path);},path);await poll(page);await waitDeferred(page,'firstVisit');
 await changeRoom(page);await expect(page.locator('.continuity-status')).toHaveText('Agent: claude');
 await page.evaluate(()=>{const w:any=window;w.states.p.room.active='claude';w.states.p.room.revision=9;});await changeRoom(page,'p');await expect(page.locator('.continuity-status')).toHaveText('Agent: claude');
 await page.evaluate(data=>{(window as any).release('firstVisit',data);},blocked);await expect(page.locator('.continuity-status')).toHaveText('Agent: claude');
});
test('revision change closes modal and rejects stale confirm without POST',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).states.p.room.revision++;});
 await page.getByRole('button',{name:'เปลี่ยนเป็น claude',exact:true}).click();await expect(page.locator('.sheet')).toHaveCount(0);expect(await posts(page)).toEqual([]);
 await expect.poll(()=>page.evaluate(()=>(window as any).toasts.at(-1))).toContain('สถานะห้องเปลี่ยนแล้ว');
});
test('retry/cancel refresh operation identity and revision before mutation',async({page})=>{
 await setup(page,true,blocked);await page.evaluate(()=>{const w:any=window;w.oldCancel=[...document.querySelectorAll('.continuity-status button')].find((b:any)=>b.textContent==='ยกเลิกการสลับ');w.states.p.room.revision=8;w.states.p.room.operationId='new-op';w.states.p.operation={id:'new-op',state:'blocked'};});
 await page.getByRole('button',{name:'ลองใหม่',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).toasts.at(-1))).toContain('สถานะห้องเปลี่ยนแล้ว');
 await page.evaluate(()=>{(window as any).oldCancel.click();});expect(await posts(page)).toEqual([]);
 await page.getByRole('button',{name:'ยกเลิกการสลับ',exact:true}).click();await expect.poll(async()=>(await posts(page)).length).toBe(1);
 const requests=await posts(page);expect(requests[0].path).toBe(path+'/operations/new-op/cancel');expect(JSON.parse(requests[0].opts.body)).toEqual({expectedRevision:8});
});
test('missing API model catalog never fills a model or sends switch',async({page})=>{
 await setup(page);await page.evaluate(()=>{(window as any).capability.models=[];});await open(page);
 await expect(page.locator('.sheet')).toContainText('ยังไม่มีข้อมูลโมเดลที่รองรับ');await expect(page.locator('select')).toHaveCount(0);expect(await posts(page)).toEqual([]);
});

test('revoked model in an open picker cannot submit its old selection',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).capability.models=[];});
 await page.getByRole('button',{name:'เปลี่ยนเป็น claude',exact:true}).click();await expect(page.locator('.sheet')).toHaveCount(0);expect(await posts(page)).toEqual([]);
});
test('capability revoked after switch acceptance stops automatic advance',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).revokeAfterSwitch=true;});
 await page.getByRole('button',{name:'เปลี่ยนเป็น claude',exact:true}).click();await expect(page.locator('[data-xk="0"]')).toBeHidden();
 const requests=await posts(page);expect(requests).toHaveLength(1);expect(requests[0].path).toBe(path+'/switch');
});
test('mismatched current room response clears controls rather than trusting requested URL',async({page})=>{
 await setup(page);await page.evaluate(()=>{(window as any).states.p.room.room='foreign-room';});await poll(page);
 await expect(page.locator('.continuity-status')).toHaveCount(0);await expect(page.locator('[data-xk="0"]')).toBeHidden();expect(await posts(page)).toEqual([]);
});
test('poll detects changed revision and dismisses obsolete modal without user input',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).states.p.room.revision++;});await poll(page);
 await expect(page.locator('.sheet')).toHaveCount(0);expect(await posts(page)).toEqual([]);
});
test('double click dispatches at most once and API reads bypass offline cache',async({page})=>{
 await setup(page);await open(page);await page.evaluate(path=>{const w:any=window;w.hold('single',path+'/switch','POST');const b=document.querySelector('.sheet button') as HTMLButtonElement;b.click();b.click();},path);
 await waitDeferred(page,'single');expect((await posts(page)).filter((c:any)=>c.path.endsWith('/switch'))).toHaveLength(1);
 await page.evaluate(()=>{(window as any).release('single',{ok:false,code:'stale_room_revision'});});await expect(page.locator('.sheet')).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).calls.every((c:any)=>c.opts.cache==='no-store'))).toBe(true);
});

test('late old-room poll hook cannot close the new room modal',async({page})=>{
 await setup(page);await page.evaluate(()=>{const w:any=window;w.previousFixture=w.fixture;});await changeRoom(page);await expect(page.locator('.continuity-status')).toHaveText('Agent: claude');await open(page);
 await page.evaluate(()=>{const w:any=window;w.mawExt.onPoll[0](w.previousFixture);});await expect(page.locator('.sheet')).toBeVisible();expect(await posts(page)).toEqual([]);
});
