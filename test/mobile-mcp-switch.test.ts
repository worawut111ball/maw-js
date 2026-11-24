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
