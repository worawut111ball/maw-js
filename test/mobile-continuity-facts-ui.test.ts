import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {FactsUIService} from '../src/mobile/continuity/facts-ui';
import {FactsSelectionStore} from '../src/mobile/continuity/facts-selection';
import type {Room} from '../src/mobile/continuity/types';
import type {Snapshot} from '../src/mobile/continuity/facts-resolver';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'facts-ui-'));
 const binding={agent:'codex' as const,nativeId:'native',generation:'generation',cursor:0};
 const room:Room={id:'room',workspace:'w',room:'p',backend:'herdr',cwd:root,revision:0,active:'codex',bindings:{codex:binding}};
 const events=[{seq:1,sourceId:'source',agent:'codex' as const,nativeId:'native',role:'user',text:JSON.stringify({kind:'continuity-facts',version:1,facts:{goal:'ส่งมอบงาน'}})}];
 const snapshot:Snapshot={roomId:room.id,roomRevision:0,sourceBinding:binding,events,throughSeq:1,archivePath:join(root,'archive'),archiveHash:createHash('sha256').update(events.map(e=>JSON.stringify(e)).join('\n')+'\n').digest('hex')};
 const store=new FactsSelectionStore(join(root,'selections'));
 return {root,room,snapshot,store,service:new FactsUIService(store,'authenticated-mobile-owner',async()=>structuredClone(snapshot))};
}
test('preview enumerates references without selecting; explicit approval persists for a fresh service instance',async()=>{
 const h=fixture();try{
  const p=await h.service.preview(h.room);expect(p.candidates).toHaveLength(1);
  await expect(h.service.verify(h.room,'op')).rejects.toMatchObject({code:'facts_selection_missing'});
  const picks=p.candidates.map(({value,...pick})=>pick);
  const receipt=await h.service.approve(h.room,{id:'op',previewId:p.id,expectedRevision:0,selections:picks});expect(receipt.id).toBe('op');
  await new FactsUIService(h.store,'authenticated-mobile-owner',async()=>h.snapshot).verify(h.room,'op');
 }finally{rmSync(h.root,{recursive:true,force:true});}
});
test('foreign binding and changed history cannot approve a preview',async()=>{
 const h=fixture();try{
  const p=await h.service.preview(h.room),body={id:'op',previewId:p.id,expectedRevision:0,selections:p.candidates.map(({value,...pick})=>pick)};
  await expect(h.service.approve({...h.room,id:'other'},body)).rejects.toMatchObject({code:'facts_room_changed'});
  h.snapshot.archiveHash='a'.repeat(64);
  await expect(h.service.approve(h.room,body)).rejects.toMatchObject({code:'facts_preview_changed'});
 }finally{rmSync(h.root,{recursive:true,force:true});}
});

test('preview rejects oversized retained snapshot explicitly instead of truncating',async()=>{
 const h=fixture();try{
  h.snapshot.events[0].text='x'.repeat(256*1024);
  await expect(h.service.preview(h.room)).rejects.toMatchObject({code:'facts_preview_too_large',status:413});
 }finally{rmSync(h.root,{recursive:true,force:true});}
});

test.each([256,257])('candidate count %s has an explicit boundary without choosing or truncating',async count=>{
 const h=fixture();try{
  const fields={goal:'goal',constraints:[],decisions:[],pendingTasks:[],fileState:[],checks:[]};
  h.snapshot.events=Array.from({length:43},(_,i)=>({seq:i+1,sourceId:'source-'+i,agent:'codex',nativeId:'native',role:'user',text:JSON.stringify({kind:'continuity-facts',version:1,facts:fields})}));
  const last={...fields} as Record<string,unknown>;delete last.checks;if(count===256)delete last.fileState;
  h.snapshot.events[42].text=JSON.stringify({kind:'continuity-facts',version:1,facts:last});
  h.snapshot.throughSeq=43;
  h.snapshot.archiveHash=createHash('sha256').update(h.snapshot.events.map(e=>JSON.stringify(e)).join('\n')+'\n').digest('hex');
  if(count===257)await expect(h.service.preview(h.room)).rejects.toMatchObject({code:'facts_candidates_limit',status:413});
  else expect((await h.service.preview(h.room)).candidates).toHaveLength(256);
 }finally{rmSync(h.root,{recursive:true,force:true});}
});
