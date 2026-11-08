# Prepared entry opt-in boundary

วันที่ 8 พ.ย. 69 · มี trusted host loader/policy แล้ว; ยังไม่มี global activation หรือ live transport ที่รับรอง

## หน้าที่และไฟล์

- `prepared-entry.ts`: รับ trusted release directory/digest กับ module contract ที่ host ส่งให้ ตรวจ canonical result จาก `verifyEntry` แล้วคืน executable/args/env เท่านั้น ไม่มี import ตาม path, spawn หรืออ่าน credentials
- `tmux-entry.ts`: สร้าง command builder ให้ `features/autostart.ts::mount({commandFor})` หรือ `ensure(list, tmux, builder)`; policy callback ต้องสร้าง args จาก trusted resume/model/permission policy เอง ไม่ส่ง raw argv จาก API

## วิธีเปิด-ปิด

ค่าเริ่มต้นไม่มี dependency นี้ จึงใช้ flow เดิม การเปิดต้องเพิ่ม host configuration/wiring และผ่าน live gates ก่อน ไม่มี toggle บน UI ไม่รับ release path หรือ digest จาก request body

Continuity ใช้ `LauncherProfile.boundary='prepared-host'` พร้อม `prepared:{directory,manifestSha256}` และ `AdapterOptions.preparedEntry` (resolveEntry/verifyEntry จาก trusted candidate module) ตัว builder สร้าง native args ตาม exact resume/model/read-only policy ก่อนตรวจ canonical args ซ้ำ ไม่ส่ง HOME/CODEX_HOME override ใน prepared mode

Herdr ใช้ optional `createLifecycleHost({launchAgent})` ส่งต่อเข้า lifecycle ภายใน start journal เดิม; callback ได้ operationId/stepId/member/binding/cwd/nativeArgs/conversation โดยเป็นสำเนา ต้องใช้ preparedCommand กับ nativeArgs และ transport ที่ตรวจแล้ว คืน acknowledged เฉพาะการส่งสำเร็จ ไม่ปลอม agent_started; lifecycle ยังตรวจชื่อ/kind/generation/native session และ bootstrap ต่อจาก snapshot จริง

## ขอบเขตความเชื่อถือ

Module และ policy เป็น trusted host dependencies ผู้เรียกต้องโหลดจาก snapshot ที่ตรวจแล้วด้วย runtime ที่รองรับ (candidate03 ใช้ pinned Node ตาม manifest); loader รับเฉพาะ trusted host config ไม่อนุญาต import module path จาก browser

`verifyEntry` ไม่ seal args จึงตรวจ canonical args เทียบกับ args ที่ caller อนุมัติไว้ก่อนเรียก dependency พร้อม directory/digest/tool/route/executable/env/capabilities env ว่างคือไม่มี overlay คง environment ของ caller และ installed host

`executionLaunchesAgent:true` หมายถึง execute เปิด agent จริง ห้าม execute เพื่อ readiness check. Candidate03 ต้อง nestedLaunch:false; candidate04 คง nestedLaunch:false เพราะ entry depth0..7/child+1 ไม่รับรอง native nested และไม่ล้าง CLAUDECODE; candidate03 ยังคง immutable

## ข้อจำกัด

- `herdr agent start --help` บน Mac มี --kind/--pane/--timeout และ native args แต่ไม่มี executable override; ยังไม่มี concrete prepared Herdr transport
- tmux opt-in verification ล้มเหลวจะไม่สร้าง session ในรอบนั้น ไม่ fallback native; ensure ยังใช้ผลลัพธ์ started[] เดิม จึงไม่มี error UI ใหม่ในรอบนี้
- เส้น prepared opt-in ไม่มี `resume || new`; trusted callback ต้องเลือก fresh/exact resume อย่างชัดเจน ค่า legacy ที่ไม่ได้ opt-in คงเดิม
- ต้องผ่าน real TTY/signals/native identity/resume/host-account/readonly-to-interactive และ live acceptance ทั้งสาม backend ก่อนเปิด continuity

## ทดสอบ

`NODE_ENV=test MAW_TEST_MODE=1 bun test test/mobile-prepared-entry.test.ts test/mobile-autostart.test.ts test/mobile-continuity-adapters.test.ts test/mobile-herdr-lifecycle.test.ts`

เป็น fixtures/injected transport และ temporary SQLite ไม่มี agent launch จริง

## ประวัติ

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม 1 | เพิ่ม canonical descriptor validation, tmux builder และ opt-in seams; คง production ปิด |


## Trusted host loader/policy — candidate04 · 8 พ.ย. 69

`host-loader.ts::loadTrustedEntry({enabled:false})` คืน undefined โดยไม่อ่านไฟล์/รัน process. เมื่อ explicit opt-in จาก host รับ release directory+manifestSha256, route และ rooms policy; ยังไม่มีการเรียก loader จาก default production composition หรือ API

ก่อนโหลด module ตรวจ manifest digest ที่ pin, required inventory/modes, canonical paths, file hashes และ pinned Node/native/host binaries. ทุก resolve/verify ตรวจซ้ำแล้วเรียก pinned Node แบบ one-off ด้วย static bridge ผ่าน stdin โหลด snapshot module เท่านั้น ไม่รัน launch/* หรือ agent. ไม่มี cache เพื่อไม่ข้าม drift check; การ hash binaries ทั้งชุดมีต้นทุน ต้องวัด latency ก่อนใช้ live

Policy room ผูก session/cwd/agent; start ต้องระบุ fresh หรือ resume exact UUID ชัดเจน พร้อม permission ask/bypass และ model ถ้าต้องการ. ไม่มี --last/--continue/fallback. room ที่ไม่ได้กำหนดหรือ binding ไม่ตรงถูกปฏิเสธ; shell ไม่มี native launch. ค่า skipPermissions ของห้องต้องตรง policy สำหรับ Claude

ผล loader ใช้ `commandFor` ต่อ autostart seam หรือ `contract` ต่อ continuity `preparedEntry` จาก host ได้ แต่รอบนี้ยังไม่ติดตั้ง host config หรือเปิดใช้ ค่า release อยู่ในรายงานไม่ hardcode เข้า runtime

Verifier child คง environment รวม CLAUDECODE/host metadata ลบเฉพาะ NODE_OPTIONS/NODE_PATH เพื่อไม่ให้ inject module ก่อน verifier. Native command ไม่เปลี่ยน environment และไม่ bypass native guards. Hash pin ไม่ใช่ signature/atomic filesystem lock; ขอบเขตความเชื่อถือยังเป็น trusted host files

Claude ask แก้เป็น `--permission-mode default` ทั้ง host policy, continuity และ lifecycle จาก static enum ใน native snapshot04; ไม่อ้างว่าทดสอบ parser/inference แล้ว. Read-only handoff ยังคง tools/MCP restriction เดิม

ตรวจ snapshot04 จริงด้วย loader ครบ Claude/Codex × Mind/Direct ผ่าน pinned Node แบบ read-only; native --version ไม่ได้รันโดยทีม 1 รอบนี้

| วันที่ | ใคร | แก้อะไร |
|---|---|---|
| 8 พ.ย. 69 | Codex ทีม 1 | เพิ่ม trusted loader/room policy, ตรวจ candidate04 และแก้ Claude permission default ตาม review ทีม 2 |
