// Herdr autostart: saved rooms in the local default session. POST only changes configuration.
import { execFile } from "child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { allowedDir } from "../api";
import { ensure, LABEL_RE, load, readInventory, sanitize, type AutoRoom, type Herdr, type EnsureResult } from "./herdr-autostart-core";

export * from "./herdr-autostart-core";

const FILE = join(homedir(), ".maw", "herdr-autostart.json");
const HERDR = existsSync("/opt/homebrew/bin/herdr") ? "/opt/homebrew/bin/herdr" : "herdr";

/** Native argv only. Validation also applies when called outside the HTTP handler. */
export function commandFor(room: AutoRoom): string[] {
  const valid = sanitize(room, p => p);
  if (!valid) throw new Error("การตั้งค่า Herdr ไม่ถูกต้อง");
  return [
    ...(valid.resumeArgs ?? (valid.agentKind === "codex" ? ["resume", "--last"] : ["--continue"])),
    ...(valid.model ? ["--model", valid.model] : []),
  ];
}

function launchPath(): string {
  let bins: string[] = [];
  try { bins = readdirSync(join(homedir(), ".nvm/versions/node")).map(v => join(homedir(), ".nvm/versions/node", v, "bin")); } catch { /* optional installation */ }
  return [...bins, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", process.env.PATH ?? ""].join(":");
}

export const realHerdr: Herdr = (args, timeoutMs = 10_000) => new Promise((resolve, reject) => {
  execFile(HERDR, args, {
    encoding: "utf-8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PATH: launchPath() },
  }, (error, stdout) => error ? reject(new Error("เรียก Herdr ไม่สำเร็จ")) : resolve(stdout));
});

/** A failed write cannot truncate the previous configuration. */
function save(rooms: AutoRoom[], file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(rooms, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed, or never written */ }
  }
}

type Schedule = (callback: () => void, delay: number) => unknown;
export interface MountOptions {
  file?: string;
  herdr?: Herdr;
  allow?: typeof allowedDir;
  schedule?: Schedule;
  nodeEnv?: string;
  /** Test seam: exercise boot callbacks without reading the user's configuration. */
  readConfig?: () => AutoRoom[];
}

export function mount(app: any, opts: MountOptions = {}): void {
  const file = opts.file ?? FILE, herdr = opts.herdr ?? realHerdr, allow = opts.allow ?? allowedDir;
  const readConfig = opts.readConfig ?? (() => load(file, allow));
  let lastEnsure: (Omit<EnsureResult, "errors"> & { errors: { label: string | null; reason: string }[] }) | null = null;
  // Herdr must already be running. This feature never starts or attaches its server.
  if (opts.file === undefined && (opts.nodeEnv ?? process.env.NODE_ENV) !== "test") {
    const schedule = opts.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); timer.unref?.(); return timer; });
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try { lastEnsure = await ensure(readConfig(), herdr, commandFor); }
      catch { lastEnsure = { started: [], skipped: [], errors: [{ label: null, reason: "config_unavailable_or_invalid" }] }; }
      finally { checking = false; }
    };
    schedule(() => { void check(); }, 5_000);
    schedule(() => { void check(); }, 60_000);
  }

  app.get("/herdr/autostart", async ({ set = {} }: any = {}) => {
    let rooms: AutoRoom[];
    try { rooms = readConfig(); }
    catch { set.status = 500; return { ok: false, available: false, lastEnsure, error: "อ่านการตั้งค่า Herdr ไม่สำเร็จ" }; }
    try {
      const { workspaces, agents } = await readInventory(herdr);
      const listed = new Set(rooms.map(r => r.label));
      return {
        ok: true, available: true, lastEnsure,
        rooms: rooms.map(room => {
          const matching = workspaces.filter(w => w.label === room.label);
          const present = matching.length === 1 ? agents.filter(a => a.workspace_id === matching[0].workspace_id) : [];
          return { ...room, running: present.length === 1 && present[0].name === room.label && present[0].agent === room.agentKind && present[0].cwd === room.cwd && !present[0].launch_pending };
        }),
        live: workspaces.filter(w => !listed.has(w.label ?? "")).map(w => ({ workspaceId: w.workspace_id, label: w.label ?? null })),
      };
    } catch {
      set.status = 503;
      return { ok: false, available: false, lastEnsure, rooms: rooms.map(r => ({ ...r, running: null })), error: "Herdr ไม่พร้อมหรืออ่านสถานะไม่ได้" };
    }
  });

  app.post("/herdr/autostart", ({ body, set }: any) => {
    const label = body?.label;
    if (typeof label !== "string" || !LABEL_RE.test(label) || (body?.on !== undefined && typeof body.on !== "boolean")) {
      set.status = 400; return { ok: false, error: "ชื่อห้องหรือสถานะเปิดปิดไม่ถูกต้อง" };
    }
    let rooms: AutoRoom[];
    try { rooms = readConfig(); }
    catch { set.status = 500; return { ok: false, error: "อ่านการตั้งค่า Herdr ไม่สำเร็จ จึงไม่เขียนทับ" }; }
    const rest = rooms.filter(r => r.label !== label);
    if (body.on !== false) {
      const room = sanitize({ ...rooms.find(r => r.label === label), ...body, label }, allow);
      if (!room) { set.status = 400; return { ok: false, error: "โฟลเดอร์ ชนิด agent หรือคำสั่ง resume ไม่ถูกต้อง" }; }
      rest.push(room);
    }
    try { save(rest, file); }
    catch { set.status = 500; return { ok: false, error: "บันทึกการตั้งค่า Herdr ไม่สำเร็จ" }; }
    return { ok: true, rooms: rest };
  });
}
