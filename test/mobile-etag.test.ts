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
    for (const e of ["suggestion", "mode", "prompt"]) expect(etagJson(req(`/mobile/rooms/tmux/%2535/${e}`), { ok: true }, set())).toBeInstanceOf(Response);
    expect(etagJson(req("/mobile/rooms/w/r/send"), { ok: true }, set())).toBeUndefined();
    expect(etagJson(req("/mobile/prs"), { ok: true }, set())).toBeUndefined();
    expect(etagJson(req("/mobile/projects"), { ok: false }, { status: 503, headers: {} })).toBeUndefined();
    expect(etagJson(req("/mobile/projects"), { ok: true }, { headers: { "cache-control": "no-store" } })).toBeUndefined();
  });
});

import { BATCH_PATH } from "../src/mobile/api";
describe("BATCH_PATH — what /batch may run", () => {
  test("polled read-only GETs only, never Herdr", () => {
    for (const p of ["/projects", "/system", "/rooms/tmux/%2535/chat?limit=30&lite=1", "/rooms/a-b/c-d/suggestion?agent=codex&sid=", "/rooms/w/r/mode?sid=x", "/rooms/w/r/prompt"])
      expect(BATCH_PATH.test(p)).toBe(true);
    for (const p of ["/rooms/w/r/send", "/rooms/herdr:x/r/chat", "/rooms/herdr%3Ax/r/chat", "/prs", "/batch?p=/system", "/rooms/w/r/chat/item?i=1", "/vault/dl"])
      expect(BATCH_PATH.test(p)).toBe(false);
  });
});
