// Feature pack "docs" — ISO work-product documents across the repos on this Mac: folders named "WP05 …", "WP18 …"
// (the /iso skill's layout, e.g. acme/Client/docs/WP18 Software User Documentation/CLIENT_App_SUD_V1.1.docx).
// GET  /docs                  → { ok, sets: [{ id, name, path, wps: [{ wp, title, files: [{ id, name, ext, size, mtime, tbd }] }] }] }
// POST /docs/render { id }    → { ok, state: "ready", pages, tbd: [{ page, text }] } | { ok, state: "working" } | { ok:false, error }
// GET  /docs/page?id=&n=      → JPEG of page n (1-based) once rendered
// GET  /docs/marks?id=        → pen marks on this document (any version of it) · POST /docs/marks {id,page,note,image}
// POST /docs/marks/delete {id, mid} · POST /docs/marks/send {id, ws, room} → one message with every unsent mark to a room
// GET  /docs/mark-img?mid=    → the marked page (JPEG, red ink on the page) — the "before" of a fix
// Read-only: files are converted into ~/.maw/docs-cache (LibreOffice → PDF → JPEG pages); the documents are never touched.
// "[TBD]" is what the /iso skill writes (highlighted yellow) wherever it is not sure — the phone lists and jumps to them.
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, relative } from "path";
import { roomChannel, typeInto } from "./ctx";

export const DOC_EXT = /\.(docx|xlsx|pptx|pdf|doc|xls|ppt|txt)$/i;   // txt: the README.txt some WPs (repository, software) hold
export const WP_DIR = /^WP\d{2}\b/i;
const ROOTS = ["artron", "my-project", "oracle", "Documents"];
const PRUNE = ["node_modules", ".git", "build", ".dart_tool", "Pods", "dist", ".next", "vendor", "target", ".gradle"];
const CACHE = join(homedir(), ".maw", "docs-cache");
const BIN = (n: string) => ["/opt/homebrew/bin/" + n, "/usr/local/bin/" + n].find(existsSync) ?? n;
// "[TBD]" and "[TBD: วันที่]" — match the opening so a label wrapped onto the next PDF line still counts
export const TBD_RE = /\[\s*TBD\b/gi;

export interface DocFile { id: string; path: string; name: string; ext: string; size: number; mtime: number; tbd: number | null; old?: boolean }
export interface DocSet { id: string; path: string; name: string; label: string; sub: string; wps: { wp: string; title: string; files: DocFile[] }[] }

export const idOf = (p: string) => Buffer.from(p).toString("base64url");
const tilde = (p: string) => p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p;

async function run(cmd: string[], timeoutMs = 20_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, timeoutMs);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited; clearTimeout(t);
  return { code, out };
}

/** "[TBD]" count inside an Office file (its XML) or a PDF (its text); null when it can't be read. */
export function countTbd(text: string): number { return (text.match(TBD_RE) ?? []).length; }
const tbdCache = new Map<string, number | null>();
async function tbdOf(f: { path: string; mtime: number; ext: string }): Promise<number | null> {
  const key = f.path + "|" + f.mtime;
  if (tbdCache.has(key)) return tbdCache.get(key)!;
  let n: number | null = null;
  try {
    const ext = f.ext.toLowerCase();
    if (ext === "pdf") n = countTbd((await run([BIN("pdftotext"), f.path, "-"])).out);
    else if (["docx", "xlsx", "pptx"].includes(ext)) {
      const parts = ext === "docx" ? ["word/document.xml", "word/header*.xml", "word/footer*.xml"] : ext === "xlsx" ? ["xl/sharedStrings.xml", "xl/worksheets/*.xml"] : ["ppt/slides/*.xml"];
      // text may be split across runs (<w:t>[</w:t><w:t>TBD]</w:t>) → strip the tags first
      n = countTbd((await run(["unzip", "-p", f.path, ...parts])).out.replace(/<[^>]+>/g, ""));
    }
  } catch { n = null; }
  tbdCache.set(key, n);
  return n;
}

// path pieces that say nothing about which project it is
const GENERIC = /^(factorypro|project|projects|core|artron|my-project|oracle|documents)$/i;
const DOCSY = /^(docs?|_?archive|old|doc[ _-]?work.*|iso[ _-]?docs?)$/i;
/** "work/Project/acme/Client/docs" → { label: "Client", sub: "acme" }; "acme2/doc work v.3" → { label: "acme2", sub: "doc work v.3" }. */
export function setLabel(rel: string): { label: string; sub: string } {
  const segs = rel.split("/").filter(Boolean);
  const tail: string[] = [];
  while (segs.length > 1 && DOCSY.test(segs[segs.length - 1])) tail.unshift(segs.pop()!);
  const label = segs.pop() ?? rel;
  const ctx = segs.filter(x => !GENERIC.test(x));
  const extra = tail.filter(t => !/^docs?$/i.test(t));
  return { label, sub: [...ctx.slice(-1), ...extra].join(" · ") };
}

/** Every folder that holds "WPnn …" folders becomes a set; its documents are the office/PDF files inside each WP folder. */
export function buildSets(wpDirs: string[], list: (dir: string) => { name: string; size: number; mtime: number; dir: boolean }[]): DocSet[] {
  const bySet = new Map<string, string[]>();
  for (const d of wpDirs) { const parent = dirname(d); bySet.set(parent, [...(bySet.get(parent) ?? []), d]); }
  const sets: DocSet[] = [];
  for (const [parent, dirs] of bySet) {
    const wps = dirs.sort((a, b) => basename(a).localeCompare(basename(b), "en", { numeric: true })).map(d => {
      const name = basename(d), wp = name.match(WP_DIR)![0].toUpperCase();
      const files: DocFile[] = [];
      const walk = (dir: string, depth: number) => {
        for (const e of list(dir)) {
          if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;            // .DS_Store, Office lock files
          const p = join(dir, e.name);
          if (e.dir) { if (depth < 2) walk(p, depth + 1); continue; }
          if (!DOC_EXT.test(e.name)) continue;
          files.push({ id: idOf(p), path: p, name: relative(d, p), ext: e.name.split(".").pop()!.toLowerCase(), size: e.size, mtime: e.mtime, tbd: null });
        }
      };
      walk(d, 0);
      files.sort((a, b) => b.mtime - a.mtime);
      markOld(files);
      return { wp, title: name.slice(wp.length).trim(), files };
    });
    const home = homedir();
    const rel = relative(home, parent).split("/").filter(s => !ROOTS.includes(s)).join("/");
    sets.push({ id: idOf(parent), path: tilde(parent), name: rel.split("/").join(" / ") || basename(parent), ...setLabel(rel || basename(parent)), wps });
  }
  return sets.sort((a, b) => Math.max(0, ...b.wps.flatMap(w => w.files.map(f => f.mtime))) - Math.max(0, ...a.wps.flatMap(w => w.files.map(f => f.mtime))));
}

/** "ACME_SUD_V1.0.docx" next to "ACME_SUD_V1.1.docx" → the 1.0 is an old version (kept, listed apart, not counted). */
export const versionOf = (name: string) => { const m = name.match(/^(.*?)[ _-]?v(\d+(?:\.\d+)*)\.[^.]+$/i); return m ? { base: m[1].toLowerCase() + "|" + name.split(".").pop()!.toLowerCase(), v: m[2].split(".").map(Number) } : null; };
const newer = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); return false; };
export function markOld(files: DocFile[]): void {
  const best = new Map<string, number[]>();
  for (const f of files) { const v = versionOf(f.name); if (v && (!best.has(v.base) || newer(v.v, best.get(v.base)!))) best.set(v.base, v.v); }
  for (const f of files) { const v = versionOf(f.name); f.old = !!v && newer(best.get(v.base)!, v.v); }
}

const listDir = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).map(e => {
      let size = 0, mtime = 0;
      if (!e.isDirectory()) { try { const s = statSync(join(dir, e.name)); size = s.size; mtime = s.mtimeMs; } catch { /* vanished */ } }
      return { name: e.name, size, mtime, dir: e.isDirectory() };
    });
  } catch { return []; }
};

async function findWpDirs(): Promise<string[]> {
  const roots = ROOTS.map(r => join(homedir(), r)).filter(existsSync);
  if (!roots.length) return [];
  const prune = PRUNE.flatMap((n, i) => [...(i ? ["-o"] : []), "-name", n]);
  const { out } = await run(["find", ...roots, "-maxdepth", "8", "(", ...prune, ")", "-prune", "-o", "-type", "d", "-name", "WP[0-9][0-9]*", "-print"], 30_000);
  return out.split("\n").filter(p => p && WP_DIR.test(basename(p)));
}

let index: { at: number; sets: DocSet[]; files: Map<string, DocFile> } = { at: 0, sets: [], files: new Map() };
let indexing: Promise<void> | null = null;
async function refreshIndex(): Promise<void> {
  const sets = buildSets(await findWpDirs(), listDir);
  const files = new Map<string, DocFile>();
  for (const s of sets) for (const w of s.wps) for (const f of w.files) { f.tbd = await tbdOf(f); files.set(f.id, f); }
  index = { at: Date.now(), sets, files };
  // warm the documents people are working on (latest versions touched in the last 14 days) so they open at once
  if (process.env.NODE_ENV !== "test")
    for (const f of [...files.values()].filter(f => !f.old && Date.now() - f.mtime < 14 * 86400e3).sort((a, b) => b.mtime - a.mtime)) startRender(f).catch(() => {});
  pruneCache(new Set([...files.values()].map(f => basename(cacheDir(f)))));
}
/** Drop rendered pages of document versions that no longer exist (edited or removed) after 3 days — it's only a cache. */
function pruneCache(keep: Set<string>) {
  try {
    for (const d of readdirSync(CACHE)) {
      if (d === "lo-profile" || keep.has(d)) continue;
      const p = join(CACHE, d);
      if (Date.now() - statSync(p).mtimeMs > 3 * 86400e3) rmSync(p, { recursive: true, force: true });
    }
  } catch { /* no cache yet */ }
}
function ensureIndex(force = false): Promise<void> {
  if (!indexing && (force || Date.now() - index.at > 120_000)) indexing = refreshIndex().finally(() => { indexing = null; });
  return index.at ? Promise.resolve() : (indexing ?? Promise.resolve());
}

// ── rendering: one job at a time (LibreOffice is heavy), results cached per file version ──
interface Meta { pages: number; tbd: { page: number; text: string }[]; pdf?: string }
const jobs = new Map<string, Promise<Meta>>();
let chain: Promise<unknown> = Promise.resolve();
const RENDER_V = 3;   // bump when what a render produces changes (v2: "[TBD: …]" marks · v3: 800 px pages) → old caches are redone
export const cacheDir = (f: { path: string; mtime: number }) => join(CACHE, createHash("sha1").update(RENDER_V + "|" + f.path + "|" + f.mtime).digest("hex").slice(0, 16));

/** The lines of each PDF page (pdftotext, pages split by form feed) that mention [TBD]. */
export function tbdLines(pdfText: string): { page: number; text: string }[] {
  const out: { page: number; text: string }[] = [];
  pdfText.split("\f").forEach((pg, i) => {
    for (const line of pg.split("\n")) if (TBD_RE.test(line)) { TBD_RE.lastIndex = 0; out.push({ page: i + 1, text: line.replace(/\s+/g, " ").trim().slice(0, 200) }); }
    TBD_RE.lastIndex = 0;
  });
  return out;
}

async function render(f: DocFile): Promise<Meta> {
  const dir = cacheDir(f), metaFile = join(dir, "meta.json");
  if (existsSync(metaFile)) return JSON.parse(readFileSync(metaFile, "utf-8"));
  mkdirSync(dir, { recursive: true });
  let pdf = f.path;
  if (f.ext !== "pdf") {
    // own profile dir so it runs next to an open LibreOffice window
    const r = await run(["nice", "-n", "15", BIN("soffice"), `-env:UserInstallation=file://${join(CACHE, "lo-profile")}`, "--headless", "--convert-to", "pdf", "--outdir", dir, f.path], 180_000);
    pdf = join(dir, basename(f.path).replace(/\.[^.]+$/, ".pdf"));
    if (r.code !== 0 || !existsSync(pdf)) throw new Error("แปลงไฟล์ไม่สำเร็จ (LibreOffice)");
  }
  // 800 px / q55 ≈ 55 KB a page — sharp enough at phone width over 4G; a zoom asks for one 1600 px page (hdPage)
  const img = await run(["nice", "-n", "15", BIN("pdftoppm"), "-jpeg", "-jpegopt", "quality=55", "-scale-to-x", "800", "-scale-to-y", "-1", pdf, join(dir, "p")], 180_000);
  const pages = readdirSync(dir).filter(n => /^p-\d+\.jpg$/.test(n)).length;
  if (img.code !== 0 || !pages) throw new Error("ทำภาพหน้าเอกสารไม่สำเร็จ");
  const meta: Meta = { pages, pdf, tbd: tbdLines((await run([BIN("pdftotext"), "-layout", pdf, "-"], 60_000)).out) };
  writeFileSync(metaFile, JSON.stringify(meta));
  return meta;
}
function startRender(f: DocFile): Promise<Meta> {
  const key = cacheDir(f);
  let j = jobs.get(key);
  if (!j) {
    j = chain.then(() => render(f));
    chain = j.catch(() => {});
    jobs.set(key, j);
    j.catch(() => setTimeout(() => jobs.delete(key), 30_000));   // a failed job can be retried later
  }
  return j;
}
/** Page file name as pdftoppm writes it: p-1.jpg … p-9.jpg, or p-01.jpg … when there are ≥10 pages. */
export function pageFile(dir: string, n: number, pages: number): string {
  return join(dir, `p-${String(n).padStart(String(pages).length, "0")}.jpg`);
}

/** One page at zoom size, made on first request. */
async function hdPage(dir: string, meta: Meta, n: number): Promise<string | null> {
  const out = join(dir, `h-${n}.jpg`);
  if (existsSync(out)) return out;
  if (!meta.pdf || !existsSync(meta.pdf)) return null;
  await run([BIN("pdftoppm"), "-jpeg", "-jpegopt", "quality=75", "-scale-to-x", "1600", "-scale-to-y", "-1", "-f", String(n), "-l", String(n), "-singlefile", meta.pdf, join(dir, `h-${n}`)], 30_000);
  return existsSync(out) ? out : null;
}

// ── pen marks: the reviewer circles / strikes on a page + a short note → queued → sent to a Claude room in one go ──
export interface Mark { mid: string; page: number; note: string; img: string; at: number; ver: number; file: string; sentAt?: number; room?: string }
const MARKS_FILE = join(homedir(), ".maw", "docs-marks.json");
const MARK_DIR = join(homedir(), ".maw", "docs-marks");
const MARK_MAX = 4 * 1024 * 1024;
/** Marks follow the document across versions: ACME_SUD_V1.1.docx and _V1.2.docx share one list. */
export const familyOf = (path: string) => { const v = versionOf(basename(path)); return join(dirname(path), v ? v.base : basename(path).toLowerCase()); };
const loadMarks = (file = MARKS_FILE): Record<string, Mark[]> => { try { return JSON.parse(readFileSync(file, "utf-8")); } catch { return {}; } };
const saveMarks = (m: Record<string, Mark[]>, file = MARKS_FILE) => writeFileSync(file, JSON.stringify(m, null, 1), { mode: 0o600 });
/** Newest version of a document family among the indexed files (the "after" of a fix). */
function latestOf(f: DocFile): DocFile {
  const fam = familyOf(f.path);
  let best = f;
  for (const x of index.files.values()) if (familyOf(x.path) === fam && !x.old && (best.old || x.mtime > best.mtime)) best = x;
  return best;
}
/** The single-line message a room gets — newlines could be taken as Enter by the agent's input box. */
export function marksMessage(docPath: string, marks: Pick<Mark, "page" | "note" | "img">[]): string {
  const items = marks.map((m, i) => `(${i + 1}) หน้า ${m.page}${m.note ? ` — ${m.note.replace(/\s+/g, " ").trim()}` : ""} · ภาพ ${tilde(m.img)}`).join(" ");
  return `📄 ตรวจเอกสาร ${tilde(docPath)} — ขีดสีแดงไว้ ${marks.length} จุด ดูภาพแต่ละจุด (หน้าเอกสารที่ขีดทับจุดที่ต้องแก้) แล้วแก้ในไฟล์ให้ครบทุกจุด ตามกติกาของ /iso: ${items}`;
}

export function mount(app: any): void {
  if (process.env.NODE_ENV !== "test") setTimeout(() => { ensureIndex(true); }, 20_000);

  app.get("/docs", async ({ query }: any) => {
    await ensureIndex(query?.refresh === "1");
    return { ok: true, at: index.at, indexing: !!indexing, sets: index.sets.map(s => ({ ...s, wps: s.wps.map(w => ({ ...w, files: w.files.map(({ path, ...rest }) => rest) })) })) };
  });

  app.post("/docs/render", async ({ body, set }: any) => {
    await ensureIndex();
    const f = index.files.get(String(body?.id ?? ""));
    if (!f) { set.status = 404; return { ok: false, error: "ไม่พบเอกสารนี้" }; }
    const j = startRender(f);
    // answer within a few seconds (Bun drops idle requests at 10 s) — the phone polls until ready
    const r = await Promise.race([j.then(m => ({ m })).catch((e: any) => ({ e })), new Promise(res => setTimeout(() => res(null), 4_000))]) as any;
    if (!r) return { ok: true, state: "working" };
    if (r.e) { set.status = 500; return { ok: false, error: String(r.e?.message || r.e) }; }
    return { ok: true, state: "ready", pages: r.m.pages, tbd: r.m.tbd, path: tilde(f.path) };
  });

  app.get("/docs/page", async ({ query, set }: any) => {
    const f = index.files.get(String(query?.id ?? ""));
    const n = Number(query?.n);
    if (!f || !Number.isInteger(n) || n < 1) { set.status = 404; return { ok: false, error: "not found" }; }
    const dir = cacheDir(f), metaFile = join(dir, "meta.json");
    if (!existsSync(metaFile)) { set.status = 409; return { ok: false, error: "ยังไม่ได้แปลง" }; }
    const meta = JSON.parse(readFileSync(metaFile, "utf-8")) as Meta, { pages } = meta;
    const p = query?.hd === "1" && n <= pages ? await hdPage(dir, meta, n) ?? pageFile(dir, n, pages) : pageFile(dir, n, pages);
    if (n > pages || !existsSync(p)) { set.status = 404; return { ok: false, error: "not found" }; }
    return new Response(Bun.file(p), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
  });

  const fileOf = async (id: unknown) => { await ensureIndex(); return index.files.get(String(id ?? "")); };
  const view = (m: Mark) => ({ mid: m.mid, page: m.page, note: m.note, at: m.at, sentAt: m.sentAt ?? null, ver: m.ver, file: basename(m.file) });

  app.get("/docs/marks", async ({ query, set }: any) => {
    const f = await fileOf(query?.id);
    if (!f) { set.status = 404; return { ok: false, error: "ไม่พบเอกสารนี้" }; }
    const latest = latestOf(f);
    return { ok: true, marks: (loadMarks()[familyOf(f.path)] ?? []).map(view), latest: { id: latest.id, name: latest.name, mtime: latest.mtime } };
  });

  app.post("/docs/marks", async ({ body, set }: any) => {
    const f = await fileOf(body?.id);
    const page = Number(body?.page), note = String(body?.note ?? "").slice(0, 1000);
    const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(body?.image ?? ""));
    if (!f || !Number.isInteger(page) || page < 1 || !m) { set.status = 400; return { ok: false, error: "ข้อมูลไม่ครบ" }; }
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > MARK_MAX) { set.status = 413; return { ok: false, error: "ภาพใหญ่เกิน" }; }
    mkdirSync(MARK_DIR, { recursive: true });
    const mid = createHash("sha1").update(f.path + Date.now() + Math.random()).digest("hex").slice(0, 12);
    const img = join(MARK_DIR, `${mid}.${m[1] === "png" ? "png" : "jpg"}`);
    writeFileSync(img, buf);
    const all = loadMarks(), fam = familyOf(f.path);
    all[fam] = [...(all[fam] ?? []), { mid, page, note, img, at: Date.now(), ver: f.mtime, file: f.path }];
    saveMarks(all);
    return { ok: true, mid };
  });

  app.post("/docs/marks/delete", async ({ body, set }: any) => {
    const f = await fileOf(body?.id);
    if (!f) { set.status = 404; return { ok: false, error: "ไม่พบเอกสารนี้" }; }
    const all = loadMarks(), fam = familyOf(f.path);
    const gone = (all[fam] ?? []).find(m => m.mid === body?.mid);
    all[fam] = (all[fam] ?? []).filter(m => m.mid !== body?.mid);
    saveMarks(all);
    if (gone) try { rmSync(gone.img, { force: true }); } catch { /* already gone */ }
    return { ok: true };
  });

  app.post("/docs/marks/send", async ({ body, set }: any) => {
    const f = await fileOf(body?.id);
    const ch = roomChannel(String(body?.ws ?? ""), String(body?.room ?? ""));
    if (!f || !ch) { set.status = 400; return { ok: false, error: "เลือกห้องก่อน" }; }
    const all = loadMarks(), fam = familyOf(f.path);
    const todo = (all[fam] ?? []).filter(m => !m.sentAt).sort((a, b) => a.page - b.page);
    if (!todo.length) { set.status = 400; return { ok: false, error: "ยังไม่มีจุดที่ขีดไว้" }; }
    await typeInto(ch, marksMessage(latestOf(f).path, todo));
    const now = Date.now();
    for (const m of todo) { m.sentAt = now; m.room = `${body.ws}|${body.room}`; }
    saveMarks(all);
    return { ok: true, sent: todo.length };
  });

  app.get("/docs/mark-img", ({ query, set }: any) => {
    for (const list of Object.values(loadMarks())) for (const m of list)
      if (m.mid === query?.mid && existsSync(m.img)) return new Response(Bun.file(m.img), { headers: { "content-type": m.img.endsWith(".png") ? "image/png" : "image/jpeg", "cache-control": "private, max-age=86400" } });
    set.status = 404; return { ok: false, error: "not found" };
  });
}
