import { describe, expect, test } from "bun:test";
import { createMobileApi, typeInto, typeLiteral, pressKey } from "../src/mobile/api";
import { HerdrError, type HerdrRuntime, type HerdrChannel } from "../src/mobile/herdr/runtime";

function harness() {
  const calls: { method: string; args: any[] }[] = [];
  let missing = false, failure = false, delivery = "acknowledged";
  const channel: HerdrChannel = { kind: "herdr", endpointId: "local", session: "default", workspaceId: "w7", paneId: "w7:p1", terminalId: "demo-terminal", label: "demo-room", agent: "codex", generation: "generation-one", conversation: null, continuityToken: "continuity-one",
    capabilities: { screen: true, history: false, prompt: true, keys: true, answer: true, stop: true, create: false, close: false } };
  const record = (method: string, ...args: any[]) => { calls.push({ method, args }); };
  const runtime: HerdrRuntime = {
    async refresh() { record("refresh"); if (failure) throw new HerdrError("herdr_unavailable", 503); },
    resolve(ws, room) { record("resolve", ws, room); return !missing && ws === "herdr:w7" && room === "w7:p1" ? channel : null; },
    async listProjects() { record("listProjects"); return []; },
    async screen(ch, lines) { record("screen", ch, lines); return "จอจริงตัวอย่าง"; },
    async history(ch, query) { record("history", ch, query); return { ok: true, kind: "none", available: false, reason: "native_session_missing" }; },
    async dispatch(ch, req) { record("dispatch", ch, req); return { id: req.id, state: delivery as any, ok: delivery === "acknowledged", generation: ch.generation }; },
    deliveryStatus(id, ch) { record("deliveryStatus", id, ch); return { id, state: "unknown", ok: false }; },
    resolveDelivery(id, ch) { record("resolveDelivery", id, ch); return { id, state: "uncertain", ok: false, code: "resolved_by_user" }; },
    async dialog(ch) { record("dialog", ch); return { ok: true, prompt: null, generation: ch.generation }; },
    close() {}, setDialogParser() {}, setDispatchGuard() {},
  };
  const token = "synthetic-mobile-token";
  const app = createMobileApi({ token, hookToken: "synthetic-hook-token", allowedLogins: [] }, { herdr: runtime });
  calls.length = 0;
  const req = (path: string, body?: unknown, authorized = true) => app.handle(new Request("http://local/mobile" + path, {
    method: body === undefined ? "GET" : "POST", headers: { ...(authorized ? { authorization: "Bearer " + token } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { calls, req, channel, runtime, missing: () => { missing = true; }, fail: () => { failure = true; }, uncertain: () => { delivery = "uncertain"; } };
}
const base = "/rooms/herdr%3Aw7/w7%3Ap1";
describe("Herdr HTTP provider guards through authenticated app.handle", () => {
  test("auth rejects every provider surface before runtime access", async () => {
    const h = harness();
    for (const path of ["/projects", base + "/chat", base + "/screen", base + "/delivery/id", base + "/prompt", "/herdr/status"])
      expect((await h.req(path, undefined, false)).status).toBe(401);
    for (const path of [base + "/send", base + "/prompt/answer", base + "/prompt/type", base + "/prompt/key", "/herdr/create", "/herdr/close/preview", "/herdr/close/confirm", "/herdr/stop"])
      expect((await h.req(path, { id: "request-1", generation: "g", text: "hello", key: "enter", n: 1 }, false)).status).toBe(401);
    expect(h.calls).toEqual([]);
  });
  test("chat lacking native history stays none instead of guessed transcript", async () => {
    const h = harness(); const r = await h.req(base + "/chat?limit=2");
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ kind: "none", available: false });
    expect(h.calls.find(c => c.method === "history")?.args[0].paneId).toBe("w7:p1");
    expect(h.calls.some(c => c.method === "dispatch")).toBe(false);
  });
  test("screen uses injected provider without terminal fallback to another provider", async () => {
    const h = harness(); const r = await h.req(base + "/screen?lines=12");
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ content: "จอจริงตัวอย่าง" });
    expect(h.calls.find(c => c.method === "screen")?.args[0]).toBe(h.channel);
  });
  test("prompt maps generation, continuity, age and ID into guarded dispatch", async () => {
    const h = harness(); const body = { id: "request-1", generation: "generation-one", continuityToken: "continuity-one", offline: true, createdAt: 1234, text: "ภาษาไทย", parentId: "earlier" };
    const r = await h.req(base + "/send", body); expect(r.status).toBe(200);
    expect(h.calls.find(c => c.method === "dispatch")?.args[1]).toMatchObject({ id: body.id, action: "prompt", expectedGeneration: body.generation, continuityToken: body.continuityToken, offline: true, createdAt: 1234, text: body.text, parentId: "earlier" });
  });
  test("uncertain dispatch is visible conflict rather than successful send", async () => {
    const h = harness(); h.uncertain(); const r = await h.req(base + "/send", { id: "request-1", generation: "generation-one", text: "hello" });
    expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ state: "uncertain", ok: false, error: "ยังยืนยันการส่งไม่ได้" });
  });
  test("missing membership fails before dispatch and legacy clear/merge cannot bypass", async () => {
    const h = harness(); h.missing(); expect((await h.req(base + "/send", { id: "request-1", generation: "g", text: "hello" })).status).toBe(409);
    expect(h.calls.some(c => c.method === "dispatch")).toBe(false);
    for (const extra of [{ clear: true }, { merge: true }, { key: "clearbox" }]) {
      const h = harness(); expect((await h.req(base + "/send", { id: "request-1", generation: "g", text: "hello", ...extra })).status).toBe(409);
      expect(h.calls.some(c => c.method === "dispatch")).toBe(false);
    }
  });
  test("delivery status is scoped to resolved room and never triggers a new send", async () => {
    const h = harness(); const r = await h.req(base + "/delivery/request-1");
    expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toContain("no-store");
    expect(await r.json()).toMatchObject({ state: "unknown" });
    expect(h.calls.find(c => c.method === "deliveryStatus")?.args).toEqual(["request-1", h.channel]);
    expect(h.calls.some(c => c.method === "dispatch")).toBe(false);
  });
  test("dialog answer carries token and generation through existing permission route", async () => {
    const h = harness(); const r = await h.req(base + "/prompt/answer", { id: "answer-1", generation: "generation-one", dialogToken: "dialog-one", n: 1 });
    expect(r.status).toBe(200);
    expect(h.calls.find(c => c.method === "dispatch")?.args[1]).toMatchObject({ action: "answer", id: "answer-1", expectedGeneration: "generation-one", expectedDialogToken: "dialog-one", n: 1 });
  });
  test("unavailable inventory returns safe code without attempting send", async () => {
    const h = harness(); h.fail(); const r = await h.req(base + "/send", { id: "request-1", generation: "g", text: "hello" });
    expect(r.status).toBe(503); expect(await r.json()).toMatchObject({ code: "herdr_unavailable" });
    expect(h.calls.some(c => c.method === "dispatch")).toBe(false);
  });
  test("generic feature input helpers refuse Herdr without using runtime/CLI", async () => {
    const h = harness();
    await expect(typeInto(h.channel, "hello")).rejects.toThrow("guarded_dispatch_required");
    await expect(typeLiteral(h.channel, "hello")).rejects.toThrow("guarded_dispatch_required");
    await expect(pressKey(h.channel, "enter")).rejects.toThrow("guarded_dispatch_required");
    expect(h.calls).toEqual([]);
  });
});
