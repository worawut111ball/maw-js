# CodexProtocolSession — pilot read-only-ask

วันที่ 8 พ.ย. 69 รองรับ Codex app-server schema 0.164.0 ผ่าน private DI `ProtocolWire` เท่านั้น ไม่ spawn/เปิด listener/เรียก provider HTTP และไม่มี I/O ตอน import/constructor ไม่แก้ continuity engine หรือ routing เดิม

## API

`new CodexProtocolSession(wire, policy, hooks?)` implements `NativeProtocolSession` จาก `types.ts` มี `open(nativeId?)`, `turn(operationId,text)`, `idle`, `pendingApproval`, `close()`, `diagnostics()` (concrete Codex instance เท่านั้น) และ pure `projectCodexDiagnosticFrame(frame, {threadId?,turnId?})`

`policy.agent` ต้อง codex; cwd/home ต้อง normalized absolute paths; model/route ต้องมีค่า และ **Codex require modelProvider** เพื่อเทียบ expected provider จริง timeout1..300000ms Policyเป็น trusted host snapshot ไม่รับจาก HTTP/model และไม่ส่ง raw config/caller overrides

- openไม่มีID: initialize → initialized → thread/start
- openมีUUID: initialize → initialized → exact thread/resume ไม่มี fallback/fork/startใหม่
- fixed pilotprofile: thread/start/resume ส่ง approvalPolicy on-request, sandbox read-only, approvalsReviewer user และตรวจ responseเป็น on-request/readOnly/user ปฏิเสธworkspaceWrite/untrusted/never/fullaccess/networkaccess ไม่มี permission parity claim
- turnส่งเฉพาะ threadId + text UserInput แล้วรอ exact turn/completed notification สถานะ completed, errorว่าง, full items (หรือ hydrate full history หนึ่งครั้งจาก summary/notLoaded) และไม่มี observed pending items/approval ไม่ถือturn/start ACKเป็นcompletion
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

## Terminal summary และ bounded full-history hydration

8 พ.ย. 69 exact 0.164.0 `TurnItemsView` มี full/summary/notLoaded และ upstream `bespoke_event_handling.rs:1344–1360` ส่ง terminal summary ที่มี last agent message หรือ notLoaded ถ้าไม่มี message จึงไม่ถือ terminal display payload ว่าเป็น full history

หลัง exact terminal completed และ turn/start ACK แล้ว ถ้าเป็น summary/notLoaded ให้ส่ง read-only `thread/read {threadId,includeTurns:true}` ครั้งเดียวต่อ turn ภายใต้ timeout เดิม ไม่มี turn resend/pagination fallback Native thread ต้อง UUID/cwd/model/provider เดิม ไม่ ephemeral/fork มี idle status และต้องพบ exact turn เพียงหนึ่งรายการ สถานะ completed/error ว่าง พร้อม `itemsView:full` ตรวจไม่เกิน10000 turns/10000 target items, unique item IDs, observed items ห้ามหาย และ public final ที่เคยเห็นห้ามเปลี่ยน ก่อนใช้ tool/final guards เดิม

เก็บ terminal snapshot แรก immutable ระหว่าง await: duplicate เหมือนเดิมไม่ hydrate ซ้ำ; conflicting duplicate หรือ turn/started ใหม่ reject ก่อนเขียนทับ snapshot ไม่ clear observed pending item/approval เพื่อให้ hydration ผ่าน และตรวจซ้ำหลัง await Full history ที่ยัง partial/ผิด scope/ผิด identity/failed tool/timeout/disconnect ทำ uncertain และ poison instance ไม่มี automatic retry Read เป็น full-history API ที่ upstream ระบุ deprecated สำหรับ paginated history: กรณีไม่ให้ full evidence ให้ fail closed ไม่มีการเดาว่า partial stream ครบ ขอบเขตจำนวนนี้ตรวจหลัง JSON parse; byte/frame bound เป็นความรับผิดชอบ transport เดิม ไม่ใช่ streaming memory cap ใหม่

Root run1794153097021 มี terminal notification แต่ปฏิเสธ และ native history มี exact task_complete ตาม Root ผู้เขียนอ่าน native เฉพาะ metadata type/phase/exact turn ไม่ dump content Safe wire trace เดิมไม่มี nested itemsView จึงยังไม่อ้างค่าของ live frame นั้นอย่างยืนยัน Patch อิง exact pinned upstream shape + generated schemas; ต้อง Root ทดสอบ native ใหม่เองด้วย fresh operation

## Hydration deprecation notice

8 พ.ย. 69 Root run1794153581156 ยืนยัน terminal statuscompleted/itemsViewsummary/items1 แล้ว thread/read ส่ง `deprecationNotice` ก่อน response Saved exact-pin `v2/DeprecationNoticeNotification.json` required summary:string และ optional details:string|null ไม่มี thread/turn/permission fields

รับ informational notice ได้เฉพาะสอง window: (1) active turn กำลัง hydrate และยังมี pending thread/read RPC สูงสุดหนึ่งครั้งต่อturn (2) opening หลัง initialize response, ไม่มี identity/active turn, มี expectedNativeId และ pending exact thread/resume RPC สูงสุดหนึ่งครั้งต่อopen แยก budgetกัน Fresh thread/start ไม่อยู่ใน window Summary ต้องไม่ว่าง จำกัด4096 UTF-8 bytes; details จำกัด8192 bytes; NUL/typeผิด/unknownkeys reject ไม่เก็บ/แสดง/log notice body ไม่ reset timer ไม่ grant ready/approval/completion ไม่มี blanket unknown-ignore นอกช่วงนี้หรือ notice ซ้ำ failclosed การอ่าน full evidenceและterminal/pending/identityguardsยังเหมือนเดิม ไม่เปลี่ยนไปใช้ paginated API ในpatchนี้

## Intermediate native retry errors

8 พ.ย. 69 `error` notification exact0.164 required error/threadId/turnId/willRetry:boolean Native source `bespoke_event_handling.rs:1068–1084` ส่ง willRetry true สำหรับ StreamError โดยไม่update terminalsummary ส่วน :1636–1650 ส่งfalseพร้อมบันทึกturnerror

รับ true เฉพาะ active turn ที่มี bound UUID และ thread/turn ตรง ยังไม่พบterminal Limit8 notificationsต่อturn Closed envelope/error keys ตรวจ TurnError messageและoptionalfieldsตามschema รวมmisalignment/steerที่ไม่ทำตามข้อความเอง ข้อความแต่ละfieldที่ตรวจจำกัด8192 UTF8bytes/noNUL และerrorJSONรวม<=16384bytes codexErrorInfo รองรับstring/objectตามschemaextension ไม่ใช้ค่าclassหรือrawmessageเป็นapproval/สิทธิ์ ไม่retain/log body

Intermediateหมายถึงnativeกำลังretryเดิม ไม่ใช่mawส่งซ้ำ: ไม่write wire ไม่resettimer/deadline ไม่clearpendingitems/approval ไม่idle ไม่grantcompletion False/malformed/foreign/unbound/opening/afterterminal/เกินlimitยังpoisonuncertain ต้อง exactterminalcompleted/errornull/fullhistory+tools/approvalguardsเดิมครบจึงสำเร็จ Nativefailure/modelreroute/disconnect/timeoutภายหลังยังไม่ผ่าน

Root run1794153986102 safe traceเดิมไม่มีactualwillRetry value จึงไม่อ้างpatchแก้rootcauseของrunนั้น Rootเพิ่มsafeprojectionสำหรับfuturefreshoperationเอง ไม่มีnative/replayในงานนี้

## Pure safe telemetry และ current-turn scope

8 พ.ย. 69 `projectCodexDiagnosticFrame(frame, expected?)` เป็น pure projection ไม่มีI/O/write/inputmutation คืนเฉพาะknownmethod/keynames+unknowncount, thread/turn equalitycategories absent/null/unbound/matches/foreign, willRetry absent/true/false/invalid, fixederrorclassificationจากcodexErrorInfo, nestedterminal/systemError status, itemsView enums Unknownextension/string/object/fieldsไม่ถูกecho; structuredclassต้องrecognizedkeyหนึ่งอันและvalid bounded HTTPstatus shape หรือ known turnKindก่อน classify ไม่คืนHTTPstatusvalue/rawmessage/headers/body/token/UUID

`diagnostics()` เพิ่ม timeout none/turn/rpc จากknownfailurecode, cloned lastError/lastTerminal observations แยกจากlastFrameเพื่อไม่ถูกpassiveframeทับ lastTerminalครอบterminalnotificationและsystemError observation **ไม่ใช่proofว่าcompleted/accepted** ค่าforeign/unboundและmalformedframeยังรายงานเป็นobservationได้ แต่guardเดิมยังreject ไม่ใช้telemetryเป็นauthority

เมื่อadmitturnใหม่หลังvalidation/replaychecks ก่อนturn/start ให้resetเฉพาะlastError/lastTerminal/lastFrame ไม่clearpending/approval/nativeworkstate Invalid/replayedrequestไม่resetหลักฐาน ข้อมูลเป็นcurrentturnเท่านั้น ไม่ใช่sessionhistoricalarchive ไม่มีlogเองและไม่มีการเก็บrequestID/header/rawpayloadหรือเปลี่ยนprovider/env/args

## Pinned notification diagnostic names และ unarchived lifecycle

8 พ.ย. 69 diagnosticMethods รู้จักครบ85 method enums จาก saved exact0.164 `ServerNotification.json` แบบstaticallowlist ไม่มีI/Oตอนimport ไม่ใช้รายการนี้เป็นguardallowlist Unknownmethodนอกpinยังmasked Unsupportedknownmethodแสดงชื่อenumได้แต่ยังpoisonตามเดิม ไม่มีblanketpass

รองรับเฉพาะ `thread/unarchived` informational shape `{threadId:string}` closedkeys/validUUID ต้องตรงverifiedidentity หรือ pendingexactthread/resumeที่ผ่านinitializeresponseและมีexpectedNativeId ไม่สร้างidentityจากeventเอง Fresh startupก่อนidentity/foreign/malformed/extrascopefields reject ระหว่างactiveturnไม่clearitems/approval ไม่grantready/completion ไม่ส่งwire Sourceปกติemitหลังunarchiveสำเร็จในthread_processor.rs806–818; ไม่ได้พิสูจน์ว่าทุกresume/firstturnต้องemit Closed/deleted/reverted/archived/queuechanged/goalcleared/unknownยังfailclosed

Rootแก้ข้อมูลrun1794156282776แล้ว: resumeมีopenACKและturnclaimsuncertainสองระดับ/locks2 **phaseopenจากdiagnosticsหลังpoisonไม่ใช่หลักฐานว่ายังไม่ส่งuser** เพราะactiveถูกclearได้ ต้องดูexactnative/trace ไม่resendoldturnหรือclearoldlocks ผู้เขียนไม่native runนี้และไม่ฟันธงว่าunknownคือunarchivedจากkeysอย่างเดียว

## Tests

`NODE_ENV=test MAW_TEST_MODE=1 bun test test/mobile-protocol-codex.test.ts` ผล scoped lifecycle+diagnostics ล่าสุด232pass/0fail/800expects ผ่านin-memoryasyncwire ไม่ใช่app-serverจริง ไม่มีinference/agentlaunch/live

Fixturesใช้shapeจากschemaที่ทีม2generateด้วยpinnedbinary0.164.0 และมีoptionaltestตรวจactualgeneratedschemasในvault เมื่อartifactไม่มีจะskipschema-artifacttestหนึ่งเคส ไม่อ้างschema-artifactcoverageบนเครื่องที่ไม่มีไฟล์นั้น Validatorสำหรับfixturesครอบrequired/type/enum/refs/unions/arrayitems ไม่ใช่JSONSchemaengineเต็มรูปแบบ

รายงาน/commands/logs/hash ล่าสุด: `~/oracle/ψ/incubate/Soul-Brews-Studio/maw-js/plans/cross-provider-handoff/PROTOCOL-CODEX-LIFECYCLE-20261108.md`

Independent review ก่อน telemetry delta p4: `PROTOCOL-CODEX-HYDRATION-REVIEW.md` ปิด latest notice delta source5a28172/tests881c1271 ไม่มี new blocker ตามรายงาน p4; P1 immutable terminal/P2 optional model closure คงอยู่ การ review นั้นไม่ใช่ native acceptance willRetry delta8f304452/8ebf022f p4closedตาม `PROTOCOL-CODEX-TRANSIENT-ERROR-REVIEW.md` telemetrydelta401277c1/684f3187/d0a6a72f p4closedตาม `PROTOCOL-CODEX-OBSERVED-REVIEW.md` ส่วน lifecycledelta232testsนี้ส่งreviewใหม่ ไม่อ้างclosureเก่าครอบdeltaใหม่

## ประวัติ

| วันที่ | ผู้ทำ | รายการ |
|---|---|---|
| 8 พ.ย. 69 | Codex ensure | เพิ่ม diagnosticknownnotifications85enums และ strict scoped informational unarchived พร้อม232DItests |
| 8 พ.ย. 69 | Codex ensure | เพิ่ม pure safe error/terminal/systemError/timeout telemetry และresetcurrentturn snapshots พร้อม212DItests/negativeleakage/exactscope |
| 8 พ.ย. 69 | Codex ensure | รองรับ scoped bounded native willRetry true โดยไม่resetdeadline/clear pending/resend พร้อม189DItests |
| 8 พ.ย. 69 | Codex ensure | จำกัด deprecationNotice เพิ่มเฉพาะ pending exact resume พร้อม outside-window/duplicate/scope/wrong-response negatives 153 tests |
| 8 พ.ย. 69 | Codex ensure | รองรับ bounded exact-pin informational deprecationNotice เฉพาะ pending hydration read พร้อม negative tests |
| 8 พ.ย. 69 | Codex ensure | รองรับ terminal summary ด้วย read-only full-history hydration ครั้งเดียว พร้อม negative tests; ไม่ resend turn |
| 8 พ.ย. 69 | Codex ensure | เพิ่ม scoped MCP lifecycle และ value-free diagnostics พร้อม scope/error/unknown/no-readiness negatives 98 focused tests |
| 8 พ.ย. 69 | Codex ensure | เพิ่ม exact-pin passive remote-control startup status พร้อม malformed/scope/unknown/no-ready negatives |
| 8 พ.ย. 69 | Codex ensure | DI Codexprotocolpilot read-only-ask, exactnativecompletion/approvals/no-replayในinstance และ55focusedtests ไม่เปิดlive |

### Followup toolHome freeze

8 พ.ย. 69 เพิ่มmatched/wrong-homeทั้งfresh/resumeและinvalidtoolHometests ผล55pass Targetedtscผ่าน ไม่มีspawn/live ดูhashชุดล่าสุดในPROTOCOL-CODEX.md
