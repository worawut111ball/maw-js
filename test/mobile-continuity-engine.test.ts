import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ContinuityStore } from "../src/mobile/continuity/store";
import { ContinuityEngine } from "../src/mobile/continuity/engine";
import type { Adapter, AgentKind, Backend, Binding, ContextDelivery, DeliveryReceipt, Inspection, Room, RoomEvent } from "../src/mobile/continuity/types";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const native = { codex: "00000000-0000-4000-8000-000000000001", claude: "00000000-0000-4000-8000-000000000002" };
const facts = async () => ({ goal: "ส่งมอบงานตัวอย่างแล้วรอผู้ใช้", constraints: ["ห้ามแก้ไฟล์เอง"], decisions: ["รักษา native session เดิม"], pendingTasks: ["รอผู้ใช้สั่งทำต่อ"], fileState: ["example.ts มีงานค้างที่ต้องรักษา"], checks: ["ยังไม่มี live acceptance"] });
function fixture(backend: Backend = "herdr", initial: AgentKind = "codex", cursors: {source?:number;target?:number} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "continuity-engine-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite"); const store = new ContinuityStore(path); cleanup.push(() => store.close());
  const first: Binding = { agent: initial, nativeId: native[initial], generation: backend + "-generation-1", route: "mind", cursor: 0 };
  const room: Room = { id: "room-" + backend, backend, workspace: "demo-workspace", room: "demo-pane", cwd: "/home/example/project", revision: 0, active: initial, bindings: { [initial]: first } };
  first.cursor=cursors.source??0;
  if(cursors.target!==undefined){const target=initial==='codex'?'claude':'codex';room.bindings[target]={agent:target,nativeId:native[target],generation:'prior-target',route:'mind',cursor:cursors.target};}
  store.register(room);
  let live = structuredClone(first), sequence = 1, checkpointReads = 0;
  let inspection: Omit<Inspection, "binding"> = { idle: true, pendingTools: false, pendingPermission: false, uncertainDelivery: false };
  const events: Omit<RoomEvent, "seq">[] = [{ sourceId: "original-message", agent: initial, nativeId: native[initial], role: "user", text: "งานตัวอย่างต้นฉบับ" }];
  const launches: { target: AgentKind; existing?: Binding; model?: string }[] = [], deliveries: { binding: Binding; context: ContextDelivery }[] = [];
  const behavior = { launchFails: false, missingSession: false, wrongLaunchId: false, receipt: "acknowledged" as DeliveryReceipt["state"], wrongReceipt: "", replaceDuringDelivery: false, generationOnlyReplacement: false, changeRouteDuringDelivery: false, historyChanges: false, checkpointThrows: false, preflight: true, inspectThrows: false, deliveryThrows: false };
  const adapter: Adapter = {
    async targetPolicy(_room,target,existing,model){return {agent:target,route:existing?.route??"mind",model:model??existing?.model};},
    async inspect() { if (behavior.inspectThrows) throw new Error("unavailable inspection"); return { binding: structuredClone(live), ...inspection }; },
    async preflight() { return { ready: behavior.preflight, reason: behavior.preflight ? undefined : "launcher_uncertified" }; },
    async checkpoint() {
      checkpointReads++; if (behavior.checkpointThrows) throw new Error("unavailable native history");
      if (behavior.historyChanges && checkpointReads === 2) events.push({ sourceId: "late-history", agent: live.agent, nativeId: live.nativeId, role: "user", text: "new turn arrived" });
      return structuredClone(events.filter(e => e.agent === live.agent && e.nativeId === live.nativeId));
    },
    async launch(_room, target, existing, model) {
      launches.push({ target, existing: existing && structuredClone(existing), model });
      if (behavior.launchFails || (behavior.missingSession && existing)) throw new Error("native_session_missing_or_launch_failed");
      live = { agent: target, nativeId: behavior.wrongLaunchId ? "unexpected-native-id" : existing?.nativeId ?? native[target], generation: backend + "-generation-" + (++sequence), route: existing?.route ?? "mind", cursor: existing?.cursor ?? 0, ...((model ?? existing?.model) ? { model: model ?? existing?.model } : {}) };
      return structuredClone(live);
    },
    async deliver(_room, binding, context) {
      deliveries.push({ binding: structuredClone(binding), context: structuredClone(context) });
      if (behavior.deliveryThrows) throw new Error("context response lost after possible side effect");
      if (behavior.changeRouteDuringDelivery) live = { ...live, route: "direct" };
      if (behavior.replaceDuringDelivery) live = { ...live, generation: "replacement-generation", ...(behavior.generationOnlyReplacement ? {} : { nativeId: "replacement-native-session" }) };
      return { state: behavior.receipt, nativeId: behavior.wrongReceipt === "nativeId" ? "wrong-id" : binding.nativeId,
        hash: behavior.wrongReceipt === "hash" ? "wrong-hash" : context.hash, throughSeq: behavior.wrongReceipt === "throughSeq" ? context.throughSeq + 1 : context.throughSeq };
    },
  };
  const unexpected: Adapter = { ...adapter, async preflight() { throw new Error("wrong backend adapter selected"); } };
  const adapters: Record<Backend, Adapter> = { herdr: unexpected, tmux: unexpected, superset: unexpected, [backend]: adapter };
  const options = { facts, archiveRoot: join(dir, "archive") };
  const engine = new ContinuityEngine(store, adapters, options);
  const request = async (target: AgentKind, id = "switch-" + target + "-" + (launches.length + 1), model?: string) => engine.request(room.id, { id, target, model, expectedRevision: store.room(room.id)!.revision });
  return { dir, path, store, room, engine, adapters, options, adapter, launches, deliveries, events, behavior, request,
    overrideLive: (value: Partial<Binding>) => { live = { ...live, ...value }; },
    setInspection: (value: Partial<typeof inspection>) => { inspection = { ...inspection, ...value }; },
    replaceSource: () => { live = { ...live, generation: "external-replacement" }; },
    addEvent: (text: string) => events.push({ sourceId: "native-event-" + events.length, agent: live.agent, nativeId: live.nativeId, role: "assistant", text }),
  };
}

describe("continuity engine cross-backend roundtrip integration via fixture adapters", () => {
  for (const backend of ["herdr", "tmux", "superset"] as const) {
    for (const initial of ["codex", "claude"] as const) {
      test(`${backend}: ${initial} A→B→A→B preserves exact native IDs, timeline and delta`, async () => {
        const h = fixture(backend, initial); const other = initial === "codex" ? "claude" : "codex";
        const targets: AgentKind[] = [other, initial, other];
        h.store.hold(h.room.id, { id: "held-one", text: "ห้ามส่งเองหลังสลับ", intendedGeneration: h.room.bindings[initial]!.generation });
        const delivered = new Map<AgentKind, number[]>();
        for (let i = 0; i < targets.length; i++) {
          const op = await h.request(targets[i], "roundtrip-" + i); const done = await h.engine.advance(op.id);
          expect(done.state).toBe("ready-awaiting-user");
          const current = h.store.room(h.room.id)!; expect(current.id).toBe(h.room.id); expect(current.active).toBe(targets[i]); expect(current.bindings[targets[i]]!.nativeId).toBe(native[targets[i]]);
          expect(current.bindings[targets[i]]!.cursor).toBe(done.checkpointSeq!);
          const payload = h.deliveries.at(-1)!.context; expect(payload.text).toContain("แล้วรอผู้ใช้สั่ง");
          const parsed = JSON.parse(payload.text.slice(payload.text.indexOf("\n") + 1));
          const seqs = parsed.events.map((e: any) => e.seq) as number[]; expect(new Set(seqs).size).toBe(seqs.length);
          const before = delivered.get(targets[i]) ?? []; expect(seqs.some(n => before.includes(n))).toBe(false); delivered.set(targets[i], [...before, ...seqs]);
          expect(readFileSync(parsed.retrieval.path, "utf8")).toContain("original-message");
          h.addEvent("งานระหว่างเปลี่ยนตัวครั้ง " + i);
        }
        expect(h.launches).toHaveLength(3); expect(h.launches[0].existing).toBeUndefined();
        expect(h.launches[1].existing!.nativeId).toBe(native[initial]); expect(h.launches[2].existing!.nativeId).toBe(native[other]);
        const all = h.store.events(h.room.id); expect(new Set(all.map(e => e.sourceId)).size).toBe(all.length);
        expect(h.store.held(h.room.id)).toHaveLength(1); expect(h.deliveries).toHaveLength(3);
      });
    }
  }
});

describe("continuity safe point, failures and verified receipts", () => {
  for (const pending of ["busy", "tools", "permission", "delivery"]) test(`${pending} waits without launch or context side effect`, async () => {
    const h = fixture(); h.setInspection(pending === "busy" ? { idle: false } : pending === "tools" ? { pendingTools: true } : pending === "permission" ? { pendingPermission: true } : { uncertainDelivery: true });
    const op = await h.request("claude"); expect((await h.engine.advance(op.id)).state).toBe("waiting-safe-point"); expect(h.launches).toEqual([]); expect(h.deliveries).toEqual([]);
    h.setInspection({ idle: true, pendingTools: false, pendingPermission: false, uncertainDelivery: false }); expect((await h.engine.advance(op.id)).state).toBe("ready-awaiting-user");
  });
  test("uncertified launcher blocks before any side effect", async () => {
    const h = fixture(); h.behavior.preflight = false; const op = await h.request("claude"); const result = await h.engine.advance(op.id);
    expect(result.state).toBe("blocked"); expect(result.reason).toBe("launcher_uncertified"); expect(h.launches).toEqual([]);
  });
  test("replacement of source identity blocks before launch", async () => {
    const h = fixture(); const op = await h.request("claude"); h.replaceSource(); const result = await h.engine.advance(op.id);
    expect(result.state).toBe("blocked"); expect(result.reason).toBe("agent_changed"); expect(h.launches).toEqual([]);
  });
  test("new history appearing during checkpoint blocks stale context delivery", async () => {
    const h = fixture(); h.behavior.historyChanges = true; const op = await h.request("claude"); const result = await h.engine.advance(op.id);
    expect(result.state).toBe("blocked"); expect(result.reason).toBe("history_changed_during_checkpoint"); expect(h.launches).toEqual([]); expect(h.deliveries).toEqual([]);
  });
  test("launch failure preserves source binding and does not blindly retry", async () => {
    const h = fixture(); h.behavior.launchFails = true; const initial = h.store.room(h.room.id)!; const op = await h.request("claude");
    const failed = await h.engine.advance(op.id); expect(failed.state).toBe("uncertain"); expect(h.store.room(h.room.id)!.active).toBe(initial.active); expect(h.store.room(h.room.id)!.bindings.codex).toEqual(initial.bindings.codex);
    await h.engine.advance(op.id); expect(h.launches).toHaveLength(1); expect(h.deliveries).toEqual([]);
  });
  test("missing previously bound native session does not silently create a new session", async () => {
    const h = fixture(); const a = await h.request("claude", "first-b"); await h.engine.advance(a.id);
    h.behavior.missingSession = true; const b = await h.request("codex", "return-a"); const failed = await h.engine.advance(b.id);
    expect(failed.state).toBe("uncertain"); expect(h.launches.at(-1)!.existing!.nativeId).toBe(native.codex); expect(h.store.room(h.room.id)!.active).toBe("claude"); expect(h.deliveries).toHaveLength(1);
  });
  test("resuming a known agent with an unexpected native ID never commits or sends context", async () => {
    const h = fixture(); const first = await h.request("claude", "before-wrong-resume"); await h.engine.advance(first.id);
    h.behavior.wrongLaunchId = true; const next = await h.request("codex", "wrong-native-resume"); const result = await h.engine.advance(next.id);
    expect(result.state).toBe("uncertain"); expect(result.reason).toBe("resume_identity_mismatch");
    expect(h.store.room(h.room.id)!.active).toBe("claude"); expect(h.store.room(h.room.id)!.bindings.codex!.nativeId).toBe(native.codex); expect(h.deliveries).toHaveLength(1);
  });
  for (const part of ["nativeId", "hash", "throughSeq"]) test(`wrong receipt ${part} cannot commit routing/cursor`, async () => {
    const h = fixture(); h.behavior.wrongReceipt = part; const initial = h.store.room(h.room.id)!; const op = await h.request("claude"); const result = await h.engine.advance(op.id);
    expect(result.state).toBe("uncertain"); expect(h.store.room(h.room.id)!.active).toBe(initial.active); expect(h.store.room(h.room.id)!.bindings.claude).toBeUndefined();
    await h.engine.advance(op.id); expect(h.deliveries).toHaveLength(1);
  });
  test("explicitly uncertain delivery is not retried after engine reload", async () => {
    const h = fixture(); h.behavior.receipt = "uncertain"; const op = await h.request("claude"); await h.engine.advance(op.id);
    const reloaded = new ContinuityEngine(h.store, h.adapters, h.options); expect((await reloaded.advance(op.id)).state).toBe("uncertain"); expect(h.deliveries).toHaveLength(1); expect(h.launches).toHaveLength(1);
  });
  test("exception after possible context dispatch is uncertain and never replayed", async () => {
    const h = fixture(); h.behavior.deliveryThrows = true; const op = await h.request("claude");
    expect((await h.engine.advance(op.id)).state).toBe("uncertain"); await h.engine.advance(op.id);
    expect(h.deliveries).toHaveLength(1); expect(h.store.room(h.room.id)!.active).toBe("codex");
  });
  test("checkpoint exception blocks before launch or delivery", async () => {
    const h = fixture(); h.behavior.checkpointThrows = true; const op = await h.request("claude");
    expect((await h.engine.advance(op.id)).state).toBe("blocked"); expect(h.launches).toEqual([]); expect(h.deliveries).toEqual([]);
  });
  test("missing inspection evidence blocks rather than assuming idle", async () => {
    const h = fixture(); h.behavior.inspectThrows = true; const op = await h.request("claude");
    expect((await h.engine.advance(op.id)).state).toBe("blocked"); expect(h.launches).toEqual([]);
  });
  test("context and archive include only the requested logical room", async () => {
    const h = fixture(); const other: Room = { ...h.room, id: "other-logical-room", room: "other-pane" }; h.store.register(other);
    h.store.append(other.id, [{ sourceId: "other-only", agent: "codex", nativeId: native.codex, role: "user", text: "OTHER_ROOM_ONLY" }]);
    const op = await h.request("claude"); expect((await h.engine.advance(op.id)).state).toBe("ready-awaiting-user");
    const text = h.deliveries[0].context.text; expect(text).not.toContain("OTHER_ROOM_ONLY");
    const payload = JSON.parse(text.slice(text.indexOf("\n") + 1)); expect(readFileSync(payload.retrieval.path, "utf8")).not.toContain("OTHER_ROOM_ONLY");
  });
  test("external connection-route drift is not accepted as the unchanged target binding", async () => {
    const h = fixture(); h.behavior.changeRouteDuringDelivery = true; const op = await h.request("claude");
    const result = await h.engine.advance(op.id); expect(result.state).toBe("uncertain"); expect(h.store.room(h.room.id)!.active).toBe("codex");
  });
  test("same native session with a replaced process generation cannot commit a stale receipt", async () => {
    const h = fixture(); h.behavior.replaceDuringDelivery = true; h.behavior.generationOnlyReplacement = true;
    const op = await h.request("claude"); const result = await h.engine.advance(op.id);
    expect(result.state).toBe("uncertain"); expect(h.store.room(h.room.id)!.active).toBe("codex");
  });
  test("target replaced during delivery cannot be committed from a stale matching receipt", async () => {
    const h = fixture(); h.behavior.replaceDuringDelivery = true; const op = await h.request("claude"); const result = await h.engine.advance(op.id);
    expect(result.state).toBe("uncertain"); expect(h.store.room(h.room.id)!.active).toBe("codex");
  });
});

describe("continuity operation journal/idempotency/concurrent calls", () => {
  test("same request returns existing operation; changed target/model conflicts", async () => {
    const h = fixture(); const first = await h.request("claude", "same-request");
    const retry = await h.engine.request(h.room.id, { id: first.id, target: "claude", expectedRevision: first.expectedRevision }); expect(retry.id).toBe(first.id);
    await expect(h.engine.request(h.room.id, { id: first.id, target: "claude", model: "different-model", expectedRevision: first.expectedRevision })).rejects.toThrow();
    await h.engine.advance(first.id); await h.engine.advance(first.id); expect(h.launches).toHaveLength(1); expect(h.deliveries).toHaveLength(1);
  });
  test("two different concurrent switch requests leave one active operation", async () => {
    const h = fixture(); const revision = h.store.room(h.room.id)!.revision;
    const result = await Promise.allSettled([h.engine.request(h.room.id, { id: "browser-one", target: "claude", expectedRevision: revision }), h.engine.request(h.room.id, { id: "browser-two", target: "claude", expectedRevision: revision })]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(h.launches).toEqual([]);
  });
  test("concurrent advance across two store/engine instances has one launch and delivery", async () => {
    const h = fixture(); const secondStore = new ContinuityStore(h.path); cleanup.push(() => secondStore.close()); const second = new ContinuityEngine(secondStore, h.adapters, h.options);
    const op = await h.request("claude"); await Promise.all([h.engine.advance(op.id), second.advance(op.id)]);
    expect(h.launches).toHaveLength(1); expect(h.deliveries).toHaveLength(1); expect(h.store.operation(op.id)!.state).toBe("ready-awaiting-user");
  });
  test("stale revision and new operation while uncertain cannot launch another target", async () => {
    const h = fixture(); h.behavior.receipt = "uncertain"; const op = await h.request("claude"); await h.engine.advance(op.id);
    await expect(h.engine.request(h.room.id, { id: "second-attempt", target: "claude", expectedRevision: h.store.room(h.room.id)!.revision })).rejects.toThrow();
    expect(h.launches).toHaveLength(1);
  });
  test("persisted preparing-target boundary is not relaunched by a new engine", async () => {
    const h = fixture(); const op = await h.request("claude"); h.store.saveOperation({ ...op, state: "checkpointed" }); h.store.saveOperation({ ...op, state: "preparing-target" });
    const fresh = new ContinuityEngine(h.store, h.adapters, h.options); const result = await fresh.advance(op.id);
    expect(["preparing-target", "uncertain"]).toContain(result.state); expect(h.launches).toEqual([]); expect(h.deliveries).toEqual([]);
  });
  test("explicit retry of a prelaunch blocked operation rechecks source and can proceed", async () => {
    const h = fixture(); h.behavior.preflight = false; const op = await h.request("claude");
    expect((await h.engine.advance(op.id)).state).toBe("blocked"); h.behavior.preflight = true;
    expect((await h.engine.retry(op.id)).state).toBe("ready-awaiting-user"); expect(h.launches).toHaveLength(1);
  });
  test("explicit safe cancellation releases room operation while preserving held messages", async () => {
    const h = fixture(); const op = await h.request("claude");
    h.store.hold(h.room.id, { id: "cancel-held", text: "keep this message", intendedGeneration: op.from.generation });
    const result = await h.engine.cancel(op.id, h.store.room(h.room.id)!.revision); expect(result.operationId).toBeUndefined(); expect(result.active).toBe("codex");
    expect(h.store.held(h.room.id)).toHaveLength(1); expect(h.launches).toEqual([]);
    expect((await h.request("claude", "after-cancel")).state).toBe("waiting-safe-point");
  });
  test("uncertain side effects cannot be cancelled or retried as safe prelaunch work", async () => {
    const h = fixture(); h.behavior.receipt = "uncertain"; const op = await h.request("claude"); await h.engine.advance(op.id);
    await expect(h.engine.retry(op.id)).rejects.toThrow("reconciliation_required");
    await expect(h.engine.cancel(op.id, h.store.room(h.room.id)!.revision)).rejects.toThrow("reconciliation_required");
    expect(h.launches).toHaveLength(1); expect(h.deliveries).toHaveLength(1);
  });
  test("missing project facts blocks context handoff instead of inventing requirements", async () => {
    const h = fixture(); const noFacts = new ContinuityEngine(h.store, h.adapters, { archiveRoot: join(h.dir, "archive-without-facts") }); const op = await noFacts.request(h.room.id, { id: "no-facts", target: "claude", expectedRevision: h.store.room(h.room.id)!.revision });
    const result = await noFacts.advance(op.id); expect(result.state).toBe("blocked"); expect(result.reason).toBe("context_facts_unavailable"); expect(h.launches).toEqual([]);
  });
});

describe('Facts checkpoint scope',()=>{
 test('resolver receives the same complete archive and cursor used by context',async()=>{
  const h=fixture();let captured:any;
  const engine=new ContinuityEngine(h.store,h.adapters,{...h.options,facts:async(r,s)=>{captured={r,s};return facts();}});
  const op=await h.request('claude');expect((await engine.advance(op.id)).state).toBe('ready-awaiting-user');
  const {createHash}=await import('node:crypto');
  expect(captured.s.archiveHash).toBe(createHash('sha256').update(readFileSync(captured.s.archivePath)).digest('hex'));
  expect(captured.s.events).toEqual(h.store.events(h.room.id));expect(captured.s.throughSeq).toBe(h.deliveries[0].context.throughSeq);
  expect(captured.s.roomRevision).toBe(0);expect(captured.s.sourceBinding).toEqual(h.room.bindings.codex);
 });
 test('resolver cannot mutate authoritative room or archived events through its arguments',async()=>{
  const h=fixture();const engine=new ContinuityEngine(h.store,h.adapters,{...h.options,facts:async(r,s)=>{
   r.cwd='/malicious';r.bindings.codex!.nativeId='wrong';s.events[0].text='rewritten';s.sourceBinding.nativeId='wrong';return facts();
  }});
  const op=await h.request('claude');expect((await engine.advance(op.id)).state).toBe('ready-awaiting-user');
  expect(h.store.room(h.room.id)?.cwd).toBe(h.room.cwd);expect(h.store.events(h.room.id)[0].text).toBe('งานตัวอย่างต้นฉบับ');
  expect(h.deliveries[0].context.text).not.toContain('rewritten');expect(h.deliveries[0].context.text).not.toContain('/malicious');
 });
});

for(const c of [{source:0,target:5,empty:true},{source:5,target:0,empty:true},{source:0,target:5,empty:false}])test(`missing history stops before resolver/launch ${JSON.stringify(c)}`,async()=>{
 const h=fixture('herdr','codex',c);if(c.empty)h.events.length=0;let factsCalls=0;
 const engine=new ContinuityEngine(h.store,h.adapters,{...h.options,facts:async()=>{factsCalls++;return facts();}});
 const op=await h.request('claude');expect(await engine.advance(op.id)).toMatchObject({state:'blocked',reason:'history_cursor_unavailable'});
 expect(factsCalls).toBe(0);expect(h.launches).toEqual([]);expect(h.deliveries).toEqual([]);expect(h.store.room(h.room.id)?.active).toBe('codex');
});

test('engine consumes only previously persisted explicit facts and preserves source provenance',async()=>{
 const {FactsSelectionStore,createFactsProvider}=await import('../src/mobile/continuity/facts-selection');
 const {factsBindingHash}=await import('../src/mobile/continuity/facts-resolver');
 const {ContinuityArchive}=await import('../src/mobile/continuity/archive');
 const {createHash}=await import('node:crypto');const h=fixture();
 h.events[0].text=JSON.stringify({kind:'continuity-facts',version:1,facts:{goal:'ตรวจข้อมูลที่เลือกไว้'}});
 h.store.append(h.room.id,h.events);const events=h.store.events(h.room.id);
 const archivePath=new ContinuityArchive(h.options.archiveRoot).snapshot(h.room.id,events),hash=(text:string)=>createHash('sha256').update(text).digest('hex');
 const snapshot={roomId:h.room.id,roomRevision:0,sourceBinding:h.room.bindings.codex!,throughSeq:1,archivePath,archiveHash:hash(readFileSync(archivePath,'utf8')),events};
 const selections=new FactsSelectionStore(join(h.dir,'facts'));
 selections.approve('explicit','host-user',snapshot,{version:1,roomId:h.room.id,roomRevision:0,archiveHash:snapshot.archiveHash,throughSeq:1,sourceBindingHash:factsBindingHash(snapshot.sourceBinding),selections:[{field:'goal',seq:1,sourceId:events[0].sourceId,agent:'codex',nativeId:native.codex,eventHash:hash(events[0].text)}]});
 const engine=new ContinuityEngine(h.store,h.adapters,{...h.options,facts:createFactsProvider(selections,async()=> 'explicit')});
 const op=await h.request('claude');expect((await engine.advance(op.id)).state).toBe('ready-awaiting-user');expect(h.deliveries[0].context.text).toContain('ตรวจข้อมูลที่เลือกไว้');expect(selections.read('explicit',snapshot).provenance[0].sourceId).toBe(events[0].sourceId);
});
test('engine blocks a missing trusted facts selection before launching any target',async()=>{
 const {FactsSelectionStore,createFactsProvider}=await import('../src/mobile/continuity/facts-selection');const h=fixture();
 const engine=new ContinuityEngine(h.store,h.adapters,{...h.options,facts:createFactsProvider(new FactsSelectionStore(join(h.dir,'facts')),async()=>null)});
 const op=await h.request('claude');expect(await engine.advance(op.id)).toMatchObject({state:'blocked',reason:'facts_selection_missing'});expect(h.launches).toEqual([]);expect(h.deliveries).toEqual([]);
});

describe('staged native context initialization',()=>{
 test('persists context intent before first user and accepts only observed binding and final receipt',async()=>{
  const h=fixture();let stagedCalls=0;
  const launch=h.adapter.launch.bind(h.adapter),deliver=h.adapter.deliver.bind(h.adapter);
  h.adapter.launchWithContext=async(room,target,context,existing,model)=>{
   stagedCalls++;
   const pending=h.store.operation(context.id)!;
   expect(pending.state).toBe('delivering-context');
   expect(pending.contextHash).toBe(context.hash);
   expect(pending.targetBinding).toBeUndefined();
   const binding=await launch(room,target,existing,model);
   return {binding,receipt:await deliver(room,binding,context)};
  };
  h.adapter.launch=async()=>{throw Error('must use staged boundary');};
  h.adapter.deliver=async()=>{throw Error('must not send first context twice');};
  const op=await h.request('claude','staged');
  expect((await h.engine.advance(op.id)).state).toBe('ready-awaiting-user');
  expect(h.store.room(h.room.id)?.active).toBe('claude');
  await h.engine.advance(op.id);expect(stagedCalls).toBe(1);expect(h.deliveries).toHaveLength(1);
 });
 test.each(['lost-result','wrong-receipt','wrong-resume'])('staged %s retains uncertain operation without another dispatch',async kind=>{
  const h=fixture('herdr','codex',{target:0});let calls=0;
  h.adapter.launchWithContext=async(room,target,context,existing,model)=>{
   calls++;
   if(kind==='lost-result')throw Error('first user may have arrived');
   const binding=await h.adapter.launch(room,target,existing,model);
   const receipt=await h.adapter.deliver(room,binding,context);
   if(kind==='wrong-receipt')receipt.hash='wrong';
   if(kind==='wrong-resume')binding.nativeId='foreign-native';
   return {binding,receipt};
  };
  const op=await h.request('claude','staged-'+kind);
  expect((await h.engine.advance(op.id)).state).toBe('uncertain');
  await h.engine.advance(op.id);expect(calls).toBe(1);
  expect(h.store.room(h.room.id)?.active).toBe('codex');
 });
});

test.each(['pendingTools','pendingPermission','uncertainDelivery'])('missing inspection flag %s cannot pass safe point',async field=>{
 const h=fixture();const inspect=h.adapter.inspect.bind(h.adapter);
 h.adapter.inspect=async r=>{const result:any=await inspect(r);delete result[field];return result;};
 const op=await h.request('claude','missing-'+field);expect((await h.engine.advance(op.id)).state).toBe('waiting-safe-point');expect(h.launches).toHaveLength(0);
});
test.each(['route','model'])('staged wrong intended %s cannot commit',async field=>{
 const h=fixture();
 h.adapter.launchWithContext=async(r,t,c,e,m)=>{const binding=await h.adapter.launch(r,t,e,m);(binding as any)[field]='wrong';h.overrideLive({[field]:'wrong'});return {binding,receipt:{state:'acknowledged',nativeId:binding.nativeId,hash:c.hash,throughSeq:c.throughSeq}};};
 const op=await h.request('claude','wrong-'+field);const result=await h.engine.advance(op.id);expect(result.state).toBe('uncertain');expect(result.reason).toBe('target_identity_unverified');expect(h.store.room(h.room.id)?.active).toBe('codex');
});
