import { describe, expect, test } from "bun:test";
import { etagJson } from "../src/mobile/api";

const req = (path: string, inm?: string) => new Request("http://x" + path, { headers: inm ? { "if-none-match": inm } : {} });
const set = () => ({ headers: {} as Record<string, any> });

describe("etagJson — polled GETs answer 304 when unchanged", () => {
  test("first answer carries an ETag, same ETag back → 304 without body", async () => {
    const body = { projects: [{ name: "a" }] };
    const r1 = etagJson(req("/mobile/projects"), body, set())!;
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual(body);
    const tag = r1.headers.get("etag")!;
    expect(r1.headers.get("cache-control")).toBe("no-cache");
    const r2 = etagJson(req("/mobile/projects", tag), body, set())!;
    expect(r2.status).toBe(304);
    expect(await r2.text()).toBe("");
    const r3 = etagJson(req("/mobile/projects", tag), { projects: [] }, set())!;
    expect(r3.status).toBe(200);
  });
  test("chat path yes · other paths, errors and no-store routes untouched", () => {
    expect(etagJson(req("/mobile/rooms/w/r/chat?limit=30&lite=1"), { ok: true }, set())).toBeInstanceOf(Response);
    expect(etagJson(req("/mobile/prs"), { ok: true }, set())).toBeUndefined();
    expect(etagJson(req("/mobile/projects"), { ok: false }, { status: 503, headers: {} })).toBeUndefined();
    expect(etagJson(req("/mobile/projects"), { ok: true }, { headers: { "cache-control": "no-store" } })).toBeUndefined();
  });
});
