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

// the auto-off time survives a maw restart (otherwise a restart mid-trip would leave sleep disabled forever)
const STATE_FILE = join(homedir(), ".maw", "travel.json");
export function createTravel(run: Run = realRun, file: string | null = STATE_FILE) {
  const load = () => { try { return JSON.parse(readFileSync(file!, "utf-8")).until ?? null; } catch { return null; } };
  const save = () => { if (file) try { writeFileSync(file, JSON.stringify({ until }), { mode: 0o600 }); } catch { /* best effort */ } };
  let until: number | null = file ? load() : null, lastReason: string | null = null, timer: ReturnType<typeof setInterval> | null = null;
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
      const reason = safetyReason(await macHealth(), parseSpeedLimit((await run(PMSET, ["-g", "therm"])).out), until);
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
      lastReason = null; save();
      if (on) watch(); else if (timer) { clearInterval(timer); timer = null; }
      return this.status();
    },
  };
}

export function mount(app: any, travel = createTravel()): void {
  app.get("/system/travel", async () => ({ ok: true, ...(await travel.status()) }));
  app.post("/system/travel", async ({ body, set }: any) => {
    try { return { ok: true, ...(await travel.turn(!!body?.on, Number(body?.hours) || DEFAULT_HOURS)) }; }
    catch (e: any) { set.status = 409; return { ok: false, error: e.message }; }
  });
}
