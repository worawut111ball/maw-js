import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { buildHandoffPrompt, mount, openWindowInSameSession, stripAnsi } from "../src/mobile/features/switch-agent";
import type { TmuxPane } from "../src/mobile/features/ctx";

const request = (app: any, method: string, path: string, body?: unknown) =>
  app.handle(new Request("http://fixture" + path, {
    method, headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));

describe("switch-agent pack — pure functions", () => {
  test("stripAnsi removes escape codes and carriage returns", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m text\r\n")).toBe("red text\n");
  });

  test("buildHandoffPrompt keeps the tail when the screen is long, labels it as context not a command", () => {
    const p = buildHandoffPrompt("team1-oracle", "a".repeat(3000));
    expect(p).toContain('ต่อจากห้อง "team1-oracle"');
    expect(p).toContain("ไม่ใช่คำสั่งใหม่");
    expect(p.length).toBeLessThan(2200);
    expect(p.endsWith("aaa\n[จบบริบท — ช่วยอ่านแล้วถามต่อ/ทำงานต่อได้เลย]")).toBe(true);
  });

  test("openWindowInSameSession targets the existing session, returns the new pane id", () => {
    const calls: string[][] = [];
    const run = (args: string[]) => { calls.push(args); return "%42\n"; };
    const pane = openWindowInSameSession("team1-oracle", "/Users/ball/project", "claude", run);
    expect(pane).toBe("%42");
    expect(calls[0]).toEqual(["new-window", "-P", "-F", "#{pane_id}", "-t", "=team1-oracle:", "-c", "/Users/ball/project", "claude"]);
  });

  test("openWindowInSameSession throws when tmux does not return a pane id", () => {
    expect(() => openWindowInSameSession("s", "/d", "codex", () => "not-a-pane")).toThrow();
  });
});

describe("switch-agent pack — route", () => {
  const panesFixture: TmuxPane[] = [{ id: "%1", session: "team1-oracle", window: "0", cwd: "/Users/ball/oracle", agent: "codex" }];

  test("switches codex -> claude: new window in the same session, context typed after the delay", async () => {
    const runCalls: string[][] = [];
    const run = (args: string[]) => { runCalls.push(args); return "%9\n"; };
    const typed: any[] = [];
    const type = async (ch: any, text: string) => { typed.push({ ch, text }); };
    const app = new Elysia();
    mount(app, { panes: () => panesFixture, run, type, screen: async () => "เนื้อหาจอเดิม", delayMs: 0 });

    const res: any = await request(app, "POST", "/rooms/tmux/%251/switch-agent", { to: "claude" }).then((r: Response) => r.json());
    expect(res).toEqual({ ok: true, workspace: "tmux", room: "%9", session: "team1-oracle", agent: "claude" });
    expect(runCalls[0]).toEqual(["new-window", "-P", "-F", "#{pane_id}", "-t", "=team1-oracle:", "-c", "/Users/ball/oracle", "claude"]);

    await new Promise(r => setTimeout(r, 5)); // let the (delayMs: 0) setTimeout fire
    expect(typed).toHaveLength(1);
    expect(typed[0].ch).toEqual({ kind: "tmux", pane: "%9", label: "%9" });
    expect(typed[0].text).toContain("เนื้อหาจอเดิม");
  });

  test("rejects a bad target agent", async () => {
    const app = new Elysia(); mount(app, { panes: () => panesFixture });
    const res: Response = await request(app, "POST", "/rooms/tmux/%251/switch-agent", { to: "gemini" });
    expect(res.status).toBe(400);
  });

  test("rejects a non-tmux workspace", async () => {
    const app = new Elysia(); mount(app, { panes: () => panesFixture });
    const res: Response = await request(app, "POST", "/rooms/dead-beef-dead-beef-dead-beef-dead-beef/room-id-also-not-a-uuid-1234/switch-agent", { to: "claude" });
    expect(res.status).toBe(400);
  });

  test("404s when the pane is gone (room closed)", async () => {
    const app = new Elysia(); mount(app, { panes: () => [] });
    const res: Response = await request(app, "POST", "/rooms/tmux/%251/switch-agent", { to: "claude" });
    expect(res.status).toBe(404);
  });

  test("refuses to switch to the agent already running there", async () => {
    const app = new Elysia(); mount(app, { panes: () => panesFixture });
    const res: Response = await request(app, "POST", "/rooms/tmux/%251/switch-agent", { to: "codex" });
    expect(res.status).toBe(400);
  });

  test("tmux failure surfaces as 502, never a crash", async () => {
    const app = new Elysia(); mount(app, { panes: () => panesFixture, run: () => { throw new Error("no tmux"); } });
    const res: Response = await request(app, "POST", "/rooms/tmux/%251/switch-agent", { to: "claude" });
    expect(res.status).toBe(502);
  });

  test("still opens the new room when reading the old screen fails", async () => {
    const typed: any[] = [];
    const app = new Elysia();
    mount(app, { panes: () => panesFixture, run: () => "%9\n", screen: async () => { throw new Error("gone"); }, type: async (ch, t) => { typed.push(t); }, delayMs: 0 });
    const res: any = await request(app, "POST", "/rooms/tmux/%251/switch-agent", { to: "claude" }).then((r: Response) => r.json());
    expect(res.ok).toBe(true);
    await new Promise(r => setTimeout(r, 5));
    expect(typed).toHaveLength(0); // no context → nothing typed, but the room still opened
  });
});
