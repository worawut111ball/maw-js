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
