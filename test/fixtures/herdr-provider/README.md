# Fixtures สำหรับ Herdr provider

วันที่ 8 พ.ย. 69 · ผู้ทำ Codex phase2-herdr-tests

## ที่มา

ข้อมูลสมมติสำหรับ tests ผ่าน DI เท่านั้น ไม่ใช่ inventory, prompt หรือ transcript จริงของผู้ใช้ ใช้ `/home/example/project`, `demo-*` และ UUID สมมติ ไม่มี IP, hostname, ชื่อลูกค้า, home path ของเจ้าของ หรือ secret

`protocol22.schema.json` ตัด success variant `session_snapshot` และ definitions ที่อ้างถึง รวม error response จาก schema protocol 22 ที่หัวหน้าสำรวจเดิม เก็บ `source_sha256` ของต้นฉบับ ไม่สร้าง schema จาก implementation tests ใช้ตัวตรวจ structural keywords แบบ subset ไม่ใช่ full JSON Schema validator และไม่ถือว่า upstream protocol รุ่นใหม่ถูกตรวจแล้ว

## รายการ

| ไฟล์ | สิ่งที่จำลอง |
|---|---|
| `snapshot-team.json` | สี่ agent สอง tab ใน cwd เดียวกัน มี Claude/Codex และ native conversation ต่างกัน สถานะ working/blocked/idle/done |
| `snapshot-empty.json` | valid snapshot ที่ไม่มีห้อง ต่างจาก error |
| `snapshot-shells.json` | มี pane แต่ไม่มี agent ต้องไม่เปิดสิทธิ์ส่ง |
| `snapshot-other-agent.json` | agent ชนิดอื่นที่ API รองรับเป็น string ดูจอได้แต่ไม่เปิด write |
| `snapshot-replaced.json` | pane/cwdเดิมแต่ terminal/native conversation ตัวแรกเปลี่ยน |
| `error-unavailable.json` | error envelope ของ session ที่ไม่มี |
| `error-agent-not-found.json` | error envelope ของ agent ที่ไม่มี |
| `claude-native.jsonl` | user/assistant สมมติในรูปแบบ Claude JSONL |
| `codex-native.jsonl` | session metadata และ user/assistant สมมติในรูปแบบ Codex rollout |
| `protocol22.schema.json` | upstream snapshot/error schema subset อิสระจาก parser |

## การทดสอบและข้อจำกัด

`test/mobile-herdr-provider-fixtures.test.ts` ตรวจโครงสร้าง fixtures กับ schema, required fields/types, identity links, replacement และรูปแบบ native transcripts `test/mobile-herdr-provider.test.ts` ตรวจ runtime ผ่าน injected runner/clock กับ SQLite ใน temp dirs ข้อมูลผิดรูปแบบและ race เพิ่มโดย clone fixtures ใน memory ไม่มี real CLI fallback

tests กลุ่ม lifecycle, production wiring และ in-memory HTTP ใช้ exports จริงของผู้รับผิดชอบ ตรวจ identity/side effects/retry/recovery โดยไม่เปิด server ผล fixtures ผ่านไม่ได้ยืนยัน behavior runtime, UI, real Herdr/socket, browser, มือถือ, Tailscale หรือการคืนห้องหลัง restart รายงานผลจริง/ช่องว่างอยู่ `IMPLEMENT-tests.md` ใน vault ของงาน ไม่อ้างการสร้าง fixtures เท่ากับรองรับ Q1–Q21 ครบ

## ประวัติ

| วันที่ | ใคร (คน/AI) | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex phase2-herdr-tests | สร้าง synthetic snapshot/native transcripts/error และ pin schema protocol22 เพื่อทดสอบ provider ผ่าน DI |

ผลรันสุดท้ายของ glob provider/lifecycle: 101 pass, 0 fail (8 พ.ย. 69; ของผู้ทำ94+cmdmap7) ผ่าน DI/temp files/in-memory HTTP log `/tmp/maw-herdr-provider-final-own.log` ไม่ใช่ผล live Herdr หรือมือถือ
