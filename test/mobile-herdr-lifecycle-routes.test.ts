import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mount } from "../src/mobile/features/herdr";
import { LifecycleError } from "../src/mobile/herdr/lifecycle";

function harness() {
  const calls: { method: string; args: any[] }[] = []; let failure: Error | null = null;
  const invoke = (method: string, ...args: any[]) => { calls.push({ method, args }); if (failure) throw failure; };
  const lifecycle: any = {
    list() { invoke("list"); return []; }, readiness: { state: "waiting" },
    async create(input: any) { invoke("create", input); return { id: input.id, phase: "partial", members: [] }; },
    status(id: string) { invoke("status", id); return { id, phase: "partial" }; },
    async continueOperation(id: string) { invoke("continue", id); return { id, phase: "uncertain" }; },
    setAutostart(...args: any[]) { invoke("autostart", ...args); return { id: args[0] }; },
    async closePreview(scope: any) { invoke("preview", scope); return { id: "preview-one", scope, autostartWillDisable: true, historyWillBeKept: true }; },
    async closeConfirm(id: string) { invoke("confirm", id); return { state: "uncertain", autostartDisabled: true, runtimeClosed: false }; },
    async stop(...args: any[]) { invoke("stop", ...args); return { state: "acknowledged", ok: true }; },
  };
  const target: any = { workspaceId: "w7", paneId: "w7:p1", terminalId: "demo-terminal", instanceId: "instance-one" };
  const app = new Elysia({ prefix: "/mobile" });
  mount(app, { lifecycle, resolve: async (...args) => { invoke("resolve", ...args); return target; } });
  const req = (path: string, body?: unknown) => app.handle(new Request("http://local/mobile/herdr" + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { calls, req, fail: (e: Error) => { failure = e; } };
}
describe("Herdr lifecycle feature routes with injected coordinator", () => {
  test("operation partial/uncertain states are preserved instead of reported ready", async () => {
    const h = harness(); const create = await h.req("/create", { id: "create-one", mode: "single", cwd: "/home/example/project", label: "demo" });
    expect(create.status).toBe(200); expect((await create.json()).operation.phase).toBe("partial");
    const resume = await h.req("/operations/create-one/continue", {}); expect((await resume.json()).operation.phase).toBe("uncertain");
  });
  test("close preview and confirmation preserve distinct autostart/runtime outcomes", async () => {
    const h = harness(); const preview = await h.req("/close/preview", { workspaceId: "w7", paneId: "w7:p1" });
    expect((await preview.json()).preview).toMatchObject({ autostartWillDisable: true, historyWillBeKept: true });
    const result = await h.req("/close/confirm", { previewId: "preview-one" });
    expect((await result.json()).close).toMatchObject({ state: "uncertain", autostartDisabled: true, runtimeClosed: false });
  });
  test("stop requires current generation lookup rather than trusting client target", async () => {
    const h = harness(); const r = await h.req("/stop", { ws: "herdr:w7", room: "w7:p1", generation: "generation-one", id: "stop-one" });
    expect(r.status).toBe(200); expect(h.calls[0]).toEqual({ method: "resolve", args: ["herdr:w7", "w7:p1", "generation-one"] });
    expect(h.calls[1].method).toBe("stop"); expect(h.calls[1].args[2]).toBe("instance-one");
  });
  test("invalid close/stop/autostart inputs do not call coordinator", async () => {
    for (const [path, body] of [["/close/preview", {}], ["/close/confirm", {}], ["/stop", { id: "stop-one" }], ["/operations/op/autostart", { on: "false" }]] as const) {
      const h = harness(); const r = await h.req(path, body); expect(r.status).toBe(400); expect(h.calls).toEqual([]);
    }
  });
  test("known coordinator errors retain safe code/status without raw exception", async () => {
    const h = harness(); h.fail(new LifecycleError("workspace_label_conflict", 409));
    const r = await h.req("/create", { id: "create-one" }); expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ ok: false, code: "workspace_label_conflict" });
    const raw = harness(); raw.fail(new Error("private data must never escape")); const response = await raw.req("/status");
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private data must never escape");
  });
  test("lifecycle status is no-store and does not create or mutate rooms", async () => {
    const h = harness(); const r = await h.req("/status"); expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toContain("no-store"); expect(h.calls.map(c => c.method)).toEqual(["list"]);
  });
});
