/** Durable reference verification only. Never changes active routing, permissions, or held messages. */
import { createHash } from 'node:crypto';
import { EffectJournal } from './effect-journal';
import type { PrepareReceiptInput, ReceiptVerification, TrustedReceiptManifest } from './context-receipt';
import type { NativeRecords } from './native-records';
export interface ReferenceManifest {
  roomId:string;operationId:string;nativeId:string;generation:string;contextHash:string;requestHash:string;
  mode?:string;version?:number;
}
export type ReferenceResult = {verified:true;state:'verified';mode?:string;version?:number;nativeId:string;generation:string;contextHash:string;throughSeq:number;summary:string} | {verified:false;state:'rejected'|'unknown';reason:string};
export interface ReferenceHandoffPorts<M extends ReferenceManifest=TrustedReceiptManifest,R extends ReferenceResult=ReceiptVerification> {
  prepare(input: PrepareReceiptInput): Promise<{requestText:string;manifest:M}>;
  send(text: string): Promise<{nativeId:string;assistantEventIds:string[]}>;
  read(): Promise<NativeRecords>;
  /** Must re-observe exact native/process generation; configured metadata alone is insufficient. */
  assertBinding(): Promise<boolean>;
  verify(manifest: M, records: NativeRecords, userSourceId: string): Promise<R>;
}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(code:string):never=>{throw new Error(code);};
/** Call only under a separately acquired writer fence. Durable uncertain stages never resend. */
export class ReferenceHandoff<M extends ReferenceManifest=TrustedReceiptManifest,R extends ReferenceResult=ReceiptVerification> {
  constructor(private journal:EffectJournal,private ports:ReferenceHandoffPorts<M,R>){}
  private checkPrepared(input:PrepareReceiptInput,prepared:{requestText:string;manifest:M}):void{
    const version=(input as PrepareReceiptInput & {version?:number}).version??1;
    const m=prepared.manifest;
    if((m.mode??'challenge-receipt')!==(input.mode??'challenge-receipt')||(m.version??1)!==version)fail('reference_protocol_changed');
    if(m.nativeId!==input.nativeId||m.generation!==input.generation||m.roomId!==input.roomId||m.operationId!==input.operationId||m.contextHash!==input.context.hash)fail('reference_prepared_binding_changed');
    if(createHash('sha256').update(prepared.requestText).digest('hex')!==m.requestHash)fail('reference_request_changed');
  }
  /** Explicit read-only recovery of a lost outer ACK. Never calls prepare or send. */
  async reconcile(input:PrepareReceiptInput):Promise<R>{
    input=structuredClone(input);
    const preparedState=this.journal.status(input.roomId,input.operationId,'reference-prepare');
    const sendState=this.journal.status(input.roomId,input.operationId,'reference-send');
    if(preparedState.state!=='acknowledged'||!['dispatching','uncertain'].includes(sendState.state))fail('reference_reconciliation_unavailable');
    // Check the persisted payload fingerprint without granting a new dispatch permit.
    const checked=this.journal.claim({roomId:input.roomId,operationId:input.operationId,step:'reference-prepare',payload:{inputHash:digest(input)}});
    if(checked.state!=='acknowledged')fail('reference_reconciliation_unavailable');
    const prepared=checked.result as {requestText:string;manifest:M};
    this.checkPrepared(input,prepared);
    if(!await this.ports.assertBinding())fail('reference_binding_changed');
    const records=await this.ports.read();
    const user=records.events.find(e=>e.sourceId===records.lastUserSourceId&&e.role==='user');
    if(!user)return fail('reference_prompt_link_missing');
    if(createHash('sha256').update(user.text).digest('hex')!==prepared.manifest.requestHash)fail('reference_prompt_link_missing');
    const receipt=await this.ports.verify(prepared.manifest,records,user.sourceId);
    if(!receipt.verified||receipt.nativeId!==input.nativeId||receipt.generation!==input.generation||receipt.contextHash!==input.context.hash||receipt.throughSeq!==input.context.throughSeq||(receipt.mode??'challenge-receipt')!==(input.mode??'challenge-receipt')||(receipt.version??1)!==(input.version??1))fail('reference_reconciliation_unverified');
    const replies=records.assistantMessages.filter(e=>e.final&&e.replyToSourceId===user.sourceId);
    if(!replies.length||records.nativeId!==input.nativeId||!await this.ports.assertBinding())fail('reference_binding_changed');
    // Verification is an observation, not dispatch permission; existing uncertain input is not replayed.
    this.journal.acknowledge(input.roomId,input.operationId,'reference-send',{nativeId:input.nativeId,assistantEventIds:replies.map(e=>e.sourceId)});
    return this.run(input);
  }
  private async stage<T>(input:PrepareReceiptInput,step:string,payload:unknown,action:()=>Promise<T>):Promise<T>{
    const key={roomId:input.roomId,operationId:input.operationId,step:'reference-'+step,payload};
    const claim=this.journal.claim(key);
    if(claim.state==='acknowledged')return claim.result as T;
    if(claim.state!=='claimed')fail('reference_effect_uncertain');
    try{const result=await action();this.journal.acknowledge(key.roomId,key.operationId,key.step,result);return result;}
    catch(error){this.journal.uncertain(key.roomId,key.operationId,key.step);throw error;}
  }
  async run(input:PrepareReceiptInput):Promise<R>{
    input=structuredClone(input);
    const identity={roomId:input.roomId,operationId:input.operationId,nativeId:input.nativeId,generation:input.generation,contextHash:input.context.hash};
    // Read previously committed result without reacquiring a completed operation's room lock.
    const completed=this.journal.status(input.roomId,input.operationId,'reference-result');
    if(completed.state==='acknowledged'){
      const stored=completed.result as {inputHash:string;receipt:R};
      if(stored.inputHash!==digest(input))fail('reference_payload_changed');
      return stored.receipt; // Historical evidence only; does not assert current readiness.
    }
    if(!await this.ports.assertBinding())fail('reference_binding_changed');
    const prepared=await this.stage(input,'prepare',{inputHash:digest(input)},()=>this.ports.prepare(input));
    this.checkPrepared(input,prepared);
    const sent=await this.stage(input,'send',{...identity,requestHash:prepared.manifest.requestHash},async()=>{
      if(!await this.ports.assertBinding())fail('reference_binding_changed');
      return this.ports.send(prepared.requestText);
    });
    if(sent.nativeId!==input.nativeId||!sent.assistantEventIds.length||new Set(sent.assistantEventIds).size!==sent.assistantEventIds.length)fail('reference_delivery_mismatch');
    const records=await this.ports.read();
    if(!await this.ports.assertBinding())fail('reference_binding_changed');
    const replies=records.assistantMessages.filter(e=>sent.assistantEventIds.includes(e.sourceId));
    const users=new Set(replies.map(e=>e.replyToSourceId));
    if(replies.length!==sent.assistantEventIds.length||users.size!==1||!replies.every(e=>e.final)||!replies[0]?.replyToSourceId)fail('reference_prompt_link_missing');
    const receipt=await this.ports.verify(prepared.manifest,records,replies[0].replyToSourceId);
    if(receipt.verified&&((receipt.mode??'challenge-receipt')!==(input.mode??'challenge-receipt')||receipt.nativeId!==input.nativeId||receipt.generation!==input.generation||receipt.contextHash!==input.context.hash||receipt.throughSeq!==input.context.throughSeq||(receipt.version??1)!==(input.version??1)))fail('reference_verified_binding_changed');
    if(!await this.ports.assertBinding())fail('reference_binding_changed');
    const result=await this.stage(input,'result',{...identity,inputHash:digest(input),assistantEventIds:sent.assistantEventIds},async()=>({inputHash:digest(input),receipt}));
    return result.receipt;
  }
}
