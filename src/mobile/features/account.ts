// Feature "account" (28 พ.ย. 69) — สลับห้อง agent ระหว่าง Mind (เกตเวย์ · โควตา Mind) กับบัญชีหลักของเครื่อง (claude-direct / codex-direct)
// แชทเดิมคุยต่อ: ปิด agent ในห้อง (/exit) → shell เดิมของห้อง → เปิดใหม่อีกทางด้วย --resume <session id> (Claude) / resume <id> (Codex)
// ประวัติแชทอยู่ที่เดียวกันทั้งสองทาง (~/.claude · ~/.codex) · ห้อง tmux ของ maw มี exec $SHELL ท้ายคำสั่ง · ห้อง Superset เป็น zsh -l
//   GET  /accounts/rooms                     → { rooms: [{ ws, room, agent, route, status, sessionId }] }   (Herdr ไม่รองรับ)
//   POST /rooms/:ws/:room/account { to }     → สลับห้องเดียว (ห้องต้องว่าง · ไม่ตัดงานกลางคัน)
//   POST /accounts/switch-all { to }         → สลับทุกห้องที่ว่างตอนนี้ · ห้องที่กำลังทำงานเข้าคิว สลับเองเมื่อว่าง
//   GET  /accounts/usage?rooms=[[ws,room]]   → { rooms: [{ ws, room, agent, route, outToday }] } โทเคนขาออกวันนี้รายห้อง (ที่ Mind นับ) จาก transcript ในเครื่อง
//   GET/POST /accounts/auto { on, at }       → สลับห้องที่ใช้ Mind ไปบัญชีหลักเองเมื่อโควตา Mind ถึง at% (วันละครั้ง · ~/.maw/account-auto.json)
import { execFileSync } from "child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readLiveRooms, roomChannel, typeInto, readScreen, codexFileFor, agentSpinner } from "./ctx";
import { getMe } from "./mind";

export type Route = "mind" | "direct";
type Agent = "claude" | "codex";
export interface AgentProc { pid: number; agent: Agent; args: string[]; route: Route; sessionId: string | null }

const ENTRY = join(homedir(), ".artron", "entry", "bin");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Full env of a process (own user only) as key → value; values stay inside this module. */
function envAll(pid: number): Record<string, string> {
  try {
    const out = execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 });
    const env: Record<string, string> = {};
    for (const m of out.matchAll(/(?:^|\s)([A-Z_][A-Z0-9_]*)=(\S*)/g)) env[m[1]] = m[2];
    return env;
  } catch { return {}; }
}
function argsOf(pid: number): string[] {
  try { return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).trim().split(/\s+/); } catch { return []; }
}
const pids = (name: string) => { try { return execFileSync("pgrep", ["-x", name], { encoding: "utf8", timeout: 3000 }).trim().split("\n").filter(Boolean).map(Number); } catch { return []; } };

/** Mind or direct, from what mind-entry put on the process: Claude → ANTHROPIC_BASE_URL at the Mind gateway · Codex → model_provider "artron" (ARTRON_TOKEN). */
export function routeOf(agent: Agent, env: Record<string, string>, args: string[]): Route {
  if (agent === "claude") return /mind\.|artron/i.test(env.ANTHROPIC_BASE_URL || "") ? "mind" : "direct";
  return env.ARTRON_TOKEN !== undefined || args.some(a => /model_provider=?"?artron/.test(a)) ? "mind" : "direct";
}

/** The Claude/Codex process of a (tmux | Superset) room, by the pane/terminal id it inherited. */
export function agentOfRoom(ws: string, room: string): AgentProc | null {
  const ch = roomChannel(ws, room); if (!ch || ch.kind === "herdr") return null;
  const key = ch.kind === "tmux" ? ["TMUX_PANE", ch.pane] : ["SUPERSET_TERMINAL_ID", (ch as any).terminalId];
  for (const agent of ["claude", "codex"] as Agent[]) for (const pid of pids(agent)) {
    const env = envAll(pid); if (env[key[0]] !== key[1]) continue;
    const args = argsOf(pid);
    let sessionId: string | null = null;
    if (agent === "claude") sessionId = [...readLiveRooms().values()].find(r => r.pid === pid)?.sessionId ?? null;
    else { const f = ch.kind === "superset" ? codexFileFor(key[1]) : null; sessionId = f ? rolloutId(f) : null; }
    return { pid, agent, args, route: routeOf(agent, env, args), sessionId };
  }
  return null;
}
function rolloutId(file: string): string | null {
  try { const m = JSON.parse(readFileSync(file, "utf8").split("\n")[0]); return m?.payload?.id ?? null; } catch { return null; }
}

// flags worth keeping across a switch (mode / model) — everything else (resume ids, prompts, mind-entry's -c provider flags) is rebuilt
const KEEP_BOOL = new Set(["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--search"]);
const KEEP_VAL = new Set(["--model", "-m", "--permission-mode", "--sandbox", "-s", "--ask-for-approval", "-a", "--add-dir"]);
export function keptFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (KEEP_BOOL.has(a)) out.push(a);
    else if (KEEP_VAL.has(a) && args[i + 1] && !args[i + 1].startsWith("-")) out.push(a, args[++i]);
    else if (/^--(model|permission-mode|sandbox)=/.test(a)) out.push(a);
  }
  return out;
}
const q = (s: string) => /^[\w./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
export function relaunchCommand(p: AgentProc, to: Route): string {
  const bin = join(ENTRY, `${p.agent}${to === "direct" ? "-direct" : ""}`);
  const flags = keptFlags(p.args).map(q).join(" ");
  const resume = p.agent === "claude" ? `--resume ${q(p.sessionId!)}` : `resume ${q(p.sessionId!)}`;
  return p.agent === "claude" ? `${q(bin)} ${flags} ${resume}`.replace(/\s+/g, " ").trim() : `${q(bin)} ${resume} ${flags}`.replace(/\s+/g, " ").trim();
}

async function busy(ws: string, room: string, p: AgentProc): Promise<boolean> {
  if (p.agent === "claude") { const st = [...readLiveRooms().values()].find(r => r.pid === p.pid)?.status; return st === "working"; }
  const ch = roomChannel(ws, room)!; return !!agentSpinner(await readScreen(ch, 40).catch(() => ""));
}

/** Switch one room. Refuses when busy, already there, or the session id is unknown. Never kills: /exit then waits. */
/** `restart` relaunches on the same route (picks up new settings/env) — same safety rules. */
export async function switchRoom(ws: string, room: string, to: Route, restart = false): Promise<{ ok: boolean; error?: string; route?: Route; queued?: boolean }> {
  const p = agentOfRoom(ws, room);
  if (!p) return { ok: false, error: "ไม่พบ Claude/Codex ในห้องนี้" };
  if (p.route === to && !restart) return { ok: true, route: to };
  if (!p.sessionId) return { ok: false, error: "หา session id ของแชทนี้ไม่เจอ — สลับแล้วจะต่อแชทเดิมไม่ได้ จึงไม่สลับ" };
  if (!existsSync(join(ENTRY, `${p.agent}${to === "direct" ? "-direct" : ""}`))) return { ok: false, error: "ไม่พบตัวเปิด mind-entry (~/.artron/entry/bin)" };
  if (await busy(ws, room, p)) return { ok: false, queued: true, error: "ห้องกำลังทำงาน — จะสลับให้เมื่อว่าง" };
  const ch = roomChannel(ws, room)!, cmd = relaunchCommand(p, to);
  await typeInto(ch, "/exit");
  for (let k = 0; k < 40 && alive(p.pid); k++) await sleep(250);
  if (alive(p.pid)) return { ok: false, error: "agent ยังไม่ปิด (/exit ไม่ได้ผล) — ไม่สลับ · ห้องยังเป็นแบบเดิม" };
  await sleep(600);
  await typeInto(ch, cmd);
  for (let k = 0; k < 60; k++) { await sleep(500); const n = agentOfRoom(ws, room); if (n && n.pid !== p.pid) return n.route === to ? { ok: true, route: to } : { ok: false, error: "เปิดใหม่แล้วแต่ยังเป็นทางเดิม" }; }
  return { ok: false, error: "สั่งเปิดใหม่แล้วแต่ยังไม่เห็น agent ในห้อง — เปิดหน้าจอห้องดู" };
}

// ── output tokens today per room (what the Mind quota counts) ──────────────────────────────────────────────────
// Claude: assistant lines' message.usage.output_tokens (thinking included), deduped by message.id (one reply is written
// over several lines) · Codex: token_count events' last_token_usage.output_tokens. Files are read on from the last
// offset, so a 100 MB transcript is parsed once and then only its new tail.
interface Tally { day: string; offset: number; ids: Map<string, number>; out: number }
const tallies = new Map<string, Tally>();
const dayKey = (now = new Date()) => `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
const midnight = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

/** Count today's output tokens from transcript lines (pure — exported for tests). */
export function countLines(lines: string[], t: Pick<Tally, "ids" | "out">, since: number): void {
  for (const l of lines) {
    if (!l.includes("output_tokens")) continue;
    let d: any; try { d = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(d.timestamp ?? ""); if (!(ts >= since)) continue;
    if (d.type === "assistant" && d.message?.usage) {
      const id = String(d.message.id ?? d.uuid), n = Number(d.message.usage.output_tokens) || 0, had = t.ids.get(id) ?? 0;
      if (n > had) { t.ids.set(id, n); t.out += n - had; }
    } else if (d.payload?.type === "token_count") t.out += Number(d.payload.info?.last_token_usage?.output_tokens) || 0;
  }
}
export function outputToday(file: string, now = new Date()): number {
  const day = dayKey(now);
  let t = tallies.get(file);
  if (!t || t.day !== day) { t = { day, offset: 0, ids: new Map(), out: 0 }; tallies.set(file, t); }
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size; if (size < t.offset) { t.offset = 0; t.ids.clear(); t.out = 0; }
    if (size === t.offset) return t.out;
    const buf = Buffer.alloc(size - t.offset); readSync(fd, buf, 0, buf.length, t.offset);
    const text = buf.toString("utf8"), end = text.lastIndexOf("\n");
    if (end < 0) return t.out;
    countLines(text.slice(0, end).split("\n"), t, midnight(now));
    t.offset += Buffer.byteLength(text.slice(0, end + 1));
  } catch { /* gone */ } finally { if (fd !== null) closeSync(fd); }
  return t.out;
}
function transcriptOf(p: AgentProc, ws: string, room: string): string | null {
  if (p.agent === "codex") { const ch = roomChannel(ws, room); return ch?.kind === "superset" ? codexFileFor(room) : null; }
  if (!p.sessionId) return null;
  const root = join(homedir(), ".claude", "projects");
  try { for (const d of readdirSync(root)) { const f = join(root, d, `${p.sessionId}.jsonl`); if (existsSync(f)) return f; } } catch {}
  return null;
}

/** Every Claude/Codex room on this Mac (tmux pane or Superset terminal) — for the auto switch, which has no phone. */
export function allAgentRooms(): [string, string][] {
  const out: [string, string][] = [];
  for (const agent of ["claude", "codex"] as Agent[]) for (const pid of pids(agent)) {
    const env = envAll(pid);
    if (env.TMUX_PANE) out.push(["tmux", env.TMUX_PANE]);
    else if (env.SUPERSET_WORKSPACE_ID && env.SUPERSET_TERMINAL_ID) out.push([env.SUPERSET_WORKSPACE_ID, env.SUPERSET_TERMINAL_ID]);
  }
  return out;
}

// ── auto switch: Mind quota ≥ at% → every Mind room to the main account (once a day · busy rooms queue) ──────────
const AUTO_FILE = join(homedir(), ".maw", "account-auto.json");
interface Auto { on: boolean; at: number; lastDay?: string }
export function readAuto(f = AUTO_FILE): Auto {
  try { const d = JSON.parse(readFileSync(f, "utf8")); return { on: !!d.on, at: Math.min(99, Math.max(50, Number(d.at) || 90)), lastDay: d.lastDay }; } catch { return { on: false, at: 90 }; }
}
function writeAuto(a: Auto, f = AUTO_FILE) { try { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, JSON.stringify(a)); } catch {} }
export async function autoPass(now = new Date()): Promise<number> {
  const a = readAuto(); if (!a.on || a.lastDay === dayKey(now)) return 0;
  const me = await getMe().catch(() => null);
  if (!me?.dailyTokenLimit || me.usedToday * 100 / me.dailyTokenLimit < a.at) return 0;
  writeAuto({ ...a, lastDay: dayKey(now) });
  let n = 0;
  for (const [ws, room] of allAgentRooms()) {
    const p = agentOfRoom(ws, room); if (!p || p.route !== "mind") continue;
    const r = await switchRoom(ws, room, "direct"); n++;
    if (r.queued) pending.set(JSON.stringify([ws, room]), "direct");
  }
  return n;
}
setInterval(() => { autoPass().catch(() => {}); }, 60_000).unref?.();

// rooms waiting to be switched once their agent is idle (switch-all)
const pending = new Map<string, Route>();
let ticking = false;
async function tick() {
  if (ticking || !pending.size) return; ticking = true;
  try { for (const [k, to] of [...pending]) { const [ws, room] = JSON.parse(k); const r = await switchRoom(ws, room, to); if (!r.queued) pending.delete(k); } }
  finally { ticking = false; }
}
setInterval(() => { tick().catch(() => {}); }, 15_000).unref?.();

export function mount(app: any): void {
  app.get("/accounts/rooms", ({ query }: any) => {
    const rooms: any[] = [];
    for (const [ws, room] of JSON.parse(String(query?.rooms || "[]")).slice(0, 60)) {
      const p = agentOfRoom(String(ws), String(room));
      if (p) rooms.push({ ws, room, agent: p.agent, route: p.route, hasSession: !!p.sessionId, pending: pending.get(JSON.stringify([ws, room])) ?? null });
    }
    return { ok: true, rooms };
  });
  app.get("/accounts/usage", ({ query }: any) => {
    const rooms: any[] = [];
    for (const [ws, room] of JSON.parse(String(query?.rooms || "[]")).slice(0, 60)) {
      const p = agentOfRoom(String(ws), String(room)); if (!p) continue;
      const f = transcriptOf(p, String(ws), String(room));
      rooms.push({ ws, room, agent: p.agent, route: p.route, outToday: f ? outputToday(f) : null });
    }
    return { ok: true, rooms };
  });
  app.get("/accounts/auto", () => ({ ok: true, ...readAuto() }));
  app.post("/accounts/auto", ({ body }: any) => {
    const a = readAuto(), next = { ...a, on: body?.on === undefined ? a.on : !!body.on, at: Number(body?.at) || a.at };
    writeAuto(next); return { ok: true, ...readAuto() };
  });
  app.get("/rooms/:ws/:room/account", ({ params }: any) => {
    const p = agentOfRoom(params.ws, params.room);
    const f = p ? transcriptOf(p, params.ws, params.room) : null;
    return { ok: true, agent: p?.agent ?? null, route: p?.route ?? null, hasSession: !!p?.sessionId, outToday: f ? outputToday(f) : null, pending: pending.get(JSON.stringify([params.ws, params.room])) ?? null };
  });
  app.post("/rooms/:ws/:room/account", async ({ params, body, set }: any) => {
    const to: Route = body?.to === "direct" ? "direct" : "mind";
    const r = await switchRoom(params.ws, params.room, to);
    if (r.queued) pending.set(JSON.stringify([params.ws, params.room]), to);
    if (!r.ok && !r.queued) set.status = 409;
    return r;
  });
  app.post("/accounts/switch-all", async ({ body }: any) => {
    const to: Route = body?.to === "direct" ? "direct" : "mind";
    const results: any[] = [];
    for (const [ws, room] of (Array.isArray(body?.rooms) ? body.rooms : []).slice(0, 60)) {
      const r = await switchRoom(String(ws), String(room), to);
      if (r.queued) pending.set(JSON.stringify([ws, room]), to);
      results.push({ ws, room, ...r });
    }
    return { ok: true, results };
  });
}
