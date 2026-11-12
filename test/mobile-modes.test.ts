import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseMode, parseEffortText, footerLines, readModelInfo, mount, MODEL_ALIASES, EFFORT_LEVELS, type ModesDeps } from "../src/mobile/features/modes";

const E = "\x1b";
const rule = `${E}[38;5;244m${"─".repeat(80)}${E}[39m`;
const status = [
  `  ${E}[38;5;246m📁 ${E}[38;5;117m~/oracle/ψ/incubate/Artron-Innovative-Co-Ltd/factorypro${E}[38;5;246m  ${E}[38;5;114mmain*${E}[39m`,
  `  ${E}[38;5;246m📄 ${E}[2mddcc62775426b5c5${E}[0m${E}[38;5;246m → ${E}[38;5;245m • 17:52 • 57% 570k/1000k • ${E}[38;5;253mOpus 5.5 (1M context) (1M con…${E}[39m`,
  `  ${E}[38;5;246m⚡ ${E}[38;5;177meffort:medium${E}[38;5;245m • ${E}[38;5;177m🧠 thinking${E}[39m`,
];
/** A tmux capture of a Claude Code pane (ANSI kept), the same shape as `tmux capture-pane -e -p`. */
const pane = (modeLine: string | null, body = "⏺ เสร็จแล้วครับ") => [
  body,
  "",
  `${E}[38;5;246m✻ Worked for 30s · done 5:48 PM${E}[39m`,
  rule,
  `${E}[39m❯ ${E}[2mไปต่อเลย${E}[0m`,
  rule,
  ...status,
  ...(modeLine === null ? [] : [modeLine]),
  "", "",
].join("\n");

const BYPASS = `  ${E}[38;5;211m⏵⏵ bypass permissions on${E}[38;5;246m (shift+tab to cycle)${E}[39m`;
const PLAN = `  ${E}[38;5;37m⏸ plan mode on${E}[38;5;246m (shift+tab to cycle)${E}[39m`;
const ACCEPT = `  ${E}[38;5;141m⏵⏵ accept edits on${E}[38;5;246m (shift+tab to cycle) · ← 3 agents${E}[39m`;
const AUTO = `  ${E}[38;5;220m⏵⏵ auto mode on${E}[38;5;246m (shift+tab to cycle)${E}[39m`;

// Superset's reader returns plain text, and the right edge of the rule is sometimes mangled.
const supersetPlain = [
  "❯ /rrr",
  "──────────────────────────────────────────────�",
  "  📁 g~/artron/artton-home  main",
  "  📄 3e9e69ea53bba51e2→  • 137103• 123 1234/1000k • Opus 5.5 (1M context) (1M context) • $781461• +2691-13",
  "  ⚡ 57d 823% • effort:high • 🧠 thinking",
  "  ⏵⏵ bypass permissions on · 1 shell · ← 3 agents",
].join("\n");

const codexScreen = [
  "• รับทราบครับ บันทึกผล ทดสอบทั้ง 5 ข้อผ่าน",
  "  Worked for 16s • 10:32",
  "› Ask Codex to do anything",
  "  GPT-6-Astra medium · Fast off · weekly 0% left · Context 46% used · Main [default]",
  "  ? for shortcuts                                                   ⚠ 3 warnings · f2 to view",
].join("\n");

describe("parseMode", () => {
  test("real Claude Code footers (tmux, ANSI)", () => {
    expect(parseMode(pane(BYPASS))).toBe("bypass");
    expect(parseMode(pane(PLAN))).toBe("plan");
    expect(parseMode(pane(ACCEPT))).toBe("acceptEdits");
    expect(parseMode(pane(AUTO))).toBe("auto");
    expect(parseMode(pane(`  ${E}[38;5;246m? for shortcuts${E}[39m`))).toBe("default");
    expect(parseMode(pane(null))).toBe("default");
  });

  test("Superset plain text", () => {
    expect(parseMode(supersetPlain)).toBe("bypass");
    expect(parseMode(supersetPlain.replace("⏵⏵ bypass permissions on", "⏸ plan mode on"))).toBe("plan");
  });

  test("only the footer counts — mode words in the conversation are ignored", () => {
    const talk = "⏸ plan mode on (shift+tab to cycle)\n⏵⏵ accept edits on\nพี่ลอง plan mode on ดู";
    expect(parseMode(pane(null, talk))).toBe("default");
    expect(parseMode(pane(BYPASS, talk))).toBe("bypass");
  });

  test("Codex, plain shells and open dialogs → unknown", () => {
    expect(parseMode(codexScreen)).toBe("unknown");
    expect(parseMode("ball@MacBook-Air facwms % ")).toBe("unknown");
    expect(parseMode("")).toBe("unknown");
    const dialog = ["⏺ Bash(rm -rf build)", rule, " Do you want to proceed?", " ❯ 1. Yes", "   2. No", rule, "  Esc to cancel"].join("\n");
    // the last rule closes a permission dialog whose menu cursor (" ❯ 1. Yes") is indented → not the input box
    expect(footerLines(dialog)).toBeNull();
    expect(parseMode(dialog)).toBe("unknown");
  });

  test("a multi-line draft in the input box still finds the footer", () => {
    const raw = ["hi", rule, "❯ บรรทัดแรก", "  บรรทัดสอง", "  บรรทัดสาม", rule, PLAN].join("\n");
    expect(parseMode(raw)).toBe("plan");
  });
});

describe("effort / model info", () => {
  test("effort from the status line text", () => {
    expect(parseEffortText(pane(BYPASS))).toBe("medium");
    expect(parseEffortText(supersetPlain)).toBe("high");
    expect(parseEffortText(codexScreen)).toBeNull();
  });

  test("status JSON (same shape as ~/.maw/status/<sid>.json)", () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-modes-"));
    const sid = "a34a3542-9801-48d7-ab41-09f97dd3baab";
    writeFileSync(join(dir, sid + ".json"), JSON.stringify({
      session_id: sid, model: { id: "claude-opus-5-5[1m]", display_name: "Opus 5.5 (1M context)" },
      effort: { level: "medium" }, output_style: { name: "default" }, thinking: { enabled: true }, fast_mode: false,
      context_window: { context_window_size: 1_000_000, used_percentage: 50 },
    }));
    expect(readModelInfo(sid, dir)).toEqual({ model: "Opus 5.5 (1M context)", modelId: "claude-opus-5-5[1m]", effort: "medium", fast: false });
    expect(readModelInfo("../../etc/passwd", dir).model).toBeNull();
    expect(readModelInfo("missing-session-id", dir)).toEqual({ model: null, modelId: null, effort: null, fast: null });
    expect(readModelInfo(undefined, dir).model).toBeNull();
  });

  test("allow-lists", () => {
    expect(MODEL_ALIASES).toContain("opus[1m]");
    expect(MODEL_ALIASES).toContain("default");
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max", "auto"]);
  });
});

describe("routes", () => {
  function setup(screens: string[], statusDir?: string) {
    const calls: string[] = [];
    let n = 0;
    const deps: ModesDeps = {
      roomChannel: (ws, room) => ws === "tmux" && /^%\d+$/.test(room) ? { kind: "tmux", pane: room, label: room } : null,
      readScreen: async () => screens[Math.min(n++, screens.length - 1)],
      pressKey: async (_ch, k) => { calls.push("key:" + k); },
      typeInto: async (_ch, t) => { calls.push("type:" + t); },
      wait: async () => {},
      statusDir,
      switchable: ch => ch.kind === "tmux" && ch.pane === "%7",   // %7 = a claude-switch room
      gptModels: () => ["gpt-6-astra", "gpt-6.1-sol"],
    };
    const app = new Elysia({ prefix: "/mobile" });
    mount(app, deps);
    const req = (path: string, body?: any) => app.handle(new Request("http://local/mobile" + path, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return { req, calls };
  }

  test("GET mode reads the footer + status JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-modes-"));
    writeFileSync(join(dir, "sess-1234-abcd.json"), JSON.stringify({ model: { id: "claude-sonnet-5", display_name: "Sonnet 5" }, effort: { level: "high" } }));
    const { req } = setup([pane(PLAN)], dir);
    const r = await (await req("/rooms/tmux/%252/mode?sid=sess-1234-abcd")).json();
    expect(r).toMatchObject({ ok: true, mode: "plan", model: "Sonnet 5", modelId: "claude-sonnet-5", effort: "high" });
    const r2 = await (await req("/rooms/tmux/%252/mode")).json();
    expect(r2).toMatchObject({ mode: "plan", model: null, effort: "medium" }); // effort falls back to the status line text
    expect((await req("/rooms/bad/room/mode")).status).toBe(404);
    expect((await (await req("/rooms/tmux/%252/mode?agent=codex")).json()).mode).toBe("unknown");
  });

  test("cycle presses shift+tab once and returns the new mode", async () => {
    const { req, calls } = setup([pane(null), pane(ACCEPT)]);
    const res = await req("/rooms/tmux/%250/mode/cycle", { agent: "claude" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, before: "default", mode: "acceptEdits" });
    expect(calls).toEqual(["key:btab"]);
  });

  test("cycle refuses Codex rooms and unreadable screens", async () => {
    const a = setup([codexScreen]);
    expect((await a.req("/rooms/tmux/%253/mode/cycle", { agent: "codex" })).status).toBe(400);
    expect((await a.req("/rooms/tmux/%253/mode/cycle", {})).status).toBe(400);
    expect(a.calls).toEqual([]);
  });

  test("model / effort: allow-list, busy check, typed command", async () => {
    const idle = setup([pane(BYPASS)]);
    expect((await idle.req("/rooms/tmux/%250/model", { model: "opus[1m]" })).status).toBe(200);
    expect((await idle.req("/rooms/tmux/%250/effort", { level: "xhigh" })).status).toBe(200);
    expect((await idle.req("/rooms/tmux/%250/model", { model: "gpt-5; rm -rf /" })).status).toBe(400);
    expect((await idle.req("/rooms/tmux/%250/effort", { level: "ultra" })).status).toBe(400);
    expect((await idle.req("/rooms/tmux/%250/model", { model: "opus", agent: "codex" })).status).toBe(400);
    expect(idle.calls).toEqual(["type:/model opus[1m]", "type:/effort xhigh"]);

    const busy = setup([pane(BYPASS, `${E}[38;5;174m✽ Moonwalking… (19s · ↓ 564 tokens · thinking)${E}[39m`)]);
    const res = await busy.req("/rooms/tmux/%250/model", { model: "sonnet" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("กำลังทำงาน");
    expect(busy.calls).toEqual([]);
  });

  test("claude-switch rooms: GET says switchable + GPT list; GPT model only there and only listed ones", async () => {
    const sw = setup([pane(BYPASS)]);
    const { mkdtempSync: mk, writeFileSync: wf, readFileSync: rf } = require("fs");
    const sf = join(mk(join(tmpdir(), "cs-")), "settings.json"); wf(sf, JSON.stringify({ theme: "dark" }));
    const sw2 = (() => { const calls: string[] = []; const app = new Elysia({ prefix: "/mobile" });
      mount(app, { roomChannel: (_w: string, r: string) => ({ kind: "tmux", pane: r, label: r }) as any, readScreen: async () => pane(BYPASS),
        pressKey: async () => {}, typeInto: async (_c: any, t: string) => { calls.push(t); wf(sf, JSON.stringify({ theme: "dark", model: "gpt-6-astra" })); },
        wait: async () => {}, switchable: () => true, gptModels: () => ["gpt-6-astra"], settingsFile: sf });
      return app; })();
    expect((await sw2.handle(new Request("http://local/mobile/rooms/tmux/%257/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-6-astra" }) }))).status).toBe(200);
    expect(JSON.parse(rf(sf, "utf-8"))).toEqual({ theme: "dark" });   // Claude Code's saved default put back
    expect(await (await sw.req("/rooms/tmux/%257/mode")).json()).toMatchObject({ switchable: true, gptModels: ["gpt-6-astra", "gpt-6.1-sol"] });
    expect(await (await sw.req("/rooms/tmux/%250/mode")).json()).toMatchObject({ switchable: false, gptModels: [] });
    expect((await sw.req("/rooms/tmux/%257/model", { model: "gpt-6-astra" })).status).toBe(200);
    expect((await sw.req("/rooms/tmux/%250/model", { model: "gpt-6-astra" })).status).toBe(400);   // plain Claude room
    expect((await sw.req("/rooms/tmux/%257/model", { model: "gpt-9-made-up" })).status).toBe(400);  // not offered by the login
    expect(sw.calls).toEqual(["type:/model gpt-6-astra"]);
  });
});

describe("paneSwitchable / gptModels", () => {
  const { paneSwitchable, gptModels } = require("../src/mobile/features/modes");
  test("finds the proxy env anywhere in the pane's process tree; Mind URL is not a switch room", () => {
    const tmux = () => "100\n";
    const tree = " 100 1\n 200 100\n 300 200\n";
    const env = (url: string) => (a: string[]) => a[0] === "-A" ? tree : a.at(-1) === "300" ? `claude.exe A=1 ANTHROPIC_BASE_URL=${url} B=2` : "zsh";
    expect(paneSwitchable("%1", tmux, env("http://127.0.0.1:18765"))).toBe(true);
    expect(paneSwitchable("%1", tmux, env("https://mind.example/api/anthropic"))).toBe(false);
    expect(paneSwitchable("%1", () => { throw new Error("no tmux"); }, env("x"))).toBe(false);
  });
  test("gptModels: listed gpt-* slugs only", () => {
    const { mkdtempSync, writeFileSync } = require("fs"), { tmpdir } = require("os"), { join } = require("path");
    const f = join(mkdtempSync(join(tmpdir(), "gm-")), "m.json");
    writeFileSync(f, JSON.stringify({ models: [{ slug: "gpt-6-astra", visibility: "list" }, { slug: "gpt-reserve", visibility: "hide" }, { slug: "codex-auto-review", visibility: "list" }, { slug: "gpt-x; rm", visibility: "list" }] }));
    expect(gptModels(f)).toEqual(["gpt-6-astra"]);
  });
});
