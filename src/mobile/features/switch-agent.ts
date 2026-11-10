// Feature pack "switch-agent" — สลับ agent (Codex ↔ Claude) ในห้อง tmux โดยเปิดอีกตัวเป็นหน้าต่างใหม่
// ใน tmux session เดิม (ห้องเดิม) พร้อมวางบริบทจากจอห้องเดิมให้อ่านต่อได้ทันที
//
// ไม่ใช่ native session handoff ไร้รอยต่อแบบที่ ψ/incubate/.../continuity/ ตั้งใจทำ (ยังไม่เสร็จ ซับซ้อนเกินกำหนดเดิม) —
// นี่คือของที่ตรงสเปกเดิม "สลับแล้วยังอยู่ห้องเดิม" แบบใช้ได้จริง: ห้องเดิมยังอยู่ (ประวัติไม่หาย) ห้องใหม่เป็น
// หน้าต่างข้างๆ ใน session เดียวกัน ไม่ใช่ server/process แยกต่างหาก
//
// POST /mobile/rooms/:ws/:room/switch-agent { to: "claude" | "codex" }
//   → { ok, workspace: "tmux", room: <pane id ใหม่>, session, agent }
// รองรับเฉพาะห้อง tmux ในรุ่นแรก (ห้อง Superset/Herdr ยังไม่ทำ — ขอบเขตจงใจเล็กเพื่อให้ใช้ได้วันนี้)
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { listTmuxPanes, roomChannel, typeInto, readScreen, type TmuxPane } from "./ctx";

const TMUX = existsSync("/opt/homebrew/bin/tmux") ? "/opt/homebrew/bin/tmux" : "tmux";
const AGENTS = ["claude", "codex"] as const;
export type Agent = typeof AGENTS[number];

/** จอแสดงผลมี ANSI escape (สี/เคอร์เซอร์) ปนมา — ตัดออกก่อนเอาไปวางเป็นข้อความบริบท */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
}

const CONTEXT_MAX = 2000; // ตัดท้าย ไม่ใช่ตัดหัว — ส่วนที่คุยล่าสุดสำคัญกว่า
export function buildHandoffPrompt(fromLabel: string, screen: string): string {
  const clean = stripAnsi(screen).trim();
  const body = clean.length > CONTEXT_MAX ? "…" + clean.slice(-CONTEXT_MAX) : clean;
  return `[ต่อจากห้อง "${fromLabel}" — นี่คือบริบทล่าสุดจากจอเดิม ไม่ใช่คำสั่งใหม่]\n${body}\n[จบบริบท — ช่วยอ่านแล้วถามต่อ/ทำงานต่อได้เลย]`;
}

type Runner = (args: string[]) => string;
const realRun: Runner = args => execFileSync(TMUX, args, { encoding: "utf-8", timeout: 5_000 });

/** หน้าต่างใหม่ใน tmux session เดิม (ไม่สร้าง session ใหม่ ต่างจาก openTmuxRoom ใน api.ts ที่สร้าง session ชื่อ "mm-<โฟลเดอร์>") */
export function openWindowInSameSession(session: string, dir: string, agent: Agent, run: Runner = realRun): string {
  const pane = run(["new-window", "-P", "-F", "#{pane_id}", "-t", "=" + session + ":", "-c", dir, agent]).trim();
  if (!/^%\d+$/.test(pane)) throw new Error("tmux ไม่คืน pane id");
  return pane;
}

export function mount(app: any, deps: { panes?: typeof listTmuxPanes; run?: Runner; type?: typeof typeInto; screen?: typeof readScreen; delayMs?: number } = {}): void {
  const panes = deps.panes ?? listTmuxPanes, run = deps.run ?? realRun, type = deps.type ?? typeInto, screen = deps.screen ?? readScreen, delayMs = deps.delayMs ?? 4_000;

  app.post("/rooms/:ws/:room/switch-agent", async ({ params, body, set }: any) => {
    const to = String(body?.to ?? "");
    if (!AGENTS.includes(to as Agent)) { set.status = 400; return { ok: false, error: "เลือก agent ปลายทางไม่ถูกต้อง" }; }
    const ch = roomChannel(params.ws, params.room);
    if (!ch || ch.kind !== "tmux") { set.status = 400; return { ok: false, error: "ยังรองรับเฉพาะห้อง tmux" }; }

    const pane = panes().find((p: TmuxPane) => p.id === ch.pane);
    if (!pane) { set.status = 404; return { ok: false, error: "หาห้องนี้ไม่เจอ (อาจปิดไปแล้ว)" }; }
    if (pane.agent === to) { set.status = 400; return { ok: false, error: "ห้องนี้เป็น " + to + " อยู่แล้ว" }; }

    let context = "";
    try { context = await screen(ch, 80); } catch { /* ไม่มีบริบทก็เปิดห้องเปล่าได้ ไม่ critical */ }

    let newPane: string;
    try { newPane = openWindowInSameSession(pane.session, pane.cwd, to as Agent, run); }
    catch { set.status = 502; return { ok: false, error: "เปิดห้องใหม่ไม่สำเร็จ" }; }

    if (context.trim()) {
      const prompt = buildHandoffPrompt(pane.session, context);
      setTimeout(() => { type({ kind: "tmux", pane: newPane, label: newPane }, prompt).catch(() => { /* หน้าต่างอาจถูกปิดไปแล้วก่อนพิมพ์ทัน */ }); }, delayMs);
    }
    return { ok: true, workspace: "tmux", room: newPane, session: pane.session, agent: to };
  });
}
