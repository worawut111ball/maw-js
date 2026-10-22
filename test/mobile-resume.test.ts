import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  deps, encodeProjectDir, listPastSessions, mount, projectDirsFor, realUserText, resumeSession, summarizeFile, summarizeLines, terminalIdFrom,
} from "../src/mobile/features/resume";
import type { LiveRoom } from "../src/mobile/api";

const WS = "11111111-2222-3333-4444-555555555555";
const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const S2 = "aaaaaaaa-0000-4000-8000-000000000002";
const S3 = "aaaaaaaa-0000-4000-8000-000000000003";
const j = (o: any) => JSON.stringify(o);
const user = (content: any, extra: any = {}) => j({ type: "user", message: { role: "user", content }, ...extra });
const asst = (text: string) => j({ type: "assistant", message: { content: [{ type: "text", text }] } });
const toolCall = () => j({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } });

const orig = { ...deps };
let root: string, cwd: string, calls: string[][];
const liveRoom = (sessionId: string, terminalId = "t-live"): LiveRoom =>
  ({ pid: 1, sessionId, status: "idle", name: null, channel: { kind: "superset", workspaceId: WS, terminalId, label: "x" } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-resume-"));
  cwd = join(root, "work", "my_repo.v2");
  mkdirSync(cwd, { recursive: true });
  calls = [];
  deps.projectsRoot = join(root, "projects");
  deps.workspacePath = () => cwd;
  deps.readLiveRooms = () => new Map();
  deps.ss = (args: string[]) => { calls.push(args); return j({ sessionId: "term-new", label: "Claude" }); };
});
afterEach(() => { Object.assign(deps, orig); });

function writeSession(id: string, lines: string[], mtimeSec: number) {
  const dir = join(deps.projectsRoot, encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${id}.jsonl`);
  writeFileSync(f, lines.join("\n") + "\n");
  utimesSync(f, mtimeSec, mtimeSec);
  return f;
}

describe("folder encoding", () => {
  test("every non-alphanumeric char becomes '-'", () => {
    expect(encodeProjectDir("/Users/ball/artron/factory_pro.wms")).toBe("-Users-ball-artron-factory-pro-wms");
  });
  test("finds the folder for cwd", () => {
    mkdirSync(join(deps.projectsRoot, encodeProjectDir(cwd)), { recursive: true });
    expect(projectDirsFor(cwd)).toEqual([join(deps.projectsRoot, encodeProjectDir(cwd))]);
    expect(projectDirsFor("/no/such/place")).toEqual([]);
  });
});

describe("transcript parsing", () => {
  test("skips plumbing user lines", () => {
    expect(realUserText(JSON.parse(user("แก้บั๊กหน้า login")))).toBe("แก้บั๊กหน้า login");
    expect(realUserText(JSON.parse(user("hi", { isMeta: true })))).toBeNull();
    expect(realUserText(JSON.parse(user("<command-name>/clear</command-name>")))).toBeNull();
    expect(realUserText(JSON.parse(user("<local-command-stdout>x</local-command-stdout>")))).toBeNull();
    expect(realUserText(JSON.parse(user("<task-notification>done</task-notification>")))).toBeNull();
    expect(realUserText(JSON.parse(user("Caveat: the messages below…")))).toBeNull();
    expect(realUserText(JSON.parse(user("[Request interrupted by user]")))).toBeNull();
    expect(realUserText(JSON.parse(user([{ type: "tool_result", content: "ok" }])))).toBeNull();
    expect(realUserText(JSON.parse(user([{ type: "image" }, { type: "text", text: "ดูรูปนี้" }])))).toBe("ดูรูปนี้");
    expect(realUserText(JSON.parse(user("x", { isSidechain: true })))).toBeNull();
  });

  test("title priority: custom > agent-name > newest ai-title; preview = first real message clipped", () => {
    const long = "ก".repeat(300);
    const r = summarizeLines([
      user("<command-name>/model</command-name>"),
      user(long),
      j({ type: "ai-title", aiTitle: "old" }),
      asst("ok"), toolCall(),
      j({ type: "ai-title", aiTitle: "new" }),
      "{not json",
    ]);
    expect(r.title).toBe("new");
    expect(r.preview!.length).toBe(120);
    expect(r.preview!.endsWith("…")).toBe(true);
    expect(r.messages).toBe(2); // 1 user + 1 assistant text; tool calls + commands don't count
    expect(summarizeLines([j({ type: "ai-title", aiTitle: "a" }), j({ type: "agent-name", agentName: "b" })]).title).toBe("b");
    expect(summarizeLines([j({ type: "agent-name", agentName: "b" }), j({ type: "custom-title", customTitle: "c" })]).title).toBe("c");
  });

  test("big files: head for preview, tail for newest title, estimated count", () => {
    const pad = "x".repeat(1000);
    const lines = [user("เริ่มงานแรก"), j({ type: "ai-title", aiTitle: "first" })];
    for (let i = 0; i < 3000; i++) lines.push(asst(pad));
    lines.push(j({ type: "ai-title", aiTitle: "latest" }));
    const f = writeSession(S1, lines, 1000);
    const s = summarizeFile(f)!;
    expect(s.approx).toBe(true);
    expect(s.title).toBe("latest");
    expect(s.preview).toBe("เริ่มงานแรก");
    expect(s.messages).toBeGreaterThan(2500);
    expect(summarizeFile(f)).toBe(s); // cached by mtime+size
  });
});

describe("listPastSessions", () => {
  test("newest first, live flag, skips empty + non-uuid files", () => {
    writeSession(S1, [user("เก่า"), asst("a")], 1_000);
    writeSession(S2, [user("ใหม่"), asst("b"), j({ type: "ai-title", aiTitle: "งานใหม่" })], 2_000);
    writeSession(S3, [j({ type: "permission-mode", permissionMode: "default" })], 3_000);
    writeFileSync(join(deps.projectsRoot, encodeProjectDir(cwd), "notes.jsonl"), user("x"));
    const l = listPastSessions(cwd, new Map([[S1, liveRoom(S1, "term-1")]]));
    expect(l.map(s => s.sessionId)).toEqual([S2, S1]);
    expect(l[0]).toMatchObject({ title: "งานใหม่", preview: "ใหม่", messages: 2, live: false, approx: false });
    expect(l[1]).toMatchObject({ title: null, preview: "เก่า", live: true, liveTerminalId: "term-1" });
    expect(listPastSessions(cwd, new Map(), 1)).toHaveLength(1);
  });
});

describe("resume launch", () => {
  test("uses agents create --resume-session", () => {
    expect(resumeSession(WS, S1)).toEqual({ terminalId: "term-new", via: "agent" });
    expect(calls).toEqual([["agents", "create", "--local", "--workspace", WS, "--agent", "claude", "--resume-session", S1, "--json"]]);
  });
  test("falls back to a terminal running `claude --resume` only when the flag is unsupported", () => {
    deps.ss = (args) => {
      calls.push(args);
      if (args[0] === "agents") throw Object.assign(new Error("x"), { stderr: "Unknown option --resume-session" });
      return j({ terminalId: "term-sh" });
    };
    expect(resumeSession(WS, S1)).toEqual({ terminalId: "term-sh", via: "terminal" });
    expect(calls[1]).toEqual(["terminals", "create", "--local", "--workspace", WS, "--command", `claude --resume ${S1}`, "--json"]);
  });
  test("other failures do not spawn a second terminal", () => {
    deps.ss = (args) => { calls.push(args); throw Object.assign(new Error("x"), { stderr: "Superset is not running" }); };
    expect(() => resumeSession(WS, S1)).toThrow();
    expect(calls).toHaveLength(1);
  });
  test("terminalIdFrom handles both shapes", () => {
    expect(terminalIdFrom(j({ sessionId: "a" }))).toBe("a");
    expect(terminalIdFrom(j({ data: { terminalId: "b" } }))).toBe("b");
    expect(terminalIdFrom("nope")).toBeNull();
  });
});

describe("routes", () => {
  const app = new Elysia({ prefix: "/mobile" });
  mount(app);
  const get = (p: string) => app.handle(new Request(`http://local/mobile${p}`));
  const post = (p: string, body: any) => app.handle(new Request(`http://local/mobile${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: j(body) }));

  test("GET sessions", async () => {
    writeSession(S1, [user("สวัสดี"), asst("hi")], 1_000);
    const r = await get(`/workspaces/${WS}/sessions`);
    const b = await r.json();
    expect(r.status).toBe(200);
    expect(b.cwd).toBe(cwd);
    expect(b.sessions.map((s: any) => s.sessionId)).toEqual([S1]);
  });
  test("GET sessions: tmux → 400, unknown workspace → 404", async () => {
    expect((await get(`/workspaces/tmux/sessions`)).status).toBe(400);
    deps.workspacePath = () => null;
    expect((await get(`/workspaces/${WS}/sessions`)).status).toBe(404);
  });
  test("POST resume: ok / bad id / live / tmux / CLI failure", async () => {
    let r = await post(`/workspaces/${WS}/resume`, { sessionId: S1 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, terminalId: "term-new", via: "agent" });

    r = await post(`/workspaces/${WS}/resume`, { sessionId: "abc; rm -rf /" });
    expect(r.status).toBe(400);

    r = await post(`/workspaces/tmux/resume`, { sessionId: S1 });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("ยังรองรับเฉพาะ Superset");

    deps.readLiveRooms = () => new Map([[S1, liveRoom(S1, "term-1")]]);
    r = await post(`/workspaces/${WS}/resume`, { sessionId: S1 });
    expect(r.status).toBe(409);
    expect((await r.json()).terminalId).toBe("term-1");

    deps.readLiveRooms = () => new Map();
    deps.ss = () => { throw Object.assign(new Error("boom"), { stderr: "Superset is not running" }); };
    r = await post(`/workspaces/${WS}/resume`, { sessionId: S1 });
    expect(r.status).toBe(502);
    expect(calls).toHaveLength(1); // only the first successful call ever reached the (mock) CLI
  });
});
