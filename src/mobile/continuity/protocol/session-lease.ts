/** Cooperative protocol-host lifetime admission. No process, PTY, network, timers or TTL recovery. */
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { EffectJournal } from '../effect-journal';
import type { ProtocolAgent } from './types';

export class SessionLeaseError extends Error {
  constructor(readonly code: string, readonly uncertain = false) { super(code); this.name = 'SessionLeaseError'; }
}
export interface SessionReservation {
  roomId: string; operationId: string; agent: ProtocolAgent; toolHome: string;
  mode: 'fresh' | 'resume'; nativeId?: string;
}
/** Authority is object identity in the issuing instance, never this public string alone. */
export interface SessionLease { readonly incarnation: string }
export interface SessionLeaseView {
  incarnation: string; launchId: string; agent: ProtocolAgent; toolHome: string;
  mode: 'fresh' | 'resume'; nativeId?: string; generation?: number; runtimeBirth?: string;
  state: 'reserved' | 'launching' | 'active' | 'uncertain' | 'closing' | 'released';
}
export interface SessionExitExpected {
  incarnation: string; launchId: string; runtimeBirth: string;
}
/** Supplied by a trusted owned-child supervisor, never by a browser or native/model frame. */
export interface SessionExitObservation extends SessionExitExpected {
  source: 'owned-process-supervisor';
  exit: { code: number | null; signal: string | null };
  inputClosed: true; outputClosed: true; pendingWork: false;
}
export interface SessionReleaseReceipt {
  incarnation: string; launchId: string; runtimeBirth: string;
  agent: ProtocolAgent; toolHome: string; nativeId?: string; generation?: number;
  state: 'released';
}
export type SessionReservationResult = { state: 'reserved'; lease: SessionLease }
  | { state: 'historical'; receipt: SessionReleaseReceipt };
interface Held {
  view: SessionLeaseView; roomKey: string; operation: string; nativeKey?: string;
  launchStarted: boolean; exitVerified: boolean;
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (code: string, uncertain = false): never => { throw new SessionLeaseError(code, uncertain); };
function identifier(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !v || v.trim() !== v || v.length > 512 || /[\x00-\x1f\x7f]/.test(v)) fail('session_invalid_identity');
}
function nativeId(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !uuid.test(v)) fail('session_invalid_native_id');
}
const sessionKey = (agent: ProtocolAgent, home: string, id: string) => 'protocol-lifetime-native:' + digest([agent, home, id.toLowerCase()]);

export class ProtocolSessionLeases {
  private held = new WeakMap<SessionLease, Held>();
  constructor(private journal: EffectJournal, private options: {
    observeExit: (expected: Readonly<SessionExitExpected>) => Promise<unknown>;
  }) {
    if (journal.path === ':memory:') fail('session_durable_store_required');
    if (typeof options?.observeExit !== 'function') fail('session_exit_observer_required');
    // Capture the trusted dependency; a later caller mutation cannot replace the verifier.
    this.options = { observeExit: options.observeExit };
  }
  reserve(input: SessionReservation): SessionReservationResult {
    if (!input || !['codex', 'claude'].includes(input.agent) || !['fresh', 'resume'].includes(input.mode)) fail('session_invalid_reservation');
    identifier(input.roomId); identifier(input.operationId);
    if (typeof input.toolHome !== 'string' || !isAbsolute(input.toolHome)) fail('session_home_unverified');
    let home: string;
    try { home = realpathSync(input.toolHome); if (!statSync(home).isDirectory()) fail('session_home_unverified'); }
    catch { return fail('session_home_unverified'); }
    if (input.mode === 'resume') nativeId(input.nativeId);
    else if (input.nativeId !== undefined) fail('session_fresh_has_native_id');
    const payload = { roomId: input.roomId, operationId: input.operationId, agent: input.agent,
      toolHome: home, mode: input.mode, ...(input.nativeId === undefined ? {} : { nativeId: input.nativeId }) };
    const roomKey = 'protocol-lifetime-room:' + digest(input.roomId), operation = digest(input.operationId);
    // Only a NEW durable claim grants authority. acquire(same owner) alone never does.
    const claim = this.journal.claim({ roomId: roomKey, operationId: operation, step: 'reservation', payload });
    if (claim.state === 'acknowledged') {
      const receipt = claim.result as SessionReleaseReceipt;
      if (!receipt || receipt.state !== 'released' || receipt.agent !== input.agent || receipt.toolHome !== home
        || !uuid.test(receipt.incarnation) || !uuid.test(receipt.launchId) || !receipt.runtimeBirth
        || (input.mode === 'resume' && receipt.nativeId !== input.nativeId)
        || (receipt.nativeId !== undefined && !uuid.test(receipt.nativeId))
        || (receipt.generation !== undefined && (!Number.isSafeInteger(receipt.generation) || receipt.generation < 1)))
        fail('session_historical_invalid', true);
      return { state: 'historical', receipt: structuredClone(receipt) };
    }
    if (claim.state !== 'claimed') fail('session_reservation_uncertain', true);
    const incarnation = randomUUID(), launchId = randomUUID();
    const held: Held = { roomKey, operation, launchStarted: false, exitVerified: false,
      view: { incarnation, launchId, agent: input.agent, toolHome: home, mode: input.mode,
        ...(input.nativeId === undefined ? {} : { nativeId: input.nativeId }), state: 'reserved' } };
    try {
      this.step(held, 'incarnation', { incarnation, launchId }, { incarnation, launchId });
      if (input.mode === 'resume') this.bindSession(held, input.nativeId!);
    } catch { this.uncertain(held); return fail('session_reservation_uncertain', true); }
    const lease = Object.freeze({ incarnation });
    this.held.set(lease, held);
    return { state: 'reserved', lease };
  }
  /** Persisted once before the caller may spawn. Never invokes a process. */
  beginLaunch(lease: SessionLease): Readonly<{ incarnation: string; launchId: string }> {
    const held = this.required(lease);
    if (held.view.state !== 'reserved') fail('session_launch_not_permitted', true);
    try {
      this.step(held, 'launch-permit', { ...held.view }, { launchId: held.view.launchId });
      held.launchStarted = true; held.view.state = 'launching';
      return Object.freeze({ incarnation: held.view.incarnation, launchId: held.view.launchId });
    } catch { this.uncertain(held); return fail('session_launch_uncertain', true); }
  }
  /** Trusted supervisor identity, composite birth token rather than a PID alone. */
  bindRuntime(lease: SessionLease, runtime: { launchId: string; runtimeBirth: string }): void {
    const held = this.required(lease);
    if (held.view.state !== 'launching' || held.view.runtimeBirth) fail('session_runtime_not_permitted', true);
    identifier(runtime?.runtimeBirth);
    if (runtime.launchId !== held.view.launchId || /^\d+$/.test(runtime.runtimeBirth)) fail('session_runtime_mismatch', true);
    try {
      this.step(held, 'runtime', runtime, runtime);
      held.view.runtimeBirth = runtime.runtimeBirth;
    } catch { this.uncertain(held); fail('session_runtime_uncertain', true); }
  }
  /** Caller has verified the native handshake. It cannot supply or change effective toolHome. */
  verifyNative(lease: SessionLease, observation: { agent: ProtocolAgent; nativeId: string }): SessionLeaseView {
    const held = this.required(lease);
    if (held.view.state !== 'launching' || !held.view.runtimeBirth) fail('session_native_not_permitted', true);
    try {
      nativeId(observation?.nativeId);
      if (observation.agent !== held.view.agent || (held.view.mode === 'resume' && observation.nativeId !== held.view.nativeId))
        fail('session_native_mismatch', true);
      if (held.view.mode === 'fresh') this.bindSession(held, observation.nativeId);
      this.step(held, 'native', { agent: observation.agent, nativeId: observation.nativeId }, { ...held.view, state: 'active' });
      held.view.state = 'active';
      return this.assertOwned(lease);
    } catch { this.uncertain(held); return fail('session_native_uncertain', true); }
  }
  assertOwned(lease: SessionLease): SessionLeaseView {
    const held = this.required(lease);
    if (!['reserved', 'launching', 'active'].includes(held.view.state)) fail('session_not_owned', true);
    return structuredClone(held.view);
  }
  /** Integration must call this before turn admission; a reservation alone is not native verification. */
  assertActive(lease: SessionLease): SessionLeaseView {
    const view = this.assertOwned(lease);
    if (view.state !== 'active') fail('session_not_active', true);
    return view;
  }
  markUncertain(lease: SessionLease): void {
    const held = this.required(lease);
    if (['released', 'closing'].includes(held.view.state)) fail('session_not_owned', true);
    this.uncertain(held);
  }
  /** Only the injected supervisor may attest exit; no user-supplied unlock or boolean proof. */
  async release(lease: SessionLease): Promise<SessionReleaseReceipt> {
    const held = this.required(lease);
    const runtimeBirth = held.view.runtimeBirth;
    if (!held.launchStarted || !runtimeBirth || ['released', 'closing'].includes(held.view.state))
      return fail('session_exit_unverified', true);
    held.view.state = 'closing';
    const expected = Object.freeze({ incarnation: held.view.incarnation, launchId: held.view.launchId, runtimeBirth });
    try {
      if (!held.exitVerified) {
        const evidence = await this.options.observeExit(expected) as SessionExitObservation;
        const exit = evidence?.exit;
        if (!evidence || evidence.source !== 'owned-process-supervisor' || evidence.incarnation !== expected.incarnation
          || evidence.launchId !== expected.launchId || evidence.runtimeBirth !== expected.runtimeBirth
          || evidence.inputClosed !== true || evidence.outputClosed !== true || evidence.pendingWork !== false
          || !exit || !(exit.code === null || Number.isSafeInteger(exit.code)) || !(exit.signal === null || typeof exit.signal === 'string' && !!exit.signal)
          || (exit.code === null && exit.signal === null)) fail('session_exit_unverified', true);
        this.step(held, 'exit', expected, { ...expected, exit: { code: exit.code, signal: exit.signal } });
        held.exitVerified = true;
      }
      const receipt: SessionReleaseReceipt = { ...expected, agent: held.view.agent, toolHome: held.view.toolHome,
        ...(held.view.nativeId === undefined ? {} : { nativeId: held.view.nativeId }),
        ...(held.view.generation === undefined ? {} : { generation: held.view.generation }), state: 'released' };
      // ACK historical outcome BEFORE unlock. A crash may strand locks, never grant a second writer.
      this.journal.acknowledge(held.roomKey, held.operation, 'reservation', receipt);
      if (held.nativeKey) this.journal.release(held.nativeKey, held.view.incarnation);
      this.journal.release(held.roomKey, held.operation);
      held.view.state = 'released';
      return structuredClone(receipt);
    } catch { held.view.state = 'uncertain'; return fail('session_exit_unverified', true); }
  }
  private required(lease: SessionLease): Held {
    const held = lease && this.held.get(lease);
    if (!held) return fail('session_invalid_lease');
    return held;
  }
  private uncertain(held: Held): void {
    held.view.state = 'uncertain';
    try { if (this.journal.status(held.roomKey, held.operation, 'reservation').state !== 'acknowledged')
      this.journal.uncertain(held.roomKey, held.operation, 'reservation'); } catch { /* Storage failure never unlocks. */ }
  }
  private step(held: Held, step: string, payload: unknown, result: unknown): void {
    const claim = this.journal.claim({ roomId: held.roomKey, operationId: held.operation, step, payload });
    if (claim.state !== 'claimed') fail('session_stage_replayed', true);
    this.journal.acknowledge(held.roomKey, held.operation, step, result);
  }
  private bindSession(held: Held, id: string): void {
    const key = sessionKey(held.view.agent, held.view.toolHome, id);
    this.journal.acquire(key, held.view.incarnation);
    held.nativeKey = key; // Retain this lock even if generation persistence fails next.
    held.view.nativeId = id;
    // Serialized by the session lock above. This bounded append-only ledger never evicts old generations.
    const ledger = key + ':generations', owner = 'generation-ledger';
    for (let generation = 1; generation <= 10_000; generation++) {
      const prior = this.journal.status(ledger, owner, String(generation));
      if (prior.state === 'acknowledged') {
        if ((prior.result as any)?.generation !== generation) fail('session_generation_corrupt', true);
        continue;
      }
      if (prior.state !== 'unknown') fail('session_generation_uncertain', true);
      const claim = this.journal.claim({ roomId: ledger, operationId: owner, step: String(generation),
        payload: { incarnation: held.view.incarnation, generation } });
      if (claim.state !== 'claimed') fail('session_generation_uncertain', true);
      this.journal.acknowledge(ledger, owner, String(generation), { generation });
      this.journal.release(ledger, owner);
      held.view.generation = generation;
      return;
    }
    fail('session_generation_capacity', true);
  }
}
