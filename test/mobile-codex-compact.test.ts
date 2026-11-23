import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { codexTranscript } from "../src/mobile/api";

// Codex auto-compact writes its context summary as an assistant message, then a `compacted` record embedding it.
const line = (o: object) => JSON.stringify(o) + "\n";
const msg = (ts: string, role: string, text: string) =>
  line({ timestamp: ts, type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const SUMMARY = "## Active task / authorization\n\nUser wants Farmlink fully ready.\n\n## Operational constraints / communication\n- Thai natural";

function room(body: string) {
  const day = join(mkdtempSync(join(tmpdir(), "maw-compact-")), ".codex", "sessions", "2026", "11", "23");
  mkdirSync(day, { recursive: true });
  const f = join(day, "rollout-2026-11-23T10-00-00-01a1f34b-4d0d-7003-ba31-1188a8c9f271.jsonl");
  writeFileSync(f, line({ timestamp: "2026-11-23T03:00:00Z", type: "session_meta", payload: { id: "01a1f34b-4d0d-7003-ba31-1188a8c9f271" } }) + body);
  return codexTranscript(f);
}

describe("codex compact summary", () => {
  test("summary before `compacted` becomes one system line; real replies stay", () => {
    const items = room(msg("2026-11-23T03:01:00Z", "user", "ทำต่อ") + msg("2026-11-23T03:02:00Z", "assistant", "production ยัง build อยู่ครับ") +
      msg("2026-11-23T03:03:00Z", "assistant", SUMMARY) +
      line({ timestamp: "2026-11-23T03:03:01Z", type: "event_msg", payload: { type: "token_count" } }) +
      line({ timestamp: "2026-11-23T03:03:02Z", type: "compacted", payload: { message: "Another language model started… Here is the summary produced:\n" + SUMMARY } }) +
      msg("2026-11-23T03:04:00Z", "assistant", "build ผ่านแล้วครับ"));
    expect(items.map(x => [x.role, x.text])).toEqual([
      ["user", "ทำต่อ"], ["assistant", "production ยัง build อยู่ครับ"],
      ["system", "🗜 Codex ย่อบทสนทนา — สรุปบริบทเก็บไว้ ไม่แสดงในแชท"], ["assistant", "build ผ่านแล้วครับ"]]);
  });

  test("a `compacted` whose summary does not match leaves the last reply alone", () => {
    const items = room(msg("2026-11-23T03:01:00Z", "user", "ถาม") + msg("2026-11-23T03:02:00Z", "assistant", "คำตอบจริง") +
      line({ timestamp: "2026-11-23T03:03:00Z", type: "compacted", payload: { message: "summary of something else" } }));
    expect(items.map(x => x.text)).toEqual(["ถาม", "คำตอบจริง"]);
  });
});
