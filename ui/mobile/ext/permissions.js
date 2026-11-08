// Phone UI pack "permissions" (P1) — answer Claude Code / Codex permission prompts with buttons.
// Server: GET /rooms/:ws/:room/prompt · POST …/prompt/answer {n, sig} · POST …/prompt/key {key} · POST …/prompt/type {n, text}  (src/mobile/features/permissions.ts)
(() => {
  if (!window.mawExt) return;
  const P = { key: "", prompt: null, last: 0, busy: false, inflight: false, hideSig: "", hideUntil: 0 };
  const EVERY = 2500, EVERY_WORKING = 7500;
  const roomKeyOf = (w, room) => `${w.id}|${room.id}`;
  const herdr = w => String(w?.id || "").startsWith("herdr:");
  function guardedBody(w, body) {
    return herdr(w) ? { ...body, id: crypto.randomUUID(), generation: P.generation, dialogToken: P.dialogToken } : body;
  }
  async function dialogPost(w, room, tail, body) {
    const out = await api(url(w, room, tail), { method: "POST", body: JSON.stringify(guardedBody(w, body)) });
    if (herdr(w)) {
      // Navigation changes the expected question/tab token; get a fresh token before the next key.
      const next = await api(url(w, room)); P.generation = next.generation; P.dialogToken = next.dialogToken;
    }
    return out;
  }
  const url = (w, room, tail = "") => `/rooms/${encodeURIComponent(w.id)}/${encodeURIComponent(room.id)}/prompt${tail}`;

  const css = `
  .perm { margin: 8px 12px 6px; border-radius: 16px; background: var(--card); border: 1px solid #f59e0b55; box-shadow: 0 6px 24px #0007, 0 0 0 3px #f59e0b14; overflow: hidden; animation: perm-in .18s ease-out; }
  @keyframes perm-in { from { transform: translateY(6px); opacity: 0 } to { transform: none; opacity: 1 } }
  .perm-h { display: flex; align-items: center; gap: 8px; padding: 11px 14px 8px; font: 700 15px var(--font); color: var(--text); }
  .perm-h .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .perm-h .ag { margin-left: auto; flex: none; font-size: 11.5px; font-weight: 600; color: var(--dim); background: var(--card2); padding: 3px 8px; border-radius: 999px; }
  .perm-d { margin: 0 12px; padding: 9px 11px; max-height: 168px; overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
    font: 12.5px/1.45 var(--mono, ui-monospace, Menlo, monospace); color: var(--text); white-space: pre-wrap; word-break: break-word; -webkit-overflow-scrolling: touch; }
  .perm-q { padding: 10px 14px 4px; font-size: 14px; line-height: 1.4; color: var(--text); }
  .perm-o { display: grid; gap: 7px; padding: 8px 12px 12px; }
  .perm-o button { display: flex; align-items: flex-start; gap: 10px; width: 100%; min-height: 46px; padding: 11px 12px; border-radius: 12px; text-align: left;
    font: 600 14px/1.35 var(--font); color: var(--text); background: var(--card2); border: 1px solid var(--line); }
  .perm-o button .n { flex: none; width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center; font-size: 12px; font-weight: 800; background: #ffffff14; }
  .perm-o button .l { min-width: 0; overflow-wrap: anywhere; }
  .perm-o button.allow { background: #22c55e1f; border-color: #22c55e66; } .perm-o button.allow .n { background: #22c55e; color: #03140a; }
  .perm-o button.always { background: #60a5fa1c; border-color: #60a5fa66; } .perm-o button.always .n { background: var(--accent); color: #031022; }
  .perm-o button.deny { background: #ef44441a; border-color: #ef444466; } .perm-o button.deny .n { background: var(--danger, #ef4444); color: #1a0303; }
  .perm-o button:active { transform: scale(.985); filter: brightness(1.2); }
  .perm-o button:disabled { opacity: .5; }
  .perm-f { padding: 0 14px 11px; font-size: 11.5px; color: var(--dim); }
  .perm.menu { border-color: #a78bfa66; box-shadow: 0 6px 24px #0007, 0 0 0 3px #a78bfa14; }
  .perm-d .ln { display: block; min-height: 1.45em; }
  .perm-d .cur { color: #c4b5fd; font-weight: 700; background: #a78bfa1f; border-radius: 4px; }
  .perm-k { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 6px; }
  .perm-k button { min-width: 44px; height: 40px; padding: 0 12px; border-radius: 10px; font: 700 14px var(--font); color: var(--text); background: var(--card2); border: 1px solid var(--line); }
  .perm-k button.go { background: #22c55e24; border-color: #22c55e77; } .perm-k button.no { background: #ef44441a; border-color: #ef444466; }
  .perm-k button.num { background: #60a5fa1c; border-color: #60a5fa66; }
  .perm-t { margin: 2px 0 8px; font-size: 13px; color: #fbbf24; } .perm-t b { font-variant-numeric: tabular-nums; }
  .perm-k button:active { transform: scale(.96); filter: brightness(1.25); } .perm-k button:disabled { opacity: .5; }
  /* question cards (AskUserQuestion) — compact: one header row, short answer rows, the card scrolls inside itself */
  .perm.ask { margin: 6px 10px 4px; border-radius: 14px; }
  .perm.ask .perm-h { padding: 8px 12px 4px; font-size: 13px; gap: 6px; flex-wrap: nowrap; }
  .perm-tabs { display: flex; gap: 4px; min-width: 0; overflow-x: auto; scrollbar-width: none; margin-left: auto; }
  .perm-tabs::-webkit-scrollbar { display: none; }
  .perm-tabs button { flex: none; font: 600 11.5px var(--font); padding: 4px 9px; border-radius: 999px; background: var(--card2); color: var(--dim); border: 1px solid var(--line); white-space: nowrap; }
  .perm-tabs button.done { color: #86efac; border-color: #22c55e55; background: #22c55e14; }
  .perm-tabs button.cur { color: #120a24; background: #a78bfa; border-color: #a78bfa; }
  .perm-tabs button:active { transform: scale(.95); } .perm-tabs button:disabled { opacity: .55; }
  .perm-qq { padding: 2px 12px 6px; color: var(--text); }
  .perm-qq .q1 { font: 600 14px/1.35 var(--font); }
  .perm-qq .qb { font: 400 12.5px/1.4 var(--font); color: var(--dim); padding-left: 2px; overflow-wrap: anywhere; }
  .perm-body { max-height: 46vh; overflow: auto; -webkit-overflow-scrolling: touch; }
  .perm-o.ask { gap: 5px; padding: 0 10px 6px; }
  .perm-o.ask button { min-height: 36px; padding: 7px 10px; border-radius: 10px; font: 600 13.5px/1.3 var(--font); gap: 8px; align-items: center; }
  .perm-o.ask button .n { width: 20px; height: 20px; font-size: 11px; border-radius: 6px; }
  .perm-o.ask button .l { flex: 1; min-width: 0; display: flex; gap: 6px; align-items: baseline; overflow: hidden; }
  .perm-o.ask button .l b { flex: none; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .perm-o.ask button .h { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; font-size: 12px; color: var(--dim); }
  .perm-o.ask button.sel { border-color: #a78bfa; background: #a78bfa1f; } .perm-o.ask button.sel .n { background: #a78bfa; color: #120a24; }
  .perm-o.ask button.side { min-height: 30px; padding: 4px 10px; font-weight: 500; font-size: 12.5px; color: var(--dim); background: transparent; }
  .perm-free { display: flex; gap: 6px; padding: 2px 10px 8px; }
  .perm-free textarea { flex: 1; min-height: 36px; height: 36px; max-height: 110px; resize: none; padding: 8px 10px; border-radius: 10px; border: 1px solid #a78bfa88; background: var(--bg); color: var(--text); font: 14px/1.3 var(--font); }
  .perm-free button { flex: none; padding: 0 12px; height: 36px; border-radius: 10px; border: 0; background: #a78bfa; color: #120a24; font: 700 13px var(--font); align-self: flex-end; }
  .perm-more { margin: 0 10px 6px; } .perm-more summary { font-size: 11.5px; color: var(--dim); cursor: pointer; padding: 2px; }`;
  const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);

  const slot = () => document.getElementById("ext-room-bottom");
  const shortTitle = t => String(t || "Permission").replace(/^Bash command$/i, "Bash").replace(/^Edit file$/i, "Edit").replace(/^Create file$/i, "Write");
  const AG = { claude: "✳ Claude", codex: "◎ Codex" };

  function hide() { P.prompt = null; slot()?.querySelector(".perm")?.remove(); }

  function render(w, room) {
    const el = slot(), p = P.prompt;
    if (!el) return;
    el.querySelector(".perm")?.remove();
    if (!p) return;
    const card = document.createElement("div");
    if (p.kind === "menu") return renderMenu(el, card, w, room, p);
    card.className = "perm";
    card.innerHTML = `
      <div class="perm-h"><span>🔐</span><span class="t">ขออนุญาต · ${esc(shortTitle(p.title))}</span><span class="ag">${esc(AG[p.agent] || p.agent)}</span></div>
      ${p.detail ? `<div class="perm-d">${esc(p.detail)}</div>` : ""}
      <div class="perm-q">${esc(p.question)}</div>
      ${p.denyIn != null ? `<div class="perm-t">⏳ ถ้าไม่ตอบ ${p.agent === "codex" ? "Codex" : "Claude"} จะปฏิเสธเองใน <b>${fmtLeft(p.denyIn)}</b></div>` : ""}
      <div class="perm-o">${p.options.map(o => `<button class="${esc(o.kind)}" data-pn="${o.n}"><span class="n">${o.n}</span><span class="l">${esc(o.label)}</span></button>`).join("")}</div>
      <div class="perm-f">กดแล้วจะส่งปุ่ม ${p.options.map(o => o.n).join("/")} ไปที่ ${p.agent === "codex" ? "Codex" : "Claude"} บน Mac ทันที</div>`;
    card.querySelectorAll("[data-pn]").forEach(b => b.onclick = () => answer(w, room, +b.dataset.pn, card));
    el.prepend(card);
    // safety-check dialogs time out by themselves — tick the countdown on the phone (the sig no longer changes with it)
    const t = card.querySelector(".perm-t b");
    if (t) {
      const end = Date.now() + p.denyIn * 1000;
      const iv = setInterval(() => { if (!card.isConnected) return clearInterval(iv); t.textContent = fmtLeft(Math.max(0, Math.round((end - Date.now()) / 1000))); }, 1000);
    }
  }
  function fmtLeft(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

  // any other dialog (trust folder, "Teach auto mode…", question pickers): show it and give a key pad
  const MENU_KEYS = [["up", "↑"], ["down", "↓"], ["left", "←"], ["right", "→"], ["space", "␣ เลือก"], ["tab", "Tab"], ["enter", "⏎ Enter", "go"], ["esc", "Esc", "no"]];
  function renderMenu(el, card, w, room, p) {
    card.className = "perm menu";
    const body = p.body.split("\n").map(l => `<span class="ln ${/^\s*[❯›>▶]\s*\S/.test(l) ? "cur" : ""}">${esc(l) || " "}</span>`).join("");
    const lr = /[←→◀▶]/.test(p.footer + p.body);
    const keys = `<div class="perm-k">${MENU_KEYS.filter(([k]) => lr || (k !== "left" && k !== "right")).map(([k, l, c]) => `<button class="${c || ""}" data-mk="${k}">${l}</button>`).join("")}</div>`;
    const opts = p.options || [];
    if (opts.length) {
      // a question with answers: tap one · "Type something." opens a box right here · the raw screen + keys stay one tap away
      const free = opts.find(o => o.free);
      const typed = free && !/^type something\.?$/i.test(free.label) ? free.label : "";
      // the free row is the box below — not a button of its own
      const btn = o => {
        const side = /^chat about this$/i.test(o.label);
        return `<button class="${o.sel ? "sel" : ""} ${side ? "side" : ""}" data-on="${o.n}"><span class="n">${o.n}</span><span class="l"><b>${esc(o.label)}</b>${o.hint ? `<span class="h">${esc(o.hint)}</span>` : ""}</span></button>`;
      };
      card.classList.add("ask");
      card.innerHTML = `
        <div class="perm-h"><span>❓</span>${p.tabs?.length ? "" : `<span class="t">${esc(p.title)}</span>`}${p.tabs?.length ? `<span class="perm-tabs">${p.tabs.map((t, i) => `<button class="${t.done ? "done" : ""} ${i === p.cur ? "cur" : ""}" data-tab="${i}">${t.done ? "✓" : i === p.cur ? "●" : "○"} ${esc(t.label)}</button>`).join("")}</span>` : `<span class="ag">รอคำตอบ</span>`}</div>
        <div class="perm-body">${p.question ? `<div class="perm-qq">${p.question.split("\n").map((l, i) => i ? `<div class="qb">${esc(l) || "&nbsp;"}</div>` : `<div class="q1">${esc(l)}</div>`).join("")}</div>` : ""}<div class="perm-o ask">${opts.filter(o => !o.free).map(btn).join("")}</div></div>
        ${free ? `<div class="perm-free"><textarea rows="1" placeholder="${typed ? "" : "หรือพิมพ์คำตอบเอง…"}"></textarea><button data-send>ส่ง</button></div>` : ""}
        <details class="perm-more"><summary>ปุ่มเพิ่มเติม · หน้าจอจริง</summary>${p.body ? `<div class="perm-d">${body}</div>` : ""}${keys}</details>`;
      card.querySelectorAll("[data-on]").forEach(b => b.onclick = () => pressMenu(w, room, b.dataset.on, card));
      card.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => goTab(w, room, +b.dataset.tab, card));
      card.querySelector(".perm-tabs .cur")?.scrollIntoView({ inline: "center", block: "nearest" });
      card.querySelectorAll("[data-mk]").forEach(b => b.onclick = () => pressMenu(w, room, b.dataset.mk, card));
      if (free) {
        const box = card.querySelector(".perm-free textarea"), go = card.querySelector("[data-send]");
        box.oninput = () => { P.draft = box.value; P.freeOpen = roomKeyOf(w, room); box.style.height = "36px"; box.style.height = Math.min(110, box.scrollHeight + 2) + "px"; };
        box.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); go.click(); } };
        go.onclick = () => typeAnswer(w, room, free.n, box.value, card);
        // redrawn (the dialog moved) → keep what was being typed; else show the text already in that row on the Mac
        box.value = P.draft != null && P.freeOpen === roomKeyOf(w, room) ? P.draft : typed;
        box.addEventListener("focus", () => { P.freeOpen = roomKeyOf(w, room); });
        if (box.value) box.oninput();
      }
      el.prepend(card);
      return;
    }
    card.innerHTML = `
      <div class="perm-h"><span>❓</span><span class="t">${esc(p.title)}</span><span class="ag">รอคำตอบ</span></div>
      ${p.body ? `<div class="perm-d">${body}</div>` : ""}
      <div class="perm-k">${p.numbers.map(n => `<button class="num" data-mk="${n}">${n}</button>`).join("")}${keys.slice(keys.indexOf(">") + 1)}
      <div class="perm-f">${esc(p.footer)} — กดแล้วส่งปุ่มไปที่ Mac ทันที แถบที่ไฮไลต์คือตัวที่เลือกอยู่</div>`;
    card.querySelectorAll("[data-mk]").forEach(b => b.onclick = () => pressMenu(w, room, b.dataset.mk, card));
    el.prepend(card);
    const d = card.querySelector(".perm-d"), cur = card.querySelector(".cur");
    if (d && cur) d.scrollTop = Math.max(0, cur.offsetTop - d.offsetTop - d.clientHeight / 2);   // keep the selected row in view
  }
  /** Tap a question tab → ← / → on the Mac as many times as it takes (what Tab/Arrow do there). */
  async function goTab(w, room, t, card) {
    const p = P.prompt; if (!p || P.busy || p.cur == null || t === p.cur) return;
    const diff = t - p.cur, key = diff > 0 ? "right" : "left";
    P.busy = true; card.querySelectorAll("button").forEach(b => b.disabled = true);
    P.nav = { to: t, q: p.question, at: Date.now() };
    try {
      for (let i = 0; i < Math.abs(diff); i++) { await dialogPost(w, room, "/key", { key }); await new Promise(r => setTimeout(r, 120)); }
    } catch (e) { toast(e.message || "เลื่อนไม่สำเร็จ"); P.nav = null; }
    finally { P.busy = false; card.querySelectorAll("button").forEach(b => b.disabled = false); }
    setTimeout(() => { P.last = 0; check(w, room, true); }, 350);
  }
  /** Which tab is open: the Mac says so when it can see colours (tmux); else the phone keeps count —
   *  a new dialog opens at its first unanswered question, a tap moves where it was sent, an answer moves one on. */
  function trackTab(p) {
    if (p.kind !== "menu" || !p.tabs?.length) return;
    const tsig = p.tabs.map(t => t.label).join("|");
    if (tsig !== P.tabsSig) { P.tabsSig = tsig; P.cur = null; P.q = null; P.nav = null; }
    if (P.nav && Date.now() - P.nav.at > 5000) P.nav = null;
    if (p.tab != null) { P.cur = p.tab; if (P.nav && p.question !== P.nav.q) P.nav = null; }
    else if ((p.options || []).some(o => /^submit answers$/i.test(o.label))) P.cur = p.tabs.length - 1;
    else if (P.nav) { if (p.question !== P.nav.q) { P.cur = P.nav.to; P.nav = null; } }
    else if (P.cur == null) P.cur = Math.max(0, p.tabs.findIndex(t => !t.done));
    else if (P.q != null && p.question !== P.q) P.cur = Math.min(P.cur + 1, p.tabs.length - 1);
    P.q = p.question; p.cur = P.cur;
  }
  /** The typed answer goes into the "Type something." row on the Mac, then Enter (server re-checks the row is open). */
  async function typeAnswer(w, room, n, text, card) {
    text = String(text || "").trim();
    if (!text) { toast("พิมพ์คำตอบก่อน"); return; }
    if (P.busy) return;
    P.busy = true; card.querySelectorAll("button, textarea").forEach(b => b.disabled = true);
    try {
      await dialogPost(w, room, "/type", { n, text });
      toast(`ตอบแล้ว: ${text.slice(0, 40)}`);
      P.draft = null; P.freeOpen = "";
      return true;
    } catch (e) { toast(e.message || "ส่งคำตอบไม่สำเร็จ"); return false; }
    finally { P.busy = false; card.querySelectorAll("button, textarea").forEach(b => b.disabled = false); setTimeout(() => { P.last = 0; check(w, room, true); }, 500); }
  }
  /** The composer at the bottom while a question card waits: the text answers its "Type something." row.
   *  → "sent" (clear the composer) · "kept" (keep the text, nothing sent) · false (no card: send as usual) */
  window.mawDialogAnswer = async text => {
    const p = P.prompt, w = P.w, room = P.room;
    if (!p || p.kind !== "menu" || !w || !room || state.room !== room.id || !slot()?.querySelector(".perm")) return false;
    const free = (p.options || []).find(o => o.free);
    if (!free) { toast("ตอบการ์ดคำถามด้านบนก่อน (คำถามนี้ไม่มีช่องพิมพ์เอง)"); return "kept"; }
    return (await typeAnswer(w, room, free.n, text, slot().querySelector(".perm"))) ? "sent" : "kept";
  };
  async function pressMenu(w, room, key, card) {
    if (P.busy) return;
    P.busy = true; card.querySelectorAll("button").forEach(b => b.disabled = true);
    try { await dialogPost(w, room, "/key", { key }); }
    catch (e) { toast(e.message || "กดไม่สำเร็จ"); }
    finally { P.busy = false; card.querySelectorAll("button").forEach(b => b.disabled = false); }
    setTimeout(() => { P.last = 0; check(w, room, true); }, 350);   // the dialog redraws → show its new state
  }

  async function answer(w, room, n, card) {
    if (P.busy || !P.prompt) return;
    const p = P.prompt, opt = p.options.find(o => o.n === n);
    P.busy = true;
    card.querySelectorAll("button").forEach(b => b.disabled = true);
    try {
      await dialogPost(w, room, "/answer", { n, sig: p.sig });
      toast(`ตอบแล้ว: ${opt ? opt.label : n}`);
      P.hideSig = p.sig; P.hideUntil = Date.now() + 4000;   // the screen may still show it for a moment
      hide();
    } catch (e) {
      toast(e.message || "ตอบไม่สำเร็จ");
      card.querySelectorAll("button").forEach(b => b.disabled = false);
      P.last = 0;   // re-check right away
    } finally { P.busy = false; }
  }

  async function check(w, room, force) {
    if (document.hidden || P.inflight || P.busy) return;
    const key = roomKeyOf(w, room);
    if (key !== P.key) { P.key = key; hide(); P.last = 0; }
    const gap = room.status === "working" && !P.prompt ? EVERY_WORKING : EVERY;
    if (!force && Date.now() - P.last < gap) return;
    P.last = Date.now(); P.inflight = true;
    try {
      const r = await api(url(w, room));
      if (P.key !== key || state.room !== room.id) return;   // user switched rooms meanwhile
      P.generation = r.generation; P.dialogToken = r.dialogToken;
      const p = r.prompt;
      if (!p || (p.sig === P.hideSig && Date.now() < P.hideUntil)) { if (P.prompt) hide(); return; }
      trackTab(p);
      if (P.prompt && P.prompt.sig === p.sig && P.prompt.cur === p.cur && slot()?.querySelector(".perm")) return;   // unchanged — don't redraw
      P.prompt = p; P.w = w; P.room = room;
      // typing in the free-answer box → don't redraw under the person's fingers (it comes back after send / blur)
      const box = slot()?.querySelector(".perm-free textarea");
      if (box && document.activeElement === box && P.prompt.kind === "menu") return;
      render(w, room);
    } catch { /* offline / 404 — keep whatever is shown */ }
    finally { P.inflight = false; }
  }

  const isAgent = room => room && (room.agent === "claude" || room.agent === "codex");

  mawExt.onPoll.push(({ w, room }) => {
    if (!w || !isAgent(room)) { hide(); return; }
    check(w, room, false);
  });

  // The room view is redrawn from scratch (tab switch, mode switch…) — put the card back, then refresh.
  mawExt.onRoom.push(({ w, room }) => {
    if (!w || !isAgent(room)) { P.key = ""; hide(); return; }
    if (roomKeyOf(w, room) === P.key && P.prompt) render(w, room);
    check(w, room, room.status !== "working");
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) P.last = 0; });
})();
