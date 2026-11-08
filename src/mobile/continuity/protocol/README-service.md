# Protocol Continuity Service

Concrete composition จาก trusted host DI — 8 พ.ย. 69

## หน้าที่

`createProtocolContinuityService` ประกอบ `ContinuityStore`, `ContinuityEngine`, `ContinuityArchive`, `FactsSelectionStore`, `FactsUIService`, `ProtocolContinuityAdapter`, `EffectJournal` และ owned runtime registry ต่อ instance ไม่มี global registry, default native supervisor, terminal discovery หรือ TUI adoption การ import ไม่มี I/O; การเรียก factory provision private directory/archive เท่านั้น ไม่ launch child

## Public API

```ts
const service = createProtocolContinuityService({
  privateRoot, actorId, timeoutMs,
  runtime: {supervisor, admit, hooks?, driverFactory?},
  host: {
    resolveRoomId, preflight, candidate, history, verifyContext,
    liveEvidence?
  },
  maxContextBytes?
});
// service.store / engine / archive / selections / factsUI
// service.featureOptions: mount continuity ได้ตรง contract ของ features/continuity.ts
service.snapshot(room): Promise<Snapshot>
service.bootstrapOwned({scope, operationId, candidate, writer, firstTurn?})
  : Promise<{room: Room; start: RuntimeStartReceipt}>
service.owned.inventory(): Promise<Array<{room: Room; transport: OwnedTransportStatus}>>
service.owned.status(room): Promise<OwnedTransportStatus>
service.owned.turn(room, {id, text, expectedRevision, binding}): Promise<OwnedTurnReceipt>
service.owned.turnStatus(room, id): Promise<OwnedTurnReceipt | null>
service.close(): Promise<void>
```

`featureOptions.owned` เป็น object เดียวกับ `service.owned` ใช้ `OwnedTransportStatus/OwnedTurnRequest/OwnedTurnReceipt` จาก Root features โดยตรง Registry ไม่รับ discovered panes หรือ runtime จาก browser API

## Trusted host configuration

- `privateRoot` ต้อง absolute/canonical directory, ไม่เป็น symlink, permissions ไม่มี group/other และอยู่นอก public/share roots ไม่มี path จาก API มาเป็น storage root
- `actorId` เป็น host label สำหรับบันทึก explicit selection ไม่ใช่ authentication; Root ต้อง mount routes หลัง authentication เดิม
- `runtime.supervisor/admit` รับผิดชอบ actual binary/config/route/home/toolHome/presence/pilot policy/external writer และ per-launch receipt ของ V3 ตาม runtime contract ไม่มี candidate flag ที่ grant launch
- Resolver อ่าน durable bootstrap catalog ก่อนแล้วอ่าน `store.room(id)` จริง Known scope ไม่กลับเป็น unmanaged เมื่อ host alias callback ลืม mapping; scope ที่ claim bootstrap แต่ยังไม่มี Room จะ fail closed ด้วย protocol_room_bootstrap_pending สำหรับ scope นอก catalog ใช้ `resolveRoomId(ws,room)` เป็น exact host alias lookup ไม่มี latest/fallback และตรวจ workspace/room จาก store อีกครั้ง Bootstrap ต้องมี mapping ไป scope.id ล่วงหน้า แม้ยังไม่มี store row
- `host.history(room,binding)` ต้อง exact native resolver + bounded full read ตั้งแต่ต้น พร้อมตรวจ native UUID/cwd จริง ไม่มี API path หรือ latest lookup Service ตรวจ room/revision/owned runtime/binding ก่อนและหลัง await และ import ผ่าน atomic Store method แต่ Event[] ไม่ได้ attest ความครบของ native file ด้วยตัวเอง
- `host.verifyContext` เป็น separate trusted final/context verifier ไม่ใช่การอ่าน model ACK แล้วตั้งว่าเข้าใจ/จำ context ได้
- Candidate ของ active operation ถูก pin เป็น immutable promise ต่อ room/op/target/existing/model ไม่เลือก config ใหม่ระหว่าง targetPolicy กับ launch จำกัด 1024 pins ต่อ service แล้ว fail closed

## Capabilities และการเปิดใช้

Default `ready:false`, models ว่าง และ textTurn false จน host ให้ `liveEvidence()` ที่ตรวจแล้ว:

```ts
interface ProtocolLiveEvidence {
  source: 'trusted-live-continuity-evidence';
  scope: 'all-backends' | 'room-backend';
  backends: Array<{backend: 'herdr'|'tmux'|'superset'; runId: string}>;
  models: Array<{agent:'codex'|'claude'; id:string; label:string}>;
}
```

ไม่มี callback/null/error/malformed evidence ทำให้ gate ปิด `all-backends` ต้องครบทั้งสาม; `room-backend` เปิดเฉพาะ backend ที่มีหลักฐาน ชื่อ models มาจาก host ไม่ hardcode การให้ source tag ไม่ได้ตรวจ acceptance artifact ให้อัตโนมัติ Host เป็นผู้ตรวจหลักฐานจริง

`factsSelectionAvailable:true` หมายถึงมี concrete selection service ไม่ใช่ live continuity readiness Fresh engine preflight และ owned text dispatch ตรวจ gate ใน service ด้วย ไม่พึ่ง HTTP ready guard เพียงชั้นเดียว

การเปิด/ปิดทำผ่าน trusted host DI และหลักฐาน ไม่ใช่ UI toggle ในโมดูลนี้ ไม่มี production enablement ในรอบ implementation นี้

## Facts snapshot เดียวกับ engine

1. รับ exact stored room ไม่มี active operation สำหรับ UI snapshot
2. ตรวจ owned runtime/binding/cwd/idle ก่อนและหลัง history read
3. `store.importHistory(room,records)` ตรวจ exact current room และ commit ทั้ง batch ใน transaction เดียว
4. อ่าน store events ตาม seq และสร้าง archive ด้วย JSONL + trailing LF แบบเดียวกับ engine ผ่าน archive root เดียวกัน
5. Facts preview/approve ใช้ snapshot/revision/binding/hash/cursor เดียวกัน explicit approve บันทึก selection ด้วย id ที่ต้องเป็น switch operation id
6. Engine facts provider ตรวจ active operation/state/expected revision/source binding, actual store events/hash/cursor/archive path แล้วอ่าน selection ด้วย operation id เท่านั้น ไม่มี hardcoded facts หรือเลือกจาก model ACK

History เปลี่ยนหลัง approve ทำให้ scope/hash ไม่ตรงและ block ก่อน source exit/target context ไม่ retarget selection เก่า

## Owned bootstrap และ inventory

`scope={id,backend,workspace,room,cwd}` เป็นข้อมูลจริงจาก host `writer` ต้อง `owned-protocol-child`; candidate ต้อง immutable runtime union ที่ versioned policy ตรวจแล้ว Claude ต้อง authorized firstTurn ไม่สร้าง bootstrap text

Persist bootstrap intent และ unique scope catalog ก่อน runtime start จากนั้นต้อง live identity/lease generation/inspection ตรงจึง register Room ไม่ adopt persisted room ที่ runtime หาย Existing room หรือ uncertain bootstrap ต้อง explicit reconciliation ไม่ start ซ้ำ

Inventory อ่านเฉพาะ catalog ที่ host bootstrap กับ store rows จริง ไม่ enumerate TUI หรือเดาจาก cwd/title Registry หายหลัง restart แสดง `unavailable` (หรือ `uncertain` หากมี pending owned turn) และ textTurn false ไม่มี auto-adopt Scope mismatch fail closed จำกัด inventory 1024 rooms

## Owned text-turn ledger

- ข้อความต้องไม่ว่าง ไม่มี NUL ไม่เกิน 8000 JS characters/32000 UTF-8 bytes
- ตรวจ same-ID/full payload/scope conflict ก่อน historical replay; exact completed/uncertain retry อ่านผลเก่าโดยไม่อ่าน native/ไม่ resend แม้ gate ปิดหรือ room revision เปลี่ยนแล้ว
- Fresh request ต้อง expectedRevision/binding ตรง current store ไม่มี switch operation, live evidence ผ่าน และ actual owned runtime inspect ตรงก่อน mutation
- Private SQLite FULL synchronous transaction claim request และ unique pending writer ต่อ room ก่อน runtime.turn; dispatching/uncertain ไม่มี TTL/no auto reset
- หลัง final ต้อง inspect identity/generation/current room อีกครั้ง แล้ว `Store.importHistory` บันทึก user+assistant สอง events atomically ก่อน completed ledger ACK
- `metadata` มี operationId/turnId/generation/requestHash และ provenance `host-authorized-user`/`native-protocol-final`; source IDs คือ `protocol-turn:<SHA256([roomId,id])>:user|assistant`
- `turnStatus` unknown คืน null; dispatching/uncertain คืน historical uncertain ไม่ advance/replay; status ระหว่าง invocation นี้ busy และหลัง interruption uncertain
- ไม่รองรับ attachments/keys ทั้งคู่ false ไม่ส่งกลับ TUI fallback

## Durability และข้อจำกัด

ไฟล์ภายใน privateRoot:

| ไฟล์ | หน้าที่ |
|---|---|
| rooms.sqlite | Room/operation/events/held messages ของ ContinuityStore |
| effects.sqlite | Runtime/lease/launch/turn effects และ bootstrap journal |
| owned-turns.sqlite | Unique owned request receipts, non-expiring pending room guard, bootstrap scope catalog |
| archive/ | Immutable facts/engine snapshots |
| selections/ | Explicit facts selections/provenance |

Owned ledger/Store เป็นคนละ transaction ไม่ใช่ distributed atomic commit: event pair atomic แต่ crash หลัง pair ก่อน receipt ACK คง uncertain และห้าม resend มี test SQL-trigger ACK failure ที่พิสูจน์กรณีนี้ ไม่มี automatic repair/reconcile หรือ replay หลัง restart

History host ต้องใช้ canonical source IDs/correlation ที่สอดคล้องกับ protocol events หากเอา raw native history ที่ source ID ต่างกันมารวมโดยตรง อาจเกิด logical duplicate Service ไม่เดา dedup จากข้อความเหมือนกันและไม่อ้างว่าแก้ native-reader projection ให้แล้ว

Root เปลี่ยน `ProtocolAdapterPorts.candidate` เป็น `ProtocolRuntimeCandidate` union แล้ว Service ใช้ exported interface นั้นตรง ๆ ไม่มี cast/fallback; V3 ยังคง pilot-only ไม่ใช่ production evidence

Root เป็นเจ้าของ native preflight, evidence certification, auth/UI/project merge, history bridge และ production bootstrap; ไม่มี implementation ของสิ่งเหล่านี้แอบเปิดใน service `close()` เป็น explicit cleanup ของ owned children: ตั้ง shutdown latch ก่อน await แล้วลองทุก runtime แม้ห้องก่อนหน้า busy/exit unavailable เก็บ failed room IDs ภายในและคืนเพียง `protocol_service_cleanup_failed` (503) ไม่มี raw error/diagnostics หากบางห้อง fail จะไม่ปิด shared stores/journal ที่ต้องใช้ reconcile และไม่ปลด failed lease/ledger

ระหว่าง close และหลัง close ที่ล้มเหลว instance นี้ไม่รับงานใหม่ รวม recheck admission หลัง await จึงไม่ปล่อย next frame ที่เพิ่งได้ approval กลับมา งานที่เคยเริ่มอาจจบเป็น uncertain และคง durable guard ไม่มี automatic relaunch/replay/reset การเรียก close ซ้ำแบบ explicit มีไว้ลอง cleanup ที่เหลือเท่านั้น ห้องที่ release สำเร็จแล้วคืน historical exit โดยไม่ cleanup ซ้ำ; uncertain native close ยังคงต้อง host reconciliation ไม่ใช่การปลอม exit proof ไม่อนุญาต restart native/server อัตโนมัติ

ไม่อ้าง Read/context retrieval, semantic understanding, account/quota หรือ production acceptance จาก final/provenance นี้

## การทดสอบ

`bun test test/mobile-protocol-service.test.ts` เป็น local DI ชั่วคราว ใช้ concrete Store/Engine/Archive/Facts/Runtime กับ fake supervisor/driver ไม่มี native/model/network/server และไม่แตะ real rooms

## ประวัติ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ensure | เพิ่ม concrete service, exact facts snapshot, explicit bootstrap, default-off capabilities และ focused tests |
| 8 พ.ย. 69 | Codex ensure | เพิ่ม durable owned text/status/inventory ผ่าน featureOptions พร้อม provenance pair, restart/ACK/race negatives |
| 8 พ.ย. 69 | Codex ensure | ปิด P2 close หลายห้อง: ลองทุก owned runtime, sanitize failure, คง failed guards และ shutdown latch รวม awaited admission |
