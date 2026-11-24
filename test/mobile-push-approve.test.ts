import { describe, expect, test } from "bun:test";
import { actOnApproval, notifyPermission, permissionDialog } from "../src/mobile/api";

const dialog = (cmd: string, sel = 1) => `
 Bash command

   ${cmd}
   Run tests

 Do you want to proceed?
 ${sel === 1 ? "❯" : " "} 1. Yes
 ${sel === 2 ? "❯" : " "} 2. Yes, and don't ask again for this command
 ${sel === 3 ? "❯" : " "} 3. No, and tell Claude what to do differently (esc)
`;
const ch = { kind: "tmux", pane: "%9", label: "%9" } as any;
const setup = async (screen: string) => {
  let sent: any = null;
  await notifyPermission("s1", "waiting", { title: "t", body: "b" }, async () => screen, () => ch, async (_s: string, _k: string, _m: any, extra: any = {}) => { sent = extra; return 1; });
  return sent;
};

describe("permissionDialog", () => {
  test("finds the dialog, highlighted Yes, same text → same fingerprint", () => {
    const a = permissionDialog(dialog("bun test")), b = permissionDialog(dialog("bun test"));
    expect(a?.yesFirst).toBe(true); expect(a?.sig).toBe(b?.sig);
    expect(permissionDialog(dialog("rm -rf /tmp/x"))?.sig).not.toBe(a?.sig);
    expect(permissionDialog(dialog("bun test", 3))?.yesFirst).toBe(false);
    expect(permissionDialog("just chat output\n› ")).toBeNull();
  });
});

describe("approve from push", () => {
  test("push carries ✓/✕ and a token · allow presses Enter once · token single-use", async () => {
    const extra = await setup(dialog("bun test"));
    expect(extra.actions.map((x: any) => x.action)).toEqual(["allow", "deny"]);
    const keys: string[] = [];
    const r = await actOnApproval(extra.act, "allow", async () => dialog("bun test"), async (_c: any, k: string) => { keys.push(k); }, () => ch);
    expect(r.ok).toBe(true); expect(keys).toEqual(["enter"]);
    expect((await actOnApproval(extra.act, "allow", async () => dialog("bun test"), async () => {}, () => ch)).ok).toBe(false);
  });
  test("deny presses Esc", async () => {
    const extra = await setup(dialog("bun test")); const keys: string[] = [];
    expect((await actOnApproval(extra.act, "deny", async () => dialog("bun test"), async (_c: any, k: string) => { keys.push(k); }, () => ch)).ok).toBe(true);
    expect(keys).toEqual(["esc"]);
  });
  test("a different dialog on screen now → refuse, press nothing", async () => {
    const extra = await setup(dialog("bun test")); const keys: string[] = [];
    const r = await actOnApproval(extra.act, "allow", async () => dialog("rm -rf build"), async (_c: any, k: string) => { keys.push(k); }, () => ch);
    expect(r.ok).toBe(false); expect(keys).toEqual([]);
  });
  test("allow refused when the highlight moved off Yes", async () => {
    const extra = await setup(dialog("bun test"));
    expect((await actOnApproval(extra.act, "allow", async () => dialog("bun test", 3), async () => { throw new Error("pressed"); }, () => ch)).ok).toBe(false);
  });
  test("no dialog on screen → plain push without buttons", async () => {
    const extra = await setup("nothing here");
    expect(extra.act).toBeUndefined();
  });
});
