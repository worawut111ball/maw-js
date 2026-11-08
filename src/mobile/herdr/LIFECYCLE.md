# Herdr lifecycle — 8 พ.ย. 69

`lifecycle.ts` ดูแลการสร้าง/คืน/ปิดห้องบน Mac local default session เท่านั้น แยกจาก inventory/history/delivery ของ `runtime.ts` และ `production.ts` ที่หัวหน้ารวม ไม่เปิด Herdr server และไม่มี CLI/ฐานข้อมูล/timer ตอน import

## จุดต่อและเจ้าของ

- cmdmap: `lifecycle.ts`, `../features/herdr.ts`, `../../../ui/mobile/ext/herdr.js` และ focused test `test/mobile-herdr-lifecycle-cmdmap.test.ts`
- ensure: inventory/history/delivery/runtime/types และ README หลัก
- หัวหน้า: production bridge, `api.ts`, `ctx.ts`, `index.ts`, `m.html`, permissions และการโหลด script/routing/legacy exclusion
- tests: suite/fixture ใหม่ที่ทีม tests เขียน แยกจาก focused test ของ cmdmap ไม่เขียนทับงานค้าง team1

`LifecycleOptions` ใช้ DI: `store`, `runner`, `snapshot`, `dispatch`, `acknowledgments`, `allowDir`, `now?`, `rulesSink?` Snapshot ต้อง fresh และตรวจ schema แล้ว; process instance evidence, foreground/shell readiness และ conversation ต้องมาจากหลักฐานจริง ไม่ใช่ชื่อ/cwd `dispatch` ต้องต่อ durable runtime ledger และ tombstone guard; acknowledgments ต้องมาจาก assistant history ที่ยืนยัน conversation ไม่อ่าน input echo เป็นคำตอบรับ

Exports หลัก: `Lifecycle`, `LifecycleStore`, `LifecycleError`, `agentArgv`, `defaultMembers` Controller มี `create`, `continueOperation`, `status`, `list`, `setAutostart`, `rulesMarkdown`, `stop`, `closePreview`, `closeConfirm`, `closeStatus`, `reconcile`, `assertOpen`, `startReadiness`, `stopReadiness`, `migrateLegacy`, `setInitializationGuard`

## การสร้างและกู้ operation

POST create ต้องมี ID เดิมและ payload เดิมสำหรับการส่งคำขอเดิมซ้ำ เปลี่ยน payload ด้วย ID เดิมตอบ conflict ก่อน mutation บันทึก logical workspace/member IDs, owner generation, model/permission/autostart และ step journal ก่อนเรียก CLI ทุกขั้น SQLite ใช้ transaction `IMMEDIATE`, WAL, `synchronous=FULL`, busy timeout 3 วินาที ไฟล์ `0600`; จำกัด state 8 ล้านอักขระ/256 operations/512 close records ไม่มี memory fallback เมื่อ store เสียหรือเต็ม

เดี่ยวมีหนึ่ง agent; ทีมมี head + worker1/1/3 สร้าง head ซ้ายและ worker สามตัวขวา `pane split` right `0.5`, down `1/3`, down `0.5` ทุกการสร้างใช้ `--no-focus` IDs อ่านจาก response ไม่คำนวณเอง มีเพียงการตรวจ argv/DI ไม่ได้ยืนยัน geometry/focus บน Herdr runtime จริง

ค่าเริ่มต้น Codex head `gpt-6-astra` และ workers `gpt-6.1-sol` แต่เลือก Claude/Codex/model/permission ต่อบทบาทได้ รุ่นเป็น config ที่ผู้ใช้เลือก ไม่ใช่ model ที่ตรวจพบจาก runtime

| Config | Codex argv | Claude argv |
|---|---|---|
| ถามอนุญาต | `--ask-for-approval on-request` | `--permission-mode default` |
| ไม่ถามสิทธิ์ | `--dangerously-bypass-approvals-and-sandbox` | `--dangerously-skip-permissions` |
| exact resume | `resume <UUID>` | `--resume <UUID>` |

flags ตรวจกับ CLI `--help` ในเครื่องวันที่ 8 พ.ย. 69 เท่านั้น ยังไม่ทดสอบ start/resume กับ agent จริง Native args ต่อหลัง Herdr `--` ไม่ผ่าน shell, ไม่รับ prompt/extra flags จาก client และไม่มี `--last`/`--continue` สำหรับ restore ที่ยืนยันแล้ว

กติกาเป็น `.md` จริงจาก roster/pane IDs/role/unique marker: ค่าเริ่มต้นเขียน `dirname(store.path)/herdr-team-rules/<hash>-<hash>.md` สิทธิ์ `0600` ก่อนเริ่ม agent/ส่ง bootstrap และบันทึก SHA256 ของ bytes ใน journal; จะใช้ `rulesSink` ของ host แทนได้ Memory store ต้อง inject sink ถ้าจะ create เอกสารบอกบทบาท วิธีแจกงานจริง และรอ user ไม่เริ่มงานเอง

Bootstrap แยก launched / dispatched / acknowledged / ready โดยให้ assistant ตอบตรง `HERDR_ACK:<unique-marker>:<role>` ACK การส่งหรือ idle ไม่ใช่หลักฐานอ่านกติกา Readiness reconcile อ่านคำตอบที่มาช้าแบบ read-only ผูก same process instance + native conversation + marker/role และยกระดับ partial/uncertain เป็น ready ได้โดยไม่ start/prompt ซ้ำ ไม่ข้าม closing/tombstone; ไม่อ้างว่า marker พิสูจน์ความเข้าใจทั้งหมด

Timeout บันทึก uncertain ก่อนหยุด การเรียก continue ไม่ยิง step เดิมซ้ำ หาก start อาจสำเร็จแต่ชื่อหาย/instance หรือ ownership ยืนยันไม่ได้ ให้พักและตรวจปลายทาง ไม่ adopt ด้วยชื่อ/cwd และไม่รับรอง recovery ว่าครบแล้ว Workspace/split response หายจนไม่รู้ resource ID ไม่สร้างซ้ำ แม้จะมี workspace ชื่อเหมือนกัน

UI เก็บ operation ID + exact create body ใน localStorage ก่อน POST ถ้าเก็บไม่ได้จะไม่ส่ง; response หายให้เปิด progress ของ ID เดิม ถ้า request ไม่เคยถึง server จน operation not-found มีปุ่มส่ง exact body/ID เดิมโดยผู้ใช้ ไม่สร้าง ID ใหม่เงียบๆ

## Restore/readiness

`reconcile()` ใช้ in-flight Promise เดียวต่อ controller และ step claims ใน store เพื่อกันสร้างซ้ำระหว่าง controller หลายตัว คืน workspace ที่ยืนยันว่าเคยเป็นของ operation และหายจริงด้วย exact conversation ของสมาชิกแต่ละตัว ไม่ adopt workspace ชื่อเหมือนกัน

เมื่อ workspace ยังอยู่แต่สมาชิกหาย ให้หา terminal ปัจจุบันจากหลักฐานความเป็นเจ้าของ หาก terminal เดิมเป็น shell ที่พร้อมจริงให้ resume; pane หายให้ split จากสมาชิกที่ยืนยันว่าเป็นของ operation แล้วใช้ pane/terminal IDs ใหม่จาก response ไม่ overwrite foreign/busy/replacement agent สมาชิกที่ปิดผ่าน flow นี้หรือปิด autostart รายตัวไม่ถูกคืน

ความพร้อมในการคืนต้องมี UUID conversation และ bootstrap ACK เดิมที่พิสูจน์แล้ว ตรวจ conversation หลัง start ตรง UUID ที่ร้องขอ จึงไม่เอาประวัติตัวอื่นมาแทน หากไม่มี native binding/source ที่ยืนยันได้ให้ blocked/partial ตามเหตุจริง ไม่ resume latest

การคืนรายสมาชิกหลังผู้ใช้เปลี่ยน topology อาจได้ layout ต่างจากตอนสร้างทีม ไม่ย้าย/ปิด pane ของเพื่อนเพื่อจัด geometry เอง ต้องตรวจ layout จริงภายหลัง ไม่อ้างว่า restore geometry สมบูรณ์ทุกกรณี

Host เรียก `startReadiness(schedule)` อย่างชัดเจน: delay 5/10/30/60 วินาทีแล้วคงสูงสุด 60 วินาทีต่อเนื่อง ไม่จบหลังสี่ครั้ง จำกัด reconciliation ซ้อนหนึ่งรอบ มี `readiness` running/checks/lastCheckAt/lastError/nextDelayMs/checking ให้ status อ่านได้ `stopReadiness` ยกเลิก timer รอบถัดไป งานที่เริ่มแล้วใช้ journal ให้จบ/uncertain ไม่ abort แล้วลองซ้ำ Sync migration error ถูกจับใน loop และรายงาน error แทนหลุด callback ไม่มีการเปิด server

## Close และ stop

Stop รับเฉพาะ Claude/Codex ที่ยืนยัน instance/foreground และ working สด ส่ง `ctrlc` ผ่าน durable dispatch ไม่ปิดห้อง ไม่ disable autostart และไม่ retry อัตโนมัติ ไม่มีหลักฐาน upstream รับประกันหยุดเฉพาะ turn แบบ atomic

Close preview ผูก scope workspace หรือ pane กับสมาชิกทั้งหมดรวม shell, runtime fingerprint และอายุ 120 วินาที เก็บได้สูงสุด 128 previews เมื่อ confirm ต้องอ่าน inventory สดเทียบอีกครั้ง Persistent tombstone + disable desired state ถูกบันทึกก่อน CLI; บันทึก disable ไม่ได้จะไม่ปิด runtime เป้าหมายเปลี่ยนต้องยืนยันใหม่

ปิดห้องเดี่ยว disable เฉพาะสมาชิก ไม่ปิดเพื่อนร่วมทีม; ปิด workspace disable ทั้งชุด ไม่ลบ transcript/โปรเจคหรือปิด server คำสั่ง pane close รับ positional ID ตาม CLI help ไม่ใช่ `--pane`

ผลแยก `autostartDisabled`, `runtimeClosed`, `deliveryUnknown` และ state closing/uncertain/closed มี status lookup เดิม อ่าน inventory ยืนยันว่า gone และตรวจ in-flight create/split/start ที่ยังไม่แน่นอนก่อนรายงาน closed หากยังอาจมี late result ให้ closing-uncertain และไม่ปิด replacement/foreign resource ด้วย confirmation เก่า

Host ต้องต่อ `assertOpen` เข้า runtime dispatch guard สำหรับ send/key/answer/bootstrap ทุกทาง การตรวจและ close CLI ยังไม่ atomic กับ desktop/อีก client ต้องบอกข้อจำกัด ไม่รับรอง exactly-once

## Migration/legacy exclusion

`migrateLegacy(file)` สำรอง JSON bytes เดิมด้วย hash filename `0600`, validate ทั้งชุด, reject unknown/corrupt schema และ publish intent เข้า versioned journal แบบ transaction/idempotent ไม่เขียน array ทับ schema ใหม่ Legacy ที่ยังไม่มี ownership/exact conversation เก็บ desired intent เป็น blocked-awaiting-binding ไม่เดา UUID หรือ permission bypass

หัวหน้าต้องปิด legacy autostart boot/writer/POST path ก่อนใช้ coordinator ใหม่ และ wire migration ก่อน read/mutation ทั้ง status/create/reconcile ด้วย production proxy หรือ `setInitializationGuard` การมีฟังก์ชัน migrate ไม่ได้พิสูจน์ว่า deployment ปิด legacy writer แล้ว

## Routes/UI integration

`../features/herdr.ts` ส่งออก `configureHerdrFeature(options)` และ `mount(app,options?)` ไม่ import runtime/เปิด controller เอง หากไม่ configure/inject ตอบ 503 Host ต้อง mount หลัง auth guard ของ `/mobile` เดิม ทุก route `Cache-Control: no-store, private` ไม่อ่าน response จาก offline cache

| ใต้ `/mobile/herdr` | หน้าที่ |
|---|---|
| `GET /status` | operations + readiness |
| `POST /create` | create/recover exact ID+body |
| `GET /operations/:id` | progress persisted |
| `POST /operations/:id/continue` | reconcile operation เดิม |
| `POST /operations/:id/autostart` | `{on,memberId?}` เปิดปิดรายสมาชิก/ชุด |
| `GET /operations/:id/rules` | Markdown ที่ตรวจ artifact hash แล้ว |
| `POST /stop` | `{id,ws,room,generation}` กับ fresh resolver |
| `POST /close/preview`, `POST /close/confirm` | scope สด / previewId |
| `GET /close/:id` | อ่านผล close เดิม ไม่ส่ง close ซ้ำ |
| `GET /delivery/:id?ws=&room=&generation=` | scoped durable status จาก runtime |

UI global: `mawHerdrCreate(w?)`, `mawHerdrProgress(id)`, `mawHerdrStop(w,room)`, `mawHerdrClose(w,room?)` ลงทะเบียน `mawExt.pages.mount(el)` และ keys stop/close ใช้ current capability; host เพิ่ม script defer `/m-ext/herdr.js` และ hook ปุ่ม `+` ให้เรียก Create ไม่ตกไป Superset ทุก status/preview/delivery fetch no-store โดยตรง

## หลักฐานการตรวจและข้อจำกัด

focused tests ใช้ synthetic runner/snapshot/assistant records + SQLite/temp files เท่านั้น ไม่มี Herdr socket mutation, live agent, browser จริงหรือ reboot ผล browser mocks/mobile regression ของหัวหน้าต้องแยกอ้างเจ้าของ ไม่ใช้แทนผล live

ชุดหลัก: `test/mobile-herdr-lifecycle*.test.ts` และ `test/mobile-herdr-integration-ui.test.ts`; typecheck ที่จำกัดไฟล์: `node_modules/.bin/tsc --noEmit --target ESNext --module preserve --moduleResolution bundler --types bun --skipLibCheck src/mobile/herdr/lifecycle.ts src/mobile/features/herdr.ts`

ข้อจำกัดคงอยู่: uncertain ที่ไม่มี ownership proof ต้องหยุดให้ตรวจ ไม่ recovery ด้วยการเดา; legacy ไม่มี adoption UI ใน module นี้; native path ref ต้อง bridge ยืนยัน UUID ก่อน exact restore; partial topology ไม่รับรอง geometry; SQLite/disk loss นอกเหนือ durable store ที่ยังอ่านได้ไม่รับรอง exactly-once; CLI help พิสูจน์ syntax ไม่พิสูจน์การ start/close/permission/resume จริง

## ประวัติ

| วันที่ | ใคร (คน/AI) | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | ไอ้คล็อต / cmdmap | เพิ่ม lifecycle/journal/restore/readiness/close/routes/UI พร้อม DI tests และข้อจำกัดการรวมกับ runtime |

## ผลรีวิวเพิ่มเติม — 8 พ.ย. 69

ผล live acceptance แก้ข้อสรุปรอบรีวิว: Codex ใหม่ไม่มี native conversation จนกว่าจะรับ prompt แรก จึงส่ง bootstrap ครั้งเดียวตาม process instance ที่ยืนยันแล้ว และผูก UUID/provider เมื่ออ่าน assistant ACK จริงจาก instance เดิม ถ้า conversation เปลี่ยนจากที่เคยผูกแล้ว ให้ล้าง ready และพัก `conversation_changed` ไม่ใช้ ACK เก่า การเปลี่ยน generation หลังเกิด native ID อาจทำ delivery uncertain แต่ readiness อ่าน ACK มาเคลียร์ความพร้อมได้โดยไม่ส่งซ้ำ

bootstrap ที่ ledger ยืนยัน `definitely-rejected` เท่านั้นจะเพิ่ม `bootstrapAttempt` ที่ persist เพื่อให้การกดดำเนินต่อใช้ request ID ใหม่ ไม่ติดผลปฏิเสธเดิม ส่วน `uncertain`/`dispatching` ไม่เพิ่ม attempt และไม่ส่งซ้ำ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex หัวหน้ารีวิวแทนไอ้แดง | แก้ late native metadata และ bootstrap definite-rejection retry พร้อม regression tests; กัน ready จาก conversation เก่า |

## Contract ที่ยืนยันจาก CLI จริง — 8 พ.ย. 69

`pane split` คืน `result.type=pane_info` (schema มี pane_created ด้วยแต่ไม่ใช่ response ของคำสั่งนี้ในเครื่อง); ratio เป็นสัดส่วน pane เดิม จึงใช้ right0.5/down1/3/down0.5 ตรวจ layout จริงได้หัวหน้า49แถวและลูก16/17/16แถวบนพื้นที่49แถว ไม่รับรองจำนวนแถวคงที่ทุกขนาดจอ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex | แก้ split response/ratio และ late native binding จากผลทดสอบ Herdr จริง |


## Review entry policy — 8 พ.ย. 69

Claude ask ใช้ `--permission-mode default` แทน manual ตาม static native enum ที่ตรวจจาก candidate04 ไม่มีการรัน inference/parser acceptance. Trusted host loader/policy และขอบเขต env guards ดู `src/mobile/launch/README.md` ของ maw; tests เพิ่มที่ `test/mobile-entry-host-loader.test.ts` ใช้ fixture runtime ไม่เปิด native agent

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม 1 | แก้ Claude default และบันทึก trusted loader tests |
