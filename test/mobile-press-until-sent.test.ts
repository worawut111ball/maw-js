import { describe, expect, test } from "bun:test";
import { pressUntilSent } from "../src/mobile/api";

const ch = { kind: "superset", workspaceId: "w", terminalId: "t" } as any;
const screen = (box: string) => `Worked for 20s\n\n› ${box}\n\n  GPT model · Context 59% used`;

describe("pressUntilSent — Codex skill picker ate the Enter", () => {
  test("text still in the box → Enter again", async () => {
    let presses = 0; const reads = [screen("$rrr "), screen("")];
    await pressUntilSent(ch, "$rrr", async () => { presses++; }, async () => reads.shift() ?? "", 0);
    expect(presses).toBe(1);
  });
  test("box already empty → no extra Enter", async () => {
    let presses = 0;
    await pressUntilSent(ch, "สวัสดี", async () => { presses++; }, async () => screen(""), 0);
    expect(presses).toBe(0);
  });
  test("gives up after 2 extra Enters", async () => {
    let presses = 0;
    await pressUntilSent(ch, "$rrr", async () => { presses++; }, async () => screen("$rrr"), 0);
    expect(presses).toBe(2);
  });
});

import { codexDraft } from "../src/mobile/api";
describe("codexDraft", () => {
  test("reads the box above the status line, not a › in history", () => {
    expect(codexDraft("› old question\nanswer\n\n› $rrr $rrr\n \n  GPT-6 medium · Context 59% used")).toBe("$rrr $rrr");
    expect(codexDraft("› old question\nanswer\n\n› \n\n  GPT-6 medium · Context 59% used")).toBeNull();
    expect(codexDraft("› sent text\nWorking…")).toBeNull();
  });
});

import { liteItem } from "../src/mobile/api";
describe("liteItem — chat?lite=1", () => {
  test("drops a finished tool step's command and output, keeps its state", () => {
    const x = liteItem({ i: 3, role: "tool", tool: { name: "Bash", summary: "ls", input: "ls -la", output: "a\nb", error: false } } as any) as any;
    expect(x.tool).toEqual({ name: "Bash", summary: "ls", output: "", error: false, lazy: true, input: undefined });
  });
  test("a running step stays running (output null)", () => {
    expect((liteItem({ i: 1, role: "tool", tool: { name: "Bash", summary: "x", input: "x", output: null } } as any) as any).tool.output).toBeNull();
  });
  test("messages and empty steps are untouched", () => {
    const m = { i: 0, role: "assistant", text: "hi" } as any;
    expect(liteItem(m)).toBe(m);
  });
});
