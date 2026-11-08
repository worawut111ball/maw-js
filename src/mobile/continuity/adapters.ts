import type { EntryContract } from '../launch/prepared-entry';
/** Verified transport adapters. No default CLI execution or fake successful production adapter. */
import { createHash } from 'node:crypto';
import { ContinuityError, type Adapter, type AgentKind, type Backend, type Binding, type ContextDelivery, type DeliveryReceipt, type Inspection, type Room, type RoomEvent } from './types';
import { buildLauncherCommand, launcherProfileHash, launcherShellCommand, NATIVE_UUID, validateAbsolutePath, type LauncherCommand, type LauncherProfile } from './launcher';
export type { Adapter, Binding, Backend, AgentKind } from './types';
export interface BackendCommand { backend: Backend; args: string[]; effect: 'read' | 'input' | 'exit' | 'launch-stage' | 'launch-submit' }
export interface PolicyObservation { source: 'native-metadata' | 'verified-host-report'; value: string; processId: string; evidenceId: string }
export interface RuntimeObservation {
  roomId: string; backend: Backend; workspace: string; room: string; cwd: string;
  binding: Binding; nativeMetadataId: string; processId: string; observedAt: number;
  generationVerified: boolean; noConcurrentWriter: boolean; routeEvidence?: PolicyObservation; modelEvidence?: PolicyObservation;
  status: 'idle' | 'done' | 'working' | 'blocked' | 'unknown' | 'exited';
  turnComplete: boolean; pendingTools: boolean | null; pendingPermission: boolean | null; uncertainDelivery: boolean | null;
}
export interface CheckpointEvidence {
  binding: Binding; complete: boolean; throughEventId: string;
  events: Omit<RoomEvent, 'seq'>[];
}
export interface LaunchEvidence {
  binding: Binding; roomId: string; cwd: string; processId: string;
  nativeMetadataId: string; sourceProcessId: string; sourceGeneration: string; sourceExited: boolean;
  noConcurrentWriter: boolean; foreground: boolean; readOnlyEnforced: boolean;
  routeEvidence?: PolicyObservation; modelEvidence?: PolicyObservation; launcherProfileHash: string; home: string; codexHome?: string;
  personaVersion: string; rulesVersion: string; skillsVersion: string; hooksVersion: string;
}
export interface ContextEvidence {
  state: 'acknowledged' | 'uncertain' | 'rejected';
  /** Required for acknowledgement: native assistant evidence, not input echo/start/submit ACK. */
  rejectedBeforeDispatch?: boolean; requestId?: string; nativeId?: string; generation?: string; processId?: string; assistantEventId?: string; role?: string;
  hash?: string; throughSeq?: number; summary?: string;
  retrieval?: { verified: boolean; roomId: string; manifestHash: string; throughSeq: number };
  readOnlyEnforced?: boolean; writesObserved?: boolean; pendingWorkStarted?: boolean;
}
export interface VerifiedTransport {
  inspect(room: Room, expected?: Binding): Promise<RuntimeObservation>;
  checkpoint(room: Room, source: RuntimeObservation): Promise<CheckpointEvidence>;
  /** Implementations must journal each mutation, verify shell after source exit and recheck generation. */
  launch(room: Room, request: { operationId: string; source: RuntimeObservation; launcher: LauncherCommand; exit: BackendCommand[]; start: BackendCommand[] }): Promise<LaunchEvidence>;
  /** Must use durable delivery claim/uncertain handling; receipt validates summary + scoped retrieval. */
  deliver(room: Room, binding: Binding, context: ContextDelivery, commands: BackendCommand[]): Promise<ContextEvidence>;
}
export const REQUIRED_CAPABILITIES = [
  'exactResume', 'firstSession', 'gracefulExit', 'idleAndTools', 'readOnlyContext', 'retrieval', 'summaryReceipt',
  'ttySignals', 'homeHooks', 'personaRulesSkills', 'autostartFence', 'durableEffects', 'rollback',
] as const;
export interface BackendCertification {
  backend: Backend; source: 'fixture' | 'production'; evidenceId: string; profileHash: string;
  verifiedAt: number; expiresAt: number;
  checks: Record<typeof REQUIRED_CAPABILITIES[number], boolean>;
}
export interface ProductionActivation {
  /** Trusted host configuration only. No UI/request flag can activate production. */
  enabled: boolean; reviewId: string;
  certificates: Record<Backend, BackendCertification>;
}
export interface AdapterOptions {
  preparedEntry?: EntryContract;
  launcher: LauncherProfile; transport: VerifiedTransport; certification: BackendCertification;
  mode: 'fixture' | 'production'; activation?: ProductionActivation;
  verifyLauncher?: (profile: LauncherProfile) => Promise<{ profileHash: string; filesUnchanged: boolean; observedAt: number }>;
  allowDir: (cwd: string) => string | null; now?: () => number; maxObservationAgeMs?: number;
}
const BACKENDS: Backend[] = ['herdr', 'tmux', 'superset'];
const ROLES = new Set(['user', 'assistant', 'tool', 'agent', 'system']);
const REQUEST = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const textDigest = (v: string) => createHash('sha256').update(v).digest('hex');
const copy = <T>(v: T): T => structuredClone(v);
function fail(code: string, status = 409): never { throw new ContinuityError(code, status); }
function validBinding(b: Binding): boolean {
  return !!b && ['codex', 'claude'].includes(b.agent) && typeof b.nativeId === 'string' && NATIVE_UUID.test(b.nativeId)
    && typeof b.generation === 'string' && b.generation.length > 0 && b.generation.length <= 256
    && Number.isSafeInteger(b.cursor) && b.cursor >= 0;
}
const sameBinding = (a: Binding, b: Binding) => a.agent === b.agent && a.nativeId === b.nativeId && a.generation === b.generation && a.route === b.route && a.model === b.model;
function policyVerified(proof: PolicyObservation | undefined, value: string | undefined, processId: string): boolean {
  return value === undefined ? proof === undefined : !!proof && ['native-metadata', 'verified-host-report'].includes(proof.source) && proof.value === value && proof.processId === processId && typeof proof.evidenceId === 'string' && !!proof.evidenceId;
}
function address(room: Room): { backend: Backend; workspace: string; pane: string } {
  if (!room || !BACKENDS.includes(room.backend) || typeof room.workspace !== 'string' || typeof room.room !== 'string') fail('backend_address_invalid');
  if (room.backend === 'herdr') {
    const workspace = room.workspace.replace(/^herdr:/, '');
    if (!/^w[A-Za-z0-9]+$/.test(workspace) || !new RegExp(`^${workspace}:p[A-Za-z0-9]+$`).test(room.room)) fail('backend_address_invalid');
    return { backend: room.backend, workspace, pane: room.room };
  }
  if (room.backend === 'tmux') {
    if (!/^%\d+$/.test(room.room) || !(room.workspace === 'tmux' || room.workspace.startsWith('dir:'))) fail('backend_address_invalid');
    return { backend: room.backend, workspace: room.workspace, pane: room.room };
  }
  if (!NATIVE_UUID.test(room.workspace) || !NATIVE_UUID.test(room.room)) fail('backend_address_invalid');
  return { backend: room.backend, workspace: room.workspace, pane: room.room };
}
function command(backend: Backend, effect: BackendCommand['effect'], args: string[]): BackendCommand { return { backend, effect, args }; }
export function buildInspectCommands(room: Room): BackendCommand[] {
  const a = address(room);
  if (a.backend === 'herdr') return [command(a.backend, 'read', ['--session', 'default', 'api', 'snapshot']), command(a.backend, 'read', ['--session', 'default', 'pane', 'process-info', '--pane', a.pane])];
  if (a.backend === 'tmux') return [command(a.backend, 'read', ['display-message', '-p', '-t', a.pane, '#{pane_id}|#{pane_pid}|#{pane_current_path}|#{pane_current_command}|#{pane_dead}'])];
  return [command(a.backend, 'read', ['agents', 'explain', '--local', '--workspace', a.workspace, '--terminal', a.pane, '--json'])];
}
export function buildSendCommands(room: Room, text: string, effect: 'input' | 'exit' = 'input'): BackendCommand[] {
  const a = address(room);
  if (typeof text !== 'string' || !text.length || text.includes('\0') || Buffer.byteLength(text) > 64_000) fail('context_input_invalid');
  if (a.backend === 'herdr') {
    // CLI help does not certify a leading-option positional escape. Refuse rather than guess flags/alter input.
    if (text.startsWith('-')) fail('leading_option_text_unsupported');
    return [command(a.backend, effect, ['--session', 'default', 'agent', 'prompt', a.pane, text])];
  }
  if (a.backend === 'tmux') return [command(a.backend, effect, ['send-keys', '-t', a.pane, '-l', text]), command(a.backend, effect, ['send-keys', '-t', a.pane, 'Enter'])];
  return [command(a.backend, effect, ['terminals', 'send', '--local', '--workspace', a.workspace, '--terminal', a.pane, '--text', text, '--json'])];
}
export const buildExitCommands = (room: Room) => buildSendCommands(room, '/exit', 'exit');
export function buildLaunchCommands(room: Room, launcher: LauncherCommand): BackendCommand[] {
  const a = address(room), line = launcherShellCommand(launcher);
  if (launcher.cwd !== room.cwd) fail('launcher_cwd_mismatch');
  // Intentional shell input only after transport has verified source exited, empty input and shell foreground.
  // Herdr agent start selects a canonical executable; it cannot wrap the arbitrary team-2 entry.
  if (a.backend === 'herdr') return [command(a.backend, 'launch-stage', ['--session', 'default', 'pane', 'send-text', a.pane, line]), command(a.backend, 'launch-submit', ['--session', 'default', 'pane', 'send-keys', a.pane, 'enter'])];
  if (a.backend === 'tmux') return [command(a.backend, 'launch-stage', ['send-keys', '-t', a.pane, '-l', line]), command(a.backend, 'launch-submit', ['send-keys', '-t', a.pane, 'Enter'])];
  return [command(a.backend, 'launch-stage', ['terminals', 'send', '--local', '--workspace', a.workspace, '--terminal', a.pane, '--text', line, '--no-submit', '--json']), command(a.backend, 'launch-submit', ['terminals', 'send', '--local', '--workspace', a.workspace, '--terminal', a.pane, '--keys', 'enter', '--json'])];
}
function certificateReason(cert: BackendCertification | undefined, backend: Backend, profileHash: string, now: number, mode: AdapterOptions['mode']): string | undefined {
  if (!cert || cert.backend !== backend || cert.source !== mode || !cert.evidenceId) return 'backend_certification_missing';
  if (cert.profileHash !== profileHash) return 'launcher_certification_stale';
  if (!Number.isFinite(cert.verifiedAt) || !Number.isFinite(cert.expiresAt) || cert.verifiedAt > now || cert.expiresAt <= now) return 'backend_certification_expired';
  if (REQUIRED_CAPABILITIES.some(k => cert.checks?.[k] !== true)) return 'backend_contract_incomplete';
}
/** No executable runner is supplied by default. A trusted host must wire and certify real ports. */
export function createTransportAdapter(backend: Backend, options: AdapterOptions): Adapter {
  const mode = options.mode;
  const now = options.now ?? Date.now, maxAge = options.maxObservationAgeMs ?? 5000;
  if (!BACKENDS.includes(backend) || !Number.isFinite(maxAge) || maxAge < 1 || maxAge > 30_000) fail('adapter_options_invalid', 400);
  // Freeze policy/catalog/certification at construction; do not change identity mid-operation via mutable config.
  const profile = copy(options.launcher), cert = copy(options.certification), activation = options.activation ? copy(options.activation) : undefined;
  const effects = new Map<string, { hash: string; result: Promise<unknown> }>();
  const readiness = (room: Room, target: AgentKind, model?: string): { ready: boolean; reason?: string } => {
    try {
      if (room.backend !== backend) return { ready: false, reason: 'backend_mismatch' };
      address(room); validateAbsolutePath(room.cwd);
      if (options.allowDir(room.cwd) !== room.cwd) return { ready: false, reason: 'room_directory_unverified' };
      const profileHash = launcherProfileHash(profile), reason = certificateReason(cert, backend, profileHash, now(), mode);
      if (reason) return { ready: false, reason };
      if (mode === 'production') {
        if (profile.boundary !== 'prepared-host') return { ready: false, reason: 'launcher_host_boundary_uncertified' };
        if (!activation?.enabled || !activation.reviewId) return { ready: false, reason: 'production_activation_required' };
        for (const kind of BACKENDS) {
          const problem = certificateReason(activation.certificates?.[kind], kind, profileHash, now(), 'production');
          if (problem) return { ready: false, reason: 'all_three_backends_required' };
        }
      }
      buildLauncherCommand(profile, { target, cwd: room.cwd, model, existing: room.bindings[target] }, options.preparedEntry);
      return { ready: true };
    } catch (e) { return { ready: false, reason: e instanceof ContinuityError ? e.code : 'launcher_contract_unavailable' }; }
  };
  const preflight = async (room: Room, target: AgentKind, model?: string) => {
    const result = readiness(room, target, model); if (!result.ready || mode !== 'production') return result;
    if (!options.verifyLauncher) return { ready: false, reason: 'launcher_files_unverified' };
    try { const proof = await options.verifyLauncher(copy(profile));
      if (!proof || proof.filesUnchanged !== true || proof.profileHash !== launcherProfileHash(profile) || !Number.isFinite(proof.observedAt) || proof.observedAt > now() + 1000 || now() - proof.observedAt > maxAge) return { ready: false, reason: 'launcher_files_unverified' };
      return readiness(room, target, model);
    } catch { return { ready: false, reason: 'launcher_files_unverified' }; }
  };
  const observation = async (room: Room, expected?: Binding): Promise<RuntimeObservation> => {
    if (room.backend !== backend) fail('backend_mismatch'); address(room);
    const wanted = expected ?? room.bindings[room.active]; if (!wanted || !validBinding(wanted)) fail('source_binding_missing');
    const value = await options.transport.inspect(copy(room), copy(wanted));
    if (!value || value.roomId !== room.id || value.backend !== backend || value.workspace !== room.workspace || value.room !== room.room
      || value.cwd !== room.cwd || !validBinding(value.binding) || !sameBinding(value.binding, wanted) || value.nativeMetadataId !== wanted.nativeId
      || (wanted.model !== undefined && value.binding.model !== wanted.model) || (wanted.route !== undefined && value.binding.route !== wanted.route)
      || !value.processId || !policyVerified(value.routeEvidence, value.binding.route, value.processId) || !policyVerified(value.modelEvidence, value.binding.model, value.processId) || value.generationVerified !== true || value.noConcurrentWriter !== true
      || !Number.isFinite(value.observedAt) || value.observedAt > now() + 1000 || now() - value.observedAt > maxAge
      || !['idle', 'done', 'working', 'blocked', 'unknown', 'exited'].includes(value.status)) fail('runtime_identity_unverified');
    return copy(value);
  };
  const safe = (o: RuntimeObservation) => ['idle', 'done'].includes(o.status) && o.turnComplete === true
    && o.pendingTools === false && o.pendingPermission === false && o.uncertainDelivery === false;
  const once = <T>(key: string, payload: unknown, fn: () => Promise<T>): Promise<T> => {
    const hash = digest(payload), old = effects.get(key);
    if (old) { if (old.hash !== hash) fail('adapter_request_conflict'); return old.result as Promise<T>; }
    if (effects.size >= 1000) fail('adapter_journal_full', 503);
    const result = Promise.resolve().then(fn); effects.set(key, { hash, result }); return result;
  };
  const requireReady = async (room: Room, target: AgentKind, model?: string) => { const result = await preflight(room, target, model); if (!result.ready) fail(result.reason!); };
  return {
    async preflight(room, target, model) { return preflight(room, target, model); },
    async inspect(room): Promise<Inspection> {
      const value = await observation(room);
      return { binding: value.binding, idle: safe(value), pendingTools: value.pendingTools !== false,
        pendingPermission: value.pendingPermission !== false, uncertainDelivery: value.uncertainDelivery !== false };
    },
    async checkpoint(room) {
      const before = await observation(room); if (!safe(before)) fail('source_not_at_safe_point');
      const evidence = await options.transport.checkpoint(copy(room), before);
      const after = await observation(room);
      if (!safe(after) || before.processId !== after.processId || !evidence || evidence.complete !== true || !evidence.throughEventId || !validBinding(evidence.binding) || !sameBinding(before.binding, evidence.binding)) fail('checkpoint_unverified');
      if (!Array.isArray(evidence.events) || evidence.events.length > 100_000) fail('checkpoint_unverified');
      const sourceIds = new Set<string>(); let size = 0;
      for (const event of evidence.events) {
        if (!event || event.agent !== before.binding.agent || event.nativeId !== before.binding.nativeId || typeof event.sourceId !== 'string' || !event.sourceId || sourceIds.has(event.sourceId) || !ROLES.has(event.role) || typeof event.text !== 'string') fail('checkpoint_identity_mismatch');
        sourceIds.add(event.sourceId); size += Buffer.byteLength(JSON.stringify(event));
        if (size > 64 * 1024 * 1024) fail('checkpoint_budget_exceeded');
      }
      return copy(evidence.events);
    },
    async launch(room, target, existing, model) {
      await requireReady(room, target, model);
      if (!room.operationId || !REQUEST.test(room.operationId)) fail('operation_id_required');
      const registered = room.bindings[target];
      if (!!registered !== !!existing || (existing && (!registered || !sameBinding(registered, existing)))) fail('target_binding_mismatch');
      const launcher = buildLauncherCommand(profile, { target, cwd: room.cwd, existing, model }, options.preparedEntry);
      return once(`launch:${room.id}:${room.operationId}`, { target, existing, launcher, revision: room.revision }, async () => {
        const source = await observation(room); if (!safe(source)) fail('source_not_at_safe_point');
        await requireReady(room, target, model);
        const proof = await options.transport.launch(copy(room), { operationId: room.operationId!, source: copy(source), launcher: copy(launcher), exit: buildExitCommands(room), start: buildLaunchCommands(room, launcher) });
        if (!proof || !validBinding(proof.binding) || proof.binding.agent !== target || proof.binding.generation === source.binding.generation
          || proof.roomId !== room.id || proof.cwd !== room.cwd || !proof.processId || proof.processId === source.processId
          || !policyVerified(proof.routeEvidence, proof.binding.route, proof.processId) || !policyVerified(proof.modelEvidence, proof.binding.model, proof.processId)
          || proof.nativeMetadataId !== proof.binding.nativeId || proof.sourceProcessId !== source.processId || proof.sourceGeneration !== source.binding.generation
          || proof.sourceExited !== true || proof.noConcurrentWriter !== true || proof.foreground !== true || proof.readOnlyEnforced !== true
          || proof.launcherProfileHash !== launcher.profileHash || proof.home !== profile.home || proof.codexHome !== profile.codexHome
          || proof.personaVersion !== profile.personaVersion || proof.rulesVersion !== profile.rulesVersion || proof.skillsVersion !== profile.skillsVersion || proof.hooksVersion !== profile.hooksVersion
          || proof.binding.route !== launcher.route || (launcher.model && proof.binding.model !== launcher.model)
          || (existing && proof.binding.nativeId !== existing.nativeId)) fail('launch_identity_unverified');
        // Process launch is only a binding, never a completed handoff or context receipt.
        return copy({ ...proof.binding, cursor: existing?.cursor ?? 0 });
      });
    },
    async deliver(room, binding, context): Promise<DeliveryReceipt> {
      await requireReady(room, binding.agent, binding.model);
      if (!validBinding(binding) || !context || !REQUEST.test(context.id) || typeof context.text !== 'string' || textDigest(context.text) !== context.hash
        || !Number.isSafeInteger(context.throughSeq) || context.throughSeq < binding.cursor) fail('context_delivery_invalid');
      return once(`delivery:${room.id}:${context.id}`, { binding, context }, async () => {
        const before = await observation(room, binding);
        if (!safe(before)) fail('target_not_at_safe_point');
        await requireReady(room, binding.agent, binding.model);
        let evidence: ContextEvidence;
        try { evidence = await options.transport.deliver(copy(room), copy(binding), copy(context), buildSendCommands(room, context.text)); }
        catch { return { state: 'uncertain' }; }
        if (evidence?.state === 'rejected') return { state: evidence.rejectedBeforeDispatch === true && evidence.requestId === context.id && evidence.nativeId === binding.nativeId && evidence.generation === binding.generation ? 'rejected' : 'uncertain' };
        if (evidence?.state !== 'acknowledged') return { state: 'uncertain' };
        let after: RuntimeObservation; try { after = await observation(room, binding); } catch { return { state: 'uncertain' }; }
        if (evidence.requestId !== context.id || evidence.nativeId !== binding.nativeId || evidence.generation !== binding.generation
          || evidence.processId !== before.processId || after.processId !== before.processId || evidence.role !== 'assistant' || !evidence.assistantEventId
          || evidence.hash !== context.hash || evidence.throughSeq !== context.throughSeq || typeof evidence.summary !== 'string' || !evidence.summary.trim()
          || evidence.retrieval?.verified !== true || evidence.retrieval.roomId !== room.id || evidence.retrieval.manifestHash !== context.hash || evidence.retrieval.throughSeq !== context.throughSeq
          || evidence.readOnlyEnforced !== true || evidence.writesObserved !== false || evidence.pendingWorkStarted !== false || !safe(after)) return { state: 'uncertain' };
        return { state: 'acknowledged', nativeId: binding.nativeId, hash: context.hash, throughSeq: context.throughSeq };
      });
    },
  };
}
export function blockedAdapter(backend: Backend, reason = 'production_transport_uncertified'): Adapter {
  return { async preflight() { return { ready: false, reason }; }, async inspect() { return fail(`${backend}_inspection_unavailable`); },
    async checkpoint() { return fail('checkpoint_transport_unavailable'); }, async launch() { return fail('launcher_transport_unavailable'); }, async deliver() { return fail('delivery_transport_unavailable'); } };
}
export function createAdapters(options: Partial<Record<Backend, AdapterOptions>> = {}): Record<Backend, Adapter> {
  return Object.fromEntries(BACKENDS.map(backend => [backend, options[backend] ? createTransportAdapter(backend, options[backend]!) : blockedAdapter(backend)])) as Record<Backend, Adapter>;
}
export const createProductionAdapters = createAdapters;
export const productionAdapters: Record<Backend, Adapter> = createAdapters();
