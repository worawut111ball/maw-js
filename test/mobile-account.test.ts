import { describe, expect, test } from "bun:test";
import { countLines, keptFlags, relaunchCommand, routeOf } from "../src/mobile/features/account";

describe("account switch", () => {
  test("route: Claude by ANTHROPIC_BASE_URL · Codex by the artron provider", () => {
    expect(routeOf("claude", { ANTHROPIC_BASE_URL: "https://mind.artroninnovative.co.th/api/anthropic" }, [])).toBe("mind");
    expect(routeOf("claude", {}, [])).toBe("direct");
    expect(routeOf("codex", { ARTRON_TOKEN: "x" }, [])).toBe("mind");
    expect(routeOf("codex", {}, ["codex", "-c", 'model_provider="artron"'])).toBe("mind");
    expect(routeOf("codex", {}, ["codex", "resume", "abc"])).toBe("direct");
  });
  test("keeps mode/model flags, drops resume ids, prompts and mind-entry provider flags", () => {
    expect(keptFlags(["claude", "--dangerously-skip-permissions", "--resume", "old-id", "--model", "opus", "ทำต่อ"])).toEqual(["--dangerously-skip-permissions", "--model", "opus"]);
    expect(keptFlags(["codex", "-c", 'model_provider="artron"', "--dangerously-bypass-approvals-and-sandbox", "resume", "x"])).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
  });
  test("relaunch command resumes the same session through the other route", () => {
    const c = relaunchCommand({ pid: 1, agent: "claude", args: ["claude", "--dangerously-skip-permissions", "--continue"], route: "mind", sessionId: "30a5ee9e-ab86-444e-8d2a-c16391c1096c" }, "direct");
    expect(c).toMatch(/\/\.artron\/entry\/bin\/claude-direct --dangerously-skip-permissions --resume 30a5ee9e-ab86-444e-8d2a-c16391c1096c$/);
    const x = relaunchCommand({ pid: 1, agent: "codex", args: ["codex", "--dangerously-bypass-approvals-and-sandbox"], route: "direct", sessionId: "01a1f2ac-bfc6" }, "mind");
    expect(x).toMatch(/\/\.artron\/entry\/bin\/codex resume 01a1f2ac-bfc6 --dangerously-bypass-approvals-and-sandbox$/);
  });
});

describe("output tokens today", () => {
  const since = Date.parse("2026-11-28T00:00:00+07:00");
  test("Claude: dedupes one reply written over several lines · skips before midnight", () => {
    const t = { ids: new Map<string, number>(), out: 0 };
    countLines([
      JSON.stringify({ type: "assistant", timestamp: "2026-11-27T16:59:00Z", message: { id: "old", usage: { output_tokens: 999 } } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-11-27T17:01:00Z", message: { id: "a", usage: { output_tokens: 10 } } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-11-27T17:01:01Z", message: { id: "a", usage: { output_tokens: 120 } } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-11-27T17:02:00Z", message: { id: "b", usage: { output_tokens: 30 } } }),
    ], t, since);
    expect(t.out).toBe(150);
  });
  test("Codex: sums last_token_usage of token_count events", () => {
    const t = { ids: new Map<string, number>(), out: 0 };
    const ev = (ts: string, n: number) => JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { output_tokens: n } } } });
    countLines([ev("2026-11-27T16:00:00Z", 500), ev("2026-11-27T18:00:00Z", 306), ev("2026-11-27T18:05:00Z", 44)], t, since);
    expect(t.out).toBe(350);
  });
});
