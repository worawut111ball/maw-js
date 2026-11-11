import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { buildHandoffPrompt, findExisting, mount, openWindowInSameSession, stripAnsi, turnsToText } from "../src/mobile/features/switch-agent";
import type { ChatItem, TmuxPane } from "../src/mobile/features/ctx";

const request = (app: any, path: string, body: unknown) =>
  app.handle(new Request("http://fixture" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const URL = "/rooms/tmux/%251/switch-agent";   // pane %1, % encoded

describe("switch-agent pack — pure functions", () => {
  test("stripAnsi removes escape codes and carriage returns", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m text\r\n")).toBe("red text\n");
  });

  test("turnsToText keeps user/assistant text only, last 20 turns, no tools / canceled / queued", () => {
    const items: ChatItem[] = [
      { i: 0, role: "user", ts: null, text: "แรกสุด" },
      ...Array.from({ length: 25 }, (_, k) => ({ i: k + 1, role: (k % 2 ? "assistant" : "user") as any, ts: null, text: "ข้อ " + k })),
      { i: 30, role: "tool", ts: null, tool: { name: "Bash" } as any },
      { i: 31, role: "user", ts: null, text: "ยกเลิก", canceled: true },
      { i: 32, role: "user", ts: null, text: "ในคิว", queued: true },
    ];
    const t = turnsToText(items, "Claude");
    expect(t).not.toContain("แรกสุด");
    expect(t).not.toContain("ยกเลิก");
    expect(t).not.toContain("ในคิว");
    expect(t).toContain("คุณ: ข้อ 24"); expect(t).toContain("Claude: ข้อ 23");
    expect(t.split("\n\n")).toHaveLength(20);
  });

  test("handoff prompt says first time vs returning, and that it is context not a command", () => {
    const first = buildHandoffPrompt({ agent: "Codex", label: "team1-oracle" }, "x", "chat", false);
    const back = buildHandoffPrompt({ agent: "Claude", label: "team1-oracle" }, "x", "screen", true);
    expect(first).toContain("ต่อจาก Codex");
    expect(back).toContain("สลับกลับมาจาก Claude");
    for (const p of [first, back]) expect(p).toContain("ไม่ใช่คำสั่งใหม่");
  });

  test("openWindowInSameSession targets the existing session, returns the new pane id", () => {
    const calls: string[][] = [];
    expect(openWindowInSameSession("team1-oracle", "/p", "claude", a => { calls.push(a); return "%42\n"; })).toBe("%42");
    expect(calls[0]).toEqual(["new-window", "-P", "-F", "#{pane_id}", "-t", "=team1-oracle:", "-c", "/p", "claude"]);
    expect(() => openWindowInSameSession("s", "/d", "codex", () => "not-a-pane")).toThrow();
  });

  test("findExisting: same session + target agent, same folder first, never the source pane", () => {
    const from: TmuxPane = { id: "%1", session: "s", window: "0", cwd: "/a", agent: "codex" };
    const all: TmuxPane[] = [from,
      { id: "%2", session: "other", window: "0", cwd: "/a", agent: "claude" },
      { id: "%3", session: "s", window: "1", cwd: "/b", agent: "claude" },
      { id: "%4", session: "s", window: "2", cwd: "/a", agent: "claude" }];
    expect(findExisting(all, from, "claude")?.id).toBe("%4");
    expect(findExisting([from, all[1]], from, "claude")).toBeUndefined();
  });
});

describe("switch-agent pack — route", () => {
  const codex: TmuxPane = { id: "%1", session: "team1-oracle", window: "0", cwd: "/Users/ball/oracle", agent: "codex" };
  const claudeOld: TmuxPane = { id: "%7", session: "team1-oracle", window: "1", cwd: "/Users/ball/oracle", agent: "claude" };
  const base = { liveRooms: () => new Map(), transcript: () => null, bin: (a: string) => a };
  // new windows type via whenReady (waits for the input box) — tests type straight away through the test's own `type`
  const mountT = (app: any, d: any) => mount(app, { ...base, ...d, whenReady: (ch: any, t: string) => (d.type ?? (async () => {}))(ch, t) });

  test("first switch: new window in the same session, screen context typed after the delay", async () => {
    const runs: string[][] = [], typed: any[] = [];
    const app = new Elysia();
    mountT(app, { panes: () => [codex], run: a => { runs.push(a); return "%9\n"; }, type: async (ch, t) => { typed.push({ ch, t }); }, screen: async () => "\x1b[1mจอเดิม\x1b[0m" });
    const res: any = await request(app, URL, { to: "claude" }).then((r: Response) => r.json());
    expect(res).toEqual({ ok: true, workspace: "tmux", room: "%9", session: "team1-oracle", agent: "claude", reused: false, context: "screen" });
    expect(runs[0].at(-1)).toBe("claude");
    await new Promise(r => setTimeout(r, 5));
    expect(typed[0].ch.pane).toBe("%9");
    expect(typed[0].t).toContain("ต่อจาก Codex");
    expect(typed[0].t).toContain("จอเดิม");
    expect(typed[0].t).not.toContain("\x1b");
  });

  test("switching back reuses the agent already open in this session — no new window, returning summary", async () => {
    const runs: string[][] = [], typed: any[] = [];
    const app = new Elysia();
    mountT(app, { panes: () => [codex, claudeOld], run: a => { runs.push(a); return "%9\n"; }, type: async (ch, t) => { typed.push({ ch, t }); }, screen: async () => "x" });
    const res: any = await request(app, URL, { to: "claude" }).then((r: Response) => r.json());
    expect(res.room).toBe("%7");
    expect(res.reused).toBe(true);
    expect(runs).toHaveLength(0);
    expect(typed[0].ch.pane).toBe("%7");
    expect(typed[0].t).toContain("สลับกลับมาจาก Codex");
  });

  test("uses the real chat transcript when the source room has one (Claude)", async () => {
    const typed: string[] = [];
    const app = new Elysia();
    const fromClaude: TmuxPane = { ...codex, agent: "claude" };
    mountT(app, { panes: () => [fromClaude], run: () => "%9\n", type: async (_ch, t) => { typed.push(t); }, screen: async () => "จอ",
      liveRooms: () => new Map([["sess", { pid: 1, sessionId: "sess", status: null, name: null, channel: { kind: "tmux", pane: "%1", label: "%1" } }]]) as any,
      transcript: () => [{ i: 0, role: "user", ts: null, text: "แก้บั๊ก X" }, { i: 1, role: "assistant", ts: null, text: "แก้แล้วที่ไฟล์ Y" }] });
    const res: any = await request(app, URL, { to: "codex" }).then((r: Response) => r.json());
    expect(res.context).toBe("chat");
    await new Promise(r => setTimeout(r, 5));
    expect(typed[0]).toContain("คุณ: แก้บั๊ก X");
    expect(typed[0]).toContain("Claude: แก้แล้วที่ไฟล์ Y");
    expect(typed[0]).not.toContain("จอ\n");
  });

  test("rejects bad target, non-tmux room, same agent; 404 when gone; 502 on tmux failure", async () => {
    const mk = (d: any = {}) => { const app = new Elysia(); mountT(app, { panes: () => [codex], screen: async () => "", ...d }); return app; };
    expect((await request(mk(), URL, { to: "gemini" })).status).toBe(400);
    expect((await request(mk(), "/rooms/not-a-uuid/nope/switch-agent", { to: "claude" })).status).toBe(400);
    expect((await request(mk(), URL, { to: "codex" })).status).toBe(400);
    expect((await request(mk({ panes: () => [] }), URL, { to: "claude" })).status).toBe(404);
    expect((await request(mk({ run: () => { throw new Error("no tmux"); } }), URL, { to: "claude" })).status).toBe(502);
  });

  test("still opens the room when no context can be read — nothing typed", async () => {
    const typed: any[] = [];
    const app = new Elysia();
    mountT(app, { panes: () => [codex], run: () => "%9\n", screen: async () => { throw new Error("gone"); }, type: async (_c, t) => { typed.push(t); } });
    const res: any = await request(app, URL, { to: "claude" }).then((r: Response) => r.json());
    expect(res.ok).toBe(true);
    expect(res.context).toBe("none");
    await new Promise(r => setTimeout(r, 5));
    expect(typed).toHaveLength(0);
  });
});

describe("agentReady / typeWhenReady", () => {
  const { agentReady, typeWhenReady } = require("../src/mobile/api");
  test("ready = Claude input box (❯+nbsp) or Codex prompt; not a trust/update menu", () => {
    expect(agentReady("header\n❯ \n───")).toBe(true);
    expect(agentReady("› Ask Codex to do anything")).toBe(true);
    expect(agentReady("Do you trust the files in this folder?\n❯ 1. Yes, proceed")).toBe(false);
    expect(agentReady("✨ Update available!\n› 1. Update now")).toBe(false);
    expect(agentReady("› 1. Yes")).toBe(false);
    expect(agentReady("│ ✨ Update available! 0.164 -> 0.167 │\n│ See full release notes │\n› Ask Codex to do anything")).toBe(true);   // notice, not a menu
    expect(agentReady("loading…")).toBe(false);
  });
  test("typeWhenReady waits for the box, then types once", async () => {
    const screens = ["loading", "Do you trust the files", "❯ "]; let i = 0; const typed: string[] = [];
    await typeWhenReady({ kind: "tmux", pane: "%1", label: "%1" }, "hi", 10_000, async () => screens[Math.min(i++, 2)], async (_c: any, t: string) => { typed.push(t); }, async () => {});
    expect(typed).toEqual(["hi"]); expect(i).toBe(3);
  });
  test("typeWhenReady never types blind into a startup dialog that never clears", async () => {
    const typed: string[] = [];
    await typeWhenReady({ kind: "tmux", pane: "%1", label: "%1" }, "trust me", 50, async () => "hooks\n  t trust all · enter review · esc close", async (_c: any, t: string) => { typed.push(t); }, async () => new Promise(r => setTimeout(r, 5)));
    expect(typed).toEqual([]);
  });
});
