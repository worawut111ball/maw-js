// Feature pack "mind" — the user's own Artron Mind on the phone: Mail Box + Mind Chat
// (PLAN-maw-mobile.md §9). Talks to Mind like artron-cli: Bearer token from ~/.artron/config.json, read per request on the
// Mac — the token never leaves this server (not in responses, logs or errors). Cloudflare blocks bare clients (1010) → real User-Agent.
// GET  /mind/me                 → {email, agent, usedToday, dailyTokenLimit}
// GET  /mind/mail[?fresh=1]     → newest first, body clipped to a preview · {pending, waiting, mode}
// GET  /mind/mail/:id           → one mail with the full body + thread links
// POST /mind/mail/mode {mode}   → manual | semi | auto (Mind hands waiting mail to the agent when leaving manual)
// POST /mind/mail/:id/act {op}  → approve | reject (pending, sent to me) · retry (failed, sent to me) — Mind's /api/mail/act {id, op}
// GET  /mind/chats · GET /mind/chats/:id[?fresh=1] · POST /mind/chats/:id/send {text} (returns at once, phone polls) · POST /mind/chats
// Background (real server only): every 2 min, new mail waiting for me → one push "📬 Mind · จดหมายใหม่". First pass only remembers.
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { notifyPhones } from "./ctx";

const CACHE_MS = 20_000, ME_MS = 5 * 60_000, TIMEOUT_MS = 15_000, WATCH_EVERY = 2 * 60_000;
const PREVIEW = 160, BODY_MAX = 20_000, MSG_MAX = 12_000, MSGS_SHOWN = 60, TEXT_MAX = 8_000;
const UA = "maw-mobile/1 (artron-cli compatible)";
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MODES = ["manual", "semi", "auto"] as const;
export const OPS = ["approve", "reject", "retry"] as const;

export interface MindConfig { baseUrl: string; token: string }
function readConfig(): MindConfig | null {
  try { const c = JSON.parse(readFileSync(join(homedir(), ".artron", "config.json"), "utf-8")); return { baseUrl: String(c.baseUrl ?? ""), token: String(c.token ?? "") }; }
  catch { return null; }
}

/** Swappable for tests — no test may reach the real Mind or push service. */
export const deps = {
  config: readConfig as () => MindConfig | null,
  fetch: ((url: string, init: RequestInit) => fetch(url, init)) as (url: string, init: RequestInit) => Promise<Response>,
  notify: (sid: string, kind: string, msg: { title: string; body: string }): Promise<unknown> => notifyPhones(sid, kind, msg),
  now: () => Date.now(),
};
export type MindDeps = typeof deps;

// ── talking to Mind ──────────────────────────────────────────────

export class MindError extends Error { constructor(public status: number, message: string) { super(message); } }
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** Belt and braces: whatever goes to the phone never carries the token. */
export const scrub = (s: string, token: string) => (token && token.length >= 8 ? s.split(token).join("***") : s);

/** Mind's HTTP answer → Thai error for the phone. Never 401: the phone treats 401 as "maw logged out". */
export function mapError(status: number, body: any, raw = ""): MindError {
  const msg = typeof body?.error === "string" ? clip(body.error, 200) : "";
  if ((status === 403 || status === 429 || status === 503) && /error code:? *10\d\d|cloudflare/i.test(raw))
    return new MindError(502, "Cloudflare บล็อกการเชื่อมต่อ Mind — ลองใหม่ทีหลัง");
  if (status === 401 || status === 403) return new MindError(503, "token หมดอายุ — รัน `artron login` บน Mac");
  if (status === 404) return new MindError(404, msg && msg !== "not found" ? msg : "ไม่พบใน Mind (อาจถูกลบไปแล้ว)");
  if (status === 400 || status === 409) return new MindError(status, msg || "Mind ไม่รับคำสั่งนี้");
  return new MindError(502, `Mind ตอบ ${status}${msg ? " · " + msg : ""}`);
}

export async function mindApi(path: string, init: { method?: string; body?: any } = {}, d: MindDeps = deps): Promise<any> {
  const cfg = d.config();
  if (!cfg?.token || !cfg.baseUrl) throw new MindError(503, "ยังไม่ได้ login Mind — รัน `artron login` บน Mac");
  let url: string;
  try { url = new URL(path, cfg.baseUrl).toString(); } catch { throw new MindError(503, "baseUrl ใน ~/.artron/config.json ไม่ถูกต้อง"); }
  let res: Response;
  try {
    res = await d.fetch(url, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${cfg.token}`, "User-Agent": UA, Accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    throw new MindError(502, e?.name === "TimeoutError" ? "ต่อ Mind ไม่ได้ (เกิน 15 วินาที)" : "ต่อ Mind ไม่ได้ — เช็คเน็ตของ Mac");
  }
  const raw = await res.text().catch(() => "");
  let body: any = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* Cloudflare HTML page */ }
  if (!res.ok) { const e = mapError(res.status, body, raw); e.message = scrub(e.message, cfg.token); throw e; }
  if (body === null && raw) throw new MindError(502, "Mind ตอบกลับมาไม่ใช่ JSON");
  return body;
}

// small GET cache (20 s) + one request in flight per path
const cache = new Map<string, { at: number; data: any }>(), inflight = new Map<string, Promise<any>>();
export function resetCache() { cache.clear(); inflight.clear(); }
async function cached(path: string, fresh: boolean, d: MindDeps, ttl = CACHE_MS): Promise<any> {
  const c = cache.get(path);
  if (!fresh && c && d.now() - c.at < ttl) return c.data;
  const f = inflight.get(path); if (f) return f;
  const p = mindApi(path, {}, d).then(data => { cache.set(path, { at: d.now(), data }); return data; }).finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}
const forget = (...prefixes: string[]) => { for (const k of [...cache.keys()]) if (prefixes.some(p => k === p || k.startsWith(p + "/"))) cache.delete(k); };

// ── normalizers (pure) ───────────────────────────────────────────

export interface Me { email: string; agent: string; usedToday: number; dailyTokenLimit: number }
export const normMe = (r: any): Me => ({
  email: String(r?.email ?? ""), agent: String(r?.agent ?? ""),
  usedToday: Number(r?.usedToday) || 0, dailyTokenLimit: Number(r?.dailyTokenLimit) || 0,
});

export type MailOp = typeof OPS[number];
export interface MailRow {
  id: string; ts: number; status: string; statusText: string; from: string; fromOwner: string; to: string; toOwner: string;
  subject: string; preview: string; held: string; toMe: boolean; needsMe: boolean; actions: MailOp[]; inReplyTo: string | null;
}
/** "รอฉัน" = waiting on MY decision: pending + addressed to me (the agent-held [HOLD] mail in semi mode is pending too). */
export const needsMe = (m: any, email: string) => m?.status === "pending" && !!email && m?.toOwner === email;
/** What Mind's /api/mail/act accepts for this mail from me (same rule as Mind's web Mail Box). */
export function mailActions(m: any, email: string): MailOp[] {
  if (!email || m?.toOwner !== email) return [];
  if (m.status === "pending") return ["approve", "reject"];
  if (m.status === "failed") return ["retry"];
  return [];
}
/** Thai status label, same words as Mind's web Mail Box. */
export function mailStatusText(m: any, email: string): string {
  const s = String(m?.status ?? "");
  if (s === "pending") return m.held && m.toOwner === email ? "⏸️ รอคุณตัดสินใจ" : m.toOwner === email ? "📩 รอคุณอนุมัติ" : "📨 รอปลายทางอนุมัติ";
  return ({ approved: "⏳ agent กำลังตอบ", replied: "✅ ตอบแล้ว", rejected: "🚫 ปฏิเสธ", failed: "⚠️ ตอบไม่สำเร็จ" } as Record<string, string>)[s] ?? s;
}
export function normMail(m: any, email: string): MailRow {
  const body = String(m?.body ?? "");
  return {
    id: String(m?.id ?? ""), ts: Number(m?.ts) || 0, status: String(m?.status ?? ""), statusText: mailStatusText(m, email),
    from: String(m?.from ?? ""), fromOwner: String(m?.fromOwner ?? ""), to: String(m?.to ?? ""), toOwner: String(m?.toOwner ?? ""),
    subject: clip(String(m?.subject ?? "").trim() || "(ไม่มีหัวข้อ)", 200), preview: clip(body.replace(/\s+/g, " ").trim(), PREVIEW),
    held: typeof m?.held === "string" ? clip(m.held, 500) : "", toMe: !!email && m?.toOwner === email, needsMe: needsMe(m, email),
    actions: mailActions(m, email), inReplyTo: typeof m?.inReplyTo === "string" ? m.inReplyTo : null,
  };
}
export interface MailList { mail: MailRow[]; total: number; pending: number; waiting: number; mode: string; email: string; at: number }
export function normMailList(raw: any, email: string, at = Date.now()): MailList {
  const list = (Array.isArray(raw?.mail) ? raw.mail : []).filter((m: any) => m && typeof m.id === "string");
  const mail = list.map((m: any) => normMail(m, email)).sort((a: MailRow, b: MailRow) => b.ts - a.ts);
  const waiting = mail.filter((m: MailRow) => m.needsMe).length;
  return { mail, total: mail.length, pending: Number.isFinite(raw?.pending) ? raw.pending : waiting, waiting,
    mode: (MODES as readonly string[]).includes(raw?.mode) ? raw.mode : "manual", email, at };
}
export interface MailDetail extends MailRow { body: string; handledAt: number | null; parent: { id: string; subject: string } | null; replies: { id: string; subject: string; status: string }[] }
export function mailDetail(raw: any, id: string, email: string): MailDetail | null {
  const all = Array.isArray(raw?.mail) ? raw.mail : [];
  const m = all.find((x: any) => x?.id === id); if (!m) return null;
  const p = m.inReplyTo ? all.find((x: any) => x?.id === m.inReplyTo) : null;
  return {
    ...normMail(m, email), body: clip(String(m.body ?? ""), BODY_MAX), handledAt: Number(m.handledAt) || null,
    parent: p ? { id: p.id, subject: String(p.subject ?? "") } : null,
    replies: all.filter((x: any) => x?.inReplyTo === id).map((x: any) => ({ id: x.id, subject: String(x.subject ?? ""), status: mailStatusText(x, email) })),
  };
}

export interface ChatRow { id: string; title: string; updatedAt: number; pinned: boolean }
export function normChats(raw: any): ChatRow[] {
  return (Array.isArray(raw) ? raw : []).filter((c: any) => c && typeof c.id === "string")
    .map((c: any) => ({ id: c.id, title: clip(String(c.title ?? "").trim() || "(ไม่มีชื่อ)", 120), updatedAt: Number(c.updatedAt) || 0, pinned: !!c.pinned }))
    .sort((a: ChatRow, b: ChatRow) => +b.pinned - +a.pinned || b.updatedAt - a.updatedAt);
}
export interface ChatMsg { id: string; role: "user" | "oracle"; status: string; ts: number; text: string; files: string[] }
export interface ChatView { id: string; title: string; agent: string; updatedAt: number; messages: ChatMsg[]; hidden: number; thinking: boolean }
/** Last 60 messages, texts clipped; owner / sessionId / attachment urls stay on the Mac. */
export function normChat(raw: any): ChatView {
  const all = (Array.isArray(raw?.messages) ? raw.messages : []).filter((m: any) => m && (m.role === "user" || m.role === "oracle"));
  const shown = all.slice(-MSGS_SHOWN).map((m: any, i: number) => ({
    id: String(m.id ?? i), role: m.role, status: String(m.status ?? "done"), ts: Number(m.ts) || 0, text: clip(String(m.text ?? ""), MSG_MAX),
    files: (Array.isArray(m.attachments) ? m.attachments : []).map((a: any) => clip(String(a?.name ?? "ไฟล์"), 80)).slice(0, 10),
  }));
  const last = shown[shown.length - 1];
  return { id: String(raw?.id ?? ""), title: String(raw?.title ?? "") || "(ไม่มีชื่อ)", agent: String(raw?.agent ?? ""), updatedAt: Number(raw?.updatedAt) || 0,
    messages: shown, hidden: all.length - shown.length, thinking: !!last && last.role === "oracle" && last.status === "pending" };
}

// ── reads ────────────────────────────────────────────────────────

export const getMe = async (d: MindDeps = deps) => normMe(await cached("/api/me", false, d, ME_MS));
export async function getMail(fresh = false, d: MindDeps = deps): Promise<{ raw: any; list: MailList }> {
  const [me, raw] = await Promise.all([getMe(d), cached("/api/mail", fresh, d)]);
  return { raw, list: normMailList(raw, me.email, cache.get("/api/mail")?.at ?? d.now()) };
}

// ── watcher: new mail waiting for me → one push per pass ─────────

export interface WatchState { seen: Set<string> }
export async function mailPass(st: WatchState, d: MindDeps = deps, quiet = false): Promise<string[]> {
  const { list } = await getMail(true, d);
  const fresh = list.mail.filter(m => m.needsMe && !st.seen.has(m.id));
  for (const m of fresh) st.seen.add(m.id);
  if (quiet || !fresh.length) return [];
  const m = fresh[0];
  const body = `จาก ${m.from} · ${clip(m.subject, 60)}${fresh.length > 1 ? ` (+อีก ${fresh.length - 1} ฉบับ)` : ""}`;
  await d.notify("mind", "mind-mail", { title: "📬 Mind · จดหมายใหม่", body }).catch(() => {});
  return fresh.map(x => x.id);
}
let watching = false;
function startWatch(): void {
  if (watching || process.env.NODE_ENV === "test") return;
  watching = true;
  const st: WatchState = { seen: new Set() };
  let first = true, running = false;
  setInterval(async () => {
    if (running) return; running = true;
    try { await mailPass(st, deps, first); first = false; } catch { /* Mind offline / not logged in */ }   // first pass after a restart only remembers
    finally { running = false; }
  }, WATCH_EVERY).unref?.();
}

// ── routes ───────────────────────────────────────────────────────

export function mount(app: any, d: MindDeps = deps): void {
  if (d === deps) startWatch();   // the real server only — tests pass their own deps
  const token = () => d.config()?.token ?? "";
  // every handler: Mind errors → {ok:false, error} with our status; never echo the token
  const wrap = (f: (ctx: any) => Promise<any>) => async (ctx: any) => {
    try { return await f(ctx); }
    catch (e: any) {
      ctx.set.status = e instanceof MindError ? e.status : 500;
      return { ok: false, error: scrub(e instanceof MindError ? e.message : "ต่อ Mind ไม่ได้", token()) };
    }
  };
  const bad = (set: any, error: string, status = 400) => { set.status = status; return { ok: false, error }; };

  app.get("/mind/me", wrap(async () => ({ ok: true, ...(await getMe(d)) })));
  app.get("/mind/mail", wrap(async ({ query }) => ({ ok: true, ...(await getMail(query?.fresh === "1", d)).list })));
  app.get("/mind/mail/:id", wrap(async ({ params, set }) => {
    if (!ID_RE.test(params.id)) return bad(set, "id ไม่ถูกต้อง");
    let { raw, list } = await getMail(false, d), m = mailDetail(raw, params.id, list.email);
    if (!m) { ({ raw, list } = await getMail(true, d)); m = mailDetail(raw, params.id, list.email); }
    return m ? { ok: true, mail: m } : bad(set, "ไม่พบจดหมายนี้", 404);
  }));
  app.post("/mind/mail/mode", wrap(async ({ body, set }) => {
    const mode = String(body?.mode ?? "");
    if (!(MODES as readonly string[]).includes(mode)) return bad(set, "mode ต้องเป็น manual / semi / auto");
    const r = await mindApi("/api/mail/mode", { method: "POST", body: { mode } }, d);
    forget("/api/mail");
    return { ok: true, mode: String(r?.mode ?? mode), delivered: Number(r?.delivered) || 0 };
  }));
  app.post("/mind/mail/:id/act", wrap(async ({ params, body, set }) => {
    const op = String(body?.op ?? "");
    if (!ID_RE.test(params.id)) return bad(set, "id ไม่ถูกต้อง");
    if (!(OPS as readonly string[]).includes(op)) return bad(set, "op ต้องเป็น approve / reject / retry");
    await mindApi("/api/mail/act", { method: "POST", body: { id: params.id, op } }, d);
    forget("/api/mail");
    return { ok: true, id: params.id, op };
  }));

  app.get("/mind/chats", wrap(async ({ query }) => {
    const chats = normChats(await cached("/api/conversations", query?.fresh === "1", d));
    return { ok: true, chats, total: chats.length };
  }));
  app.get("/mind/chats/:id", wrap(async ({ params, query, set }) => {
    if (!ID_RE.test(params.id)) return bad(set, "id ไม่ถูกต้อง");
    return { ok: true, chat: normChat(await cached(`/api/conversations/${params.id}`, query?.fresh === "1", d)) };
  }));
  app.post("/mind/chats/:id/send", wrap(async ({ params, body, set }) => {
    if (!ID_RE.test(params.id)) return bad(set, "id ไม่ถูกต้อง");
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return bad(set, "ข้อความว่าง");
    if (text.length > TEXT_MAX) return bad(set, `ข้อความยาวเกิน ${TEXT_MAX} ตัวอักษร`);
    await mindApi(`/api/conversations/${params.id}/messages`, { method: "POST", body: { text, attachments: [] } }, d);
    forget("/api/conversations");   // the reply runs on Mind; the phone polls GET /mind/chats/:id?fresh=1
    return { ok: true };
  }));
  app.post("/mind/chats", wrap(async ({ set }) => {
    const c = await mindApi("/api/conversations", { method: "POST" }, d);
    if (!c || typeof c.id !== "string") return bad(set, "Mind ไม่ได้ส่ง id แชทกลับมา", 502);
    forget("/api/conversations");
    return { ok: true, id: c.id, title: String(c.title ?? "") || "แชทใหม่" };
  }));
}
