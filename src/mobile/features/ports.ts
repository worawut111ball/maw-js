// Feature pack "ports" — dev servers this project is running: which port, who runs it, stop / re-run (PLAN-maw-mobile.md §9).
// Superset CLI has no ports command, so we look ourselves: lsof (listening TCP of this user) → cwd inside the workspace.
// Owning terminal comes from the process env (TMUX_PANE / SUPERSET_*). Re-run = ctrl+c in that terminal, then ↑ + Enter.
// Absolute paths only — maw's launchd PATH has no /usr/sbin.
import { execFileSync } from "child_process";
import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { Tmux } from "../../core/transport/tmux-class";
import { pressKey, readLiveRooms, supersetSnapshot, workspacePath, type ReplyChannel } from "./ctx";

const LSOF = "/usr/sbin/lsof", PS = "/bin/ps";
const CACHE_MS = 3_000, CMD_MAX = 200;

// ── parsers (pure — tests feed fixtures) ─────────────────────────

export interface Listener { pid: number; ppid: number | null; uid: number | null; name: string; addrs: string[]; ports: number[] }

/** `lsof -nP -iTCP -sTCP:LISTEN -F pcuRn` → one entry per process (IPv4 + IPv6 of the same port collapse). */
export function parseLsofListen(out: string): Listener[] {
  const by = new Map<number, Listener>();
  let cur: Listener | null = null;
  for (const line of String(out).split("\n")) {
    const tag = line[0], v = line.slice(1);
    if (tag === "p") { const pid = +v; cur = by.get(pid) ?? { pid, ppid: null, uid: null, name: "", addrs: [], ports: [] }; by.set(pid, cur); }
    else if (!cur) continue;
    else if (tag === "c") cur.name = v;
    else if (tag === "u") cur.uid = +v;
    else if (tag === "R") cur.ppid = +v;
    else if (tag === "n") {
      const m = /^(.*):(\d+)$/.exec(v); if (!m) continue;
      const port = +m[2];
      if (!cur.addrs.includes(m[1])) cur.addrs.push(m[1]);
      if (!cur.ports.includes(port)) cur.ports.push(port);
    }
  }
  for (const l of by.values()) l.ports.sort((a, b) => a - b);
  return [...by.values()].filter(l => l.ports.length);
}

/** `lsof -a -p 1,2 -d cwd -Fpn` → pid → cwd. */
export function parseLsofCwd(out: string): Map<number, string> {
  const m = new Map<number, string>(); let pid = 0;
  for (const line of String(out).split("\n")) {
    if (line[0] === "p") pid = +line.slice(1);
    else if (line[0] === "n" && pid) m.set(pid, line.slice(1));
  }
  return m;
}

/** Only loopback addresses → the phone can't open it (needs --host / 0.0.0.0). */
export const loopbackOnly = (addrs: string[]) => addrs.length > 0 && addrs.every(a => /^(127\.|\[::1\]|localhost)/.test(a));

/** Is `cwd` the workspace folder or below it? (string check on already-resolved paths) */
export function insidePath(cwd: string | null | undefined, root: string | null | undefined): boolean {
  if (!cwd || !root) return false;
  const r = root.replace(/\/+$/, "");
  return cwd === r || cwd.startsWith(r + "/");
}

export interface TermEnv { tmuxPane?: string; ssWorkspace?: string; ssTerminal?: string }
/** `ps eww -o command=` output → the terminal ids the process inherited. */
export function parseEnv(out: string): TermEnv {
  const e: TermEnv = {};
  const get = (k: string) => new RegExp(`(?:^|\\s)${k}=(\\S+)`).exec(out)?.[1];
  const pane = get("TMUX_PANE"); if (pane && /^%\d+$/.test(pane)) e.tmuxPane = pane;
  const ws = get("SUPERSET_WORKSPACE_ID"), t = get("SUPERSET_TERMINAL_ID");
  if (ws && t && /^[0-9a-f-]{36}$/i.test(ws) && /^[0-9a-f-]{36}$/i.test(t)) { e.ssWorkspace = ws; e.ssTerminal = t; }
  return e;
}

/** `ps -axo pid=,ppid=,comm=` → pid → { ppid, comm }. */
export function parseProcTable(out: string): Map<number, { ppid: number; comm: string }> {
  const m = new Map<number, { ppid: number; comm: string }>();
  for (const line of String(out).split("\n")) {
    const x = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (x) m.set(+x[1], { ppid: +x[2], comm: x[3].trim() });
  }
  return m;
}
const AGENT_RE = /(^|\/)(claude|codex)$/i;
/** The process IS an agent (Claude Code / Codex). */
export const isAgentProc = (pid: number, procs: Map<number, { ppid: number; comm: string }>, agentPids: Set<number> = new Set()) =>
  agentPids.has(pid) || AGENT_RE.test(procs.get(pid)?.comm ?? "");
/** Is the process started by an agent (Claude / Codex)? Then ctrl+c in "its" terminal would hit the agent, not the server. */
export function agentAncestor(pid: number, procs: Map<number, { ppid: number; comm: string }>, agentPids: Set<number> = new Set()): boolean {
  let p = procs.get(pid)?.ppid ?? 0;
  for (let i = 0; i < 40 && p > 1; i++) {
    const x = procs.get(p); if (!x) return false;
    if (agentPids.has(p) || AGENT_RE.test(x.comm)) return true;
    p = x.ppid;
  }
  return false;
}

/** `ps -o pid=,etime=,command= -p …` → pid → { etime, command } */
export function parsePsInfo(out: string): Map<number, { etime: string; command: string }> {
  const m = new Map<number, { etime: string; command: string }>();
  for (const line of String(out).split("\n")) {
    const x = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (x) m.set(+x[1], { etime: x[2], command: x[3].trim().slice(0, CMD_MAX) });
  }
  return m;
}
/** ps etime "[[dd-]hh:]mm:ss" → seconds. */
export function etimeSeconds(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim()); if (!m) return null;
  return ((+(m[1] ?? 0) * 24 + +(m[2] ?? 0)) * 60 + +m[3]) * 60 + +m[4];
}

// ── scan (reads the real Mac) ────────────────────────────────────

export interface PortProc {
  pid: number; port: number; ports: number[]; name: string; command: string; cwd: string;
  uptime: number | null; localOnly: boolean; terminal: ReplyChannel | null; agent: boolean;
}

const run = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: "utf-8", timeout: 4000, maxBuffer: 8 * 1024 * 1024 }); } catch (e: any) { return String(e?.stdout ?? ""); } };
let scanCache: { at: number; list: PortProc[] } = { at: 0, list: [] };

async function tmuxLabel(pane: string): Promise<string> {
  try { return (await new Tmux().run("display-message", "-p", "-t", pane, "#S:#W")).trim() || `tmux ${pane}`; } catch { return `tmux ${pane}`; }
}
function ssLabel(terminalId: string): string {
  for (const w of supersetSnapshot()?.workspaces ?? []) for (const t of w.terminals ?? []) if (t.id === terminalId && t.title) return String(t.title).replace(/^[◐◑◒◓●○◌⠀-⣿✳✻·*\s]+/, "");
  return "Superset";
}

/** Every listening TCP process of this user (minus maw itself) with cwd, command and owning terminal. Cached 3 s. */
export async function scanPorts(fresh = false): Promise<PortProc[]> {
  if (!fresh && Date.now() - scanCache.at < CACHE_MS) return scanCache.list;
  const uid = process.getuid?.() ?? -1;
  const ls = parseLsofListen(run(LSOF, ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcuRn"]))
    .filter(l => l.uid === uid && l.pid !== process.pid && l.pid !== process.ppid);
  if (!ls.length) { scanCache = { at: Date.now(), list: [] }; return []; }
  const pids = ls.map(l => l.pid).join(",");
  const cwd = parseLsofCwd(run(LSOF, ["-a", "-p", pids, "-d", "cwd", "-Fpn"]));
  const info = parsePsInfo(run(PS, ["-o", "pid=,etime=,command=", "-p", pids]));
  const procs = parseProcTable(run(PS, ["-axo", "pid=,ppid=,comm="]));
  const envs = new Map<number, string>();
  for (const line of run(PS, ["eww", "-o", "pid=,command=", "-p", pids]).split("\n")) { const m = /^\s*(\d+)\s(.*)$/.exec(line); if (m) envs.set(+m[1], m[2]); }
  const agentPids = new Set([...readLiveRooms().values()].map(r => r.pid));
  const list: PortProc[] = [];
  for (const l of ls) {
    if (isAgentProc(l.pid, procs, agentPids)) continue; // Claude/Codex's own sockets (IDE/MCP) aren't dev servers — and killing them kills the agent
    const env = parseEnv(envs.get(l.pid) ?? "");
    const terminal: ReplyChannel | null = env.tmuxPane ? { kind: "tmux", pane: env.tmuxPane, label: await tmuxLabel(env.tmuxPane) }
      : env.ssWorkspace ? { kind: "superset", workspaceId: env.ssWorkspace, terminalId: env.ssTerminal!, label: ssLabel(env.ssTerminal!) } : null;
    const i = info.get(l.pid);
    list.push({
      pid: l.pid, port: l.ports[0], ports: l.ports, name: l.name, command: i?.command ?? l.name, cwd: cwd.get(l.pid) ?? "",
      uptime: i ? etimeSeconds(i.etime) : null, localOnly: loopbackOnly(l.addrs), terminal,
      agent: agentAncestor(l.pid, procs, agentPids),
    });
  }
  list.sort((a, b) => a.port - b.port);
  scanCache = { at: Date.now(), list };
  return list;
}

const realRoot = (p: string) => { try { return realpathSync(p); } catch { return p; } };
/** `tailscale serve status --json` → local port → HTTPS port that proxies to it (8443 → 5710). */
export function servedHttps(json: string): Map<number, number> {
  const out = new Map<number, number>();
  let d: any; try { d = JSON.parse(json); } catch { return out; }
  for (const [hostPort, v] of Object.entries<any>(d?.Web ?? {})) {
    const https = Number(String(hostPort).split(":").pop());
    for (const h of Object.values<any>(v?.Handlers ?? {})) {
      const m = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/.exec(String(h?.Proxy ?? ""));
      if (m && https && !out.has(+m[1])) out.set(+m[1], https);
    }
  }
  return out;
}
const TAILSCALE = ["/Applications/Tailscale.app/Contents/MacOS/tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"].find(f => existsSync(f));
let serveCache = { at: 0, map: new Map<number, number>() };
function servedMap(): Map<number, number> {
  if (Date.now() - serveCache.at < 30_000 || !TAILSCALE) return serveCache.map;
  // TERM is required: without it the macOS app binary tries to start its GUI instead of acting as the CLI
  let out = ""; try { out = execFileSync(TAILSCALE, ["serve", "status", "--json"], { encoding: "utf-8", timeout: 4_000, env: { ...process.env, TERM: process.env.TERM || "xterm-256color" } }); } catch { /* not serving */ }
  serveCache = { at: Date.now(), map: servedHttps(out) };
  return serveCache.map;
}
// the phone opens a port through Tailscale: the HTTPS one `tailscale serve` maps to it, else plain http
const withLink = (x: PortProc) => { const https = servedMap().get(x.port); return { ...x, httpsPort: https ?? null }; };

async function portsOf(ws: string, fresh = false): Promise<{ root: string | null; list: PortProc[] }> {
  const p = workspacePath(ws); if (!p) return { root: null, list: [] };
  const root = realRoot(p);
  return { root, list: (await scanPorts(fresh)).filter(x => insidePath(x.cwd, root)) };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitGone(pid: number, ms: number): Promise<boolean> {
  for (let t = 0; t < ms; t += 150) { if (!alive(pid)) return true; await sleep(150); }
  return !alive(pid);
}
const portFree = (ports: number[]) => !ports.some(port => run(LSOF, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).trim());

// ── routes ───────────────────────────────────────────────────────

const RE_WS = /^([0-9a-f-]{36}|dir:[A-Za-z0-9_-]+)$/i;
const fail = (set: any, code: number, error: string) => { set.status = code; return { ok: false, error }; };

export function mount(app: any): void {
  app.get("/workspaces/:ws/ports", async ({ params, set }: any) => {
    if (!RE_WS.test(params.ws)) return fail(set, 400, "workspace ไม่ถูกต้อง");
    const { root, list } = await portsOf(params.ws);
    if (!root) return { ok: true, path: null, ports: [] };
    return { ok: true, path: root, ports: list.map(withLink) };
  });

  // every port of this user in a folder under $HOME (not $HOME itself = desktop apps), grouped by folder
  app.get("/ports", async () => {
    const home = realRoot(homedir()), groups = new Map<string, PortProc[]>();
    for (const x of await scanPorts()) if (x.cwd !== home && insidePath(x.cwd, home)) groups.set(x.cwd, [...(groups.get(x.cwd) ?? []), x]);
    return { ok: true, groups: [...groups].map(([cwd, ports]) => ({ cwd, ports })) };
  });

  app.post("/workspaces/:ws/ports/:pid/stop", async ({ params, body, set }: any) => {
    if (!RE_WS.test(params.ws)) return fail(set, 400, "workspace ไม่ถูกต้อง");
    const pid = +params.pid;
    const x = (await portsOf(params.ws, true)).list.find(p => p.pid === pid);
    if (!x) return fail(set, 409, "โปรเซสนี้ไม่ได้เปิดพอร์ตในโปรเจคนี้แล้ว — รีเฟรชดูใหม่");
    const force = !!body?.force;
    try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); } catch (e: any) { if (e?.code !== "ESRCH") return fail(set, 500, "หยุดไม่ได้: " + (e?.message ?? e)); }
    const stopped = await waitGone(pid, 3_000);
    scanCache.at = 0;
    return { ok: true, stopped, portFree: portFree(x.ports), ports: x.ports };
  });

  app.post("/workspaces/:ws/ports/:pid/restart", async ({ params, set }: any) => {
    if (!RE_WS.test(params.ws)) return fail(set, 400, "workspace ไม่ถูกต้อง");
    const pid = +params.pid;
    const x = (await portsOf(params.ws, true)).list.find(p => p.pid === pid);
    if (!x) return fail(set, 409, "โปรเซสนี้ไม่ได้เปิดพอร์ตในโปรเจคนี้แล้ว — รีเฟรชดูใหม่");
    if (!x.terminal) return fail(set, 409, "หา terminal ที่รันอยู่ไม่เจอ — หยุดได้อย่างเดียว");
    if (x.agent) return fail(set, 409, "agent เป็นคนรันพอร์ตนี้ — กด ctrl+c จะไปหยุด agent แทน · หยุดได้อย่างเดียว");
    await pressKey(x.terminal, "ctrlc");
    if (!(await waitGone(pid, 3_000))) { scanCache.at = 0; return fail(set, 409, "กด ctrl+c แล้วแต่โปรเซสยังไม่หยุด — ลอง \"หยุด\" แทน"); }
    await sleep(1_200); // let the shell print its prompt back
    await pressKey(x.terminal, "up");
    await sleep(300);
    await pressKey(x.terminal, "enter");
    scanCache.at = 0;
    return { ok: true, terminal: x.terminal.label };
  });
}
