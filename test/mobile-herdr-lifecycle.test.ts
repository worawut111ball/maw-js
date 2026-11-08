import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Lifecycle, LifecycleStore, agentArgv, defaultMembers, type Binding, type LifecycleSnapshot, type AssistantAck } from "../src/mobile/herdr/lifecycle";
const dirs: string[] = [], stores: LifecycleStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const cwd = "/home/example/project";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-lifecycle-")); dirs.push(dir);
  const path = join(dir, "lifecycle.sqlite"); const store = new LifecycleStore(path); stores.push(store);
  const state: LifecycleSnapshot = { fresh: true, workspaces: [], panes: [] };
  const calls: string[][] = [], deliveries: any[] = [], acks = new Map<string, AssistantAck[]>();
  let serial = 0, autoAck = true, timeout = "", now = 1_000_000;
  const shell = (w: string): Binding => ({ workspaceId: w, paneId: w + ":p" + (++serial), terminalId: "demo-terminal-" + serial, instanceId: null, cwd, agentKind: null, name: null, status: "unknown", foreground: false, shellReady: true });
  const reply = (type: string, fields: any) => JSON.stringify({ id: "fixture-request", result: { type, ...fields } });
  const runner = async (args: string[]) => {
    calls.push([...args]); expect(args.slice(0, 2)).toEqual(["--session", "default"]); const cmd = args.slice(2), key = cmd.slice(0, 2).join(" ");
    const opt = (flag: string) => cmd[cmd.indexOf(flag) + 1];
    if (key === "workspace create") {
      const workspaceId = "w" + (state.workspaces.length + 7); const p = shell(workspaceId);
      state.workspaces.push({ id: workspaceId, label: opt("--label") }); state.panes.push(p);
      if (timeout === key) throw new Error("response lost after create");
      return reply("workspace_created", { workspace: { workspace_id: workspaceId, label: opt("--label") }, root_pane: { pane_id: p.paneId, terminal_id: p.terminalId, workspace_id: workspaceId } });
    }
    if (key === "pane split") {
      const source = state.panes.find(p => p.paneId === opt("--pane"))!; const p = shell(source.workspaceId); state.panes.push(p);
      return reply("pane_info", { pane: { pane_id: p.paneId, terminal_id: p.terminalId, workspace_id: p.workspaceId } });
    }
    if (key === "agent start") {
      const p = state.panes.find(p => p.paneId === opt("--pane"))!;
      Object.assign(p, { agentKind: opt("--kind"), name: cmd[2], instanceId: "instance-" + serial + "-" + p.paneId, foreground: true, shellReady: false, status: "idle",
        conversation: { provider: opt("--kind"), id: "00000000-0000-4000-8000-" + String(Number(p.paneId.split(":p")[1])).padStart(12, "0") } });
      const resumeIndex = cmd.indexOf("resume"); const claudeResume = cmd.indexOf("--resume");
      if (resumeIndex >= 0 || claudeResume >= 0) p.conversation!.id = cmd[(resumeIndex >= 0 ? resumeIndex : claudeResume) + 1];
      if (timeout === key) throw new Error("response lost after start");
      return reply("agent_started", { agent: { pane_id: p.paneId, workspace_id: p.workspaceId, name: p.name, agent: p.agentKind } });
    }
    if (key === "pane close") { state.panes = state.panes.filter(p => p.paneId !== (cmd.includes("--pane") ? opt("--pane") : cmd[2])); return reply("pane_closed", {}); }
    if (key === "workspace close") { state.panes = state.panes.filter(p => p.workspaceId !== cmd[2]); state.workspaces = state.workspaces.filter(w => w.id !== cmd[2]); return reply("workspace_closed", {}); }
    throw new Error("unexpected lifecycle operation: " + key);
  };
  const options = { store, runner, snapshot: async () => structuredClone(state), allowDir: (p: string) => p === cwd ? p : null, now: () => now,
    dispatch: async (binding: Binding, req: any) => {
      deliveries.push({ binding: structuredClone(binding), req });
      if (autoAck && req.action === "bootstrap") {
        const marker = req.text.match(/HERDR_ACK:[a-f0-9-]+:[a-z0-9]+/g)?.at(-1);
        if (marker) acks.set(binding.paneId, [{ role: "assistant", text: marker, instanceId: binding.instanceId!, conversationId: binding.conversation!.id, evidenceId: "assistant-record-" + binding.paneId }]);
      }
      return { id: req.id, state: "acknowledged", ok: true };
    }, acknowledgments: async (binding: Binding) => acks.get(binding.paneId) ?? [],
  };
  return { dir, path, store, state, calls, deliveries, options, lifecycle: new Lifecycle(options), noAck: () => { autoAck = false; }, timeout: (s: string) => { timeout = s; }, advance: (ms: number) => { now += ms; } };
}
const input = { id: "create-1", label: "demo-team", cwd, mode: "team" as const };
describe("Herdr lifecycle default config and operation side effects", () => {
  test("preset head Astra/workers Sol is normal permissions and exact resume never uses last", () => {
    const ms = defaultMembers("team"); expect(ms).toHaveLength(4); expect(ms[0].model).toBe("gpt-6-astra"); expect(ms.slice(1).map(m => m.model)).toEqual(Array(3).fill("gpt-6.1-sol"));
    expect(ms.every(m => m.permission === "ask")).toBe(true);
    expect(agentArgv({ role: "agent", agentKind: "claude", permission: "ask" })).toEqual(["--permission-mode", "default"]);
    for (const agentKind of ["codex", "claude"] as const) {
      const ask = { role: "agent", agentKind, permission: "ask" as const, model: "example-model" };
      expect(agentArgv(ask).some(x => x.includes("dangerously"))).toBe(false);
      const argv = agentArgv({ ...ask, permission: "bypass" }, { provider: agentKind, id: "00000000-0000-4000-8000-000000000001" });
      expect(argv).not.toContain("--last"); expect(argv.some(x => x.includes("dangerously"))).toBe(true);
    }
  });
  test("invalid cwd/model/role/body fail before mutation", async () => {
    for (const over of [{ cwd: "/etc" }, { label: "--option" }, { members: [{ role: "bad", agentKind: "codex", permission: "ask" }] }, { autostart: "true" }]) {
      const h = setup(); await expect(h.lifecycle.create({ ...input, ...over } as any)).rejects.toThrow(); expect(h.calls).toEqual([]);
    }
    expect(() => agentArgv({ role: "agent", agentKind: "codex", model: "--config", permission: "ask" })).toThrow();
  });
  test("single defaults autostart on but can explicitly turn it off before create", async () => {
    for (const autostart of [undefined, false]) {
      const h = setup(); const op = await h.lifecycle.create({ ...input, mode: "single", autostart });
      expect(op.phase).toBe("ready"); expect(op.members).toHaveLength(1); expect(op.desiredAutostart).toBe(autostart !== false);
      expect(h.calls.filter(a => a[3] === "start")).toHaveLength(1); expect(h.deliveries).toHaveLength(1);
    }
  });
  test("team starts four real pane targets and bootstraps all roles only once", async () => {
    const h = setup(); const op = await h.lifecycle.create(input);
    expect(op.phase).toBe("ready"); expect(op.members.every(m => m.ready && m.ackEvidence)).toBe(true);
    expect(h.calls.filter(a => a[3] === "create")).toHaveLength(1); expect(h.calls.filter(a => a[3] === "split")).toHaveLength(3); expect(h.calls.filter(a => a[3] === "start")).toHaveLength(4);
    expect(new Set(h.deliveries.map(d => d.binding.paneId)).size).toBe(4);
    expect(h.deliveries.every(d => d.req.text.includes("ห้ามเริ่มงานจริง"))).toBe(true);
    expect(h.calls.filter(a => ["create", "split"].includes(a[3])).every(a => a.includes("--no-focus"))).toBe(true);
    const split = h.calls.filter(a => a[3] === "split"); expect(split[0]).toContain("right"); expect(split.slice(1).every(a => a.includes("down"))).toBe(true);
    await h.lifecycle.create(input); expect(h.deliveries).toHaveLength(4); expect(h.calls.filter(a => a[3] === "start")).toHaveLength(4);
  });
  test("started/idle and bootstrap dispatch ACK alone do not mean agent read rules", async () => {
    const h = setup(); h.noAck(); const op = await h.lifecycle.create(input);
    expect(op.phase).not.toBe("ready"); expect(op.members.some(m => m.ready)).toBe(false);
    expect(h.deliveries).toHaveLength(4); await h.lifecycle.continueOperation(input.id); expect(h.deliveries).toHaveLength(4);
  });
  test("same operation ID with changed payload conflicts without new mutations", async () => {
    const h = setup(); await h.lifecycle.create(input); const count = h.calls.length;
    await expect(h.lifecycle.create({ ...input, label: "other-team" })).rejects.toThrow(); expect(h.calls).toHaveLength(count);
  });
  test("start timeout after side effect can reconcile existing agent without duplicate start", async () => {
    const h = setup(); h.timeout("agent start"); await h.lifecycle.create({ ...input, mode: "single" });
    const recovered = await h.lifecycle.continueOperation(input.id);
    expect(recovered.members[0].launched).toBe(true); expect(h.calls.filter(a => a[3] === "start")).toHaveLength(1);
  });
  test("workspace create timeout remains uncertain across coordinator reload and never creates twice", async () => {
    const h = setup(); h.timeout("workspace create"); const op = await h.lifecycle.create(input); expect(op.phase).toBe("uncertain");
    h.store.close(); const s = new LifecycleStore(h.path); stores.push(s); const restarted = new Lifecycle({ ...h.options, store: s });
    await restarted.continueOperation(input.id); expect(h.calls.filter(a => a[3] === "create")).toHaveLength(1); expect(h.calls.filter(a => a[3] === "start")).toHaveLength(0);
  });
  test("explicit stop is dispatch ctrlc only and does not close runtime or disable autostart", async () => {
    const h = setup(); const op = await h.lifecycle.create({ ...input, mode: "single" }); const binding = h.state.panes[0]; binding.status = "working";
    const count = h.calls.length; await h.lifecycle.stop(binding, "stop-1", binding.instanceId!);
    expect(h.calls).toHaveLength(count); expect(h.deliveries.at(-1)?.req).toMatchObject({ action: "stop", key: "ctrlc" });
    expect(h.lifecycle.status(op.id).desiredAutostart).toBe(true);
  });
  test("closing one member disables only that member and tombstones old identity", async () => {
    const h = setup(); const op = await h.lifecycle.create(input); const old = structuredClone(h.state.panes[1]);
    const preview = await h.lifecycle.closePreview({ workspaceId: op.workspaceId!, paneId: old.paneId });
    expect(preview.autostartWillDisable).toBe(true); expect(preview.historyWillBeKept).toBe(true);
    const result = await h.lifecycle.closeConfirm(preview.id); expect(result.runtimeClosed).toBe(true); expect(result.autostartDisabled).toBe(true);
    const next = h.lifecycle.status(op.id); expect(next.members.filter(m => m.desired)).toHaveLength(3); expect(h.lifecycle.assertOpen(old)).toBe(false);
    await h.lifecycle.closeConfirm(preview.id); expect(h.calls.filter(a => a[3] === "close")).toHaveLength(1);
  });
  test("confirmation expires or member replacement forces fresh confirmation without close", async () => {
    for (const scenario of ["expiry", "replacement"]) {
      const h = setup(); const op = await h.lifecycle.create({ ...input, mode: "single" }); const p = await h.lifecycle.closePreview({ workspaceId: op.workspaceId! });
      if (scenario === "expiry") h.advance(120_001); else h.state.panes[0].instanceId = "new-instance";
      await expect(h.lifecycle.closeConfirm(p.id)).rejects.toThrow(); expect(h.calls.filter(a => a[3] === "close")).toHaveLength(0);
    }
  });
  test("closed workspace is not resurrected by autostart reconciliation", async () => {
    const h = setup(); const op = await h.lifecycle.create(input); const p = await h.lifecycle.closePreview({ workspaceId: op.workspaceId! }); await h.lifecycle.closeConfirm(p.id);
    const before = h.calls.length; await h.lifecycle.reconcile(); expect(h.calls).toHaveLength(before); expect(h.lifecycle.status(op.id).phase).toBe("closed");
  });
  test("legacy migration preserves bytes and repeats without creating agents", () => {
    const h = setup(); const file = join(h.dir, "legacy.json"); const bytes = JSON.stringify([{ label: "demo-old", cwd, agentKind: "codex" }]); writeFileSync(file, bytes);
    const first = h.lifecycle.migrateLegacy(file); expect(first.migrated).toBe(1); expect(readFileSync(first.backup, "utf8")).toBe(bytes); expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(h.lifecycle.migrateLegacy(file).migrated).toBe(0); expect(h.lifecycle.list()[0].phase).toBe("blocked-awaiting-binding"); expect(h.calls).toEqual([]);
  });
  test("missing team restores each proven conversation by exact ID rather than resume last", async () => {
    const h = setup(); const old = await h.lifecycle.create(input); const ids = old.members.map(m => m.conversation!.id);
    h.state.workspaces = []; h.state.panes = []; const startCount = h.calls.filter(a => a[3] === "start").length;
    const restored = (await h.lifecycle.reconcile())[0];
    expect(restored.phase).toBe("ready"); const starts = h.calls.filter(a => a[3] === "start").slice(startCount);
    expect(starts).toHaveLength(4); expect(starts.every(a => !a.includes("--last"))).toBe(true);
    for (let i = 0; i < 4; i++) expect(starts[i]).toContain(ids[i]);
  });
  test("missing workspace without verified bootstrap/conversation never creates a replacement", async () => {
    const h = setup(); h.noAck(); await h.lifecycle.create(input); h.state.workspaces = []; h.state.panes = [];
    const count = h.calls.length; const result = (await h.lifecycle.reconcile())[0];
    expect(result.phase).toBe("blocked-awaiting-binding"); expect(h.calls).toHaveLength(count);
  });
  test("mixed team agent/model/permission settings remain isolated per position", async () => {
    const h = setup(); const members = defaultMembers("team"); members[1] = { role: "worker1", agentKind: "claude", model: "example-claude-model", permission: "bypass" };
    const op = await h.lifecycle.create({ ...input, members }); expect(op.phase).toBe("ready");
    const starts = h.calls.filter(a => a[3] === "start");
    expect(starts[1]).toContain("claude"); expect(starts[1]).toContain("example-claude-model"); expect(starts[1]).toContain("--dangerously-skip-permissions");
    for (const i of [0, 2, 3]) expect(starts[i].some(a => a.includes("dangerously"))).toBe(false);
  });
  test("failure to persist autostart disable prevents runtime close", async () => {
    const h = setup(); const op = await h.lifecycle.create({ ...input, mode: "single" }); const preview = await h.lifecycle.closePreview({ workspaceId: op.workspaceId! });
    h.store.change = () => { throw new Error("simulated durable storage unavailable"); };
    await expect(h.lifecycle.closeConfirm(preview.id)).rejects.toThrow();
    expect(h.calls.filter(a => a[3] === "close")).toHaveLength(0);
  });
  test("readiness keeps checking after sixty seconds with explicit cancellation", async () => {
    const h = setup(); h.state.fresh = false; const callbacks: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const cancel = h.lifecycle.startReadiness((fn, ms) => { const item = { fn, ms, cancelled: false }; callbacks.push(item); return () => { item.cancelled = true; }; });
    for (let i = 0; i < 5; i++) { callbacks[i].fn(); await new Promise<void>(resolve => setImmediate(resolve)); }
    expect(callbacks).toHaveLength(6); expect(callbacks[4].ms).toBe(60_000); expect(callbacks[5].ms).toBe(60_000);
    cancel(); expect(callbacks[5].cancelled).toBe(true); expect(h.calls).toEqual([]);
  });
  test("readiness has explicit scheduler and cancellation with no server startup", () => {
    const h = setup(); const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const cancel = h.lifecycle.startReadiness((fn, ms) => { const item = { fn, ms, cancelled: false }; pending.push(item); return () => { item.cancelled = true; }; });
    expect(pending[0].ms).toBe(5000); expect(h.calls).toEqual([]); cancel(); expect(pending[0].cancelled).toBe(true);
  });
});

test('opt-in launch hook stays inside journal; ACK alone cannot bootstrap and uncertain never retries', async () => {
  for (const receipt of ['acknowledged', 'uncertain'] as const) {
    const h = setup(); let launches = 0;
    const lifecycle = new Lifecycle({ ...h.options, launchAgent: async r => {
      launches++;
      expect(h.store.read().operations[r.operationId].steps[r.stepId].state).toBe('dispatching');
      expect(r.binding.shellReady).toBe(true);
      expect(r.nativeArgs).toContain('--ask-for-approval');
      return { state: receipt };
    } });
    const op = await lifecycle.create({ ...input, mode: 'single' });
    expect(op.members[0].ready).toBe(false); expect(h.deliveries).toHaveLength(0);
    expect(h.calls.some(a => a[3] === 'start')).toBe(false);
    await lifecycle.create({ ...input, mode: 'single' });
    expect(launches).toBe(1);
  }
});

test('opt-in launch becomes ready only after observed identity and assistant acknowledgment', async () => {
  const h = setup();
  const lifecycle = new Lifecycle({ ...h.options, launchAgent: async r => {
    const p = h.state.panes.find(p => p.paneId === r.binding.paneId)!;
    Object.assign(p, { name: r.member.name, agentKind: r.member.agentKind, instanceId: 'fixture-prepared-process', foreground: true, shellReady: false, status: 'idle',
      conversation: { provider: r.member.agentKind, id: '00000000-0000-4000-8000-000000000001' } });
    return { state: 'acknowledged' };
  } });
  const op = await lifecycle.create({ ...input, mode: 'single' });
  expect(op.phase).toBe('ready'); expect(op.members[0].binding?.instanceId).toBe('fixture-prepared-process');
  expect(op.members[0].ackEvidence).toBeDefined(); expect(h.deliveries).toHaveLength(1);
  expect(h.calls.some(a => a[3] === 'start')).toBe(false);
});
