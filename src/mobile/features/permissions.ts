// Feature pack "permissions" (P1) — answer Claude Code / Codex permission prompts from the phone.
// GET  /rooms/:ws/:room/prompt         → { ok, prompt }   the dialog open at the bottom of the screen, or null
// POST /rooms/:ws/:room/prompt/answer  { n, sig? }        re-reads the screen, presses option n only if that
//                                                          same dialog is still open (else 409).
import { createHash } from "crypto";
import { t } from "elysia";
import { readScreen, pressKey, roomChannel } from "./ctx";

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
}

const SCREEN_LINES = 160;
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

  const base = { agent: codex ? "codex" as const : "claude" as const, title, detail, question, options };
  return { ...base, sig: promptSig(base) };
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
  sig: string;
}

const MENU_RULE = /^\s*[╭┌╰└]?[─━═╌┄┈▔▁-]{6,}[╮┐╯┘]?\s*$/;
// a dialog footer says how to answer it; Claude's normal input footer ("? for shortcuts", "shift+tab to cycle",
// "esc to interrupt") must not count
const MENU_FOOTER = /\b(?:enter|esc|space|tab)\b[^·]*\bto (?:continue|confirm|select|cancel|exit|go back|submit|toggle|save|skip|choose|proceed|open)\b|[←→↑↓]+(?:\/[←→↑↓]+)? to \w/i;
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
    if (MENU_FOOTER.test(lines[i])) { foot = i; break; }
  }
  if (foot < 0) return null;
  // top: the rule above, at most 40 lines up; stop at things that belong to the conversation
  let top = -1;
  for (let i = foot - 1; i >= Math.max(0, foot - 40); i--) {
    if (MENU_RULE.test(lines[i])) { top = i; break; }
    if (SPINNER.test(lines[i]) || /^\s*[⏺●⎿✻]/.test(lines[i])) { top = i; break; }
  }
  const block = lines.slice(top + 1, foot);
  while (block.length && !block[0].trim()) block.shift();
  while (block.length && !block[block.length - 1].trim()) block.pop();
  if (!block.length || !block.some(l => /^\s*[❯›>▶]\s*\S/.test(l))) return null;   // a live menu has a cursor
  const body = dedent(block);
  const title = body[0].trim();
  const rest = body.slice(1);
  while (rest.length && !rest[0].trim()) rest.shift();
  const numbers = rest.map(l => /^\s*[❯›>▶]?\s*(\d)[.)]\s+\S/.exec(l)).filter(Boolean).map(m => +m![1]).filter(n => n >= 1 && n <= 4);
  const footer = lines[foot].trim();
  const text = rest.join("\n").slice(0, MAX_DETAIL_CHARS);
  const sig = createHash("sha1").update(["menu", title, text, footer].join("\u0001")).digest("hex").slice(0, 12);
  return { kind: "menu", title, body: text, footer, numbers: [...new Set(numbers)], sig };
}

/** Keys the phone may press inside an open dialog. */
export const MENU_KEYS = ["up", "down", "left", "right", "enter", "esc", "tab", "space", "1", "2", "3", "4"];

/** `deps` exists so tests can swap the terminal for a fake — production always uses the real helpers. */
export function mount(app: any, deps: { readScreen: typeof readScreen; pressKey: typeof pressKey; roomChannel: typeof roomChannel } = { readScreen, pressKey, roomChannel }): void {
  const { readScreen: read, pressKey: press, roomChannel: chan } = deps;
  app.get("/rooms/:ws/:room/prompt", async ({ params, set }: any) => {
    const ch = chan(params.ws, params.room);
    if (!ch) { set.status = 404; return { ok: false, error: "ไม่พบห้องนี้" }; }
    try { const raw = await read(ch, SCREEN_LINES); return { ok: true, prompt: parsePrompt(raw) ?? parseMenu(raw) }; }
    catch { return { ok: true, prompt: null }; }
  });

  // one key into an open dialog (moving the cursor changes the dialog, so no sig — but a dialog must be open)
  app.post("/rooms/:ws/:room/prompt/key", async ({ params, body, set }: any) => {
    const ch = chan(params.ws, params.room);
    if (!ch) { set.status = 404; return { ok: false, error: "ไม่พบห้องนี้" }; }
    let open = false;
    try { const raw = await read(ch, SCREEN_LINES); open = !!(parsePrompt(raw) ?? parseMenu(raw)); } catch { /* unreadable */ }
    if (!open) { set.status = 409; return { ok: false, error: "หน้าถามปิดไปแล้ว — ไม่ได้กดอะไร" }; }
    await press(ch, body.key);
    return { ok: true };
  }, { body: t.Object({ key: t.Union(MENU_KEYS.map(k => t.Literal(k))) }) });

  app.post("/rooms/:ws/:room/prompt/answer", async ({ params, body, set }: any) => {
    const ch = chan(params.ws, params.room);
    if (!ch) { set.status = 404; return { ok: false, error: "ไม่พบห้องนี้" }; }
    let prompt: PermissionPrompt | null = null;
    try { prompt = parsePrompt(await read(ch, SCREEN_LINES)); } catch { /* unreadable = no prompt */ }
    if (!prompt) { set.status = 409; return { ok: false, error: "คำถามขออนุญาตปิดไปแล้ว — ไม่ได้กดอะไร" }; }
    if (body.sig && body.sig !== prompt.sig) { set.status = 409; return { ok: false, error: "คำถามเปลี่ยนไปแล้ว — โหลดใหม่ก่อนตอบ", prompt }; }
    const opt = prompt.options.find(o => o.n === body.n);
    if (!opt) { set.status = 409; return { ok: false, error: `ไม่มีตัวเลือกที่ ${body.n}`, prompt }; }
    if (opt.n > 4) { set.status = 409; return { ok: false, error: "ตัวเลือกนี้ต้องตอบจากเครื่อง Mac", prompt }; }
    await press(ch, String(opt.n));
    return { ok: true, answered: opt };
  }, { body: t.Object({ n: t.Integer({ minimum: 1, maximum: 9 }), sig: t.Optional(t.String({ maxLength: 40 })) }) });
}
