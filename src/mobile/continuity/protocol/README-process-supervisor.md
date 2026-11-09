# Protocol process supervisor

วันที่ 8 พ.ย. 69 · owner p4 · `process-supervisor.ts` คุมเฉพาะ owned private stdio child ของ trusted host ไม่มี native binary/config defaults และไม่เปิด protocol process ตอน import/construction

## หน้าที่และขอบเขต

สร้าง child หลัง constructor preflight ผ่านเท่านั้น ใช้ `JsonLineWire` สำหรับ private JSONL stdio และมี bounded frame/output/write/lifetime/cleanup. ไม่ใช้ shell หรือ parent environment inheritance ไม่คืน raw stderr/argv/candidate env ใน diagnostics/errors. ไม่ relaunch/resend เมื่อ timeout/disconnect และไม่ใช้ EOF/idle เป็น exit proof

นี่เป็น process mechanism ไม่ใช่ account/config/MCP/hooks/external-writer trust policy. `candidateOnly`/`liveEligible` หรือ HTTP boolean ไม่ให้ launch authority. Root ต้องใช้ trusted preflight ตรวจ exact v2 entry binding/pins/env presence/workspace/settings/MCP/hooks และ external ownership ก่อนคืน concrete spec; ไม่มี v1 fallback ใน module นี้

## API สำหรับ runtime host

```ts
const supervisor = new ProtocolProcessSupervisor({
  preflight: async (candidate, permit) => approvedSpec,
  pendingWork: () => hostHasPendingTurnToolsOrApprovals(),
  limits: { /* optional finite bounds */ },
});
const owned = await supervisor.launch(candidate, permit);
```

ตัวอย่างเป็น interface wiring สำหรับ root ไม่ใช่ preflight implementation. `approvedSpec` ต้องมาจาก trusted closure ที่ตรวจครบแล้ว เป็น `{binary,sha256,args,env,cwd}` เท่านั้น; canonical existing paths และ binary pin ตรวจซ้ำโดย module. `env` เป็น exact string record ไม่มี merge `process.env`. Spec ต้องไม่มี shell/custom spawn options; raw user argv ห้ามถูกส่งผ่าน trusted preflight โดยไม่ตรวจ

`permit` คือ `{incarnation,launchId}` จาก lifetime lease `beginLaunch` ที่ persist แล้ว; supervisor ไม่สามารถรับรอง journal authority จาก strings เอง Root ต้องถือ opaque lease และไม่ expose `launch` ให้ HTTP caller

| Owned API | ความหมาย |
|---|---|
| `wire` | private `ProtocolWire` ผ่าน JsonLineWire; bounded serialized input, single reader; close เรียก owned cleanup |
| `runtimeBirth` | random per-owned-handle birth token ผูก child object/exit events ใน instance นี้ ไม่ใช่ PID proof |
| `incarnation`, `launchId` | immutable runtime correlation metadata จาก lease permit |
| `assertRunning()` | read-only ตรวจ observed child/pipes ยัง usable ไม่ launch/kill/retry; ไม่ใช่ atomic guarantee ว่า child จะอยู่ต่อหลัง await |
| `cleanup()` | idempotent cached promise; ปิด input, รอ grace → SIGTERM → SIGKILL เฉพาะ owned child handle และรอ actual exit + stdio close จริง มี finite deadline |
| `observeExit(expected)` | read-only ไม่ cleanup ให้อัตโนมัติ; ต้อง exact incarnation/launch/birth + actual child exit/close + ไม่มี pending writes และ trusted pendingWork false จึงคืน SessionExitObservation |
| `diagnostics()` | stderr byte count/truncation และ fixed sanitized label เท่านั้น ไม่เก็บหรือคืน raw stderr |

## ลำดับ integration

1. Root trusted admission + lifetime `reserve`/`beginLaunch` ก่อน `supervisor.launch`
2. Launch คืน owned child แล้ว root `lease.bindRuntime({launchId,runtimeBirth})`
3. Driver ใช้ owned.wire; host เรียก assertRunning และ trusted admission ก่อน open/first user/next turn ตาม runtime-host contract. Native handshake/effective identity ต้องตรวจโดย driver/host แยก
4. Lifetime ไม่ release ตอน turn complete. เมื่อปิด session root เรียก cleanup แล้วให้ lease observer forward ไป owned.observeExit(expected)
5. `pendingWork` ต้องอ้าง host-owned state ของ child นี้ รวม turn/tools/approvals ไม่ใช่ browser input/global mutable allow flag. Supervisor ไม่แปลง unknown เป็น false

EOF ขณะ child ยังอยู่ทำให้ assertRunning/send ปฏิเสธ แต่ observeExit ยังไม่ผ่าน. Final native frames ควรถูก driver ตรวจและ journal ก่อน cleanup ซึ่งอาจทิ้ง output ระหว่าง shutdown; cleanup ไม่ใช่ receipt acceptance. Process exit ไม่ทำให้ uncertain operation ส่งซ้ำได้

## Bounds และ failure behavior

Defaults: preflight/pin 10s, lifetime 120s เฉพาะ `lifetimeMode: bounded` (ค่าเริ่มต้น), write 5s, graceful close 250ms, SIGTERM 500ms, SIGKILL wait 1s; frame 8MiB, cumulative stdout 32MiB, stderr 256KiB, pending writes 4, launch records 1024. Constructor รับ finite limits ที่ตรวจช่วงแล้วเท่านั้น Pipe transform ใช้ 64KiB high-water mark จึง backpressure เมื่อ driver ยังไม่อ่าน

เมื่อ stderr/output cap หรือ write/read failure เกิดขึ้น supervisor หยุด owned child ผ่าน cleanup ไม่มี raw frame/error content ใน error. Stderr drain ไม่เก็บ content เลย จึงไม่ต้องเดาว่า regex redact credential ครบหรือไม่. Preflight failure คืน sanitized code และถือ permit ใช้แล้วใน instance; late preflight resolution หลัง timeout ไม่ spawn

ข้อจำกัด:

- Replay set เป็น per-supervisor instance/capacity bounded ไม่ใช่ durable lease; root ใช้ lifetime module ป้องกัน crash/new-instance replay ห้ามสร้าง supervisor ใหม่เพื่อข้าม replay gate
- Pin hash/canonical file ตรวจจาก open file ก่อน spawn แต่ไม่มี atomic execute-from-open-file proof; root ต้องรักษา trusted native path integrity หากไฟล์ถูกแก้ได้โดยผู้โจมตีระหว่าง hash กับ spawn ต้องคง BLOCK
- Signals ใช้ owned ChildProcess handle ไม่รับ raw PID. ไม่รับรอง descendant process tree/external TUI ทั้งเครื่อง; root trusted pending/external ownership evidence ยังจำเป็น ไม่ฆ่า process อื่นเพื่อให้ได้ proof
- Failed spawn/kill/exit observation ไม่ปล่อย lifetime leaseเอง. ไม่มี process reconnect/adoption/TTL/user unlock
- ไม่มี network/model/native pilot ใน verification รอบนี้; `prepareOneWayServerHost` เลือก `owned-session` ผ่าน trusted constructor เท่านั้น ไม่เปิดใช้อัตโนมัติ
- `lifetimeMode: owned-session` ไม่มี lifetime timer: session อยู่จน explicit cleanup หรือ failure/output bounds เดิม ไม่รับค่านี้จาก browser และไม่เปลี่ยน pending-work/exit/lease guards; `bounded` ยังคง timeout เดิม

## Verification

Tests ใช้ executable Node scripts ใน temp dirs เท่านั้น (ต้องมี `node` ใน PATH; resolve realpath แล้วใช้ absolute shebang ไม่เปลี่ยน PATH). ไม่มี native agent/model/network/server. ใช้ local Bun test runner สำหรับ JsonLineWire + lease integration; รายละเอียดผลจริง/initial fixture issue/final hashes อยู่ vault `PROTOCOL-PROCESS-SUPERVISOR.md`

คำสั่ง focused ที่รันให้แล้ว:

```sh
MAW_TEST_MODE=1 bun test test/mobile-protocol-process-supervisor.test.ts test/mobile-protocol-wire.test.ts test/mobile-protocol-session-lease.test.ts
bun x tsc --noEmit --target ESNext --module ESNext --moduleResolution bundler --types bun --skipLibCheck src/mobile/continuity/protocol/process-supervisor.ts test/mobile-protocol-process-supervisor.test.ts
```

## ประวัติ

| วันที่ | ใคร | งาน |
|---|---|---|
| 8 พ.ย. 69 | Codex p4 | เพิ่ม trusted preflight private child supervisor/bounded JSONL/owned exit evidence พร้อม fixture-child tests; ประสาน p2/runtime-host โดย Herdr ไม่แก้ lease/shared files |

| 9 พ.ย. 69 | Codex root/p4 | เพิ่ม owned-session สำหรับ explicit production startup; local Node fixture regression 24 pass / 143 expects ตาม `/tmp/maw-production-lifetime-p4-regression.log`; ไม่มี native/server execution |
