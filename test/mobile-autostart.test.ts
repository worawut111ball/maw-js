import { describe, expect, test } from "bun:test";
import { commandFor, ensure, load, mount, sanitize } from "../src/mobile/features/autostart";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const allow = (p: string) => (p.startsWith("/Users/x/") || p === "/Users/x" ? p : null);

describe("autostart", () => {
  test("commands come from a fixed set — the phone never sends one", () => {
    expect(commandFor({ session: "t1", dir: "/Users/x", agent: "claude", skipPermissions: true })).toStartWith("claude --continue --dangerously-skip-permissions || claude --dangerously-skip-permissions; ");
    expect(commandFor({ session: "t2", dir: "/Users/x", agent: "claude", skipPermissions: false })).toStartWith("claude --continue || claude; ");
    expect(commandFor({ session: "c", dir: "/Users/x", agent: "codex", skipPermissions: true })).toStartWith("codex resume --last || codex; ");
    // the agent quitting (trust prompt → "No, exit") leaves a shell, so the tmux session does not disappear
    for (const agent of ["claude", "codex"] as const) expect(commandFor({ session: "k", dir: "/Users/x", agent, skipPermissions: false })).toEndWith('; exec "${SHELL:-/bin/zsh}" -l');
    expect(commandFor({ session: "s", dir: "/Users/x", agent: "shell", skipPermissions: false })).toBeNull();
    expect(sanitize({ session: "a; rm -rf /", dir: "/Users/x" }, allow)).toBeNull();
    expect(sanitize({ session: "ok", dir: "/etc" }, allow)).toBeNull();
    expect(sanitize({ session: "ok", dir: "/Users/x/p", agent: "evil", cmd: "curl x|sh" }, allow)).toEqual({ session: "ok", dir: "/Users/x/p", agent: "claude", skipPermissions: false });
  });

  test("ensure starts only the missing sessions", () => {
    const calls: string[][] = [];
    const tmux = (a: string[]) => { calls.push(a); if (a[0] === "has-session" && a[2] === "=up") return ""; if (a[0] === "has-session") throw new Error("no"); return ""; };
    const started = ensure([{ session: "up", dir: "/Users/x", agent: "claude", skipPermissions: false }, { session: "down", dir: "/Users/x/p", agent: "claude", skipPermissions: true }], tmux);
    expect(started).toEqual(["down"]);
    expect(calls.find(a => a[0] === "new-session")).toEqual(["new-session", "-d", "-s", "down", "-c", "/Users/x/p", commandFor({ session: "down", dir: "/Users/x/p", agent: "claude", skipPermissions: true })]);
  });

  test("routes add, update and remove; live tmux sessions offered", () => {
    const file = join(mkdtempSync(join(tmpdir(), "as-")), "autostart.json");
    const routes: Record<string, Function> = {};
    mount({ get: (p: string, h: Function) => { routes["GET " + p] = h; }, post: (p: string, h: Function) => { routes["POST " + p] = h; } },
      { file, allow, tmux: () => "", panes: () => [{ id: "%1", session: "team2", window: "w", cwd: "/Users/x", agent: "claude" }] as any });
    const post = (body: any) => { const set: any = {}; const r = routes["POST /autostart"]({ body, set }); return { status: set.status ?? 200, ...r }; };
    expect(routes["GET /autostart"]().live).toEqual([{ session: "team2", dir: "/Users/x", agent: "claude" }]);
    expect(post({ session: "team2", dir: "/Users/x", agent: "claude", on: true }).status).toBe(200);
    expect(load(file, allow)).toHaveLength(1);
    expect(routes["GET /autostart"]().rooms[0].running).toBe(true);
    expect(post({ session: "team2", skipPermissions: true, on: true }).rooms[0].skipPermissions).toBe(true);   // update keeps the folder
    expect(post({ session: "bad name!", dir: "/Users/x" }).status).toBe(400);
    expect(post({ session: "team2", on: false }).rooms).toHaveLength(0);
  });
});
