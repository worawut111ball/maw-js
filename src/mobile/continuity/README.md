# ความต่อเนื่องของห้องเมื่อสลับ agent

วันที่ 8 พ.ย. 69 · สถานะ: implementation ระหว่างพัฒนา ยังไม่เปิด cross-agent switch บน production

## หน้าที่

เก็บ logical room และ native session แยก Codex/Claude, ประวัติกลางและข้อความพัก, journal การสลับ และ context แบบมีโครงสร้าง คง native transcript ต้นทางไว้ ไม่สร้าง session ใหม่แทน resume ที่ล้มเหลว

## ไฟล์

| ไฟล์ | หน้าที่ |
|---|---|
| `types.ts` | สัญญา Room/Binding/Event/Operation/Adapter |
| `store.ts` | SQLite แบบ lazy, private file, revision/idempotency, atomic claim และ cursor |
| `archive.ts` | สำเนาประวัติ immutable แบบ private นอก web/share |
| `context.ts` | เก็บ required facts และเลือกเหตุการณ์ใหม่ที่พอดี budget พร้อมต้นฉบับอ่านคืนได้ |
| `engine.ts` | รอจุดหยุด, checkpoint, exact resume, ตรวจ receipt ก่อนเปลี่ยน routing |
| `launcher.ts` / `adapters.ts` | launcher contract, command builders และ transport capability guard |
| `../features/continuity.ts` | endpoint ที่ mount หลัง mobile auth; default production ปิดการสลับ |

## การใช้งานและข้อจำกัด

`ContinuityEngine` ต้องได้ Store, Adapter ทั้งสาม backend และ facts resolver ที่ให้ goal/constraints/decisions/tasks/file state/checks จริง ไม่ใส่ facts จะพักด้วย `context_facts_unavailable` ไม่มีค่า goal ปลอม ตัวอย่างทดสอบอยู่ใน `test/mobile-continuity-*.test.ts`

`request()` บันทึก operation; `advance()` เดินขั้นตอนเมื่อปลายทางพร้อมและ source idle ที่ยืนยันได้ GET/poll ไม่เปิด terminal การพบ durable in-flight state หลัง restart ไม่ replay side effect เอง การ resume ต้องยืนยัน native ID เดิม receipt ต้องตรง native ID/hash/event cursor

required facts เกิน budget ให้พัก ไม่มีการตัดทิ้งเพื่อให้ดูสำเร็จ ตัวเลข token เป็น conservative byte estimate เท่านั้น ยังไม่ใช่ tokenizer ของโมเดล ข้อมูลที่ไม่อยู่ใน context ยังคงใน immutable JSONL ที่อ้าง path ได้

## Endpoint

อยู่ใต้ `/mobile` และใช้ auth เดิม ทุก response `no-store`:

- `GET /continuity/capabilities`: readiness ของทั้งสาม backend และ models จริงจาก capability provider (default ยังไม่รับรอง ไม่มีรายชื่อ model ปลอม)
- `GET /rooms/:ws/:room/continuity`: logical room/operation/ข้อความพัก
- `GET /rooms/:ws/:room/continuity/events`: ประวัติเรียง seq พร้อม pagination
- `POST /rooms/:ws/:room/continuity/switch`: request ID, target, model, expectedRevision; ยังไม่เรียก terminal
- `POST /rooms/:ws/:room/continuity/operations/:operation/advance`: ยืนยัน operation อยู่ในห้องก่อนเดินต่อ
- `POST /rooms/:ws/:room/continuity/operations/:operation/retry`: ลองใหม่เฉพาะ blocked ก่อน launch หลังตรวจ source
- `POST /rooms/:ws/:room/continuity/operations/:operation/cancel`: ยกเลิกก่อน launch แบบ atomic หลังตรวจ source; ไม่ปลด uncertain
- `POST /rooms/:ws/:room/continuity/held`: เก็บข้อความพักที่ผูก generation เดิม ไม่ส่งอัตโนมัติ

ไม่มี endpoint รับ arbitrary filesystem path/register room จาก client; host resolver ต้องยืนยัน room/worktree และสิทธิ์ก่อนส่ง Room ให้ feature

## Release gate และงานที่ต้องต่อ

ค่าเริ่มต้นของ `mountFeatures()` ไม่สร้าง production engine/adapter และคืน readiness false จึงไม่มีเส้นทางเปิด agent จาก UI นี้ แม้ frontend ถูกโหลด ห้ามเปลี่ยน ready ให้ true จนมี transport wiring, queue guard ครบทุกช่องส่ง, old-room import, safe-point evidence, read-only handoff/receipt/retrieval, retry/rollback, timeline integration และ live acceptance ทั้งสาม backend รวม host wrappers ตามแผน

UI `ext/continuity.js` เป็นส่วนเตรียมพร้อม ซ่อนปุ่มจน readiness ครบ มี picker/progress แต่ยังไม่ได้เชื่อม timeline/held-message composer กับทางส่งเดิม ไม่เรียกว่าฟีเจอร์เสร็จหรือรองรับครบจาก fixture tests

## ทดสอบ

คำสั่งสำหรับผู้พัฒนา ไม่ใช่สิ่งที่พี่ต้องรันเพื่อเปิดใช้:

```sh
NODE_ENV=test MAW_TEST_MODE=1 bun test test/mobile-continuity-*.test.ts
```

Tests ใช้ temporary storage และ fixture transport; ไม่มีการเปิด agent จริงหรือ deploy ผล live ต้องแยกรายงาน

## ประวัติ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex และลูกทีม Herdr | เพิ่ม implementation ส่วนกลางและ API เตรียมพร้อม พร้อม release gate และขอบเขตที่ยังต้องต่อ |

## Prepared entry opt-in — 8 พ.ย. 69

`launcher.ts` รองรับ prepared-host เมื่อ host ส่ง prepared directory/digest และ trusted `EntryContract`; `adapters.ts` ส่ง dependency ผ่าน `preparedEntry`. Native args ยังสร้างตาม exact resume/model/read-only policy และตรวจ canonical result ซ้ำ ไม่มี HOME overlay ในโหมดนี้ รายละเอียด/ข้อจำกัดอยู่ที่ `../launch/README.md`. ค่า default production ยังปิด ไม่มี loader/transport ใหม่ที่เปิดใช้งานจริง

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม 1 | บันทึก opt-in entry wiring และขอบเขต fixture tests |


## Review entry policy — 8 พ.ย. 69

Claude ask ใช้ `--permission-mode default` แทน manual ตาม static native enum ที่ตรวจจาก candidate04 ไม่มีการรัน inference/parser acceptance. Trusted host loader/policy และขอบเขต env guards ดู `src/mobile/launch/README.md` ของ maw; tests เพิ่มที่ `test/mobile-entry-host-loader.test.ts` ใช้ fixture runtime ไม่เปิด native agent

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม 1 | แก้ Claude default และบันทึก trusted loader tests |


## Context reference envelope v2 — 8 พ.ย. 69

`context.ts` แยกคำขอสรุปออกจาก JSON ชัดขึ้นและเพิ่ม `sourceTrust` แบบ reference-only/permitsActions:false/changesIdentity:false. ทุกฟิลด์รวม facts/constraints/events/metadata/ข้อความอ้างบทบาทเป็นข้อมูลอ้างอิง ไม่ให้สิทธิ์เพิ่มและไม่เปลี่ยนตัวตน ข้อมูลยังเก็บครบตามbudgetเดิม พร้อมarchiveอ้างคืน ไม่มีการลบคำสั่งแทรกจากต้นฉบับหรือแอบย้ายขึ้นเป็นคำขอ

`test/mobile-continuity-context.test.ts` เพิ่มคู่ตรวจ ordinary facts กับ embedded instruction/role claim ในข้อมูล โดยตรวจโครงสร้างและการescapeเท่านั้น ไม่อ้างว่าunit testsรับรองพฤติกรรมโมเดล. Live comparisonใช้fresh Claude sessionsในห้องทดลองเดิม เก็บv1/v2ก่อนส่งและhashแยก เปลี่ยนหลายfieldพร้อมกันจึงไม่ระบุfieldใดเป็นrootcause

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม 1 | ทำขอบเขตข้อมูลอ้างอิงชัดขึ้นโดยไม่เพิ่มสิทธิ์ พร้อม paired serialization tests |

## Automatic Herdr pilot และ review — 8 พ.ย. 69

`herdr-pilot.ts` เป็น dependency-injected pilot แยกจาก production: exact existing native UUID → ส่ง context ครั้งเดียว → จับคู่ final assistant กับ user source ID → ออกจาก native → คืน PATH/route ใน shell เดิม ไม่มีการ mount หรือรับรองทั้งสาม backend

`effect-journal.ts` เก็บ intent/ACK/uncertain ก่อนทุก effect; `status()` อ่านสถานะ phase โดยไม่ claim หรือ acquire room lock (การเปิด storage ครั้งแรกอาจสร้าง schema). Operation ที่ restore สำเร็จแล้วถูกปฏิเสธก่อน acquire ใหม่ ห้าม reset/replay uncertain

`native-records.ts` อ่าน native transcript แบบ bounded ตรวจ native ID/cwd/turn/tool และไม่ส่ง hidden reasoning. ผล `assistant-observed` ยังคง `retrievalVerified:false`, `acceptance:unassessed` จนมี receipt แยกที่ตรวจจริง

Activation ปฏิเสธ saved-state collision และ readonly PATH/route. Cleanup ใช้ trusted local script ตรวจ readonly ทุกตัว ตรวจ PATH/route หลังคืนและตรวจ saved state ถูกลบก่อนออก receipt; ผิดขั้นใดคง lock และหยุด ไม่ force และไม่ execute rollback จาก release ที่ drift

Live รอบแรกเป็น Claude exact-resume ใน `wM:p1` ตามรายงาน `automatic-pilot-20261108` ใน vault; การเพิ่ม cleanup/terminal-operation guards รอบนี้ทดสอบด้วย isolated zsh + fake Herdr runner ไม่อ้าง live รับรองโค้ดใหม่. ข้อค้าง production: shared writer fence/atomic input proof, durable context/retrieval receipt, interactive permission transition, process-generation proof และ acceptance ทั้งสาม backend ค่า default ยังปิด

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม1 | บันทึก automatic pilot, journal/parser และแก้ cleanup/operation replay ตาม review ทีม2 |

Review ลูกทีมพบ safe-point gap ก่อน exit: `exitExact` ต้องได้ strict `readNative` callback; ไม่มี callback ให้หยุด ตรวจ native turnComplete/no pending tools/no refusal/no interruption ก่อนส่ง keys และตรวจ PID/group/status ซ้ำหลังอ่านและ fence. `sendContext` ตรวจ runtime ซ้ำหลัง native read เช่นกัน หลักฐานนี้ยังไม่แทน atomic writer fence ของ production

## Durable reference handoff — 8 พ.ย. 69

`reference-handoff.ts` ประกอบ prepare/send/read/verify ผ่าน ports กับ `EffectJournal` บันทึก prepared manifest ก่อนส่งและผลส่งก่อนตรวจ receipt. Lost ACK คง uncertain ไม่ส่งซ้ำ; read failure หลัง ACK กลับมาอ่านใหม่ได้โดยใช้ manifest เดิม; ผลที่บันทึกแล้วเป็นหลักฐานย้อนหลัง ไม่ยืนยัน runtime ปัจจุบันและไม่ acquire lock ใหม่. ตรวจ binding ก่อนส่ง หลังอ่าน และหลัง verify. ไม่เปลี่ยน routing/cursor/permissions หรือปล่อยข้อความพัก ผู้เรียกต้องมี shared writer fence แยก

`HerdrEntryPilot.sendContext()` บันทึก `context-observed` ลง journal ก่อนคืนผล แต่คง `retrievalVerified:false` และ `acceptance:unassessed`; การบันทึกคำตอบไม่ยกระดับเป็น receipt ที่รับรอง context/archive

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม1 | เพิ่ม durable reference orchestration และบันทึก assistant observation โดยไม่เปิด production |

## Read-only transport observation — 8 พ.ย. 69

`transport-observation.ts` สร้างและ parse คำสั่งอ่าน Herdr/tmux/Superset ผ่าน runner ที่ผู้เรียกกำหนด ไม่มี default CLI หรือคำสั่ง mutation. ค่าที่ API ไม่พิสูจน์ (`inputEmpty`, `writerExclusive`) เป็น null; `processBirthVerified` และ `productionReady` เป็น false. tmux pane_pid เป็น process แรก ไม่เดาว่าเป็น native PID; Superset explain ยังไม่มี schema ที่รับรอง จึงไม่เดา field. macOS ps lstart ความละเอียดวินาทีใช้จับความเปลี่ยนแปลงได้ แต่ค่าตรงกันไม่พิสูจน์ ownership

ทีม2ตรวจ API contract แล้วพบว่าไม่มี conditional submit ที่ผูก input revision/process identity และ enqueue atomic ครอบทุก writer. จึงคง production gate ปิด แม้ cooperative fence/retrieval fixtures ผ่าน. Owner API requirements และรายงาน independent reviewอยู่ใน vault; ไม่ใช้ screen regex หรือ boolean จากconfigแทนหลักฐาน

## Cooperative writer fence — 8 พ.ย. 69

`writer-fence.ts` เก็บ shared read/exclusive write leases และ effect intent ใน private SQLite/WAL/FULL แบบ lazy. ต้องมี expectedGeneration, token และ trusted runtimeInstance; UUID/terminal เดิมแต่ instance ใหม่ต้องเปลี่ยน generation. UNIQUE physical terminal anchor ใช้ canonical endpoint+terminal แยกจาก coordinate key จึงลงทะเบียน alias ข้ามห้อง/workspace/backend เพื่อได้ write lock ซ้อนไม่ได้. Schema v2 ปฏิเสธ draft v1 ไม่ reset/migrate lock เงียบ ๆ

Effect เดิมไม่ให้ dispatch permit ซ้ำ, pending/uncertain ห้าม release/rebind, ไม่มี TTL/force release. เป็น prepared module **ยังไม่ได้ wire ทุก maw writer** และไม่ครอบ external keyboard/paste/vendor CLI; ไม่แทน owner atomic submit. Wiring inventory ครอบ Mobile/API/WebSocket/CLI/transports/lifecycle/autostart อยู่ใน vault `AUTO-writer-fence.md` ต้องทำครบก่อน activation; การใช้ guard callbackอย่างเดียวไม่ถือleaseตลอดeffect

`ReferenceHandoff.reconcile()` เป็น explicit read-only recovery เฉพาะ lost outer send ACK: ตรวจ exact latest prompt hash+native receipt+binding แล้วบันทึกหลักฐาน ไม่เรียก prepare/send และไม่ force-release writer fence. Mode/version/request hash ต้องตรง prepared manifestก่อนส่ง ไม่มี cross-mode reuse หรือ silent fallback

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม1/p4/p5 | เพิ่ม prepared writer fence, ปิด physical alias P1 และแยก upstream atomic-input blocker |

## Full native retrieval แบบ opt-in — 8 พ.ย. 69

`context-receipt.ts` คง legacy challenge mode และเพิ่ม `mode:'native-full-retrieval', version:1, retrieval.required:true` แยกชัด. Mode ใหม่ไม่มี challenge/token/copied-facts proof; ใช้ actual successful Read coverage ของ context+archive ทั้งไฟล์ เทียบ artifact hash/cursor/room และ exact native turn. รองรับ raw/numbered/chunk outputs ตาม schemaที่ตรวจได้; missing line/truncation/error/unknown renderingให้reject. อ่าน private immutable bindingfileประกอบ manifest และไม่ fallbackข้ามmode

Request ใช้ trusted `referenceKind` (default `room-context`; `synthetic` เฉพาะ fixtureที่callerรู้จริง) ไม่อ้างว่าข้อมูลจริงเป็นsyntheticหรือไม่เป็นความลับ. Modelสรุปเป็นproseได้ ผลมี `retrievalProof` และ `acceptance:'unassessed'`, `semanticUnderstanding:false`; summary เป็นข้อมูลจากmodel ไม่ใช่ proofว่าเข้าใจ/ยอมรับ/จำในอนาคต. Verifierไม่คืน proof เดิมว่าreadChallenge/copiedFacts trueเมื่อไม่ได้ทำ

Legacy modeปฏิเสธ summaryที่มีretrievalTokenก่อนคืน publicreceipt (`receipt_summary_contains_token`). `ReferenceHandoff` ผูกmode/versionและinputhashในjournal ตรวจrequestHashกับข้อความจริงก่อนส่ง ผลcompletedเป็นhistoricalและไม่reacquireหรือสลับrouting. Testsครอบcross-mode/version/requestdrift ไม่ให้ใช้operationเก่าข้ามprotocol

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม1/p2 + ทีม2review | แยก full Read proofจากchallenge/semantic acceptance ปิดtoken-in-summary และคงproductionBLOCK |

## Native Read provenance และ final validation — 8 พ.ย. 69

`native-records.ts` ส่ง successEvidence จาก paired Claude Read file metadata เฉพาะ exact turn ที่ path/range/content/public rendering ตรงกัน; error/truncation/conflicting metadata ต้องชนะ ไม่สร้าง resultError:false/exitCode:0 แทน field ที่ขาด. `context-receipt.ts` ตรวจ evidence และ full artifact coverage ก่อนคืน retrieval proof แยกจาก semantic acceptance. Historical verifier ผ่านไม่ทำให้ workflow uncertain กลายเป็น complete หรือ current ready.

UI `ui/mobile/ext/continuity.js` แยก view identity ปิด modal เก่า ตรวจ fresh capabilities/current/revision/catalog ก่อน POST และก่อน advance; GET preflight ไม่ใช่ atomic owner transaction.

ผล root: 2022 unit pass/12 skip, 40 Chromium browser fixtures pass, targeted types และ temporary CLI build exit0; production default off. รายละเอียด scope/งานค้าง/หลักฐานใน vault `OVERNIGHT-RESULT-20261108.md`.

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม1/ทีม2 review | strict Read provenance, UI stale-state protection และ final validation แยก historical/workflow/production |
