// ext/mind-route.js — "📤 ส่งให้ห้อง agent" ranking + the forwarded chat text (pure · no DOM, no network)
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { runInNewContext } from "vm";

function load() {
  const ctx: any = { window: { mawExt: {} } };
  runInNewContext(readFileSync(join(import.meta.dir, "../ui/mobile/ext/mind-route.js"), "utf8"), ctx);
  return ctx.window.mawExt.mindRoute;
}
const room = (id: string, title: string, agent: string | null, status = "idle", extra: any = {}) => ({ id, title, agent, status, ...extra });
const PROJECTS = [
  { name: "artron-workspace", source: "superset", workspaces: [{ id: "ws-aw", rooms: [room("r1", "ERP ใหม่ prod", "claude"), room("r2", "terminal", null)] }] },
  { name: "facwms", source: "superset", workspaces: [{ id: "ws-fw", rooms: [room("r3", "aisin", "codex"), room("r4", "jtekt7", "codex", "asleep")] }] },
  { name: "qa-tracker", source: "superset", workspaces: [{ id: "ws-qa", rooms: [room("r5", "Claude Code", "claude", "ended")] }] },
  { name: "herdr", source: "herdr", workspaces: [{ id: "herdr:w1", rooms: [room("r6", "มาร์ค 1", "claude", "working", { generation: "g7" })] }] },
];
const MAIL = { id: "m1", from: "jinmom", fromOwner: "", to: "ball-agent", subject: "ERP ใหม่ระบบจริง (workspace.artron.app) · artron-workspace", body: "ขอสถานะเครื่องจริง" };

describe("mind-route", () => {
  test("only Claude/Codex rooms that have not ended", () => {
    const r = load().rankRooms(PROJECTS, MAIL, {});
    expect(r.map((x: any) => x.room).sort()).toEqual(["r1", "r3", "r4", "r6"]);
  });

  test("project named in the mail ranks first and is suggested; generation kept for Herdr", () => {
    const R = load(), r = R.rankRooms(PROJECTS, MAIL, {});
    expect(r[0]).toMatchObject({ room: "r1", project: "artron-workspace", ws: "ws-aw" });
    expect(r[0].why.join(" ")).toContain("artron-workspace");
    expect(R.suggestedCount(r)).toBe(1);
    expect(r.find((x: any) => x.room === "r6").generation).toBe("g7");
  });

  test("remembered room for this sender beats a name match; sleeping room says so", () => {
    const R = load(), r = R.rankRooms(PROJECTS, MAIL, { jinmom: { ws: "ws-fw", room: "r4" } });
    expect(r[0].room).toBe("r4");
    expect(r[0].why.join(" ")).toContain("เคยส่งเรื่องจาก jinmom");
    expect(r[0].why.join(" ")).toContain("หลับ");
    expect(R.suggestedCount(r)).toBe(2);
  });

  test("Thai room title in the mail counts (มาร์ค 1)", () => {
    const r = load().rankRooms(PROJECTS, { ...MAIL, subject: "ฝากมาร์ค 1 ดูหน่อย", body: "" }, {});
    expect(r[0].room).toBe("r6");
  });

  test("whole words only (cli ≠ client) · tmux source name ignored · ไอ้แดง → team1 room", () => {
    const P = [
      { name: "artron-cli", workspaces: [{ id: "w1", rooms: [room("a", "Claude Code", "claude")] }] },
      { name: "tmux", source: "tmux", workspaces: [{ id: "tmux", rooms: [room("%1", "team1-oracle", "claude"), room("%2", "team2-oracle", "claude")] }] },
    ];
    const r = load().rankRooms(P, { id: "m", from: "jinmom", subject: "ถึงไอ้แดง · client prod", body: "อยู่ใน tmux" }, {});
    expect(r[0].room).toBe("%1");
    expect(r.find((x: any) => x.room === "a").score).toBeLessThan(8);
    expect(r.find((x: any) => x.room === "%2").score).toBeLessThan(8);
  });

  test("no signal → nothing suggested, live rooms before sleeping ones", () => {
    const R = load(), r = R.rankRooms(PROJECTS, { id: "m2", from: "x", subject: "hello", body: "" }, {});
    expect(R.suggestedCount(r)).toBe(0);
    expect(r[r.length - 1].room).toBe("r4");
    expect(R.rankRooms(null, MAIL, null)).toEqual([]);
  });

  test("forwardText carries sender, subject, body, id and fits the 8000-char send limit", () => {
    const R = load();
    const t = R.forwardText(MAIL);
    expect(t).toContain("jinmom"); expect(t).toContain(MAIL.subject); expect(t).toContain("ขอสถานะเครื่องจริง"); expect(t).toContain("m1");
    const long = R.forwardText({ ...MAIL, body: "ก".repeat(20000) });
    expect(long.length).toBeLessThanOrEqual(R.TEXT_MAX);
    expect(long).toContain("ตัดท้าย");
  });
});
