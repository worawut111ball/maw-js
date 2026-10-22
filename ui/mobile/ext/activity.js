// Phone UI pack "activity" (PLAN-maw-mobile.md §9, P3): the agent's todo list + background work still running.
// Todos: one line under the room title ("☑ 3/7 · กำลัง: …"), tap → checklist.
// Running work (agents / shells / monitors): a floating circle at the bottom right with a count; tap → fans out,
// tap an item → jump to its card in the chat. (พี่ Ball 22 ต.ค. 69: "วงกลมลอยๆ ขวาล่าง … กดกระจายออกมาให้เลือกดู")
// Data: GET /mobile/rooms/:ws/:room/activity?agent=&sid=  →  { todos:[{content,status,activeForm}], running:[{kind,label,since,id}] }
(() => {
  const POLL_MS = 5000;
  const KIND = { shell: ["⚙", "shell"], agent: ["🤖", "agent"], monitor: ["👁", "monitor"] };
  const S = { key: "", data: null, at: 0, busy: false, open: store.get("maw-act-open") === "1", tick: null };

  const style = document.createElement("style");
  style.textContent = `
  #act-box { margin: 6px 12px 0; }
  #act-box .act-bar { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px; padding: 4px 10px; border-radius: 10px;
    background: var(--card); border: 1px solid var(--line); color: var(--text); font: 12.5px/1.3 var(--font); text-align: left; cursor: pointer; }
  #act-box .act-bar:active { background: var(--card2); }
  #act-box .act-cnt { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; }
  #act-box .act-cnt.all { color: var(--working); }
  #act-box .act-now { flex: 1; min-width: 0; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #act-box .act-now b { color: var(--text); font-weight: 500; }
  #act-box .act-chips { flex: none; display: flex; gap: 4px; }
  #act-box .act-chip { padding: 1px 7px; border-radius: 999px; background: var(--card2); color: var(--text); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  #act-box .act-chip.agent { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); }
  #act-box .act-chev { flex: none; color: var(--dim); transition: transform .18s; font-size: 11px; }
  #act-box.open .act-chev { transform: rotate(180deg); }
  #act-box .act-panel { margin-top: 4px; max-height: 42vh; overflow: auto; overscroll-behavior: contain; padding: 6px 4px 8px; border-radius: 12px;
    background: var(--card); border: 1px solid var(--line); font: 13.5px/1.45 var(--font); }
  #act-box .act-h { color: var(--dim); font-size: 11.5px; letter-spacing: .05em; margin: 4px 8px 2px; }
  #act-box ul { list-style: none; margin: 0; padding: 0; }
  #act-box li { display: flex; gap: 8px; align-items: flex-start; padding: 5px 8px; border-radius: 8px; }
  #act-box li .ic { flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; }
  #act-box li .tx { flex: 1; min-width: 0; word-break: break-word; }
  #act-box li.completed .ic { background: color-mix(in srgb, var(--working) 22%, transparent); color: var(--working); }
  #act-box li.completed .tx { color: var(--dim); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--dim) 60%, transparent); }
  #act-box li.pending .ic { border: 1.5px solid var(--idle); }
  #act-box li.pending .tx { color: var(--dim); }
  #act-box li.in_progress { background: color-mix(in srgb, var(--accent) 12%, transparent); animation: act-pulse 2.2s ease-in-out infinite; }
  #act-box li.in_progress .ic { border: 1.5px solid var(--accent); }
  #act-box li.in_progress .ic::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  #act-box li.in_progress .tx { color: var(--text); font-weight: 500; }
  #act-box li .sub2 { display: block; color: var(--accent); font-size: 12px; font-weight: 400; }
  #act-box li.run .ic { font-size: 13px; }
  #act-box li.run .el { flex: none; color: var(--dim); font: 12px var(--mono); margin-top: 1px; }
  @keyframes act-pulse { 50% { background: color-mix(in srgb, var(--accent) 22%, transparent); } }
  #act-fab { position: fixed; right: 14px; z-index: 40; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  #act-fab[hidden] { display: none; }
  #act-fab .fab { position: relative; width: 52px; height: 52px; padding: 0; overflow: visible; border-radius: 50%; background: #05060a; border: 1.5px solid #7c3aed; color: #e9d5ff; font-size: 22px; display: grid; place-items: center; box-shadow: 0 6px 22px #000a; }
  #act-fab .fab::before { content: ""; position: absolute; inset: -5px; border-radius: 50%; border: 2px solid transparent; border-top-color: #a78bfa; border-right-color: #f472b6; animation: act-spin 1.4s linear infinite; }
  #act-fab .fab img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
  #act-fab .fab .n { position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 99px; background: #f472b6; color: #1b0a14; font: 700 12px/20px var(--font); text-align: center; }
  #act-fab .items { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; max-height: 55vh; overflow-y: auto; }
  #act-fab .it { display: flex; align-items: center; gap: 8px; max-width: 78vw; padding: 7px 12px; border-radius: 999px; background: var(--card); border: 1px solid #3b2a66; color: var(--text); font: 13px var(--font); box-shadow: 0 4px 16px #0009; animation: act-pop .16s ease-out backwards; }
  #act-fab .it .l { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #act-fab .it .el { flex: none; color: var(--dim); font: 11.5px var(--mono); }
  #act-dim { position: fixed; inset: 0; z-index: 39; background: #0007; }
  @keyframes act-spin { to { transform: rotate(360deg); } }
  @keyframes act-pop { from { opacity: 0; transform: translateY(10px) scale(.9); } }
  @media (prefers-reduced-motion: reduce) { #act-fab .fab::before { animation: none; } }
  @media (prefers-reduced-motion: reduce) { #act-box li.in_progress { animation: none; } #act-box .act-chev { transition: none; } }`;
  document.head.appendChild(style);

  const keyOf = (w, room) => `${w.id}/${room.id}/${room.agent}/${room.claudeSessionId || ""}`;
  const ago = since => {
    const t = Date.parse(since || "");
    if (!Number.isFinite(t)) return "";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  };

  function box() {
    const top = document.getElementById("ext-room-top");
    if (!top) return null;
    let b = document.getElementById("act-box");
    if (!b) { b = document.createElement("div"); b.id = "act-box"; top.appendChild(b); }
    return b;
  }

  function draw() {
    const b = box();
    if (!b) return;
    const d = S.data;
    const todos = d?.todos || [], running = d?.running || [];
    drawFab(running);
    if (!todos.length) { b.hidden = true; b.innerHTML = ""; return; }
    b.hidden = false;
    b.classList.toggle("open", S.open);
    const done = todos.filter(t => t.status === "completed").length;
    const cur = todos.find(t => t.status === "in_progress");
    const counts = {};
    for (const r of running) counts[r.kind] = (counts[r.kind] || 0) + 1;
    const chips = ""; // running work lives in the floating circle now
    const now = cur ? `กำลัง: <b>${esc(cur.activeForm || cur.content)}</b>`
      : todos.length && done === todos.length ? "เสร็จครบแล้ว"
      : todos.length ? "รอทำต่อ" : `งานเบื้องหลัง ${running.length} รายการ`;
    const bar = `<button class="act-bar" type="button" aria-expanded="${S.open}" aria-label="รายการงานของ agent">
      ${todos.length ? `<span class="act-cnt ${done === todos.length ? "all" : ""}">☑ ${done}/${todos.length}</span>` : ""}
      <span class="act-now">${now}</span><span class="act-chips">${chips}</span><span class="act-chev">▾</span></button>`;
    let panel = "";
    if (S.open) {
      const list = todos.map(t => `<li class="${esc(t.status)}"><span class="ic">${t.status === "completed" ? "✓" : ""}</span>
        <span class="tx">${esc(t.content)}${t.status === "in_progress" && t.activeForm && t.activeForm !== t.content ? `<span class="sub2">${esc(t.activeForm)}</span>` : ""}</span></li>`).join("");
      const runs = running.map(r => `<li class="run"><span class="ic">${(KIND[r.kind] || ["•"])[0]}</span>
        <span class="tx">${esc(r.label || (KIND[r.kind] || [, r.kind])[1])}</span><span class="el">${ago(r.since)}</span></li>`).join("");
      panel = `<div class="act-panel">${todos.length ? `<div class="act-h">รายการงาน · เสร็จ ${done} จาก ${todos.length}</div><ul>${list}</ul>` : ""}
        </div>`;
    }
    const keep = b.querySelector(".act-panel")?.scrollTop || 0;
    b.innerHTML = bar + panel;
    const p = b.querySelector(".act-panel"); if (p) p.scrollTop = keep;
    b.querySelector(".act-bar").onclick = () => { S.open = !S.open; store.set("maw-act-open", S.open ? "1" : "0"); draw(); syncTick(); };
  }

  // floating circle (bottom right, above the send button) for running agents / shells / monitors
  function fabEl() {
    let f = document.getElementById("act-fab");
    if (!f) { f = document.createElement("div"); f.id = "act-fab"; f.hidden = true; document.body.appendChild(f); }
    return f;
  }
  function placeFab(f) {
    const keys = document.querySelector(".keys") || document.querySelector(".composer");
    const top = keys ? keys.getBoundingClientRect().top : window.innerHeight - 140;
    f.style.bottom = Math.max(90, window.innerHeight - top + 10) + "px";
  }
  function closeFan() { S.fan = false; document.getElementById("act-dim")?.remove(); drawFab(S.data?.running || []); }
  function drawFab(running) {
    const f = fabEl();
    if (!running.length || !document.getElementById("screen")) { f.hidden = true; f.innerHTML = ""; S.fan = false; document.getElementById("act-dim")?.remove(); return; }
    f.hidden = false; placeFab(f);
    const items = S.fan ? `<div class="items">${running.map((r, i) => `<button class="it" data-i="${i}" style="animation-delay:${(running.length - i) * 25}ms">
        <span>${(KIND[r.kind] || ["•"])[0]}</span><span class="l">${esc(r.label || (KIND[r.kind] || [, r.kind])[1])}</span><span class="el">${ago(r.since)}</span></button>`).join("")}</div>` : "";
    f.innerHTML = items + `<button class="fab" aria-label="งานที่กำลังรัน ${running.length} รายการ"><img src="/icon-192.png" alt=""><span class="n">${running.length}</span></button>`;
    f.querySelector(".fab").onclick = () => {
      S.fan = !S.fan;
      if (S.fan) { const d = document.createElement("div"); d.id = "act-dim"; d.onclick = closeFan; document.body.appendChild(d); } else document.getElementById("act-dim")?.remove();
      drawFab(S.data?.running || []); syncTick();
    };
    f.querySelectorAll("[data-i]").forEach(b => b.onclick = () => {
      const r = running[+b.dataset.i]; closeFan();
      // jump to that card in the chat and open it
      const label = String(r?.label || "").slice(0, 40);
      const card = [...document.querySelectorAll("#screen details.tool")].reverse().find(d => label && d.querySelector("summary")?.textContent.includes(label));
      if (card) { card.closest("details.tgroup")?.setAttribute("open", ""); card.open = true; card.scrollIntoView({ block: "center", behavior: "smooth" }); state.follow = false; }
      else toast("การ์ดนี้อยู่ในข้อความเก่า — เลื่อนขึ้นไปดูได้");
    });
  }
  mawExt.onHome.push(() => { const f = document.getElementById("act-fab"); if (f) { f.hidden = true; f.innerHTML = ""; } document.getElementById("act-dim")?.remove(); S.fan = false; });
  setInterval(() => { const f = document.getElementById("act-fab"); if (f && !f.hidden && !document.getElementById("screen")) { f.hidden = true; document.getElementById("act-dim")?.remove(); S.fan = false; } }, 1000);
  window.addEventListener("resize", () => { const f = document.getElementById("act-fab"); if (f && !f.hidden) placeFab(f); });

  // elapsed times tick while the panel is open and something is running
  function syncTick() {
    const want = S.fan && S.data?.running?.length;
    if (want && !S.tick) S.tick = setInterval(() => { if (!document.getElementById("act-fab")?.querySelector(".it")) { clearInterval(S.tick); S.tick = null; return; }
      document.querySelectorAll("#act-fab .it .el").forEach((el, i) => { const r = S.data?.running?.[i]; if (r) el.textContent = ago(r.since); }); }, 1000);
    if (!want && S.tick) { clearInterval(S.tick); S.tick = null; }
  }

  async function load(w, room, force) {
    if (!room || !["claude", "codex"].includes(room.agent)) { S.key = ""; S.data = null; draw(); return; }
    const key = keyOf(w, room);
    if (key !== S.key) { S.key = key; S.data = null; S.at = 0; draw(); }
    if (S.busy || (!force && Date.now() - S.at < POLL_MS)) return;
    S.busy = true; S.at = Date.now();
    try {
      const r = await api(`/rooms/${encodeURIComponent(w.id)}/${encodeURIComponent(room.id)}/activity?${qs({ agent: room.agent, sid: room.claudeSessionId || "" })}`);
      if (S.key !== key) return;                                   // switched rooms meanwhile
      S.data = { todos: r.todos || [], running: r.running || [] };
      draw(); syncTick();
    } catch { /* keep the last picture; next poll retries */ }
    finally { S.busy = false; }
  }

  // room view redrawn → put the last known state back at once (no flash), then refresh if stale
  mawExt.onRoom.push(({ w, room }) => {
    if (room && keyOf(w, room) === S.key) draw();
    load(w, room, false);
  });
  mawExt.onPoll.push(({ w, room }) => load(w, room, false));
})();
