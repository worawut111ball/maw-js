# Pinned protocol entry loader

8 พ.ย. 69 — `entry-loader.ts` เชื่อม reviewed Artron builder V2/V3 เข้ากับ host โดยตรวจ SHA-256 ของ `local-entry.js`, `protocol-entry.js`, `protocol-entry-v2.js`, `protocol-entry-pilot.js` ก่อน import และก่อนใช้ผลทุกครั้ง

`new PinnedProtocolEntryLoader(pin)` รับ directory และ inventory จาก trusted host เท่านั้น ไม่รับจาก HTTP. `build(input)` สร้าง candidate แบบ immutable ตรวจ policy/home presence/env schema และเก็บ ownership ภายใน instance. `processSpec(candidate)` คืน binary/argv/env ให้ supervisor หลัง trusted admission; JSON copy ของ candidate ใช้แทนไม่ได้ และ module drift ถูกปฏิเสธแม้ module ถูก cache แล้ว

การตรวจ hash ไม่ให้สิทธิ์เปิด agent: caller ยังต้องตรวจ effective policy, account/home context, external ownership และ request intent. `processSpec` มี credential ใน env จึงห้าม serialize/log/ส่งเป็น API response. โมดูลไม่ spawn, ไม่แก้ settings และไม่เปิด production capability

ตรวจด้วย `bun test test/mobile-protocol-entry-loader.test.ts`: ใช้ temporary source fixtures ไม่ execute native/model/network. ครอบ owned instance, immutable candidate, source drift และ sanitized errors. Actual frozen builder→mapper DI ของรอบก่อนอยู่ใน vault `FINISH-PLAN.md`

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex root | เพิ่ม pinned module loader, candidate ownership, drift guards และ fixture tests |
