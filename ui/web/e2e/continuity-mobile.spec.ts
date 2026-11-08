import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const extension=readFileSync(resolve(import.meta.dirname,'../../mobile/ext/continuity.js'),'utf8');
const mobile=readFileSync(resolve(import.meta.dirname,'../../mobile/m.html'),'utf8');
const pendingCore=mobile.slice(mobile.indexOf('function roomBinding(ws, id)'),mobile.indexOf('// mark the newest agent reply'));
const composerCore=mobile.slice(mobile.indexOf('    async function doSend() {'),mobile.indexOf('    $app.querySelectorAll("[data-k]")'));
const path='/rooms/w/p/continuity';
const blocked={ok:true,room:{id:'logical-p',workspace:'w',room:'p',active:'codex',revision:7,operationId:'old-op'},operation:{id:'old-op',state:'blocked'},held:[]};
async function setup(page:Page,ready=true,initial?:any){
 await page.setContent('<header><div id="ext-room-actions"></div></header><div id="ext-room-top"></div><button data-xk="0">Agent</button>');
 await page.addScriptTag({content:`
 var memoryStorage={};var storageMode='normal';Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>{if(storageMode==='unavailable')throw new Error('storage unavailable');if(storageMode==='readback')return 'mismatched';return memoryStorage[k]??null;},setItem:(k,v)=>{if(['full','unavailable'].includes(storageMode))throw new Error('storage full');memoryStorage[k]=v;},removeItem:k=>{delete memoryStorage[k];}}});
 var mawExt={keys:[],onRoom:[],onPoll:[],onHome:[]};var state={ws:'w',room:'p'};var calls=[];var toasts=[];
 var fixture={w:{id:'w'},room:{id:'p',agent:'codex'}};
 var capability={ok:true,roomStateAvailable:false,factsSelectionAvailable:true,ready:${JSON.stringify(ready)},backends:['herdr','tmux','superset'].map(backend=>({backend,ready:${JSON.stringify(ready)}})),models:[{agent:'claude',id:'fixture-model',label:'Fixture <model>'}]};
 var states={p:${JSON.stringify(initial??{ok:true,room:{id:'logical-p',workspace:'w',room:'p',active:'codex',revision:7},operation:null,held:[]})},q:{ok:true,room:{id:'logical-q',workspace:'w',room:'q',active:'claude',revision:2},operation:null,held:[]}};
 var defaultBinding=agent=>({agent,nativeId:'native-'+agent,generation:'generation-'+agent,model:'fixture-'+agent+'-model',route:'fixture-route',cursor:0});
 for(const d of Object.values(states)){d.room.backend ||= 'herdr';d.room.bindings ||= {codex:defaultBinding('codex'),claude:defaultBinding('claude')};}
 var normalizeOperation=(op,d)=>op?{roomId:d.room.id,target:'claude',model:'fixture-model',expectedRevision:d.room.revision,from:structuredClone(d.room.bindings[d.room.active]),...op}:null;
 var previewFor=room=>({id:'preview-'+room,roomId:states[room].room.id,roomRevision:states[room].room.revision,sourceBindingHash:'a'.repeat(64),archiveHash:'b'.repeat(64),throughSeq:2,contextText:'บริบทจริงจาก API fixture <script>window.pwned=1</script>',selectionRequired:true,candidates:[{field:'goal',seq:1,sourceId:'goal-source',agent:'codex',nativeId:'native-codex',eventHash:'c'.repeat(64),value:'เป้าหมายที่เลือกเอง'},{field:'constraints',seq:2,sourceId:'constraint-source',agent:'codex',nativeId:'native-codex',eventHash:'d'.repeat(64),value:['ข้อจำกัดอ้างอิง']}],...(window.previewOverrides?.[room]||{})});
 var savedSelections={},storedOperations={};
 var toast=function(t){toasts.push(t);};var nextId=0;var requestId=function(){return 'browser-request-'+(++nextId);};
 var deferred=[];var releases={};
 window.hold=function(key,path,method='GET'){deferred.push({key,path,method});};
 window.release=function(key,value,fail=false){releases[key](value,fail);};
 var apiRaw=async function(path,opts){calls.push({path,opts});const method=opts?.method||'GET';
 const index=deferred.findIndex(d=>d.path===path&&d.method===method);
 if(index>=0){const d=deferred.splice(index,1)[0];return new Promise((resolve,reject)=>{releases[d.key]=(value,fail)=>fail?reject(new Error(value)):resolve(structuredClone(value));});}
 if(path.endsWith('/transport')){const e=new Error('optional transport absent');e.status=404;throw e;}
 if(path==='/continuity/capabilities')return structuredClone(capability);
 const room=path.includes('/rooms/w/q/')?'q':'p';
 if(path.endsWith('/facts/preview')){if(window.previewFailure)throw new Error('facts service unavailable');return {ok:true,preview:previewFor(room)};}
 if(path.endsWith('/facts/selections')){const b=JSON.parse(opts.body);savedSelections[b.id]=structuredClone(b);if(window.selectionLostACK)throw new Error('selection ACK lost');return {ok:true,selection:{id:b.id,previewId:b.previewId,roomRevision:b.expectedRevision,factsHash:'e'.repeat(64),...(window.selectionReceiptOverride||{})}};}
 if(method==='GET'&&path.includes('/operations/')){if(window.statusFailure){const e=new Error('lookup unavailable');e.status=window.statusFailure;throw e;}const id=decodeURIComponent(path.split('/').at(-1));return {ok:true,operation:structuredClone(window.lookupOverride||storedOperations[id])};}
 if(path.includes('/events?')){const after=new URL('http://fixture'+path).searchParams.get('after');return {ok:true,items:structuredClone(window.historyPages?.[after]||[])};}
 if(path.endsWith('/held')){
 const body=JSON.parse(opts.body);window.holdRequests ||= [];window.holdRequests.push({body,persisted:localStorage.getItem('maw-pend')});
 if(window.failHeldBeforeStore)throw new Error('lost held ACK');
 const message={id:body.id,text:body.text,intendedGeneration:body.intendedGeneration,version:2,originOperationId:body.expectedOperationId,originRevision:body.expectedRevision,intendedBinding:structuredClone(states[room].room.bindings[states[room].room.active])};delete message.intendedBinding.cursor;
 if(window.badHeldReceipt)message.intendedBinding.generation='forged';
 states[room].held.push(message);
 if(window.failHeldAfterStore)throw new Error('lost held ACK');return {ok:true,message};}
 if(path.endsWith('/switch')){const b=JSON.parse(opts.body);if(window.revokeAfterSwitch)capability.ready=false;states[room].room.operationId=b.id;states[room].operation=normalizeOperation({id:b.id,target:b.target,model:b.model,expectedRevision:b.expectedRevision,state:'waiting-safe-point'},states[room]);storedOperations[b.id]=structuredClone(states[room].operation);if(window.switchLostACK)throw new Error('switch ACK lost');return {ok:true,operation:structuredClone(states[room].operation)};}
 if(path.endsWith('/advance')||path.endsWith('/retry'))return {ok:true,operation:structuredClone(states[room].operation)};
 if(path.endsWith('/cancel'))return {ok:true,room:structuredClone(states[room].room)};
 const d=structuredClone(states[room]);d.operation=normalizeOperation(d.operation,d);return d;};
 `});
 await page.addScriptTag({content:extension});
 await page.evaluate(()=>{const w:any=window;w.mawExt.onRoom[0](w.fixture);});
 await expect.poll(()=>page.evaluate(()=>(window as any).calls.length)).toBeGreaterThan(0);
 if(ready)await expect(page.locator('.continuity-status')).toBeVisible();
 else await expect(page.locator('[data-xk="0"]')).toBeHidden();
}
async function open(page:Page,choose=true){await page.evaluate(()=>{const w:any=window;return w.mawExt.keys[0].onClick(w.fixture);});await expect(page.locator('.sheet')).toBeVisible();if(choose&&await page.locator('[data-continuity-preview]').isEnabled()){await page.locator('[data-continuity-preview]').click();await expect(page.locator('.continuity-preview-status')).not.toContainText('กำลังอ่าน');const goal=page.locator('.continuity-facts input[type=radio]').first();if(await goal.count())await goal.check();}}
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
 await expect(page.locator('[data-continuity-model] option')).toHaveText('Fixture <model>');
 await page.getByRole('button',{name:'เปลี่ยนเป็น claude',exact:true}).click();
 await expect(page.locator('.continuity-status')).toContainText('รอ agent จบรอบ');
 await expect.poll(async()=>(await posts(page)).length).toBe(3);const requests=(await posts(page)).filter((c:any)=>!c.path.endsWith('/facts/selections'));
 expect(JSON.parse(requests[0].opts.body)).toEqual({id:'browser-request-1',target:'claude',model:'fixture-model',expectedRevision:7,factsSelectionId:'browser-request-1'});
 expect(requests[1].path).toBe(path+'/operations/browser-request-1/advance');expect(errors).toEqual([]);
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
 await changeRoom(page);await expect(page.locator('.continuity-status')).toContainText('Agent: claude');
 await page.evaluate(data=>{(window as any).release('old',data);},blocked);
 await expect(page.locator('.continuity-status')).toContainText('Agent: claude');await expect(page.getByRole('button',{name:'ลองใหม่',exact:true})).toHaveCount(0);expect(await posts(page)).toEqual([]);
});
test('room change closes modal and detached old confirm cannot POST',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).oldConfirm=document.querySelector('[data-continuity-confirm]');});await changeRoom(page);
 await expect(page.locator('.sheet')).toHaveCount(0);await page.evaluate(()=>{(window as any).oldConfirm.click();});expect(await posts(page)).toEqual([]);
});
test('room change during preflight prevents switch request to previous room',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).hold('caps','/continuity/capabilities');});
 await page.getByRole('button',{name:'เปลี่ยนเป็น claude',exact:true}).click();await waitDeferred(page,'caps');await changeRoom(page);
 await page.evaluate(()=>{const w:any=window;w.release('caps',w.capability);});await expect(page.locator('.continuity-status')).toContainText('Agent: claude');expect(await posts(page)).toEqual([]);
});
test('switch response after room change does not trigger old-room advance or refresh',async({page})=>{
 await setup(page);await open(page);await page.evaluate(path=>{(window as any).hold('switch',path+'/switch','POST');},path);
 await page.getByRole('button',{name:'เปลี่ยนเป็น claude',exact:true}).click();await waitDeferred(page,'switch');await changeRoom(page);await expect(page.locator('.continuity-status')).toContainText('Agent: claude');
 const before=await page.evaluate(()=>(window as any).calls.length);await page.evaluate(()=>{(window as any).release('switch',{ok:true,operation:{id:'op-p'}});});
 await expect(page.locator('.continuity-status')).toContainText('Agent: claude');expect(await posts(page)).toHaveLength(2);expect(await page.evaluate(()=>(window as any).calls.length)).toBe(before);
});
test('same room ID revisited ignores earlier visit response',async({page})=>{
 await setup(page);await page.evaluate(path=>{(window as any).hold('firstVisit',path);},path);await poll(page);await waitDeferred(page,'firstVisit');
 await changeRoom(page);await expect(page.locator('.continuity-status')).toContainText('Agent: claude');
 await page.evaluate(()=>{const w:any=window;w.states.p.room.active='claude';w.states.p.room.revision=9;});await changeRoom(page,'p');await expect(page.locator('.continuity-status')).toContainText('Agent: claude');
 await page.evaluate(data=>{(window as any).release('firstVisit',data);},blocked);await expect(page.locator('.continuity-status')).toContainText('Agent: claude');
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
 const requests=await posts(page);expect(requests).toHaveLength(2);expect(requests[1].path).toBe(path+'/switch');
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
 await setup(page);await open(page);await page.evaluate(path=>{const w:any=window;w.hold('single',path+'/switch','POST');const b=document.querySelector('[data-continuity-confirm]') as HTMLButtonElement;b.click();b.click();},path);
 await waitDeferred(page,'single');expect((await posts(page)).filter((c:any)=>c.path.endsWith('/switch'))).toHaveLength(1);
 await page.evaluate(()=>{(window as any).release('single',{ok:false,code:'stale_room_revision'});});await expect(page.locator('.sheet')).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).calls.every((c:any)=>c.opts.cache==='no-store'))).toBe(true);
});

test('late old-room poll hook cannot close the new room modal',async({page})=>{
 await setup(page);await page.evaluate(()=>{const w:any=window;w.previousFixture=w.fixture;});await changeRoom(page);await expect(page.locator('.continuity-status')).toContainText('Agent: claude');await open(page);
 await page.evaluate(()=>{const w:any=window;w.mawExt.onPoll[0](w.previousFixture);});await expect(page.locator('.sheet')).toBeVisible();expect(await posts(page)).toEqual([]);
});

test('stored history uses API sequence pagination and renders reference text without executing markup',async({page})=>{
 await setup(page);await page.evaluate(()=>{(window as any).historyPages={0:[{seq:3,agent:'codex',nativeId:'n1',sourceId:'s1',role:'user',text:'<img src=x onerror="window.pwned=1">'}],3:[{seq:8,agent:'claude',nativeId:'n2',sourceId:'s2',role:'assistant',text:'ข้อมูลต่อเนื่อง'}],8:[]};});
 await page.locator('.continuity-history-load').click();await expect(page.locator('.continuity-history')).toContainText('#3 · codex · user · —');
 await expect(page.locator('.continuity-history img')).toHaveCount(0);await expect(page.locator('.continuity-history')).toContainText('อาจไม่รวมข้อความล่าสุด');
 await page.locator('.continuity-history-load').click();await expect(page.locator('.continuity-history')).toContainText('#8 · claude');
 await page.locator('.continuity-history-load').click();await expect(page.locator('.continuity-history-load')).toHaveText('อ่านประวัติใหม่');
 expect(await posts(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).pwned)).toBeUndefined();
});
test('history rejects an invalid page atomically and preserves previous records',async({page})=>{
 await setup(page);await page.evaluate(()=>{const e={agent:'codex',nativeId:'n',sourceId:'s',role:'user',text:'kept'};(window as any).historyPages={0:[{...e,seq:1}],1:[{...e,seq:2,text:'must-not-append'},{...e,seq:1}]};});
 await page.locator('.continuity-history-load').click();await expect(page.locator('.continuity-history')).toContainText('kept');
 await page.locator('.continuity-history-load').click();await expect(page.locator('.continuity-history')).toContainText('ลำดับหรือข้อมูลประวัติไม่ถูกต้อง');await expect(page.locator('.continuity-history')).not.toContainText('must-not-append');expect(await posts(page)).toEqual([]);
});
test('late historical response cannot populate another room or survive capability withdrawal',async({page})=>{
 await setup(page);await page.evaluate(()=>{(window as any).hold('history','/rooms/w/p/continuity/events?after=0&limit=100');});
 await page.locator('.continuity-history-load').click();await waitDeferred(page,'history');await changeRoom(page);
 await page.evaluate(()=>{(window as any).release('history',{ok:true,items:[{seq:1,agent:'codex',nativeId:'n',sourceId:'s',role:'user',text:'wrong-room'}]});});
 await expect(page.locator('.continuity-status')).not.toContainText('wrong-room');await expect(page.locator('.continuity-history')).toHaveCount(0);
 await page.evaluate(()=>{(window as any).capability.ready=false;});await poll(page);await expect(page.locator('.continuity-status')).toHaveCount(0);expect(await posts(page)).toEqual([]);
});
test('held records are displayed as stored only, never auto-sent on polling',async({page})=>{
 await setup(page,true,{...blocked,held:[{id:'held',text:'<b>ข้อความพัก</b>',intendedGeneration:'old-generation'}]});
 await page.locator('.continuity-held summary').click();await expect(page.locator('.continuity-held')).toContainText('ยังไม่ส่งถึง agent');await expect(page.locator('.continuity-held pre')).toHaveText('<b>ข้อความพัก</b>');await expect(page.locator('.continuity-held b')).toHaveCount(0);
 await poll(page);expect(await posts(page)).toEqual([]);
});


// Real m.html queued-send/persistence/composer code, with browser platform/API fixtures only.
async function setupCore(page:Page, saved?:string, ws='w') {
 await setup(page,false);
 await page.evaluate(({saved,ws})=>{
  const w:any=window;
  w.memoryStorage=saved?{'maw-pend':saved}:{};w.storageMode='normal';
  Object.defineProperty(window,'localStorage',{configurable:true,value:{
   getItem(key:string){if(w.storageMode==='unavailable')throw new DOMException('storage disabled');if(w.storageMode==='readback'&&key==='maw-pend')return 'mismatched';return w.memoryStorage[key]??null;},
   setItem(key:string,value:string){if(['full','unavailable'].includes(w.storageMode))throw new DOMException('quota exceeded');w.memoryStorage[key]=value;},
   removeItem(key:string){delete w.memoryStorage[key];}
  }});
  w.blobs={};Object.defineProperty(window,'caches',{configurable:true,value:{open:async()=>({put:async(key:string,value:Response)=>{w.blobs[key]=value.clone();},match:async(key:string)=>w.blobs[key]?.clone()??null,delete:async(key:string)=>{delete w.blobs[key];}})}});
  w.state={...w.state,ws,room:'p',files:[],filesRoom:ws+'/p',follow:false,mode:'chat',projects:[]};
  w.fixture={w:{id:ws},room:{id:'p',generation:'provider-generation',continuityToken:'provider-token',status:'idle',capabilities:{prompt:true,answer:false}}};
  w.state.projects=[{workspaces:[{id:ws,rooms:[w.fixture.room]}]}];
  w.capability.roomStateAvailable=true;
  w.states.p={...w.states.p,room:{...w.states.p.room,workspace:ws,operationId:'op',bindings:{codex:{agent:'codex',nativeId:'native-original',generation:'continuity-generation',model:'fixture-codex-model',route:'mind',cursor:0}}},operation:{id:'op',state:'waiting-safe-point'}};
  w.mawExt.onRoom[0](w.fixture);
  document.body.insertAdjacentHTML('beforeend','<div id="screen"></div><textarea id="msg"></textarea><button id="send">ส่ง</button>');
  const msg=document.getElementById('msg') as HTMLTextAreaElement;msg.oninput=()=>{w.draftSaved=msg.value;};
  w.uploads=[];w.fetch=async(...args:any[])=>{w.uploads.push(args[0]);return new Response(JSON.stringify({ok:true,path:'/fixture/upload'}),{headers:{'content-type':'application/json'}});};
  w.originalRaw=w.apiRaw;w.currentReads=0;
  w.apiRaw=async(path:string,opts:any)=>{
   if(path===('/rooms/'+encodeURIComponent(ws)+'/p/continuity')&&opts?.method!=='POST'){
    w.currentReads++;
    if(w.replaceOnRead===w.currentReads)w.states.p.room.bindings.codex.generation='replacement-generation';
    if(w.current404){const error:any=new Error('not managed');error.body={ok:false,code:'room_not_found'};error.status=w.currentErrorStatus??404;throw error;}
    if(w.currentFailure)throw new Error('current unavailable');
   }
   return w.originalRaw(path,opts);
  };
 },{saved,ws});
 await page.addScriptTag({content:`
 var api=(...a)=>apiRaw(...a);var isHerdr=ws=>ws.startsWith('herdr:');var paintNet=()=>{};var playSound=()=>{};var loadScreen=()=>{};var clearDraft=()=>{};var shrinkImage=async f=>f;var askMacDraft=async()=>null;
 var net={online:true,error:()=>Object.assign(new Error('offline'),{offline:true}),gatewayDown:()=>false,isNetErr:()=>false,probe:async()=>true,up:()=>{},down:()=>{}};
 var store={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}},del:k=>{try{localStorage.removeItem(k)}catch{}}};
 var esc=t=>String(t??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 `+pendingCore+`
 window.core={pendingSends,inspectContinuityNativeDelivery,runSend,queueSend,settle:()=>sendChain,flushWaiting,restorePending,savePending,paintPending,reconcilePending,reconcileContinuityPending,captureComposerPending,isContinuityPending,retargetHerdrPending,dropPending};
 window.makePending=(over={})=>{const p={id:++pendSeq,key:state.ws+'/p',ws:state.ws,room:'p',text:'ข้อความทดสอบคงเดิม',files:[],pics:[],names:[],mode:'',at:Date.now(),state:'waiting',generation:'provider-generation',continuityToken:'provider-token',...over};pendingSends.push(p);return p;};
 var w=fixture.w,room=fixture.room,msg=document.getElementById('msg'),send=document.getElementById('send'),dkey=w.id+'/'+room.id,drawAtt=()=>{};
 `+composerCore+`
window.submitComposer=doSend;`});
}
async function coreRun(page:Page,over:any={}) {await page.evaluate(async over=>{const w:any=window;w.pending=w.makePending(over);await w.core.queueSend(w.pending);},over);}
async function heldPosts(page:Page){return (await posts(page)).filter((c:any)=>c.path.endsWith('/held'));}
async function nativePosts(page:Page){return (await posts(page)).filter((c:any)=>c.path.endsWith('/send'));}

test('actual queue entry captures v2 stored receipt before uploads/send, using continuity source not provider generation',async({page})=>{
 await setupCore(page);await coreRun(page);
 const p=await page.evaluate(()=>(window as any).pending);expect(p.state).toBe('continuity-held');expect(p.requestStarted).toBeUndefined();expect(p.generation).toBe('provider-generation');expect(p.continuityIntent.intendedGeneration).toBe('continuity-generation');
 const held=await heldPosts(page);expect(held).toHaveLength(1);expect(JSON.parse(held[0].opts.body)).toEqual({id:p.continuityIntent.id,text:p.text,intendedGeneration:'continuity-generation',expectedOperationId:'op',expectedRevision:7});
 const dispatch=await page.evaluate(()=>(window as any).holdRequests[0]);expect(JSON.parse(dispatch.persisted)[0].continuityIntent).toEqual(p.continuityIntent);
 expect(await nativePosts(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).uploads)).toEqual([]);
});
test('managed room without active operation parks locally even when switch capability is false',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{delete (window as any).states.p.room.operationId;});await coreRun(page);
 expect(await page.evaluate(()=>(window as any).pending.state)).toBe('continuity-local');expect(await posts(page)).toEqual([]);
});
test('unmanaged 404 and roomStateAvailable=false preserve legacy queue path',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{(window as any).capability.roomStateAvailable=false;});await coreRun(page);expect(await nativePosts(page)).toHaveLength(1);expect(await heldPosts(page)).toEqual([]);
 await page.evaluate(()=>{const w:any=window;w.capability.roomStateAvailable=true;w.current404=true;});await coreRun(page,{text:'legacy second'});expect(await nativePosts(page)).toHaveLength(2);expect(await heldPosts(page)).toEqual([]);
});
test('current error or unknown capability availability fails closed without provider fallback',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{(window as any).currentFailure=true;});await coreRun(page);expect(await posts(page)).toEqual([]);
 await page.evaluate(()=>{const w:any=window;w.currentFailure=false;delete w.capability.roomStateAvailable;});await coreRun(page,{text:'another draft'});expect(await posts(page)).toEqual([]);
});
for(const mode of ['full','unavailable','readback'])test(`storage ${mode} prevents POST and preserves composer text`,async({page})=>{
 await setupCore(page);await page.evaluate(async mode=>{const w:any=window;w.storageMode=mode;(document.getElementById('msg') as HTMLTextAreaElement).value='ต้นฉบับต้องอยู่';await w.submitComposer();},mode);
 expect(await posts(page)).toEqual([]);await expect(page.locator('#msg')).toHaveValue('ต้นฉบับต้องอยู่');await expect(page.locator('.pend')).toContainText('บันทึก');
});
test('lost hold ACK cannot autoflush/re-ID, explicit retry submits the exact stored request ID/body only',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{(window as any).failHeldBeforeStore=true;});await coreRun(page);
 const first=(await heldPosts(page))[0];await page.evaluate(async()=>{const w:any=window;w.core.flushWaiting();await w.core.runSend(w.pending);w.mawExt.onPoll[0](w.fixture);});expect(await heldPosts(page)).toHaveLength(1);
 await page.evaluate(async()=>{const w:any=window;w.failHeldBeforeStore=false;await w.core.reconcileContinuityPending(w.pending);});
 const held=await heldPosts(page);expect(held).toHaveLength(2);expect(held[1].opts.body).toBe(first.opts.body);expect(await page.evaluate(()=>(window as any).pending.state)).toBe('continuity-held');expect(await nativePosts(page)).toEqual([]);
});
test('lost ACK after store commit reconciles by exact receipt read without another POST',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{(window as any).failHeldAfterStore=true;});await coreRun(page);
 await page.evaluate(async()=>{const w:any=window;await w.core.reconcileContinuityPending(w.pending);});expect(await heldPosts(page)).toHaveLength(1);expect(await page.evaluate(()=>(window as any).pending.state)).toBe('continuity-held');
});
test('generation change with same native UUID before hold POST blocks without retargeting',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{(window as any).replaceOnRead=2;});await coreRun(page);
 expect(await posts(page)).toEqual([]);const p=await page.evaluate(()=>(window as any).pending);expect(p.continuityIntent.intendedGeneration).toBe('continuity-generation');expect(p.state).toBe('continuity-local');
});
test('changed generation on explicit reconciliation never replaces ID or chooses the new target',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{(window as any).failHeldBeforeStore=true;});await coreRun(page);const body=(await heldPosts(page))[0].opts.body;
 await page.evaluate(async()=>{const w:any=window;w.states.p.room.bindings.codex.generation='replacement';w.failHeldBeforeStore=false;await w.core.reconcileContinuityPending(w.pending);});expect(await heldPosts(page)).toHaveLength(1);expect(JSON.stringify(await page.evaluate(()=>(window as any).pending.continuityIntent))).toContain(JSON.parse(body).id);expect(await nativePosts(page)).toEqual([]);
});
test('room change while held state GET is inflight stops old-room POST',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{const w:any=window;w.hold('capture', '/rooms/w/p/continuity');w.pending=w.makePending();void w.core.runSend(w.pending);});await waitDeferred(page,'capture');await changeRoom(page);
 await page.evaluate(()=>{const w:any=window;w.release('capture',w.states.p);});await expect.poll(()=>page.evaluate(()=>(window as any).pending.busy)).toBe(false);expect(await posts(page)).toEqual([]);
});
test('files and voice recordings remain local before upload and are never silently reduced to text',async({page})=>{
 await setupCore(page);await page.evaluate(async()=>{const w:any=window;for(const type of ['image/png','audio/webm']){const f=new File(['bytes'],'fixture-file',{type});const p=w.makePending({files:[f],names:[f.name]});await w.core.queueSend(p);}});
 expect(await posts(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).uploads)).toEqual([]);expect(await page.evaluate(()=>(window as any).core.pendingSends.every((p:any)=>p.files.length===1&&p.state==='continuity-local'))).toBe(true);
});
test('previous provider attempt/uncertain is not recaptured as a fresh held request',async({page})=>{
 await setupCore(page);await coreRun(page,{requestStarted:true,uid:'old-delivery',state:'uncertain'});expect(await posts(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).pending.continuityIntent)).toBeUndefined();
});
test('new draft typed while hold ACK waits is preserved and does not get sent',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{const w:any=window;w.hold('ack', '/rooms/w/p/continuity/held','POST');(document.getElementById('msg') as HTMLTextAreaElement).value='old draft';void w.submitComposer();});await waitDeferred(page,'ack');
 await page.locator('#msg').fill('new draft');await page.evaluate(()=>{const w:any=window;const p=w.core.pendingSends[0],i=p.continuityIntent;w.release('ack',{ok:true,message:{id:i.id,text:i.text,intendedGeneration:i.intendedGeneration,version:2,originOperationId:i.expectedOperationId,originRevision:i.expectedRevision,intendedBinding:p.continuityBinding}});});
 await expect.poll(()=>page.evaluate(()=>(window as any).core.pendingSends[0].state)).toBe('continuity-held');await expect(page.locator('#msg')).toHaveValue('new draft');expect(await nativePosts(page)).toEqual([]);
});
test('stored-only bubble never expires, matches away, drops, or exposes legacy retarget controls',async({page})=>{
 await setupCore(page);await coreRun(page);await page.evaluate(()=>{const w:any=window;w.pending.sentAt=1;w.core.reconcilePending([{role:'user',text:w.pending.text,i:999}]);w.core.dropPending(w.pending);w.core.paintPending();});
 expect(await page.evaluate(()=>(window as any).core.pendingSends.length)).toBe(1);await expect(page.locator('.pend')).toContainText('ยังไม่ส่งถึง agent');await expect(page.locator('.pend [data-a]')).toHaveCount(0);
});
test('reload preserves immutable hold intent and never auto-replays uncertain requests',async({page,context})=>{
 await setupCore(page);await page.evaluate(()=>{(window as any).failHeldBeforeStore=true;});await coreRun(page);const saved=await page.evaluate(()=>(window as any).memoryStorage['maw-pend']);
 const restored=await context.newPage();await setupCore(restored,saved);await restored.evaluate(async()=>{const w:any=window;await w.core.restorePending();w.core.flushWaiting();await w.core.queueSend(w.core.pendingSends[0]);});
 expect(await posts(restored)).toEqual([]);expect(await restored.evaluate(()=>(window as any).core.pendingSends[0].continuityIntent)).toEqual(JSON.parse(saved)[0].continuityIntent);await restored.close();
});
test('reload with missing cached attachment keeps intent/count and blocks text-only fallback',async({page,context})=>{
 await setupCore(page);await page.evaluate(async()=>{const w:any=window;const f=new File(['voice'],'voice.webm',{type:'audio/webm'});w.pending=w.makePending({files:[f],names:['voice.webm']});await w.core.runSend(w.pending);});const saved=await page.evaluate(()=>(window as any).memoryStorage['maw-pend']);
 const restored=await context.newPage();await setupCore(restored,saved);await restored.evaluate(async()=>{const w:any=window;await w.core.restorePending();w.core.flushWaiting();await w.core.runSend(w.core.pendingSends[0]);});
 expect(await posts(restored)).toEqual([]);const p=await restored.evaluate(()=>(window as any).core.pendingSends[0]);expect(p.continuityMissingFiles).toBe(true);expect(p.expectedFiles).toBe(1);expect(p.names).toEqual(['voice.webm']);await expect(restored.locator('.pend')).toContainText('ไฟล์แนบในอุปกรณ์ไม่ครบ');await restored.close();
});
test('forged held ACK is not displayed as stored/sent',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{(window as any).badHeldReceipt=true;});await coreRun(page);expect(await page.evaluate(()=>(window as any).pending.state)).toBe('continuity-uncertain');expect(await nativePosts(page)).toEqual([]);
});

test('actual provider boundary rechecks continuity after a legacy pre-upload decision',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{const w:any=window;w.capability.roomStateAvailable=false;w.mawExt.beforeSend.push(async({phase}:any)=>{if(phase==='before-upload')w.capability.roomStateAvailable=true;return {handled:false};});});await coreRun(page);
 expect(await heldPosts(page)).toHaveLength(1);expect(await nativePosts(page)).toEqual([]);const p=await page.evaluate(()=>(window as any).pending);expect(p.uid).toBeTruthy();expect(p.requestStarted).toBeUndefined();expect(p.state).toBe('continuity-held');
});
test('500 with room_not_found code is not treated as an unmanaged 404',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{const w:any=window;w.current404=true;w.currentErrorStatus=500;});await coreRun(page);expect(await posts(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).pending.state)).toBe('continuity-local');
});
test('managed composer is intercepted before legacy permission dialog while unmanaged keeps it',async({page})=>{
 await setupCore(page);await page.evaluate(async()=>{const w:any=window;w.dialogCalls=0;w.mawDialogAnswer=async()=>{w.dialogCalls++;return 'sent';};(document.getElementById('msg') as HTMLTextAreaElement).value='managed text';await w.submitComposer();});
 expect(await page.evaluate(()=>(window as any).dialogCalls)).toBe(0);expect(await heldPosts(page)).toHaveLength(1);await expect(page.locator('#msg')).toHaveValue('');
 await page.evaluate(async()=>{const w:any=window;w.capability.roomStateAvailable=false;(document.getElementById('msg') as HTMLTextAreaElement).value='legacy dialog answer';await w.submitComposer();});
 expect(await page.evaluate(()=>(window as any).dialogCalls)).toBe(1);expect(await nativePosts(page)).toEqual([]);await expect(page.locator('#msg')).toHaveValue('');
});
test('over-limit text keeps original draft without POSTing an invalid held body',async({page})=>{
 await setupCore(page);await page.evaluate(async()=>{const w:any=window;(document.getElementById('msg') as HTMLTextAreaElement).value='x'.repeat(8001);await w.submitComposer();});expect(await posts(page)).toEqual([]);expect(await page.locator('#msg').inputValue()).toHaveLength(8001);
});
test('restored previously attempted delivery cannot become a new held intent',async({page,context})=>{
 await setupCore(page);const saved=JSON.stringify([{id:1,key:'w/p',ws:'w',room:'p',text:'old delivery',state:'sending',uid:'old-request',requestStarted:true,at:Date.now(),n:0}]);
 const restored=await context.newPage();await setupCore(restored,saved);await restored.evaluate(async()=>{const w:any=window;await w.core.restorePending();await w.core.queueSend(w.core.pendingSends[0]);});
 expect(await posts(restored)).toEqual([]);expect(await restored.evaluate(()=>(window as any).core.pendingSends[0].continuityIntent)).toBeUndefined();await restored.close();
});

test('legacy Herdr retarget cannot clear a managed previous delivery attempt or create a fresh hold',async({page})=>{
 await setupCore(page,undefined,'herdr:wFixture');await coreRun(page,{requestStarted:true,uid:'old-delivery',state:'uncertain'});
 await page.evaluate(async()=>{const w:any=window;await w.core.retargetHerdrPending(w.pending);});
 const p=await page.evaluate(()=>(window as any).pending);expect(p.requestStarted).toBe(true);expect(p.uid).toBe('old-delivery');expect(p.continuityIntent).toBeUndefined();expect(p.continuityScope).toBe(true);expect(await posts(page)).toEqual([]);await expect(page.locator('.sheet-bg')).toHaveCount(0);
});
test('core capture ignores a same-ID room revisit response from a previous view',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{const w:any=window;w.hold('visit', '/rooms/w/p/continuity');w.pending=w.makePending();void w.core.runSend(w.pending);});await waitDeferred(page,'visit');await changeRoom(page);await changeRoom(page,'p');
 await page.evaluate(()=>{const w:any=window;w.release('visit',w.states.p);});await expect.poll(()=>page.evaluate(()=>(window as any).pending.busy)).toBe(false);expect(await posts(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).pending.continuityIntent)).toBeUndefined();
});

test('reload with missing attachment preserves prior uncertain intent/state instead of reclassifying it unsent',async({page,context})=>{
 await setupCore(page);await page.evaluate(()=>{(window as any).failHeldBeforeStore=true;});await coreRun(page);
 const saved=await page.evaluate(()=>{const row=JSON.parse((window as any).memoryStorage['maw-pend'])[0];row.n=1;row.names=['missing.webm'];return JSON.stringify([row]);});
 const next=await context.newPage();await setupCore(next,saved);await next.evaluate(async()=>{const w:any=window;await w.core.restorePending();const p=w.core.pendingSends[0];await w.core.reconcileContinuityPending(p);await w.core.queueSend(p);w.core.flushWaiting();});
 const p=await next.evaluate(()=>(window as any).core.pendingSends[0]);expect(p.state).toBe('continuity-uncertain');expect(p.continuityMissingFiles).toBe(true);expect(p.continuityIntent).toEqual(JSON.parse(saved)[0].continuityIntent);expect(await posts(next)).toEqual([]);await next.close();
});


// P1 regression: invoke the shipped doSend closure and defer each real async decision boundary.
for(const stage of ['unmanaged','permission-sent','permission-false','mac-draft']) {
 for(const change of ['text','files','room']) {
  test(`actual doSend ${stage} await preserves changed ${change} and never queues the old draft`,async({page})=>{
   await setupCore(page);
   await page.evaluate(stage=>{
    const w:any=window;w.capability.roomStateAvailable=false;
    (document.getElementById('msg') as HTMLTextAreaElement).value='original draft';
    if(stage==='unmanaged')w.mawExt.beforeSend.push(({phase}:any)=>phase==='capture'?new Promise(resolve=>{w.draftResume=resolve;}):{handled:false});
    else if(stage.startsWith('permission'))w.mawDialogAnswer=()=>new Promise(resolve=>{w.draftResume=resolve;});
    else {w.state.macDraft='old computer draft';w.askMacDraft=()=>new Promise(resolve=>{w.draftResume=resolve;});}
    w.submission=w.submitComposer();
   },stage);
   await expect.poll(()=>page.evaluate(()=>typeof (window as any).draftResume)).toBe('function');
   await page.evaluate(change=>{
    const w:any=window;
    if(change==='text')(document.getElementById('msg') as HTMLTextAreaElement).value='new draft must stay';
    if(change==='files')w.state.files=[new File(['new'],'new-file.txt',{type:'text/plain'})];
    if(change==='room'){
     w.state.room='q';w.state.filesRoom='w/q';w.state.files=[new File(['new room'],'room-file.txt')];
     document.getElementById('msg')!.outerHTML='<textarea id="msg">new room draft</textarea>';
     document.getElementById('send')!.outerHTML='<button id="send" disabled>new room button</button>';
    }
    w.state.macDraft='new computer draft';w.state.pulled='new pulled';w.state.pulledFiles=[new File(['pulled'],'new-pulled.txt')];
    w.expectedDraft=(document.getElementById('msg') as HTMLTextAreaElement).value;w.expectedFiles=[...w.state.files];
   },change);
   await page.evaluate(async stage=>{const w:any=window;w.draftResume(stage==='unmanaged'?{handled:false}:stage==='permission-sent'?'sent':stage==='permission-false'?false:'merge');await w.submission;await w.core.settle();},stage);
   const result=await page.evaluate(()=>{const w:any=window;return {text:(document.getElementById('msg') as HTMLTextAreaElement).value,expected:w.expectedDraft,sameFiles:w.state.files.length===w.expectedFiles.length&&w.state.files.every((f:File,i:number)=>f===w.expectedFiles[i]),macDraft:w.state.macDraft,pulled:w.state.pulled,pulledFiles:w.state.pulledFiles.map((f:File)=>f.name),pending:w.core.pendingSends.length,newButtonDisabled:(document.getElementById('send') as HTMLButtonElement).disabled};});
   expect(result.text).toBe(result.expected);expect(result.sameFiles).toBe(true);expect(result.macDraft).toBe('new computer draft');expect(result.pulled).toBe('new pulled');expect(result.pulledFiles).toEqual(['new-pulled.txt']);expect(result.pending).toBe(0);
   if(change==='room')expect(result.newButtonDisabled).toBe(true);
   expect(await posts(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).uploads)).toEqual([]);
  });
 }
}
test('deferred unmanaged verdict compares raw draft, not only trimmed text',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{const w:any=window;w.capability.roomStateAvailable=false;w.mawExt.beforeSend.push(({phase}:any)=>phase==='capture'?new Promise(resolve=>{w.draftResume=resolve;}):{handled:false});(document.getElementById('msg') as HTMLTextAreaElement).value='same';w.submission=w.submitComposer();});
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).draftResume)).toBe('function');await page.locator('#msg').fill('same ');
 await page.evaluate(async()=>{const w:any=window;w.draftResume({handled:false});await w.submission;await w.core.settle();});await expect(page.locator('#msg')).toHaveValue('same ');expect(await posts(page)).toEqual([]);
});
test('deferred unmanaged verdict compares File identity even for an unchanged name/count',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{const w:any=window;w.capability.roomStateAvailable=false;w.state.files=[new File(['old'],'same-name.txt')];w.mawExt.beforeSend.push(({phase}:any)=>phase==='capture'?new Promise(resolve=>{w.draftResume=resolve;}):{handled:false});(document.getElementById('msg') as HTMLTextAreaElement).value='same draft';w.submission=w.submitComposer();});
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).draftResume)).toBe('function');await page.evaluate(async()=>{const w:any=window;w.replacement=new File(['replacement'],'same-name.txt');w.state.files=[w.replacement];w.draftResume({handled:false});await w.submission;await w.core.settle();});
 expect(await page.evaluate(()=>(window as any).state.files[0]===(window as any).replacement)).toBe(true);await expect(page.locator('#msg')).toHaveValue('same draft');expect(await posts(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).uploads)).toEqual([]);
});
test('managed held ACK cannot clear a changed raw draft with the same trimmed text',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{const w:any=window;w.hold('raw-ack','/rooms/w/p/continuity/held','POST');(document.getElementById('msg') as HTMLTextAreaElement).value='same';w.submission=w.submitComposer();});await waitDeferred(page,'raw-ack');await page.locator('#msg').fill('same ');
 await page.evaluate(async()=>{const w:any=window;const p=w.core.pendingSends[0],i=p.continuityIntent;w.release('raw-ack',{ok:true,message:{id:i.id,text:i.text,intendedGeneration:i.intendedGeneration,version:2,originOperationId:i.expectedOperationId,originRevision:i.expectedRevision,intendedBinding:p.continuityBinding}});await w.submission;});
 await expect(page.locator('#msg')).toHaveValue('same ');expect(await nativePosts(page)).toEqual([]);
});


async function setupInspection(page:Page,ws='herdr:wFixture',over:any={}) {
 await setupCore(page,undefined,ws);
 await page.evaluate(()=>{
  const w:any=window;w.inspectionGets=[];w.deliveryStatus={ok:true,id:'prior-native-request',generation:'provider-generation',state:'acknowledged'};
  const previous=w.apiRaw;
  w.apiRaw=async(path:string,opts:any)=>{
   if(path.includes('/delivery/')){
    w.calls.push({path,opts});w.inspectionGets.push({path,opts});
    if(w.inspectionDefer)return new Promise((resolve,reject)=>{w.inspectionResolve=resolve;w.inspectionReject=reject;});
    if(w.inspectionError){const e:any=new Error('lookup failed');e.status=w.inspectionError;e.body={code:w.inspectionError===409?'agent_changed':'lookup_failed'};throw e;}
    return structuredClone(w.deliveryStatus);
   }
   return previous(path,opts);
  };
 });
 await coreRun(page,{requestStarted:true,uid:'prior-native-request',state:'waiting',...over});
 await page.evaluate(()=>{
  const w:any=window,p=w.pending;w.beforeInspection={state:p.state,uid:p.uid,ws:p.ws,room:p.room,generation:p.generation,requestStarted:p.requestStarted,text:p.text,intent:p.continuityIntent??null,origin:p.continuityNativeAttempt};
  const msg=document.getElementById('msg') as HTMLTextAreaElement;msg.value='draft must remain';w.draftFile=new File(['new draft'],'draft-file.txt');w.state.files=[w.draftFile];
 });
}
async function assertInspectionPreserved(page:Page){
 const result=await page.evaluate(()=>{const w:any=window,p=w.pending;return {before:w.beforeInspection,after:{state:p.state,uid:p.uid,ws:p.ws,room:p.room,generation:p.generation,requestStarted:p.requestStarted,text:p.text,intent:p.continuityIntent??null,origin:p.continuityNativeAttempt},count:w.core.pendingSends.length,sameFile:w.state.files[0]===w.draftFile};});
 expect(result.after).toEqual(result.before);expect(result.count).toBe(1);expect(result.sameFile).toBe(true);await expect(page.locator('#msg')).toHaveValue('draft must remain');expect(await posts(page)).toEqual([]);
}
const inspectionButton=(page:Page)=>page.locator('[data-a="continuity-delivery-status"]');

test('parked native-attempt inspection is GET-only with original uid/provider generation and does not mark sent/drop/change draft',async({page})=>{
 await setupInspection(page);await inspectionButton(page).click();
 await expect(page.locator('.delivery-inspection-note')).toContainText('ledger มี ACK');await expect(page.locator('.delivery-inspection-note')).toContainText('ยังเก็บรายการพักไว้');
 const gets=await page.evaluate(()=>(window as any).inspectionGets);expect(gets).toEqual([{path:'/rooms/herdr%3AwFixture/p/delivery/prior-native-request',opts:{cache:'no-store'}}]);
 await page.evaluate(async()=>{const w:any=window;w.core.reconcilePending([{role:'user',text:w.pending.text,i:42}]);w.core.dropPending(w.pending);w.core.flushWaiting();await w.core.queueSend(w.pending);});
 await assertInspectionPreserved(page);await expect(page.locator('.pend [data-a]')).toHaveCount(1);await expect(page.locator('[data-a="retarget"],[data-a="resolve"],[data-a="drop"],[data-a="retry"]')).toHaveCount(0);
});
test('inspection does not change an existing immutable held intent even on ACK',async({page})=>{
 await setupInspection(page);await page.evaluate(()=>{const w:any=window;w.pending.continuityIntent=Object.freeze({id:'immutable-held-marker',text:'not a new capture'});w.beforeInspection.intent={...w.pending.continuityIntent};});await inspectionButton(page).click();await expect(page.locator('.delivery-inspection-note')).toContainText('ledger มี ACK');await assertInspectionPreserved(page);
});
test('lookup ACK for a changed generation is never accepted or retried against latest target',async({page})=>{
 await setupInspection(page);await page.evaluate(()=>{(window as any).deliveryStatus.generation='replacement-generation';});await inspectionButton(page).click();
 await expect(page.locator('.delivery-inspection-note')).toContainText('ไม่ตรง generation เดิม');await expect(page.locator('.delivery-inspection-note')).not.toContainText('ledger มี ACK');expect(await page.evaluate(()=>(window as any).inspectionGets.length)).toBe(1);await assertInspectionPreserved(page);
});
test('known changed current provider generation explains old-generation lookup limitation without a fallback GET',async({page})=>{
 await setupInspection(page);await page.evaluate(()=>{const w:any=window;w.state.projects=[{workspaces:[{id:w.pending.ws,rooms:[{id:w.pending.room,generation:'new-provider-generation'}]}]}];});await inspectionButton(page).click();
 await expect(page.locator('.delivery-inspection-note')).toContainText('generation เปลี่ยนแล้ว');expect(await page.evaluate(()=>(window as any).inspectionGets.length)).toBe(0);await assertInspectionPreserved(page);
});
test('room navigation while status is inflight ignores the late result and preserves new room draft/files',async({page})=>{
 await setupInspection(page);await page.evaluate(()=>{(window as any).inspectionDefer=true;});await inspectionButton(page).click();await expect.poll(()=>page.evaluate(()=>typeof (window as any).inspectionResolve)).toBe('function');
 await page.evaluate(()=>{const w:any=window;w.state.room='another-pane';w.state.filesRoom='another-scope';document.getElementById('screen')!.outerHTML='<div id="screen">new room screen</div>';document.getElementById('msg')!.outerHTML='<textarea id="msg">new room draft</textarea>';w.newRoomFile=new File(['new room'],'room.txt');w.state.files=[w.newRoomFile];w.inspectionResolve(w.deliveryStatus);});
 await expect(page.locator('#screen')).toHaveText('new room screen');await expect(page.locator('#msg')).toHaveValue('new room draft');expect(await page.evaluate(()=>(window as any).state.files[0]===(window as any).newRoomFile)).toBe(true);expect(await page.evaluate(()=>(window as any).pending.continuityInspection)).toBeUndefined();expect(await posts(page)).toEqual([]);
});
test('lost status response stays unavailable with no auto-retry; manual check uses the identical original GET',async({page})=>{
 await setupInspection(page);await page.evaluate(()=>{(window as any).inspectionError=503;});await inspectionButton(page).click();await expect(page.locator('.delivery-inspection-note')).toContainText('อ่านสถานะ delivery เดิมไม่ได้');
 await page.evaluate(()=>{const w:any=window;w.core.flushWaiting();w.core.paintPending();});expect(await page.evaluate(()=>(window as any).inspectionGets.length)).toBe(1);await assertInspectionPreserved(page);
 await page.evaluate(()=>{(window as any).inspectionError=0;});await inspectionButton(page).click();await expect(page.locator('.delivery-inspection-note')).toContainText('ledger มี ACK');
 const gets=await page.evaluate(()=>(window as any).inspectionGets);expect(gets).toHaveLength(2);expect(gets[1]).toEqual(gets[0]);await assertInspectionPreserved(page);
});
for(const status of [404,409])test(`status lookup HTTP ${status} shows limitation without resolving or resending`,async({page})=>{
 await setupInspection(page);await page.evaluate(status=>{(window as any).inspectionError=status;},status);await inspectionButton(page).click();
 await expect(page.locator('.delivery-inspection-note')).toContainText(status===404?'API ตรวจ delivery เดิมไม่พร้อม':'agent เดิมเปลี่ยนแล้ว');await assertInspectionPreserved(page);
});
for(const ws of ['tmux-workspace','superset-workspace'])test(`no lookup backend ${ws} displays a limitation without guessing delivery`,async({page})=>{
 await setupInspection(page,ws);await expect(inspectionButton(page)).toHaveCount(0);await expect(page.locator('.delivery-inspection-note')).toContainText('ยังไม่มี API ตรวจ delivery เดิม');
 expect(await page.evaluate(()=>(window as any).inspectionGets.length)).toBe(0);await assertInspectionPreserved(page);
});
for(const result of [
 {ok:true,id:'wrong-request',generation:'provider-generation',state:'acknowledged'},
 {ok:true,id:'prior-native-request',state:'acknowledged'},
 {ok:true,id:'prior-native-request',state:'unknown'},
 {ok:true,id:'prior-native-request',generation:'provider-generation',state:'toString'}
])test(`unverified status cannot promote parked delivery: ${JSON.stringify(result)}`,async({page})=>{
 await setupInspection(page);await page.evaluate(result=>{(window as any).deliveryStatus=result;},result);await inspectionButton(page).click();await expect(page.locator('.delivery-inspection-note')).not.toContainText('ledger มี ACK');await assertInspectionPreserved(page);
});
test('missing original uid/generation is not filled from current continuity state',async({page})=>{
 await setupInspection(page,'herdr:wFixture',{uid:undefined,generation:undefined});await expect(inspectionButton(page)).toHaveCount(0);await expect(page.locator('.delivery-inspection-note')).toContainText('ข้อมูล uid/room/generation เดิมไม่ครบ');expect(await page.evaluate(()=>(window as any).inspectionGets.length)).toBe(0);await assertInspectionPreserved(page);
});

test('current provider generation changing during status GET prevents displaying the old ACK as verified',async({page})=>{
 await setupInspection(page);await page.evaluate(()=>{(window as any).inspectionDefer=true;});await inspectionButton(page).click();await expect.poll(()=>page.evaluate(()=>typeof (window as any).inspectionResolve)).toBe('function');
 await page.evaluate(()=>{const w:any=window;w.state.projects=[{workspaces:[{id:w.pending.ws,rooms:[{id:w.pending.room,generation:'changed-during-read'}]}]}];w.inspectionResolve(w.deliveryStatus);});
 await expect(page.locator('.delivery-inspection-note')).toContainText('generation เปลี่ยนระหว่างอ่านสถานะ');await expect(page.locator('.delivery-inspection-note')).not.toContainText('ledger มี ACK');await assertInspectionPreserved(page);
});
test('an inflight lookup cannot write its result onto a mutated pending target or follow that target',async({page})=>{
 await setupInspection(page);await page.evaluate(()=>{(window as any).inspectionDefer=true;});await inspectionButton(page).click();await expect.poll(()=>page.evaluate(()=>typeof (window as any).inspectionResolve)).toBe('function');
 await page.evaluate(()=>{const w:any=window;w.pending.uid='different-request';w.inspectionResolve(w.deliveryStatus);});
 await expect(page.locator('.delivery-inspection-note')).toContainText('ข้อมูลคำขอเดิมเปลี่ยน');expect(await page.evaluate(()=>(window as any).pending.continuityInspection)).toBeUndefined();expect(await page.evaluate(()=>(window as any).inspectionGets.length)).toBe(1);expect(await posts(page)).toEqual([]);await expect(page.locator('#msg')).toHaveValue('draft must remain');
});
test('reloading diagnostic status preserves original attempt and never automatically checks or resends',async({page,context})=>{
 await setupInspection(page);await inspectionButton(page).click();await expect(page.locator('.delivery-inspection-note')).toContainText('ledger มี ACK');const saved=await page.evaluate(()=>(window as any).memoryStorage['maw-pend']);
 const restored=await context.newPage();await setupCore(restored,saved,'herdr:wFixture');await restored.evaluate(async()=>{const w:any=window;await w.core.restorePending();w.core.flushWaiting();await w.core.queueSend(w.core.pendingSends[0]);});
 const p=await restored.evaluate(()=>(window as any).core.pendingSends[0]);expect(p.state).toBe('continuity-uncertain');expect(p.continuityNativeAttempt).toEqual(JSON.parse(saved)[0].continuityNativeAttempt);await expect(restored.locator('.delivery-inspection-note')).toContainText('ผลตรวจครั้งล่าสุด');expect(await restored.evaluate(()=>(window as any).calls.some((c:any)=>c.path.includes('/delivery/')))).toBe(false);expect(await posts(restored)).toEqual([]);await restored.close();
});

// Protocol switch panel: real extension and current API DTOs; no native launch or server.
const confirmSwitch=(page:Page)=>page.locator('[data-continuity-confirm]');
const selectionPosts=async(page:Page)=>(await posts(page)).filter((c:any)=>c.path.endsWith('/facts/selections'));
const switchPosts=async(page:Page)=>(await posts(page)).filter((c:any)=>c.path.endsWith('/switch'));
async function currentIntent(page:Page){return page.evaluate(()=>{const w:any=window;const key=Object.keys(w.memoryStorage).find(k=>k.startsWith('maw-continuity-switch-v1:'));return key?JSON.parse(w.memoryStorage[key]):null;});}

test('header button is visible but uncertified backend stays disabled without fake readiness',async({page})=>{
 await setup(page,false);await expect(page.locator('header [data-continuity-switch]')).toHaveText('เปลี่ยน agent / โมเดล');await expect(page.locator('[data-continuity-switch]')).toBeDisabled();await expect(page.locator('.sheet')).toHaveCount(0);expect(await posts(page)).toEqual([]);
});
test('explicit room-backend scope honors only the authoritative room backend; omitted scope stays all-three',async({page})=>{
 await setup(page);await page.evaluate(()=>{const w:any=window;w.capability.scope='room-backend';w.capability.backends.forEach((b:any)=>b.ready=b.backend==='herdr');});await poll(page);await expect(page.locator('[data-continuity-switch]')).toBeEnabled();await open(page,false);await expect(page.locator('.sheet')).toBeVisible();
 await page.evaluate(()=>{(window as any).states.p.room.backend='tmux';});await poll(page);await expect(page.locator('.sheet')).toHaveCount(0);await expect(page.locator('[data-continuity-switch]')).toBeDisabled();expect(await posts(page)).toEqual([]);
});
test('API model/provider values control the picker including a same-agent model choice',async({page})=>{
 await setup(page);await page.evaluate(()=>{(window as any).capability.models.push({agent:'codex',id:'fixture-code-next',label:'Code next from API'});});await open(page);await expect(page.locator('[data-continuity-provider] option')).toHaveText(['claude','codex']);await page.locator('[data-continuity-provider]').selectOption('codex');await expect(page.locator('[data-continuity-model] option')).toHaveText('Code next from API');await confirmSwitch(page).click();await expect.poll(async()=>(await switchPosts(page)).length).toBe(1);const body=JSON.parse((await switchPosts(page))[0].opts.body);expect(body.target).toBe('codex');expect(body.model).toBe('fixture-code-next');expect(body).not.toHaveProperty('provider');
});
test('preview displays exact API reference text and provenance safely with zero auto-selected facts',async({page})=>{
 await setup(page);await open(page,false);await expect(confirmSwitch(page)).toBeDisabled();await page.locator('[data-continuity-preview]').click();await expect(page.locator('.continuity-preview')).toContainText('บริบทจริงจาก API fixture');await expect(page.locator('.continuity-preview script')).toHaveCount(0);await expect(page.locator('.continuity-facts')).toContainText('goal-source');await expect(page.locator('.continuity-facts input:checked')).toHaveCount(0);await expect(confirmSwitch(page)).toBeDisabled();expect(await posts(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).pwned)).toBeUndefined();
});
test('explicit fact selections are scoped DTOs and use the switch operation ID, not arbitrary values/actor/path',async({page})=>{
 await setup(page);await open(page);await page.locator('.continuity-facts input[type=checkbox]').check();await confirmSwitch(page).click();await expect.poll(async()=>(await switchPosts(page)).length).toBe(1);const all=await posts(page),selection=JSON.parse(all[0].opts.body),sw=JSON.parse(all[1].opts.body);expect(all.map((x:any)=>x.path)).toEqual([path+'/facts/selections',path+'/switch',path+'/operations/'+sw.id+'/advance']);expect(selection.id).toBe(sw.id);expect(sw.factsSelectionId).toBe(sw.id);expect(selection.selections).toHaveLength(2);expect(Object.keys(selection).sort()).toEqual(['expectedRevision','id','previewId','selections']);for(const pick of selection.selections)expect(Object.keys(pick).sort()).toEqual(['agent','eventHash','field','nativeId','seq','sourceId']);const intent=await currentIntent(page);expect(intent.request.selectionBody).toEqual(selection);expect(intent.request.switchBody).toEqual(sw);expect(intent.selectionReceipt.factsHash).toBe('e'.repeat(64));
});
for(const issue of ['missing-service','503','no-goal','bad-provenance','wrong-room'])test('preview '+issue+' stops before any selection or switch POST',async({page})=>{
 await setup(page);await page.evaluate(issue=>{const w:any=window;if(issue==='missing-service')w.capability.factsSelectionAvailable=false;else if(issue==='503')w.previewFailure=true;else if(issue==='no-goal')w.previewOverrides={p:{candidates:[]}};else if(issue==='wrong-room')w.previewOverrides={p:{roomId:'foreign'}};else w.previewOverrides={p:{candidates:[{field:'goal',seq:1,sourceId:'s',agent:'codex',nativeId:'n',eventHash:'wrong',value:'goal'}]}};},issue);await open(page,false);if(issue==='missing-service')await expect(page.locator('[data-continuity-preview]')).toBeDisabled();else await page.locator('[data-continuity-preview]').click();await expect(confirmSwitch(page)).toBeDisabled();expect(await posts(page)).toEqual([]);
});
test('preview and choices are invalidated by history hash changes even when room revision did not move',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).previewOverrides={p:{archiveHash:'f'.repeat(64)}};});await confirmSwitch(page).click();await expect.poll(()=>page.evaluate(()=>(window as any).toasts.at(-1))).toContain('เปลี่ยนแล้ว');expect(await posts(page)).toEqual([]);
});
for(const mode of ['full','unavailable','readback'])test('durable intent '+mode+' failure prevents all mutation POSTs',async({page})=>{
 await setup(page);await open(page);await page.evaluate(mode=>{(window as any).storageMode=mode;},mode);await confirmSwitch(page).click();await expect(page.locator('.continuity-client-status')).toContainText('บันทึกคำขอในอุปกรณ์ไม่สำเร็จ');expect(await posts(page)).toEqual([]);
});
test('lost selection ACK stays uncertain and cannot fall through to switch or mint another ID',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).selectionLostACK=true;});await confirmSwitch(page).click();await expect(page.locator('.continuity-client-status')).toContainText('ยังยืนยันการบันทึก facts ไม่ได้');expect(await selectionPosts(page)).toHaveLength(1);expect(await switchPosts(page)).toHaveLength(0);const intent=await currentIntent(page);await page.evaluate(()=>{const w:any=window;return w.mawExt.keys[0].onClick(w.fixture);});await expect(page.locator('.sheet')).toHaveCount(0);expect((await currentIntent(page)).request).toEqual(intent.request);expect(await selectionPosts(page)).toHaveLength(1);
});
test('wrong facts receipt fails closed without creating a switch request',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).selectionReceiptOverride={previewId:'wrong-preview'};});await confirmSwitch(page).click();await expect(page.locator('.continuity-client-status')).toContainText('receipt facts ไม่ตรง');expect(await selectionPosts(page)).toHaveLength(1);expect(await switchPosts(page)).toHaveLength(0);
});
test('room navigation while preview is inflight ignores old reference/facts and cannot POST',async({page})=>{
 await setup(page);await open(page,false);await page.evaluate(path=>{(window as any).hold('preview',path+'/facts/preview');},path);await page.locator('[data-continuity-preview]').click();await waitDeferred(page,'preview');await changeRoom(page);await page.evaluate(()=>{const w:any=window;w.release('preview',{ok:true,preview:w.previewFor('p')});});await expect(page.locator('.sheet')).toHaveCount(0);await expect(page.locator('.continuity-status')).toContainText('Agent: claude');expect(await posts(page)).toEqual([]);
});
test('physical generation change during selected-facts POST prevents switch and leaves the original intent scoped',async({page})=>{
 await setup(page);await page.evaluate(()=>{const w:any=window;w.fixture.room.generation='physical-original';w.state.projects=[{workspaces:[{id:'w',rooms:[w.fixture.room]}]}];w.mawExt.onRoom[0](w.fixture);});await open(page);await page.evaluate(path=>{(window as any).hold('facts',path+'/facts/selections','POST');},path);await confirmSwitch(page).click();await waitDeferred(page,'facts');const selected=JSON.parse((await selectionPosts(page))[0].opts.body);await page.evaluate(b=>{const w:any=window;w.fixture.room.generation='physical-replacement';w.mawExt.onRoom[0](w.fixture);w.release('facts',{ok:true,selection:{id:b.id,previewId:b.previewId,roomRevision:b.expectedRevision,factsHash:'e'.repeat(64)}});},selected);await expect(page.locator('.sheet')).toHaveCount(0);expect(await switchPosts(page)).toHaveLength(0);expect((await currentIntent(page)).request.physical).toContain('physical-original');
});
test('duplicate confirm clicks during facts save create exactly one immutable intent',async({page})=>{
 await setup(page);await open(page);await page.evaluate(path=>{const w:any=window;w.hold('facts-once',path+'/facts/selections','POST');const b=document.querySelector('[data-continuity-confirm]') as HTMLButtonElement;b.click();b.click();},path);await waitDeferred(page,'facts-once');expect(await selectionPosts(page)).toHaveLength(1);const body=JSON.parse((await selectionPosts(page))[0].opts.body);await page.evaluate(b=>{(window as any).release('facts-once',{ok:true,selection:{id:b.id,previewId:b.previewId,roomRevision:b.expectedRevision,factsHash:'e'.repeat(64)}});},body);await expect.poll(async()=>(await switchPosts(page)).length).toBe(1);expect(JSON.parse((await switchPosts(page))[0].opts.body).id).toBe(body.id);
});
test('lost switch ACK is checked by exact scoped historical GET with no resend/advance or fake current readiness',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).switchLostACK=true;});await confirmSwitch(page).click();await expect(page.locator('.continuity-client-status')).toContainText('ยังยืนยันคำขอเดิมไม่ได้');const intent=await currentIntent(page),before=(await posts(page)).length;await page.evaluate(()=>{(window as any).capability.ready=false;});await poll(page);await expect(page.locator('[data-continuity-switch]')).toBeDisabled();await page.getByRole('button',{name:'ตรวจสถานะคำขอเดิม · อ่านอย่างเดียว',exact:true}).click();await expect(page.locator('.continuity-client-status')).toContainText('ข้อมูลย้อนหลัง ไม่ยืนยันว่า agent ปัจจุบันพร้อม');expect(await posts(page)).toHaveLength(before);expect(await page.evaluate(id=>(window as any).calls.some((c:any)=>c.path.endsWith('/operations/'+id)&&!c.opts.method),intent.request.switchBody.id)).toBe(true);expect((await currentIntent(page)).request).toEqual(intent.request);
});
for(const failure of [404,503])test('lost switch status '+failure+' retains unknown outcome and original ID without POST',async({page})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).switchLostACK=true;});await confirmSwitch(page).click();await expect(page.locator('.continuity-client-status')).toContainText('ยังยืนยัน');const intent=await currentIntent(page),before=(await posts(page)).length;await page.evaluate(failure=>{(window as any).statusFailure=failure;},failure);await page.getByRole('button',{name:'ตรวจสถานะคำขอเดิม · อ่านอย่างเดียว',exact:true}).click();await expect(page.locator('.continuity-client-status')).toContainText('ไม่ส่งซ้ำ');expect(await posts(page)).toHaveLength(before);expect((await currentIntent(page)).request).toEqual(intent.request);
});
test('restoring a lost-ACK switch intent performs reads only and does not create a new request',async({page,context})=>{
 await setup(page);await open(page);await page.evaluate(()=>{(window as any).switchLostACK=true;});await confirmSwitch(page).click();await expect(page.locator('.continuity-client-status')).toContainText('ยังยืนยัน');const saved=await page.evaluate(()=>(window as any).memoryStorage);const restored=await context.newPage();await setup(restored);await restored.evaluate(saved=>{const w:any=window;Object.assign(w.memoryStorage,saved);w.mawExt.onRoom[0](w.fixture);},saved);await expect(restored.locator('.continuity-client-status')).toContainText('พบคำขอเดิม');await poll(restored);expect(await posts(restored)).toEqual([]);expect(await restored.evaluate(()=>(window as any).calls.some((c:any)=>c.path.includes('/operations/')))).toBe(false);await restored.close();
});
test('stored logical history remains visibly historical across a successful room revision change',async({page})=>{
 await setup(page);await page.evaluate(()=>{(window as any).historyPages={0:[{seq:1,agent:'codex',nativeId:'old-native',sourceId:'stored-source',role:'assistant',text:'stored history must stay'}]};});await page.locator('.continuity-history-load').click();await expect(page.locator('.continuity-history')).toContainText('stored history must stay');await page.evaluate(()=>{const w:any=window;w.states.p.room.revision++;w.states.p.room.active='claude';w.states.p.operation={id:'complete',roomId:'logical-p',target:'claude',expectedRevision:7,from:w.states.p.room.bindings.codex,targetBinding:structuredClone(w.states.p.room.bindings.claude),state:'ready-awaiting-user'};});await poll(page);await expect(page.locator('.continuity-status')).toContainText('พร้อม — รอคำสั่ง');await expect(page.locator('.continuity-history')).toContainText('stored history must stay');await expect(page.locator('.continuity-history')).toContainText('เก็บจากสถานะก่อนหน้า');expect(await posts(page)).toEqual([]);
});
test('failed and uncertain server operations are distinct from ready and never show unsafe retry',async({page})=>{
 await setup(page);for(const state of ['failed','uncertain','preparing-target','ready-awaiting-user']){await page.evaluate(state=>{const w:any=window;w.states.p.operation={id:'op-status',state,targetBinding:{agent:'claude',nativeId:'target',generation:'target-gen',cursor:0}};w.states.p.room.operationId=state==='ready-awaiting-user'?undefined:'op-status';},state);await poll(page);await expect(page.locator('.continuity-status')).toHaveAttribute('data-state',state==='ready-awaiting-user'?'historical':state);await expect(page.getByRole('button',{name:'ลองใหม่',exact:true})).toHaveCount(0);}expect(await posts(page)).toEqual([]);
});

// Actual complete m.html + extension, fake HTTP. The native history and composer are real core code.
async function setupSwitchApplication(page:Page,lost=false){
 const requests:{path:string;method:string;body:any}[]=[];
 const nativeRoom={id:'p',title:'Fixture room',agent:'codex',status:'idle',generation:'physical-generation',continuityToken:'physical-generation',claudeSessionId:null,capabilities:{history:true,screen:true,prompt:true,answer:false,keys:true,stop:false}};
 const bindings={codex:{agent:'codex',nativeId:'native-codex',generation:'source-generation',model:'source-model',route:'fixture-route',cursor:0},claude:{agent:'claude',nativeId:'native-claude',generation:'target-generation',model:'target-model',route:'fixture-route',cursor:0}};
 const room:any={id:'logical-room',workspace:'herdr:fixture',room:'p',backend:'herdr',cwd:'/fixture/project',revision:7,active:'codex',bindings};let operation:any=null;
 const cap={ok:true,ready:true,scope:'room-backend',roomStateAvailable:true,factsSelectionAvailable:true,backends:[{backend:'herdr',ready:true},{backend:'tmux',ready:false},{backend:'superset',ready:false}],models:[{agent:'claude',id:'target-model',label:'Target model from API'}]};
 const preview=()=>({id:'preview-actual',roomId:room.id,roomRevision:room.revision,sourceBindingHash:'a'.repeat(64),archiveHash:'b'.repeat(64),throughSeq:1,selectionRequired:true,contextText:'server reference context',candidates:[{field:'goal',seq:1,sourceId:'goal-source',agent:'codex',nativeId:'native-codex',eventHash:'c'.repeat(64),value:'explicit fixture goal'}]});
 const html=mobile.replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/g,'').replace(/^start\(\);$/m,'').replace(/^if \("serviceWorker" in navigator\).*$/m,'').replace('</body>','<script>window.switchFixture={state,renderProject,loadScreen};</script></body>');
 await page.addInitScript(()=>{window.setInterval=(()=>0) as any;});
 await page.route('http://switch.fixture.test/**',async route=>{
  const url=new URL(route.request().url()),p=decodeURIComponent(url.pathname),method=route.request().method();if(p==='/m')return route.fulfill({contentType:'text/html',body:html});
  const body=method==='POST'?JSON.parse(route.request().postData()||'{}'):null;requests.push({path:p,method,body});let data:any={ok:true};
  if(p==='/mobile/version')data={v:'fixture-version'};
  else if(p.endsWith('/continuity/transport'))return route.fulfill({status:404,json:{ok:false,code:'transport_not_found'}});
  else if(p.endsWith('/continuity/capabilities'))data=cap;
  else if(p.endsWith('/facts/preview'))data={ok:true,preview:preview()};
  else if(p.endsWith('/facts/selections'))data={ok:true,selection:{id:body.id,previewId:body.previewId,roomRevision:body.expectedRevision,factsHash:'e'.repeat(64)}};
  else if(p.endsWith('/switch')){operation={id:body.id,roomId:room.id,target:body.target,model:body.model,expectedRevision:body.expectedRevision,from:structuredClone(bindings.codex),state:'waiting-safe-point'};room.operationId=operation.id;if(lost)return route.fulfill({status:500,json:{ok:false,code:'fixture_lost_ack'}});data={ok:true,operation};}
  else if(p.endsWith('/advance')){operation.state='ready-awaiting-user';operation.targetBinding=bindings.claude;room.active='claude';room.revision++;delete room.operationId;data={ok:true,operation};}
  else if(p.includes('/continuity/operations/'))data={ok:true,operation};
  else if(p.endsWith('/continuity/events'))data={ok:true,items:[{seq:1,sourceId:'stored-event',agent:'codex',nativeId:'native-codex',role:'assistant',text:'stored reference history'}]};
  else if(p.endsWith('/continuity'))data={ok:true,room,operation,held:[]};
  else if(p.endsWith('/chat'))data={ok:true,kind:'messages',conversation:'11111111-1111-4111-8111-111111111111',epoch:'verified-epoch',total:60,start:0,items:Array.from({length:60},(_,i)=>({i,role:i%2?'assistant':'user',text:'verified native history '+i}))};
  else if(p.endsWith('/prompt'))data={ok:true,prompt:null,generation:nativeRoom.generation};
  return route.fulfill({json:data});
 });
 await page.goto('http://switch.fixture.test/m');await page.addScriptTag({content:extension});await page.evaluate(r=>{const f=(window as any).switchFixture;Object.assign(f.state,{project:'Fixture',ws:'herdr:fixture',room:'p',mode:'chat',pview:'rooms',projects:[{name:'Fixture',source:'herdr',workspaces:[{id:'herdr:fixture',name:'Fixture',rooms:[r]}]}]});f.renderProject();},nativeRoom);
 await expect(page.locator('#screen')).toContainText('verified native history 59');await expect(page.locator('header [data-continuity-switch]')).toBeEnabled();
 await page.locator('#msg').fill('new draft stays exactly');await page.locator('#fileIn').setInputFiles({name:'keep.txt',mimeType:'text/plain',buffer:Buffer.from('keep fixture attachment')});
 await page.evaluate(()=>{const f=(window as any).switchFixture,s=document.getElementById('screen')!;s.scrollTop=100;s.dispatchEvent(new Event('scroll'));f.before={screen:s,msg:document.getElementById('msg'),file:f.state.files[0],scroll:s.scrollTop};});
 return requests;
}
for(const lost of [false,true])test('actual header/preview/switch '+(lost?'lost ACK':'ready')+' preserves native history DOM, raw draft, File identity and scroll',async({page})=>{
 const requests=await setupSwitchApplication(page,lost);await page.locator('.continuity-history-load').click();await expect(page.locator('.continuity-history')).toContainText('stored reference history');await page.locator('header [data-continuity-switch]').click();await page.locator('[data-continuity-preview]').click();await expect(page.locator('.continuity-facts input:checked')).toHaveCount(0);await page.locator('.continuity-facts input[type=radio]').check();await confirmSwitch(page).click();
 if(lost){await expect(page.locator('.continuity-client-status')).toContainText('ยังยืนยันคำขอเดิมไม่ได้');await page.getByRole('button',{name:'ตรวจสถานะคำขอเดิม · อ่านอย่างเดียว',exact:true}).click();await expect(page.locator('.continuity-client-status')).toContainText('ข้อมูลย้อนหลัง');}
 else {await expect(page.locator('.continuity-status')).toHaveAttribute('data-state','ready-awaiting-user');await expect(page.locator('.continuity-client-status')).not.toContainText('กำลังดำเนิน');}
 await expect(page.locator('#msg')).toHaveValue('new draft stays exactly');await expect(page.locator('#screen')).toContainText('verified native history 59');await expect(page.locator('.continuity-history')).toContainText('stored reference history');
 expect(await page.evaluate(()=>{const f=(window as any).switchFixture;return {screen:document.getElementById('screen')===f.before.screen,msg:document.getElementById('msg')===f.before.msg,file:f.state.files[0]===f.before.file,scroll:document.getElementById('screen')!.scrollTop,before:f.before.scroll};})).toEqual({screen:true,msg:true,file:true,scroll:100,before:100});
 expect(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/switch'))).toHaveLength(1);expect(requests.some(r=>r.path.endsWith('/send')||r.path.includes('/upload'))).toBe(false);
});
test('valid switch ACK after leaving the room never advances the old operation',async({page})=>{
 await setup(page);await open(page);await page.evaluate(path=>{(window as any).hold('valid-old-ack',path+'/switch','POST');},path);await confirmSwitch(page).click();await waitDeferred(page,'valid-old-ack');const body=JSON.parse((await switchPosts(page))[0].opts.body);await changeRoom(page);await page.evaluate(b=>{const w:any=window;w.release('valid-old-ack',{ok:true,operation:w.normalizeOperation({id:b.id,target:b.target,model:b.model,expectedRevision:b.expectedRevision,state:'waiting-safe-point'},w.states.p)});},body);await expect(page.locator('.continuity-current')).toContainText('Agent: claude');expect((await posts(page)).some((c:any)=>c.path.endsWith('/advance'))).toBe(false);expect(await switchPosts(page)).toHaveLength(1);
});
test('changing chosen model while preview revalidation is awaiting stops before saving facts',async({page})=>{
 await setup(page);await open(page);await page.evaluate(path=>{(window as any).hold('check-preview',path+'/facts/preview');},path);await confirmSwitch(page).click();await waitDeferred(page,'check-preview');await page.evaluate(()=>{const w:any=window;(document.querySelector('[data-continuity-model]') as HTMLSelectElement).value='unavailable-model';w.release('check-preview',{ok:true,preview:w.previewFor('p')});});await expect(page.locator('.sheet')).toHaveCount(0);expect(await posts(page)).toEqual([]);
});
test('capability revocation after facts receipt prevents switch despite a valid saved selection',async({page})=>{
 await setup(page);await open(page);await page.evaluate(path=>{(window as any).hold('save-facts',path+'/facts/selections','POST');},path);await confirmSwitch(page).click();await waitDeferred(page,'save-facts');const b=JSON.parse((await selectionPosts(page))[0].opts.body);await page.evaluate(b=>{const w:any=window;w.capability.ready=false;w.release('save-facts',{ok:true,selection:{id:b.id,previewId:b.previewId,roomRevision:b.expectedRevision,factsHash:'e'.repeat(64)}});},b);await expect(page.locator('[data-continuity-switch]')).toBeDisabled();expect(await switchPosts(page)).toHaveLength(0);await expect(page.locator('.continuity-client-status')).toContainText('ยังไม่เริ่มสลับ');
});
test('preview modal can close during a deferred GET and late reply cannot recreate it',async({page})=>{
 await setup(page);await open(page,false);await page.evaluate(path=>{(window as any).hold('close-preview',path+'/facts/preview');},path);await page.locator('[data-continuity-preview]').click();await waitDeferred(page,'close-preview');await page.locator('[data-continuity-close]').click();await expect(page.locator('.sheet')).toHaveCount(0);await page.evaluate(()=>{const w:any=window;w.release('close-preview',{ok:true,preview:w.previewFor('p')});});await expect(page.locator('.sheet')).toHaveCount(0);expect(await posts(page)).toEqual([]);
});

test('staged source/target uncertainty never claims the source was preserved or offers automatic retry',async({page})=>{await setup(page,true,{...blocked,operation:{id:'old-op',state:'uncertain',reason:'staged_source_target_unverified'}});await expect(page.locator('.continuity-status')).toContainText('ยังยืนยันสถานะ agent ต้นทางและปลายทางไม่ได้ กรุณาตรวจ operation เดิมก่อนส่งซ้ำ');await expect(page.locator('.continuity-status')).not.toContainText('source preserved');await expect(page.getByRole('button',{name:'ลองใหม่',exact:true})).toHaveCount(0);expect(await posts(page)).toEqual([]);});

for(const drift of ['generation','model'])test('historical ready operation with current '+drift+' drift never claims current readiness',async({page})=>{await setup(page);await page.evaluate(drift=>{const w:any=window,r=w.states.p.room;r.active='claude';r.revision=8;w.states.p.operation={id:'past-op',roomId:r.id,target:'claude',expectedRevision:7,targetBinding:structuredClone(r.bindings.claude),from:r.bindings.codex,state:'ready-awaiting-user'};r.bindings.claude[drift]='replacement';},drift);await poll(page);await expect(page.locator('.continuity-status')).toHaveAttribute('data-state','historical');await expect(page.locator('.continuity-status')).not.toContainText('พร้อม — รอคำสั่ง');expect(await posts(page)).toEqual([]);});

// Owned transport fixtures exercise actual composer/pending code; no native processes or server.
async function setupOwnedCore(page:Page){
 await setupCore(page);
 await page.evaluate(()=>{
  const w:any=window;delete w.states.p.room.operationId;w.states.p.operation=null;
  w.ownedTransport={kind:'owned-protocol',roomId:w.states.p.room.id,revision:w.states.p.room.revision,binding:structuredClone(w.states.p.room.bindings.codex),state:'idle',capabilities:{textTurn:true,attachments:false,keys:false}};
  const raw=w.apiRaw;w.turnRequests=[];w.turnReceipts={};
  w.apiRaw=async(path:string,opts:any)=>{
   if(path.endsWith('/transport')){
    w.calls.push({path,opts});if(w.transportFailure){const e:any=new Error('transport unavailable');e.status=w.transportFailure;throw e;}
    if(w.pauseTransport){w.pauseTransport=false;return new Promise(resolve=>{w.resumeTransport=()=>resolve({ok:true,transport:structuredClone(w.ownedTransport)});});}
    return {ok:true,transport:structuredClone(w.ownedTransport)};
   }
   if(path.endsWith('/turns')){
    const body=JSON.parse(opts.body);w.calls.push({path,opts});w.turnRequests.push({body,persisted:JSON.parse(w.memoryStorage['maw-pend'])});
    const receipt={id:body.id,roomId:w.ownedTransport.roomId,binding:body.binding,state:'completed',source:'live',turn:{operationId:body.id,nativeId:body.binding.nativeId,turnId:'native-turn',text:'native final fixture',state:'completed'}};
    w.turnReceipts[body.id]=receipt;if(w.turnLostACK)throw new Error('lost ACK');
    if(w.pauseTurn)return new Promise(resolve=>{w.resumeTurn=()=>resolve({ok:true,receipt});});
    return {ok:true,receipt:w.receiptOverride||receipt};
   }
   if(path.includes('/turns/')){w.calls.push({path,opts});if(w.statusLost)throw new Error('lost status');return {ok:true,receipt:{...w.turnReceipts[decodeURIComponent(path.split('/').at(-1))],source:'historical'}};}
   return raw(path,opts);
  };
 });
}
test('owned actual composer persists exact intent before one text turn and clears only acknowledged unchanged draft',async({page})=>{
 await setupOwnedCore(page);await page.locator('#msg').fill('authorized text');await page.evaluate(()=>(window as any).submitComposer());
 const result=await page.evaluate(()=>{const w:any=window;return {requests:w.turnRequests,p:w.core.pendingSends[0],draft:document.querySelector<HTMLTextAreaElement>('#msg')!.value};});
 expect(result.requests).toHaveLength(1);const intent=result.requests[0].persisted[0].continuityTurnIntent;
 expect(result.requests[0].body).toEqual(intent.body);expect(intent.body.binding.generation).toBe('continuity-generation');expect(intent.body.expectedRevision).toBe(7);
 expect(result.p.state).toBe('continuity-completed');expect(result.draft).toBe('');expect(await nativePosts(page)).toEqual([]);expect(await heldPosts(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).uploads)).toEqual([]);
});
test('owned attachments retain exact draft and File objects without upload, turn, hold or legacy send',async({page})=>{
 await setupOwnedCore(page);await page.evaluate(async()=>{const w:any=window;w.state.files=[new File(['keep'],'keep.txt')];w.savedFile=w.state.files[0];document.querySelector<HTMLTextAreaElement>('#msg')!.value='keep text';await w.submitComposer();});
 await expect(page.locator('#msg')).toHaveValue('keep text');expect(await page.evaluate(()=>{const w:any=window;return w.state.files[0]===w.savedFile&&w.core.pendingSends[0].files[0]===w.savedFile;})).toBe(true);expect(await posts(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).uploads)).toEqual([]);
});
for(const storage of ['full','readback'])test(`owned ${storage} storage refuses POST and keeps draft`,async({page})=>{
 await setupOwnedCore(page);await page.evaluate(storage=>{(window as any).storageMode=storage;},storage);await page.locator('#msg').fill('keep local');await page.evaluate(()=>(window as any).submitComposer());await expect(page.locator('#msg')).toHaveValue('keep local');expect(await posts(page)).toEqual([]);
});
test('owned lost ACK/double click and explicit exact lookup never replay or clear a later draft',async({page})=>{
 await setupOwnedCore(page);await page.evaluate(()=>{(window as any).turnLostACK=true;});await page.locator('#msg').fill('original text');await page.evaluate(()=>{const w:any=window;return Promise.all([w.submitComposer(),w.submitComposer()]);});
 await expect(page.locator('#msg')).toHaveValue('original text');expect(await page.evaluate(()=>(window as any).turnRequests)).toHaveLength(1);
 await page.evaluate(async()=>{const w:any=window;await w.submitComposer();w.statusLost=true;await w.core.reconcileContinuityPending(w.core.pendingSends[0]);});expect(await page.evaluate(()=>(window as any).core.pendingSends[0].state)).toBe('continuity-uncertain');
 await page.locator('#msg').fill('later draft');await page.evaluate(async()=>{const w:any=window;w.statusLost=false;await w.core.reconcileContinuityPending(w.core.pendingSends[0]);});
 expect(await page.evaluate(()=>(window as any).turnRequests)).toHaveLength(1);await expect(page.locator('#msg')).toHaveValue('later draft');expect(await page.evaluate(()=>(window as any).core.pendingSends[0].state)).toBe('continuity-completed');
});
for(const change of ['draft','files','room','binding','revision','revoked'])test(`owned deferred preflight ${change} prevents dispatch and preserves draft/files`,async({page})=>{
 await setupOwnedCore(page);await page.locator('#msg').fill('original text');await page.evaluate(()=>{const w:any=window;w.pauseTransport=true;void w.submitComposer();});await expect.poll(()=>page.evaluate(()=>typeof (window as any).resumeTransport)).toBe('function');
 await page.evaluate(change=>{const w:any=window;if(change==='draft')document.querySelector<HTMLTextAreaElement>('#msg')!.value='new text';if(change==='files')w.state.files=[new File(['new'],'new.txt')];if(change==='room')w.state.room='q';if(change==='binding')w.ownedTransport.binding.generation='replacement';if(change==='revision')w.ownedTransport.revision++;if(change==='revoked')w.ownedTransport.capabilities.textTurn=false;w.resumeTransport();},change);
 await expect.poll(()=>page.evaluate(()=>!!(document.querySelector('#msg') as any)._continuityCapturing)).toBe(false);expect(await posts(page)).toEqual([]);await expect(page.locator('#msg')).toHaveValue(change==='draft'?'new text':'original text');if(change==='files')expect(await page.evaluate(()=>(window as any).state.files[0].name)).toBe('new.txt');
});
test('owned late completed receipt after navigation or editing never clears new draft',async({page})=>{
 await setupOwnedCore(page);await page.locator('#msg').fill('original');await page.evaluate(()=>{const w:any=window;w.pauseTurn=true;void w.submitComposer();});await expect.poll(()=>page.evaluate(()=>typeof (window as any).resumeTurn)).toBe('function');
 await page.evaluate(()=>{const w:any=window;w.state.room='q';document.querySelector<HTMLTextAreaElement>('#msg')!.value='new room draft';w.resumeTurn();});await expect.poll(()=>page.evaluate(()=>(window as any).core.pendingSends[0].state)).toBe('continuity-completed');await expect(page.locator('#msg')).toHaveValue('new room draft');expect(await page.evaluate(()=>(window as any).turnRequests)).toHaveLength(1);
});
test('owned wrong final correlation remains uncertain and never grants successful clear',async({page})=>{
 await setupOwnedCore(page);await page.evaluate(()=>{(window as any).receiptOverride={id:'foreign',state:'completed',source:'live'};});await page.locator('#msg').fill('original');await page.evaluate(()=>(window as any).submitComposer());await expect(page.locator('#msg')).toHaveValue('original');expect(await page.evaluate(()=>(window as any).core.pendingSends[0].state)).toBe('continuity-uncertain');
});
test('owned restored intent survives reload without POST/auto flush and has exact GET reconciliation only',async({page,context})=>{
 await setupOwnedCore(page);await page.evaluate(()=>{(window as any).turnLostACK=true;});await page.locator('#msg').fill('original');await page.evaluate(()=>(window as any).submitComposer());const saved=await page.evaluate(()=>(window as any).memoryStorage['maw-pend']);
 const next=await context.newPage();await setupOwnedCore(next);await next.evaluate(async saved=>{const w:any=window;w.memoryStorage['maw-pend']=saved;await w.core.restorePending();await w.core.flushWaiting();},saved);expect(await posts(next)).toEqual([]);expect(await next.evaluate(()=>(window as any).core.pendingSends[0].continuityTurnIntent.body.text)).toBe('original');await next.close();
});
test('owned actual application renders stored events and blocks TUI reads/keys/permission posts even in raw mode',async({page})=>{
 const requests=await setupSwitchApplication(page);const t={kind:'owned-protocol',roomId:'logical-room',revision:7,binding:{agent:'codex',nativeId:'native-codex',generation:'source-generation',model:'source-model',route:'fixture-route',cursor:0},state:'idle',capabilities:{textTurn:true,attachments:false,keys:false}};
 await page.route('**/continuity/transport',route=>route.fulfill({json:{ok:true,transport:t}}));
 const before=requests.length;await page.evaluate(async()=>{const f=(window as any).switchFixture;f.state.mode='raw';await f.loadScreen();});await expect(page.locator('#screen')).toContainText('stored reference history');await expect(page.locator('[data-m="raw"]')).toBeHidden();await expect(page.locator('.keys')).toBeHidden();
 for(const suffix of ['send','prompt/answer','prompt/key','screen','chat','suggestion']){
  const result=await page.evaluate(async suffix=>{try{await (window as any).eval(`apiRaw('/rooms/herdr%3Afixture/p/${suffix}',${['send','prompt/answer','prompt/key'].includes(suffix)?"{method:'POST',body:'{}'}":"{}"})`);return 'sent';}catch{return 'blocked';}},suffix);expect(result).toBe('blocked');
 }
 expect(requests.slice(before).filter(r=>/\/(send|prompt|chat|screen|suggestion)(\/|$)/.test(r.path))).toEqual([]);await expect(page.locator('#msg')).toHaveValue('new draft stays exactly');expect(await page.evaluate(()=>(window as any).switchFixture.state.files[0].name)).toBe('keep.txt');
 await page.route('**/continuity/transport',route=>route.fulfill({status:404,json:{ok:false}}));await page.evaluate(async()=>{await (window as any).switchFixture.loadScreen();});expect(requests.slice(before).filter(r=>/\/(send|prompt|chat|screen|suggestion)(\/|$)/.test(r.path))).toEqual([]);
});
test('facts references accept exact 1024 slash/space provenance without loosening operation IDs',async({page})=>{
 await setup(page);await page.evaluate(()=>{const w:any=window;const p=w.previewFor('p');p.candidates[0].sourceId='folder / '+'x'.repeat(1015);p.candidates[0].nativeId='native / with spaces';w.previewOverrides={p};});await open(page);await confirmSwitch(page).click();const selection=(await posts(page)).find((c:any)=>c.path.endsWith('/facts/selections'));expect(JSON.parse(selection.opts.body).selections[0].sourceId).toHaveLength(1024);expect(JSON.parse(selection.opts.body).selections[0].nativeId).toBe('native / with spaces');
});
for(const value of ['x'.repeat(1025),'bad\nsource','bad\0source'])test(`facts reference rejects ${value.length>1024?'overlimit':value.includes('\n')?'newline':'NUL'} before mutation`,async({page})=>{
 await setup(page);await page.evaluate(value=>{const w:any=window;const p=w.previewFor('p');p.candidates[0].sourceId=value;w.previewOverrides={p};},value);await open(page,false);await page.locator('[data-continuity-preview]').click();await expect(page.locator('.continuity-preview-status')).toContainText('ไม่ถูกต้อง');expect(await posts(page)).toEqual([]);
});
test('owned completed composer allows a newly authorized identical text as a distinct next turn',async({page})=>{
 await setupOwnedCore(page);for(let i=0;i<2;i++){await page.locator('#msg').fill('same authorized text');await page.evaluate(()=>(window as any).submitComposer());await expect(page.locator('#msg')).toHaveValue('');}
 const requests=await page.evaluate(()=>(window as any).turnRequests);expect(requests).toHaveLength(2);expect(requests[0].body.id).not.toBe(requests[1].body.id);
});
test('owned actual HTTP composer sends only scoped protocol turn and preserves exact persisted body',async({page})=>{
 const requests=await setupSwitchApplication(page);const binding={agent:'codex',nativeId:'native-codex',generation:'source-generation',model:'source-model',route:'fixture-route',cursor:0};let actual:any;
 await page.route('**/continuity/transport',route=>route.fulfill({json:{ok:true,transport:{kind:'owned-protocol',roomId:'logical-room',revision:7,binding,state:'idle',capabilities:{textTurn:true,attachments:false,keys:false}}}}));
 await page.route('**/continuity/turns',async route=>{actual=JSON.parse(route.request().postData()!);return route.fulfill({json:{ok:true,receipt:{id:actual.id,roomId:'logical-room',binding,state:'completed',source:'live',turn:{operationId:actual.id,nativeId:binding.nativeId,turnId:'actual-native-turn',text:'actual final fixture',state:'completed'}}}});});
 await page.evaluate(async()=>{const f=(window as any).switchFixture;f.state.files=[];await f.loadScreen();});const before=requests.length;await page.locator('#msg').fill('owned HTTP request');await page.locator('#send').click();await expect(page.locator('#msg')).toHaveValue('');
 expect(actual).toEqual({id:expect.any(String),text:'owned HTTP request',expectedRevision:7,binding});const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('maw-pend')!));expect(stored.find((p:any)=>p.continuityTurnIntent?.body.id===actual.id).continuityTurnIntent.body).toEqual(actual);expect(requests.slice(before).filter(r=>r.method==='POST')).toEqual([]);
});
test('owned stored transcript follows real event cursors beyond first page and retains new final history',async({page})=>{
 await setupSwitchApplication(page);const pages:number[]=[];
 await page.route('**/continuity/transport',route=>route.fulfill({json:{ok:true,transport:{kind:'owned-protocol',roomId:'logical-room',revision:7,binding:{agent:'codex',nativeId:'native-codex',generation:'source-generation',model:'source-model',route:'fixture-route',cursor:0},state:'idle',capabilities:{textTurn:true,attachments:false,keys:false}}}}));
 await page.route('**/continuity/events?**',route=>{const after=Number(new URL(route.request().url()).searchParams.get('after'));pages.push(after);const items=after===0?Array.from({length:500},(_,i)=>({seq:i+1,sourceId:'stored-'+i,nativeId:'native-codex',agent:'codex',role:'user',text:'older stored '+i})):after===500?[{seq:501,sourceId:'new-final',nativeId:'native-codex',agent:'codex',role:'assistant',text:'new final past first page'}]:[];return route.fulfill({json:{ok:true,items}});});
 await page.evaluate(async()=>{await (window as any).switchFixture.loadScreen();});await expect(page.locator('#screen')).toContainText('new final past first page');expect(pages).toEqual([0,500]);await page.evaluate(async()=>{await (window as any).switchFixture.loadScreen();});expect(pages.at(-1)).toBe(501);await expect(page.locator('#screen')).toContainText('older stored 0');await expect(page.locator('#screen')).toContainText('new final past first page');
});
test('owned reload marker forbids TUI fallback on missing endpoint and never grants text capability',async({page,context})=>{
 await setupOwnedCore(page);await page.evaluate(async()=>{try{await (window as any).mawContinuityTransport.guard('/rooms/w/p/chat');}catch{}});const saved=await page.evaluate(()=>(window as any).memoryStorage);
 const next=await context.newPage();await setupCore(next);await next.evaluate(saved=>{const w:any=window;Object.assign(w.memoryStorage,saved);w.capability.roomStateAvailable=false;},saved);
 const result=await next.evaluate(async()=>{const w:any=window;let blocked=false;try{await w.mawContinuityTransport.guard('/rooms/w/p/send');}catch{blocked=true;}return {blocked,t:w.mawContinuityTransport.known('w','p')};});expect(result.blocked).toBe(true);expect(result.t.state).toBe('unavailable');expect(result.t.capabilities.textTurn).toBe(false);expect(await posts(next)).toEqual([]);await next.close();
});
test('owned pending status button performs exact GET only and retains draft on lost status',async({page})=>{
 await setupOwnedCore(page);await page.evaluate(()=>{(window as any).turnLostACK=true;});await page.locator('#msg').fill('original');await page.evaluate(()=>(window as any).submitComposer());const original=await page.evaluate(()=>(window as any).core.pendingSends[0].continuityTurnIntent.body.id);await page.evaluate(()=>{(window as any).statusLost=true;});const before=(await posts(page)).length;
 await page.getByRole('button',{name:'ตรวจสถานะ protocol เดิม · อ่านอย่างเดียว',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).core.pendingSends[0].busy)).toBe(false);expect((await posts(page)).length).toBe(before);expect(await page.evaluate(id=>(window as any).calls.some((c:any)=>c.path.endsWith('/turns/'+id)&&!c.opts?.method),original)).toBe(true);await expect(page.locator('#msg')).toHaveValue('original');
});
test('owned inventory projection only revokes TUI and cannot grant idle/text readiness when status is missing',async({page})=>{
 await setupCore(page);await page.evaluate(()=>{const w:any=window;Object.assign(w.fixture.room,{transportKind:'owned-protocol',logicalRoomId:w.states.p.room.id,revision:7,protocolBinding:structuredClone(w.states.p.room.bindings.codex),capabilities:{prompt:true,history:true,screen:false,keys:false,answer:false}});w.mawExt.onRoom[0](w.fixture);});
 const result=await page.evaluate(async()=>{const w:any=window;let blocked=false;try{await w.mawContinuityTransport.guard('/rooms/w/p/send');}catch{blocked=true;}return {blocked,t:w.mawContinuityTransport.known('w','p')};});expect(result.blocked).toBe(true);expect(result.t.capabilities.textTurn).toBe(false);await page.locator('#msg').fill('inventory is not authority');await page.evaluate(()=>(window as any).submitComposer());expect(await posts(page)).toEqual([]);await expect(page.locator('#msg')).toHaveValue('inventory is not authority');
});
test('owned same-generation Codex native identity change during deferred capture cannot target replacement',async({page})=>{
 await setupOwnedCore(page);await page.evaluate(()=>{const w:any=window;Object.assign(w.fixture.room,{transportKind:'owned-protocol',logicalRoomId:w.states.p.room.id,revision:7,protocolBinding:structuredClone(w.states.p.room.bindings.codex)});w.mawExt.onRoom[0](w.fixture);});await page.locator('#msg').fill('original UUID only');await page.evaluate(()=>{const w:any=window;w.pauseTransport=true;void w.submitComposer();});await expect.poll(()=>page.evaluate(()=>typeof (window as any).resumeTransport)).toBe('function');
 await page.evaluate(()=>{const w:any=window;w.fixture.room.protocolBinding={...w.fixture.room.protocolBinding,nativeId:'replacement-native'};w.states.p.room.bindings.codex.nativeId='replacement-native';w.ownedTransport.binding.nativeId='replacement-native';w.resumeTransport();});await expect.poll(()=>page.evaluate(()=>!!(document.querySelector('#msg') as any)._continuityCapturing)).toBe(false);expect(await posts(page)).toEqual([]);await expect(page.locator('#msg')).toHaveValue('original UUID only');
});
test('owned inventory header opens with complete cached identity and refuses detached confirm after native replacement',async({page})=>{
 await setupOwnedCore(page);await page.evaluate(()=>{const w:any=window;w.capability.ready=true;for(const b of w.capability.backends)b.ready=true;Object.assign(w.fixture.room,{agent:'codex',transportKind:'owned-protocol',logicalRoomId:w.states.p.room.id,revision:7,protocolBinding:structuredClone(w.states.p.room.bindings.codex)});w.mawExt.onRoom[0](w.fixture);});
 const header=page.locator('header [data-continuity-switch]');await expect(header).toBeEnabled();await header.click();await expect(page.locator('[data-continuity-provider]')).toBeVisible();await expect(page.locator('[data-continuity-model]')).toHaveValue('fixture-model');
 await page.locator('[data-continuity-preview]').click();await expect(page.locator('.continuity-facts input[type=radio]').first()).toBeVisible();await page.locator('.continuity-facts input[type=radio]').first().check();
 await page.evaluate(()=>{const w:any=window;w.detachedConfirm=document.querySelector('[data-continuity-confirm]');w.fixture.room.protocolBinding={...w.fixture.room.protocolBinding,nativeId:'replacement-native'};w.mawExt.onPoll[0](w.fixture);});await expect(page.locator('.sheet')).toHaveCount(0);await page.evaluate(()=>{(window as any).detachedConfirm.click();});expect(await posts(page)).toEqual([]);
});
