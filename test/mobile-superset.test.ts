import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  mount, setRunner, buildRrule, describeRrule, slugBranch, parseCreated, parseJson, normalizeAutomation, normalizeTask,
  scriptCommand, thaiError, vName, vBranch, vPrompt, argvCreateWorkspace,
} from "../src/mobile/features/superset";

const WS = "507bfe6e-4fb3-4f71-bc40-9c356c9943b8";
const PROJ = "3a9591ce-5bfe-4e89-8910-7f50b1ed7de9";
const TERM = "98f5ee3c-4006-4092-a224-b74628e670fd";
const AUTO = "11111111-2222-3333-4444-555555555555";
const SCRIPT = "c120a808-5883-4173-95f1-5ad65b27e041";

/** Mock CLI: records every argv, answers by the first two words. Never touches the real Superset. */
function mock(answers: Record<string, unknown> = {}, fail?: (args: string[]) => Error | null) {
  const calls: string[][] = [];
  setRunner(async (args) => {
    calls.push(args);
    const err = fail?.(args); if (err) throw err;
    const key = args.slice(0, 2).join(" ");
    return JSON.stringify(answers[key] ?? {});
  });
  return calls;
}
afterEach(() => setRunner(null));

const app = new Elysia({ prefix: "/mobile" });
mount(app);
const get = (p: string) => app.handle(new Request(`http://local/mobile${p}`));
const post = (p: string, body: unknown = {}) => app.handle(new Request(`http://local/mobile${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("pure helpers", () => {
  test("RRULE presets", () => {
    expect(buildRrule("daily", "02:00")).toBe("FREQ=DAILY;BYHOUR=2;BYMINUTE=0");
    expect(buildRrule("weekdays", "09:30")).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=30");
    expect(buildRrule("weekly", "18:05", "FR")).toBe("FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=5");
    expect(() => buildRrule("daily", "25:00")).toThrow();
    expect(() => buildRrule("weekly", "09:00", "XX")).toThrow();
  });
  test("RRULE → Thai", () => {
    expect(describeRrule("FREQ=DAILY;BYHOUR=2;BYMINUTE=0")).toBe("ทุกวัน 02:00");
    expect(describeRrule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=30")).toBe("ทุกวันทำการ (จ–ศ) 09:30");
    expect(describeRrule("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0")).toBe("ทุกวันจันทร์ 09:00");
    expect(describeRrule("FREQ=DAILY")).toBe("ทุกวัน");
    expect(describeRrule("FREQ=HOURLY;INTERVAL=2")).toBe("ทุก 2 ชั่วโมง");
    expect(describeRrule(null)).toBeNull();
  });
  test("branch slug", () => {
    expect(slugBranch("Fix Login Bug")).toBe("fix-login-bug");
    expect(slugBranch("feat/new api")).toBe("feat/new-api");
    expect(slugBranch("แก้บั๊ก", new Date(2026, 9, 22, 8, 5))).toBe("ws-20261022-0805");
  });
  test("validation", () => {
    expect(vName(" fix tests ")).toBe("fix tests");
    expect(() => vName("--local")).toThrow();
    expect(() => vName("a;rm -rf")).toThrow();
    expect(() => vName("x".repeat(81))).toThrow();
    expect(vBranch("feat/x-1")).toBe("feat/x-1");
    expect(() => vBranch("a b")).toThrow();
    expect(() => vBranch("a..b")).toThrow();
    expect(() => vPrompt("")).toThrow();
    expect(() => vPrompt("x".repeat(4001))).toThrow();
    expect(() => vPrompt("--api-key x")).toThrow();
  });
  test("output parsing", () => {
    expect(parseJson('{"data":{"id":"a"},"message":"m"}')).toEqual({ id: "a" });
    expect(parseJson('{"data":1,"id":"x"}')).toEqual({ data: 1, id: "x" });
    expect(parseJson("not json")).toBeNull();
    expect(parseCreated({ workspace: { id: WS }, agents: [{ terminalId: TERM }] })).toEqual({ workspaceId: WS, terminalId: TERM });
    expect(parseCreated({ workspace: { id: WS } })).toEqual({ workspaceId: WS, terminalId: null });
    expect(normalizeAutomation({ id: AUTO, name: "n", rrule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=0", enabled: false }).schedule).toBe("ทุกวัน 02:00");
    expect(normalizeAutomation({ id: AUTO, enabled: false }).enabled).toBe(false);
    expect(normalizeTask({ id: "t", title: "T", status: { name: "Todo" } }).status).toBe("Todo");
    expect(scriptCommand({ commands: ["bun i", "bun dev"] })).toBe("bun i && bun dev");
    expect(scriptCommand({ commands: [] })).toBeNull();
  });
  test("errors become Thai", () => {
    expect(thaiError({ stderr: "Error: No active organization" })).toContain("login");
    expect(thaiError({ code: "ENOENT" })).toContain("ไม่พบ Superset CLI");
    expect(thaiError({ killed: true })).toContain("ช้า");
    expect(thaiError({ stderr: "Error: boom\nstack" })).toBe("Superset แจ้งว่า: boom");
  });
});

describe("routes build exact argv", () => {
  test("A. create workspace + agent", async () => {
    const calls = mock({ "workspaces create": { workspace: { id: WS }, agents: [{ terminalId: TERM }] } });
    const r = await post("/superset/workspaces", { projectId: PROJ, name: "Fix Tests", agent: "codex", prompt: "fix the flaky tests" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, workspaceId: WS, terminalId: TERM, alreadyExists: false });
    expect(calls).toEqual([["workspaces", "create", "--local", "--project", PROJ, "--name", "Fix Tests", "--branch", "fix-tests", "--agent", "codex", "--prompt", "fix the flaky tests", "--json"]]);
  });
  test("A. explicit branch kept; bad input never reaches the CLI", async () => {
    const calls = mock({ "workspaces create": { workspace: { id: WS } } });
    await post("/superset/workspaces", { projectId: PROJ, name: "x", branch: "feat/y", prompt: "go" });
    expect(calls[0]).toEqual(argvCreateWorkspace({ projectId: PROJ, name: "x", branch: "feat/y", agent: "claude", prompt: "go" }));
    for (const bad of [{ projectId: "nope", name: "x", prompt: "p" }, { projectId: PROJ, name: "x;y", prompt: "p" }, { projectId: PROJ, name: "x", branch: "a b", prompt: "p" }, { projectId: PROJ, name: "x", prompt: "" }, { projectId: PROJ, name: "x", agent: "rm -rf", prompt: "p" }]) {
      const r = await post("/superset/workspaces", bad);
      expect(r.status).toBe(400);
      expect((await r.json()).ok).toBe(false);
    }
    expect(calls.length).toBe(1);
  });
  test("E. archive checks type then archives", async () => {
    const calls = mock({ "workspaces get": { id: WS, type: "worktree" } });
    expect((await post(`/superset/workspaces/${WS}/archive`)).status).toBe(200);
    expect(calls).toEqual([["workspaces", "get", WS, "--local", "--json"], ["workspaces", "archive", WS, "--local", "--json"]]);
  });
  test("E. main checkout (type local) is refused", async () => {
    const calls = mock({ "workspaces get": { id: WS, type: "local" } });
    const r = await post(`/superset/workspaces/${WS}/archive`);
    expect(r.status).toBe(400);
    expect(calls.length).toBe(1);
    expect((await post(`/superset/workspaces/not-a-uuid/archive`)).status).toBe(400);
  });
  test("B. automations list / create / pause / resume / delete", async () => {
    const calls = mock({ "automations list": [{ id: AUTO, name: "nightly", rrule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=0", enabled: true, nextRunAt: "2026-10-23T19:00:00Z" }], "automations create": { id: AUTO, name: "nightly" } });
    const l = await (await get("/superset/automations")).json();
    expect(l.automations[0]).toMatchObject({ id: AUTO, schedule: "ทุกวัน 02:00", enabled: true });
    expect(calls[0]).toEqual(["automations", "list", "--json"]);
    expect((await post("/superset/automations", { name: "nightly audit", projectId: PROJ, preset: "weekdays", time: "09:00", prompt: "audit deps" })).status).toBe(200);
    expect(calls[1]).toEqual(["automations", "create", "--name", "nightly audit", "--local", "--project", PROJ, "--rrule", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0", "--agent", "claude", "--prompt", "audit deps", "--json"]);
    for (const a of ["pause", "resume", "delete"]) expect((await post(`/superset/automations/${AUTO}/${a}`)).status).toBe(200);
    expect(calls.slice(2)).toEqual([["automations", "pause", AUTO, "--json"], ["automations", "resume", AUTO, "--json"], ["automations", "delete", AUTO, "--json"]]);
    expect((await post(`/superset/automations/${AUTO}/run`)).status).toBe(400);
    expect((await post("/superset/automations", { name: "x", projectId: PROJ, preset: "hourly", time: "09:00", prompt: "p" })).status).toBe(400);
    expect(calls.length).toBe(5);
  });
  test("C. tasks list + start agent on a task", async () => {
    const calls = mock({ "tasks list": [{ id: "t1", slug: "SUP-1", title: "Fix", status: { name: "Todo" } }], "workspaces create": { workspace: { id: WS } } });
    const l = await (await get("/superset/tasks")).json();
    expect(l.tasks[0]).toMatchObject({ slug: "SUP-1", title: "Fix", status: "Todo" });
    expect(calls[0]).toEqual(["tasks", "list", "--limit", "30", "--json"]);
    await post("/superset/tasks/SUP-1/start", { projectId: PROJ, name: "SUP-1", branch: "sup-1", agent: "claude", prompt: "do it" });
    expect(calls[1]).toEqual(["workspaces", "create", "--local", "--project", PROJ, "--name", "SUP-1", "--branch", "sup-1", "--task", "SUP-1", "--agent", "claude", "--prompt", "do it", "--json"]);
    expect((await post("/superset/tasks/--x/start", { projectId: PROJ, name: "a", prompt: "p" })).status).toBe(400);
  });
  test("D. scripts filtered by project and run in a new terminal", async () => {
    const other = "99999999-2222-3333-4444-555555555555";
    const calls = mock({ "scripts list": [{ id: SCRIPT, name: "dev", commands: ["bun i", "bun dev"], projectIds: null }, { id: other, name: "x", commands: ["x"], projectIds: [other] }], "terminals create": { terminalId: TERM } });
    const l = await (await get(`/superset/scripts?projectId=${PROJ}`)).json();
    expect(l.scripts.map((s: any) => s.id)).toEqual([SCRIPT]);
    const r = await (await post(`/superset/workspaces/${WS}/scripts/${SCRIPT}/run`)).json();
    expect(r.terminalId).toBe(TERM);
    expect(calls[2]).toEqual(["terminals", "create", "--local", "--workspace", WS, "--command", "bun i && bun dev", "--json"]);
    const missing = await post(`/superset/workspaces/${WS}/scripts/${AUTO}/run`);
    expect(missing.status).toBe(400);
  });
  test("F. explain", async () => {
    const calls = mock({ "agents explain": { terminalId: TERM, headline: "Blocked", because: "waiting for permission", details: [] } });
    const r = await (await get(`/superset/rooms/${WS}/${TERM}/explain`)).json();
    expect(r.explain.headline).toBe("Blocked");
    expect(calls).toEqual([["agents", "explain", "--local", "--workspace", WS, "--terminal", TERM, "--json"]]);
    expect((await get(`/superset/rooms/tmux/%251/explain`)).status).toBe(400);
  });
  test("meta maps the workspace to its Superset project", async () => {
    mock({ "workspaces get": { id: WS, name: "local", branch: "main", type: "local", projectId: PROJ, projectName: "p" }, "projects list": [{ id: PROJ, name: "p" }], "agents list": [{ id: "u", presetId: "claude", label: "Claude" }] });
    const m = await (await get(`/superset/workspaces/${WS}/meta`)).json();
    expect(m.workspace.projectId).toBe(PROJ);
    expect(m.projects).toEqual([{ id: PROJ, name: "p" }]);
    expect(m.agents).toEqual([{ id: "claude", label: "Claude" }]);
  });
  test("CLI failure → 502 with Thai message", async () => {
    mock({}, () => Object.assign(new Error("exit 1"), { stderr: "Error: No active organization" }));
    const r = await get("/superset/automations");
    expect(r.status).toBe(502);
    expect((await r.json()).error).toContain("login");
  });
});
