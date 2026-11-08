import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHerdrRuntime } from "../src/mobile/herdr/runtime";
import { Lifecycle, LifecycleStore, type Binding, type LifecycleSnapshot } from "../src/mobile/herdr/lifecycle";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function pendingClaude(status = "blocked", verified = true) {
  const snapshot = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/herdr-provider/snapshot-team.json"), "utf8"));
  const pane = snapshot.result.snapshot.panes[1], agent = snapshot.result.snapshot.agents[1];
  pane.agent_status = status; agent.agent_status = status; agent.launch_pending = true;
  const mutations: string[][] = [];
  const runner = async (args: string[]) => {
    const a = args.slice(2);
    if (a[0] === "api") return JSON.stringify(snapshot);
    if (a[1] === "process-info") return JSON.stringify({ id: "review", result: { type: "pane_process_info", process_info: {
      pane_id: a[a.indexOf("--pane") + 1], shell_pid: 100, foreground_process_group_id: 100,
      foreground_processes: [{ pid: verified ? 200 : 100, name: "claude.exe" }],
    } } });
    if (a[1] === "read") return "Choose option\n❯ 1. Allow\n  2. Deny";
    if (a[0] === "agent" && a[1] === "send-keys") { mutations.push(a); return JSON.stringify({ id: "review", result: { type: "ok" } }); }
    throw new Error("Unexpected review runner call: " + JSON.stringify(a));
  };
  const runtime = createHerdrRuntime({ runner, ledgerPath: ":memory:", parseDialog: () => ({ kind: "menu", question: "Choose option", options: [{ n: 1, label: "Allow", sel: true }, { n: 2, label: "Deny" }] }) });
  cleanup.push(() => runtime.close()); return { runtime, mutations };
}
describe("independent review of live startup contract regressions", () => {
  test("verified claude.exe with launch_pending blocked can answer a fresh dialog exactly once", async () => {
    const h = pendingClaude(); await h.runtime.refresh(); const ch = h.runtime.resolve("herdr:w7", "w7:p2")!;
    expect(ch.capabilities.answer).toBe(true); expect(ch.capabilities.prompt).toBe(false);
    const dialog = await h.runtime.dialog(ch); const request = { id: "live-review-answer", action: "answer" as const, n: 1, expectedGeneration: ch.generation, expectedDialogToken: dialog.dialogToken };
    expect((await h.runtime.dispatch(ch, request)).state).toBe("acknowledged");
    expect((await h.runtime.dispatch(ch, request)).state).toBe("acknowledged");
    expect(h.mutations).toEqual([["agent", "send-keys", "w7:p2", "1"]]);
  });
  test("launch_pending idle does not inherit the blocked-dialog exception", async () => {
    const h = pendingClaude("idle"); await h.runtime.refresh(); const ch = h.runtime.resolve("herdr:w7", "w7:p2")!;
    expect(ch.capabilities.keys).toBe(false); expect(ch.capabilities.prompt).toBe(false); expect(h.mutations).toEqual([]);
  });
  test("launch_pending blocked without a distinct verified child PID cannot answer", async () => {
    const h = pendingClaude("blocked", false); await h.runtime.refresh(); const ch = h.runtime.resolve("herdr:w7", "w7:p2")!;
    expect(ch.capabilities.answer).toBe(false); expect(ch.capabilities.keys).toBe(false); expect(h.mutations).toEqual([]);
  });
  test("agent startup CLI gets 60 seconds and the enclosing transport outlives that deadline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-live-review-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new LifecycleStore(join(dir, "state.sqlite")); cleanup.push(() => store.close());
    const p: Binding = { workspaceId: "w7", paneId: "w7:p1", terminalId: "review-terminal", instanceId: null, cwd: "/home/example/project", agentKind: null, name: null, status: "unknown", foreground: false, shellReady: true };
    const state: LifecycleSnapshot = { fresh: true, workspaces: [], panes: [] };
    const starts: { args: string[]; timeout: number | undefined }[] = [];
    const lifecycle = new Lifecycle({ store, allowDir: p => p, snapshot: async () => structuredClone(state), dispatch: async () => { throw new Error("unready agent must not get input"); }, acknowledgments: async () => [], runner: async (args, timeout) => {
      const a = args.slice(2);
      if (a[0] === "workspace" && a[1] === "create") { state.workspaces.push({ id: "w7", label: "review-room" }); state.panes.push(p); return JSON.stringify({ id: "review", result: { type: "workspace_created", workspace: { workspace_id: "w7", label: "review-room" }, root_pane: { pane_id: p.paneId, terminal_id: p.terminalId, workspace_id: "w7" } } }); }
      if (a[0] === "agent" && a[1] === "start") { starts.push({ args, timeout }); p.name = a[2]; p.agentKind = "codex"; return JSON.stringify({ id: "review", result: { type: "agent_started", agent: { pane_id: p.paneId, workspace_id: "w7", name: p.name, agent: "codex" } } }); }
      throw new Error("unexpected lifecycle review operation");
    } });
    await lifecycle.create({ id: "review-timeout", label: "review-room", cwd: p.cwd, mode: "single", autostart: false });
    expect(starts).toHaveLength(1); const start = starts[0]; expect(start.args[start.args.indexOf("--timeout") + 1]).toBe("60000"); expect(start.timeout!).toBeGreaterThan(60_000);
  });
});
