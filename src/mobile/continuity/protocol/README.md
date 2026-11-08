# Native protocol integration

วันที่ 8 พ.ย. 69 · อยู่ระหว่าง integration ของปุ่มสลับ model ยังไม่เปิด production capability

| ไฟล์ | หน้าที่ | ขอบเขตหลักฐาน |
|---|---|---|
| `types.ts` | Common wire/session contract | `nativeObservation` แยกจาก `home`/`route` ที่ host ต้องตรวจ |
| `entry.ts` | Team2 candidate binding → typed policy/driver | ไม่อ่าน `env` ไม่ spawn และไม่ให้ launch authority |
| `entry-loader.ts` | ตรวจ reviewed source inventory และเรียก builder V2/V3 | Host-only; process spec มี private env ห้าม log; ดู `README-entry-loader.md` |
| `native-history-reader.ts` | ค้น exact UUID ใน native home ของ admitted profile แล้วอ่านเต็ม | ไม่เลือก latest; duplicate/missing/symlink ปฏิเสธ; ใช้ bounded stable reader ที่ตัด hidden reasoning |
| `host-composition.ts` | ประกอบ private pinned config, loader, supervisor, service และ history synchronization | Default off; ดู `README-host-composition.md`; pilot ไม่เปิด production capabilities |
| `service.ts` | Durable owned-room registry, facts selection, turn receipts และ inventory | ต้องมี trusted authority; ดู `README-service.md`; ไม่มี TUI adoption |
| `wire.ts` | JSONL framing, UTF-8 และขนาด frame, serialized write | ไม่มี process launch; failed write ไม่ replay |
| `turn-host.ts` | Persist intent ก่อน turn; exact retry คืน historical result | ใช้ได้เฉพาะ session ที่ host ถือ ownership แล้ว ไม่ใช่ lifetime lease |
| `codex.ts` | Codex 0.164.0 app-server driver | Fixed on-request/read-only/user-reviewer; native final แยกจาก ACK |
| `claude.ts` | Claude 2.1.220 stream-json driver | ต้องตรวจ initialization sequencing และ exact final ก่อน live |

Native lock key ผูก agent + canonical home + UUID lowercase เพื่อกัน logical room/UUID case alias ส่วน receipt ยังตรวจ native UUID แบบ exact ไม่เปลี่ยนคำตอบของ native เอง

Team2 ส่ง `buildProtocolLaunch` แบบ candidate-only; `liveEligible:false` ไม่ให้ caller เปลี่ยนเป็นสิทธิ์ spawn. Host ต้องตรวจ effective home, native pin, endpoint, settings/MCP/hooks, lifetime ownership, approval และ exit proof แยกก่อนใช้ candidate. ห้าม serialize candidate ทั้งก้อนเพราะ `env` มี credential

V2/V3 แยก `homeEnvironment` absent/present แล้ว การไม่พบ local managed files/cache ไม่พิสูจน์ว่าไม่มี policy จาก remote. Root ตรวจ safe gateway projection และ effective settings/env สำหรับ Claude Mind 2.1.220 context-only pilot โดยไม่เผย credential; เป็น point-in-time attestation ของ tuple นี้เท่านั้น ไม่รับรอง DIRECT หรือ production. Native pilot พบความต่างระหว่าง wire กับ fixture และยังไม่มี fresh+resume acceptance หลังแก้ล่าสุด

## ตรวจสอบ

`context-delivery.ts` ตรวจ exact native context-only/no-tools turn แยกจาก retrieval/semantic proof ดู [README-context-delivery.md](README-context-delivery.md)

`MAW_TEST_MODE=1 bun test test/mobile-protocol-wire.test.ts test/mobile-protocol-turn-host.test.ts test/mobile-protocol-codex.test.ts`

Root รัน 8 พ.ย. 69 ได้ 62 pass / 0 fail / 174 expects ผ่าน local DI/SQLite fixtures และ pinned schema artifacts ไม่ใช่ native inference หรือการใช้ปุ่มผ่าน browser

แผนและหลักฐานร่วม: `~/oracle/ψ/incubate/Soul-Brews-Studio/maw-js/plans/cross-provider-handoff/FINISH-PLAN.md`; contract ทีม2อยู่ `~/oracle/ψ/incubate/Artron-Innovative-Co-Ltd/artron-cli/PROTOCOL-ENTRY-API.md`

## ประวัติ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex root | Common contracts, JSONL wire, durable turn admission, UUID alias regression และบันทึกขอบเขต integration |
| 8 พ.ย. 69 | Codex root | เพิ่ม exact native UUID history reader สำหรับ trusted host; แยกจากการยืนยัน process ownership และ context receipt |

8 พ.ย.69 — `adapter.ts` เชื่อมownedruntimeกับContinuityEngineผ่านstagedlaunchWithContext; expectedtargetpolicyจากtrustedcandidateก่อนeffect, sourceexitก่อนtargetstart, verifyContextแยกจากnativefinal. Runtimeไม่มีในregistryต้องrejectไม่adoptTUI. `entry.ts` เพิ่มexplicitV2mapperและpresencemetadata; ไม่มีlaunchauthority.

8 พ.ย. 69 — `entry.ts` รับ V3 context-only pilot แยกจาก V2: ตรวจ typed policy, policy argv hash, final argv hash และ exact restrictive suffix. Mapper เลือกเฉพาะ public fields ไม่ spread candidate จึงไม่อ่าน `env` แม้เป็น enumerable getter. การตรวจนี้ไม่ให้ launch authority และไม่พิสูจน์ remote policy. Root รัน `bun test test/mobile-protocol-entry.test.ts test/mobile-protocol-runtime-host.test.ts test/mobile-protocol-adapter.test.ts` ได้ 45 pass / 0 fail / 400 expects ผ่าน local fixtures; targeted TypeScript exit 0. หลักฐาน `/tmp/maw-protocol-final-mapping.log` และ `/tmp/maw-protocol-final-mapping-types.log` ไม่ใช่ native หรือ production acceptance.

8 พ.ย. 69 — Native diagnostic จริงพบ Claude 2.1.220 ส่ง `command_lifecycle` ก่อน `init` (schema byte246207822). Driverตรวจ `command_uuid` เทียบ inbound user UUID, universal UUID, exact session และ state; fresh session hint ต้องตรงกับ initภายหลัง แต่ไม่ใช้เป็น native identity. queued/started/completedไม่ใช่ final receipt; cancelled/discarded/regressionหยุดโดยไม่ส่งซ้ำ. Focused Claude+runtime165pass874expects (`/tmp/maw-command-lifecycle-tests.log`), reviewerตรวจ sourceแล้ว. รอบnativeก่อนแก้ยังเป็นuncertainและownedprocessปิดแล้ว; ไม่ใช้ fixture ปิด live acceptance.

`inventory.ts` รวม owned roomจากtrustedregistryเข้ารายการprojectsด้วยworkspace/roomเดิม พร้อม `transportKind`, exact binding/revision และปิดTUI capabilities. ไม่discover/adopt agentจากชื่อ; aliasซ้ำหรือbindingไม่ตรงถูกปฏิเสธ. HTTP `/continuity/transport` และ `/continuity/turns` แยกจากlegacy `/send`; serviceต้องตรวจdurableintent/ownershipก่อนfreshturn, exactGETไม่ส่งข้อความซ้ำ.

8 พ.ย. 69 — `claude.ts` แยก assistant text candidate ที่มี `stop_reason:null` ออกจาก final acceptance เนื่องจาก exact pin yield assistant ก่อน `message_delta` แก้ stop reason ใน memory. Candidate ไม่ทำให้ turn จบ; result ต้องตรง session/user UUID/text, `end_turn`, `terminal_reason:completed` และไม่มี pending tools/tasks/approval/denials/deferred/error. Missing stop reason ยังปฏิเสธ ไม่อนุมาน null จาก diagnostic `assistantStopEndTurn:false`. Focused Claude+runtime 177 pass / 0 fail / 888 expects (`/tmp/maw-claude-pending-stop-tests.log`) และ p4 ตรวจ source แล้ว; ไม่ใช่ native acceptance. Source report ทีม2 `CLAUDE-ASSISTANT-RESULT-EMISSION-REVIEW.md` อธิบาย emission order ไม่พิสูจน์ actual null ของรอบเก่า

Root ตรวจเพิ่มแล้วพบ assistant flags ที่ report ขอให้รักษายังไม่มี guard จริง จึงเพิ่ม `aborted`, `is_virtual`, `is_api_error_message` ให้ปฏิเสธทันที และปฏิเสธ refusal ทั้ง stop reason และ content block ทุกตำแหน่ง แม้ตามด้วย text/result success. Focused ล่าสุด 182 pass / 0 fail / 901 expects ผ่าน local DI ใน `/tmp/maw-claude-assistant-flags.log`; รอบแรกมี assertion เดิมคาด error ที่ result แทน error refusal ที่เกิดเร็วขึ้น จึงปรับ assertion ให้ตรงการปฏิเสธทันทีแล้วรันใหม่ ไม่ใช่ native acceptance

ตาม schema ทีม2 `CLAUDE-SUPERSEDES-RETRACTION-SCHEMA.md` driver ยังไม่รองรับ replacement: `assistant.supersedes` ที่ไม่ว่างหรือผิดชนิดหยุดก่อน meta/parent filter และ `system/model_refusal_fallback` หยุดตาม policy แม้ไม่มี retraction list. ไม่ใช้ข้อความเดิมที่ถอนแล้วรับ success ภายหลัง ไม่คืนชีพจาก replay UUID เดิม ไม่ถือว่า tool effect ถูกย้อนกลับ. เพิ่ม 6 negative fixtures สำหรับ replacement/meta/subagent/malformed/fallback/ไม่มี list; ผล focused ล่าสุดให้ดู log เดียวกันหลังรอบนี้
