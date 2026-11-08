import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { EffectJournal } from '../effect-journal';
import { ProtocolError, type NativeProtocolSession, type ProtocolIdentity, type ProtocolTurn } from './types';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 256 && !/[\x00-\x1f]/.test(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface ProtocolTurnReceipt { source: 'live' | 'historical'; turn: ProtocolTurn }

/** Durable turn admission for a session ALREADY verified/owned by the host.
 * Does not grant launch, migration, external TUI ownership or trust authority.
 */
export class ProtocolTurnHost {
  readonly identity: Readonly<ProtocolIdentity>;
  private roomKey: string;
  private nativeKey: string;
  constructor(private journal: EffectJournal, roomId: string, identity: ProtocolIdentity, private session: NativeProtocolSession) {
    if (!id(roomId) || !identity || !['codex','claude'].includes(identity.agent) || !uuid.test(identity.nativeId)
      || !id(identity.model) || !id(identity.route)) throw new ProtocolError('protocol_host_identity_invalid');
    try {
      if (realpathSync(identity.home) !== identity.home || realpathSync(identity.cwd) !== identity.cwd) throw new Error();
    } catch { throw new ProtocolError('protocol_host_paths_unverified'); }
    this.identity = Object.freeze(structuredClone(identity));
    this.roomKey = 'protocol-room:' + hash(roomId);
    // Route/model/room labels cannot create a second writer for the same native session.
    this.nativeKey = 'protocol-native:' + hash([identity.agent,identity.home,identity.nativeId.toLowerCase()]);
  }
  async turn(operationId: string, text: string): Promise<ProtocolTurnReceipt> {
    if (!id(operationId) || typeof text !== 'string' || !text.trim() || text.includes('\0') || Buffer.byteLength(text) > 32_000)
      throw new ProtocolError('protocol_turn_invalid');
    const owner = hash([this.roomKey,operationId]);
    if (this.journal.status(this.roomKey,owner,'turn').state === 'unknown' && (!this.session.idle || this.session.pendingApproval))
      throw new ProtocolError('protocol_session_busy');
    const claim = this.journal.claim({roomId:this.roomKey,operationId:owner,step:'turn',payload:{identity:this.identity,operationId,text}});
    if (claim.state === 'acknowledged') return {source:'historical',turn:this.validate(claim.result,operationId)};
    if (claim.state !== 'claimed') throw new ProtocolError('protocol_turn_uncertain',true);
    try {
      this.journal.acquire(this.nativeKey,owner);
      if (!this.session.idle || this.session.pendingApproval) throw new ProtocolError('protocol_session_changed');
      const turn = this.validate(await this.session.turn(operationId,text),operationId);
      if (!this.session.idle || this.session.pendingApproval) throw new ProtocolError('protocol_turn_not_quiescent',true);
      this.journal.acknowledge(this.roomKey,owner,'turn',turn);
      this.journal.release(this.nativeKey,owner);
      this.journal.release(this.roomKey,owner);
      return {source:'live',turn};
    } catch {
      // Retain locks on uncertainty. Recovery must inspect the original operation; never retry input.
      try { if (this.journal.status(this.roomKey,owner,'turn').state !== 'acknowledged') this.journal.uncertain(this.roomKey,owner,'turn'); } catch {}
      throw new ProtocolError('protocol_turn_uncertain',true);
    }
  }
  private validate(value: unknown, operationId:string):ProtocolTurn {
    const v=value as ProtocolTurn;
    if (!v || v.operationId!==operationId || v.nativeId!==this.identity.nativeId || !id(v.turnId)
      || v.state!=='completed' || typeof v.text!=='string' || Buffer.byteLength(v.text)>1024*1024)
      throw new ProtocolError('protocol_turn_receipt_invalid',true);
    return {operationId:v.operationId,nativeId:v.nativeId,turnId:v.turnId,state:'completed',text:v.text};
  }
}
