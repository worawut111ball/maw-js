import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { codexTranscript } from "../src/mobile/api";

// Codex 0.170 `fork` writes a new rollout with only session_meta + forked_from_id — the room must still show the old turns.
const line = (o: object) => JSON.stringify(o) + "\n";
const msg = (ts: string, role: string, text: string) =>
  line({ timestamp: ts, type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });

describe("codex fork transcript", () => {
  test("forked room shows parent turns before the fork, then its own", () => {
    const home = mkdtempSync(join(tmpdir(), "maw-fork-"));
    const day = join(home, ".codex", "sessions", "2026", "11", "19");
    mkdirSync(day, { recursive: true });
    const parentId = "01a1521a-4fcd-7120-85e8-5abe228a244a", childId = "01a1f295-1f39-78a3-a88b-ea2b7e01697e";
    writeFileSync(join(day, `rollout-2026-11-19T10-00-00-${parentId}.jsonl`),
      line({ timestamp: "2026-11-19T03:00:00Z", type: "session_meta", payload: { id: parentId, model_provider: "openai" } }) +
      msg("2026-11-19T03:01:00Z", "user", "งานเดิม") + msg("2026-11-19T03:02:00Z", "assistant", "ตอบงานเดิม") +
      msg("2026-11-19T07:00:00Z", "user", "หลัง fork ในห้องเดิม"));
    const child = join(day, `rollout-2026-11-19T13-53-41-${childId}.jsonl`);
    writeFileSync(child,
      line({ timestamp: "2026-11-19T06:53:41Z", type: "session_meta", payload: { id: childId, model_provider: "artron", forked_from_id: parentId } }) +
      msg("2026-11-19T06:54:00Z", "user", "ต่อใน fork"));
    // parent is looked up in the same sessions root as the forked file; its turns after the fork stay out
    const items = codexTranscript(child);
    expect(items.map(x => x.text)).toEqual(["งานเดิม", "ตอบงานเดิม", "— แชทต่อจาก thread เดิม (codex fork) —", "ต่อใน fork"]);
    expect(items.every((x, k) => x.i === k)).toBe(true);
  });
});
