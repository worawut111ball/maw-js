// Feature pack "leases" — 🗓️ เครื่องเช่า (server/VPS) ใกล้หมดสัญญา: การ์ดเตือนที่หน้าแรก (PLAN-maw-mobile.md §9).
// GET  /mobile/leases                              → { ok, items: [{id,label,provider,expiresAt,note?,daysLeft}], warnDays }
// POST /mobile/leases {id?,label,provider,expiresAt,note?,on}  → เพิ่ม/แก้ 1 รายการ · on:false = ลบ
// เก็บที่ ~/.maw/leases.json (เขียนแบบ atomic: tmp แล้ว rename กัน config เสียถ้าสลับระหว่างเขียน)
import { readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

const FILE = join(homedir(), ".maw", "leases.json");
export const WARN_DAYS = 30;           // แตะ "ใกล้หมด" (สีส้ม)
export const DANGER_DAYS = 7;          // แตะ "ใกล้มาก" (สีแดง)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[0-9a-z]{6,20}$/;

export interface Lease { id: string; label: string; provider: string; expiresAt: string; note?: string }
export interface LeaseWithDays extends Lease { daysLeft: number }

export function load(file = FILE): Lease[] {
  try { return JSON.parse(readFileSync(file, "utf-8")); } catch { return []; }
}
function save(items: Lease[], file = FILE) {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** วันที่เหลือ นับแบบ "วันที่ปฏิทิน" ล้วนๆ (เที่ยงคืนของวันหมดอายุ ลบเวลาปัจจุบัน แล้วปัดขึ้น) ไม่ใช่ 24 ชม.เป๊ะ. */
export function daysLeft(expiresAt: string, now = Date.now()): number {
  return Math.ceil((Date.parse(expiresAt + "T00:00:00") - now) / 86_400_000) || 0; // ceil(-0.x) → -0; normalize to 0
}

export function sanitize(x: any): Lease | null {
  const label = String(x?.label ?? "").trim().slice(0, 80);
  const provider = String(x?.provider ?? "").trim().slice(0, 80);
  const expiresAt = String(x?.expiresAt ?? "").trim();
  const noteRaw = x?.note != null ? String(x.note).trim().slice(0, 200) : "";
  if (!label || !provider || !DATE_RE.test(expiresAt) || Number.isNaN(Date.parse(expiresAt + "T00:00:00"))) return null;
  const id = ID_RE.test(String(x?.id ?? "")) ? String(x.id) : Date.now().toString(36) + randomBytes(3).toString("hex");
  return noteRaw ? { id, label, provider, expiresAt, note: noteRaw } : { id, label, provider, expiresAt };
}

export function mount(app: any, opts: { file?: string } = {}): void {
  const file = opts.file ?? FILE;

  app.get("/leases", () => {
    const items: LeaseWithDays[] = load(file)
      .map(l => ({ ...l, daysLeft: daysLeft(l.expiresAt) }))
      .sort((a, b) => a.daysLeft - b.daysLeft);
    return { ok: true, items, warnDays: WARN_DAYS, dangerDays: DANGER_DAYS };
  });

  app.post("/leases", ({ body, set }: any) => {
    const list = load(file);
    const id = String(body?.id ?? "");
    if (body?.on === false) {
      if (!ID_RE.test(id)) { set.status = 400; return { ok: false, error: "bad id" }; }
      const rest = list.filter(l => l.id !== id);
      save(rest, file);
      return { ok: true, items: rest };
    }
    const existing = id ? list.find(l => l.id === id) : undefined;
    const l = sanitize({ ...existing, ...body, id: id || undefined });
    if (!l) { set.status = 400; return { ok: false, error: "ต้องมีชื่อ ผู้ให้บริการ และวันหมดอายุ (YYYY-MM-DD)" }; }
    const rest = list.filter(x => x.id !== l.id);
    const next = [...rest, l];
    save(next, file);
    return { ok: true, items: next };
  });
}
