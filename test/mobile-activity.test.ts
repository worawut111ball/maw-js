import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ClaudeActivity, CodexActivity, claudeFile, notificationsIn, parseClaudeActivity, parseCodexActivity, readLinesFrom, tailLines } from "../src/mobile/features/activity";

// ── fixtures shaped like real Claude Code transcript lines (ids/paths shortened) ──
const T0 = Date.parse("2026-10-22T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const J = (o: unknown) => JSON.stringify(o);
const asst = (min: number, ...blocks: unknown[]) => J({ type: "assistant", timestamp: at(min), sessionId: "s1", message: { role: "assistant", content: blocks } });
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const result = (min: number, id: string, content: unknown, toolUseResult?: unknown, is_error = false) =>
  J({ type: "user", timestamp: at(min), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(is_error ? { is_error } : {}) }] }, ...(toolUseResult ? { toolUseResult } : {}) });
const userText = (min: number, text: string) => J({ type: "user", timestamp: at(min), message: { role: "user", content: text } });
const queued = (min: number, prompt: string) => J({ type: "attachment", timestamp: at(min), attachment: { type: "queued_command", prompt } });
const notif = (taskId: string, useId: string | null, status: string | null, summary: string, extra = "") =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n${useId ? `<tool-use-id>${useId}</tool-use-id>\n` : ""}<output-file>/private/tmp/claude-501/x/tasks/${taskId}.output</output-file>\n${status ? `<status>${status}</status>\n` : ""}<summary>${summary}</summary>\n${extra}</task-notification>`;

const bgBash = (min: number, id: string, bid: string, desc: string) => [
  asst(min, use(id, "Bash", { command: "sleep 300 && echo done", description: desc, run_in_background: true })),
  result(min, id, `Command running in background with ID: ${bid}. Output is being written to: /private/tmp/claude-501/x/tasks/${bid}.output. You will be notified when it completes.`,
    { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: bid }),
];
const bgAgent = (min: number, id: string, aid: string, desc: string) => [
  asst(min, use(id, "Agent", { subagent_type: "general-purpose", description: desc, run_in_background: true, prompt: "Read-only research…" })),
  result(min, id, [{ type: "text", text: `Async agent launched successfully.\nagentId: ${aid} (internal ID - do not mention to user.)` }],
    { isAsync: true, status: "async_launched", agentId: aid, description: desc }),
];
const monitor = (min: number, id: string, mid: string, desc: string, timeoutMs = 1_800_000) => [
  asst(min, use(id, "Monitor", { command: "./bin/z620-watch.sh", description: desc, timeout_ms: timeoutMs })),
  result(min, id, `Monitor started (task ${mid}, expires in 30m unless the source ends first). You will be notified on each event.`, { taskId: mid, timeoutMs, persistent: false }),
];

describe("TodoWrite", () => {
  test("latest list wins, statuses and activeForm kept", () => {
    const lines = [
      asst(0, use("toolu_t1", "TodoWrite", { todos: [{ content: "อ่านโค้ด", status: "in_progress", activeForm: "กำลังอ่านโค้ด" }, { content: "เขียนเทส", status: "pending", activeForm: "กำลังเขียนเทส" }] })),
      result(0, "toolu_t1", "Todos have been modified successfully."),
      asst(3, use("toolu_t2", "TodoWrite", { todos: [
        { content: "อ่านโค้ด", status: "completed", activeForm: "กำลังอ่านโค้ด" },
        { content: "เขียนเทส", status: "in_progress", activeForm: "กำลังเขียนเทส" },
        { content: "รันเทส", status: "pending", activeForm: "กำลังรันเทส" }] })),
    ];
    const a = parseClaudeActivity(lines, T0 + 5 * 60_000);
    expect(a.todos).toEqual([
      { content: "อ่านโค้ด", status: "completed", activeForm: "กำลังอ่านโค้ด" },
      { content: "เขียนเทส", status: "in_progress", activeForm: "กำลังเขียนเทส" },
      { content: "รันเทส", status: "pending", activeForm: "กำลังรันเทส" },
    ]);
    expect(a.running).toEqual([]);
  });

  test("an all-done list disappears after 30 min, an unfinished one stays", () => {
    const done = [asst(0, use("toolu_t", "TodoWrite", { todos: [{ content: "a", status: "completed", activeForm: "A" }] }))];
    expect(parseClaudeActivity(done, T0 + 10 * 60_000).todos).toHaveLength(1);
    expect(parseClaudeActivity(done, T0 + 31 * 60_000).todos).toHaveLength(0);
    const open = [asst(0, use("toolu_t", "TodoWrite", { todos: [{ content: "a", status: "pending", activeForm: "A" }] }))];
    expect(parseClaudeActivity(open, T0 + 300 * 60_000).todos).toHaveLength(1);
  });

  test("empty TodoWrite clears the list", () => {
    const lines = [asst(0, use("a", "TodoWrite", { todos: [{ content: "x", status: "pending" }] })), asst(1, use("b", "TodoWrite", { todos: [] }))];
    expect(parseClaudeActivity(lines, T0).todos).toEqual([]);
  });
});

describe("TaskCreate / TaskUpdate", () => {
  test("tasks get their id from the result and follow updates; deleted ones vanish", () => {
    const lines = [
      asst(0, use("toolu_c1", "TaskCreate", { subject: "WP19 Test Cases", description: "แตกกรณีทดสอบ", activeForm: "กำลังทำ WP19" })),
      result(0, "toolu_c1", "Task #10 created successfully: WP19 Test Cases", { task: { id: "10", subject: "WP19 Test Cases" } }),
      asst(1, use("toolu_c2", "TaskCreate", { subject: "WP20 Test Report", description: "รายงานผล", activeForm: "กำลังทำ WP20" })),
      result(1, "toolu_c2", "Task #11 created successfully: WP20 Test Report"),   // no toolUseResult → parse text
      asst(1, use("toolu_c3", "TaskCreate", { subject: "ทิ้ง", activeForm: "x" })),
      result(1, "toolu_c3", "Task #12 created successfully: ทิ้ง", { task: { id: "12", subject: "ทิ้ง" } }),
      asst(2, use("toolu_u1", "TaskUpdate", { taskId: "10", status: "completed" })),
      result(2, "toolu_u1", "Updated task #10 status", { success: true, taskId: "10", updatedFields: ["status"], statusChange: { from: "pending", to: "completed" } }),
      asst(3, use("toolu_u2", "TaskUpdate", { taskId: "11", status: "in_progress" })),
      asst(3, use("toolu_u3", "TaskUpdate", { taskId: "12", status: "deleted" })),
    ];
    expect(parseClaudeActivity(lines, T0 + 4 * 60_000).todos).toEqual([
      { content: "WP19 Test Cases", status: "completed", activeForm: "กำลังทำ WP19" },
      { content: "WP20 Test Report", status: "in_progress", activeForm: "กำลังทำ WP20" },
    ]);
  });

  test("whichever list was touched last is shown", () => {
    const lines = [
      asst(0, use("c", "TaskCreate", { subject: "task-list item" })), result(0, "c", "Task #1 created successfully: task-list item", { task: { id: "1" } }),
      asst(1, use("t", "TodoWrite", { todos: [{ content: "todo item", status: "in_progress", activeForm: "doing" }] })),
    ];
    expect(parseClaudeActivity(lines, T0).todos.map(t => t.content)).toEqual(["todo item"]);
  });
});

describe("background work", () => {
  test("background shell runs until its <task-notification> (user text) arrives", () => {
    const start = bgBash(0, "toolu_b1", "b6wpo21sg", "Full local docker build");
    let a = parseClaudeActivity(start, T0 + 2 * 60_000);
    expect(a.running).toEqual([{ kind: "shell", label: "Full local docker build", since: at(0), id: "b6wpo21sg" }]);
    const end = userText(4, notif("b6wpo21sg", "toolu_b1", "completed", 'Background command "Full local docker build" completed (exit code 0)'));
    a = parseClaudeActivity([...start, end], T0 + 5 * 60_000);
    expect(a.running).toEqual([]);
  });

  test("shell label falls back to the first line of the command", () => {
    const lines = [asst(0, use("toolu_x", "Bash", { command: "\n  npm run build\nnpm test", run_in_background: true }))];
    expect(parseClaudeActivity(lines, T0).running[0].label).toBe("npm run build");
  });

  test("a foreground Bash is never 'running'", () => {
    const lines = [asst(0, use("toolu_f", "Bash", { command: "ls", description: "List" }))];
    expect(parseClaudeActivity(lines, T0).running).toEqual([]);
  });

  test("async agent runs until a queued_command notification (completed / failed / killed)", () => {
    for (const st of ["completed", "failed", "killed"]) {
      const start = bgAgent(0, "toolu_a1", "aea6aeb481cf497a5", "Extract session timestamps");
      expect(parseClaudeActivity(start, T0).running).toEqual([{ kind: "agent", label: "Extract session timestamps", since: at(0), id: "aea6aeb481cf497a5" }]);
      const end = queued(9, notif("aea6aeb481cf497a5", "toolu_a1", st, 'Agent "Extract session timestamps" finished',
        "<note>A task-notification fires each time this agent stops.</note>\n<result>done</result>\n"));
      expect(parseClaudeActivity([...start, end], T0 + 10 * 60_000).running).toEqual([]);
    }
  });

  test("notification without tool-use-id is matched by task-id (agentId)", () => {
    const start = bgAgent(0, "toolu_a2", "a30cfa2ba0c089dde", "Review mockAuth guard commit");
    const end = userText(5, notif("a30cfa2ba0c089dde", null, "completed", 'Agent "Review mockAuth guard commit" finished'));
    expect(parseClaudeActivity([...start, end], T0 + 6 * 60_000).running).toEqual([]);
  });

  test("'previous session ended' notice listing many task-ids stops them all", () => {
    const lines = [...bgAgent(0, "toolu_p1", "a2e1d825e340cc30d", "Find OEE apps"), ...bgBash(0, "toolu_p2", "bphodf29t", "Watch logs"),
      userText(30, "<task-notification>\n<task-id>a2e1d825e340cc30d</task-id>\n<task-id>bphodf29t</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>2 background tasks didn't finish before the previous session ended</summary>\n</task-notification>")];
    expect(parseClaudeActivity(lines, T0 + 31 * 60_000).running).toEqual([]);
  });

  test("a foreground Agent is running until its result arrives", () => {
    const call = asst(0, use("toolu_g", "Agent", { subagent_type: "Explore", description: "Find the /locations page", prompt: "…" }));
    expect(parseClaudeActivity([call], T0 + 60_000).running.map(r => r.kind)).toEqual(["agent"]);
    const res = result(2, "toolu_g", [{ type: "text", text: "Found it in src/app/locations/page.tsx" }], { status: "completed", prompt: "…" });
    expect(parseClaudeActivity([call, res], T0 + 3 * 60_000).running).toEqual([]);
  });

  test("monitor: events don't end it, 'stream ended' / TaskStop / timeout do", () => {
    const start = monitor(0, "toolu_m1", "blsnyijab", "อาการผิดปกติของ z620");
    const event = queued(5, '<task-notification>\n<task-id>blsnyijab</task-id>\n<summary>Monitor event: "อาการผิดปกติของ z620"</summary>\n<event>11:21:41 ✅ ปกติ</event>\n</task-notification>');
    expect(parseClaudeActivity([...start, event], T0 + 6 * 60_000).running).toEqual([{ kind: "monitor", label: "อาการผิดปกติของ z620", since: at(0), id: "blsnyijab" }]);
    const ended = userText(8, notif("blsnyijab", "toolu_m1", "completed", 'Monitor "อาการผิดปกติของ z620" stream ended', "<event>vps online 0</event>\n"));
    expect(parseClaudeActivity([...start, event, ended], T0 + 9 * 60_000).running).toEqual([]);
    const stop = [asst(7, use("toolu_s", "TaskStop", { task_id: "blsnyijab" })),
      result(7, "toolu_s", J({ message: "Successfully stopped task: blsnyijab", task_id: "blsnyijab", task_type: "local_bash" }))];
    expect(parseClaudeActivity([...start, ...stop], T0 + 9 * 60_000).running).toEqual([]);
    expect(parseClaudeActivity(start, T0 + 32 * 60_000).running).toEqual([]);   // 30 min timeout (+1 min grace) passed
  });

  test("TaskStop ends a background shell too", () => {
    const lines = [...bgBash(0, "toolu_k", "bzt21q6gg", "Codex review"), asst(1, use("toolu_s2", "TaskStop", { task_id: "bzt21q6gg" }))];
    expect(parseClaudeActivity(lines, T0 + 2 * 60_000).running).toEqual([]);
  });

  test("errors and launches that never got an id don't linger", () => {
    const lines = [asst(0, use("toolu_e", "Bash", { command: "x", run_in_background: true })), result(0, "toolu_e", "permission denied", undefined, true)];
    expect(parseClaudeActivity(lines, T0).running).toEqual([]);
  });

  test("ghosts older than 6 h are dropped", () => {
    const start = bgAgent(0, "toolu_old", "aold", "Old agent");
    expect(parseClaudeActivity(start, T0 + 5 * 3600_000).running).toHaveLength(1);
    expect(parseClaudeActivity(start, T0 + 7 * 3600_000).running).toHaveLength(0);
  });

  test("sub-agent (sidechain) lines and junk are ignored", () => {
    const side = J({ type: "assistant", isSidechain: true, timestamp: at(0), message: { content: [use("toolu_sc", "Bash", { command: "x", run_in_background: true })] } });
    expect(parseClaudeActivity([side, "not json", "", "{broken"], T0).running).toEqual([]);
  });
});

describe("notificationsIn", () => {
  test("only notices with a status close anything", () => {
    expect(notificationsIn(notif("b1", "toolu_1", "failed", "x"))).toEqual([{ ids: ["b1", "toolu_1"], status: "failed" }]);
    expect(notificationsIn("<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor event</summary>\n</task-notification>")).toEqual([]);
    expect(notificationsIn("<task-notification>\n<task-type>artifact-watch-lifecycle</task-type>\n<summary>Stopped watching</summary>\n</task-notification>")).toEqual([]);
  });
});

describe("Codex rollouts", () => {
  const cx = (iso: string, type: string, payload: unknown) => J({ timestamp: iso, type, payload });
  test("update_plan → todos; latest plan wins", () => {
    const lines = [
      cx(at(0), "response_item", { type: "function_call", name: "update_plan", call_id: "call_1", arguments: J({ plan: [{ step: "ตรวจ logic", status: "in_progress" }, { step: "สรุปสาเหตุ", status: "pending" }] }) }),
      cx(at(2), "response_item", { type: "function_call", name: "update_plan", call_id: "call_2", arguments: J({ explanation: "ต่อ", plan: [{ step: "ตรวจ logic", status: "completed" }, { step: "สรุปสาเหตุ", status: "in_progress" }] }) }),
    ];
    expect(parseCodexActivity(lines, T0 + 3 * 60_000).todos).toEqual([{ content: "ตรวจ logic", status: "completed" }, { content: "สรุปสาเหตุ", status: "in_progress" }]);
  });

  test("an exec call without output for ≥5 s is a running shell; output / task_complete ends it", () => {
    const call = cx(at(0), "response_item", { type: "function_call", name: "exec_command", call_id: "call_bf", arguments: J({ cmd: "bun test\nexit", max_output_tokens: 2000 }) });
    const custom = cx(at(0), "response_item", { type: "custom_tool_call", name: "exec", call_id: "call_wn", input: 'const r=await tools.exec_command({cmd:"pwd; rg --files",workdir:"/x"});text(r.output);\n' });
    expect(parseCodexActivity([call], T0 + 2_000).running).toEqual([]);
    const a = parseCodexActivity([call, custom], T0 + 60_000);
    expect(a.running.map(r => r.label)).toEqual(["bun test", "pwd; rg --files"]);
    const out = cx(at(1), "response_item", { type: "function_call_output", call_id: "call_bf", output: "Process exited with code 0" });
    expect(parseCodexActivity([call, custom, out], T0 + 90_000).running.map(r => r.id)).toEqual(["call_wn"]);
    const done = cx(at(2), "event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: "เสร็จ" });
    expect(parseCodexActivity([call, custom, done], T0 + 3 * 60_000).running).toEqual([]);
  });

  // ── shapes as Codex writes them (field names real, values synthetic) ──
  const fc = (min: number, call_id: string, name: string, args: unknown) => cx(at(min), "response_item", { type: "function_call", name, call_id, arguments: J(args) });
  const fco = (min: number, call_id: string, output: string) => cx(at(min), "response_item", { type: "function_call_output", call_id, output });
  const ctc = (min: number, call_id: string, input: string) => cx(at(min), "response_item", { type: "custom_tool_call", name: "exec", call_id, input });
  const ctco = (min: number, call_id: string, text: string) => cx(at(min), "response_item", { type: "custom_tool_call_output", call_id, output: [{ type: "input_text", text }] });
  const cmdDone = (min: number, pid: string, exit = 0) => cx(at(min), "event_msg", { type: "item_completed", thread_id: "th-main", turn_id: "t1",
    item: { type: "CommandExecution", id: "item_1", process_id: pid, command: ["/bin/zsh", "-lc", "x"], source: "unified_exec_startup", status: exit ? "failed" : "completed", exit_code: exit },
    started_at_ms: T0, completed_at_ms: T0 + min * 60_000 });
  const subAgent = (min: number, kind: string, path: string, thread: string) => cx(at(min), "event_msg", { type: "item_completed", thread_id: "th-main", turn_id: "t1",
    item: { type: "SubAgentActivity", id: "item_s", kind, agent_thread_id: thread, agent_path: path }, started_at_ms: T0 + min * 60_000, completed_at_ms: T0 + min * 60_000 });
  const taskDone = (min: number) => cx(at(min), "event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: "x" });

  test("exec_command that yields is a running session until item_completed for its process id — across task_complete", () => {
    const lines = [
      fc(0, "call_dev", "exec_command", { cmd: "bun run dev --port 3456 " + "x".repeat(120), yield_time_ms: 1000 }),
      fco(0, "call_dev", "Chunk ID: ab12cd\nWall time: 1.0012 seconds\nProcess running with session ID 51234\nOriginal token count: 9\nOutput:\nready\n"),
      taskDone(1),
    ];
    const a = parseCodexActivity(lines, T0 + 2 * 60_000);
    expect(a.running).toHaveLength(1);
    expect(a.running[0]).toMatchObject({ kind: "shell", id: "51234", since: at(0) });
    expect(a.running[0].label.startsWith("bun run dev --port 3456")).toBe(true);
    expect(a.running[0].label.length).toBeLessThanOrEqual(80);
    // a poll that still sees it running keeps the original label; the real end closes it
    const poll = [fc(2, "call_p", "write_stdin", { session_id: 51234, chars: "", yield_time_ms: 5000 }),
      fco(2, "call_p", "Chunk ID: ef\nWall time: 5.0 seconds\nProcess running with session ID 51234\nOutput:\n")];
    expect(parseCodexActivity([...lines, ...poll], T0 + 3 * 60_000).running.map(r => r.label)).toEqual([a.running[0].label]);
    expect(parseCodexActivity([...lines, ...poll, cmdDone(4, "51234")], T0 + 5 * 60_000).running).toEqual([]);
  });

  test("write_stdin that sees the process exit closes the session; a finished process is never reopened", () => {
    const start = [fc(0, "call_s", "exec_command", { cmd: "npm test" }), fco(0, "call_s", "Process running with session ID 777\nOutput:\n")];
    const exit = [fc(1, "call_w", "write_stdin", { session_id: 777, chars: "" }), fco(1, "call_w", "Chunk ID: 1\nWall time: 3 seconds\nProcess exited with code 0\nOutput:\nok\n")];
    expect(parseCodexActivity([...start, ...exit], T0 + 2 * 60_000).running).toEqual([]);
    // item_completed written before the result that names the session (code-mode race)
    const race = [ctc(0, "call_c", 'const r = await tools.exec_command({cmd:"sleep 2", yield_time_ms: 500}); text(JSON.stringify(r));'),
      cmdDone(0, "888"), ctco(0, "call_c", '{"chunk_id":"a","wall_time_seconds":0.5,"session_id":888,"original_token_count":0,"output":""}')];
    expect(parseCodexActivity(race, T0 + 60_000).running).toEqual([]);
  });

  test("code-mode exec: session_id in the script result opens a session named after its cmd; polling-only scripts don't rename it", () => {
    const lines = [
      ctc(0, "call_a", 'const r = await tools.exec_command({cmd:"python3 -m http.server 8000", workdir:"/x", yield_time_ms: 1000});\ntext(JSON.stringify(r));'),
      ctco(0, "call_a", '{"chunk_id":"a1","wall_time_seconds":1.0,"session_id":4242,"original_token_count":3,"output":"Serving"}'),
      ctc(1, "call_b", "const r = await tools.write_stdin({session_id: 4242, chars: \"\"});\ntext(JSON.stringify(r));"),
      ctco(1, "call_b", '{"chunk_id":"b1","wall_time_seconds":5.0,"session_id":4242,"original_token_count":0,"output":""}'),
    ];
    const a = parseCodexActivity(lines, T0 + 2 * 60_000);
    expect(a.running).toEqual([{ kind: "shell", label: "python3 -m http.server 8000", since: at(0), id: "4242" }]);
    // only a poll seen (start was before the tail): generic label, not the script text
    expect(parseCodexActivity(lines.slice(2), T0 + 2 * 60_000).running.map(r => r.label)).toEqual(["session 4242"]);
    // exit_code result = finished, nothing opened
    const fin = [ctc(0, "call_f", 'text(JSON.stringify(await tools.exec_command({cmd:"ls"})));'), ctco(0, "call_f", '{"chunk_id":"c","wall_time_seconds":0.1,"exit_code":0,"original_token_count":1,"output":"a"}')];
    expect(parseCodexActivity(fin, T0 + 60_000).running).toEqual([]);
  });

  test("code-mode cell still running until a wait on it stops saying so", () => {
    const lines = [ctc(0, "call_x", 'await tools.exec_command({cmd:"bun test", yield_time_ms: 60000});'), ctco(0, "call_x", "Script running with cell ID 7f3\n")];
    expect(parseCodexActivity(lines, T0 + 60_000).running).toEqual([{ kind: "shell", label: "bun test", since: at(0), id: "7f3" }]);
    const still = [fc(1, "call_w1", "wait", { cell_id: "7f3", yield_time_ms: 30000, max_tokens: 1000 }), fco(1, "call_w1", "Script running with cell ID 7f3\n")];
    expect(parseCodexActivity([...lines, ...still], T0 + 2 * 60_000).running.map(r => r.id)).toEqual(["7f3"]);
    const done = [fc(2, "call_w2", "wait", { cell_id: "7f3", yield_time_ms: 30000, max_tokens: 1000 }), fco(2, "call_w2", "Script completed\nWall time 70.1 seconds\n")];
    expect(parseCodexActivity([...lines, ...still, ...done], T0 + 3 * 60_000).running).toEqual([]);
  });

  test("sub-agents: spawn_agent + SubAgentActivity started → running (child thread id), completed ends, followup_task restarts, interrupt stops", () => {
    const spawn = [
      fc(0, "call_sp", "spawn_agent", { task_name: "oee_map", message: "อ่านโค้ด…" }),
      fco(0, "call_sp", J({ task_name: "/root/oee_map" })),
      subAgent(0, "started", "/root/oee_map", "019a0000-aaaa-7000-8000-000000000001"),
      fc(0, "call_sp2", "spawn_agent", { task_name: "care_check", message: "ตรวจ…" }),
      fco(0, "call_sp2", J({ task_name: "/root/care_check" })),
      taskDone(1),                                                   // parent turn ends — agents keep working
    ];
    const a = parseCodexActivity(spawn, T0 + 2 * 60_000);
    expect(a.running).toEqual([
      { kind: "agent", label: "oee_map", since: at(0), id: "019a0000-aaaa-7000-8000-000000000001" },
      { kind: "agent", label: "care_check", since: at(0), id: "/root/care_check" },
    ]);
    const end = [subAgent(3, "interacted", "/root/oee_map", "019a0000-aaaa-7000-8000-000000000001"), subAgent(4, "completed", "/root/oee_map", "019a0000-aaaa-7000-8000-000000000001"),
      fc(4, "call_i", "interrupt_agent", { target: "care_check" }), fco(4, "call_i", J({ previous_status: "running" }))];
    expect(parseCodexActivity([...spawn, ...end], T0 + 5 * 60_000).running).toEqual([]);
    const again = [fc(6, "call_fu", "followup_task", { target: "oee_map", message: "ต่อ" }), fco(6, "call_fu", "")];
    expect(parseCodexActivity([...spawn, ...end, ...again], T0 + 7 * 60_000).running)
      .toEqual([{ kind: "agent", label: "oee_map", since: at(6), id: "019a0000-aaaa-7000-8000-000000000001" }]);
  });

  test("a failed spawn shows nothing; incremental feeding matches one pass", () => {
    expect(parseCodexActivity([fc(0, "c", "spawn_agent", { task_name: "x", message: "y" }), fco(0, "c", "collab spawn failed: agent thread limit reached")], T0 + 60_000).running).toEqual([]);
    const all = [fc(0, "call_dev", "exec_command", { cmd: "bun run dev" }), fco(0, "call_dev", "Process running with session ID 1\n"),
      fc(0, "call_sp", "spawn_agent", { task_name: "a", message: "m" }), subAgent(0, "started", "/root/a", "th-a"), fco(0, "call_sp", J({ task_name: "/root/a" })), taskDone(1)];
    const inc = new CodexActivity();
    for (const l of all) inc.feed([l]);
    expect(inc.snapshot(T0 + 2 * 60_000)).toEqual(parseCodexActivity(all, T0 + 2 * 60_000));
    expect(inc.snapshot(T0 + 2 * 60_000).running.map(r => r.kind)).toEqual(["agent", "shell"]);
  });
});

describe("file reading", () => {
  const dir = mkdtempSync(join(tmpdir(), "maw-act-"));

  test("tailLines drops the partial first line; readLinesFrom resumes at the right byte, Thai-safe", () => {
    const f = join(dir, "t.jsonl");
    const lines = Array.from({ length: 50 }, (_, i) => J({ i, text: "ภาษาไทย ".repeat(i % 7) }));
    writeFileSync(f, lines.join("\n") + "\n");
    const tail = tailLines(f, 300);
    expect(tail.length).toBeGreaterThan(0);
    for (const l of tail) expect(() => JSON.parse(l)).not.toThrow();
    expect(JSON.parse(tail.at(-1)!).i).toBe(49);
    // first full read, then append a line in two halves (a write caught mid-line)
    const r1 = readLinesFrom(f, 0);
    expect(r1.lines).toHaveLength(50);
    const extra = J({ i: 50, text: "ต่อท้าย" });
    appendFileSync(f, extra.slice(0, 9));
    const r2 = readLinesFrom(f, r1.next);
    expect(r2.lines).toEqual([]);
    appendFileSync(f, extra.slice(9) + "\n");
    const r3 = readLinesFrom(f, r2.next);
    expect(r3.lines).toEqual([extra]);
  });

  test("incremental feeding gives the same answer as one pass", () => {
    const all = [...bgAgent(0, "toolu_i", "ainc", "Inc agent"), asst(1, use("t", "TodoWrite", { todos: [{ content: "x", status: "in_progress", activeForm: "X" }] })),
      ...bgBash(2, "toolu_j", "binc", "Build"), userText(3, notif("ainc", "toolu_i", "completed", "done"))];
    const inc = new ClaudeActivity();
    for (const l of all) inc.feed([l]);
    expect(inc.snapshot(T0 + 4 * 60_000)).toEqual(parseClaudeActivity(all, T0 + 4 * 60_000));
    expect(new CodexActivity().feed([]).snapshot()).toEqual({ todos: [], running: [] });
  });

  test("claudeFile finds <sid>.jsonl under any project dir and rejects odd ids", () => {
    const root = join(dir, "projects");
    const p = join(root, "-Users-ball-repo");
    require("fs").mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "6ae1c3f2-1111-2222-3333-444455556666.jsonl"), "");
    expect(claudeFile("6ae1c3f2-1111-2222-3333-444455556666", root)).toBe(join(p, "6ae1c3f2-1111-2222-3333-444455556666.jsonl"));
    expect(claudeFile("../../etc/passwd", root)).toBeNull();
    expect(claudeFile("deadbeef-0000", root)).toBeNull();
  });
});

describe("route", () => {
  test("GET /rooms/:ws/:room/activity is mounted and rejects bad rooms", async () => {
    const { mount } = await import("../src/mobile/features/activity");
    const routes: Record<string, Function> = {};
    mount({ get: (path: string, h: Function) => { routes[path] = h; } });
    const h = routes["/rooms/:ws/:room/activity"];
    expect(typeof h).toBe("function");
    const set: any = {};
    expect(h({ params: { ws: "nope", room: "x" }, query: {}, set })).toEqual({ ok: false, error: "bad room" });
    expect(set.status).toBe(400);
    const r = h({ params: { ws: "tmux", room: "%999999" }, query: { agent: "claude", sid: "00000000-0000-0000-0000-000000000000" }, set: {} });
    expect(r).toEqual({ ok: true, todos: [], running: [] });
  });
});
