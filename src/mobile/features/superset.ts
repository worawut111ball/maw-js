// Feature pack "superset" (P6) — Superset power features for the phone (PLAN-maw-mobile.md §9).
// New workspace + agent · automations · tasks · scripts · archive workspace · "why is it stuck" (agents explain).
// Every CLI call goes through `runner` (argv array, never a shell string) so tests can inject a mock.
import { execFile } from "child_process";
import { SUPERSET_BIN } from "./ctx";

// ── runner (injectable) ──────────────────────────────────────────

export type Runner = (args: string[], timeoutMs?: number) => Promise<string>;

/** Async so a slow `ws create` (worktree + agent boot) doesn't freeze the whole server like execFileSync would. */
const defaultRunner: Runner = (args, timeoutMs = 20_000) => new Promise((resolve, reject) => {
  execFile(SUPERSET_BIN, args, { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) { (err as any).stderr = stderr; return reject(err); }
    resolve(stdout);
  });
});
let runner: Runner = defaultRunner;
/** Tests only: swap the CLI for a mock. Pass null to restore the real CLI. */
export function setRunner(r: Runner | null): void { runner = r ?? defaultRunner; }

const CREATE_TIMEOUT = 120_000;

// ── validation (pure) ────────────────────────────────────────────

export const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RE_NAME = /^[\w.\-/ ]{1,80}$/;
export const RE_BRANCH = /^[\w.\-/]{1,100}$/;
export const RE_AGENT = /^[a-z0-9-]{1,40}$|^[0-9a-f-]{36}$/i;
export const RE_TASK = /^[\w.\-]{1,80}$/;
export const RE_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export const MAX_PROMPT = 4000;

export class BadInput extends Error {}
const need = (ok: boolean, msg: string) => { if (!ok) throw new BadInput(msg); };
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function vUuid(v: unknown, what = "id"): string { const s = str(v); need(RE_UUID.test(s), `${what} ไม่ถูกต้อง`); return s; }
export function vName(v: unknown): string {
  const s = str(v).trim();
  need(RE_NAME.test(s) && !s.startsWith("-"), "ชื่อใช้ได้เฉพาะ a-z 0-9 _ . - / เว้นวรรค (1–80 ตัว) และห้ามขึ้นต้นด้วย -");
  return s;
}
export function vBranch(v: unknown): string {
  const s = str(v).trim();
  need(RE_BRANCH.test(s) && !s.startsWith("-") && !s.includes(".."), "ชื่อ branch ไม่ถูกต้อง (a-z 0-9 _ . - / ไม่เกิน 100 ตัว)");
  return s;
}
export function vAgent(v: unknown): string { const s = str(v) || "claude"; need(RE_AGENT.test(s), "agent ไม่ถูกต้อง"); return s; }
export function vPrompt(v: unknown, required = true): string {
  const s = str(v).trim();
  if (!required && !s) return "";
  need(s.length > 0, "กรุณาพิมพ์คำสั่งแรกให้ agent");
  need(s.length <= MAX_PROMPT, `ข้อความยาวเกิน ${MAX_PROMPT} ตัวอักษร`);
  need(!s.startsWith("-"), "ข้อความห้ามขึ้นต้นด้วย -");
  return s;
}

/** Default branch from a workspace name: "Fix Login Bug" → "fix-login-bug". Thai-only names fall back to ws-YYYYMMDD-HHMM. */
export function slugBranch(name: string, now = new Date()): string {
  const s = String(name).toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/-+/g, "-").replace(/^[-./]+|[-./]+$/g, "").slice(0, 60);
  if (s) return s;
  const p = (n: number) => String(n).padStart(2, "0");
  return `ws-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

// ── schedules (pure) ─────────────────────────────────────────────

export type SchedulePreset = "daily" | "weekdays" | "weekly";

export function buildRrule(preset: SchedulePreset, time: string, day = "MO"): string {
  const m = RE_TIME.exec(time); need(!!m, "เวลาไม่ถูกต้อง (HH:MM)");
  const at = `BYHOUR=${+m![1]};BYMINUTE=${+m![2]}`;
  if (preset === "daily") return `FREQ=DAILY;${at}`;
  if (preset === "weekdays") return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;${at}`;
  if (preset === "weekly") { need((DAYS as readonly string[]).includes(day), "วันไม่ถูกต้อง"); return `FREQ=WEEKLY;BYDAY=${day};${at}`; }
  throw new BadInput("รูปแบบเวลาไม่ถูกต้อง");
}

const DAY_TH: Record<string, string> = { MO: "จันทร์", TU: "อังคาร", WE: "พุธ", TH: "พฤหัสบดี", FR: "ศุกร์", SA: "เสาร์", SU: "อาทิตย์" };

/** RRULE → plain Thai ("ทุกวัน 02:00", "ทุกวันทำการ 09:00", "ทุกวันจันทร์ 09:00"). Unknown shapes return null. */
export function describeRrule(rrule: string | null | undefined): string | null {
  if (!rrule) return null;
  const kv: Record<string, string> = {};
  for (const part of String(rrule).replace(/^RRULE:/i, "").split(";")) { const [k, v] = part.split("="); if (k && v) kv[k.toUpperCase()] = v.toUpperCase(); }
  const hh = kv.BYHOUR, mm = kv.BYMINUTE ?? "0";
  const time = hh != null && /^\d+$/.test(hh) && /^\d+$/.test(mm) ? ` ${hh.padStart(2, "0")}:${mm.padStart(2, "0")}` : "";
  const iv = kv.INTERVAL && kv.INTERVAL !== "1" ? kv.INTERVAL : null;
  switch (kv.FREQ) {
    case "MINUTELY": return iv ? `ทุก ${iv} นาที` : "ทุกนาที";
    case "HOURLY": return (iv ? `ทุก ${iv} ชั่วโมง` : "ทุกชั่วโมง") + (kv.BYMINUTE ? ` (นาทีที่ ${kv.BYMINUTE})` : "");
    case "DAILY": return (iv ? `ทุก ${iv} วัน` : "ทุกวัน") + time;
    case "WEEKLY": {
      const days = (kv.BYDAY ?? "").split(",").filter(Boolean);
      const pre = iv ? `ทุก ${iv} สัปดาห์ ` : "";
      if (days.join(",") === "MO,TU,WE,TH,FR") return `${pre}ทุกวันทำการ (จ–ศ)${time}`;
      if (days.length === 7) return `${pre}ทุกวัน${time}`;
      if (days.length && days.every(d => DAY_TH[d])) return `${pre || "ทุก"}วัน${days.map(d => DAY_TH[d]).join(", ")}${time}`;
      return `${pre || "ทุกสัปดาห์"}${time}`.trim();
    }
    case "MONTHLY": return `ทุกเดือน${kv.BYMONTHDAY ? ` วันที่ ${kv.BYMONTHDAY}` : ""}${time}`;
    default: return null;
  }
}

// ── argv builders (pure — tests assert these exactly) ────────────

export function argvCreateWorkspace(b: { projectId: string; name: string; branch: string; agent: string; prompt: string; task?: string }): string[] {
  const a = ["workspaces", "create", "--local", "--project", b.projectId, "--name", b.name];
  if (b.branch) a.push("--branch", b.branch);
  if (b.task) a.push("--task", b.task);
  a.push("--agent", b.agent, "--prompt", b.prompt, "--json");
  return a;
}
export const argvArchive = (ws: string) => ["workspaces", "archive", ws, "--local", "--json"];
export const argvExplain = (ws: string, term: string) => ["agents", "explain", "--local", "--workspace", ws, "--terminal", term, "--json"];
export function argvCreateAutomation(b: { name: string; projectId: string; rrule: string; prompt: string; agent: string }): string[] {
  return ["automations", "create", "--name", b.name, "--local", "--project", b.projectId, "--rrule", b.rrule, "--agent", b.agent, "--prompt", b.prompt, "--json"];
}
export const argvAutomationAction = (action: "pause" | "resume" | "delete", id: string) => ["automations", action, id, "--json"];
export const argvRunScript = (ws: string, command: string) => ["terminals", "create", "--local", "--workspace", ws, "--command", command, "--json"];

// ── output parsing (pure) ────────────────────────────────────────

export function parseJson(out: string): any {
  let d: any;
  try { d = JSON.parse(out); } catch { return null; }
  // Some commands wrap as { data, message } — unwrap only that exact envelope.
  if (d && typeof d === "object" && !Array.isArray(d) && "data" in d && Object.keys(d).every(k => k === "data" || k === "message")) return d.data;
  return d;
}
const arr = (d: any, key?: string): any[] => Array.isArray(d) ? d : Array.isArray(d?.[key ?? ""]) ? d[key!] : Array.isArray(d?.items) ? d.items : [];

/** `ws create --json` → the new workspace id and the agent's terminal (if the CLI reported one). */
export function parseCreated(d: any): { workspaceId: string | null; terminalId: string | null } {
  const ws = d?.workspace ?? d;
  const workspaceId = typeof ws?.id === "string" ? ws.id : null;
  let terminalId: string | null = null;
  for (const list of [d?.agents, d?.sessions, d?.terminals, ws?.terminals]) {
    for (const x of Array.isArray(list) ? list : []) {
      const id = x?.terminalId ?? x?.sessionId ?? x?.id;
      if (typeof id === "string" && RE_UUID.test(id)) { terminalId = id; break; }
    }
    if (terminalId) break;
  }
  if (!terminalId) for (const k of ["terminalId", "sessionId"]) if (typeof d?.[k] === "string") { terminalId = d[k]; break; }
  return { workspaceId, terminalId };
}

export function normalizeAutomation(a: any) {
  return {
    id: String(a?.id ?? ""), name: String(a?.name ?? "(ไม่มีชื่อ)"), agent: a?.agent ?? a?.agentPresetId ?? null,
    rrule: a?.rrule ?? null,
    schedule: describeRrule(a?.rrule) ?? a?.scheduleText ?? (a?.rrule ? String(a.rrule) : "ตาม event (trigger)"),
    nextRunAt: a?.nextRunAt ?? null, timezone: a?.timezone ?? null,
    enabled: a?.enabled !== false && !a?.paused,
  };
}

export function normalizeTask(t: any) {
  const status = t?.status?.name ?? t?.statusName ?? t?.state?.name ?? (typeof t?.status === "string" ? t.status : null) ?? t?.statusId ?? null;
  return { id: String(t?.id ?? ""), slug: t?.slug ?? null, title: String(t?.title ?? "(ไม่มีชื่อ)"), status, priority: t?.priority ?? null, assignee: t?.assignee ?? null };
}

/** A script's commands → one shell line for `terminals create --command` (the CLI itself runs it in a shell). */
export function scriptCommand(s: any): string | null {
  const cmds = (Array.isArray(s?.commands) ? s.commands : [s?.command]).filter((c: unknown) => typeof c === "string" && c.trim());
  return cmds.length ? cmds.join(" && ") : null;
}

/** CLI failure → short readable Thai. */
export function thaiError(e: any): string {
  const raw = String(e?.stderr || e?.message || e || "").replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (e?.code === "ENOENT") return "ไม่พบ Superset CLI บน Mac (~/.superset/bin/superset)";
  if (e?.killed || /ETIMEDOUT|timed out/i.test(raw)) return "Superset ตอบช้าเกินไป ลองใหม่อีกครั้ง";
  if (/No active organization|auth login|unauthori[sz]ed/i.test(raw)) return "Superset ยังไม่ได้ login บน Mac (superset auth login)";
  if (/ECONNREFUSED|not running|host service/i.test(raw)) return "Superset host service ไม่ทำงาน — เปิดแอป Superset บน Mac ก่อน";
  if (/not found|no such|does not exist/i.test(raw)) return "Superset หาไม่เจอ: " + firstLine(raw);
  if (/already exists/i.test(raw)) return "มีอยู่แล้ว: " + firstLine(raw);
  return "Superset แจ้งว่า: " + (firstLine(raw) || "ผิดพลาดไม่ทราบสาเหตุ");
}
const firstLine = (s: string) => (s.split("\n").map(x => x.replace(/^(Error|error):\s*/, "").trim()).find(Boolean) ?? "").slice(0, 200);

// ── routes ───────────────────────────────────────────────────────

async function call(args: string[], timeoutMs?: number): Promise<any> { return parseJson(await runner(args, timeoutMs)); }

/** Wrap a handler: BadInput → 400 Thai text, CLI failure → 502 Thai text. */
const handle = (fn: (ctx: any) => Promise<any>) => async (ctx: any) => {
  try { return { ok: true, ...(await fn(ctx)) }; }
  catch (e: any) {
    if (e instanceof BadInput) { ctx.set.status = 400; return { ok: false, error: e.message }; }
    ctx.set.status = 502; return { ok: false, error: thaiError(e) };
  }
};
const bodyOf = (ctx: any) => (ctx.body && typeof ctx.body === "object" ? ctx.body : {});

async function scriptsList(): Promise<any[]> { return arr(await call(["scripts", "list", "--json"]), "scripts"); }

export function mount(app: any): void {
  // Everything the tab needs about the open workspace: its Superset project, all projects, agent presets.
  app.get("/superset/workspaces/:ws/meta", handle(async ({ params }) => {
    const ws = vUuid(params.ws, "workspace");
    const [w, projects, agents] = await Promise.all([
      call(["workspaces", "get", ws, "--local", "--json"]).catch(() => null),
      call(["projects", "list", "--local", "--json"]).catch(() => []),
      call(["agents", "list", "--local", "--json"]).catch(() => []),
    ]);
    return {
      workspace: w ? { id: w.id, name: w.name ?? null, branch: w.branch ?? null, type: w.type ?? null, projectId: w.projectId ?? null, projectName: w.projectName ?? null } : null,
      projects: arr(projects, "projects").map((p: any) => ({ id: String(p.id), name: String(p.name ?? p.id) })),
      agents: arr(agents, "agents").map((a: any) => ({ id: String(a.presetId ?? a.id), label: String(a.label ?? a.presetId ?? a.id) })),
    };
  }));

  // A. new workspace + agent
  app.post("/superset/workspaces", handle(async (ctx) => {
    const b = bodyOf(ctx);
    const name = vName(b.name);
    const args = argvCreateWorkspace({
      projectId: vUuid(b.projectId, "project"), name,
      branch: b.branch ? vBranch(b.branch) : slugBranch(name),
      agent: vAgent(b.agent), prompt: vPrompt(b.prompt),
    });
    const d = await call(args, CREATE_TIMEOUT);
    return { ...parseCreated(d), alreadyExists: !!d?.alreadyExists };
  }));

  // E. archive the workspace (worktree folder + uncommitted changes go, branch stays)
  app.post("/superset/workspaces/:ws/archive", handle(async ({ params }) => {
    const ws = vUuid(params.ws, "workspace");
    const w = await call(["workspaces", "get", ws, "--local", "--json"]);
    need(w?.type !== "local", "นี่คือ workspace หลักของโปรเจค (checkout เดิม) — ไม่เก็บจากมือถือ");
    await call(argvArchive(ws), 60_000);
    return {};
  }));

  // B. automations
  app.get("/superset/automations", handle(async () => ({ automations: arr(await call(["automations", "list", "--json"]), "automations").map(normalizeAutomation) })));
  app.post("/superset/automations", handle(async (ctx) => {
    const b = bodyOf(ctx);
    need(["daily", "weekdays", "weekly"].includes(b.preset), "เลือกรอบเวลา");
    const args = argvCreateAutomation({
      name: vName(b.name), projectId: vUuid(b.projectId, "project"),
      rrule: buildRrule(b.preset, str(b.time), str(b.day) || "MO"),
      agent: vAgent(b.agent), prompt: vPrompt(b.prompt),
    });
    const d = await call(args, 60_000);
    return { automation: d && typeof d === "object" ? normalizeAutomation(d) : null };
  }));
  app.post("/superset/automations/:id/:action", handle(async ({ params }) => {
    const id = vUuid(params.id, "automation");
    need(["pause", "resume", "delete"].includes(params.action), "คำสั่งไม่ถูกต้อง");
    await call(argvAutomationAction(params.action as "pause" | "resume" | "delete", id));
    return {};
  }));

  // C. tasks (+ start an agent on one = a new workspace linked with --task)
  app.get("/superset/tasks", handle(async () => ({ tasks: arr(await call(["tasks", "list", "--limit", "30", "--json"]), "tasks").map(normalizeTask) })));
  app.post("/superset/tasks/:id/start", handle(async (ctx) => {
    const b = bodyOf(ctx);
    const task = str(ctx.params.id); need(RE_TASK.test(task) && !task.startsWith("-"), "task ไม่ถูกต้อง");
    const name = vName(b.name);
    const args = argvCreateWorkspace({
      projectId: vUuid(b.projectId, "project"), name,
      branch: b.branch ? vBranch(b.branch) : "", // empty → the task's own branch name
      task, agent: vAgent(b.agent), prompt: vPrompt(b.prompt),
    });
    return parseCreated(await call(args, CREATE_TIMEOUT));
  }));

  // D. scripts / presets — run one in a new terminal of this workspace
  app.get("/superset/scripts", handle(async ({ query }) => {
    const pid = query?.projectId ? vUuid(query.projectId, "project") : null;
    const list = (await scriptsList()).filter((s: any) => !pid || !Array.isArray(s.projectIds) || s.projectIds.includes(pid));
    return { scripts: list.map((s: any) => ({ id: String(s.id), name: String(s.name ?? s.id), description: s.description ?? "", command: scriptCommand(s) })).filter((s: any) => s.command) };
  }));
  app.post("/superset/workspaces/:ws/scripts/:id/run", handle(async ({ params }) => {
    const ws = vUuid(params.ws, "workspace"), id = vUuid(params.id, "script");
    const s = (await scriptsList()).find((x: any) => x.id === id);
    need(!!s, "ไม่พบ script นี้แล้ว");
    const cmd = scriptCommand(s); need(!!cmd, "script นี้ไม่มีคำสั่ง");
    const d = await call(argvRunScript(ws, cmd!), 30_000);
    const tid = d?.terminalId ?? d?.sessionId ?? d?.id ?? null;
    return { terminalId: typeof tid === "string" ? tid : null };
  }));

  // F. why is this agent stuck?
  app.get("/superset/rooms/:ws/:room/explain", handle(async ({ params }) => {
    const d = await call(argvExplain(vUuid(params.ws, "workspace"), vUuid(params.room, "room")));
    return { explain: d ?? {} };
  }));
}
