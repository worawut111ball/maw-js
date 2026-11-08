/** Pure context-only/no-tools delivery verification. No retrieval or semantic certification. */
import {createHash} from 'node:crypto';
import {ContinuityError,type Room,type Binding,type ContextDelivery,type DeliveryReceipt} from '../types';
import type {NativeRecords} from '../native-records';
import type {RuntimeStartReceipt} from './runtime-host';

/** All inputs must come from the owned host/native reader, never HTTP or model JSON. */
export function verifyProtocolContextDelivery(input:{
  room:Room;binding:Binding;context:ContextDelivery;start:RuntimeStartReceipt;records:NativeRecords;
}):DeliveryReceipt {
  const {room,binding:b,context:c,start:s,records:r}=input;
  const reject=():never=>{throw new ContinuityError('protocol_context_delivery_unverified');};
  if(!c.id||room.operationId!==c.id||typeof c.text!=='string'||!c.text.trim()
    ||Buffer.byteLength(c.text)>32_000||createHash('sha256').update(c.text).digest('hex')!==c.hash
    ||!Number.isSafeInteger(c.throughSeq)||c.throughSeq<0)return reject();
  const t=s.firstTurn,identity=s.identity;
  if(s.source!=='live'||!t||t.state!=='completed'||t.operationId!==c.id+':context'
    ||!identity||identity.agent!==b.agent||identity.nativeId!==b.nativeId||identity.cwd!==room.cwd
    ||identity.model!==b.model||identity.route!==b.route||t.nativeId!==b.nativeId
    ||!Number.isSafeInteger(s.generation)||s.generation<1
    ||!new RegExp('^protocol:'+b.agent+':[a-f0-9]{64}:'+s.generation+'$').test(b.generation)
    ||typeof t.text!=='string'||!t.text.trim()||typeof t.turnId!=='string'||!t.turnId)return reject();
  if(r.nativeId!==b.nativeId||r.cwd!==room.cwd||r.model!==b.model||r.turnComplete!==true
    ||r.pendingTools!==false||r.refused!==false||r.interrupted!==false||!Array.isArray(r.events)||!Array.isArray(r.assistantMessages))return reject();
  const answers=r.assistantMessages.filter(a=>a.final===true&&(b.agent==='claude'
    ?a.replyToSourceId===`claude:${b.nativeId}:message:${t.turnId}`:a.turnId===t.turnId));
  if(answers.length!==1)return reject();
  const a=answers[0],users=r.events.filter(e=>e.sourceId===a.replyToSourceId),finals=r.events.filter(e=>e.sourceId===a.sourceId);
  if(users.length!==1||finals.length!==1)return reject();
  const u=users[0],f=finals[0];
  if(![u.index,f.index,a.index,a.replyToIndex].every(x=>Number.isSafeInteger(x)&&x>=0)
    ||!u.sourceId.startsWith(`${b.agent}:${b.nativeId}:message:`)||!f.sourceId.startsWith(`${b.agent}:${b.nativeId}:message:`)
    ||u.role!=='user'||u.text!==c.text||u.index!==a.replyToIndex||f.role!=='assistant'||f.index!==a.index
    ||u.index>=f.index||f.text!==t.text||a.text!==t.text||f.metadata?.final!==true
    ||f.metadata?.replyToSourceId!==u.sourceId||f.metadata?.replyToIndex!==u.index
    ||b.agent==='codex'&&f.metadata?.turnId!==t.turnId
    ||r.lastUserSourceId!==u.sourceId||r.lastUserIndex!==u.index
    ||r.events.some(e=>e.index>f.index||e.index>u.index&&e.role==='tool'))return reject();
  return {state:'acknowledged',nativeId:b.nativeId,hash:c.hash,throughSeq:c.throughSeq};
}
