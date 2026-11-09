import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { daysLeft, mount, sanitize, type Lease } from "../src/mobile/features/leases";

const request = (app: any, method: string, path: string, body?: unknown) =>
  app.handle(new Request("http://fixture" + path, {
    method, headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));

describe("leases pack — pure functions", () => {
  test("daysLeft counts calendar days, rounds up, negative when past", () => {
    const now = Date.parse("2026-11-09T10:00:00");
    expect(daysLeft("2026-11-09", now)).toBe(0);
    expect(daysLeft("2026-11-10", now)).toBe(1);
    expect(daysLeft("2026-12-09", now)).toBe(30);
    expect(daysLeft("2026-11-01", now)).toBe(-8);
  });

  test("sanitize requires label, provider, and a real YYYY-MM-DD date", () => {
    expect(sanitize({ label: "atom", provider: "P&T", expiresAt: "2026-12-01" })).toMatchObject({ label: "atom", provider: "P&T", expiresAt: "2026-12-01" });
    expect(sanitize({ label: "", provider: "P&T", expiresAt: "2026-12-01" })).toBeNull();
    expect(sanitize({ label: "atom", provider: "", expiresAt: "2026-12-01" })).toBeNull();
    expect(sanitize({ label: "atom", provider: "P&T", expiresAt: "not-a-date" })).toBeNull();
    expect(sanitize({ label: "atom", provider: "P&T", expiresAt: "2026-13-40" })).toBeNull();
    expect(sanitize({ label: "atom", provider: "P&T", expiresAt: "2026-12-01", note: "  เช่ารายปี  " })?.note).toBe("เช่ารายปี");
  });

  test("sanitize keeps a given id only if it looks like one of ours, else mints one", () => {
    const a = sanitize({ id: "not valid!!", label: "x", provider: "y", expiresAt: "2026-01-01" })!;
    expect(a.id).not.toBe("not valid!!");
    const b = sanitize({ id: "abc123", label: "x", provider: "y", expiresAt: "2026-01-01" })!;
    expect(b.id).toBe("abc123");
  });
});

describe("leases pack — routes", () => {
  const freshFile = () => join(mkdtempSync(join(tmpdir(), "maw-leases-")), "leases.json");

  test("GET starts empty, sorted by soonest-first, POST adds / updates / deletes", async () => {
    const file = freshFile();
    const app = new Elysia(); mount(app, { file });

    let r: any = await request(app, "GET", "/leases").then((x: Response) => x.json());
    expect(r).toMatchObject({ ok: true, items: [], warnDays: 30, dangerDays: 7 });

    r = await request(app, "POST", "/leases", { label: "atom", provider: "P&T", expiresAt: "2099-01-01" }).then((x: Response) => x.json());
    expect(r.ok).toBe(true);
    const id = r.items[0].id;
    expect(r.items[0]).toMatchObject({ label: "atom", provider: "P&T", expiresAt: "2099-01-01" });

    r = await request(app, "POST", "/leases", { label: "atom p&t", provider: "P&T", expiresAt: "2030-06-15" }).then((x: Response) => x.json());
    const id2 = r.items.find((x: Lease) => x.label === "atom p&t").id;

    r = await request(app, "GET", "/leases").then((x: Response) => x.json());
    expect(r.items.map((x: Lease) => x.expiresAt)).toEqual(["2030-06-15", "2099-01-01"]); // 2030 comes first (fewer days left)

    r = await request(app, "POST", "/leases", { id, label: "atom (renew)", provider: "P&T", expiresAt: "2099-01-01" }).then((x: Response) => x.json());
    expect(r.items.find((x: Lease) => x.id === id)?.label).toBe("atom (renew)");
    expect(r.items).toHaveLength(2); // update, not a 3rd row

    r = await request(app, "POST", "/leases", { id: id2, on: false }).then((x: Response) => x.json());
    expect(r.items).toHaveLength(1);
    expect(r.items[0].id).toBe(id);

    // persisted to disk, not just in memory
    expect(JSON.parse(readFileSync(file, "utf-8"))).toHaveLength(1);
  });

  test("POST rejects a bad payload and a bad delete id without touching the file", async () => {
    const file = freshFile();
    const app = new Elysia(); mount(app, { file });
    let res: Response = await request(app, "POST", "/leases", { label: "", provider: "x", expiresAt: "2099-01-01" });
    expect(res.status).toBe(400);
    res = await request(app, "POST", "/leases", { id: "../../etc", on: false });
    expect(res.status).toBe(400);
  });
});
