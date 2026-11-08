# Mobile feature packs

แต่ละ feature ส่งออก `mount(app)` และลงทะเบียนใน `index.ts`; `api.ts` เรียก `mountFeatures()` ภายใต้ `/mobile` ใช้การยืนยันตัวตนของ API เดิม

## Herdr provider — 8 พ.ย. 69

`herdr.ts` mount lifecycle routes ภายใต้ mobile auth เดิม; `../herdr/production.ts` เชื่อม runtime กับ lifecycle coordinator ส่วน API หลักรวม workspace/ห้องจาก Herdr ใน `/projects` และใช้ `/rooms/:ws/:room/chat`, `/screen`, `/send`, `/delivery/:id` โดย workspace มี prefix `herdr:`

รายละเอียด core และขอบเขตอยู่ [Herdr core](../herdr/README.md) และ [Lifecycle](../herdr/LIFECYCLE.md) ข้อมูลคำตอบ Q1–Q21 อยู่ใน vault `plans/herdr-provider/PLAN.md` ไม่มีการสร้างข้อมูลแชทจาก terminal

การส่ง Herdr ต้องมี request ID และ expected generation ผ่าน durable ledger; helper เดิม `typeInto`/`typeLiteral`/`pressKey` ไม่อนุญาต Herdr เพื่อปิดทางส่งที่ไม่มี guard ของ Docs/PR/modes การ์ด Herdr เพิ่ม dialog token + generation ทุก action และไม่ส่งซ้ำอัตโนมัติเมื่อผลไม่แน่นอน

`index.ts` เลิก mount boot/writer ของ `herdr-autostart.ts` รุ่นเก่าแล้ว ใช้ lifecycle store เดียวสำหรับ create/restore/close; นำรายการเก่ามาเก็บเจตนาแบบ blocked-awaiting-binding ก่อน restore ไม่ใช้ `--last` ข้ามสมาชิก เอกสารหัวข้อด้านล่างเป็น contract ของร่างเดิมที่ยังเก็บโค้ดและ tests ไว้ ไม่ใช่ endpoint production ปัจจุบัน

## Herdr autostart รุ่นเดิม (เลิก mount ใน provider ใหม่)

เพิ่มวันที่ 7 พ.ย. 69: `herdr-autostart.ts` ดูแล command argv, runner, config และ routes; `herdr-autostart-core.ts` ดูแล data model, validation, inventory และ `ensure()` แยกจาก `autostart.ts` ของ tmux และ `resume.ts` ที่อ่าน Claude transcript ผ่าน Superset

### การตั้งค่าและ endpoint

เก็บรายการใน `~/.maw/herdr-autostart.json` แต่ละรายการมี `label`, `cwd`, `agentKind` (`codex` หรือ `claude`), `model?`, `resumeArgs?` ชื่อห้องใช้ a–z ตัวแรก ตามด้วย a–z/0–9/underscore/hyphen รวมไม่เกิน 32 ตัว โฟลเดอร์ต้องผ่าน `allowedDir()` ของ API เดิม

| endpoint | ผล |
|---|---|
| `GET /mobile/herdr/autostart` | รายการ config พร้อมสถานะจริงและ workspace ที่ยังไม่ได้ลงทะเบียน; `lastEnsure` แสดงผลตรวจ boot ล่าสุด (`started/skipped/errors`, เริ่ม `null`); ติดต่อ Herdr ไม่ได้ตอบ `503`, `running:null` |
| `POST /mobile/herdr/autostart` | เพิ่ม/แก้รายการด้วย `label`, `cwd`, `agentKind`, `on:true`; ส่ง `label`, `on:false` เพื่อลบออกจากรายการอัตโนมัติ |

POST บันทึก config เท่านั้น ไม่เปิด/ปิด agent ที่กำลังทำงาน ไม่มีปุ่ม UI ใหม่ในรอบนี้ บันทึกผ่านไฟล์ชั่วคราวแล้ว rename ด้วยสิทธิ์ `0600`; config เสียหรือมีรายการไม่ถูกต้องตอบ `500` และไม่เขียนทับ

คำสั่งเริ่มต้นคือ `codex resume --last` หรือ `claude --continue`; `resumeArgs` อนุญาตเฉพาะรูปแบบเดิมหรือ resume ด้วย UUID (`resume <UUID>` / `--resume <UUID>`) ไม่รับคำสั่งอิสระหรือ flags ข้ามการขออนุญาต ถ้าไม่พบ conversation เดิมไม่มี fallback เปิด conversation ใหม่อัตโนมัติ

### ลำดับการคืนห้อง

เมื่อ maw เริ่มทำงาน ตรวจ config ที่ 5 และ 60 วินาที ปิด timer เมื่อ `NODE_ENV=test` หรือส่ง `opts.file` เข้ามา (รวมค่าว่าง; ตรวจด้วย `opts.file === undefined`) เรียก Herdr ผ่าน argv แบบ async โดยระบุ `--session default` ทุกครั้ง ไม่ใช้ shell string

1. อ่าน workspace/agent inventory ใหม่ หากอ่านไม่ได้หรือ JSON ผิดรูปแบบ ไม่สร้างห้อง
2. ข้าม label ซ้ำหรือชื่อ agent ชนกับ workspace อื่น; agent เดิมที่ยังอยู่จะไม่ถูกแทนที่
3. สร้าง workspace ที่หายโดย `--no-focus` แล้วอ่าน inventory ยืนยัน ID จาก response
4. รุ่นนี้รองรับ workspace หนึ่ง pane ต่อหนึ่ง agent เท่านั้น ตรวจ cwd และ process-info ว่า shell เป็น foreground ก่อน `agent start`
5. หาก create/start ให้ผลไม่แน่นอน รวมถึง timeout ระงับ mutation ซ้ำสำหรับ label นั้นตลอดอายุ process นี้; ไม่ลองส่งซ้ำโดยอัตโนมัติ

มี guard ไม่ให้ `ensure()` ของ runner เดียวกันทำงานซ้อนกัน ความไม่แน่นอนเก็บใน memory ไม่ใช่ ledger ข้ามการเริ่ม maw ใหม่ และการตรวจ inventory ไม่รับประกันว่าจะไม่มีผู้ใช้ desktop เปลี่ยนห้องระหว่างคำสั่ง Herdr ต้องตรวจ foreground ซ้ำตอน start ด้วย

### เงื่อนไขและข้อจำกัด

- Herdr default server ต้องทำงานก่อนรอบตรวจ feature นี้ไม่ start/attach/restart server และไม่ติดตั้ง LaunchAgent ให้ Herdr
- หาก Herdr พร้อมหลัง 60 วินาที ไม่มี polling เพิ่มในรุ่นนี้ ยังไม่รับรองการคืนห้องข้าม reboot แบบครบวงจร
- รองรับ local default session เท่านั้น ไม่คืน layout หลาย pane หรือ remote session
- PATH ที่เพิ่มให้ runner ช่วยหา CLI; agent executable ใน shell ของ Herdr ยังขึ้นกับ environment ของ server/shell
- สถานะ running ยืนยันจาก inventory ไม่ใช่หลักฐานว่า resume conversation สำเร็จหรือผ่านหน้าถาม trust แล้ว
- หน้าห้อง Herdr/การเชื่อม chat ใน mobile และการตั้งค่าผ่าน UI เป็นงานคนละส่วน

### การตรวจ

ใช้ `NODE_ENV=test bun test test/mobile-*.test.ts` บนเครื่องพัฒนา ชุดใหม่ `test/mobile-herdr-autostart.test.ts` ใช้ runner/scheduler ที่ inject และ fixture สมมติเทียบ schema protocol 22 ไม่เรียก mutation ไปยัง Herdr จริง ไม่พิสูจน์การใช้งานผ่าน browser/มือถือหรือ reboot

ผลตรวจวันที่ 7 พ.ย. 69 โดยหัวหน้า: `NODE_ENV=test MAW_TEST_MODE=1 bun test test/mobile-*.test.ts` ได้ 343 pass / 0 fail (17 ไฟล์; เดิม 304 + ใหม่ 39) ผ่าน Bun/DI บนเครื่องพัฒนา ไม่ใช่ tests ทั้ง repository; bundle ของ feature ผ่าน `bun build` แต่ไม่ใช่ typecheck ทั้ง repository

ตรวจเพิ่มส่วน command/routes วันที่ 7 พ.ย. 69 ผ่าน `Elysia.handle()` ใน memory และ runner/scheduler ที่ inject: POST ไม่เรียก Herdr, GET อ่าน inventory, เขียนทับ config ได้สิทธิ์ `0600` และไม่เหลือไฟล์ชั่วคราว, config เสียไม่ถูกลบ, boot ที่ซ้อนกันและผลผิดพลาดแสดงใน `lastEnsure` ไม่มีการเปิด HTTP server หรือ mutation Herdr จริง

## ประวัติ

| วันที่ | ใคร (คน/AI) | แก้อะไร |
|---|---|---|
| 7 พ.ย. 69 | ไอ้คล็อต / Codex และลูก 3 ตัว | เพิ่ม Herdr autostart, config endpoints, การตรวจด้วย DI และบันทึกข้อจำกัด |

| 7 พ.ย. 69 | ไอ้คล็อต / phase2-herdr-cmdmap | ตรวจร่าง command/routes ด้วย DI, ใช้ LABEL_RE ร่วมกับ core และปิด boot เมื่อส่ง opts.file ค่าว่าง |

### ผลตรวจ core เพิ่มเติม — 7 พ.ย. 69

`herdr-autostart-core.ts` ตรวจ response envelope (`id`, `result.type`) และ field สำหรับ identity/occupancy ตาม schema protocol 22 รวมความสัมพันธ์ workspace/tab/root pane ของผล create ก่อนใช้งาน ตรวจ inventory และ terminal identity ซ้ำก่อนอ่าน foreground process; ถ้าพบ agent/name ชนหรือ terminal เปลี่ยนจะข้ามโดยไม่ start

`cwd` หลังผ่าน allow ต้องเป็น absolute path และไม่มี NUL/CR/LF; shell foreground ต้องมี PID ตรง shell PID, cwd ตรง config และชื่อ process อยู่ในรายการ shell ที่รองรับ (`sh`, `bash`, `zsh`, `fish`, `dash`, `ksh`, `nu`, `xonsh`) ชื่ออื่นหรือข้อมูลไม่ครบข้ามด้วย `shell_not_ready` การตรวจนี้ไม่ได้ล็อกการเปลี่ยนห้องจาก desktop และไม่ตรวจ background jobs

| วันที่ | ใคร (คน/AI) | แก้อะไร |
|---|---|---|
| 7 พ.ย. 69 | Codex `phase2-herdr-ensure` | ตรวจ schema/identity/foreground เพิ่ม และตรวจสถานะซ้ำก่อน start; ใช้ DI เท่านั้น |

| 8 พ.ย. 69 | ไอ้คล็อต / Codex | ต่อ provider และ lifecycle แทน legacy mount เพิ่ม guarded send/dialog, DI seam และเอกสารการรวม |

## Cross-agent continuity — 8 พ.ย. 69

`continuity.ts` เพิ่ม status/events/switch/advance/held-message routes หลัง auth เดิม โดย default production readiness เป็น false ไม่เปิด terminal จาก route นี้จน host integration และการทดสอบครบทั้ง Herdr/tmux/Superset ดู [README ของ module](../continuity/README.md) ส่วน UI ที่เตรียมไว้ซ่อนปุ่มขณะยังไม่พร้อม ไม่มีการเปิดใช้ผ่าน environment flag ลัดการรับรอง

## tmux entry seam — 8 พ.ย. 69

`autostart.ts` รับ optional `commandFor` ผ่าน mount/ensure จาก trusted host เท่านั้น API sanitizer ไม่รับ executable/release path/argv. ตัว builder ใน `../launch/tmux-entry.ts` ใช้ canonical prepared entry และไม่มี native fallback; verification failure ไม่สร้าง session. ค่า default legacy เดิมไม่เปลี่ยน ไม่มี timer เพิ่ม ดู `../launch/README.md`

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม 1 | บันทึก opt-in entry wiring และขอบเขต fixture tests |

## Continuity held v2 — 8 พ.ย. 69

POST `/mobile/rooms/:ws/:room/continuity/held` รับ `{id,text,intendedGeneration,expectedOperationId,expectedRevision}`; text1–8000chars. ใช้hostroomresolver+authเดิมแล้วเรียกatomicStore.holdForOperation ไม่ตัดสินactiveoperationจากsnapshotก่อนtransaction. Exact lost-ACK replayหลังcomplete/cancelคืนreceiptเดิมได้; fresh/stale/conflictingrequestปฏิเสธ. Responseเป็นstoredmessageมีversion2/originOperationId/originRevision/intendedBinding ไม่ใช่deliveryACK ไม่มีtargetretargetหรือautosendendpointเพิ่ม

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม1 ensure/cmdmap | เปลี่ยนheldrouteเป็นatomicv2และเก็บauth/scope/no-storeเดิม |

## Continuity input/lifecycle policy — 8 พ.ย. 69

`mountFeatures` รับ guard ของ API instance เดียวกัน ไม่ใช้ global mutable guard. เมื่อ configure continuity: exact room lookup คืน null จึงใช้เส้นทางเดิม; managed/malformed/error ปฏิเสธด้วย409 `continuity_delivery_not_certified` ก่อน input. Raw channel และ lifecycle ที่ไม่มี canonical scope ปฏิเสธทั้งหมดในโหมดนี้ รวม mapping callback คืนnull เพราะไม่ถือว่าเป็น unmanaged proof. Default ไม่มี continuity options คง behavior เดิม. นี่เป็นการปิดทางส่งที่ยังไม่รับรอง ไม่ใช่ native atomic input implementation.

ครอบ API send/reply/keys, permission key/type/answer, mode/model/effort, delivery resolve, wake/create ตาม guard ที่ host ต่อ. `docs` ตรวจ room ก่อน lookup และ channel ก่อนส่ง; `ports` ตรวจ channel ก่อน kill และทุก key; ไม่มี terminal ให้ถือว่า unknown. `prs`/`retro` ใช้ read/type dependencies ที่ห่อ guard ต่อ mount รวม background passes ไม่ย้อนกลับไปใช้ global unguarded dependencies. Loop registration แยกต่อ dependency object พร้อม dispose; startRetroLoop/startPrsLoop รับ scheduler จำลองเพื่อทดสอบ callback จริงโดยไม่เปิด timer production.

`herdr` mutation routes, Superset workspace/automation/task/script mutations, resume และ legacy autostart config/boot pass ปฏิเสธ unknown scope เมื่อ configure continuity. Herdr production readiness loop ไม่เริ่มใน configuration นี้จนมี lifecycle contract; GET status และการอ่านไม่ได้แปลว่าพร้อมส่ง. `ensureGuarded` ตรวจ policy ก่อนโหลดรายการ/สร้าง terminal. ไม่มีการเปลี่ยน runtime production ในรอบแก้ source.

External CLI/native keyboard และ daemon ที่เปิดนอก API instance ไม่ถูก guard นี้ครอบ จึงคง production gate ปิด. ต้องมี native/session ownership contract ก่อนใช้สลับจริง ไม่ใช้ guard callback อย่างเดียวอ้าง all-writer atomic.

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex root/ensure | ต่อ guard ผ่าน API/features/background/lifecycle และเพิ่ม fake-transport tests โดยคง default behavior |


8 พ.ย.69 — continuityเพิ่มauthenticatedfacts preview/selection callbacksและverifyก่อนswitch; noactor/archivepathจากclient. ไม่มีserviceคืน503. scope room-backendเปิดได้เฉพาะtrustedcapabilityและbackendของroomพร้อม; defaultall-backendsเดิม. Sourceมีpreparedseams ยังไม่เปิดproduction.
