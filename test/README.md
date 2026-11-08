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


## Herdr chat stability — 8 พ.ย. 69

`ui/web/e2e/herdr-chat-stability.spec.ts` ใช้ full Mobile HTML กับ mock HTTP บน Chromium iphone-xr/desktop: send→working→done, draft/files/scroll, transient/error recovery, binding/UUID/epoch/workspace isolation, latest-response ordering, older pagination และ missing/revoked capabilities. `MOBILE_HTML_PATH` ใช้ทดสอบ exact scoped release candidate; `herdr-mobile.spec.ts` รองรับตัวเลือกเดียวกัน. ไม่มีการเปิด native agentหรือส่งข้อความจริงจากtestsเหล่านี้. Logs/hash/reviewอยู่ vault `plans/cross-provider-handoff/herdr-chat-stability-20261108/`.
