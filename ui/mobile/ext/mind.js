// Phone UI pack "mind" — page "🧠 Mind" (tile in the home เมนู): the user's own Artron Mind — 📬 Mail Box + 💬 Mind Chat.
// Server: GET /mind/mail · /mind/mail/:id · POST /mind/mail/mode · /mind/mail/:id/act · GET /mind/chats · /mind/chats/:id
//         POST /mind/chats/:id/send · POST /mind/chats  (src/mobile/features/mind.ts — the Mind token stays on the Mac)
// Every write is a user tap: mode change + mail actions need a second tap. Mail bodies are plain text (links not clickable).
(() => {
  if (!window.mawExt) return;
  const css = `
  .mi-page { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; } .mi-page > * { min-width: 0; }
  .mi-seg { display: flex; gap: 2px; padding: 3px; background: var(--card2); border-radius: 11px; }
  .mi-seg button { flex: 1; min-width: 0; padding: 8px 4px; border-radius: 8px; color: var(--dim); font: 600 13.5px var(--font); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mi-seg button.on { background: var(--card); color: var(--text); box-shadow: 0 1px 3px #0006; }
  .mi-seg button i { font-style: normal; margin-left: 4px; padding: 0 6px; border-radius: 99px; background: #f59e0b; color: #1a1003; font-size: 11px; font-weight: 800; }
  .mi-seg.sm button { padding: 6px 2px; font-size: 12.5px; }
  .mi-seg.sm button.on.auto { color: #fbbf24; } .mi-seg.sm button.armed { background: #f59e0b; color: #1a1003; }
  .mi-x { color: var(--dim); font-size: 12px; line-height: 1.45; margin: 0 2px; overflow-wrap: anywhere; } .mi-x.warn { color: #fbbf24; }
  .mi-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .mi-chip { padding: 5px 11px; border-radius: 999px; background: var(--card2); color: var(--dim); font: 600 12.5px var(--font); }
  .mi-chip.on { background: var(--accent); color: #031022; }
  .mi-bar .rf { margin-left: auto; width: 34px; height: 30px; border-radius: 9px; background: var(--card2); color: var(--dim); }
  .mi-list { display: grid; grid-template-columns: minmax(0, 1fr); background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .mi-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px; width: 100%; padding: 10px 12px; text-align: left; color: var(--text); border-bottom: 1px solid var(--line); }
  .mi-row:last-child { border-bottom: 0; } .mi-row:active { background: var(--card2); } .mi-row.me { box-shadow: inset 3px 0 0 #f59e0b; }
  .mi-r1 { display: flex; align-items: center; gap: 6px; min-width: 0; } .mi-r1 .t { margin-left: auto; flex: none; color: var(--dim); font-size: 11.5px; }
  .mi-pill { flex: none; padding: 2px 8px; border-radius: 99px; font-size: 11.5px; font-weight: 700; background: var(--card2); color: var(--dim); white-space: nowrap; }
  .mi-pill.pending { background: #f59e0b24; color: #fcd34d; } .mi-pill.replied { background: #22c55e1f; color: #86efac; }
  .mi-pill.failed, .mi-pill.rejected { background: #ef44441f; color: #fca5a5; } .mi-pill.approved { background: #38bdf81f; color: #7dd3fc; }
  .mi-sub { font-size: 13.5px; line-height: 1.35; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .mi-ft { color: var(--dim); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mi-more { padding: 10px; color: var(--dim); font-size: 12.5px; text-align: center; width: 100%; }
  .mi-empty { color: var(--dim); text-align: center; padding: 28px 8px; font-size: 13px; overflow-wrap: anywhere; }
  .mi-new { width: 100%; padding: 10px 12px; border-radius: 12px; border: 1px dashed #3b4266; color: var(--accent); font: 600 13.5px var(--font); text-align: left; }
  .mi-new:disabled { opacity: .5; }
  /* mail sheet */
  .mi-sheet { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .mi-sheet h2 { font-size: 16.5px !important; line-height: 1.35; overflow-wrap: anywhere; padding-right: 36px; }
  .mi-sheet .cl { position: absolute; right: 12px; top: 12px; width: 34px; height: 34px; border-radius: 10px; background: var(--card2); color: var(--dim); }
  .mi-meta { display: grid; gap: 2px; color: var(--dim); font-size: 12px; overflow-wrap: anywhere; } .mi-meta b { color: var(--text); font-weight: 600; }
  .mi-held { padding: 8px 10px; border-radius: 10px; background: #f59e0b1a; color: #fcd34d; font-size: 12.5px; overflow-wrap: anywhere; }
  .mi-body { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px; line-height: 1.6; padding: 10px 12px; border-radius: 12px; background: var(--bg); border: 1px solid var(--line); max-height: 52dvh; overflow-y: auto; user-select: text; }
  .mi-acts { display: flex; gap: 6px; flex-wrap: wrap; } .mi-acts button { flex: 1 1 120px; min-height: 40px; border-radius: 11px; font: 700 13.5px var(--font); background: var(--card2); color: var(--text); border: 1px solid var(--line); }
  .mi-acts .ok { background: #22c55e24; border-color: #22c55e77; color: #bbf7d0; } .mi-acts .no { color: #fca5a5; }
  .mi-acts .armed { background: #f59e0b; border-color: #f59e0b; color: #1a1003; } .mi-acts button:disabled { opacity: .5; }
  .mi-thr { display: grid; gap: 4px; } .mi-thr button { text-align: left; padding: 7px 10px; border-radius: 9px; background: var(--card2); color: var(--accent); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* chat */
  .mi-chead { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .mi-chead button { flex: none; height: 32px; padding: 0 10px; border-radius: 9px; background: var(--card2); color: var(--text); font: 600 13px var(--font); }
  .mi-chead b { flex: 1; min-width: 0; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mi-msgs { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 4px 0 8px; }
  .mi-m { display: flex; flex-direction: column; min-width: 0; } .mi-m.user { align-items: flex-end; }
  .mi-m .bb { padding: 9px 12px; font-size: 14px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 92%; min-width: 0; }
  .mi-m.user .bb { background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff; border-radius: 16px 16px 4px 16px; }
  .mi-m.oracle .bb { background: var(--card); border: 1px solid var(--line); border-radius: 4px 16px 16px 16px; max-width: 100%; }
  .mi-m.error .bb { border-color: #ef444477; color: #fca5a5; }
  .mi-m .bb code { font: 12.5px var(--mono); background: #ffffff14; padding: 1px 4px; border-radius: 4px; }
  .mi-m .bb pre { margin: 6px 0; padding: 8px 10px; border-radius: 8px; background: var(--bg); border: 1px solid var(--line); font: 12px/1.5 var(--mono); white-space: pre; overflow-x: auto; max-width: 100%; }
  .mi-m .fl { color: var(--dim); font-size: 11.5px; margin-top: 2px; }
  .mi-m .wh { color: var(--dim); font-size: 11px; margin: 0 4px 2px; }
  .mi-think { color: var(--dim); font-size: 13px; padding: 8px 12px; } .mi-think::after { content: "…"; animation: mi-dots 1.2s steps(3) infinite; }
  @keyframes mi-dots { 0% { content: "."; } 50% { content: ".."; } 100% { content: "..."; } }
  .mi-comp { position: sticky; bottom: 0; display: flex; gap: 6px; align-items: flex-end; padding: 8px 0 4px; background: var(--bg); }
  .mi-comp textarea { flex: 1; min-width: 0; min-height: 44px; max-height: 140px; resize: none; padding: 11px 12px; border-radius: 13px; border: 1px solid var(--line); background: var(--card); color: var(--text); font: 16px/1.35 var(--font); outline: none; }
  .mi-comp button { flex: none; width: 50px; height: 44px; border-radius: 13px; background: var(--accent); color: #031022; font-size: 19px; font-weight: 800; } .mi-comp button:disabled { opacity: .35; }`;
  if (!document.getElementById("mi-style")) { const s = document.createElement("style"); s.id = "mi-style"; s.textContent = css; document.head.appendChild(s); }

  const S = { tab: "mail", mail: null, mailErr: "", mailAt: 0, chats: null, chatsErr: "", chatsAt: 0, filter: "", shown: 40, armed: null, busy: false,
    open: null, chat: null, chatErr: "", sending: false, graceUntil: 0, pollT: 0, loading: new Set() };
  const root = document.createElement("div"); root.className = "mi-page";
  const MODES = [["manual", "แมนนวล", "ทุกฉบับรอคุณอนุมัติก่อน agent ตอบ"], ["semi", "กึ่งออโต้", "agent ตอบเอง · เรื่องที่ต้องให้คุณตัดสินใจจะค้างไว้ใน \"รอฉัน\""], ["auto", "ออโต้", "agent ตอบทุกฉบับเอง แล้วสรุปให้คุณในแชท 📬 Mailbox บน Mind"]];
  const OPS = { approve: ["✓ อนุมัติให้ agent ตอบ", "ok"], reject: ["✕ ปฏิเสธ", "no"], retry: ["↻ ให้ agent ตอบใหม่", "ok"] };
  const ago = t => { const m = Math.max(0, (Date.now() - t) / 60000); return m < 1 ? "เมื่อกี้" : m < 60 ? `${Math.round(m)} นาที` : m < 1440 ? `${Math.round(m / 60)} ชม.` : `${Math.round(m / 1440)} วัน`; };
  const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const when = t => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const mine = m => m.needsMe || m.actions.length;           // "รอฉัน" also shows failed mail I can retry
  const isArmed = (k) => S.armed && S.armed.k === k;
  function arm(k, redraw) { clearTimeout(S.armed?.t); S.armed = { k, t: setTimeout(() => { S.armed = null; redraw(); }, 4000) }; redraw(); }
  const disarm = () => { clearTimeout(S.armed?.t); S.armed = null; };
  // markdown-lite: ``` blocks → <pre>, `code`, **bold**; line breaks kept by pre-wrap; never links
  const md = t => String(t ?? "").split(/```[^\n]*\n?/).map((p, i, a) => i % 2 ? `<pre>${esc(p.replace(/\n$/, ""))}</pre>`
    : esc(p.replace(i ? /^\n/ : /^$/, "").replace(i < a.length - 1 ? /\n$/ : /^$/, "")).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")).join("");

  // ── draw ──
  function draw() {
    if (!root.isConnected) return;
    const w = S.mail?.waiting || 0;
    const seg = `<div class="mi-seg"><button class="${S.tab === "mail" ? "on" : ""}" data-tab="mail">📬 Mail Box${w ? `<i>${w}</i>` : ""}</button>
      <button class="${S.tab === "chat" ? "on" : ""}" data-tab="chat">💬 Chat${S.chats ? ` · ${S.chats.length}` : ""}</button></div>`;
    if (S.tab === "chat" && S.open) { if (!root.querySelector(".mi-conv")) root.innerHTML = seg + convShell(); drawConv(); return; }
    root.innerHTML = seg + (S.tab === "mail" ? mailHtml() : chatsHtml());
  }

  function mailHtml() {
    const d = S.mail;
    if (!d) return `<div class="mi-empty">${S.mailErr ? esc(S.mailErr) : "กำลังโหลด Mail Box…"}</div>`;
    const flt = S.filter || (d.mail.some(mine) ? "me" : "all");
    const list = flt === "me" ? d.mail.filter(mine) : d.mail, nMe = d.mail.filter(mine).length;
    const armedMode = S.armed?.k?.startsWith("mode:") ? S.armed.k.slice(5) : "";
    const note = armedMode ? `แตะ "${MODES.find(m => m[0] === armedMode)[1]}" อีกครั้งเพื่อเปลี่ยน${armedMode !== "manual" ? " · จดหมายที่รอคุณอยู่จะถูกส่งให้ agent ตอบทันที" : ""}`
      : (MODES.find(m => m[0] === d.mode) || MODES[0])[2] + (d.mode !== "manual" ? " (เรื่องเดียวกันตอบเองไม่เกิน 8 รอบ)" : "");
    return `<div class="mi-x" style="margin-top:4px">การตอบจดหมายของ agent</div>
      <div class="mi-seg sm">${MODES.map(([k, l]) => `<button class="${d.mode === k ? "on" : ""} ${k} ${armedMode === k ? "armed" : ""}" data-mode="${k}" ${S.busy ? "disabled" : ""}>${l}</button>`).join("")}</div>
      <div class="mi-x ${armedMode ? "warn" : ""}">${esc(note)}</div>
      <div class="mi-bar"><button class="mi-chip ${flt === "me" ? "on" : ""}" data-flt="me">รอฉัน ${nMe}</button><button class="mi-chip ${flt === "all" ? "on" : ""}" data-flt="all">ทั้งหมด ${d.total}</button>
        <button class="rf" data-rf>${S.loading.has("mail") ? "…" : "↻"}</button></div>
      ${S.mailErr ? `<div class="mi-x warn">${esc(S.mailErr)}</div>` : ""}
      ${list.length ? `<div class="mi-list">${list.slice(0, S.shown).map(m => `<button class="mi-row ${m.needsMe ? "me" : ""}" data-mail="${esc(m.id)}">
          <span class="mi-r1"><span class="mi-pill ${esc(m.status)}">${esc(m.statusText)}</span><span class="t">${ago(m.ts)}</span></span>
          <span class="mi-sub">${esc(m.subject)}</span><span class="mi-ft">${esc(m.from)} → ${esc(m.to)}</span></button>`).join("")}
        ${list.length > S.shown ? `<button class="mi-more" data-more>แสดงเพิ่ม (${list.length - S.shown})</button>` : ""}</div>`
        : `<div class="mi-empty">${flt === "me" ? "ไม่มีจดหมายรอคุณ 🎉" : "ยังไม่มีจดหมาย"}</div>`}`;
  }

  function chatsHtml() {
    const c = S.chats;
    if (!c) return `<div class="mi-empty">${S.chatsErr ? esc(S.chatsErr) : "กำลังโหลดแชท…"}</div>`;
    return `<div class="mi-bar"><button class="mi-new" data-newchat style="flex:1" ${S.busy ? "disabled" : ""}>＋ แชทใหม่</button><button class="rf" data-rfc>${S.loading.has("chats") ? "…" : "↻"}</button></div>
      ${S.chatsErr ? `<div class="mi-x warn">${esc(S.chatsErr)}</div>` : ""}
      ${c.length ? `<div class="mi-list">${c.map(x => `<button class="mi-row" data-chat="${esc(x.id)}"><span class="mi-r1"><span class="mi-sub" style="-webkit-line-clamp:1">${x.pinned ? "📌 " : ""}${esc(x.title)}</span><span class="t">${x.updatedAt ? ago(x.updatedAt) : ""}</span></span></button>`).join("")}</div>`
        : `<div class="mi-empty">ยังไม่มีแชท</div>`}`;
  }

  // conversation: shell drawn once (keeps the draft), messages redrawn on every poll
  const convShell = () => `<div class="mi-conv"><div class="mi-chead"><button data-back>← แชท</button><b></b><button data-rfm>↻</button></div>
    <div class="mi-msgs"></div><div class="mi-comp"><textarea rows="1" placeholder="พิมพ์ถึง agent ใน Mind…"></textarea><button data-send aria-label="ส่ง">↑</button></div></div>`;
  function drawConv() {
    const box = root.querySelector(".mi-msgs"); if (!box) return;
    const c = S.chat, main = root.closest("main");
    const atBottom = !main || main.scrollHeight - main.scrollTop - main.clientHeight < 80;
    root.querySelector(".mi-chead b").textContent = c?.title || (S.chats || []).find(x => x.id === S.open)?.title || "แชท";
    if (!c) { box.innerHTML = `<div class="mi-empty">${S.chatErr ? esc(S.chatErr) : "กำลังโหลด…"}</div>`; }
    else {
      const msgs = c.messages.filter(m => !(m.role === "oracle" && m.status === "pending"));
      box.innerHTML = (c.hidden ? `<div class="mi-x" style="text-align:center">ข้อความเก่ากว่านี้ ${c.hidden} ข้อความ — ดูบนเว็บ Mind</div>` : "")
        + msgs.map(m => `<div class="mi-m ${m.role} ${m.status === "error" ? "error" : ""}">${m.role === "oracle" ? `<span class="wh">${esc(c.agent || "agent")}${m.ts ? " · " + when(m.ts) : ""}</span>` : ""}
          <div class="bb">${m.status === "error" ? "⚠️ " : ""}${md(m.text)}</div>${m.files.length ? `<div class="fl">📎 ${m.files.map(esc).join(" · ")}</div>` : ""}</div>`).join("")
        + (thinking() ? `<div class="mi-think">กำลังคิด</div>` : "")
        + (S.chatErr ? `<div class="mi-x warn">${esc(S.chatErr)}</div>` : "")
        || `<div class="mi-empty">เริ่มคุยกับ agent ได้เลย</div>`;
    }
    root.querySelector("[data-send]").disabled = S.sending;
    if (atBottom && main) main.scrollTop = main.scrollHeight;
  }
  const thinking = () => !!S.chat && (S.chat.thinking || S.sending || (Date.now() < S.graceUntil && S.chat.messages.at(-1)?.role === "user"));

  // ── loading ──
  async function loadMail(fresh) {
    if (S.loading.has("mail")) return; S.loading.add("mail"); draw();
    try { S.mail = await api("/mind/mail" + (fresh ? "?fresh=1" : "")); S.mailErr = ""; S.mailAt = Date.now(); }
    catch (e) { S.mailErr = e.message; S.mailAt = Date.now(); }
    finally { S.loading.delete("mail"); draw(); mawExt.refreshTiles?.(); }
  }
  async function loadChats(fresh) {
    if (S.loading.has("chats")) return; S.loading.add("chats"); if (!S.open) draw();
    try { S.chats = (await api("/mind/chats" + (fresh ? "?fresh=1" : ""))).chats; S.chatsErr = ""; S.chatsAt = Date.now(); }
    catch (e) { S.chatsErr = e.message; S.chatsAt = Date.now(); }
    finally { S.loading.delete("chats"); if (!S.open) draw(); mawExt.refreshTiles?.(); }
  }
  async function loadChat(fresh) {
    const id = S.open; if (!id) return;
    try { const r = await api(`/mind/chats/${encodeURIComponent(id)}${fresh ? "?fresh=1" : ""}`); if (S.open === id) { S.chat = r.chat; S.chatErr = ""; } }
    catch (e) { if (S.open === id) S.chatErr = e.message; }
    if (S.open === id) { drawConv(); schedule(); }
  }
  // poll every 2 s while the agent is thinking and this chat is on screen; stops when leaving
  function schedule() {
    clearTimeout(S.pollT);
    if (!S.open || !root.isConnected || S.tab !== "chat" || !thinking()) return;
    S.pollT = setTimeout(() => { if (root.isConnected && !document.hidden) loadChat(true); else schedule(); }, 2000);
  }
  function openChat(id) { S.open = id; S.chat = null; S.chatErr = ""; S.graceUntil = 0; root.innerHTML = ""; draw(); loadChat(true); }

  // ── mail sheet ──
  async function openMail(id) {
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    bg.innerHTML = `<div class="sheet mi-sheet" style="position:relative"><div class="mi-empty">กำลังโหลด…</div></div>`;
    document.body.appendChild(bg);
    const close = () => { disarm(); bg.remove(); };
    bg.addEventListener("click", e => { if (e.target === bg) close(); });
    let m;
    try { m = (await api(`/mind/mail/${encodeURIComponent(id)}`)).mail; }
    catch (e) { bg.querySelector(".sheet").innerHTML = `<button class="cl" data-cl>✕</button><div class="mi-empty">${esc(e.message)}</div>`; bg.querySelector("[data-cl]").onclick = close; return; }
    const sheet = bg.querySelector(".sheet");
    const paint = () => {
      if (!bg.isConnected) return;
      sheet.innerHTML = `<button class="cl" data-cl aria-label="ปิด">✕</button><h2>${esc(m.subject)}</h2>
        <div class="mi-meta"><span>จาก <b>${esc(m.from)}</b> (${esc(m.fromOwner)})</span><span>ถึง <b>${esc(m.to)}</b> (${esc(m.toOwner)})</span>
          <span>${when(m.ts)} · <span class="mi-pill ${esc(m.status)}">${esc(m.statusText)}</span></span></div>
        ${m.held && m.status === "pending" ? `<div class="mi-held">⏸️ agent ค้างไว้ให้คุณตัดสินใจ: ${esc(m.held)}</div>` : ""}
        <div class="mi-body">${esc(m.body) || "(ไม่มีเนื้อหา)"}</div>
        ${m.actions.length ? `<div class="mi-acts">${m.actions.map(op => { const k = `act:${m.id}:${op}`; return `<button class="${OPS[op][1]} ${isArmed(k) ? "armed" : ""}" data-op="${op}" ${S.busy ? "disabled" : ""}>${isArmed(k) ? "แตะอีกครั้งเพื่อยืนยัน" : OPS[op][0]}</button>`; }).join("")}</div>
          <div class="mi-x">${m.actions.includes("retry") ? "คุณอนุมัติไปแล้วแต่ agent ตอบไม่สำเร็จ — แตะเพื่อส่งให้ตอบอีกครั้ง" : "อนุมัติแล้ว agent ของคุณจะร่างคำตอบส่งกลับให้เจ้าของผู้ส่ง"}</div>` : ""}
        ${m.parent || m.replies.length ? `<div class="mi-thr">${m.parent ? `<button data-go="${esc(m.parent.id)}">↩ ตอบจดหมาย: ${esc(m.parent.subject)}</button>` : ""}${m.replies.map(r => `<button data-go="${esc(r.id)}">↪ ${esc(r.subject)} · ${esc(r.status)}</button>`).join("")}</div>` : ""}`;
      sheet.querySelector("[data-cl]").onclick = close;
      sheet.querySelectorAll("[data-go]").forEach(b => b.onclick = () => { close(); openMail(b.dataset.go); });
      sheet.querySelectorAll("[data-op]").forEach(b => b.onclick = () => act(b.dataset.op));
    };
    async function act(op) {
      const k = `act:${m.id}:${op}`;
      if (S.busy) return;
      if (!isArmed(k)) return arm(k, paint);
      disarm(); S.busy = true; paint();
      try { await api(`/mind/mail/${encodeURIComponent(m.id)}/act`, { method: "POST", body: JSON.stringify({ op }) }); toast(op === "approve" ? "อนุมัติแล้ว · agent กำลังตอบ" : op === "reject" ? "ปฏิเสธแล้ว" : "ส่งให้ agent ตอบใหม่แล้ว"); close(); }
      catch (e) { toast(e.message); }
      finally { S.busy = false; if (bg.isConnected) paint(); loadMail(true); }
    }
    paint();
  }

  // ── taps ──
  root.addEventListener("click", async e => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.tab) { S.tab = t.dataset.tab; disarm(); clearTimeout(S.pollT); root.innerHTML = ""; draw(); if (S.tab === "chat") { if (!S.chats || Date.now() - S.chatsAt > 20_000) loadChats(false); if (S.open) loadChat(true); } return; }
    if (t.dataset.flt) { S.filter = t.dataset.flt; S.shown = 40; return draw(); }
    if (t.hasAttribute("data-more")) { S.shown += 40; return draw(); }
    if (t.hasAttribute("data-rf")) return loadMail(true);
    if (t.hasAttribute("data-rfc")) return loadChats(true);
    if (t.dataset.mail) return openMail(t.dataset.mail);
    if (t.dataset.chat) return openChat(t.dataset.chat);
    if (t.hasAttribute("data-back")) { S.open = null; S.chat = null; clearTimeout(S.pollT); root.innerHTML = ""; draw(); return loadChats(false); }
    if (t.hasAttribute("data-rfm")) return loadChat(true);
    if (t.dataset.mode) {
      const mode = t.dataset.mode; if (S.busy || !S.mail || mode === S.mail.mode) return;
      if (!isArmed("mode:" + mode)) return arm("mode:" + mode, draw);
      disarm(); S.busy = true; draw();
      try { const r = await api("/mind/mail/mode", { method: "POST", body: JSON.stringify({ mode }) }); S.mail.mode = r.mode; toast(`โหมด${MODES.find(m => m[0] === r.mode)?.[1] || r.mode}แล้ว${r.delivered ? ` · ส่งให้ agent ตอบ ${r.delivered} ฉบับ` : ""}`); }
      catch (err) { toast(err.message); }
      finally { S.busy = false; loadMail(true); }
      return;
    }
    if (t.hasAttribute("data-newchat")) {
      if (S.busy) return; S.busy = true; draw();
      try { const r = await api("/mind/chats", { method: "POST", body: "{}" }); S.busy = false; openChat(r.id); loadChats(true); }
      catch (err) { S.busy = false; toast(err.message); draw(); }
      return;
    }
    if (t.hasAttribute("data-send")) {
      const ta = root.querySelector(".mi-comp textarea"), text = ta.value.trim(), id = S.open;
      if (!text || S.sending || !id) return;
      S.sending = true; ta.value = ""; ta.style.height = "";
      if (S.chat) S.chat.messages.push({ id: "local", role: "user", status: "done", ts: Date.now(), text, files: [] });
      drawConv(); const main = root.closest("main"); if (main) main.scrollTop = main.scrollHeight;
      try { await api(`/mind/chats/${encodeURIComponent(id)}/send`, { method: "POST", body: JSON.stringify({ text }) }); S.graceUntil = Date.now() + 20_000; }
      catch (err) { toast("ส่งไม่ได้: " + err.message); if (S.open === id) { ta.value = text; if (S.chat) S.chat.messages = S.chat.messages.filter(m => m.id !== "local"); } }
      finally { S.sending = false; if (S.open === id) loadChat(true); }
    }
  });
  root.addEventListener("input", e => { if (e.target.matches(".mi-comp textarea")) { e.target.style.height = "auto"; e.target.style.height = Math.min(140, e.target.scrollHeight) + "px"; } });

  // ── home tile + own screen ──
  mawExt.pages.push({
    key: "mind", icon: "🧠", title: "Mind",
    summary() {
      if (!S.mail && !S.chats) return { text: S.mailErr ? "ต่อ Mind ไม่ได้" : "กำลังโหลด…" };
      const w = S.mail?.waiting || 0;
      return { text: [S.mail ? `📬 ${w} รอ` : "📬 —", S.chats ? `💬 ${S.chats.length} แชท` : ""].filter(Boolean).join(" · "), badge: w ? String(w) : "", tone: "" };
    },
    mount(el) {
      el.appendChild(root); root.innerHTML = ""; draw();
      if (Date.now() - S.mailAt > 20_000) loadMail(false);
      if (S.tab === "chat") { if (S.open) loadChat(true); else loadChats(false); }
    },
  });
  // a push "📬 Mind" carries ?open=mind — open this page instead of looking for a room with that id
  if (typeof window.openSession === "function" && typeof window.renderPage === "function") {
    const orig = window.openSession;
    window.openSession = sid => { if (sid !== "mind") return orig(sid); history.pushState({ v: "pg" }, ""); S.tab = "mail"; S.filter = "me"; renderPage("mind"); };
  }
  loadMail(false); loadChats(false);
  setInterval(() => { if (!document.hidden && !S.busy && Date.now() - S.mailAt > (root.isConnected ? 60_000 : 120_000)) { loadMail(false); if (!root.isConnected) loadChats(false); } }, 15_000);
})();
