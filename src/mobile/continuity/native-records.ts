/** Strict native JSONL evidence only. Never reuse a transcript renderer that exposes reasoning. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative } from 'node:path';

export type NativeAgent = 'codex' | 'claude';
/** Positive Claude Read file-result provenance, not a synthetic native is_error:false/exit code. */
export interface NativeReadSuccessEvidence {
  source: 'claude-read-file'; version: 1; toolCallId: string;
  replyToSourceId: string; replyToIndex: number; filePath: string;
  startLine: number; numLines: number; totalLines: number;
  fileContentHash: string; publicOutputHash: string;
}
export interface NativeEvent {
  sourceId: string; role: string; text: string; metadata?: Record<string, unknown>;
  /** Zero-based physical JSONL record index, including ignored metadata records. */
  index: number; ts?: string;
}
export interface NativeAssistantMessage {
  sourceId: string; text: string; index: number; replyToSourceId: string; replyToIndex: number;
  final: boolean; turnId?: string; ts?: string;
}
export interface NativeRecords {
  nativeId: string; cwd: string; model?: string; events: NativeEvent[];
  turnComplete: boolean; pendingTools: boolean; assistantMessages: NativeAssistantMessage[];
  refused: boolean; interrupted: boolean; lastUserSourceId?: string; lastUserIndex?: number;
}
export class NativeRecordsError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'NativeRecordsError'; }
}
export const NATIVE_RECORD_LIMITS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxLineBytes: 2 * 1024 * 1024, maxRecords: 50_000, maxTools: 2000 });
export interface NativeReadOptions {
  allowedRoot: string; expectedCwd: string; maxBytes?: number; maxLineBytes?: number; maxRecords?: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string): never { throw new NativeRecordsError(code); }
const token = (v: any): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\x00\r\n]/.test(v);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const textHash = (v: string) => createHash('sha256').update(v).digest('hex');
/** Unknown/error/truncated/conflicting shapes provide no success evidence. Never inspect output prose for success. */
function claudeReadFileEvidence(d: any, id: string, output: any, tool: { name: string; input: any; recordId?: string;
  prompt: { sourceId: string; index: number } }, prompt?: { sourceId: string; index: number }): NativeReadSuccessEvidence | undefined {
  const blocks = d.message?.content, r = d.toolUseResult;
  if (tool.name !== 'Read' || !Array.isArray(blocks) || blocks.length !== 1 || blocks[0]?.type !== 'tool_result'
    || blocks[0].tool_use_id !== id || blocks[0].is_error !== undefined && blocks[0].is_error !== false
    || !token(tool.recordId) || d.parentUuid !== tool.recordId
    || d.sourceToolAssistantUUID !== undefined && d.sourceToolAssistantUUID !== tool.recordId || !prompt
    || prompt.sourceId !== tool.prompt.sourceId || prompt.index !== tool.prompt.index
    || !object(r) || r.type !== 'text' || !object(r.file) || typeof output !== 'string') return;
  const f = r.file, input = tool.input;
  // Explicit conflicting metadata wins over a superficially positive file discriminant.
  for (const v of [d, d.message, blocks[0], r, f]) {
    if (['is_error','isError','error','truncated','isTruncated','interrupted'].some(k => v[k] !== undefined && v[k] !== false)
      || ['exit_code','exitCode'].some(k => v[k] !== undefined && v[k] !== 0)
      || v.success !== undefined && v.success !== true || v.status !== undefined && v.status !== 'success') return;
  }
  if (!object(input) || Object.keys(input).some(k => !['file_path', 'path', 'offset', 'limit'].includes(k))) return;
  const path = input.file_path ?? input.path;
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path !== f.filePath
    || input.file_path !== undefined && input.path !== undefined && input.file_path !== input.path
    || typeof f.content !== 'string') return;
  const positiveInt = (v: any) => Number.isSafeInteger(v) && v >= 1;
  if (![f.startLine, f.numLines, f.totalLines].every(positiveInt)
    || !Number.isSafeInteger(f.startLine + f.numLines - 1) || f.startLine + f.numLines - 1 > f.totalLines
    || input.offset !== undefined && !positiveInt(input.offset) || input.limit !== undefined && !positiveInt(input.limit)
    || f.startLine !== (input.offset ?? 1) || input.limit !== undefined && f.numLines > input.limit) return;
  // Claude's native file line count includes a terminal empty split when content ends with LF.
  const fileLines = f.content.split('\n');
  if (fileLines.length !== f.numLines) return;
  if (output !== f.content) {
    // Only the known Read rendering/suffix: arbitrary prose and omitted/altered lines cannot establish success.
    const body = output.replace(/\n<system-reminder>[\s\S]*<\/system-reminder>\s*$/, '');
    const lines = body.endsWith('\n') ? body.slice(0, -1).split('\n') : body.split('\n');
    if (lines.length !== fileLines.length || lines.some((line: string, i: number) => {
      const m = /^\s*(\d+)(?:→|\t)(.*)$/.exec(line);
      return !m || Number(m[1]) !== f.startLine + i || m[2] !== fileLines[i];
    })) return;
  }
  return { source: 'claude-read-file', version: 1, toolCallId: id, replyToSourceId: prompt.sourceId,
    replyToIndex: prompt.index, filePath: path, startLine: f.startLine, numLines: f.numLines, totalLines: f.totalLines,
    fileContentHash: textHash(f.content), publicOutputHash: textHash(output) };
}
function cwdValue(v: unknown): string {
  if (typeof v !== 'string' || !isAbsolute(v) || normalize(v) !== v || /[\x00\r\n]/.test(v)) fail('native_cwd_invalid');
  return v as string;
}
function limit(v: number | undefined, ceiling: number): number {
  if (v === undefined) return ceiling;
  if (!Number.isSafeInteger(v) || v < 1 || v > ceiling) fail('native_limit_invalid');
  return v;
}
const hiddenKeys = /^(thinking|reasoning|analysis|encrypted_content|signature|internal_chat_message_metadata_passthrough)$/i;
/** Tool inputs/results are data; project a clone without native hidden-reasoning fields. */
function publicData(v: any, depth = 0): any {
  if (depth > 24) fail('native_tool_data_limit');
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return v;
  if (Array.isArray(v)) return v.map(x => publicData(x, depth + 1)).filter(x => x !== undefined);
  if (!object(v)) fail('native_tool_data_invalid');
  if (['thinking', 'reasoning', 'redacted_thinking'].includes(v.type)) return undefined;
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, value] of Object.entries(v)) if (!hiddenKeys.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k)) { const projected = publicData(value, depth + 1); if (projected !== undefined) out[k] = projected; }
  return out;
}
function publicText(content: any): { text: string; refusal: boolean } {
  if (typeof content === 'string') return { text: content, refusal: false };
  if (!Array.isArray(content)) fail('native_content_invalid');
  const parts: string[] = []; let refusal = false;
  for (const b of content) {
    if (!object(b) || typeof b.type !== 'string') fail('native_content_invalid');
    if (['text', 'Text', 'input_text', 'output_text'].includes(b.type)) {
      if (typeof b.text !== 'string') fail('native_content_invalid'); parts.push(b.text);
    } else if (b.type === 'refusal') {
      if (typeof (b.refusal ?? b.text) !== 'string') fail('native_refusal_invalid');
      parts.push(b.refusal ?? b.text); refusal = true;
    } else if (!['thinking', 'redacted_thinking', 'reasoning', 'image', 'input_image', 'output_image', 'tool_use', 'tool_result'].includes(b.type)) fail('native_content_unsupported');
  }
  return { text: parts.join('\n'), refusal };
}
function rowsFrom(text: string, limits: { maxBytes: number; maxLineBytes: number; maxRecords: number } = NATIVE_RECORD_LIMITS): Record<string, any>[] {
  if (typeof text !== 'string' || !text.length || Buffer.byteLength(text) > limits.maxBytes) fail('native_size_limit');
  if (Buffer.from(text).toString('utf8') !== text || text.includes('\0')) fail('native_encoding_invalid');
  if (!text.endsWith('\n')) fail('native_truncated');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > limits.maxRecords) fail('native_record_limit');
  return lines.map(line => {
    if (!line.trim() || Buffer.byteLength(line) > limits.maxLineBytes) fail('native_line_invalid');
    let value: any; try { value = JSON.parse(line); } catch { return fail('native_json_invalid'); }
    if (!object(value) || typeof value.type !== 'string') fail('native_record_invalid');
    return value;
  });
}

export function parseNativeRecords(agent: NativeAgent, nativeId: string, text: string): NativeRecords {
  if (!['codex', 'claude'].includes(agent) || !UUID.test(nativeId)) fail('native_identity_invalid');
  const rows = rowsFrom(text); let cwd: string | undefined, model: string | undefined, identitySeen = false;
  const checkId = (v: unknown) => { if (typeof v !== 'string' || v !== nativeId) fail('native_identity_mismatch'); identitySeen = true; };
  const checkCwd = (v: unknown) => { const next = cwdValue(v); if (cwd !== undefined && next !== cwd) fail('native_cwd_mismatch'); cwd = next; };
  const checkModel = (v: unknown) => { if (v !== undefined) { if (!token(v)) fail('native_model_invalid'); model = v; } };
  // Verify all declared identities before emitting anything. Never return a partial parse on failure.
  let sessionHeaders = 0;
  for (const d of rows) {
    if (agent === 'claude') {
      for (const k of ['sessionId', 'session_id']) if (d[k] !== undefined) checkId(d[k]);
      if (d.cwd !== undefined) checkCwd(d.cwd);
      if (['user', 'assistant'].includes(d.type) && !d.isSidechain) {
        if (d.sessionId === undefined && d.session_id === undefined) fail('native_identity_missing');
        if (d.cwd === undefined) fail('native_cwd_missing');
      }
    } else {
      const p = d.payload;
      if (d.type === 'session_meta') {
        if (!object(p) || ++sessionHeaders !== 1) fail('native_header_invalid');
        checkId(p.id); if (p.session_id !== undefined) checkId(p.session_id); checkCwd(p.cwd);
      }
      if (object(p)) {
        if (p.session_id !== undefined) checkId(p.session_id);
        if (p.thread_id !== undefined) checkId(p.thread_id);
        if (d.type === 'turn_context') { if (p.cwd === undefined) fail('native_cwd_missing'); checkCwd(p.cwd); checkModel(p.model); }
      }
    }
  }
  if (!identitySeen || !cwd || (agent === 'codex' && sessionHeaders !== 1)) fail('native_identity_missing');

  const events: NativeEvent[] = [], assistantMessages: NativeAssistantMessage[] = [];
  const seen = new Map<string, string>(), tools = new Map<string, { name: string; input: any; prompt: Prompt; recordId?: string }>(), pending = new Set<string>();
  type Prompt = { sourceId: string; index: number; turnId?: string };
  let latest: Prompt | undefined, complete = false, refused = false, interrupted = false, currentTurn: string | undefined, unverifiedTurn = false;
  const parents = new Map<string, string | null>(), userNodes = new Map<string, Prompt>();
  if (agent === 'claude') for (const d of rows) if (token(d.uuid)) {
    const parent = d.parentUuid ?? d.logicalParentUuid ?? null;
    if (parent !== null && !token(parent)) fail('native_parent_invalid');
    if (parents.has(d.uuid)) fail('native_record_identity_duplicate'); parents.set(d.uuid, parent);
  }
  const visitedParents = new Set<string>();
  for (const node of parents.keys()) {
    const path = new Set<string>(); let cursor: string | null | undefined = node;
    while (cursor && parents.has(cursor) && !visitedParents.has(cursor)) {
      if (path.has(cursor)) fail('native_parent_cycle'); path.add(cursor); cursor = parents.get(cursor);
    }
    for (const key of path) visitedParents.add(key);
  }
  const source = (d: any, index: number, kind: string, id?: string) => `${agent}:${nativeId}:${kind}:${id ?? (agent === 'claude' && token(d.uuid) ? d.uuid : Number.isSafeInteger(d.ordinal) && d.ordinal >= 0 ? 'ordinal-' + d.ordinal : 'line-' + index)}`;
  const add = (sourceId: string, role: string, text: string, index: number, metadata?: Record<string, unknown>, ts?: string) => {
    if (typeof text !== 'string') fail('native_text_invalid');
    const fingerprint = digest({ role, text, metadata }); const before = seen.get(sourceId);
    if (before !== undefined) { if (before !== fingerprint) fail('native_event_conflict'); return false; }
    seen.set(sourceId, fingerprint); events.push({ sourceId, role, text, index, ...(metadata ? { metadata } : {}), ...(ts ? { ts } : {}) }); return true;
  };
  const newUser = (sid: string, value: string, index: number, ts?: string, uuid?: string) => {
    const prompt: Prompt = { sourceId: sid, index, ...(currentTurn ? { turnId: currentTurn } : {}) };
    if (!add(sid, 'user', value, index, undefined, ts)) return;
    latest = prompt; complete = false; refused = false; interrupted = false;
    if (uuid) userNodes.set(uuid, prompt);
  };
  const claudePrompt = (d: any): Prompt | undefined => {
    let cursor = d.parentUuid ?? d.logicalParentUuid; const walked = new Set<string>();
    while (token(cursor)) {
      if (walked.has(cursor)) fail('native_parent_cycle'); walked.add(cursor);
      const found = userNodes.get(cursor); if (found) return found;
      if (!parents.has(cursor)) return undefined; cursor = parents.get(cursor);
    }
    return undefined;
  };
  const assistant = (d: any, value: { text: string; refusal: boolean }, sid: string, index: number, prompt: Prompt | undefined, final: boolean) => {
    if (!value.text && !value.refusal) return;
    if (!prompt) fail('native_prompt_link_missing');
    const metadata = { replyToSourceId: prompt.sourceId, replyToIndex: prompt.index, final, ...(value.refusal ? { refusal: true } : {}), ...(prompt.turnId ? { turnId: prompt.turnId } : {}) };
    const inserted = add(sid, 'assistant', value.text, index, metadata, typeof d.timestamp === 'string' ? d.timestamp : undefined);
    if (!value.refusal && inserted) assistantMessages.push({ sourceId: sid, text: value.text, index, replyToSourceId: prompt.sourceId, replyToIndex: prompt.index, final, ...(prompt.turnId ? { turnId: prompt.turnId } : {}), ...(typeof d.timestamp === 'string' ? { ts: d.timestamp } : {}) });
    if (latest?.sourceId === prompt.sourceId) {
      if (value.refusal) { refused = true; complete = false; }
      else if (agent === 'claude' && final && !pending.size) complete = true;
    }
  };
  const call = (d: any, index: number, id: any, name: any, input: any, prompt: Prompt | undefined) => {
    if (!token(id) || !token(name) || !prompt || tools.size >= NATIVE_RECORD_LIMITS.maxTools) fail('native_tool_call_invalid');
    const safeInput = publicData(input); const old = tools.get(id);
    if (old) { if (digest([old.name, old.input, old.prompt.sourceId]) !== digest([name, safeInput, prompt.sourceId])) fail('native_tool_conflict'); return; }
    tools.set(id, { name, input: safeInput, prompt, ...(agent === 'claude' ? { recordId: d.uuid } : {}) }); pending.add(id); complete = false;
    add(source(d, index, 'tool-call', id), 'tool', name, index, { toolName: name, toolCallId: id, toolInput: safeInput, phase: 'call', replyToSourceId: prompt.sourceId, replyToIndex: prompt.index });
  };
  const result = (d: any, index: number, id: any, output: any, error?: boolean, exitCode?: number) => {
    if (!token(id)) fail('native_tool_result_invalid'); const tool = tools.get(id); if (!tool) fail('native_tool_result_orphan');
    let parsedOutput = output; if (typeof output === 'string') { try { const parsed = JSON.parse(output); if (object(parsed) || Array.isArray(parsed)) parsedOutput = parsed; } catch { /* Public plain text is not a JSON envelope. */ } }
    const safeOutput = publicData(parsedOutput) ?? null, value = typeof safeOutput === 'string' ? safeOutput : JSON.stringify(safeOutput);
    const linkedPrompt = agent === 'claude' ? claudePrompt(d) : undefined;
    const successEvidence = agent === 'claude' && latest?.sourceId === linkedPrompt?.sourceId
      ? claudeReadFileEvidence(d, id, output, tool, linkedPrompt) : undefined;
    if (successEvidence) successEvidence.publicOutputHash = textHash(value);
    add(source(d, index, 'tool-result', id), 'tool', value, index, { toolName: tool.name, toolCallId: id, toolInput: tool.input, toolOutput: safeOutput, ...(error !== undefined ? { resultError: error } : {}), ...(exitCode !== undefined ? { exitCode } : {}), ...(successEvidence ? { successEvidence } : {}), phase: 'result', replyToSourceId: tool.prompt.sourceId, replyToIndex: tool.prompt.index });
    pending.delete(id); complete = false;
  };

  const claudeIgnored = new Set(['last-prompt', 'mode', 'permission-mode', 'attachment', 'file-history-snapshot', 'ai-title', 'queue-operation', 'progress']);
  const codexIgnored = new Set(['world_state', 'token_usage_record', 'compacted']);
  for (let index = 0; index < rows.length; index++) {
    const d = rows[index]; if (d.isSidechain) continue;
    if (agent === 'claude') {
      if (claudeIgnored.has(d.type)) continue;
      if (d.type === 'system') {
        if (!['stop_hook_summary', 'turn_duration', 'compact_boundary', 'api_error', 'local_command'].includes(d.subtype) || d.subtype === 'api_error') { complete = false; unverifiedTurn = true; }
        if (d.subtype === 'stop_hook_summary' && d.preventedContinuation === true) complete = false;
        if (d.stopReason === 'refusal') { refused = true; complete = false; }
        continue;
      }
      if (!['user', 'assistant'].includes(d.type) || !object(d.message) || !token(d.uuid)) fail('native_record_unsupported');
      const m = d.message; if (m.role !== undefined && m.role !== d.type) fail('native_role_mismatch');
      const content = m.content; const visible = publicText(content);
      if (d.type === 'user') {
        const toolResults = Array.isArray(content) ? content.filter(b => b.type === 'tool_result') : [];
        if (toolResults.length) for (const b of toolResults) result(d, index, b.tool_use_id, publicText(b.content).text, typeof b.is_error === 'boolean' ? b.is_error : undefined);
        else if (!d.isMeta && !d.isCompactSummary && visible.text) newUser(source(d, index, 'message'), visible.text, index, d.timestamp, d.uuid);
        continue;
      }
      checkModel(m.model); const prompt = claudePrompt(d);
      if (latest?.sourceId === prompt?.sourceId) complete = false;
      if (d.isApiErrorMessage === true || m.is_error === true) unverifiedTurn = true;
      if (Array.isArray(content)) for (const b of content) if (b.type === 'tool_use') call(d, index, b.id, b.name, b.input, prompt);
      if (m.stop_reason === 'refusal' || m.stop_reason === 'content_filter') visible.refusal = true;
      const final = m.stop_reason === 'end_turn';
      assistant(d, visible, source(d, index, 'message'), index, prompt, final);
      if (['tool_use', 'max_tokens', 'pause_turn'].includes(m.stop_reason)) complete = false;
      continue;
    }
    const p = d.payload;
    if (d.type === 'session_meta' || codexIgnored.has(d.type)) continue;
    if (d.type === 'turn_context') { if (token(p.turn_id)) { if (p.turn_id !== currentTurn) complete = false; currentTurn = p.turn_id; } continue; }
    if (!object(p)) fail('native_record_invalid');
    if (d.type === 'event_msg') {
      if (['task_started', 'turn_started'].includes(p.type)) { if (!token(p.turn_id)) fail('native_turn_id_missing'); currentTurn = p.turn_id; complete = false; interrupted = false; unverifiedTurn = false; }
      else if (['task_complete', 'turn_complete'].includes(p.type)) {
        const last = assistantMessages.at(-1);
        complete = !!currentTurn && p.turn_id === currentTurn && latest?.turnId === currentTurn && !!last?.final && last.replyToSourceId === latest.sourceId && !pending.size && !refused && !interrupted && !unverifiedTurn;
      } else if (['turn_aborted', 'task_cancelled', 'task_interrupted'].includes(p.type)) { complete = false; interrupted = true; }
      else if (p.type === 'agent_message') {
        if (p.phase === 'analysis' || p.channel === 'analysis') { complete = false; continue; }
        complete = false;
        assistant(d, { text: typeof p.message === 'string' ? p.message : fail('native_content_invalid'), refusal: false }, source(d, index, 'message', token(p.id) ? p.id : undefined), index, latest?.turnId === currentTurn ? latest : undefined, p.phase === 'final_answer');
      } else if (p.type === 'item_completed') {
        if (!object(p.item)) fail('native_record_invalid');
        if (p.item.type === 'AgentMessage' && (p.item.phase === 'analysis' || p.item.channel === 'analysis')) { complete = false; continue; }
        if (p.item.type === 'AgentMessage') assistant(d, publicText(p.item.content), source(d, index, 'message', token(p.item.id) ? p.item.id : undefined), index, latest?.turnId === currentTurn ? latest : undefined, p.item.phase === 'final_answer');
        else if (p.item.type !== 'UserMessage' && p.item.type !== 'Reasoning') { complete = false; unverifiedTurn = true; }
      } else if (!['token_count', 'thread_settings_applied', 'agent_reasoning', 'agent_reasoning_raw_content', 'user_message'].includes(p.type)) { complete = false; unverifiedTurn = true; }
      continue;
    }
    if (d.type !== 'response_item' || typeof p.type !== 'string') fail('native_record_unsupported');
    if (['reasoning', 'additional_tools'].includes(p.type)) continue;
    if (p.type === 'message') {
      if (['developer', 'system'].includes(p.role) || p.channel === 'analysis' || p.phase === 'analysis') continue;
      if (!['user', 'assistant'].includes(p.role)) fail('native_role_unsupported');
      const visible = publicText(p.content), sid = source(d, index, 'message', token(p.id) ? p.id : undefined);
      if (p.role === 'user') { if (visible.text) newUser(sid, visible.text, index, d.timestamp); }
      else { if (!seen.has(sid)) complete = false; assistant(d, visible, sid, index, latest?.turnId === currentTurn ? latest : undefined, p.phase === 'final_answer' && (p.status === undefined || p.status === 'completed')); }
    } else if (['function_call', 'custom_tool_call'].includes(p.type)) {
      let input = p.input;
      if (p.type === 'function_call') { if (typeof p.arguments !== 'string') fail('native_tool_call_invalid'); try { input = JSON.parse(p.arguments); } catch { fail('native_tool_arguments_invalid'); } }
      call(d, index, p.call_id, p.name, input, latest?.turnId === currentTurn ? latest : undefined);
    } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
      let decoded = p.output; if (typeof p.output === 'string') { try { decoded = JSON.parse(p.output); } catch { /* plain output */ } }
      const structured = object(decoded) ? decoded : undefined;
      result(d, index, p.call_id, p.output, typeof p.is_error === 'boolean' ? p.is_error : typeof structured?.is_error === 'boolean' ? structured.is_error : Number.isInteger(structured?.exit_code) ? structured!.exit_code !== 0 : undefined, Number.isInteger(structured?.exit_code) ? structured!.exit_code : undefined);
    } else if (p.type === 'refusal') {
      assistant(d, { text: typeof p.refusal === 'string' ? p.refusal : '', refusal: true }, source(d, index, 'message', token(p.id) ? p.id : undefined), index, latest, false);
    } else fail('native_response_unsupported');
  }
  return { nativeId, cwd, ...(model ? { model } : {}), events, turnComplete: complete && !pending.size && !refused && !interrupted && !unverifiedTurn,
    pendingTools: pending.size > 0, assistantMessages, refused, interrupted, ...(latest ? { lastUserSourceId: latest.sourceId, lastUserIndex: latest.index } : {}) };
}

/** Read a complete stable private file only, never an unbounded tail or guessed filename. */
export async function readNativeRecords(agent: NativeAgent, nativeId: string, file: string, options: NativeReadOptions): Promise<NativeRecords> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const maxBytes = limit(options.maxBytes, NATIVE_RECORD_LIMITS.maxBytes), maxLineBytes = limit(options.maxLineBytes, NATIVE_RECORD_LIMITS.maxLineBytes), maxRecords = limit(options.maxRecords, NATIVE_RECORD_LIMITS.maxRecords);
    const expected = cwdValue(options.expectedCwd);
    const root = await realpath(options.allowedRoot), path = await realpath(file), rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('native_path_outside_root');
    const entry = await lstat(file); if (entry.isSymbolicLink()) fail('native_path_outside_root'); if (!entry.isFile()) fail('native_not_regular');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat(); if (!before.isFile() || before.size < 1 || before.size > maxBytes) fail('native_size_limit');
    const buffer = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < buffer.length) { const r = await handle.read(buffer, offset, buffer.length - offset, offset); if (!r.bytesRead) break; offset += r.bytesRead; }
    const after = await handle.stat(), freshPath = await realpath(file), atPath = await lstat(freshPath);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev || freshPath !== path || atPath.ino !== before.ino || atPath.dev !== before.dev) fail('native_file_changed');
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)); } catch { return fail('native_encoding_invalid'); }
    rowsFrom(text, { maxBytes, maxLineBytes, maxRecords });
    const result = parseNativeRecords(agent, nativeId, text); if (result.cwd !== expected) fail('native_cwd_mismatch'); return result;
  } catch (e) { if (e instanceof NativeRecordsError) throw e; throw new NativeRecordsError('native_read_unavailable'); }
  finally { if (handle) { try { await handle.close(); } catch { throw new NativeRecordsError('native_read_unavailable'); } } }
}
