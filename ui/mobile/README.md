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

**จุดต่อขยายของ pack (`window.mawExt`)**: `onRoom` · `onPoll` · `onHome` · `onComposer` · `tabs` (แท็บในโปรเจค, `folder: true` = ขึ้นในโปรเจคโฟลเดอร์ด้วย) · `keys` (ปุ่มลัด) · `pages` (`{key, icon, title, summary(), mount(el), tile?: false}` = ช่องในเมนูหน้าแรก หรือในเมนู ⋯ ถ้า `tile: false`)

## Feature pack

| pack | หน้าจอ | route หลัก (ใต้ `/mobile`) |
|---|---|---|
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
| docs | เมนู "📄 เอกสาร": เอกสาร ISO (โฟลเดอร์ `WP05 …`) ทุก repo · อ่านทีละหน้า (Mac แปลง Word/Excel/PDF → ภาพด้วย LibreOffice + pdftoppm, cache ใน `~/.maw/docs-cache`) · ไล่ `[TBD]` · ส่งคำตอบเข้าห้อง Claude · ✏️ ปากกาขีดทับหน้า + โน้ต → รายการรอส่ง → ส่งทีเดียวเข้าห้อง (ข้อความบรรทัดเดียว + path ภาพ) → เทียบก่อน/หลังกับรุ่นใหม่ (`~/.maw/docs-marks*`) · รุ่นเก่า (`_V1.0` เมื่อมี `_V1.1`) พับไว้ ไม่นับ TBD · อ่านอย่างเดียว | `GET /docs` · `POST /docs/render` · `GET /docs/page` · `/docs/marks*` · `GET /docs/mark-img` |

## ข้อมูลที่เก็บบน Mac (`~/.maw/`)

`mobile.json` (token แอป + hook — ห้ามพิมพ์ค่า) · `push.json` (กุญแจ push — ห้ามพิมพ์ค่า) · `travel.json` · `autostart.json` · `prs.json` · `retro.json` · `folders.json` ·
`pr-verdicts/` (ผลตรวจ PR จาก AI) · `docs-cache/` (ภาพหน้าเอกสาร — ลบได้ สร้างใหม่เอง) · `uploads/` (รูป/ไฟล์ที่ส่งจากมือถือ) · `status/` (สถานะจาก statusline ของ Claude) · `bin/thermal`, `bin/temps`

## กติกา (ห้ามพลาด)

1. แก้ `m.html` / `ext/*.js` แล้วต้อง `deploy.sh` · แก้ `src/mobile/**` ต้องรีสตาร์ท maw — เทสก่อนรีสตาร์ทเสมอ (รีสตาร์ทแล้วมือถือหลุดชั่วครู่)
2. repo นี้ public — ห้ามใส่ token, hostname ของ Tailscale (`*.ts.net`), IP ภายใน, โดเมนบริษัท ลงโค้ด/คอมเมนต์
3. คำสั่ง shell ที่ Mac รัน สร้างฝั่ง server จากตัวเลือกตายตัวเท่านั้น — มือถือส่งคำสั่งเข้ามาไม่ได้ (autostart · ports · clone)
4. อนิเมชันบนมือถือต้องถูก: ห้าม animation วนไม่จบ / ไล่สีทุกเฟรม (เคยทำมือถือร้อนจน Chrome กิน CPU 160%) · หยุดทุกอย่างเมื่อ `document.hidden`
5. ส่งข้อมูลให้มือถือแบบ gzip (ทำใน `src/core/server.ts`) และไฟล์แอปส่ง `Cache-Control: no-cache` — Android เคยเปิดแอปเวอร์ชันเก่าค้างหลายวัน
6. AI ห้าม merge PR / ห้ามส่งข้อความเข้าห้องจริงตอนทดสอบ (ใช้ fake ในเทส)

## ประวัติ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 23 ต.ค. 69 | ไอ้แดง (Claude Code) | สร้าง README — สรุปโครง pack ทั้งหมด, deploy, ข้อมูลใน ~/.maw, กติกา (ประวัติละเอียดอยู่ใน PLAN-maw-mobile.md) |
| 30 ต.ค. 69 | ไอ้แดง (Claude Code) | เพิ่ม pack docs (เมนูเอกสาร ISO) · ห้อง Superset "ยังไม่เปิด" + wake · autostart เหลือ shell เมื่อ agent ปิด |
