import { describe, expect, test } from "bun:test";
import { insideWorkspace, listDir, gitInfo, gitFileDiff, decorateDir, findRepos, promptSuggestion, nestedDeco, queuedMessages, claudeUsage, claudeLimits, codexUsage, slashCommands, frontMatter, forgetGitStatus, agentSpinner, transcriptImage, gitAction, gitGraph, ignoredNames, safeName, saveUpload, buildProjects, claudeTranscript, codexTranscript, createMobileApi, isSubagentRollout, hookStates, isAuthorized, readLiveRooms, roomChannel, statusFromHook, statusFromRoom, tmuxChannel, toMobileAgent, type LiveRoom } from "../src/mobile/api";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ClaudeSession } from "../src/core/fleet/claude-sessions";

const cfg = { token: "t".repeat(48), hookToken: "h".repeat(48), allowedLogins: ["ball@example.com"] };
const app = createMobileApi(cfg);
const req = (path: string, init: RequestInit = {}) => app.handle(new Request(`http://local${path}`, init));

const session = (over: Partial<ClaudeSession> = {}): ClaudeSession => ({
  sessionId: "s1", projectPath: "/tmp/repo", repo: null, worktree: { name: "repo", branch: "main" },
  pid: 42, ppid: 41, parentChain: [], tmuxTarget: null, triggeredFrom: "superset", status: "active",
  lastActivityAt: new Date(1_000_000).toISOString(), lastUser: "hi", lastAssistant: "hello",
  ...over,
} as ClaudeSession);

describe("auth", () => {
  test("bearer token or allowed tailscale login only", () => {
    expect(isAuthorized(new Headers({ authorization: `Bearer ${cfg.token}` }), cfg)).toBe(true);
    expect(isAuthorized(new Headers({ "tailscale-user-login": "ball@example.com" }), cfg)).toBe(true);
    expect(isAuthorized(new Headers({ "tailscale-user-login": "other@example.com" }), cfg)).toBe(false);
    expect(isAuthorized(new Headers({ authorization: "Bearer wrong" }), cfg)).toBe(false);
    expect(isAuthorized(new Headers(), cfg)).toBe(false);
  });

  test("routes reject callers without credentials", async () => {
    expect((await req("/mobile/health")).status).toBe(401);
    expect((await req("/mobile/health", { headers: { authorization: `Bearer ${cfg.token}` } })).status).toBe(200);
  });

  test("hook needs the hook token, not the app token", async () => {
    const body = JSON.stringify({ session_id: "s9", hook_event_name: "Stop" });
    const headers = { "content-type": "application/json" };
    expect((await req("/mobile/hook", { method: "POST", body, headers: { ...headers, authorization: `Bearer ${cfg.token}` } })).status).toBe(401);
    expect((await req("/mobile/hook", { method: "POST", body, headers: { ...headers, "x-mobile-hook-token": cfg.hookToken } })).status).toBe(200);
    expect(hookStates.get("s9")?.status).toBe("done");
  });
});

describe("status", () => {
  test("hook events map to statuses", () => {
    expect(statusFromHook("UserPromptSubmit")).toBe("working");
    expect(statusFromHook("Notification")).toBe("waiting");
    expect(statusFromHook("PermissionRequest")).toBe("waiting");
    expect(statusFromHook("Stop")).toBe("done");
    expect(statusFromHook("SessionEnd")).toBe("ended");
    expect(statusFromHook("SomethingElse")).toBeNull();
  });

  const room = (over: Partial<LiveRoom> = {}): LiveRoom => ({ pid: 1, sessionId: "s1", status: "busy", name: null, channel: null, ...over });

  test("fresh hook state wins over the room status", () => {
    const hook = { status: "waiting" as const, event: "Notification", at: 1_000_000 };
    expect(toMobileAgent(session(), hook, room()).status).toBe("waiting");
  });

  test("stale hook state is ignored", () => {
    const hook = { status: "done" as const, event: "Stop", at: 1 };
    expect(toMobileAgent(session(), hook, room({ status: "busy" })).status).toBe("working");
  });

  test("a session without a live process is ended (other rooms in the same folder no longer leak in)", () => {
    expect(toMobileAgent(session(), undefined, undefined).status).toBe("ended");
  });

  test("tmux and Superset rooms can be replied to, others cannot", () => {
    const tmux = room({ channel: { kind: "tmux", pane: "%2", label: "team2-oracle" } });
    const sup = room({ channel: { kind: "superset", workspaceId: "w", terminalId: "t", label: "fix login" } });
    expect(toMobileAgent(session(), undefined, room()).canReply).toBe(false);
    expect(toMobileAgent(session(), undefined, tmux).canReply).toBe(true);
    expect(toMobileAgent(session(), undefined, tmux).tmuxTarget).toBe("team2-oracle");
    const a = toMobileAgent(session(), undefined, sup);
    expect([a.canReply, a.source, a.room]).toEqual([true, "superset", "fix login"]);
  });
});

describe("rooms", () => {
  test("tmux field → pane id + session label", () => {
    expect(tmuxChannel("team1-oracle:@0.%0")).toEqual({ kind: "tmux", pane: "%0", label: "team1-oracle" });
    expect(tmuxChannel(null)).toBeNull();
  });

  test("Claude room status words", () => {
    expect(statusFromRoom("busy")).toBe("working");
    expect(statusFromRoom("waiting_for_input")).toBe("waiting");
    expect(statusFromRoom("idle")).toBe("idle");
  });

  test("reads only live session files, one room per process", () => {
    const dir = mkdtempSync(join(tmpdir(), "rooms-"));
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "live", status: "busy", tmux: "t1:@0.%3" }));
    writeFileSync(join(dir, "999999.json"), JSON.stringify({ pid: 999999, sessionId: "dead", status: "busy" }));
    const rooms = readLiveRooms(dir);
    expect([...rooms.keys()]).toEqual(["live"]);
    expect(rooms.get("live")!.channel).toEqual({ kind: "tmux", pane: "%3", label: "t1" });
  });
});

describe("quick keys", () => {
  test("unknown keys are rejected before touching tmux", async () => {
    const res = await req("/mobile/agents/whatever/keys", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ key: "rm -rf" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("projects", () => {
  const snap = { workspaces: [
    { id: "11111111-1111-1111-1111-111111111111", project: "facwms", name: "local", branch: "main",
      terminals: [
        { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", title: "◑ Add CSV export", agent: { id: "claude", state: "idle" } },
        { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "", agent: { id: "codex", state: "blocked" } },
        { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", title: "", agent: null },
      ],
      layout: { tabs: [{ title: "claude Jtekt 2", panes: [{ terminalId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }] }] } },
  ] };

  test("rooms take the user's tab title, Superset agent state, and live Claude status", () => {
    const live = new Map<string, LiveRoom>([["s1", { pid: 1, sessionId: "s1", status: "busy", name: null,
      channel: { kind: "superset", workspaceId: "w", terminalId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", label: "x" } }]]);
    const [p] = buildProjects(snap, live);
    const [a, b, c] = p.workspaces[0].rooms;
    expect([a.title, a.status, a.claudeSessionId]).toEqual(["claude Jtekt 2", "working", "s1"]);
    expect([b.agent, b.status]).toEqual(["codex", "waiting"]);
    expect([c.title, c.status]).toEqual(["terminal", "idle"]);
  });

  test("room ids from the phone are validated", () => {
    expect(roomChannel("tmux", "%2")).toEqual({ kind: "tmux", pane: "%2", label: "%2" });
    expect(roomChannel("tmux", "team1; rm -rf")).toBeNull();
    expect(roomChannel("not-a-uuid", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBeNull();
  });
});

describe("chat", () => {
  test("full transcript: every user message, replies, tool calls with results, sub-agents; plumbing hidden", () => {
    const root = mkdtempSync(join(tmpdir(), "proj-"));
    const dir = join(root, "-Users-x-repo"); require("fs").mkdirSync(dir);
    const rows = [
      { type: "user", timestamp: "t1", message: { content: "แก้เทส P7" } },
      { type: "user", isMeta: true, message: { content: "<command-name>x</command-name>" } },
      { type: "user", message: { content: "<system-reminder>ignore</system-reminder>" } },
      { type: "user", message: { content: "<command-name>/rrr</command-name><command-args>--quick</command-args>" } },
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "…" }, { type: "tool_use", id: "a", name: "Bash", input: { command: "bun test", description: "Run tests" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "8 pass", is_error: false }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "b", name: "Agent", input: { subagent_type: "Explore", description: "find files", prompt: "look" } }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "แก้แล้วครับ" }] } },
      { type: "user", message: { content: "[Request interrupted by user]" } },
      { type: "attachment", attachment: { type: "queued_command", prompt: "อย่าพึ่งลบนะ", timestamp: "t9" } },
      { type: "attachment", attachment: { type: "total_tokens_reminder", text: "x" } },
    ];
    writeFileSync(join(dir, "sess.jsonl"), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    const items = claudeTranscript("sess", root)!;
    expect(items.map(x => [x.role, x.text ?? x.tool?.summary])).toEqual([
      ["user", "แก้เทส P7"], ["user", "/rrr --quick"], ["tool", "Run tests"], ["agent", "Explore · find files"],
      ["assistant", "แก้แล้วครับ"], ["system", "⏹ หยุดงานกลางคัน"], ["user", "อย่าพึ่งลบนะ"],
    ]);
    expect(items[2].tool).toMatchObject({ input: "bun test", output: "8 pass", error: false });
    // appended lines are picked up without re-reading the file
    require("fs").appendFileSync(join(dir, "sess.jsonl"), JSON.stringify({ type: "user", message: { content: "ต่อ" } }) + "\n");
    expect(claudeTranscript("sess", root)!.at(-1)).toMatchObject({ role: "user", text: "ต่อ" });
  });
});

describe("codex chat", () => {
  test("Codex rollout → same bubbles: user text (images marked), replies, shell calls with exit code, patches, sub-agents", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-"));
    const f = join(dir, "rollout-x.jsonl");
    const rows = [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /x" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: '<image name=[Image #1] path="/a.png"></image> ดูหน่อย' }] } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: "bun test" }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "Chunk ID: 1\nProcess exited with code 1\nOutput:\n2 fail" } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c2", input: "*** Begin Patch\n*** Update File: src/a.ts\n+x" } },
      { type: "response_item", payload: { type: "agent_message", author: "/root", recipient: "/root/siren", content: [{ type: "input_text", text: "Task name: /root/siren" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "เสร็จครับ" }] } },
      { type: "event_msg", payload: { type: "turn_aborted" } },
    ];
    writeFileSync(f, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    const items = codexTranscript(f);
    expect(items.map(x => [x.role, x.text ?? x.tool?.summary])).toEqual([
      ["user", "ดูหน่อย"], ["tool", "bun test"], ["tool", "src/a.ts"], ["agent", "siren · /root → /root/siren"],
      ["assistant", "เสร็จครับ"], ["system", "⏹ หยุดงานกลางคัน"],
    ]);
    expect(items[1].tool).toMatchObject({ name: "Bash", output: "2 fail", error: true });
  });
});

test("sub-agent rollouts are told apart from the main thread", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex2-"));
  const main = join(dir, "rollout-main.jsonl"), sub = join(dir, "rollout-sub.jsonl");
  writeFileSync(main, JSON.stringify({ type: "session_meta", payload: { source: "cli" } }) + "\n");
  writeFileSync(sub, JSON.stringify({ type: "session_meta", payload: { source: { subagent: { thread_spawn: {} } } } }) + "\n");
  expect([isSubagentRollout(main), isSubagentRollout(sub)]).toEqual([false, true]);
});

describe("uploads", () => {
  test("file names cannot escape the upload folder, Thai names survive", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("รูป หน้าจอ.png")).toBe("รูป_หน้าจอ.png");
    expect(safeName("...")).toBe("file");
  });
  test("saved under a dated folder with a random prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "up-"));
    const f = saveUpload("a.png", new Uint8Array([1, 2, 3]), dir);
    expect(f.startsWith(dir)).toBe(true);
    expect(f).toMatch(/\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-a\.png$/);
  });
  test("upload + download through the API", async () => {
    const up = await req("/mobile/upload?name=x.txt", { method: "POST", headers: { authorization: `Bearer ${cfg.token}` }, body: "hello" });
    const j = await up.json();
    expect(j.ok).toBe(true);
    const down = await req(j.url, { headers: { authorization: `Bearer ${cfg.token}` } });
    expect(await down.text()).toBe("hello");
    require("fs").unlinkSync(j.path);
    expect((await req("/mobile/uploads/2026-01-01/..%2Fx", { headers: { authorization: `Bearer ${cfg.token}` } })).status).toBe(400);
  });
});

describe("explorer", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  const fs = require("fs"), { execFileSync } = require("child_process");
  fs.mkdirSync(join(root, "src")); fs.writeFileSync(join(root, "src/a.ts"), "one\n"); fs.writeFileSync(join(root, "README.md"), "hi\n");
  const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  g("init", "-q"); g("add", "."); g("commit", "-qm", "init");
  fs.writeFileSync(join(root, "src/a.ts"), "two\n"); fs.writeFileSync(join(root, "new.txt"), "n\n");

  test("paths cannot escape the workspace", () => {
    expect(insideWorkspace(root, "src")).toBe(require("fs").realpathSync(join(root, "src")));
    expect(insideWorkspace(root, "../../etc")).toBeNull();
    expect(insideWorkspace(root, "/etc/passwd")).toBe(require("fs").realpathSync(root) + "/etc/passwd");
  });
  test("folders first, .git hidden", () => {
    expect(listDir(root, "")!.items.map(i => i.name)).toEqual(["src", "new.txt", "README.md"]);
  });
  test("Source Control groups: staged vs changes, VS Code letters, per-file diff", () => {
    g("add", "src/a.ts");
    fs.writeFileSync(join(root, "README.md"), "changed\n");
    const info = gitInfo(root);
    expect(info.staged).toEqual([{ path: "src/a.ts", letter: "M" }]);
    expect(info.changes.map(c => [c.path, c.letter])).toEqual([["README.md", "M"], ["new.txt", "U"]]);
    expect(info.log[0].subject).toBe("init");
    expect(gitFileDiff(root, "", "src/a.ts", true)).toContain("+two");
    expect(gitFileDiff(root, "", "new.txt")).toContain("+n");
  });
  test("tree decorations: files get letters, folders get the strongest letter + count", () => {
    const d = decorateDir(require("fs").realpathSync(root));
    expect(d.get("src")).toEqual({ letter: "M", count: 1 });
    expect(d.get("new.txt")?.letter).toBe("U");
  });
  test("nested repos are listed", () => {
    const sub = join(root, "pkg"); fs.mkdirSync(sub); execFileSync("git", ["-C", sub, "init", "-q"]);
    expect(findRepos(root)).toEqual(["", "pkg"]);
    expect(nestedDeco(sub)).toBeNull(); // clean nested repo → no colour, even though the parent sees it as untracked
    fs.writeFileSync(join(sub, "x.txt"), "x"); forgetGitStatus(sub);
    expect(nestedDeco(sub)).toEqual({ letter: "U", count: 1 });
  });
  test("ignored names are flagged", () => {
    fs.writeFileSync(join(root, ".gitignore"), "build/\n"); fs.mkdirSync(join(root, "build"));
    const ign = ignoredNames(require("fs").realpathSync(root), ["build", "src", ".gitignore"]);
    expect([...ign]).toEqual(["build"]);
  });
  test("source control actions: stage, unstage, refuse discarding untracked, commit, graph", () => {
    gitAction(root, "", "unstage", {});
    expect(gitInfo(root).staged).toEqual([]);
    gitAction(root, "", "stage", { paths: ["src/a.ts"] });
    expect(gitInfo(root).staged.map(c => c.path)).toEqual(["src/a.ts"]);
    expect(() => gitAction(root, "", "discard", { paths: ["new.txt"] })).toThrow(/ไฟล์ใหม่/);
    expect(() => gitAction(root, "", "stage", { paths: ["--force"] })).toThrow(/bad path/);
    gitAction(root, "", "discard", { paths: ["README.md"] });
    expect(fs.readFileSync(join(root, "README.md"), "utf-8")).toBe("hi\n");
    execFileSync("git", ["-C", root, "config", "user.email", "t@t"]); execFileSync("git", ["-C", root, "config", "user.name", "t"]);
    gitAction(root, "", "commit", { message: "second" });
    const g = gitGraph(root);
    expect(g.map(c => c.subject)).toEqual(["second", "init"]);
    expect(g[0].parents).toEqual([g[1].sha]);
    expect(g[0].refs[0]).toMatchObject({ kind: "head", synced: false });
    expect(() => gitAction(root, "", "commit", { message: "  " })).toThrow(/ข้อความ/);
  });
});

describe("prompt suggestion (grey text in Claude's input box)", () => {
  const rule = "─".repeat(20);
  test("tmux: dim text after ❯+NBSP is a suggestion", () => {
    const raw = `\x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231mmerge เลย\x1b[39m\n${rule}\n\x1b[39m❯\u00a0\x1b[2mไปต่อเลย เสร็จแล้วสรุปมา\x1b[0m\n${rule}\n  status`;
    expect(promptSuggestion(raw)).toEqual({ text: "ไปต่อเลย เสร็จแล้วสรุปมา", sure: true });
  });
  test("tmux: normal-colour text is a real draft, not a suggestion", () => {
    expect(promptSuggestion(`${rule}\n\x1b[39m❯\u00a0\x1b[38;5;231mhalf typed\x1b[0m\n${rule}`)).toBeNull();
  });
  test("superset plain text: reported but marked unsure; empty box and placeholder give null", () => {
    expect(promptSuggestion(`❯ old message\n${rule}\n❯\u00a0ไปต่อเลย\n${rule}`)).toEqual({ text: "ไปต่อเลย", sure: false });
    expect(promptSuggestion(`❯ old message\n${rule}\n❯\u00a0\n${rule}`)).toBeNull();
    expect(promptSuggestion(`${rule}\n❯\u00a0Try "fix lint errors"\n${rule}`)).toBeNull();
  });
});

describe("pasted images show as real pictures", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  test("same picture → same file, written once", () => {
    const dir = mkdtempSync(join(tmpdir(), "img-"));
    const a = transcriptImage(PNG, "image/png", dir), b = transcriptImage(PNG, "image/png", dir);
    expect(a).toMatch(/^\/mobile\/img\/[0-9a-f]{20}\.png$/);
    expect(a).toBe(b);
    expect(require("fs").readdirSync(dir)).toHaveLength(1);
    expect(transcriptImage(PNG, "application/pdf", dir)).toBeNull();
  });
});

describe("working line (the animated spinner above the input box)", () => {
  test("Claude: verb + details while working; finished line ignored", () => {
    expect(agentSpinner("● Checking\n\n\x1b[38;5;211m✽ Moonwalking… \x1b[2m(19s · ↓ 564 tokens · thinking)\x1b[0m\n────\n❯ \n────"))
      .toEqual({ verb: "Moonwalking…", detail: "19s · ↓ 564 tokens · thinking" });
    expect(agentSpinner("✻ Brewed for 35s · done 4:42 PM\n────\n❯ \n────")).toBeNull();
  });
  test("Codex working line", () => {
    expect(agentSpinner("• Working (12s • esc to interrupt)\n› ")).toEqual({ verb: "Working…", detail: "12s" });
  });
});

describe("/ picker: skills and commands", () => {
  test("front matter: quoted, folded, and plain-first-line fallback", () => {
    expect(frontMatter("---\nname: rrr\ndescription: '[standard] v1 | Retro'\n---\nbody")).toEqual({ name: "rrr", description: "[standard] v1 | Retro" });
    expect(frontMatter("---\ndescription: >\n  line one\n  line two\n---")).toEqual({ description: "line one line two" });
    expect(frontMatter("# Title\nDo the thing")).toEqual({ description: "Do the thing" });
  });
  test("claude: builtins + project + user skills/commands, codex: prompts + $skills", () => {
    const home = mkdtempSync(join(tmpdir(), "home-")), proj = mkdtempSync(join(tmpdir(), "proj-"));
    const fs = require("fs");
    fs.mkdirSync(join(home, ".claude/skills/rrr"), { recursive: true });
    fs.writeFileSync(join(home, ".claude/skills/rrr/SKILL.md"), "---\nname: rrr\ndescription: '[standard] v26.5.16 G-SKLL | Create session retrospective'\n---\n");
    fs.mkdirSync(join(home, ".claude/commands/git"), { recursive: true });
    fs.writeFileSync(join(home, ".claude/commands/git/pr.md"), "---\ndescription: open a PR\n---\n");
    fs.mkdirSync(join(proj, ".claude/skills/deploy"), { recursive: true });
    fs.writeFileSync(join(proj, ".claude/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: ship it\n---\n");
    const c = slashCommands("claude", proj, home);
    expect(c.find(x => x.name === "compact")?.source).toBe("builtin");
    expect(c.find(x => x.name === "rrr")).toEqual({ name: "rrr", insert: "/rrr", desc: "Create session retrospective", source: "user" });
    expect(c.find(x => x.name === "git:pr")?.insert).toBe("/git:pr");
    fs.mkdirSync(join(home, ".claude/skills/bud"), { recursive: true });
    fs.writeFileSync(join(home, ".claude/skills/bud/SKILL.md"), "---\nname: bud\ndescription: '[core] v26.4.18-alpha.22 G-SKLL | Create a new oracle'\n---\n");
    expect(c.find(x => x.name === "deploy")?.source).toBe("project");
    expect(slashCommands("claude", proj + "/", home).find(x => x.name === "bud")?.desc).toBe("Create a new oracle");
    fs.mkdirSync(join(home, ".codex/skills/dig"), { recursive: true });
    fs.writeFileSync(join(home, ".codex/skills/dig/SKILL.md"), "---\nname: dig\ndescription: mine history\n---\n");
    fs.mkdirSync(join(home, ".codex/prompts"), { recursive: true });
    fs.writeFileSync(join(home, ".codex/prompts/scan-repo.md"), "Scan the repo");
    const x = slashCommands("codex", null, home);
    expect(x.find(i => i.name === "dig")?.insert).toBe("$dig");
    expect(x.find(i => i.name === "prompts:scan-repo")).toMatchObject({ insert: "/prompts:scan-repo", desc: "Scan the repo" });
  });
});

describe("context + limits", () => {
  test("claude: numbers from the saved status line JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "st-"));
    writeFileSync(join(dir, "a34a3542-aaaa.json"), JSON.stringify({ context_window: { context_window_size: 1000000, used_percentage: 34, current_usage: { input_tokens: 2, cache_creation_input_tokens: 1817, cache_read_input_tokens: 339841 } }, rate_limits: { five_hour: { used_percentage: 1, resets_at: 1792681200 }, seven_day: { used_percentage: 25.4, resets_at: 1793142000 } }, model: { display_name: "Opus 5.5 (1M context)" } }));
    const u = claudeUsage("a34a3542-aaaa", dir)!;
    expect(u.context).toEqual({ pct: 34, used: 341660, size: 1000000 });
    expect(u.limits).toEqual({ h5: { pct: 1, resetsAt: 1792681200 }, d7: { pct: 25, resetsAt: 1793142000 } });
    expect(claudeLimits(dir)?.d7?.pct).toBe(25);
    expect(claudeUsage("../etc/passwd", dir)).toBeNull();
  });
  test("codex: last token_count event in the rollout", () => {
    const f = join(mkdtempSync(join(tmpdir(), "cx-")), "rollout.jsonl");
    writeFileSync(f, [{ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100 }, model_context_window: 1000 }, rate_limits: null } },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 212702 }, model_context_window: 258400 }, rate_limits: { primary: { used_percent: 14, window_minutes: 10080, resets_at: 1793082765 }, secondary: { used_percent: 40, window_minutes: 300, resets_at: 1 } } } }].map(x => JSON.stringify(x)).join("\n") + "\n");
    const u = codexUsage(f)!;
    expect(u.context).toEqual({ pct: 82, used: 212702, size: 258400 });
    expect(u.limits).toEqual({ h5: { pct: 40, resetsAt: 1 }, d7: { pct: 14, resetsAt: 1793082765 } });
  });
});

describe("queued messages (typed while the agent is busy)", () => {
  const rule = "─".repeat(20);
  test("lines above 'send now' hint, wrapped lines joined; placeholder is not a suggestion", () => {
    const raw = `● Background command done\n\n\x1b[48;5;237m❯ \x1b[38;5;246mทำไมไม่เอาลง บรานกลาง\n  แล้วเอาเข้า deploy ที่เดียว\n❯ อีกข้อความ\n\x1b[49m  ctrl+x ctrl+s to send now\n\n✢ Noodling… (3m 4s · ↓ 358 tokens)\n${rule}\n❯\u00a0\x1b[2mPress up to edit queued messages\x1b[0m\n${rule}`;
    expect(queuedMessages(raw)).toEqual(["ทำไมไม่เอาลง บรานกลาง แล้วเอาเข้า deploy ที่เดียว", "อีกข้อความ"]);
    expect(promptSuggestion(raw)).toBeNull();
    expect(queuedMessages("● done\n❯ old\n")).toEqual([]);
  });
});
