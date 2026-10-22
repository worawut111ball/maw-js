// Phone UI pack "permissions" (P1) — answer Claude Code / Codex permission prompts with buttons.
// Server: GET /rooms/:ws/:room/prompt · POST /rooms/:ws/:room/prompt/answer {n, sig}  (src/mobile/features/permissions.ts)
(() => {
  if (!window.mawExt) return;
  const P = { key: "", prompt: null, last: 0, busy: false, inflight: false, hideSig: "", hideUntil: 0 };
  const EVERY = 2500, EVERY_WORKING = 7500;
  const roomKeyOf = (w, room) => `${w.id}|${room.id}`;
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
  .perm-k button:active { transform: scale(.96); filter: brightness(1.25); } .perm-k button:disabled { opacity: .5; }`;
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
      <div class="perm-o">${p.options.map(o => `<button class="${esc(o.kind)}" data-pn="${o.n}"><span class="n">${o.n}</span><span class="l">${esc(o.label)}</span></button>`).join("")}</div>
      <div class="perm-f">กดแล้วจะส่งปุ่ม ${p.options.map(o => o.n).join("/")} ไปที่ ${p.agent === "codex" ? "Codex" : "Claude"} บน Mac ทันที</div>`;
    card.querySelectorAll("[data-pn]").forEach(b => b.onclick = () => answer(w, room, +b.dataset.pn, card));
    el.prepend(card);
  }

  // any other dialog (trust folder, "Teach auto mode…", question pickers): show it and give a key pad
  const MENU_KEYS = [["up", "↑"], ["down", "↓"], ["left", "←"], ["right", "→"], ["space", "␣ เลือก"], ["tab", "Tab"], ["enter", "⏎ Enter", "go"], ["esc", "Esc", "no"]];
  function renderMenu(el, card, w, room, p) {
    card.className = "perm menu";
    const body = p.body.split("\n").map(l => `<span class="ln ${/^\s*[❯›>▶]\s*\S/.test(l) ? "cur" : ""}">${esc(l) || " "}</span>`).join("");
    const lr = /[←→◀▶]/.test(p.footer + p.body);
    card.innerHTML = `
      <div class="perm-h"><span>❓</span><span class="t">${esc(p.title)}</span><span class="ag">รอคำตอบ</span></div>
      ${p.body ? `<div class="perm-d">${body}</div>` : ""}
      <div class="perm-k">${p.numbers.map(n => `<button class="num" data-mk="${n}">${n}</button>`).join("")}${MENU_KEYS.filter(([k]) => lr || (k !== "left" && k !== "right")).map(([k, l, c]) => `<button class="${c || ""}" data-mk="${k}">${l}</button>`).join("")}</div>
      <div class="perm-f">${esc(p.footer)} — กดแล้วส่งปุ่มไปที่ Mac ทันที แถบที่ไฮไลต์คือตัวที่เลือกอยู่</div>`;
    card.querySelectorAll("[data-mk]").forEach(b => b.onclick = () => pressMenu(w, room, b.dataset.mk, card));
    el.prepend(card);
    const d = card.querySelector(".perm-d"), cur = card.querySelector(".cur");
    if (d && cur) d.scrollTop = Math.max(0, cur.offsetTop - d.offsetTop - d.clientHeight / 2);   // keep the selected row in view
  }
  async function pressMenu(w, room, key, card) {
    if (P.busy) return;
    P.busy = true; card.querySelectorAll("button").forEach(b => b.disabled = true);
    try { await api(url(w, room, "/key"), { method: "POST", body: JSON.stringify({ key }) }); }
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
      await api(url(w, room, "/answer"), { method: "POST", body: JSON.stringify({ n, sig: p.sig }) });
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
      const p = r.prompt;
      if (!p || (p.sig === P.hideSig && Date.now() < P.hideUntil)) { if (P.prompt) hide(); return; }
      if (P.prompt && P.prompt.sig === p.sig && slot()?.querySelector(".perm")) return;   // unchanged — don't redraw
      P.prompt = p; render(w, room);
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
