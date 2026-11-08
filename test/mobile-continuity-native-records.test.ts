import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NATIVE_RECORD_LIMITS, NativeRecordsError, parseNativeRecords, readNativeRecords } from "../src/mobile/continuity/native-records";
const id = "00000000-0000-4000-8000-000000000001", otherId = "00000000-0000-4000-8000-000000000002", cwd = "/home/example/project";
const hidden = "HIDDEN_REASONING_SENTINEL_NEVER_EXPORT";
const jsonl = (rows: any[]) => rows.map((r, ordinal) => JSON.stringify({ ordinal, ...r })).join("\n") + "\n";
const c = (type: string, uuid: string, parentUuid: string | null, content: any, extra: any = {}) => ({ type, uuid, parentUuid, sessionId: id, cwd, message: { role: type, content, ...(type === "assistant" ? { model: "example-claude", stop_reason: "end_turn" } : {}) }, ...extra });
const cu = (uuid = "u1", parent: string | null = null, text = "อ่าน archive อย่างเดียว") => c("user", uuid, parent, text);
const ca = (uuid = "a1", parent = "u1", text = "อ่านแล้ว รอคำสั่ง") => c("assistant", uuid, parent, [{ type: "text", text }]);
const meta = () => ({ type: "session_meta", payload: { id, session_id: id, cwd, base_instructions: hidden, creator_account_id: "PRIVATE_ACCOUNT_SENTINEL" } });
const start = (turn = "turn-1") => ({ type: "event_msg", payload: { type: "task_started", turn_id: turn } });
const context = (turn = "turn-1") => ({ type: "turn_context", payload: { turn_id: turn, cwd, model: "example-codex", summary: hidden } });
const u = (mid = "u1", text = "อ่าน archive อย่างเดียว") => ({ type: "response_item", payload: { type: "message", id: mid, role: "user", content: [{ type: "input_text", text }] } });
const a = (mid = "a1", text = "อ่านแล้ว รอคำสั่ง") => ({ type: "response_item", payload: { type: "message", id: mid, role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text }] } });
const done = (turn = "turn-1") => ({ type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: "MUST_NOT_BE_USED_AS_REPLY" } });
const codex = () => [meta(), start(), context(), u(), a(), done()];
function rejects(agent: "claude" | "codex", rows: any[], code?: string) { expect(() => parseNativeRecords(agent, id, jsonl(rows))).toThrow(code); }

describe("Claude native evidence excludes hidden content and binds exact prompt", () => {
  test("real end_turn signal plus visible reply identifies its exact user source/index", () => {
    const result = parseNativeRecords("claude", id, jsonl([cu(), ca()]));
    expect(result.nativeId).toBe(id); expect(result.cwd).toBe(cwd); expect(result.model).toBe("example-claude"); expect(result.turnComplete).toBe(true); expect(result.pendingTools).toBe(false);
    expect(result.assistantMessages[0]).toMatchObject({ replyToSourceId: result.events[0].sourceId, replyToIndex: 0, index: 1, final: true });
  });
  test("thinking/redacted blocks and signatures never become events or assistant receipts", () => {
    const thought = c("assistant", "thought", "u1", [{ type: "thinking", thinking: hidden, signature: hidden }, { type: "redacted_thinking", data: hidden }]);
    const result = parseNativeRecords("claude", id, jsonl([cu(), thought, ca("a1", "thought")]));
    expect(JSON.stringify(result)).not.toContain(hidden); expect(result.events).toHaveLength(2); expect(result.assistantMessages).toHaveLength(1);
    expect(result.assistantMessages[0].replyToSourceId).toBe(result.events[0].sourceId);
  });
  test("text without stop_reason does not prove turn completion", () => {
    const row = ca(); delete row.message.stop_reason;
    const result = parseNativeRecords("claude", id, jsonl([cu(), row])); expect(result.turnComplete).toBe(false); expect(result.assistantMessages[0].final).toBe(false);
  });
  test("new user prompt invalidates earlier completion and replies link separately", () => {
    const rows = [cu(), ca(), cu("u2", "a1", "คำสั่งที่สอง")]; const pending = parseNativeRecords("claude", id, jsonl(rows)); expect(pending.turnComplete).toBe(false);
    const result = parseNativeRecords("claude", id, jsonl([...rows, ca("a2", "u2", "คำตอบที่สอง")]));
    expect(result.assistantMessages[0].replyToSourceId).not.toBe(result.assistantMessages[1].replyToSourceId); expect(result.assistantMessages[1].replyToIndex).toBe(2);
  });
  test("parent-linked reply to older prompt cannot finish a newer user turn", () => {
    const result = parseNativeRecords("claude", id, jsonl([cu(), cu("u2", "u1", "newer"), ca("a1", "u1", "older reply")]));
    expect(result.turnComplete).toBe(false); expect(result.assistantMessages[0].replyToIndex).toBe(0); expect(result.lastUserIndex).toBe(1);
  });
  test("orphan parent, duplicate UUID, inconsistent session/cwd and role mismatch fail closed", () => {
    rejects("claude", [cu(), ca("a1", "missing")], "native_prompt_link_missing");
    rejects("claude", [cu(), { ...cu(), message: { role: "user", content: "different" } }], "native_record_identity_duplicate");
    rejects("claude", [cu(), { ...ca(), session_id: otherId }], "native_identity_mismatch");
    rejects("claude", [cu(), { ...ca(), cwd: "/home/example/other" }], "native_cwd_mismatch");
    const wrong = ca(); wrong.message.role = "user"; rejects("claude", [cu(), wrong], "native_role_mismatch");
  });
  test("cyclic Claude ancestry is rejected even when a user anchor can otherwise be found", () => {
    rejects("claude", [cu("u1", "u1"), ca()], "native_parent_cycle");
  });
  test("structured refusal never becomes a normal assistant receipt or successful turn", () => {
    const row = ca(); row.message.stop_reason = "refusal";
    const result = parseNativeRecords("claude", id, jsonl([cu(), row]));
    expect(result.refused).toBe(true); expect(result.turnComplete).toBe(false); expect(result.assistantMessages).toEqual([]); expect(result.events.at(-1)?.metadata?.refusal).toBe(true);
  });
  test("refusal-like prose is not guessed to be structured refusal", () => {
    const result = parseNativeRecords("claude", id, jsonl([cu(), ca("a1", "u1", "Example text: I cannot do that.")])); expect(result.refused).toBe(false);
  });
  test("a later unfinished assistant continuation invalidates the earlier end_turn", () => {
    const row = ca("a2", "a1", "continuing"); delete row.message.stop_reason;
    expect(parseNativeRecords("claude", id, jsonl([cu(), ca(), row])).turnComplete).toBe(false);
    const apiError = ca(); (apiError as any).isApiErrorMessage = true;
    expect(parseNativeRecords("claude", id, jsonl([cu(), apiError])).turnComplete).toBe(false);
  });
  test("stop hook preventing continuation and unknown native status cannot assert safe completion", () => {
    const hook = { type: "system", uuid: "hook", parentUuid: "a1", sessionId: id, cwd, subtype: "stop_hook_summary", preventedContinuation: true };
    expect(parseNativeRecords("claude", id, jsonl([cu(), ca(), hook])).turnComplete).toBe(false);
    expect(parseNativeRecords("claude", id, jsonl([cu(), ca(), { ...hook, subtype: "new_unknown_status" }])).turnComplete).toBe(false);
  });
});

describe("native tools provide scoped public Read evidence, never hidden data", () => {
  const readCall = () => c("assistant", "call", "u1", [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/home/example/archive.jsonl", thinking: hidden, nested: { reasoning: hidden } } }], { message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/home/example/archive.jsonl", thinking: hidden } }] } });
  const readResult = () => c("user", "result", "call", [{ type: "tool_result", tool_use_id: "read-1", is_error: false, content: [{ type: "text", text: "archive rows 1–4" }, { type: "thinking", thinking: hidden }] }]);
  test("pending Read prevents completion until result and a real assistant finish", () => {
    const rows = [cu(), readCall()]; const pending = parseNativeRecords("claude", id, jsonl(rows)); expect(pending.pendingTools).toBe(true); expect(pending.turnComplete).toBe(false);
    const finished = parseNativeRecords("claude", id, jsonl([...rows, readResult(), ca("final", "result")]));
    expect(finished.pendingTools).toBe(false); expect(finished.turnComplete).toBe(true); expect(finished.lastUserIndex).toBe(0);
    const tool = finished.events.filter(e => e.role === "tool"); expect(tool[0].metadata).toMatchObject({ toolName: "Read", toolCallId: "read-1", toolInput: { file_path: "/home/example/archive.jsonl" }, phase: "call" });
    expect(tool[1].metadata).toMatchObject({ toolName: "Read", toolCallId: "read-1", toolOutput: "archive rows 1–4", resultError: false, replyToSourceId: finished.events[0].sourceId });
    expect(JSON.stringify(finished)).not.toContain(hidden);
  });
  test("orphan/changed tool identity cannot fabricate completed retrieval evidence", () => {
    rejects("claude", [cu(), readResult()], "native_tool_result_orphan");
    const changed = readCall(); changed.uuid = "another-call"; changed.message.content[0].name = "Write";
    rejects("claude", [cu(), readCall(), changed], "native_tool_conflict");
  });
  test("tool error is preserved as error, never inferred from output prose", () => {
    const row = readResult(); row.message.content[0].is_error = true;
    const result = parseNativeRecords("claude", id, jsonl([cu(), readCall(), row, ca("final", "result")]));
    expect(result.events.find(e => e.metadata?.phase === "result")?.metadata?.resultError).toBe(true);
  });
  test("Codex function call and structured output expose tool metadata and explicit exit failure", () => {
    const rows = [meta(), start(), context(), u(), { type: "response_item", payload: { type: "function_call", name: "Read", call_id: "read-1", arguments: JSON.stringify({ path: "/home/example/archive.jsonl", reasoning: hidden }) } }];
    expect(parseNativeRecords("codex", id, jsonl(rows)).pendingTools).toBe(true);
    const result = parseNativeRecords("codex", id, jsonl([...rows, { type: "response_item", payload: { type: "function_call_output", call_id: "read-1", output: JSON.stringify({ text: "missing archive", exit_code: 1, thinking: hidden }) } }, a(), done()]));
    expect(result.pendingTools).toBe(false); const tool = result.events.find(e => e.metadata?.phase === "result")!;
    expect(tool.metadata).toMatchObject({ toolName: "Read", toolCallId: "read-1", resultError: true, exitCode: 1 }); expect(JSON.stringify(result)).not.toContain(hidden);
  });
});

describe('Claude positive native Read file-result provenance (synthetic)', () => {
  const filePath = '/home/example/artifacts/context.json';
  const readCall = () => c('assistant', 'read-call', 'u1', [{ type: 'tool_use', id: 'read-proof', name: 'Read', input: { file_path: filePath } }],
    { message: { role: 'assistant', model: 'example-claude', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'read-proof', name: 'Read', input: { file_path: filePath } }] } });
  const readResult = (content = 'synthetic row one\nsynthetic row two') => c('user', 'read-result', 'read-call',
    [{ type: 'tool_result', tool_use_id: 'read-proof', content: content.split('\n').map((line, i) => `${i + 1}→${line}`).join('\n') }],
    { toolUseResult: { type: 'text', file: { filePath, content, startLine: 1, numLines: content.split('\n').length, totalLines: content.split('\n').length } } });
  const parsed = (row = readResult(), call = readCall()) => parseNativeRecords('claude', id, jsonl([cu(), call, row, ca('final-read', 'read-result')]));
  const resultMetadata = (row = readResult(), call = readCall()) => parsed(row, call).events.find(e => e.metadata?.phase === 'result')!.metadata!;
  test('positive text/file shape linked to Read establishes provenance without inventing native error/exit fields', () => {
    const records = parsed(), m = records.events.find(e => e.metadata?.phase === 'result')!.metadata!;
    expect(m.successEvidence).toMatchObject({ source: 'claude-read-file', version: 1, toolCallId: 'read-proof',
      replyToSourceId: records.events[0].sourceId, replyToIndex: 0, filePath, startLine: 1, numLines: 2, totalLines: 2 });
    expect(m).not.toHaveProperty('resultError'); expect(m).not.toHaveProperty('exitCode');
    expect(records.turnComplete).toBe(true); expect(records.pendingTools).toBe(false);
    const evidence = m.successEvidence as any;
    expect(evidence.fileContentHash).toMatch(/^[a-f0-9]{64}$/); expect(evidence.publicOutputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain('synthetic row');
  });
  test('terminal empty split is native data, preserved in provenance/rendering without changing tool output', () => {
    const row = readResult('synthetic row\n'), m = resultMetadata(row);
    expect(m.successEvidence).toMatchObject({ numLines: 2, totalLines: 2 });
    expect(m.toolOutput).toBe('1→synthetic row\n2→');
  });
  test('a successful partial Read proves success of that range, never full-file coverage', () => {
    const call = readCall(); call.message.content[0].input.offset = 4; call.message.content[0].input.limit = 2;
    const row = readResult(); row.toolUseResult.file.startLine = 4; row.toolUseResult.file.totalLines = 9;
    row.message.content[0].content = '4→synthetic row one\n5→synthetic row two';
    expect(resultMetadata(row, call).successEvidence).toMatchObject({ startLine: 4, numLines: 2, totalLines: 9 });
  });
  test('raw matching text and known numbered Read reminder suffix are accepted without including sibling content in metadata', () => {
    const raw = readResult(); raw.message.content[0].content = raw.toolUseResult.file.content;
    expect(resultMetadata(raw).successEvidence).toBeDefined();
    const decorated = readResult(); decorated.message.content[0].content += '\n<system-reminder>synthetic reminder</system-reminder>';
    decorated.toolUseResult.thinking = hidden; decorated.toolUseResult.file.reasoning = hidden;
    const output = parsed(decorated); expect(output.events.find(e => e.metadata?.phase === 'result')?.metadata?.successEvidence).toBeDefined();
    expect(JSON.stringify(output)).not.toContain(hidden);
  });
  test('absence of error without positive structured Read file evidence is still unknown', () => {
    for (const sibling of [undefined, {}, { type: 'text' }, { type: 'text', file: {} }, { type: 'image', file: readResult().toolUseResult.file }]) {
      const row = readResult(); row.toolUseResult = sibling;
      const m = resultMetadata(row); expect(m.successEvidence).toBeUndefined(); expect(m.resultError).toBeUndefined();
    }
  });
  test('explicit error, interruption, truncation and nonzero exit beat positive file discriminant', () => {
    for (const where of ['row', 'message', 'block', 'sibling', 'file']) for (const patch of [
      { is_error: true }, { error: 'synthetic failure' }, { isError: true }, { truncated: true }, { isTruncated: true },
      { interrupted: true }, { exit_code: 1 }, { exitCode: 1 }, { success: false }, { status: 'failed' },
    ]) {
      const row = readResult();
      const holder = where === 'row' ? row : where === 'message' ? row.message : where === 'block' ? row.message.content[0] : where === 'sibling' ? row.toolUseResult : row.toolUseResult.file;
      Object.assign(holder, patch); expect(resultMetadata(row).successEvidence).toBeUndefined();
    }
    const row = readResult(); row.message.content[0].is_error = true;
    expect(resultMetadata(row).resultError).toBe(true);
  });
  test('mismatched path, malformed range/counts, changed content or omitted lines cannot prove success', () => {
    for (const patch of [{ filePath: '/home/example/other' }, { startLine: 2 }, { numLines: 1 }, { totalLines: 1 },
      { startLine: 0 }, { numLines: -1 }, { numLines: 1.5 }, { totalLines: '2' }, { content: 'different content' }]) {
      const row = readResult(); Object.assign(row.toolUseResult.file, patch); expect(resultMetadata(row).successEvidence).toBeUndefined();
    }
    for (const content of ['Read succeeded', '1→synthetic row one', '2→synthetic row one\n3→synthetic row two', '1→different\n2→synthetic row two']) {
      const row = readResult(); row.message.content[0].content = content; expect(resultMetadata(row).successEvidence).toBeUndefined();
    }
  });
  test('tool kind and original input range/path have to agree; file-shaped Bash output is not Read proof', () => {
    for (const patch of [{ offset: 2 }, { limit: 1 }, { offset: 0 }, { limit: -1 }, { path: '/home/example/other' }, { unknown: true }]) {
      const call = readCall(); Object.assign(call.message.content[0].input, patch); expect(resultMetadata(readResult(), call).successEvidence).toBeUndefined();
    }
    const call = readCall(); call.message.content[0].name = 'Bash'; expect(resultMetadata(readResult(), call).successEvidence).toBeUndefined();
  });
  test('one sibling cannot establish success for multiple tool_result blocks in a row', () => {
    const call = readCall(); call.message.content.push({ type: 'tool_use', id: 'read-second', name: 'Read', input: { file_path: filePath } });
    const row = readResult(); row.message.content.push({ ...row.message.content[0], tool_use_id: 'read-second' });
    const records = parsed(row, call), results = records.events.filter(e => e.metadata?.phase === 'result');
    expect(results).toHaveLength(2); expect(results.every(e => e.metadata?.successEvidence === undefined)).toBe(true);
  });
  test('valid tool ID with a foreign prompt/parent does not inherit sibling success', () => {
    const row = readResult(); row.parentUuid = 'u1'; expect(resultMetadata(row).successEvidence).toBeUndefined();
    const rows = [cu(), readCall(), cu('new-user', 'read-call', 'another prompt'), { ...readResult(), parentUuid: 'new-user' }, ca('final-read', 'read-result')];
    const records = parseNativeRecords('claude', id, jsonl(rows));
    expect(records.events.find(e => e.metadata?.phase === 'result')?.metadata?.successEvidence).toBeUndefined();
    expect(records.events.find(e => e.metadata?.phase === 'result')?.metadata?.replyToSourceId).not.toBe(records.lastUserSourceId);
  });
  test('sourceToolAssistantUUID when present must agree with paired assistant call record', () => {
    const matching = readResult(); matching.sourceToolAssistantUUID = 'read-call';
    expect(resultMetadata(matching).successEvidence).toBeDefined();
    for (const value of ['other-call', '', null, 12]) {
      const conflict = readResult(); conflict.sourceToolAssistantUUID = value;
      expect(resultMetadata(conflict).successEvidence).toBeUndefined();
    }
  });
});

describe("Codex native completion, phase and exact prompt evidence", () => {
  test("requires native task_complete for the exact active turn and a visible final reply", () => {
    const result = parseNativeRecords("codex", id, jsonl(codex())); expect(result.turnComplete).toBe(true); expect(result.cwd).toBe(cwd); expect(result.model).toBe("example-codex");
    expect(result.assistantMessages[0]).toMatchObject({ replyToSourceId: result.events[0].sourceId, replyToIndex: 3, turnId: "turn-1", final: true }); expect(JSON.stringify(result)).not.toContain("MUST_NOT_BE_USED_AS_REPLY"); expect(JSON.stringify(result)).not.toContain("PRIVATE_ACCOUNT_SENTINEL");
  });
  test("assistant text or final phase alone, wrong task ID and commentary do not prove completed turn", () => {
    const rows = codex(); expect(parseNativeRecords("codex", id, jsonl(rows.slice(0, -1))).turnComplete).toBe(false);
    expect(parseNativeRecords("codex", id, jsonl([...rows.slice(0, -1), done("other-turn")])).turnComplete).toBe(false);
    const comment = a(); comment.payload.phase = "commentary";
    expect(parseNativeRecords("codex", id, jsonl([meta(), start(), context(), u(), comment, done()])).turnComplete).toBe(false);
  });
  test("new turn_context after a completed turn cannot keep the previous completion flag", () => {
    expect(parseNativeRecords("codex", id, jsonl([...codex(), context("turn-2")])).turnComplete).toBe(false);
  });
  test("reasoning, analysis and developer instructions are excluded from events and receipts", () => {
    const analysis = a("private", hidden); (analysis.payload as any).channel = "analysis";
    const result = parseNativeRecords("codex", id, jsonl([meta(), start(), context(), { type: "response_item", payload: { type: "reasoning", summary: [{ text: hidden }], encrypted_content: hidden } }, { type: "event_msg", payload: { type: "agent_reasoning", text: hidden } }, { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: hidden }] } }, u(), analysis, a(), done()]));
    expect(result.events).toHaveLength(2); expect(result.assistantMessages).toHaveLength(1); expect(result.turnComplete).toBe(true); expect(JSON.stringify(result)).not.toContain(hidden);
  });
  test("analysis-phase event messages and item mirrors never become receipt candidates", () => {
    const result = parseNativeRecords("codex", id, jsonl([meta(), start(), context(), u(),
      { type: "event_msg", payload: { type: "agent_message", phase: "analysis", message: hidden } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "hidden-item", phase: "analysis", content: [{ type: "Text", text: hidden }] } } }, a(), done()]));
    expect(JSON.stringify(result)).not.toContain(hidden); expect(result.assistantMessages).toHaveLength(1); expect(result.turnComplete).toBe(true);
  });
  test("item_completed assistant mirror deduplicates by native message ID, not text", () => {
    const mirror = { type: "event_msg", payload: { type: "item_completed", thread_id: id, turn_id: "turn-1", item: { type: "AgentMessage", id: "a1", phase: "final_answer", content: [{ type: "Text", text: "อ่านแล้ว รอคำสั่ง" }] } } };
    const result = parseNativeRecords("codex", id, jsonl([meta(), start(), context(), u(), mirror, a(), done()])); expect(result.assistantMessages).toHaveLength(1); expect(result.turnComplete).toBe(true);
  });
  test("same text on a new user turn still has distinct source IDs and reply links", () => {
    const result = parseNativeRecords("codex", id, jsonl([...codex(), start("turn-2"), context("turn-2"), u("u2"), a("a2"), done("turn-2")]));
    expect(result.events.filter(e => e.role === "user")).toHaveLength(2); expect(result.assistantMessages[0].replyToSourceId).not.toBe(result.assistantMessages[1].replyToSourceId); expect(result.assistantMessages[1].turnId).toBe("turn-2");
  });
  test("refusal and interruption are explicit unsafe outcomes, never receipt summaries", () => {
    const refusal = a(); refusal.payload.content = [{ type: "refusal", refusal: "declined" } as any];
    const r = parseNativeRecords("codex", id, jsonl([meta(), start(), context(), u(), refusal, done()])); expect(r.refused).toBe(true); expect(r.turnComplete).toBe(false); expect(r.assistantMessages).toEqual([]);
    const i = parseNativeRecords("codex", id, jsonl([...codex(), { type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-1" } }])); expect(i.interrupted).toBe(true); expect(i.turnComplete).toBe(false);
  });
  test("unknown task metadata cannot be papered over by later task_complete", () => {
    const rows = codex(); rows.splice(4, 0, { type: "event_msg", payload: { type: "new_unverified_tool_state" } } as any);
    expect(parseNativeRecords("codex", id, jsonl(rows)).turnComplete).toBe(false);
  });
  test("inconsistent native IDs, cwd and duplicate headers fail closed", () => {
    const bad = meta(); bad.payload.id = otherId; rejects("codex", [bad, ...codex().slice(1)], "native_identity_mismatch");
    const ctx = context(); ctx.payload.cwd = "/home/example/other"; rejects("codex", [meta(), start(), ctx, u(), a(), done()], "native_cwd_mismatch");
    rejects("codex", [meta(), ...codex()], "native_header_invalid");
  });
});

describe("native input boundaries and stable source identity", () => {
  test("malformed, blank, truncated and nonobject records never return a partial result", () => {
    for (const text of [jsonl(codex()).slice(0, -1), jsonl(codex()) + "{broken\n", jsonl(codex()) + "\n", "[]\n", "null\n"])
      expect(() => parseNativeRecords("codex", id, text)).toThrow(NativeRecordsError);
  });
  test("source IDs are stable across reparsing and appending, without text-based dedup", () => {
    const first = parseNativeRecords("claude", id, jsonl([cu(), ca()])); const appended = parseNativeRecords("claude", id, jsonl([cu(), ca(), cu("u2", "a1")]));
    expect(appended.events.slice(0, 2).map(e => e.sourceId)).toEqual(first.events.map(e => e.sourceId)); expect(appended.events[2].sourceId).not.toBe(first.events[0].sourceId);
  });
  test("mismatched content for one native source ID is rejected", () => {
    rejects("codex", [meta(), start(), context(), u(), a(), a("a1", "another answer"), done()], "native_event_conflict");
  });
  test("identity and cwd cannot be supplied by transcript prose", () => {
    expect(() => parseNativeRecords("codex", "not-a-native-id", jsonl(codex()))).toThrow("native_identity_invalid");
    rejects("codex", [start(), u(), a(), done()], "native_identity_missing");
    const row = cu(); delete (row as any).cwd; rejects("claude", [row, ca()], "native_cwd_missing");
  });
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function files() { const dir = mkdtempSync(join(tmpdir(), "native-records-")); dirs.push(dir); const root = join(dir, "allowed"); mkdirSync(root); const file = join(root, "native.jsonl"); writeFileSync(file, jsonl(codex())); return { dir, root, file }; }
describe("bounded native reader verifies scope/cwd and never opens live agents", () => {
  test("reads a scoped stable native file and verifies exact declared cwd", async () => {
    const h = files(); const r = await readNativeRecords("codex", id, h.file, { allowedRoot: h.root, expectedCwd: cwd }); expect(r.turnComplete).toBe(true); expect(r.events).toHaveLength(2);
    await expect(readNativeRecords("codex", id, h.file, { allowedRoot: h.root, expectedCwd: "/home/example/other" })).rejects.toThrow("native_cwd_mismatch");
  });
  test("outside path, symlink and nonregular file cannot be read as native evidence", async () => {
    const h = files(); const outside = join(h.dir, "outside.jsonl"); writeFileSync(outside, jsonl(codex())); const link = join(h.root, "link.jsonl"); symlinkSync(outside, link);
    for (const path of [outside, link, h.root]) await expect(readNativeRecords("codex", id, path, { allowedRoot: h.root, expectedCwd: cwd })).rejects.toThrow(NativeRecordsError);
    const folder = join(h.root, "folder"); mkdirSync(folder); await expect(readNativeRecords("codex", id, folder, { allowedRoot: h.root, expectedCwd: cwd })).rejects.toThrow("native_not_regular");
  });
  test("file/line/record bounds apply before accepting evidence and cannot be increased above ceiling", async () => {
    const h = files();
    for (const extra of [{ maxBytes: 1 }, { maxLineBytes: 10 }, { maxRecords: 1 }, { maxBytes: NATIVE_RECORD_LIMITS.maxBytes + 1 }, { maxRecords: 0 }])
      await expect(readNativeRecords("codex", id, h.file, { allowedRoot: h.root, expectedCwd: cwd, ...extra })).rejects.toThrow(NativeRecordsError);
  });
  test("invalid UTF-8 and partial trailing write fail closed with no text leakage in error", async () => {
    const h = files(); writeFileSync(h.file, new Uint8Array([0xff, 0xfe, 0x0a]));
    await expect(readNativeRecords("codex", id, h.file, { allowedRoot: h.root, expectedCwd: cwd })).rejects.toThrow("native_encoding_invalid");
    writeFileSync(h.file, jsonl(codex()).slice(0, -2));
    await expect(readNativeRecords("codex", id, h.file, { allowedRoot: h.root, expectedCwd: cwd })).rejects.toThrow("native_truncated");
  });
});
