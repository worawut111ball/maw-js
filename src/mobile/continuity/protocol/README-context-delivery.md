# Context-only delivery verifier

8 พ.ย. 69 — `verifyProtocolContextDelivery` ตรวจข้อความ context ที่ส่งผ่าน owned protocol โดยไม่อ่านไฟล์หรือเปิด process เอง

## ขอบเขต

Host ส่ง `room`, target `binding`, `context`, live `RuntimeStartReceipt` และ `NativeRecords` จาก trusted native reader เท่านั้น ไม่รับชุดหลักฐานจาก HTTP/model JSON ตรวจ operation, identity/generation, hash ของข้อความ, exact native turn/user/final และสถานะจบจริง ไม่มี pending/refusal/interruption หรือ turn ใหม่แทรก

ใช้เฉพาะ context-only/no-tools: tool event ใน turn ปัจจุบันทำให้ปฏิเสธแม้ tool จบแล้ว แต่ historical tool ไม่ทำให้ปฏิเสธ turn ใหม่ ไม่ใช้กับการรับรอง toolful retrieval

ผล `DeliveryReceipt.state=acknowledged` หมายถึงข้อความที่ฉีดตรงกับ native user และ exact final ตรง runtime เท่านั้น ไม่พิสูจน์ว่าอ่าน archive, เข้าใจความหมาย หรือยอมรับ facts. `throughSeq` เป็นค่าที่ host ผูกกับ context ไม่ใช่คำรับรองของ model ว่าอ่านทุก seq. Namespace/home/policy ยังเป็นหน้าที่ trusted host admission; verifier ตรวจรูปแบบและ generation ของ supplied binding ไม่สร้างหลักฐาน account ใหม่

## ตรวจสอบ

`bun test test/mobile-protocol-context-delivery.test.ts` ใช้ local pure fixtures ผ่าน native parser จริง ไม่มี native/model/network หรือ production activation

## ประวัติ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex root | เพิ่ม exact context-only delivery verifier แยกจาก retrieval proof |
