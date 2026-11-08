import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { InventoryStore, parseSnapshot } from "../src/mobile/herdr/inventory";
const fixture = () => JSON.parse(readFileSync(join(import.meta.dir, "fixtures/herdr-provider/snapshot-team.json"), "utf8"));

describe("Herdr protocol inventory fail-closed guards", () => {
  test("valid snapshot retains all four independent panes", () => {
    expect(parseSnapshot(JSON.stringify(fixture())).panes).toHaveLength(4);
  });
  test("duplicate identities and cross-workspace links cannot become channels", () => {
    for (const scenario of ["pane", "workspace", "tab-link", "agent-link"]) {
      const value = fixture(), s = value.result.snapshot;
      if (scenario === "pane") s.panes.push({ ...s.panes[0] });
      if (scenario === "workspace") s.workspaces.push({ ...s.workspaces[0] });
      if (scenario === "tab-link") s.panes[0].tab_id = "w9:t1";
      if (scenario === "agent-link") s.agents[0].terminal_id = "foreign-terminal";
      expect(() => parseSnapshot(JSON.stringify(value))).toThrow();
    }
  });
  test("missing upstream required envelope and snapshot fields are rejected", () => {
    for (const field of ["id", "layouts", "focused", "revision"]) {
      const value = fixture();
      if (field === "id") delete value.id;
      else if (field === "layouts") delete value.result.snapshot.layouts;
      else delete value.result.snapshot.panes[0][field];
      expect(() => parseSnapshot(JSON.stringify(value))).toThrow();
    }
  });
  test("concurrent refresh shares one snapshot call and never invokes mutation", async () => {
    const calls: string[][] = []; let release!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    const store = new InventoryStore(async args => {
      calls.push(args);
      if (args[2] !== "api") throw new Error("process evidence unavailable");
      await barrier; return JSON.stringify(fixture());
    }, () => 1000);
    const a = store.refresh(), b = store.refresh(); release(); await Promise.all([a, b]);
    expect(calls.filter(a => a[2] === "api")).toHaveLength(1);
    expect(calls.every(a => a[2] === "api" || a[3] === "process-info")).toBe(true);
  });
  test("observation gap invalidates continuity rather than reusing old generation", async () => {
    let now = 1000;
    const store = new InventoryStore(async args => {
      if (args[2] === "api") return JSON.stringify(fixture());
      throw new Error("process evidence unavailable");
    }, () => now, 100);
    await store.refresh(); const old = store.resolve("herdr:w7", "w7:p1")!;
    now += 101; expect(store.resolve("herdr:w7", "w7:p1")).toBeNull();
    await store.refresh(); expect(store.resolve("herdr:w7", "w7:p1")!.generation).not.toBe(old.generation);
  });
  test("failed refresh invalidates cached write resolution; recovery does not revive generation", async () => {
    let fail = false;
    const store = new InventoryStore(async args => {
      if (args[2] !== "api") throw new Error("no process evidence");
      if (fail) throw new Error("server unavailable");
      return JSON.stringify(fixture());
    }, () => 1000);
    await store.refresh(); const old = store.resolve("herdr:w7", "w7:p1")!;
    fail = true; await expect(store.refresh()).rejects.toThrow();
    expect(store.resolve("herdr:w7", "w7:p1")).toBeNull();
    fail = false; await store.refresh();
    expect(store.resolve("herdr:w7", "w7:p1")!.generation).not.toBe(old.generation);
  });
});
