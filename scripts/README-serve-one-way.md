# Explicit one-way server entry

9 พ.ย. 69 — owner root

`scripts/serve-one-way.ts` เป็น operator entry หลัง review เท่านั้น ไม่ใช่คำสั่งให้รันตอนนี้ และ import ไม่ start server/native. รับ private canonical host module path, SHA256 และ port; ตรวจไฟล์ก่อน/หลัง import และ createStartup แล้ว bootstrap owned room ก่อน startServer จริง ไม่ adopt shared TUI.

`createOneWayClose` memoize Promise เดียว: พยายามปิด server แม้ owned cleanup reject; ทุก caller ได้ sanitized failure เดิม ไม่ replay cleanup ไม่ reset uncertain/lease. Tests `test/mobile-protocol-production-close.test.ts` ใช้ callbacks ใน memory ไม่เปิด server/native.

Operator syntax หลังได้รับอนุมัติ: `bun scripts/serve-one-way.ts <reviewed-private-host-module> <sha256> [port]`. ห้ามใช้กับ port ที่ server เดิมถืออยู่; deployment/restart ต้องผ่าน review ตาม CLOSE-PLAN ก่อน. Existing durable room ไม่ implicit resume/relaunch ต้องตรวจ state ก่อนเปิดใหม่.

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 9 พ.ย. 69 | Codex root | เพิ่ม explicit pinned entry และ failure-preserving shutdown |
