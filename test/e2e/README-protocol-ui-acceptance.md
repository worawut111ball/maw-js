# Protocol UI acceptance bridge — 8 พ.ย. 69

`protocol-ui-acceptance.ts` เตรียม real working mobile HTML + ทุก extension โดยไม่แก้ source, ไม่ inject UI state และไม่ stub HTTP ของ Backend: Playwright route แปลง browser request เป็น Web `Request` แล้วรอ `host.api.handle(request)` ส่ง Response bytes/status/headers กลับตรง ๆ ไม่มี listener/port/background server

## Interface สำหรับ Root

```ts
import {acceptProtocolSwitch} from './test/e2e/protocol-ui-acceptance';
// ใช้ Bun process เพื่อให้ createMobileApi และ trusted service ใช้ bun:sqlite ได้
const host = {
  api, // actual createMobileApi(cfg, {continuity: service.featureOptions, ...DI})
  workspace, room, // exact isolated lab alias ที่ Root เตรียมแล้ว
  requestHeaders, // ephemeral actual API auth; ไม่เขียนลงรายงาน
  setup: {runId, runtime: 'native', apiKind: 'createMobileApi', sourcePath},
  dispose, // Root owns exact cleanup; helper ไม่เรียกเอง ไม่ปล่อย uncertain locks
};
const scenario = {
  target, model, // ต้องอยู่ใน actual capability.models
  facts, // explicit authorized provenance: field,seq,sourceId,agent,nativeId,eventHash
  text: 'ช่วยทวนเป้าหมาย จำนวนงานที่เหลือ และกำหนดส่งจากบริบทที่ได้รับก่อนหน้า',
  timeoutMs: 180000,
  purpose: 'bounded-acceptance', // ตรวจ API purpose และป้าย UI จริง ไม่สร้าง permit ให้เอง
};
// Root ส่ง Page จาก isolated context {serviceWorkers:'block'}
const result = await acceptProtocolSwitch(page, host, scenario);
```

นำไปเรียกเมื่อ Root อนุมัติ native lab setup แล้วเท่านั้น ตัวอย่างนี้ไม่ใช่คำสั่งให้เปิด native ตอนนี้ Import helper ไม่ spawn CLI/browser/server และไม่ import native runtime/actual API ให้เอง Root เป็นผู้สร้าง trusted host/runtime/admission/config/profile/lease/evidence; ไม่มี fake service fallback

Root ยืนยัน scenario: synthetic goal `DEMO-17`, remaining `4`, delivery `วันอังคาร`. ต้องอยู่ใน structured source events จริงของ lab และ facts ที่ Root อนุญาตเลือก; harness ไม่แต่ง archive/preview/selection ให้ native ข้อความหลัง switch ถามทวนโดยไม่ใส่ facts เหล่านี้ ไม่ claim `Read`, retrieval หรือ semantic understanding จาก completion

## ขั้นตอนและหลักฐาน

1. รับ `/projects` จริง หา exact ws/room/project แล้วคลิก card/workspace/tab จริง
2. คลิก header switch จริง เลือก agent/model จาก controls ของ actual UI
3. คลิก preview แล้วเลือกเฉพาะ authorized candidate provenance ที่ตรง actual response; ไม่มี autochoose goal/facts
4. คลิก confirm รอ actual facts receipt/switch/advance/current ready/transport; helper ไม่ POST advance/retry เอง
5. ส่งข้อความผ่าน `#msg`/`#send` จริง รอ `/turns` live completed และ exact id/logical room/full binding/native final
6. ตรวจ stored events จาก UI polling จริง ทั้ง user/assistant พร้อม operationId/turnId/generation และ native final แสดงใน main screen จริง ไม่มี text echo receipt แทน Backend

Writes ที่อนุญาตเฉพาะ lab: facts/selections, switch, operations/:id/advance, turns. Native TUI send/prompt/upload/other-room/retry/cancel และ auxiliary telemetry ถูก abort ไม่สร้าง HTTP response success แทน Backend GET เฉพาะ essential bootstrap + continuity ของ lab; หน้า dashboard/module อื่นไม่ได้อยู่ใน acceptance นี้

Responses ใน bridge ไม่ถูกเติม ready/identity/receipt. `runtime`/`apiKind` เป็นคำประกาศของ setup ที่ต้อง review source ไม่ใช่ proof. เมื่อเป็น DI หรือ fixture-handler ผลติดป้าย `fixture-only` เสมอ แม้ UI path สำเร็จ; `ui-api-completed` ไม่เท่ากับ production certification

Returned result เก็บเฉพาะ route/status + request/response/source/ID hashes ไม่เก็บ auth/context/prompt/answer/native ID. UI assets คือ source เดิมไม่ rewrite; hash ทุก asset ที่เสิร์ฟ Unknown assets/network ถูก abort และใช้ isolated context ปิด service worker Root ต้องเก็บ artifacts ใน private vault ถ้าจะเพิ่ม screenshot/native diagnostics

## Actual API/composition/service integration ด้วย bounded permit

`protocol-ui-composition-setup.ts` เตรียม host ที่ใช้ actual `createMobileApi`, host composition, pinned loader validation, service, engine, SQLite journal/permit budget/facts selection, native-record parser และ `verifyProtocolContextDelivery` ของ Root จริง. `protocol-ui-composition.test.ts` เรียก browser ผ่าน bridge เดิม ไม่มี fake HTTP handler หรือ UI state injection

ส่วนที่เป็น DI อย่างชัดเจน: temporary pinned builder stand-in/fake native bytes ที่ไม่ execute, supervisor/driver/wire, authority/attestation, native-format records, และ `projectInventory:async()=>[]` สำหรับ ambient discovery. `/projects` ใช้ actual owned registry merge/auth; purpose/remaining/progress/receipt/events มาจาก actual service ไม่เติม API response ขึ้นเอง. Host bounded authority ส่ง permit จริงตาม exported schema และ `protocolAcceptanceProfile(candidate.binding)` ไม่ echo profile จาก HTTP เพื่อ grant สิทธิ์

Production evidence ปิดอยู่ (pilot); tests ยืนยัน advertisement2→2, switch+text consume2→0 จาก durable ledger, all permits หมดแล้วยังอ่าน exact receipt/events ได้ และ delayed final ระหว่าง budgetหมดรักษา original draft ไม่ replay. ทุกกรณีเป็น DI integration ไม่ใช่ native execution/Read/retrieval/account/upstream/production proof

Focused command: `MAW_PROTOCOL_UI_FIXTURES=1 NODE_ENV=test MAW_TEST_MODE=1 bun test test/e2e/protocol-ui-acceptance.test.ts test/e2e/protocol-ui-composition.test.ts`. ทั้งสอง suite เป็น opt-in เมื่อไม่เปิด flag ไม่มี browser/service fixture launch ใน canonical suite

`result.nativeExecutionVerified:false` และ `productionCertified:false` เสมอ ไม่ยก `setup.runtime` label เป็น proof. `authorizationPurpose` อ่านจาก API, `draftOutcome` แยก `cleared`/`retained-original`; completed receipt ไม่บังคับล้าง draft หาก guard เปลี่ยนระหว่างรอ ACK

## การ cleanup

Root ถือ native lifecycle ทั้งหมด: helper ไม่ bootstrap/close/start/stop/dispose เอง ถ้า timeout/uncertain ไม่ retry หรือเรียก cleanup เพื่อเดาว่าปลอดภัย เมื่อรันจริงต้องให้ native pending effect จบหรือเข้าสู่ explicit reconciliation ตาม contractก่อน Root ทำ cleanup ห้ามใช้ user pane `wM:p1` และห้ามเผย raw failure/body/auth ใน public report

## Fixture tests ของ harness

`MAW_PROTOCOL_UI_FIXTURES=1 NODE_ENV=test MAW_TEST_MODE=1 bun test test/e2e/protocol-ui-acceptance.test.ts` เป็น opt-in แยกจาก canonical suite (default skip ไม่มี browser/native setup) และใช้ fixture-only Web Request handler + actual HTML/extension + browser จริง UI flow นี้ไม่ใช่ createMobileApi/service/native; มี actual createMobileApi auth/health test แยกที่ไม่ประกอบ native service ใช้ actual `mergeOwnedInventory` เพื่อให้ row shape ตรง host contract จึงแยกจาก full-native acceptance อย่างชัดเจน ไม่เรียก runtime setup ของ Root

ทดสอบ happy path, switch uncertain (ไม่ส่ง turn), lost turn ACK (ไม่ replay/ไม่ claim complete). P1 ที่พบจาก actual owned inventory แก้แล้วใน `activate()`: cached room เก็บ `transportKind/logicalRoomId/revision/protocolBinding` ครบ จึงคลิก header เปิด modal ได้โดยคง exact identity guard. Regression ทวนทั้ง header จริงและ stale confirm หลัง native replacement ไม่ bypass header หรือปลอม ready ดู `PROTOCOL-UI-ACCEPTANCE.md` ใน vault

## ประวัติ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex cmdmap/p5 | เพิ่ม in-process bridge/interface + fixture-only browser tests; แจ้ง P1 header owned identity โดยไม่แก้ UI freeze |
| 8 พ.ย. 69 | Codex cmdmap/p5 | รับ owner P1 จาก Root แก้ cached protocol fields และเพิ่ม regression; negative fixtures ต้องล้มที่ stage ที่กำหนดจริง |
| 8 พ.ย. 69 | Codex cmdmap/p5 | เพิ่ม bounded-purpose validation และ actual API/composition/service/parser/context-verifier integration; แยก DI/native evidence และ preserved draft หลัง budgetหมด |
