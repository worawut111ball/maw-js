import { execFileSync } from "child_process";
import { sendKeys, selectWindow, hostExec, getPaneCommand } from "../transport/ssh";
import { tmux } from "../transport/tmux";
import { buildCommand } from "../../config";
import type { MawWS, Handler, MawEngine } from "../types";

/** Run an async action with standard ok/error response */
async function runAction(ws: MawWS, action: string, target: string, fn: () => Promise<void>) {
  try {
    await fn();
    ws.send(JSON.stringify({ type: "action-ok", action, target }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
}

// --- Handlers ---

const subscribe: Handler = (ws, data, engine) => {
  ws.data.target = data.target;
  engine.pushCapture(ws);
};

const subscribePreviews: Handler = (ws, data, engine) => {
  ws.data.previewTargets = new Set(data.targets || []);
  engine.pushPreviews(ws);
};

const select: Handler = (_ws, data) => {
  selectWindow(data.target).catch(() => { /* expected: window may not exist */ });
};

/**
 * tmux reports the pane's foreground command, which can be the shell (`zsh`)
 * even while Claude Code runs as its child — that made every send to such a
 * pane fail with "no active Claude session". Look at the pane's process tree too.
 */
function paneHasAgentChild(target: string): boolean {
  try {
    const panePid = execFileSync("tmux", ["display-message", "-p", "-t", target, "#{pane_pid}"], { encoding: "utf-8", timeout: 1000 }).trim();
    const tree = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf-8", timeout: 2000 });
    const kids = new Map<string, { pid: string; comm: string }[]>();
    for (const line of tree.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (m) kids.set(m[2], [...(kids.get(m[2]) ?? []), { pid: m[1], comm: m[3] }]);
    }
    const queue = [panePid];
    for (let i = 0; i < queue.length && i < 200; i++) {
      for (const c of kids.get(queue[i]) ?? []) {
        if (/claude|codex/i.test(c.comm)) return true;
        queue.push(c.pid);
      }
    }
  } catch { /* tmux/ps unavailable — fall back to the foreground check */ }
  return false;
}

const send: Handler = async (ws, data, engine) => {
  // Check for active Claude session before sending (#17)
  if (!data.force) {
    try {
      const cmd = await getPaneCommand(data.target);
      if (!/claude|codex|node/i.test(cmd) && !paneHasAgentChild(data.target)) {
        ws.send(JSON.stringify({ type: "error", error: `no active Claude session in ${data.target} (running: ${cmd})` }));
        return;
      }
    } catch { /* pane check failed, proceed anyway */ }
  }
  sendKeys(data.target, data.text)
    .then(() => {
      ws.send(JSON.stringify({ type: "sent", ok: true, target: data.target, text: data.text }));
      setTimeout(() => engine.pushCapture(ws), 300);
    })
    .catch(e => ws.send(JSON.stringify({ type: "error", error: e.message })));
};

const sleep: Handler = (ws, data) => {
  runAction(ws, "sleep", data.target, () => sendKeys(data.target, "\x03"));
};

const stop: Handler = (ws, data) => {
  runAction(ws, "stop", data.target, () => tmux.killWindow(data.target));
};

const wake: Handler = (ws, data) => {
  // Use client command if provided, otherwise resolve from config
  const cmd = data.command || buildCommand(data.target?.split(":").pop() || "");
  runAction(ws, "wake", data.target, () => sendKeys(data.target, cmd + "\r"));
};

const restart: Handler = (ws, data) => {
  const cmd = data.command || buildCommand(data.target?.split(":").pop() || "");
  runAction(ws, "restart", data.target, async () => {
    await sendKeys(data.target, "\x03"); // Ctrl+C
    await new Promise(r => setTimeout(r, 2000));
    await sendKeys(data.target, "\x03"); // Ctrl+C again (in case first was caught)
    await new Promise(r => setTimeout(r, 500));
    await sendKeys(data.target, cmd + "\r");
  });
};

/** Register all built-in WebSocket handlers on the engine */
export function registerBuiltinHandlers(engine: MawEngine) {
  engine.on("subscribe", subscribe);
  engine.on("subscribe-previews", subscribePreviews);
  engine.on("select", select);
  engine.on("send", send);
  engine.on("sleep", sleep);
  engine.on("stop", stop);
  engine.on("wake", wake);
  engine.on("restart", restart);
}
