import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdtempSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULTS, retroDue, validateSettings, workedMinutes, foldLines, runRetro, retroPass, mount, loadFile, saveFile, fmtMin,
  type RetroDeps, type RetroFile, type Activity,
} from "../src/mobile/features/retro";

const MIN = 60_000, NOW = Date.parse("2026-10-22T12:00:00Z");
const S = { ...DEFAULTS, minMinutes: 30, idleMinutes: 10 };

describe("retro due logic", () => {
  const base = { status: "done" as const, workedMin: 45, lastActivityAt: NOW - 15 * MIN, lastRetroAt: null };
  test("due after enough work and enough idle", () => expect(retroDue(base, S, NOW).due).toBe(true));
  test("not while working / waiting / ended", () => {
    for (const status of ["working", "waiting", "ended"] as const) expect(retroDue({ ...base, status }, S, NOW).due).toBe(false);
  });
  test("not before minMinutes of work, not before idleMinutes of quiet", () => {
    expect(retroDue({ ...base, workedMin: 29 }, S, NOW).why).toBe("ทำงาน 29/30 นาที");
    expect(retroDue({ ...base, lastActivityAt: NOW - 4 * MIN }, S, NOW).why).toBe("รอว่างอีก 6 นาที");
  });
  test("not again after a retro, nor twice for the same activity", () => {
    expect(retroDue({ ...base, lastRetroAt: NOW - 14 * MIN }, S, NOW).due).toBe(false);
    expect(retroDue({ ...base, handled: base.lastActivityAt }, S, NOW).why).toBe("แจ้งไปแล้ว");
    expect(retroDue({ ...base, handled: base.lastActivityAt - MIN }, S, NOW).due).toBe(true);   // new activity = new period
  });
});

describe("worked minutes from transcript timestamps", () => {
  test("gaps ≤ 5 min count, longer silences count 1, only after the last retro", () => {
    const m = [100, 101, 103, 120, 121];         // 1 + 1 + 2 + 1 (gap 17) + 1
    expect(workedMinutes(m, null)).toBe(6);
    expect(workedMinutes(m, 103 * MIN + 30_000)).toBe(2);
  });
  test("foldLines picks activity, cwd and typed /rrr", () => {
    const a: Activity = { minutes: [], lastTs: null, retros: [], cwd: null };
    const ts = (min: number) => new Date(NOW + min * MIN).toISOString();
    foldLines(a, [
      JSON.stringify({ type: "user", timestamp: ts(0), cwd: "/x/maw-js", message: { content: "hi" } }),
      JSON.stringify({ type: "assistant", timestamp: ts(2), message: { content: [{ type: "text", text: "ok" }] } }),
      JSON.stringify({ type: "file-history-snapshot", timestamp: ts(3) }),
      JSON.stringify({ type: "user", timestamp: ts(4), message: { content: "<command-name>/rrr</command-name>\n<command-args></command-args>" } }),
      "{broken",
    ]);
    expect(a.minutes.length).toBe(3); expect(a.cwd).toBe("/x/maw-js");
    expect(a.retros).toEqual([NOW + 4 * MIN]); expect(a.lastTs).toBe(NOW + 4 * MIN);
  });
  test("fmtMin", () => { expect(fmtMin(45)).toBe("45 นาที"); expect(fmtMin(120)).toBe("2 ชม."); expect(fmtMin(95)).toBe("1 ชม. 35 นาที"); });
});

describe("settings", () => {
  test("validation", () => {
    expect(validateSettings({ mode: "auto", skill: "mind-rrr", minMinutes: 60, idleMinutes: 5 })).toEqual({ ok: true, settings: { mode: "auto", skill: "mind-rrr", minMinutes: 60, idleMinutes: 5 } });
    expect(validateSettings({ mode: "always" }).ok).toBe(false);
    expect(validateSettings({ skill: "rm -rf" }).ok).toBe(false);
    expect(validateSettings({ minMinutes: 2 }).ok).toBe(false);
    expect(validateSettings({ idleMinutes: 1.5 }).ok).toBe(false);
    expect(validateSettings({ minMinutes: "30" }).ok).toBe(false);
  });
  test("file is 0600 and a broken file falls back to manual", () => {
    const f = join(mkdtempSync(join(tmpdir(), "retro-")), "retro.json");
    expect(loadFile(f).mode).toBe("manual");
    saveFile({ ...DEFAULTS, mode: "semi", sessions: { a: { lastRetroAt: 1, lastActivityAt: 2 } } }, f);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(loadFile(f).mode).toBe("semi"); expect(loadFile(f).sessions.a.lastRetroAt).toBe(1);
    saveFile({ ...DEFAULTS, mode: "bogus" as any, sessions: {} }, f);
    expect(loadFile(f).mode).toBe("manual");
  });
});

// ── fake world: one live Claude room, a fake screen, a fake typist ──
const IDLE_SCREEN = "⏺ done\n\n────────\n❯ \n────────\n  ? for shortcuts";
const DIALOG_SCREEN = "╭────────────────╮\n│ Bash command    │\n│ rm x            │\n│ Do you want to proceed? │\n│ ❯ 1. Yes │\n│   2. No │\n╰────────────────╯";
function world(over: Partial<{ status: string; hook: any; screen: string; mode: string; skills: string[] }> = {}) {
  const typed: string[] = [], pushes: any[] = [];
  let file: RetroFile = { ...DEFAULTS, mode: (over.mode ?? "manual") as any, sessions: {} };
  let screen = over.screen ?? IDLE_SCREEN;
  const act: Activity = { minutes: Array.from({ length: 40 }, (_, i) => Math.floor((NOW - 60 * MIN) / MIN) + i), lastTs: NOW - 20 * MIN, retros: [], cwd: "/p/maw-js" };
  const d: RetroDeps = {
    rooms: () => new Map([["sess-aaaa-1111", { pid: 1, sessionId: "sess-aaaa-1111", status: over.status ?? "idle", name: "main", channel: { kind: "tmux", pane: "%1", label: "t1" } as any }]]),
    read: async () => screen,
    type: async (_ch, t) => { typed.push(t); },
    notify: async (sid, kind, msg) => { pushes.push({ sid, kind, ...msg }); },
    hook: () => over.hook,
    activity: () => act,
    skillExists: n => (over.skills ?? ["rrr", "mind-rrr"]).includes(n),
    load: () => structuredClone(file),
    save: f => { file = structuredClone(f); },
    now: () => NOW,
  };
  return { d, typed, pushes, get file() { return file; }, setScreen: (s: string) => { screen = s; } };
}

describe("run refuses when the room is not free", () => {
  test("idle room → types /rrr and records the time", async () => {
    const w = world();
    expect(await runRetro(w.d, "sess-aaaa-1111", "rrr")).toEqual({ ok: true, skill: "rrr" });
    expect(w.typed).toEqual(["/rrr"]);
    expect(w.file.sessions["sess-aaaa-1111"].lastRetroAt).toBe(NOW);
  });
  test("busy (room status or hook) → 409, nothing typed", async () => {
    for (const w of [world({ status: "busy" }), world({ hook: { status: "working", at: NOW - MIN } }), world({ hook: { status: "waiting", at: NOW - MIN } })]) {
      const r = await runRetro(w.d, "sess-aaaa-1111", "rrr");
      expect(r.ok).toBe(false); expect((r as any).code).toBe(409); expect(w.typed).toEqual([]);
    }
  });
  test("open dialog / spinner / half-typed text on screen → 409", async () => {
    for (const screen of [DIALOG_SCREEN, "✻ Moonwalking… (12s · ↓ 3k tokens)\n❯ ", "❯ \x1b[0mhalf typed message\x1b[0m"]) {
      const w = world({ screen });
      const r = await runRetro(w.d, "sess-aaaa-1111", "rrr");
      expect(r.ok).toBe(false); expect(w.typed).toEqual([]);
    }
  });
  test("missing skill → 400, unknown room → 404", async () => {
    const w = world({ skills: ["rrr"] });
    expect((await runRetro(w.d, "sess-aaaa-1111", "mind-rrr") as any).code).toBe(400);
    expect((await runRetro(w.d, "nope-0000-0000", "rrr") as any).code).toBe(404);
  });
  test("second run right after the first is refused", async () => {
    const w = world();
    await runRetro(w.d, "sess-aaaa-1111", "rrr");
    expect((await runRetro(w.d, "sess-aaaa-1111", "rrr") as any).error).toContain("เพิ่งสั่ง");
    expect(w.typed.length).toBe(1);
  });
});

describe("loop", () => {
  test("manual: nothing automatic", async () => {
    const w = world();
    expect(await retroPass(w.d)).toEqual({ notified: [], ran: [] });
    expect(w.typed).toEqual([]); expect(w.pushes).toEqual([]);
  });
  test("semi: one push per due period, no conversation text, never types", async () => {
    const w = world({ mode: "semi" });
    expect((await retroPass(w.d)).notified).toEqual(["sess-aaaa-1111"]);
    expect((await retroPass(w.d)).notified).toEqual([]);
    expect(w.typed).toEqual([]);
    expect(w.pushes.length).toBe(1);
    expect(w.pushes[0].title).toBe("📝 สรุปงานไหม · t1 · maw-js");
    expect(w.pushes[0].body).toMatch(/^ทำงานไป 40 นาที/);
  });
  test("auto: runs once, never twice, never into a dialog", async () => {
    const w = world({ mode: "auto", screen: DIALOG_SCREEN });
    expect((await retroPass(w.d)).ran).toEqual([]);           // dialog open → wait
    w.setScreen(IDLE_SCREEN);
    expect((await retroPass(w.d)).ran).toEqual(["sess-aaaa-1111"]);
    expect((await retroPass(w.d)).ran).toEqual([]);
    expect((await retroPass(w.d)).ran).toEqual([]);
    expect(w.typed).toEqual(["/rrr"]);
    expect(w.pushes.map(p => p.title)).toEqual(["📝 สั่ง /rrr แล้ว · t1 · maw-js"]);
  });
  test("auto: skips a working room", async () => {
    const w = world({ mode: "auto", status: "busy" });
    expect((await retroPass(w.d)).ran).toEqual([]); expect(w.typed).toEqual([]);
  });
});

describe("routes", () => {
  const j = (x: any) => JSON.stringify(x);
  const setup = (over = {}) => {
    const w = world(over), app = new Elysia({ prefix: "/mobile" });
    mount(app, w.d);
    const call = (p: string, body?: any) => app.handle(new Request(`http://local/mobile${p}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: j(body) }));
    return { w, call };
  };
  test("GET /retro lists rooms with worked minutes and due flag", async () => {
    const { call } = setup();
    const r = await (await call("/retro")).json();
    expect(r.settings).toEqual(DEFAULTS);
    expect(r.skills).toEqual([{ name: "rrr", available: true }, { name: "mind-rrr", available: true }]);
    expect(r.rooms[0]).toMatchObject({ sessionId: "sess-aaaa-1111", ws: "tmux", room: "%1", project: "maw-js", workedMin: 40, due: true });
  });
  test("POST /retro/settings validates", async () => {
    const { call } = setup();
    expect((await call("/retro/settings", { mode: "nope" })).status).toBe(400);
    const r = await (await call("/retro/settings", { mode: "semi", skill: "mind-rrr" })).json();
    expect(r.settings.mode).toBe("semi"); expect(r.settings.skill).toBe("mind-rrr");
  });
  test("POST /retro/run by ws+room, 409 in Thai when busy", async () => {
    const ok = setup();
    const r = await ok.call("/retro/run", { ws: "tmux", room: "%1" });
    expect(r.status).toBe(200); expect(ok.w.typed).toEqual(["/rrr"]);
    const busy = setup({ status: "busy" });
    const b = await busy.call("/retro/run", { sessionId: "sess-aaaa-1111" });
    expect(b.status).toBe(409); expect((await b.json()).error).toContain("กำลังทำงาน");
    expect((await busy.call("/retro/run", {})).status).toBe(400);
  });
});
