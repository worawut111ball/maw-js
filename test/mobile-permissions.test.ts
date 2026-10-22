import { describe, expect, test } from "bun:test";
import { parsePrompt, optionKind, stripAnsi, promptSig, mount } from "../src/mobile/features/permissions";

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
  "   2. Yes, and don't ask again for git push commands in /Users/ball/my-project/maw-js",
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
