// Phone UI pack "resume" (P4 · PLAN-maw-mobile.md §9) — tab "🕘 ห้องเก่า": list past Claude sessions of the
// selected Superset workspace and reopen one (`claude --resume`) in a new room.
(() => {
  const css = `
  .rs-top { position: sticky; top: -8px; z-index: 2; background: var(--bg); padding: 8px 0 6px; display: flex; gap: 8px; align-items: center; }
  .rs-q { flex: 1; min-width: 0; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); background: var(--card); color: var(--text); font: 15px var(--font, inherit); }
  .rs-q:focus { outline: none; border-color: var(--accent); }
  .rs-rf { flex: none; width: 42px; height: 42px; border-radius: 12px; background: var(--card2); color: var(--dim); font-size: 17px; }
  .rs-note { color: var(--dim); font-size: 12px; padding: 0 2px 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
  .rs-card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 12px 13px; margin: 8px 0; }
  .rs-card.live { border-color: #14532d; }
  .rs-t { font-weight: 650; font-size: 15px; line-height: 1.35; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .rs-p { color: var(--dim); font-size: 13px; line-height: 1.4; margin-top: 4px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .rs-m { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .rs-meta { color: var(--dim); font-size: 12.5px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rs-live { flex: none; display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px; border-radius: 999px; background: #052e16; color: #4ade80; font-size: 12.5px; font-weight: 600; }
  .rs-live::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 3px #22c55e33; }
  .rs-go { flex: none; padding: 8px 14px; border-radius: 10px; background: var(--accent); color: #031022; font-weight: 700; font-size: 13.5px; min-height: 36px; }
  .rs-go.armed { background: #f59e0b; }
  .rs-go:disabled { opacity: .55; }
  .rs-more { display: block; margin: 10px auto 0; color: var(--dim); font-size: 12.5px; }
  `;
  if (!document.getElementById("rs-style")) {
    const st = document.createElement("style"); st.id = "rs-style"; st.textContent = css; document.head.appendChild(st);
  }

  const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const hhmm = d => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  /** "เมื่อสักครู่" · "5 นาทีก่อน" · "3 ชม.ก่อน" · "เมื่อวาน 14:20" · "4 วันก่อน" · "12 ต.ค. 14:20" · "12 ต.ค. 68" */
  function relTime(ms, now = Date.now()) {
    const d = new Date(ms), diff = Math.max(0, now - ms), min = Math.floor(diff / 60e3);
    if (min < 1) return "เมื่อสักครู่";
    if (min < 60) return `${min} นาทีก่อน`;
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    if (ms >= today.getTime()) return `${Math.floor(min / 60)} ชม.ก่อน`;
    if (ms >= today.getTime() - 864e5) return `เมื่อวาน ${hhmm(d)}`;
    if (ms >= today.getTime() - 6 * 864e5) return `${Math.ceil((today.getTime() - ms) / 864e5)} วันก่อน`;
    if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hhmm(d)}`;
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getFullYear() + 543).slice(-2)}`;
  }
  const size = b => b >= 1e6 ? (b / 1e6).toFixed(b >= 1e7 ? 0 : 1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB";

  const cache = new Map(); // ws id → { cwd, sessions, at }
  let query = "";

  /** Jump to a room by its Superset terminal id, wherever it lives. */
  function openRoom(terminalId) {
    for (const p of state.projects) for (const w of p.workspaces) {
      if (w.rooms.some(r => r.id === terminalId)) {
        state.project = p.name; state.ws = w.id; state.room = terminalId; state.pview = "rooms"; renderProject(); return true;
      }
    }
    return false;
  }

  function cardHtml(s) {
    const head = s.title || s.preview || "(ไม่มีข้อความ)";
    const sub = s.title && s.preview ? s.preview : "";
    const meta = [relTime(s.mtime), `${s.approx ? "~" : ""}${Number(s.messages).toLocaleString("th-TH")} ข้อความ`, size(s.size)].join(" · ");
    const act = s.live
      ? `<button class="rs-live" data-live="${esc(s.liveTerminalId || "")}">กำลังเปิดอยู่</button>`
      : `<button class="rs-go" data-go="${esc(s.sessionId)}">เปิดคุยต่อ</button>`;
    return `<div class="rs-card ${s.live ? "live" : ""}"><div class="rs-t">${esc(head)}</div>${sub ? `<div class="rs-p">${esc(sub)}</div>` : ""}
      <div class="rs-m"><span class="rs-meta">${esc(meta)}</span>${act}</div></div>`;
  }

  function draw(w, el, data) {
    const q = query.trim().toLowerCase();
    const list = data.sessions.filter(s => !q || `${s.title || ""} ${s.preview || ""}`.toLowerCase().includes(q));
    let box = el.querySelector("#rs-list");
    if (!box) {
      el.innerHTML = `<div class="rs-top"><input class="rs-q" id="rs-q" type="search" placeholder="ค้นหาชื่อหรือข้อความ" autocomplete="off" enterkeyhint="search" /><button class="rs-rf" id="rs-rf" aria-label="โหลดใหม่">↻</button></div>
        <div class="rs-note" id="rs-note"></div><div id="rs-list"></div>`;
      const qi = el.querySelector("#rs-q"); qi.value = query;
      qi.oninput = () => { query = qi.value; draw(w, el, cache.get(w.id) || data); };
      el.querySelector("#rs-rf").onclick = () => fetchAndDraw(w, el, true);
      box = el.querySelector("#rs-list");
    }
    el.querySelector("#rs-note").textContent = data.sessions.length ? `${data.sessions.length} ห้องล่าสุด · ${data.cwd}` : data.cwd || "";
    if (!data.sessions.length) { box.innerHTML = `<div class="empty">ยังไม่มีห้อง Claude เก่าใน workspace นี้</div>`; return; }
    box.innerHTML = list.map(cardHtml).join("") || `<div class="empty">ไม่พบห้องที่ตรงกับ “${esc(query)}”</div>`;
    box.querySelectorAll("[data-live]").forEach(b => b.onclick = () => {
      if (!b.dataset.live || !openRoom(b.dataset.live)) toast("ห้องนี้เปิดอยู่นอก Superset — เปิดจากหน้าแรกแทน");
    });
    box.querySelectorAll("[data-go]").forEach(b => b.onclick = () => resume(w, el, b));
  }

  async function resume(w, el, b) {
    if (!b.classList.contains("armed")) {
      for (const x of el.querySelectorAll(".rs-go.armed")) { x.classList.remove("armed"); x.textContent = "เปิดคุยต่อ"; }
      b.classList.add("armed"); b.textContent = "แตะอีกครั้งเพื่อยืนยัน";
      clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove("armed"); b.textContent = "เปิดคุยต่อ"; }, 4000);
      return;
    }
    clearTimeout(b._t); b.disabled = true; b.textContent = "กำลังเปิด…";
    try {
      const r = await api(`/workspaces/${encodeURIComponent(w.id)}/resume`, { method: "POST", body: JSON.stringify({ sessionId: b.dataset.go }) });
      toast("เปิดห้องเก่าแล้ว");
      // the new terminal shows up in the Superset snapshot a moment later
      for (let i = 0; i < 6; i++) {
        await load();
        const ww = state.projects.find(x => x.name === state.project)?.workspaces.find(x => x.id === w.id);
        if (!r.terminalId || ww?.rooms.some(x => x.id === r.terminalId)) break;
        await new Promise(res => setTimeout(res, 700));
      }
      cache.delete(w.id);
      state.ws = w.id; state.room = r.terminalId || state.room; state.pview = "rooms"; renderProject();
    } catch (e) {
      toast("เปิดไม่ได้: " + e.message);
      b.disabled = false; b.classList.remove("armed"); b.textContent = "เปิดคุยต่อ";
      fetchAndDraw(w, el, true);
    }
  }

  async function fetchAndDraw(w, el, manual) {
    const rf = el.querySelector("#rs-rf"); if (rf) rf.disabled = true;
    try {
      const d = await api(`/workspaces/${encodeURIComponent(w.id)}/sessions`);
      const data = { cwd: d.cwd, sessions: d.sessions || [], at: Date.now() };
      cache.set(w.id, data);
      if (el.isConnected && state.pview === "resume" && state.ws === w.id) draw(w, el, data);
      if (manual) toast("อัปเดตแล้ว");
    } catch (e) {
      if (el.isConnected && !cache.get(w.id)) el.innerHTML = `<div class="empty">โหลดไม่ได้: ${esc(e.message)}</div>`;
      else toast("โหลดไม่ได้: " + e.message);
    } finally { if (rf) rf.disabled = false; }
  }

  mawExt.tabs.push({
    key: "resume",
    label: "🕘 ห้องเก่า",
    render(w, el) {
      if (!w) { el.innerHTML = `<div class="empty">ไม่มี workspace</div>`; return; }
      const hit = cache.get(w.id);
      if (hit) draw(w, el, hit); else el.innerHTML = `<div class="empty">กำลังโหลดห้องเก่า…</div>`;
      if (!hit || Date.now() - hit.at > 5_000) fetchAndDraw(w, el, false);
    },
  });

  window.mawResume = { relTime }; // handy for poking from the console
})();
