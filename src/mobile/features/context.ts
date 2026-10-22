// Feature pack "context" (P5, PLAN-maw-mobile.md §9):
//  1. "@file" mentions — GET /rooms/:ws/:room/files?q=  → files/folders in the room's folder, ranked
//  2. read-only settings viewer — GET /settings/agents  → Claude/Codex plugins · MCP · hooks (names/types only)
// Secrets rule: config files hold API keys in env/headers/args. Nothing but names, types, command basenames,
// versions and redacted+shortened hook commands may leave this module.
import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { workspacePath } from "./ctx";

// ── redaction ──────────────────────────────────────────────────────────────
const MASK = "***";

/** Strip anything secret-looking from a string meant for display. Order matters: URLs → headers → env → tokens. */
export function redact(input: unknown): string {
  let s = String(input ?? "");
  // URLs: drop userinfo, query string and fragment
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@'"]+@)?([^\s?#'"]*)(\?[^\s#'"]*)?(#[^\s'"]*)?/gi,
    (_m, scheme, user, rest, q, frag) => scheme + (user ? MASK + "@" : "") + rest + (q ? "?" + MASK : "") + (frag ? "#" + MASK : ""));
  // Authorization: Bearer/Basic/Token …
  s = s.replace(/\b(Bearer|Basic|Token)\s+[^\s'"]+/gi, (_m, k) => `${k} ${MASK}`);
  // header / flag style secrets: "x-api-key: v", "--token v", "password: v"
  s = s.replace(/\b([\w-]*(?:api[-_]?key|authorization|token|secret|password|passwd|cookie)[\w-]*)(\s*:\s*)(?!\*\*\*$)[^\s'"]+(?:\s+\*\*\*)?/gi,
    (_m, k, sep) => `${k}${sep}${MASK}`);
  s = s.replace(/(^|\s)(--?[\w-]*(?:key|token|secret|password|passwd|auth)[\w-]*)\s+(?!-)("[^"]*"|'[^']*'|\S+)/gi, (_m, pre, k) => `${pre}${k} ${MASK}`);
  // env-like assignments KEY=value / --flag=value / KEY="value with spaces"
  s = s.replace(/([A-Za-z_][\w.-]*)=("[^"]*"|'[^']*'|[^\s'"]+)/g, (_m, k) => `${k}=${MASK}`);
  // well-known token prefixes
  s = s.replace(/\b(?:sk-(?:ant-)?[\w-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[\w]{10,}|xox[abprs]-[\w-]{8,}|AKIA[0-9A-Z]{12,}|AIza[\w-]{20,}|eyJ[\w-]{10,}\.[\w-]+\.[\w-]*)/g, MASK);
  // long hex/base64 runs (≥24) — must mix letters and digits so ordinary long words/paths survive
  s = s.replace(/[A-Za-z0-9+_=-]{24,}/g, m => (/\d/.test(m) && /[A-Za-z]/.test(m)) || /^[0-9a-f]{24,}$/i.test(m) ? MASK : m);
  return s;
}

/** Redact, collapse $HOME to ~, squash whitespace and clip — for showing a hook command on a phone. */
export function shortenCommand(cmd: unknown, home = homedir(), max = 96): string {
  let s = String(cmd ?? "");
  if (home) s = s.split(home).join("~");
  s = redact(s).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** The script a hook runs (notify.sh, guard.py …) or its program name — a short label for the phone. */
export function hookScript(cmd: unknown): string | undefined {
  const s = String(cmd ?? "");
  const m = s.match(/[^\s"'=;&|()]+\.(?:sh|bash|zsh|js|mjs|cjs|ts|py|rb|pl)\b/);
  if (m) return redact(basename(m[0])).slice(0, 40);
  return /^[\w./~-]+(\s|$)/.test(s.trim()) ? commandBase(s) : undefined;
}

/** Only the program name of an MCP/stdio command — never its args or path. */
export function commandBase(cmd: unknown): string | undefined {
  if (typeof cmd !== "string" || !cmd.trim()) return undefined;
  const first = cmd.trim().split(/\s+/)[0];
  return redact(basename(first)).slice(0, 40) || undefined;
}

// ── settings readers (pure: take parsed objects) ───────────────────────────
export type McpType = "stdio" | "http" | "sse";
export type McpScope = "user" | "project" | "local";
export interface McpEntry { name: string; scope?: McpScope; type: McpType; command?: string; project?: string }
export interface PluginEntry { name: string; marketplace?: string; version?: string; enabled: boolean }
export interface HookEntry { event: string; matcher: string; command: string; script?: string }

export function mcpType(def: any): McpType {
  const t = String(def?.type ?? def?.transport ?? "").toLowerCase();
  if (t === "sse") return "sse";
  if (t === "http" || t === "streamable-http" || t === "streamable_http") return "http";
  if (t === "stdio") return "stdio";
  return def?.url ? "http" : "stdio";
}

const safeName = (n: string) => redact(n).slice(0, 80);

export function mcpList(servers: any, scope?: McpScope, project?: string): McpEntry[] {
  if (!servers || typeof servers !== "object") return [];
  return Object.entries(servers).map(([name, def]: [string, any]) => {
    const type = mcpType(def);
    const e: McpEntry = { name: safeName(name), type };
    if (scope) e.scope = scope;
    if (project) e.project = safeName(project);
    if (type === "stdio") { const c = commandBase(def?.command); if (c) e.command = c; }
    return e;
  });
}

export function pluginList(settings: any, installed: any): PluginEntry[] {
  const enabled: Record<string, unknown> = settings?.enabledPlugins && typeof settings.enabledPlugins === "object" ? settings.enabledPlugins : {};
  const inst: Record<string, any> = installed?.plugins && typeof installed.plugins === "object" ? installed.plugins : {};
  const keys = [...new Set([...Object.keys(enabled), ...Object.keys(inst)])];
  return keys.map(key => {
    const at = key.lastIndexOf("@");
    const rec = inst[key], first = Array.isArray(rec) ? rec[0] : rec;
    const e: PluginEntry = { name: safeName(at > 0 ? key.slice(0, at) : key), enabled: enabled[key] === true };
    if (at > 0) e.marketplace = safeName(key.slice(at + 1));
    if (first?.version != null) e.version = redact(String(first.version)).slice(0, 24);
    return e;
  }).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
}

export function hookList(settings: any, home = homedir()): HookEntry[] {
  const hooks = settings?.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const out: HookEntry[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray((g as any)?.hooks) ? (g as any).hooks : []) {
        const cmd = h?.type === "command" || h?.command ? h.command : `[${h?.type ?? "?"}]`;
        const e: HookEntry = { event: safeName(event), matcher: redact((g as any)?.matcher ?? "").slice(0, 60), command: shortenCommand(cmd, home) };
        const sc = hookScript(cmd); if (sc) e.script = sc;
        out.push(e);
      }
    }
  }
  return out;
}

/** ~/.claude.json: user-scope servers + per-project ("local") servers; `only` limits to one project folder. */
export function claudeJsonMcp(cj: any, only?: string | null): McpEntry[] {
  const out = mcpList(cj?.mcpServers, "user");
  const projects = cj?.projects && typeof cj.projects === "object" ? cj.projects : {};
  for (const [path, p] of Object.entries(projects)) {
    if (only && path !== only) continue;
    out.push(...mcpList((p as any)?.mcpServers, "local", basename(path)));
  }
  return out;
}

export function codexSettings(toml: any): { mcp: McpEntry[]; model?: string } {
  const r: { mcp: McpEntry[]; model?: string } = { mcp: mcpList(toml?.mcp_servers) };
  if (typeof toml?.model === "string") r.model = redact(toml.model).slice(0, 60);
  return r;
}

// ── settings IO ────────────────────────────────────────────────────────────
function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}
function readToml(path: string): any {
  try { return (globalThis as any).Bun.TOML.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

export function readAgentSettings(home = homedir(), folder?: string | null) {
  const settings = readJson(join(home, ".claude/settings.json")) ?? {};
  const installed = readJson(join(home, ".claude/plugins/installed_plugins.json"));
  const cj = readJson(join(home, ".claude.json"));
  const mcp = claudeJsonMcp(cj, folder);
  // project-scope .mcp.json: the given folder, or every project Claude knows about (bounded)
  const dirs = folder ? [folder] : Object.keys(cj?.projects ?? {}).slice(0, 80);
  for (const d of dirs) {
    const f = join(d, ".mcp.json");
    if (existsSync(f)) mcp.push(...mcpList(readJson(f)?.mcpServers, "project", basename(d)));
  }
  const claude: any = { plugins: pluginList(settings, installed), mcp, hooks: hookList(settings, home), statusLine: !!settings.statusLine };
  if (typeof settings.model === "string") claude.model = redact(settings.model).slice(0, 60);
  const codex = codexSettings(readToml(join(home, ".codex/config.toml")));
  return { claude, codex };
}

// ── @file mentions ─────────────────────────────────────────────────────────
export interface FileHit { path: string; dir?: boolean }
const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", ".next", ".nuxt", "out", "target", ".turbo", ".cache", "coverage", "__pycache__", ".venv", "venv", ".dart_tool", ".gradle", "Pods", "DerivedData", ".idea"]);
const MAX_FILES = 40_000;

/** Every ancestor folder of the listed files, as "a", "a/b", … */
export function dirsOf(files: string[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
  }
  return [...set];
}

/** Bounded walk for non-git folders. */
export function walkFiles(root: string, maxDepth = 8, max = 20_000): string[] {
  const out: string[] = [];
  const go = (dir: string, rel: string, depth: number) => {
    if (depth > maxDepth || out.length >= max) return;
    let ents: import("fs").Dirent[];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= max) return;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) go(join(dir, e.name), r, depth + 1); }
      else if (e.isFile() || e.isSymbolicLink()) out.push(r);
    }
  };
  go(root, "", 0);
  return out;
}

function gitFiles(root: string): string[] | null {
  try {
    const run = (...a: string[]) => execFileSync("git", ["-C", root, "ls-files", "-z", ...a], { encoding: "utf-8", timeout: 5_000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
    return [...new Set([...run(), ...run("--others", "--exclude-standard")])].slice(0, MAX_FILES);
  } catch { return null; }
}

const fileCache = new Map<string, { at: number; files: string[]; dirs: string[] }>();
export function candidates(root: string, ttl = 20_000) {
  const hit = fileCache.get(root);
  if (hit && Date.now() - hit.at < ttl) return hit;
  const files = gitFiles(root) ?? walkFiles(root);
  const v = { at: Date.now(), files, dirs: dirsOf(files) };
  fileCache.set(root, v);
  if (fileCache.size > 32) fileCache.delete(fileCache.keys().next().value!);
  return v;
}

/** basename prefix > basename contains > path contains; then shorter paths, then a–z. */
export function rankFiles(files: string[], dirs: string[], q: string, limit = 30): FileHit[] {
  const needle = q.trim().toLowerCase().replace(/^\.\//, "");
  const scored: [number, FileHit][] = [];
  const add = (path: string, dir: boolean) => {
    const p = path.toLowerCase(), b = p.slice(p.lastIndexOf("/") + 1);
    let s: number;
    if (!needle) s = 0;
    else if (needle.includes("/")) s = p.startsWith(needle) ? 0 : p.includes(needle) ? 2 : -1;
    else s = b.startsWith(needle) ? 0 : b.includes(needle) ? 1 : p.includes(needle) ? 2 : -1;
    if (s >= 0) scored.push([s, dir ? { path, dir: true } : { path }]);
  };
  for (const f of files) add(f, false);
  for (const d of dirs) add(d, true);
  scored.sort((a, b) => a[0] - b[0] || a[1].path.length - b[1].path.length || a[1].path.localeCompare(b[1].path));
  return scored.slice(0, limit).map(x => x[1]);
}

/** Folder a room works in: Superset workspace path, or the tmux pane's current folder. */
export function roomFolder(ws: string, room: string): string | null {
  if (ws === "tmux") {
    if (!/^%\d+$/.test(room)) return null;
    try { return execFileSync("tmux", ["display", "-p", "-t", room, "#{pane_current_path}"], { encoding: "utf-8", timeout: 3_000 }).trim() || null; } catch { return null; }
  }
  return workspacePath(ws);
}

export function mount(app: any): void {
  app.get("/rooms/:ws/:room/files", ({ params, query, set }: any) => {
    const root = roomFolder(String(params.ws), String(params.room));
    if (!root || !existsSync(root)) { set.status = 404; return { ok: false, error: "ไม่พบโฟลเดอร์ของห้องนี้" }; }
    const { files, dirs } = candidates(root);
    return { ok: true, files: rankFiles(files, dirs, String(query?.q ?? "").slice(0, 200)) };
  });
  app.get("/settings/agents", () => ({ ok: true, ...readAgentSettings() }));
}
