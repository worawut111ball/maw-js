/** Local/default Herdr lifecycle. No CLI, timer, file or database is opened at import. */
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export type Provider = 'codex' | 'claude';
export type Permission = 'ask' | 'bypass';
export interface Conversation { provider: Provider; id: string }
export interface MemberConfig { role: string; agentKind: Provider; model?: string; permission: Permission }
export interface Binding {
  workspaceId: string; paneId: string; terminalId: string; instanceId: string | null;
  cwd: string; agentKind: string | null; name: string | null;
  status: string; foreground: boolean; shellReady: boolean; conversation?: Conversation;
}
export interface LifecycleSnapshot { fresh: boolean; workspaces: { id: string; label: string }[]; panes: Binding[] }
export interface AssistantAck { role: 'assistant'; text: string; instanceId: string; conversationId: string; evidenceId: string }
export interface Receipt { id?: string; state: string; ok: boolean; code?: string }
export interface DispatchInput {
  id: string; action: 'bootstrap' | 'stop'; text?: string; key?: string; expectedGeneration?: string;
}
export interface LaunchAgentRequest {
  operationId: string; stepId: string; member: Member; binding: Binding; cwd: string;
  nativeArgs: string[]; conversation?: Conversation;
}
export interface LifecycleOptions {
  /** Trusted opt-in transport. ACK is submission only; observed identity is still required. */
  launchAgent?: (request: LaunchAgentRequest) => Promise<{ state: 'acknowledged' | 'uncertain' }>;
  store: LifecycleStore;
  /** Raw argv excluding binary; lifecycle supplies --session default itself. */
  runner: (argv: string[], timeoutMs?: number) => Promise<string>;
  snapshot: () => Promise<LifecycleSnapshot>;
  /** Must use the runtime durable delivery ledger + fresh identity guard. */
  dispatch: (binding: Binding, request: DispatchInput) => Promise<Receipt>;
  /** Only verified assistant records, never terminal echo, idle/footer, or start ACK. */
  acknowledgments: (binding: Binding) => Promise<AssistantAck[]>;
  allowDir: (path: string) => string | null;
  now?: () => number;
  rulesSink?: (op: Operation, markdown: string) => Promise<{ path: string; digest: string }>;
}
export interface CreateInput { id: string; label: string; cwd: string; mode: 'single' | 'team'; members?: MemberConfig[]; autostart?: boolean }
type Step = { state: 'dispatching' | 'acknowledged' | 'uncertain'; result?: any };
export interface Member extends MemberConfig {
  logicalId: string; name: string; marker: string; desired: boolean; binding?: Binding;
  conversation?: Conversation; launched: boolean; bootstrap: 'pending' | 'dispatching' | 'acknowledged' | 'uncertain';
  ackEvidence?: string; ready: boolean; reason?: string; closed?: boolean; restoreCount?: number; bootstrapAttempt?: number; conversationConflict?: boolean;
}
export interface Operation {
  id: string; fingerprint: string; logicalWorkspaceId: string; ownerGeneration: number;
  label: string; cwd: string; mode: 'single' | 'team'; desiredAutostart: boolean;
  phase: 'provisioning' | 'waiting-agent' | 'bootstrap-pending' | 'ready' | 'partial' | 'uncertain' | 'closing' | 'closed' | 'blocked-awaiting-binding';
  workspaceId?: string; members: Member[]; steps: Record<string, Step>; createdAt: number; updatedAt: number;
  reason?: string; restoreCycle: number; rulesVersion: string; rulesHash: string; rulesPath?: string; rulesArtifactHash?: string;
}
export interface ClosePreview {
  id: string; scope: { workspaceId: string; paneId?: string }; fingerprint: string; panes: Binding[];
  expiresAt: number; autostartWillDisable: true; historyWillBeKept: true;
}
export interface CloseRecord { preview: ClosePreview; state: 'closing' | 'uncertain' | 'closed'; autostartDisabled: boolean; runtimeClosed: boolean; deliveryUnknown: boolean; inflight: { operationId: string; key: string }[] }
interface State { version: 1; revision: number; operations: Record<string, Operation>; closes: Record<string, CloseRecord>; previews: Record<string, ClosePreview>; migrations: string[] }
const ID = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/;
const LABEL = /^[a-z][a-z0-9_-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/;
const RULES = 'maw-herdr-team-v1';
const empty = (): State => ({ version: 1, revision: 0, operations: {}, closes: {}, previews: {}, migrations: [] });
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const own = (v: object, key: string) => Object.hasOwn(v, key);
export class LifecycleError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
function fail(code: string, status = 409): never { throw new LifecycleError(code, status); }
const validId = (v: unknown): v is string => typeof v === 'string' && ID.test(v) && !['constructor', 'prototype', '__proto__'].includes(v);
function checkState(s: any): asserts s is State {
  if (!s || s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || !s.operations || !s.closes || !s.previews || !Array.isArray(s.migrations)) fail('lifecycle_store_invalid', 503);
  if ([s.operations, s.closes, s.previews].some(x => typeof x !== 'object' || Array.isArray(x))) fail('lifecycle_store_invalid', 503);
  for (const [id, op] of Object.entries(s.operations) as [string, Operation][]) {
    if (!validId(id) || op.id !== id || !validId(op.logicalWorkspaceId) || !Number.isSafeInteger(op.ownerGeneration)
      || !Array.isArray(op.members) || ![1, 4].includes(op.members.length) || typeof op.fingerprint !== 'string'
      || typeof op.desiredAutostart !== 'boolean' || !op.steps || !Number.isFinite(op.updatedAt)
      || !op.members.every(m => validId(m.logicalId) && LABEL.test(m.name) && ['ask', 'bypass'].includes(m.permission) && ['claude', 'codex'].includes(m.agentKind))) fail('lifecycle_store_invalid', 503);
  }
  for (const c of Object.values(s.closes) as CloseRecord[]) if (!c?.preview?.scope?.workspaceId || !Array.isArray(c.preview.panes) || typeof c.autostartDisabled !== 'boolean') fail('lifecycle_store_invalid', 503);
}

/** SQLite FULL transactions serialize all coordinators, including separate instances/processes. */
export class LifecycleStore {
  private db?: Database;
  constructor(readonly path: string) {}
  private connection(): Database {
    if (this.db) return this.db;
    try {
      if (this.path !== ':memory:') {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        if (!existsSync(this.path)) { try { closeSync(openSync(this.path, 'wx', 0o600)); } catch (e: any) { if (e.code !== 'EEXIST') throw e; } }
        chmodSync(this.path, 0o600);
      }
      const db = new Database(this.path, { create: true });
      db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS lifecycle_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);');
      db.query('INSERT OR IGNORE INTO lifecycle_state VALUES (1, ?)').run(JSON.stringify(empty()));
      this.db = db; return db;
    } catch { return fail('lifecycle_store_unavailable', 503); }
  }
  read(): State {
    try {
      const row = this.connection().query('SELECT body FROM lifecycle_state WHERE id=1').get() as { body: string };
      const state = JSON.parse(row.body); checkState(state); return state;
    } catch (e) { if (e instanceof LifecycleError) throw e; return fail('lifecycle_store_invalid', 503); }
  }
  change<T>(fn: (state: State) => T): T {
    const db = this.connection();
    try {
      return db.transaction(() => {
        const state = this.read(), result = fn(state); state.revision++; checkState(state);
        const body = JSON.stringify(state);
        if (body.length > 8_000_000 || Object.keys(state.operations).length > 256 || Object.keys(state.closes).length > 512) fail('lifecycle_store_full', 503);
        db.query('UPDATE lifecycle_state SET body=? WHERE id=1').run(body); return clone(result);
      }).immediate();
    } catch (e) { if (e instanceof LifecycleError) throw e; return fail('lifecycle_store_unavailable', 503); }
  }
  close() { this.db?.close(); this.db = undefined; }
}

export function defaultMembers(mode: 'single' | 'team'): MemberConfig[] {
  return mode === 'team' ? [
    { role: 'head', agentKind: 'codex', model: 'gpt-6-astra', permission: 'ask' },
    ...[1, 2, 3].map(i => ({ role: `worker${i}`, agentKind: 'codex' as const, model: 'gpt-6.1-sol', permission: 'ask' as const })),
  ] : [{ role: 'agent', agentKind: 'codex', model: 'gpt-6-astra', permission: 'ask' }];
}
export function agentArgv(member: MemberConfig, conversation?: Conversation): string[] {
  if (!member || typeof member !== 'object' || !['codex', 'claude'].includes(member.agentKind) || !['ask', 'bypass'].includes(member.permission) || (member.model !== undefined && (typeof member.model !== 'string' || !MODEL.test(member.model)))) fail('invalid_agent_config', 400);
  if (conversation && (conversation.provider !== member.agentKind || !UUID.test(conversation.id))) fail('exact_conversation_required', 400);
  const resume = conversation ? member.agentKind === 'codex' ? ['resume', conversation.id] : ['--resume', conversation.id] : [];
  return [...resume, ...(member.model ? ['--model', member.model] : []), ...(member.permission === 'bypass' ? [member.agentKind === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions'] : member.agentKind === 'codex' ? ['--ask-for-approval', 'on-request'] : ['--permission-mode', 'default'])];
}
function paneIdentity(p: Binding) { return [p.workspaceId, p.paneId, p.terminalId, p.instanceId, p.agentKind, p.name, p.conversation ?? null]; }
const samePane = (a: Binding, b: Binding) => a.workspaceId === b.workspaceId && a.paneId === b.paneId && a.terminalId === b.terminalId;
const sameAgent = (a: Binding, b: Binding) => samePane(a, b) && !!a.instanceId && a.instanceId === b.instanceId && a.agentKind === b.agentKind;
function scopePanes(s: LifecycleSnapshot, scope: { workspaceId: string; paneId?: string }) {
  return s.panes.filter(p => p.workspaceId === scope.workspaceId && (!scope.paneId || p.paneId === scope.paneId));
}
const scopeHash = (ps: Binding[]) => hash(ps.map(paneIdentity).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

export class Lifecycle {
  private now: () => number;
  private initialize?: () => void;
  setInitializationGuard(initialize: () => void): void { this.initialize = initialize; }
  private reconciliation?: Promise<Operation[]>;
  private running = new Map<string, Promise<Operation>>();
  private cancelReadiness?: () => void;
  readonly readiness = { running: false, checks: 0, lastCheckAt: null as number | null, lastError: null as string | null, nextDelayMs: null as number | null, checking: false };
  constructor(readonly options: LifecycleOptions) { this.now = options.now ?? Date.now; }
  private edit<T>(fn: (state: State) => T): T { return this.options.store.change(fn); }
  status(id: string): Operation { this.initialize?.(); const s = this.options.store.read(); return own(s.operations, id) ? clone(s.operations[id]) : fail('operation_not_found', 404); }
  list(): Operation[] { this.initialize?.(); return Object.values(this.options.store.read().operations); }
  private patch(id: string, fn: (op: Operation) => void): Operation {
    return this.edit(s => { const op = s.operations[id]; if (!own(s.operations, id)) fail('operation_not_found', 404); fn(op); op.updatedAt = this.now(); return op; });
  }
  /** Wire to runtime.setDispatchGuard. A store error rejects, never permits input. */
  assertOpen(binding: Pick<Binding, 'workspaceId' | 'paneId' | 'terminalId'>): boolean {
    this.initialize?.(); const s = this.options.store.read();
    return !Object.values(s.closes).some(c => c.state !== 'closed'
      ? c.preview.scope.workspaceId === binding.workspaceId && (!c.preview.scope.paneId || c.preview.scope.paneId === binding.paneId)
      : c.preview.panes.some(p => samePane(p, binding as Binding)));
  }
  private async fresh(): Promise<LifecycleSnapshot> {
    const s = await this.options.snapshot();
    if (!s?.fresh || !Array.isArray(s.workspaces) || !Array.isArray(s.panes)) fail('inventory_unavailable', 503);
    if (s.workspaces.some(w => !validId(w.id)) || s.panes.some(p => !validId(p.workspaceId) || !validId(p.paneId) || !validId(p.terminalId))) fail('inventory_invalid', 503);
    return s;
  }
  private async call(args: string[], type: string, timeout = 10_000): Promise<any> {
    const raw = await this.options.runner(['--session', 'default', ...args], timeout);
    let envelope: any; try { envelope = JSON.parse(raw); } catch { return fail('invalid_lifecycle_response', 503); }
    if (!envelope || typeof envelope.id !== 'string' || envelope.error || envelope.result?.type !== type) fail('invalid_lifecycle_response', 503);
    return envelope.result;
  }
  /** Persist the intent before invoking the CLI. A lost response or store ACK is never re-dispatched. */
  private async action(id: string, key: string, fn: () => Promise<any>): Promise<any> {
    const existing = this.status(id).steps[key];
    if (existing?.state === 'acknowledged') return existing.result;
    const claimed = this.edit(s => {
      const op = s.operations[id]; if (['closing', 'closed'].includes(op.phase)) fail('room_closing');
      if (op.steps[key]) return false;
      op.steps[key] = { state: 'dispatching' }; op.updatedAt = this.now(); return true;
    });
    if (!claimed) return fail('operation_uncertain');
    try {
      const result = await fn();
      this.patch(id, op => { op.steps[key] = { state: 'acknowledged', result }; });
      return result;
    } catch {
      this.patch(id, op => { op.steps[key] = { state: 'uncertain' }; if (op.phase !== 'closing' && op.phase !== 'closed') { op.phase = 'uncertain'; op.reason = key; } });
      return fail('operation_uncertain');
    }
  }
  async create(input: CreateInput): Promise<Operation> {
    this.initialize?.();
    if (!validId(input?.id) || !LABEL.test(input?.label) || !['single', 'team'].includes(input?.mode) || (input.autostart !== undefined && typeof input.autostart !== 'boolean')) fail('invalid_create', 400);
    const cwd = typeof input.cwd === 'string' ? this.options.allowDir(input.cwd) : null;
    if (!cwd || !cwd.startsWith('/') || /[\x00\r\n]/.test(cwd)) fail('invalid_directory', 400);
    const members = input.members ?? defaultMembers(input.mode), roles = defaultMembers(input.mode).map(m => m.role);
    if (!Array.isArray(members) || members.length !== roles.length || members.some((m, i) => !m || typeof m !== 'object' || m.role !== roles[i])) fail('invalid_members', 400);
    members.forEach(m => agentArgv(m));
    const desired = input.autostart !== false;
    const fingerprint = hash({ label: input.label, cwd, mode: input.mode, members, desired });
    const state = this.options.store.read();
    if (own(state.operations, input.id)) { if (state.operations[input.id].fingerprint !== fingerprint) fail('operation_payload_conflict'); return this.continueOperation(input.id); }
    const inventory = await this.fresh();
    if (inventory.workspaces.some(w => w.label === input.label)) fail('workspace_label_conflict');
    this.edit(s => {
      if (own(s.operations, input.id)) { if (s.operations[input.id].fingerprint !== fingerprint) fail('operation_payload_conflict'); return null; }
      if (Object.values(s.operations).some(o => o.label === input.label && o.phase !== 'closed')) fail('workspace_label_conflict');
      const logicalWorkspaceId = randomUUID(), suffix = hash(input.id).slice(0, 10);
      const op: Operation = { id: input.id, fingerprint, logicalWorkspaceId, ownerGeneration: 1, label: input.label, cwd, mode: input.mode,
        desiredAutostart: desired, phase: 'provisioning', createdAt: this.now(), updatedAt: this.now(), restoreCycle: 0, rulesVersion: RULES, rulesHash: '', steps: {},
        members: members.map(m => ({ ...m, logicalId: randomUUID(), name: `maw-${suffix}-${m.role}`, marker: randomUUID(), desired, launched: false, bootstrap: 'pending', ready: false })) };
      op.rulesHash = hash({ version: RULES, roster: op.members.map(m => [m.role, m.logicalId, m.name]) });
      s.operations[input.id] = op; return null;
    });
    return this.continueOperation(input.id);
  }
  async continueOperation(id: string): Promise<Operation> {
    if (this.running.has(id)) return this.running.get(id)!;
    const task = this.provision(id).finally(() => this.running.delete(id)); this.running.set(id, task); return task;
  }
  private async provision(id: string): Promise<Operation> {
    let op = this.status(id);
    if (['closing', 'closed', 'blocked-awaiting-binding'].includes(op.phase)) return op;
    try {
      const prefix = `${op.restoreCycle}:`;
      if (!op.workspaceId) {
        const result = await this.action(id, prefix + 'workspace', async () => {
          const snap = await this.fresh(); if (snap.workspaces.some(w => w.label === op.label)) fail('workspace_label_conflict');
          const r = await this.call(['workspace', 'create', '--cwd', op.cwd, '--label', op.label, '--no-focus'], 'workspace_created');
          if (!validId(r.workspace?.workspace_id) || r.workspace.label !== op.label || !validId(r.root_pane?.pane_id) || !validId(r.root_pane?.terminal_id) || r.root_pane.workspace_id !== r.workspace.workspace_id) fail('invalid_creation');
          return { workspaceId: r.workspace.workspace_id, paneId: r.root_pane.pane_id, terminalId: r.root_pane.terminal_id };
        });
        this.patch(id, o => { o.workspaceId = result.workspaceId; o.members[0].binding = { ...result, cwd: o.cwd, agentKind: null, name: null, instanceId: null, status: 'unknown', foreground: false, shellReady: true }; });
      }
      for (let i = 1; i < op.members.length; i++) {
        op = this.status(id); if (op.members[i].binding || op.members[i].closed) continue;
        const source = op.members[i === 1 ? 0 : i - 1].binding!;
        const result = await this.action(id, prefix + `split-${i}`, async () => {
          const snap = await this.fresh(); const p = snap.panes.find(p => samePane(p, source)); if (!p || !this.assertOpen(p)) fail('pane_changed');
          const r = await this.call(['pane', 'split', '--pane', p.paneId, '--direction', i === 1 ? 'right' : 'down', '--ratio', i === 2 ? String(1 / 3) : '0.5', '--cwd', op.cwd, '--no-focus'], 'pane_info');
          if (!validId(r.pane?.pane_id) || !validId(r.pane?.terminal_id) || r.pane.workspace_id !== op.workspaceId) fail('invalid_split');
          return { workspaceId: r.pane.workspace_id, paneId: r.pane.pane_id, terminalId: r.pane.terminal_id };
        });
        this.patch(id, o => { o.members[i].binding = { ...result, cwd: o.cwd, agentKind: null, name: null, instanceId: null, status: 'unknown', foreground: false, shellReady: true }; });
      }
      await this.persistRules(id);
      for (let i = 0; i < this.status(id).members.length; i++) {
        op = this.status(id); const m = op.members[i];
        if (m.closed || (!m.desired && op.restoreCycle > 0)) continue;
        if (m.conversationConflict) { this.patch(id, o => { o.members[i].ready = false; o.members[i].reason = 'conversation_changed'; }); continue; }
        if (!m.binding || !this.assertOpen(m.binding)) fail('room_closing');
        let live = (await this.fresh()).panes.find(p => samePane(p, m.binding!));
        if (!live) fail('pane_changed');
        const startKey = prefix + `start-${i}-${m.restoreCount ?? 0}`, oldStep = op.steps[startKey];
        if (!m.launched) {
          if (oldStep && oldStep.state !== 'acknowledged') {
            // The persisted exact pane+terminal/name permits observing a late successful start; never start again.
            if (live.name !== m.name || live.agentKind !== m.agentKind || !live.instanceId || !live.foreground) { this.patch(id, o => { o.phase = 'uncertain'; o.members[i].reason = 'start_uncertain'; }); continue; }
            this.patch(id, o => { o.steps[startKey] = { state: 'acknowledged', result: { observed: true } }; });
          } else {
            await this.action(id, startKey, async () => {
              const snap = await this.fresh(), p = snap.panes.find(p => samePane(p, m.binding!));
              if (!p || p.agentKind || !p.shellReady || !this.assertOpen(p) || p.cwd !== op.cwd || snap.panes.some(p => p.name === m.name)) fail('shell_not_available');
              const conversation = (op.restoreCycle || m.restoreCount) ? m.conversation : undefined;
              const nativeArgs = agentArgv(m, conversation);
              if (this.options.launchAgent) {
                const receipt = await this.options.launchAgent(clone({ operationId: id, stepId: startKey, member: m, binding: p, cwd: op.cwd, nativeArgs, conversation }));
                if (receipt?.state !== 'acknowledged') fail('start_uncertain');
              } else {
                const r = await this.call(['agent', 'start', m.name, '--kind', m.agentKind, '--pane', p.paneId, '--timeout', '60000', '--', ...nativeArgs], 'agent_started', 65_000);
                if (r.agent?.pane_id !== p.paneId || r.agent?.workspace_id !== p.workspaceId || r.agent?.name !== m.name || r.agent?.agent !== m.agentKind) fail('invalid_start');
              }
              return { paneId: p.paneId };
            });
          }
          live = (await this.fresh()).panes.find(p => samePane(p, m.binding!));
          if (!live || live.name !== m.name || live.agentKind !== m.agentKind || !live.instanceId || !live.foreground) { this.patch(id, o => { o.phase = 'waiting-agent'; o.members[i].reason = 'waiting-agent'; }); continue; }
          // Persist the verified owned process even when native metadata arrives after start ACK.
          // Keep the expected conversation; never manufacture verification from the resume argv.
          const observed = live;
          this.patch(id, o => { o.members[i].binding = observed; o.members[i].launched = true; });
          if ((op.restoreCycle || m.restoreCount) && !live.conversation) {
            this.patch(id, o => { o.phase = 'waiting-agent'; o.members[i].ready = false; o.members[i].reason = 'waiting-native'; }); continue;
          }
        } else if (!sameAgent(live, m.binding)) { this.patch(id, o => { o.phase = 'partial'; o.members[i].reason = 'agent_changed'; }); continue; }
        // New native sessions may not exist until the first prompt. Bind late metadata
        // to the already verified process; never replace a previously bound conversation.
        op = this.status(id);
        const known = op.members[i].conversation;
        if (live.conversation && (live.conversation.provider !== m.agentKind || !UUID.test(live.conversation.id))) {
          this.patch(id, o => { o.members[i].conversationConflict = true; o.members[i].ready = false; o.members[i].reason = 'conversation_changed'; }); continue;
        }
        if (known && !live.conversation) { this.patch(id, o => { o.members[i].ready = false; o.members[i].reason = 'waiting-native'; }); continue; }
        if (known && live.conversation && (known.id !== live.conversation.id || known.provider !== live.conversation.provider)) {
          this.patch(id, o => { o.members[i].conversationConflict = true; o.members[i].ready = false; o.members[i].reason = 'conversation_changed'; }); continue;
        }
        if (!known && live.conversation) this.patch(id, o => { o.members[i].conversation = live.conversation; o.members[i].binding = live; });
        op = this.status(id); const member = op.members[i];
        if (live.status === 'blocked' || live.status === 'unknown' || !live.foreground) { this.patch(id, o => { o.phase = 'waiting-agent'; o.members[i].reason = 'waiting-agent'; }); continue; }
        if (!member.ackEvidence && member.bootstrap === 'pending') {
          const claimed = this.edit(s => { const current = s.operations[id]; if (['closing', 'closed'].includes(current.phase)) fail('room_closing'); const member = current.members[i]; if (member.bootstrap !== 'pending') return false; member.bootstrap = 'dispatching'; return true; });
          if (claimed) {
            let receipt: Receipt;
            try { if (!this.assertOpen(live)) fail('room_closing'); receipt = await this.options.dispatch(live, { id: `bootstrap:${member.logicalId}${member.bootstrapAttempt ? ':' + member.bootstrapAttempt : ''}`, action: 'bootstrap', text: this.rules(op, member) }); }
            catch { receipt = { state: 'uncertain', ok: false }; }
            this.patch(id, o => {
              o.members[i].bootstrap = receipt.state === 'acknowledged' ? 'acknowledged' : receipt.state === 'definitely-rejected' ? 'pending' : 'uncertain';
              // The ledger permanently remembers rejected IDs. Only a proven pre-send
              // rejection may advance the attempt; uncertainty keeps the original ID.
              if (receipt.state === 'definitely-rejected') o.members[i].bootstrapAttempt = (o.members[i].bootstrapAttempt ?? 0) + 1;
            });
          }
        }
        const acknowledged = (await this.options.acknowledgments(live)).find(a => a.role === 'assistant' && a.instanceId === live.instanceId
          && a.conversationId === live.conversation?.id && a.evidenceId && a.text.split(/\r?\n/).some(line => line.trim() === `HERDR_ACK:${member.marker}:${member.role}`));
        if (member.ackEvidence && member.conversation?.id === live.conversation?.id) this.patch(id, o => { o.members[i].ready = true; o.members[i].reason = undefined; });
        if (acknowledged) this.patch(id, o => { o.members[i].bootstrap = 'acknowledged'; o.members[i].ackEvidence = acknowledged.evidenceId; o.members[i].ready = true; o.members[i].reason = undefined; });
      }
      return this.patch(id, o => {
        if (['closing', 'closed'].includes(o.phase)) return;
        o.phase = o.members.filter(m => !m.closed && (m.desired || !o.restoreCycle)).every(m => m.ready) ? 'ready'
          : o.members.some(m => m.bootstrap === 'uncertain' || m.bootstrap === 'dispatching' || m.reason?.includes('uncertain')) ? 'uncertain'
          : o.members.some(m => ['waiting-agent', 'waiting-native'].includes(m.reason ?? '')) ? 'waiting-agent' : 'partial';
      });
    } catch (e) {
      return this.patch(id, o => { if (['closing', 'closed'].includes(o.phase)) return; o.reason = e instanceof LifecycleError ? e.code : 'inventory_unavailable'; if (o.phase !== 'uncertain') o.phase = 'partial'; });
    }
  }
  private async persistRules(id: string): Promise<void> {
    const op = this.status(id);
    const markdown = `# กติกาทีม Herdr\n\nVersion: ${op.rulesVersion}\nOperation: ${op.id}\nRoster hash: ${op.rulesHash}\n\n` + op.members.map(m => `## ${m.role}\n\n${this.rules(op, m)}\n`).join('\n');
    const digest = createHash('sha256').update(markdown).digest('hex');
    if (op.rulesArtifactHash === digest && op.rulesPath) return;
    let saved: { path: string; digest: string };
    if (this.options.rulesSink) saved = await this.options.rulesSink(op, markdown);
    else {
      // Tests with :memory: may inject a sink. No implicit write into the repository/user home.
      if (this.options.store.path === ':memory:') fail('rules_sink_required', 503);
      const directory = dirname(this.options.store.path) + '/herdr-team-rules'; mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = `${directory}/${hash(op.id).slice(0, 24)}-${digest.slice(0, 16)}.md`;
      if (!existsSync(path)) writeFileSync(path, markdown, { flag: 'wx', mode: 0o600 });
      if (readFileSync(path, 'utf8') !== markdown) fail('rules_artifact_conflict', 503);
      saved = { path, digest };
    }
    if (!saved.path || saved.digest !== digest) fail('rules_artifact_invalid', 503);
    this.patch(id, o => { o.rulesPath = saved.path; o.rulesArtifactHash = digest; });
  }
  rulesMarkdown(id: string): string {
    const op = this.status(id); if (!op.rulesPath || !op.rulesArtifactHash) fail('rules_not_ready', 404);
    const markdown = readFileSync(op.rulesPath, 'utf8');
    if (createHash('sha256').update(markdown).digest('hex') !== op.rulesArtifactHash) fail('rules_artifact_changed', 503);
    return markdown;
  }
  rules(op: Operation, member: Member): string {
    return `กติกาทีม ${op.rulesVersion} hash ${op.rulesHash}\nบทบาทของคุณ: ${member.role}\nroster จริง:\n${op.members.map(m => `${m.role}: ${m.name} (${m.binding?.paneId ?? 'pending'})`).join('\n')}\nหัวหน้าแจกงานผ่าน Herdr CLI ไปห้องลูกจริงและอ่านผลก่อนรวม ลูกทำเฉพาะงานที่มอบหมายและส่งผลให้หัวหน้า ห้ามเปิดลูกเพิ่ม ห้ามเริ่มงานจริงจนกว่าผู้ใช้มอบงาน ห้าม commit/push/restart server หรือเปิด server เอง\nอ่านข้อความแล้วตอบเฉพาะ HERDR_ACK:${member.marker}:${member.role} จากนั้นรอคำสั่งผู้ใช้`;
  }
  async closePreview(scope: { workspaceId: string; paneId?: string }): Promise<ClosePreview> {
    this.initialize?.();
    if (!validId(scope?.workspaceId) || (scope.paneId !== undefined && !validId(scope.paneId))) fail('invalid_close_target', 400);
    const snapshot = await this.fresh(), panes = scopePanes(snapshot, scope);
    if (!panes.length) fail('room_not_found', 404);
    const preview: ClosePreview = { id: randomUUID(), scope: clone(scope), fingerprint: scopeHash(panes), panes, expiresAt: this.now() + 120_000, autostartWillDisable: true, historyWillBeKept: true };
    this.edit(s => { for (const [id, p] of Object.entries(s.previews)) if (p.expiresAt < this.now()) delete s.previews[id]; if (Object.keys(s.previews).length >= 128) fail('preview_limit', 429); s.previews[preview.id] = preview; return null; });
    return preview;
  }
  async closeConfirm(previewId: string): Promise<CloseRecord> {
    this.initialize?.();
    if (!validId(previewId)) fail('invalid_confirmation', 400);
    const state = this.options.store.read();
    if (own(state.closes, previewId)) return this.reconcileClose(previewId);
    const preview = state.previews[previewId];
    if (!own(state.previews, previewId) || preview.expiresAt < this.now()) fail('confirmation_expired');
    const current = await this.fresh();
    if (scopeHash(scopePanes(current, preview.scope)) !== preview.fingerprint) fail('close_members_changed');
    const claimed = this.edit(s => {
      if (own(s.closes, previewId)) return false;
      s.closes[previewId] = { preview, state: 'closing', autostartDisabled: true, runtimeClosed: false, deliveryUnknown: false,
        inflight: Object.values(s.operations).filter(o => o.workspaceId === preview.scope.workspaceId || !o.workspaceId).flatMap(o => Object.entries(o.steps).filter(([,step]) => step.state !== 'acknowledged').map(([key]) => ({ operationId: o.id, key }))) };
      for (const op of Object.values(s.operations)) {
        const affected = op.members.filter(m => m.binding && preview.panes.some(p => samePane(p, m.binding!)));
        if (op.workspaceId === preview.scope.workspaceId && !preview.scope.paneId) { op.phase = 'closing'; op.desiredAutostart = false; op.ownerGeneration++; for (const m of op.members) m.desired = false; }
        else if (affected.length) { op.ownerGeneration++; for (const m of affected) { m.desired = false; m.closed = true; m.ready = false; m.reason = 'closing'; } op.desiredAutostart = op.members.some(m => m.desired); if (op.members.every(m => m.closed)) op.phase = 'closing'; }
      }
      delete s.previews[previewId]; return true;
    });
    if (!claimed) return this.reconcileClose(previewId);
    try {
      const fresh = await this.fresh(); if (scopeHash(scopePanes(fresh, preview.scope)) !== preview.fingerprint) fail('close_members_changed');
      await this.call(preview.scope.paneId ? ['pane', 'close', preview.scope.paneId] : ['workspace', 'close', preview.scope.workspaceId], preview.scope.paneId ? 'pane_closed' : 'workspace_closed');
    } catch { this.edit(s => { s.closes[previewId].state = 'uncertain'; s.closes[previewId].deliveryUnknown = true; return null; }); }
    return this.reconcileClose(previewId);
  }
  async closeStatus(id: string): Promise<CloseRecord> {
    if (!validId(id) || !own(this.options.store.read().closes, id)) fail('close_not_found', 404);
    return this.reconcileClose(id);
  }
  private async reconcileClose(id: string): Promise<CloseRecord> {
    const record = this.options.store.read().closes[id]; if (record.runtimeClosed) return record;
    let snapshot: LifecycleSnapshot; try { snapshot = await this.fresh(); } catch { return record; }
    const remaining = scopePanes(snapshot, record.preview.scope);
    const gone = record.preview.scope.paneId ? !remaining.length : !snapshot.workspaces.some(w => w.id === record.preview.scope.workspaceId);
    return this.edit(s => {
      const c = s.closes[id]; const unsafeInflight = c.inflight.some(a => { const o = s.operations[a.operationId], step = o?.steps[a.key]; return step && step.state !== 'acknowledged' && (a.key.includes('workspace') || a.key.includes('split') || step.state === 'dispatching'); });
      if (gone && !unsafeInflight) { c.state = 'closed'; c.runtimeClosed = true; c.deliveryUnknown = false;
        for (const op of Object.values(s.operations)) if (op.workspaceId === c.preview.scope.workspaceId && (!c.preview.scope.paneId || op.members.every(m => m.closed))) op.phase = 'closed';
      } else { c.state = 'uncertain'; c.deliveryUnknown = true; }
      return c;
    });
  }
  async stop(binding: Binding, id: string, expectedInstance: string): Promise<Receipt> {
    if (!validId(id) || !this.assertOpen(binding)) fail('room_closing');
    const live = (await this.fresh()).panes.find(p => sameAgent(p, binding));
    if (!live || live.instanceId !== expectedInstance || !live.foreground || live.status !== 'working' || !['claude', 'codex'].includes(live.agentKind ?? '')) fail('stop_not_available');
    return this.options.dispatch(live, { id, action: 'stop', key: 'ctrlc' });
  }
  /** Restore only proven owned missing workspaces. Existing/replacement workspaces are never adopted by label. */
  reconcile(): Promise<Operation[]> {
    this.initialize?.();
    if (this.reconciliation) return this.reconciliation;
    const task = this.runReconcile().finally(() => { this.reconciliation = undefined; }); this.reconciliation = task; return task;
  }
  private async runReconcile(): Promise<Operation[]> {
    const snap = await this.fresh();
    for (const close of Object.keys(this.options.store.read().closes)) await this.reconcileClose(close);
    for (const original of this.list()) {
      if (['closing', 'closed', 'blocked-awaiting-binding'].includes(original.phase) || !original.workspaceId) continue;
      if (snap.workspaces.some(w => w.id === original.workspaceId)) {
        await this.observeAcknowledgments(original.id, snap);
        if (original.desiredAutostart) await this.restoreMembers(original.id, await this.fresh()); continue;
      }
      if (!original.desiredAutostart || ['provisioning', 'uncertain'].includes(original.phase)) continue;
      if (original.members.filter(m => m.desired).some(m => m.conversationConflict || !m.conversation || !UUID.test(m.conversation.id) || !m.ackEvidence)) {
        this.patch(original.id, o => { o.phase = 'blocked-awaiting-binding'; o.reason = 'exact_conversation_required'; }); continue;
      }
      if (snap.workspaces.some(w => w.label === original.label)) { this.patch(original.id, o => { o.phase = 'partial'; o.reason = 'foreign_workspace'; }); continue; }
      const claimed = this.edit(s => {
        const op = s.operations[original.id]; if (op.ownerGeneration !== original.ownerGeneration || op.phase === 'closing' || op.phase === 'closed') return false;
        op.ownerGeneration++; op.restoreCycle++; op.workspaceId = undefined; op.phase = 'provisioning';
        for (const m of op.members) { m.binding = undefined; m.launched = false; m.ready = !m.desired; }
        return true;
      });
      if (claimed) await this.continueOperation(original.id);
    }
    return this.list();
  }
  /** Read-only reconciliation of late replies; never starts an agent or re-sends bootstrap. */
  private async observeAcknowledgments(id: string, snapshot: LifecycleSnapshot): Promise<void> {
    const op = this.status(id);
    if (['closing', 'closed'].includes(op.phase)) return;
    for (let i = 0; i < op.members.length; i++) {
      const member = op.members[i];
      if (!member.launched || member.closed || !member.binding || member.conversationConflict) continue;
      const live = snapshot.panes.find(p => sameAgent(p, member.binding!));
      if (!live) {
        this.patch(id, current => {
          const m = current.members[i];
          if (current.ownerGeneration !== op.ownerGeneration || ['closing', 'closed'].includes(current.phase) || m.closed || !m.binding || !sameAgent(m.binding, member.binding!)) return;
          m.ready = false; m.reason = 'agent_changed'; current.phase = 'partial';
        });
        continue;
      }
      if (!this.assertOpen(live)) continue;
      const native = live.conversation;
      if (!native) {
        this.patch(id, o => { if (o.ownerGeneration !== op.ownerGeneration || ['closing', 'closed'].includes(o.phase) || o.members[i].closed || o.members[i].conversationConflict || !o.members[i].binding || !sameAgent(o.members[i].binding!, live)) return; o.members[i].ready = false; o.members[i].reason = 'waiting-native'; o.phase = 'waiting-agent'; });
        continue;
      }
      if (native.provider !== member.agentKind || !UUID.test(native.id) || member.conversation && (native.id !== member.conversation.id || native.provider !== member.conversation.provider)) {
        this.patch(id, o => { if (o.ownerGeneration !== op.ownerGeneration || ['closing', 'closed'].includes(o.phase) || o.members[i].closed || !o.members[i].binding || !sameAgent(o.members[i].binding!, live)) return; o.members[i].conversationConflict = true; o.members[i].ready = false; o.members[i].reason = 'conversation_changed'; o.phase = 'partial'; });
        continue;
      }
      const conversation = member.conversation ?? native;
      let ack: AssistantAck | undefined;
      if (!member.ackEvidence) {
        try {
          ack = (await this.options.acknowledgments(live)).find(a => a.role === 'assistant' && a.instanceId === live.instanceId && a.conversationId === conversation.id
            && a.evidenceId && a.text.split(/\r?\n/).some(line => line.trim() === `HERDR_ACK:${member.marker}:${member.role}`));
        } catch { continue; }
        if (!ack) continue;
      }
      this.patch(id, current => {
        const m = current.members[i];
        if (current.ownerGeneration !== op.ownerGeneration || ['closing', 'closed'].includes(current.phase) || m.closed || m.conversationConflict || !m.binding || !sameAgent(m.binding, live)) return;
        m.conversation = conversation; m.binding = live; m.bootstrap = 'acknowledged'; m.ackEvidence = ack?.evidenceId ?? m.ackEvidence; m.ready = true; m.reason = undefined;
        if (current.members.filter(m => !m.closed && (m.desired || !current.restoreCycle)).every(m => m.ready)) { current.phase = 'ready'; current.reason = undefined; }
      });
    }
  }
  private async restoreMembers(id: string, snapshot: LifecycleSnapshot): Promise<void> {
    for (let i = 0; i < this.status(id).members.length; i++) {
      let op = this.status(id), m = op.members[i];
      if (!op.desiredAutostart || !m.desired || m.closed || m.conversationConflict || !m.launched || !m.binding) continue;
      const current = snapshot.panes.find(p => p.terminalId === m.binding!.terminalId && p.workspaceId === op.workspaceId);
      if (current && sameAgent(current, m.binding)) continue;
      if (current?.agentKind || (current && !current.shellReady)) { this.patch(id, o => { o.members[i].reason = 'foreign_or_busy_terminal'; }); continue; }
      if (!m.conversation || !UUID.test(m.conversation.id) || !m.ackEvidence) { this.patch(id, o => { o.members[i].reason = 'exact_conversation_required'; }); continue; }
      try {
        let target = current;
        if (!target) {
          const source = snapshot.panes.find(p => p.workspaceId === op.workspaceId && op.members.some(other => other.binding && sameAgent(p, other.binding)));
          if (!source || !this.assertOpen(source)) { this.patch(id, o => { o.members[i].reason = 'owned_split_source_unavailable'; }); continue; }
          const key = `member-${m.logicalId}-split-${(m.restoreCount ?? 0) + 1}`;
          const r = await this.action(id, key, async () => {
            const live = (await this.fresh()).panes.find(p => sameAgent(p, source)); if (!live || !this.assertOpen(live)) fail('room_changed');
            const result = await this.call(['pane', 'split', '--pane', live.paneId, '--direction', i === 0 ? 'right' : 'down', '--ratio', i === 2 ? String(1 / 3) : '0.5', '--cwd', op.cwd, '--no-focus'], 'pane_info');
            if (!validId(result.pane?.pane_id) || !validId(result.pane?.terminal_id) || result.pane.workspace_id !== op.workspaceId) fail('invalid_split');
            return { workspaceId: result.pane.workspace_id, paneId: result.pane.pane_id, terminalId: result.pane.terminal_id };
          });
          target = (await this.fresh()).panes.find(p => samePane(p, r));
        }
        if (!target || target.agentKind || !target.shellReady || !this.assertOpen(target)) fail('restore_pane_not_available');
        this.patch(id, o => { const member = o.members[i]; member.binding = target; member.launched = false; member.ready = false; member.restoreCount = (member.restoreCount ?? 0) + 1; o.phase = 'provisioning'; });
        await this.continueOperation(id);
        snapshot = await this.fresh();
      } catch { this.patch(id, o => { if (o.phase !== 'closing' && o.phase !== 'closed') { o.phase = 'uncertain'; o.members[i].reason = 'member_restore_uncertain'; } }); }
    }
  }
  setAutostart(id: string, on: boolean, logicalMemberId?: string): Operation {
    this.initialize?.();
    if (typeof on !== 'boolean') fail('invalid_autostart', 400);
    return this.patch(id, op => {
      if (['closing', 'closed'].includes(op.phase)) fail('room_closing');
      const members = logicalMemberId ? op.members.filter(m => m.logicalId === logicalMemberId) : op.members;
      if (!members.length || members.some(m => m.closed)) fail('member_not_available');
      members.forEach(m => m.desired = on); op.desiredAutostart = op.members.some(m => m.desired); op.ownerGeneration++;
    });
  }
  /** Explicit host-owned loop. Delay is bounded, lifetime is cancellable and not bounded by retries. */
  startReadiness(schedule: (fn: () => void, ms: number) => () => void, delays = [5_000, 10_000, 30_000, 60_000]): () => void {
    if (!delays.length || delays.some(d => !Number.isFinite(d) || d < 1 || d > 60_000)) fail('invalid_readiness_delay', 400);
    this.stopReadiness(); let stopped = false, cancel: (() => void) | undefined, i = 0;
    this.readiness.running = true;
    const next = () => {
      if (stopped) return;
      const delay = delays[Math.min(i++, delays.length - 1)]; this.readiness.nextDelayMs = delay;
      cancel = schedule(() => { if (stopped) return; if (this.readiness.checking) { next(); return; } this.readiness.checking = true; this.readiness.checks++; this.readiness.lastCheckAt = this.now();
        void Promise.resolve().then(() => this.reconcile()).then(() => { this.readiness.lastError = null; }, () => { this.readiness.lastError = 'inventory_or_store_unavailable'; }).finally(() => { this.readiness.checking = false; next(); });
      }, delay);
    };
    const cancelThis = () => { stopped = true; cancel?.(); if (this.cancelReadiness === cancelThis) { this.cancelReadiness = undefined; this.readiness.running = false; this.readiness.nextDelayMs = null; } };
    this.cancelReadiness = cancelThis; next(); return cancelThis;
  }
  stopReadiness() { this.cancelReadiness?.(); }
  /** Legacy intent is retained but cannot restore without exact conversation AND ownership evidence. */
  migrateLegacy(file: string): { migrated: number; backup: string } {
    let raw: string, rows: any; try { raw = readFileSync(file, 'utf8'); rows = JSON.parse(raw); } catch { return fail('legacy_config_invalid', 503); }
    if (!Array.isArray(rows) || rows.some(r => !r || !LABEL.test(r.label) || typeof r.cwd !== 'string' || !this.options.allowDir(r.cwd) || !['codex', 'claude'].includes(r.agentKind) || (r.model !== undefined && !MODEL.test(r.model)))) fail('legacy_config_invalid', 503);
    for (const r of rows) {
      if (r.resumeArgs !== undefined) { const a = r.resumeArgs; const valid = Array.isArray(a) && (r.agentKind === 'codex' ? a.length === 2 && a[0] === 'resume' && (a[1] === '--last' || UUID.test(a[1])) : (a.length === 1 && a[0] === '--continue') || (a.length === 2 && a[0] === '--resume' && UUID.test(a[1]))); if (!valid) fail('legacy_config_invalid', 503); }
    }
    if (new Set(rows.map((r: any) => r.label)).size !== rows.length) fail('legacy_config_invalid', 503);
    const digest = hash(raw), backup = `${file}.backup-${digest.slice(0, 12)}`;
    if (!existsSync(backup)) writeFileSync(backup, raw, { flag: 'wx', mode: 0o600 });
    else if (readFileSync(backup, 'utf8') !== raw) fail('legacy_backup_conflict', 503);
    return this.edit(s => {
      if (s.migrations.includes(digest)) return { migrated: 0, backup };
      for (const row of rows) {
        const id = `legacy:${hash(row.label).slice(0, 24)}`; if (own(s.operations, id)) fail('legacy_migration_conflict');
        s.operations[id] = { id, fingerprint: hash(row), logicalWorkspaceId: randomUUID(), ownerGeneration: 1, label: row.label, cwd: row.cwd, mode: 'single', desiredAutostart: true,
          phase: 'blocked-awaiting-binding', reason: 'ownership_and_exact_conversation_required', restoreCycle: 0, steps: {}, createdAt: this.now(), updatedAt: this.now(), rulesVersion: RULES, rulesHash: '',
          members: [{ role: 'agent', logicalId: randomUUID(), name: `maw-${hash(row.label).slice(0, 10)}-agent`, agentKind: row.agentKind, model: row.model, permission: 'ask', marker: randomUUID(), desired: true, launched: false, bootstrap: 'pending', ready: false }] };
      }
      s.migrations.push(digest); return { migrated: rows.length, backup };
    });
  }
}
