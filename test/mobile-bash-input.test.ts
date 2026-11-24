import { expect, test } from "bun:test";
import { parseTranscriptLines } from "../src/mobile/api";

const L = (o: any) => JSON.stringify(o);
const u = (uuid: string, parent: string | null, content: string, ts = "2026-11-24T13:28:13Z") => L({ type: "user", uuid, parentUuid: parent, timestamp: ts, message: { role: "user", content } });
const q = (op: string, content: string, ts: string) => L({ type: "queue-operation", operation: op, timestamp: ts, content });

test("!cmd in Claude Code: one '! cmd' bubble + a folded Bash step · the re-pressed Enter's queued echo is not shown", () => {
  const st: any = { size: 0, partial: "", items: [], tools: new Map() };
  parseTranscriptLines(st, [
    u("u1", null, "<bash-input> launchctl kickstart -k gui/501/homebrew.maw</bash-input>"),
    u("u2", "u1", "<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>", "2026-11-24T13:28:14Z"),
    q("enqueue", "launchctl kickstart -k gui/501/homebrew.maw", "2026-11-24T13:28:18Z"),
  ]);
  expect(st.items.map((x: any) => [x.role, x.text ?? x.tool?.name + ":" + x.tool?.summary + "→" + x.tool?.output])).toEqual([
    ["user", "! launchctl kickstart -k gui/501/homebrew.maw"],
    ["tool", "Bash:launchctl kickstart -k gui/501/homebrew.maw→(Bash completed with no output)"],
  ]);
});

test("stderr kept · a real later message with the same words is still shown", () => {
  const st: any = { size: 0, partial: "", items: [], tools: new Map() };
  parseTranscriptLines(st, [
    u("u1", null, "<bash-input>ls nope</bash-input>"),
    u("u2", "u1", "<bash-stdout></bash-stdout><bash-stderr>ls: nope: No such file</bash-stderr>"),
    q("enqueue", "ls nope", "2026-11-24T13:40:00Z"),   // 12 minutes later — a new message, not an echo
  ]);
  expect(st.items[1].tool.output).toBe("ls: nope: No such file");
  expect(st.items.at(-1)).toMatchObject({ role: "user", text: "ls nope", queued: true });
});
