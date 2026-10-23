import { beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  normMe, normMail, normMailList, mailDetail, mailActions, mailStatusText, needsMe, normChats, normChat,
  mapError, mindApi, mailPass, mount, resetCache, scrub, MindError, type MindDeps,
} from "../src/mobile/features/mind";

// fake Mind — shapes copied from a read-only call (23 ต.ค. 69); never the real server
const TOKEN = "mind_SECRET_token_abcdef123456";
const ME = { email: "ball@x.co", agent: "ball-agent", isAdmin: true, noAgent: false, usedToday: 1200, dailyTokenLimit: 0, models: ["a"], modelDefault: "a", cliEngines: ["claude"] };
const MAIL = (o: any = {}) => ({ id: "a1b2c3d4e5f60789", ts: 1_000, status: "replied", from: "hp-agent", fromOwner: "hp@x.co", to: "ball-agent", toOwner: "ball@x.co", subject: "สวัสดี", body: "เนื้อหา", ...o });

interface Call { url: string; method: string; body: any; headers: Record<string, string> }
function fake(routes: Record<string, (c: Call) => { status?: number; json?: any; text?: string } | Error>, cfg: any = { baseUrl: "https://mind.test", token: TOKEN }) {
  const calls: Call[] = [], pushes: { sid: string; kind: string; msg: any }[] = [];
  let now = 1_000_000;
  const d: MindDeps = {
    config: () => cfg,
    fetch: async (url, init) => {
      const c: Call = { url, method: String(init.method ?? "GET"), body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as any };
      calls.push(c);
      const path = new URL(url).pathname, h = routes[`${c.method} ${path}`];
      const r = h ? h(c) : { status: 404, json: { error: "not found" } };
      if (r instanceof Error) throw r;
      return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
    },
    notify: async (sid, kind, msg) => { pushes.push({ sid, kind, msg }); return 1; },
    now: () => now,
  };
  return { d, calls, pushes, tick: (ms: number) => { now += ms; } };
}
const app = (d: MindDeps) => { const a = new Elysia({ prefix: "/mobile" }); mount(a, d); return a; };
const req = async (a: any, path: string, body?: any) => {
  const res = await a.handle(new Request("http://localhost/mobile" + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
};

beforeEach(() => resetCache());

describe("normalize", () => {
  test("me keeps only the subset", () => {
    expect(normMe(ME)).toEqual({ email: "ball@x.co", agent: "ball-agent", usedToday: 1200, dailyTokenLimit: 0 });
  });
  test("รอฉัน = pending + sent to me (held too); actions follow Mind's rules", () => {
    const e = "ball@x.co";
    expect(needsMe(MAIL({ status: "pending" }), e)).toBe(true);
    expect(needsMe(MAIL({ status: "pending", held: "ต้องตัดสินใจ" }), e)).toBe(true);
    expect(needsMe(MAIL({ status: "pending", toOwner: "hp@x.co" }), e)).toBe(false);   // waiting on the other owner
    expect(needsMe(MAIL({ status: "failed" }), e)).toBe(false);
    expect(mailActions(MAIL({ status: "pending" }), e)).toEqual(["approve", "reject"]);
    expect(mailActions(MAIL({ status: "failed" }), e)).toEqual(["retry"]);
    expect(mailActions(MAIL({ status: "replied" }), e)).toEqual([]);
    expect(mailActions(MAIL({ status: "pending", toOwner: "hp@x.co" }), e)).toEqual([]);
    expect(mailStatusText(MAIL({ status: "pending", held: "x" }), e)).toBe("⏸️ รอคุณตัดสินใจ");
    expect(mailStatusText(MAIL({ status: "pending", toOwner: "hp@x.co" }), e)).toBe("📨 รอปลายทางอนุมัติ");
  });
  test("list newest first, body only as a preview", () => {
    const long = "ก".repeat(500);
    const l = normMailList({ mail: [MAIL({ id: "old", ts: 1 }), MAIL({ id: "new", ts: 9, status: "pending", body: long }), { junk: 1 }], pending: 1, mode: "semi" }, "ball@x.co");
    expect(l.mail.map(m => m.id)).toEqual(["new", "old"]);
    expect(l).toMatchObject({ total: 2, pending: 1, waiting: 1, mode: "semi" });
    expect(l.mail[0].preview.length).toBe(160);
    expect((l.mail[0] as any).body).toBeUndefined();
    expect(normMailList({ mail: [], mode: "weird" }, "").mode).toBe("manual");
  });
  test("detail has the full body and thread links", () => {
    const raw = { mail: [MAIL({ id: "p", subject: "ถาม" }), MAIL({ id: "c", inReplyTo: "p", subject: "ตอบ", body: "x".repeat(3000) }), MAIL({ id: "r", inReplyTo: "c" })] };
    const m = mailDetail(raw, "c", "ball@x.co")!;
    expect(m.body.length).toBe(3000);
    expect(m.parent).toEqual({ id: "p", subject: "ถาม" });
    expect(m.replies.map(r => r.id)).toEqual(["r"]);
    expect(mailDetail(raw, "nope", "")).toBeNull();
  });
  test("chats: pinned first, then newest", () => {
    expect(normChats([{ id: "a", title: "A", updatedAt: 5, pinned: false }, { id: "b", title: "", updatedAt: 1, pinned: true }, { id: "c", title: "C", updatedAt: 9 }]).map(c => [c.id, c.title]))
      .toEqual([["b", "(ไม่มีชื่อ)"], ["c", "C"], ["a", "A"]]);
  });
  test("chat: last 60 messages, thinking flag, no session/owner/attachment urls", () => {
    const msgs = Array.from({ length: 70 }, (_, i) => ({ id: "m" + i, role: i % 2 ? "oracle" : "user", status: "done", ts: i, text: "t" + i, attachments: i === 69 ? [{ name: "a.png", url: "/uploads/secret", mime: "image/png", size: 1 }] : [] }));
    msgs[69].status = "pending";
    const c = normChat({ id: "x", title: "T", owner: "ball@x.co", sessionId: "sess-123", agent: "ball-agent", messages: msgs });
    expect(c.messages.length).toBe(60); expect(c.hidden).toBe(10); expect(c.thinking).toBe(true);
    expect(c.messages[59].files).toEqual(["a.png"]);
    const s = JSON.stringify(c);
    expect(s).not.toContain("sess-123"); expect(s).not.toContain("/uploads/secret"); expect(s).not.toContain("ball@x.co");
    expect(normChat({ messages: [{ role: "oracle", status: "done", text: "ok" }] }).thinking).toBe(false);
  });
});

describe("errors", () => {
  test("mapping to Thai, never 401 (the phone would log out of maw)", () => {
    expect(mapError(401, { error: "unauthorized" })).toMatchObject({ status: 503, message: "token หมดอายุ — รัน `artron login` บน Mac" });
    expect(mapError(403, null, "error code: 1010")).toMatchObject({ status: 502 });
    expect(mapError(403, null, "error code: 1010").message).toContain("Cloudflare");
    expect(mapError(409, { error: "จดหมายนี้จัดการไปแล้ว" })).toMatchObject({ status: 409, message: "จดหมายนี้จัดการไปแล้ว" });
    expect(mapError(500, {}).message).toBe("Mind ตอบ 500");
    expect(scrub(`x ${TOKEN} y`, TOKEN)).toBe("x *** y");
  });
  test("network / timeout / no login", async () => {
    const f = fake({ "GET /api/me": () => new Error("ECONNREFUSED") });
    await expect(mindApi("/api/me", {}, f.d)).rejects.toThrow("ต่อ Mind ไม่ได้");
    const t = fake({ "GET /api/me": () => Object.assign(new Error("t"), { name: "TimeoutError" }) });
    await expect(mindApi("/api/me", {}, t.d)).rejects.toThrow("เกิน 15 วินาที");
    const n = fake({}, null);
    const r = await req(app(n.d), "/mind/me");
    expect(r.status).toBe(503); expect(r.json.error).toContain("artron login");
    expect(n.calls.length).toBe(0);
  });
  test("sends Bearer + a real User-Agent", async () => {
    const f = fake({ "GET /api/me": () => ({ json: ME }) });
    await mindApi("/api/me", {}, f.d);
    expect(f.calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0].headers["User-Agent"]).toMatch(/^maw-mobile\//);
  });
});

describe("routes", () => {
  const routes = (extra: Record<string, any> = {}) => ({
    "GET /api/me": () => ({ json: ME }),
    "GET /api/mail": () => ({ json: { mail: [MAIL({ id: "pend0000000000001", status: "pending", ts: 5000 }), MAIL()], pending: 1, mode: "manual" } }),
    "GET /api/conversations": () => ({ json: [{ id: "c1", title: "งาน", updatedAt: 1, pinned: false }] }),
    "GET /api/conversations/c1": () => ({ json: { id: "c1", title: "งาน", sessionId: "S", owner: "ball@x.co", messages: [{ id: "1", role: "user", status: "done", text: "hi" }] } }),
    ...extra,
  });

  test("token never appears in any response, even when Mind echoes it", async () => {
    const f = fake(routes({ "POST /api/mail/act": () => ({ status: 409, json: { error: `bad token ${TOKEN}` } }), "GET /api/conversations/c2": () => ({ status: 500, json: { error: TOKEN } }) }));
    const a = app(f.d);
    const outs = [
      await req(a, "/mind/me"), await req(a, "/mind/mail"), await req(a, "/mind/mail/pend0000000000001"), await req(a, "/mind/chats"),
      await req(a, "/mind/chats/c1"), await req(a, "/mind/chats/c2"), await req(a, "/mind/mail/pend0000000000001/act", { op: "approve" }),
    ];
    for (const o of outs) expect(o.text).not.toContain(TOKEN);
    expect(outs[6].status).toBe(409); expect(outs[6].json.error).toContain("***");
  });

  test("mail list + detail + cache 20 s", async () => {
    const f = fake(routes()), a = app(f.d);
    const l = await req(a, "/mind/mail");
    expect(l.json).toMatchObject({ ok: true, total: 2, pending: 1, waiting: 1, mode: "manual", email: "ball@x.co" });
    expect(l.json.mail[0]).toMatchObject({ id: "pend0000000000001", needsMe: true, actions: ["approve", "reject"] });
    await req(a, "/mind/mail");
    expect(f.calls.filter(c => c.url.endsWith("/api/mail")).length).toBe(1);
    f.tick(21_000); await req(a, "/mind/mail");
    expect(f.calls.filter(c => c.url.endsWith("/api/mail")).length).toBe(2);
    const dt = await req(a, "/mind/mail/pend0000000000001");
    expect(dt.json.mail.body).toBe("เนื้อหา");
    expect((await req(a, "/mind/mail/zzzz")).status).toBe(404);
    expect((await req(a, "/mind/mail/bad%20id")).status).toBe(400);
  });

  test("act / mode pass Mind's exact body, validate first", async () => {
    const f = fake(routes({ "POST /api/mail/act": () => ({ json: { ok: true } }), "POST /api/mail/mode": (c: Call) => ({ json: { ok: true, mode: c.body.mode, delivered: 2 } }) })), a = app(f.d);
    expect((await req(a, "/mind/mail/pend0000000000001/act", { op: "delete" })).status).toBe(400);
    expect((await req(a, "/mind/mail/mode", { mode: "turbo" })).status).toBe(400);
    expect(f.calls.length).toBe(0);
    expect((await req(a, "/mind/mail/pend0000000000001/act", { op: "approve" })).json).toEqual({ ok: true, id: "pend0000000000001", op: "approve" });
    expect(f.calls[0]).toMatchObject({ method: "POST", body: { id: "pend0000000000001", op: "approve" } });
    expect((await req(a, "/mind/mail/mode", { mode: "semi" })).json).toEqual({ ok: true, mode: "semi", delivered: 2 });
    expect(f.calls[1]).toMatchObject({ method: "POST", body: { mode: "semi" } });
  });

  test("chat send returns at once; new chat; text validated", async () => {
    const f = fake(routes({ "POST /api/conversations/c1/messages": () => ({ json: { ok: true } }), "POST /api/conversations": () => ({ json: { id: "c9", title: "" } }) })), a = app(f.d);
    expect((await req(a, "/mind/chats/c1/send", { text: "  " })).status).toBe(400);
    expect((await req(a, "/mind/chats/c1/send", { text: "x".repeat(8001) })).status).toBe(400);
    expect((await req(a, "/mind/chats/c1/send", { text: " สวัสดี " })).json).toEqual({ ok: true });
    expect(f.calls.at(-1)).toMatchObject({ method: "POST", body: { text: "สวัสดี", attachments: [] } });
    expect((await req(a, "/mind/chats", {})).json).toEqual({ ok: true, id: "c9", title: "แชทใหม่" });
    const c = await req(a, "/mind/chats/c1");
    expect(c.json.chat).toMatchObject({ id: "c1", thinking: false }); expect(c.text).not.toContain('"S"');
  });
});

describe("watcher", () => {
  test("first pass only remembers; each new waiting mail pushes once", async () => {
    let mail = [MAIL({ id: "old", status: "pending", ts: 1 }), MAIL({ id: "done" })];
    const f = fake({ "GET /api/me": () => ({ json: ME }), "GET /api/mail": () => ({ json: { mail, pending: 1, mode: "manual" } }) });
    const st = { seen: new Set<string>() };
    expect(await mailPass(st, f.d, true)).toEqual([]);
    expect(f.pushes.length).toBe(0);
    mail = [MAIL({ id: "new", status: "pending", ts: 2, from: "hp-agent", subject: "ขอ deploy ".repeat(20) }), ...mail, MAIL({ id: "notmine", status: "pending", toOwner: "hp@x.co" })];
    expect(await mailPass(st, f.d)).toEqual(["new"]);
    expect(f.pushes).toHaveLength(1);
    expect(f.pushes[0]).toMatchObject({ sid: "mind", kind: "mind-mail", msg: { title: "📬 Mind · จดหมายใหม่" } });
    expect(f.pushes[0].msg.body.startsWith("จาก hp-agent · ขอ deploy")).toBe(true);
    expect(f.pushes[0].msg.body.length).toBeLessThan(80);
    expect(await mailPass(st, f.d)).toEqual([]);           // same mail again → no second push
    expect(f.pushes).toHaveLength(1);
    // a mail the agent held later (semi) counts as new when it turns pending
    mail = mail.map(m => m.id === "done" ? { ...m, status: "pending", held: "ต้องตัดสินใจ" } : m);
    expect(await mailPass(st, f.d)).toEqual(["done"]);
    expect(JSON.stringify(f.pushes)).not.toContain(TOKEN);
  });
  test("several at once → one push with a count", async () => {
    const f = fake({ "GET /api/me": () => ({ json: ME }), "GET /api/mail": () => ({ json: { mail: [MAIL({ id: "a", status: "pending" }), MAIL({ id: "b", status: "pending" })], pending: 2 } }) });
    await mailPass({ seen: new Set() }, f.d);
    expect(f.pushes).toHaveLength(1); expect(f.pushes[0].msg.body).toContain("+อีก 1 ฉบับ");
  });
  test("Mind down → throws (the loop swallows it), nothing pushed", async () => {
    const f = fake({ "GET /api/me": () => new Error("down") });
    await expect(mailPass({ seen: new Set() }, f.d)).rejects.toBeInstanceOf(MindError);
    expect(f.pushes.length).toBe(0);
  });
});
