import { continuityWriteFailure, createContinuityWriteAttempt, type ContinuityWriteGuard } from '../continuity/write-guard';
// Feature pack "modes" (P2) — permission mode chip, model / effort switch, compact, rewind.
// Routes (under /mobile, behind auth):
//   GET  /rooms/:ws/:room/mode?sid=&agent=   → { mode, model, modelId, effort, fast }
//   POST /rooms/:ws/:room/mode/cycle          → shift+tab once, re-read → { mode }
//   POST /rooms/:ws/:room/model  { model }    → types "/model <alias>"
//   POST /rooms/:ws/:room/effort { level }    → types "/effort <level>"
// Footer formats verified on real Claude Code 2.1.281 panes (tmux %0/%2 + Superset): "⏵⏵ bypass permissions on (shift+tab to cycle)",
// "⏵⏵ bypass permissions on · 1 shell". The other indicators come from Claude Code's mode table
// (symbol ⏸ for plan, ⏵⏵ otherwise; "<symbol> <indicator> on"); default ("manual mode") draws no indicator.
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readScreen, typeInto, pressKey, roomChannel, type ReplyChannel } from "./ctx";
import { agentSpinner } from "../api";

export type PermMode = "default" | "acceptEdits" | "plan" | "bypass" | "auto" | "dontAsk" | "unknown";

/** `/model` aliases Claude Code 2.1.x accepts (from its alias table). */
export const MODEL_ALIASES = ["default", "opus", "sonnet", "haiku", "fable", "opus[1m]", "sonnet[1m]", "fable[1m]", "opusplan"] as const;
/** `/effort` levels (Claude Code shows low|medium|high|xhigh|max — which ones a model takes varies — plus auto). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "auto"] as const;

const strip = (s: string) => s
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
  .replace(/\r/g, "");

const RULE = /^\s*[─━]{8,}/;
const PROMPT = /^❯(?:[\s\u00a0]|$)/; // the input box prompt sits in column 0; menu cursors (" ❯ 1. Yes") are indented
const INDICATOR = /^\s*(?:⏸|⏵⏵|⏵)\s+(plan mode|accept edits|bypass permissions|auto mode|don['’]t ask|manual mode) on\b/;
const MODE_OF: Record<string, PermMode> = {
  "plan mode": "plan", "accept edits": "acceptEdits", "bypass permissions": "bypass",
  "auto mode": "auto", "don't ask": "dontAsk", "don’t ask": "dontAsk", "manual mode": "default",
};

/** Lines under Claude's input box (status line + mode row), or null when no input box is on screen. */
export function footerLines(raw: string): string[] | null {
  const lines = strip(raw).split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
    if (!RULE.test(lines[i])) continue;
    // the bottom border of the input box has a "❯" prompt line just above it (multi-line drafts wrap)
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      if (RULE.test(lines[j])) break;
      if (PROMPT.test(lines[j])) return lines.slice(i + 1);
    }
    return null; // last rule isn't the input box (a dialog / menu is open)
  }
  return null;
}

/** Claude Code's permission mode, read only from the footer below the input box. */
export function parseMode(raw: string): PermMode {
  const lines = strip(raw).split("\n");
  const foot = footerLines(raw);
  for (const l of foot ?? lines.slice(-6)) {
    const m = INDICATOR.exec(l);
    if (m) return MODE_OF[m[1]] ?? "unknown";
  }
  return foot ? "default" : "unknown";
}

/** "effort:medium" drawn by the user's status line (fallback when no status JSON). */
export function parseEffortText(raw: string): string | null {
  for (const l of footerLines(raw) ?? []) {
    const m = /\beffort:([a-z]+)\b/.exec(l);
    if (m) return m[1];
  }
  return null;
}

export interface ModelInfo { model: string | null; modelId: string | null; effort: string | null; fast: boolean | null }

/** Model / effort from ~/.maw/status/<sid>.json (written by the Claude status line). */
export function readModelInfo(sid: string | undefined | null, dir = join(homedir(), ".maw", "status")): ModelInfo {
  const none: ModelInfo = { model: null, modelId: null, effort: null, fast: null };
  if (!sid || !/^[\w-]{8,80}$/.test(sid)) return none;
  try {
    const d = JSON.parse(readFileSync(join(dir, sid + ".json"), "utf-8"));
    return {
      model: typeof d.model?.display_name === "string" ? d.model.display_name : null,
      modelId: typeof d.model?.id === "string" ? d.model.id : null,
      effort: typeof d.effort?.level === "string" ? d.effort.level : typeof d.effort === "string" ? d.effort : null,
      fast: typeof d.fast_mode === "boolean" ? d.fast_mode : null,
    };
  } catch { return none; }
}

/** claude-switch rooms (12 พ.ย. 69): Claude Code talking through the local claude-codex proxy, so `/model gpt-…` keeps
 *  the same chat. Known by the agent process env (ANTHROPIC_BASE_URL → 127.0.0.1:18765), not by the room title.
 *  Plan: ψ/incubate/Soul-Brews-Studio/maw-js/plans/PLAN-same-chat-model-switch-20261112.md */
export const SWITCH_PROXY = /^ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+\/?$/m;
export const GPT_MODEL = /^gpt-[a-z0-9][a-z0-9.\-]{0,40}$/;
const ps = (args: string[]) => execFileSync("/bin/ps", args, { encoding: "utf-8", timeout: 3_000 });
/** Is the pane's process tree running Claude Code through the switch proxy? */
export function paneSwitchable(pane: string, run = (a: string[]) => execFileSync("tmux", a, { encoding: "utf-8", timeout: 3_000 }), psRun = ps): boolean {
  try {
    const root = +run(["display", "-p", "-t", pane, "#{pane_pid}"]).trim();
    if (!root) return false;
    const kids = new Map<number, number[]>();
    for (const l of psRun(["-A", "-o", "pid=,ppid="]).split("\n")) { const [a, b] = l.trim().split(/\s+/).map(Number); if (a && b) kids.set(b, [...(kids.get(b) ?? []), a]); }
    const todo = [root], seen = new Set<number>();
    while (todo.length && seen.size < 64) {
      const p = todo.pop()!; if (seen.has(p)) continue; seen.add(p);
      try { if (SWITCH_PROXY.test(psRun(["eww", "-o", "command=", "-p", String(p)]).replace(/ /g, "\n"))) return true; } catch { /* gone */ }
      todo.push(...(kids.get(p) ?? []));
    }
  } catch { /* no tmux / pane gone */ }
  return false;
}
/** GPT models the ChatGPT login offers (Codex CLI's own cache), listed ones only. */
export function gptModels(file = join(homedir(), ".codex", "models_cache.json")): string[] {
  try {
    const d = JSON.parse(readFileSync(file, "utf-8"));
    return (d.models ?? []).filter((m: any) => m?.visibility === "list" && GPT_MODEL.test(String(m.slug))).map((m: any) => String(m.slug)).slice(0, 12);
  } catch { return []; }
}

/** Claude Code's `/model` also saves the pick as the default for every new session (~/.claude/settings.json "model").
 *  A switch room flipping to gpt-… must not make plain `claude` (Mind / direct — no GPT there) start on GPT: put the
 *  previous default back once the command has landed. */
export const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
export function readDefaultModel(file = CLAUDE_SETTINGS): { ok: boolean; model?: string } {
  try { const d = JSON.parse(readFileSync(file, "utf-8")); return { ok: true, model: typeof d.model === "string" ? d.model : undefined }; }
  catch { return { ok: false }; }
}
export function restoreDefaultModel(prev: { ok: boolean; model?: string }, file = CLAUDE_SETTINGS): void {
  if (!prev.ok) return;
  try {
    const d = JSON.parse(readFileSync(file, "utf-8"));
    if (d.model === prev.model) return;
    if (prev.model === undefined) delete d.model; else d.model = prev.model;
    writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
  } catch { /* settings unreadable — leave it */ }
}

export interface ModesDeps {
  writeGuard?: ContinuityWriteGuard;
  settingsFile?: string;
  switchable?: (ch: ReplyChannel) => boolean;
  gptModels?: () => string[];
  readScreen: (ch: ReplyChannel, lines: number) => Promise<string>;
  pressKey: (ch: ReplyChannel, label: string) => Promise<void>;
  typeInto: (ch: ReplyChannel, text: string) => Promise<void>;
  roomChannel: (ws: string, room: string) => ReplyChannel | null;
  statusDir?: string;
  wait: (ms: number) => Promise<void>;
}
const defaults: ModesDeps = { readScreen, pressKey, typeInto, roomChannel, wait: ms => new Promise(r => setTimeout(r, ms)),
  switchable: ch => ch.kind === "tmux" && paneSwitchable(ch.pane), gptModels: () => gptModels() };

const isCodex = (agent: unknown) => typeof agent === "string" && agent !== "" && agent !== "claude";

export function mount(app: any, overrides: Partial<ModesDeps> = {}): void {
  const deps: ModesDeps = { ...defaults, ...overrides };
  const chan = (params: any, set: any) => {
    const ch = deps.roomChannel(params.ws, params.room);
    if (!ch) { set.status = 404; return null; }
    return ch;
  };
  const screen = async (ch: ReplyChannel) => { try { return await deps.readScreen(ch, 60); } catch { return ""; } };
  /** Slash commands typed while Claude is working get queued behind the turn — refuse instead. */
  const busy = async (ch: ReplyChannel) => !!agentSpinner(await screen(ch));

  app.get("/rooms/:ws/:room/mode", async ({ params, query, set }: any) => {
    const ch = chan(params, set);
    if (!ch) return { ok: false, error: "ไม่พบห้องนี้" };
    const info = readModelInfo(query?.sid, deps.statusDir);
    if (isCodex(query?.agent)) return { ok: true, mode: "unknown", ...info };
    const raw = await screen(ch);
    const switchable = !!deps.switchable?.(ch);
    return { ok: true, mode: parseMode(raw), ...info, effort: info.effort ?? parseEffortText(raw),
      switchable, gptModels: switchable ? deps.gptModels?.() ?? [] : [] };
  });

  app.post("/rooms/:ws/:room/mode/cycle", async ({ params, query, body, set }: any) => {
    const attempt=createContinuityWriteAttempt(deps.writeGuard,params.ws,params.room);
    const guardedPress=(ch:ReplyChannel,key:string)=>attempt.run(()=>deps.pressKey(ch,key));
    const guardedType=(ch:ReplyChannel,text:string)=>attempt.run(()=>deps.typeInto(ch,text));
    try {
      await attempt.check();
    const ch = chan(params, set);
    if (!ch) return { ok: false, error: "ไม่พบห้องนี้" };
    const agent = body?.agent ?? query?.agent;
    const before = parseMode(await screen(ch));
    if (isCodex(agent) || before === "unknown") {
      set.status = 400;
      return { ok: false, error: isCodex(agent) ? "สลับโหมดได้เฉพาะห้อง Claude" : "อ่านโหมดจากจอไม่ได้ — ปิดเมนู/คำถามที่ค้างอยู่ก่อน" };
    }
    await guardedPress(ch, "btab");
    await deps.wait(400);
    return { ok: true, before, mode: parseMode(await screen(ch)) };
    } catch(error) { const failure=attempt.failure(error,set);if(failure)return failure;throw error; }
  });

  app.post("/rooms/:ws/:room/model", async ({ params, body, set }: any) => {
    const attempt=createContinuityWriteAttempt(deps.writeGuard,params.ws,params.room);
    const guardedPress=(ch:ReplyChannel,key:string)=>attempt.run(()=>deps.pressKey(ch,key));
    const guardedType=(ch:ReplyChannel,text:string)=>attempt.run(()=>deps.typeInto(ch,text));
    try {
      await attempt.check();
    const model = String(body?.model ?? "");
    const gpt = GPT_MODEL.test(model);
    if (!gpt && !(MODEL_ALIASES as readonly string[]).includes(model)) { set.status = 400; return { ok: false, error: "ไม่รู้จัก model นี้" }; }
    const ch = chan(params, set);
    if (!ch) return { ok: false, error: "ไม่พบห้องนี้" };
    // GPT only in a claude-switch room, and only a model the ChatGPT login lists
    if (gpt && !(deps.switchable?.(ch) && (deps.gptModels?.() ?? []).includes(model))) { set.status = 400; return { ok: false, error: "ห้องนี้สลับเป็น GPT ไม่ได้ — เปิดห้องแบบ Claude ⇄ GPT ก่อน" }; }
    if (isCodex(body?.agent)) { set.status = 400; return { ok: false, error: "เปลี่ยน model ได้เฉพาะห้อง Claude" }; }
    if (await busy(ch)) { set.status = 409; return { ok: false, error: "Claude กำลังทำงานอยู่ — รอให้เสร็จก่อนค่อยเปลี่ยน model" }; }
    const sw = !!deps.switchable?.(ch), prev = sw ? readDefaultModel(deps.settingsFile) : { ok: false };
    await guardedType(ch, `/model ${model}`);
    if (sw) { await deps.wait(1_500); restoreDefaultModel(prev, deps.settingsFile); }
    return { ok: true, model };
    } catch(error) { const failure=attempt.failure(error,set);if(failure)return failure;throw error; }
  });

  app.post("/rooms/:ws/:room/effort", async ({ params, body, set }: any) => {
    const attempt=createContinuityWriteAttempt(deps.writeGuard,params.ws,params.room);
    const guardedPress=(ch:ReplyChannel,key:string)=>attempt.run(()=>deps.pressKey(ch,key));
    const guardedType=(ch:ReplyChannel,text:string)=>attempt.run(()=>deps.typeInto(ch,text));
    try {
      await attempt.check();
    const level = String(body?.level ?? "");
    if (!(EFFORT_LEVELS as readonly string[]).includes(level)) { set.status = 400; return { ok: false, error: "ไม่รู้จักระดับ effort นี้" }; }
    const ch = chan(params, set);
    if (!ch) return { ok: false, error: "ไม่พบห้องนี้" };
    if (isCodex(body?.agent)) { set.status = 400; return { ok: false, error: "ปรับ effort ได้เฉพาะห้อง Claude" }; }
    if (await busy(ch)) { set.status = 409; return { ok: false, error: "Claude กำลังทำงานอยู่ — รอให้เสร็จก่อนค่อยปรับ effort" }; }
    await guardedType(ch, `/effort ${level}`);
    return { ok: true, level };
    } catch(error) { const failure=attempt.failure(error,set);if(failure)return failure;throw error; }
  });
}
