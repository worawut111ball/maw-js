import { readFileSync } from "fs";

export interface AutoRoom {
  label: string;
  cwd: string;
  agentKind: "codex" | "claude";
  model?: string;
  resumeArgs?: string[];
}
export type Herdr = (args: string[], timeoutMs?: number) => Promise<string>;
export type AllowDir = (path: string) => string | null;
export const LABEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/;

export function sanitize(x: any, allow: AllowDir): AutoRoom | null {
  if (!x || typeof x !== "object" || Array.isArray(x) || typeof x.label !== "string" || !LABEL_RE.test(x.label)) return null;
  if (typeof x.cwd !== "string" || !["codex", "claude"].includes(x.agentKind)) return null;
  const cwd = allow(x.cwd);
  if (typeof cwd !== "string" || !cwd.startsWith("/") || /[\x00\r\n]/.test(cwd)) return null;
  const room: AutoRoom = { label: x.label, cwd, agentKind: x.agentKind };
  if (x.model !== undefined) {
    if (typeof x.model !== "string" || !MODEL_RE.test(x.model)) return null;
    room.model = x.model;
  }
  if (x.resumeArgs !== undefined) {
    const a = x.resumeArgs;
    if (!Array.isArray(a) || !a.every(v => typeof v === "string")) return null;
    const valid = x.agentKind === "codex"
      ? a.length === 2 && a[0] === "resume" && (a[1] === "--last" || UUID_RE.test(a[1]))
      : (a.length === 1 && a[0] === "--continue") || (a.length === 2 && a[0] === "--resume" && UUID_RE.test(a[1]));
    if (!valid) return null;
    room.resumeArgs = [...a];
  }
  return room;
}

/** Corrupt configuration must never become an empty list that POST silently overwrites. */
export function load(file: string, allow: AllowDir): AutoRoom[] {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return []; throw new Error("config_unavailable"); }
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error("config_invalid"); }
  if (!Array.isArray(data)) throw new Error("config_invalid");
  const seen = new Set<string>();
  return data.map(x => {
    const r = sanitize(x, allow);
    if (!r || seen.has(r.label)) throw new Error("config_invalid");
    seen.add(r.label);
    return r;
  });
}

export interface Workspace { workspace_id: string; label: string; pane_count: number }
export interface Agent { workspace_id: string; pane_id: string; name?: string | null; agent?: string | null; cwd?: string | null; launch_pending?: boolean }
export interface Inventory { workspaces: Workspace[]; agents: Agent[] }
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9:_-]+$/.test(v);
const object = (v: any): boolean => !!v && typeof v === "object" && !Array.isArray(v);
const uint = (v: any): boolean => Number.isSafeInteger(v) && v >= 0;
const nullableString = (v: any): boolean => v === undefined || v === null || typeof v === "string";
const status = (v: any): boolean => ["unknown", "idle", "working", "blocked", "done"].includes(v);
// Validate fields used for identity/occupancy, including required protocol-22 fields.
function validWorkspace(v: any): boolean {
  return object(v) && id(v.workspace_id) && typeof v.label === "string" && uint(v.number)
    && uint(v.pane_count) && uint(v.tab_count) && id(v.active_tab_id)
    && typeof v.focused === "boolean" && status(v.agent_status);
}
function validTab(v: any): boolean {
  return object(v) && id(v.tab_id) && id(v.workspace_id) && uint(v.number)
    && typeof v.label === "string" && typeof v.focused === "boolean" && uint(v.pane_count) && status(v.agent_status);
}
function validPane(v: any): boolean {
  return object(v) && id(v.workspace_id) && id(v.pane_id) && id(v.tab_id) && id(v.terminal_id)
    && typeof v.focused === "boolean" && uint(v.revision) && status(v.agent_status)
    && [v.cwd, v.foreground_cwd, v.agent, v.restore_error].every(nullableString);
}
function validAgent(v: any): boolean {
  return validPane(v) && nullableString(v.name)
    && (v.launch_pending === undefined || typeof v.launch_pending === "boolean");
}

async function call(herdr: Herdr, args: string[], timeout = 10_000): Promise<any> {
  const raw = await herdr(["--session", "default", ...args], timeout);
  let d: any;
  try { d = JSON.parse(raw); } catch { throw new Error("invalid_response"); }
  const expected = ({
    "workspace list": "workspace_list", "workspace create": "workspace_created",
    "agent list": "agent_list", "agent start": "agent_started",
    "pane list": "pane_list", "pane process-info": "pane_process_info",
  } as Record<string, string>)[`${args[0]} ${args[1]}`];
  if (!object(d) || typeof d.id !== "string" || d.error !== undefined || !object(d.result) || d.result.type !== expected) throw new Error("invalid_response");
  return d.result;
}

export async function readInventory(herdr: Herdr): Promise<Inventory> {
  const w = await call(herdr, ["workspace", "list"]);
  const a = await call(herdr, ["agent", "list"]);
  if (!Array.isArray(w.workspaces) || !Array.isArray(a.agents)) throw new Error("invalid_inventory");
  if (!w.workspaces.every(validWorkspace) || !a.agents.every(validAgent)) throw new Error("invalid_inventory");
  if (new Set(w.workspaces.map((v: any) => v.workspace_id)).size !== w.workspaces.length || new Set(a.agents.map((v: any) => v.pane_id)).size !== a.agents.length) throw new Error("invalid_inventory");
  return { workspaces: w.workspaces, agents: a.agents };
}

export interface EnsureResult { started: string[]; skipped: { label: string; reason: string }[]; errors: { label: string; reason: string }[] }
type CommandFor = (room: AutoRoom) => string[];
// One reconciliation per transport at a time. Uncertain starts remain suppressed for this process.
const active = new WeakMap<Herdr, Promise<EnsureResult>>();
const uncertain = new WeakMap<Herdr, Set<string>>();

export function ensure(list: AutoRoom[], herdr: Herdr, commandFor: CommandFor): Promise<EnsureResult> {
  const current = active.get(herdr);
  if (current) return current;
  const task = reconcile(list, herdr, commandFor).finally(() => active.delete(herdr));
  active.set(herdr, task);
  return task;
}

async function reconcile(list: AutoRoom[], herdr: Herdr, commandFor: CommandFor): Promise<EnsureResult> {
  const result: EnsureResult = { started: [], skipped: [], errors: [] };
  const pending = uncertain.get(herdr) ?? new Set<string>();
  uncertain.set(herdr, pending);
  const duplicates = new Set(list.filter((r, i) => list.findIndex(other => other.label === r.label) !== i).map(r => r.label));
  const seen = new Set<string>();
  for (const r of list) {
    if (seen.has(r.label)) continue;
    seen.add(r.label);
    if (duplicates.has(r.label)) { result.skipped.push({ label: r.label, reason: "duplicate_config" }); continue; }
    try {
      if (!sanitize(r, path => path)) throw new Error("invalid_config");
      const agentArgs = commandFor(r);
      let createdPane: { pane_id: string; terminal_id: string } | undefined;
      let inv = await readInventory(herdr);
      let matches = inv.workspaces.filter(w => w.label === r.label);
      if (matches.length > 1) { result.skipped.push({ label: r.label, reason: "duplicate_label" }); continue; }
      const named = inv.agents.filter(a => a.name === r.label);
      if (named.length && (!matches.length || named.some(a => a.workspace_id !== matches[0].workspace_id))) {
        result.skipped.push({ label: r.label, reason: "agent_name_conflict" }); continue;
      }
      if (pending.has(r.label)) { result.skipped.push({ label: r.label, reason: "start_uncertain" }); continue; }
      if (!matches.length) {
        // A failed creation may already exist. Never issue another mutation in this pass.
        pending.add(r.label);
        const created = await call(herdr, ["workspace", "create", "--cwd", r.cwd, "--label", r.label, "--no-focus"]);
        if (!validWorkspace(created.workspace) || created.workspace.label !== r.label || !validPane(created.root_pane)
          || !validTab(created.tab) || created.root_pane.workspace_id !== created.workspace.workspace_id
          || created.tab.workspace_id !== created.workspace.workspace_id || created.root_pane.tab_id !== created.tab.tab_id
          || created.workspace.active_tab_id !== created.tab.tab_id || created.workspace.pane_count !== 1
          || created.workspace.tab_count !== 1 || created.tab.pane_count !== 1) throw new Error("invalid_creation");
        createdPane = created.root_pane;
        inv = await readInventory(herdr);
        matches = inv.workspaces.filter(w => w.label === r.label);
        if (matches.length !== 1 || matches[0].workspace_id !== created.workspace.workspace_id) throw new Error("workspace_changed");
        pending.delete(r.label);
      }
      const ws = matches[0];
      const agents = inv.agents.filter(a => a.workspace_id === ws.workspace_id);
      if (agents.length) {
        const running = agents.length === 1 && !agents[0].launch_pending && agents[0].name === r.label && agents[0].agent === r.agentKind && agents[0].cwd === r.cwd;
        result.skipped.push({ label: r.label, reason: running ? "running" : "occupied" }); continue;
      }
      if (ws.pane_count !== 1) { result.skipped.push({ label: r.label, reason: "ambiguous_panes" }); continue; }
      const p = await call(herdr, ["pane", "list", "--workspace", ws.workspace_id]);
      if (!Array.isArray(p.panes) || p.panes.length !== 1) throw new Error("invalid_panes");
      const pane = p.panes[0];
      if (createdPane && (pane?.pane_id !== createdPane.pane_id || pane?.terminal_id !== createdPane.terminal_id)) throw new Error("pane_changed");
      if (!validPane(pane) || pane.workspace_id !== ws.workspace_id || pane.cwd !== r.cwd || pane.agent || pane.restore_error) {
        result.skipped.push({ label: r.label, reason: "pane_not_available" }); continue;
      }
      // Recheck after pane lookup: another client may have claimed the name or workspace.
      const fresh = await readInventory(herdr);
      const freshMatches = fresh.workspaces.filter(w => w.label === r.label);
      if (freshMatches.length !== 1 || freshMatches[0].workspace_id !== ws.workspace_id
        || freshMatches[0].pane_count !== 1 || fresh.agents.some(a => a.workspace_id === ws.workspace_id || a.pane_id === pane.pane_id || a.name === r.label)) {
        result.skipped.push({ label: r.label, reason: "inventory_changed" }); continue;
      }
      const freshPanes = (await call(herdr, ["pane", "list", "--workspace", ws.workspace_id])).panes;
      const freshPane = Array.isArray(freshPanes) && freshPanes.length === 1 ? freshPanes[0] : null;
      if (!validPane(freshPane) || freshPane.pane_id !== pane.pane_id || freshPane.terminal_id !== pane.terminal_id
        || freshPane.workspace_id !== ws.workspace_id || freshPane.cwd !== r.cwd || freshPane.agent || freshPane.restore_error) {
        result.skipped.push({ label: r.label, reason: "pane_changed" }); continue;
      }
      const pi = (await call(herdr, ["pane", "process-info", "--pane", pane.pane_id])).process_info;
      if (!pi || pi.pane_id !== pane.pane_id || !Number.isInteger(pi.shell_pid) || pi.shell_pid <= 0 || pi.foreground_process_group_id !== pi.shell_pid || !Array.isArray(pi.foreground_processes) || pi.foreground_processes.length !== 1 || !object(pi.foreground_processes[0]) || pi.foreground_processes[0].pid !== pi.shell_pid || !["sh", "bash", "zsh", "fish", "dash", "ksh", "nu", "xonsh"].includes(pi.foreground_processes[0].name) || pi.foreground_processes[0].cwd !== r.cwd) {
        result.skipped.push({ label: r.label, reason: "shell_not_ready" }); continue;
      }
      // These observations cannot lock changes made by another desktop client before start.
      pending.add(r.label);
      try {
        const started = await call(herdr, ["agent", "start", r.label, "--kind", r.agentKind, "--pane", pane.pane_id, "--", ...agentArgs], 35_000);
        if (!validAgent(started.agent) || started.agent.pane_id !== pane.pane_id || started.agent.workspace_id !== ws.workspace_id || started.agent.terminal_id !== pane.terminal_id || started.agent.name !== r.label || started.agent.agent !== r.agentKind || !Array.isArray(started.argv) || !started.argv.every((v: any) => typeof v === "string")) throw new Error("invalid_start");
        pending.delete(r.label);
        result.started.push(r.label);
      } catch { result.errors.push({ label: r.label, reason: "start_uncertain" }); }
    } catch { result.errors.push({ label: r.label, reason: "herdr_unavailable_or_invalid" }); }
  }
  return result;
}
