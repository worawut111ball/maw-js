import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mcpState, setClaudeMcp, setCodexMcp, tomlSetEnabled } from "../src/mobile/features/context";

const TOML = `model = "x"

[mcp_servers.canva]
url = "https://mcp.canva.com/mcp"

[mcp_servers.canva.tools.generate-image]
approval_mode = "approve"

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
`;

function home() {
  const h = mkdtempSync(join(tmpdir(), "maw-mcp-")), proj = join(h, "repo");
  mkdirSync(join(h, ".codex")); mkdirSync(proj);
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ numStartups: 1, mcpServers: { drawdy: { type: "http", url: "https://d" } }, projects: { [proj]: { mcpServers: { local1: { command: "x" } } } } }));
  writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { pj: { command: "y" } } }));
  writeFileSync(join(h, ".codex/config.toml"), TOML);
  return { h, proj };
}

describe("tomlSetEnabled", () => {
  test("off adds enabled = false under the server table, before its sub-tables · on removes it", () => {
    const off = tomlSetEnabled(TOML, "canva", false)!;
    expect(off).toContain('[mcp_servers.canva]\nenabled = false\nurl = "https://mcp.canva.com/mcp"');
    expect(off).toContain("[mcp_servers.canva.tools.generate-image]\napproval_mode");
    expect(tomlSetEnabled(off, "canva", true)).toBe(TOML);
    expect(tomlSetEnabled(TOML, "nope", false)).toBeNull();
  });
});

describe("MCP switches", () => {
  test("Claude per project: user/local → disabledMcpServers · .mcp.json → disabledMcpjsonServers · backup kept", () => {
    const { h, proj } = home();
    expect(mcpState(h, proj).claude.map(m => `${m.scope}:${m.name}:${m.enabled}`)).toEqual(["user:drawdy:true", "local:local1:true", "project:pj:true"]);
    expect(setClaudeMcp(h, proj, "drawdy", "user", false)).toBe(true);
    expect(setClaudeMcp(h, proj, "pj", "project", false)).toBe(true);
    const cj = JSON.parse(readFileSync(join(h, ".claude.json"), "utf-8"));
    expect(cj.projects[proj].disabledMcpServers).toEqual(["drawdy"]);
    expect(cj.projects[proj].disabledMcpjsonServers).toEqual(["pj"]);
    expect(cj.numStartups).toBe(1);
    expect(mcpState(h, proj).claude.find(m => m.name === "drawdy")!.enabled).toBe(false);
    expect(setClaudeMcp(h, proj, "drawdy", "user", true)).toBe(true);
    expect(JSON.parse(readFileSync(join(h, ".claude.json"), "utf-8")).projects[proj].disabledMcpServers).toEqual([]);
    expect(readdirSync(join(h, ".maw/backup")).length).toBeGreaterThan(0);
    expect(setClaudeMcp(h, proj, "ghost", "user", false)).toBe(false);
  });
  test("Codex global enabled flag", () => {
    const { h } = home();
    expect(setCodexMcp(h, "figma", false)).toBe(true);
    expect(mcpState(h).codex.map(m => `${m.name}:${m.enabled}`)).toEqual(["canva:true", "figma:false"]);
    expect(setCodexMcp(h, "figma", true)).toBe(true);
    expect(readFileSync(join(h, ".codex/config.toml"), "utf-8")).toBe(TOML);
    expect(setCodexMcp(h, "ghost", false)).toBe(false);
  });
});

import { addMcp, removeMcp, MCP_CATALOG } from "../src/mobile/features/context";
describe("add / remove MCP by URL (CLI)", () => {
  const fake = (h: string) => { const calls: string[][] = []; return { calls, run: (bin: string, args: string[], cwd: string) => { calls.push([bin.split("/").pop()!, ...args, "@" + (cwd === h ? "home" : "proj")]); return ""; } }; };
  test("Claude user/local and Codex call the right CLI with --transport http / --url", () => {
    const { h, proj } = home(), f = fake(h);
    expect(addMcp(h, { agent: "claude", name: "context7", url: "https://mcp.context7.com/mcp", scope: "user" }, f.run).ok).toBe(true);
    expect(addMcp(h, { agent: "claude", name: "sentry", url: "https://mcp.sentry.dev/mcp", scope: "local", folder: proj }, f.run).ok).toBe(true);
    expect(addMcp(h, { agent: "codex", name: "linear", url: "https://mcp.linear.app/mcp" }, f.run).ok).toBe(true);
    expect(f.calls).toEqual([
      ["claude", "mcp", "add", "--transport", "http", "-s", "user", "context7", "https://mcp.context7.com/mcp", "@home"],
      ["claude", "mcp", "add", "--transport", "http", "-s", "local", "sentry", "https://mcp.sentry.dev/mcp", "@proj"],
      ["codex", "mcp", "add", "linear", "--url", "https://mcp.linear.app/mcp", "@home"],
    ]);
  });
  test("refuses: http · credentials in URL · bad name · existing name · local without a room · removing .mcp.json server", () => {
    const { h, proj } = home(), f = fake(h);
    expect(addMcp(h, { agent: "codex", name: "x", url: "http://a.b/mcp" }, f.run).ok).toBe(false);
    expect(addMcp(h, { agent: "codex", name: "x", url: "https://u:p@a.b/mcp" }, f.run).ok).toBe(false);
    expect(addMcp(h, { agent: "codex", name: "bad name!", url: "https://a.b/mcp" }, f.run).ok).toBe(false);
    expect(addMcp(h, { agent: "codex", name: "canva", url: "https://a.b/mcp" }, f.run).ok).toBe(false);
    expect(addMcp(h, { agent: "claude", name: "drawdy", url: "https://a.b/mcp", scope: "user" }, f.run).ok).toBe(false);
    expect(addMcp(h, { agent: "claude", name: "new1", url: "https://a.b/mcp", scope: "local" }, f.run).ok).toBe(false);
    expect(removeMcp(h, { agent: "claude", name: "pj", scope: "project", folder: proj }, f.run).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });
  test("catalog: https URLs and valid names", () => {
    for (const c of MCP_CATALOG) { expect(c.url.startsWith("https://")).toBe(true); expect(/^[a-z0-9.-]+$/.test(c.name)).toBe(true); }
  });
});
