// Feature pack "vault" — 📦 คลังไฟล์: one box on the Mac for photos and files from any phone. Originals are kept as
// they came (never resized); any device in the tailnet (or with the app token) can list, download or delete them.
// POST /vault/upload?name=&dev=   raw body → stored as is (refused when the Mac would drop under FREE_MIN free)
// GET  /vault                     → { ok, items: [{ id, name, size, mime, at, dev, kind }], used, free }
// GET  /vault/thumb/:id           → small JPEG (sips for images, Quick Look for video / PDF) or 404
// POST /vault/link { ids }        → { links: [{ id, name, url }] } signed for 15 min → GET /vault/dl/:id?e=&s=
//                                   (a plain link: the phone's own downloader saves it, big files stream)
// POST /vault/zip { ids }         → { url } signed → GET /vault/dl-zip?k=&e=&s= streams one zip (stored, not compressed)
// POST /vault/delete { ids }      → moved to ~/.maw/vault/.trash (nothing is deleted outright)
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, symlinkSync, utimesSync, writeFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadMobileConfig, safeName } from "../api";

export const ROOT = join(homedir(), ".maw", "vault");
const FILES = join(ROOT, "files"), THUMBS = join(ROOT, "thumbs"), TRASH = join(ROOT, ".trash"), ZIPS = join(ROOT, ".zips");
const INDEX = join(ROOT, "index.json");
export const FREE_MIN = 5 * 1024 ** 3;              // keep 5 GB free on the Mac
export const FILE_MAX = 4 * 1024 ** 3;              // one file ≤ 4 GB
const LINK_MS = 15 * 60_000;

export interface Item { id: string; name: string; size: number; mime: string; at: number; dev: string; kind: "image" | "video" | "file" }

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", "3gp": "video/3gpp", webm: "video/webm",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", json: "application/json",
  zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg", m4a: "audio/mp4",
};
export const mimeOf = (name: string) => EXT_MIME[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
export const kindOf = (mime: string): Item["kind"] => mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file";

const load = (): Item[] => { try { return JSON.parse(readFileSync(INDEX, "utf-8")); } catch { return []; } };
const save = (items: Item[]) => { mkdirSync(ROOT, { recursive: true }); writeFileSync(INDEX, JSON.stringify(items), { mode: 0o600 }); };
const pathOf = (it: Item) => join(FILES, `${it.id}__${it.name}`);
export const newId = () => Date.now().toString(36) + randomBytes(4).toString("hex");
const ID_RE = /^[0-9a-z]{6,20}$/;

export function freeBytes(dir = homedir()): number {
  try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Number.MAX_SAFE_INTEGER; }
}

/** Signed short-lived link — the phone downloads with a plain <a href>, no token header (big files stream to disk). */
export function sign(secret: string, what: string, exp: number): string {
  return createHmac("sha256", secret).update(`${what}.${exp}`).digest("hex").slice(0, 40);
}
export function verify(secret: string, what: string, exp: number, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp < now || exp > now + LINK_MS + 60_000 || !/^[0-9a-f]{40}$/.test(sig)) return false;
  const want = Buffer.from(sign(secret, what, exp)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

async function makeThumb(it: Item): Promise<void> {
  mkdirSync(THUMBS, { recursive: true });
  const out = join(THUMBS, `${it.id}.jpg`), src = pathOf(it);
  const run = async (cmd: string[]) => { const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }); const t = setTimeout(() => p.kill(), 60_000); await p.exited; clearTimeout(t); };
  try {
    if (it.kind === "image") { await run(["/usr/bin/sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "400", src, "--out", out]); return; }
    const bin = (n: string) => ["/opt/homebrew/bin/" + n, "/usr/local/bin/" + n].find(existsSync);
    // PDF: first page via poppler · video: a frame at 1 s via ffmpeg (Quick Look can't run under launchd)
    if (it.mime === "application/pdf" && bin("pdftoppm")) { await run([bin("pdftoppm")!, "-jpeg", "-jpegopt", "quality=70", "-scale-to", "400", "-f", "1", "-l", "1", "-singlefile", src, out.replace(/\.jpg$/, "")]); return; }
    if (it.kind === "video" && bin("ffmpeg")) { await run([bin("ffmpeg")!, "-y", "-loglevel", "error", "-ss", "1", "-i", src, "-frames:v", "1", "-vf", "scale=400:-2", out]); if (existsSync(out)) return; }
    // anything else: Quick Look renders a PNG next to us → shrink to JPEG (works when maw runs in a login session)
    const tmp = join(THUMBS, `.${it.id}`); mkdirSync(tmp, { recursive: true });
    await run(["/usr/bin/qlmanage", "-t", "-s", "400", "-o", tmp, src]);
    const png = readdirSync(tmp).find(f => f.endsWith(".png"));
    if (png) await run(["/usr/bin/sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", join(tmp, png), "--out", out]);
    rmSync(tmp, { recursive: true, force: true });
  } catch { /* no thumbnail — the phone shows an icon */ }
}

export function mount(app: any, opts: { secret?: () => string } = {}): void {
  const secret = opts.secret ?? (() => loadMobileConfig().token);
  const signed = (path: string, what: string) => { const e = Date.now() + LINK_MS; return `/mobile${path}${path.includes("?") ? "&" : "?"}e=${e}&s=${sign(secret(), what, e)}`; };

  app.get("/vault", () => {
    const items = load().sort((a, b) => b.at - a.at);
    return { ok: true, items, used: items.reduce((a, x) => a + x.size, 0), free: freeBytes() };
  });

  app.post("/vault/upload", async ({ request, query, set }: any) => {
    const name = safeName(String(query?.name ?? "file"));
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > FILE_MAX) { set.status = 413; return { ok: false, error: "ไฟล์ใหญ่เกิน 4 GB" }; }
    if (freeBytes() - declared < FREE_MIN) { set.status = 507; return { ok: false, error: "พื้นที่บน Mac เหลือน้อย (ต้องเหลืออย่างน้อย 5 GB) — ลบไฟล์เก่าในคลังก่อน" }; }
    mkdirSync(FILES, { recursive: true });
    const id = newId(), mime = mimeOf(name);
    const it: Item = { id, name, size: 0, mime, at: Date.now(), dev: String(query?.dev ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 40) || "?", kind: kindOf(mime) };
    const dest = pathOf(it), part = dest + ".part";
    try {
      await Bun.write(part, new Response(request.body));     // streamed to disk, never held in memory
      it.size = statSync(part).size;
      if (!it.size) { rmSync(part, { force: true }); set.status = 400; return { ok: false, error: "ไฟล์ว่าง" }; }
      if (it.size > FILE_MAX) { rmSync(part, { force: true }); set.status = 413; return { ok: false, error: "ไฟล์ใหญ่เกิน 4 GB" }; }
      renameSync(part, dest);
    } catch (e: any) { rmSync(part, { force: true }); set.status = 500; return { ok: false, error: "บันทึกไม่สำเร็จ: " + String(e?.message ?? e).slice(0, 120) }; }
    save([...load(), it]);
    makeThumb(it).catch(() => {});
    return { ok: true, item: it };
  }, { parse: "none" });

  app.get("/vault/thumb/:id", ({ params, set }: any) => {
    const f = join(THUMBS, `${params.id}.jpg`);
    if (!ID_RE.test(params.id) || !existsSync(f)) { set.status = 404; return { ok: false }; }
    return new Response(Bun.file(f), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
  });

  app.post("/vault/link", ({ body, set }: any) => {
    const ids: string[] = Array.isArray(body?.ids) ? body.ids.slice(0, 500) : [];
    const items = load().filter(x => ids.includes(x.id));
    if (!items.length) { set.status = 404; return { ok: false, error: "ไม่พบไฟล์" }; }
    return { ok: true, links: items.map(x => ({ id: x.id, name: x.name, size: x.size, mime: x.mime, url: signed(`/vault/dl/${x.id}`, x.id) })) };
  });

  app.get("/vault/dl/:id", ({ params, query, set }: any) => {
    if (!ID_RE.test(params.id) || !verify(secret(), params.id, Number(query?.e), String(query?.s ?? ""))) { set.status = 403; return { ok: false, error: "ลิงก์หมดอายุ — กดโหลดใหม่ในแอป" }; }
    const it = load().find(x => x.id === params.id);
    if (!it || !existsSync(pathOf(it))) { set.status = 404; return { ok: false, error: "ไม่พบไฟล์" }; }
    const inline = query?.inline === "1";
    return new Response(Bun.file(pathOf(it)), { headers: {
      "content-type": it.mime, "content-length": String(it.size),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="file"; filename*=UTF-8''${encodeURIComponent(it.name)}`,
    } });
  });

  // many files in one go: a zip made on the fly (stored, not compressed — photos don't shrink anyway)
  app.post("/vault/zip", ({ body, set }: any) => {
    const ids: string[] = Array.isArray(body?.ids) ? body.ids.slice(0, 500) : [];
    const items = load().filter(x => ids.includes(x.id));
    if (!items.length) { set.status = 404; return { ok: false, error: "ไม่พบไฟล์" }; }
    const k = newId(), dir = join(ZIPS, k);
    mkdirSync(dir, { recursive: true });
    const used = new Set<string>();
    for (const it of items) {
      let n = it.name, i = 1;
      while (used.has(n.toLowerCase())) n = it.name.replace(/(\.[^.]*)?$/, m => ` (${i++})${m}`);
      used.add(n.toLowerCase());
      symlinkSync(pathOf(it), join(dir, n));
    }
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), LINK_MS + 60_000);
    return { ok: true, url: signed(`/vault/dl-zip?k=${k}`, "zip:" + k), count: items.length, size: items.reduce((a, x) => a + x.size, 0) };
  });

  app.get("/vault/dl-zip", ({ query, set }: any) => {
    const k = String(query?.k ?? ""), dir = join(ZIPS, k);
    if (!ID_RE.test(k) || !verify(secret(), "zip:" + k, Number(query?.e), String(query?.s ?? "")) || !existsSync(dir)) { set.status = 403; return { ok: false, error: "ลิงก์หมดอายุ — กดโหลดใหม่ในแอป" }; }
    const names = readdirSync(dir);
    const proc = Bun.spawn(["/usr/bin/zip", "-0", "-q", "-", ...names], { cwd: dir, stdout: "pipe", stderr: "ignore" });
    const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    return new Response(proc.stdout, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="maw-${stamp}.zip"` } });
  });

  app.post("/vault/delete", ({ body }: any) => {
    const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
    const all = load(), keep: Item[] = [];
    mkdirSync(TRASH, { recursive: true });
    for (const it of all) {
      if (!ids.includes(it.id)) { keep.push(it); continue; }
      const bin = join(TRASH, `${it.id}__${it.name}`);
      try { renameSync(pathOf(it), bin); const now = new Date(); utimesSync(bin, now, now); } catch { /* already gone */ }   // the 30 days count from now
      rmSync(join(THUMBS, `${it.id}.jpg`), { force: true });
    }
    save(keep);
    // the bin keeps 30 days
    try { for (const f of readdirSync(TRASH)) { const p = join(TRASH, f); if (Date.now() - statSync(p).mtimeMs > 30 * 86400e3) rmSync(p, { force: true }); } } catch { /* empty */ }
    return { ok: true, removed: all.length - keep.length };
  });
}
