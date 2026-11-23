# maw mobile — แอปมือถือคุมห้อง Claude Code / Codex

PWA หน้าเดียว (`m.html`) ที่ maw เสิร์ฟจาก Mac ให้มือถือ (ผ่าน Tailscale) ใช้คุยกับห้อง agent ใน tmux และ Superset,
ดูไฟล์ / Git / พอร์ต, PR, Mind, สถานะเครื่อง และโหมดเดินทาง (พับจอแล้วงานยังวิ่ง)

> แผนงาน + ประวัติละเอียดทุกการเปลี่ยนแปลง: `~/oracle/ψ/incubate/Soul-Brews-Studio/maw-js/PLAN-maw-mobile.md` (เครื่องพี่ Ball)

## ใช้งาน / deploy

| ทำอะไร | คำสั่ง |
|---|---|
| ส่งหน้าแอป (m.html · pwa · ext) ไปที่ maw เสิร์ฟ | `bash ui/mobile/deploy.sh` — มือถือโหลดตัวใหม่เองภายใน 1 นาที |
| แก้ฝั่ง server (`src/mobile/**`) | `launchctl kickstart -k gui/$(id -u)/homebrew.maw` (รีสตาร์ท maw) |
| build หน้าเว็บเก่า + ใส่แอปมือถือ | `bun run build:ui` (ที่ root) |
| เทส | `bun test test/mobile-*.test.ts` |
| ตัวอ่านความร้อน (ไม่ต้อง sudo) | `swiftc -O scripts/thermal.swift -o ~/.maw/bin/thermal` · `swiftc -O scripts/temps.swift -o ~/.maw/bin/temps` |
| สิทธิ์โหมดเดินทาง (ครั้งเดียว) | `sudo install -m 0440 -o root -g wheel scripts/maw-travel.sudoers /etc/sudoers.d/maw-travel` |

## โครงสร้าง

```
ui/mobile/
  m.html            ตัวแอปทั้งหมด (HTML + CSS + JS ไฟล์เดียว) · จุดต่อขยาย window.mawExt
  ext/*.js          feature pack ฝั่งหน้าจอ (โหลด defer หลัง m.html) → เสิร์ฟที่ /m-ext/
  pwa/              sw.js (แชร์รูปเข้าแอป · push · ห้ามใช้ cache เก่า) · manifest.json · ไอคอน
  deploy.sh         copy ไป ~/.maw/ui/dist (หรือ MAW_UI_DIR)
src/mobile/
  api.ts            route หลัก /mobile/* (ห้อง · แชท · ไฟล์ · git · สถานะเครื่อง · push · upload)
  features/*.ts     feature pack ฝั่ง server — mount(app) ลงทะเบียนใน features/index.ts · ใช้ helper จาก ctx.ts
```

**จุดต่อขยายของ pack (`window.mawExt`)**: `onRoom` · `onPoll` · `onHome` · `onComposer` · `beforeSend` (await ก่อนส่ง) · `tabs` (แท็บในโปรเจค, `folder: true` = ขึ้นในโปรเจคโฟลเดอร์ด้วย) · `keys` (ปุ่มลัด) · `pages` (`{key, icon, title, summary(), mount(el), tile?: false}` = ช่องในเมนูหน้าแรก หรือในเมนู ⋯ ถ้า `tile: false`)

## Feature pack

| pack | หน้าจอ | route หลัก (ใต้ `/mobile`) |
|---|---|---|
| continuity | ปุ่ม header เปลี่ยน agent/model, reference preview, explicit facts, progress/uncertain และ stored history/held | `GET /continuity/capabilities` · `/rooms/:ws/:room/continuity` · `/facts/preview` · `/facts/selections` · `/switch` · `/operations/:id` · `/events` · `/held` |
| permissions | การ์ดตอบหน้าขออนุญาต + การ์ดหน้าถามอื่น (trust folder, ตัวเลือก) · push เมื่อมีหน้าถามใหม่ | `GET /rooms/:ws/:room/prompt` · `POST …/prompt/answer` · `POST …/prompt/key` |
| modes | ป้ายโหมด (» bypass / auto / ‖ plan) · model · effort | `GET …/mode` · `POST …/mode/cycle` · `POST …/model` |
| activity | todo + วงกลม agent ลอย (งานเบื้องหลังของ Claude และ Codex) | `GET …/activity` |
| resume | แท็บ "ห้องเก่า" เปิดแชทเดิมต่อ | `GET /workspaces/:ws/sessions` · `POST /workspaces/:ws/resume` |
| context | Plugin · MCP · Hooks (อ่านอย่างเดียว) · @ไฟล์ ในช่องพิมพ์ | `GET /settings/agents` · `GET /rooms/:ws/:room/files` |
| superset | แท็บ Superset (workspace, automations, tasks, scripts) | `/superset/*` |
| travel | โหมดเดินทาง (`pmset disablesleep`) · +1/+3 ชม. · ปิดเองเมื่อแบตต่ำ/ร้อน/หมดเวลา/กลับมาที่โต๊ะ | `GET/POST /system/travel` |
| autostart | ⋯ → เปิดห้องอัตโนมัติ: ห้อง tmux ที่ maw สร้างใหม่ให้หลังรีสตาร์ท Mac | `GET/POST /autostart` |
| ports | แท็บ "พอร์ต": พอร์ตที่โปรเซสในโฟลเดอร์โปรเจคเปิดอยู่ · เปิด / หยุด / รันใหม่ | `/workspaces/:ws/ports*` |
| retro | เมนู "สรุปงาน": สั่ง /rrr หรือ /mind-rrr · แมนนวล / กึ่งออโต้ / ออโต้ | `/retro*` |
| prs | เมนู "PR": PR เปิดทุก repo · AI ตรวจ (skill `/review-pr-check` อ่านอย่างเดียว) · merge โดยคนกดเท่านั้น | `/prs*` |
| mind | เมนู "Mind": Mail Box + Mind Chat ของ Artron Mind (token อยู่บน Mac เท่านั้น) | `/mind/*` |
| mind-route | ตัวช่วยของ mind: "📤 ส่งให้ห้อง agent ทำ" ในแผ่นจดหมาย — เรียงห้อง Claude/Codex จาก `/projects` (ห้องที่เคยส่งเรื่องจากผู้ส่งคนนี้ · ชื่อโปรเจกต์/ห้องที่จดหมายพูดถึง · ห้องที่ตื่นอยู่) แนะนำสูงสุด 3 ห้อง → แตะ 2 ครั้งส่งเนื้อจดหมายเป็นแชทเข้าห้อง (`/rooms/:ws/:room/send`) · ติ๊กปิดการ์ดใน Mind ได้ (op close + note · 0 token) · จำห้องล่าสุดต่อผู้ส่งใน localStorage `maw-mind-route` · ฟังก์ชันล้วน เทสต์ `test/mobile-mind-route.test.ts` | `/projects` · `/rooms/:ws/:room/send` · `/mind/mail/:id/act` |
| vault | เมนู "📦 คลังไฟล์": ฝากรูป/ไฟล์ต้นฉบับ (ไม่ย่อ) จากมือถือเครื่องไหนก็ได้ ≤4 GB/ไฟล์ · สตรีมลงดิสก์ · ปฏิเสธเมื่อ Mac เหลือ <5 GB · รูปย่อ (sips / pdftoppm / ffmpeg) · โหลด ≤5 ไฟล์ทีละไฟล์ · มากกว่านั้นเป็น zip · "บันทึก/แชร์" (share sheet → คลังภาพ iPhone) · ลิงก์โหลดเซ็นชื่ออายุ 15 นาที (ไม่ต้องแนบ token) · ลบ = ย้ายไป `.trash` 30 วัน · ข้อมูลอยู่ `~/.maw/vault/` | `GET /vault` · `POST /vault/upload` · `/vault/thumb/:id` · `POST /vault/link` · `GET /vault/dl/:id` · `POST /vault/zip` · `POST /vault/delete` |
| docs | เมนู "📄 เอกสาร": เอกสาร ISO (โฟลเดอร์ `WP05 …`) ทุก repo · อ่านทีละหน้า (Mac แปลง Word/Excel/PDF → ภาพด้วย LibreOffice + pdftoppm, cache ใน `~/.maw/docs-cache`) · ไล่ `[TBD]` · ส่งคำตอบเข้าห้อง Claude · ✏️ ปากกาขีดทับหน้า + โน้ต → รายการรอส่ง → ส่งทีเดียวเข้าห้อง (ข้อความบรรทัดเดียว + path ภาพ) → เทียบก่อน/หลังกับรุ่นใหม่ (`~/.maw/docs-marks*`) · รุ่นเก่า (`_V1.0` เมื่อมี `_V1.1`) พับไว้ ไม่นับ TBD · อ่านอย่างเดียว | `GET /docs` · `POST /docs/render` · `GET /docs/page` · `/docs/marks*` · `GET /docs/mark-img` |

## ปุ่มเปลี่ยน agent / โมเดล — 8 พ.ย. 69

`ext/continuity.js` วางปุ่มใน `#ext-room-actions` ของ header จึงแยกจาก native quick keys. ปุ่มปิดเมื่อ capability/current room ยังไม่ยืนยัน; catalog มาจาก `models.agent/id/label` และสถานะปัจจุบันมาจาก room bindings เท่านั้น ไม่มี model/demo fallback และไม่มี picker Mind/Directเพิ่มในรุ่นแรก

ผู้ใช้กดดูบริบทอ้างอิงจาก `GET …/facts/preview` แล้วเลือก goal/facts พร้อม provenanceเอง ไม่มีการ preselect หรือเดา goalจากข้อความ. ต้องบันทึก explicit selection ผ่าน `POST …/facts/selections` ก่อน `POST …/switch`; ทั้งคู่ใช้ operation IDเดียวกัน และ factsSelectionIdเท่ากับIDนั้น. Preview/receiptไม่ตรงหรือ service503จะพัก ไม่ fallbackไปส่งคำขอเก่าแบบไม่มี facts

`scope` omitted/`all-backends` ใช้ gateครบสาม Backendเดิม. `room-backend` ใช้ได้เฉพาะ Backendใน current-room APIที่ hostรับรองพร้อม `ready`; UIไม่เดา Backendจากชื่อworkspaceและไม่เปิดreadyเอง. เปิด-ปิด/rolloutต้องคุมที่ host capability/service ไม่ใช่แก้ค่าบน browser

Browserเก็บ immutable switch/facts intentพร้อม scope/revision/binding และตรวจ storage readbackก่อนแต่ละ POST. ACKหายแสดง uncertain ไม่สร้าง IDใหม่/ส่งซ้ำจากpoll/reload. ปุ่มตรวจคำขอเดิมใช้ scoped `GET …/operations/:id` เท่านั้น ผลเป็น historical receiptไม่ใช่ current native readinessและไม่ advanceให้อัตโนมัติ. ไม่มี receipt lookupของ facts-selectionเดี่ยว: ถ้า selection ACKหายก่อน /switchจะพักชัดว่าไม่เริ่มสลับ ไม่สร้างreceiptเอง

Panelไม่ clear composer/files/native chat cache. Stored logical historyคงพร้อมป้ายข้อมูลก่อนหน้าเมื่อ revisionเปลี่ยนใน logical roomเดิม; ไม่ใช้ historyนี้อ้าง native conversation/epochใหม่. Guard physical generationแยกจาก continuity generation; เปลี่ยนห้อง/bindingระหว่างawaitหยุดก่อน POSTถัดไป. ไม่ส่ง held/draftหลังswitchสำเร็จเอง

**ขอบเขต release:** รอบนี้แก้เฉพาะ working source และ browser fixtures. Productionมี scoped static candidateแยก; ห้าม copyทั้ง working `m.html`/รัน deploy.shทั้งชุดเองหรือ restartserverจากงานนี้. Rootถือการรวมserver/candidateและnative acceptance. ผล fake APIไม่ใช่ live certification

## ข้อมูลที่เก็บบน Mac (`~/.maw/`)

`mobile.json` (token แอป + hook — ห้ามพิมพ์ค่า) · `push.json` (กุญแจ push — ห้ามพิมพ์ค่า) · `travel.json` · `autostart.json` · `prs.json` · `retro.json` · `folders.json` ·
`pr-verdicts/` (ผลตรวจ PR จาก AI) · `docs-cache/` (ภาพหน้าเอกสาร — ลบได้ สร้างใหม่เอง) · `uploads/` (รูป/ไฟล์ที่ส่งจากมือถือ) · `status/` (สถานะจาก statusline ของ Claude) · `bin/thermal`, `bin/temps`

## กติกา (ห้ามพลาด)

1. แก้ source ต้องมี tests/READMEตรงกัน แล้วรวม releaseตามสิทธิ์ที่ได้รับแยกต่างหาก — ไม่ deploy/restartอัตโนมัติ. โดยเฉพาะ working HTMLที่มี unreleased featuresต้องแยกจาก scoped production candidate; การจัดการ serverเป็นงานของผู้ดูแลตามคำสั่งล่าสุด
2. repo นี้ public — ห้ามใส่ token, hostname ของ Tailscale (`*.ts.net`), IP ภายใน, โดเมนบริษัท ลงโค้ด/คอมเมนต์
3. คำสั่ง shell ที่ Mac รัน สร้างฝั่ง server จากตัวเลือกตายตัวเท่านั้น — มือถือส่งคำสั่งเข้ามาไม่ได้ (autostart · ports · clone)
4. อนิเมชันบนมือถือต้องถูก: ห้าม animation วนไม่จบ / ไล่สีทุกเฟรม (เคยทำมือถือร้อนจน Chrome กิน CPU 160%) · หยุดทุกอย่างเมื่อ `document.hidden`
5. ส่งข้อมูลให้มือถือแบบ gzip (ทำใน `src/core/server.ts`) และไฟล์แอปส่ง `Cache-Control: no-cache` — Android เคยเปิดแอปเวอร์ชันเก่าค้างหลายวัน
6. AI ห้าม merge PR / ห้ามส่งข้อความเข้าห้องจริงตอนทดสอบ (ใช้ fake ในเทส)

## พักข้อความระหว่าง continuity — 8 พ.ย. 69

`ext/continuity.js` ใช้ `beforeSend` ที่ core รอผลจริงก่อนตอบ permission ผ่าน composer, upload และ provider send. `roomStateAvailable` มาจาก host แยกจาก `ready`; default ไม่ได้เปิด automatic switch. ห้องที่ host ยืนยันว่า unmanaged ใช้ทางส่งเดิม ส่วน managed room ที่ยังไม่มี operation จะเก็บข้อความในอุปกรณ์โดยไม่ส่ง.

ข้อความ text-only ที่มี operation จะเก็บ intent พร้อม room/operation/revision/generation เดิมใน localStorage และตรวจ readback ก่อน `POST …/held`. Receipt ตรงกันจึงแสดง “ข้อความพักที่ Mac — ยังไม่ส่งถึง agent”. หาก ACK หายจะไม่ส่งซ้ำจาก reload/reconnect; ผู้ใช้กดตรวจคำขอเดิมได้โดยไม่เปลี่ยน ID หรือปลายทาง. ไฟล์แนบพักในอุปกรณ์ ไม่มี upload หรือส่งเฉพาะข้อความแทนไฟล์ที่หาย. Storage ไม่สำเร็จจะแจ้งให้คงหน้าไว้ ไม่รับรอง browser eviction หรือ OS crash.

ข้อจำกัด: ไม่มี held delivery/discard/retarget ในรอบนี้. ข้อความที่เคยเริ่ม native delivery แล้วจะไม่ถูกเปลี่ยนเป็น held ใหม่; สำหรับ Herdr มีปุ่มตรวจ delivery เดิมผ่าน GET โดยตรวจ uid/generation ตรงเท่านั้น. ผลเป็นข้อมูลประกอบจาก ledger ไม่เปลี่ยนรายการเป็น sent ไม่ลบ ไม่ส่งซ้ำ และถ้า generation เปลี่ยนจะบอกว่า API ย้อนตรวจรุ่นเดิมไม่ได้. Mobile permission/raw/feature/lifecycle writers มี per-instance guard เพิ่มแล้ว แต่ keyboard/CLI/raw WebSocket และระบบอื่นนอก Mobile ยังไม่อยู่ใน guard นี้ จึงยังไม่ใช่ all-writer fence และคง production gate ปิด. การเปิดใช้จริงต้องต่อ host และผ่าน native acceptance ไม่ใช่เปลี่ยนค่า `ready` อย่างเดียว.


### Owned protocol บน logical room เดิม — 8 พ.ย. 69

`/projects` row ของ owned room ใช้ `transportKind/logicalRoomId/protocolBinding/revision/transportState` จาก host; identity guard รวม native ID/model/route ของ protocol แม้ Codex generation เดิม และ inventory ไม่ grant ready. Cached room ของปุ่ม header เก็บ `transportKind/logicalRoomId/revision/protocolBinding` ครบด้วย เพื่อให้การเปิด modal ใช้ identity เดียวกับ row ปัจจุบัน โดยไม่ลด stale-room guard

`ext/continuity.js` ใช้ GET `/rooms/:ws/:room/continuity/transport` เป็น authority ของ transport; การสลับสำเร็จหรือ native history เดิมไม่ให้สิทธิ์ส่ง protocol เอง เมื่อ host ประกาศ `kind:owned-protocol` หน้าเดิมแสดง stored `/events` ตาม cursor (เก็บในจอได้ 5000 รายการล่าสุด, อ่านสูงสุด 10 หน้าต่อรอบ) และปิด TUI keys/permissions/raw screen/suggestion ผ่าน awaited API guard ไม่มี native epoch จำลอง

ส่งได้เฉพาะ text เมื่อ transport idle และ `capabilities.textTurn:true`; actual composer บันทึก immutable `{ws,room,roomId,body:{id,text,expectedRevision,binding}}` พร้อม localStorage readback ก่อน POST `/continuity/turns`. ก่อนส่งอ่าน current room/transport อีกครั้งและตรวจ draft/files/scope; receipt ต้องตรง ID/logical room/full binding/native final correlation จึงล้าง draft เดิมได้ ไฟล์แนบและ voice files ยังคงอยู่ใน draft/local pending ไม่ upload ไม่ส่งเฉพาะ text แทน

บันทึก marker ของห้องที่เคยเป็น owned ไว้เพื่อห้าม fallback หลัง reload เท่านั้น marker ไม่ให้สิทธิ์ ready/textTurn; storage ไม่พร้อมอาจเก็บ marker ไม่ได้ แต่ turn intent ต้องผ่าน durable readback จึงส่งได้

Lost ACK/reload ไม่มี auto-send/re-ID/retarget; ผู้ใช้ตรวจด้วย GET `/continuity/turns/:id` ตามคำขอเดิมเท่านั้น Historical completion ไม่ให้ ready authority สำหรับ turn ใหม่ ข้อความที่เคยเริ่ม native delivery และ stored held intent เดิมไม่ถูกเปลี่ยนเป็น owned turn อัตโนมัติ Backend ยังต้อง wire trusted owned registry/inventory และ host admission เอง; UI fixture tests ไม่ใช่ production/live certification และไม่อ้าง all-writer atomic

Working source เท่านั้น ห้าม copy `m.html` นี้ทั้งไฟล์ขึ้น dist แทน scoped production candidate; ไม่ได้ deploy ในงานรอบนี้

### Bounded host acceptance purpose — 8 พ.ย. 69

`capabilities.authorization` มาจาก host เท่านั้น: `purpose:production` ใช้ evidence gate เดิม; `purpose:bounded-acceptance` แสดง “โหมดทดสอบจำกัดขอบเขต” พร้อมห้อง/โมเดล/route/คงเหลือ/หมดอายุ (GMT+7) จาก API; actions ใช้ป้าย “สลับโมเดล”/“ส่งข้อความ” และ production ใช้ “โหมดใช้งานจริง”. Permit ID/opaque hash ใช้ guard ภายใน ไม่แสดง implementation metadata ใน product flow. Advertisement อ่านได้โดยไม่ consume ไม่ใช่ production certification และ UI ไม่ override ready/backends

Fresh switch ต้องมี exact room/action และ advertised profile ที่ unique สำหรับ agent/model; text turn ต้องตรง agent/model/route และ namespace ของ `binding.generation` เพิ่มเติม Full opaque profile hash ให้ service ตรวจ. Missing/expired/revoked/exhausted/wrong-scope/ambiguous profile ปิด POST guards; modal stamp รวม authorization/ready/backends และ local expiry ปิด confirm เก่า โดยยัง revalidate API ก่อน effects จริง

Read-only current/progress/events/exact operation/turn receipt แยกจากสิทธิ์ fresh switch/text: ห้อง managed ยังอ่านได้เมื่อ budget0 หรือ readyfalse ไม่ล้างประวัติเพียงเพราะ permit หมด. Switch0 แต่ text1 ส่ง text ได้เฉพาะ profile ที่ API อนุญาต; หมดทุก permit ยังอ่านผลเดิมได้โดยไม่ grant current delivery. ถ้า permit หมดระหว่างรอ ACK จะคง original draft ตาม guard แม้ exact receipt completed แล้ว ไม่ส่งซ้ำ

## ประวัติ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 23 ต.ค. 69 | ไอ้แดง (Claude Code) | สร้าง README — สรุปโครง pack ทั้งหมด, deploy, ข้อมูลใน ~/.maw, กติกา (ประวัติละเอียดอยู่ใน PLAN-maw-mobile.md) |
| 30 ต.ค. 69 | ไอ้แดง (Claude Code) | เพิ่ม pack docs (เมนูเอกสาร ISO) · ห้อง Superset "ยังไม่เปิด" + wake · autostart เหลือ shell เมื่อ agent ปิด |
| 8 พ.ย. 69 | Codex ทีม1 | เพิ่ม awaited composer gate, durable held intent และเอกสารขอบเขตที่ยังไม่เปิด production |
| 22 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | Mind Mail: ปุ่ม "📤 ส่งให้ห้อง agent ทำ" + ห้องแนะนำ (`ext/mind-route.js` ใหม่ · `ext/mind.js` · close รับ `note`) |


## Herdr chat stability — 8 พ.ย. 69

Status/capability changes ใน session เดิมอัปเดต controls โดยไม่สร้าง chat DOM ใหม่. Cache ผูก workspace/room/agent/generation; native conversation/epoch เปลี่ยนจริงไม่ merge ข้อมูลเดิม. History transient แสดงข้อมูลที่ยืนยันล่าสุดพร้อมป้ายข้อมูลเก่า และ retry แบบอ่านอย่างเดียว. Herdr chat ไม่ใช้ generic offline API cache; latest request ป้องกันคำตอบเก่าทับใหม่ และ pagination signature รวม loaded range. Draft/ไฟล์/ตำแหน่งอ่านคงอยู่ใน same binding; missing capability ปิดทั้งปุ่มและ keyboard shortcut.

ผลทดสอบและ scoped static release ดู vault `plans/cross-provider-handoff/herdr-chat-stability-20261108/RESULT.md`. Browser fixture ไม่ใช่ native inference; ไม่เปิด cross-provider switch และไม่ restart serverจากการแก้ HTML นี้.

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | ทีม1 | Herdr capability/transient history/cache ordering/pagination และ composer guards |
| 8 พ.ย. 69 | Codex cmdmap/p5 | เพิ่ม header switch UI, explicit facts API, scoped capability, immutable intent/lookup และ regressions โดยไม่ deploy working source |
| 8 พ.ย. 69 | Codex cmdmap/p5 | ต่อ optional owned transport/text turn/status, ปิด TUI fallback, เก็บไฟล์/draft และแก้ facts reference 1024 พร้อม browser fixtures |
| 8 พ.ย. 69 | Codex cmdmap/p5 | แก้ P1 cached room protocol identity ของ header switch; เพิ่ม actual owned inventory header/stale confirm regression และทวน acceptance fixtures โดยไม่รัน native |
| 8 พ.ย. 69 | Codex cmdmap/p5 | ต่อ bounded authorization purpose/profile/action/expiry/budget guards แยก read-only state/history และเพิ่ม actual API/composition DI browser integration |

## ปรับปรุง 9 พ.ย. 69 — CLOSE one-way

Capabilities `switchDirections` คุมปุ่มสลับ Codex→Claude; Claude→Codex disabled พร้อมข้อความ “ยังพัฒนาอยู่”. Error มี `data-continuity-error`; uncertain ไม่มี automatic resend และรักษา draft. Browser fixture ผ่าน 10 cases ตาม `/tmp/maw-close-p4-browser-final.log`; ยังไม่ deploy.

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 9 พ.ย. 69 | Codex root | บันทึก production one-way implementation สำหรับ review ก่อนเปิดใช้ |

### Herdr incremental history — 9 พ.ย. 69

`history_indexing` เป็นสถานะเตรียมประวัติชั่วคราว: แสดงข้อความกำลังเตรียมและ poll ต่อ; แสดงประวัติเดิมได้เฉพาะ verified binding เดิมพร้อมป้ายข้อมูลเก่า ไม่ดึง cache ของ agent/session ใหม่ และไม่ล้าง draft. Backend/pagination tests และ browserผลfinalอยู่ CLOSE review packet.

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 9 พ.ย. 69 | Codex root | รักษาประวัติ same binding ระหว่าง bounded indexing |
| 23 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | หน้าตาแบบคลีน ขั้น 1: หัวจอห้องแถวเดียว (☰ · ชื่อห้อง+สถานะ · แชท/จอ · Mind Mail · ห้องใหม่) + ลิ้นชัก ☰ (ค้น · กำลังทำ/รอคุณ · ห้องทุกโปรเจกต์ · ไฟล์/Git) แทนแถบ branch/แท็บห้อง/seg/roomhead (ยังวาดแต่ซ่อน — `refreshTabs()` ใช้ `#tabs`) · สลับหน้าตาเก่าได้ (localStorage `maw-ui=classic` · ☰ บนหัวจอเก่าเพื่อกลับ) · ตัวแสดงตอน AI ทำงาน (Concocting…) คงเดิม |
| 23 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | หน้าตาแบบคลีน ขั้น 2: ช่องพิมพ์เป็นการ์ดมน (ข้อความบน · + / ไมค์ / ส่ง ล่าง · placeholder "บอกงานที่ให้ <agent> ทำ") · แถวปุ่มลัด + แนบไฟล์/ถ่ายรูป ย้ายเข้าแผ่น "+" (`openPlusSheet` กดแทนปุ่มเดิมที่ซ่อนอยู่ · ปุ่มลัดกดต่อกันได้โดยแผ่นไม่ปิด) |
| 23 พ.ย. 69 | ไอ้แดง (Claude Code) · พี่ Ball สั่ง | หน้าตาแบบคลีน ขั้น 3: ข้อความ AI ไม่มีกรอบ (15.5px) + ปุ่มคัดลอกใต้ข้อความ (`[data-cpy]`) · ข้อความเราเป็นฟองเทา (ซ่อน "คุณ · เวลา" ยกเว้นสถานะรอส่ง/ยกเลิก/กำลังส่ง) · ขั้นตอน agent (`details.tool` · `details.tgroup`) เป็นบรรทัดบางไม่มีกรอบ · บรรทัด `.who` ที่มีตัวหมุนตอนทำงานคงไว้ |
