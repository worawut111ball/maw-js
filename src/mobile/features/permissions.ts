import { continuityWriteFailure, createContinuityWriteAttempt, type ContinuityWriteGuard } from '../continuity/write-guard';
// Feature pack "permissions" (P1) — answer Claude Code / Codex permission prompts from the phone.
// GET  /rooms/:ws/:room/prompt         → { ok, prompt }   the dialog open at the bottom of the screen, or null
// POST /rooms/:ws/:room/prompt/type    { n, text }     AskUserQuestion "Type something." → that row, text, Enter
// POST /rooms/:ws/:room/prompt/answer  { n, sig? }        re-reads the screen, presses option n only if that
//                                                          same dialog is still open (else 409).
import { createHash } from "crypto";
import { herdrRuntime as defaultHerdrRuntime, type HerdrRuntime } from "../herdr/runtime";
import { herdrFailure } from "../api";
import { t } from "elysia";
import { readScreen, pressKey, typeLiteral, roomChannel, readLiveRooms, notifyPhones } from "./ctx";
import type { LiveRoom, ReplyChannel } from "./ctx";

export type OptionKind = "allow" | "always" | "deny" | "other";
export interface PromptOption { n: number; label: string; kind: OptionKind }
export interface PermissionPrompt {
  kind?: "permission";
  agent: "claude" | "codex";
  title: string;
  detail: string;
  question: string;
  options: PromptOption[];
  /** Short hash of the dialog — lets the phone prove it answers the dialog it saw. */
  sig: string;
  /** Seconds left before Claude Code denies it by itself (safety-check dialogs show a countdown) — not part of sig */
  denyIn?: number;
}

const SCREEN_LINES = 160;
/** "⚠ Claude Code will automatically deny this request in 1:42, to avoid blocking …" — ticks every second */
const COUNTDOWN = /will automatically deny this request in (\d+):(\d{2})/i;
/** The countdown line is cut out of the dialog text: it changes every second, so a sig over it would never match twice. */
export function splitCountdown(text: string): { text: string; denyIn?: number } {
  const lines = text.split("\n");
  const k = lines.findIndex(l => COUNTDOWN.test(l));
  if (k < 0) return { text };
  const m = COUNTDOWN.exec(lines[k])!;
  lines.splice(k, 1);
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n"), denyIn: +m[1] * 60 + +m[2] };
}
const MAX_DETAIL_LINES = 40;
const MAX_DETAIL_CHARS = 4000;

/** Remove OSC (links/titles), CSI (colour/cursor) and other control chars; normalise CRLF. */
export function stripAnsi(s: string): string {
  return String(s ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b./g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Drop box side borders (│ ┃ ║) so boxed and unboxed dialogs look the same. */
function unbox(line: string): string {
  let l = line.replace(/\s+$/, "");
  for (let k = 0; k < 3; k++) {
    const next = l.replace(/^(\s*)[│┃║] ?/, "$1 ").replace(/\s*[│┃║]$/, "");
    if (next === l) break;
    l = next;
  }
  return l;
}

const RULE = /^\s*[╭┌╰└]?[─━═╌┄┈-]{6,}[╮┐╯┘]?\s*$/;          // top/bottom border or separator
const DASHED = /^\s*[╌┄┈]{6,}\s*$/;                           // Claude's diff frame
const OPTION = /^\s*([❯›>▶→])?\s*(\d{1,2})[.)]\s+(\S.*)$/;     // "❯ 1. Yes" / "  2. No, …"
const FOOTER = /\b(?:esc|enter|tab|ctrl\+[a-z]|shift\+tab) to \w|\bto (?:cancel|confirm|select|navigate|explain)\b|for shortcuts/i;
const SPINNER = /^\s*[·✢✳✶✻✽]\s+\S.*…/u;                    // "✻ Thinking… (3s)"
const ACTIVITY = /^\s*[⏺●⎿]/;                                // Claude transcript lines after an answer

export function optionKind(label: string): OptionKind {
  const l = label.toLowerCase();
  if (/^no\b/.test(l) || /what to do differently|^deny|^reject|^cancel|^don'?t\b/.test(l)) return "deny";
  if (/don['’]t ask again|always|allow all|remember|for this session|during this session|bypass permissions|auto mode|allow this host|permission rules|allow access to/.test(l)) return "always";
  if (/^(yes|allow|approve|proceed|ok|continue)\b/.test(l)) return "allow";
  return "other";
}

/** "Yes, proceed (y)" → "Yes, proceed"; keep meaningful parentheses. */
function cleanLabel(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/\s*\((?:esc|enter|tab|shift\+tab|ctrl\+[a-z]|[a-z])\)\s*$/i, "").trim();
}

function dedent(lines: string[]): string[] {
  const ind = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^ */)![0].length));
  return lines.map(l => l.slice(Number.isFinite(ind) ? ind : 0).replace(/\s+$/, ""));
}

function clipDetail(lines: string[]): string {
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let out = dedent(lines);
  if (out.length > MAX_DETAIL_LINES) out = [...out.slice(0, MAX_DETAIL_LINES - 1), `… (+${out.length - MAX_DETAIL_LINES + 1} บรรทัด)`];
  const s = out.join("\n");
  return s.length > MAX_DETAIL_CHARS ? s.slice(0, MAX_DETAIL_CHARS) + "…" : s;
}

const CODEX_TITLES: [RegExp, string][] = [
  [/run the following command/i, "Run command"],
  [/make the following edits/i, "Edit files"],
  [/grant these permissions/i, "Permissions"],
  [/send input to/i, "Terminal input"],
  [/host|network|connect/i, "Network"],
];

export function promptSig(p: Omit<PermissionPrompt, "sig">): string {
  const key = [p.agent, p.title, p.question, p.detail, ...p.options.map(o => `${o.n}:${o.label}`)].join("\u0001");
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/**
 * Parse the permission dialog that is still OPEN at the bottom of a terminal screen.
 * Returns null when there is none — including when only old, answered prompts sit in scrollback.
 */
export function parsePrompt(raw: string): PermissionPrompt | null {
  const lines = stripAnsi(raw).split("\n").map(unbox);
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  if (end < 0) return null;

  // 1. Walk up over the footer area to the last numbered option. Anything that looks like the agent
  //    has moved on (input box, spinner, new output) means the dialog was answered → null.
  let last = -1, tail = 0;
  for (let i = end; i >= Math.max(0, end - 12); i--) {
    const l = lines[i];
    if (!l.trim() || RULE.test(l)) continue;
    if (OPTION.test(l)) { last = i; break; }
    if (SPINNER.test(l) || ACTIVITY.test(l)) return null;
    if (/^\s*[❯>›]\s*(?!\d)/.test(l) && !FOOTER.test(l)) return null;   // empty input prompt "❯ " / "› Ask Codex…"
    if (!FOOTER.test(l) && ++tail > 3) return null;
  }
  if (last < 0) return null;

  // 2. Collect the option block upward (wrapped labels continue on indented, un-numbered lines).
  const opts: { n: number; label: string; marked: boolean; line: number }[] = [];
  // the last label may itself wrap onto the lines below it
  let cont: string[] = [];
  for (let k = last + 1; k <= end && lines[k].trim() && /^\s{2,}\S/.test(lines[k]) && !FOOTER.test(lines[k]) && !RULE.test(lines[k]); k++) cont.push(lines[k].trim());
  let i = last;
  for (; i >= 0 && i >= last - 30; i--) {
    const l = lines[i];
    const m = OPTION.exec(l);
    if (m) {
      opts.unshift({ n: +m[2], label: cleanLabel([m[3], ...cont].join(" ")), marked: !!m[1], line: i });
      cont = [];
      if (+m[2] === 1) break;
      continue;
    }
    if (!l.trim() || RULE.test(l) || DASHED.test(l)) return null;     // gap before reaching "1."
    if (opts.length && /^\s{2,}\S/.test(l)) { cont.unshift(l.trim()); continue; }
    return null;
  }
  if (!opts.length || opts[0].n !== 1 || opts.length < 2) return null;
  if (opts.some((o, k) => o.n !== k + 1)) return null;
  if (!opts.some(o => o.marked)) return null;                        // a live menu always has a cursor
  const first = opts[0].line;

  const allLabels = opts.map(o => o.label).join(" ");
  const codex = /tell codex/i.test(allLabels) || /Yes, proceed|Yes, just this once/i.test(allLabels);
  const options: PromptOption[] = opts.map(o => ({ n: o.n, label: o.label, kind: optionKind(o.label) }));

  // 3. Question + header + detail.
  let title = "", detail = "", question = "";
  if (codex) {
    let q = -1;
    for (let k = first - 1; k >= Math.max(0, first - 60); k--) {
      if (/(Would you like to|Do you want to|Allow )\S?.*\?\s*$/i.test(lines[k]) || /Would you like to/i.test(lines[k])) { q = k; break; }
    }
    if (q < 0) return null;
    question = lines[q].trim();
    // a question can wrap onto the next line(s) until it ends in "?"
    let k = q;
    while (!/\?\s*$/.test(question) && k + 1 < first && lines[k + 1].trim()) question += " " + lines[++k].trim();
    title = CODEX_TITLES.find(([re]) => re.test(question))?.[1] ?? "Permission";
    detail = clipDetail(lines.slice(k + 1, first));
  } else {
    // question: the line(s) right above "1." — starts with "Do you want…" (may wrap)
    let q = -1;
    for (let k = first - 1; k >= Math.max(0, first - 4); k--) {
      if (!lines[k].trim()) break;
      if (/^\s*(Do you want|Would you like|Allow|Proceed|Continue)\b/i.test(lines[k]) || (k === first - 1 && /\?\s*$/.test(lines[k]))) { q = k; if (/^\s*(Do you|Would you)/i.test(lines[k])) break; }
    }
    if (q < 0) return null;
    question = lines.slice(q, first).map(l => l.trim()).join(" ");
    // header: first text after the dialog's top rule
    let top = -1, depth = 0;
    for (let k = q - 1; k >= Math.max(0, q - 200); k--) {
      const l = lines[k];
      if (!RULE.test(l) || DASHED.test(l)) continue;
      if (/^\s*[╰└]/.test(l)) { depth++; continue; }              // bottom of a nested box (e.g. diff frame)
      if (/^\s*[╭┌]/.test(l) && depth > 0) { depth--; continue; }
      top = k; break;
    }
    let h = top + 1;
    while (h < q && !lines[h].trim()) h++;
    if (top < 0) {                       // no frame visible — take the paragraph above the question
      h = q - 1;
      while (h > 0 && lines[h - 1].trim()) h--;
      while (h < q && !lines[h].trim()) h++;
    }
    title = h < q ? lines[h].trim() : "Permission";
    detail = clipDetail(lines.slice(h + 1, q).filter(l => !RULE.test(l)));
  }

  const cd = splitCountdown(detail);
  const base = { agent: codex ? "codex" as const : "claude" as const, title, detail: cd.text, question, options };
  return { ...base, sig: promptSig(base), ...(cd.denyIn !== undefined ? { denyIn: cd.denyIn } : {}) };
}

/** Any other open dialog (trust folder, "Teach auto mode…", pickers): shown as text + a key pad on the phone. */
export interface MenuPrompt {
  kind: "menu";
  title: string;
  /** Dialog body as on screen (cursor "❯" kept so the phone can highlight the selected row). */
  body: string;
  footer: string;
  /** Numbered rows ("1. Yes") → number buttons. */
  numbers: number[];
  /** The numbered rows as tappable answers. `free` = AskUserQuestion's "Type something." row (its label turns into the
   *  typed text once typed) · `sel` = the cursor is on it · `hint` = the description line under it. */
  options: MenuOption[];
  /** AskUserQuestion's header "←  ☒ Colour  ☐ Fruit  ✔ Submit  →" — done = answered already. */
  tabs: { label: string; done: boolean }[];
  /** index of the open tab when the screen shows it (tmux), else null */
  tab: number | null;
  /** The question line under that header (or the dialog's title). */
  question: string;
  sig: string;
  denyIn?: number;
}
export interface MenuOption { n: number; label: string; hint: string; sel: boolean; free: boolean }

const OPT_ROW = /^\s*([❯›>▶])?\s*(\d)[.)]\s+(.+?)\s*$/;
/** Numbered rows of a dialog body → options. The free-text row is the one AskUserQuestion closes with a rule
 *  (below it only "Chat about this"), or the one still reading "Type something.". */
export function menuOptions(body: string[]): MenuOption[] {
  const out: MenuOption[] = [];
  for (let i = 0; i < body.length; i++) {
    const m = OPT_ROW.exec(body[i]); if (!m) continue;
    const n = +m[2]; if (n < 1 || out.some(o => o.n === n)) continue;
    let j = i + 1; while (j < body.length && !body[j].trim()) j++;
    const next = body[j] ?? "";
    const hint = next && !OPT_ROW.test(next) && !MENU_RULE.test(next) && /^\s{3,}\S/.test(next) ? next.trim() : "";
    const label = m[3].trim();
    const ruleAfter = MENU_RULE.test(hint ? (body[j + 1] ?? "") : next);
    out.push({ n, label, hint, sel: !!m[1], free: /^type something\.?$/i.test(label) || ruleAfter });
  }
  return out;
}
/** Which tab of the header is the open one: Claude paints it with a background colour (tmux keeps it, `-e`;
 *  Superset's reader returns plain text → null, the phone then keeps track itself). */
export function currentTab(raw: string): number | null {
  const line = raw.split("\n").find(l => /←/.test(l) && /→/.test(l) && /[☐☒✔✓]/.test(l));
  if (!line || !line.includes("\x1b[")) return null;
  let bg = false, k = -1, cur: number | null = null;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\x1b") {
      const m = /^\x1b\[([0-9;]*)m/.exec(line.slice(i)); if (!m) continue;
      const codes = m[1].split(";");
      for (let j = 0; j < codes.length; j++) {
        const c = +codes[j] || 0;
        // 38/48;5;n and 38/48;2;r;g;b carry colour numbers that are not codes of their own
        if (c === 38 || c === 48) { if (c === 48) bg = true; j += codes[j + 1] === "2" ? 4 : 2; continue; }
        if (c === 0 || c === 49) bg = false;
        else if ((c >= 40 && c <= 47) || (c >= 100 && c <= 107)) bg = true;
      }
      i += m[0].length - 1; continue;
    }
    if ("☐☒✔✓".includes(line[i])) { k++; if (bg) cur = k; }
  }
  return cur;
}
/** "←  ☒ Colour  ☐ Fruit  ✔ Submit  →" → [{Colour, done}, {Fruit}, {Submit}] · anything else → [] */
export function menuTabs(line: string): { label: string; done: boolean }[] {
  // several questions: "←  ☒ A  ☐ B  ✔ Submit  →" · one question: just " ☐ Card 33 " (no arrows, no Submit)
  const several = /^\s*←.*→\s*$/.test(line), single = /^\s*[☐☒]\s*\S[^☐☒✔✓←→]*$/.test(line);
  if (!(several || single) || !/[☐☒✔✓]/.test(line)) return [];
  return [...line.matchAll(/([☐☒✔✓])\s*([^☐☒✔✓→]+?)(?=\s{2,}|\s*[☐☒✔✓→]|$)/g)].map(m => ({ label: m[2].trim(), done: m[1] === "☒" }));
}

const MENU_RULE = /^\s*[╭┌╰└]?[─━═╌┄┈▔▁-]{6,}[╮┐╯┘]?\s*$/;
// a dialog footer says how to answer it; Claude's normal input footer ("? for shortcuts", "shift+tab to cycle",
// "esc to interrupt") must not count
const MENU_FOOTER = /\b(?:enter|esc|space|tab|ctrl\+\w)\b[^·]*\bto (?:continue|confirm|select|cancel|exit|go back|submit|toggle|save|skip|choose|proceed|open|edit|approve)\b|[←→↑↓]+(?:\/[←→↑↓]+)? to \w/i;
// Codex writes its footers without "to": "enter continue · esc quit"
const CODEX_FOOTER = /^\s*(?:enter|esc|tab|space)\s+[a-z]+(?: [a-z]+)?(?:\s*·\s*(?:enter|esc|tab|space|[←→↑↓/]+)\s+[a-z]+(?: [a-z]+)?)+\s*$/i;
const NOT_DIALOG = /for shortcuts|to cycle|to interrupt|auto mode on|bypass permissions on|accept edits on|plan mode on/i;

/** The dialog still open at the bottom of the screen that is NOT a numbered permission prompt, else null. */
export function parseMenu(raw: string): MenuPrompt | null {
  const lines = stripAnsi(raw).split("\n").map(unbox);
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  if (end < 0) return null;
  // footer: within the last few non-empty lines
  let foot = -1;
  for (let i = end, seen = 0; i >= 0 && seen < 3; i--) {
    if (!lines[i].trim() || MENU_RULE.test(lines[i])) continue;
    seen++;
    if (NOT_DIALOG.test(lines[i])) return null;
    if (MENU_FOOTER.test(lines[i]) || CODEX_FOOTER.test(lines[i])) { foot = i; break; }
  }
  // no footer: AskUserQuestion's last page ("Review your answers" → "❯ 1. Submit answers / 2. Cancel") ends on
  // its numbered rows. Only when the cursor sits on one of them — chat output never ends like that (the input box
  // and its "? for shortcuts" footer follow it)
  if (foot < 0) {
    const tail: number[] = [];
    for (let i = end; i >= 0 && tail.length < 6 && /^\s*[❯›>▶]?\s*\d[.)]\s+\S/.test(lines[i]); i--) tail.push(i);
    if (tail.length < 2 || !tail.some(i => /^\s*[❯›>▶]\s*\d[.)]/.test(lines[i]))) return null;
    foot = end + 1;
  }
  // top: the rule above, at most 40 lines up; stop at things that belong to the conversation
  let top = -1;
  // a rule with no cursor row below it yet is a separator inside the dialog (AskUserQuestion puts one
  // between "Type something." and "Chat about this") — keep climbing to the dialog's own top rule
  const cursorBelow = (i: number) => lines.slice(i + 1, foot).some(l => /^\s*[❯›>▶]\s*\S/.test(l));
  for (let i = foot - 1; i >= Math.max(0, foot - 40); i--) {
    if (MENU_RULE.test(lines[i])) { if (cursorBelow(i)) { top = i; break; } continue; }
    // conversation marks: ⏺/●/✻ at column 0, ⎿ under a tool call (a dialog indents its own "●" bullets)
    if (SPINNER.test(lines[i]) || /^[⏺●✻]|^\s*⎿/.test(lines[i])) { top = i; break; }
  }
  const block = lines.slice(top + 1, foot);
  while (block.length && !block[0].trim()) block.shift();
  while (block.length && !block[block.length - 1].trim()) block.pop();
  if (!block.length || !block.some(l => /^\s*[❯›>▶]\s*\S/.test(l))) return null;   // a live menu has a cursor
  const body = dedent(block);
  const title = body[0].trim();
  const rest = body.slice(1);
  while (rest.length && !rest[0].trim()) rest.shift();
  const numbers = rest.map(l => /^\s*[❯›>▶]?\s*(\d)[.)]\s+\S/.exec(l)).filter(Boolean).map(m => +m![1]).filter(n => n >= 1 && n <= 9);
  const footer = (lines[foot] ?? "").trim();
  const cd = splitCountdown(rest.join("\n").slice(0, MAX_DETAIL_CHARS)), text = cd.text;
  const sig = createHash("sha1").update(["menu", title, text, footer].join("\u0001")).digest("hex").slice(0, 12);
  const tabs = menuTabs(title);
  // the question is every line above the first answer (a long one comes as a block: heading + bullets), not just the first
  const firstOpt = rest.findIndex(l => OPT_ROW.test(l));
  const qLines = tabs.length ? rest.slice(0, firstOpt < 0 ? rest.length : firstOpt) : [title];
  const question = dedent(qLines.map(l => l.replace(/\s+$/, ""))).join("\n").replace(/^\n+|\n+$/g, "").replace(/\n{3,}/g, "\n\n");
  return { kind: "menu", title, body: text, footer, numbers: [...new Set(numbers)], options: menuOptions(rest), tabs, tab: tabs.length ? currentTab(raw) : null, question, sig, ...(cd.denyIn !== undefined ? { denyIn: cd.denyIn } : {}) };
}

/** Keys the phone may press inside an open dialog. */
export const MENU_KEYS = ["up", "down", "left", "right", "enter", "esc", "tab", "space", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

// ── push when a dialog opens ──
// Permission prompts already push through the Claude hook; other dialogs (trust folder, "Teach auto mode…",
// pickers) send no hook, so the screens of live rooms are checked here. Only the fact goes out, never the text.
export const DIALOG_EVERY = 8_000;
export interface WatchDeps {
  rooms: () => Map<string, LiveRoom>;
  read: (ch: ReplyChannel, lines: number) => Promise<string>;
  notify: (sid: string, kind: string, msg: { title: string; body: string }) => Promise<unknown>;
}
/** One pass. `seen` holds the dialog each session showed last time; returns the sessions that were notified. */
export async function dialogPass(deps: WatchDeps, seen: Map<string, string>, quiet = false): Promise<string[]> {
  const sent: string[] = [];
  const live = deps.rooms();
  for (const sid of [...seen.keys()]) if (!live.has(sid)) seen.delete(sid);
  for (const r of live.values()) {
    if (!r.channel || r.status === "busy") continue;            // a dialog stops the agent, so it is never "busy"
    let menu: MenuPrompt | null = null;
    try { const raw = await deps.read(r.channel, SCREEN_LINES); menu = parsePrompt(raw) ? null : parseMenu(raw); } catch { continue; }
    const prev = seen.get(r.sessionId);
    if (!menu) { seen.delete(r.sessionId); continue; }
    if (prev === menu.title) continue;                          // same dialog (cursor moves change the sig, not the title)
    seen.set(r.sessionId, menu.title);
    if (quiet) continue;
    const room = r.name || (r.channel as any).label || "Claude";
    await deps.notify(r.sessionId, "dialog", { title: `❓ รอให้เลือก · ${room}`, body: "มีหน้าถามเปิดค้างบน Mac — แตะเพื่อตอบจากมือถือ" }).catch(() => {});
    sent.push(r.sessionId);
  }
  return sent;
}
let watching = false;
function watchDialogs(): void {
  if (watching) return; watching = true;
  const seen = new Map<string, string>();
  const deps: WatchDeps = { rooms: readLiveRooms, read: readScreen, notify: notifyPhones };
  let first = true, running = false;
  setInterval(async () => {
    if (running) return; running = true;
    try { await dialogPass(deps, seen, first); first = false; }   // first pass after a restart only remembers what is open
    finally { running = false; }
  }, DIALOG_EVERY).unref?.();
}

/** `deps` exists so tests can swap the terminal for a fake — production always uses the real helpers. */
/** Open tab of an AskUserQuestion card when the screen has no colours (Superset): the review page is the last tab;
 *  else the one tab whose header word appears in the question on screen ("Fruit" ↔ "…favourite fruit?").
 *  (Claude Code writes the question to its transcript only after it is answered — no help while it is open.) */
export function tabFromScreen(menu: MenuPrompt): number | null {
  if (!menu.tabs.length) return null;
  if (menu.options.some(o => /^submit answers$/i.test(o.label))) return menu.tabs.length - 1;
  const q = menu.question.split("\n")[0].toLowerCase();   // the heading line — bullets below may name other topics
  const hits = menu.tabs.map((t, i) => (t.label.length >= 2 && !/^submit$/i.test(t.label) && q.includes(t.label.toLowerCase()) ? i : -1)).filter(i => i >= 0);
  return hits.length === 1 ? hits[0] : null;
}

// Herdr mutations never pass through legacy generic input helpers.
const herdrBody = {
  id: t.Optional(t.String({ maxLength: 128 })), generation: t.Optional(t.String({ maxLength: 256 })),
  dialogToken: t.Optional(t.String({ maxLength: 256 })),
};
async function herdrPromptAction(herdrRuntime: HerdrRuntime, params: any, body: any, set: any, action: "key" | "answer", attempt: ReturnType<typeof createContinuityWriteAttempt>) {
  set.headers["cache-control"] = "no-store";
  try {
    await herdrRuntime.refresh();
    const ch = herdrRuntime.resolve(params.ws, params.room);
    if (!ch) { set.status = 409; return { ok: false, code: "agent_changed", error: "agent เดิมปิดหรือเปลี่ยนแล้ว" }; }
    const result = await attempt.run(() => herdrRuntime.dispatch(ch, { id: body.id || "", action, expectedGeneration: body.generation || "",
      expectedDialogToken: body.dialogToken, key: body.key, n: body.n, text: body.text }));
    if (!result.ok) set.status = 409;
    return { ...result, error: result.ok ? undefined : "ยังยืนยันการส่งไม่ได้ — โหลดคำถามใหม่ก่อนตอบ" };
  } catch (e) { return attempt.failure(e,set) ?? herdrFailure(e, set); }
}

export interface PermissionsDeps { readScreen: typeof readScreen; pressKey: typeof pressKey; roomChannel: typeof roomChannel; typeLiteral?: typeof typeLiteral; pause?: (ms: number) => Promise<void>; herdr?: HerdrRuntime; writeGuard?: ContinuityWriteGuard }
export function mount(app: any, deps: PermissionsDeps = { readScreen, pressKey, roomChannel }): void {
  const herdrRuntime = deps.herdr ?? defaultHerdrRuntime;
  herdrRuntime.setDialogParser((raw: string) => {
    const p = parsePrompt(raw) ?? parseMenu(raw);
    if (p && p.kind === "menu" && p.tabs.length && p.tab == null) p.tab = tabFromScreen(p);
    return p as any;
  });
  const { readScreen: read, pressKey: press, roomChannel: chan } = deps;
  const typeText = deps.typeLiteral ?? typeLiteral;
  const pause = deps.pause ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  if (deps.readScreen === readScreen) watchDialogs();   // the real server only — tests pass fakes
  app.get("/rooms/:ws/:room/prompt", async ({ params, set }: any) => {
    if (params.ws.startsWith("herdr:")) {
      set.headers["cache-control"] = "no-store";
      try {
        await herdrRuntime.refresh();
        const hc = herdrRuntime.resolve(params.ws, params.room);
        if (!hc) { set.status = 404; return { ok: false, error: "ไม่พบห้อง Herdr" }; }
        return await herdrRuntime.dialog(hc);
      } catch (e) { return herdrFailure(e, set); }
    }
    const ch = chan(params.ws, params.room);
    if (!ch) { set.status = 404; return { ok: false, error: "ไม่พบห้องนี้" }; }
    try {
      const raw = await read(ch, SCREEN_LINES);
      const prompt = parsePrompt(raw) ?? parseMenu(raw);
      // no colours (Superset) → guess from the screen's own words; still unknown → the phone keeps count
      if (prompt && prompt.kind === "menu" && prompt.tabs.length && prompt.tab == null) prompt.tab = tabFromScreen(prompt);
      return { ok: true, prompt };
    } catch { return { ok: true, prompt: null }; }
  });

  // one key into an open dialog (moving the cursor changes the dialog, so no sig — but a dialog must be open)
  app.post("/rooms/:ws/:room/prompt/key", async ({ params, body, set }: any) => {
    const attempt=createContinuityWriteAttempt(deps.writeGuard,params.ws,params.room);
    const guardedPress=(ch:ReplyChannel,key:string)=>attempt.run(()=>press(ch,key));
    const guardedType=(ch:ReplyChannel,text:string)=>attempt.run(()=>typeText(ch,text));
    try {
      await attempt.check();
    if (params.ws.startsWith("herdr:")) return herdrPromptAction(herdrRuntime, params, body, set, "key", attempt);
    const ch = chan(params.ws, params.room);
    if (!ch) { set.status = 404; return { ok: false, error: "ไม่พบห้องนี้" }; }
    let open = false, menu: MenuPrompt | null = null;
    try { const raw = await read(ch, SCREEN_LINES); menu = parseMenu(raw); open = !!(parsePrompt(raw) ?? menu); } catch { /* unreadable */ }
    if (!open) { set.status = 409; return { ok: false, error: "หน้าถามปิดไปแล้ว — ไม่ได้กดอะไร" }; }
    // the cursor in AskUserQuestion's "Type something." row is a text field: a digit there is typed, not picked
    // (seen 7 Nov: card 14 opened with the cursor still on that row and "4" landed in it) → step out first
    if (/^\d$/.test(body.key) && menu?.options.find(o => o.sel)?.free) {
      await guardedPress(ch, "up"); await pause(300);
      try { const again = parseMenu(await read(ch, SCREEN_LINES)); if (again?.options.find(o => o.sel)?.free) { set.status = 409; return { ok: false, error: "ออกจากช่องพิมพ์คำตอบไม่ได้ — กด ↑ แล้วลองใหม่" }; } } catch { /* unreadable → press anyway */ }
    }
    await guardedPress(ch, body.key);
    return { ok: true };
    } catch(error) { const failure=attempt.failure(error,set);if(failure)return failure;throw error; }
  }, { body: t.Object({ ...herdrBody, key: t.Union(MENU_KEYS.map(k => t.Literal(k))) }) });

  // AskUserQuestion's "Type something." row: put the cursor on it (its number), replace what is there with the text,
  // Enter. Only into that row of the dialog still open — never into the chat input box.
  app.post("/rooms/:ws/:room/prompt/type", async ({ params, body, set }: any) => {
    const attempt=createContinuityWriteAttempt(deps.writeGuard,params.ws,params.room);
    const guardedPress=(ch:ReplyChannel,key:string)=>attempt.run(()=>press(ch,key));
    const guardedType=(ch:ReplyChannel,text:string)=>attempt.run(()=>typeText(ch,text));
    try {
      await attempt.check();
    if (params.ws.startsWith("herdr:")) return herdrPromptAction(herdrRuntime, params, body, set, "answer", attempt);
    const ch = chan(params.ws, params.room);
    if (!ch) { set.status = 404; return { ok: false, error: "ไม่พบห้องนี้" }; }
    const menu = async () => { try { return parseMenu(await read(ch, SCREEN_LINES)); } catch { return null; } };
    let m = await menu();
    const opt = () => m?.options.find(o => o.n === body.n);
    if (!m || !opt()?.free) { set.status = 409; return { ok: false, error: "ช่องพิมพ์คำตอบปิดไปแล้ว — ไม่ได้พิมพ์อะไร", prompt: m }; }
    if (!opt()!.sel) {
      await guardedPress(ch, String(body.n)); await pause(450); m = await menu();
      if (!opt()?.sel) { set.status = 409; return { ok: false, error: "เลือกช่องพิมพ์คำตอบไม่ได้ — ลองใหม่", prompt: m }; }
    }
    // text typed there before (label is no longer "Type something.") → clear it first
    if (!/^type something\.?$/i.test(opt()!.label)) { await guardedPress(ch, "ctrlu"); await pause(250); }
    await guardedType(ch, body.text);
    await pause(350);
    await guardedPress(ch, "enter");
    return { ok: true };
    } catch(error) { const failure=attempt.failure(error,set);if(failure)return failure;throw error; }
  }, { body: t.Object({ ...herdrBody, n: t.Integer({ minimum: 1, maximum: 9 }), text: t.String({ minLength: 1, maxLength: 2000 }) }) });

  app.post("/rooms/:ws/:room/prompt/answer", async ({ params, body, set }: any) => {
    const attempt=createContinuityWriteAttempt(deps.writeGuard,params.ws,params.room);
    const guardedPress=(ch:ReplyChannel,key:string)=>attempt.run(()=>press(ch,key));
    const guardedType=(ch:ReplyChannel,text:string)=>attempt.run(()=>typeText(ch,text));
    try {
      await attempt.check();
    if (params.ws.startsWith("herdr:")) return herdrPromptAction(herdrRuntime, params, body, set, "answer", attempt);
    const ch = chan(params.ws, params.room);
    if (!ch) { set.status = 404; return { ok: false, error: "ไม่พบห้องนี้" }; }
    let prompt: PermissionPrompt | null = null;
    try { prompt = parsePrompt(await read(ch, SCREEN_LINES)); } catch { /* unreadable = no prompt */ }
    if (!prompt) { set.status = 409; return { ok: false, error: "คำถามขออนุญาตปิดไปแล้ว — ไม่ได้กดอะไร" }; }
    if (body.sig && body.sig !== prompt.sig) { set.status = 409; return { ok: false, error: "คำถามเปลี่ยนไปแล้ว — โหลดใหม่ก่อนตอบ", prompt }; }
    const opt = prompt.options.find(o => o.n === body.n);
    if (!opt) { set.status = 409; return { ok: false, error: `ไม่มีตัวเลือกที่ ${body.n}`, prompt }; }
    if (opt.n > 4) { set.status = 409; return { ok: false, error: "ตัวเลือกนี้ต้องตอบจากเครื่อง Mac", prompt }; }
    await guardedPress(ch, String(opt.n));
    return { ok: true, answered: opt };
    } catch(error) { const failure=attempt.failure(error,set);if(failure)return failure;throw error; }
  }, { body: t.Object({ ...herdrBody, n: t.Integer({ minimum: 1, maximum: 9 }), sig: t.Optional(t.String({ maxLength: 40 })) }) });
}
