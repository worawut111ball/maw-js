// Feature pack "switch-agent" — สลับ agent (Codex ↔ Claude) ในห้อง tmux เดิม (tmux session เดิม)
//
// - ไปครั้งแรก: เปิดอีกตัวเป็นหน้าต่างใหม่ใน session เดิม แล้วส่งบริบทล่าสุดของห้องต้นทางเข้าไป
// - สลับกลับ: ถ้าใน session เดิมมีตัวปลายทางเปิดค้างอยู่แล้ว → กลับไปตัวนั้น (ไม่เปิดบานใหม่) แล้วส่งสรุปว่า
//   อีกตัวทำอะไรไประหว่างนั้น → สลับไปกลับได้เรื่อยๆ จบที่ 2 หน้าต่าง และแต่ละตัวรู้ว่าอีกตัวทำอะไร
// - บริบท: ประวัติแชทจริง (คำถาม/คำตอบล่าสุด ไม่มีผล tool) ถ้าหา transcript ได้ · ไม่ได้ (เช่น Codex ใน tmux) → ใช้จอแทน
//
// ไม่ใช่ native session handoff แบบ timeline เดียว (งาน continuity พักไว้ — ซับซ้อนเกินสเปกเดิม) แค่ของที่ใช้ได้จริง
//
// POST /mobile/rooms/:ws/:room/switch-agent { to: "claude" | "codex" }
//   → { ok, workspace: "tmux", room: <pane ปลายทาง>, session, agent, reused, context: "chat" | "screen" | "none" }
// รองรับเฉพาะห้อง tmux (ห้อง Superset/Herdr ยังไม่ทำ)
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { claudeTranscript, listTmuxPanes, readLiveRooms, readScreen, roomChannel, typeInto, type ChatItem, type TmuxPane } from "./ctx";

const TMUX = existsSync("/opt/homebrew/bin/tmux") ? "/opt/homebrew/bin/tmux" : "tmux";
const AGENTS = ["claude", "codex"] as const;
export type Agent = typeof AGENTS[number];
const NAME: Record<Agent, string> = { claude: "Claude", codex: "Codex" };

/** จอแสดงผลมี ANSI escape (สี/เคอร์เซอร์) ปนมา — ตัดออกก่อนเอาไปวางเป็นข้อความบริบท */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
}

const CONTEXT_MAX = 6000;   // ตัดหัว เก็บท้าย — ส่วนที่คุยล่าสุดสำคัญกว่า
const TURNS = 20, TURN_MAX = 800;
const tail = (s: string, n: number) => s.length > n ? "…" + s.slice(-n) : s;

/** คำถาม/คำตอบล่าสุดจากประวัติแชท (ไม่เอาผล tool, ข้อความที่ยกเลิก/ค้างคิว) → ข้อความอ่านง่าย */
export function turnsToText(items: ChatItem[], agentName: string): string {
  const turns = items.filter(m => (m.role === "user" || m.role === "assistant") && m.text?.trim() && !m.canceled && !m.queued).slice(-TURNS);
  const text = turns.map(m => `${m.role === "user" ? "คุณ" : agentName}: ${m.text!.trim().length > TURN_MAX ? m.text!.trim().slice(0, TURN_MAX) + "…" : m.text!.trim()}`).join("\n\n");
  return tail(text, CONTEXT_MAX);
}

export function buildHandoffPrompt(from: { agent: string; label: string }, body: string, kind: "chat" | "screen", returning: boolean): string {
  const head = returning
    ? `[สลับกลับมาจาก ${from.agent} (ห้อง "${from.label}") — ระหว่างนั้น ${from.agent} ทำงานต่อจากคุณ นี่คือ${kind === "chat" ? "บทสนทนาล่าสุดฝั่งนั้น" : "จอล่าสุดฝั่งนั้น"} ไม่ใช่คำสั่งใหม่]`
    : `[ต่อจาก ${from.agent} ในห้อง "${from.label}" — นี่คือ${kind === "chat" ? "บทสนทนาล่าสุด" : "จอล่าสุด"}ของห้องเดิม ไม่ใช่คำสั่งใหม่]`;
  return `${head}\n${body}\n[จบบริบท — อ่านแล้วทำงานต่อ หรือถามผู้ใช้ว่าจะให้ทำอะไรต่อ]`;
}

type Runner = (args: string[]) => string;
const realRun: Runner = args => execFileSync(TMUX, args, { encoding: "utf-8", timeout: 5_000 });

/** หน้าต่างใหม่ใน tmux session เดิม (ไม่สร้าง session ใหม่ ต่างจาก openTmuxRoom ใน api.ts ที่สร้าง session ชื่อ "mm-<โฟลเดอร์>") */
export function openWindowInSameSession(session: string, dir: string, agent: Agent, run: Runner = realRun): string {
  const pane = run(["new-window", "-P", "-F", "#{pane_id}", "-t", "=" + session + ":", "-c", dir, agent]).trim();
  if (!/^%\d+$/.test(pane)) throw new Error("tmux ไม่คืน pane id");
  return pane;
}

/** ตัวปลายทางที่เปิดค้างอยู่แล้วใน session เดียวกัน (โฟลเดอร์เดียวกันก่อน) — สลับกลับไปหาตัวนี้แทนเปิดบานใหม่ */
export function findExisting(all: TmuxPane[], from: TmuxPane, to: Agent): TmuxPane | undefined {
  const same = all.filter(p => p.session === from.session && p.agent === to && p.id !== from.id);
  return same.find(p => p.cwd === from.cwd) ?? same[0];
}

interface Deps {
  panes?: typeof listTmuxPanes; run?: Runner; type?: typeof typeInto; screen?: typeof readScreen;
  liveRooms?: typeof readLiveRooms; transcript?: typeof claudeTranscript; delayMs?: number;
}

export function mount(app: any, deps: Deps = {}): void {
  const panes = deps.panes ?? listTmuxPanes, run = deps.run ?? realRun, type = deps.type ?? typeInto, screen = deps.screen ?? readScreen;
  const liveRooms = deps.liveRooms ?? readLiveRooms, transcript = deps.transcript ?? claudeTranscript, delayMs = deps.delayMs ?? 4_000;

  /** บริบทของห้องต้นทาง: ประวัติแชทถ้ามี (Claude ที่มี live room ผูก pane นี้) ไม่งั้นจอ */
  async function contextOf(pane: TmuxPane): Promise<{ body: string; kind: "chat" | "screen" | "none" }> {
    const name = NAME[pane.agent as Agent] ?? "agent";
    try {
      const live = [...liveRooms().values()].find(r => r.channel?.kind === "tmux" && r.channel.pane === pane.id);
      const items = live ? transcript(live.sessionId) : null;
      const body = items ? turnsToText(items, name) : "";
      if (body.trim()) return { body, kind: "chat" };
    } catch { /* ไปใช้จอแทน */ }
    try {
      const body = tail(stripAnsi(await screen({ kind: "tmux", pane: pane.id, label: pane.id }, 80)).trim(), CONTEXT_MAX);
      if (body) return { body, kind: "screen" };
    } catch { /* ไม่มีบริบทก็สลับได้ ไม่ critical */ }
    return { body: "", kind: "none" };
  }

  app.post("/rooms/:ws/:room/switch-agent", async ({ params, body, set }: any) => {
    const to = String(body?.to ?? "") as Agent;
    if (!AGENTS.includes(to)) { set.status = 400; return { ok: false, error: "เลือก agent ปลายทางไม่ถูกต้อง" }; }
    const ch = roomChannel(params.ws, params.room);
    if (!ch || ch.kind !== "tmux") { set.status = 400; return { ok: false, error: "ยังรองรับเฉพาะห้อง tmux" }; }

    const all = panes();
    const pane = all.find(p => p.id === ch.pane);
    if (!pane) { set.status = 404; return { ok: false, error: "หาห้องนี้ไม่เจอ (อาจปิดไปแล้ว)" }; }
    if (pane.agent === to) { set.status = 400; return { ok: false, error: "ห้องนี้เป็น " + NAME[to] + " อยู่แล้ว" }; }

    const ctx = await contextOf(pane);
    const existing = findExisting(all, pane, to);
    let target: string;
    if (existing) target = existing.id;
    else {
      try { target = openWindowInSameSession(pane.session, pane.cwd, to, run); }
      catch { set.status = 502; return { ok: false, error: "เปิดห้องใหม่ไม่สำเร็จ" }; }
    }

    if (ctx.kind !== "none") {
      const prompt = buildHandoffPrompt({ agent: NAME[pane.agent as Agent] ?? "agent", label: pane.session }, ctx.body, ctx.kind, !!existing);
      const send = () => type({ kind: "tmux", pane: target, label: target }, prompt).catch(() => { /* หน้าต่างอาจถูกปิดไปก่อนพิมพ์ทัน */ });
      if (existing) await send();            // ตัวเดิมพร้อมอยู่แล้ว ส่งเลย
      else setTimeout(send, delayMs);        // ตัวใหม่ต้องรอเปิดเสร็จก่อน
    }
    return { ok: true, workspace: "tmux", room: target, session: pane.session, agent: to, reused: !!existing, context: ctx.kind };
  });
}
