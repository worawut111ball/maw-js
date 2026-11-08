import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,readdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {FactsSelectionStore,createFactsProvider} from '../src/mobile/continuity/facts-selection';
import {factsBindingHash,type Snapshot,type SelectionSet} from '../src/mobile/continuity/facts-resolver';
import type {Room} from '../src/mobile/continuity/types';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'maw-facts-selection-'));dirs.push(dir);
 const text=JSON.stringify({kind:'continuity-facts',version:1,facts:{goal:'เป้าหมายที่เลือกชัดเจน'}});
 const binding={agent:'codex' as const,nativeId:'n',generation:'g',cursor:0};
 const events=[{seq:1,sourceId:'s',agent:'codex' as const,nativeId:'n',role:'user',text}];
 const snapshot:Snapshot={roomId:'r',roomRevision:0,sourceBinding:binding,throughSeq:1,archivePath:'/private/archive.jsonl',archiveHash:sha(events.map(e=>JSON.stringify(e)).join('\n')+'\n'),events};
 const selection:SelectionSet={version:1,roomId:'r',roomRevision:0,archiveHash:snapshot.archiveHash,throughSeq:1,sourceBindingHash:factsBindingHash(binding),selections:[{field:'goal',seq:1,sourceId:'s',agent:'codex',nativeId:'n',eventHash:sha(text)}]};
 const room:Room={id:'r',revision:0,workspace:'w',room:'p',backend:'herdr',cwd:'/project',active:'codex',bindings:{codex:binding}};
 return {dir,store:new FactsSelectionStore(join(dir,'selections')),snapshot,selection,room};
}
test('persisted provenance is private, durable, exact and reusable after reopen',()=>{
 const f=fixture(),r=f.store.approve('selection','authenticated-host-user',f.snapshot,f.selection);
 const files=readdirSync(f.store.root);expect(files).toHaveLength(1);expect(statSync(f.store.root).mode&0o777).toBe(0o700);expect(statSync(join(f.store.root,files[0])).mode&0o777).toBe(0o600);
 expect(new FactsSelectionStore(f.store.root).read('selection',f.snapshot)).toEqual(r);expect(r.trust.permitsActions).toBe(false);
 expect(f.store.approve('selection','authenticated-host-user',f.snapshot,f.selection)).toEqual(r);
});
test('same selection ID cannot overwrite an actor or different selected source',()=>{
 const f=fixture();f.store.approve('s','actor1',f.snapshot,f.selection);
 expect(()=>f.store.approve('s','actor2',f.snapshot,f.selection)).toThrow('facts_selection_conflict');expect(f.store.read('s',f.snapshot).facts.goal).toBe('เป้าหมายที่เลือกชัดเจน');
 expect(readdirSync(f.store.root)).toHaveLength(1);
});
test('missing or invalid goal never persists an approval or creates a store',()=>{
 const f=fixture();expect(()=>f.store.approve('s','actor',f.snapshot,{...f.selection,selections:[]})).toThrow('facts_explicit_goal_missing');expect(()=>statSync(f.store.root)).toThrow();
 expect(()=>f.store.read('none',f.snapshot)).toThrow('facts_selection_missing');expect(()=>statSync(f.store.root)).toThrow();
});
test('exact selection scope rejects changed room, revision, cursor and generation',()=>{
 const f=fixture();f.store.approve('s','actor',f.snapshot,f.selection);
 for(const snapshot of [{...f.snapshot,roomId:'other'},{...f.snapshot,roomRevision:1},{...f.snapshot,throughSeq:2},{...f.snapshot,sourceBinding:{...f.snapshot.sourceBinding,generation:'replacement'}}])expect(()=>f.store.read('s',snapshot)).toThrow();
 expect(()=>f.store.read('latest',f.snapshot)).toThrow('facts_selection_missing');
});
test('tampered provenance and duplicate-key record are rejected',()=>{
 const f=fixture();f.store.approve('s','actor',f.snapshot,f.selection);const p=join(f.store.root,readdirSync(f.store.root)[0]),raw=readFileSync(p,'utf8');
 writeFileSync(p,raw.replace('เป้าหมายที่เลือกชัดเจน','tampered'));expect(()=>f.store.read('s',f.snapshot)).toThrow('facts_provenance_mismatch');
 writeFileSync(p,'{"version":1,'+raw.slice(1));expect(()=>f.store.read('s',f.snapshot)).toThrow('facts_selection_corrupt');
});
test('symlink record is never read or overwritten',()=>{
 const f=fixture();f.store.approve('s','actor',f.snapshot,f.selection);const p=join(f.store.root,readdirSync(f.store.root)[0]),outside=join(f.dir,'outside');writeFileSync(outside,'private');rmSync(p);symlinkSync(outside,p);
 expect(()=>f.store.read('s',f.snapshot)).toThrow('facts_selection_unreadable');expect(()=>f.store.approve('s','actor',f.snapshot,f.selection)).toThrow('facts_selection_unreadable');expect(readFileSync(outside,'utf8')).toBe('private');
});
test('provider requires explicit persisted selection and does not let selector mutate its snapshot',async()=>{
 const f=fixture();f.store.approve('s','actor',f.snapshot,f.selection);
 const provider=createFactsProvider(f.store,async(r,s)=>{r.id='other';s.events[0].text='mutated';s.sourceBinding.generation='other';return 's';});
 expect((await provider(f.room,f.snapshot)).goal).toBe('เป้าหมายที่เลือกชัดเจน');
 await expect(createFactsProvider(f.store,async()=>null)(f.room,f.snapshot)).rejects.toThrow('facts_selection_missing');
 await expect(provider({...f.room,revision:1},f.snapshot)).rejects.toThrow('facts_room_changed');
});

test('same ID with a valid changed snapshot cannot replace a selection',()=>{
 const f=fixture();f.store.approve('s','actor',f.snapshot,f.selection);
 const snapshot={...f.snapshot,roomRevision:1},selection={...f.selection,roomRevision:1};
 expect(()=>f.store.approve('s','actor',snapshot,selection)).toThrow('facts_selection_conflict');expect(f.store.read('s',f.snapshot).scope.roomRevision).toBe(0);
});
const modulePath=join(import.meta.dir,'../src/mobile/continuity/facts-selection.ts');
async function child(script:string,args:string[]){
 const p=Bun.spawn([process.execPath,'-e',script,...args],{stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>p.kill(),5000);
 try{const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);expect(code).toBe(0);expect(err).toBe('');return out.trim();}finally{clearTimeout(timer);}
}
test('cross-process identical publishers agree and conflicting publishers have exactly one winner',async()=>{
 for(const conflicting of [false,true]){
  const f=fixture(),script=`import {FactsSelectionStore} from ${JSON.stringify(modulePath)};const [root,actor,snapshot,selection]=process.argv.slice(1);try{new FactsSelectionStore(root).approve('s',actor,JSON.parse(snapshot),JSON.parse(selection));console.log('published')}catch(e){console.log(e.code||e.message)}`;
  const outputs=await Promise.all(['a',conflicting?'b':'a'].map(actor=>child(script,[f.store.root,actor,JSON.stringify(f.snapshot),JSON.stringify(f.selection)])));
  expect(outputs.filter(v=>v==='published')).toHaveLength(conflicting?1:2);
  if(conflicting)expect(outputs).toContain('facts_selection_conflict');expect(f.store.read('s',f.snapshot).state).toBe('resolved');
 }
});
test('reader establishes durability when publishing process is paused after link, before its directory fsync',async()=>{
 const f=fixture();const script=`import {mock} from 'bun:test';import * as fs from 'node:fs';const original={...fs};mock.module('node:fs',()=>({...original,linkSync:(...args)=>{original.linkSync(...args);process.stdout.write('published\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}));const {FactsSelectionStore}=await import(${JSON.stringify(modulePath)});const [root,snapshot,selection]=process.argv.slice(1);new FactsSelectionStore(root).approve('s','actor',JSON.parse(snapshot),JSON.parse(selection));`;
 const p=Bun.spawn([process.execPath,'-e',script,f.store.root,JSON.stringify(f.snapshot),JSON.stringify(f.selection)],{stdout:'pipe',stderr:'pipe'});const timer=setTimeout(()=>p.kill(),5000);
 try{
  const reader=p.stdout.getReader();let out='';while(!out.includes('published\n')){const next=await reader.read();if(next.done)break;out+=new TextDecoder().decode(next.value);}expect(out).toContain('published');
  expect(f.store.read('s',f.snapshot).state).toBe('resolved');p.kill('SIGKILL');await p.exited;
  expect(new FactsSelectionStore(f.store.root).read('s',f.snapshot).state).toBe('resolved');
 }finally{clearTimeout(timer);p.kill();await p.exited;}
});
test('reader never returns facts if the directory durability barrier fails',async()=>{
 const f=fixture();f.store.approve('s','actor',f.snapshot,f.selection);
 const script=`import {mock} from 'bun:test';import * as fs from 'node:fs';const original={...fs};mock.module('node:fs',()=>({...original,fsyncSync:(fd)=>{if(original.fstatSync(fd).isDirectory())throw Error('injected-directory-flush');return original.fsyncSync(fd);}}));const {FactsSelectionStore}=await import(${JSON.stringify(modulePath)});try{new FactsSelectionStore(process.argv[1]).read('s',JSON.parse(process.argv[2]));console.log('unexpected-return')}catch(e){console.log(e.message)}`;
 expect(await child(script,[f.store.root,JSON.stringify(f.snapshot)])).toBe('injected-directory-flush');
});
test('FIFO is rejected without waiting for a writer',async()=>{
 const f=fixture();f.store.approve('s','actor',f.snapshot,f.selection);const p=join(f.store.root,readdirSync(f.store.root)[0]);rmSync(p);
 const mkfifo=Bun.spawn(['mkfifo',p],{stdout:'pipe',stderr:'pipe'});expect(await mkfifo.exited).toBe(0);
 const script=`import {FactsSelectionStore} from ${JSON.stringify(modulePath)};try{new FactsSelectionStore(process.argv[1]).read('s',JSON.parse(process.argv[2]));console.log('unexpected-return')}catch(e){console.log(e.code||e.message)}`;
 expect(await child(script,[f.store.root,JSON.stringify(f.snapshot)])).toBe('facts_selection_unreadable');
});

test('new root provisioning fails closed when a parent directory cannot be flushed',async()=>{
 const f=fixture(),root=join(f.dir,'new-parent','store');
 const script=`import {mock} from 'bun:test';import * as fs from 'node:fs';const original={...fs},names=new Map();mock.module('node:fs',()=>({...original,openSync:(path,...args)=>{const fd=original.openSync(path,...args);names.set(fd,String(path));return fd},fsyncSync:(fd)=>{if(names.get(fd)?.endsWith('/new-parent'))throw Error('injected-parent-flush');return original.fsyncSync(fd)}}));const {FactsSelectionStore}=await import(${JSON.stringify(modulePath)});try{new FactsSelectionStore(process.argv[1]).approve('s','actor',JSON.parse(process.argv[2]),JSON.parse(process.argv[3]));console.log('unexpected-return')}catch(e){console.log(e.message)}`;
 expect(await child(script,[root,JSON.stringify(f.snapshot),JSON.stringify(f.selection)])).toBe('injected-parent-flush');expect(readdirSync(root)).toEqual([]);
});
test('reader cannot consume a record when its parent directory barrier fails',async()=>{
 const f=fixture();f.store.approve('s','actor',f.snapshot,f.selection);
 const script=`import {mock} from 'bun:test';import * as fs from 'node:fs';const original={...fs},names=new Map();mock.module('node:fs',()=>({...original,openSync:(path,...args)=>{const fd=original.openSync(path,...args);names.set(fd,String(path));return fd},fsyncSync:(fd)=>{if(names.get(fd)===original.realpathSync(process.argv[3]))throw Error('injected-read-parent-flush');return original.fsyncSync(fd)}}));const {FactsSelectionStore}=await import(${JSON.stringify(modulePath)});try{new FactsSelectionStore(process.argv[1]).read('s',JSON.parse(process.argv[2]));console.log('unexpected-return')}catch(e){console.log(e.message)}`;
 expect(await child(script,[f.store.root,JSON.stringify(f.snapshot),f.dir])).toBe('injected-read-parent-flush');
});
