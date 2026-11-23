# Core server

วันที่ 8 พ.ย. 69

`server.ts` ประกอบ HTTP/WebSocket server และ mount mobile API. `startServer(port, host?)` รับ `ServerHostOptions.mobile` จาก trusted startup code เพื่อส่ง continuity service ของ host เข้า `createMobileApi` ของ server instance นั้น ไม่มี host options ยังคงพฤติกรรมเดิม ไม่โหลด private config หรือเปิด protocol capability ให้อัตโนมัติ

## การเชื่อม protocol

Host ที่ตรวจ config/authority แล้วส่ง `{mobile:{continuity:composition.featureOptions}}` เป็น argument ที่สอง. Browser/API/environment ไม่สามารถส่ง callback หรือ path มาเปิด runtime ได้ การ mount ไม่ใช่ native launch approval และไม่รับรอง live evidence; owned bootstrap เป็นขั้น explicit ของ host แยกต่างหาก

`server.ts` มี auto-start เมื่อ import โดยไม่มี `MAW_CLI` จึงห้าม import ระหว่าง unit tests เพื่อทดสอบเพียง type/DI และห้ามใช้การ import เป็นการตรวจ read-only. รอบงานนี้ไม่เรียก `startServer` หรือ restart server. CLI route เดิมไม่ส่ง host options จึงยังไม่เปิด protocol production

## การตรวจสอบ

ตรวจ build และ static type โดยไม่รัน server; mobile API/continuity behavior ทดสอบผ่าน in-process handler ในชุด `test/mobile-continuity-routes.test.ts`. ผล native และ production แยกบันทึกใน vault ของ maw

## ประวัติ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex root | ย้าย mobile API construction เข้า server instance และรับ trusted startup options โดย default ไม่เปิด protocol |

## ปรับปรุง 9 พ.ย. 69 — CLOSE one-way

`protocol-startup.ts` เตรียม exact scoped Codex owned room และ persist bootstrap snapshot ก่อน expose mobile options; ต้อง explicit production policy Codex→Claude, ไม่ adopt shared TUI และไม่ implicit resume. เลือก supervisor owned-session; import ไม่เปิด server.

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 9 พ.ย. 69 | Codex root | บันทึก production one-way implementation สำหรับ review ก่อนเปิดใช้ |
| 23 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | `server.ts` ใส่ ETag (`hono/etag`) ให้ไฟล์แอปมือถือ `/m.html` `/sw.js` `/manifest.json` `/m-ext/*` → ไฟล์ไม่เปลี่ยนตอบ 304 ไม่มีเนื้อหา (ประหยัดเน็ตตอนเปิดแอป) |
