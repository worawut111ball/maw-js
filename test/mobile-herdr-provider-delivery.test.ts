import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DeliveryLedger, withRoomLock } from "../src/mobile/herdr/delivery";
const dirs: string[] = [], ledgers: DeliveryLedger[] = [];
afterEach(() => { for (const l of ledgers.splice(0)) l.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function file() { const d = mkdtempSync(join(tmpdir(), "herdr-ledger-")); dirs.push(d); return join(d, "ledger.sqlite"); }
function ledger(path = file(), now = () => 1_000_000, max = 10_000) { const l = new DeliveryLedger(path, now, max); ledgers.push(l); return l; }
const payload = { action: "prompt", text: "ข้อความไทย", expectedGeneration: "gen-one" };
describe("Herdr durable ledger crash/retry invariants", () => {
  test("dispatching is persisted before caller performs any side effect", () => {
    const path = file(), first = ledger(path); const result = first.claim("message-1", "room-one", payload, "gen-one");
    expect(result.claimed).toBe(true); expect(result.result.state).toBe("dispatching"); expect(statSync(path).mode & 0o777).toBe(0o600);
    const observer = ledger(path); expect(observer.status("message-1", "room-one").state).toBe("dispatching");
  });
  test("process interruption after persisted intent is uncertain rather than safe retry", () => {
    const path = file(), first = ledger(path); first.claim("crash-1", "room-one", payload, "gen-one"); first.close();
    const recovered = ledger(path); expect(recovered.status("crash-1", "room-one").state).toBe("uncertain");
    const retry = recovered.claim("crash-1", "room-one", payload, "gen-one"); expect(retry.claimed).toBe(false); expect(retry.result.state).toBe("uncertain");
  });
  test("acknowledged result survives a new ledger instance and never reclaims", () => {
    const path = file(), first = ledger(path); first.claim("ack-1", "room-one", payload, "gen-one"); first.complete("ack-1", "acknowledged"); first.close();
    const second = ledger(path); const retry = second.claim("ack-1", "room-one", payload, "gen-one"); expect(retry.claimed).toBe(false); expect(retry.result.state).toBe("acknowledged");
  });
  test("same ID changed scope or payload cannot inherit earlier acknowledgement", () => {
    const l = ledger(); l.claim("conflict-1", "room-one", payload, "gen-one"); l.complete("conflict-1", "acknowledged");
    expect(() => l.claim("conflict-1", "room-two", payload, "gen-two")).toThrow();
    expect(() => l.claim("conflict-1", "room-one", { ...payload, text: "different" }, "gen-one")).toThrow();
    expect(l.status("conflict-1", "room-two").state).toBe("unknown");
  });
  test("uncertain entries are not evicted solely by elapsed TTL", () => {
    let now = 1_000_000; const l = ledger(file(), () => now); l.claim("old-1", "room-one", payload, "gen-one"); l.complete("old-1", "uncertain");
    now += 365 * 24 * 60 * 60_000;
    expect(l.status("old-1").state).toBe("uncertain"); expect(l.claim("old-1", "room-one", payload, "gen-one").claimed).toBe(false);
  });
  test("full ledger rejects new claims and retains unresolved records", () => {
    const l = ledger(file(), () => 1000, 1); l.claim("first", "room-one", payload, "gen-one"); l.complete("first", "uncertain");
    expect(() => l.claim("second", "room-one", payload, "gen-one")).toThrow(); expect(l.status("first").state).toBe("uncertain");
  });
  test("corrupt or unwritable store cannot fall back to memory acceptance", () => {
    const path = file(); writeFileSync(path, "not a sqlite database");
    expect(() => ledger(path).claim("bad-1", "room-one", payload, "gen-one")).toThrow();
    const parentIsFile = file(); writeFileSync(parentIsFile, "not a directory");
    expect(() => ledger(join(parentIsFile, "child.sqlite")).claim("bad-2", "room-one", payload, "gen-one")).toThrow();
  });
  test("explicit user resolution unblocks queue without pretending old delivery acknowledged", () => {
    const l = ledger(); l.claim("uncertain-parent", "room-one", payload, "gen-one"); l.complete("uncertain-parent", "uncertain");
    expect(l.hasUncertain("room-one")).toBe(true); const result = l.resolve("uncertain-parent", "room-one");
    expect(result.state).toBe("uncertain"); expect(result.code).toBe("resolved_by_user"); expect(l.hasUncertain("room-one")).toBe(false);
    expect(l.claim("uncertain-parent", "room-one", payload, "gen-one").claimed).toBe(false);
  });
  test("resolution requires matching scope and acknowledged replacement", () => {
    const l = ledger(); l.claim("old-parent", "room-one", payload, "gen-one"); l.complete("old-parent", "uncertain");
    expect(() => l.resolve("old-parent", "room-two")).toThrow();
    l.claim("new-child", "room-one", payload, "gen-one");
    expect(() => l.resolve("old-parent", "room-one", "new-child")).toThrow();
    l.complete("new-child", "acknowledged"); expect(l.resolve("old-parent", "room-one", "new-child").code).toBe("superseded_by:new-child");
    expect(l.status("old-parent").state).toBe("uncertain");
  });
  test("coordinator serializes one room and releases the lock after rejection", async () => {
    const seen: string[] = []; let release!: () => void; const barrier = new Promise<void>(r => { release = r; });
    const first = withRoomLock("demo-room", async () => { seen.push("first"); await barrier; throw new Error("simulated failure"); });
    const second = withRoomLock("demo-room", async () => { seen.push("second"); });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(seen).toEqual(["first"]); release(); await expect(first).rejects.toThrow(); await second; expect(seen).toEqual(["first", "second"]);
  });
});
