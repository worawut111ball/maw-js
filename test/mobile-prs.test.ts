import { beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  githubSlug, slugFromGitConfig, checkSummary, prStatus, mergeBlock, parseVerdict, attachVerdict, verdictName,
  screenIdle, pickReviewRoom, reviewMessage, sendReview, mergePr, listPrs, autoPass, resetCache, mount, loadConfig,
  type PrsDeps, type GhResult,
} from "../src/mobile/features/prs";

// gh pr list --json … samples (shape copied from a real read-only call, 22 ต.ค. 69)
const run = (conclusion: string | null, status = "COMPLETED") => ({ __typename: "CheckRun", name: "check", status, conclusion, workflowName: "CI" });
const PR = (o: any = {}) => ({
  number: 130, title: "fix(estimates): audit", author: { login: "dev" }, headRefName: "fix/x", baseRefName: "develop", isDraft: false,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "", statusCheckRollup: [run("SUCCESS")],
  updatedAt: "2026-10-22T15:47:44Z", url: "https://github.com/o/r/pull/130", ...o,
});

describe("repo slug", () => {
  test("remote url forms", () => {
    expect(githubSlug("git@github.com:Artron-Innovative-Co-Ltd/artron-erp.git")).toBe("Artron-Innovative-Co-Ltd/artron-erp");
    expect(githubSlug("https://github.com/worawut111ball/maw-js")).toBe("worawut111ball/maw-js");
    expect(githubSlug("ssh://git@github.com/o/r.js.git")).toBe("o/r.js");
    expect(githubSlug("https://gitlab.com/o/r.git")).toBeNull();
  });
  test("origin wins over other remotes", () => {
    const cfg = `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/up/r.git\n[remote "origin"]\n\turl = git@github.com:me/r.git\n[branch "main"]\n\tremote = origin`;
    expect(slugFromGitConfig(cfg)).toBe("me/r");
    expect(slugFromGitConfig(`[remote "origin"]\n\turl = https://gitlab.com/x/y`)).toBeNull();
  });
});

describe("status summary", () => {
  test("checks rollup", () => {
    expect(checkSummary([run("SUCCESS"), run("FAILURE"), run(null, "IN_PROGRESS"), { __typename: "StatusContext", state: "ERROR" }, run("SKIPPED")]))
      .toEqual({ total: 5, failed: 2, pending: 1 });
    expect(checkSummary(null)).toEqual({ total: 0, failed: 0, pending: 0 });
  });
  test("one line per state, most important first", () => {
    expect(prStatus(PR())).toMatchObject({ code: "ready", ready: true, text: "✅ พร้อม merge" });
    expect(prStatus(PR({ statusCheckRollup: [] })).text).toBe("✅ พร้อม merge (ไม่มี CI)");
    expect(prStatus(PR({ isDraft: true, mergeable: "CONFLICTING" })).text).toBe("📝 draft");
    expect(prStatus(PR({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })).text).toBe("⚠️ ชนกับ develop (conflict)");
    expect(prStatus(PR({ statusCheckRollup: [run("FAILURE"), run("TIMED_OUT")] })).text).toBe("❌ CI ล้ม 2 ตัว");
    expect(prStatus(PR({ statusCheckRollup: [run("SUCCESS"), run(null, "QUEUED")] })).text).toBe("⏳ CI กำลังรัน (1/2)");
    expect(prStatus(PR({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" })).text).toBe("👀 รอรีวิว");
    expect(prStatus(PR({ reviewDecision: "CHANGES_REQUESTED" })).code).toBe("changes");
    expect(prStatus(PR({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).ready).toBe(false);
    expect(prStatus(PR({ mergeStateStatus: "BEHIND" })).code).toBe("behind");
    expect(prStatus(PR({ mergeStateStatus: "BLOCKED" })).code).toBe("blocked");
  });
});

describe("verdicts", () => {
  test("shape is validated, note clipped to 140", () => {
    expect(parseVerdict('{"verdict":"ready","note":"ผ่านหมด","at":"2026-10-22T16:00:00Z"}')).toEqual({ verdict: "ready", note: "ผ่านหมด", at: Date.parse("2026-10-22T16:00:00Z") });
    expect(parseVerdict('{"verdict":"ok","note":"x","at":"2026-10-22T16:00:00Z"}')).toBeNull();
    expect(parseVerdict("not json")).toBeNull();
    expect(parseVerdict('{"verdict":"blocked","note":"x"}')).toBeNull();                 // no time at all
    expect(parseVerdict('{"verdict":"blocked","note":"x"}', 1234)?.at).toBe(1234);        // file mtime fallback
    const long = parseVerdict(JSON.stringify({ verdict: "blocked", note: "ก".repeat(300), at: "2026-10-22T16:00:00Z" }))!;
    expect(long.note.length).toBe(140);
    expect(long.note.endsWith("…")).toBe(true);
  });
  test("older than the PR's last update → stale", () => {
    const v = { verdict: "ready" as const, note: "", at: Date.parse("2026-10-22T15:00:00Z") };
    expect(attachVerdict(v, "2026-10-22T15:47:44Z")!.stale).toBe(true);
    expect(attachVerdict(v, "2026-10-22T14:00:00Z")!.stale).toBe(false);
    expect(attachVerdict(null, "x")).toBeNull();
    expect(verdictName("Artron-Innovative-Co-Ltd/artron-erp", 7)).toBe("Artron-Innovative-Co-Ltd__artron-erp__7.json");
  });
  test("review message forbids merge/push", () => {
    const m = reviewMessage("o/r", 5, "https://github.com/o/r/pull/5");
    expect(m.startsWith("/review-pr-check ตรวจ PR o/r#5 (https://github.com/o/r/pull/5)")).toBe(true);
    expect(m).toContain("ตรวจอย่างเดียว ห้าม merge ห้าม push");
    expect(m).toContain("~/.maw/pr-verdicts/o__r__5.json");
    expect(m.includes("\n")).toBe(false);
  });
});

// ── fakes ──
const E = "\x1b";
const IDLE = `⏺ เสร็จแล้ว\n\n${"─".repeat(40)}\n❯ \n${"─".repeat(40)}\n  ? for shortcuts\n`;
const DRAFT = `⏺ เสร็จแล้ว\n${"─".repeat(40)}\n${E}[39m❯ ${E}[39mเอา ข. เซ็นคนเดียวเลย\n${"─".repeat(40)}\n`;
const WORKING = `⏺ อ่านไฟล์\n✻ Thinking… (12s · esc to interrupt)\n${"─".repeat(40)}\n❯ \n`;
const DIALOG = ` Bash command\n\n   rm -rf x\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n`;

function fakes(o: { screens?: Record<string, string>; rooms?: any[]; gh?: (a: string[]) => GhResult; cfg?: any } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prs-"));
  const configFile = join(dir, "prs.json"), verdictDir = join(dir, "verdicts");
  if (o.cfg) writeFileSync(configFile, JSON.stringify(o.cfg));
  const typed: { pane: string; text: string }[] = [], ghCalls: string[][] = [], notes: any[] = [];
  const rooms = new Map((o.rooms ?? []).map(r => [r.sessionId, r]));
  const d: PrsDeps = {
    gh: async a => { ghCalls.push(a); return o.gh ? o.gh(a) : { code: 0, stdout: "[]", stderr: "" }; },
    localRepos: () => [{ repo: "o/r", path: "/tmp/r" }, { repo: "o/empty", path: "/tmp/e" }],
    rooms: () => rooms as any,
    read: async (ch: any) => o.screens?.[ch.pane ?? ch.terminalId] ?? IDLE,
    type: async (ch: any, text) => { typed.push({ pane: ch.pane ?? ch.terminalId, text }); },
    chan: (ws, room) => (ws === "tmux" && /^%\d+$/.test(room) ? { kind: "tmux", pane: room, label: room } : null),
    notify: async (sid, kind, msg) => { notes.push({ sid, kind, ...msg }); },
    configFile, verdictDir, now: () => Date.now(),
  };
  return { d, typed, ghCalls, notes, verdictDir, configFile };
}
const room = (sid: string, pane: string, label: string, status: string | null = "idle") => ({ pid: 1, sessionId: sid, status, name: null, channel: { kind: "tmux", pane, label } });

beforeEach(() => resetCache());

describe("review room", () => {
  test("screen idle = no dialog, no spinner, empty box", () => {
    expect(screenIdle(IDLE)).toBe(true);
    expect(screenIdle(DRAFT)).toBe(false);
    expect(screenIdle(WORKING)).toBe(false);
    expect(screenIdle(DIALOG)).toBe(false);
  });
  test("prefers team2-oracle, skips busy rooms", async () => {
    const { d } = fakes({ rooms: [room("a", "%1", "team1-oracle"), room("b", "%2", "team2-oracle"), room("c", "%3", "team2-oracle", "busy")] });
    const r = await pickReviewRoom(loadConfig(d.configFile), d);
    expect(r.ok && r.label).toBe("team2-oracle");
    expect(r.ok && r.sid).toBe("b");
  });
  test("refuses when every room is busy, has a dialog or a half-typed draft", async () => {
    const { d } = fakes({ rooms: [room("a", "%1", "team1-oracle"), room("b", "%2", "team2-oracle"), room("c", "%3", "x")], screens: { "%1": DRAFT, "%2": DIALOG, "%3": WORKING } });
    const r = await pickReviewRoom(loadConfig(d.configFile), d);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("ไม่มีห้อง Claude ที่ว่าง");
  });
  test("configured reviewRoom is the only choice", async () => {
    const { d } = fakes({ cfg: { reviewRoom: "a" }, rooms: [room("a", "%1", "team1-oracle"), room("b", "%2", "team2-oracle")], screens: { "%1": WORKING } });
    const r = await pickReviewRoom(loadConfig(d.configFile), d);
    expect(r.ok).toBe(false);
    const gone = fakes({ cfg: { reviewRoom: "zzz" }, rooms: [room("b", "%2", "team2-oracle")] });
    expect((await pickReviewRoom(loadConfig(gone.d.configFile), gone.d)).ok).toBe(false);
  });
  test("reviewRoom tmux:<session> locks to that tmux session (new Claude ids keep working) and never falls back", async () => {
    const ok = fakes({ cfg: { reviewRoom: "tmux:team2-oracle" }, rooms: [room("a", "%1", "team1-oracle"), room("new-id", "%2", "team2-oracle")] });
    const r = await pickReviewRoom(loadConfig(ok.d.configFile), ok.d);
    expect(r.ok && r.label).toBe("team2-oracle");
    const busy = fakes({ cfg: { reviewRoom: "tmux:team2-oracle" }, rooms: [room("a", "%1", "team1-oracle"), room("b", "%2", "team2-oracle")], screens: { "%2": WORKING } });
    const b = await pickReviewRoom(loadConfig(busy.d.configFile), busy.d);
    expect(b.ok).toBe(false);   // team1 is idle, but it must not be used
  });
  test("sendReview types one line and remembers it; 2nd tap → 409", async () => {
    const f = fakes({ rooms: [room("b", "%2", "team2-oracle")], gh: a => a[1] === "view" ? { code: 0, stdout: JSON.stringify({ number: 5, url: "https://github.com/o/r/pull/5", state: "OPEN" }), stderr: "" } : { code: 0, stdout: "[]", stderr: "" } });
    const r = await sendReview("o/r", 5, f.d);
    expect(r.ok).toBe(true);
    expect(f.typed).toHaveLength(1);
    expect(f.typed[0].pane).toBe("%2");
    expect(f.typed[0].text).toContain("ห้าม merge ห้าม push");
    expect(f.ghCalls.some(a => a.includes("merge"))).toBe(false);
    const again = await sendReview("o/r", 5, f.d);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.status).toBe(409);
  });
  test("unknown repo / closed PR / no idle room are refused without typing", async () => {
    const f = fakes({ rooms: [room("b", "%2", "team2-oracle")], screens: { "%2": WORKING }, gh: () => ({ code: 0, stdout: JSON.stringify({ number: 5, url: "u", state: "OPEN" }), stderr: "" }) });
    expect((await sendReview("x/unknown", 5, f.d)).ok).toBe(false);
    const busy = await sendReview("o/r", 5, f.d);
    expect(!busy.ok && busy.status).toBe(409);
    const closed = fakes({ rooms: [room("b", "%2", "team2-oracle")], gh: () => ({ code: 0, stdout: JSON.stringify({ number: 6, url: "u", state: "MERGED" }), stderr: "" }) });
    expect((await sendReview("o/r", 6, closed.d)).ok).toBe(false);
    expect(f.typed.length + closed.typed.length).toBe(0);
  });
});

describe("merge guard", () => {
  test("pure refusals", () => {
    expect(mergeBlock(PR({ state: "OPEN" }))).toBeNull();
    expect(mergeBlock(PR({ isDraft: true }))).toContain("draft");
    expect(mergeBlock(PR({ mergeable: "CONFLICTING" }))).toContain("conflict");
    expect(mergeBlock(PR({ mergeable: "UNKNOWN" }))).toContain("ลองใหม่");
    expect(mergeBlock(PR({ statusCheckRollup: [run("FAILURE")] }))).toContain("CI ล้ม 1 ตัว");
    expect(mergeBlock(PR({ statusCheckRollup: [run(null, "IN_PROGRESS")] }))).toContain("CI ยังรัน");
    expect(mergeBlock(PR({ state: "MERGED" }))).toContain("ไม่ได้เปิดอยู่");
  });
  test("refused PR never reaches `gh pr merge`", async () => {
    for (const bad of [{ isDraft: true }, { mergeable: "CONFLICTING" }, { statusCheckRollup: [run("FAILURE")] }]) {
      const f = fakes({ gh: a => ({ code: 0, stdout: JSON.stringify(PR({ state: "OPEN", ...bad })), stderr: "" }) });
      const r = await mergePr("o/r", 130, "squash", false, f.d);
      expect(r.ok).toBe(false);
      expect(f.ghCalls.some(a => a[1] === "merge")).toBe(false);
    }
  });
  test("bad method / unknown repo refused before gh", async () => {
    const f = fakes();
    expect((await mergePr("o/r", 1, "admin", false, f.d)).ok).toBe(false);
    expect((await mergePr("x/y", 1, "squash", false, f.d)).ok).toBe(false);
    expect(f.ghCalls).toHaveLength(0);
  });
  test("ok PR → gh pr merge with method + head commit, no --admin", async () => {
    const f = fakes({ gh: a => a[1] === "view" ? { code: 0, stdout: JSON.stringify(PR({ state: "OPEN", headRefOid: "abc123" })), stderr: "" } : { code: 0, stdout: "✓ Squashed and merged", stderr: "" } });
    const r = await mergePr("o/r", 130, "squash", true, f.d);
    expect(r.ok).toBe(true);
    const m = f.ghCalls.find(a => a[1] === "merge")!;
    expect(m).toEqual(["pr", "merge", "130", "--repo", "o/r", "--squash", "--match-head-commit", "abc123", "--delete-branch"]);
    expect(m.includes("--admin")).toBe(false);
  });
});

describe("list + routes", () => {
  const listGh = (a: string[]): GhResult => a[1] === "list" && a[3] === "o/r"
    ? { code: 0, stdout: JSON.stringify([PR(), PR({ number: 131, isDraft: true, updatedAt: "2026-10-22T10:00:00Z" })]), stderr: "" }
    : { code: 0, stdout: "[]", stderr: "" };
  test("groups by repo, empty repos only counted, verdict attached", async () => {
    const f = fakes({ gh: listGh });
    const { mkdirSync } = await import("fs");
    mkdirSync(f.verdictDir, { recursive: true });
    writeFileSync(join(f.verdictDir, "o__r__130.json"), JSON.stringify({ verdict: "blocked", note: "ขาด ALTER คอลัมน์ใหม่", at: "2026-10-22T16:00:00Z" }));
    const app = new Elysia({ prefix: "/mobile" }); mount(app, f.d);
    const res = await (await app.handle(new Request("http://localhost/mobile/prs"))).json();
    expect(res.ok).toBe(true);
    expect(res.empty).toBe(1);
    expect(res.repos).toHaveLength(1);
    expect(res.repos[0].repo).toBe("o/r");
    expect(res.repos[0].prs.map((p: any) => p.number)).toEqual([130, 131]);
    expect(res.repos[0].prs[0].verdict).toMatchObject({ verdict: "blocked", stale: false });
    expect(res.repos[0].prs[1].status.text).toBe("📝 draft");
  });
  test("auto toggle saves config; merge route refuses with Thai error", async () => {
    const f = fakes({ gh: a => a[1] === "view" ? { code: 0, stdout: JSON.stringify(PR({ state: "OPEN", isDraft: true })), stderr: "" } : { code: 0, stdout: "[]", stderr: "" } });
    const app = new Elysia({ prefix: "/mobile" }); mount(app, f.d);
    const post = (p: string, b: any) => app.handle(new Request("http://localhost/mobile" + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
    expect((await post("/prs/auto", { repo: "o/r", on: true })).status).toBe(200);
    expect(JSON.parse(readFileSync(f.configFile, "utf-8")).auto).toEqual({ "o/r": true });
    expect((await post("/prs/auto", { repo: "nope/x", on: true })).status).toBe(404);
    const m = await post("/prs/merge", { repo: "o/r", number: 130, method: "squash" });
    expect(m.status).toBe(409);
    expect((await m.json()).error).toContain("draft");
  });
  test("auto pass: sends one PR, then notifies its verdict once", async () => {
    const f = fakes({ cfg: { auto: { "o/r": true } }, rooms: [room("b", "%2", "team2-oracle")],
      gh: a => a[1] === "view" ? { code: 0, stdout: JSON.stringify({ number: 130, url: "u", state: "OPEN" }), stderr: "" } : listGh(a) });
    const st = { tried: new Map(), told: new Set<string>() };
    const p1 = await autoPass(st, f.d);
    expect(p1.sent).toBe("o/r#130");                       // the draft #131 is skipped
    expect(f.typed).toHaveLength(1);
    expect(f.notes[0].title).toContain("🔀 ส่ง PR #130");
    const p2 = await autoPass(st, f.d);
    expect(p2.sent).toBeNull();                           // one at a time while pending
    const { mkdirSync } = await import("fs");
    mkdirSync(f.verdictDir, { recursive: true });
    writeFileSync(join(f.verdictDir, "o__r__130.json"), JSON.stringify({ verdict: "ready", note: "ok", at: new Date().toISOString() }));
    const p3 = await autoPass(st, f.d);
    expect(p3.notified).toEqual(["o/r#130"]);
    expect(f.notes.at(-1).title).toBe("✅ PR #130 พร้อม merge");
    expect((await autoPass(st, f.d)).notified).toEqual([]);
    expect(f.typed).toHaveLength(1);
  });
  test("list is cached; ?fresh bypasses", async () => {
    const f = fakes({ gh: listGh });
    await listPrs(false, f.d); const n = f.ghCalls.length;
    await listPrs(false, f.d); expect(f.ghCalls.length).toBe(n);
    await listPrs(true, f.d); expect(f.ghCalls.length).toBe(2 * n);
  });
});
