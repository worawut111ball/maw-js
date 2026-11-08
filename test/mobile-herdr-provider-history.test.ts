import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HistoryResolver } from "../src/mobile/herdr/history";
import type { ConversationRef } from "../src/mobile/herdr/types";
const rootFixture = join(import.meta.dir, "fixtures/herdr-provider");
const ids = { codex: "00000000-0000-4000-8000-000000000001", claude: "00000000-0000-4000-8000-000000000002" };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-history-")); dirs.push(dir);
  const claudeRoot = join(dir, "claude"), codexRoot = join(dir, "codex"); mkdirSync(claudeRoot); mkdirSync(codexRoot);
  const files = { claude: join(claudeRoot, ids.claude + ".jsonl"), codex: join(codexRoot, "rollout-" + ids.codex + ".jsonl") };
  for (const a of ["claude", "codex"] as const) copyFileSync(join(rootFixture, a + "-native.jsonl"), files[a]);
  return { dir, files, claudeRoot, codexRoot, resolver: new HistoryResolver({ claudeRoot, codexRoot }) };
}
const ref = (agent: "claude" | "codex"): ConversationRef => ({ agent, kind: "id", value: ids[agent], source: "herdr:" + agent });
describe("Herdr native history identity and filesystem guards", () => {
  test("both providers resolve exact native ID and show their own messages", async () => {
    const h = setup();
    for (const a of ["claude", "codex"] as const) {
      const result = await h.resolver.read(ref(a)); expect(result.kind).toBe("messages");
      if (result.kind !== "messages") throw new Error("expected native history");
      expect(result.conversation).toBe(ids[a]); expect(result.items.at(-1)?.text).toContain(a === "claude" ? "Claude" : "Codex");
      expect(result.items.map(i => i.role)).toEqual(["user", "assistant"]);
    }
  });
  test("missing or unsupported reference remains unavailable rather than guessed from cwd", async () => {
    const h = setup();
    for (const r of [null, { ...ref("codex"), source: "untrusted-source" }, { ...ref("codex"), value: "../../secret" }])
      expect((await h.resolver.read(r)).kind).toBe("none");
  });
  test("same file name with another conversation ID is rejected", async () => {
    const h = setup(); writeFileSync(h.files.codex, readFileSync(h.files.codex, "utf8").replace(ids.codex, ids.claude));
    expect((await h.resolver.read(ref("codex"))).kind).toBe("none");
  });
  test("ambiguous ID files do not select the newest transcript", async () => {
    const h = setup(); mkdirSync(join(h.codexRoot, "other")); copyFileSync(h.files.codex, join(h.codexRoot, "other", ids.codex + ".jsonl"));
    expect((await h.resolver.read(ref("codex"))).kind).toBe("none");
  });
  test("explicit path outside configured root and symlink escape are rejected", async () => {
    const h = setup(); const outside = join(h.dir, "outside.jsonl"); copyFileSync(h.files.codex, outside);
    const link = join(h.codexRoot, "linked.jsonl"); symlinkSync(outside, link);
    for (const value of [outside, link, "relative.jsonl", "bad\0path"])
      expect((await h.resolver.read({ ...ref("codex"), kind: "path", value })).kind).toBe("none");
  });
  test("wrong provider metadata cannot become a valid conversation", async () => {
    const h = setup(); copyFileSync(h.files.codex, h.files.claude);
    expect((await h.resolver.read(ref("claude"))).kind).toBe("none");
  });
  test("history size and traversal budgets fail closed", async () => {
    const h = setup();
    expect((await new HistoryResolver({ codexRoot: h.codexRoot, maxBytes: 1 }).read(ref("codex"))).kind).toBe("none");
    expect((await new HistoryResolver({ codexRoot: h.codexRoot, maxFiles: 0 }).read(ref("codex"))).kind).toBe("none");
  });
  test("Claude rewind drops abandoned branch while preserving compaction ancestry", async () => {
    const h = setup();
    const row = (type: string, uuid: string, parentUuid: string | null, text: string, extra = {}) => ({ type, uuid, parentUuid, sessionId: ids.claude, message: { content: type === "assistant" ? [{ type: "text", text }] : text }, ...extra });
    const rows = [row("user", "u1", null, "start"), row("assistant", "a1", "u1", "first"), row("user", "old-u", "a1", "abandoned user"), row("assistant", "old-a", "old-u", "abandoned answer"),
      row("user", "new-u", "a1", "kept user"), row("assistant", "new-a", "new-u", "kept answer"), row("user", "compact", null, "summary", { logicalParentUuid: "new-a", isCompactSummary: true }), row("assistant", "after", "compact", "after compact")];
    writeFileSync(h.files.claude, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    const result = await h.resolver.read(ref("claude")); expect(result.kind).toBe("messages");
    if (result.kind !== "messages") return;
    const text = result.items.map(i => i.text).join("\n"); expect(text).not.toContain("abandoned"); expect(text).toContain("start"); expect(text).toContain("kept user"); expect(text).toContain("after compact");
  });
  test("pagination validates bounds, preserves append epoch and rejects replaced history", async () => {
    const h = setup(); const first = await h.resolver.read(ref("codex"), { limit: 1 });
    expect(first.kind).toBe("messages"); if (first.kind !== "messages") return;
    expect(first.items).toHaveLength(1); expect(first.start).toBe(1);
    for (const query of [{ limit: "NaN" }, { before: -1 }, { limit: 0 }]) expect((await h.resolver.read(ref("codex"), query)).kind).toBe("none");
    appendFileSync(h.files.codex, JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "next" }] } }) + "\n");
    const appended = await h.resolver.read(ref("codex"), { before: 1, epoch: first.epoch });
    expect(appended.kind).toBe("messages");
    if (appended.kind === "messages") expect(appended.epoch).toBe(first.epoch);
    writeFileSync(h.files.codex, readFileSync(h.files.codex, "utf8").replace("ตรวจห้องตัวอย่าง", "เปลี่ยนกิ่งสนทนา"));
    expect((await h.resolver.read(ref("codex"), { before: 1, epoch: first.epoch })).kind).toBe("none");
  });
});
