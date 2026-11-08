# Protocol Runtime Host

โมดูล DI สำหรับ owned native protocol session — 8 พ.ย. 69

## หน้าที่และขอบเขต

`ProtocolRuntimeHost` รวม entry V2 และ explicit pilot V3, native drivers, `ProtocolSessionLeases` และ `EffectJournal` โดยไม่ spawn เอง ไม่มี default supervisor/admission ไม่มี filesystem effect ตอน import/constructor และไม่รับ ownership ของ external TUI

`source:"live"` หมายถึงตรวจ native identity และ completion ใน invocation นี้ พร้อมตรวจ owned child/admission ก่อนคืนผล ส่วน `source:"historical"` เป็นผล durable เก่า ไม่ใช่หลักฐานว่า child ยังทำงานหรือสิทธิ์ส่งใหม่ `inspect()` ใช้ได้เฉพาะ instance ที่ถือ active lease จริง

## Public API

```ts
new ProtocolRuntimeHost({journal, supervisor, admit, hooks?, driverFactory?})
open(input: RuntimeStartRequest): Promise<RuntimeStartReceipt>
start(input: RuntimeStartRequest): Promise<RuntimeStartReceipt>
startWithContext(input: RuntimeStartRequest & {
  firstTurn: {operationId: string; text: string}
}): Promise<RuntimeStartReceipt>
turn(operationId: string, text: string): Promise<RuntimeTurnReceipt>
inspect(): Promise<RuntimeInspection>
close(): Promise<SessionReleaseReceipt>
```

`RuntimeStartRequest` คือ `{roomId,operationId,candidate,timeoutMs,writer,firstTurn?}` โดย candidate ต้องเป็น immutable `ProtocolRuntimeCandidate` (`ProtocolEntryCandidateV2 | ProtocolPilotCandidate`), writer ต้องเป็น `owned-protocol-child`; exact resume ใช้ `candidate.session.id` เท่านั้น ไม่มี fresh fallback Claude ต้องได้รับ firstTurn ที่ผู้ใช้/host อนุมัติก่อน prepare ไม่สร้าง bootstrap text

Receipt ของ start/open คือ `{source,identity,generation,firstTurn?}`; turn คือ `{source,identity,generation,turn}` โดย generation มาจาก active lease หลัง verify native `inspect` คืน `{identity,generation,binding,selection,idle,pendingApproval}` หลังตรวจใหม่ `identity.home/route` เป็น host metadata ไม่ใช่ native proof

## Trusted dependencies

- `supervisor.launch(candidate,permit)` คืน `OwnedProtocolProcess` ของ `process-supervisor.ts` โดย exact incarnation/launchId/runtimeBirth, `assertRunning`, cleanup และ read-only exit proof
- `admit({binding,selection,phase,operationId,textHash?})` คืน `{source:"trusted-protocol-admission",binding,externalWriter:"absent"}` เท่านั้นจึงไปต่อ เป็น callback ที่ต้องอ่าน actual host state แบบ read-only; object จาก client/model ไม่ได้ให้ authority ต้องตรวจ binary hash/version/config/route/model/cwd/home/effectiveToolHome/homeEnvironment presence และ external ownership จริง
- ทุก admission ถูก bound ด้วย timeoutMs; ไม่ใช้ timeout แยกครอบ launch ที่อาจทำให้มี orphan child Supervisor มี bounded preflight/launch ของตนเอง
- `journal` ต้องเป็น private durable file ไม่ใช้ `:memory:`; payload เก็บ original V2 binding/selection และ authorized text แบบ private ไม่มี candidate env/argv/credentials ใน journal หรือ public diagnostics
- `driverFactory` เป็น trusted test/host seam เท่านั้น default ใช้ `protocolRuntimeDriver` และตรวจด้วย `protocolRuntimePolicy` ไม่ใช่ callable จาก request

## ลำดับและ guard

Persist start → original entry-binding ACK → reserve lifetime lease → launch permit → launch intent → supervisor → bind runtime → open (Codex) หรือ prepare + authorized first-user (Claude) → native identity/final verification → active generation → start ACK ทุก wire write ตรวจ persisted current intent, live lease, child running, admission และ native observation ที่มีอยู่ก่อนส่ง หลัง await admission ตรวจ child/lease/birth/failed/released ใหม่ และตรวจ intent dispatching อีกครั้งก่อน actual send

`turn` persist ก่อน driver และตรวจอีกครั้งก่อนคืน final ใช้ `ProtocolTurnHost` สำหรับ turn journal ภายในด้วย ACK/completed ไม่ปล่อย lifetime lease `close` ต้อง cleanup owned child และมี exact exit/closed pipes/no pending work proof ก่อน release ไม่มี TTL หรือ automatic uncertainty reset

## Pilot V3 binding

`RuntimeAdmissionRequest.binding`, `RuntimeAdmission.binding`, `RuntimeInspection.binding` ใช้ `ProtocolRuntimeBinding` union รับ original version 2/3 ตรง ๆ ไม่ downgrade/fallback และเปรียบเทียบทุก field แบบ canonical รวม presence/pilotPolicy/policyArgvHash Nested pilot policy/args ต้อง immutable ก่อนรับ candidate

ก่อน launch เก็บ binding/selection/version ทั้งชุดใน `entry-binding` acknowledged record เพราะ EffectJournal claim ปกติเก็บเพียง payload hash V3 เก็บ candidate.finalArgvHash แยกใน private entry record/start fingerprint ด้วย ไม่มี raw argv/env จึง reject same-operation cross-version/final-argv replay

`RuntimeLaunchReceipt` คือ `{readonly finalArgvHash:string}` แยกจาก resume binding Runtime เก็บเฉพาะ hash หลัง versioned entry policy validate แล้ว เป็น immutable snapshot ตลอด incarnation ไม่เก็บ/อ่าน/log env หรือ raw argv เพิ่มเพื่อ admission

`RuntimeAdmissionRequest.launchReceipt?:Readonly<RuntimeLaunchReceipt>` และ `RuntimeAdmission.launchReceipt?:Readonly<RuntimeLaunchReceipt>`: V3 ส่ง frozen receipt และบังคับ trusted response ตรงทุก field ที่ทุก admission boundary ขาด/hash เปลี่ยน/มี field เพิ่มจะ reject โดยไม่ส่ง frame ถัดไป V2 ไม่ส่งและไม่บังคับ field ใหม่ Historical ACK เป็น read-only replay ไม่มี admission/live authority ตามเดิม

Host ต้อง validate จาก trusted per-launch selection/preflight แล้วคืน receipt ไม่รับ hash จาก client/model มา grant authority ไม่เพิ่ม finalArgvHash ใน resume binding เพราะ fresh/resume argv ต่างกันตาม UUID Private entry record/start fingerprint เก็บ validated hash แบบเดิม จึงไม่เปลี่ยน journal format ด้วยการเพิ่ม admission receipt นี้ Supervisor preflight ยังคงเป็น authority ของ actual argv Pilot ไม่ให้ Read/retrieval/semantic/account/production proof

## Errors และข้อจำกัด

Errors เป็น safe `ProtocolError` code; stage/start/inspection/close uncertainty คง locks และไม่ replay อัตโนมัติ Concurrent turn/inspect/close ขณะ request ทำงานจะ reject Historical replay ไม่ call supervisor/admission; consumer ต้องแยกจาก live

โมดูลนี้ไม่ได้ detect external OS writer เอง ต้องใช้ trusted host admission/preflight; exact admission ไม่ atomic กับ OS write จึงยังมี TOCTOU ระหว่างตรวจและ write การ fail หลังบาง frame อาจเป็น uncertain ไม่ใช่ zero-byte rejection Callback ต้องไม่ mutation เพราะ late read-only admission completion อาจเกิดหลัง timeout

ยังไม่มี recovery/adopt process หลัง host restart, automatic reconcile uncertain locks หรือ production UI/engine routingในโมดูลนี้ Historical start ใน instance ใหม่ไม่ให้ `turn`/`inspect` authority Cleanup failure/exit proof ไม่ครบต้องคง lock และให้ host reconcile แบบ explicit ไม่ relaunch/ปลดโดยเดา

ไม่รับรอง account/quota, context retrieval, memory หรือ semantic understanding จาก native final; Root เป็นผู้ผูก context/hash/cursor/room binding ไม่มี native/live/model execution ในการตรวจรอบนี้

## ทดสอบ

`RuntimeAdmissionRequest` ส่ง `roomId` และ `launchOperationId` จาก start intent เดิมทุก phase แยกจาก `operationId` ของ turn ปัจจุบัน Host จึงตรวจ owner policy ได้โดยไม่เดาห้องจาก candidate ที่ใช้ร่วมกัน ค่า scope คงเดิมข้าม turn/inspect และ outer request frozen. Root ทดสอบ runtime+service 90 pass / 0 fail / 866 expects ผ่าน local DI (`/tmp/maw-protocol-admission-scope.log`) รวม different room/same candidate ปฏิเสธก่อน launch; ไม่ใช่ native acceptance ของ seam ใหม่นี้

`bun test test/mobile-protocol-runtime-host.test.ts` ใช้ temporary SQLite + fake owned child + real Codex/Claude drivers ผ่าน schema fixtures ใน DI wire ไม่มี child spawn/network/native Keys

## ประวัติ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ensure | เพิ่ม owned runtime V2, staged Claude, lifetime lease, durable turns, inspection และ focused tests |
| 8 พ.ย. 69 | Codex ensure | รับ explicit pilot V3 union, persist original binding และปิด child/intent revocation ระหว่าง awaited admission |
| 8 พ.ย. 69 | Codex ensure | เพิ่ม immutable per-launch receipt แยก resume binding และ missing/drift guards ทุก admission boundary ของ V3 โดยคง contract V2 |
| 8 พ.ย. 69 | Codex root | เพิ่ม stable room/launch operation scope ให้ trusted admission สำหรับ host composition |
