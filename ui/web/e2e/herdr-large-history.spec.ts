/** Actual inline UI + explicit synthetic indexing progression. No native reader certification. */
import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const html=readFileSync(process.env.MOBILE_HTML_PATH||resolve(import.meta.dirname,'../../mobile/m.html'),'utf8')
  .replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/g,'').replace(/^start\(\);$/m,'')
  .replace(/^if \("serviceWorker" in navigator\).*$/m,'')
  .replace('</body>','<script>window.largeChat={state,renderProject,loadScreen,chatCache};</script></body>');
const uuid='55555555-5555-4555-8555-555555555555',total=100000;
const room={id:'synthetic-large',title:'Synthetic large history',agent:'claude',status:'idle',generation:'synthetic-generation',claudeSessionId:null,capabilities:{history:true,screen:true,prompt:true,keys:true,answer:false}};
async function setup(page:Page,initialIndexing=false){
  const calls:{method:string;before:string|null;epoch:string|null;limit:string|null}[]=[];
  let indexing=initialIndexing,hardReason:string|null=null,reads=0,epoch='synthetic-epoch',conversation=uuid;
  await page.addInitScript(()=>{window.setInterval=(()=>0) as any;});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!=='http://large-chat.fixture')return route.abort();
    if(url.pathname==='/m')return route.fulfill({contentType:'text/html',body:html});
    if(!url.pathname.endsWith('/chat'))return route.fulfill({json:{ok:true}});
    reads++;const before=url.searchParams.get('before'),requestedEpoch=url.searchParams.get('epoch'),limit=url.searchParams.get('limit');
    calls.push({method:route.request().method(),before,epoch:requestedEpoch,limit});
    if(hardReason||indexing)return route.fulfill({json:{ok:true,kind:'none',available:false,reason:hardReason||'history_indexing'}});
    if(before!==null&&requestedEpoch!==epoch)return route.fulfill({json:{ok:true,kind:'none',available:false,reason:'history_epoch_changed'}});
    const end=Math.min(total,Number(before??total)),start=Math.max(0,end-Math.min(500,Number(limit??150)));
    return route.fulfill({json:{ok:true,kind:'messages',epoch,conversation,total,start,items:Array.from({length:end-start},(_,n)=>({i:start+n,role:(start+n)%2?'assistant':'user',text:`Synthetic item ${start+n}`,ts:null}))}});
  });
  await page.goto('http://large-chat.fixture/m');
  await page.evaluate(r=>{const f=(window as any).largeChat;Object.assign(f.state,{projects:[{name:'Synthetic',source:'herdr',workspaces:[{id:'herdr:synthetic',name:'Synthetic',rooms:[r]}]}],project:'Synthetic',ws:'herdr:synthetic',room:r.id,pview:'rooms',mode:'chat'});f.renderProject();},room);
  await expect.poll(()=>reads).toBeGreaterThan(0);
  return {calls,index:(value:boolean)=>{indexing=value;},hard:(reason:string|null)=>{hardReason=reason;},changeIdentity:()=>{epoch='replacement-epoch';conversation='66666666-6666-4666-8666-666666666666';}};
}
async function poll(page:Page){await page.evaluate(()=>(window as any).largeChat.loadScreen());}
async function saveDraft(page:Page){
  await page.locator('#msg').fill('Synthetic unsent large-history draft');
  await page.locator('#fileIn').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('public fixture')});
  await page.evaluate(()=>{const f=(window as any).largeChat;f.savedFile=f.state.files[0];});
}
async function assertDraft(page:Page){
  await expect(page.locator('#msg')).toHaveValue('Synthetic unsent large-history draft');
  expect(await page.evaluate(()=>{const f=(window as any).largeChat;return f.state.files[0]===f.savedFile;})).toBe(true);
}
test('initial indexing stays explicit across polls then exact large pages load without synthetic tail or draft loss',async({page})=>{
  const f=await setup(page,true);await saveDraft(page);
  for(let n=0;n<3;n++){
    await poll(page);await expect(page.locator('#screen')).toContainText('กำลังเตรียมประวัติแชท');
    await expect(page.locator('#screen')).not.toContainText('Synthetic item');
    expect(await page.evaluate(()=>(window as any).largeChat.state.chat)).toBeNull();await assertDraft(page);
  }
  f.index(false);await poll(page);await expect(page.locator('#screen')).toContainText('Synthetic item 99999');
  expect(await page.evaluate(()=>{const c=(window as any).largeChat.state.chat;return {start:c.start,total:c.total,size:c.items.size};})).toEqual({start:99850,total,size:150});
  for(const before of [99850,99700]){
    await page.locator('#older').click();await expect.poll(()=>f.calls.at(-1)?.before).toBe(String(before));
    await expect(page.locator('#screen')).toContainText(`Synthetic item ${before-150}`);
    expect(f.calls.at(-1)).toMatchObject({method:'GET',epoch:'synthetic-epoch',limit:'150'});await assertDraft(page);
  }
  expect(await page.evaluate(()=>{const c=(window as any).largeChat.state.chat;return {start:c.start,total:c.total,size:c.items.size,min:Math.min(...c.items.keys()),max:Math.max(...c.items.keys())};})).toEqual({start:99550,total,size:450,min:99550,max:99999});
  expect(f.calls.every(c=>c.method==='GET')).toBe(true);
});
test('reindexing preserves only verified same-binding history; new generation cannot borrow that cache',async({page})=>{
  const f=await setup(page);await expect(page.locator('#screen')).toContainText('Synthetic item 99999');await saveDraft(page);f.index(true);
  for(let n=0;n<3;n++){
    await poll(page);await expect(page.locator('#screen')).toContainText('Synthetic item 99999');
    await expect(page.locator('[data-history-transient]')).toContainText('กำลังเตรียมประวัติแชท');
    await expect(page.locator('[data-history-transient]')).toContainText('ข้อมูลเก่า');await assertDraft(page);
  }
  await page.evaluate(()=>{const f=(window as any).largeChat;f.state.projects[0].workspaces[0].rooms[0].generation='replacement-generation';f.renderProject();});
  await expect(page.locator('#screen')).toContainText('กำลังเตรียมประวัติแชท');
  await expect(page.locator('#screen')).not.toContainText('Synthetic item');await expect(page.locator('[data-history-transient]')).toHaveCount(0);
  await assertDraft(page);f.index(false);f.changeIdentity();await poll(page);
  await expect(page.locator('#screen')).toContainText('Synthetic item 99999');
  expect(await page.evaluate(()=>(window as any).largeChat.state.chat.conversation)).toBe('66666666-6666-4666-8666-666666666666');
  await assertDraft(page);expect(f.calls.every(c=>c.method==='GET')).toBe(true);
});
test('hard reader limits and unverified ancestry never retain old history as indexing progress',async({page})=>{
  const f=await setup(page);await expect(page.locator('#screen')).toContainText('Synthetic item 99999');await saveDraft(page);
  for(const reason of ['history_record_size_limit','history_page_size_limit','history_index_size_limit','history_ancestry_unverified']){
    f.hard(reason);await poll(page);
    await expect(page.locator('#screen')).toContainText('ยังอ่านประวัติแชทไม่ได้');
    await expect(page.locator('#screen')).not.toContainText('Synthetic item');
    await expect(page.locator('#screen')).not.toContainText('กำลังเตรียมประวัติแชท');
    await expect(page.locator('[data-history-transient]')).toHaveCount(0);await assertDraft(page);
    f.hard(null);await poll(page);await expect(page.locator('#screen')).toContainText('Synthetic item 99999');
  }
  expect(f.calls.every(c=>c.method==='GET')).toBe(true);
});
