# Mobile API

`api.ts` สร้าง authenticated Mobile API สำหรับ UI ของ maw; การ import ไม่เปิด HTTP server

## Host inventory seam

8 พ.ย. 69 — `createMobileApi(config, {projectInventory})` รับ trusted constructor callback แบบ read-only คืน `Project[]`. เมื่อกำหนด callback จะไม่เรียก Superset/tmux/Herdr discovery ใน `/mobile/projects`; ยังตรวจ auth และรวม owned registry ด้วย `mergeOwnedInventory` เดิม Callback ล้มคืน sanitized 503 ไม่ fallback ไปสำรวจห้องจริง

ใช้สำหรับ host ที่กำหนดขอบเขตห้องเองและ integration tests ผ่าน API handler จริง ไม่รับ callback จาก HTTP หรือ config JSON ไม่ทำให้ห้องที่แสดงได้รับสิทธิ์ส่งข้อความ เมื่อไม่กำหนด callback ใช้ discovery เดิม

## ตรวจสอบ

`bun test test/mobile-project-inventory-host.test.ts` ตรวจ real in-process API/auth/projection ด้วย local fixtures ไม่มี server/native/model

## ประวัติ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex root | เพิ่ม read-only host inventory seam สำหรับ scoped API integration |

## แชท Codex ที่ fork มา — 19 พ.ย. 69

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 19 พ.ย. 69 | หล่อรอง (Claude Code) · พี่ Ball สั่ง | ห้อง Codex ที่ `codex fork` มา (Codex 0.170 เขียน rollout ใหม่มีแค่ `forked_from_id`) แสดงแชทของ thread ต้นทางก่อนจุด fork + เส้นคั่น "แชทต่อจาก thread เดิม" (`codexTranscript` ใน `api.ts` · หา rollout ต้นทางใน sessions root เดียวกัน · ย้อนได้ 5 ชั้น) · เทสต์ `test/mobile-codex-fork.test.ts` |
| 23 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | แชท Codex: สรุปบริบทตอน auto-compact (ข้อความ assistant "## Active task …" ก่อนบรรทัด `compacted`) ไม่โชว์เป็นคำตอบแล้ว → บรรทัดระบบ "🗜 Codex ย่อบทสนทนา" (`parseCodexLines` จับคู่ข้อความกับ `compacted.message` · เทสต์ `test/mobile-codex-compact.test.ts`) |
| 23 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | ส่ง `$skill` ให้ Codex จากมือถือแล้วค้างในช่องพิมพ์ (Enter ไปเลือกสกิลในเมนู `$` ไม่ได้ส่ง): `typeInto` ห้อง Superset เช็คช่องพิมพ์ซ้ำแล้วกด Enter อีก (สูงสุด 2) แบบเดียวกับ tmux (`pressUntilSent`) · อ่านช่องพิมพ์ Codex ได้ (`codexDraft` — บรรทัด `›` เหนือแถบ Context) · อ่านจอสดไม่ใช้ cache 900ms · เทสต์ `test/mobile-press-until-sent.test.ts` |
| 23 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | แชทโหลดเร็ว/ประหยัดเน็ต: `GET /rooms/:ws/:room/chat?lite=1` ส่งขั้นตอน tool แบบไม่มีคำสั่ง/ผลลัพธ์ (`liteItem` · ธง `lazy`) · `GET /rooms/:ws/:room/chat/item?i=N` ส่งข้อความเดียวเต็มๆ เมื่อมือถือเปิดดู · ใช้กับ Claude และ Codex (Herdr ยังส่งเต็ม) · วัดจาก Codex rollout ล่าสุด 150 ข้อความ 272 KB → 43 KB · เทสต์ใน `test/mobile-press-until-sent.test.ts` |
| 23 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | ETag + 304 สำหรับ poll ที่ข้อมูลมักไม่เปลี่ยน: `GET /projects` · `/system` · `/rooms/:ws/:room/chat` (`etagJson` ผ่าน `.mapResponse` · ข้าม route ที่ตั้ง cache-control เอง/ตอบ error) · browser ส่ง If-None-Match เอง ไม่ต้องแก้ฝั่งมือถือ · หน้าแอป `m.html` `m-ext/*` `sw.js` ได้ ETag จาก `hono/etag` ใน `src/core/server.ts` · เทสต์ `test/mobile-etag.test.ts` |
| 23 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | ETag/304 เพิ่ม `GET /rooms/:ws/:room/suggestion` · `/mode` · `/prompt` (poll ในห้องทุก 2.5 วิ · วัดก่อนหน้า suggestion ~9 KB/นาที) |
| 24 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | `GET /batch?p=<path>&p=…` (สูงสุด 8) รัน GET ที่มือถือ poll (`/projects` `/system` `/rooms/:ws/:room/(chat|suggestion|mode|prompt)` · ไม่รับห้อง Herdr · `BATCH_PATH`) ผ่าน route เดิมด้วย header เดิม แล้วตอบ `{results:[{status, body}]}` · มี ETag/304 ทั้งก้อน · เทสต์ใน `test/mobile-etag.test.ts` |
| 24 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | `GET /search?q=` (⌘K) ค้นข้อความเรา/agent ในทุกห้อง Claude/Codex ที่อ่านแชทได้ (`roomItems` · ห้องละ ≤ 3 · รวม ≤ 40 ห้อง · 600 ข้อความล่าสุดต่อห้อง) |
| 24 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | อนุมัติ/ปฏิเสธจากแจ้งเตือน: hook ขออนุญาตของ Claude → `notifyPermission` อ่านจอหาหน้าต่างขออนุญาต (`permissionDialog` · ลายนิ้วมือของข้อความ) แล้ว push พร้อมปุ่ม ✓/✕ และ token ใช้ครั้งเดียว 10 นาที · `POST /push/act` (ไม่ใช้ bearer · token คือหลักฐาน) กดได้เฉพาะเมื่อหน้าต่างบนจอยังเป็นอันเดิมและตัวเลือกอยู่ที่ "1. Yes" (อนุมัติ = Enter · ปฏิเสธ = Esc) · ไม่เจอหน้าต่าง → push ธรรมดา · เทสต์ `test/mobile-push-approve.test.ts` |
| 24 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | `/batch` ETag รายส่วน: มือถือส่ง `e=` (ETag ที่ถือไว้ ตามลำดับ `p=`) ส่วนที่ไม่เปลี่ยนตอบ `{status:304}` ไม่มี body (วัดจริง: รวมทั้งก้อนแล้วส่วนเดียวที่เปลี่ยน เช่น projects ของห้องอื่น ทำให้แชทถูกส่งซ้ำ 147 KB/นาที) |
| 24 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | `!คำสั่ง` ใน Claude Code: `<bash-input>` เป็น bubble "! คำสั่ง" ฟองเดียว · `<bash-stdout>/<bash-stderr>` เป็นขั้นตอน Bash พับไว้ · คิวที่ Claude บันทึกซ้ำ (ไม่มี "!") ภายใน 15 วิ ไม่แสดง · `pressUntilSent` ไม่กด Enter ซ้ำกับข้อความที่ขึ้นต้น "!" (ต้นเหตุคิวซ้ำ) · เทสต์ `test/mobile-bash-input.test.ts` |
| 25 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | บรรทัดสถานะ Codex (`agentSpinner`): นอกจาก Working/Thinking/Exploring/Running แล้ว ทุกบรรทัด `• … (… esc to interrupt)` ก็นับ เช่น "Reconnecting... waiting for network (7m 52s)" พร้อมเหตุผลบรรทัดถัดไป (`└ Connection failed: …`) — เดิมจอ Codex บอกว่ากำลังต่อเน็ตใหม่/ล้ม แต่ maw ไม่แสดงอะไร |
| 26 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | ลิมิต Claude ในแผงแมวค้าง 49% หลายวัน: Claude ผ่าน Mind ไม่เขียน rate_limits ลงไฟล์สถานะ → `claudeLimits` เคยหยิบไฟล์ล่าสุดที่มี (13 พ.ย.) · ตอนนี้นับเฉพาะค่าที่อายุ ≤ 6 ชม. และไม่ช้ากว่าไฟล์สถานะล่าสุดเกิน 1 ชม. ไม่งั้นตอบ null · เทสต์ใน `test/mobile-etag.test.ts` |
