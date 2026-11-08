# Protocol Host Composition

8 พ.ย. 69 — concrete host-only config → pinned loader → per-child supervisor → continuity service ไม่มี server mount หรือ native execution ตอน import

## API และการเปิดใช้

```ts
readProtocolHostConfig({path,sha256}):ProtocolHostConfig
loadProtocolHostComposition(config?,authority?,mechanisms?):
  | {kind:'disabled',featureOptions:undefined,close}
  | {kind:'configured',service,featureOptions,bootstrapOwned,close}
```

ไม่มี config/activation หรือ mode disabled คืน disabled โดยไม่ load module/provision service ไม่มี ambient environment/config discovery `readProtocolHostConfig` อ่านเฉพาะ explicit pinned canonical regular JSON file ที่ไม่มี group/other permission ตรวจ hash/stable bytes/size และปฏิเสธ unknown config fields ไม่ใช่ API สำหรับรับ browser path หรือ enable boolean

Configured host ส่ง `composition.featureOptions` ให้ server mount ของ Root โดยตรง ไม่ mount raw `service.featureOptions` แทน เพราะ composition มี history synchronization wrappers ไม่มี resolveChannel/raw-channel passthrough เมื่อ configured

## Config schema

`ProtocolHostConfig` version1 มี activation `{kind:'host-owned-protocol',mode:'pilot'|'production'}`, modulePin `{directory,hashes}`, privateRoot/actorId/timeoutMs, scopes และ optional maxContextBytes

Scope คือ `{id,backend,workspace,room,cwd,profiles}` โดย backend คง herdr/tmux/superset ไม่สร้าง protocol backend ใหม่ Profile คือ `{agent,version,model,route,provider,endpoint,home,effectiveToolHome,homeEnvironment,native}`; native มี binary/sha256/version/versionEvidence ครบ

Profile/scope เป็น immutable snapshots จาก constructor ต้องเลือก profile เดียวตาม agent+model ไม่เดา latest/default เมื่อกำกวม Scope/model/route/native/home/presence ที่ browser เปลี่ยนเองไม่ถูกส่งต่อไป builder เป็น config Root ต้องไม่เอา request body มาสร้าง host constructor

Builder input สร้างจาก allowlist จริง เลือก V2/V3 แบบ explicit V3 เฉพาะ pilot ไม่ downgrade/fallback Native env มาจาก pinned loader processSpec เท่านั้น ไม่ merge process.env; absent CODEX_HOME/CLAUDE_CONFIG_DIR คง absent

## Concrete mechanisms

- PinnedProtocolEntryLoader ตรวจ reviewed module hashes ก่อน build/spec และยอม processSpec เฉพาะ owned candidate object ไม่เปิด candidate/spec/env ออก HTTP
- ProtocolProcessSupervisor ต่อ child ใช้ native policy attestation ก่อน loader.processSpec และ bounded binary pin/spawn/cleanup ของ Root/p4 ไม่มี shell/global spawn defaults นอก module นี้
- Native driver จริง default protocolRuntimeDriver; wrapper นับ pending calls/approvals/driver lifecycle จาก instance ของ child นั้นเพื่อ supervisor exit proof ไม่ใช้ browser pendingWork boolean
- Continuity service จริง มี private Store/Engine/Archive/Facts/owned registry/ledger ตาม service freeze ไม่มีแก้ service/driver/API
- mechanisms เป็น constructor DI สำหรับ trusted host/tests ไม่ใช่ JSON config หรือ browser option

## Authority ที่ Root ต้องให้

`attestNative(request)` รับ exact roomId/launchOperationId/current operation/phase/selection/binding/V3 launchReceipt รวม textHash/permit เมื่อมี ต้องคืน source trusted-native-host-attestation, durable reference, matching IDs/binding/receipt, externalWriter absent และ nativePin/effectivePolicy/route verified กับ startup reviewed ขาด/unknown/mismatch ไม่ launch หรือส่ง frame ไม่ถือ module hash/native ACK เป็น policy/exclusivity proof

roomId+launchOperationId มาจาก runtime seam ของ Root โดยตรง ใช้แยกสองห้องที่ binding เหมือนกันไม่อนุมานจาก cwd/home

`connection(profile)` เฉพาะ mind ให้ private connection เข้า pure builder ห้าม log/serialize token/env/candidate ทั้งก้อน ไม่มี direct fallback

`resumeBinding({scope,profile,binding})` ต้องคืน exact persisted full entry binding ที่ native UUID/version/namespace ตรง ไม่สร้างจาก current config/UUID อย่างเดียว ไม่เพิ่ม finalArgvHash เข้า resume binding

`verifyContext(room,binding,context,start)` ต้องเป็น actual exact native turn/context verifier คืน matching acknowledged receipt เท่านั้น ถ้าขาด production capability ยังปิด ไม่อ่านข้อความ model ACK แล้ว claim memory/retrieval

`liveEvidence()` เป็น Root-reviewed production backend/model acceptance references ไม่ใช่ fixture หรือ config boolean Mode pilot ไม่เรียก provider นี้และยัง gate off แม้ native bootstrap ทำได้ ตาม scope freeze รอบนี้

## Actual native history และ order

Default ใช้ readProtocolNativeHistory ของ Root ส่ง exact UUID/effectiveToolHome/cwd จาก owned Room/configured profile อ่าน readNativeRecords เต็มแบบ bounded/stable ไม่มี latest lookup หรือ resolver ซ้ำ Optional readHistory override ต้องเป็น trusted-full-native-history attestation ตรง scope/binding/cwd และ bounded-from-start

`bootstrapOwned({scopeId,operationId,agent,model?,resume?,firstTurn?})` เป็น host-only explicit plan เปิด child ใหม่ด้วย service ไม่ adopt TUI หรือ persisted Room จากนั้น await snapshot ก่อนคืนผล Claude ต้อง authorized firstTurn; native history ยังไม่มี/ไม่ complete จะไม่ปลอม ready ไม่มี auto prompt กระตุ้น ID

Transport status synchronize ต่อ revision/binding ก่อนเปิด readiness Fresh owned turn snapshot ก่อน dispatch เสมอเพื่อ import bootstrap/target context ก่อนข้อความใหม่ Exact stored turn retry ส่งให้ service ตรวจ full-key conflict ก่อน historical โดยไม่บังคับ history read ซ้ำ

Normalization ใช้ persisted host protocol-turn pair/provenance + exact identity: Claude user source UUID, Codex assistantMessages.turnId และ replyToSourceId/index ตรวจ final flag/text ตรงเพิ่มเพื่อจับ rewrite ไม่ใช้ text-only dedup Native aliases ถูก map กลับ deterministic persisted source IDs โดยเก็บ body เดิม ไม่สร้าง duplicated facts

Existing source history ต้องเป็น prefix ของ projected native history หากกำลัง append ประวัติเก่าย้อนท้ายจะ fail closed Bootstrap/target context จึงต้อง synchronize ก่อนเปิด UI รับ turn

**ขอบเขตที่ยังทำไม่ได้:** เมื่อ proven owned pair มี native intermediate public/tool events ระหว่าง user กับ final แต่ Store append-only บันทึก pair ไปแล้ว โมดูล reject protocol_history_intermediate_events_require_projection แทน drop/reorder/fabricate events ต้อง Root ตัดสิน ordered event projection/atomic ingest seam ภายหลัง ไม่แก้ parser/Store/service ในรอบนี้

## Pilot acceptance permit — proposal เท่านั้น

V3 pilot ใช้งาน explicit bootstrap/history ได้ แต่ engine/UI mutation ยัง gate off จึงยังทดสอบ switch จริงผ่าน UI ใน mode นี้ไม่ได้ ไม่เปลี่ยน fixture ให้เป็น production liveEvidence

เสนอให้ Root เพิ่ม optional service seam สำหรับ host-owned bounded acceptance permit แยก production certification (purpose/permit ID/exact room+profile+operation scope และ budget/expiry ที่ authority ตรวจ) เพื่อให้ internal service preflight/text gate กับ UI เห็นฐานการอนุญาตเดียวกัน ห้าม override แค่ UI capabilities เพราะ internal service ยังปิดอยู่ งานนี้ยังไม่ implement permit หรือแก้ service/API

## การตรวจและข้อจำกัด

Focused tests ใช้ pinned temporary builder sources, actual loader/service/runtime, fake process/driver DI และ parseNativeRecords จริงทั้ง Claude/Codex รวม default native reader อ่าน fixture file จริง ไม่มี native/model/network/server/config จริง/wM ไม่อ้าง production acceptance

Attestation callbacks เป็น trusted host authority ไม่ใช่การตรวจ artifact/effective managed policy ให้เอง Source/config pins ไม่พิสูจน์ account/endpoint/semantic understanding ต้อง Root ส่ง actual authority/verifier และถือ livepilot/mount/activation decision

## ประวัติ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ensure | เพิ่ม pinned host config/owner-policy composition, concrete loader/supervisor/service และ actual Root history-reader default |
| 8 พ.ย. 69 | Codex ensure | เพิ่ม exact native-turn normalization/order guards และบันทึก acceptance-permit proposal โดยคง production gate |
