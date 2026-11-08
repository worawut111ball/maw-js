# Herdr autostart fixtures

วันที่ 7 พ.ย. 69 · ผู้ทำ: Codex `phase2-herdr-tests`

## ที่มาและขอบเขต

สร้างข้อมูลสมมติตาม `herdr api schema --json` protocol `22` และรูปแบบ envelope ที่ตรวจในเฟส 1 ไม่ใช่สำเนา inventory หรือ transcript จริง ใช้ `demo-room`, `w7:p1`, `/home/example/project` และ process ID สมมติ ไม่มีข้อมูลเครื่องผู้ใช้ ชื่อลูกค้า หรือความลับ

| ไฟล์ | จำลองคำตอบ |
|---|---|
| `workspace-list.json` | workspace หนึ่งห้อง |
| `agent-list.json` | Codex หนึ่งตัวที่ idle |
| `pane-list.json` | shell pane หนึ่งตัว |
| `workspace-created.json` | workspace/tab/root pane หลังสร้าง |
| `pane-process-info.json` | shell อยู่ foreground |
| `agent-started.json` | คำตอบหลังเริ่ม Codex |
| `protocol22.schema.json` | ส่วน schema ของ success response หกชนิดพร้อม definitions ที่อ้างถึง จาก protocol 22 |

`protocol22.schema.json` ตัดจากผล `herdr api schema --json` ที่หัวหน้าสำรวจขั้น 0 เก็บไว้ ไม่ได้สร้างจากชนิดข้อมูลใน implementation เก็บ `protocol`, `schema_version` และ SHA-256 ของต้นฉบับไว้ตรวจที่มา คง definitions ที่อ้างถึงทั้งหมดและกรองเฉพาะหก variants ของ `ResponseResult` จึงไม่ใช่ schema ของ API ทั้งระบบ

tests ตรวจ fixtures ทั้งหกกับ required fields, ชนิดข้อมูล, enum และ nested references จาก schema นี้ พร้อมกรณีลบ `terminal_id`, ลบ `result.type`, เปลี่ยนชนิด `pane_count` และใช้ agent status ที่ไม่มีใน protocol เพื่อยืนยันว่าการตรวจจับข้อมูลผิดจริง ตัวตรวจ schema ใน tests รองรับเฉพาะ keywords ของส่วนที่ใช้ ไม่ใช่ JSON Schema validator ทั่วไป

## การทดสอบ

`NODE_ENV=test bun test test/mobile-herdr-autostart.test.ts` ใช้ runner และ scheduler ที่ inject เข้า feature เท่านั้น ไม่ start/restart Herdr หรือ maw และไม่ส่ง input ไป pane จริง

ชุดทดสอบปรับ fixture ใน memory เพื่อจำลองห้องหาย ห้องซ้ำ agent เดิม pane ไม่ว่าง timeout และข้อมูลตอบกลับไม่ครบ ผล unit test ไม่ใช่การยืนยันว่าคืนห้องหลังรีบูตเครื่องจริงแล้ว

ครอบคลุม config CRUD, HTTP body/flags ผิดรูปแบบ, config เสียที่ต้องไม่ถูกเขียนทับ, restore ห้องหาย/ห้องเดิม, busy/foreign/duplicate, process/pane identity ไม่ตรง, start timeout ทั้งพบและไม่พบ agent, create timeout ทั้งก่อนและหลังสร้าง workspace, ensure ซ้อน, boot guard 5/60 วินาที, boot callbacks ซ้อน, `readConfig` ที่เปลี่ยนตามรอบ และ `lastEnsure` รวมกรณีอ่าน config ไม่สำเร็จ ทุกการเรียก mutation เป็นเพียง argv ที่ส่งให้ fake runner ใน memory

ข้อจำกัด: suppression ของ mutation ที่ไม่ทราบผลอยู่ใน process เดียว ไม่พิสูจน์การกันซ้ำข้าม process restart; ไม่ทดสอบ real CLI, Herdr socket, browser, มือถือ หรือการรีบูต ไม่เขียน config จริงของผู้ใช้ ใช้ไฟล์ชั่วคราวและลบทิ้งหลัง tests

## ผลตรวจจริง — 7 พ.ย. 69

ผู้ทำ `phase2-herdr-tests` รันเองบนเครื่องพัฒนา หลัง hash ของร่าง core/main นิ่ง ผลนี้ไม่ได้อ้างจากรายงานลูกคนอื่น

| ทางที่ตรวจ | คำสั่ง/หลักฐาน | ผล |
|---|---|---|
| Bun + injected runner/scheduler + ไฟล์ config ชั่วคราว | `NODE_ENV=test bun test test/mobile-herdr-autostart.test.ts` · log `/tmp/maw-herdr-phase2-tests-focused.log` | 39 pass, 0 fail, 459 assertions |
| ชุด mobile ทั้งหมดบนเครื่องพัฒนา | `NODE_ENV=test bun test test/mobile-*.test.ts` · log `/tmp/maw-herdr-phase2-tests-mobile.log` | 343 pass, 0 fail, 17 ไฟล์, 1585 assertions |
| ตรวจต้นทาง schema ผ่าน Python แบบอ่านไฟล์ | เทียบส่วนที่ pin กับ `/tmp/maw-herdr-phase2-schema.json` | protocol 22, success envelope, หก variants และ definitions ที่อ้างถึง 11 ตัวตรงต้นฉบับ |

baseline `/tmp/maw-herdr-phase2-mobile-baseline.log` เดิม 304 pass; รอบนี้เพิ่ม 39 tests จึงรวมเป็น 343 ผลข้างต้นเป็นเฉพาะชุด mobile ไม่ใช่ tests ทั้ง repository ไม่มีการรัน server, reboot, commit/push หรือ Herdr mutation จริง

hash SHA-256 ของ implementation ก่อนและหลังรันตรงกัน:

- `src/mobile/features/herdr-autostart-core.ts`: `d9d2d09a79be49e1580049635fef6abe2d11b9fc114bc2469ba696fdefaaa867`
- `src/mobile/features/herdr-autostart.ts`: `99da6d97f94507d82fd95ff4adff16d7ebd3970c83021864d75722d222e32f55`

Python ไม่มี package `jsonschema` จึงไม่ได้ validate กับ full schema ผ่าน Python; การ validate fixtures ใน Bun ใช้ตัวตรวจ subset ตามที่อธิบายไว้ข้างต้นและรันผ่านจริง

ส่วนที่ค้างสำหรับหัวหน้า: รวมผลของ core/main และตรวจ diff ทั้งงาน; real Herdr integration/การคืนห้องข้าม restart อยู่นอกขอบเขต DI รอบนี้ ฝั่ง tests/fixtures ที่ได้รับมอบหมายเสร็จแล้ว

## ประวัติ

| วันที่ | ใคร (คน/AI) | แก้อะไร |
|---|---|---|
| 7 พ.ย. 69 | Codex phase2-herdr-tests | สร้าง fixtures สมมติตาม protocol 22 สำหรับทดสอบ autostart ผ่าน DI |
| 7 พ.ย. 69 | Codex phase2-herdr-tests | ตรวจร่างเดิมกับ upstream schema, เพิ่ม schema contract และกรณี flags/timeout/identity/boot ซ้อน; รันเอง 39/39 และ mobile 343/343 ผ่าน DI พร้อมเก็บ log/hash |
