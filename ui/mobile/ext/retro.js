// Phone UI pack "retro" — home card "📝 สรุปงาน": run /rrr or /mind-rrr in a live Claude room, mode แมนนวล / กึ่งออโต้ / ออโต้.
// Server: GET /retro · POST /retro/settings · POST /retro/run  (src/mobile/features/retro.ts)
// Home is redrawn every ~2.5 s, so everything here paints from cache and keeps its own state (armed button, open/closed).
(() => {
  if (!window.mawExt) return;
  const R = { data: null, at: 0, inflight: false, busy: false, armed: "", armedT: 0, open: true };
  try { R.open = localStorage.getItem("maw-retro-open") !== "0"; } catch { /* private mode */ }
  const EVERY_OPEN = 15_000, EVERY_CLOSED = 60_000;

  const css = `
  .rt { background: var(--card); border: 1px solid var(--line); border-radius: 16px; margin: 0 0 10px; overflow: hidden; }
  .rt-h { display: flex; align-items: center; gap: 8px; width: 100%; padding: 11px 13px; text-align: left; font: 650 14.5px var(--font); color: var(--text); }
  .rt-h .m { color: var(--dim); font-weight: 500; font-size: 12.5px; }
  .rt-h .bd { margin-left: auto; flex: none; padding: 2px 8px; border-radius: 999px; background: #f59e0b26; color: #fbbf24; font-size: 11.5px; font-weight: 700; }
  .rt-h .cv { flex: none; color: var(--dim); transition: transform .15s; } .rt.open .rt-h .cv { transform: rotate(90deg); }
  .rt-b { padding: 0 12px 12px; display: none; } .rt.open .rt-b { display: block; }
  .rt-seg { display: flex; gap: 2px; padding: 3px; background: var(--card2); border-radius: 10px; }
  .rt-seg button { flex: 1; padding: 7px 4px; border-radius: 7px; color: var(--dim); font: 600 13px var(--font); }
  .rt-seg button.on { background: var(--card); color: var(--text); box-shadow: 0 1px 3px #0006; }
  .rt-seg button.on.auto { color: #fbbf24; }
  .rt-x { color: var(--dim); font-size: 12px; line-height: 1.45; margin: 6px 2px 8px; }
  .rt-l { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 6px 0; font-size: 12px; color: var(--dim); }
  .rt-l .k { min-width: 46px; }
  .rt-c { padding: 4px 10px; border-radius: 999px; background: var(--card2); color: var(--dim); font: 600 12.5px var(--font); }
  .rt-c.on { background: var(--accent); color: #031022; }
  .rt-c:disabled { opacity: .45; text-decoration: line-through; }
  .rt-rs { margin-top: 8px; border-top: 1px solid var(--line); }
  .rt-r { display: flex; align-items: center; gap: 9px; padding: 9px 0; border-bottom: 1px solid var(--line); }
  .rt-r:last-child { border-bottom: 0; padding-bottom: 0; }
  .rt-r .n { flex: 1; min-width: 0; } .rt-r .n b { display: block; font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rt-r .n span { display: block; color: var(--dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .rt-r .n span.due { color: #fbbf24; }
  .rt-go { flex: none; min-height: 32px; padding: 0 11px; border-radius: 9px; background: var(--card2); border: 1px solid var(--line); color: var(--text); font: 700 12.5px var(--font); white-space: nowrap; }
  .rt-go.due { background: var(--accent); border-color: var(--accent); color: #031022; }
  .rt-go.armed { background: #f59e0b; border-color: #f59e0b; color: #1a1003; }
  .rt-go:disabled { opacity: .45; }
  .rt-none { color: var(--dim); font-size: 12.5px; padding: 10px 0 0; }`;
  if (!document.getElementById("rt-style")) { const s = document.createElement("style"); s.id = "rt-style"; s.textContent = css; document.head.appendChild(s); }

  const MODES = [["manual", "แมนนวล"], ["semi", "กึ่งออโต้"], ["auto", "ออโต้"]];
  const hhmm = d => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const when = ms => { const d = new Date(ms), t = new Date(); return d.toDateString() === t.toDateString() ? hhmm(d) : `${d.getDate()} ${MONTHS[d.getMonth()]} ${hhmm(d)}`; };
  const dur = m => m >= 60 ? `${Math.floor(m / 60)} ชม.${m % 60 >= 10 ? ` ${m % 60} น.` : ""}` : `${m} นาที`;
  const explain = s => s.mode === "manual" ? "กดสั่งเองจากรายการห้องด้านล่าง — ไม่มีอะไรอัตโนมัติ"
    : s.mode === "semi" ? `แจ้งเตือนเมื่อห้องทำงานครบ ${s.minMinutes} นาทีแล้วว่าง ${s.idleMinutes} นาที — แตะแล้วสั่งเอง`
    : `สั่ง /${s.skill} ให้เองเมื่อห้องทำงานครบ ${s.minMinutes} นาทีแล้วว่าง ${s.idleMinutes} นาที · ไม่สั่งตอนกำลังทำ / มีหน้าถาม / มีข้อความค้างในช่อง`;
  const blocked = r => r.status === "working" ? "กำลังทำงาน" : r.status === "waiting" ? "รอคำตอบ" : r.status === "ended" ? "ปิดแล้ว" : "";

  function html(d) {
    const s = d.settings, avail = Object.fromEntries((d.skills || []).map(k => [k.name, k.available]));
    const due = d.rooms.filter(r => r.due).length;
    const rooms = d.rooms.map(r => {
      const why = blocked(r), armed = R.armed === r.sessionId && Date.now() < R.armedT;
      const meta = [r.workedMin ? `ทำงานไป ${dur(r.workedMin)}` : "ยังไม่มีงานใหม่", r.lastRetroAt ? `สรุปล่าสุด ${when(r.lastRetroAt)}` : "ยังไม่เคยสรุป"].join(" · ");
      return `<div class="rt-r"><span class="dot s-${esc(r.status)}"></span><div class="n"><b>${esc(r.label)}${r.project && r.project !== r.label ? ` · ${esc(r.project)}` : ""}</b>
        <span class="${r.due ? "due" : ""}">${esc(r.due ? "⏰ ถึงเวลาสรุป · " + meta : meta)}</span></div>
        <button class="rt-go ${r.due ? "due" : ""} ${armed ? "armed" : ""}" data-rt="${esc(r.sessionId)}" ${why || !r.ws || !avail[s.skill] ? "disabled" : ""}>${why ? esc(why) : !r.ws ? "สั่งไม่ได้" : armed ? "แตะอีกครั้ง" : `สั่ง /${esc(s.skill)}`}</button></div>`;
    }).join("");
    return `<button class="rt-h" id="rt-h"><span>📝 สรุปงาน</span><span class="m">(${esc(s.skill)} · ${esc(MODES.find(m => m[0] === s.mode)?.[1] || s.mode)})</span>${due ? `<span class="bd">${due} ถึงเวลา</span>` : ""}<span class="cv" ${due ? "" : 'style="margin-left:auto"'}>›</span></button>
      <div class="rt-b">
        <div class="rt-seg">${MODES.map(([k, l]) => `<button class="${s.mode === k ? "on" : ""} ${k}" data-mode="${k}">${l}</button>`).join("")}</div>
        <div class="rt-x">${esc(explain(s))}</div>
        <div class="rt-l"><span class="k">skill</span>${(d.skills || []).map(k => `<button class="rt-c ${s.skill === k.name ? "on" : ""}" data-skill="${esc(k.name)}" ${k.available ? "" : 'disabled title="ไม่มี skill นี้ในเครื่อง"'}>${esc(k.name)}${k.available ? "" : " · ไม่มี"}</button>`).join("")}</div>
        ${s.mode !== "manual" ? `<div class="rt-l"><span class="k">ทำงานครบ</span>${[15, 30, 60, 90].map(n => `<button class="rt-c ${s.minMinutes === n ? "on" : ""}" data-min="${n}">${n} น.</button>`).join("")}</div>
        <div class="rt-l"><span class="k">ว่าง</span>${[5, 10, 20, 30].map(n => `<button class="rt-c ${s.idleMinutes === n ? "on" : ""}" data-idle="${n}">${n} น.</button>`).join("")}</div>` : ""}
        <div class="rt-rs">${rooms || `<div class="rt-none">ไม่มีห้อง Claude ที่เปิดอยู่</div>`}</div>
      </div>`;
  }

  function paint() {
    const slot = document.getElementById("ext-home");
    if (!slot || !R.data) return;
    let card = slot.querySelector(".rt");
    if (!card) { card = document.createElement("div"); card.className = "rt"; slot.prepend(card); }
    card.classList.toggle("open", R.open);
    card.innerHTML = html(R.data);
    card.querySelector("#rt-h").onclick = () => { R.open = !R.open; try { localStorage.setItem("maw-retro-open", R.open ? "1" : "0"); } catch {} paint(); if (R.open) refresh(); };
    card.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => saveSettings({ mode: b.dataset.mode }));
    card.querySelectorAll("[data-skill]").forEach(b => b.onclick = () => saveSettings({ skill: b.dataset.skill }));
    card.querySelectorAll("[data-min]").forEach(b => b.onclick = () => saveSettings({ minMinutes: +b.dataset.min }));
    card.querySelectorAll("[data-idle]").forEach(b => b.onclick = () => saveSettings({ idleMinutes: +b.dataset.idle }));
    card.querySelectorAll("[data-rt]").forEach(b => b.onclick = () => run(b.dataset.rt));
  }

  async function refresh(force) {
    if (R.inflight || document.hidden) return;
    if (!force && Date.now() - R.at < (R.open ? EVERY_OPEN : EVERY_CLOSED)) return;
    R.inflight = true;
    try { R.data = await api("/retro"); R.at = Date.now(); if (!state.project) paint(); }
    catch { R.at = Date.now(); /* old server without the pack / offline → no card */ }
    finally { R.inflight = false; }
  }

  async function saveSettings(patch) {
    if (R.busy) return;
    if (patch.mode === "auto" && R.data?.settings.mode !== "auto") toast(`ออโต้: จะสั่ง /${R.data?.settings.skill || "rrr"} ให้เองเมื่อห้องว่าง`);
    R.busy = true;
    try { R.data = await api("/retro/settings", { method: "POST", body: JSON.stringify(patch) }); R.at = Date.now(); paint(); }
    catch (e) { toast("บันทึกไม่ได้: " + e.message); }
    finally { R.busy = false; }
  }

  async function run(sid) {
    if (R.busy || !R.data) return;
    if (!(R.armed === sid && Date.now() < R.armedT)) {
      R.armed = sid; R.armedT = Date.now() + 4000; paint();
      setTimeout(() => { if (Date.now() >= R.armedT) { R.armed = ""; if (!state.project) paint(); } }, 4100);
      return;
    }
    R.armed = ""; R.busy = true;
    const skill = R.data.settings.skill;
    try { await api("/retro/run", { method: "POST", body: JSON.stringify({ sessionId: sid, skill }) }); toast(`สั่ง /${skill} แล้ว`); }
    catch (e) { toast(e.message || "สั่งไม่ได้"); }
    finally { R.busy = false; refresh(true); }
  }

  mawExt.onHome.push(() => { paint(); refresh(); });
  if (!state.project) { paint(); refresh(true); }   // home may already be on screen before this deferred script ran
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !state.project) refresh(true); });
})();
