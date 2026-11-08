import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHerdrRuntime, HerdrError } from "../src/mobile/herdr/runtime";

const data = (n = "snapshot-team") => JSON.parse(readFileSync(join(import.meta.dir, "fixtures/herdr-provider", n + ".json"), "utf8"));
const dirs: string[] = [], runtimes: ReturnType<typeof createHerdrRuntime>[] = [];
afterEach(() => { for (const r of runtimes.splice(0)) r.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function file() { const d = mkdtempSync(join(tmpdir(), "herdr-provider-")); dirs.push(d); return join(d, "ledger.sqlite"); }
function setup(options: Record<string, any> = {}) {
  let snapshot = data(); let now = 1_000_000;
  const calls: string[][] = []; let failMutation = false, badAck = false;
  const runner = async (args: string[]) => {
    calls.push([...args]);
    expect(args.slice(0, 2)).toEqual(["--session", "default"]);
    const cmd = args.slice(2);
    if (cmd[0] === "api" && cmd[1] === "snapshot") return JSON.stringify(snapshot);
    if (cmd[0] === "pane" && cmd[1] === "process-info") return JSON.stringify({ id: "fixture-request", result: {
      type: "pane_process_info", process_info: { pane_id: cmd[cmd.indexOf("--pane") + 1], shell_pid: 100,
        foreground_process_group_id: 200, foreground_processes: [{ pid: 200, name: cmd[cmd.indexOf("--pane") + 1] === "w7:p2" ? "claude" : "codex", cwd: "/home/example/project" }] },
    } });
    if ((cmd[0] === "agent" || cmd[0] === "pane") && cmd[1] === "read") return "หน้าจอตัวอย่าง\n❯ ";
    if ((cmd[0] === "agent" && ["prompt", "send-keys"].includes(cmd[1])) || (cmd[0] === "pane" && cmd[1] === "send-text")) {
      expect(cmd).toHaveLength(4); // protocol22 TEXT is positional; no -- separator
      options.onMutation?.(cmd);
      if (failMutation) throw new Error("response lost after possible dispatch");
      if (badAck) return JSON.stringify({ id: "fixture-request", error: { code: "failed", message: "synthetic error" } });
      return JSON.stringify({ id: "fixture-request", result: cmd[1] === "prompt"
        ? { type: "agent_prompted", agent: snapshot.result.snapshot.agents.find((a: any) => a.pane_id === cmd[2]) }
        : { type: "ok" } });
    }
    throw new Error("unexpected runner operation: " + JSON.stringify(cmd));
  };
  const r = createHerdrRuntime({ runner, now: () => now, ledgerPath: file(), ...options }); runtimes.push(r);
  return { r, calls, runner, setSnapshot: (s: any) => { snapshot = s; }, advance: (ms: number) => { now += ms; }, fail: () => { failMutation = true; }, corruptAck: () => { badAck = true; },
    mutations: () => calls.filter(a => ["prompt", "send-keys", "send-text"].includes(a[3])) };
}
async function rejection(action: Promise<any>): Promise<string | undefined> {
  try { const result = await action; expect(result.state).toBe("definitely-rejected"); return result.code; }
  catch (e) { if (e instanceof HerdrError) return e.code; throw e; }
}
async function room(h: ReturnType<typeof setup>, id = "w7:p1") {
  await h.r.listProjects();
  const ch = h.r.resolve("herdr:w7", id);
  expect(ch).not.toBeNull(); return ch!;
}

describe("Herdr provider inventory, identity and read isolation", () => {
  test("cold resolve/import creates no CLI activity; explicit list returns all tabs", async () => {
    const h = setup(); expect(h.calls).toEqual([]);
    expect(h.r.resolve("herdr:w7", "w7:p1")).toBeNull();
    const projects = await h.r.listProjects();
    expect(projects[0].source).toBe("herdr");
    expect(projects.flatMap(p => p.workspaces).flatMap(w => w.rooms)).toHaveLength(4);
    expect(h.mutations()).toEqual([]);
  });
  test("workspace membership and provider/session scope cannot be fabricated by URL", async () => {
    const h = setup(); await room(h);
    for (const [ws, id] of [["herdr:w8", "w7:p1"], ["superset:w7", "w7:p1"], ["herdr:../../etc", "w7:p1"], ["herdr:w7", "w8:p1"], ["herdr:w7", "--help"]])
      expect(h.r.resolve(ws, id)).toBeNull();
    expect(h.mutations()).toEqual([]);
  });
  test("same cwd does not collapse native agent identity or equate working and done", async () => {
    const h = setup(); const ps = await h.r.listProjects(); const rooms = ps.flatMap(p => p.workspaces).flatMap(w => w.rooms);
    expect(rooms.map(r => r.status).sort()).toEqual(["done", "idle", "waiting", "working"]);
    expect(new Set(rooms.map(r => r.generation)).size).toBe(4);
  });
  test("terminal replacement invalidates the stale channel before any dispatch", async () => {
    const h = setup(); const ch = await room(h); h.setSnapshot(data("snapshot-replaced"));
    await h.r.refresh(); const next = h.r.resolve("herdr:w7", "w7:p1")!;
    expect(next.generation).not.toBe(ch.generation);
    expect(await rejection(h.r.dispatch(ch, { id: "stale-1", action: "prompt", expectedGeneration: ch.generation, text: "do not send" }))).toBe("room_changed");
    expect(h.mutations()).toEqual([]);
  });
  test("native conversation changes with the same terminal invalidate generation", async () => {
    const h = setup(); const ch = await room(h); const s = data();
    for (const row of [s.result.snapshot.panes[0], s.result.snapshot.agents[0]]) row.agent_session.value = "00000000-0000-4000-8000-000000000099";
    h.setSnapshot(s); await h.r.refresh();
    expect(h.r.resolve("herdr:w7", "w7:p1")!.generation).not.toBe(ch.generation);
    expect(h.mutations()).toEqual([]);
  });
  test("shells remain readable without prompt capability", async () => {
    const h = setup(); h.setSnapshot(data("snapshot-shells")); const ch = await room(h);
    expect(ch.capabilities.screen).toBe(true); expect(ch.capabilities.prompt).toBe(false);
    expect(await h.r.screen(ch, 8)).toContain("หน้าจอ");
    expect(h.mutations()).toEqual([]);
  });
  test("unsupported agent type remains visible and readable with no fabricated write capability", async () => {
    const h = setup(); h.setSnapshot(data("snapshot-other-agent")); const ch = await room(h);
    expect(ch.agent).toBe("example-agent"); expect(ch.capabilities.screen).toBe(true);
    for (const capability of ["prompt", "keys", "answer", "stop"] as const) expect(ch.capabilities[capability]).toBe(false);
    expect(await h.r.screen(ch, 8)).toContain("หน้าจอ");
    expect(await rejection(h.r.dispatch(ch, { id: "unsupported-agent", action: "prompt", text: "hello", expectedGeneration: ch.generation }))).toBe("agent_foreground_unverified");
    expect(h.mutations()).toEqual([]);
  });
  test("malformed/error inventory is not accepted as successful empty inventory", async () => {
    for (const output of ["not JSON", JSON.stringify(data("error-unavailable")), '{"id":"x","result":{"type":"session_snapshot","snapshot":{}}}']) {
      const h = setup({ runner: async () => output });
      await expect(h.r.refresh()).rejects.toThrow();
      expect(h.r.resolve("herdr:w7", "w7:p1")).toBeNull();
    }
  });
  test("screen polling uses visible text and no mutation/recent history", async () => {
    const h = setup(); const ch = await room(h);
    expect(await h.r.screen(ch, 12)).toContain("หน้าจอตัวอย่าง");
    const reads = h.calls.filter(a => a[3] === "read"); expect(reads.length).toBeGreaterThan(0);
    for (const args of reads) { expect(args).toContain("visible"); expect(args).not.toContain("recent"); expect(args).not.toContain("recent-unwrapped"); }
    expect(h.mutations()).toEqual([]);
  });
});

describe("Herdr durable dispatch safety via injected runner", () => {
  test("working prompt is sent once with literal multilingual argv and no extra Enter", async () => {
    const h = setup(); const ch = await room(h); const text = 'ข้อความไทย\n$HOME `command` "quote"; --literal';
    const result = await h.r.dispatch(ch, { id: "send-1", action: "prompt", expectedGeneration: ch.generation, text });
    expect(result.state).toBe("acknowledged"); expect(h.mutations()).toHaveLength(1);
    expect(h.mutations()[0]).toContain(text); expect(h.mutations()[0][3]).toBe("prompt");
  });
  test("retry of acknowledged ID does not repeat a side effect", async () => {
    const h = setup(); const ch = await room(h); const req = { id: "same-1", action: "prompt" as const, expectedGeneration: ch.generation, text: "hello" };
    await h.r.dispatch(ch, req); await h.r.dispatch(ch, req);
    expect(h.mutations()).toHaveLength(1);
  });
  test("same ID with changed payload is a conflict without a second dispatch", async () => {
    const h = setup(); const ch = await room(h);
    await h.r.dispatch(ch, { id: "conflict-1", action: "prompt", expectedGeneration: ch.generation, text: "first" });
    await expect(h.r.dispatch(ch, { id: "conflict-1", action: "prompt", expectedGeneration: ch.generation, text: "different" })).rejects.toThrow();
    expect(h.mutations()).toHaveLength(1);
  });
  test("lost acknowledgement remains uncertain and retry never sends again", async () => {
    const h = setup(); const ch = await room(h); h.fail();
    const req = { id: "uncertain-1", action: "prompt" as const, expectedGeneration: ch.generation, text: "hello" };
    expect((await h.r.dispatch(ch, req)).state).toBe("uncertain");
    expect((await h.r.dispatch(ch, req)).state).toBe("uncertain");
    expect(h.r.deliveryStatus(req.id, ch).state).toBe("uncertain");
    expect(h.mutations()).toHaveLength(1);
  });
  test("unknown delivery ID cannot be mistaken for safe never-dispatched", () => {
    const h = setup(); expect(h.r.deliveryStatus("never-observed").state).toBe("unknown"); expect(h.calls).toEqual([]);
  });
  test("overlapping retries result in one dispatch", async () => {
    const h = setup(); const ch = await room(h); const req = { id: "concurrent-1", action: "prompt" as const, expectedGeneration: ch.generation, text: "hello" };
    await Promise.all([h.r.dispatch(ch, req), h.r.dispatch(ch, req)]);
    expect(h.mutations()).toHaveLength(1);
  });
  test("blocked agent cannot receive normal prompt", async () => {
    const h = setup(); const ch = await room(h, "w7:p2");
    expect(await rejection(h.r.dispatch(ch, { id: "blocked-1", action: "prompt", expectedGeneration: ch.generation, text: "hello" }))).toBe("agent_blocked");
    expect(h.mutations()).toEqual([]);
  });
  test("offline with missing continuity or aged queue never auto-dispatches", async () => {
    for (const age of [0, 30 * 60_000 + 1]) {
      const h = setup(); const ch = await room(h);
      expect(await rejection(h.r.dispatch(ch, { id: "offline-" + age, action: "prompt", expectedGeneration: ch.generation, text: "hello", offline: true, createdAt: 1_000_000 - age }))).toBe(age ? "offline_message_stale" : "agent_continuity_unverified");
      expect(h.mutations()).toEqual([]);
    }
  });
  test("lifecycle tombstone guard blocks all input", async () => {
    const h = setup({ canDispatch: () => false }); const ch = await room(h);
    expect(await rejection(h.r.dispatch(ch, { id: "closed-1", action: "prompt", expectedGeneration: ch.generation, text: "hello" }))).toBe("room_closing");
    expect(h.mutations()).toEqual([]);
  });
  test("valid never-dispatched offline message sends only with current continuity", async () => {
    const h = setup(); const ch = await room(h); expect(ch.continuityToken).not.toBeNull();
    const result = await h.r.dispatch(ch, { id: "valid-offline", action: "prompt", text: "hello", expectedGeneration: ch.generation,
      offline: true, continuityToken: ch.continuityToken!, createdAt: 1_000_000 });
    expect(result.state).toBe("acknowledged"); expect(h.mutations()).toHaveLength(1);
  });
  test("uncertain message blocks subsequent offline auto-flush in the same room", async () => {
    const h = setup(); const ch = await room(h); h.fail();
    await h.r.dispatch(ch, { id: "first-lost", action: "prompt", text: "first", expectedGeneration: ch.generation });
    await expect(h.r.dispatch(ch, { id: "second-offline", action: "prompt", text: "second", expectedGeneration: ch.generation,
      offline: true, continuityToken: ch.continuityToken!, createdAt: 1_000_000 })).rejects.toThrow();
    expect(h.mutations()).toHaveLength(1);
  });
  test("client-forged capabilities cannot promote a shell to agent input", async () => {
    const h = setup(); h.setSnapshot(data("snapshot-shells")); const ch = await room(h);
    ch.capabilities.prompt = true; ch.capabilities.keys = true; ch.agent = "codex";
    const code = await rejection(h.r.dispatch(ch, { id: "forged-cap", action: "prompt", text: "hello", expectedGeneration: ch.generation }));
    expect(code).toBe("agent_foreground_unverified"); expect(h.mutations()).toEqual([]);
  });
  test("screen rejects invalid bounds and clamps oversized request without mutation", async () => {
    const h = setup(); const ch = await room(h);
    for (const n of [0, -1, NaN, Infinity]) await expect(h.r.screen(ch, n)).rejects.toThrow();
    await h.r.screen(ch, 999_999); const read = h.calls.filter(a => a[3] === "read").at(-1)!;
    expect(read[read.indexOf("--lines") + 1]).toBe("1500"); expect(h.mutations()).toEqual([]);
  });
  test("malformed mutation acknowledgement is uncertain, not successful, and cannot retry", async () => {
    const h = setup(); const ch = await room(h); h.corruptAck();
    const req = { id: "bad-ack-1", action: "prompt" as const, text: "hello", expectedGeneration: ch.generation };
    expect((await h.r.dispatch(ch, req)).state).toBe("uncertain");
    expect((await h.r.dispatch(ch, req)).state).toBe("uncertain"); expect(h.mutations()).toHaveLength(1);
  });
  test("dialog answer requires current token and submits only the selected option once", async () => {
    const dialog = { kind: "menu", question: "Choose a color", options: [{ n: 1, label: "Blue", free: false, sel: true }] };
    const h = setup({ parseDialog: () => dialog }); const ch = await room(h, "w7:p2"); const current = await h.r.dialog(ch);
    expect(current.dialogToken).toBeDefined();
    expect(await rejection(h.r.dispatch(ch, { id: "stale-dialog", action: "answer", n: 1, expectedGeneration: ch.generation, expectedDialogToken: "old-dialog" }))).toBe("dialog_changed");
    expect(h.mutations()).toEqual([]);
    const req = { id: "answer-one", action: "answer" as const, n: 1, expectedGeneration: ch.generation, expectedDialogToken: current.dialogToken };
    expect((await h.r.dispatch(ch, req)).state).toBe("acknowledged"); await h.r.dispatch(ch, req);
    expect(h.mutations()).toHaveLength(1); expect(h.mutations()[0].at(-1)).toBe("1");
  });
  test("free-text answer uses literal input and exactly one Enter, never agent prompt", async () => {
    const dialog = { kind: "menu", question: "Choose a color", options: [{ n: 2, label: "Type something.", free: true, sel: true }] };
    const h = setup({ parseDialog: () => dialog }); const ch = await room(h, "w7:p2"); const current = await h.r.dialog(ch);
    const result = await h.r.dispatch(ch, { id: "free-answer", action: "answer", n: 2, text: "สีเขียว", expectedGeneration: ch.generation, expectedDialogToken: current.dialogToken });
    expect(result.state).toBe("acknowledged"); expect(h.mutations().map(a => a[3])).toEqual(["send-text", "send-keys"]);
    expect(h.mutations()[0]).toContain("สีเขียว"); expect(h.mutations()[1].at(-1)).toBe("enter");
  });
  test("question changing after literal input prevents Enter and leaves uncertain delivery", async () => {
    let typed = false;
    const dialog = { kind: "menu", question: "Original", options: [{ n: 2, label: "Type something.", free: true, sel: true }] };
    const h = setup({ parseDialog: () => ({ ...dialog, question: typed ? "Another question" : "Original" }), onMutation: (cmd: string[]) => { if (cmd[0] === "pane" && cmd[1] === "send-text") typed = true; } });
    const ch = await room(h, "w7:p2"); const current = await h.r.dialog(ch);
    const result = await h.r.dispatch(ch, { id: "changed-during-answer", action: "answer", n: 2, text: "สีเขียว", expectedGeneration: ch.generation, expectedDialogToken: current.dialogToken });
    expect(result.state).toBe("uncertain"); expect(h.mutations().map(a => a[3])).toEqual(["send-text"]);
  });
  test("unknown key is rejected before CLI input", async () => {
    const h = setup(); const ch = await room(h);
    expect(await rejection(h.r.dispatch(ch, { id: "bad-key", action: "key", expectedGeneration: ch.generation, key: "shell-command" }))).toBe("unsupported_key");
    expect(h.mutations()).toEqual([]);
  });
});

test("verified launch-pending blocked agent permits guarded startup dialog but not normal prompt", async () => {
  const h = setup(); const s = data();
  s.result.snapshot.panes[0].agent_status = 'blocked';
  s.result.snapshot.agents[0].agent_status = 'blocked';
  s.result.snapshot.agents[0].launch_pending = true;
  h.setSnapshot(s); const ch = await room(h);
  expect(ch.capabilities.answer).toBe(true); expect(ch.capabilities.keys).toBe(true);
  expect(ch.capabilities.prompt).toBe(false); expect(ch.capabilities.stop).toBe(false);
  expect(await rejection(h.r.dispatch(ch, {id:'startup-normal-prompt', action:'prompt', expectedGeneration:ch.generation,text:'do not send'}))).toBe('agent_blocked');
  expect(h.mutations()).toHaveLength(0);
});
