# test/

## Canonical suite

Use `bun run test:all`. This is the ship gate — the alpha release script
(`scripts/ship-alpha.sh`) refuses to tag if it fails.

`test:all` runs four disjoint invocations so mocks don't cross-pollute:

1. `bun test test/` with `test/isolated/` and `zz-mock-tmux-smoke` excluded
2. `bun test test/isolated/`
3. `bun test test/zz-mock-tmux-smoke.test.ts`
4. `bun test src/commands/plugins/`

## Why `bun test test/` (bare, no flags) is broken

Bun's `mock.module()` is **process-global and retroactive**. Two test files
that both mock the same path race inside one Bun process — one wins, the
other observes the wrong stub. Fix: run mutually-incompatible mockers in
separate invocations. Bare `bun test test/` puts them all in one process
and produces ~57 spurious failures; we accept that and ship via `test:all`.
See issue #387.

## Where `mock.module()` is allowed

- **`test/isolated/`** — invoked as its own `bun test` call by
  `test:isolated`. Each file may mock freely; pollution is contained.
- **`test/helpers/`** — shared mock definitions (imported, not executed).

New files outside those two directories **must not** call `mock.module()`.
`scripts/check-mock-boundary.sh` enforces this as a pre-tag gate. Options
when it trips:

- Move the test into `test/isolated/` (preferred).
- Add `// mock-boundary-ok: <reason>` on the offending line for a one-off
  justification (rare — `zz-mock-tmux-smoke` is the canonical example).

`scripts/mock-boundary-allowlist.txt` grandfathers files that predate the
rule. That list is expected to shrink; adding new entries requires review.

## Herdr mobile — 8 พ.ย. 69

ชุด `mobile-herdr-provider*.test.ts`, `mobile-herdr-lifecycle*.test.ts` และ `mobile-herdr-integration-ui.test.ts` ตรวจ inventory/identity/native transcript, durable delivery, create/restore/close, API auth และคิวใน JavaScript ที่ส่งให้ browser ใช้ synthetic fixtures ใน `fixtures/herdr-provider/`, injected runner/clock และ temporary SQLite ไม่มีการส่งเข้า agent จริงหรือเปิด server

รันเฉพาะส่วนด้วย `NODE_ENV=test MAW_TEST_MODE=1 bun test test/mobile-herdr-*.test.ts` และ regression mobile ด้วย `NODE_ENV=test MAW_TEST_MODE=1 bun test test/mobile-*.test.ts` ส่วน `ui/web/e2e/herdr-mobile.spec.ts` ใช้ browser จริงพร้อม route interception บน HTTPS ไม่ต้องเปิด server; รันจาก `ui/web` ด้วย `bunx playwright test e2e/herdr-mobile.spec.ts --project=iphone-xr --project=desktop --retries=0` ผลนี้ไม่ใช่ live Tailscale acceptance

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | ไอ้คล็อตและลูก Herdr | ลงทะเบียนชุดทดสอบ provider/lifecycle/UI และแยก DI/browser mock จาก runtime จริง |

รีวิว Herdr วันที่ 8 พ.ย. 69: `mobile-herdr-lifecycle-cmdmap.test.ts` เพิ่ม regression กรณี native metadata มาช้า, bootstrap ถูกปฏิเสธแน่นอนเทียบกับ uncertain และ conversation เปลี่ยนขณะ process เดิม โดยใช้ DI/SQLite temporary ไม่มี live mutation ผลรวมรอบรีวิว `NODE_ENV=test MAW_TEST_MODE=1 bun test test/mobile-*.test.ts` ได้ 455 pass / 0 fail / 2642 assertions

Live acceptance วันที่ 8 พ.ย. 69 เพิ่ม `mobile-herdr-live-contract-review.test.ts` (startup dialog/timeout) และ `mobile-herdr-resume-review.test.ts` (native metadata มาช้า/identity เปลี่ยน/ไม่ replay) พร้อมตรวจ helper process ใน production wiring ผลรวมสุดท้าย `NODE_ENV=test MAW_TEST_MODE=1 bun test test/mobile-*.test.ts`: 474 pass / 0 fail / 2755 assertions / 30 files ผ่าน DI/SQLite temporary ไม่ใช่ผล live flow; หลักฐาน live browser ผ่าน Tailscale เก็บใน vault `implementation-2026-11-08/LIVE-UAT.md`

### Cross-agent continuity — 8 พ.ย. 69

`mobile-continuity-*.test.ts` ตรวจ durable room/session journal, context/archive, capability gate, authenticated routes และ fixture adapters/engine (ไม่ใช่ live CLI acceptance) รัน `NODE_ENV=test MAW_TEST_MODE=1 bun test test/mobile-continuity-*.test.ts` ขอบเขต production ที่ค้างอยู่ใน `src/mobile/continuity/README.md`

## Entry boundary fixtures — 8 พ.ย. 69

`mobile-prepared-entry.test.ts` ตรวจ canonical descriptor/digest/route/args/env, exact native policy และ tmux verification failure ไม่มี fallback. `mobile-herdr-lifecycle.test.ts` เพิ่ม hook journal/ACK-only/uncertain no-retry. เป็น DI fixtures ไม่มี live launch/restart/deploy

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม 1 | บันทึก opt-in entry wiring และขอบเขต fixture tests |


## Review entry policy — 8 พ.ย. 69

Claude ask ใช้ `--permission-mode default` แทน manual ตาม static native enum ที่ตรวจจาก candidate04 ไม่มีการรัน inference/parser acceptance. Trusted host loader/policy และขอบเขต env guards ดู `src/mobile/launch/README.md` ของ maw; tests เพิ่มที่ `test/mobile-entry-host-loader.test.ts` ใช้ fixture runtime ไม่เปิด native agent

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม 1 | แก้ Claude default และบันทึก trusted loader tests |


## Context boundary review — 8 พ.ย. 69

`mobile-continuity-context.test.ts` ตรวจข้อมูลธุรกิจธรรมดาคงเดิมและคำสั่ง/role claimในfacts/events/metadataยังอยู่ในJSONไม่หลุดเป็นคำขอภายนอก พร้อมreference-only envelope. Testsเหล่านี้ไม่ใช่model inference; ผลliveเก็บในmemory maw `plans/cross-provider-handoff/context-review-20261108/`

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม 1 | เพิ่ม paired context serialization tests และแยกขอบเขตจากlive model tests |

### Automatic Herdr pilot — 8 พ.ย. 69

`mobile-continuity-effects.test.ts` ตรวจ durable effect claim/lock/status และ no replay; `mobile-continuity-native-records.test.ts` ตรวจ native lineage/turn/tool จาก synthetic records; `mobile-continuity-herdr-pilot.test.ts` ใช้ fake Herdr runner, SQLite ชั่วคราว และ isolated zsh เพื่อทดสอบ runtime proof, context correlation, operation completion, cleanup และ input guards ไม่มีการเปิด native agent หรือ restart/deploy ผล live แยกไว้ใน vault `cross-provider-handoff/automatic-pilot-20261108/`

`mobile-continuity-reference-handoff.test.ts` ตรวจ persisted prepare/send/result, lost ACK ไม่ส่งซ้ำ, read failure recovery, exact assistant/user correlation และ completed result ไม่แย่ง lock ใหม่ ใช้ temporary SQLite + DI ports ไม่ใช่ live inference

`mobile-continuity-transport-observation.test.ts` ตรวจ scope/argv/parser ของ read-only observation และ unknown proofs ด้วย DI fixtures; ไม่มีการส่ง input หรือเปิด agent. CLI help/version verification แยกบันทึกใน vault `AUTO-observation.md`

`mobile-continuity-writer-fence.test.ts` ใช้ SQLite ชั่วคราวและ Bun subprocesses ตรวจ multi-reader/exclusive writer, physical alias, same UUID/new instance generation, crash/uncertain/no replay/no TTL. ไม่รับรอง external terminal input หรือ default route wiring

`mobile-continuity-receipt.test.ts` ตรวจ legacy/native-full-retrieval แยก mode/version, token-in-summary reject, actual Read full coverage/hash/cursor/turn, artifact tampering และ truncation. ใช้ native JSONL synthetic ผ่านparserจริง ไม่ใช่ model inference ผลliveแยกในvault `retrieval-pilot-20261108` และ `native-retrieval-pilot-20261108`

### Final continuity validation — 8 พ.ย. 69

Root `bun run test`: 2022 pass/12 skip/0 fail (124 files; ไม่รวม isolated/plugin scripts). Playwright continuity-mobile: 40 pass บน iphone-xr+desktop Chromium API fixtures ไม่ใช่ live backend. Native Read testsครอบ successEvidence แบบไม่สร้าง error/exit fields, strict exact turn/rendering/coverage; receipt แยก historical retrieval จาก workflow/current readiness. Logs/source hashes ใน vault `plans/cross-provider-handoff/final-validation-20261108/`.

### Release checks — 8 พ.ย. 69

ก่อน commit/deploy ตามคำสั่งพี่ Ball: mock-smoke 6 pass; isolated 76/77 files ผ่าน แต่ oracle-manifest ล้มเรื่องลำดับ fleet; plugin 144 pass/2 skip/13 fail/2 errors จาก mock export cmdOraclePrune ไม่ครบ. รันทวนทั้งสองชุดใน git archive HEAD เดิม 4c3f0ab7 แล้วพบ failures เดียวกัน จึงเป็น baseline limitations ไม่อ้าง test:all ผ่าน. ไม่แก้ส่วน manifest/plugin นอกขอบเขตรอบนี้. สำรอง source/UI แล้ว; deploy คง continuity default off.

History import รอบต่อ 8 พ.ย. 69: store tests41pass/160assertionsบนtemporarySQLite; ครอบ late batch conflict rollback new/existing room, stale revision/generation, pending operation, foreign native source และ coordinate alias. Targeted types exit0 ไม่อ้าง live import.

Facts snapshot: engine tests38pass/316assertionsในfixture adapters; ตรวจ exact archive digest/cursor และ callback mutation ไม่เปลี่ยนroom/history/contextหลัก. ไม่รับรองresolver productionหรือsemantic facts.

Finalรอบต่อ 8 พ.ย. 69: continuity453pass/0fail/2554assertions/13files; targetedtypes engine/context/store/history-import+tests exit0. `mobile-continuity-history-import.test.ts` ใช้Codex/ClaudeparserจริงกับsyntheticJSONL/fullboundedtemporaryfileread ไม่มีliveagent. เพิ่มcursorout-of-historyguard3enginecases+purebuildercase. หลักฐานvault continue-validation-20261108.

### Facts/held/timeline รอบลุย — 8 พ.ย. 69

- `mobile-continuity-facts-resolver.test.ts`:41purefixturesจากทีม2 sourcehashverifiedก่อนรวม testปรับimportpathเท่านั้น
- `mobile-continuity-facts-selection.test.ts`:12temporaryfilesystemcases รวมcrossprocesspublish, pauseafterlink, injectedreaderfsyncfailure,FIFOfailfast,scopechangevalidpayload และimmutableprovenance. Testsไม่ใช่powerlosssimulation/nativeacceptance
- Store/routeheldv2ตรวจtransaction/retryaftercompletion/race ไม่มีproviderdispatch; engineintegrationตรวจexplicitpersistedselectionก่อนlaunchและmissingselectionblock
- Playwright continuity-mobile48executionsบนChromiumiphone-xr/desktop APIfixtures ผ่าน; storedtimelinepagination/XSS/nonprogress/roomchange/heldlistไม่POST ไม่ใช่liveมือถือ/Tailscale
- Herdrfeasibilitynegativeproofอยู่vaultchecks/herdr-native-participation-20261108 ใช้syntheticPTYไม่มีmodel/server/nativeagent. Rootรันเองพบqueue/kernel0แต่composer5bytes ไม่อ้างHerdrforkproduction

Final8พ.ย.69รอบHerdrfeasibility/facts:main2138pass12skip0fail/8323assertions/127files; browser48pass. Factsselectionล่าสุด14cases58assertionsรวมdurableparentprovision/readbarriers. Logsในvault native-feasibility-and-facts-20261108. ไม่รันisolated/pluginซ้ำ (baselinefailuresบันทึกรอบreleaseเดิม) ไม่claimtest:allหรือproductionnativeacceptance

### Composer final validation — 8 พ.ย. 69

Root รัน main2156pass/12skip/0fail/128files และ browser132pass (Chromium iphone-xr/desktop, mocked API + actual core). P1 deferred draft-loss แก้และ independent source review ปิดแล้ว. Targeted6modules/types exit0; typecheckรวมAPIยังมี6diagnosticsตามรายงานp2 ไม่อ้างทั้งrepoผ่าน. หลักฐาน vault `plans/cross-provider-handoff/composer-final-20261108/RESULT.md`. Sourceรอบนี้ยังไม่deploy; direct permission/raw/all-writer/native gates คง BLOCK.


### Finish-to-done writer/inspection checkpoint — 8 พ.ย. 69

Rootรัน `bun run test` ล่าสุด 2222pass/12skip/0fail/9410expects/130files. Browser168pass (Chromiumiphone-xr/desktop, mockedAPI/actualcomposer; UIhashตรงfreeze). Buildexit0; API-inclusive targetedtypecheckยัง6diagnosticsเดิม ไม่ใช่test:all/typecheckclean/liveacceptance. หลักฐานvault `plans/cross-provider-handoff/finish-validation-20261108/RESULT.md`.

`mobile-feature-write-guards.test.ts` ตรวจ unknown-scope lifecycle, docs/ports และ actualschedulercallbacks PR/retroด้วยfakeeffects. `mobile-continuity-write-guard.test.ts` ตรวจ deferred policy revocationก่อนkey/type/dispatch/wake และ partialeffectsต้องuncertain; sameIDconcurrency/partialretryไม่ACKหรือส่งซ้ำในprocess-localconfiguredmap. ไม่รับรองdurabilityข้ามrestart/atomicnativeenqueue. Sourceไม่deployและproductiongateคงปิด.


## Herdr chat stability — 8 พ.ย. 69

`ui/web/e2e/herdr-chat-stability.spec.ts` ใช้ full Mobile HTML กับ mock HTTP บน Chromium iphone-xr/desktop: send→working→done, draft/files/scroll, transient/error recovery, binding/UUID/epoch/workspace isolation, latest-response ordering, older pagination และ missing/revoked capabilities. `MOBILE_HTML_PATH` ใช้ทดสอบ exact scoped release candidate; `herdr-mobile.spec.ts` รองรับตัวเลือกเดียวกัน. ไม่มีการเปิด native agentหรือส่งข้อความจริงจากtestsเหล่านี้. Logs/hash/reviewอยู่ vault `plans/cross-provider-handoff/herdr-chat-stability-20261108/`.


8 พ.ย.69 — เพิ่ม mobile-continuity-facts-ui.test.ts สำหรับexplicitselection/persistence/stalesnapshot; engine stagedfirstcontext4cases; routes facts/scopedrollout; protocol-entryv2mapping. ใช้localfixturesไม่มีnative/model/network. รอcombinedintegrationfreezeก่อนfullsuite.

8 พ.ย. 69 — ชุดรวม `bun run test` ได้ 2512 pass / 12 skip / 1 fail (valid ref main subprocess timeout 15 วินาที) จึงไม่ถือว่าชุดรวมผ่าน; log `/tmp/maw-protocol-combined-main.log`. หลัง mapper V3 แก้การ spread candidate รัน entry/runtime-host/adapter ได้ 45 pass / 400 expects / 0 fail และ targeted TypeScript exit 0; logs `/tmp/maw-protocol-final-mapping{,-types}.log`. Negative tests ครอบ policy/hash/argv drift, ไม่อ่าน enumerable credential accessor และ child exit ระหว่าง awaited admission. ทั้งหมดเป็น local fixture ไม่ใช่ native pilot หรือ production acceptance.

ผลล่าสุดหลัง isolated update fixture และ runtime launch receipt (8 พ.ย. 69): root รัน `bun run test` ได้ **2542 pass / 12 skip / 0 fail / 10885 expects / 141 files**, exit0; `/tmp/maw-protocol-combined-final.log`. Focused entry/runtime/adapter ล่าสุด **62 pass / 634 expects**, targeted types exit0. ไม่ใช่ `test:all` หรือ native/production certification; ผล2512/1failด้านบนเป็นประวัติก่อนแก้ test.


## Update ref validation แบบ isolated fixture — 8 พ.ย. 69

`cmd-update-ref-validation.test.ts` เรียก production `runUpdate` ใน fresh Bun fixture subprocess โดยมี temporary HOME/BUN_INSTALL และไม่ import CLI entry ที่เขียน audit/bootstrap. Module mocks อยู่เฉพาะ subprocess ไม่แตะ parent test runner; มี `mock-boundary-ok` อธิบายแต่ละบรรทัดตามกติกาด้านบน

Valid refs ต้องผ่าน production allowlist แล้วเรียก fake installer ด้วย exact `bun add -g github:OWNER/REPO#ref` หนึ่งครั้ง รวม default main; fake installer หยุดด้วย rejected fixture sentinel ก่อน fallback/global cleanup/link refresh. Invalid refs/unknown flag ต้อง exit 1 โดย installer/update-lock invocation เป็นศูนย์ และ help ต้องไม่มี effects. Fixture บล็อก real subprocess/network และไม่ inherit parent environment. **ห้ามกลับไปเรียก `maw update ... --yes` จริงเพื่อหวังให้ network ล้มเองใน test**

Focused command ที่รันแล้ว: `MAW_TEST_MODE=1 bun test test/cmd-update-ref-validation.test.ts` ได้ 17 pass / 0 fail / 116 assertions ผ่าน local Bun + fake installer ไม่ใช่ติดตั้งจริง. ไม่เพิ่ม test timeout เดิม (valid 15s / invalid 10s), ไม่แก้ production updater. Log `/tmp/maw-update-ref-fixture-final.log`; สาเหตุของ combined main เก่าและข้อจำกัดอยู่ vault `plans/cross-provider-handoff/PROTOCOL-UPDATE-REF-FIXTURE-RESULT.md`. ไม่อ้าง full main ผ่านจน root รันชุดรวมใหม่

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex p4 | เปลี่ยน ref validation เป็น actual runUpdate + isolated fake installer/temp HOME; positive exact invocation / negative zero effects ไม่แตะ network/global install |
