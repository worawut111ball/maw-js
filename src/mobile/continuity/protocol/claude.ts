import { randomUUID } from 'node:crypto';
import {
  ProtocolError, type ProtocolApproval, type ProtocolHooks,
  type ProtocolIdentity, type ProtocolPolicy, type ProtocolTurn, type ProtocolWire, type NativeProtocolObservation, type StagedNativeProtocolSession,
} from './types';

/** Claude 2.1.220 stream-json. Host owns launch/resume arguments and wire exclusivity.
 * Native schemas inspected in installed claude.exe: init @246171316, result @246169113,
 * can_use_tool @242656877, control response @246275564. No process/CLI side effects.
 */
type Frame = Record<string, any>;
const object = (v: unknown): v is Frame => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const fingerprint = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(fingerprint).join(',') + ']';
  if (object(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + fingerprint(v[k])).join(',') + '}';
  return JSON.stringify(v) ?? 'undefined';
};
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: ProtocolError) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Attempt = ReturnType<typeof deferred<ProtocolTurn>> & {
  operationId: string; text: string; userId: string; dispatched: boolean;
  tools: Map<string, { name: string; input: unknown }>; tasks: Set<string>;
  first: boolean; identityAtCompletion?: ProtocolIdentity; startPromise?: Promise<{ identity: ProtocolIdentity; turn: ProtocolTurn }>;
  finalText?: string; finalSeen: boolean; assistantStopPending?:boolean; timer?: ReturnType<typeof setTimeout>;
};
type Approval = { id: string; turn: Attempt; request: Frame; cancelled: boolean; decided: boolean; responding: boolean };
export type ClaudeNativeIdentity = NativeProtocolObservation & Readonly<{ agent: 'claude' }>;

/** Compatibility identity: native proof stays in nativeObservation; scope is host metadata only. */
export function composeClaudeIdentity(native: ClaudeNativeIdentity, policy: ProtocolPolicy): Readonly<ProtocolIdentity> {
  return Object.freeze({ ...native, home: policy.home, route: policy.route });
}

/** Validate completion against explicit native result correlation, never a user echo/ACK. */
export function validateClaudeResult(frame: unknown, expected: {
  nativeId: string; userId: string; finalText?: string; finalSeen: boolean;
  pendingTools: number; pendingApproval: boolean; assistantStopPending?:boolean;
}): string {
  if (!object(frame) || frame.type !== 'result' || !uuid(frame.uuid) || frame.session_id !== expected.nativeId)
    throw new ProtocolError('claude_result_identity_mismatch', true);
  if (frame.user_message_uuid !== expected.userId) throw new ProtocolError('claude_result_uncorrelated', true);
  if (frame.subtype !== 'success' || frame.is_error !== false || frame.api_error_status != null) throw new ProtocolError('claude_result_failed', true);
  if (!Number.isInteger(frame.num_turns) || frame.num_turns < 1 || frame.stop_reason !== 'end_turn'
    || frame.terminal_reason !== undefined && frame.terminal_reason !== 'completed'
    || expected.assistantStopPending && frame.terminal_reason!=='completed'
    || frame.deferred_tool_use !== undefined && frame.deferred_tool_use !== null
    || !Array.isArray(frame.permission_denials) || frame.permission_denials.length > 0
    || expected.pendingTools || expected.pendingApproval || !expected.finalSeen)
    throw new ProtocolError('claude_result_not_final', true);
  if (typeof frame.result !== 'string' || frame.result !== expected.finalText)
    throw new ProtocolError('claude_result_text_mismatch', true);
  return frame.result;
}

export class ClaudeProtocolSession implements StagedNativeProtocolSession {
  private readonly wire: ProtocolWire;
  private readonly policy: Readonly<ProtocolPolicy>;
  private readonly hooks: ProtocolHooks;
  private phase: 'new' | 'preparing' | 'prepared' | 'starting' | 'open' | 'failed' | 'closed' = 'new';
  private opening?: ReturnType<typeof deferred<void>>;
  private identity?: ProtocolIdentity;
  private native?: ClaudeNativeIdentity;
  private expectedId?: string;
  /** Queue notifications constrain later init; they never establish native identity. */
  private provisionalSessionId?: string;
  private commandStates=new Map<string,string>();
  private initializeId?: string;
  private initialized = false;
  private apiProvider?: string;
  private active?: Attempt;
  private attempts = new Map<string, Attempt>();
  private approvals = new Map<string, Approval>();
  private seenRequests = new Set<string>();
  private frames = new Map<string, string>();
  private fatal?: ProtocolError;
  private openingTimer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;

  constructor(wire: ProtocolWire, policy: ProtocolPolicy, hooks: ProtocolHooks = {}) {
    this.wire = wire; this.policy = Object.freeze({ ...policy }); this.hooks = { ...hooks };
  }
  get idle(): boolean { return this.phase === 'open' && !this.active && !this.pendingApproval; }
  get pendingApproval(): boolean { return [...this.approvals.values()].some(a => !a.cancelled && !a.decided); }
  /** Native-only observations. Never filled from policy home/route or extra wire properties. */
  get nativeObservation(): ClaudeNativeIdentity | undefined { return this.native; }

  /** Legacy open cannot obtain native identity from this pin without first user input. */
  open(_nativeId?: string): Promise<ProtocolIdentity> {
    return Promise.reject(new ProtocolError('claude_requires_staged_start'));
  }
  /** An observed provider selector (firstParty/bedrock/etc), NOT entry's logical provider or route proof. */
  get nativeApiProvider(): string | undefined { return this.apiProvider; }

  prepare(nativeId?: string): Promise<void> {
    if (this.phase !== 'new') return Promise.reject(new ProtocolError('claude_prepare_once'));
    if (this.policy.agent !== 'claude' || typeof this.policy.cwd !== 'string' || !this.policy.cwd.startsWith('/') || !nonempty(this.policy.model)
      || !nonempty(this.policy.home) || !nonempty(this.policy.route)
      || !Number.isInteger(this.policy.timeoutMs) || this.policy.timeoutMs < 1 || this.policy.timeoutMs > 2_147_483_647
      || nativeId !== undefined && !uuid(nativeId)) return Promise.reject(new ProtocolError('claude_policy_invalid'));
    this.phase = 'preparing'; this.expectedId = nativeId; this.opening = deferred<void>();
    this.initializeId = randomUUID();
    this.openingTimer = setTimeout(() => this.fail('claude_prepare_timeout'), this.policy.timeoutMs);
    void this.read();
    this.write({ type: 'control_request', request_id: this.initializeId, request: { subtype: 'initialize' } }, 'claude_initialize_write_failed');
    return this.opening.promise;
  }

  /** Host must journal first intent and verify trusted entry BEFORE calling this method. */
  startTurn(operationId: string, text: string): Promise<{ identity: ProtocolIdentity; turn: ProtocolTurn }> {
    const previous = this.attempts.get(operationId);
    if (previous) {
      if (!previous.first || previous.text !== text) return Promise.reject(new ProtocolError('claude_operation_conflict'));
      return previous.startPromise!;
    }
    if (this.phase !== 'prepared') return Promise.reject(this.fatal ?? new ProtocolError(this.active ? 'claude_busy' : 'claude_not_prepared'));
    if (!nonempty(operationId) || typeof text !== 'string' || !text.trim()) return Promise.reject(new ProtocolError('claude_turn_invalid'));
    this.phase = 'starting';
    const attempt = this.dispatch(operationId, text, true);
    attempt.startPromise = attempt.promise.then(turn => Object.freeze({ identity: attempt.identityAtCompletion!, turn }));
    return attempt.startPromise;
  }

  turn(operationId: string, text: string): Promise<ProtocolTurn> {
    if (this.phase !== 'open' || !this.identity) return Promise.reject(this.fatal ?? new ProtocolError('claude_not_open'));
    const previous = this.attempts.get(operationId);
    if (previous) return previous.text === text ? previous.promise : Promise.reject(new ProtocolError('claude_operation_conflict'));
    if (this.active || this.pendingApproval) return Promise.reject(new ProtocolError('claude_busy'));
    if (!nonempty(operationId) || typeof text !== 'string' || !text.trim()) return Promise.reject(new ProtocolError('claude_turn_invalid'));
    return this.dispatch(operationId, text, false).promise;
  }
  private dispatch(operationId: string, text: string, first: boolean): Attempt {
    const attempt: Attempt = { ...deferred<ProtocolTurn>(), operationId, text, userId: randomUUID(), dispatched: false, first, tools: new Map(), tasks: new Set(), finalSeen: false };
    this.attempts.set(operationId, attempt); this.active = attempt;
    attempt.timer = setTimeout(() => this.fail('claude_turn_timeout'), this.policy.timeoutMs);
    // Native uyl schema @246160920 makes session_id optional. Fresh first input omits it;
    // a resume uses trusted host --resume selection, never this metadata field as selector.
    const sessionId = this.native?.nativeId ?? this.expectedId;
    attempt.dispatched = true;
    this.write({ type: 'user', uuid: attempt.userId, ...(sessionId ? { session_id: sessionId } : {}),
      parent_tool_use_id: null, message: { role: 'user', content: text } }, 'claude_prompt_write_uncertain');
    return attempt;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeInternal(); return this.closing;
  }
  private async closeInternal(): Promise<void> {
    if (this.phase !== 'closed') {
      this.fail('claude_closed');
      // Explicit deny of outstanding requests; no prompt, interrupt or replay.
      const pending = [...this.approvals.values()].filter(a => !a.cancelled && !a.decided);
      for (const approval of pending) {
        approval.decided = true;
        await this.deny(approval.id).catch(() => {});
      }
      this.phase = 'closed';
    }
    await this.wire.close();
  }

  private write(frame: Record<string, unknown>, failure: string): void {
    try { void Promise.resolve(this.wire.send(frame)).catch(() => this.fail(failure)); } catch { this.fail(failure); }
  }
  private fail(code: string): void {
    if (this.phase === 'closed' || this.phase === 'failed') return;
    this.fatal = new ProtocolError(code, !!this.active?.dispatched);
    this.phase = 'failed'; clearTimeout(this.openingTimer);
    this.opening?.reject(this.fatal);
    if (this.active) { clearTimeout(this.active.timer); this.active.reject(this.fatal); }
    for (const approval of this.approvals.values()) if (!approval.decided && !approval.cancelled) {
      approval.decided = true; void this.deny(approval.id).catch(() => {});
    }
    // Do not mark idle or forget attempts: late frames cannot recover/replay an uncertain dispatch.
  }
  private async read(): Promise<void> {
    try {
      for await (const frame of this.wire.messages) {
        if (this.phase === 'closed') break;
        if (!object(frame)) { this.fail('claude_frame_invalid'); continue; }
        if (frame.type === 'control_request') { this.handleApproval(frame); continue; }
        if (this.phase === 'failed') continue;
        this.accept(frame);
      }
      if (this.phase !== 'closed') this.fail('claude_disconnected');
    } catch { this.fail('claude_wire_failed'); }
  }

  private accept(frame: Frame): void {
    if (frame.type === 'keep_alive') return;
    if (frame.type === 'control_response') {
      const response = frame.response;
      if (this.phase !== 'preparing' || !object(response) || response.request_id !== this.initializeId || this.initialized) { this.fail('claude_control_response_mismatch'); return; }
      if (response.subtype !== 'success' || !object(response.response)) { this.fail('claude_initialize_rejected'); return; }
      if (response.pending_permission_requests !== undefined && (!Array.isArray(response.pending_permission_requests) || response.pending_permission_requests.length) || response.pending_user_dialog_requests !== undefined && (!Array.isArray(response.pending_user_dialog_requests) || response.pending_user_dialog_requests.length)) {
        for (const pending of Array.isArray(response.pending_permission_requests) ? response.pending_permission_requests : [])
          if (object(pending) && nonempty(pending.request_id)) void this.deny(pending.request_id).catch(() => {});
        this.fail('claude_preexisting_approval'); return;
      }
      // xn() @227682549 reports firstParty/gateway/etc, not logical entry provider 'anthropic'.
      // Preserve this observation separately; host owns provider/route/entry validation.
      if (nonempty(response.response.account?.apiProvider)) this.apiProvider = response.response.account.apiProvider;
      this.initialized = true; clearTimeout(this.openingTimer); this.phase = 'prepared'; this.opening!.resolve(); return;
    }
    if (frame.type === 'control_cancel_request') {
      const approval = this.approvals.get(frame.request_id);
      if (approval) approval.cancelled = true;
      return;
    }
    if (frame.session_id !== undefined && (!uuid(frame.session_id) || this.native && frame.session_id !== this.native.nativeId || this.provisionalSessionId && frame.session_id!==this.provisionalSessionId)) { this.fail('claude_session_mismatch'); return; }
    if ((['assistant', 'user', 'result','command_lifecycle'].includes(frame.type) || frame.type === 'system' && frame.subtype === 'init') && !uuid(frame.uuid)) { this.fail('claude_frame_invalid'); return; }
    if (nonempty(frame.uuid)) {
      const body = fingerprint(frame), previous = this.frames.get(frame.uuid);
      if (previous !== undefined) { if (previous !== body) this.fail('claude_frame_rewritten'); return; }
      this.frames.set(frame.uuid, body);
    }
    // Exact 2.1.220 schema @246207822: queue notifications precede system/init.
    // command_uuid is our inbound user UUID, not the universal notification UUID.
    if(frame.type==='command_lifecycle') {
      const attempt=[...this.attempts.values()].find(a=>a.userId===frame.command_uuid);
      if(!attempt||!uuid(frame.session_id)||this.expectedId&&frame.session_id!==this.expectedId
        ||!['queued','started','completed','cancelled','discarded'].includes(frame.state)) {
        this.fail('claude_command_scope_mismatch');return;
      }
      if(frame.state==='cancelled'||frame.state==='discarded'){this.fail('claude_command_cancelled');return;}
      const order=['queued','started','completed'],prior=this.commandStates.get(frame.command_uuid);
      if(prior&&order.indexOf(frame.state)<order.indexOf(prior)){this.fail('claude_command_state_regressed');return;}
      this.commandStates.set(frame.command_uuid,frame.state);
      if(!this.native)this.provisionalSessionId=frame.session_id;
      return; // Even completed is NOT an assistant final/result receipt or an idle signal.
    }
    if (frame.type === 'system' && frame.subtype === 'init') {
      if (!this.active || !['starting', 'open'].includes(this.phase)) { this.fail('claude_unsolicited_init'); return; }
      if (!uuid(frame.session_id) || this.expectedId && frame.session_id !== this.expectedId) { this.fail('claude_resume_mismatch'); return; }
      if (frame.cwd !== this.policy.cwd || frame.model !== this.policy.model || !['manual', 'default'].includes(frame.permissionMode)) { this.fail('claude_native_policy_mismatch'); return; }
      if (frame.claude_code_version !== '2.1.220') { this.fail('claude_version_unsupported'); return; }
      if (this.native && (this.native.model !== frame.model || this.native.cwd !== frame.cwd)) { this.fail('claude_native_policy_mismatch'); return; }
      this.native = Object.freeze({ agent: 'claude', nativeId: frame.session_id, cwd: frame.cwd, model: frame.model });
      this.identity = composeClaudeIdentity(this.native, this.policy); return;
    }
    if (frame.type === 'system' && ['model_fallback', 'model_consent_fallback', 'model_refusal_no_fallback', 'model_refusal_fallback'].includes(frame.subtype)
      || frame.type === 'conversation_reset') { this.fail('claude_native_binding_changed'); return; }
    if (frame.type === 'stream_event' || frame.type === 'tool_progress') {
      if (!this.active && (frame.type === 'tool_progress' || frame.event?.type !== 'ping')) this.fail('claude_unexpected_background_work');
      return; // never completion proof
    }
    const attempt = this.active;
    if (!attempt) {
      if (frame.type === 'system' && ['task_started', 'task_progress'].includes(frame.subtype)) this.fail('claude_unexpected_background_work');
      else if (['assistant', 'result', 'user'].includes(frame.type)) this.fail('claude_unexpected_turn_frame');
      return;
    }
    const native = this.native;
    // --replay-user-messages may ACK input before submitMessage emits init. Echo is never identity/final proof.
    if (!native && frame.type === 'user' && frame.uuid === attempt.userId && frame.message?.role === 'user'
      && frame.message.content === attempt.text && !frame.isSynthetic && frame.parent_tool_use_id === null
      && (!this.expectedId || frame.session_id === this.expectedId)) return;
    if (!native || frame.session_id !== native.nativeId) { this.fail('claude_session_mismatch'); return; }
    // Native task schemas @246195347/246195764/246200371. A background task is not
    // finished merely because its launch tool returned or the main agent wrote end_turn.
    if (frame.type === 'system' && ['task_started', 'task_progress', 'task_notification'].includes(frame.subtype)) {
      if (!nonempty(frame.task_id)) { this.fail('claude_task_invalid'); return; }
      if (frame.subtype !== 'task_notification') attempt.tasks.add(frame.task_id);
      else if (!attempt.tasks.has(frame.task_id)) this.fail('claude_task_scope_mismatch');
      else if (frame.status !== 'completed') this.fail('claude_task_not_completed');
      else attempt.tasks.delete(frame.task_id);
      return;
    }
    if (frame.type === 'assistant') {
      // This adapter does not support replacement/retraction. Stop before filtering
      // meta/subagent frames so an old candidate cannot survive a tombstone.
      if (frame.supersedes!==undefined && (!Array.isArray(frame.supersedes)||frame.supersedes.length>0)) { this.fail('claude_assistant_retracted'); return; }
      if (frame.aborted || frame.is_virtual || frame.is_api_error_message) { this.fail('claude_assistant_not_final'); return; }
      if (frame.parent_tool_use_id !== null || frame.is_meta) return;
      if (frame.error || !object(frame.message)) { this.fail('claude_assistant_error'); return; }
      const message = frame.message;
      if (message.role !== 'assistant' || message.model !== native.model || !Array.isArray(message.content)) { this.fail('claude_assistant_invalid'); return; }
      if (message.stop_reason==='refusal'||message.content.some((block:unknown)=>object(block)&&block.type==='refusal')) { this.fail('claude_assistant_refusal'); return; }
      for (const block of message.content) if (object(block) && block.type === 'tool_use') {
        if (!nonempty(block.id) || !nonempty(block.name) || !object(block.input) || attempt.tools.has(block.id)) { this.fail('claude_tool_invalid'); return; }
        attempt.tools.set(block.id, { name: block.name, input: structuredClone(block.input) });
      }
      // Pin's SG(content) @229000479 picks the last block; result emitter @246341908 uses its text.
      const last = message.content.at(-1);
      // Pin emits at content_block_stop (@237565042), before message_delta mutates
      // the in-memory transcript stop_reason (@237567100). An explicit null may
      // nominate text, but only an exact correlated end_turn/completed result can finish it.
      attempt.assistantStopPending=message.stop_reason===null;
      attempt.finalSeen = (message.stop_reason === 'end_turn'||attempt.assistantStopPending) && attempt.tools.size === 0 && object(last) && last.type === 'text' && typeof last.text === 'string';
      if (attempt.finalSeen) attempt.finalText = last.text;
      return;
    }
    if (frame.type === 'user') {
      const blocks = frame.message?.content;
      if (Array.isArray(blocks) && blocks.length && blocks.every((b: unknown) => object(b) && b.type === 'tool_result')) {
        for (const block of blocks) { if (!attempt.tools.delete(block.tool_use_id)) { this.fail('claude_tool_result_mismatch'); return; } }
      } else if (frame.uuid !== attempt.userId || frame.message?.role !== 'user' || frame.message.content !== attempt.text || frame.isSynthetic) this.fail('claude_foreign_user');
      return;
    }
    if (frame.type === 'result') {
      // A known old terminal frame cannot finish a new operation, even with another frame UUID.
      if (frame.user_message_uuid !== attempt.userId && [...this.attempts.values()].some(a => a !== attempt && a.userId === frame.user_message_uuid)) return;
      try {
        const text = validateClaudeResult(frame, { nativeId: this.native!.nativeId, userId: attempt.userId,
          finalSeen: attempt.finalSeen, finalText: attempt.finalText, assistantStopPending:attempt.assistantStopPending,
          pendingTools: attempt.tools.size + attempt.tasks.size, pendingApproval: this.pendingApproval });
        clearTimeout(attempt.timer); attempt.identityAtCompletion = this.identity!; this.active = undefined; this.phase = 'open';
        attempt.resolve(Object.freeze({ operationId: attempt.operationId, nativeId: this.native!.nativeId, turnId: attempt.userId, text, state: 'completed' }));
      } catch (e) { this.fail(e instanceof ProtocolError ? e.code : 'claude_result_invalid'); }
    }
  }

  private async deny(id: string): Promise<void> {
    await this.wire.send({ type: 'control_response', response: { subtype: 'success', request_id: id,
      response: { behavior: 'deny', message: 'Host approval unavailable or scope mismatch' } } });
  }
  private handleApproval(frame: Frame): void {
    if (!nonempty(frame.request_id) || !object(frame.request)) { this.fail('claude_approval_invalid'); return; }
    const id = frame.request_id, request = frame.request, attempt = this.active;
    const deny = () => { void this.deny(id).catch(() => this.fail('claude_approval_write_failed')); };
    if (request.subtype !== 'can_use_tool') {
      void this.wire.send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Unsupported control request' } })
        .catch(() => this.fail('claude_approval_write_failed'));
      return;
    }
    const tool = attempt?.tools.get(request.tool_use_id);
    if (this.seenRequests.has(id)) { deny(); this.fail('claude_approval_duplicate'); return; }
    this.seenRequests.add(id);
    if (!['starting', 'open'].includes(this.phase) || !this.native || !attempt || !tool || tool.name !== request.tool_name || fingerprint(tool.input) !== fingerprint(request.input)
      || frame.session_id !== undefined && frame.session_id !== this.native?.nativeId || !this.hooks.approve) { deny(); return; }
    const approval: Approval = { id, turn: attempt, request: structuredClone(request), cancelled: false, decided: false, responding: false };
    this.approvals.set(id, approval);
    const input: ProtocolApproval = { id, nativeId: this.native!.nativeId, turnId: attempt.userId, tool: tool.name, details: structuredClone(request.input) };
    void Promise.resolve().then(() => this.hooks.approve!(input)).catch(() => 'deny' as const).then(async verdict => {
      if (approval.cancelled || approval.decided || approval.responding) return;
      approval.responding = true;
      const allow = verdict === 'allow' && ['starting', 'open'].includes(this.phase) && this.active === attempt
        && attempt.tools.get(request.tool_use_id)?.name === approval.request.tool_name
        && fingerprint(attempt.tools.get(request.tool_use_id)?.input) === fingerprint(approval.request.input);
      await this.wire.send({ type: 'control_response', response: { subtype: 'success', request_id: id,
        response: allow ? { behavior: 'allow', updatedInput: structuredClone(approval.request.input) } : { behavior: 'deny', message: 'Host denied or request no longer current' } } });
      approval.decided = true;
    }).catch(() => this.fail('claude_approval_write_failed'));
  }
}
