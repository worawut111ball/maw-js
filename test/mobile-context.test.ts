import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  redact, shortenCommand, commandBase, hookScript, mcpType, mcpList, pluginList, hookList, claudeJsonMcp, codexSettings,
  readAgentSettings, dirsOf, walkFiles, rankFiles, candidates, roomFolder, mount,
} from "../src/mobile/features/context";

// Fake secrets built at runtime so nothing real-looking sits in the source.
const HEX = "a1b2c3d4".repeat(5);                 // 40 hex chars
const B64 = "QWxhZGRpbjpvcGVuIHNlc2FtZQ9xZ2";      // 30 base64 chars, mixed
const SK = "sk-ant-api03-" + "Xy9".repeat(8);

describe("redact", () => {
  test("env-like assignments lose their value", () => {
    expect(redact("API_KEY=abc123 node x.js")).toBe("API_KEY=*** node x.js");
    expect(redact('FOO="two words" bar')).toBe("FOO=*** bar");
    expect(redact("--api-key=zzz")).toBe("--api-key=***");
    expect(redact("A=1 B=2")).toBe("A=*** B=***");
  });

  test("Bearer / Basic / Token headers", () => {
    expect(redact("Bearer abcdef")).toBe("Bearer ***");
    expect(redact("-H 'Authorization: Bearer xyz.123'")).not.toContain("xyz.123");
    expect(redact("basic dXNlcjpwYXNz")).toBe("basic ***");
  });

  test("header and flag style secrets", () => {
    expect(redact("x-api-key: abc")).toBe("x-api-key: ***");
    expect(redact("--token abc123 --verbose")).toBe("--token *** --verbose");
    expect(redact("cmd --password 'p w' next")).toBe("cmd --password *** next");
    expect(redact("--auth-token hunter2")).not.toContain("hunter2");
  });

  test("URLs: userinfo, query string and fragment stripped", () => {
    expect(redact("https://user:pw@example.com/path?key=v&b=2#frag")).toBe("https://***@example.com/path?***#***");
    expect(redact("see http://host:8080/a/b ok")).toBe("see http://host:8080/a/b ok");
    expect(redact("wss://h.io/s?token=abc")).toBe("wss://h.io/s?***");
  });

  test("long hex / base64 and known token prefixes", () => {
    expect(redact(`id ${HEX} end`)).toBe("id *** end");
    expect(redact(`x ${B64}`)).toBe("x ***");
    expect(redact(SK)).not.toContain("Xy9Xy9");
    expect(redact("ghp_" + "A1b2C3d4E5f6G7h8")).toBe("***");
    expect(redact("xoxb-1234-5678-abcdefgh")).toBe("***");
  });

  test("ordinary text and paths survive", () => {
    expect(redact("bash ~/.claude/hooks/notify.sh Stop")).toBe("bash ~/.claude/hooks/notify.sh Stop");
    expect(redact("Artron-Innovative-Co-Ltd")).toBe("Artron-Innovative-Co-Ltd");
    expect(redact("npx -y @modelcontextprotocol/server-filesystem")).toBe("npx -y @modelcontextprotocol/server-filesystem");
    expect(redact(null)).toBe("");
  });
});

describe("command helpers", () => {
  test("shortenCommand collapses home, redacts, clips", () => {
    expect(shortenCommand("/home/me/bin/hook.sh  --x", "/home/me")).toBe("~/bin/hook.sh --x");
    expect(shortenCommand(`TOKEN=${HEX} run`, "/h")).toBe("TOKEN=*** run");
    const long = shortenCommand("x".repeat(10) + " " + "y ".repeat(100), "/h", 40);
    expect(long.length).toBe(40);
    expect(long.endsWith("…")).toBe(true);
  });

  test("hookScript picks the script name or the program", () => {
    expect(hookScript('[ -x "$D/hooks/notify.sh" ] && "$D/hooks/notify.sh" Stop')).toBe("notify.sh");
    expect(hookScript('bash "$HOME/.maw/mobile-hook.sh"')).toBe("mobile-hook.sh");
    expect(hookScript("rtk hook claude")).toBe("rtk");
    expect(hookScript("python3 /x/guard.py --k v")).toBe("guard.py");
    expect(hookScript('[ -n "$X" ] && echo hi')).toBeUndefined();
  });

  test("commandBase keeps only the program name", () => {
    expect(commandBase("/usr/local/bin/npx -y pkg --token abc")).toBe("npx");
    expect(commandBase("uvx")).toBe("uvx");
    expect(commandBase("")).toBeUndefined();
    expect(commandBase(42)).toBeUndefined();
  });
});

describe("settings readers", () => {
  test("mcpType", () => {
    expect(mcpType({ command: "npx" })).toBe("stdio");
    expect(mcpType({ url: "https://x" })).toBe("http");
    expect(mcpType({ type: "sse", url: "https://x" })).toBe("sse");
    expect(mcpType({ type: "streamable-http" })).toBe("http");
  });

  test("mcpList never leaks args/env/headers/url", () => {
    const list = mcpList({
      fs: { command: "/opt/bin/npx", args: ["-y", "srv", SK], env: { API_KEY: HEX } },
      remote: { type: "http", url: `https://u:p@api.example.com/mcp?key=${HEX}`, headers: { Authorization: "Bearer " + HEX } },
    }, "user");
    expect(list).toEqual([
      { name: "fs", scope: "user", type: "stdio", command: "npx" },
      { name: "remote", scope: "user", type: "http" },
    ]);
    const s = JSON.stringify(list);
    for (const bad of [HEX, "Xy9", "api.example.com", "srv"]) expect(s).not.toContain(bad);
  });

  test("pluginList merges enabled flags with installed versions", () => {
    const list = pluginList(
      { enabledPlugins: { "a@mk": true, "b@mk": false, "c@other": true } },
      { version: 2, plugins: { "a@mk": [{ version: "1.2.0", installPath: "/secret/path" }], "d@mk": [{ version: "0.1" }] } },
    );
    expect(list).toEqual([
      { name: "a", marketplace: "mk", version: "1.2.0", enabled: true },
      { name: "c", marketplace: "other", enabled: true },
      { name: "b", marketplace: "mk", enabled: false },
      { name: "d", marketplace: "mk", version: "0.1", enabled: false },
    ]);
    expect(pluginList(null, null)).toEqual([]);
  });

  test("hookList flattens events with matchers and redacted commands", () => {
    const hooks = hookList({ hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/h/x/notify.sh" }] }],
      PreToolUse: [{ matcher: "Bash|Edit", hooks: [{ type: "command", command: `curl -H "Authorization: Bearer ${HEX}" https://h.io/x?t=1` }, { type: "prompt", prompt: "secret prompt" }] }],
    } }, "/h");
    expect(hooks[0]).toEqual({ event: "Stop", matcher: "", command: "~/x/notify.sh", script: "notify.sh" });
    expect(hooks[1].script).toBe("curl");
    expect(hooks[1].matcher).toBe("Bash|Edit");
    expect(hooks[1].command).not.toContain(HEX);
    expect(hooks[1].command).not.toContain("t=1");
    expect(hooks[2].command).toBe("[prompt]");
    expect(hookList({})).toEqual([]);
  });

  test("claudeJsonMcp: user + local scopes, optional project filter", () => {
    const cj = { mcpServers: { g: { command: "uvx" } }, projects: { "/a/proj1": { mcpServers: { l: { url: "https://x" } } }, "/a/proj2": {} } };
    expect(claudeJsonMcp(cj)).toEqual([
      { name: "g", scope: "user", type: "stdio", command: "uvx" },
      { name: "l", scope: "local", type: "http", project: "proj1" },
    ]);
    expect(claudeJsonMcp(cj, "/a/proj2")).toEqual([{ name: "g", scope: "user", type: "stdio", command: "uvx" }]);
    expect(claudeJsonMcp(null)).toEqual([]);
  });

  test("codexSettings reads mcp_servers + model", () => {
    const t = Bun.TOML.parse(`model = "gpt-5"\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["${SK}"]\n[mcp_servers.web]\nurl = "https://h/x?k=${HEX}"\nbearer_token_env_var = "T"\n`);
    const r = codexSettings(t);
    expect(r).toEqual({ model: "gpt-5", mcp: [{ name: "docs", type: "stdio", command: "npx" }, { name: "web", type: "http" }] });
    expect(codexSettings(null)).toEqual({ mcp: [] });
  });

  test("readAgentSettings end-to-end on a fake home leaks nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-home-"));
    const proj = join(home, "proj");
    mkdirSync(join(home, ".claude/plugins"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(proj);
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({
      model: "opus", statusLine: { type: "command", command: "x" }, enabledPlugins: { "p@m": true },
      hooks: { Stop: [{ hooks: [{ type: "command", command: `${home}/h.sh --token ${HEX}` }] }] },
    }));
    writeFileSync(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: { "p@m": [{ version: "2.0" }] } }));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { u: { command: "npx", env: { K: HEX } } }, projects: { [proj]: { mcpServers: { loc: { type: "sse", url: "https://x" } } } } }));
    writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { pj: { command: "/usr/bin/python3", args: [SK] } } }));
    writeFileSync(join(home, ".codex/config.toml"), `model = "o4"\n[mcp_servers.c]\ncommand = "node"\nenv = { SECRET = "${HEX}" }\n`);

    const r = readAgentSettings(home);
    expect(r.claude.model).toBe("opus");
    expect(r.claude.statusLine).toBe(true);
    expect(r.claude.plugins).toEqual([{ name: "p", marketplace: "m", version: "2.0", enabled: true }]);
    expect(r.claude.hooks).toEqual([{ event: "Stop", matcher: "", command: "~/h.sh --token ***", script: "h.sh" }]);
    expect(r.claude.mcp).toEqual([
      { name: "u", scope: "user", type: "stdio", command: "npx" },
      { name: "loc", scope: "local", type: "sse", project: "proj" },
      { name: "pj", scope: "project", type: "stdio", command: "python3", project: "proj" },
    ]);
    expect(r.codex).toEqual({ model: "o4", mcp: [{ name: "c", type: "stdio", command: "node" }] });
    const s = JSON.stringify(r);
    expect(s).not.toContain(HEX);
    expect(s).not.toContain("Xy9");
  });
});

describe("@file mentions", () => {
  test("dirsOf lists every ancestor folder", () => {
    expect(dirsOf(["a/b/c.ts", "a/d.ts", "e.md"]).sort()).toEqual(["a", "a/b"]);
  });

  test("rankFiles: basename prefix > contains > path; shorter first", () => {
    const files = ["src/mobile/api.ts", "src/api/index.ts", "test/mobile-api.test.ts", "docs/rapid.md", "api.md"];
    const dirs = dirsOf(files);
    const hits = rankFiles(files, dirs, "api").map(h => h.path);
    expect(hits.slice(0, 3)).toEqual(["api.md", "src/api", "src/mobile/api.ts"]);
    expect(hits.indexOf("docs/rapid.md")).toBeGreaterThan(hits.indexOf("src/api/index.ts") === -1 ? 0 : 2);
    expect(hits).toContain("src/api/index.ts");
    expect(rankFiles(files, dirs, "API")[0].path).toBe("api.md");
    expect(rankFiles(files, dirs, "src")[0]).toEqual({ path: "src", dir: true });
    expect(rankFiles(files, dirs, "mobile/api")[0].path).toBe("src/mobile/api.ts");
    expect(rankFiles(files, dirs, "zzz")).toEqual([]);
    expect(rankFiles(files, dirs, "", 3).length).toBe(3);
    expect(rankFiles(Array.from({ length: 100 }, (_, i) => `f${i}.ts`), [], "f").length).toBe(30);
  });

  test("walkFiles skips heavy folders; candidates caches per folder", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-walk-"));
    for (const d of ["src", "node_modules/x", ".git", "build"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "");
    writeFileSync(join(root, "README.md"), "");
    writeFileSync(join(root, "node_modules/x/i.js"), "");
    writeFileSync(join(root, "build/out.js"), "");
    expect(walkFiles(root).sort()).toEqual(["README.md", "src/a.ts"]);
    const c1 = candidates(root);
    expect(c1.files.sort()).toEqual(["README.md", "src/a.ts"]);
    expect(c1.dirs).toEqual(["src"]);
    writeFileSync(join(root, "new.ts"), "");
    expect(candidates(root)).toBe(c1);               // cached
    expect(candidates(root, 0).files).toContain("new.ts");
  });

  test("roomFolder rejects bad tmux targets", () => {
    expect(roomFolder("tmux", "evil;rm")).toBeNull();
    expect(roomFolder("tmux", "-t")).toBeNull();
  });
});

describe("mount", () => {
  test("registers both routes", () => {
    const paths: string[] = [];
    mount({ get: (p: string) => { paths.push(p); } });
    expect(paths).toEqual(["/rooms/:ws/:room/files", "/settings/agents"]);
  });
});
