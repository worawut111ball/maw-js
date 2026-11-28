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

import { claudeLimits } from "../src/mobile/api";
import { mkdtempSync as mkd, writeFileSync as wf, utimesSync } from "fs";
import { tmpdir as tmpd } from "os";
import { join as pj } from "path";
describe("claudeLimits — stale readings are dropped", () => {
  const dir = () => mkd(pj(tmpd(), "maw-status-"));
  const put = (d: string, sid: string, limits: boolean, at: number) => {
    const f = pj(d, sid + ".json");
    wf(f, JSON.stringify({ context_window: {}, ...(limits ? { rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 }, seven_day: { used_percentage: 49, resets_at: 2 } } } : {}) }));
    utimesSync(f, at / 1000, at / 1000);
  };
  const now = Date.parse("2026-11-26T15:00:00Z");
  test("fresh reading is shown", () => { const d = dir(); put(d, "aaaaaaaa", true, now - 600_000); expect(claudeLimits(d, now)?.d7?.pct).toBe(49); });
  test("days-old reading while current sessions have none (through Mind) → null", () => {
    const d = dir(); put(d, "aaaaaaaa", true, now - 13 * 86400_000); put(d, "bbbbbbbb", false, now - 60_000);
    expect(claudeLimits(d, now)).toBeNull();
  });
  test("one main-account room among newer Mind rooms keeps its limits (≤ 6 h)", () => {
    const d = dir(); put(d, "aaaaaaaa", true, now - 3 * 3600_000); put(d, "bbbbbbbb", false, now - 60_000);
    expect(claudeLimits(d, now)?.d7?.pct).toBe(49);
  });
});

import { codexLimits } from "../src/mobile/api";
import { mkdirSync as mkdirS } from "fs";
describe("codexLimits — main-account room found past Mind rooms · stale dropped", () => {
  const now = Date.parse("2026-11-26T15:00:00Z");
  const rollout = (root: string, name: string, real: boolean, at: number) => {
    const day = pj(root, "2026", "11", "26"); mkdirS(day, { recursive: true });
    const f = pj(day, name);
    const rl = real ? { primary: { used_percent: 12, window_minutes: 300, resets_at: 1 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 2 } } : { primary: null, secondary: null };
    wf(f, JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null, rate_limits: rl } }) + "\n");
    utimesSync(f, at / 1000, at / 1000);
  };
  test("newer Mind rollouts (null limits) do not hide an older main-account one", () => {
    const r = mkd(pj(tmpd(), "maw-codex-"));
    for (let k = 0; k < 7; k++) rollout(r, `mind-${k}.jsonl`, false, now - k * 60_000);
    rollout(r, "direct.jsonl", true, now - 2 * 3600_000);
    const L = codexLimits(r, now); expect(L?.h5?.pct).toBe(12); expect(L?.d7?.pct).toBe(40);
  });
  test("only Mind rollouts → null · main-account older than 6 h → null", () => {
    const r = mkd(pj(tmpd(), "maw-codex-"));
    rollout(r, "mind.jsonl", false, now - 60_000); rollout(r, "old-direct.jsonl", true, now - 7 * 3600_000);
    expect(codexLimits(r, now)).toBeNull();
  });
});
