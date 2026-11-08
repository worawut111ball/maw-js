# Protocol session lifetime lease

วันที่ 8 พ.ย. 69 · owner Codex p4 · `session-lease.ts` เป็น cooperative host module ที่ใช้ `EffectJournal` เดิม ไม่ spawn/kill process, ไม่ใช้ PTY, ไม่มี network/timer/TTL และไม่เชื่อม production อัตโนมัติ

## หน้าที่และขอบเขต

จอง durable operation ก่อน launch และถือ exclusive session tuple `(agent, canonical toolHome, lowercase native UUID)` ตลอด lifetime. `toolHome` ต้องเป็น existing directory; realpath รวม symlink aliases. Exact resume ยึด tuple ก่อนคืน lease; fresh ยึดเมื่อ host ส่ง verified native observation หลัง handshake. Module ไม่รับรองว่า external TUI หรือ native client ที่ไม่ร่วม authority หยุดแล้ว Root ต้องพิสูจน์ก่อน entry เอง

Authority คือ opaque object ที่ผูกกับ issuing instance ผ่าน WeakMap ไม่ใช่ public incarnation string. Operation เดิมที่ยังค้างคืน uncertain; instance ใหม่ไม่มี recovery API ที่ mint authority ซ้ำ. Completed operation คืน historical receipt ก่อน acquire ใด ๆ และไม่มี lease

## API และลำดับ wiring

1. `new ProtocolSessionLeases(journal, { observeExit })` — ใช้ durable EffectJournal และ trusted owned-child supervisor dependency; ห้าม expose observer/journal ผ่าน HTTP หรือรับ boolean จาก user
2. `reserve({roomId,operationId,agent,toolHome,mode,nativeId?})` — exact resume ต้องมี UUID; fresh ห้ามส่ง UUID. คืน `{state:'reserved',lease}` หรือ `{state:'historical',receipt}`; ห้าม launch เมื่อ historical/throw
3. `beginLaunch(lease)` — persist launch permit ก่อน caller spawn แล้วคืน `{incarnation,launchId}` ครั้งเดียว. Journal ACK ของ `launch-permit` หมายถึง persist permit สำเร็จ **ไม่ใช่ native launch สำเร็จ**
4. Root spawn เอง จากนั้น `bindRuntime(lease,{launchId,runtimeBirth})` — runtimeBirth ต้องเป็น trusted supervisor birth token ที่ผูก exact owned child ไม่ใช้ PID เดี่ยว. Module ตรวจรูปแบบ/ความตรงกัน แต่ไม่สามารถพิสูจน์แหล่งกำเนิด token แทน supervisor
5. `verifyNative(lease,{agent,nativeId})` — caller ต้อง verify handshake/cwd/model/route/home policy แล้ว; resume ต้องตรง exact requested UUID. Fresh จะ lock tuple และเพิ่ม generation; collision ไม่ให้ active
6. `assertActive(lease)` ก่อนสร้าง/ใช้ turn admission; `assertOwned` ให้ detached lifecycle view รวม reserved/launching จึงไม่ใช้แทน native verification. Root ยังต้อง guard ทุก asynchronous turn/approval boundary
7. Turn complete ไม่ปล่อย lifetime lease. `markUncertain(lease)` หยุด authority และคง locks; ไม่มี TTL/force unlock/automatic retry
8. `release(lease)` เรียก injected `observeExit(expected)`; ต้องคืน `source:'owned-process-supervisor'`, exact incarnation/launchId/runtimeBirth, terminal exit code หรือ signal, input/output closed และ pendingWork false. Persist exit receipt ก่อน ACK reservation และ unlock. ไม่มี argument ให้ user สั่งปลด lock

Exit observer เป็น trust boundary ที่ root ต้อง implement ด้วย owned-child lifecycle evidenceจริง ไม่ใช้ native frame/screen/idle/`close()` called เป็น proof. ตัว module ไม่ spawn/observe OS process เอง และไม่อ้าง cryptographic attestation จาก fields ที่ observer ส่ง

## Persistence และ recovery

- Session owner ใช้ random incarnation แยกจาก stable operation ID; EffectJournal acquire ที่ idempotent ตาม owner ไม่ใช่สิทธิ์ replay launch
- Generation เป็น durable increasing append-only ledger ต่อ tuple ยึด session lock ก่อนเพิ่ม; limit 10,000 generations แล้ว fail closed. ไม่มี eviction/reset ที่ทำให้ stale generation กลับมาใช้ได้
- Journal stages ไม่มี atomic transaction เดียวข้ามทุก step. Crash อาจ strand locks; fail closed และไม่มี auto recovery/replay. เก็บ evidence ไว้ให้ trusted recovery design ของ root ไม่ให้ module เดาว่า native writer จบแล้ว
- Fresh เริ่มได้ก่อนรู้ UUID แต่ยังไม่ active ก่อน link; ถ้า link collision rootต้องหยุด owned new child และตรวจ exit ก่อน release reservation ไม่มีสิทธิ์ปล่อย lease ของ writer เดิม
- Uncertain lease ใน instance เดิมปล่อยได้เฉพาะเมื่อ trusted exit observer ให้ evidence ตรงจริง. Instance ใหม่/JSON handle ปล่อยไม่ได้. Crash ก่อน bindRuntime ต้องคง BLOCK เพราะยังไม่มี birth proof; ไม่มี force recovery API
- ACK reservation ก่อน unlock ทำให้ retry historical ไม่ launch ซ้ำแม้ crash ก่อนปล่อย locks. ถ้า instance เดิมยังอยู่สามารถ retry release หลัง verified exit เพื่อ finish local unlock ได้; หลัง process crash อาจคง lock ถาวรจน rootออกแบบ recovery แยก
- Namespace/db ต้องร่วมกันทุก host ที่ร่วม authority; คนละ journal database ไม่ใช่ cross-instance exclusion. Module ยังไม่ fence turn-host หรือ old mobile writers อัตโนมัติ

## Verification

ใช้ local Bun + temp SQLite + fixture supervisor เท่านั้น ไม่มี native CLI/model/server. Tests ตรวจ independent connections, UUID/home aliases, crash/reopen, fresh collision, exact resume, generation, false exit evidence, storage failures และ historical outcome. อ่านผลรันจริงและ hashes ใน vault `plans/cross-provider-handoff/PROTOCOL-SESSION-LEASE.md`

คำสั่ง targeted สำหรับผู้ดูแล (reviewer รันให้แล้วตามรายงาน):

```sh
MAW_TEST_MODE=1 bun test test/mobile-protocol-session-lease.test.ts
bun x tsc --noEmit --target ESNext --module ESNext --moduleResolution bundler --types bun --skipLibCheck src/mobile/continuity/protocol/session-lease.ts test/mobile-protocol-session-lease.test.ts
```

## ประวัติ

| วันที่ | ใคร | งาน |
|---|---|---|
| 8 พ.ย. 69 | Codex p4 | เพิ่ม lifetime reservation/opaque authority/native tuple/generation/trusted-exit gates พร้อม DI/temp SQLite tests; ไม่มี production wiring |
