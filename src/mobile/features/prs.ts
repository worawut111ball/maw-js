// Feature pack "prs" — open pull requests of every GitHub repo on this Mac, AI review in a Claude room, merge on tap
// (PLAN-maw-mobile.md §9). gh is authenticated on the Mac; we call it by absolute path (launchd PATH is bare), no shell.
// GET  /prs[?fresh=1]        → repos with open PRs + short Thai status + latest AI verdict
// POST /prs/review {repo, number}            → type "/review-pr …" into an idle Claude room (review only, never merge)
// POST /prs/auto   {repo, on}                → per-repo auto review (background loop every 3 min)
// POST /prs/merge  {repo, number, method, deleteBranch?} → re-check the PR, then `gh pr merge` (only on the user's tap)
// Config ~/.maw/prs.json {extraRepos: ["owner/repo"], auto: {"owner/repo": true}, reviewRoom: "tmux:<session> | <sessionId> | ws/room"}
// Verdicts ~/.maw/pr-verdicts/<owner>__<repo>__<n>.json {"verdict":"ready"|"blocked","note":"…","at":"<ISO>"} written by the AI.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readLiveRooms, readScreen, typeInto, notifyPhones, roomChannel, scanRepos, inputDraft, agentSpinner } from "./ctx";
import type { LiveRoom, ReplyChannel } from "./ctx";
import { parsePrompt, parseMenu } from "./permissions";

const CACHE_MS = 90_000, CONCURRENCY = 4, NOTE_MAX = 140, PENDING_MS = 60 * 60_000, AUTO_EVERY = 3 * 60_000;
const REVIEW_TMUX = "team2-oracle";
export const SLUG_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PR_FIELDS = "number,title,author,headRefName,baseRefName,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,updatedAt,url";
const GH = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].find(p => existsSync(p)) ?? "gh";

export interface GhResult { code: number; stdout: string; stderr: string }
async function runGh(args: string[], timeoutMs = 30_000): Promise<GhResult> {
  const p = Bun.spawn([GH, ...args], { cwd: homedir(), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

export interface PrsConfig { extraRepos: string[]; auto: Record<string, boolean>; reviewRoom: string | null }
export interface RepoRef { repo: string; path: string | null }

/** Swappable for tests — no test may reach real gh, tmux or ~/.maw. */
export const deps = {
  gh: runGh as (args: string[]) => Promise<GhResult>,
  localRepos: (): RepoRef[] => localGithubRepos(),
  rooms: (): Map<string, LiveRoom> => readLiveRooms(),
  read: (ch: ReplyChannel, lines: number): Promise<string> => readScreen(ch, lines),
  type: (ch: ReplyChannel, text: string): Promise<void> => typeInto(ch, text),
  chan: (ws: string, room: string): ReplyChannel | null => roomChannel(ws, room),
  notify: (sid: string, kind: string, msg: { title: string; body: string }): Promise<unknown> => notifyPhones(sid, kind, msg),
  configFile: join(homedir(), ".maw", "prs.json"),
  verdictDir: join(homedir(), ".maw", "pr-verdicts"),
  now: () => Date.now(),
};
export type PrsDeps = typeof deps;

// ── repos ────────────────────────────────────────────────────────

/** "git@github.com:o/r.git" · "https://github.com/o/r" · "ssh://git@github.com/o/r.git" → "o/r", else null. */
export function githubSlug(url: string): string | null {
  const m = /github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url ?? "").trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** GitHub slug from a .git/config text: origin first, else any github remote. */
export function slugFromGitConfig(text: string): string | null {
  const remotes: { name: string; url: string }[] = [];
  let cur: string | null = null;
  for (const line of String(text).split("\n")) {
    const sec = /^\s*\[remote\s+"([^"]+)"\]/.exec(line);
    if (sec) { cur = sec[1]; continue; }
    if (/^\s*\[/.test(line)) { cur = null; continue; }
    const u = cur && /^\s*url\s*=\s*(\S+)/.exec(line);
    if (u) remotes.push({ name: cur!, url: u[1] });
  }
  const gh = remotes.map(r => ({ ...r, slug: githubSlug(r.url) })).filter(r => r.slug);
  return (gh.find(r => r.name === "origin") ?? gh[0])?.slug ?? null;
}

function localGithubRepos(): RepoRef[] {
  const out: RepoRef[] = [], seen = new Set<string>();
  for (const r of scanRepos()) {
    let slug: string | null = null;
    try { slug = slugFromGitConfig(readFileSync(join(r.path, ".git", "config"), "utf-8")); } catch { continue; }   // worktrees (.git file) skipped
    if (!slug || seen.has(slug.toLowerCase())) continue;
    seen.add(slug.toLowerCase()); out.push({ repo: slug, path: r.path });
  }
  return out;
}

export function loadConfig(file = deps.configFile): PrsConfig {
  try {
    const d = JSON.parse(readFileSync(file, "utf-8"));
    return {
      extraRepos: Array.isArray(d.extraRepos) ? d.extraRepos.filter((s: any) => typeof s === "string" && SLUG_RE.test(s)) : [],
      auto: d.auto && typeof d.auto === "object" ? Object.fromEntries(Object.entries(d.auto).filter(([k, v]) => SLUG_RE.test(k) && v === true)) as Record<string, boolean> : {},
      reviewRoom: typeof d.reviewRoom === "string" && d.reviewRoom.trim() ? d.reviewRoom.trim() : null,
    };
  } catch { return { extraRepos: [], auto: {}, reviewRoom: null }; }
}
function saveConfig(cfg: PrsConfig, file = deps.configFile) {
  let raw: any = {}; try { raw = JSON.parse(readFileSync(file, "utf-8")); } catch { /* new */ }
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...raw, extraRepos: cfg.extraRepos, auto: cfg.auto, ...(cfg.reviewRoom ? { reviewRoom: cfg.reviewRoom } : {}) }, null, 2), { mode: 0o600 });
}

/** Local + extra + auto repos, deduped case-insensitively. */
export function allRepos(cfg: PrsConfig, local: RepoRef[]): RepoRef[] {
  const out = [...local], seen = new Set(local.map(r => r.repo.toLowerCase()));
  for (const s of [...cfg.extraRepos, ...Object.keys(cfg.auto)]) if (!seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push({ repo: s, path: null }); }
  return out;
}
const findRepo = (list: RepoRef[], repo: string) => list.find(r => r.repo.toLowerCase() === String(repo).toLowerCase()) ?? null;

// ── status (pure) ────────────────────────────────────────────────

export interface Checks { total: number; failed: number; pending: number }
/** statusCheckRollup → counts. CheckRun {status, conclusion} · StatusContext {state}. */
export function checkSummary(rollup: any[] | null | undefined): Checks {
  const c = { total: 0, failed: 0, pending: 0 };
  for (const x of rollup ?? []) {
    c.total++;
    if (x?.__typename === "StatusContext" || ("state" in (x ?? {}) && !("conclusion" in (x ?? {})))) {
      const s = String(x.state ?? "").toUpperCase();
      if (s === "FAILURE" || s === "ERROR") c.failed++;
      else if (s === "PENDING" || s === "EXPECTED") c.pending++;
      continue;
    }
    if (String(x?.status ?? "").toUpperCase() !== "COMPLETED") { c.pending++; continue; }
    if (/^(FAILURE|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE)$/i.test(String(x?.conclusion ?? ""))) c.failed++;
  }
  return c;
}

export type StatusCode = "draft" | "conflict" | "ci-failed" | "ci-running" | "changes" | "computing" | "behind" | "review" | "blocked" | "ready";
export interface PrStatus { code: StatusCode; text: string; ready: boolean; checks: Checks }

/** One short Thai line per PR, most important problem first. */
export function prStatus(pr: any): PrStatus {
  const checks = checkSummary(pr?.statusCheckRollup);
  const ms = String(pr?.mergeStateStatus ?? "").toUpperCase(), mg = String(pr?.mergeable ?? "").toUpperCase();
  const rd = String(pr?.reviewDecision ?? "").toUpperCase(), base = pr?.baseRefName || "base";
  const s = (code: StatusCode, text: string): PrStatus => ({ code, text, ready: code === "ready", checks });
  if (pr?.isDraft || ms === "DRAFT") return s("draft", "📝 draft");
  if (mg === "CONFLICTING" || ms === "DIRTY") return s("conflict", `⚠️ ชนกับ ${base} (conflict)`);
  if (checks.failed) return s("ci-failed", `❌ CI ล้ม ${checks.failed} ตัว`);
  if (checks.pending) return s("ci-running", `⏳ CI กำลังรัน (${checks.total - checks.pending}/${checks.total})`);
  if (rd === "CHANGES_REQUESTED") return s("changes", "✋ มีคนขอให้แก้");
  if (mg !== "MERGEABLE") return s("computing", "… GitHub กำลังเช็คว่า merge ได้ไหม");
  if (ms === "BEHIND") return s("behind", `⬇️ ตามหลัง ${base} ต้อง update branch`);
  if (rd === "REVIEW_REQUIRED") return s("review", "👀 รอรีวิว");
  if (ms === "BLOCKED") return s("blocked", "🔒 ติดกฎ branch protection");
  return s("ready", checks.total ? "✅ พร้อม merge" : "✅ พร้อม merge (ไม่มี CI)");
}

/** Why a merge must not go ahead (Thai), or null. `pr` = fresh `gh pr view` JSON. */
export function mergeBlock(pr: any): string | null {
  if (!pr) return "ไม่พบ PR นี้";
  if (pr.state && String(pr.state).toUpperCase() !== "OPEN") return `PR นี้ไม่ได้เปิดอยู่แล้ว (${pr.state})`;
  if (pr.isDraft) return "PR ยังเป็น draft — merge ไม่ได้";
  const mg = String(pr.mergeable ?? "").toUpperCase();
  if (mg === "CONFLICTING") return "ชนกับ base (conflict) — ต้องแก้ก่อน";
  if (mg !== "MERGEABLE") return "GitHub ยังเช็คไม่เสร็จว่า merge ได้ไหม — ลองใหม่อีกครู่";
  const c = checkSummary(pr.statusCheckRollup);
  if (c.failed) return `CI ล้ม ${c.failed} ตัว — merge ไม่ได้`;
  if (c.pending) return "CI ยังรันอยู่ — รอให้ผ่านก่อน";
  return null;
}

// ── verdicts (written by the AI) ─────────────────────────────────

export interface Verdict { verdict: "ready" | "blocked"; note: string; at: number }
export const verdictName = (repo: string, n: number) => `${repo.replace("/", "__")}__${n}.json`;

/** Validate one verdict file; `fallbackAt` (file mtime) is used when "at" is missing/bad. */
export function parseVerdict(text: string, fallbackAt = 0): Verdict | null {
  let d: any;
  try { d = JSON.parse(text); } catch { return null; }
  if (!d || (d.verdict !== "ready" && d.verdict !== "blocked")) return null;
  let note = typeof d.note === "string" ? d.note.replace(/\s+/g, " ").trim() : "";
  if (note.length > NOTE_MAX) note = note.slice(0, NOTE_MAX - 1).trimEnd() + "…";
  const at = typeof d.at === "string" && Number.isFinite(Date.parse(d.at)) ? Date.parse(d.at) : fallbackAt;
  if (!at) return null;
  return { verdict: d.verdict, note, at };
}

function readVerdict(repo: string, n: number, dir = deps.verdictDir): Verdict | null {
  const f = join(dir, verdictName(repo, n));
  try { return parseVerdict(readFileSync(f, "utf-8"), statSync(f).mtimeMs); } catch { return null; }
}

export interface PrVerdict extends Verdict { stale: boolean }
/** A verdict counts only if written after the PR's last update. */
export function attachVerdict(v: Verdict | null, updatedAt: string): PrVerdict | null {
  if (!v) return null;
  const u = Date.parse(updatedAt);
  return { ...v, stale: Number.isFinite(u) && v.at < u };
}

// ── list ─────────────────────────────────────────────────────────

export interface PrRow {
  number: number; title: string; author: string; head: string; base: string; url: string; updatedAt: string; isDraft: boolean;
  status: PrStatus; verdict: PrVerdict | null; reviewing: { at: number; room: string } | null;
}
export interface RepoRow { repo: string; auto: boolean; prs: PrRow[]; error?: string }
export interface PrList { at: number; repos: RepoRow[]; empty: number; errors: number }

interface Pending { repo: string; number: number; room: string; sid: string | null; at: number }
const pending = new Map<string, Pending>();
const keyOf = (repo: string, n: number) => `${repo.toLowerCase()}#${n}`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

async function mapLimit<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } }));
  return out;
}

export function toRow(pr: any, repo: string, d: PrsDeps = deps): PrRow {
  const p = pending.get(keyOf(repo, pr.number));
  const verdict = attachVerdict(readVerdict(repo, pr.number, d.verdictDir), pr.updatedAt);
  const live = p && d.now() - p.at < PENDING_MS && !(verdict && !verdict.stale && verdict.at >= p.at - 60_000) ? p : null;
  return {
    number: pr.number, title: String(pr.title ?? ""), author: pr.author?.login ?? "", head: pr.headRefName ?? "", base: pr.baseRefName ?? "",
    url: String(pr.url ?? ""), updatedAt: String(pr.updatedAt ?? ""), isDraft: !!pr.isDraft,
    status: prStatus(pr), verdict, reviewing: live ? { at: live.at, room: live.room } : null,
  };
}

let cache: { at: number; data: PrList } | null = null;
let inflight: Promise<PrList> | null = null;
export function resetCache() { cache = null; inflight = null; pending.clear(); }

export async function listPrs(fresh = false, d: PrsDeps = deps): Promise<PrList> {
  if (!fresh && cache && d.now() - cache.at < CACHE_MS) return refreshRows(cache.data, d);
  if (inflight) return inflight;
  inflight = (async () => {
    const cfg = loadConfig(d.configFile);
    const repos = allRepos(cfg, d.localRepos());
    const rows = await mapLimit(repos, CONCURRENCY, async (r): Promise<RepoRow> => {
      const auto = !!Object.keys(cfg.auto).find(k => k.toLowerCase() === r.repo.toLowerCase());
      try {
        const res = await d.gh(["pr", "list", "--repo", r.repo, "--state", "open", "--limit", "50", "--json", PR_FIELDS]);
        if (res.code !== 0) return { repo: r.repo, auto, prs: [], error: clip(res.stderr.trim() || `gh exit ${res.code}`, 160) };
        const list = JSON.parse(res.stdout || "[]");
        return { repo: r.repo, auto, prs: Array.isArray(list) ? list : [] };
      } catch (e: any) { return { repo: r.repo, auto, prs: [], error: clip(String(e?.message ?? e), 160) }; }
    });
    const raw: PrList = { at: d.now(), repos: rows, empty: 0, errors: 0 };
    cache = { at: raw.at, data: raw };
    return refreshRows(raw, d);
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Raw gh rows (cached) → rows with the latest verdict/pending state; repos with 0 PRs are only counted (auto ones stay). */
function refreshRows(raw: PrList, d: PrsDeps): PrList {
  const cfg = loadConfig(d.configFile);
  const isAuto = (repo: string) => !!Object.keys(cfg.auto).find(k => k.toLowerCase() === repo.toLowerCase());
  const repos: RepoRow[] = [];
  let empty = 0, errors = 0;
  for (const r of raw.repos) {
    if (r.error) errors++;
    const prs = r.prs.map((p: any) => toRow(p, r.repo, d)).sort((a, b) => +a.isDraft - +b.isDraft || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));   // drafts last
    const auto = isAuto(r.repo);
    if (!prs.length && !auto) { if (!r.error) empty++; continue; }
    repos.push({ repo: r.repo, auto, prs, ...(r.error ? { error: r.error } : {}) });
  }
  repos.sort((a, b) => b.prs.length - a.prs.length || a.repo.localeCompare(b.repo));
  return { at: raw.at, repos, empty, errors };
}

// ── review room ──────────────────────────────────────────────────

/** Nothing on screen that typing would disturb: no dialog, no spinner, empty input box. */
export function screenIdle(raw: string): boolean {
  return !parsePrompt(raw) && !parseMenu(raw) && !agentSpinner(raw) && !inputDraft(raw);
}
const busyStatus = (s: string | null) => !!s && /busy|work|run|think|wait|block|input|permission|ask/i.test(s);

export type RoomPick = { ok: true; ch: ReplyChannel; label: string; sid: string | null } | { ok: false; error: string };
/** reviewRoom from config, else an idle Claude room in tmux "team2-oracle", else any idle live Claude room. */
export async function pickReviewRoom(cfg: PrsConfig, d: PrsDeps = deps): Promise<RoomPick> {
  const live = [...d.rooms().values()].filter(r => r.channel);
  const idle = async (ch: ReplyChannel) => { try { return screenIdle(await d.read(ch, 60)); } catch { return false; } };
  if (cfg.reviewRoom) {
    let ch: ReplyChannel | null = null, sid: string | null = null, label = cfg.reviewRoom, status: string | null = null;
    // "tmux:<session>" survives Claude restarts (a new session id each time) — the room is the tmux session
    if (cfg.reviewRoom.startsWith("tmux:")) {
      const name = cfg.reviewRoom.slice(5), r = live.find(x => x.channel!.kind === "tmux" && x.channel!.label === name);
      if (r) { ch = r.channel; sid = r.sessionId; label = name; status = r.status; }
    } else if (cfg.reviewRoom.includes("/")) { const [ws, room] = cfg.reviewRoom.split("/"); ch = d.chan(ws, room); }
    else { const r = live.find(x => x.sessionId === cfg.reviewRoom); if (r) { ch = r.channel; sid = r.sessionId; label = r.name || r.channel!.label; status = r.status; } }
    if (!ch) return { ok: false, error: "ห้องตรวจที่ตั้งไว้ (reviewRoom ใน ~/.maw/prs.json) ไม่ได้เปิดอยู่" };
    if (busyStatus(status) || !(await idle(ch))) return { ok: false, error: `ห้องตรวจ ${label} ไม่ว่าง (กำลังทำงาน/มีหน้าถาม/มีข้อความค้างในช่องพิมพ์)` };
    return { ok: true, ch, label, sid };
  }
  const rank = (r: LiveRoom) => (r.channel!.kind === "tmux" && r.channel!.label === REVIEW_TMUX ? 0 : r.channel!.kind === "tmux" ? 1 : 2);
  for (const r of live.filter(x => !busyStatus(x.status)).sort((a, b) => rank(a) - rank(b))) {
    if (await idle(r.channel!)) return { ok: true, ch: r.channel!, label: r.name || r.channel!.label, sid: r.sessionId };
  }
  return { ok: false, error: "ไม่มีห้อง Claude ที่ว่าง (ทุกห้องกำลังทำงาน/มีหน้าถาม/มีข้อความค้าง) — ลองใหม่ทีหลัง" };
}

/** The one line typed into the review room. Review only — the room must never merge or push. */
export function reviewMessage(repo: string, n: number, url: string, dir = "~/.maw/pr-verdicts"): string {
  // /review-pr-check = the read-only twin of /review-pr (no fix / merge / deploy steps at all)
  return `/review-pr-check ตรวจ PR ${repo}#${n} (${url}) — ตรวจอย่างเดียว ห้าม merge ห้าม push ห้ามแก้ branch ห้ามคอมเมนต์ลง PR · เสร็จแล้วเขียนผลลงไฟล์ ${dir}/${verdictName(repo, n)} เป็น JSON {"verdict":"ready"|"blocked","note":"สรุปสั้น 1 บรรทัด ไทย","at":"<ISO>"}`;
}

export type ReviewResult = { ok: true; room: string; sid: string | null } | { ok: false; status: number; error: string };
export async function sendReview(repo: string, n: number, d: PrsDeps = deps): Promise<ReviewResult> {
  if (!SLUG_RE.test(repo) || !Number.isInteger(n) || n < 1) return { ok: false, status: 400, error: "repo/เลข PR ไม่ถูกต้อง" };
  const cfg = loadConfig(d.configFile);
  const known = findRepo(allRepos(cfg, d.localRepos()), repo);
  if (!known) return { ok: false, status: 404, error: "ไม่รู้จัก repo นี้ (ไม่มีในเครื่อง/ใน ~/.maw/prs.json)" };
  repo = known.repo;
  const p = pending.get(keyOf(repo, n));
  if (p && d.now() - p.at < PENDING_MS) return { ok: false, status: 409, error: `กำลังตรวจอยู่แล้วที่ห้อง ${p.room}` };
  const v = await d.gh(["pr", "view", String(n), "--repo", repo, "--json", "number,url,state"]);
  if (v.code !== 0) return { ok: false, status: 502, error: "อ่าน PR ไม่ได้: " + clip(v.stderr.trim(), 200) };
  let pr: any; try { pr = JSON.parse(v.stdout); } catch { return { ok: false, status: 502, error: "อ่าน PR ไม่ได้" }; }
  if (String(pr?.state).toUpperCase() !== "OPEN") return { ok: false, status: 409, error: `PR นี้ไม่ได้เปิดอยู่แล้ว (${pr?.state})` };
  const room = await pickReviewRoom(cfg, d);
  if (!room.ok) return { ok: false, status: 409, error: room.error };
  try { mkdirSync(d.verdictDir, { recursive: true }); } catch { /* the AI can create it */ }
  await d.type(room.ch, reviewMessage(repo, n, String(pr.url || `https://github.com/${repo}/pull/${n}`)));
  pending.set(keyOf(repo, n), { repo, number: n, room: room.label, sid: room.sid, at: d.now() });
  return { ok: true, room: room.label, sid: room.sid };
}

// ── auto review loop ─────────────────────────────────────────────

export interface AutoState { tried: Map<string, string>; told: Set<string> }
/** One pass: tell the phone about new verdicts, then send at most one PR of an auto repo for review. */
export async function autoPass(st: AutoState, d: PrsDeps = deps, quiet = false): Promise<{ notified: string[]; sent: string | null }> {
  const cfg = loadConfig(d.configFile);
  const data = await listPrs(false, d);
  const notified: string[] = [];
  for (const r of data.repos) for (const pr of r.prs) {
    const key = keyOf(r.repo, pr.number), v = pr.verdict, p = pending.get(key);
    if (!v || v.stale || !(r.auto || p)) continue;
    const tag = `${key}@${v.at}`;
    if (st.told.has(tag)) continue;
    st.told.add(tag);
    if (p && v.at >= p.at - 60_000) pending.delete(key);
    if (quiet) continue;
    const msg = v.verdict === "ready"
      ? { title: `✅ PR #${pr.number} พร้อม merge`, body: `${r.repo}${v.note ? " · " + v.note : ""}` }
      : { title: `❌ PR #${pr.number} ติด: ${v.note || "ดูรายละเอียดในห้องตรวจ"}`, body: r.repo };
    await d.notify(p?.sid ?? "prs", `pr:${key}`, msg).catch(() => {});
    notified.push(key);
  }
  const busy = [...pending.values()].some(p => d.now() - p.at < PENDING_MS);
  if (busy) return { notified, sent: null };
  for (const r of data.repos) {
    if (!r.auto) continue;
    for (const pr of [...r.prs].reverse()) {             // oldest update first
      const key = keyOf(r.repo, pr.number);
      if (pr.isDraft || (pr.verdict && !pr.verdict.stale) || pr.reviewing || st.tried.get(key) === pr.updatedAt) continue;
      st.tried.set(key, pr.updatedAt);                    // one try per PR version, even if the room was busy
      const res = await sendReview(r.repo, pr.number, d);
      if (!res.ok) { if (res.status === 409) st.tried.delete(key); return { notified, sent: null }; }   // no idle room → retry next pass
      await d.notify(res.sid ?? "prs", `pr:${key}`, { title: `🔀 ส่ง PR #${pr.number} ให้ AI ตรวจแล้ว · ${r.repo}`, body: `ห้อง ${res.room}` }).catch(() => {});
      return { notified, sent: key };
    }
  }
  return { notified, sent: null };
}

let looping = false;
function startLoop(): void {
  if (looping || process.env.NODE_ENV === "test") return;
  looping = true;
  const st: AutoState = { tried: new Map(), told: new Set() };
  let first = true, running = false;
  setInterval(async () => {
    if (running) return; running = true;
    try { await autoPass(st, deps, first); first = false; } catch { /* gh offline */ }   // first pass after a restart only remembers old verdicts
    finally { running = false; }
  }, AUTO_EVERY).unref?.();
}

// ── merge ────────────────────────────────────────────────────────

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeResult = { ok: true; text: string } | { ok: false; status: number; error: string };
export async function mergePr(repo: string, n: number, method: string, deleteBranch: boolean, d: PrsDeps = deps): Promise<MergeResult> {
  if (!SLUG_RE.test(repo) || !Number.isInteger(n) || n < 1) return { ok: false, status: 400, error: "repo/เลข PR ไม่ถูกต้อง" };
  if (!(MERGE_METHODS as readonly string[]).includes(method)) return { ok: false, status: 400, error: "วิธี merge ต้องเป็น squash / merge / rebase" };
  const known = findRepo(allRepos(loadConfig(d.configFile), d.localRepos()), repo);
  if (!known) return { ok: false, status: 404, error: "ไม่รู้จัก repo นี้" };
  repo = known.repo;
  const v = await d.gh(["pr", "view", String(n), "--repo", repo, "--json", "number,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,headRefOid"]);
  if (v.code !== 0) return { ok: false, status: 502, error: "อ่าน PR ไม่ได้: " + clip(v.stderr.trim(), 200) };
  let pr: any; try { pr = JSON.parse(v.stdout); } catch { return { ok: false, status: 502, error: "อ่าน PR ไม่ได้" }; }
  const why = mergeBlock(pr);
  if (why) return { ok: false, status: 409, error: why };
  // --match-head-commit: refuse if someone pushed between our check and the merge
  const args = ["pr", "merge", String(n), "--repo", repo, `--${method}`, ...(pr.headRefOid ? ["--match-head-commit", String(pr.headRefOid)] : []), ...(deleteBranch ? ["--delete-branch"] : [])];
  const res = await d.gh(args);
  cache = null;
  const text = clip(`${res.stdout}\n${res.stderr}`.trim(), 400);
  if (res.code !== 0) return { ok: false, status: 502, error: "merge ไม่สำเร็จ: " + (text || `gh exit ${res.code}`) };
  return { ok: true, text: text || `merge PR #${n} แล้ว` };
}

// ── routes ───────────────────────────────────────────────────────

export function mount(app: any, d: PrsDeps = deps): void {
  if (d === deps) startLoop();   // the real server only — tests pass their own deps
  app.get("/prs", async ({ query }: any) => {
    const data = await listPrs(query?.fresh === "1", d);
    return { ok: true, ...data };
  });
  app.post("/prs/review", async ({ body, set }: any) => {
    const r = await sendReview(String(body?.repo ?? ""), Number(body?.number), d);
    if (!r.ok) { set.status = r.status; return { ok: false, error: r.error }; }
    return { ok: true, room: r.room };
  });
  app.post("/prs/auto", ({ body, set }: any) => {
    const repo = String(body?.repo ?? "");
    if (!SLUG_RE.test(repo) || typeof body?.on !== "boolean") { set.status = 400; return { ok: false, error: "repo/on ไม่ถูกต้อง" }; }
    const cfg = loadConfig(d.configFile);
    const known = findRepo(allRepos(cfg, d.localRepos()), repo);
    if (!known) { set.status = 404; return { ok: false, error: "ไม่รู้จัก repo นี้" }; }
    for (const k of Object.keys(cfg.auto)) if (k.toLowerCase() === known.repo.toLowerCase()) delete cfg.auto[k];
    if (body.on) cfg.auto[known.repo] = true;
    saveConfig(cfg, d.configFile);
    return { ok: true, repo: known.repo, on: body.on };
  });
  app.post("/prs/merge", async ({ body, set }: any) => {
    const r = await mergePr(String(body?.repo ?? ""), Number(body?.number), String(body?.method ?? "squash"), body?.deleteBranch === true, d);
    if (!r.ok) { set.status = r.status; return { ok: false, error: r.error }; }
    return { ok: true, text: r.text };
  });
}
