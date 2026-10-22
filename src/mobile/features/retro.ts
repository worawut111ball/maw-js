// Feature pack "retro" — run /rrr (or /mind-rrr) in a live Claude room from the phone home page.
// GET  /retro                 → { settings, skills, rooms }   live Claude rooms + minutes worked since the last retro
// POST /retro/settings        { mode, skill, minMinutes?, idleMinutes? }
// POST /retro/run             { sessionId | ws+room, skill? }  only when the room is idle/done with no dialog (else 409)
// Modes: manual = nothing automatic · semi = push "สรุปงานไหม" once per due period · auto = type the skill itself.
// "Worked" = transcript timestamps since the last retro; gaps over 5 min are not counted (an honest lower bound).
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { readScreen, typeInto, readLiveRooms, notifyPhones } from "./ctx";
import type { LiveRoom, ReplyChannel } from "./ctx";
import { hookStates, statusFromRoom, inputDraft, agentSpinner } from "../api";
import type { AgentStatus } from "../api";
import { parsePrompt, parseMenu } from "./permissions";

export type RetroMode = "manual" | "semi" | "auto";
export const MODES: RetroMode[] = ["manual", "semi", "auto"];
export const SKILLS = ["rrr", "mind-rrr"] as const;
export type RetroSkill = typeof SKILLS[number];
export interface RetroSettings { mode: RetroMode; skill: RetroSkill; minMinutes: number; idleMinutes: number }
/** Per session: when we last ran a retro, last activity seen, and which activity a push/auto-run already covered. */
export interface SessionMark { lastRetroAt: number | null; lastActivityAt: number | null; handled?: number | null }
export interface RetroFile extends RetroSettings { sessions: Record<string, SessionMark> }
export const DEFAULTS: RetroSettings = { mode: "manual", skill: "rrr", minMinutes: 30, idleMinutes: 10 };

export const FILE = join(homedir(), ".maw", "retro.json");
export const LOOP_EVERY = 60_000;
const GAP_MIN = 5;                       // silence longer than this is not work
const WINDOW = 8 * 1024 * 1024;          // transcript tail we read (files can be 500 MB+)
const KEEP_DAYS = 7;
const RECENT_RUN = 2 * 60_000;           // refuse a second run this soon
const SCREEN_LINES = 160;

// ── settings ──
export function validateSettings(b: any, cur: RetroSettings = DEFAULTS): { ok: true; settings: RetroSettings } | { ok: false; error: string } {
  const s = { ...cur };
  if (b?.mode !== undefined) { if (!MODES.includes(b.mode)) return { ok: false, error: "โหมดต้องเป็น manual / semi / auto" }; s.mode = b.mode; }
  if (b?.skill !== undefined) { if (!SKILLS.includes(b.skill)) return { ok: false, error: "skill ต้องเป็น rrr หรือ mind-rrr" }; s.skill = b.skill; }
  const num = (v: any, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  if (b?.minMinutes !== undefined) { if (!num(b.minMinutes, 5, 480)) return { ok: false, error: "เวลาทำงานขั้นต่ำต้องเป็น 5–480 นาที" }; s.minMinutes = b.minMinutes; }
  if (b?.idleMinutes !== undefined) { if (!num(b.idleMinutes, 1, 240)) return { ok: false, error: "เวลาว่างก่อนสรุปต้องเป็น 1–240 นาที" }; s.idleMinutes = b.idleMinutes; }
  return { ok: true, settings: s };
}

export function loadFile(file = FILE): RetroFile {
  let d: any = {};
  try { d = JSON.parse(readFileSync(file, "utf-8")); } catch { /* none yet */ }
  const v = validateSettings(d, DEFAULTS);
  const settings = v.ok ? v.settings : { ...DEFAULTS };   // a hand-broken file falls back to manual
  return { ...settings, sessions: d && typeof d.sessions === "object" && d.sessions ? d.sessions : {} };
}
export function saveFile(f: RetroFile, file = FILE): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(f, null, 1), { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* best effort */ }
}

// ── transcript activity (tail only, then appended bytes) ──
export interface Activity { minutes: number[]; lastTs: number | null; retros: number[]; cwd: string | null }
const RETRO_CMD = /<command-name>\/?(rrr|mind-rrr)<\/command-name>/;

/** Fold JSONL lines into minute stamps of activity + times a retro command was typed. */
export function foldLines(a: Activity, lines: string[]): void {
  for (const line of lines) {
    if (!line.includes('"timestamp"')) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== "user" && e?.type !== "assistant") continue;
    const ts = Date.parse(e.timestamp); if (!Number.isFinite(ts)) continue;
    if (e.cwd) a.cwd = String(e.cwd);
    const m = Math.floor(ts / 60_000);
    if (a.minutes[a.minutes.length - 1] !== m) {
      if (!a.minutes.length || m > a.minutes[a.minutes.length - 1]) a.minutes.push(m);
      else if (!a.minutes.includes(m)) { a.minutes.push(m); a.minutes.sort((x, y) => x - y); }
    }
    if (a.lastTs === null || ts > a.lastTs) a.lastTs = ts;
    const c = e.type === "user" ? e.message?.content : null;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b?.text ?? "").join("\n") : "";
    if (text && RETRO_CMD.test(text)) a.retros.push(ts);
  }
}

/** Minutes of work after `since`: consecutive active minutes ≤ 5 apart count the gap, longer silences count 1. */
export function workedMinutes(minutes: number[], since: number | null, gap = GAP_MIN): number {
  const from = since == null ? -Infinity : Math.floor(since / 60_000);
  let total = 0, prev: number | null = null;
  for (const m of minutes) {
    if (m <= from) continue;
    total += prev !== null && m - prev <= gap ? m - prev : 1;
    prev = m;
  }
  return total;
}

const projectsRoot = join(homedir(), ".claude", "projects");
const fileOf = new Map<string, string>();
function transcriptFor(sid: string, root = projectsRoot): string | null {
  const hit = fileOf.get(sid); if (hit && existsSync(hit)) return hit;
  try { for (const d of readdirSync(root)) { const f = join(root, d, `${sid}.jsonl`); if (existsSync(f)) { fileOf.set(sid, f); return f; } } } catch { /* none */ }
  return null;
}
const acts = new Map<string, { size: number; partial: string; skip: boolean; a: Activity }>();
export function readActivity(file: string): Activity | null {
  let size: number; try { size = statSync(file).size; } catch { return null; }
  let st = acts.get(file);
  if (!st || size < st.size) {
    st = { size: Math.max(0, size - WINDOW), partial: "", skip: size > WINDOW, a: { minutes: [], lastTs: null, retros: [], cwd: null } };
    acts.set(file, st);
  }
  if (size > st.size) {
    if (size - st.size > WINDOW) { st.size = size - WINDOW; st.partial = ""; st.skip = true; }
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - st.size);
      readSync(fd, buf, 0, buf.length, st.size);
      const lines = (st.partial + buf.toString("utf-8")).split("\n");
      st.partial = lines.pop() ?? "";
      if (st.skip) { lines.shift(); st.skip = false; }
      foldLines(st.a, lines);
      st.size = size;
    } finally { closeSync(fd); }
    const keep = Math.floor(Date.now() / 60_000) - KEEP_DAYS * 1440;
    if (st.a.minutes.length && st.a.minutes[0] < keep) st.a.minutes = st.a.minutes.filter(m => m >= keep);
  }
  return st.a;
}

// ── status + due ──
type Hook = { status: AgentStatus; at: number } | undefined;
/** Same rule as the projects view: a fresh hook event wins, else Claude's own room status. */
export function roomStatus(room: LiveRoom, hook: Hook, now = Date.now()): AgentStatus {
  if (hook && hook.status !== "ended" && now - hook.at < 6 * 3600e3) return hook.status;
  return statusFromRoom(room.status);
}

export interface DueFacts { status: AgentStatus; workedMin: number; lastActivityAt: number | null; lastRetroAt: number | null; handled?: number | null }
/** Is a retro due now? `why` is the Thai reason shown on the phone. */
export function retroDue(f: DueFacts, s: RetroSettings, now = Date.now()): { due: boolean; why: string } {
  if (f.status === "working") return { due: false, why: "กำลังทำงาน" };
  if (f.status === "waiting") return { due: false, why: "รอคำตอบอยู่" };
  if (f.status === "ended") return { due: false, why: "ปิดแล้ว" };
  if (f.lastActivityAt == null) return { due: false, why: "ยังไม่มีงาน" };
  if (f.lastRetroAt != null && f.lastRetroAt >= f.lastActivityAt) return { due: false, why: "สรุปแล้ว" };
  if (f.workedMin < s.minMinutes) return { due: false, why: `ทำงาน ${f.workedMin}/${s.minMinutes} นาที` };
  const idle = Math.floor((now - f.lastActivityAt) / 60_000);
  if (idle < s.idleMinutes) return { due: false, why: `รอว่างอีก ${s.idleMinutes - idle} นาที` };
  if (f.handled != null && f.handled >= f.lastActivityAt) return { due: false, why: "แจ้งไปแล้ว" };
  return { due: true, why: "ถึงเวลาสรุป" };
}

// ── deps (tests pass fakes — never the real terminal) ──
export interface RetroDeps {
  rooms: () => Map<string, LiveRoom>;
  read: (ch: ReplyChannel, lines: number) => Promise<string>;
  type: (ch: ReplyChannel, text: string) => Promise<void>;
  notify: (sid: string, kind: string, msg: { title: string; body: string }) => Promise<unknown>;
  hook: (sid: string) => Hook;
  activity: (sid: string) => Activity | null;
  skillExists: (name: string) => boolean;
  load: () => RetroFile;
  save: (f: RetroFile) => void;
  now: () => number;
}
const userSkill = (n: string, home = homedir()) => existsSync(join(home, ".claude", "skills", n, "SKILL.md")) || existsSync(join(home, ".claude", "commands", n + ".md"));
export const realDeps: RetroDeps = {
  rooms: () => readLiveRooms(), read: readScreen, type: typeInto, notify: notifyPhones,
  hook: sid => hookStates.get(sid), activity: sid => { const f = transcriptFor(sid); return f ? readActivity(f) : null; },
  skillExists: n => userSkill(n), load: () => loadFile(), save: f => saveFile(f), now: () => Date.now(),
};

export interface Candidate {
  sessionId: string; ws: string | null; room: string | null; label: string; project: string | null;
  status: AgentStatus; workedMin: number; lastActivityAt: number | null; lastRetroAt: number | null; due: boolean; why: string;
}
const chanIds = (ch: ReplyChannel | null): [string | null, string | null] =>
  ch?.kind === "superset" ? [ch.workspaceId, ch.terminalId] : ch?.kind === "tmux" ? ["tmux", ch.pane] : [null, null];
const maxOf = (...xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => typeof x === "number"); return v.length ? Math.max(...v) : null; };

export function candidates(d: RetroDeps, f: RetroFile = d.load()): Candidate[] {
  const now = d.now(), out: Candidate[] = [];
  for (const r of d.rooms().values()) {
    const hook = d.hook(r.sessionId), act = d.activity(r.sessionId), mark = f.sessions[r.sessionId];
    const status = roomStatus(r, hook, now);
    const lastRetroAt = maxOf(mark?.lastRetroAt, act?.retros.length ? Math.max(...act.retros) : null);
    const lastActivityAt = maxOf(act?.lastTs, hook && hook.status !== "ended" ? hook.at : null, mark?.lastActivityAt);
    const workedMin = act ? workedMinutes(act.minutes, lastRetroAt) : 0;
    const { due, why } = retroDue({ status, workedMin, lastActivityAt, lastRetroAt, handled: mark?.handled }, f, now);
    const [ws, room] = chanIds(r.channel);
    out.push({ sessionId: r.sessionId, ws, room, label: r.name || r.channel?.label || "Claude", project: act?.cwd ? basename(act.cwd) : null,
      status, workedMin, lastActivityAt, lastRetroAt, due, why });
  }
  return out.sort((a, b) => Number(b.due) - Number(a.due) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

// ── run ──
const running = new Set<string>();
export type RunResult = { ok: true; skill: RetroSkill } | { ok: false; code: number; error: string };

/** Type `/skill` into the room — only when it is idle/done, shows no dialog, no spinner and no half-typed text. */
export async function runRetro(d: RetroDeps, sid: string, skill: RetroSkill, opts: { auto?: boolean } = {}): Promise<RunResult> {
  const room = d.rooms().get(sid);
  if (!room) return { ok: false, code: 404, error: "ไม่พบห้องนี้ (ปิดไปแล้ว?)" };
  if (!room.channel) return { ok: false, code: 409, error: "ห้องนี้สั่งจากมือถือไม่ได้ (ไม่ได้เปิดใน tmux / Superset)" };
  if (!d.skillExists(skill)) return { ok: false, code: 400, error: `ไม่มี skill /${skill} บนเครื่องนี้` };
  if (running.has(sid)) return { ok: false, code: 409, error: "กำลังสั่งอยู่แล้ว" };
  const f = d.load(), now = d.now(), mark = f.sessions[sid];
  if (mark?.lastRetroAt && now - mark.lastRetroAt < RECENT_RUN) return { ok: false, code: 409, error: "เพิ่งสั่งสรุปไปเมื่อสักครู่" };
  const st = roomStatus(room, d.hook(sid), now);
  if (st === "working") return { ok: false, code: 409, error: "ห้องกำลังทำงานอยู่ — รอให้เสร็จก่อน" };
  if (st === "waiting") return { ok: false, code: 409, error: "ห้องรอคำตอบอยู่ — ตอบก่อนแล้วค่อยสรุป" };
  running.add(sid);
  try {
    let raw: string;
    try { raw = await d.read(room.channel, SCREEN_LINES); } catch { return { ok: false, code: 409, error: "อ่านจอห้องนี้ไม่ได้ — ไม่ได้สั่งอะไร" }; }
    if (parsePrompt(raw) || parseMenu(raw)) return { ok: false, code: 409, error: "มีหน้าถามเปิดค้างอยู่ — ตอบก่อนแล้วค่อยสรุป" };
    if (agentSpinner(raw)) return { ok: false, code: 409, error: "ห้องกำลังทำงานอยู่ — รอให้เสร็จก่อน" };
    const draft = inputDraft(raw);
    // Superset's reader is plain text: a grey suggestion looks like a draft → auto mode never risks it
    if (draft && (draft.sure || opts.auto)) return { ok: false, code: 409, error: "มีข้อความพิมพ์ค้างในช่องบน Mac — ไม่ได้สั่ง" };
    await d.type(room.channel, "/" + skill);
    const g = d.load(), act = d.activity(sid), t = d.now();
    const last = maxOf(act?.lastTs, g.sessions[sid]?.lastActivityAt);
    g.sessions[sid] = { ...g.sessions[sid], lastRetroAt: t, lastActivityAt: last, handled: last };
    d.save(g);
    return { ok: true, skill };
  } finally { running.delete(sid); }
}

// ── background loop ──
/** One pass of the semi/auto loop. Returns the sessions notified (semi) and run (auto). */
export async function retroPass(d: RetroDeps): Promise<{ notified: string[]; ran: string[] }> {
  const notified: string[] = [], ran: string[] = [];
  const f = d.load();
  const list = candidates(d, f);
  let dirty = false;
  // remember last activity (so "worked/idle" survive a restart) and forget rooms closed long ago
  const live = new Set(list.map(c => c.sessionId)), old = d.now() - 30 * 864e5;
  for (const c of list) {
    const m = f.sessions[c.sessionId];
    if (c.lastActivityAt != null && m?.lastActivityAt !== c.lastActivityAt) { f.sessions[c.sessionId] = { lastRetroAt: m?.lastRetroAt ?? null, ...m, lastActivityAt: c.lastActivityAt }; dirty = true; }
  }
  for (const [sid, m] of Object.entries(f.sessions)) if (!live.has(sid) && (m.lastActivityAt ?? 0) < old && (m.lastRetroAt ?? 0) < old) { delete f.sessions[sid]; dirty = true; }
  if (dirty) d.save(f);
  if (f.mode === "manual") return { notified, ran };
  for (const c of list) {
    if (!c.due) continue;
    const room = c.label + (c.project && c.project !== c.label ? ` · ${c.project}` : "");
    if (f.mode === "semi") {
      const g = d.load(); g.sessions[c.sessionId] = { lastRetroAt: c.lastRetroAt, ...g.sessions[c.sessionId], lastActivityAt: c.lastActivityAt, handled: c.lastActivityAt }; d.save(g);
      await d.notify(c.sessionId, "retro", { title: `📝 สรุปงานไหม · ${room}`, body: `ทำงานไป ${fmtMin(c.workedMin)} — แตะเพื่อเปิดห้องแล้วสั่ง /${f.skill}` }).catch(() => {});
      notified.push(c.sessionId);
    } else {
      const r = await runRetro(d, c.sessionId, f.skill, { auto: true });
      if (!r.ok) continue;                                  // busy / dialog / draft → try again next pass
      await d.notify(c.sessionId, "retro", { title: `📝 สั่ง /${f.skill} แล้ว · ${room}`, body: `ทำงานไป ${fmtMin(c.workedMin)} แล้วว่าง — สั่งสรุปงานให้อัตโนมัติ` }).catch(() => {});
      ran.push(c.sessionId);
    }
  }
  return { notified, ran };
}
export const fmtMin = (m: number) => m >= 60 ? `${Math.floor(m / 60)} ชม.${m % 60 ? ` ${m % 60} นาที` : ""}` : `${m} นาที`;

let looping = false;
function startLoop(d: RetroDeps): void {
  if (looping || process.env.NODE_ENV === "test") return;   // never auto-type into real rooms from a test run
  looping = true;
  let busy = false;
  setInterval(async () => {
    if (busy) return; busy = true;
    try { await retroPass(d); } catch { /* next minute */ } finally { busy = false; }
  }, LOOP_EVERY).unref?.();
}

function payload(d: RetroDeps) {
  const f = d.load();
  const { sessions: _s, ...settings } = f;
  return { ok: true, settings, skills: SKILLS.map(name => ({ name, available: d.skillExists(name) })), rooms: candidates(d, f) };
}

export function mount(app: any, d: RetroDeps = realDeps): void {
  if (d === realDeps) startLoop(d);   // the real server only — tests pass fakes
  app.get("/retro", () => payload(d));
  app.post("/retro/settings", ({ body, set }: any) => {
    const f = d.load();
    const v = validateSettings(body ?? {}, f);
    if (!v.ok) { set.status = 400; return { ok: false, error: v.error }; }
    d.save({ ...f, ...v.settings });
    return payload(d);
  });
  app.post("/retro/run", async ({ body, set }: any) => {
    const skill = body?.skill ?? d.load().skill;
    if (!SKILLS.includes(skill)) { set.status = 400; return { ok: false, error: "skill ต้องเป็น rrr หรือ mind-rrr" }; }
    let sid = typeof body?.sessionId === "string" ? body.sessionId : "";
    if (!sid && body?.ws && body?.room) {
      for (const r of d.rooms().values()) { const [w, rm] = chanIds(r.channel); if (w === String(body.ws) && rm === String(body.room)) { sid = r.sessionId; break; } }
    }
    if (!sid || !/^[\w-]{8,80}$/.test(sid)) { set.status = 400; return { ok: false, error: "ต้องระบุห้อง (sessionId หรือ ws+room)" }; }
    const r = await runRetro(d, sid, skill);
    if (!r.ok) { set.status = r.code; return { ok: false, error: r.error }; }
    return { ok: true, skill: r.skill, sessionId: sid };
  });
}
