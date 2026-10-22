/**
 * Mobile API — phone-friendly view of every coding agent on this machine.
 *
 * Mounted at /mobile (NOT under /api) so `tailscale serve --set-path /mobile`
 * can expose only this surface. The /api write routes trust loopback callers,
 * and tailscale serve proxies from 127.0.0.1 — never expose /api to the tailnet.
 *
 * Auth (every route except /mobile/hook):
 *   - `Authorization: Bearer <token>` from ~/.maw/mobile.json, or
 *   - `Tailscale-User-Login` header matching `allowedLogins` in the same file.
 * /mobile/hook only accepts `X-Mobile-Hook-Token` (written by the local Claude/Codex hook).
 *
 * Plan: ~/oracle/ψ/incubate/Soul-Brews-Studio/maw-js/PLAN-maw-mobile.md
 */
import { Elysia, t } from "elysia";
import webpush from "web-push";
import { mountFeatures } from "./features";
import { execFileSync } from "child_process";
import { closeSync, realpathSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { listClaudeSessions, type ClaudeSession } from "../core/fleet/claude-sessions";
import { capture } from "../core/transport/ssh";
import { Tmux } from "../core/transport/tmux";

// ── Config + secrets (~/.maw/mobile.json, mode 600) ──────────────

interface MobileConfig { token: string; hookToken: string; allowedLogins: string[] }

const CONFIG_PATH = join(homedir(), ".maw", "mobile.json");

export function loadMobileConfig(path = CONFIG_PATH): MobileConfig {
  if (existsSync(path)) {
    const c = JSON.parse(readFileSync(path, "utf-8"));
    return { token: c.token, hookToken: c.hookToken, allowedLogins: c.allowedLogins ?? [] };
  }
  const c: MobileConfig = {
    token: randomBytes(24).toString("hex"),
    hookToken: randomBytes(24).toString("hex"),
    allowedLogins: [],
  };
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(c, null, 2), { mode: 0o600 });
  return c;
}

function sameSecret(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isAuthorized(headers: Headers, cfg: MobileConfig): boolean {
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (sameSecret(bearer, cfg.token)) return true;
  const login = headers.get("tailscale-user-login");
  return !!login && cfg.allowedLogins.includes(login);
}

// ── Hook state (Claude Code hooks / Codex notify) ────────────────

export type AgentStatus = "working" | "waiting" | "done" | "idle" | "ended";

interface HookState { status: AgentStatus; event: string; message?: string; at: number }

/** Latest hook event per session id. In memory: hooks re-fire on the next turn after a restart. */
export const hookStates = new Map<string, HookState>();

/** Map a Claude Code hook event to an agent status. */
export function statusFromHook(event: string): AgentStatus | null {
  switch (event) {
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      return "working";
    case "Notification":
    case "PermissionRequest":
      return "waiting"; // permission prompt or idle-waiting-for-input
    case "Stop":
      return "done";
    case "SessionEnd":
      return "ended";
    case "StopFailure":
      return "waiting"; // the turn died on an API error (overloaded, limit, network) → needs the human
    default:
      return null;
  }
}

// ── Live rooms: one entry per running Claude process ─────────────
// Claude Code writes ~/.claude/sessions/<pid>.json (pid ↔ sessionId, status, tmux pane), so several
// rooms in the same project folder are told apart exactly. Superset puts its workspace/terminal ids
// in each terminal's environment, which the Superset CLI uses to read and type into that room.

export interface Channel { kind: "tmux"; pane: string; label: string }
export interface SupersetChannel { kind: "superset"; workspaceId: string; terminalId: string; label: string }
export type ReplyChannel = Channel | SupersetChannel;

export interface LiveRoom { pid: number; sessionId: string; status: string | null; name: string | null; channel: ReplyChannel | null }

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");
export const SUPERSET_BIN = join(homedir(), ".superset", "bin", "superset");

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

function envOf(pid: number): Record<string, string> {
  try {
    const out = execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf-8", timeout: 1500 });
    const env: Record<string, string> = {};
    for (const m of out.matchAll(/(?:^|\s)(SUPERSET_[A-Z_]+)=(\S+)/g)) env[m[1]] = m[2];
    return env;
  } catch { return {}; }
}

/** tmux field looks like "team1-oracle:@0.%0" → send to pane "%0", show "team1-oracle". */
export function tmuxChannel(tmux: string | null | undefined): Channel | null {
  if (!tmux) return null;
  const pane = tmux.match(/(%\d+)$/)?.[1];
  return pane ? { kind: "tmux", pane, label: tmux.split(":")[0] } : null;
}

let supersetTitles: { at: number; map: Map<string, string> } = { at: 0, map: new Map() };
function supersetTitle(terminalId: string): string | null {
  if (Date.now() - supersetTitles.at > 15_000) {
    const map = new Map<string, string>();
    try {
      const snap = JSON.parse(execFileSync(SUPERSET_BIN, ["snapshot", "--json"], { encoding: "utf-8", timeout: 5000 }));
      for (const w of snap.workspaces ?? []) for (const t of w.terminals ?? []) if (t.title) map.set(t.id, String(t.title).replace(/^[◐◑◒◓●○◌⠀-⣿✳✻·*\s]+/, ""));
    } catch { /* Superset not running */ }
    supersetTitles = { at: Date.now(), map };
  }
  return supersetTitles.map.get(terminalId) ?? null;
}

export function readLiveRooms(dir = SESSIONS_DIR): Map<string, LiveRoom> {
  const rooms = new Map<string, LiveRoom>();
  let files: string[] = [];
  try { files = readdirSync(dir).filter(f => /^\d+\.json$/.test(f)); } catch { return rooms; }
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      const pid = +d.pid;
      if (!d.sessionId || !pid || !alive(pid)) continue;
      let channel: ReplyChannel | null = tmuxChannel(d.tmux);
      if (!channel) {
        const env = envOf(pid);
        if (env.SUPERSET_WORKSPACE_ID && env.SUPERSET_TERMINAL_ID) {
          channel = { kind: "superset", workspaceId: env.SUPERSET_WORKSPACE_ID, terminalId: env.SUPERSET_TERMINAL_ID,
                      label: supersetTitle(env.SUPERSET_TERMINAL_ID) ?? "Superset" };
        }
      }
      rooms.set(String(d.sessionId), { pid, sessionId: String(d.sessionId), status: d.status ?? null, name: d.name ?? null, channel });
    } catch { /* half-written file */ }
  }
  return rooms;
}

/** Claude's own status word (busy / idle / waiting…) → ours. */
export function statusFromRoom(st: string | null): AgentStatus {
  if (!st) return "idle";
  if (/busy|work|run|think/i.test(st)) return "working";
  if (/wait|block|input|permission|ask/i.test(st)) return "waiting";
  return "idle";
}

// ── Agent list ───────────────────────────────────────────────────

export interface MobileAgent {
  id: string;
  title: string;
  room: string | null;
  branch: string | null;
  projectPath: string;
  source: ClaudeSession["triggeredFrom"];
  status: AgentStatus;
  canReply: boolean;
  tmuxTarget: string | null;
  lastUser: string | null;
  lastAssistant: string | null;
  lastActivityAt: string;
  hookMessage: string | null;
}

const clip = (s: string | null | undefined, n = 280) => (s ? (s.length > n ? s.slice(0, n) + "…" : s) : null);

/**
 * Status priority: a fresh hook event → Claude's own room status → "ended" when no live process owns
 * this session (older transcripts in the same folder used to borrow the live room's pid).
 */
export function toMobileAgent(s: ClaudeSession, hook: HookState | undefined, room: LiveRoom | undefined): MobileAgent {
  const base: AgentStatus = room ? statusFromRoom(room.status) : "ended";
  // a live room means the process runs → its "ended" hook belongs to a run before a resume
  const status = hook && hook.at >= Date.parse(s.lastActivityAt) - 5_000 && (room ? hook.status !== "ended" : hook.status === "ended") ? hook.status : base;
  const ch = room?.channel ?? null;
  return {
    id: s.sessionId,
    title: s.worktree?.name || s.projectPath.split("/").pop() || s.projectPath,
    room: ch?.label ?? room?.name ?? null,
    branch: s.worktree?.branch ?? null,
    projectPath: s.projectPath,
    source: ch?.kind === "superset" ? "superset" : ch?.kind === "tmux" ? "tmux" : s.triggeredFrom,
    status,
    canReply: !!ch && status !== "ended",
    tmuxTarget: ch?.kind === "tmux" ? ch.label : null,
    lastUser: clip(s.lastUser),
    lastAssistant: clip(s.lastAssistant),
    lastActivityAt: s.lastActivityAt,
    hookMessage: hook?.message ?? null,
  };
}

async function listAgentsWithRooms(): Promise<{ agent: MobileAgent; room: LiveRoom | undefined }[]> {
  // The same session can appear under two project folders (symlinked paths) — keep one per id.
  const seen = new Set<string>();
  const sessions = (await listClaudeSessions()).filter(s => !seen.has(s.sessionId) && !!seen.add(s.sessionId));
  const rooms = readLiveRooms();
  return sessions
    .map(s => { const room = rooms.get(s.sessionId); return { agent: toMobileAgent(s, hookStates.get(s.sessionId), room), room }; })
    .sort((a, b) => b.agent.lastActivityAt.localeCompare(a.agent.lastActivityAt));
}

async function listAgents(): Promise<MobileAgent[]> {
  return (await listAgentsWithRooms()).map(x => x.agent);
}

async function findRoom(id: string) {
  return (await listAgentsWithRooms()).find(x => x.agent.id === id);
}

// ── Talking to a room (tmux or Superset) ─────────────────────────

/**
 * Claude Code's grey "prompt suggestion" in the input box (e.g. "ไปต่อเลย เสร็จแล้วสรุปมา").
 * It is not saved in the transcript, so it is read off the screen: the live input line starts with
 * "❯" + NBSP (sent messages above use a normal space). tmux keeps colours, so ghost text is
 * recognised by its dim style; Superset's reader returns plain text, so there it may also be a
 * half-typed draft on the Mac (`sure: false`).
 */
/**
 * What is typed in the Mac's input box right now (not Claude's grey suggestion).
 * tmux keeps colours, so ghost text (dim) is excluded; Superset is plain text → `sure: false`.
 */
export function inputDraft(raw: string): { text: string; sure: boolean } | null {
  const lines = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    const plain = lines[i].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (!/^❯\u00a0/.test(plain)) continue;
    const text = plain.slice(2).trim();
    if (!text || /^(Try "|Press up to edit queued messages)/.test(text)) return null;
    if (!/\x1b\[/.test(lines[i])) return { text, sure: false };
    const after = lines[i].slice(lines[i].indexOf("❯") + 1).replace(/^\u00a0/, "");
    const sgr = (after.match(/^(?:\x1b\[[0-9;]*m)+/) ?? [""])[0];
    return /\x1b\[(?:[0-9;]*;)?2(?:;[0-9;]*)?m/.test(sgr) ? null : { text, sure: true };
  }
  return null;
}

export function promptSuggestion(raw: string): { text: string; sure: boolean } | null {
  const lines = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").split("\n");
  const plainOf = (l: string) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    const plain = plainOf(lines[i]);
    if (!/^❯\u00a0/.test(plain)) continue;
    const text = plain.slice(2).trim();
    if (!text || /^(Try "|Press up to edit queued messages)/.test(text)) return null; // empty box, or a static placeholder hint
    if (!/\x1b\[/.test(lines[i])) return { text, sure: false };
    const after = lines[i].slice(lines[i].indexOf("❯") + 1).replace(/^\u00a0/, "");
    const sgr = (after.match(/^(?:\x1b\[[0-9;]*m)+/) ?? [""])[0];
    return /\x1b\[(?:[0-9;]*;)?2(?:;[0-9;]*)?m/.test(sgr) ? { text, sure: true } : null;
  }
  return null;
}

/**
 * Messages typed while the agent is busy sit in Claude's queue (not in the transcript yet) and are
 * drawn as "❯ text" lines just above "ctrl+x ctrl+s to send now". Wrapped lines are indented.
 */
export function queuedMessages(raw: string): string[] {
  const lines = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
  const hint = lines.findLastIndex(l => /ctrl\+x ctrl\+s to send now/.test(l));
  if (hint < 0) return [];
  const out: string[] = []; let cur: string[] = [];
  for (let i = hint - 1; i >= 0 && i >= hint - 40; i--) {
    const l = lines[i];
    if (!l.trim()) break;
    const m = /^❯[\s ](.*)$/.exec(l);
    if (m) { out.unshift([m[1].trim(), ...cur].join(" ").trim()); cur = []; }
    else if (/^\s+\S/.test(l)) cur.unshift(l.trim());
    else break;
  }
  return out.filter(Boolean);
}

/**
 * The live "working" line an agent draws above its input box, e.g.
 *   Claude: "✽ Moonwalking… (19s · ↓ 564 tokens · thinking)"
 *   Codex:  "• Working (12s • esc to interrupt)"
 * Finished lines ("✻ Brewed for 35s · done 4:42 PM") have no "…" and are ignored.
 */
export function agentSpinner(raw: string): { verb: string; detail: string } | null {
  const lines = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    const l = lines[i].trim();
    let m = /^[·✢✳✶✻✽*]\s+(\S[^(…]*…)\s*(?:\((.*)\))?\s*$/u.exec(l);
    if (m) return { verb: m[1].trim(), detail: (m[2] ?? "").trim() };
    m = /^•\s+(Working|Thinking|Exploring|Running)\b[^(]*\((.*)\)\s*$/.exec(l);
    if (m) return { verb: m[1] + "…", detail: m[2].replace(/\s*•\s*esc to interrupt/, "").trim() };
  }
  return null;
}

// ── /compact progress: Claude shows only "Compacting conversation… (25s)", so estimate from past compactions ──
/** "1m 5s · ↓ 3k tokens" → 65 */
export function elapsedSeconds(detail: string): number | null {
  const m = /^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/.exec(detail.trim());
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0));
}
/** Past compactions (compact_boundary entries) → median milliseconds per pre-compact token.
 *  Refreshed in the background at most hourly (a full scan of all transcripts takes ~20 s): find files that
 *  contain a boundary (fast, stops at first hit), then read only the 5 newest of those. */
let compactRate: { at: number; msPerToken: number | null; n: number; busy?: boolean } = { at: 0, msPerToken: null, n: 0 };
const medianRate = (list: { preTokens: number; durationMs: number }[]) => {
  const r = list.map(x => x.durationMs / x.preTokens).sort((a, b) => a - b);
  return { msPerToken: r.length ? r[Math.floor(r.length / 2)] : null, n: r.length };
};
async function refreshCompactRate() {
  if (compactRate.busy) return;
  compactRate.busy = true;
  try {
    const p = Bun.spawn(["/bin/sh", "-c", `ls -t -- "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -150 | xargs /usr/bin/grep -lF '"subtype":"compact_boundary"' 2>/dev/null | head -5 | xargs /usr/bin/grep -hF '"subtype":"compact_boundary"' 2>/dev/null | /usr/bin/grep -o '"preTokens":[0-9]*\\|"durationMs":[0-9]*'`], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text(); await p.exited;
    const list: { preTokens: number; durationMs: number }[] = []; let pre = 0;
    for (const l of out.split("\n")) {
      const m = /"(preTokens|durationMs)":(\d+)/.exec(l); if (!m) continue;
      if (m[1] === "preTokens") pre = +m[2]; else if (pre > 10_000 && +m[2] > 1000) { list.push({ preTokens: pre, durationMs: +m[2] }); pre = 0; }
    }
    compactRate = { at: Date.now(), ...medianRate(list) };
  } catch { compactRate = { ...compactRate, at: Date.now(), busy: false }; }
}
export function compactMsPerToken(samples?: { preTokens: number; durationMs: number }[]): { msPerToken: number | null; n: number } {
  if (samples) return medianRate(samples);
  if (Date.now() - compactRate.at > 3600_000) refreshCompactRate();   // non-blocking; first call uses the default estimate
  return { msPerToken: compactRate.msPerToken, n: compactRate.n };
}
/** {pct, leftS} while compacting; never claims more than 95 % until Claude actually finishes. */
export function compactProgress(elapsedS: number, contextTokens: number | null, rate = compactMsPerToken()) {
  const expected = Math.min(600, Math.max(30, rate.msPerToken && contextTokens ? (rate.msPerToken * contextTokens) / 1000 : 150));
  return { elapsedS, expectedS: Math.round(expected), pct: Math.min(95, Math.round((elapsedS / expected) * 100)), leftS: Math.max(0, Math.round(expected - elapsedS)), basedOn: rate.n };
}

export const ss = (args: string[]) => execFileSync(SUPERSET_BIN, args, { encoding: "utf-8", timeout: 15_000 });

export async function readScreen(ch: ReplyChannel, lines: number): Promise<string> {
  if (ch.kind === "tmux") return capture(ch.pane, lines);
  const out = JSON.parse(ss(["terminals", "read", "--local", "--workspace", ch.workspaceId, "--terminal", ch.terminalId, "--max-lines", String(lines), "--json"]));
  return String(out.text ?? "");
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function typeInto(ch: ReplyChannel, text: string): Promise<void> {
  if (ch.kind === "tmux") {
    const tmux = new Tmux();
    await tmux.sendKeysLiteral(ch.pane, text);
    // an Enter right behind a long paste is sometimes taken as part of the paste → the text sits in the
    // box unsent. Pause, press, then check the box and press again while our text is still there.
    await sleep(250);
    await tmux.sendKeys(ch.pane, "Enter");
    const head = text.split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 24);
    for (let k = 0; k < 2 && head; k++) {
      await sleep(700);
      const box = inputDraft(await readScreen(ch, 40).catch(() => ""))?.text.replace(/\s+/g, " ") ?? "";
      if (!box.startsWith(head)) return;
      await tmux.sendKeys(ch.pane, "Enter");
    }
    return;
  }
  ss(["terminals", "send", "--local", "--workspace", ch.workspaceId, "--terminal", ch.terminalId, "--text", text]);
}

export async function pressKey(ch: ReplyChannel, label: string): Promise<void> {
  if (ch.kind === "tmux") return new Tmux().sendKeys(ch.pane, QUICK_KEYS[label]);
  ss(["terminals", "send", "--local", "--workspace", ch.workspaceId, "--terminal", ch.terminalId, "--keys", SUPERSET_KEYS[label]]);
}


// ── Projects view (Superset-style: project → workspace → rooms/tabs) ─────
// Source of truth is the Superset snapshot (every terminal, any agent) plus tmux panes that run an agent.

export interface Room { id: string; title: string; agent: string | null; status: AgentStatus; claudeSessionId: string | null }
export interface Workspace { id: string; name: string; branch: string | null; rooms: Room[] }
export interface Project { name: string; source: "superset" | "tmux" | "folder"; path?: string; workspaces: Workspace[] }

export function statusFromSuperset(state: string | null | undefined, hasAgent: boolean): AgentStatus {
  if (!hasAgent) return "idle";
  switch (state) {
    case "working": case "starting": return "working";
    case "blocked": return "waiting";
    case "exited": return "idle";   // the agent quit but the terminal is open → still typeable (e.g. `claude --continue`)
    default: return "idle";
  }
}

const cleanTitle = (t: string | null | undefined) => String(t ?? "").replace(/^[◐◑◒◓●○◌✳✻·*\s]+/, "").trim();

let snapCache: { at: number; data: any } = { at: 0, data: null };
export function supersetSnapshot(): any {
  if (Date.now() - snapCache.at < 2_000 && snapCache.data) return snapCache.data;
  let data: any = { workspaces: [] };
  try { data = JSON.parse(ss(["snapshot", "--json"])); } catch { /* Superset not running */ }
  snapCache = { at: Date.now(), data };
  return data;
}

/** Tab titles the user typed in Superset (e.g. "claude Jtekt 2") beat the terminal's auto title. */
function tabTitles(ws: any): Map<string, string> {
  const map = new Map<string, string>();
  for (const tab of ws.layout?.tabs ?? []) {
    const panes = (tab.panes ?? []).filter((p: any) => p.terminalId);
    for (const pane of panes) {
      if (!tab.title) continue;
      // A split tab holds several terminals — name each pane the way Superset's pane header does ("Claude", "Codex")
      const own = cleanTitle(pane.title) || "Terminal";
      map.set(pane.terminalId, panes.length > 1 ? `${tab.title} · ${own}` : tab.title);
    }
  }
  return map;
}
/** Position of each terminal in Superset's tab strip (left → right, panes in order) so the phone lists rooms the same way. */
function tabOrder(ws: any): Map<string, number> {
  const order = new Map<string, number>();
  for (const tab of ws.layout?.tabs ?? []) for (const pane of tab.panes ?? []) if (pane.terminalId && !order.has(pane.terminalId)) order.set(pane.terminalId, order.size);
  return order;
}

// ── Local folders & repos (open any repo on this Mac from the phone) ─────────────
export interface PinnedFolder { name: string; path: string }
export interface TmuxPane { id: string; session: string; window: string; cwd: string; agent: string | null }
const FOLDERS_FILE = join(homedir(), ".maw", "folders.json");
const b64u = (s: string) => Buffer.from(s).toString("base64url");
export const dirId = (path: string) => "dir:" + b64u(path);
/** Only real folders inside $HOME, never hidden ones (.ssh, .aws, …) or ~/Library. */
export function allowedDir(path: string, home = homedir()): string | null {
  try {
    const real = realpathSync(path), h = realpathSync(home);
    if (real !== h && !real.startsWith(h + "/")) return null;
    const rel = real.slice(h.length + 1);
    if (rel && (rel.split("/").some(seg => seg.startsWith(".")) || /^Library(\/|$)/.test(rel))) return null;
    return statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}
export function dirFromId(id: string): string | null {
  if (!/^dir:[A-Za-z0-9_-]+$/.test(id)) return null;
  return allowedDir(Buffer.from(id.slice(4), "base64url").toString("utf-8"));
}
export function loadFolders(file = FOLDERS_FILE): PinnedFolder[] {
  try { return (JSON.parse(readFileSync(file, "utf-8")) as PinnedFolder[]).filter(f => allowedDir(f.path)); } catch { return []; }
}
export function saveFolders(list: PinnedFolder[], file = FOLDERS_FILE) {
  mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 });
}
function gitBranchOf(path: string): string | null {
  try { const head = readFileSync(join(path, ".git", "HEAD"), "utf-8").trim(); return head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 8); } catch { return null; }
}
let panesCache = { at: 0, list: [] as TmuxPane[] };
export function listTmuxPanes(): TmuxPane[] {
  if (Date.now() - panesCache.at < 2_000) return panesCache.list;
  let list: TmuxPane[] = [];
  try {
    // printable separator: tmux escapes control characters like TAB in -F output
    const out = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}|~|#{session_name}|~|#{window_name}|~|#{pane_current_path}|~|#{pane_start_command}|~|#{pane_current_command}"], { encoding: "utf-8", timeout: 3_000 });
    list = out.split("\n").filter(l => l.includes("|~|")).map(l => {
      const [id, session = "", window = "", cwd = "", start = "", cur = ""] = l.split("|~|");
      const cmd = `${start} ${cur}`;
      return { id, session, window, cwd, agent: /\bclaude\b/.test(cmd) ? "claude" : /\bcodex\b/.test(cmd) ? "codex" : null };
    });
  } catch { /* no tmux server */ }
  panesCache = { at: Date.now(), list };
  return list;
}
const REPO_ROOTS = ["artron", "my-project", "oracle", "Desktop", "Documents", "Projects", "code", "dev"];
let reposCache = { at: 0, list: [] as { name: string; path: string; branch: string | null; mtime: number }[] };
/** git repos under the usual folders of $HOME (3 levels deep), newest first; cached 5 min. */
export function scanRepos(home = homedir(), roots = REPO_ROOTS) {
  if (home === homedir() && Date.now() - reposCache.at < 300_000) return reposCache.list;
  const out: { name: string; path: string; branch: string | null; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let ents: any[] = []; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some(d => d.name === ".git")) {
      let mtime = 0; try { mtime = statSync(join(dir, ".git")).mtimeMs; } catch { /* */ }
      out.push({ name: dir.split("/").pop()!, path: dir, branch: gitBranchOf(dir), mtime });
    }
    if (depth >= 3) return;
    for (const d of ents) if (d.isDirectory() && !d.name.startsWith(".") && !/^(node_modules|build|dist|vendor|Pods|target)$/.test(d.name)) walk(join(dir, d.name), depth + 1);
  };
  for (const r of roots) { const p = join(home, r); if (existsSync(p)) walk(p, 1); }
  out.sort((a, b) => b.mtime - a.mtime);
  if (home === homedir()) reposCache = { at: Date.now(), list: out };
  return out;
}

export function buildProjects(snapshot: any, rooms: Map<string, LiveRoom>, local: { folders?: PinnedFolder[]; panes?: TmuxPane[] } = {}): Project[] {
  const byTerminal = new Map<string, LiveRoom>();
  const tmuxRooms: LiveRoom[] = [];
  for (const r of rooms.values()) {
    if (r.channel?.kind === "superset") byTerminal.set(r.channel.terminalId, r);
    if (r.channel?.kind === "tmux") tmuxRooms.push(r);
  }
  const fresh = (r: LiveRoom | undefined) => {
    const h = r && hookStates.get(r.sessionId);
    // r is a live process: a SessionEnd from before a resume (same session id) is stale
    return h && h.status !== "ended" && Date.now() - h.at < 6 * 3600e3 ? h.status : null;
  };
  const projects = new Map<string, Project>();
  for (const w of snapshot?.workspaces ?? []) {
    const name = String(w.project ?? w.name ?? "?");
    const p = projects.get(name) ?? { name, source: "superset" as const, workspaces: [] };
    const titles = tabTitles(w), order = tabOrder(w);
    const pos = (t: any) => order.get(t.id) ?? 1e6;
    p.workspaces.push({
      id: String(w.id), name: String(w.name ?? ""), branch: w.branch ?? null,
      rooms: [...(w.terminals ?? [])].sort((a: any, b: any) => pos(a) - pos(b)).map((t: any) => {
        const live = byTerminal.get(t.id);
        const agent = t.agent?.id ?? null;
        return {
          id: String(t.id),
          title: titles.get(t.id) || cleanTitle(t.title) || (agent ? agent : "terminal"),
          agent,
          status: fresh(live) ?? (live ? statusFromRoom(live.status) : statusFromSuperset(t.agent?.state, !!agent)),
          claudeSessionId: live?.sessionId ?? null,
        };
      }),
    });
    projects.set(name, p);
  }
  // tmux: Claude panes (live sessions) + every pane of a session the phone opened ("mm-…", may run codex / a shell)
  const byPane = new Map<string, Room>();
  // a pane that is still open always takes keys (trust prompt, a shell after claude quit) → never "ended"
  const openPanes = new Set((local.panes ?? []).map(p => p?.id).filter(Boolean));
  for (const r of tmuxRooms) {
    const pane = (r.channel as Channel).pane, st = fresh(r) ?? statusFromRoom(r.status);
    byPane.set(pane, { id: pane, title: (r.channel as Channel).label, agent: "claude", status: st === "ended" && openPanes.has(pane) ? "idle" : st, claudeSessionId: r.sessionId });
  }
  for (const p of local.panes ?? []) if (p?.id && !byPane.has(p.id))
    byPane.set(p.id, { id: p.id, title: String(p.session ?? "").startsWith("mm-") ? `${p.session.slice(3)} · ${p.window}` : p.session, agent: p.agent, status: "idle", claudeSessionId: null });
  const paneCwd = new Map((local.panes ?? []).map(p => [p.id, p.cwd]));
  // pinned folders become projects; a tmux room working inside one moves under it
  for (const f of local.folders ?? []) {
    const id = dirId(f.path), inside = (c?: string) => !!c && (c === f.path || c.startsWith(f.path + "/"));
    const mine = [...byPane.values()].filter(r => inside(paneCwd.get(r.id)));
    for (const r of mine) byPane.delete(r.id);
    projects.set(`📁 ${f.name}`, { name: `📁 ${f.name}`, source: "folder", path: f.path, workspaces: [{ id, name: f.name, branch: gitBranchOf(f.path), rooms: mine }] });
  }
  if (byPane.size) projects.set("tmux", { name: "tmux", source: "tmux", workspaces: [{ id: "tmux", name: "tmux", branch: null, rooms: [...byPane.values()] }] });
  return [...projects.values()];
}

/** A new folder's name: one plain segment, no hidden/dot names, no separators. */
export function safeFolderName(name: unknown): string | null {
  const n = String(name ?? "").trim();
  if (!n || n.length > 80 || n.startsWith(".") || n.startsWith("-") || /[\/\\\x00-\x1f:]/.test(n)) return null;
  return n;
}
/** Only https / ssh git URLs (no local paths, no "ext::", nothing that git could read as an option). */
export function cloneUrlOk(url: unknown): string | null {
  const u = String(url ?? "").trim();
  if (u.length > 300 || /\s/.test(u)) return null;
  if (/^https:\/\/[\w.-]+(:\d+)?\/[\w.~\-\/]+$/.test(u)) return u;
  if (/^git@[\w.-]+:[\w.~\-\/]+$/.test(u)) return u;
  return null;
}
export const repoNameFromUrl = (u: string) => (u.replace(/\/+$/, "").split(/[\/:]/).pop() || "repo").replace(/\.git$/, "");

/** New tmux window (session "mm-<folder>", created if missing) running claude / codex / a shell in `dir`. */
export async function openTmuxRoom(dir: string, agent: string, prompt?: string, run = (args: string[]) => execFileSync("tmux", args, { encoding: "utf-8", timeout: 5_000 })) {
  const session = "mm-" + (dir.split("/").pop() || "home").replace(/[^\w-]/g, "-").slice(0, 30);
  const cmd = agent === "claude" ? ["claude"] : agent === "codex" ? ["codex"] : [];
  let exists = true; try { run(["has-session", "-t", "=" + session]); } catch { exists = false; }
  const pane = (exists
    ? run(["new-window", "-P", "-F", "#{pane_id}", "-t", "=" + session + ":", "-c", dir, ...cmd])
    : run(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", session, "-c", dir, ...cmd])).trim();
  if (!/^%\d+$/.test(pane)) throw new Error("tmux ไม่คืน pane id");
  if (prompt && cmd.length) setTimeout(async () => { try { await typeInto({ kind: "tmux", pane, label: pane }, prompt); } catch { /* window closed */ } }, 4_000);
  panesCache.at = 0;
  return { session, pane };
}

/** Resolve a (workspace, room) pair from the phone into something we can read/type into. */
export function roomChannel(ws: string, room: string): ReplyChannel | null {
  if (ws === "tmux" || ws.startsWith("dir:")) return /^%\d+$/.test(room) ? { kind: "tmux", pane: room, label: room } : null;
  if (!/^[0-9a-f-]{36}$/i.test(ws) || !/^[0-9a-f-]{36}$/i.test(room)) return null;
  return { kind: "superset", workspaceId: ws, terminalId: room, label: room };
}


// ── Chat view: the full conversation, like Claude Code itself ─────────────
// Every user message, every assistant reply, every tool call (with its result) and every sub-agent.
// Transcripts are huge (100 MB+), so each file is parsed once and then only the appended bytes.

export interface ChatTool { name: string; summary: string; input: string; output: string | null; error: boolean; bg?: "running" | "done" }
export interface ChatItem { i: number; role: "user" | "assistant" | "tool" | "agent" | "system"; ts: string | null; text?: string; tool?: ChatTool; images?: string[]; queued?: boolean; canceled?: boolean }

const IMG_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
/** Pasted images live base64-encoded inside transcripts; write each once to disk and hand the phone a URL. */
export function transcriptImage(b64: string, mediaType: string, dir = join(UPLOAD_DIR, "img")): string | null {
  const ext = IMG_EXT[mediaType]; if (!ext || !b64) return null;
  const name = createHash("sha1").update(b64).digest("hex").slice(0, 20) + "." + ext;
  const f = join(dir, name);
  if (!existsSync(f)) { mkdirSync(dir, { recursive: true }); writeFileSync(f, Buffer.from(b64, "base64")); }
  return `/mobile/img/${name}`;
}
const imageOf = (b: any): string | null =>
  b?.type === "image" && b.source?.type === "base64" ? transcriptImage(b.source.data, b.source.media_type)
  : b?.type === "input_image" && typeof b.image_url === "string" ? (m => m ? transcriptImage(m[2], m[1]) : null)(/^data:([^;]+);base64,(.+)$/s.exec(b.image_url))
  : null;

const OUT_MAX = 6000, IN_MAX = 4000;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (ตัด ${s.length - n} ตัวอักษร)` : s);

function toolView(name: string, inp: any): { summary: string; input: string } {
  const i = inp ?? {};
  switch (name) {
    case "Bash": case "Monitor": case "PowerShell":
      return { summary: i.description || String(i.command ?? "").split("\n")[0], input: String(i.command ?? "") };
    case "Read": return { summary: i.file_path ?? "", input: i.file_path ?? "" };
    case "Write": return { summary: i.file_path ?? "", input: cut(String(i.content ?? ""), IN_MAX) };
    case "Edit": return { summary: i.file_path ?? "", input: cut(`- ${String(i.old_string ?? "").replace(/\n/g, "\n- ")}\n+ ${String(i.new_string ?? "").replace(/\n/g, "\n+ ")}`, IN_MAX) };
    case "Grep": case "Glob": return { summary: `${i.pattern ?? ""}${i.path ? "  in " + i.path : ""}`, input: JSON.stringify(i, null, 1) };
    case "WebFetch": return { summary: i.url ?? "", input: i.prompt ?? "" };
    case "WebSearch": return { summary: i.query ?? "", input: i.query ?? "" };
    case "Skill": return { summary: i.skill ?? "", input: i.args ?? "" };
    case "Agent": case "Task": return { summary: `${i.subagent_type ?? "agent"} · ${i.description ?? ""}`, input: cut(String(i.prompt ?? ""), IN_MAX) };
    default: return { summary: Object.values(i).filter(v => typeof v === "string").map(v => String(v).split("\n")[0]).join(" · ").slice(0, 160), input: cut(JSON.stringify(i, null, 1), IN_MAX) };
  }
}

function resultText(c: any): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(b => (b.type === "text" ? b.text : b.type === "image" ? "[รูปภาพ]" : "")).join("\n");
  return "";
}

/** User strings that are harness plumbing, not something the person typed. */
function userMessage(raw: string): { role: "user" | "system"; text: string } | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^<(local-command-stdout|local-command-caveat|system-reminder|local-command-stderr)>/.test(t)) return null;
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([\s\S]*?)<\/command-args>)?/);
  if (cmd) return { role: "user", text: `${cmd[1].trim()} ${(cmd[2] ?? "").trim()}`.trim() };
  if (t.startsWith("<task-notification>")) {
    const sum = t.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? "งานเบื้องหลังจบแล้ว";
    return { role: "system", text: "🔔 " + sum.trim() };
  }
  if (/^\[Request interrupted by user/.test(t)) return { role: "system", text: "⏹ หยุดงานกลางคัน" };
  const text = raw.replace(/<\/?pasted_content[^>]*>/g, "").replace(/\[Image: source: [^\]\n]+\]/g, "").trim();
  return text ? { role: "user", text } : null;
}

interface ParseState { size: number; partial: string; items: ChatItem[]; tools: Map<string, ChatItem>; sentQ?: ChatItem[]; removedQ?: ChatItem[]; skipFirst?: boolean }
const transcripts = new Map<string, ParseState>();
const BOOT_ID = Date.now().toString(36);

/** "<task-notification>…<tool-use-id>X</tool-use-id><status>completed</status><summary>…" closes the background card X. */
function finishBackground(st: ParseState, raw: string) {
  const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(raw)?.[1]?.trim();
  const it = id ? st.tools.get(id) : undefined;
  if (!it?.tool) return;
  const status = /<status>([^<]+)<\/status>/.exec(raw)?.[1]?.trim() ?? "completed";
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(raw)?.[1]?.trim() ?? "";
  const result = /<result>([\s\S]*?)<\/result>/.exec(raw)?.[1]?.trim() ?? "";
  it.tool.bg = "done"; it.tool.error = status !== "completed";
  it.tool.output = cut([summary, result].filter(Boolean).join("\n\n") || status, OUT_MAX);
}

export function parseTranscriptLines(st: ParseState, lines: string[]): void {
  const push = (it: Omit<ChatItem, "i">) => { const x = { ...it, i: st.items.length } as ChatItem; st.items.push(x); return x; };
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    const ts = e.timestamp ?? null, c = e.message?.content;
    // Typed while the agent is busy: "enqueue" is written the moment it's sent → show it there (in order),
    // marked queued until "remove" (Claude took it). The later queued_command attachment is then a duplicate.
    if (e.type === "queue-operation") {
      const text = typeof e.content === "string" ? e.content : "";
      // "remove" names the message; "dequeue" (agent became free) has no text and takes the oldest one —
      // it then arrives as a normal user turn, which must not be shown twice
      const pending = st.items.filter(x => x.queued && (e.operation === "dequeue" || x.text === (userMessage(text)?.text ?? text)));
      if (e.operation === "enqueue") { const m = userMessage(text); if (m?.role === "user") push({ role: "user", ts, text: m.text, queued: true }); }
      else if (e.operation === "dequeue" && pending[0]) { pending[0].queued = false; (st.sentQ ??= []).push(pending[0]); }
      // "remove" = either Claude took it mid-turn (a queued_command follows right away) or the user deleted it on the Mac
      else if (e.operation === "remove" && pending[0]) { pending[0].queued = false; (st.sentQ ??= []).push(pending[0]); (st.removedQ ??= []).push(pending[0]); }
      continue;
    }
    // a tool_result can sit between "remove" and the queued_command (message sent while a tool was running) —
    // only a real reply or a new typed turn proves the removed message was deleted instead
    const realTurn = e.type === "assistant" || (e.type === "user" && !(Array.isArray(c) && c.every((b: any) => b?.type === "tool_result")));
    if (st.removedQ?.length && realTurn) {
      for (const it of st.removedQ) { it.canceled = true; st.sentQ = st.sentQ?.filter(x => x !== it); }
      st.removedQ = [];
    }
    if (e.type === "attachment" && e.attachment?.type === "queued_command") {
      // Messages typed while the agent was busy are stored as attachments, not as user turns.
      const pr = e.attachment.prompt;
      const raw = typeof pr === "string" ? pr : Array.isArray(pr) ? pr.map((b: any) => b.text ?? "").join("\n") : "";
      const images = Array.isArray(pr) ? pr.map(imageOf).filter(Boolean) as string[] : [];
      const m = userMessage(raw) ?? (images.length ? { role: "user" as const, text: "" } : null);
      const seen = st.sentQ?.findIndex(x => x.text === m?.text) ?? -1;
      if (seen >= 0) { const it = st.sentQ!.splice(seen, 1)[0]; st.removedQ = st.removedQ?.filter(x => x !== it); if (images.length) it.images = images; continue; } // already shown at enqueue time
      if (m) push({ role: m.role, ts: e.attachment.timestamp ?? ts, text: m.text, ...(images.length && m.role === "user" ? { images } : {}) });
      continue;
    }
    if (e.type === "user") {
      if (e.isMeta) continue;
      const parts = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
      // one bubble per turn: "[Image #7] ผิดแชท" + the pasted picture(s)
      const images = parts.map(imageOf).filter(Boolean) as string[];
      let owner: ChatItem | null = null;
      for (const b of parts) {
        if (b.type === "text") {
          const raw = String(b.text ?? "");
          if (raw.trimStart().startsWith("<task-notification>")) finishBackground(st, raw);
          const m = userMessage(raw); if (!m) continue;
          const seen = m.role === "user" ? st.sentQ?.findIndex(x => x.text === m.text) ?? -1 : -1;
          if (seen >= 0) { const it = st.sentQ!.splice(seen, 1)[0]; if (!owner) owner = it; continue; } // shown when it was queued
          const it = push({ role: m.role, ts, text: m.text }); if (m.role === "user" && !owner) owner = it;
        }
        if (b.type === "tool_result") {
          const t = st.tools.get(b.tool_use_id);
          if (t?.tool) {
            const out = resultText(b.content);
            // background agent / shell: the result comes later in a <task-notification>, until then it is still running
            if (/^(Async agent launched|Command running in background)/.test(out.trim())) { t.tool.bg = "running"; t.tool.output = null; }
            else { t.tool.output = cut(out, OUT_MAX); t.tool.error = !!b.is_error; }
          }
        }
      }
      if (images.length && !parts.some((b: any) => b.type === "tool_result")) (owner ?? push({ role: "user", ts, text: "" })).images = images;
    } else if (e.type === "assistant" && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === "text" && String(b.text ?? "").trim()) push({ role: "assistant", ts, text: b.text });
        // Claude Code sometimes records a visible reply as a thinking block with plain text (shown on the Mac with
        // an orange marker); hidden/encrypted thinking has empty text and stays hidden
        if (b.type === "thinking" && /[\p{L}\p{N}]/u.test(String(b.thinking ?? ""))) push({ role: "assistant", ts, text: b.thinking }); // "…" / blank = hidden
        if (b.type === "tool_use") {
          const v = toolView(b.name, b.input);
          const item = push({ role: b.name === "Agent" || b.name === "Task" ? "agent" : "tool", ts, tool: { name: b.name, ...v, output: null, error: false } });
          st.tools.set(b.id, item);
        }
      }
    }
  }
}

function transcriptFile(sessionId: string, root = join(homedir(), ".claude", "projects")): string | null {
  try {
    for (const d of readdirSync(root)) { const f = join(root, d, `${sessionId}.jsonl`); if (existsSync(f)) return f; }
  } catch { /* no projects dir */ }
  return null;
}

type LineParser = (st: ParseState, lines: string[]) => void;

/** Parse a growing JSONL transcript once, then only the bytes appended since the last call. */
/** Transcripts can be hundreds of MB; the phone only needs the recent part. Bigger files start at the last 24 MB. */
export const TAIL_START = 32 * 1024 * 1024, TAIL_BYTES = 24 * 1024 * 1024;
function readIncremental(file: string, parse: LineParser): ChatItem[] {
  const size = statSync(file).size;
  let st = transcripts.get(file);
  if (!st || size < st.size) {
    st = { size: 0, partial: "", items: [], tools: new Map() };
    if (size > TAIL_START) { st.size = size - TAIL_BYTES; st.skipFirst = true; } // the first line there is cut in half
    transcripts.set(file, st);
  }
  if (size > st.size) {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - st.size);
      readSync(fd, buf, 0, buf.length, st.size);
      const lines = (st.partial + buf.toString("utf-8")).split("\n");
      st.partial = lines.pop() ?? "";
      if (st.skipFirst) { lines.shift(); st.skipFirst = false; }
      parse(st, lines);
      st.size = size;
    } finally { closeSync(fd); }
  }
  return st.items;
}

/** Full conversation for a Claude session. */
export function claudeTranscript(sessionId: string, root?: string): ChatItem[] | null {
  const file = transcriptFile(sessionId, root);
  return file ? readIncremental(file, parseTranscriptLines) : null;
}

// ── Codex (~/.codex/sessions/**/rollout-*.jsonl) ──

/** Codex user turns also carry injected context (AGENTS.md, environment) — only keep what the person typed. */
function codexUserText(raw: string): { role: "user" | "system"; text: string } | null {
  const t = raw.trim();
  if (!t || /^(<environment_context>|<user_instructions>|<permissions|# AGENTS\.md|<INSTRUCTIONS>|<turn_aborted>)/.test(t)) return null;
  const text = t.replace(/<image\b[^>]*>(?:<\/image>)?/g, "").replace(/\[Image: source: [^\]\n]+\]/g, "").trim();
  return text ? { role: "user", text } : null;
}

function codexOutput(o: any): { text: string; error: boolean } {
  let text = typeof o === "string" ? o : Array.isArray(o) ? o.map((b: any) => b.text ?? "").join("\n") : JSON.stringify(o ?? "");
  const code = text.match(/Process exited with code (\d+)/)?.[1];
  text = text.replace(/^Chunk ID:[\s\S]*?\nOutput:\n/, "");
  return { text: cut(text, OUT_MAX), error: !!code && code !== "0" };
}

export function parseCodexLines(st: ParseState, lines: string[]): void {
  const push = (it: Omit<ChatItem, "i">) => { const x = { ...it, i: st.items.length } as ChatItem; st.items.push(x); return x; };
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    const p = e.payload ?? {}, ts = e.timestamp ?? null;
    if (e.type === "event_msg" && p.type === "turn_aborted") { push({ role: "system", ts, text: "⏹ หยุดงานกลางคัน" }); continue; }
    if (e.type !== "response_item") continue;
    if (p.type === "message") {
      const text = (p.content ?? []).map((c: any) => c.text ?? "").join("\n");
      if (p.role === "user") {
        const images = (p.content ?? []).map(imageOf).filter(Boolean) as string[];
        const m = codexUserText(text) ?? (images.length ? { role: "user" as const, text: "" } : null);
        if (m) push({ role: m.role, ts, text: m.text, ...(images.length && m.role === "user" ? { images } : {}) });
      }
      else if (p.role === "assistant" && text.trim()) push({ role: "assistant", ts, text });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      let args: any = p.arguments ?? p.input ?? "";
      try { if (typeof args === "string" && args.startsWith("{")) args = JSON.parse(args); } catch { /* raw */ }
      const cmd = typeof args === "string" ? args : args.cmd ?? args.command ?? "";
      const isShell = p.name === "exec_command" || p.name === "shell" || p.name === "exec";
      const summary = isShell ? String(Array.isArray(cmd) ? cmd.join(" ") : cmd).split("\n")[0]
        : p.name === "apply_patch" ? (String(args).match(/\*\*\* (?:Update|Add|Delete) File: (.+)/)?.[1] ?? "แก้ไฟล์")
        : typeof args === "string" ? args.split("\n")[0] : Object.values(args).filter(v => typeof v === "string").join(" · ");
      const item = push({ role: "tool", ts, tool: {
        name: isShell ? "Bash" : p.name === "apply_patch" ? "Edit" : p.name,
        summary: String(summary).slice(0, 200),
        input: cut(typeof args === "string" ? args : isShell ? String(Array.isArray(cmd) ? cmd.join(" ") : cmd) : JSON.stringify(args, null, 1), IN_MAX),
        output: null, error: false } });
      st.tools.set(p.call_id, item);
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const t = st.tools.get(p.call_id);
      if (t?.tool) { const o = codexOutput(p.output); t.tool.output = o.text; t.tool.error = o.error; }
    } else if (p.type === "agent_message") {
      // Sub-agent traffic: the payload itself is encrypted, show who talked to whom and the visible header.
      const head = (p.content ?? []).filter((c: any) => c.type === "input_text").map((c: any) => c.text).join("\n");
      const task = head.match(/Task name: (\S+)/)?.[1] ?? p.recipient ?? "";
      push({ role: "agent", ts, tool: { name: "Agent", summary: `${String(task).split("/").pop()} · ${p.author ?? ""} → ${p.recipient ?? ""}`, input: head.trim(), output: "(ข้อความระหว่าง agent ถูกเข้ารหัส)", error: false } });
    }
  }
}

/** First line of a rollout is session_meta; sub-agent threads say source.subagent. */
export function isSubagentRollout(file: string): boolean {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const first = buf.subarray(0, n).toString("utf-8").split("\n")[0];
      const src = JSON.parse(first)?.payload?.source;
      return typeof src === "object" && src !== null && "subagent" in src;
    } finally { closeSync(fd); }
  } catch { return false; }
}

let codexFiles: { at: number; map: Map<string, string> } = { at: 0, map: new Map() };
/** Superset terminal id → the rollout file its running codex process has open. */
export function codexFileFor(terminalId: string): string | null {
  if (Date.now() - codexFiles.at > 15_000) {
    const map = new Map<string, string>();
    try {
      const pids = execFileSync("pgrep", ["-x", "codex"], { encoding: "utf-8", timeout: 2000 }).split("\n").filter(Boolean);
      for (const pid of pids) {
        const tid = envOf(+pid).SUPERSET_TERMINAL_ID;
        if (!tid) continue;
        const files = execFileSync("/usr/sbin/lsof", ["-p", pid, "-Fn"], { encoding: "utf-8", timeout: 3000 });
        const open = [...files.matchAll(/^n(\/.*\/rollout-[^\n]*\.jsonl)$/gm)].map(m => m[1]);
        // A codex process keeps its sub-agents' rollouts open too — pick the thread the person talks to.
        const main = open.find(f => !isSubagentRollout(f)) ?? open[0];
        if (main) map.set(tid, main);
      }
    } catch { /* no codex running */ }
    codexFiles = { at: Date.now(), map };
  }
  return codexFiles.map.get(terminalId) ?? null;
}

export function codexTranscript(file: string): ChatItem[] {
  return readIncremental(file, parseCodexLines);
}


// ── Attachments from the phone: stored on this Mac, the room gets the path in the message ──

export const UPLOAD_DIR = join(homedir(), ".maw", "uploads");
const UPLOAD_MAX = 25 * 1024 * 1024;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", json: "application/json" };

/** Keep letters (any script), digits, dot, dash, underscore — never a path. */
export function safeName(name: string): string {
  const base = String(name || "file").split(/[\\/]/).pop()!.normalize("NFC");
  const clean = base.replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "_").replace(/^\.+/, "").slice(-120);
  return clean || "file";
}

export function saveUpload(name: string, data: Uint8Array, dir = UPLOAD_DIR): string {
  const day = new Date().toISOString().slice(0, 10);
  const folder = join(dir, day);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${randomBytes(4).toString("hex")}-${safeName(name)}`);
  writeFileSync(file, data, { mode: 0o600 });
  return file;
}


// ── Workspace explorer (read-only): folders, files, git — like Superset's sidebar ──

let wsPaths: { at: number; map: Map<string, string> } = { at: 0, map: new Map() };
// ── Push notifications (Web Push into the installed PWA) ───────────

const PUSH_FILE = join(homedir(), ".maw", "push.json"); // VAPID keys + phone subscriptions, mode 600
interface PushStore { vapid: { publicKey: string; privateKey: string }; subs: any[] }
export function loadPush(file = PUSH_FILE): PushStore {
  try { const d = JSON.parse(readFileSync(file, "utf-8")); if (d.vapid?.publicKey) return { vapid: d.vapid, subs: d.subs ?? [] }; } catch { /* first run */ }
  const d: PushStore = { vapid: webpush.generateVAPIDKeys(), subs: [] };
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(d, null, 2), { mode: 0o600 });
  return d;
}
const savePush = (d: PushStore, file = PUSH_FILE) => writeFileSync(file, JSON.stringify(d, null, 2), { mode: 0o600 });

/** What a hook event should say on the phone, or null (only "waiting" and "done" are worth a buzz). No work content is sent. */
export function pushFor(event: string, room: string, message?: string): { title: string; body: string } | null {
  if (event === "Notification" || event === "PermissionRequest")
    return { title: `🟡 รอคำตอบ · ${room}`, body: /permission/i.test(message ?? "") || event === "PermissionRequest" ? "ขออนุญาตใช้ tool — แตะเพื่อตอบ" : "รอพี่ตอบอยู่ — แตะเพื่อเปิดห้อง" };
  if (event === "Stop") return { title: `✅ เสร็จแล้ว · ${room}`, body: "ทำงานรอบนี้เสร็จ — แตะเพื่อดูผล" };
  if (event === "StopFailure") return { title: `🔴 error · ${room}`, body: `${message ? message + " — " : ""}Claude หยุดกลางทาง — แตะเพื่อดู` };
  return null;
}
const lastPush = new Map<string, number>();
/** Send to every subscribed phone; drop subscriptions the push service says are gone. Same session + kind at most once a minute. */
export async function notifyPhones(sid: string, kind: string, msg: { title: string; body: string }) {
  const key = sid + kind, now = Date.now();
  if (now - (lastPush.get(key) ?? 0) < 60_000) return 0;
  lastPush.set(key, now);
  const d = loadPush(); if (!d.subs.length) return 0;
  webpush.setVapidDetails("mailto:maw-mobile@localhost", d.vapid.publicKey, d.vapid.privateKey);
  const payload = JSON.stringify({ ...msg, kind, tag: sid, url: `/m.html?open=${encodeURIComponent(sid)}` });
  let sent = 0; const keep: any[] = [];
  for (const sub of d.subs) {
    try { await webpush.sendNotification(sub, payload, { TTL: 600, urgency: "high" }); sent++; keep.push(sub); }
    catch (e: any) { if (e?.statusCode !== 404 && e?.statusCode !== 410) keep.push(sub); }
  }
  if (keep.length !== d.subs.length) savePush({ ...d, subs: keep });
  return sent;
}

// ── Context, plan limits and Mac health for the phone header ───────

const STATUS_DIR = join(homedir(), ".maw", "status"); // written by ~/.claude/statusline.sh on every redraw
type Limit = { pct: number; resetsAt: number | null } | null;
export interface Usage { context: { pct: number | null; used: number; size: number | null } | null; limits: { h5: Limit; d7: Limit } | null; model?: string | null; at?: number }

const limitOf = (x: any): Limit => x && typeof x.used_percentage === "number" ? { pct: Math.round(x.used_percentage), resetsAt: x.resets_at ?? null } : null;

/** Claude's own numbers (same as its status line) for one session. */
export function claudeUsage(sid: string, dir = STATUS_DIR): Usage | null {
  if (!/^[\w-]{8,80}$/.test(sid)) return null;
  const f = join(dir, sid + ".json");
  try {
    const d = JSON.parse(readFileSync(f, "utf-8")), cw = d.context_window ?? {}, u = cw.current_usage ?? {};
    const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const size = cw.context_window_size ?? null;
    return {
      context: { pct: typeof cw.used_percentage === "number" ? Math.round(cw.used_percentage) : size ? Math.round(used * 100 / size) : null, used, size },
      limits: d.rate_limits ? { h5: limitOf(d.rate_limits.five_hour), d7: limitOf(d.rate_limits.seven_day) } : null,
      model: d.model?.display_name ?? null, at: statSync(f).mtimeMs,
    };
  } catch { return null; }
}
/** Account-wide Claude limits = the most recently written status file that has them. */
export function claudeLimits(dir = STATUS_DIR): (Usage["limits"] & { at: number }) | null {
  let best: any = null;
  try {
    for (const n of readdirSync(dir)) {
      if (!n.endsWith(".json")) continue;
      const u = claudeUsage(n.slice(0, -5), dir);
      if (u?.limits && (!best || (u.at ?? 0) > best.at)) best = { ...u.limits, at: u.at ?? 0 };
    }
  } catch { /* no dir yet */ }
  return best;
}

/** Codex writes token_count events (context + rate limits) into its rollout file. */
export function codexUsage(file: string): Usage | null {
  try {
    const size = statSync(file).size, fd = openSync(file, "r");
    const len = Math.min(size, 512 * 1024), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len); closeSync(fd);
    const lines = buf.toString("utf-8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue;
      let p: any; try { p = JSON.parse(lines[i]).payload; } catch { continue; }
      if (p?.type !== "token_count") continue;
      const win = p.info?.model_context_window ?? null, used = p.info?.last_token_usage?.input_tokens ?? 0;
      const lim: { h5: Limit; d7: Limit } = { h5: null, d7: null };
      for (const w of [p.rate_limits?.primary, p.rate_limits?.secondary]) {
        if (!w) continue;
        const v = { pct: Math.round(w.used_percent), resetsAt: w.resets_at ?? null };
        if (w.window_minutes <= 600) lim.h5 = v; else lim.d7 = v;
      }
      return { context: p.info ? { pct: win ? Math.round(used * 100 / win) : null, used, size: win } : null, limits: p.rate_limits ? lim : null, at: statSync(file).mtimeMs };
    }
  } catch { /* unreadable */ }
  return null;
}
/** Account-wide Codex limits from the newest rollout file. */
export function codexLimits(root = join(homedir(), ".codex", "sessions")) {
  const newest = (dir: string) => { try { return readdirSync(dir).filter(n => /^\d+$/.test(n)).sort().reverse(); } catch { return []; } };
  for (const y of newest(root)) for (const m of newest(join(root, y))) for (const d of newest(join(root, y, m))) {
    const day = join(root, y, m, d);
    const files = readdirSync(day).filter(n => n.endsWith(".jsonl")).map(n => ({ f: join(day, n), t: statSync(join(day, n)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(0, 5)) { const u = codexUsage(f); if (u?.limits) return { ...u.limits, at: u.at ?? 0 }; }
    return null;
  }
  return null;
}

const sh = async (cmd: string[]) => { const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" }); const out = await new Response(p.stdout).text(); await p.exited; return out; };
let macCache: { at: number; v: any } | null = null;
const THERMAL_BIN = join(homedir(), ".maw", "bin", "thermal");
/** CPU % (of one core, like Activity Monitor) and RAM of maw itself and of all Claude / Codex agents. */
export function processUsage(psOut: string, selfPid: number) {
  const out = { maw: { cpu: 0, ramMB: 0 }, claude: { cpu: 0, ramMB: 0, n: 0 }, codex: { cpu: 0, ramMB: 0, n: 0 } };
  for (const line of psOut.split("\n").slice(1)) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line); if (!m) continue;
    const name = m[4].trim().split("/").pop()!, cpu = +m[2], mb = +m[3] / 1024;
    const g = +m[1] === selfPid ? out.maw : name === "claude" ? out.claude : /^codex/.test(name) ? out.codex : null;
    if (!g) continue;
    g.cpu += cpu; g.ramMB += mb; if ("n" in g && (name === "claude" || name === "codex")) (g as any).n++;
  }
  for (const g of Object.values(out)) { g.cpu = Math.round(g.cpu); g.ramMB = Math.round(g.ramMB); }
  return out;
}
/** Battery, CPU, RAM, disk of this Mac (cached 10 s; CPU needs a 1 s sample). */
export async function macHealth() {
  if (macCache && Date.now() - macCache.at < 10_000) return macCache.v;
  const [batt, top, mem, total, df] = await Promise.all([
    // absolute paths: maw runs under launchd, whose PATH has no /usr/sbin
    sh(["/usr/bin/pmset", "-g", "batt"]), sh(["/usr/bin/top", "-l", "2", "-n", "0", "-s", "1"]), sh(["/usr/bin/memory_pressure", "-Q"]),
    sh(["/usr/sbin/sysctl", "-n", "hw.memsize"]), sh(["/bin/df", "-k", "/System/Volumes/Data"]),
  ].map(p => p.catch(() => "")));
  // heat: macOS thermal state via scripts/thermal.swift (0 ปกติ · 1 อุ่น · 2 ร้อน · 3 ร้อนจัด); and who uses the machine
  const [therm, procs] = await Promise.all([
    existsSync(THERMAL_BIN) ? sh([THERMAL_BIN]).catch(() => "") : Promise.resolve(""),
    sh(["/bin/ps", "-axo", "pid,pcpu,rss,comm"]).catch(() => ""),
  ]);
  const b = /(\d+)%;\s*([\w ]+?);\s*(?:(\d+:\d+) remaining)?/.exec(batt);
  const cpuL = [...top.matchAll(/CPU usage:.*?([\d.]+)% idle/g)].pop();
  const freePct = Number(/free percentage:\s*(\d+)%/.exec(mem)?.[1] ?? NaN);
  const memTotal = Number(total.trim()) || Number(/system has (\d+)/.exec(mem)?.[1] ?? 0);
  const dfl = df.trim().split("\n")[1]?.split(/\s+/) ?? [];
  const v = {
    battery: b ? { pct: +b[1], state: b[2].trim(), remaining: b[3] ?? null, ac: /AC Power/.test(batt) } : null,
    cpu: cpuL ? Math.round(100 - Number(cpuL[1])) : null,
    ram: memTotal && !isNaN(freePct) ? { pct: 100 - freePct, totalGB: +(memTotal / 2 ** 30).toFixed(0), usedGB: +((memTotal / 2 ** 30) * (100 - freePct) / 100).toFixed(1) } : null,
    heat: /^[0-3]$/.test(therm.trim()) ? +therm.trim() : null,
    usage: processUsage(procs, process.pid),
    disk: dfl.length > 3 ? { totalGB: Math.round(+dfl[1] / 2 ** 20), freeGB: Math.round(+dfl[3] / 2 ** 20), pct: Math.round(100 - (+dfl[3] / +dfl[1]) * 100) } : null,
  };
  macCache = { at: Date.now(), v };
  return v;
}

// ── Slash commands & skills for the "/" picker ───────────────────

export interface SlashCmd { name: string; insert: string; desc: string; source: "builtin" | "user" | "project" | "plugin" | "prompt" | "skill" }

const CLAUDE_BUILTIN: [string, string][] = [
  ["clear", "ล้างบทสนทนา เริ่มใหม่"], ["compact", "ย่อบทสนทนาให้สั้นลง"], ["context", "ดูการใช้ context"], ["cost", "ดูค่าใช้จ่าย session นี้"],
  ["model", "เปลี่ยนโมเดล"], ["resume", "กลับไปคุย session เก่า"], ["rewind", "ย้อนกลับไปข้อความก่อนหน้า"], ["status", "สถานะ Claude Code"],
  ["memory", "แก้ไฟล์ความจำ CLAUDE.md"], ["agents", "จัดการ subagent"], ["mcp", "จัดการ MCP server"], ["hooks", "ดู/แก้ hooks"],
  ["permissions", "สิทธิ์ของ tool"], ["review", "รีวิว PR"], ["init", "สร้าง CLAUDE.md ให้โปรเจค"], ["usage", "ดูโควต้าการใช้งาน"],
  ["todos", "ดูรายการงาน"], ["export", "ส่งออกบทสนทนา"], ["add-dir", "เพิ่มโฟลเดอร์ที่ทำงานได้"], ["doctor", "ตรวจการติดตั้ง"],
  ["plugin", "จัดการ plugin"], ["config", "ตั้งค่า"], ["help", "วิธีใช้"],
];
const CODEX_BUILTIN: [string, string][] = [
  ["model", "เปลี่ยนโมเดล/ระดับการคิด"], ["approvals", "ระดับการขออนุญาต"], ["new", "เริ่มบทสนทนาใหม่"], ["compact", "ย่อบทสนทนา"],
  ["diff", "ดู git diff"], ["status", "สถานะ session"], ["review", "รีวิวงานที่แก้"], ["init", "สร้าง AGENTS.md"], ["mention", "อ้างถึงไฟล์"], ["undo", "ย้อนการแก้ล่าสุด"],
];

/** name/description from a SKILL.md or command .md front matter (handles quoted and folded values). */
export function frontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) { const first = text.split("\n").find(l => l.trim() && !l.startsWith("#")); if (first) out.description = first.trim(); return out; }
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]); if (!kv) continue;
    let v = kv[2].trim();
    if (v === ">" || v === "|" || v === ">-" || v === "|-") { const buf = []; while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) buf.push(lines[++i].trim()); v = buf.join(" "); }
    out[kv[1]] = v.replace(/^(['"])([\s\S]*)\1$/, "$2");
  }
  return out;
}
const tidyDesc = (d = "") => d.replace(/^\[[^\]]*\]\s*v[\w.\-]+\s*[\w-]*\s*\|\s*/, "").replace(/\s+/g, " ").trim().slice(0, 160);

function readSkills(dir: string, source: SlashCmd["source"], prefix = "", insert = (n: string) => "/" + n): SlashCmd[] {
  let ents: any[] = []; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: SlashCmd[] = [];
  for (const d of ents) {
    const f = join(dir, d.name, "SKILL.md");
    if (!existsSync(f)) continue;
    let fm: Record<string, string> = {}; try { fm = frontMatter(readFileSync(f, "utf-8").slice(0, 6000)); } catch { /* unreadable */ }
    if (fm["user-invocable"] === "false") continue;
    const name = prefix + (fm.name || d.name);
    out.push({ name, insert: insert(name), desc: tidyDesc(fm.description), source });
  }
  return out;
}
function readCommands(dir: string, source: SlashCmd["source"], prefix = "", sub = ""): SlashCmd[] {
  let ents: any[] = []; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: SlashCmd[] = [];
  for (const d of ents) {
    if (d.isDirectory()) { out.push(...readCommands(join(dir, d.name), source, prefix, sub + d.name + ":")); continue; }
    if (!d.name.endsWith(".md")) continue;
    let fm: Record<string, string> = {}; try { fm = frontMatter(readFileSync(join(dir, d.name), "utf-8").slice(0, 6000)); } catch { /* unreadable */ }
    const name = prefix + sub + d.name.replace(/\.md$/, "");
    out.push({ name, insert: "/" + name, desc: tidyDesc(fm.description), source });
  }
  return out;
}
function enabledPlugins(): { name: string; path: string }[] {
  try {
    const on = JSON.parse(readFileSync(join(homedir(), ".claude/settings.json"), "utf-8")).enabledPlugins ?? {};
    const inst = JSON.parse(readFileSync(join(homedir(), ".claude/plugins/installed_plugins.json"), "utf-8")).plugins ?? {};
    return Object.keys(on).filter(k => on[k] && inst[k]?.[0]?.installPath).map(k => ({ name: k.split("@")[0], path: inst[k][0].installPath }));
  } catch { return []; }
}

const cmdCache = new Map<string, { at: number; list: SlashCmd[] }>();
/** Everything the "/" picker can offer for one agent + working folder (deduped, cached 30 s). */
export function slashCommands(agent: string, cwd: string | null, home = homedir()): SlashCmd[] {
  const key = agent + "|" + (cwd ?? "");
  const c = cmdCache.get(key); if (c && Date.now() - c.at < 30_000) return c.list;
  let list: SlashCmd[] = [];
  if (agent === "codex") {
    list.push(...CODEX_BUILTIN.map(([n, d]) => ({ name: n, insert: "/" + n, desc: d, source: "builtin" as const })));
    list.push(...readCommands(join(home, ".codex/prompts"), "prompt", "prompts:"));
    list.push(...readSkills(join(home, ".codex/skills"), "skill", "", n => "$" + n));
  } else {
    list.push(...CLAUDE_BUILTIN.map(([n, d]) => ({ name: n, insert: "/" + n, desc: d, source: "builtin" as const })));
    if (cwd) { list.push(...readSkills(join(cwd, ".claude/skills"), "project")); list.push(...readCommands(join(cwd, ".claude/commands"), "project")); }
    list.push(...readSkills(join(home, ".claude/skills"), "user"));
    list.push(...readCommands(join(home, ".claude/commands"), "user"));
    for (const p of enabledPlugins()) { list.push(...readSkills(join(p.path, "skills"), "plugin", p.name + ":")); list.push(...readCommands(join(p.path, "commands"), "plugin", p.name + ":")); }
  }
  const seen = new Set<string>(); list = list.filter(x => !seen.has(x.insert) && seen.add(x.insert));
  cmdCache.set(key, { at: Date.now(), list });
  return list;
}

export function workspacePath(wsId: string): string | null {
  if (wsId === "tmux") return null;
  if (wsId.startsWith("dir:")) return dirFromId(wsId);
  if (Date.now() - wsPaths.at > 30_000) {
    const map = new Map<string, string>();
    try {
      const list = JSON.parse(ss(["workspaces", "list", "--local", "--json"]));
      for (const w of Array.isArray(list) ? list : list.workspaces ?? []) if (w.worktreePath && w.worktreeExists !== false) map.set(w.id, w.worktreePath);
    } catch { /* Superset not running */ }
    wsPaths = { at: Date.now(), map };
  }
  return wsPaths.map.get(wsId) ?? null;
}

/** Resolve a path inside the workspace; refuses anything that escapes it (../, symlinks out). */
export function insideWorkspace(root: string, rel: string): string | null {
  const rootReal = realpathSync(root);
  const full = resolve(rootReal, "." + "/" + String(rel ?? "").replace(/^\/+/, ""));
  let real: string;
  try { real = realpathSync(full); } catch { real = full; }
  return real === rootReal || real.startsWith(rootReal + "/") ? real : null;
}

const HIDE = new Set([".git", ".DS_Store"]);
export function listDir(root: string, rel: string) {
  const dir = insideWorkspace(root, rel);
  if (!dir) return null;
  const items = readdirSync(dir, { withFileTypes: true }).filter(d => !HIDE.has(d.name)).map(d => {
    const isDir = d.isDirectory() || (d.isSymbolicLink() && (() => { try { return statSync(join(dir, d.name)).isDirectory(); } catch { return false; } })());
    let size = 0; if (!isDir) { try { size = statSync(join(dir, d.name)).size; } catch { /* broken link */ } }
    return { name: d.name, dir: isDir, size };
  });
  items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: dir.slice(realpathSync(root).length).replace(/^\//, ""), items };
}

const git = (cwd: string, args: string[], max = 4_000_000, timeout = 10_000) =>
  execFileSync("git", ["-C", cwd, "-c", "core.quotepath=false", ...args], { encoding: "utf-8", timeout, maxBuffer: max, stdio: ["ignore", "pipe", "pipe"] });

/** Names in `dirAbs` that .gitignore hides (VS Code dims them). */
export function ignoredNames(dirAbs: string, names: string[]): Set<string> {
  if (!names.length) return new Set();
  try {
    const out = execFileSync("git", ["-C", dirAbs, "check-ignore", "--stdin", "-z"], { input: names.join("\0") + "\0", encoding: "utf-8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] });
    return new Set(out.split("\0").filter(Boolean));
  } catch { return new Set(); } // exit 1 = nothing ignored, or not a repo
}

/** Repo that contains `dir` (nested repos win), or null. */
export function repoRoot(dir: string): string | null {
  try { return realpathSync(git(dir, ["rev-parse", "--show-toplevel"]).trim()); } catch { return null; }
}

export interface GitEntry { path: string; x: string; y: string }
const statusCache = new Map<string, { at: number; entries: GitEntry[] }>();
/** `git status --porcelain` for a repo, cached for 3 s (the tree asks once per folder it shows). */
export function gitStatus(repo: string): GitEntry[] {
  const c = statusCache.get(repo);
  if (c && Date.now() - c.at < 3_000) return c.entries;
  const entries = git(repo, ["status", "--porcelain=v1", "-uall", "-z"]).split("\0").filter(Boolean).reduce((acc: GitEntry[], rec, i, arr) => {
    if ((arr as any)._skip === i) return acc;
    const x = rec[0], y = rec[1]; const path = rec.slice(3);
    if (x === "R" || x === "C") (arr as any)._skip = i + 1; // renamed: next record is the old path
    acc.push({ path, x, y }); return acc;
  }, []);
  statusCache.set(repo, { at: Date.now(), entries });
  return entries;
}

/** VS Code-style letter for a file: U untracked · A added · M modified · D deleted · R renamed · ! conflict. */
export function decoLetter(e: GitEntry): string {
  if (e.x === "?" ) return "U";
  if (e.x === "U" || e.y === "U" || (e.x === "A" && e.y === "A") || (e.x === "D" && e.y === "D")) return "!";
  if (e.x === "D" || e.y === "D") return "D";
  if (e.x === "R") return "R";
  if (e.x === "A") return "A";
  return "M";
}
const RANK: Record<string, number> = { "!": 5, D: 4, M: 3, R: 3, A: 2, U: 1 };

/** Status letters for the entries of one folder (folders get the strongest letter of their contents + a count). */
export function decorateDir(dirAbs: string): Map<string, { letter: string; count: number }> {
  const out = new Map<string, { letter: string; count: number }>();
  const repo = repoRoot(dirAbs);
  if (!repo) return out;
  const rel = dirAbs === repo ? "" : dirAbs.slice(repo.length + 1) + "/";
  for (const e of gitStatus(repo)) {
    if (!e.path.startsWith(rel)) continue;
    const rest = e.path.slice(rel.length);
    const name = rest.split("/")[0];
    const isDir = rest.includes("/");
    const l = decoLetter(e), prev = out.get(name);
    if (!prev) out.set(name, { letter: l, count: 1 });
    else { prev.count++; if (isDir && RANK[l] > RANK[prev.letter]) prev.letter = l; }
  }
  return out;
}

export const forgetGitStatus = (repo: string) => statusCache.delete(repo);

/** Summary for a nested repo folder: strongest letter + number of changed files, or null when clean. */
export function nestedDeco(repo: string): { letter: string; count: number } | null {
  let entries: GitEntry[] = []; try { entries = gitStatus(repo); } catch { return null; }
  if (!entries.length) return null;
  const letter = entries.map(decoLetter).reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  return { letter, count: entries.length };
}

/** Git repos inside a workspace (the workspace itself + nested ones up to 3 levels down). */
export function findRepos(root: string): string[] {
  const rootReal = realpathSync(root), repos: string[] = [];
  if (repoRoot(rootReal) === rootReal) repos.push("");
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let ents: any[] = []; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (!d.isDirectory() || d.name === ".git" || d.name === "node_modules" || d.name.startsWith(".")) continue;
      const sub = join(dir, d.name);
      if (existsSync(join(sub, ".git"))) repos.push(sub.slice(rootReal.length + 1));
      walk(sub, depth + 1);
    }
  };
  walk(rootReal, 1);
  return repos;
}

export function repoBranch(repo: string): string {
  try { return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(); } catch { return "?"; }
}

/** Commit graph rows: HEAD (+ its upstream) in topo order, with parents and ref names. */
export function gitGraph(repo: string, limit = 60) {
  let up = false; try { git(repo, ["rev-parse", "--verify", "-q", "@{upstream}"]); up = true; } catch { /* none */ }
  const remotes = git(repo, ["remote"]).split("\n").filter(Boolean);
  // VS Code style: one badge per branch; a branch that also exists on a remote gets the cloud mark
  const refsOf = (raw: string) => {
    const out: { name: string; kind: "head" | "branch" | "remote" | "tag"; synced?: boolean }[] = [];
    for (let r of raw ? raw.split(", ") : []) {
      if (r === "HEAD" || r.endsWith("/HEAD")) continue;
      if (r.startsWith("tag: ")) { out.push({ name: r.slice(5), kind: "tag" }); continue; }
      const head = r.startsWith("HEAD -> "); if (head) r = r.slice(8);
      const rem = remotes.find(x => r.startsWith(x + "/"));
      if (rem) {
        const local = out.find(o => (o.kind === "branch" || o.kind === "head") && o.name === r.slice(rem.length + 1));
        if (local) local.synced = true; else out.push({ name: r, kind: "remote" });
      } else {
        const remote = out.findIndex(o => o.kind === "remote" && o.name.replace(/^[^/]+\//, "") === r);
        if (remote >= 0) out.splice(remote, 1);
        out.push({ name: r, kind: head ? "head" : "branch", synced: remote >= 0 });
      }
    }
    return out;
  };
  return git(repo, ["log", "--topo-order", `-${limit}`, "--date=iso-strict", "--format=%h%x1f%p%x1f%s%x1f%an%x1f%ad%x1f%D", "HEAD", ...(up ? ["@{upstream}"] : [])])
    .split("\n").filter(Boolean).map(l => {
      const [sha, parents, subject, author, date, refs] = l.split("\x1f");
      return { sha, parents: parents ? parents.split(" ") : [], subject, author, date, refs: refsOf(refs) };
    });
}

/** Write actions from the phone's Source Control view. No force, no history rewrite. */
export function gitAction(root: string, repoRel: string, action: string, body: { paths?: string[]; message?: string; all?: boolean }) {
  const repo = insideWorkspace(root, repoRel);
  if (!repo || repoRoot(repo) !== repo) throw new Error("ไม่ใช่ git repo");
  const paths = (body.paths ?? []).map(String);
  for (const p of paths) if (p.startsWith("-") || !insideWorkspace(repo, p)) throw new Error("bad path: " + p);
  statusCache.delete(repo);
  switch (action) {
    case "stage": return git(repo, ["add", "-A", "--", ...(paths.length ? paths : ["."])]);
    case "unstage": return paths.length ? git(repo, ["restore", "--staged", "--", ...paths]) : git(repo, ["reset", "-q"]);
    case "discard": {
      // tracked files only — untracked files are never deleted from the phone
      if (!paths.length) throw new Error("ต้องระบุไฟล์");
      const tracked = paths.filter(p => { try { git(repo, ["ls-files", "--error-unmatch", "--", p]); return true; } catch { return false; } });
      if (tracked.length !== paths.length) throw new Error("ไฟล์ใหม่ (U) ทิ้งจากมือถือไม่ได้ — ลบเองที่เครื่อง");
      return git(repo, ["restore", "--worktree", "--", ...paths]);
    }
    case "commit": {
      const msg = String(body.message ?? "").trim();
      if (!msg) throw new Error("ใส่ข้อความ commit ก่อน");
      if (body.all) git(repo, ["add", "-A"]);
      return git(repo, ["commit", "-m", msg]);
    }
    case "pull": return git(repo, ["pull", "--ff-only"], 4_000_000, 60_000);
    case "push": return git(repo, ["push"], 4_000_000, 60_000);
    case "fetch": return git(repo, ["fetch", "--prune"], 4_000_000, 60_000);
    default: throw new Error("unknown action");
  }
}

export function gitInfo(root: string, repoRel = "") {
  const repo = insideWorkspace(root, repoRel);
  if (!repo) throw new Error("bad path");
  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  let ahead = 0, behind = 0;
  try { [behind, ahead] = git(repo, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]).trim().split(/\s+/).map(Number); } catch { /* no upstream */ }
  const all = gitStatus(repo);
  const staged = all.filter(e => e.x !== " " && e.x !== "?").map(e => ({ path: e.path, letter: e.x === "R" ? "R" : e.x === "D" ? "D" : e.x === "A" ? "A" : "M" }));
  const changes = all.filter(e => e.y !== " " || e.x === "?").map(e => ({ path: e.path, letter: e.x === "?" ? "U" : e.y === "D" ? "D" : "M" }));
  const log = git(repo, ["log", "-30", "--date=iso-strict", "--pretty=format:%h%x1f%s%x1f%an%x1f%ad"]).split("\n").filter(Boolean)
    .map(l => { const [sha, subject, author, date] = l.split("\x1f"); return { sha, subject, author, date }; });
  return { repo: repoRel, branch, ahead, behind, staged, changes, log, graph: gitGraph(repo), repos: findRepos(root).map(p => ({ path: p, branch: repoBranch(insideWorkspace(root, p)!) })) };
}

export function gitFileDiff(root: string, repoRel: string, rel: string, staged = false): string {
  const repo = insideWorkspace(root, repoRel);
  const full = repo && insideWorkspace(repo, rel);
  if (!repo || !full) throw new Error("bad path");
  const tracked = (() => { try { git(repo, ["ls-files", "--error-unmatch", "--", rel]); return true; } catch { return false; } })();
  if (!tracked) {
    const body = existsSync(full) ? readFileSync(full, "utf-8").slice(0, 200_000) : "";
    const lines = body.replace(/\n$/, "").split("\n");
    return `new file\n@@ -0,0 +1,${lines.length} @@\n` + lines.map(l => "+" + l).join("\n");
  }
  return git(repo, ["diff", ...(staged ? ["--cached"] : []), "--", rel]).slice(0, 400_000) || "(ไม่มีความต่าง)";
}

// ── Routes ───────────────────────────────────────────────────────

const MAX_DIFF = 200_000;

/** Keys the phone may send (label → tmux key name). */
export const QUICK_KEYS: Record<string, string> = {
  enter: "Enter", esc: "Escape", up: "Up", down: "Down", tab: "Tab", ctrlc: "C-c",
  btab: "BTab", left: "Left", right: "Right", ctrlu: "C-u", space: "Space",
  "1": "1", "2": "2", "3": "3", "4": "4", y: "y", n: "n",
};
/** Same labels in Superset CLI key names. */
export const SUPERSET_KEYS: Record<string, string> = {
  enter: "enter", esc: "esc", up: "up", down: "down", tab: "tab", ctrlc: "ctrl+c",
  btab: "shift+tab", left: "left", right: "right", ctrlu: "ctrl+u", space: "space",
  "1": "1", "2": "2", "3": "3", "4": "4", y: "y", n: "n",
};

export function createMobileApi(cfg: MobileConfig = loadMobileConfig()) {
  const app = new Elysia({ prefix: "/mobile" })
    // Local hook receiver — guarded by its own token, never by Tailscale identity.
    .post("/hook", ({ body, headers, set }) => {
      if (!sameSecret(headers["x-mobile-hook-token"], cfg.hookToken)) { set.status = 401; return { ok: false }; }
      const b = body as Record<string, any>;
      const status = statusFromHook(String(b.hook_event_name ?? ""));
      if (!b.session_id || !status) return { ok: true, ignored: true };
      hookStates.set(String(b.session_id), { status, event: b.hook_event_name, message: clip(b.message, 200) ?? undefined, at: Date.now() });
      const room = readLiveRooms().get(String(b.session_id))?.name || String(b.cwd ?? "").split("/").filter(Boolean).pop() || "Claude";
      const ev = String(b.hook_event_name);
      // StopFailure: the error kind only ("rate_limit", "overloaded"…), never conversation text
      const why = ev === "StopFailure" ? clip(String(b.error_type ?? (typeof b.error === "string" ? b.error : b.error?.type ?? b.error?.message) ?? b.reason ?? "").replace(/\s+/g, " "), 80) ?? undefined : b.message;
      const msg = pushFor(ev, room, why);
      if (msg) notifyPhones(String(b.session_id), ev === "StopFailure" ? "error" : status, msg).catch(() => {});
      return { ok: true };
    })
    .onBeforeHandle(({ request, path, set }) => {
      if (path.endsWith("/hook")) return;
      if (!isAuthorized(request.headers, cfg)) { set.status = 401; return { ok: false, error: "unauthorized" }; }
    })
    .get("/health", () => ({ ok: true, hooks: hookStates.size }))
    .get("/agents", async () => ({ agents: await listAgents() }))
    .get("/agents/:id/screen", async ({ params, query, set }) => {
      const x = await findRoom(params.id);
      if (!x) { set.status = 404; return { ok: false, error: "not found" }; }
      const ch = x.room?.channel;
      if (!ch || x.agent.status === "ended") return { ok: true, live: false, content: x.agent.lastAssistant ?? "" };
      try { return { ok: true, live: true, content: await readScreen(ch, Math.min(+(query.lines || 120), 400)) }; }
      catch { return { ok: true, live: false, content: x.agent.lastAssistant ?? "" }; }
    }, { query: t.Object({ lines: t.Optional(t.String()) }) })
    .post("/agents/:id/reply", async ({ params, body, set }) => {
      const x = await findRoom(params.id);
      if (!x) { set.status = 404; return { ok: false, error: "not found" }; }
      const ch = x.room?.channel;
      if (!ch || !x.agent.canReply) { set.status = 409; return { ok: false, error: "this room cannot be typed into" }; }
      await typeInto(ch, body.text);
      return { ok: true, via: ch.kind };
    }, { body: t.Object({ text: t.String({ minLength: 1, maxLength: 8000 }) }) })
    // Quick keys for permission prompts / menus — whitelist only, never raw tmux key names from the client.
    .post("/agents/:id/keys", async ({ params, body, set }) => {
      if (!QUICK_KEYS[body.key]) { set.status = 400; return { ok: false, error: "unknown key" }; }
      const x = await findRoom(params.id);
      if (!x) { set.status = 404; return { ok: false, error: "not found" }; }
      const ch = x.room?.channel;
      if (!ch || !x.agent.canReply) { set.status = 409; return { ok: false, error: "this room cannot be typed into" }; }
      await pressKey(ch, body.key);
      return { ok: true };
    }, { body: t.Object({ key: t.String() }) })
    // ── projects / rooms ──
    .get("/projects", () => ({ projects: buildProjects(supersetSnapshot(), readLiveRooms(), { folders: loadFolders(), panes: listTmuxPanes() }) }))
    .get("/local/repos", () => {
      const pinned = new Set(loadFolders().map(f => f.path));
      return { ok: true, repos: scanRepos().slice(0, 200).map(r => ({ ...r, pinned: pinned.has(r.path) })) };
    })
    .get("/local/dirs", ({ query, set }) => {
      const dir = allowedDir(String(query.path || homedir()));
      if (!dir) { set.status = 400; return { ok: false, error: "เปิดโฟลเดอร์นี้ไม่ได้" }; }
      const pinned = new Set(loadFolders().map(f => f.path));
      let ents: any[] = []; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { /* */ }
      const dirs = ents.filter(d => d.isDirectory() && !d.name.startsWith(".") && !(dir === realpathSync(homedir()) && d.name === "Library"))
        .map(d => { const p = join(dir, d.name); return { name: d.name, path: p, git: existsSync(join(p, ".git")), pinned: pinned.has(p) }; })
        .sort((a, b) => a.name.localeCompare(b.name));
      return { ok: true, path: dir, home: realpathSync(homedir()), parent: dir === realpathSync(homedir()) ? null : join(dir, ".."), git: existsSync(join(dir, ".git")), pinned: pinned.has(dir), dirs };
    }, { query: t.Object({ path: t.Optional(t.String()) }) })
    .post("/local/folders", ({ body, set }) => {
      const path = allowedDir(String((body as any).path ?? ""));
      if (!path) { set.status = 400; return { ok: false, error: "เปิดโฟลเดอร์นี้ไม่ได้" }; }
      const list = loadFolders().filter(f => f.path !== path);
      if ((body as any).pin !== false) list.unshift({ name: String((body as any).name || path.split("/").pop()).slice(0, 60), path });
      saveFolders(list);
      return { ok: true, id: dirId(path), folders: list };
    })
    // new empty folder inside a folder the phone may browse
    .post("/local/mkdir", ({ body, set }) => {
      const parent = allowedDir(String((body as any).parent ?? "")), name = safeFolderName((body as any).name);
      if (!parent || !name) { set.status = 400; return { ok: false, error: "ชื่อหรือที่อยู่ไม่ถูกต้อง" }; }
      const path = join(parent, name);
      if (existsSync(path)) { set.status = 409; return { ok: false, error: "มีชื่อนี้อยู่แล้ว" }; }
      try { mkdirSync(path); } catch (e: any) { set.status = 500; return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
      return { ok: true, path };
    })
    // git clone <https|ssh url> into a folder the phone may browse (no prompts: private repos need the Mac's saved credentials)
    .post("/local/clone", async ({ body, set }) => {
      const parent = allowedDir(String((body as any).parent ?? "")), url = cloneUrlOk((body as any).url);
      if (!parent || !url) { set.status = 400; return { ok: false, error: "ใช้ได้เฉพาะลิงก์ https:// หรือ git@… ของ repo" }; }
      const name = safeFolderName((body as any).name || repoNameFromUrl(url));
      if (!name) { set.status = 400; return { ok: false, error: "ชื่อโฟลเดอร์ไม่ถูกต้อง" }; }
      const path = join(parent, name);
      if (existsSync(path)) { set.status = 409; return { ok: false, error: `มีโฟลเดอร์ ${name} อยู่แล้ว` }; }
      const proc = Bun.spawn(["git", "clone", "--", url, path], { cwd: parent, stdout: "ignore", stderr: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } });
      const timer = setTimeout(() => proc.kill(), 300_000);
      const code = await proc.exited; clearTimeout(timer);
      if (code !== 0) {
        const err = (await new Response(proc.stderr).text()).trim().split("\n").filter(l => /fatal|error/i.test(l)).pop() || `git clone ล้มเหลว (${code})`;
        set.status = 502; return { ok: false, error: err.slice(0, 200) };
      }
      reposCache.at = 0;
      return { ok: true, path, name };
    })
    .post("/local/superset-import", ({ body, set }) => {
      const path = allowedDir(String((body as any).path ?? ""));
      if (!path || !existsSync(join(path, ".git"))) { set.status = 400; return { ok: false, error: "ต้องเป็น git repo ใน home" }; }
      const name = String((body as any).name || path.split("/").pop()).replace(/[^\w.\- ]/g, "").slice(0, 60) || "project";
      try { const out = ss(["projects", "create", "--local", "--import", path, "--name", name, "--json"]); snapCache.at = 0; return { ok: true, result: JSON.parse(out) }; }
      catch (e: any) { set.status = 502; return { ok: false, error: String(e?.stderr || e?.message || e).slice(0, 300) }; }
    })
    .get("/rooms/:ws/:room/commands", async ({ params, query }) => {
      // working folder: Superset workspace path, or the tmux pane's current folder
      let cwd: string | null = null;
      if (params.ws === "tmux") { try { cwd = execFileSync("tmux", ["display", "-p", "-t", params.room, "#{pane_current_path}"], { encoding: "utf-8", timeout: 3_000 }).trim() || null; } catch { /* gone */ } }
      else cwd = workspacePath(params.ws);
      return { ok: true, cwd, commands: slashCommands(String(query.agent ?? "claude"), cwd) };
    }, { query: t.Object({ agent: t.Optional(t.String()) }) })
    .get("/agent-presets", () => {
      try {
        const d = JSON.parse(ss(["agents", "list", "--local", "--json"]));
        const list = Array.isArray(d) ? d : d.agents ?? [];
        return { presets: list.map((a: any) => ({ id: a.presetId ?? a.id, label: a.label ?? a.presetId })) };
      } catch { return { presets: [] }; }
    })
    // ── explorer ──
    .get("/workspaces/:ws/tree", ({ params, query, set }) => {
      const root = workspacePath(params.ws);
      if (!root) { set.status = 404; return { ok: false, error: "ไม่พบโฟลเดอร์ของ workspace นี้" }; }
      const r = listDir(root, String(query.path ?? ""));
      if (!r) { set.status = 400; return { ok: false, error: "bad path" }; }
      const abs = join(realpathSync(root), r.path);
      const deco = decorateDir(abs), ign = ignoredNames(abs, r.items.map(it => it.name));
      return { ok: true, root, ...r, items: r.items.map(it => {
        // a folder that is its own repo: show ITS changes + branch, not the parent's "untracked" (matches what you see inside)
        const nested = it.dir && existsSync(join(abs, it.name, ".git")) ? join(abs, it.name) : null;
        if (nested) return { ...it, git: nestedDeco(nested), repo: repoBranch(nested), ignored: ign.has(it.name) };
        return { ...it, git: deco.get(it.name) ?? null, ignored: ign.has(it.name) };
      }) };
    }, { query: t.Object({ path: t.Optional(t.String()) }) })
    .get("/workspaces/:ws/file", ({ params, query, set }) => {
      const root = workspacePath(params.ws);
      const f = root && insideWorkspace(root, String(query.path ?? ""));
      if (!f || !existsSync(f) || statSync(f).isDirectory()) { set.status = 404; return { ok: false, error: "not found" }; }
      const ext = f.split(".").pop()!.toLowerCase();
      if (query.raw === "1") return new Response(Bun.file(f), { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
      const size = statSync(f).size;
      if (/^(png|jpe?g|gif|webp|svg|heic)$/.test(ext)) return { ok: true, kind: "image", size };
      const head = readFileSync(f).subarray(0, Math.min(size, 512 * 1024));
      if (head.includes(0)) return { ok: true, kind: "binary", size };
      return { ok: true, kind: "text", size, truncated: size > head.length, text: head.toString("utf-8") };
    }, { query: t.Object({ path: t.Optional(t.String()), raw: t.Optional(t.String()) }) })
    .get("/workspaces/:ws/git", ({ params, query, set }) => {
      const root = workspacePath(params.ws);
      if (!root) { set.status = 404; return { ok: false, error: "ไม่พบโฟลเดอร์ของ workspace นี้" }; }
      try { return { ok: true, root, ...gitInfo(root, String(query.repo ?? "")) }; } catch { return { ok: false, error: "โฟลเดอร์นี้ไม่ใช่ git repo" }; }
    }, { query: t.Object({ repo: t.Optional(t.String()) }) })
    .get("/workspaces/:ws/git/diff", ({ params, query, set }) => {
      const root = workspacePath(params.ws);
      if (!root) { set.status = 404; return { ok: false, error: "not found" }; }
      try { return { ok: true, diff: gitFileDiff(root, String(query.repo ?? ""), String(query.path ?? ""), query.staged === "1") }; }
      catch (e: any) { set.status = 400; return { ok: false, error: String(e.message) }; }
    }, { query: t.Object({ path: t.Optional(t.String()), repo: t.Optional(t.String()), staged: t.Optional(t.String()) }) })
    .post("/workspaces/:ws/git/:action", ({ params, body, set }) => {
      const root = workspacePath(params.ws);
      if (!root) { set.status = 404; return { ok: false, error: "ไม่พบโฟลเดอร์ของ workspace นี้" }; }
      try { return { ok: true, output: gitAction(root, String(body.repo ?? ""), params.action, body).slice(0, 20_000) }; }
      catch (e: any) { set.status = 400; return { ok: false, error: String(e.stderr || e.stdout || e.message).trim().slice(0, 4000) }; }
    }, { body: t.Object({ repo: t.Optional(t.String()), paths: t.Optional(t.Array(t.String())), message: t.Optional(t.String()), all: t.Optional(t.Boolean()) }) })
    .get("/workspaces/:ws/git/commit/:sha", ({ params, query, set }) => {
      const root0 = workspacePath(params.ws);
      const root = root0 && insideWorkspace(root0, String(query.repo ?? ""));
      if (!root || !/^[0-9a-f]{4,40}$/i.test(params.sha)) { set.status = 400; return { ok: false, error: "bad request" }; }
      try { return { ok: true, show: git(root, ["show", "--stat", "--patch", "--format=%H%n%an · %ad%n%n%B", "--date=iso", params.sha]).slice(0, 400_000) }; }
      catch { set.status = 404; return { ok: false, error: "ไม่พบ commit" }; }
    }, { query: t.Object({ repo: t.Optional(t.String()) }) })
    .post("/upload", async ({ request, query, set }) => {
      const buf = new Uint8Array(await request.arrayBuffer());
      if (!buf.length) { set.status = 400; return { ok: false, error: "empty file" }; }
      if (buf.length > UPLOAD_MAX) { set.status = 413; return { ok: false, error: "ไฟล์ใหญ่เกิน 25 MB" }; }
      const path = saveUpload(String(query.name ?? "file"), buf);
      return { ok: true, path, url: "/mobile/uploads/" + path.slice(UPLOAD_DIR.length + 1) };
    }, { parse: "none" })
    .get("/img/:file", ({ params, set }) => {
      if (!/^[0-9a-f]{20}\.(png|jpg|gif|webp)$/.test(params.file)) { set.status = 400; return "bad path"; }
      const f = join(UPLOAD_DIR, "img", params.file);
      if (!existsSync(f)) { set.status = 404; return "not found"; }
      set.headers["cache-control"] = "private, max-age=31536000, immutable";
      return Bun.file(f);
    })
    .get("/uploads/:day/:file", ({ params, set }) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(params.day) || params.file !== safeName(params.file)) { set.status = 400; return "bad path"; }
      const f = join(UPLOAD_DIR, params.day, params.file);
      if (!existsSync(f)) { set.status = 404; return "not found"; }
      const ext = params.file.split(".").pop()!.toLowerCase();
      return new Response(Bun.file(f), { headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "private, max-age=86400" } });
    })
    .get("/rooms/:ws/:room/chat", async ({ params, query, set }) => {
      const ch = roomChannel(params.ws, params.room);
      if (!ch) { set.status = 400; return { ok: false, error: "bad room" }; }
      const live = [...readLiveRooms().values()].find(r => r.channel && (
        (r.channel.kind === "tmux" && ch.kind === "tmux" && r.channel.pane === ch.pane) ||
        (r.channel.kind === "superset" && ch.kind === "superset" && r.channel.terminalId === ch.terminalId)));
      const codex = !live && ch.kind === "superset" ? codexFileFor(ch.terminalId) : null;
      const items = live ? claudeTranscript(live.sessionId) : codex ? codexTranscript(codex) : null;
      if (items) {
        // Page from the end: newest `limit` messages, or the ones before `before`.
        const limit = Math.min(+(query.limit || 150), 500);
        const end = query.before ? Math.max(0, Math.min(+query.before, items.length)) : items.length;
        const start = Math.max(0, end - limit);
        // epoch changes when maw restarts (numbering may differ after a re-parse) → the phone drops its cached items
        let page = items.slice(start, end);
        // Esc on the Mac before Claude answered pulls the message back into the input box and writes nothing more:
        // a trailing user turn while the session is idle never reached Claude
        const last = items.at(-1);
        if (live?.status === "idle" && end === items.length && last?.role === "user" && !last.queued && last.ts && Date.now() - Date.parse(last.ts) > 8000)
          page = page.map(x => (x === last ? { ...x, canceled: true } : x));
        return { ok: true, kind: "messages", epoch: BOOT_ID, total: items.length, start, items: page };
      }
      if (ch.kind === "superset") {
        try {
          const out = JSON.parse(ss(["agents", "read", "--local", "--workspace", ch.workspaceId, "--terminal", ch.terminalId, "--json"]));
          if (out.text?.trim()) return { ok: true, kind: "text", text: String(out.text) };
        } catch { /* not an agent terminal */ }
      }
      return { ok: true, kind: "none" };
    }, { query: t.Object({ before: t.Optional(t.String()), limit: t.Optional(t.String()) }) })
    .get("/rooms/:ws/:room/screen", async ({ params, query, set }) => {
      const ch = roomChannel(params.ws, params.room);
      if (!ch) { set.status = 400; return { ok: false, error: "bad room" }; }
      try { return { ok: true, content: await readScreen(ch, Math.min(+(query.lines || 150), 1500)) }; }
      catch { set.status = 502; return { ok: false, error: "cannot read this room" }; }
    }, { query: t.Object({ lines: t.Optional(t.String()) }) })
    .get("/rooms/:ws/:room/suggestion", async ({ params, query, set }) => {
      const ch = roomChannel(params.ws, params.room);
      if (!ch) { set.status = 400; return { ok: false, error: "bad room" }; }
      const usage = query.agent === "codex" ? (f => f ? codexUsage(f) : null)(codexFileFor(params.room)) : query.sid ? claudeUsage(String(query.sid)) : null;
      try {
        const scr = await readScreen(ch, 60), spinner = agentSpinner(scr);
        const el = spinner && /^compact/i.test(spinner.verb) ? elapsedSeconds(spinner.detail) : null;
        const compact = el != null ? compactProgress(el, usage?.context?.used ?? null) : null;
        return { ok: true, suggestion: promptSuggestion(scr), draft: inputDraft(scr), spinner, compact, queued: queuedMessages(scr), usage };
      }
      catch { return { ok: true, suggestion: null, spinner: null, queued: [], usage }; }
    }, { query: t.Object({ agent: t.Optional(t.String()), sid: t.Optional(t.String()) }) })
    // phone UI version = newest mtime of the deployed page + feature packs (the page reloads itself when it changes)
    .get("/version", () => {
      const dir = process.env.MAW_UI_DIR ?? join(homedir(), ".maw", "ui", "dist");
      const files = ["m.html", "sw.js", ...(() => { try { return readdirSync(join(dir, "m-ext")).map(f => join("m-ext", f)); } catch { return []; } })()];
      let v = 0; for (const f of files) { try { v = Math.max(v, statSync(join(dir, f)).mtimeMs); } catch { /* missing */ } }
      return { ok: true, v: Math.round(v) };
    })
    .get("/push/key", () => ({ ok: true, key: loadPush().vapid.publicKey }))
    .post("/push/subscribe", ({ body }) => {
      const sub = (body as any).subscription;
      if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint)) return { ok: false, error: "bad subscription" };
      const d = loadPush(); d.subs = [...d.subs.filter(x => x.endpoint !== sub.endpoint), sub]; savePush(d);
      return { ok: true, count: d.subs.length };
    })
    .post("/push/unsubscribe", ({ body }) => { const d = loadPush(); d.subs = d.subs.filter(x => x.endpoint !== (body as any).endpoint); savePush(d); return { ok: true }; })
    .post("/push/test", async () => { lastPush.delete("test" + "test"); return { ok: true, sent: await notifyPhones("test", "test", { title: "🔔 maw แจ้งเตือนได้แล้ว", body: "จะเด้งเมื่อ agent รอคำตอบ หรือทำงานเสร็จ" }) }; })
    .get("/system", async () => ({ ok: true, mac: await macHealth(), limits: { claude: claudeLimits(), codex: codexLimits() } }))
    .post("/rooms/:ws/:room/send", async ({ params, body, set }) => {
      const ch = roomChannel(params.ws, params.room);
      if (!ch) { set.status = 400; return { ok: false, error: "bad room" }; }
      if (body.key) {
        if (!QUICK_KEYS[body.key]) { set.status = 400; return { ok: false, error: "unknown key" }; }
        await pressKey(ch, body.key);
      } else if (body.text) {
        await typeInto(ch, body.text);
      } else { set.status = 400; return { ok: false, error: "text or key required" }; }
      snapCache.at = 0;
      return { ok: true };
    }, { body: t.Object({ text: t.Optional(t.String({ maxLength: 8000 })), key: t.Optional(t.String()) }) })
    // Open a new room in a Superset workspace: an agent with a first prompt, or a plain shell.
    .post("/workspaces/:ws/rooms", async ({ params, body, set }) => {
      if (params.ws.startsWith("dir:")) {
        const dir = dirFromId(params.ws);
        if (!dir) { set.status = 400; return { ok: false, error: "เปิดโฟลเดอร์นี้ไม่ได้" }; }
        try { return { ok: true, result: await openTmuxRoom(dir, body.agent, body.prompt) }; }
        catch (e: any) { set.status = 502; return { ok: false, error: String(e?.message || e).slice(0, 300) }; }
      }
      if (!/^[0-9a-f-]{36}$/i.test(params.ws)) { set.status = 400; return { ok: false, error: "bad workspace" }; }
      try {
        const out = body.agent === "shell"
          ? ss(["terminals", "create", "--local", "--workspace", params.ws, "--json"])
          : ss(["agents", "create", "--local", "--workspace", params.ws, "--agent", body.agent, "--prompt", body.prompt || "", "--json"]);
        snapCache.at = 0;
        return { ok: true, result: JSON.parse(out) };
      } catch (e: any) { set.status = 502; return { ok: false, error: String(e?.stderr || e?.message || e).slice(0, 300) }; }
    }, { body: t.Object({ agent: t.String({ pattern: "^[a-z0-9-]{1,40}$" }), prompt: t.Optional(t.String({ maxLength: 8000 })) }) })
    .get("/agents/:id/diff", async ({ params, set }) => {
      const a = (await findRoom(params.id))?.agent;
      if (!a) { set.status = 404; return { ok: false, error: "not found" }; }
      try {
        const git = (...args: string[]) => execFileSync("git", ["-C", a.projectPath, ...args], { encoding: "utf-8", timeout: 5000, maxBuffer: 8 * MAX_DIFF });
        const stat = git("diff", "--stat", "HEAD");
        const diff = git("diff", "HEAD");
        return { ok: true, stat, diff: diff.slice(0, MAX_DIFF), truncated: diff.length > MAX_DIFF };
      } catch (e: any) {
        return { ok: false, error: "not a git repo or git failed" };
      }
    });
  // feature packs (src/mobile/features/*) add their routes after the auth guard above
  mountFeatures(app);
  setTimeout(() => compactMsPerToken(), 30_000).unref?.(); // warm the /compact estimate in the background
  return app;
}
