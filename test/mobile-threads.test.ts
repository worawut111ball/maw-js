import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mount, projectKey, type ThreadDeps } from "../src/mobile/features/threads";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "maw-threads-")), vault = new Map<string, string>();
  const d: ThreadDeps = { root, keychain: { set: (a, v) => { vault.set(a, v); }, get: a => vault.get(a) ?? null, del: a => { vault.delete(a); } } };
  const app = new Elysia({ prefix: "/mobile" }); mount(app, d);
  const call = async (method: string, path: string, body?: any) => {
    const r = await app.handle(new Request("http://localhost/mobile" + path, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }));
    return { status: r.status, j: await r.json().catch(() => null) as any, headers: r.headers };
  };
  return { root, vault, call };
}
const P = "facwms";

describe("threads", () => {
  test("first open creates the 5 default threads · summary counts them", async () => {
    const { call } = setup();
    const r = await call("GET", `/threads?project=${P}`);
    expect(r.j.threads.map((t: any) => t.icon + t.name)).toEqual(["#คำสั่งรัน", "#deploy", "🔒รหัส", "#ไฟล์", "#บันทึกงาน"]);
    expect((await call("GET", "/threads/summary")).j.projects[P].count).toBe(5);
  });
  test("command item · pin sorts first · delete", async () => {
    const { call } = setup(); const t = (await call("GET", `/threads?project=${P}`)).j.threads[0].id;
    const a = (await call("POST", `/threads/${t}/items`, { project: P, kind: "cmd", title: "dev", code: "bun run dev" })).j.item;
    const b = (await call("POST", `/threads/${t}/items`, { project: P, kind: "note", title: "โน้ต" })).j.item;
    await call("POST", `/threads/${t}/items/${a.id}/update`, { project: P, pinned: true });
    const items = (await call("GET", `/threads/${t}?project=${P}`)).j.items;
    expect(items.map((x: any) => x.title)).toEqual(["dev", "โน้ต"]);
    expect((await call("POST", `/threads/${t}/items`, { project: P, kind: "cmd", title: "x", code: " " })).status).toBe(400);
    await call("POST", `/threads/${t}/items/${b.id}/delete`, { project: P });
    expect((await call("GET", `/threads/${t}?project=${P}`)).j.items.length).toBe(1);
  });
  test("secret: value only in the keychain, never in the file or list · reveal no-store · delete removes it", async () => {
    const { call, vault, root } = setup(); const t = (await call("GET", `/threads?project=${P}`)).j.threads[2].id;
    const it = (await call("POST", `/threads/${t}/items`, { project: P, kind: "secret", title: "DB dev", secret: "s3cr3t-ค่า" })).j.item;
    expect(vault.get(`${projectKey(P)}/${it.id}`)).toBe("s3cr3t-ค่า");
    expect(readFileSync(join(root, `${projectKey(P)}.json`), "utf8")).not.toContain("s3cr3t");
    expect(JSON.stringify((await call("GET", `/threads/${t}?project=${P}`)).j)).not.toContain("s3cr3t");
    const rv = await call("POST", `/threads/${t}/items/${it.id}/reveal`, { project: P });
    expect(rv.j.value).toBe("s3cr3t-ค่า"); expect(rv.headers.get("cache-control")).toBe("no-store");
    await call("POST", `/threads/${t}/items/${it.id}/delete`, { project: P });
    expect(vault.size).toBe(0);
  });
  test("deleting a thread removes its secrets and files", async () => {
    const { call, vault, root } = setup(); const t = (await call("POST", "/threads", { project: P, name: "ใหม่" })).j.thread.id;
    await call("POST", `/threads/${t}/items`, { project: P, kind: "secret", title: "k", secret: "v" });
    const app2 = await call("GET", `/threads/${t}?project=${P}`); expect(app2.j.items.length).toBe(1);
    await call("POST", `/threads/${t}/delete`, { project: P });
    expect(vault.size).toBe(0);
    expect((await call("GET", `/threads/${t}?project=${P}`)).status).toBe(404);
  });
  test("projectKey keeps Thai, strips path tricks", () => {
    expect(projectKey("../../etc")).toBe("etc"); expect(projectKey("ทดสอบ โปรเจค")).toBe("ทดสอบ_โปรเจค");
  });
});
