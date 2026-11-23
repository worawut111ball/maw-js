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
