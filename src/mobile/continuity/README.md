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

## นำเข้าประวัติแบบ atomic — 8 พ.ย. 69

`ContinuityStore.importHistory(room, records)` เป็น host-only storage boundary รวม registration และ append ทุก batch ใน transaction เดียว มีเพดาน100000events/64MiB. ตรวจ exact current room/revision/binding และปฏิเสธ operation ที่ยัง active; events ต้องมาจาก active agent/native UUID. Conflict ช่วงท้าย rollback ทั้งหมด รวม room ใหม่. ไม่อ่าน native file หรือพิสูจน์ runtime เอง ผู้เรียกต้องยืนยัน binding ก่อน/หลังอ่าน; ไม่ใช่ API ให้ client ระบุ path.

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม1 | เพิ่ม atomic history import และ regression tests rollback/dedup/stale binding |

## Facts snapshot — 8 พ.ย. 69

`EngineOptions.facts(room, snapshot)` ได้ roomRevision/sourceBinding/throughSeq/archivePath/archiveHash/events จาก checkpoint เดียวกับ context. Arguments เป็น detached clone ไม่ให้ callback เปลี่ยน authoritative room/events. นี่เป็น integration seam ไม่ใช่ structured facts resolver: caller ยังต้องตรวจ explicit selection/provenance และไม่ใช้ global latest หรือเดา goal; ยังไม่รับรอง semantic truth/approval จาก hash.

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม1 + ทีม2 contract | ผูก callback กับ archive snapshot และทดสอบ mutation isolation |

`history-import.ts` เพิ่ม host-only import ที่ตรวจ exact room/native UUID/cwd/generation/model/route ก่อนและหลังอ่าน full bounded native records แล้วเรียก atomic Store. ไม่มี public path input ไม่มี latest lookup/launch/keys. ผลเป็นhistoricalเท่านั้น; NativeRecords shapeไม่รับรองfull-file attestationด้วยตัวเอง ต้องใช้trusted full readerจริง ไม่อ้างpre/postcheckเป็นatomicruntimeproof. `AUTO-history-import.md` ในvaultระบุข้อจำกัดและfreeze.

Engine และ context builder ปฏิเสธ cursor ที่เกินประวัติจริง (`history_cursor_unavailable`); emptyhistoryไม่ใช้targetcursorเติมthroughSeq. Engineหยุดก่อนarchive/facts/launch. ทีม2รันpurebuilderและreviewnegativecasesอิสระแล้ว.

ผลรอบต่อ: continuity453pass/0fail/2554assertions/13files; targetedtypes4modules+testsและdiffcheckexit0. เป็นtemporarySQLite/parserfixtures/adapterfixtures ไม่มีnewlive/deploy.

## Explicit facts และ durable selection — 8 พ.ย. 69

`facts-resolver.ts` รับ snapshot กับ explicit selections จาก trusted host เท่านั้น ตรวจ archiveHash/cursor/roomRevision/sourceBindingHash/eventHash และเก็บ provenance ราย field. ไม่เลือก goal จากข้อความอิสระหรือ metadata approval; ไม่มี goal คืน missing และหลาย goal ขัดกันคืน conflict. v1 รับ compact JSON.stringify envelope ทั้ง event เท่านั้น ไม่รองรับ pretty/prose/projectMemory/supersedes และไม่ normalize ประวัติเก่าเอง. hash/provenanceไม่ใช่หลักฐานการอนุญาตหรือsemantic truth

`facts-selection.ts` เป็น host-only immutable private store: approve ตรวจresolverก่อนเขียนไฟล์0600ในdirectory0700, fsynccontentก่อนatomiclinkและfsyncdirectory. ExactIDretryคืนข้อมูลเดิมหรือrejectconflict ไม่มีlatestlookup/overwrite. read ตรวจprivate regular fileด้วยO_NOFOLLOW|O_NONBLOCK, ขอบเขตsize/snapshot/provenanceทั้งหมด และทำdirectorydurabilitybarrierก่อนคืนผล แม้publisherหยุดหลังlink. StoredactorIdเป็นlabelจากtrustedcaller ไม่ใช่authenticationที่moduleตรวจเอง

`createFactsProvider` ต่อ engine ด้วย explicit persisted selection ID และ detached checkpoint. ไม่มี selection blockก่อนlaunch; ไม่มีAPIauth/selectionUIproducerในรอบนี้จึงยังไม่ปิดproductionfactsgate. การเลือกข้อความquoted/tool/assistantเป็นreferenceclaim ไม่ยกระดับเป็นคำสั่งหรือสิทธิ์. Resolverเป็นpure; selectionstoreมีfilesystemeffectsเฉพาะhostcallและreadมีdurabilityflush ไม่เรียกว่าpure

## Held acceptance v2 และหน้าดูข้อมูล — 8 พ.ย. 69

`holdForOperation` transactionเดียวตรวจexpectedOperationId/expectedRevision/sourcegenerationและidentityตรงกับoperation.from เก็บserverderivedoriginและintendedBinding. ExactIDretryหลังcomplete/cancelคืนstoredreceiptเดิมได้; freshIDหลังoperationจบreject. Legacyholdภายในยังคงเดิมและไม่rewriteข้อมูลเก่า; productionrouteใช้v2เท่านั้น. ไม่มีhelddelivery/discard/retarget/consume และไม่มีauto-send

UIอ่าน `/events?after=seq&limit=100` เมื่อผู้ใช้กด แสดงเป็น “ประวัติที่บันทึกไว้ · อาจไม่รวมข้อความล่าสุด” ไม่แต่งtotal/epoch/เวลาหรือmodel และไม่แทนnative livechat. รับทีละpageครบก่อนappend ปฏิเสธsequenceผิด แสดงtextContent ไม่มีrawmetadata/HTMLexecution. Room/revisionเปลี่ยนหรือcapabilityถอนต้องทิ้งlate response. Heldlistแสดงเป็นข้อความพักที่บันทึกไว้ ไม่ใช่sent. ยังอยู่ใต้capabilitygateเดิม ไม่มีเปิด read surface ใน production; composer hook เพิ่มในรอบถัดมาด้านล่างและยังต้องมี host integration

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | ทีม1 + ทีม2 | รวมpurefactsresolver/durableexplicitselection, heldv2transaction/routes, storedhistory/heldreadUI; productionยังปิด |

Durabilityเพิ่มเติม: provision/readsyncAncestors bottom-upถึงfilesystemroot เพื่อไม่สมมติว่าparentที่mkdirใหม่หรือconcurrentcreatorสร้างไว้durableแล้ว. Readมีdurabilityflush; fault-injectiontestsตรวจparentflushfailureไม่คืนfacts. ไม่ใช่powerlosstest และไม่มีreboot.

Rootfinal:main2138pass12skip0fail/127files, browser48pass, targetedtypesและtemporaryCLIbuildexit0. NativecomposercontractยังBLOCK รายงานvault `native-feasibility-and-facts-20261108/RESULT.md`. ยังไม่deployการแก้รอบนี้

## Composer และ managed send guard — 8 พ.ย. 69

Core mobile รอ `beforeSend` ก่อน permission diversion/upload/provider. Managed text-only intent ผูก operation/revision/source binding และตรวจ localStorage readback ก่อน held POST; receipt ไม่ใช่ delivery. Lost ACK/reload ไม่ส่งอัตโนมัติหรือ retarget. `roomStateAvailable` เป็น host-derived flag แยกจาก all-backend readiness. `/send` ยอมผ่านเฉพาะ resolver คืน exact null; error/non-null ปฏิเสธก่อน transport. ข้อความส่วนนี้เป็นขอบเขต ณ composer freeze เดิม; รอบ finish-to-done เพิ่ม Mobile permissions/raw/feature/lifecycle guards แล้วตามหัวข้อถัดไป แต่ไม่ครอบ native keyboard/CLI และไม่แทน atomic input contract. Default production ยังปิด.

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม1 | รวม composer held กับ managed send guard; แยก stored receipt ออกจาก sent และคง all-writer/native gate |

### Composer final validation — 8 พ.ย. 69

Root รัน main2156pass/12skip/0fail/128files และ browser132pass (Chromium iphone-xr/desktop, mocked API + actual core). P1 deferred draft-loss แก้และ independent source review ปิดแล้ว. Targeted6modules/types exit0; typecheckรวมAPIยังมี6diagnosticsตามรายงานp2 ไม่อ้างทั้งrepoผ่าน. หลักฐาน vault `plans/cross-provider-handoff/composer-final-20261108/RESULT.md`. Sourceรอบนี้ยังไม่deploy; direct permission/raw/all-writer/native gates คง BLOCK.


### Mobile writer policy รอบ finish-to-done — 8 พ.ย. 69

`write-guard.ts` สร้าง policy ต่อ host instance: ไม่มี options ใช้พฤติกรรมเดิม; configured room ต้องได้ exact null จึงถือว่า unmanaged. Resolver error/non-null ปิดการเขียน; raw channel ที่ไม่มี canonical room attestation ปิดไว้แม้ resolver คืน null. Guard ถูกส่งเข้า API/permissions/modes และ feature mounts ไม่ใช้ mutable global policy.

Docs/ports/PRS/retro ตรวจ guard ก่อน effects; scheduled PR/retro callbacks ถือ guarded dependencies ของ instance และ dispose หยุด future ticksเท่านั้น. Herdr/resume/Superset/autostart mutations ที่ยังไม่มี trusted scope ถูกปิดก่อน launch/config effects. ไม่ได้ยกระดับ low-level primitives หรือ raw WS/CLI/keyboard ให้เป็น shared writer service. การตรวจซ้ำก่อน helper ไม่ใช่ atomic enqueue กับ native composer และไม่ยกเลิก effects ภายใน helper ที่เริ่มแล้ว.

ถ้า policy เปลี่ยนหลังเริ่มคำสั่งแล้ว ต้องรายงาน uncertain และหยุดลำดับที่เหลือ ไม่อ้างว่าไม่มี effects. Production continuity คง default off; ไม่มี all-backend live acceptance จาก patch นี้. ผลทดสอบสุดท้ายเก็บแยกใน vault `finish-validation-20261108/RESULT.md`.


Configured legacy `/send` text+ID เก็บ attempt ต่อ API instance (dispatching/acknowledged/uncertain) และตรวจ state ทั้งก่อนและหลัง await. Partial ID ไม่ release และ duplicate ที่ยัง uncertain ไม่ตอบ ACK. Map จำกัด2000แล้ว reject ไม่ล้างอัตโนมัติ; ไม่ durable ข้าม restart/process/instance และไม่ครอบไม่มี ID. Default unconfigured legacy ledgerยังคงเดิม. Mainล่าสุด2222pass/browser168passเป็นfixtures; targetedtypecheckยัง6diagnosticsและproductiongateไม่เปลี่ยน.


## การรวม protocol และ facts UI — 8 พ.ย.69

`Adapter.launchWithContext` รองรับ nativeที่ส่งidentityหลังfirstuser โดยenginepersistdelivering-contextก่อนcall แล้วตรวจexactbinding/receipt/inspectionก่อนcomplete. ไม่มี fallbackส่งcontextซ้ำหลังuncertain. `facts-ui.ts` แสดงstructuredreferencecandidatesจากsnapshotจริง ให้ผู้ใช้เลือกเอง แล้วpersistผ่านFactsSelectionStore; actorมาจากtrustedhost ไม่รับclientactor. snapshotเปลี่ยนต้องpreviewใหม่; ไม่infergoalจากprose. Routefactsserviceที่ยังไม่mountคืน503ไม่ให้UIสร้างreceiptเอง.

Capabilities `scope:room-backend` เป็นexplicitopt-inสำหรับรุ่นแรกหนึ่งเส้นทาง; omittedคงall-backends. ไม่ได้เปิดproductionด้วยschemaนี้. `protocol/entry.ts` มีv2mappingแยกversion/effectiveToolHome/homeEnvironmentและsessionselection consistency; presenceไม่ใช่accountproof.

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย.69 | Codex root | stagedengine, factsUIservice/routes, explicitone-backendrolloutscope และv2entrymapping; integrationยังไม่live |

8 พ.ย.69 root review fixes: replayfingerprintรวมfactsSelectionIdและคืนhistoricalก่อนfreshfactscheck; safe-pointบังคับboolean; stagedtargetPolicyexplicitก่อนlaunch; previewจำกัด256KiBต่อsnapshot/64itemsและ413หากcandidatesเกิน256ไม่truncate; archivefsyncfileและparentdirectoriesก่อนreturn. Testใหม่ฝั่งroutes/engine/factsUI. การfsyncไม่ใช่ผลทดสอบpowerloss.
