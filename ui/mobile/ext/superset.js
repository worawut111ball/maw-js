// Phone UI pack "superset" (P6) — Superset power features (PLAN-maw-mobile.md §9).
// Tab "⚙ Superset": new workspace + agent · automations · tasks · scripts · archive workspace.
// Quick key "❓ ทำไมค้าง" in Superset rooms → `superset agents explain` in a bottom sheet.
// Server routes: src/mobile/features/superset.ts. Every write action needs a second tap to confirm.
(() => {
  if (!window.mawExt) return;
  const enc = encodeURIComponent;

  if (!document.getElementById("ssx-style")) {
    const st = document.createElement("style"); st.id = "ssx-style";
    st.textContent = `
      .ssx .section { display: flex; align-items: center; gap: 8px; }
      .ssx .section .more { margin-left: auto; color: var(--accent); font-size: 13px; letter-spacing: 0; padding: 4px 6px; }
      .ssx .card { cursor: default; }
      .ssx .card:active { background: var(--card); }
      .ssx-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .ssx-row .t { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ssx-sub { color: var(--dim); font-size: 12.5px; margin-top: 4px; overflow-wrap: anywhere; }
      .ssx-mono { font-family: var(--mono); font-size: 12px; color: var(--dim); margin-top: 6px; overflow-wrap: anywhere; }
      .ssx-acts { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
      .ssx-btn { flex: 1 1 auto; min-height: 38px; padding: 8px 12px; border-radius: 10px; background: var(--card2); color: var(--text); font-size: 13.5px; border: 1px solid var(--line); }
      .ssx-btn.go { background: var(--accent); color: #031022; font-weight: 700; border-color: transparent; }
      .ssx-btn.bad { color: var(--danger, #ef4444); border-color: #ef444466; }
      .ssx-btn.armed, .primary.armed { background: var(--danger, #ef4444) !important; color: #fff !important; font-weight: 700; }
      .ssx-btn:disabled { opacity: .45; }
      .ssx-badge { flex: none; font-size: 11.5px; padding: 2px 8px; border-radius: 999px; background: var(--card2); color: var(--dim); }
      .ssx-badge.on { background: #14532d; color: #bbf7d0; }
      .ssx-badge.off { background: #3f3f46; color: #d4d4d8; }
      .ssx-danger { border-color: #ef444466 !important; }
      .ssx-danger p { margin: 6px 0; font-size: 13.5px; line-height: 1.5; }
      .ssx-note { color: var(--dim); font-size: 13px; padding: 8px 2px; }
      .ssx-f label { display: block; color: var(--dim); font-size: 12.5px; margin: 12px 0 4px; }
      .ssx-f input, .ssx-f select, .ssx-f textarea { display: block; width: 100%; box-sizing: border-box; padding: 11px 12px; border-radius: 10px;
        border: 1px solid var(--line); background: var(--bg); color: var(--text); font: 15px var(--font); flex: none; max-height: none; }
      .ssx-f textarea { min-height: 96px; resize: vertical; }
      .ssx-f input:focus, .ssx-f select:focus, .ssx-f textarea:focus { outline: none; border-color: var(--accent); }
      .ssx-f .hint { color: var(--dim); font-size: 11.5px; margin-top: 4px; }
      .ssx-f .grid { margin: 4px 0 0; }
      .ssx-f .opt { padding: 10px 4px; font-size: 13px; }
      .ssx-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
      .ssx-chips .chip { padding: 8px 12px; }
      .ssx-why h3 { margin: 10px 0 4px; font-size: 17px; }
      .ssx-why ul { margin: 6px 0; padding-left: 18px; font-size: 13.5px; line-height: 1.5; }
    `;
    document.head.appendChild(st);
  }

  // ── helpers ──
  const slug = (name) => {
    const s = String(name || "").toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/-+/g, "-").replace(/^[-./]+|[-./]+$/g, "").slice(0, 60);
    if (s) return s;
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `ws-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  };
  const NAME_RE = /^[\w.\-/ ]{1,80}$/;
  const fmtWhen = (iso) => { try { return new Date(iso).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return String(iso); } };
  const ago = (iso) => { const s = (Date.now() - new Date(iso).getTime()) / 1000; if (!isFinite(s)) return ""; return s < 60 ? "เมื่อสักครู่" : s < 3600 ? `${Math.round(s / 60)} นาทีก่อน` : s < 86400 ? `${Math.round(s / 3600)} ชม.ก่อน` : `${Math.round(s / 86400)} วันก่อน`; };
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });

  /** Two-tap confirm: first tap arms (red, "แตะอีกครั้ง…"), second runs. Disarms after 4 s. */
  function arm(btn, run, confirmText = "แตะอีกครั้งเพื่อยืนยัน") {
    const label = btn.textContent;
    btn.onclick = async () => {
      if (!btn.dataset.armed) {
        btn.dataset.armed = "1"; btn.classList.add("armed"); btn.textContent = confirmText;
        clearTimeout(btn._t); btn._t = setTimeout(() => { delete btn.dataset.armed; btn.classList.remove("armed"); btn.textContent = label; }, 4000);
        return;
      }
      clearTimeout(btn._t); btn.disabled = true; btn.classList.remove("armed"); btn.textContent = "กำลังส่ง…";
      try { await run(); }
      catch (e) { toast(e.message || String(e)); }
      finally { if (btn.isConnected) { delete btn.dataset.armed; btn.disabled = false; btn.textContent = label; } }
    };
  }

  function openSheet(html) {
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    bg.innerHTML = `<div class="sheet ssx-f">${html}</div>`;
    document.body.appendChild(bg);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    bg.querySelectorAll("[data-close]").forEach(b => b.onclick = () => bg.remove());
    return bg;
  }

  const metaCache = new Map();
  function getMeta(wsId) {
    const c = metaCache.get(wsId);
    if (c && Date.now() - c.at < 60_000) return c.p;
    const p = api(`/superset/workspaces/${enc(wsId)}/meta`).catch(e => { metaCache.delete(wsId); throw e; });
    metaCache.set(wsId, { at: Date.now(), p });
    return p;
  }
  /** Superset project id for the open project: from the workspace itself, else by name. */
  const currentProjectId = (meta) => meta.workspace?.projectId || meta.projects.find(p => p.name === state.project)?.id || "";
  const projectOptions = (meta, sel) => meta.projects.map(p => `<option value="${esc(p.id)}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  const agentOptions = (meta, sel = "claude") => (meta.agents.length ? meta.agents : [{ id: "claude", label: "Claude" }])
    .map(a => `<option value="${esc(a.id)}" ${a.id === sel ? "selected" : ""}>${esc(a.label)}</option>`).join("");

  /** After a create: wait for the new workspace to show in /projects, then open its agent room. */
  async function openCreated(r) {
    for (let i = 0; i < 8; i++) {
      await load();
      for (const p of state.projects) {
        const w = p.workspaces.find(x => x.id === r.workspaceId);
        if (!w) continue;
        const room = (r.terminalId && w.rooms.find(x => x.id === r.terminalId)) || w.rooms.find(x => x.agent) || w.rooms[0];
        if (!room && i < 7) break; // agent terminal not up yet — poll again
        state.project = p.name; state.ws = w.id; state.room = room?.id || null; state.pview = "rooms";
        state.chat = null; state.follow = true;
        return renderProject();
      }
      await new Promise(res => setTimeout(res, 1500));
    }
    toast("สร้างแล้ว แต่ยังไม่เห็นใน Superset — ลองรีเฟรชอีกครั้ง");
  }

  // ── A. new workspace + agent ──
  async function newWorkspaceSheet(meta, preset = {}) {
    const pid = preset.projectId || currentProjectId(meta);
    const bg = openSheet(`<h2>${preset.task ? "ให้ agent ทำ task" : "Workspace ใหม่ + agent"}</h2>
      ${preset.task ? `<div class="ssx-sub">${esc(preset.taskLabel || preset.task)}</div>` : `<div class="ssx-sub">สร้าง worktree + branch ใหม่ แล้วเปิด agent พร้อมคำสั่งแรก</div>`}
      <label>โปรเจค</label><select id="sp">${projectOptions(meta, pid)}</select>
      <label>ชื่อ workspace</label><input id="sn" maxlength="80" autocapitalize="off" spellcheck="false" placeholder="เช่น fix-login-bug" value="${esc(preset.name || "")}">
      <div class="hint">ภาษาอังกฤษ ตัวเลข _ . - / และเว้นวรรค</div>
      <label>Branch</label><input id="sb" maxlength="100" autocapitalize="off" spellcheck="false" value="${esc(preset.branch || "")}">
      <div class="hint">เว้นว่าง = ใช้ชื่อเดียวกับ workspace</div>
      <label>Agent</label><select id="sa">${agentOptions(meta)}</select>
      <label>คำสั่งแรก</label><textarea id="sq" maxlength="4000" placeholder="บอก agent ว่าต้องทำอะไร">${esc(preset.prompt || "")}</textarea>
      <div class="hint" id="sc"></div>
      <button class="primary" id="go">สร้าง workspace</button><button class="ghost" data-close>ยกเลิก</button>`);
    const $ = (s) => bg.querySelector(s);
    const sync = () => {
      $("#sb").placeholder = slug($("#sn").value) || "branch";
      $("#sc").textContent = `${$("#sq").value.length}/4000`;
      const okName = NAME_RE.test($("#sn").value.trim()) && !$("#sn").value.trim().startsWith("-");
      $("#go").disabled = !okName || !$("#sq").value.trim() || !$("#sp").value;
    };
    ["#sn", "#sb", "#sq", "#sp"].forEach(s => $(s).addEventListener("input", sync)); sync();
    arm($("#go"), async () => {
      const name = $("#sn").value.trim();
      const body = { projectId: $("#sp").value, name, branch: $("#sb").value.trim() || slug(name), agent: $("#sa").value, prompt: $("#sq").value.trim() };
      toast("กำลังสร้าง workspace… (อาจใช้เวลาสักครู่)");
      const r = preset.task ? await post(`/superset/tasks/${enc(preset.task)}/start`, body) : await post("/superset/workspaces", body);
      bg.remove(); toast(r.alreadyExists ? "มี workspace นี้อยู่แล้ว — เปิดให้" : "สร้างแล้ว กำลังเปิดห้อง agent…");
      if (r.workspaceId) await openCreated(r); else await load();
    }, "แตะอีกครั้งเพื่อสร้าง");
  }

  // ── B. automations ──
  const PRESETS = [["daily", "ทุกวัน"], ["weekdays", "ทุกวันทำการ"], ["weekly", "ทุกสัปดาห์"]];
  const DAYS = [["MO", "จ"], ["TU", "อ"], ["WE", "พ"], ["TH", "พฤ"], ["FR", "ศ"], ["SA", "ส"], ["SU", "อา"]];
  function newAutomationSheet(meta, reload) {
    let preset = "daily", day = "MO";
    const bg = openSheet(`<h2>Automation ใหม่</h2><div class="ssx-sub">ให้ agent ทำงานตามเวลาที่ตั้ง (แต่ละรอบสร้าง workspace ใหม่ในโปรเจคที่เลือก)</div>
      <label>ชื่อ</label><input id="an" maxlength="80" autocapitalize="off" spellcheck="false" placeholder="เช่น nightly-audit">
      <label>โปรเจค</label><select id="ap">${projectOptions(meta, currentProjectId(meta))}</select>
      <label>รอบเวลา</label><div class="ssx-chips" id="apr">${PRESETS.map(([k, l]) => `<button class="chip ${k === preset ? "on" : ""}" data-pr="${k}">${l}</button>`).join("")}</div>
      <div id="adw" hidden><label>วัน</label><div class="ssx-chips">${DAYS.map(([k, l]) => `<button class="chip ${k === day ? "on" : ""}" data-d="${k}">${l}</button>`).join("")}</div></div>
      <label>เวลา (เวลาของ Mac)</label><input id="at" type="time" value="02:00">
      <label>Agent</label><select id="aa">${agentOptions(meta)}</select>
      <label>คำสั่ง</label><textarea id="aq" maxlength="4000" placeholder="เช่น ตรวจ dependency ที่มีช่องโหว่ แล้วสรุปใน PR"></textarea>
      <button class="primary" id="go">สร้าง automation</button><button class="ghost" data-close>ยกเลิก</button>`);
    const $ = (s) => bg.querySelector(s);
    const sync = () => {
      $("#adw").hidden = preset !== "weekly";
      const n = $("#an").value.trim();
      $("#go").disabled = !(NAME_RE.test(n) && !n.startsWith("-")) || !$("#aq").value.trim() || !/^\d\d:\d\d$/.test($("#at").value) || !$("#ap").value;
    };
    bg.querySelectorAll("[data-pr]").forEach(b => b.onclick = () => { preset = b.dataset.pr; bg.querySelectorAll("[data-pr]").forEach(x => x.classList.toggle("on", x === b)); sync(); });
    bg.querySelectorAll("[data-d]").forEach(b => b.onclick = () => { day = b.dataset.d; bg.querySelectorAll("[data-d]").forEach(x => x.classList.toggle("on", x === b)); sync(); });
    ["#an", "#aq", "#at", "#ap"].forEach(s => $(s).addEventListener("input", sync)); sync();
    arm($("#go"), async () => {
      await post("/superset/automations", { name: $("#an").value.trim(), projectId: $("#ap").value, preset, day, time: $("#at").value, agent: $("#aa").value, prompt: $("#aq").value.trim() });
      bg.remove(); toast("สร้าง automation แล้ว"); reload();
    }, "แตะอีกครั้งเพื่อสร้าง");
  }

  async function renderAutomations(box, meta) {
    const reload = () => renderAutomations(box, meta);
    box.innerHTML = `<div class="ssx-note">กำลังโหลด…</div>`;
    let list;
    try { list = (await api("/superset/automations")).automations; }
    catch (e) { if (box.isConnected) box.innerHTML = `<div class="ssx-note">โหลด automation ไม่ได้: ${esc(e.message)}</div>`; return; }
    if (!box.isConnected) return;
    box.innerHTML = list.length ? list.map((a, i) => `<div class="card">
        <div class="ssx-row"><span class="t">${esc(a.name)}</span><span class="ssx-badge ${a.enabled ? "on" : "off"}">${a.enabled ? "เปิดอยู่" : "หยุดไว้"}</span></div>
        <div class="ssx-sub">⏰ ${esc(a.schedule)}${a.agent ? ` · ${esc(a.agent)}` : ""}</div>
        ${a.enabled && a.nextRunAt ? `<div class="ssx-sub">รอบถัดไป: ${esc(fmtWhen(a.nextRunAt))}</div>` : ""}
        <div class="ssx-acts"><button class="ssx-btn" data-tg="${i}">${a.enabled ? "⏸ หยุดชั่วคราว" : "▶ เปิดใช้"}</button><button class="ssx-btn bad" data-del="${i}">🗑 ลบ</button></div>
      </div>`).join("") : `<div class="ssx-note">ยังไม่มี automation</div>`;
    box.querySelectorAll("[data-tg]").forEach(b => { const a = list[+b.dataset.tg]; arm(b, async () => { await post(`/superset/automations/${enc(a.id)}/${a.enabled ? "pause" : "resume"}`); toast(a.enabled ? "หยุด automation แล้ว" : "เปิด automation แล้ว"); reload(); }); });
    box.querySelectorAll("[data-del]").forEach(b => { const a = list[+b.dataset.del]; arm(b, async () => { await post(`/superset/automations/${enc(a.id)}/delete`); toast("ลบ automation แล้ว"); reload(); }, "แตะอีกครั้งเพื่อลบถาวร"); });
  }

  // ── C. tasks ──
  async function renderTasks(box, meta) {
    box.innerHTML = `<div class="ssx-note">กำลังโหลด…</div>`;
    let list;
    try { list = (await api("/superset/tasks")).tasks; }
    catch (e) { if (box.isConnected) box.innerHTML = `<div class="ssx-note">โหลด task ไม่ได้: ${esc(e.message)}</div>`; return; }
    if (!box.isConnected) return;
    box.innerHTML = list.length ? list.map((t, i) => `<div class="card">
        <div class="ssx-row"><span class="t">${esc(t.title)}</span>${t.status ? `<span class="ssx-badge">${esc(t.status)}</span>` : ""}</div>
        ${t.slug || t.priority ? `<div class="ssx-sub">${esc(t.slug || "")}${t.priority ? ` · priority ${esc(t.priority)}` : ""}</div>` : ""}
        <div class="ssx-acts"><button class="ssx-btn go" data-ts="${i}">▶ ให้ agent ทำ task นี้</button></div>
      </div>`).join("") : `<div class="ssx-note">ไม่มี task ที่กำลังทำอยู่</div>`;
    box.querySelectorAll("[data-ts]").forEach(b => b.onclick = () => {
      const t = list[+b.dataset.ts];
      const ref = t.slug || t.id;
      const base = slug(t.slug || t.title);
      newWorkspaceSheet(meta, { task: ref, taskLabel: `${t.slug ? t.slug + " · " : ""}${t.title}`, name: base.slice(0, 80), branch: base, prompt: `ทำ task ${ref}: ${t.title}` });
    });
  }

  // ── D. scripts ──
  async function renderScripts(box, meta, w) {
    box.innerHTML = `<div class="ssx-note">กำลังโหลด…</div>`;
    let list;
    const pid = currentProjectId(meta);
    try { list = (await api(`/superset/scripts${pid ? `?projectId=${enc(pid)}` : ""}`)).scripts; }
    catch (e) { if (box.isConnected) box.innerHTML = `<div class="ssx-note">โหลด script ไม่ได้: ${esc(e.message)}</div>`; return; }
    if (!box.isConnected) return;
    box.innerHTML = list.length ? list.map((s, i) => `<div class="card">
        <div class="ssx-row"><span class="t">${esc(s.name)}</span></div>
        ${s.description ? `<div class="ssx-sub">${esc(s.description)}</div>` : ""}
        <div class="ssx-mono">$ ${esc(s.command)}</div>
        <div class="ssx-acts"><button class="ssx-btn" data-run="${i}">▶ รันใน terminal ใหม่</button></div>
      </div>`).join("") : `<div class="ssx-note">ยังไม่มี script</div>`;
    box.querySelectorAll("[data-run]").forEach(b => { const s = list[+b.dataset.run]; arm(b, async () => {
      const r = await post(`/superset/workspaces/${enc(w.id)}/scripts/${enc(s.id)}/run`);
      toast(`เปิด terminal รัน ${s.name} แล้ว`);
      await load();
      const ww = state.projects.find(p => p.name === state.project)?.workspaces.find(x => x.id === w.id);
      if (r.terminalId && ww?.rooms.some(x => x.id === r.terminalId)) { state.room = r.terminalId; state.pview = "rooms"; state.chat = null; renderProject(); }
    }, `แตะอีกครั้งเพื่อรัน ${s.name}`); });
  }

  // ── E. archive ──
  function renderDanger(box, meta, w) {
    if (meta.workspace?.type === "local") {
      box.innerHTML = `<div class="card ssx-danger"><p>นี่คือ workspace หลักของโปรเจค (ใช้โฟลเดอร์โปรเจคเดิมโดยตรง) — เก็บ (archive) จากมือถือไม่ได้</p></div>`;
      return;
    }
    box.innerHTML = `<div class="card ssx-danger">
      <div class="ssx-row"><span class="t">เก็บ workspace นี้ (archive)</span></div>
      <p>⎇ <b>${esc(w.branch || w.name)}</b> — ห้อง agent/terminal ทั้งหมดใน workspace นี้จะปิด และ<b>โฟลเดอร์ worktree จะถูกลบ</b></p>
      <p>⚠ งานที่ยังไม่ได้ commit ใน worktree จะ<b>หายถาวร</b> · branch ยังอยู่ กู้คืนได้เฉพาะงานที่ commit แล้ว</p>
      <div class="ssx-acts"><button class="ssx-btn bad" id="ssx-arch">🗄 เก็บ workspace</button></div></div>`;
    arm(box.querySelector("#ssx-arch"), async () => {
      await post(`/superset/workspaces/${enc(w.id)}/archive`);
      metaCache.delete(w.id);
      toast("เก็บ workspace แล้ว");
      state.pview = "rooms"; state.project = null; state.ws = null; state.room = null;
      await load(); renderHome();
    }, "แตะอีกครั้ง = ลบ worktree");
  }

  // ── the tab ──
  mawExt.tabs.push({
    key: "superset", label: "⚙ Superset",
    render(w, el) {
      if (!w || w.id === "tmux") { el.innerHTML = `<div class="empty">ใช้ได้เฉพาะโปรเจคของ Superset</div>`; return; }
      el.innerHTML = `<div class="ssx">
        <div class="section">➕ เริ่มงานใหม่</div>
        <div class="card"><div class="ssx-sub" style="margin-top:0">สร้าง workspace (worktree + branch) แล้วเปิด agent พร้อมคำสั่งแรก</div>
          <div class="ssx-acts"><button class="ssx-btn go" id="ssx-new" disabled>➕ Workspace ใหม่ + agent</button></div></div>
        <div class="section">⏰ Automations<button class="more" id="ssx-anew" disabled>+ สร้าง</button></div><div id="ssx-auto"></div>
        <div class="section">📋 Tasks</div><div id="ssx-tasks"></div>
        <div class="section">▶ Scripts</div><div id="ssx-scripts"></div>
        <div class="section">⚠ Danger zone</div><div id="ssx-danger"><div class="ssx-note">กำลังโหลด…</div></div>
      </div>`;
      const q = (s) => el.querySelector(s);
      getMeta(w.id).then(meta => {
        if (!el.isConnected) return;
        if (!meta.projects.length) toast("ไม่พบรายชื่อโปรเจคจาก Superset");
        const nb = q("#ssx-new"), ab = q("#ssx-anew");
        nb.disabled = false; nb.onclick = () => newWorkspaceSheet(meta);
        ab.disabled = false; ab.onclick = () => newAutomationSheet(meta, () => renderAutomations(q("#ssx-auto"), meta));
        renderAutomations(q("#ssx-auto"), meta);
        renderTasks(q("#ssx-tasks"), meta);
        renderScripts(q("#ssx-scripts"), meta, w);
        renderDanger(q("#ssx-danger"), meta, w);
      }).catch(e => {
        if (!el.isConnected) return;
        el.querySelector(".ssx").insertAdjacentHTML("afterbegin", `<div class="card ssx-danger"><p>เชื่อม Superset ไม่ได้: ${esc(e.message)}</p></div>`);
        q("#ssx-danger").innerHTML = "";
      });
    },
  });

  // ── F. "❓ ทำไมค้าง" quick key ──
  async function explainSheet(w, room) {
    const bg = openSheet(`<div class="ssx-why"><h2>❓ ทำไม agent ถึงเป็นแบบนี้</h2><div class="ssx-sub">${esc(room.title)}</div><div id="ex"><div class="ssx-note">กำลังถาม Superset…</div></div></div>
      <button class="primary" id="again">↻ ถามใหม่</button><button class="ghost" data-close>ปิด</button>`);
    const box = bg.querySelector("#ex");
    const run = async () => {
      box.innerHTML = `<div class="ssx-note">กำลังถาม Superset…</div>`;
      try {
        const x = (await api(`/superset/rooms/${enc(w.id)}/${enc(room.id)}/explain`)).explain || {};
        const details = Array.isArray(x.details) ? x.details : [];
        box.innerHTML = `
          ${x.state ? `<div class="ssx-sub">สถานะ: <span class="ssx-badge">${esc(x.state)}</span></div>` : ""}
          <h3>${esc(x.headline || "ไม่มีคำอธิบาย")}</h3>
          ${x.because ? `<div>เพราะ: ${esc(x.because)}</div>` : ""}
          ${details.length ? `<ul>${details.map(d => `<li>${esc(typeof d === "string" ? d : JSON.stringify(d))}</li>`).join("")}</ul>` : ""}
          ${x.lastEventType ? `<div class="ssx-sub">event ล่าสุด: ${esc(x.lastEventType)}${x.lastEventAt ? ` · ${esc(ago(x.lastEventAt))}` : ""}</div>` : ""}`;
      } catch (e) { box.innerHTML = `<div class="ssx-note">ถามไม่ได้: ${esc(e.message)}</div>`; }
    };
    bg.querySelector("#again").onclick = run;
    run();
  }
  const whyIdx = mawExt.keys.length;
  mawExt.keys.push({
    label: "❓ ทำไมค้าง", cls: "ssx-why-key",
    show: ({ w }) => !!w && w.id !== "tmux" && !String(w.id).startsWith("dir:"), // Superset rooms only
    onClick({ w, room }) {
      if (!w || w.id === "tmux") return toast("ใช้ได้เฉพาะห้องของ Superset");
      explainSheet(w, room);
    },
  });
  // tmux rooms have no Superset agent state — hide the key there.
  mawExt.onRoom.push(({ w }) => {
    if (w?.id !== "tmux") return;
    const b = document.querySelector(`[data-xk="${whyIdx}"]`); if (b) b.hidden = true;
  });
})();
