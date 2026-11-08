import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commandFor, ensure, load, mount, readInventory, sanitize, type AutoRoom, type Herdr } from "../src/mobile/features/herdr-autostart";

const fixture = (name: string): any => JSON.parse(readFileSync(join(import.meta.dir, "fixtures/herdr-autostart", name + ".json"), "utf8"));
const protocol = fixture("protocol22.schema");
// Interpret the pinned upstream schema, independently of the production parser.
// This subset covers the keywords used by the six response variants and their fixtures.
function conforms(value: any, schema: any): boolean {
  if (schema.$ref) {
    const target = schema.$ref.slice(2).split("/").reduce((node: any, key: string) => node[key], protocol);
    return conforms(value, target);
  }
  if (schema.oneOf && schema.oneOf.filter((s: any) => conforms(value, s)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some((s: any) => conforms(value, s))) return false;
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t: string) => t === "null" ? value === null : t === "array" ? Array.isArray(value)
      : t === "integer" ? Number.isInteger(value) : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : typeof value === t)) return false;
  }
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (Array.isArray(value) && schema.items && !value.every(v => conforms(v, schema.items))) return false;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some((key: string) => !Object.hasOwn(value, key))) return false;
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) return false;
    for (const [key, v] of Object.entries(value)) {
      if (schema.propertyNames && !conforms(key, schema.propertyNames)) return false;
      const property = schema.properties?.[key] ?? schema.additionalProperties;
      if (property === false || (property && !conforms(v, property))) return false;
    }
  }
  return true;
}
const cwd = "/home/example/project";
const allow = (p: string) => p === cwd ? p : null;
const room: AutoRoom = { label: "demo-room", cwd, agentKind: "codex" };
const uuid = "00000000-0000-4000-8000-000000000001";
const tempDirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-autostart-test-"));
  tempDirs.push(dir);
  return join(dir, "config.json");
}
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("fixtures follow the pinned Herdr protocol 22 contract", () => {
  const response = protocol.schemas.success_response;
  test("all six response envelopes satisfy upstream required fields and types", () => {
    expect(protocol.protocol).toBe(22);
    for (const name of ["workspace-list", "agent-list", "pane-list", "workspace-created", "pane-process-info", "agent-started"])
      expect(conforms(fixture(name), response)).toBe(true);
  });
  test("contract validation rejects malformed required fields independently of ensure", () => {
    for (const name of ["workspace-list", "agent-list", "pane-list", "workspace-created", "pane-process-info", "agent-started"]) {
      const value = fixture(name);
      delete value.result.type;
      expect(conforms(value, response)).toBe(false);
    }
    const pane = fixture("pane-list");
    delete pane.result.panes[0].terminal_id;
    expect(conforms(pane, response)).toBe(false);
    const workspace = fixture("workspace-list");
    workspace.result.workspaces[0].pane_count = "1";
    expect(conforms(workspace, response)).toBe(false);
    const agent = fixture("agent-list");
    agent.result.agents[0].agent_status = "made-up-status";
    expect(conforms(agent, response)).toBe(false);
  });
});

function fake(initial: "missing" | "shell" | "running" = "missing") {
  const w = fixture("workspace-list").result.workspaces[0];
  const p = fixture("pane-list").result.panes[0];
  const a = fixture("agent-list").result.agents[0];
  const state = {
    workspaces: initial === "missing" ? [] : [w],
    agents: initial === "running" ? [a] : [],
    panes: [p], process: fixture("pane-process-info").result.process_info,
    failStart: false, startedDespiteTimeout: false,
  };
  const calls: string[][] = [];
  const run: Herdr = async args => {
    calls.push([...args]);
    expect(args.slice(0, 2)).toEqual(["--session", "default"]);
    const cmd = args.slice(2);
    const key = cmd.slice(0, 2).join(" ");
    const reply = (type: string, fields: any) => JSON.stringify({ id: "fixture-request", result: { type, ...fields } });
    if (key === "workspace list") return reply("workspace_list", { workspaces: state.workspaces });
    if (key === "agent list") return reply("agent_list", { agents: state.agents });
    if (key === "pane list") return reply("pane_list", { panes: state.panes });
    if (key === "pane process-info") return reply("pane_process_info", { process_info: state.process });
    if (key === "workspace create") {
      state.workspaces = [w];
      return JSON.stringify(fixture("workspace-created"));
    }
    if (key === "agent start") {
      if (!state.failStart || state.startedDespiteTimeout) state.agents = [a];
      if (state.failStart) throw new Error("timeout");
      return JSON.stringify(fixture("agent-started"));
    }
    throw new Error("Unexpected CLI operation: " + key);
  };
  const mutations = () => calls.filter(args => args[3] === "create" || args[3] === "start");
  return { state, calls, run, mutations };
}

function routes(file: string, herdr: Herdr) {
  const handlers: Record<string, Function> = {};
  const app = {
    get: (path: string, fn: Function) => { handlers["GET " + path] = fn; },
    post: (path: string, fn: Function) => { handlers["POST " + path] = fn; },
  };
  mount(app, { file, herdr, allow });
  const call = async (method: string, body?: unknown) => {
    const set: any = {};
    const result = await handlers[method + " /herdr/autostart"]({ body, set });
    return { status: set.status ?? 200, ...result };
  };
  return { call };
}

describe("Herdr autostart validation and commands", () => {
  test("fixed native resume arguments and optional model", () => {
    expect(commandFor(room)).toEqual(["resume", "--last"]);
    expect(commandFor({ ...room, model: "example-model" })).toEqual(["resume", "--last", "--model", "example-model"]);
    expect(commandFor({ ...room, agentKind: "claude" })).toEqual(["--continue"]);
    expect(commandFor({ ...room, agentKind: "claude", model: "example-model" })).toEqual(["--continue", "--model", "example-model"]);
    expect(commandFor({ ...room, resumeArgs: ["resume", uuid] })).toEqual(["resume", uuid]);
    expect(commandFor({ ...room, agentKind: "claude", resumeArgs: ["--resume", uuid] })).toEqual(["--resume", uuid]);
  });

  test("validates label, cwd, agent kind, model and resume flags", () => {
    expect(sanitize(room, allow)).toEqual(room);
    for (const label of ["", "-option", "two words", "room;command", "A", "a".repeat(33)])
      expect(sanitize({ ...room, label }, allow)).toBeNull();
    expect(sanitize({ ...room, cwd: "/etc" }, allow)).toBeNull();
    expect(sanitize({ ...room, agentKind: "shell" }, allow)).toBeNull();
    for (const model of ["--config", "x;command", "x\ncommand"])
      expect(sanitize({ ...room, model }, allow)).toBeNull();
    for (const resumeArgs of [["--dangerously-bypass-approvals-and-sandbox"], ["resume", "--all"], ["resume", "--last", "prompt"], "resume --last"])
      expect(sanitize({ ...room, resumeArgs }, allow)).toBeNull();
    expect(sanitize({ ...room, resumeArgs: ["resume", uuid] }, allow)?.resumeArgs).toEqual(["resume", uuid]);
    expect(sanitize({ ...room, agentKind: "claude", resumeArgs: ["--continue"] }, allow)?.resumeArgs).toEqual(["--continue"]);
  });

  test("malformed flag types and cross-provider arguments never become launch argv", () => {
    for (const invalid of [null, [], "room", { ...room, model: 42 }, { ...room, model: "" },
      { ...room, resumeArgs: [] }, { ...room, resumeArgs: ["resume", null] },
      { ...room, resumeArgs: ["--continue"] }, { ...room, resumeArgs: ["resume", "--last", "--model", "x"] },
      { ...room, agentKind: "claude", resumeArgs: ["resume", "--last"] },
      { ...room, agentKind: "claude", resumeArgs: ["--resume", "not-a-session-id"] },
      { ...room, resumeArgs: ["resume", "--last", "--", "echo"] }]) {
      expect(sanitize(invalid, allow)).toBeNull();
      expect(() => commandFor(invalid as AutoRoom)).toThrow();
    }
  });

  test("load accepts missing file but rejects malformed config without erasing it", () => {
    const file = tempFile();
    expect(load(file, allow)).toEqual([]);
    for (const contents of ["{broken", "{}", JSON.stringify([{ ...room, agentKind: "unknown" }])]) {
      writeFileSync(file, contents);
      expect(() => load(file, allow)).toThrow();
      expect(readFileSync(file, "utf8")).toBe(contents);
    }
  });
});

describe("Herdr ensure through injected runner", () => {
  test("restores missing workspace and starts native resume without a shell", async () => {
    const h = fake();
    const result = await ensure([room], h.run, commandFor);
    expect(result.started).toEqual([room.label]);
    expect(h.mutations()).toHaveLength(2);
    expect(h.calls.find(a => a[3] === "create")).toEqual(["--session", "default", "workspace", "create", "--cwd", cwd, "--label", room.label, "--no-focus"]);
    const start = h.calls.find(a => a[3] === "start")!;
    expect(start.slice(0, 9)).toEqual(["--session", "default", "agent", "start", room.label, "--kind", "codex", "--pane", "w7:p1"]);
    expect(start.slice(start.indexOf("--") + 1)).toEqual(["resume", "--last"]);
    expect(h.calls.some(a => a.includes("split") || a.includes("attach") || a.includes("stop"))).toBe(false);
  });

  test("second pass does not duplicate an already running agent", async () => {
    const h = fake();
    await ensure([room], h.run, commandFor);
    expect((await ensure([room], h.run, commandFor)).started).toEqual([]);
    expect(h.calls.filter(a => a[3] === "start")).toHaveLength(1);
    expect(h.calls.filter(a => a[3] === "create")).toHaveLength(1);
  });

  test("existing idle agent is preserved without mutation", async () => {
    const h = fake("running");
    expect((await ensure([room], h.run, commandFor)).started).toEqual([]);
    expect(h.mutations()).toEqual([]);
  });

  test("existing empty shell workspace resumes in its actual pane", async () => {
    const h = fake("shell");
    expect((await ensure([room], h.run, commandFor)).started).toEqual([room.label]);
    expect(h.mutations()).toHaveLength(1);
    expect(h.mutations()[0][3]).toBe("start");
  });

  test("malformed or missing inventory does not imply an empty server", async () => {
    for (const output of ["not json", "{}", '{"result":{}}', '{"result":{"workspaces":null}}']) {
      const calls: string[][] = [];
      const run: Herdr = async args => { calls.push(args); return output; };
      await expect(readInventory(run)).rejects.toThrow();
      const result = await ensure([room], run, commandFor);
      expect(result.started).toEqual([]);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(calls.some(a => a[3] === "create" || a[3] === "start")).toBe(false);
    }
  });

  test("wrong response kind and incomplete protocol fields never trigger restore", async () => {
    for (const scenario of ["type", "id", "error", "workspace-field", "agent-field"]) {
      const h = fake("running");
      const run: Herdr = async args => {
        const response = JSON.parse(await h.run(args));
        if (scenario === "type") response.result.type = "pane_list";
        if (scenario === "id") delete response.id;
        if (scenario === "error") response.error = { code: "unavailable", message: "fixture error" };
        if (scenario === "workspace-field" && args[2] === "workspace") delete response.result.workspaces[0].active_tab_id;
        if (scenario === "agent-field" && args[2] === "agent") delete response.result.agents[0].terminal_id;
        return JSON.stringify(response);
      };
      await expect(readInventory(run)).rejects.toThrow();
      const result = await ensure([room], run, commandFor);
      expect(result.started).toEqual([]);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(h.mutations()).toEqual([]);
    }
  });

  test("unavailable server causes no mutation", async () => {
    const calls: string[][] = [];
    const run: Herdr = async args => { calls.push(args); throw new Error("unavailable"); };
    const result = await ensure([room], run, commandFor);
    expect(result.started).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(calls.some(a => a[3] === "create" || a[3] === "start")).toBe(false);
  });

  test("duplicate live workspace labels are ambiguous and untouched", async () => {
    const h = fake("shell");
    h.state.workspaces.push({ ...h.state.workspaces[0], workspace_id: "w8", active_tab_id: "w8:t1" });
    const result = await ensure([room], h.run, commandFor);
    expect(result.started).toEqual([]);
    expect(h.mutations()).toEqual([]);
  });

  test("duplicate saved labels are rejected before runtime mutation", async () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify([room, room]));
    expect(() => load(file, allow)).toThrow();
    const h = fake();
    const result = await ensure([room, room], h.run, commandFor);
    expect(result.skipped).toEqual([{ label: room.label, reason: "duplicate_config" }]);
    expect(h.calls).toEqual([]);
  });

  test("invalid commands fail before creating a workspace", async () => {
    const h = fake();
    const result = await ensure([{ ...room, resumeArgs: ["--unsafe"] }], h.run, commandFor);
    expect(result.started).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(h.calls).toEqual([]);
  });

  test("uncertain workspace creation is not retried blindly", async () => {
    const h = fake();
    const calls: string[][] = [];
    const run: Herdr = async args => {
      calls.push(args);
      if (args[2] === "workspace" && args[3] === "create") throw new Error("timeout");
      return h.run(args);
    };
    expect((await ensure([room], run, commandFor)).started).toEqual([]);
    expect((await ensure([room], run, commandFor)).skipped).toEqual([{ label: room.label, reason: "start_uncertain" }]);
    expect(calls.filter(a => a[3] === "create")).toHaveLength(1);
    expect(calls.filter(a => a[3] === "start")).toHaveLength(0);
  });

  test("create timeout after the server created the workspace stays suppressed", async () => {
    const h = fake();
    const calls: string[][] = [];
    const run: Herdr = async args => {
      calls.push([...args]);
      const response = await h.run(args);
      if (args[2] === "workspace" && args[3] === "create") throw new Error("response lost after creation");
      return response;
    };
    await ensure([room], run, commandFor);
    expect(h.state.workspaces).toHaveLength(1);
    await ensure([room], run, commandFor);
    expect(calls.filter(a => a[3] === "create")).toHaveLength(1);
    expect(calls.filter(a => a[3] === "start")).toHaveLength(0);
  });

  test("changed terminal after workspace creation prevents agent start", async () => {
    const h = fake();
    h.state.panes[0].terminal_id = "replacement-terminal";
    const result = await ensure([room], h.run, commandFor);
    expect(result.started).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(h.calls.filter(a => a[3] === "start")).toHaveLength(0);
  });

  test("foreign agent in matching workspace is untouched", async () => {
    const h = fake("running");
    h.state.agents[0].name = "someone-else";
    h.state.agents[0].agent = "claude";
    expect((await ensure([room], h.run, commandFor)).started).toEqual([]);
    expect(h.mutations()).toEqual([]);
  });

  test("working, blocked and launch-pending agents are preserved", async () => {
    for (const status of ["working", "blocked", "unknown", "done", "idle"]) {
      const h = fake("running");
      h.state.agents[0].agent_status = status;
      h.state.agents[0].launch_pending = status === "idle";
      await ensure([room], h.run, commandFor);
      expect(h.mutations()).toEqual([]);
    }
  });

  test("duplicate protocol identities are not treated as safe inventory", async () => {
    for (const collection of ["workspaces", "agents"] as const) {
      const h = fake("running");
      h.state[collection].push({ ...h.state[collection][0] });
      await expect(readInventory(h.run)).rejects.toThrow();
      await ensure([room], h.run, commandFor);
      expect(h.mutations()).toEqual([]);
    }
  });

  test("restoration errors and wrong process identity leave shells untouched", async () => {
    for (const scenario of ["restore", "pane-agent", "process-pane", "process-cwd", "null-shell"]) {
      const h = fake("shell");
      if (scenario === "restore") h.state.panes[0].restore_error = "restoration failed";
      if (scenario === "pane-agent") h.state.panes[0].agent = "claude";
      if (scenario === "process-pane") h.state.process.pane_id = "w8:p1";
      if (scenario === "process-cwd") h.state.process.foreground_processes[0].cwd = "/home/example/other";
      if (scenario === "null-shell") h.state.process.shell_pid = null;
      await ensure([room], h.run, commandFor);
      expect(h.mutations()).toEqual([]);
    }
  });

  test("another client claiming the workspace during reconciliation prevents start", async () => {
    const h = fake("shell");
    const run: Herdr = async args => {
      const response = await h.run(args);
      if (args[2] === "pane" && args[3] === "list")
        h.state.agents = [fixture("agent-list").result.agents[0]];
      return response;
    };
    expect((await ensure([room], run, commandFor)).started).toEqual([]);
    expect(h.mutations()).toEqual([]);
  });

  test("same agent name elsewhere is not launched again", async () => {
    const h = fake("running");
    h.state.workspaces = [];
    expect((await ensure([room], h.run, commandFor)).started).toEqual([]);
    expect(h.mutations()).toEqual([]);
  });

  test("busy foreground process is never overwritten", async () => {
    const h = fake("shell");
    h.state.process.foreground_process_group_id = 200;
    h.state.process.foreground_processes = [{ pid: 200, name: "editor", cwd }];
    expect((await ensure([room], h.run, commandFor)).started).toEqual([]);
    expect(h.mutations()).toEqual([]);
  });

  test("missing process evidence, wrong cwd, and multiple panes fail closed", async () => {
    for (const scenario of ["process", "cwd", "panes"]) {
      const h = fake("shell");
      if (scenario === "process") h.state.process = { pane_id: "w7:p1" };
      if (scenario === "cwd") h.state.panes[0].cwd = "/home/example/other";
      if (scenario === "panes") h.state.panes.push({ ...h.state.panes[0], pane_id: "w7:p2" });
      expect((await ensure([room], h.run, commandFor)).started).toEqual([]);
      expect(h.mutations()).toEqual([]);
    }
  });

  test("timeout with a detected agent never triggers a second launch", async () => {
    const h = fake("shell");
    h.state.failStart = true;
    h.state.startedDespiteTimeout = true;
    await ensure([room], h.run, commandFor);
    await ensure([room], h.run, commandFor);
    expect(h.calls.filter(a => a[3] === "start")).toHaveLength(1);
  });

  test("timeout without detection stays uncertain instead of blindly retrying", async () => {
    const h = fake("shell");
    h.state.failStart = true;
    const result = await ensure([room], h.run, commandFor);
    expect(result.started).toEqual([]);
    await ensure([room], h.run, commandFor);
    expect(h.calls.filter(a => a[3] === "start")).toHaveLength(1);
  });

  test("overlapping ensure calls cannot create or start twice", async () => {
    const h = fake();
    await Promise.all([ensure([room], h.run, commandFor), ensure([room], h.run, commandFor)]);
    expect(h.calls.filter(a => a[3] === "create")).toHaveLength(1);
    expect(h.calls.filter(a => a[3] === "start")).toHaveLength(1);
  });
});

describe("Herdr autostart routes and boot scheduling", () => {
  test("add, update, list and remove config without runtime mutation", async () => {
    const h = fake("running");
    const file = tempFile();
    const r = routes(file, h.run);
    expect((await r.call("POST", { ...room, on: true })).status).toBe(200);
    expect(load(file, allow)).toEqual([room]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await r.call("POST", { label: room.label, model: "example-model" })).status).toBe(200);
    expect(load(file, allow)[0]).toEqual({ ...room, model: "example-model" });
    const get = await r.call("GET");
    expect(get.status).toBe(200);
    expect(get.available).toBe(true);
    expect(get.rooms[0].running).toBe(true);
    expect((await r.call("POST", { label: room.label, on: false })).rooms).toEqual([]);
    expect(load(file, allow)).toEqual([]);
    expect(h.mutations()).toEqual([]);
  });

  test("invalid config returns 400 and retains previously saved room", async () => {
    const file = tempFile();
    const h = fake();
    const r = routes(file, h.run);
    await r.call("POST", { ...room, on: true });
    const before = readFileSync(file, "utf8");
    for (const body of [{ ...room, label: "bad name" }, { ...room, cwd: "/etc" }, { ...room, resumeArgs: ["--config", "x"] }])
      expect((await r.call("POST", body)).status).toBe(400);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(h.calls).toEqual([]);
  });

  test("malformed HTTP bodies and non-boolean toggles never alter saved config", async () => {
    const file = tempFile();
    const h = fake();
    const r = routes(file, h.run);
    await r.call("POST", room);
    const before = readFileSync(file, "utf8");
    for (const body of [undefined, null, [], "room", {}, { label: room.label, on: "false" },
      { label: room.label, on: 0 }, { label: room.label, on: null },
      { label: room.label, resumeArgs: ["--config", "file"] }]) {
      expect((await r.call("POST", body)).status).toBe(400);
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    expect(h.calls).toEqual([]);
  });

  test("malformed saved config is not replaced by POST or removal", async () => {
    const file = tempFile();
    writeFileSync(file, "{broken");
    const h = fake();
    const r = routes(file, h.run);
    expect((await r.call("POST", room)).status).toBe(500);
    expect((await r.call("POST", { label: room.label, on: false })).status).toBe(500);
    expect(readFileSync(file, "utf8")).toBe("{broken");
    expect(h.calls).toEqual([]);
  });

  test("GET unavailable is explicit instead of a successful empty inventory", async () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify([room]));
    const r = routes(file, async () => { throw new Error("unavailable"); });
    const result = await r.call("GET");
    expect(result.status).toBe(503);
    expect(result.ok).toBe(false);
    expect(result.available).toBe(false);
    expect(result.rooms[0].running).toBeNull();
  });

  test("boot schedules only real-file production mounts at 5 and 60 seconds", () => {
    const scheduled: number[] = [];
    const app = { get() {}, post() {} };
    const schedule = (_callback: () => void, delay: number) => { scheduled.push(delay); return undefined as any; };
    const herdr: Herdr = async () => { throw new Error("scheduler test must never invoke CLI"); };
    mount(app, { herdr, allow, schedule, nodeEnv: "test" });
    expect(scheduled).toEqual([]);
    mount(app, { file: tempFile(), herdr, allow, schedule, nodeEnv: "production" });
    expect(scheduled).toEqual([]);
    mount(app, { herdr, allow, schedule, nodeEnv: "production" });
    expect(scheduled).toEqual([5_000, 60_000]);
  });

  test("scheduled reconciliation reports its result through GET", async () => {
    const h = fake();
    const callbacks: (() => void)[] = [];
    let get: Function = () => {};
    mount({ get: (_path: string, handler: Function) => { get = handler; }, post() {} }, {
      nodeEnv: "production", herdr: h.run, allow, readConfig: () => [room],
      schedule: callback => { callbacks.push(callback); },
    });
    expect((await get()).lastEnsure).toBeNull();
    callbacks[0]();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await get()).lastEnsure.started).toEqual([room.label]);
    callbacks[1]();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await get()).lastEnsure.skipped).toEqual([{ label: room.label, reason: "running" }]);
    expect(h.calls.filter(a => a[3] === "start")).toHaveLength(1);
  });

  test("boot reads fresh injected config each pass and exposes config failure safely", async () => {
    const h = fake();
    const callbacks: (() => void)[] = [];
    let get: Function = () => {};
    let configured: AutoRoom[] = [];
    let configError = false;
    mount({ get: (_path: string, handler: Function) => { get = handler; }, post() {} }, {
      nodeEnv: "production", herdr: h.run, allow,
      readConfig: () => { if (configError) throw new Error("private config details"); return configured; },
      schedule: callback => { callbacks.push(callback); },
    });
    expect((await get()).lastEnsure).toBeNull();
    callbacks[0]();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await get()).lastEnsure.started).toEqual([]);
    configured = [room];
    callbacks[1]();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await get()).lastEnsure.started).toEqual([room.label]);
    configError = true;
    callbacks[1]();
    await new Promise<void>(resolve => setImmediate(resolve));
    const set: any = {};
    const response = await get({ set });
    expect(set.status).toBe(500);
    expect(response.lastEnsure.started).toEqual([]);
    expect(response.lastEnsure.errors).toHaveLength(1);
    expect(JSON.stringify(response)).not.toContain("private config details");
    expect(h.calls.filter(a => a[3] === "start")).toHaveLength(1);
  });

  test("overlapping boot callbacks keep one reconciliation in flight", async () => {
    const h = fake();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const calls: string[][] = [];
    const herdr: Herdr = async args => { calls.push([...args]); await barrier; return h.run(args); };
    const callbacks: (() => void)[] = [];
    let get: Function = () => {};
    let configReads = 0;
    mount({ get: (_path: string, handler: Function) => { get = handler; }, post() {} }, {
      nodeEnv: "production", herdr, allow,
      readConfig: () => { configReads++; return [room]; },
      schedule: callback => { callbacks.push(callback); },
    });
    callbacks[0]();
    callbacks[1]();
    expect(configReads).toBe(1);
    expect(calls).toHaveLength(1);
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await get()).lastEnsure.started).toEqual([room.label]);
    expect(h.calls.filter(a => a[3] === "create")).toHaveLength(1);
    expect(h.calls.filter(a => a[3] === "start")).toHaveLength(1);
  });
});
