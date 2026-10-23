// Feature pack "autostart" — tmux rooms that come back by themselves after the Mac restarts.
// GET  /autostart                         → { ok, rooms: [{session, dir, agent, skipPermissions, running}], live: [tmux sessions not in the list] }
// POST /autostart {session, dir?, agent?, skipPermissions?, on}  → add / update / remove one room
// maw itself is a LaunchAgent (RunAtLoad), so on start it recreates any listed session that is missing.
// The command is built here from a fixed set (claude / codex / shell) — the phone never sends a command line.
import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { allowedDir, listTmuxPanes } from "../api";

export type Agent = "claude" | "codex" | "shell";
export interface AutoRoom { session: string; dir: string; agent: Agent; skipPermissions: boolean }

const FILE = join(homedir(), ".maw", "autostart.json");
const TMUX = existsSync("/opt/homebrew/bin/tmux") ? "/opt/homebrew/bin/tmux" : "tmux";
export const SESSION_RE = /^[\w.-]{1,40}$/;

export function sanitize(x: any, allow = allowedDir): AutoRoom | null {
  const session = String(x?.session ?? "").trim();
  const dir = allow(String(x?.dir ?? ""));
  const agent: Agent = ["claude", "codex", "shell"].includes(x?.agent) ? x.agent : "claude";
  if (!SESSION_RE.test(session) || !dir) return null;
  return { session, dir, agent, skipPermissions: agent === "claude" && x?.skipPermissions === true };
}
export function load(file = FILE, allow = allowedDir): AutoRoom[] {
  try { return (JSON.parse(readFileSync(file, "utf-8")) as any[]).map(x => sanitize(x, allow)).filter(Boolean) as AutoRoom[]; } catch { return []; }
}
function save(list: AutoRoom[], file = FILE) { writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 }); }

/** Shell command tmux runs in the new session: continue the last chat in that folder, else start fresh. */
export function commandFor(r: AutoRoom): string | null {
  if (r.agent === "shell") return null;
  if (r.agent === "codex") return "codex resume --last || codex";
  const f = r.skipPermissions ? " --dangerously-skip-permissions" : "";
  return `claude --continue${f} || claude${f}`;
}

type Tmux = (args: string[]) => string;
// maw runs under launchd with a bare PATH — the new session must still find `claude` / `codex` (nvm, homebrew)
const nvmBins = () => { try { return readdirSync(join(homedir(), ".nvm/versions/node")).map(v => join(homedir(), ".nvm/versions/node", v, "bin")); } catch { return []; } };
const realTmux: Tmux = args => execFileSync(TMUX, args, { encoding: "utf-8", timeout: 5_000, env: { ...process.env, PATH: [...nvmBins(), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", process.env.PATH ?? ""].join(":") } });
const has = (tmux: Tmux, s: string) => { try { tmux(["has-session", "-t", "=" + s]); return true; } catch { return false; } };

/** Create every listed session that is not running. Returns the ones it started. */
export function ensure(list: AutoRoom[], tmux: Tmux = realTmux): string[] {
  const started: string[] = [];
  for (const r of list) {
    if (has(tmux, r.session)) continue;
    const cmd = commandFor(r);
    try { tmux(["new-session", "-d", "-s", r.session, "-c", r.dir, ...(cmd ? [cmd] : [])]); started.push(r.session); } catch { /* tmux server not up yet — next pass */ }
  }
  return started;
}

export function mount(app: any, opts: { file?: string; tmux?: Tmux; allow?: typeof allowedDir; panes?: typeof listTmuxPanes } = {}): void {
  const file = opts.file ?? FILE, tmux = opts.tmux ?? realTmux, allow = opts.allow ?? allowedDir, panes = opts.panes ?? listTmuxPanes;
  // real server only: after a reboot maw starts at login → bring the rooms back (twice, in case tmux was slow)
  if (!opts.file && process.env.NODE_ENV !== "test") { setTimeout(() => ensure(load(file, allow), tmux), 5_000); setTimeout(() => ensure(load(file, allow), tmux), 60_000); }

  app.get("/autostart", () => {
    const list = load(file, allow), live = panes();
    const running = new Set(live.map(p => p.session));
    const listed = new Set(list.map(r => r.session));
    // tmux sessions you could add: one row per session (first pane's folder + agent)
    const extra = new Map<string, { session: string; dir: string; agent: Agent }>();
    for (const p of live) if (!listed.has(p.session) && !extra.has(p.session) && SESSION_RE.test(p.session))
      extra.set(p.session, { session: p.session, dir: p.cwd, agent: p.agent === "codex" ? "codex" : p.agent === "claude" ? "claude" : "shell" });
    return { ok: true, rooms: list.map(r => ({ ...r, running: running.has(r.session) })), live: [...extra.values()] };
  });

  app.post("/autostart", ({ body, set }: any) => {
    const list = load(file, allow);
    const session = String(body?.session ?? "");
    if (!SESSION_RE.test(session)) { set.status = 400; return { ok: false, error: "ชื่อห้องไม่ถูกต้อง" }; }
    const rest = list.filter(r => r.session !== session);
    if (body?.on === false) { save(rest, file); return { ok: true, rooms: rest }; }
    const old = list.find(r => r.session === session);
    const r = sanitize({ ...old, ...body, session }, allow);
    if (!r) { set.status = 400; return { ok: false, error: "โฟลเดอร์ต้องอยู่ใน home และไม่ใช่โฟลเดอร์ลับ" }; }
    save([...rest, r], file);
    return { ok: true, rooms: [...rest, r] };
  });
}
