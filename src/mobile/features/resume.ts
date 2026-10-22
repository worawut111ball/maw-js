// Feature pack "resume" (P4 · PLAN-maw-mobile.md §9) — list past Claude Code sessions of a Superset
// workspace ("ห้องเก่า") and reopen one in a new terminal: `superset agents create --agent claude --resume-session <id>`.
//
// Transcripts: ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl, where every non-alphanumeric char of the
// cwd becomes "-" (/Users/a/b_c.d → -Users-a-b-c-d). Files can be 100 MB+, so we only read a head + tail
// window and cache the summary by (path, mtime, size).
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readLiveRooms, ss, workspacePath, type LiveRoom } from "./ctx";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;
const FULL_SCAN_MAX = 2 * 1024 * 1024; // files up to this size are counted exactly
const PREVIEW_MAX = 120;
const LIMIT = 40;

/** Swappable for tests — never let a test reach the real Superset CLI or ~/.claude. */
export const deps = {
  ss: (args: string[]): string => ss(args),
  readLiveRooms: (): Map<string, LiveRoom> => readLiveRooms(),
  workspacePath: (ws: string): string | null => workspacePath(ws),
  projectsRoot: join(homedir(), ".claude", "projects"),
};

export interface PastSession {
  sessionId: string;
  title: string | null;
  preview: string | null;
  messages: number;
  approx: boolean;
  size: number;
  mtime: number;
  live: boolean;
  liveTerminalId: string | null;
}

/** Claude Code's folder name for a cwd. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Every ~/.claude/projects folder that may hold sessions for this cwd (as given + realpath; long names are cut + hashed by Claude). */
export function projectDirsFor(cwd: string, root = deps.projectsRoot): string[] {
  const cands = new Set<string>([encodeProjectDir(cwd)]);
  try { cands.add(encodeProjectDir(realpathSync(cwd))); } catch { /* gone */ }
  const out: string[] = [];
  let names: string[] | null = null;
  for (const c of cands) {
    if (existsSync(join(root, c))) { out.push(join(root, c)); continue; }
    if (c.length > 200) {
      names ??= (() => { try { return readdirSync(root); } catch { return []; } })();
      for (const n of names) if (n.startsWith(c.slice(0, 200))) out.push(join(root, n));
    }
  }
  return [...new Set(out)];
}

/** Text of a user line, or null when it is plumbing (meta, tool results, slash commands, hooks, notifications). */
export function realUserText(d: any): string | null {
  if (d?.type !== "user" || d.isMeta || d.isSidechain || d.isCompactSummary) return null;
  const c = d.message?.content;
  let s = typeof c === "string" ? c
    : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("\n") : "";
  s = s.trim();
  if (!s) return null;
  if (/^<(command-[a-z]+|local-command-[a-z]+|task-notification|bash-input|bash-stdout|bash-stderr|system-reminder|user-prompt-submit-hook)\b/.test(s)) return null;
  if (/^(Caveat:|\[Request interrupted|This session is being continued|Base directory for this skill)/.test(s)) return null;
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/\[Image #?\d*[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  return s || null;
}

const clip = (s: string, n = PREVIEW_MAX) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export interface Summary { title: string | null; preview: string | null; messages: number; approx: boolean }

/** Summarise JSONL lines. `headLines` are read in order; `tailLines` only feed the latest title + counts. */
export function summarizeLines(headLines: string[], tailLines: string[] = []): Omit<Summary, "approx"> & { counted: number } {
  let custom: string | null = null, agentName: string | null = null, ai: string | null = null, summary: string | null = null;
  let preview: string | null = null, messages = 0;
  const eat = (line: string, wantPreview: boolean) => {
    if (!line.trim()) return;
    let d: any;
    try { d = JSON.parse(line); } catch { return; }
    switch (d?.type) {
      case "custom-title": if (d.customTitle) custom = String(d.customTitle); return;
      case "agent-name": if (d.agentName) agentName = String(d.agentName); return;
      case "ai-title": if (d.aiTitle) ai = String(d.aiTitle); return;
      case "summary": if (d.summary) summary = String(d.summary); return;
      // count what a person reads: assistant text replies, not every tool call
      case "assistant": if (!d.isSidechain && Array.isArray(d.message?.content) && d.message.content.some((b: any) => b?.type === "text" && String(b.text ?? "").trim())) messages++; return;
      case "user": {
        const t = realUserText(d);
        if (!t) return;
        messages++;
        if (wantPreview && !preview) preview = clip(t);
      }
    }
  };
  for (const l of headLines) eat(l, true);
  for (const l of tailLines) eat(l, false);
  const title = custom ?? agentName ?? ai ?? summary;
  return { title: title ? clip(String(title).trim(), 100) : null, preview, messages, counted: headLines.length + tailLines.length };
}

function readSlice(fd: number, start: number, len: number): string {
  const buf = Buffer.alloc(len);
  const n = readSync(fd, buf, 0, len, start);
  return buf.subarray(0, n).toString("utf-8");
}

const cache = new Map<string, { key: string; s: Summary }>();

/** Summary of one transcript file: full read when small, head + tail window when large (count is then estimated). */
export function summarizeFile(file: string): Summary | null {
  let st;
  try { st = statSync(file); } catch { return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.s;
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return null; }
  let s: Summary;
  try {
    if (st.size <= FULL_SCAN_MAX) {
      const r = summarizeLines(readSlice(fd, 0, st.size).split("\n"));
      s = { title: r.title, preview: r.preview, messages: r.messages, approx: false };
    } else {
      const head = readSlice(fd, 0, HEAD_BYTES).split("\n"); head.pop();            // drop the cut-off last line
      const tail = readSlice(fd, st.size - TAIL_BYTES, TAIL_BYTES).split("\n"); tail.shift(); // drop the cut-off first line
      const h = summarizeLines(head), t = summarizeLines([], tail);
      // titles: the newest one wins (tail), else whatever the head had
      const title = t.title ?? h.title;
      const perByte = (h.messages + t.messages) / (HEAD_BYTES + TAIL_BYTES);
      s = { title, preview: h.preview, messages: Math.max(h.messages + t.messages, Math.round(perByte * st.size)), approx: true };
    }
  } finally { closeSync(fd); }
  cache.set(file, { key, s });
  return s;
}

/** Past Claude sessions for a working folder, newest first. */
export function listPastSessions(cwd: string, live: Map<string, LiveRoom> = deps.readLiveRooms(), limit = LIMIT, root = deps.projectsRoot): PastSession[] {
  const files: { file: string; id: string; mtime: number; size: number }[] = [];
  for (const dir of projectDirsFor(cwd, root)) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const id = n.replace(/\.jsonl$/, "");
      if (id === n || !UUID_RE.test(id)) continue;
      try { const st = statSync(join(dir, n)); files.push({ file: join(dir, n), id, mtime: st.mtimeMs, size: st.size }); } catch { /* raced */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: PastSession[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (out.length >= limit) break;
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const s = summarizeFile(f.file);
    if (!s || (!s.messages && !s.title)) continue; // empty / aborted session
    const room = live.get(f.id);
    out.push({
      sessionId: f.id, title: s.title, preview: s.preview, messages: s.messages, approx: s.approx, size: f.size, mtime: f.mtime,
      live: !!room, liveTerminalId: room?.channel?.kind === "superset" ? room.channel.terminalId : null,
    });
  }
  return out;
}

/** Pull the new terminal id out of `agents create` ({sessionId}) or `terminals create` ({terminalId}) JSON. */
export function terminalIdFrom(out: string): string | null {
  let d: any;
  try { d = JSON.parse(out); } catch { return null; }
  const x = d?.data ?? d;
  const id = x?.sessionId ?? x?.terminalId ?? x?.terminal?.id ?? x?.id ?? null;
  return id ? String(id) : null;
}

/** Errors that mean "this CLI can't resume via agents create" — only then fall back to a plain terminal. */
const UNSUPPORTED = /unknown (option|flag|agent|preset)|unrecognized|not supported|no such (agent|preset)|invalid agent/i;

export function resumeSession(ws: string, sessionId: string): { terminalId: string | null; via: "agent" | "terminal" } {
  try {
    const out = deps.ss(["agents", "create", "--local", "--workspace", ws, "--agent", "claude", "--resume-session", sessionId, "--json"]);
    return { terminalId: terminalIdFrom(out), via: "agent" };
  } catch (e: any) {
    const msg = String(e?.stderr || e?.stdout || e?.message || e);
    if (!UNSUPPORTED.test(msg)) throw e;
  }
  // sessionId is a validated UUID, so the command string is safe to hand to the shell
  const out = deps.ss(["terminals", "create", "--local", "--workspace", ws, "--command", `claude --resume ${sessionId}`, "--json"]);
  return { terminalId: terminalIdFrom(out), via: "terminal" };
}

export function mount(app: any): void {
  app.get("/workspaces/:ws/sessions", ({ params, set }: any) => {
    if (params.ws === "tmux" || !UUID_RE.test(params.ws)) { set.status = 400; return { ok: false, error: "ยังรองรับเฉพาะ Superset" }; }
    const cwd = deps.workspacePath(params.ws);
    if (!cwd) { set.status = 404; return { ok: false, error: "ไม่พบโฟลเดอร์ของ workspace นี้" }; }
    return { ok: true, cwd, sessions: listPastSessions(cwd) };
  });

  app.post("/workspaces/:ws/resume", ({ params, body, set }: any) => {
    if (params.ws === "tmux" || !UUID_RE.test(params.ws)) { set.status = 400; return { ok: false, error: "ยังรองรับเฉพาะ Superset" }; }
    const sid = String(body?.sessionId ?? "");
    if (!UUID_RE.test(sid)) { set.status = 400; return { ok: false, error: "sessionId ไม่ถูกต้อง" }; }
    const room = deps.readLiveRooms().get(sid);
    if (room) {
      set.status = 409;
      return { ok: false, error: "ห้องนี้กำลังเปิดอยู่แล้ว", terminalId: room.channel?.kind === "superset" ? room.channel.terminalId : null };
    }
    try {
      const r = resumeSession(params.ws, sid);
      return { ok: true, terminalId: r.terminalId, via: r.via };
    } catch (e: any) {
      set.status = 502;
      return { ok: false, error: String(e?.stderr || e?.message || e).trim().slice(0, 300) };
    }
  });
}
