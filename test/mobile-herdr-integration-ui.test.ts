import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Execute the shipped browser queue function with a fake network, never a server or agent.
const html = readFileSync(new URL("../ui/mobile/m.html", import.meta.url), "utf8");
const source = html.slice(html.indexOf("const isHerdr ="), html.indexOf("/** Link back →"));
function harness(online: boolean, request: (path: string, options: any) => Promise<any>) {
  let snapshots: any[] = [];
  const deps: Record<string, any> = {
    // Legacy queue fixture: no continuity extension is installed in this harness.
    mawExt: { beforeSend: [] },
    crypto: { randomUUID: () => "test-request" }, state: { projects: [], filesRoom: "other", files: [] },
    net: { online, error: () => Object.assign(new Error("offline"), { offline: true }) },
    api: request, paintPending() {}, paintNet() {}, playSound() {}, clearDraft() {}, loadScreen() {},
    savePending: () => snapshots.push(JSON.parse(JSON.stringify(get().pendingSends))),
    document: { hidden: false, getElementById: () => null }, setTimeout() {},
    shrinkImage: async (f: any) => f, AbortSignal,
  };
  const get = new Function(...Object.keys(deps), source + ";return () => ({ runSend, pendingSends });")(...Object.values(deps));
  const api = get();
  const message = (id = 1) => ({ id, uid: "r-" + id, ws: "herdr:w1", room: "w1:p1", generation: "g1", continuityToken: "g1", text: "สวัสดี\nทดสอบ", files: [], pics: [], names: [], mode: "", at: Date.now(), state: "waiting", key: "room" });
  return { ...api, message, snapshots, deps };
}

describe("Herdr shipped mobile queue", () => {
  test("offline before dispatch remains waiting and records offline origin", async () => {
    let calls = 0; const h = harness(false, async () => { calls++; }); const p: any = h.message(); h.pendingSends.push(p);
    await h.runSend(p);
    expect(calls).toBe(0); expect(p.state).toBe("waiting"); expect(p.offline).toBe(true); expect(p.requestStarted).toBeUndefined();
  });
  test("lost HTTP response becomes uncertain and is never replayed", async () => {
    let calls = 0; const h = harness(true, async () => { calls++; throw new Error("connection lost"); }); const p: any = h.message(); h.pendingSends.push(p);
    await h.runSend(p); await h.runSend(p);
    expect(calls).toBe(1); expect(p.state).toBe("uncertain"); expect(p.requestStarted).toBe(true);
    expect(h.snapshots.some(s => s[0]?.requestStarted === true && s[0]?.state === "sending")).toBe(true);
  });
  test("ack preserves target generation and native multiline payload", async () => {
    let body: any; const h = harness(true, async (_path, opts) => { body = JSON.parse(opts.body); return { ok: true, state: "acknowledged" }; });
    const p: any = h.message(); h.pendingSends.push(p); await h.runSend(p);
    expect(p.state).toBe("sent"); expect(body.generation).toBe("g1"); expect(body.continuityToken).toBe("g1"); expect(body.text).toBe(p.text);
  });
  test("uncertain predecessor blocks later messages in the same room", async () => {
    let calls = 0; const h = harness(true, async () => { calls++; }); const first: any = h.message(), next: any = h.message(2);
    first.state = "uncertain"; h.pendingSends.push(first, next); await h.runSend(next);
    expect(calls).toBe(0); expect(next.state).toBe("waiting");
  });
  test("changed agent is held rather than automatically retargeted", async () => {
    const h = harness(true, async () => { throw Object.assign(new Error("changed"), { body: { code: "agent_changed", error: "agent เดิมปิดหรือเปลี่ยนแล้ว" } }); });
    const p: any = h.message(); h.pendingSends.push(p); await h.runSend(p);
    expect(p.state).toBe("held"); expect(p.generation).toBe("g1");
  });
});
