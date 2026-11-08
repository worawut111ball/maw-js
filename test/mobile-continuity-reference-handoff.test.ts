import {afterEach,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EffectJournal} from '../src/mobile/continuity/effect-journal';
import {ReferenceHandoff,type ReferenceHandoffPorts} from '../src/mobile/continuity/reference-handoff';
import type {PrepareReceiptInput,PreparedReceipt,ReceiptVerification} from '../src/mobile/continuity/context-receipt';
import type {NativeRecords} from '../src/mobile/continuity/native-records';
const roots:string[]=[],journals:EffectJournal[]=[];
afterEach(()=>{journals.splice(0).forEach(j=>j.close());roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'reference-handoff-'));roots.push(root);const journal=new EffectJournal(join(root,'effects.sqlite'));journals.push(journal);
 const input:PrepareReceiptInput={context:{text:'fixture',hash:'a'.repeat(64),throughSeq:2},roomId:'room',nativeId:'11111111-1111-4111-8111-111111111111',generation:'g1',expectedFacts:{job:'fixture'},privateRoot:root,operationId:'op1'};
 const prepared={requestText:'Read private reference',manifest:{roomId:input.roomId,operationId:input.operationId,nativeId:input.nativeId,generation:input.generation,contextHash:input.context.hash,requestHash:createHash('sha256').update('Read private reference').digest('hex')}} as PreparedReceipt;
 const records={nativeId:input.nativeId,lastUserSourceId:'user',events:[{sourceId:'user',role:'user',text:'Read private reference'}],assistantMessages:[{sourceId:'reply',replyToSourceId:'user',final:true}]} as NativeRecords;
 // An explicitly unverified result demonstrates this orchestrator cannot manufacture acceptance.
 const receipt:ReceiptVerification={verified:false,state:'unknown',reason:'fixture_not_retrieved'};
 let prepares=0,sends=0,reads=0,verifies=0,binding=true,lost=false,afterRead:undefined|(()=>void);
 const ports:ReferenceHandoffPorts={prepare:async()=>{prepares++;return structuredClone(prepared);},send:async()=>{sends++;if(lost)throw Error('lost_ack');return {nativeId:input.nativeId,assistantEventIds:['reply']};},read:async()=>{reads++;afterRead?.();return records;},assertBinding:async()=>binding,verify:async(_m,_r,user)=>{expect(user).toBe('user');verifies++;return receipt;}};
 return {journal,input,ports,records,prepared,receipt,run:()=>new ReferenceHandoff(journal,ports).run(input),counts:()=>({prepares,sends,reads,verifies}),lose:()=>{lost=true;},unbind:()=>{binding=false;},afterRead:(f:()=>void)=>{afterRead=f;}};
}
test('persists prepare/send/result without upgrading unknown and replay never re-sends or steals newer lock',async()=>{const f=fixture();expect(await f.run()).toEqual(f.receipt);f.journal.release('room','op1');f.journal.acquire('room','new-owner');f.journal.close();f.unbind();expect(await f.run()).toEqual(f.receipt);expect(f.counts()).toEqual({prepares:1,sends:1,reads:1,verifies:1});expect(()=>f.journal.acquire('room','op1')).toThrow('effect_room_locked');});
test('lost send ACK stays uncertain across reopen without prepare/send replay',async()=>{const f=fixture();f.lose();await expect(f.run()).rejects.toThrow('lost_ack');f.journal.close();await expect(f.run()).rejects.toThrow('reference_effect_uncertain');expect(f.counts().prepares).toBe(1);expect(f.counts().sends).toBe(1);});
test('completed operation reused with changed input is rejected',async()=>{const f=fixture();await f.run();f.input.generation='g2';await expect(f.run()).rejects.toThrow('reference_payload_changed');expect(f.counts().sends).toBe(1);});
test('changed binding after native read prevents any receipt persistence',async()=>{const f=fixture();f.afterRead(f.unbind);await expect(f.run()).rejects.toThrow('reference_binding_changed');expect(f.journal.status('room','op1','reference-result').state).toBe('unknown');expect(f.counts().verifies).toBe(0);});
test('prepared native mismatch never sends',async()=>{const f=fixture();f.prepared.manifest.nativeId='wrong';await expect(f.run()).rejects.toThrow('reference_prepared_binding_changed');expect(f.counts().sends).toBe(0);});
test.each(['missing','nonfinal','multiple'])('rejects %s final prompt links',async kind=>{const f=fixture();if(kind==='missing')f.records.assistantMessages=[];else if(kind==='nonfinal')f.records.assistantMessages[0].final=false;else f.records.assistantMessages[0].replyToSourceId='';await expect(f.run()).rejects.toThrow('reference_prompt_link_missing');expect(f.counts().verifies).toBe(0);});
test('restart after read failure reuses exact prepared artifact and acknowledged send',async()=>{const f=fixture(),read=f.ports.read;f.ports.read=async()=>{throw Error('temporary_read_failure');};await expect(f.run()).rejects.toThrow('temporary_read_failure');f.journal.close();f.ports.read=read;expect(await f.run()).toEqual(f.receipt);expect(f.counts().prepares).toBe(1);expect(f.counts().sends).toBe(1);});


test('explicit native reconciliation of lost ACK never replays prepare/send',async()=>{const f=fixture();f.lose();await expect(f.run()).rejects.toThrow('lost_ack');const receipt={verified:true,state:'verified',disposition:'accepted-reference',nativeId:f.input.nativeId,generation:f.input.generation,contextHash:f.input.context.hash,throughSeq:f.input.context.throughSeq,summary:'fixture reference',proof:{}} as ReceiptVerification;f.ports.verify=async()=>receipt;f.journal.close();expect(await new ReferenceHandoff(f.journal,f.ports).reconcile(f.input)).toEqual(receipt);expect(f.counts().sends).toBe(1);expect(f.counts().prepares).toBe(1);expect(f.journal.status('room','op1','reference-send').state).toBe('acknowledged');});
test('unverified reconciliation keeps uncertainty and never sends',async()=>{const f=fixture();f.lose();await expect(f.run()).rejects.toThrow('lost_ack');await expect(new ReferenceHandoff(f.journal,f.ports).reconcile(f.input)).rejects.toThrow('reference_reconciliation_unverified');expect(f.journal.status('room','op1','reference-send').state).toBe('uncertain');expect(f.counts().sends).toBe(1);});
test('reconciliation cannot create a dispatch or adopt a changed prompt',async()=>{const f=fixture();await expect(new ReferenceHandoff(f.journal,f.ports).reconcile(f.input)).rejects.toThrow('reference_reconciliation_unavailable');expect(f.counts().sends).toBe(0);f.lose();await expect(f.run()).rejects.toThrow('lost_ack');f.records.events[0].text='another prompt';await expect(new ReferenceHandoff(f.journal,f.ports).reconcile(f.input)).rejects.toThrow('reference_prompt_link_missing');expect(f.counts().sends).toBe(1);});

test('cross-mode prepared manifest never dispatches',async()=>{const f=fixture();f.input.mode='native-full-retrieval';await expect(f.run()).rejects.toThrow('reference_protocol_changed');expect(f.counts().sends).toBe(0);});
test('prepared request text drift never dispatches',async()=>{const f=fixture();f.prepared.requestText='changed request';await expect(f.run()).rejects.toThrow('reference_request_changed');expect(f.counts().sends).toBe(0);});
test('completed operation cannot reuse receipt across modes',async()=>{const f=fixture();await f.run();f.input.mode='native-full-retrieval';await expect(f.run()).rejects.toThrow('reference_payload_changed');expect(f.counts().sends).toBe(1);});
test('protocol version mismatch blocks before send',async()=>{const f=fixture();(f.input as any).version=2;await expect(f.run()).rejects.toThrow('reference_protocol_changed');expect(f.counts().sends).toBe(0);});
