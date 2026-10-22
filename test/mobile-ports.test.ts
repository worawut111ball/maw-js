import { describe, expect, test } from "bun:test";
import { agentAncestor, isAgentProc, etimeSeconds, insidePath, loopbackOnly, parseEnv, parseLsofCwd, parseLsofListen, parseProcTable, parsePsInfo } from "../src/mobile/features/ports";

const LSOF_LISTEN = [
  "p697", "R1", "cControlCenter", "u501", "Lball", "f9", "n*:7000", "f10", "n*:7000", "f11", "n*:5000",
  "p4242", "R4200", "cnode", "u501", "Lball", "f20", "n127.0.0.1:5710", "f21", "n[::1]:5710",
  "p5000", "R1", "cpostgres", "u502", "f5", "n*:5432",
  "p6000", "R1", "cweird", "u501", "f5", "nnot-an-addr",
  "",
].join("\n");

describe("ports pack — parsers", () => {
  test("lsof -F listen: one entry per pid, ports deduped + sorted, addrs kept", () => {
    const l = parseLsofListen(LSOF_LISTEN);
    expect(l.map(x => x.pid)).toEqual([697, 4242, 5000]); // 6000 has no parsable port → dropped
    expect(l[0]).toMatchObject({ name: "ControlCenter", uid: 501, ppid: 1, ports: [5000, 7000], addrs: ["*"] });
    expect(l[1]).toMatchObject({ name: "node", ppid: 4200, ports: [5710], addrs: ["127.0.0.1", "[::1]"] });
    expect(l[2].uid).toBe(502);
    expect(parseLsofListen("")).toEqual([]);
  });

  test("loopback-only addresses", () => {
    expect(loopbackOnly(["127.0.0.1", "[::1]"])).toBe(true);
    expect(loopbackOnly(["*"])).toBe(false);
    expect(loopbackOnly(["127.0.0.1", "10.0.0.5"])).toBe(false);
    expect(loopbackOnly([])).toBe(false);
  });

  test("lsof cwd", () => {
    const m = parseLsofCwd("p4242\nfcwd\nn/Users/ball/artron/app\np99\nfcwd\nn/Users/ball/my project\n");
    expect(m.get(4242)).toBe("/Users/ball/artron/app");
    expect(m.get(99)).toBe("/Users/ball/my project");
  });

  test("path filter: inside, equal, sibling-prefix, empty", () => {
    expect(insidePath("/a/b", "/a/b")).toBe(true);
    expect(insidePath("/a/b/c/d", "/a/b/")).toBe(true);
    expect(insidePath("/a/bc", "/a/b")).toBe(false);
    expect(insidePath("/a", "/a/b")).toBe(false);
    expect(insidePath("", "/a")).toBe(false);
    expect(insidePath("/a", null)).toBe(false);
  });

  test("env: tmux pane, superset ids, junk ignored", () => {
    const ws = "11111111-2222-3333-4444-555555555555", t = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(parseEnv("node vite PATH=/usr/bin TMUX=/tmp/tmux-501/default,1,0 TMUX_PANE=%12 HOME=/Users/ball")).toEqual({ tmuxPane: "%12" });
    expect(parseEnv(`node x SUPERSET_WORKSPACE_ID=${ws} SUPERSET_TERMINAL_ID=${t}`)).toEqual({ ssWorkspace: ws, ssTerminal: t });
    expect(parseEnv(`node x SUPERSET_WORKSPACE_ID=${ws}`)).toEqual({});
    expect(parseEnv("node x TMUX_PANE=oops MY_TMUX_PANE=%3")).toEqual({});
  });

  test("ps info + etime", () => {
    const m = parsePsInfo("  4242   01:02:03 node /x/node_modules/.bin/vite --port 5710\n 99 1-00:00:05 bun run dev\n");
    expect(m.get(4242)).toEqual({ etime: "01:02:03", command: "node /x/node_modules/.bin/vite --port 5710" });
    expect(etimeSeconds("01:02:03")).toBe(3723);
    expect(etimeSeconds("1-00:00:05")).toBe(86405);
    expect(etimeSeconds("05:07")).toBe(307);
    expect(etimeSeconds("?")).toBeNull();
    expect(parsePsInfo(`1 00:01 ${"x".repeat(500)}`).get(1)!.command.length).toBe(200);
  });

  test("agent ancestor: a dev server started by Claude must not get ctrl+c in Claude's pane", () => {
    const procs = parseProcTable([
      "  1     0 /sbin/launchd", " 100     1 tmux", " 200   100 -zsh", " 300   200 claude", " 400   300 /bin/zsh",
      " 500   400 node", " 600   200 npm", " 700   600 node",
    ].join("\n"));
    expect(agentAncestor(500, procs)).toBe(true);             // claude → zsh → node
    expect(agentAncestor(700, procs)).toBe(false);            // zsh → npm → node (typed by a human)
    expect(agentAncestor(700, procs, new Set([600]))).toBe(true); // live-room pid counts as agent
    expect(agentAncestor(999, procs)).toBe(false);
    expect(isAgentProc(300, procs)).toBe(true);               // the agent's own socket is hidden
    expect(isAgentProc(700, procs)).toBe(false);
    expect(isAgentProc(700, procs, new Set([700]))).toBe(true);
  });
});
