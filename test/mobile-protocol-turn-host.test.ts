import { expect, test } from 'bun:test';
import { realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EffectJournal } from '../src/mobile/continuity/effect-journal';
import { ProtocolTurnHost } from '../src/mobile/continuity/protocol/turn-host';
import type { NativeProtocolSession, ProtocolIdentity, ProtocolTurn } from '../src/mobile/continuity/protocol/types';
const home=realpathSync(tmpdir());
const identity:ProtocolIdentity={agent:'codex',nativeId:'00000000-0000-4000-8000-000000000001',model:'fixture',cwd:home,home,route:'direct'};
function fixture(journal=new EffectJournal(':memory:'), room='room-a', fn?:(id:string,text:string)=>Promise<ProtocolTurn>) {
 let calls=0;
 const session:NativeProtocolSession={idle:true,pendingApproval:false,open:async()=>identity,close:async()=>{},turn:async(id,text)=>{calls++;return fn?fn(id,text):{nativeId:identity.nativeId,operationId:id,turnId:'turn-1',text:'reply',state:'completed'};}};
 return {journal,session,host:new ProtocolTurnHost(journal,room,identity,session),calls:()=>calls};
}
test('persisted completion is historical on exact retry, changed text never replays',async()=>{
 const f=fixture();expect((await f.host.turn('op','hello')).source).toBe('live');
 Object.assign(f.session,{idle:false,pendingApproval:true});
 expect((await f.host.turn('op','hello')).source).toBe('historical');expect(f.calls()).toBe(1);
 await expect(f.host.turn('op','changed')).rejects.toMatchObject({code:'effect_payload_conflict'});expect(f.calls()).toBe(1);f.journal.close();
});
test('final receipt cannot release admission with a newly pending approval',async()=>{
 const f=fixture();
 f.session.turn=async(operationId)=>{
  Object.assign(f.session,{pendingApproval:true});
  return {operationId,nativeId:identity.nativeId,turnId:'t',text:'reply',state:'completed'};
 };
 await expect(f.host.turn('op','hello')).rejects.toMatchObject({code:'protocol_turn_uncertain'});
 Object.assign(f.session,{pendingApproval:false});
 await expect(f.host.turn('op','hello')).rejects.toMatchObject({code:'protocol_turn_uncertain'});
 await expect(f.host.turn('next','hello')).rejects.toMatchObject({code:'effect_room_locked'});
 f.journal.close();
});
test('same operation in flight cannot dispatch twice',async()=>{
 let finish!:(r:ProtocolTurn)=>void;const f=fixture(undefined,'a',()=>new Promise(r=>finish=r));
 const first=f.host.turn('op','hello');await expect(f.host.turn('op','hello')).rejects.toMatchObject({code:'protocol_turn_uncertain',uncertain:true});
 finish({nativeId:identity.nativeId,operationId:'op',turnId:'t',text:'reply',state:'completed'});expect((await first).source).toBe('live');expect(f.calls()).toBe(1);f.journal.close();
});
test('different logical room and operation labels cannot write same native session concurrently',async()=>{
 const journal=new EffectJournal(':memory:');let finish!:(r:ProtocolTurn)=>void;
 const a=fixture(journal,'a',()=>new Promise(r=>finish=r)),b=fixture(journal,'b');const first=a.host.turn('same-op','a');
 await expect(b.host.turn('same-op','b')).rejects.toMatchObject({code:'protocol_turn_uncertain'});expect(b.calls()).toBe(0);
 finish({nativeId:identity.nativeId,operationId:'same-op',turnId:'t',text:'reply',state:'completed'});await first;journal.close();
});
test('disconnect persists uncertainty across store reopen without sending again',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'maw-protocol-journal-')),file=join(dir,'effects.sqlite');
 try{
  const one=fixture(new EffectJournal(file),'a',async()=>{throw Error('private transport error');});
  await expect(one.host.turn('op','hello')).rejects.toMatchObject({code:'protocol_turn_uncertain'});expect(one.calls()).toBe(1);one.journal.close();
  const two=fixture(new EffectJournal(file),'a');await expect(two.host.turn('op','hello')).rejects.toMatchObject({code:'protocol_turn_uncertain'});expect(two.calls()).toBe(0);two.journal.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('UUID case aliases collide across independent journal connections',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'maw-protocol-alias-')),file=join(dir,'effects.sqlite');
 const firstJournal=new EffectJournal(file),secondJournal=new EffectJournal(file);
 let finish!:(r:ProtocolTurn)=>void;let otherCalls=0;
 const lower={...identity,nativeId:'abcdefab-1234-4000-8000-abcdefabcdef'};
 const upper={...lower,nativeId:lower.nativeId.toUpperCase()};
 const a:NativeProtocolSession={idle:true,pendingApproval:false,open:async()=>lower,close:async()=>{},turn:()=>new Promise(r=>finish=r)};
 const b:NativeProtocolSession={...a,turn:async()=>{otherCalls++;throw Error('must not dispatch');}};
 try {
  const pending=new ProtocolTurnHost(firstJournal,'lower',lower,a).turn('one','hello');
  await expect(new ProtocolTurnHost(secondJournal,'upper',upper,b).turn('two','hello')).rejects.toMatchObject({code:'protocol_turn_uncertain'});
  expect(otherCalls).toBe(0);
  finish({operationId:'one',nativeId:lower.nativeId,turnId:'t',text:'reply',state:'completed'});
  await pending;
 } finally {firstJournal.close();secondJournal.close();rmSync(dir,{recursive:true,force:true});}
});
test('busy state rejects before any turn and mismatched final stays uncertain',async()=>{
 const f=fixture();Object.assign(f.session,{idle:false});await expect(f.host.turn('a','hello')).rejects.toMatchObject({code:'protocol_session_busy'});expect(f.calls()).toBe(0);
 Object.assign(f.session,{idle:true,pendingApproval:true});await expect(f.host.turn('b','hello')).rejects.toMatchObject({code:'protocol_session_busy'});f.journal.close();
 const bad=fixture(undefined,'bad',async(id)=>({operationId:id,nativeId:'foreign',turnId:'t',text:'reply',state:'completed'}));
 await expect(bad.host.turn('op','hello')).rejects.toMatchObject({code:'protocol_turn_uncertain'});await expect(bad.host.turn('op','hello')).rejects.toMatchObject({code:'protocol_turn_uncertain'});expect(bad.calls()).toBe(1);bad.journal.close();
});
