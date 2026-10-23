// Feature pack "travel" — close the MacBook lid and keep agents running, driven from the phone.
// macOS only stops lid-close sleep with `pmset -a disablesleep 1` (root). A one-line sudoers rule
// (scripts/maw-travel.sudoers) lets maw run exactly that command and nothing else.
// Safety: auto-off on low battery (unplugged), on thermal throttling, and after a timer — then the Mac
// sleeps normally. The phone is told via push before that happens.
import { execFile } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { macHealth, notifyPhones } from "../api";

type Run = (cmd: string, args: string[]) => Promise<{ ok: boolean; out: string }>;
const realRun: Run = (cmd, args) => new Promise(res =>
  execFile(cmd, args, { timeout: 8_000 }, (err, stdout, stderr) => res({ ok: !err, out: String(stdout || stderr || "") })));

const PMSET = "/usr/bin/pmset", SUDO = "/usr/bin/sudo";
export const LOW_BATTERY = 15;            // % — below this while unplugged, let the Mac sleep
export const DEFAULT_HOURS = 8;

export function parseSleepDisabled(pmsetG: string): boolean { return /SleepDisabled\s+1/.test(pmsetG); }
/** `pmset -g therm` → lowest CPU speed limit in % (100 = not throttled), or null when nothing recorded. */
export function parseSpeedLimit(therm: string): number | null {
  const m = [...therm.matchAll(/CPU_Speed_Limit\s*=\s*(\d+)/g)].map(x => +x[1]);
  return m.length ? Math.min(...m) : null;
}
/** Why travel mode must switch itself off now, or null. */
export function safetyReason(h: { battery?: { pct: number; ac: boolean } | null }, speedLimit: number | null, until: number | null, now = Date.now()): string | null {
  if (until && now >= until) return "ครบเวลาที่ตั้งไว้";
  if (h.battery && !h.battery.ac && h.battery.pct <= LOW_BATTERY) return `แบตเหลือ ${h.battery.pct}% และไม่ได้เสียบสาย`;
  if (speedLimit != null && speedLimit < 70) return `เครื่องร้อนจนลดความเร็ว CPU เหลือ ${speedLimit}%`;
  return null;
}

/** `ioreg -r -k AppleClamshellState -d 1` → lid closed? (null = no lid / unreadable) */
export function parseLidClosed(ioreg: string): boolean | null {
  const m = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(ioreg); return m ? m[1] === "Yes" : null;
}
export const DESK_MINUTES = 15;
export interface DeskTrack { wasClosed: boolean; deskSince: number | null }
/**
 * Back at the desk = the lid was closed at some point since travel mode went on (a real trip), and now the lid
 * is open with the charger plugged in for DESK_MINUTES in a row. Turning it on at the desk before leaving never trips it.
 */
export function deskCheck(t: DeskTrack, lidClosed: boolean | null, ac: boolean | undefined, now = Date.now()): { t: DeskTrack; reason: string | null } {
  if (lidClosed) return { t: { wasClosed: true, deskSince: null }, reason: null };
  if (!t.wasClosed || lidClosed == null || !ac) return { t: { ...t, deskSince: null }, reason: null };
  const since = t.deskSince ?? now;
  return { t: { ...t, deskSince: since }, reason: now - since >= DESK_MINUTES * 60_000 ? `กลับมาที่โต๊ะแล้ว (เปิดจอ + เสียบสายชาร์จ ${DESK_MINUTES} นาที)` : null };
}

// the auto-off time survives a maw restart (otherwise a restart mid-trip would leave sleep disabled forever)
const STATE_FILE = join(homedir(), ".maw", "travel.json");
export function createTravel(run: Run = realRun, file: string | null = STATE_FILE) {
  const load = () => { try { return JSON.parse(readFileSync(file!, "utf-8")).until ?? null; } catch { return null; } };
  const save = () => { if (file) try { writeFileSync(file, JSON.stringify({ until }), { mode: 0o600 }); } catch { /* best effort */ } };
  let until: number | null = file ? load() : null, lastReason: string | null = null, timer: ReturnType<typeof setInterval> | null = null;
  let desk: DeskTrack = { wasClosed: false, deskSince: null };
  const sudoReady = async () => (await run(SUDO, ["-n", "-l", PMSET, "-a", "disablesleep", "1"])).ok;
  const isOn = async () => parseSleepDisabled((await run(PMSET, ["-g"])).out);
  const set = async (on: boolean) => {
    const r = await run(SUDO, ["-n", PMSET, "-a", "disablesleep", on ? "1" : "0"]);
    if (!r.ok) throw new Error("ยังไม่ได้ตั้งสิทธิ์ — รันคำสั่งติดตั้งบน Mac หนึ่งครั้งก่อน");
  };
  const watch = () => {
    if (timer) return;
    timer = setInterval(async () => {
      if (!(await isOn())) { clearInterval(timer!); timer = null; until = null; return; }
      const h = await macHealth();
      const d = deskCheck(desk, parseLidClosed((await run("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "1"])).out), h.battery?.ac);
      desk = d.t;
      const reason = safetyReason(h, parseSpeedLimit((await run(PMSET, ["-g", "therm"])).out), until) ?? d.reason;
      if (!reason) return;
      lastReason = reason;
      await notifyPhones("travel", "off", { title: "🧳 ปิดโหมดเดินทางแล้ว", body: `${reason} — Mac จะหลับเมื่อพับจอ` }).catch(() => 0);
      await set(false).catch(() => {});
      clearInterval(timer!); timer = null; until = null; save();
    }, 60_000);
  };
  return {
    async status() {
      const on = await isOn();
      if (on && !until) { until = Date.now() + DEFAULT_HOURS * 3600_000; save(); }
      if (on) watch();
      return { on, sudoReady: await sudoReady(), until, lastReason };
    },
    async turn(on: boolean, hours = DEFAULT_HOURS) {
      await set(on);
      until = on ? Date.now() + Math.min(Math.max(hours, 0.5), 24) * 3600_000 : null;
      desk = { wasClosed: false, deskSince: null };   // a new trip starts now
      lastReason = null; save();
      if (on) watch(); else if (timer) { clearInterval(timer); timer = null; }
      return this.status();
    },
    /** Add time while on — never switches sleep back on in between (with the lid shut the Mac would sleep at once). */
    async extend(hours: number) {
      if (!(await isOn())) throw new Error("โหมดเดินทางปิดอยู่ — เปิดก่อน");
      const add = Math.min(Math.max(hours, 0.5), 12) * 3600_000, now = Date.now();
      until = Math.min(Math.max(until ?? now, now) + add, now + 24 * 3600_000);
      lastReason = null; save(); watch();
      return this.status();
    },
  };
}

export function mount(app: any, travel = createTravel()): void {
  app.get("/system/travel", async () => ({ ok: true, ...(await travel.status()) }));
  app.post("/system/travel", async ({ body, set }: any) => {
    try {
      if (body?.add) return { ok: true, ...(await travel.extend(Number(body.add))) };
      return { ok: true, ...(await travel.turn(!!body?.on, Number(body?.hours) || DEFAULT_HOURS)) };
    }
    catch (e: any) { set.status = 409; return { ok: false, error: e.message }; }
  });
}
