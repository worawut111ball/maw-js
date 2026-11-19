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
