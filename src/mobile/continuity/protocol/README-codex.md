# CodexProtocolSession — pilot read-only-ask

วันที่ 8 พ.ย. 69 รองรับ Codex app-server schema 0.164.0 ผ่าน private DI `ProtocolWire` เท่านั้น ไม่ spawn/เปิด listener/เรียก provider HTTP และไม่มี I/O ตอน import/constructor ไม่แก้ continuity engine หรือ routing เดิม

## API

`new CodexProtocolSession(wire, policy, hooks?)` implements `NativeProtocolSession` จาก `types.ts` มี `open(nativeId?)`, `turn(operationId,text)`, `idle`, `pendingApproval`, `close()`

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

## Tests

`NODE_ENV=test MAW_TEST_MODE=1 bun test test/mobile-protocol-codex.test.ts` ผลล่าสุด55pass/0fail/156expects ผ่านin-memoryasyncwire ไม่ใช่app-serverจริง ไม่มีinference/agentlaunch/live

Fixturesใช้shapeจากschemaที่ทีม2generateด้วยpinnedbinary0.164.0 และมีoptionaltestตรวจactualgeneratedschemasในvault เมื่อartifactไม่มีจะskipschema-artifacttestหนึ่งเคส ไม่อ้างschema-artifactcoverageบนเครื่องที่ไม่มีไฟล์นั้น Validatorสำหรับfixturesครอบrequired/type/enum/refs/unions/arrayitems ไม่ใช่JSONSchemaengineเต็มรูปแบบ

รายงาน/commands/logs/hash: `~/oracle/ψ/incubate/Soul-Brews-Studio/maw-js/plans/cross-provider-handoff/PROTOCOL-CODEX.md`

## ประวัติ

| วันที่ | ผู้ทำ | รายการ |
|---|---|---|
| 8 พ.ย. 69 | Codex ensure | DI Codexprotocolpilot read-only-ask, exactnativecompletion/approvals/no-replayในinstance และ55focusedtests ไม่เปิดlive |

### Followup toolHome freeze

8 พ.ย. 69 เพิ่มmatched/wrong-homeทั้งfresh/resumeและinvalidtoolHometests ผล55pass Targetedtscผ่าน ไม่มีspawn/live ดูhashชุดล่าสุดในPROTOCOL-CODEX.md
