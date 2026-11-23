// ext/quick-reply.js — free reply chips read from the agent's last message (no AI, no tokens)
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { runInNewContext } from "vm";

const load = () => { const ctx: any = { window: { mawExt: {} } }; runInNewContext(readFileSync(join(import.meta.dir, "../ui/mobile/ext/quick-reply.js"), "utf8"), ctx); return ctx.window.mawExt.quickReplies; };
const vals = (r: any[]) => r.map(x => x.value);

describe("quick-reply", () => {
  test("numbered choices + question → ข้อ N", () => {
    const q = load()("มี 4 ข้อที่ผมทำต่อได้เลยครับ\n\n1. **ส่งข้อเสนอนัดวันย้าย QA Tracker**\n2. **อัปเดตแผนจัดโฟลเดอร์ z620**\n3. ย้าย runner workspace-dev\n4. แก้ runner factorypro\n\nผมแนะนำ 1 → 2 ครับ จะให้เริ่มเลยไหม");
    expect(vals(q)).toEqual(["ข้อ 1", "ข้อ 2", "ข้อ 3", "ข้อ 4"]);
    expect(q[0].label.startsWith("1 · ส่งข้อเสนอ")).toBe(true);
  });
  test("ทาง ก/ข/ค named → ทำ ทาง X", () => {
    expect(vals(load()("| **ก. อ่านจากข้อความล่าสุด** | … |\n| ข. ให้ AI ช่วยคิด | … |\n\nผมแนะนำ **ทาง ก** ก่อน · ไม่เสีย token\n\nจะเอาทางไหนครับ, ทาง ข หรือ ทาง ค"))).toEqual(["ทำ ทาง ก", "ทำ ทาง ข", "ทำ ทาง ค"]);
  });
  test("closing yes/no question → ทำเลย · ยังไม่ต้อง", () => {
    expect(vals(load()("แก้เสร็จแล้ว ทดสอบผ่าน 26/26\n\nให้ผมทำข้อ 1 เลยไหมครับ"))).toEqual(["ทำเลย", "ยังไม่ต้อง ไว้ก่อน"]);
    expect(vals(load()("Tests pass. Should I open the PR?"))).toEqual(["ทำเลย", "ยังไม่ต้อง ไว้ก่อน"]);
  });
  test("commit push offered", () => {
    expect(vals(load()("ยังไม่ได้ commit · ถ้าโอเคแล้วบอก \"commit push\" ได้ครับ"))).toEqual(["commit push"]);
  });
  test("plain report / list without a question → nothing", () => {
    const q = load();
    expect(q("deploy เสร็จแล้ว ตรวจผ่านทุกข้อ\n1. หน้าแรก 200\n2. api 401")).toEqual([]);
    expect(q("")).toEqual([]);
    expect(q("```\n1. code\n2. block\n```\nเสร็จแล้ว")).toEqual([]);
  });
  test("which-question with a list gets only the choices (no ทำเลย)", () => {
    expect(vals(load()("มี 3 ทางครับ\n\n1. ย้าย runner\n2. ปล่อยไว้\n3. ปิดทิ้ง\n\nเอาข้อไหนครับ"))).toEqual(["ข้อ 1", "ข้อ 2", "ข้อ 3"]);
    expect(vals(load()("จะใช้ชื่อโดเมนอะไรดีครับ"))).toEqual([]);
  });
  test("never more than 4 chips", () => {
    expect(load()("เลือกข้อไหน\n1. a1\n2. b2\n3. c3\n4. d4\n5. e5\n6. f6\nเอาข้อไหน?").length).toBe(4);
  });
});
