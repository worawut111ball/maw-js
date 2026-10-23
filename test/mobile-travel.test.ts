import { describe, expect, test } from "bun:test";
import { createTravel, deskCheck, parseLidClosed, parseSleepDisabled, parseSpeedLimit, safetyReason } from "../src/mobile/features/travel";

describe("travel mode (close the lid, keep working)", () => {
  test("parsers", () => {
    expect(parseSleepDisabled(" SleepDisabled\t\t1\n sleep 1")).toBe(true);
    expect(parseSleepDisabled(" sleep 1 (sleep prevented by caffeinate)")).toBe(false);
    expect(parseSpeedLimit("Note: No thermal warning level has been recorded")).toBeNull();
    expect(parseSpeedLimit("CPU_Scheduler_Limit \t= 100\nCPU_Speed_Limit \t= 62")).toBe(62);
  });
  test("safety: low battery unplugged, throttling, timer — but not when charging", () => {
    expect(safetyReason({ battery: { pct: 12, ac: false } }, null, null)).toContain("12%");
    expect(safetyReason({ battery: { pct: 12, ac: true } }, null, null)).toBeNull();
    expect(safetyReason({ battery: { pct: 80, ac: false } }, 55, null)).toContain("55%");
    expect(safetyReason({ battery: null }, 100, 1000, 2000)).toBe("ครบเวลาที่ตั้งไว้");
    expect(safetyReason({ battery: { pct: 80, ac: false } }, 100, Date.now() + 1e6)).toBeNull();
  });
  test("runs exactly `sudo -n pmset -a disablesleep 1|0`, and explains when sudo isn't set up", async () => {
    const calls: string[] = []; let sleepOff = false, sudoOk = false;
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd.endsWith("pmset") && args[0] === "-g") return { ok: true, out: sleepOff ? "SleepDisabled 1" : "sleep 1" };
      if (args[0] === "-n" && args[1] === "-l") return { ok: sudoOk, out: "" };
      if (args[0] === "-n") { if (!sudoOk) return { ok: false, out: "sudo: a password is required" }; sleepOff = args.at(-1) === "1"; return { ok: true, out: "" }; }
      return { ok: true, out: "" };
    };
    const t = createTravel(run, null);
    await expect(t.turn(true)).rejects.toThrow(/ตั้งสิทธิ์/);
    sudoOk = true;
    const s = await t.turn(true, 2);
    expect(s.on).toBe(true); expect(s.sudoReady).toBe(true); expect(s.until! - Date.now()).toBeGreaterThan(7_100_000);
    expect(calls).toContain("/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1");
    expect((await t.turn(false)).on).toBe(false);
    expect(calls).toContain("/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0");
  });
});

test("auto-off time is kept across a restart", async () => {
  const f = require("path").join(require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "tr-")), "travel.json");
  let off = false;
  const run = async (cmd: string, args: string[]) => (args[0] === "-g" ? { ok: true, out: off ? "SleepDisabled 1" : "" } : (args[0] === "-n" && args[1] !== "-l" && (off = args.at(-1) === "1"), { ok: true, out: "" }));
  const a = await createTravel(run, f).turn(true, 3);
  const b = await createTravel(run, f).status();   // "maw restarted"
  expect(b.until).toBe(a.until);
});

test("extend adds time without ever switching sleep back on", async () => {
  let off = false; const calls: string[] = [];
  const run = async (cmd: string, args: string[]) => { calls.push(args.join(" ")); return args[0] === "-g" ? { ok: true, out: off ? "SleepDisabled 1" : "" } : (args[0] === "-n" && args[1] !== "-l" && (off = args.at(-1) === "1"), { ok: true, out: "" }); };
  const t = createTravel(run, null);
  await expect(t.extend(1)).rejects.toThrow(/ปิดอยู่/);
  const a = await t.turn(true, 1);
  calls.length = 0;
  const b = await t.extend(3);
  expect(b.until! - a.until!).toBeGreaterThan(3 * 3600_000 - 2_000);
  expect(calls.some(c => c.endsWith("disablesleep 0"))).toBe(false);
  expect((await t.extend(12)).until! - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
});

test("back at the desk: lid closed once, then open + charging 15 min → off; never before a real trip", () => {
  expect(parseLidClosed('    "AppleClamshellState" = Yes')).toBe(true);
  expect(parseLidClosed('    "AppleClamshellState" = No')).toBe(false);
  expect(parseLidClosed("")).toBeNull();
  const m = 60_000;
  let t = { wasClosed: false, deskSince: null as number | null };
  let r = deskCheck(t, false, true, 0);                 // turned on at the desk, lid open, charging
  expect(r.reason).toBeNull(); expect(r.t.deskSince).toBeNull();
  r = deskCheck(r.t, true, false, 10 * m);               // lid closed — on the road
  r = deskCheck(r.t, false, true, 60 * m);               // home: lid open, plugged in
  expect(r.reason).toBeNull();
  r = deskCheck(r.t, false, false, 70 * m);              // unplugged for a moment → timer restarts
  expect(r.t.deskSince).toBeNull();
  r = deskCheck(r.t, false, true, 71 * m);
  expect(deskCheck(r.t, false, true, 85 * m).reason).toBeNull();
  expect(deskCheck(r.t, false, true, 86 * m).reason).toContain("กลับมาที่โต๊ะ");
});
