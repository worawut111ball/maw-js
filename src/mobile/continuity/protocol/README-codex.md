# CodexProtocolSession — pilot read-only-ask

วันที่ 8 พ.ย. 69 รองรับ Codex app-server schema 0.164.0 ผ่าน private DI `ProtocolWire` เท่านั้น ไม่ spawn/เปิด listener/เรียก provider HTTP และไม่มี I/O ตอน import/constructor ไม่แก้ continuity engine หรือ routing เดิม

## API

`new CodexProtocolSession(wire, policy, hooks?)` implements `NativeProtocolSession` จาก `types.ts` มี `open(nativeId?)`, `turn(operationId,text)`, `idle`, `pendingApproval`, `close()`, `diagnostics()` (concrete Codex instance เท่านั้น)

`policy.agent` ต้อง codex; cwd/home ต้อง normalized absolute paths; model/route ต้องมีค่า และ **Codex require modelProvider** เพื่อเทียบ expected provider จริง timeout1..300000ms Policyเป็น trusted host snapshot ไม่รับจาก HTTP/model และไม่ส่ง raw config/caller overrides

- openไม่มีID: initialize → initialized → thread/start
- openมีUUID: initialize → initialized → exact thread/resume ไม่มี fallback/fork/startใหม่
- fixed pilotprofile: thread/start/resume ส่ง approvalPolicy on-request, sandbox read-only, approvalsReviewer user และตรวจ responseเป็น on-request/readOnly/user ปฏิเสธworkspaceWrite/untrusted/never/fullaccess/networkaccess ไม่มี permission parity claim
- turnส่งเฉพาะ threadId + text UserInput แล้วรอ exact turn/completed notification สถานะ completed, errorว่าง, fullitems และไม่มี observed pending items/approval ไม่ถือturn/start ACKเป็นcompletion
- คืน ProtocolTurn เฉพาะ public agentMessage final/legacy unknown phase ไม่คืน reasoning/tool bodies เป็นคำตอบ
- concurrentturn/reused operation ID ปฏิเสธ ไม่มี automatic resend/reconnect/resume fallback เมื่อ disconnect/writefailure/timeout จะ poison instance และคืน ProtocolError.uncertain=true หากมีoperationอาจเริ่มแล้ว
- operation IDs/approval IDs เป็น memory-bound ต่อinstance จำกัด10000 ไม่มี guaranteeข้ามrestart/instance ต้องใช้hostdurablejournal/exclusivewriterเพิ่มเติม

## Approvals

รองรับ commandExecution/requestApproval กับ fileChange/requestApproval ผูก native thread/turn/item/requestID และ cwd ห้าม grantRoot/persistent amendment หรือ session-wide accept ใช้ one-shot accept เฉพาะ hooks.approve คืนallowอย่างชัดเจน; ไม่มีhook/errorคืนdecline Unsupported requestคืนJSONRPCerrorและหยุดinstance ไม่ปลอมpermissions approval

Callbackที่ตอบหลังdisconnect/timeout/turnเปลี่ยนไม่มีทางส่งlateallow pendingapprovalไม่ใช่idle และcompletedระหว่างpendingไม่ผ่าน Hostต้อง authenticate actor/lease/UIก่อนเรียกallow ไม่มีgenericautoapprove

## Trust และข้อจำกัด

`ProtocolIdentity.home` กับ route เป็น **host-attested metadata** ไม่ใช่nativeproof `initialize.codexHome` ตรวจว่าเป็นnormalizedabsolutepath และเมื่อhostส่ง optional `policy.toolHome` จะต้องตรงexactก่อนinitialized/threadstart/resume (ผิดให้initialize_identity_mismatch) ไม่เทียบcodexHomeกับOS HOME SharedtypesมีtoolHomeแล้ว แต่endpoint/binaryversion/exclusivewriterยังเป็นhostpreflight Pilotของrootต้องส่งtoolHomeเสมอ; omissionรองรับcallerเดิมแต่ไม่รับรองselectedtoolHomebinding `thread.model` เป็น configured model ไม่ใช่per-turntelemetry/account/quota proof

Onlyinitialization/thread/turn/item/approvalที่รองรับ Unknownnotification/error/modelrerouteทำให้failclosed ไม่รองรับturnsteer/rawcontrols/userinputelicitation/MCPpermissionbridge/permission parityหรือ live production ตอนนี้ Native tool failed/declined ไม่ผ่านcompletion gateแม้nativeจะสามารถตอบข้อความอธิบายfailureแล้วจบturnได้

## Exact-pin startup remote-control status

8 พ.ย. 69 รองรับเฉพาะ `remoteControl/status/changed` ตาม generated 0.164.0 `v2/RemoteControlStatusChangedNotification.json`: required status/serverName/installationId; environmentId optional string|null; status enum disabled/connecting/connected/errored

ยอมรับแบบ passive เฉพาะ open ที่เห็น initialize response แล้ว ยังไม่มี thread identity/active turn Native อาจ enqueue ทันทีหลัง RPC response ก่อน open continuation จึง track response envelope แยกจาก readiness แต่ initialize.codexHome/thread/model/provider/permission checks ทั้งหมดยังคงเดิม

Remote metadata ไม่ถูกเก็บ/log/expose ไม่ grant ready/identity/approval ไม่ตอบ server request ไม่ส่ง user turn และไม่เป็น completion proof Malformed fields/unknown scope keys เช่น threadId/turnId/approvalPolicy ปฏิเสธ Status ก่อน initialize response หลัง open หรือระหว่าง active turn scope mismatch; method อื่นยัง unsupported_notification ไม่มี blanket unknown-ignore

Live diagnostic ของ Root คือ protocol-codex-live-1794150258886 พบ method นี้หลัง initialize ก่อน thread start Rootcleanup owned childแล้ว ผู้เขียนไม่รัน native/spawn/live รอบนี้

## Scoped MCP lifecycle และ safe diagnostics

8 พ.ย. 69 เพิ่ม `mcpServer/startupStatus/updated` ตาม exact 0.164.0 `v2/McpServerStatusUpdatedNotification.json` Required name/status; threadId optional string|null; error optional string|null; failureReason optional null/reauthenticationRequired; status starting/ready/failed/cancelled

starting/ready เป็น passive lifecycle ต้อง thread UUID ตรง selected identity หรือ thread response ที่กำลังเปิด Global null/omitted thread รับได้เฉพาะ opening หลัง initialize response ก่อนมี identity ไม่ให้ establish thread จาก notificationเอง หลัง open/global/foreign thread reject Scope fieldsนอกschema, invalidtypes/status/reason reject Failed/cancelled/non-null error/failureReason fail closed ไม่เพิกเฉย startup failure ไม่เปิด tools/ไม่ส่งMCPcalls ไม่ให้ approval ไม่ถือreadyหรือturncompletedจากMCPstatus

เหตุหลัง open ACK แล้วไม่มี turn claim ที่ Rootพบอธิบายได้จาก code: unsupported notification poison ทำ broken จึง idlefalse; runtime performTurn ตรวจ idle/pending ก่อนสร้าง effect claim (runtime-host.ts:223–224) จึงลง runtime_start_uncertain โดยยังไม่ส่ง firstuser การแก้เพิ่มเฉพาะ exact method/schema ไม่ลดลำดับguard

`diagnostics():CodexProtocolDiagnostics` อ่านได้จาก concrete Codex driver instanceก่อนwrapper ไม่มี I/O และไม่ logเอง คืน phase/broken/idle/pendingApproval/safe code และ lastFrame snapshot มี kind/known method/masked unknown, allowlisted key names+unknown count, threadScope absent/null/unbound/matches/foreign, enum status และ error/failure field types ไม่มี rawUUID/serverName/MCPname/installation/environment/errorbody/reasoning/tokens Unknownmethod/rawcodeที่ไม่รู้จักถูกmask คืน cloned dataไม่ให้callermutateinternalstate

Root trace protocol-codex-live-1794150744991 เป็นหลักฐานของ Root: initialize→remoteControl status→thread/start result→MCP lifecycle ก่อนfirstturn ผู้เขียนใช้ DI/schemaเท่านั้น ไม่มีnative/spawn Live rerunเป็นของRootด้วยfreshoperation ไม่replayoperationเดิม

## Tests

`NODE_ENV=test MAW_TEST_MODE=1 bun test test/mobile-protocol-codex.test.ts` ผล scoped lifecycle+diagnostics ล่าสุด98pass/0fail/310expects ผ่านin-memoryasyncwire ไม่ใช่app-serverจริง ไม่มีinference/agentlaunch/live

Fixturesใช้shapeจากschemaที่ทีม2generateด้วยpinnedbinary0.164.0 และมีoptionaltestตรวจactualgeneratedschemasในvault เมื่อartifactไม่มีจะskipschema-artifacttestหนึ่งเคส ไม่อ้างschema-artifactcoverageบนเครื่องที่ไม่มีไฟล์นั้น Validatorสำหรับfixturesครอบrequired/type/enum/refs/unions/arrayitems ไม่ใช่JSONSchemaengineเต็มรูปแบบ

รายงาน/commands/logs/hash: `~/oracle/ψ/incubate/Soul-Brews-Studio/maw-js/plans/cross-provider-handoff/PROTOCOL-CODEX.md`

## ประวัติ

| วันที่ | ผู้ทำ | รายการ |
|---|---|---|
| 8 พ.ย. 69 | Codex ensure | เพิ่ม scoped MCP lifecycle และ value-free diagnostics พร้อม scope/error/unknown/no-readiness negatives 98 focused tests |
| 8 พ.ย. 69 | Codex ensure | เพิ่ม exact-pin passive remote-control startup status พร้อม malformed/scope/unknown/no-ready negatives |
| 8 พ.ย. 69 | Codex ensure | DI Codexprotocolpilot read-only-ask, exactnativecompletion/approvals/no-replayในinstance และ55focusedtests ไม่เปิดlive |

### Followup toolHome freeze

8 พ.ย. 69 เพิ่มmatched/wrong-homeทั้งfresh/resumeและinvalidtoolHometests ผล55pass Targetedtscผ่าน ไม่มีspawn/live ดูhashชุดล่าสุดในPROTOCOL-CODEX.md
