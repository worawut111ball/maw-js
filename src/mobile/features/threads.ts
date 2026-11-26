// Phone UI feature "threads" (26 พ.ย. 69) — เธรดประจำโปรเจคแบบ Discord: คำสั่งที่ต้องรัน · deploy · รหัส · ไฟล์ · บันทึกงาน
// แยกจากห้อง agent (ห้องปิด/เปิดใหม่ได้ เธรดยังอยู่) · เก็บบน Mac เท่านั้น: ~/.maw/threads/<โปรเจค>.json + files/ (ไม่อยู่ใน repo)
// รหัส: ค่าจริงอยู่ใน Keychain ของ Mac (service "maw-thread", account "<โปรเจค>/<item id>") — ไฟล์ maw มีแค่ชื่อ ·
//   เขียนผ่าน `security -i` ทาง stdin (ค่าไม่โผล่ใน process list) · เก็บเป็น base64 · อ่านได้ทีละรายการผ่าน /reveal (ไม่ cache)
//   GET  /threads/summary                           → { projects: { [name]: { count, names[] } } }  (บรรทัดในลิ้นชัก)
//   GET  /threads?project=                          → { threads: [{ id, name, icon, count }] } (สร้างเธรดตั้งต้นครั้งแรก)
//   POST /threads                {project, name}    → เธรดใหม่
//   POST /threads/:tid/delete    {project}          → ลบเธรด (รหัสในเธรดถูกลบออกจาก Keychain ด้วย)
//   GET  /threads/:tid?project=                     → { thread, items } (รหัสไม่มีค่า)
//   POST /threads/:tid/items     {project, kind: note|cmd|secret, title, body?, code?, secret?}
//   POST /threads/:tid/items/:iid/update {project, pinned?, title?, body?, code?}
//   POST /threads/:tid/items/:iid/delete {project}
//   POST /threads/:tid/items/:iid/reveal {project}  → { value } (เฉพาะรหัส)
//   POST /threads/:tid/files?project=&name=  raw body → ไฟล์แนบ (≤ 200 MB)
//   GET  /threads/:tid/files/:iid?project=           → ดาวน์โหลด
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

export type ItemKind = "note" | "cmd" | "secret" | "file";
export interface ThreadItem { id: string; kind: ItemKind; title: string; body?: string; code?: string; pinned?: boolean; at: number; file?: { name: string; size: number } }
export interface Thread { id: string; name: string; icon: string; items: ThreadItem[] }
interface Store { threads: Thread[] }

const DEFAULTS: [string, string][] = [["คำสั่งรัน", "#"], ["deploy", "#"], ["รหัส", "🔒"], ["ไฟล์", "#"], ["บันทึกงาน", "#"]];
const ID_RE = /^[a-z0-9]{6,24}$/;
const FILE_MAX = 200 * 1024 * 1024;
export const KEYCHAIN_SERVICE = "maw-thread";

export interface ThreadDeps {
  root: string;
  keychain: { set(account: string, value: string): void; get(account: string): string | null; del(account: string): void };
}
const macKeychain: ThreadDeps["keychain"] = {
  set(account, value) {
    const hex = Buffer.from(Buffer.from(value, "utf8").toString("base64"), "utf8").toString("hex");
    const r = spawnSync("/usr/bin/security", ["-i"], { input: `add-generic-password -a ${account} -s ${KEYCHAIN_SERVICE} -X ${hex} -U\n`, encoding: "utf8", timeout: 10_000 });
    if (r.status !== 0 || /error|could not/i.test(r.stderr || "")) throw new Error("บันทึกลง Keychain ไม่สำเร็จ");
  },
  get(account) {
    try { return Buffer.from(execFileSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim(), "base64").toString("utf8"); }
    catch { return null; }
  },
  del(account) { try { execFileSync("/usr/bin/security", ["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE], { timeout: 10_000, stdio: "ignore" }); } catch { /* already gone */ } },
};
export const deps: ThreadDeps = { root: join(homedir(), ".maw", "threads"), keychain: macKeychain };

/** Project name → file-safe key (Thai kept) — the account name in Keychain uses it too. */
export const projectKey = (name: string) => String(name ?? "").normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+/, "").slice(0, 80);
const newId = () => randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12).padEnd(8, "0");
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);
const safeFile = (s: string) => String(s).normalize("NFC").replace(/[\/\\:\0]/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";

function pathOf(d: ThreadDeps, key: string) { return join(d.root, `${key}.json`); }
export function load(d: ThreadDeps, project: string): Store | null {
  const key = projectKey(project); if (!key) return null;
  try { return JSON.parse(readFileSync(pathOf(d, key), "utf8")); } catch { return null; }
}
function save(d: ThreadDeps, project: string, st: Store) {
  const key = projectKey(project), f = pathOf(d, key), tmp = f + ".tmp";
  mkdirSync(d.root, { recursive: true }); writeFileSync(tmp, JSON.stringify(st, null, 1)); renameSync(tmp, f);
}
/** First open of a project: the 5 default threads. */
export function ensure(d: ThreadDeps, project: string): Store {
  const st = load(d, project);
  if (st) return st;
  const fresh: Store = { threads: DEFAULTS.map(([name, icon]) => ({ id: newId(), name, icon, items: [] })) };
  save(d, project, fresh); return fresh;
}
const fileDir = (d: ThreadDeps, project: string) => join(d.root, "files", projectKey(project));
const filePath = (d: ThreadDeps, project: string, it: ThreadItem) => join(fileDir(d, project), `${it.id}-${safeFile(it.file!.name)}`);
const secretAccount = (project: string, id: string) => `${projectKey(project)}/${id}`;
const view = (t: Thread) => ({ id: t.id, name: t.name, icon: t.icon, count: t.items.length });
const sorted = (items: ThreadItem[]) => [...items].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.at - a.at);

export function mount(app: any, d: ThreadDeps = deps): void {
  const proj = (x: any) => { const p = String(x ?? "").trim(); return p && projectKey(p) ? p : null; };
  const bad = (set: any, error: string, status = 400) => { set.status = status; return { ok: false, error }; };
  const find = (project: string, tid: string) => { const st = load(d, project); return { st, t: st?.threads.find(x => x.id === tid) ?? null }; };

  app.get("/threads/summary", () => {
    const out: Record<string, { count: number; names: string[] }> = {};
    try {
      for (const f of require("fs").readdirSync(d.root) as string[]) {
        if (!f.endsWith(".json")) continue;
        try { const st: Store = JSON.parse(readFileSync(join(d.root, f), "utf8")); out[f.slice(0, -5)] = { count: st.threads.length, names: st.threads.slice(0, 4).map(t => t.name) }; } catch { /* skip broken */ }
      }
    } catch { /* no threads yet */ }
    return { ok: true, projects: out };
  });
  app.get("/threads", ({ query, set }: any) => {
    const p = proj(query?.project); if (!p) return bad(set, "ไม่มีชื่อโปรเจค");
    return { ok: true, key: projectKey(p), threads: ensure(d, p).threads.map(view) };
  });
  app.post("/threads", ({ body, set }: any) => {
    const p = proj(body?.project), name = clip(body?.name, 40).trim(); if (!p || !name) return bad(set, "ต้องมีโปรเจคและชื่อเธรด");
    const st = ensure(d, p); if (st.threads.length >= 40) return bad(set, "เธรดเต็ม (40)");
    const t: Thread = { id: newId(), name, icon: body?.secret ? "🔒" : "#", items: [] };
    st.threads.push(t); save(d, p, st); return { ok: true, thread: view(t) };
  });
  app.post("/threads/:tid/delete", ({ params, body, set }: any) => {
    const p = proj(body?.project); if (!p) return bad(set, "ไม่มีชื่อโปรเจค");
    const { st, t } = find(p, params.tid); if (!st || !t) return bad(set, "ไม่พบเธรด", 404);
    for (const it of t.items) { if (it.kind === "secret") d.keychain.del(secretAccount(p, it.id)); if (it.kind === "file") rmSync(filePath(d, p, it), { force: true }); }
    st.threads = st.threads.filter(x => x !== t); save(d, p, st); return { ok: true };
  });
  app.get("/threads/:tid", ({ params, query, set }: any) => {
    const p = proj(query?.project); if (!p) return bad(set, "ไม่มีชื่อโปรเจค");
    const { t } = find(p, params.tid); if (!t) return bad(set, "ไม่พบเธรด", 404);
    return { ok: true, thread: view(t), items: sorted(t.items) };
  });
  app.post("/threads/:tid/items", ({ params, body, set }: any) => {
    const p = proj(body?.project); if (!p) return bad(set, "ไม่มีชื่อโปรเจค");
    const { st, t } = find(p, params.tid); if (!st || !t) return bad(set, "ไม่พบเธรด", 404);
    const kind: ItemKind = ["note", "cmd", "secret"].includes(body?.kind) ? body.kind : "note";
    const title = clip(body?.title, 120).trim(); if (!title) return bad(set, "ต้องมีชื่อรายการ");
    if (t.items.length >= 500) return bad(set, "เธรดนี้เต็ม (500 รายการ)");
    const it: ThreadItem = { id: newId(), kind, title, at: Date.now() };
    if (body?.body) it.body = clip(body.body, 4000);
    if (kind === "cmd") { it.code = clip(body?.code, 8000); if (!it.code.trim()) return bad(set, "ต้องมีคำสั่ง"); }
    if (kind === "secret") {
      const v = String(body?.secret ?? ""); if (!v || v.length > 4000) return bad(set, "ต้องมีค่ารหัส (ไม่เกิน 4000 ตัว)");
      try { d.keychain.set(secretAccount(p, it.id), v); } catch (e: any) { return bad(set, e.message, 500); }
    }
    t.items.push(it); save(d, p, st); return { ok: true, item: it };
  });
  app.post("/threads/:tid/items/:iid/update", ({ params, body, set }: any) => {
    const p = proj(body?.project); if (!p) return bad(set, "ไม่มีชื่อโปรเจค");
    const { st, t } = find(p, params.tid), it = t?.items.find(x => x.id === params.iid); if (!st || !it) return bad(set, "ไม่พบรายการ", 404);
    if (typeof body?.pinned === "boolean") it.pinned = body.pinned;
    if (typeof body?.title === "string" && body.title.trim()) it.title = clip(body.title, 120).trim();
    if (typeof body?.body === "string") it.body = clip(body.body, 4000);
    if (typeof body?.code === "string" && it.kind === "cmd") it.code = clip(body.code, 8000);
    if (typeof body?.secret === "string" && it.kind === "secret" && body.secret) { try { d.keychain.set(secretAccount(p, it.id), body.secret); } catch (e: any) { return bad(set, e.message, 500); } }
    save(d, p, st); return { ok: true, item: it };
  });
  app.post("/threads/:tid/items/:iid/delete", ({ params, body, set }: any) => {
    const p = proj(body?.project); if (!p) return bad(set, "ไม่มีชื่อโปรเจค");
    const { st, t } = find(p, params.tid), it = t?.items.find(x => x.id === params.iid); if (!st || !t || !it) return bad(set, "ไม่พบรายการ", 404);
    if (it.kind === "secret") d.keychain.del(secretAccount(p, it.id));
    if (it.kind === "file") rmSync(filePath(d, p, it), { force: true });
    t.items = t.items.filter(x => x !== it); save(d, p, st); return { ok: true };
  });
  app.post("/threads/:tid/items/:iid/reveal", ({ params, body, set }: any) => {
    set.headers["cache-control"] = "no-store";
    const p = proj(body?.project); if (!p) return bad(set, "ไม่มีชื่อโปรเจค");
    const { t } = find(p, params.tid), it = t?.items.find(x => x.id === params.iid); if (!it || it.kind !== "secret") return bad(set, "ไม่พบรหัส", 404);
    const value = d.keychain.get(secretAccount(p, it.id)); if (value == null) return bad(set, "ไม่พบค่าใน Keychain", 404);
    return { ok: true, value };
  });
  app.post("/threads/:tid/files", async ({ params, query, request, set }: any) => {
    const p = proj(query?.project); if (!p) return bad(set, "ไม่มีชื่อโปรเจค");
    const { st, t } = find(p, params.tid); if (!st || !t) return bad(set, "ไม่พบเธรด", 404);
    if (Number(request.headers.get("content-length") ?? 0) > FILE_MAX) return bad(set, "ไฟล์ใหญ่เกิน 200 MB", 413);
    const it: ThreadItem = { id: newId(), kind: "file", title: safeFile(String(query?.name ?? "file")), at: Date.now(), file: { name: safeFile(String(query?.name ?? "file")), size: 0 } };
    mkdirSync(fileDir(d, p), { recursive: true });
    const dest = filePath(d, p, it), part = dest + ".part";
    try {
      await Bun.write(part, new Response(request.body));
      it.file!.size = statSync(part).size;
      if (!it.file!.size || it.file!.size > FILE_MAX) { rmSync(part, { force: true }); return bad(set, it.file!.size ? "ไฟล์ใหญ่เกิน 200 MB" : "ไฟล์ว่าง", it.file!.size ? 413 : 400); }
      renameSync(part, dest);
    } catch (e: any) { rmSync(part, { force: true }); return bad(set, "บันทึกไม่สำเร็จ: " + String(e?.message ?? e).slice(0, 100), 500); }
    t.items.push(it); save(d, p, st); return { ok: true, item: it };
  }, { parse: "none" });
  app.get("/threads/:tid/files/:iid", ({ params, query, set }: any) => {
    const p = proj(query?.project); if (!p || !ID_RE.test(params.iid)) return bad(set, "bad request");
    const { t } = find(p, params.tid), it = t?.items.find(x => x.id === params.iid && x.kind === "file");
    if (!it || !existsSync(filePath(d, p, it))) return bad(set, "ไม่พบไฟล์", 404);
    return new Response(Bun.file(filePath(d, p, it)), { headers: { "content-disposition": `${query?.inline === "1" ? "inline" : "attachment"}; filename="file"; filename*=UTF-8''${encodeURIComponent(it.file!.name)}`, "cache-control": "private, no-store" } });
  });
}
