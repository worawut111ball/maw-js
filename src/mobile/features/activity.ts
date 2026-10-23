// Feature pack "activity" (PLAN-maw-mobile.md §9, P3): the agent's todo list + background work still running.
//   GET /mobile/rooms/:ws/:room/activity?sid=&agent=  →  { ok, todos, running }
// Claude: TodoWrite (latest list) or TaskCreate/TaskUpdate (task list) · background Bash / Monitor / Agent
//         are "running" from launch until a <task-notification> with a <status> (or TaskStop) closes them.
// Codex:  update_plan steps · exec calls with no output yet · exec sessions still running · sub-agents (see CodexActivity).
// Transcripts reach 100 MB+: the first look scans only the tail (pre-filtered before JSON.parse),
// after that only the bytes appended since — state is kept per (file, size).
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { codexFileFor, readLiveRooms, roomChannel } from "./ctx";

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface Todo { content: string; status: TodoStatus; activeForm?: string }
export interface Running { kind: "shell" | "monitor" | "agent"; label: string; since: string | null; id?: string }
export interface Activity { todos: Todo[]; running: Running[] }

const MAX_AGE = 6 * 3600_000;       // anything "running" longer than this is a ghost (session died, notice lost)
const DONE_LIST_TTL = 30 * 60_000;  // a list that is all ✓ disappears 30 min after its last change
const FIRST_SCAN = 48 * 1024 * 1024; // first look at a transcript: its last 48 MB (pre-filtered, so cheap); then only appended bytes
const CHUNK = 4 * 1024 * 1024;

const status = (s: unknown): TodoStatus | null =>
  s === "completed" || s === "done" ? "completed" : s === "in_progress" || s === "active" ? "in_progress" : s === "pending" ? "pending" : null;
const clip = (s: unknown, n = 90) => { const t = String(s ?? "").split("\n").find(x => x.trim())?.trim() ?? ""; return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const tms = (ts: string | null) => (ts ? Date.parse(ts) : NaN);

function finalize(todos: Todo[], todosAt: string | null, running: (Running & { until?: number })[], now: number): Activity {
  const allDone = todos.length > 0 && todos.every(t => t.status === "completed");
  const stale = allDone && todosAt && now - tms(todosAt) > DONE_LIST_TTL;
  const live = running.filter(r => {
    const t = tms(r.since);
    if (Number.isFinite(t) && now - t > MAX_AGE) return false;
    if (r.until && now > r.until) return false;
    return true;
  }).map(({ until, ...r }) => r);
  return { todos: stale ? [] : todos, running: live };
}

// ── Claude Code transcript lines ──────────────────────────────────

/** Every <task-notification> in a text → the ids it closes (only notices that carry a <status>; Monitor events don't). */
export function notificationsIn(text: string): { ids: string[]; status: string }[] {
  const out: { ids: string[]; status: string }[] = [];
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g)) {
    const body = m[1];
    const st = body.match(/<status>\s*([\w-]+)\s*<\/status>/)?.[1];
    if (!st) continue;
    const ids = [...body.matchAll(/<(?:tool-use-id|task-id)>\s*([^<\s]+)\s*<\/(?:tool-use-id|task-id)>/g)].map(x => x[1]);
    if (ids.length) out.push({ ids, status: st });
  }
  return out;
}

function textsOf(d: any): string[] {
  const out: string[] = [];
  const c = d?.message?.content;
  if (typeof c === "string") out.push(c);
  else if (Array.isArray(c)) for (const b of c) if (b?.type === "text" && typeof b.text === "string") out.push(b.text);
  const p = d?.attachment?.prompt;
  if (typeof p === "string") out.push(p);
  return out;
}

function resultText(b: any): string {
  if (typeof b?.content === "string") return b.content;
  if (Array.isArray(b?.content)) return b.content.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join("\n");
  return "";
}

/** Claude transcript → activity, as a reducer: feed lines as the file grows, take a snapshot any time. */
export class ClaudeActivity {
  private todos: Todo[] = [];
  private todosAt: string | null = null;
  private source: "todo" | "task" | null = null;
  private tasks = new Map<string, Todo>();
  private creating = new Map<string, Todo>();             // TaskCreate tool_use id → task waiting for its id
  private pending = new Map<string, Running & { until?: number; timeoutMs?: number }>(); // tool_use id → work in flight
  private byTask = new Map<string, string>();             // background task / agent id → tool_use id

  private close(id: string) { this.pending.delete(this.byTask.get(id) ?? id); }

  /** Cheap pre-check so a 50 MB transcript isn't JSON-parsed line by line. */
  private relevant(line: string): boolean {
    if (line.includes("<task-notification>")) return true;
    if (line.includes('"tool_use"') && /"name":"(TodoWrite|Task\w*|Bash|Monitor|Agent|KillShell|KillBash)"/.test(line)) return true;
    if (!line.includes('"tool_result"')) return false;
    for (const m of line.matchAll(/"tool_use_id":"([^"]+)"/g)) if (this.pending.has(m[1]) || this.creating.has(m[1])) return true;
    return false;
  }

  feed(lines: string[]): this {
    for (const line of lines) {
      if (!line || line[0] !== "{" || !this.relevant(line)) continue;
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.isSidechain) continue;
      this.line(d);
    }
    return this;
  }

  private line(d: any) {
    const ts: string | null = typeof d.timestamp === "string" ? d.timestamp : null;
    const content = d?.message?.content;
    if (Array.isArray(content)) {
      const results = content.filter((b: any) => b?.type === "tool_result");
      for (const b of content) {
        if (b?.type === "tool_use") this.toolUse(b, ts);
        else if (b?.type === "tool_result") this.toolResult(b, results.length === 1 ? d.toolUseResult : undefined, ts);
      }
    }
    for (const t of textsOf(d)) {
      if (!t.includes("<task-notification>")) continue;
      for (const n of notificationsIn(t)) for (const id of n.ids) this.close(id);
    }
  }

  private toolUse(b: any, ts: string | null) {
    const inp = b.input ?? {};
    switch (b.name) {
      case "TodoWrite":
        this.todos = (Array.isArray(inp.todos) ? inp.todos : []).map((t: any) => ({
          content: String(t?.content ?? ""), status: status(t?.status) ?? "pending", ...(t?.activeForm ? { activeForm: String(t.activeForm) } : {}),
        })).filter((t: Todo) => t.content);
        this.todosAt = ts; this.source = "todo";
        break;
      case "TaskCreate":
        this.creating.set(b.id, { content: String(inp.subject ?? inp.description ?? ""), status: "pending", ...(inp.activeForm ? { activeForm: String(inp.activeForm) } : {}) });
        break;
      case "TaskUpdate": {
        const key = String(inp.taskId ?? "");
        const t = this.tasks.get(key);
        if (!t) break;
        if (inp.status === "deleted") this.tasks.delete(key);
        else {
          const s = status(inp.status); if (s) t.status = s;
          if (inp.subject) t.content = String(inp.subject);
          if (inp.activeForm) t.activeForm = String(inp.activeForm);
        }
        this.todosAt = ts; this.source = "task";
        break;
      }
      case "Bash":
        if (inp.run_in_background) this.pending.set(b.id, { kind: "shell", label: clip(inp.description || inp.command), since: ts });
        break;
      case "Monitor":
        this.pending.set(b.id, { kind: "monitor", label: clip(inp.description || inp.command), since: ts, timeoutMs: +inp.timeout_ms || undefined });
        break;
      case "Agent": case "Task":
        this.pending.set(b.id, { kind: "agent", label: clip(inp.description || inp.subagent_type || "agent"), since: ts });
        break;
      case "TaskStop": case "KillShell": case "KillBash": {
        const id = inp.task_id ?? inp.shell_id ?? inp.bash_id;
        if (id) this.close(String(id));
        break;
      }
    }
  }

  private toolResult(b: any, tur: any, ts: string | null) {
    const useId = String(b.tool_use_id ?? "");
    const text = resultText(b);
    const c = this.creating.get(useId);
    if (c) {
      this.creating.delete(useId);
      const id = tur?.task?.id ?? text.match(/Task #(\w+) created/)?.[1];
      if (id && !b.is_error) { this.tasks.set(String(id), c); this.todosAt = ts; this.source = "task"; }
      return;
    }
    const p = this.pending.get(useId);
    if (!p) return;
    if (b.is_error) { this.pending.delete(useId); return; }
    let id: unknown;
    if (p.kind === "agent") {
      const async = tur?.status === "async_launched" || /^Async agent launched/.test(text);
      if (!async) { this.pending.delete(useId); return; }              // a foreground agent returned its answer
      id = tur?.agentId ?? text.match(/agentId:\s*(\w+)/)?.[1];
    } else if (p.kind === "shell") {
      id = tur?.backgroundTaskId ?? text.match(/running in background with ID:\s*(\w+)/)?.[1];
    } else {
      id = tur?.taskId ?? text.match(/Monitor started \(task (\w+)/)?.[1];
      const ms = +tur?.timeoutMs || p.timeoutMs;
      const t0 = tms(p.since);
      if (ms && Number.isFinite(t0)) p.until = t0 + ms + 60_000;
    }
    if (!id) { if (p.kind !== "agent") this.pending.delete(useId); return; }
    this.byTask.set(String(id), useId); p.id = String(id);
  }

  snapshot(now = Date.now()): Activity {
    const list = this.source === "task"
      ? [...this.tasks.entries()].sort((a, b) => (+a[0] || 0) - (+b[0] || 0) || a[0].localeCompare(b[0])).map(([, t]) => ({ ...t }))
      : this.todos.map(t => ({ ...t }));
    return finalize(list, this.todosAt, [...this.pending.values()].map(({ timeoutMs, ...r }) => ({ ...r })), now);
  }
}

export function parseClaudeActivity(lines: string[], now = Date.now()): Activity {
  return new ClaudeActivity().feed(lines).snapshot(now);
}

// ── Codex rollout lines ───────────────────────────────────────────

function codexCmd(p: any, n = 90): string {
  if (p.type === "function_call") {
    try { const a = JSON.parse(p.arguments ?? "{}"); const c = a.cmd ?? a.command; return clip(Array.isArray(c) ? c.join(" ") : c, n); } catch { return ""; }
  }
  const src = String(p.input ?? "");
  const m = src.match(/cmd\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return clip(m ? m[1].replace(/\\(.)/g, "$1") : src, n);
}

const msIso = (ms: unknown) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);
const outText = (o: unknown): string =>
  typeof o === "string" ? o : Array.isArray(o) ? o.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("\n") : "";
const argsOf = (p: any): any => { try { return JSON.parse(p.arguments ?? "{}") ?? {}; } catch { return {}; } };
const agentName = (path: unknown) => String(path ?? "").split("/").filter(Boolean).pop() ?? "";

/** Codex rollout → activity, as a reducer (same shape as ClaudeActivity).
 *  in flight  : exec / exec_command / shell call with no output yet (≥ 5 s) — a turn ending clears these.
 *  sessions   : an exec that yielded and keeps running — "Process running with session ID N" (function call) or
 *               `"session_id":N` in a code-mode `exec` result; closed by event_msg item_completed CommandExecution
 *               with process_id N (Codex writes one when the process really ends), or a write_stdin that saw it exit.
 *  cells      : code-mode script still running ("Script running with cell ID X") until a `wait` on it stops saying so.
 *  sub-agents : item_completed SubAgentActivity kind started → running, completed / interrupted → done;
 *               spawn_agent result { task_name } is the fallback start, followup_task restarts, interrupt_agent stops.
 *  Sessions and sub-agents outlive the turn (task_complete) — only their own end closes them (or MAX_AGE). */
export class CodexActivity {
  private todos: Todo[] = [];
  private todosAt: string | null = null;
  private pending = new Map<string, Running>();                       // call_id → exec in flight
  private calls = new Map<string, { name: string; label: string; since: string | null; args: any }>(); // call_id → call, until its output
  private sessions = new Map<string, Running>();                      // exec session / process id → still running
  private ended = new Set<string>();                                  // process ids already finished (a result can arrive after the end)
  private cells = new Map<string, Running>();                         // code-mode cell id → still running
  private agents = new Map<string, Running>();                        // agent path (/root/x) → sub-agent working
  private child = new Map<string, string>();                          // agent path → its own thread id (= child rollout id)

  private relevant(line: string): boolean {
    if (/"(function_call|custom_tool_call|function_call_output|custom_tool_call_output|task_complete|turn_aborted)"/.test(line)) return true;
    return line.includes('"item_completed"') && /"type":"(CommandExecution|SubAgentActivity)"/.test(line);
  }

  feed(lines: string[]): this {
    for (const line of lines) {
      if (!line || line[0] !== "{" || !this.relevant(line)) continue;
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      this.line(d);
    }
    return this;
  }

  private endSession(id: string) {
    this.sessions.delete(id);
    this.ended.add(id);
    if (this.ended.size > 4000) this.ended.delete(this.ended.values().next().value!);
  }
  private openSession(id: string, label: string, since: string | null) {
    if (this.ended.has(id) || this.sessions.has(id)) return;          // keep the first label / start time
    this.sessions.set(id, { kind: "shell", label: label || `session ${id}`, since, id });
  }
  private startAgent(path: string, since: string | null, child?: string) {
    const name = agentName(path);
    if (!name) return;
    if (child) this.child.set(path, child);
    const cur = this.agents.get(path);
    if (cur) { if (child) cur.id = child; return; }
    this.agents.set(path, { kind: "agent", label: name, since, id: this.child.get(path) ?? path });
  }

  private line(d: any) {
    const p = d.payload ?? {};
    const ts: string | null = typeof d.timestamp === "string" ? d.timestamp : null;
    if (d.type === "event_msg") {
      if (p.type === "task_complete" || p.type === "turn_aborted") { this.pending.clear(); this.cells.clear(); return; }
      if (p.type !== "item_completed") return;
      const it = p.item ?? {};
      if (it.type === "CommandExecution" && it.process_id != null) {
        this.endSession(String(it.process_id));
      } else if (it.type === "SubAgentActivity" && it.agent_path) {
        const path = String(it.agent_path);
        if (it.kind === "started") this.startAgent(path, msIso(p.started_at_ms) ?? ts, it.agent_thread_id ? String(it.agent_thread_id) : undefined);
        else if (it.kind === "completed" || it.kind === "interrupted") this.agents.delete(path);
      }
      return;
    }
    if (p.type === "function_call" && p.name === "update_plan") {
      const a = argsOf(p);
      if (Array.isArray(a.plan)) {
        this.todos = a.plan.map((s: any) => ({ content: String(s?.step ?? ""), status: status(s?.status) ?? "pending" })).filter((t: Todo) => t.content);
        this.todosAt = ts;
      }
      return;
    }
    if ((p.type === "function_call" || p.type === "custom_tool_call") && p.call_id) {
      const id = String(p.call_id), name = String(p.name);
      const args = p.type === "function_call" ? argsOf(p) : {};
      const isExec = /^(exec|exec_command|shell|local_shell)$/.test(name);
      const label = isExec ? codexCmd(p, 80) : "";
      // a code-mode script that only polls (write_stdin) has no command of its own — don't name a session after its code
      const cmd = p.type === "custom_tool_call" && !/\bcmd\s*:/.test(String(p.input ?? "")) ? "" : label;
      this.calls.set(id, { name, label: cmd, since: ts, args });
      if (this.calls.size > 2000) this.calls.delete(this.calls.keys().next().value!);
      if (isExec) this.pending.set(id, { kind: "shell", label: label || name, since: ts, id });
      if (name === "interrupt_agent") { const t = String(args.target ?? ""); for (const k of this.agents.keys()) if (k === t || agentName(k) === agentName(t)) this.agents.delete(k); }
      if (name === "followup_task") { const t = String(args.target ?? ""); if (t) this.startAgent(t.startsWith("/") ? t : `/root/${t}`, ts); }
      return;
    }
    if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && p.call_id) {
      const id = String(p.call_id);
      this.pending.delete(id);
      const c = this.calls.get(id);
      this.calls.delete(id);
      const text = outText(p.output);
      const since = c?.since ?? ts;
      // exec that yielded: still running under a session id
      for (const m of text.matchAll(/Process running with session ID (\d+)/g))
        this.openSession(m[1], c?.name === "write_stdin" ? "" : c?.label ?? "", since);
      if (c?.name === "exec") for (const m of text.matchAll(/"session_id"\s*:\s*(\d+)/g)) this.openSession(m[1], c.label, since);
      if (c?.name === "write_stdin" && /Process exited with code/.test(text) && c.args?.session_id != null) this.endSession(String(c.args.session_id));
      // code-mode script still running in the background
      const cells = [...text.matchAll(/Script running with cell ID ([\w-]+)/g)].map(m => m[1]);
      for (const cell of cells) if (!this.cells.has(cell)) this.cells.set(cell, { kind: "shell", label: c?.name === "exec" ? c.label || "exec" : `cell ${cell}`, since, id: cell });
      if (c?.name === "wait" && c.args?.cell_id != null && !cells.includes(String(c.args.cell_id))) this.cells.delete(String(c.args.cell_id));
      // sub-agent spawned: { task_name: "/root/x" } (older Codex has no SubAgentActivity)
      if (c?.name === "spawn_agent") {
        try { const r = JSON.parse(text); if (typeof r?.task_name === "string") this.startAgent(r.task_name, since); } catch { /* "collab spawn failed: …" */ }
      }
    }
  }

  snapshot(now = Date.now()): Activity {
    // a command that has run < 5 s is just "working", not background work worth a chip
    const inflight = [...this.pending.values()].filter(r => { const t = tms(r.since); return !Number.isFinite(t) || now - t >= 5_000; });
    const running = [...this.agents.values(), ...this.sessions.values(), ...this.cells.values(), ...inflight].map(r => ({ ...r }));
    return finalize(this.todos.map(t => ({ ...t })), this.todosAt, running, now);
  }
}

export function parseCodexActivity(lines: string[], now = Date.now()): Activity {
  return new CodexActivity().feed(lines).snapshot(now);
}

// ── File access: one scan of the tail, then only the appended bytes ──

/** Whole lines of `file` from byte `from` (or the last `max` bytes on a first read) — the trailing partial line is left for next time. */
export function readLinesFrom(file: string, from: number | null, max = FIRST_SCAN): { lines: string[]; next: number } {
  const size = statSync(file).size;
  let start = from ?? Math.max(0, size - max);
  if (start > size) start = Math.max(0, size - max);       // file was rewritten / truncated
  const skipFirst = from === null && start > 0;
  const lines: string[] = [];
  const fd = openSync(file, "r");
  let pos = start, carry: Buffer = Buffer.alloc(0), first = skipFirst;
  try {
    const buf = Buffer.alloc(CHUNK);
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      // split on the newline byte, never inside a multi-byte (Thai) character
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let at = 0, nl: number;
      while ((nl = data.indexOf(10, at)) !== -1) {
        if (first) first = false; else lines.push(data.toString("utf-8", at, nl));
        at = nl + 1;
      }
      carry = Buffer.from(data.subarray(at));
    }
  } finally { closeSync(fd); }
  return { lines, next: pos - carry.length };               // an incomplete last line is re-read next time
}

/** Last `max` bytes of a file as whole lines (first partial line dropped). */
export function tailLines(file: string, max = FIRST_SCAN): string[] {
  return readLinesFrom(file, null, max).lines;
}

type Reducer = { feed(lines: string[]): unknown; snapshot(now?: number): Activity };
const states = new Map<string, { next: number; size: number; r: Reducer }>();
function fileActivity(file: string, make: () => Reducer, now: number): Activity | null {
  try {
    const size = statSync(file).size;
    let st = states.get(file);
    if (st && size < st.size) st = undefined;                 // truncated → start over
    if (!st) {
      const r = make();
      const { lines, next } = readLinesFrom(file, null);
      r.feed(lines);
      st = { next, size, r };
      if (states.size >= 16) states.delete(states.keys().next().value!);
      states.set(file, st);
    } else if (size !== st.size) {
      const { lines, next } = readLinesFrom(file, st.next);
      st.r.feed(lines); st.next = next; st.size = size;
    }
    return st.r.snapshot(now);
  } catch { return null; }
}

const fileOf = new Map<string, string>();
export function claudeFile(sid: string, root = join(homedir(), ".claude", "projects")): string | null {
  if (!/^[0-9a-zA-Z_-]{8,80}$/.test(sid)) return null;
  const hit = fileOf.get(sid);
  if (hit && existsSync(hit)) return hit;
  try {
    for (const d of readdirSync(root)) {
      const f = join(root, d, `${sid}.jsonl`);
      if (existsSync(f)) { fileOf.set(sid, f); return f; }
    }
  } catch { /* no projects dir */ }
  return null;
}

/** Claude session id living in this room, when the phone didn't send one. */
function sidForRoom(ws: string, room: string): string | null {
  for (const r of readLiveRooms().values()) {
    const ch = r.channel;
    if (!ch) continue;
    if (ch.kind === "superset" && ch.terminalId === room && (ws === "tmux" || ch.workspaceId === ws)) return r.sessionId;
    if (ch.kind === "tmux" && ws === "tmux" && ch.pane === room) return r.sessionId;
  }
  return null;
}

export function roomActivity(ws: string, room: string, agent: string, sid: string, now = Date.now()): Activity {
  const empty: Activity = { todos: [], running: [] };
  if (agent === "codex") {
    const f = codexFileFor(room);
    return (f && fileActivity(f, () => new CodexActivity(), now)) || empty;
  }
  const id = sid || sidForRoom(ws, room);
  const f = id ? claudeFile(id) : null;
  return (f && fileActivity(f, () => new ClaudeActivity(), now)) || empty;
}

export function mount(app: any): void {
  app.get("/rooms/:ws/:room/activity", ({ params, query, set }: any) => {
    if (!roomChannel(params.ws, params.room)) { set.status = 400; return { ok: false, error: "bad room" }; }
    try {
      const a = roomActivity(params.ws, params.room, String(query?.agent ?? "claude"), String(query?.sid ?? ""));
      return { ok: true, ...a };
    } catch {
      return { ok: true, todos: [], running: [] };
    }
  });
}
