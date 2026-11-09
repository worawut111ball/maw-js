# Herdr provider core

เพิ่ม 8 พ.ย. 69 — local endpoint / session `default` เท่านั้น เป็น provider สำหรับ maw mobile แยกจาก tmux/Superset และ `features/herdr-autostart*.ts` รุ่นเดิม

## หน้าที่และเจ้าของไฟล์

| ไฟล์ | หน้าที่ |
|---|---|
| `types.ts` | channel/room/generation/capability, history/action/delivery contracts และ `HerdrError` |
| `inventory.ts` | bounded async argv runner, protocol22 snapshot validation, membership และ process-instance binding |
| `history.ts` | native Claude/Codex id/path resolver, canonical root/metadata validation, JSONL messages/tools, branch และ pagination epoch |
| `delivery.ts` | lazy SQLite FULL/WAL unique claim, payload fingerprint, recovery/uncertainty/audit resolution และ room mutex |
| `runtime.ts` | DI factory, lazy singleton `herdrRuntime`, guarded screen/history/dialog/dispatch/status |
| `lifecycle.ts` | cmdmap เป็นเจ้าของ: operation/manifest/create/bootstrap/migration/close/autostart ไม่แก้จากงาน core |

## วิธีใช้

นำเข้า `herdrRuntime` หรือ `createHerdrRuntime(options)` จาก `runtime.ts` ไม่มี CLI/SQLite/timer/watch/server ตอน import เรียก `listProjects()` หรือ `refresh()` ก่อน `resolve('herdr:wB','wB:p2')` ซึ่งเป็น synchronous cache resolver ทุก write ต้องผ่าน `dispatch` พร้อม request ID และ `expectedGeneration` ห้ามนำ Herdr channel ไป generic tmux/Superset input helpers

Factory รับ runner/clock/ledgerPath/history roots/parser/lifecycle guard ผ่าน DI `ledgerPath: ':memory:'` ใช้ได้เฉพาะ unit ที่ไม่ตรวจ persistence; กรณี recovery ใช้ SQLite ใต้ temporary directory ไม่ใช้ config จริง Singleton เปิด store ที่ `~/.maw/herdr/delivery.sqlite` เมื่อเรียก ledger ครั้งแรกเท่านั้น Default runner ปฏิเสธเมื่อ `NODE_ENV=test` หรือมี `MAW_TEST_MODE`; DI runner ยังทำงานตามปกติ Default store ใน test mode เป็น memory เมื่อไม่ได้ระบุ ledgerPath เพื่อไม่เขียน config จริง

`setDialogParser(parse)` ตั้ง parser จริงจาก permissions ในจุด integration ห้าม import `api.ts` หรือ feature packs ย้อนเข้ามาใน core เพราะอาจเกิด circular imports/side effects `setDispatchGuard(guard)` ใช้ตรวจ lifecycle closing/tombstone ทุก mutation และ `RuntimeOptions.beforeDispatch` เป็น seam ของ coordinator เมื่อใช้ factory

## Inventory และ identity

- `api snapshot` ต้องคืน envelope `session_snapshot` ของ protocol22; validate arrays/IDs/links/required identity fields ไม่เปลี่ยน malformed/unavailable เป็นรายการว่างสำเร็จ
- Public workspace = `herdr:<workspace_id>`, public room = pane ID จริง ตรวจ workspace membership เสมอ ไม่เปิด arbitrary session/socket จาก URL
- generation รวม terminal/provider/native conversation และ foreground process evidence พร้อม observation epoch ชื่อ/label/cwd/revision ไม่ใช่ identity ไม่มี membership จาก client มาแทน snapshot
- process-info ต้องมี shell PID/foreground group และ agent process ชื่อ codex/claude/claude-code/claude.exe ที่ PID ไม่ใช่ shell; shell กับ agent อยู่ group เดียวกันได้ ถ้าเห็น shell อย่างเดียว แม้ pane.agent ค้างอยู่จะไม่มี write capability
- continuity หมดเมื่อ observation ขาดเกิน 15 วินาที, snapshot หาย, terminal/native/process เปลี่ยน; token ใหม่ไม่รับรอง queue เดิม ผู้ใช้ต้องได้ refresh current generation ก่อน manual send
- shell pane อ่านจอได้ แต่ไม่มี write; stop เปิดเฉพาะ working; normal prompt เปิด working/idle/done ที่ foreground ยืนยันและไม่มี dialog; unknown/stale ปิดส่ง blocked ใช้ answer/key ที่ตรวจ dialog สดเท่านั้น
- `answer` ป้ายเริ่มต้นใน inventory เปิดเมื่อ blocked; runtime ยังตรวจ parsed dialog/token จริง หาก dialog ปรากฏในสถานะ idle ที่ foreground ยืนยัน การเรียก answer ด้วย token จาก `dialog()` ยังตรวจได้ตาม parser

## History

Default roots คือ Claude `.claude/projects` และ Codex `.codex/sessions` ใต้ home; source allowlist เริ่ม `herdr:claude`/`herdr:codex` ตั้ง roots/source สำหรับ fixtures ด้วย `HistoryOptions` ไม่ค้น cwd/latest หรือ Superset env

`id` ต้อง UUID และพบ candidate เดียว ส่วน `path` ต้อง absolute/canonical JSONL ภายใน root ชื่อไฟล์ต้องผูก UUID ใน metadata ของ provider จริง (Claude sessionId / Codex session_meta.payload.id) ปฏิเสธ provider mismatch, ambiguous, symlink escape และ malformed metadata ไม่มีหลักฐานให้คืน `kind:none,available:false,reason` ไม่สร้าง chat จากจอ

อ่านไฟล์ด้วย handle/O_NOFOLLOW ตรวจ stat ก่อนหลังและไม่ใช้ incremental path-only cache Epoch ผูก conversation/file generation/branch: append ที่ hash ของ prefix เดิมตรงยังใช้ epoch เดิม; rewrite/replacement/rewind เปลี่ยน epoch Cursor เก่าต้องหยุด pagination และโหลดใหม่ ข้อมูลที่กลับจาก history ต้องผ่าน current runtime binding ซ้ำก่อนคืนให้ route

Parser แสดง user/assistant/tool/system, tool result และ Claude compact/rewind sibling filtering จาก native JSONL เท่านั้น Codex rollback marker ทำให้ epoch เปลี่ยน ไม่มีการอ้าง terminal text เป็นข้อความใหม่ ข้อมูลชนิด event ที่ไม่รองรับจะไม่ถูกแต่งเป็นข้อความ

## Delivery/actions และผลไม่แน่นอน

`dispatch` รับ prompt/bootstrap/key/literal/answer/stop ทุก action ใช้ SQLite store เดียวกัน + mutex ต่อ room, fresh binding/foreground, lifecycle guard และ fingerprint ของ action/target/expected generation/exact payload รวมข้อความไฟล์แนบ ID เดิม payload ต่างตอบ conflict และไม่ dispatch อีก

SQLite ใช้ primary key/BEGIN IMMEDIATE, synchronous FULL/WAL; persist dispatching ก่อนเรียก CLI, ACK ก่อนคืน acknowledged ไม่มี memory fallback ถ้า store เปิด/เขียนไม่ได้ เก็บ record ไม่ลบตาม TTL เมื่อเต็มให้หยุดส่ง ข้าม process restart พบ dispatching เดิมเป็น uncertain ไม่ retry

- ก่อน mutation ถูกปฏิเสธ คืน persisted `definitely-rejected`; syntax/ID/store/conflict อาจ throw `HerdrError` (code/status) หัวหน้าต้องจัดการทั้งสองแบบ
- หลังเริ่ม mutation timeout/error/ACK malformed หรือ target ไม่ตรงเป็น uncertain; prompt ACK ต้อง `agent_prompted` และ agent identity ตรง
- key/text ACK ตาม schema เป็น bare `ok` ไม่มี target; core จึงตรวจ binding อีกครั้งหลัง ACK เป็นข้อจำกัดของ protocol ไม่อ้าง atomic compare-and-send
- prompt ใช้ argv `agent prompt <pane> -- <text>` ส่ง Enter โดย Herdr ครั้งเดียว ส่วน literal ใช้ `pane send-text <pane> -- <text>` เฉพาะ dialog/free row ที่ยืนยัน
- dialog token ผูก generation/question/tab/stable option identities ตัด body/cursor/free input text/countdown; answer flow ตรวจซ้ำระหว่างเลือก free row/ล้าง/พิมพ์/Enter ทุก mutation ไม่มี retry key/answer อัตโนมัติ
- generic key ctrlc ขณะ idle ที่ไม่มี dialog ปฏิเสธ ไม่ให้ bypass stop capability

Offline ส่งได้เฉพาะ entry ที่พิสูจน์ never-dispatched จาก client state พร้อม generation+continuityToken เดิมและอายุไม่เกิน 30 นาที; old queue ที่ไม่มี token ต้องพัก ห้ามแปลง sending→waiting เพียงเพราะมี ID ต้องถาม `deliveryStatus` ก่อน `unknown` ไม่ใช่หลักฐานว่ายังไม่เคยส่ง Store/operation/status เป็นข้อมูลสด ห้ามรับรองจาก offline cache

## ผู้ใช้จัดการ uncertain

`dispatch` manual ID ใหม่พร้อม `parentId` อ้าง record เดิมได้ การปลด queue block ใช้ `resolveParent:true` ได้เฉพาะ same scope, parent uncertain และไม่ใช่ offline หลัง resend ACK แล้วจึงบันทึก parent code `superseded_by:<newID>` โดย state ยัง uncertain (ไม่ปลอมเป็น acknowledged) ถ้า resend ยัง uncertain block ยังอยู่

Parent ID ที่ status unknown อนุญาตเฉพาะ manual request ใหม่ที่ไม่ใช้ resolveParent เพื่อเก็บ audit reference (`parent_id`/`action` ใน SQLite) ไม่สรุปว่าไม่เคยส่งและไม่ปลด block; offline/resolveParent กับ unknown parent ปฏิเสธ Retarget ข้าม room/generation อ้าง parentId ได้ แต่ห้าม resolveParent ไปปลด scope เก่า ถ้าผู้ใช้ตรวจแล้วเลือกจัดการโดยไม่ resend ใช้ `resolveDelivery(id, oldChannel)` ซึ่งตรวจ scope แล้วบันทึก `resolved_by_user` ไม่ลบ record ไม่ส่ง CLI Route ต้อง auth และรับการยืนยัน explicit จากผู้ใช้ก่อนเรียก ไม่ทำ auto-resolution

## Limits ที่มีในโค้ด

| ส่วน | ค่า/เมื่อเกิน |
|---|---|
| CLI | 4 process พร้อมกัน, รอคิวสูงสุด 32, stdout+stderr รวม 4 MiB, timeout ปกติ 10 วินาที (process-info 5 วินาที), kill client process เมื่อหมดเวลา; ไม่ restart server |
| Snapshot probes | 4 worker ต่อ refresh, share in-flight; continuity 15 วินาที |
| Screen | visible อย่างเดียว 1–1500 lines, 4 MiB; ไม่เรียก recent/recent-unwrapped อัตโนมัติ |
| History | discovery แบบ opendir สูงสุด20,000 entries/depth8; incremental work default/max16MiB ต่อ read, record8MiB, structural metadata32MiB/200,000records/items ต่อ index; cache4/active reads4; pagination default150/max500 และลดหน้าแบบต่อเนื่องตาม bytebudget |
| Text | UTF-8 ไม่เกิน32,000 bytes, ไม่รับ NUL, prompt ไม่รับว่าง |
| Ledger | สูงสุด10,000 records ไม่ expire unresolved/uncertain เอง เมื่อเต็ม `delivery_store_full`; ไฟล์0600/โฟลเดอร์สร้าง0700 |

## การตรวจและข้อจำกัด

Focused tests ใช้ injected runner/synthetic fixtures และ SQLite ใน temporary directory ไม่มี live mutation/desktop/browser/mobile/reboot acceptance ในงาน core นี้ อ่านคำสั่งจริงเฉพาะ `--help`/schema ที่เก็บไว้

การอ่าน foreground ก่อน/หลัง mutation ไม่ล็อก input จาก desktop; PID/name ไม่ใช่ cryptographic process identity และ observation gap ต้อง failclosed ไม่มี exactly-once ฝั่ง Herdr เพราะ CLI ไม่มี idempotency key การรับรอง lifecycle restore/close/bootstrap readiness เป็นงาน `lifecycle.ts`/integration ไม่อนุมานจาก delivery ACK

## ประวัติ

| วันที่ | ใคร (คน/AI) | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex phase2-herdr-ensure | เพิ่ม core inventory/native history/durable delivery/runtime และ contract DI; แก้ epoch/ACK/foreground/dialog/uncertain resolution จาก review |

## ผลตรวจ runtime จริง — 8 พ.ย. 69

CLI `agent prompt TARGET TEXT` และ `pane send-text PANE TEXT` รับ TEXT เป็น positional argv โดยไม่รองรับตัวคั่น `--`; ส่งเป็น argv เดียวโดยไม่ผ่าน shell แม้ข้อความขึ้นต้นขีดก็เป็นข้อความ (ตรวจ CLI จริงแล้ว) ส่วน launch agent ยังคงใช้ `--` ตาม help ของ agent start

Claude บน Mac นี้มีชื่อ process `claude.exe` จึงเพิ่ม alias นี้ใน inventory/production ให้ตรงกัน สำหรับ launch_pending ที่ foreground ยืนยันและสถานะ blocked เปิดเฉพาะ guarded dialog/keys เพื่อผ่านหน้า trust; normal prompt และ stop ยังปิด ไม่ถือเพียง launch_pending ว่าพร้อม

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex | แก้ prompt/text argv, Claude process alias และ startup dialog ตามผล live acceptance |

ตรวจ identity เพิ่มท้าย live acceptance: inventory และ production ใช้ unique foreground agent PID เหมือนกัน ไม่รวม helper ที่เกิด/หายชั่วคราวใน identity ถ้ามี agent candidate มากกว่าหนึ่งตัวให้ unverifiable ไม่เลือกตัวแรก Production รักษารูป hash เดิมเมื่อมีagentเดียวเพื่อลดการเปลี่ยน binding ของ manifestเดิม

## Exact resume และ native metadata ที่มาช้า — L1/L2 (8 พ.ย. 69)

`lifecycle.ts` บันทึก binding/instance ของ agent ที่ start สำเร็จพร้อม `launched=true` แม้ Herdr ยังไม่มี native conversation โดยเก็บ exact UUID ที่คาดไว้แยกจาก metadata ที่ตรวจพบ สมาชิกคง `waiting-native`/ไม่พร้อมและ read-only reconciliation รอ UUID เดิมโดยไม่ start/bootstrap หรือส่ง prompt เพื่อกระตุ้น metadata หาก native ไม่มาเลยจะคงรอ ไม่อ้างว่าผ่าน

สมาชิกที่ ready แล้วถูกตรวจ process/conversation ทุก reconcile ด้วย ถ้า process หายหรือเปลี่ยนให้ล้าง ready และระบุ agent_changed โดยไม่ตั้ง conversationConflict จาก exit ตามปกติ จึงยังคืน exact UUID ที่เคย verify ได้เมื่อมี shell/owned target ที่ปลอดภัย หาก native หายชั่วคราวให้ waiting-native และกู้ ready เมื่อ UUID เดิมกลับมา หากเคยพบ UUID/provider อื่นให้เก็บ conversationConflict ใน journal ไม่ overwrite UUID ที่ยืนยันไว้ ไม่กลับไปรับ UUID เก่าหรือ restore เงียบๆ แม้ภายหลัง metadata กลับเป็นค่าเดิม ต้องจัดการ binding อย่างชัดเจนก่อน

ตรวจผ่าน `test/mobile-herdr-resume-review.test.ts` 11 กรณีใหม่ร่วมกับ lifecycle regression ผ่าน DI/SQLite temporary directory เท่านั้น ไม่มี live mutation/restart จากผู้แก้ L1/L2

| วันที่ | ใคร (คน/AI) | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex phase2-herdr-ensure | รับ ownership lifecycle.ts แก้ L1/L2: waiting native, late read-only verification, sticky conversation conflict และล้าง readiness เมื่อ process หาย/เปลี่ยน |

## Prepared launch hook — 8 พ.ย. 69

`LifecycleOptions.launchAgent` และ `createLifecycleHost({launchAgent})` เป็น trusted opt-in dependency อยู่ใน start journal หลังตรวจ shell/ownership ใช้ร่วม create/restore ACK ของ hook ไม่แทนการตรวจ identity/native/bootstrap จาก snapshot; uncertain ไม่ replay. ค่า default ยังเรียก agent start แบบเดิม ไม่มี concrete prepared transport เปิดใช้งาน ดู `../launch/README.md`

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม 1 | บันทึก opt-in entry wiring และขอบเขต fixture tests |


## Review entry policy — 8 พ.ย. 69

Claude ask ใช้ `--permission-mode default` แทน manual ตาม static native enum ที่ตรวจจาก candidate04 ไม่มีการรัน inference/parser acceptance. Trusted host loader/policy และขอบเขต env guards ดู `src/mobile/launch/README.md` ของ maw; tests เพิ่มที่ `test/mobile-entry-host-loader.test.ts` ใช้ fixture runtime ไม่เปิด native agent

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม 1 | แก้ Claude default และบันทึก trusted loader tests |

## Bounded native history reader — 9 พ.ย. 69

`history.ts` ไม่โหลดไฟล์ทั้งหมดหรือเพิ่ม file-size limit เดิมเพื่อแก้อาการ `history_size_limit`. Reader สร้าง byte-range index แบบ incremental: แต่ละ request อ่านไม่เกิน16MiB ด้วย chunks64KiB; `HistoryOptions.maxBytes` เปลี่ยนความหมายเป็น **work/read budget ต่อ request** (1byte–16MiB) ไม่ใช่ขนาดไฟล์ทั้งหมด. Transcript ใหญ่กว่า64MiB จึงค่อยๆ index ได้ โดยยังไม่คืน tail/total ที่คาดเดาระหว่างตรวจ prefix

เมื่อ index ยังไม่ครบหรือกำลัง revalidate จะคืน `{ok:true,kind:"none",available:false,reason:"history_indexing"}` ให้ caller poll GET ต่อ. ไม่มี background task/prompt/replay. Indexเก็บ offsets/lengths กับ structural metadata ที่ hash ข้อความแล้ว ไม่ cache raw messages; scratch สำหรับ recordที่กำลังอ่านมีขอบเขต8MiB. Indexมี hardcaps32MiB serialized metadata, 200,000records/items, cache4 และ active readers4 (ก่อน discovery/await). เป้าหมายต่างไฟล์ที่เกินactivecapและsamefileobserverคืน indexingโดยไม่ปลดbusyของowner

ต้องสแกน committed prefixครบก่อนยืนยัน native metadata/globalClaudeancestry/branch และ exact total. Incomplete EOF ไม่เป็น eventจนnewlineครบ. หลัง readyแล้ว readsอ่านเฉพาะrecordsของpageกับ tool-result dependencies. Result schemaเดิม: `conversation` exactnativeUUID, `epoch`, `total` exactfiltereditemcount, `start` absoluteitemordinal และ `items[].i=start+n`; `before` เป็นexclusiveabsoluteordinal. limitdefault150/max500 เป็นจำนวนสูงสุด **ไม่รับประกันว่าครบ limit**: ถ้า bytesของpageเกินbudget จะคืนcontiguoussuffixสั้นลงจบที่beforeเดิม ไม่ข้ามrecordและไม่ปลอมindices; callerโหลดolderด้วยbefore=start. Itemเดี่ยว+dependenciesเกินbudgetคืน `history_page_size_limit` ไม่วนindexingถาวร

Stable indexed snapshotต้องมี dev/ino/birthtime/size/mtime/ctime ตรงและตรวจ handle/path ก่อนคืนpage. Metadataเปลี่ยนไม่ใช่appendproof: reader rehash **prefixเดิมทั้งหมดแบบ incrementalตามbudget** ก่อนใช้ indexต่อและscanเฉพาะsuffix. Digestต่างต้องrebuildจากศูนย์/new epoch; rotation/truncateใหม่ต้องrebuild. Claude branchเปลี่ยนต้องnew epoch; unknownnonlogicalparentคืน `history_ancestry_unverified`. Older cursorที่epochไม่ตรงยังคืน `history_epoch_changed`. การตรวจtrustedfilesystemmetadataไม่ใช่cryptographiclockกับwriter; ไฟล์เปลี่ยนระหว่างอ่านคืนindexingและไม่คืนpageข้ามsnapshot

Exact source/nativeID/provider/path/symlink/ambiguity guardsคงเดิมและrejectlateconflictingCodexmetadataเพิ่ม. Directoryscanใช้opendiriterator จึงหยุดก่อนโหลดentryarrayทั้งหมด. Openใช้O_RDONLY|O_NOFOLLOW|O_NONBLOCKแล้วfstatrejectnonregularfile/FIFOโดยไม่block. ไม่มีแก้ native file/DB/config หรือ import sideeffect

Hard-cap reasons: `history_record_size_limit` (recordเกิน8MiB), `history_index_size_limit`, `history_page_size_limit`, `history_scan_limit`, `history_read_budget_invalid`; identity/provider/ancestry/cursorไม่ตรงยังfailclosed. อาจใช้เวลาหลายpollหรือคงindexingถ้าwriterเปลี่ยนไฟล์ต่อเนื่อง ไม่รับรองว่าประวัติทุกขนาดหรือทุกactivefileจะพร้อมภายในเวลาตายตัว

Focused tests: `NODE_ENV=test MAW_TEST_MODE=1 bun test test/mobile-herdr-provider-history.test.ts test/mobile-herdr-history-bounded.test.ts` — 24pass/0fail/181expects. ใช้ temporary native-format fixtures (>64MiB/large record/prefixrewrite+append/rotation/partialtail/queue+branch/tool/page/FIFO/concurrency) ไม่มีnativeinference/server. Targeted TSC ของ reader+newtests exit0 ไม่ใช่whole-repo typecheck. Candidate local readonly กับexactinventory/agentrefอ่านactual transcriptได้5poll/latest150/older150ตามsafeprojectionในvault `CLOSE-HERDR-BACKEND-20261109.md`; **ไม่ใช่deployedAPIหรือmobilelive acceptance**. Rootถือรวมreleaseหลังreview

| วันที่ | ใคร (คน/AI) | แก้อะไร |
|---|---|---|
| 9 พ.ย. 69 | Codex cmdmap/p5 | เพิ่มboundedincrementalindex/byte-rangepages/prefixintegrity/recordและglobalcaps; รักษาidentity/epoch/branch พร้อมreadonlycandidateproofและfocusedtests |

### แก้ active append ตามไอ้แดง review — 9 พ.ย. 69

เมื่อมี ready index แล้วและกำลัง verify prefix หาก fileKeyเดิมและขนาดโตขึ้นระหว่าง request จะคง `verify.offset`/hasher/`verify.previous` เดิม ไม่ rebuildจาก0. Prefixที่ตรวจยังมีขนาด `previous.size` เดิม; growthเป็นเพียงเงื่อนไขให้ตรวจต่อ ไม่ใช่ผลยืนยันappend. Ready indexล่าสุดยังอยู่ในpreviousจนdigestตรวจครบ ไม่ส่งpageเก่าที่ไม่มีป้ายstale ระหว่างนี้คืนhistory_indexingและUIรักษาsameverifiedhistoryเดิมตามcontract. หลังverifyผ่านจึงอ่านsuffixและคืนexactmessagesตามbudgetเดิม

Same-size rewrite, shrink หรือ fileKeyเปลี่ยนไม่เข้าcontinuation; prefixdigestไม่ตรงยังrebuild/new epoch. การตรวจนี้ยังอาศัยtrustedfilesystem/append writer ไม่ใช่atomiclockหรือรับรองrewriteพร้อมappendของbytesที่อ่านไปแล้วทุกจังหวะ. Cold first-indexก่อนมีready indexคงcontractเดิม; รอบนี้แก้ starvation ระหว่างrevalidationตามreproducerใน REVIEW-AIDAENG ไม่เพิ่มscopecold indexing

Testsเพิ่ม81MiBที่readyแล้ว appendก่อนอ่านทุกครั้ง15รอบ ต้องได้messagesอย่างน้อย2ครั้งและแต่ละครั้งห่างไม่เกิน8requests พร้อมsameepoch/exacttotal/text/index/budget/previousobjectretained; negative same-size rewriteระหว่างverifyต้องnew epoch. Focused26pass0fail266expectsและtargetedTSC0. ไม่rerun mobileglob/browserที่ไม่เกี่ยวในรอบquotaจำกัดนี้; ผล1842/78/10ก่อนหน้าเป็นคนละsourcecut ไม่อ้างfinalของdeltaนี้. ข้อ4 tmpdirtestแยกไว้ตามคำสั่ง

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 9 พ.ย. 69 | Codex root | แก้reviewข้อ1–3: รักษาverificationprogress/readyindexระหว่างactiveappend พร้อมregression |
