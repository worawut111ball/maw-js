import { describe, expect, test } from "bun:test";
import { parsePrompt, parseMenu, dialogPass, optionKind, stripAnsi, promptSig, mount } from "../src/mobile/features/permissions";

const E = "\x1b[";
const dim = (s: string) => `${E}2m${s}${E}22m`;
const bold = (s: string) => `${E}1m${s}${E}22m`;
const blue = (s: string) => `${E}38;5;153m${s}${E}39m`;
const RULE = `${E}38;5;174m${"─".repeat(110)}${E}39m`;

// Claude Code 2.1 Bash permission dialog, as `tmux capture-pane -e -p` returns it (ANSI, top rule only).
const claudeBash = [
  `${E}38;5;231m⏺${E}39m ${bold("Bash")}(git push origin ball/local-2026-05)`,
  `  ⎿  ${dim("Running…")}`,
  "",
  RULE,
  ` ${bold(blue("Bash command"))}`,
  "",
  "   git push origin ball/local-2026-05",
  `   ${dim("Push local branch to origin")}`,
  "",
  " Do you want to proceed?",
  ` ${blue("❯")} ${blue("1. Yes")}`,
  "   2. Yes, and don't ask again for git push commands in ~/my-project/maw-js",
  "   3. No, and tell Claude what to do differently (esc)",
  "",
  ` ${dim("Esc to cancel · Tab to amend · ctrl+e to explain")}`,
  "",
  "",
].join("\n");

// Same dialog after it was answered: the agent ran the command, input box is back.
const claudeAnswered = [
  ...claudeBash.split("\n").slice(0, 14),
  "⏺ Bash(git push origin ball/local-2026-05)",
  "  ⎿  Everything up-to-date",
  "",
  "⏺ Pushed — the branch is already up to date.",
  "",
  RULE,
  `${E}38;5;246m❯${E}39m `,
  RULE,
  `  ${dim("⏵⏵ accept edits on (shift+tab to cycle)")}`,
].join("\n");

// Claude Code Edit dialog with a dashed diff frame; long option wraps onto the next line.
const claudeEdit = [
  RULE,
  " Edit file",
  " src/mobile/features/permissions.ts",
  "╌".repeat(80),
  "  12  -const SCREEN_LINES = 120;",
  "  12  +const SCREEN_LINES = 160;",
  "╌".repeat(80),
  " Do you want to make this edit to permissions.ts?",
  " ❯ 1. Yes",
  "   2. Yes, allow all edits during this session",
  "   (shift+tab)",
  "   3. No, and tell Claude what to do differently (esc)",
  "",
  " Esc to cancel",
].join("\n");

// Older Claude Code: rounded box with side borders and a nested diff box.
const claudeBoxed = [
  "╭──────────────────────────────────────────────╮",
  "│ Create file                                  │",
  "│ ╭──────────────────────────────────────────╮ │",
  "│ │ notes/todo.md                            │ │",
  "│ │ - buy milk                               │ │",
  "│ ╰──────────────────────────────────────────╯ │",
  "│ Do you want to create todo.md?               │",
  "│ ❯ 1. Yes                                     │",
  "│   2. Yes, and don't ask again this session   │",
  "│   3. No, and tell Claude what to do          │",
  "│   differently (esc)                          │",
  "╰──────────────────────────────────────────────╯",
].join("\n");

// Claude Code WebFetch, plain text as Superset's `terminals read` returns it.
const claudeFetch = [
  "────────────────────────────────────────────────",
  " Fetch",
  "",
  "   https://docs.anthropic.com/en/docs/claude-code/hooks",
  "   Claude wants to fetch content from docs.anthropic.com",
  "",
  " Do you want to allow Claude to fetch this content?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for docs.anthropic.com",
  "   3. No, and tell Claude what to do differently (esc)",
].join("\n");

// Codex CLI exec approval (ratatui), ANSI coloured.
const codexRun = [
  `${E}2m›${E}0m Run the mobile tests`,
  "",
  "• Running the new test file.",
  "",
  `  ${bold("Would you like to run the following command?")}`,
  "",
  `  ${dim("Reason:")} Run the test suite to verify the parser`,
  "",
  `  ${E}36m$${E}0m bun test test/mobile-permissions.test.ts`,
  "",
  `${E}36m›${E}0m ${E}36m1. Yes, proceed (y)${E}0m`,
  "  2. Yes, and don't ask again for commands that start with `bun test` (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  `  ${dim("Press enter to confirm or esc to cancel")}`,
].join("\n");

const codexAnswered = [
  ...codexRun.split("\n").slice(0, 14),
  "✔ You approved codex to run bun test test/mobile-permissions.test.ts this time",
  "",
  "• Ran bun test test/mobile-permissions.test.ts",
  "  └ 12 pass",
  "",
  "› Ask Codex to do anything",
  "",
  "  100% context left · ? for shortcuts",
].join("\n");

describe("parsePrompt — Claude Code", () => {
  test("Bash dialog with ANSI", () => {
    const p = parsePrompt(claudeBash)!;
    expect(p).not.toBeNull();
    expect(p.agent).toBe("claude");
    expect(p.title).toBe("Bash command");
    expect(p.detail).toBe("git push origin ball/local-2026-05\nPush local branch to origin");
    expect(p.question).toBe("Do you want to proceed?");
    expect(p.options.map(o => [o.n, o.kind])).toEqual([[1, "allow"], [2, "always"], [3, "deny"]]);
    expect(p.options[0].label).toBe("Yes");
    expect(p.options[2].label).toBe("No, and tell Claude what to do differently");
    expect(p.sig).toMatch(/^[0-9a-f]{12}$/);
  });

  test("answered prompt in scrollback → null", () => {
    expect(parsePrompt(claudeAnswered)).toBeNull();
  });

  test("Edit dialog: diff detail, wrapped option label", () => {
    const p = parsePrompt(claudeEdit)!;
    expect(p.title).toBe("Edit file");
    expect(p.detail).toContain("src/mobile/features/permissions.ts");
    expect(p.detail).toContain("+const SCREEN_LINES = 160;");
    expect(p.detail).not.toContain("╌");
    expect(p.question).toBe("Do you want to make this edit to permissions.ts?");
    expect(p.options[1]).toEqual({ n: 2, label: "Yes, allow all edits during this session", kind: "always" });
    expect(p.options).toHaveLength(3);
  });

  test("boxed dialog with nested box and wrapped last option", () => {
    const p = parsePrompt(claudeBoxed)!;
    expect(p.title).toBe("Create file");
    expect(p.detail).toBe("notes/todo.md\n- buy milk");
    expect(p.detail).toContain("notes/todo.md");
    expect(p.detail).not.toContain("│");
    expect(p.question).toBe("Do you want to create todo.md?");
    expect(p.options[2]).toEqual({ n: 3, label: "No, and tell Claude what to do differently", kind: "deny" });
  });

  test("Fetch dialog as plain text (Superset)", () => {
    const p = parsePrompt(claudeFetch)!;
    expect(p.title).toBe("Fetch");
    expect(p.detail).toContain("https://docs.anthropic.com/en/docs/claude-code/hooks");
    expect(p.question).toBe("Do you want to allow Claude to fetch this content?");
    expect(p.options[1].kind).toBe("always");
  });
});

describe("parsePrompt — Codex", () => {
  test("exec approval", () => {
    const p = parsePrompt(codexRun)!;
    expect(p.agent).toBe("codex");
    expect(p.title).toBe("Run command");
    expect(p.question).toBe("Would you like to run the following command?");
    expect(p.detail).toContain("$ bun test test/mobile-permissions.test.ts");
    expect(p.detail).toContain("Reason: Run the test suite");
    expect(p.options.map(o => o.label)).toEqual([
      "Yes, proceed",
      "Yes, and don't ask again for commands that start with `bun test`",
      "No, and tell Codex what to do differently",
    ]);
    expect(p.options.map(o => o.kind)).toEqual(["allow", "always", "deny"]);
  });

  test("answered → null", () => {
    expect(parsePrompt(codexAnswered)).toBeNull();
  });
});

describe("parsePrompt — negatives", () => {
  test("empty / plain shell", () => {
    expect(parsePrompt("")).toBeNull();
    expect(parsePrompt("ball@mac ~ % ls\nREADME.md  src\nball@mac ~ % ")).toBeNull();
  });

  test("numbered list in assistant output is not a prompt", () => {
    const s = ["⏺ Next steps:", "  1. Add tests", "  2. Ship it", "", RULE, "❯ ", RULE].join("\n");
    expect(parsePrompt(s)).toBeNull();
  });

  test("a menu without a cursor marker is ignored", () => {
    const s = [RULE, " Bash command", "   ls", " Do you want to proceed?", "   1. Yes", "   2. No"].join("\n");
    expect(parsePrompt(s)).toBeNull();
  });

  test("spinner after the options means it moved on", () => {
    const s = claudeFetch + "\n\n✻ Fetching… (3s · esc to interrupt)";
    expect(parsePrompt(s)).toBeNull();
  });
});

describe("helpers", () => {
  test("optionKind", () => {
    expect(optionKind("Yes")).toBe("allow");
    expect(optionKind("Yes, and don’t ask again for npm commands")).toBe("always");
    expect(optionKind("Yes, just this once")).toBe("allow");
    expect(optionKind("No, continue without running it")).toBe("deny");
    expect(optionKind("Keep planning")).toBe("other");
  });

  test("stripAnsi removes CSI + OSC 8 links", () => {
    expect(stripAnsi(`${E}1mhi${E}0m \x1b]8;;file:///a\x07a.ts\x1b]8;;\x07`)).toBe("hi a.ts");
  });

  test("sig changes when the dialog changes", () => {
    const a = parsePrompt(claudeBash)!, b = parsePrompt(claudeBash.replaceAll("ball/local-2026-05", "main"))!;
    expect(a.sig).not.toBe(b.sig);
    const { sig, ...rest } = a;
    expect(promptSig(rest)).toBe(sig);
  });
});

describe("routes", () => {
  // Fake ctx: a scripted screen and a recorder for key presses — nothing reaches tmux/Superset.
  const pressed: string[] = [];
  let screen = "";
  const load = async () => {
    const routes: Record<string, Function> = {};
    const fakeApp = { get: (p: string, h: Function) => { routes["GET " + p] = h; }, post: (p: string, h: Function) => { routes["POST " + p] = h; } };
    mount(fakeApp, {
      readScreen: async () => screen,
      pressKey: async (_ch: unknown, k: string) => { pressed.push(k); },
      roomChannel: (ws: string, room: string) => (ws === "tmux" && /^%\d+$/.test(room) ? { kind: "tmux", pane: room, label: room } : null),
    } as any);
    return routes;
  };
  const call = async (h: Function, params: any, body?: any) => { const set: any = {}; const r = await h({ params, body, set }); return { status: set.status ?? 200, ...r }; };

  test("GET returns the open prompt, POST presses only the confirmed option", async () => {
    const r = await load();
    screen = claudeBash;
    const got = await call(r["GET /rooms/:ws/:room/prompt"], { ws: "tmux", room: "%7" });
    expect(got.prompt.title).toBe("Bash command");
    const ok = await call(r["POST /rooms/:ws/:room/prompt/answer"], { ws: "tmux", room: "%7" }, { n: 1, sig: got.prompt.sig });
    expect(ok.status).toBe(200);
    expect(pressed).toEqual(["1"]);
  });

  test("POST refuses (409) and presses nothing when the prompt is gone, changed, or n missing", async () => {
    const r = await load();
    pressed.length = 0;
    const answer = r["POST /rooms/:ws/:room/prompt/answer"];
    screen = claudeAnswered;
    expect((await call(answer, { ws: "tmux", room: "%7" }, { n: 1 })).status).toBe(409);
    screen = claudeBash;
    expect((await call(answer, { ws: "tmux", room: "%7" }, { n: 1, sig: "000000000000" })).status).toBe(409);
    expect((await call(answer, { ws: "tmux", room: "%7" }, { n: 4 })).status).toBe(409);
    expect((await call(answer, { ws: "bogus", room: "x" }, { n: 1 })).status).toBe(404);
    expect(pressed).toEqual([]);
  });
});

describe("parseMenu — other dialogs", () => {
  const teach = [
    "✻ Brewed for 56s · done 9:07 PM",
    "▔".repeat(60),
    "   Teach auto mode about your environment?",
    "",
    "   Claude Code reads this project, your recent Claude sessions, and optionally",
    "",
    "     How you use Claude here    ◀ Mixed ▶",
    "   ❯ Also scan shell history    [✔]",
    "     Also scan your other repos [ ]",
    "",
    "     Continue",
    "",
    "   ←/→ to change usage · Enter to continue · Esc to cancel",
  ].join("\n");
  const trust = [
    "─".repeat(60),
    " Accessing workspace:",
    " /Users/ball",
    " Quick safety check: Is this a project you created or one you trust?",
    " Claude Code'll be able to read, edit, and execute files here.",
    " Security guide",
    " ❯ 1. No, exit",
    "   2. Yes, I trust this folder",
    " Enter to confirm · Esc to cancel",
  ].join("\n");

  test("toggle menu without numbers → title, body with cursor, footer", () => {
    const m = parseMenu(teach)!;
    expect(m.kind).toBe("menu");
    expect(m.title).toBe("Teach auto mode about your environment?");
    expect(m.body).toContain("❯ Also scan shell history");
    expect(m.footer).toContain("Enter to continue");
    expect(m.numbers).toEqual([]);
  });

  test("trust prompt (no 'Do you want' question) → menu with number buttons", () => {
    expect(parsePrompt(trust)).toBeNull();
    const m = parseMenu(trust)!;
    expect(m.title).toBe("Accessing workspace:");
    expect(m.numbers).toEqual([1, 2]);
  });

  test("AskUserQuestion: separator rule inside the options, 6 numbered rows", () => {
    // real screen (Claude Code 2.x) — a rule sits between "5. Type something." and "6. Chat about this"
    const ask = "✻ Sautéed for 1m 31s · done 10:40 PM \n\n \n❯ something else                                                            \n─────────────────────────────────────────────────────────────────────────────\n ☐ Account  \n\nWhich test account should we try on dev instead?\n \n  1. alice → Admin (Recommended)\n     Has admin + editor + viewer today · drop publish rights first, then check \n     that the admin page still opens\n❯ 2. bob → Editor\n     Has editor + viewer · remove publish rights and keep \n     editor only\n  3. carol → Viewer\n     Already viewer only · no change needed, just try the app\n  4. dave / erin → Guest\n     Already guest only · log in and look around\n  5. Type something.\n─────────────────────────────────────────────────────────────────────────────\n  6. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n───────────────────── Design data flow diagram ──";
    expect(parsePrompt(ask)).toBeNull();
    const m = parseMenu(ask)!;
    expect(m.title).toBe("☐ Account");
    expect(m.body).toContain("Which test account should we try on dev instead?");
    expect(m.body).toContain("❯ 2. bob → Editor");
    expect(m.body).toContain("6. Chat about this");
    expect(m.numbers).toEqual([1, 2, 3, 4, 5, 6]);
    expect(m.footer).toContain("Enter to select");
  });

  // real screens captured from Claude Code 2.1 / Codex CLI 0.163 in a throwaway tmux session (24 ต.ค. 69)
  test("AskUserQuestion last page (Review your answers) has no footer — still a menu", () => {
    const review = "──────────────────────────────────────────────────\n←  ☒ Color  ☒ Toppings  ✔ Submit  →\n\nReview your answers\n\n ● Which color do you want?\n   → Green\n ● Which toppings do you want?\n   → Cheese, Olive\n\nReady to submit your answers?\n\n❯ 1. Submit answers\n  2. Cancel";
    const m = parseMenu(review)!;
    expect(m).not.toBeNull();
    expect(m.body).toContain("Ready to submit your answers?");
    expect(m.body).toContain("● Which color do you want?");   // the dialog's own bullets don't end it
    expect(m.numbers).toEqual([1, 2]);
    expect(m.footer).toBe("");
  });

  test("plan mode exit (footer \"ctrl+g to edit in Vim\") → menu with 3 numbers", () => {
    const plan = "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n\n  ────────────────────────────────────────────────────────────────────────────────────────────────\n   Ready to code?\n\n   Here is Claude's plan:\n  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n   1. Run echo hello >> stamp.txt in project dir to append \"hello\" line.\n   2. Verify with tail -n 1 stamp.txt → shows hello.\n  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n  ────────────────────────────────────────────────────────────────────────────────────────────────\n   Claude has written up a plan and is ready to execute. Would you like to proceed?\n\n   ❯ 1. Yes, and use auto mode\n     2. Yes, manually approve edits\n     3. Tell Claude what to change\n        shift+tab to approve with this feedback\n\n   ctrl+g to edit in Vim · ~/.claude/plans/plan-demo.md";
    const m = parseMenu(plan)!;
    expect(m.title).toContain("Would you like to proceed?");
    expect(m.numbers).toEqual([1, 2, 3]);
    expect(m.footer).toContain("ctrl+g to edit");
  });

  test("Codex dialogs: footers without \"to\" (trust folder, hooks review)", () => {
    const t = parseMenu("  Folder access\n  /tmp/demo\n\n  Trust this folder? Codex can read, edit, and run files here, subject to your permission\n  settings. Continue only if you trust these files.\n\n› 1. Trust and continue\n  2. Quit\n\n  enter continue · esc quit")!;
    expect(t.title).toBe("Folder access");
    expect(t.numbers).toEqual([1, 2]);
    expect(t.footer).toBe("enter continue · esc quit");
    expect(parseMenu("  Hooks need review\n\n  9 hooks are new or changed.\n  Hooks can run outside the sandbox after you trust them.\n\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won't run)\n\n  enter confirm · esc skip")!.numbers).toEqual([1, 2, 3]);
  });

  test("Codex command approval → permission prompt; Codex idle input → nothing", () => {
    const p = parsePrompt("• Running printf 'hi' > hello.txt\n\n  Would you like to run the following command?\n\n  Environment: local\n\n  Reason: the session is read-only\n\n  $ printf 'hi' > hello.txt\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for commands that start with `printf 'hi' > hello.txt` (p)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel")!;
    expect(p.question).toBe("Would you like to run the following command?");
    expect(p.options.map(o => o.n)).toEqual([1, 2, 3]);
    expect(parseMenu("• Done.\n\n› Ask Codex to do anything\n\n  medium · Fast off · Context 5% used\n  ? for shortcuts")).toBeNull();
    expect(parsePrompt("• Done.\n\n› Ask Codex to do anything\n\n  medium · Fast off · Context 5% used\n  ? for shortcuts")).toBeNull();
  });

  test("normal input box and answered dialogs are not menus", () => {
    expect(parseMenu("⏺ done\n\n" + "─".repeat(20) + "\n❯ \n" + "─".repeat(20) + "\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 3 agents")).toBeNull();
    expect(parseMenu(teach + "\n\n⏺ Saved.\n\n❯ \n  ? for shortcuts")).toBeNull();
    expect(parseMenu("✻ Thinking… (3s · esc to interrupt)")).toBeNull();
  });

  test("POST /prompt/key presses only while a dialog is open", async () => {
    const pressed: string[] = [];
    let screen = teach;
    const routes: Record<string, Function> = {};
    mount({ get: (p: string, h: Function) => { routes["GET " + p] = h; }, post: (p: string, h: Function) => { routes["POST " + p] = h; } }, {
      readScreen: async () => screen,
      pressKey: async (_c: unknown, k: string) => { pressed.push(k); },
      roomChannel: () => ({ kind: "tmux", pane: "%7", label: "%7" }),
    } as any);
    const call = async (body: any) => { const set: any = {}; const r = await routes["POST /rooms/:ws/:room/prompt/key"]({ params: { ws: "tmux", room: "%7" }, body, set }); return set.status ?? 200; };
    const got: any = await routes["GET /rooms/:ws/:room/prompt"]({ params: { ws: "tmux", room: "%7" }, set: {} });
    expect(got.prompt.kind).toBe("menu");
    expect(await call({ key: "down" })).toBe(200);
    screen = "⏺ ok\n❯ \n  ? for shortcuts";
    expect(await call({ key: "enter" })).toBe(409);
    expect(pressed).toEqual(["down"]);
  });
});

describe("dialog watcher", () => {
  const teach = ["▔".repeat(40), "  Teach auto mode about your environment?", "", "  ❯ Also scan shell history [✔]", "    Continue", "", "  Enter to continue · Esc to cancel"].join("\n");
  const perm = ["─".repeat(40), " Bash command", "   rm -rf x", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", " Esc to cancel"].join("\n");
  const idle = "⏺ done\n❯ \n  ? for shortcuts";
  const ch = (pane: string) => ({ kind: "tmux", pane, label: "team" + pane }) as any;

  test("pushes once per new dialog, skips permission prompts, busy rooms and the first quiet pass", async () => {
    const screens: Record<string, string> = { "%1": teach, "%2": perm, "%3": teach };
    const rooms = new Map<string, any>([
      ["a", { pid: 1, sessionId: "a", status: "idle", name: "team1", channel: ch("%1") }],
      ["b", { pid: 2, sessionId: "b", status: "idle", name: "team2", channel: ch("%2") }],
      ["c", { pid: 3, sessionId: "c", status: "busy", name: "team3", channel: ch("%3") }],
    ]);
    const sent: any[] = [];
    const deps = { rooms: () => rooms, read: async (c: any) => screens[c.pane], notify: async (sid: string, kind: string, msg: any) => { sent.push([sid, kind, msg.title]); } };
    const seen = new Map<string, string>();
    expect(await dialogPass(deps, seen, true)).toEqual([]);          // after a restart: remember only
    screens["%1"] = idle;
    expect(await dialogPass(deps, seen)).toEqual([]);                 // closed
    screens["%1"] = teach;
    expect(await dialogPass(deps, seen)).toEqual(["a"]);              // opened again → push
    expect(await dialogPass(deps, seen)).toEqual([]);                 // still the same dialog
    expect(sent).toEqual([["a", "dialog", "❓ รอให้เลือก · team1"]]);
    expect(JSON.stringify(sent)).not.toContain("Teach");             // no screen text leaves the Mac
  });
});
