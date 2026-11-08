import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHerdrRuntime } from "../src/mobile/herdr/runtime";
import { createLifecycleHost } from "../src/mobile/herdr/production";
const dirs: string[] = [];
const hosts: ReturnType<typeof createLifecycleHost>[] = [], runtimes: ReturnType<typeof createHerdrRuntime>[] = [];
afterEach(() => { for (const h of hosts.splice(0)) h.close(); for (const r of runtimes.splice(0)) r.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup(sameGroup = false, claudeName = "claude", helpers: any[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-host-")); dirs.push(dir);
  const raw = readFileSync(join(import.meta.dir, "fixtures/herdr-provider/snapshot-team.json"), "utf8");
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push([...args]); if (args[2] === "api" && args[3] === "snapshot") return raw;
    if (args[2] === "pane" && args[3] === "process-info") {
      const pane = args[args.indexOf("--pane") + 1]; const name = pane === "w7:p2" ? claudeName : "codex";
      return JSON.stringify({ id: "fixture-request", result: { type: "pane_process_info", process_info: { pane_id: pane, shell_pid: 100, foreground_process_group_id: sameGroup ? 100 : 200,
        foreground_processes: [{ pid: 200, name, cwd: "/home/example/project" }, ...helpers] } } });
    }
    throw new Error("unexpected host call: " + JSON.stringify(args));
  };
  const runtime = createHerdrRuntime({ runner, ledgerPath: join(dir, "delivery.sqlite") }); runtimes.push(runtime);
  const host = createLifecycleHost({ runtime, runner, storePath: join(dir, "lifecycle.sqlite"), legacyFile: join(dir, "absent-legacy.json"), allowDir: p => p === "/home/example/project" ? p : null }); hosts.push(host);
  return { runtime, host, calls };
}
describe("production lifecycle wiring through fully injected ports", () => {
  test("construction is lazy and snapshot joins native provider/generation without mutation", async () => {
    const h = setup(); expect(h.calls).toEqual([]); const snapshot = await h.host.snapshot();
    expect(snapshot.fresh).toBe(true); expect(snapshot.panes).toHaveLength(4);
    expect(snapshot.panes.every(p => p.foreground && p.instanceId && p.conversation)).toBe(true);
    expect(h.calls.every(a => a[2] === "api" || a[3] === "process-info")).toBe(true);
  });
  test("foreground evidence contract is consistent when shell and child share process group", async () => {
    const h = setup(true); await h.runtime.refresh(); const ch = h.runtime.resolve("herdr:w7", "w7:p1")!;
    expect(ch.capabilities.prompt).toBe(true);
    const snapshot = await h.host.snapshot(); const binding = snapshot.panes.find(p => p.paneId === ch.paneId)!;
    expect(binding.foreground).toBe(true); expect(binding.instanceId).not.toBeNull();
  });
});

test("Mac Claude executable named claude.exe remains a verified foreground agent", async () => {
  const h = setup(false, "claude.exe"); await h.runtime.refresh();
  expect(h.runtime.resolve("herdr:w7", "w7:p2")!.capabilities.keys).toBe(true);
  const snapshot = await h.host.snapshot();
  expect(snapshot.panes.find(p => p.paneId === "w7:p2")!.foreground).toBe(true);
});

test("foreground helper changes preserve agent binding but a second matching agent blocks it", async () => {
  const helpers:any[]=[]; const h=setup(false,"claude",helpers);
  const before=(await h.host.snapshot()).panes[0];
  const generation=h.runtime.resolve("herdr:w7","w7:p1")!.generation;
  helpers.push({pid:201,name:"helper"});
  const after=(await h.host.snapshot()).panes[0];
  expect(after.instanceId).toBe(before.instanceId);
  expect(h.runtime.resolve("herdr:w7","w7:p1")!.generation).toBe(generation);
  helpers.push({pid:202,name:"codex"});
  expect((await h.host.snapshot()).panes[0].foreground).toBe(false);
  expect(h.runtime.resolve("herdr:w7","w7:p1")!.capabilities.keys).toBe(false);
});
