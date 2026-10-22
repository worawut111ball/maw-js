// Phone UI pack "context" (P5, PLAN-maw-mobile.md §9)
//  · "@file" mentions in the room composer → GET /mobile/rooms/:ws/:room/files?q=
//  · read-only "Plugin · MCP · Hooks" sheet on home → GET /mobile/settings/agents
(() => {
  if (!window.mawExt) return;

  // ── styles (match the "/" popup: .slash / .sc) ──
  const css = `
  .cx-at .sc { grid-template-columns: auto 1fr auto; align-items: center; }
  .cx-at .cx-ico { font-size: 14px; width: 18px; text-align: center; }
  .cx-at .sn { color: #9ecbff; }
  .cx-at .sn.dir { color: #f0c27f; }
  .cx-at .sd { grid-column: 2 / -1; -webkit-line-clamp: 1; font: 11.5px var(--mono); }
  .cx-at .cx-empty { padding: 10px 12px; color: var(--dim); font-size: 12.5px; }
  .cx-home { display: flex; align-items: center; gap: 10px; width: calc(100% - 24px); margin: 10px 12px 2px; padding: 11px 14px;
    background: var(--card); border: 1px solid var(--line); border-radius: 14px; text-align: left; }
  .cx-home b { font-weight: 600; font-size: 14px; } .cx-home span { margin-left: auto; color: var(--dim); font-size: 12px; white-space: nowrap; }
  .cx-sheet h3 { margin: 16px 0 6px; font-size: 13px; color: var(--dim); font-weight: 600; letter-spacing: .02em; display: flex; align-items: center; gap: 6px; }
  .cx-sheet h3 .cx-n { background: var(--card2); color: var(--text); border-radius: 999px; padding: 0 7px; font-size: 11.5px; }
  .cx-agent { display: flex; align-items: center; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); font-weight: 700; font-size: 15px; }
  .cx-agent:first-of-type { border-top: 0; padding-top: 0; }
  .cx-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .cx-list { background: var(--card2); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .cx-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #ffffff08; min-width: 0; }
  .cx-row:last-child { border-bottom: 0; }
  .cx-row .cx-name { font: 600 13px var(--mono); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx-row .cx-sub { color: var(--dim); font-size: 11.5px; }
  .cx-row .cx-r { margin-left: auto; display: flex; gap: 4px; flex: none; }
  .cx-row.off .cx-name { color: var(--dim); }
  .cx-hk { display: block; }
  .cx-hk .cx-top { display: flex; align-items: center; gap: 6px; }
  .cx-hk code { display: block; margin-top: 3px; font: 11px/1.4 var(--mono); color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cx-pill { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; background: #ffffff0d; color: #9aa3c7; white-space: nowrap; }
  .cx-pill.on { background: #22c55e22; color: #4ade80; } .cx-pill.off { background: #ffffff0a; color: #6b7190; }
  .cx-pill.user { background: #60a5fa22; color: #93c5fd; } .cx-pill.project { background: #a78bfa22; color: #c4b5fd; } .cx-pill.local { background: #f59e0b22; color: #fbbf24; }
  .cx-pill.mono { font-family: var(--mono); }
  .cx-none { padding: 10px 12px; color: var(--dim); font-size: 12.5px; }
  .cx-note { color: var(--dim); font-size: 12px; margin-top: 2px; }`;
  if (!document.getElementById("cx-style")) { const st = document.createElement("style"); st.id = "cx-style"; st.textContent = css; document.head.appendChild(st); }

  // ── @file mentions ──
  const AT = /(^|\s)@([^\s@]*)$/;
  const ICONS = { ts: "🟦", tsx: "⚛️", js: "🟨", jsx: "⚛️", mjs: "🟨", json: "🧾", md: "📝", html: "🌐", css: "🎨", scss: "🎨", py: "🐍", go: "🐹", rs: "🦀", dart: "🎯",
    sh: "⚙️", yml: "⚙️", yaml: "⚙️", toml: "⚙️", sql: "🗄️", png: "🖼️", jpg: "🖼️", jpeg: "🖼️", svg: "🖼️", gif: "🖼️", pdf: "📕", lock: "🔒" };
  const extOf = p => { const b = p.slice(p.lastIndexOf("/") + 1), i = b.lastIndexOf("."); return i > 0 ? b.slice(i + 1).toLowerCase() : ""; };
  const atRow = f => {
    const i = f.path.lastIndexOf("/"), base = f.path.slice(i + 1), dir = i > 0 ? f.path.slice(0, i + 1) : "", ext = f.dir ? "" : extOf(f.path);
    return `<button class="sc" data-at="${esc(f.path)}" data-dir="${f.dir ? 1 : ""}"><span class="cx-ico">${f.dir ? "📁" : ICONS[ext] || "📄"}</span>`
      + `<span class="sn${f.dir ? " dir" : ""}">${esc(base)}${f.dir ? "/" : ""}</span><span class="ss">${f.dir ? "โฟลเดอร์" : esc(ext || "ไฟล์")}</span>`
      + (dir ? `<span class="sd">${esc(dir)}</span>` : "") + `</button>`;
  };

  mawExt.onComposer.push(({ w, room, msg }) => {
    if (!msg || !w || !room) return;
    const slash = document.getElementById("slash");
    const box = document.createElement("div");
    box.className = "slash cx-at"; box.hidden = true;
    (slash || msg.closest(".composer")).insertAdjacentElement(slash ? "afterend" : "beforebegin", box);
    let timer = 0, seq = 0;
    const hide = () => { box.hidden = true; clearTimeout(timer); seq++; };
    const token = () => AT.exec(msg.value.slice(0, msg.selectionStart ?? msg.value.length));
    const insert = (path, isDir) => {
      const pos = msg.selectionStart ?? msg.value.length, before = msg.value.slice(0, pos), after = msg.value.slice(pos);
      const m = AT.exec(before); if (!m) return;
      const head = before.slice(0, before.length - m[2].length - 1); // drop "@query"
      const ins = "@" + path + (isDir ? "/" : " ");
      const rest = after.replace(/^[^\s]*/, "");
      msg.value = head + ins + (isDir ? rest : rest.replace(/^\s+/, ""));
      const at = (head + ins).length; msg.focus(); msg.setSelectionRange(at, at);
      msg.oninput && msg.oninput();
      if (!isDir) hide(); else run(); // keep drilling into a folder
    };
    const run = async () => {
      const m = token();
      if (!m) { hide(); return; }
      const my = ++seq;
      let r;
      try { r = await api(`/rooms/${encodeURIComponent(w.id)}/${encodeURIComponent(room.id)}/files?q=${encodeURIComponent(m[2])}`); }
      catch { if (my === seq) hide(); return; }
      if (my !== seq || !token()) return;
      const hits = r.files || [];
      if (!hits.length) { box.innerHTML = `<div class="cx-empty">ไม่พบไฟล์ที่ตรงกับ “${esc(m[2])}”</div>`; box.hidden = !m[2]; return; }
      box.innerHTML = hits.map(atRow).join(""); box.hidden = false; box.scrollTop = 0;
      if (slash) slash.hidden = true;
      box.querySelectorAll("[data-at]").forEach(b => { b.onpointerdown = e => e.preventDefault(); b.onclick = () => insert(b.dataset.at, !!b.dataset.dir); });
    };
    const schedule = () => { clearTimeout(timer); if (!token()) { hide(); return; } timer = setTimeout(run, 150); };
    msg.addEventListener("input", schedule);
    msg.addEventListener("click", schedule);
    msg.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== msg) hide(); }, 150));
  });

  // ── settings viewer ──
  let cache = null;
  const n = x => `<span class="cx-n">${x}</span>`;
  const none = t => `<div class="cx-list"><div class="cx-none">${t}</div></div>`;
  const SCOPE = { user: "user", project: "project", local: "local" };
  const mcpRows = list => list.length ? `<div class="cx-list">${list.map(m => `<div class="cx-row"><span class="cx-name">${esc(m.name)}</span>`
    + `<span class="cx-r">${m.scope ? `<span class="cx-pill ${esc(m.scope)}">${esc(SCOPE[m.scope] || m.scope)}${m.project ? " · " + esc(m.project) : ""}</span>` : ""}`
    + `<span class="cx-pill mono">${esc(m.type)}</span>${m.command ? `<span class="cx-pill mono">${esc(m.command)}</span>` : ""}</span></div>`).join("")}</div>` : none("ไม่มี MCP server");
  const pluginRows = list => list.length ? `<div class="cx-list">${list.map(p => `<div class="cx-row ${p.enabled ? "" : "off"}"><span class="cx-name">${esc(p.name)}</span>`
    + (p.marketplace ? `<span class="cx-sub">@${esc(p.marketplace)}</span>` : "")
    + `<span class="cx-r">${p.version ? `<span class="cx-pill mono">v${esc(p.version)}</span>` : ""}<span class="cx-pill ${p.enabled ? "on" : "off"}">${p.enabled ? "เปิด" : "ปิด"}</span></span></div>`).join("")}</div>` : none("ไม่มี plugin");
  const hookRows = list => list.length ? `<div class="cx-list">${list.map(h => `<div class="cx-row cx-hk"><div class="cx-top"><span class="cx-name">${esc(h.event)}</span>`
    + `<span class="cx-r">${h.matcher ? `<span class="cx-pill mono">${esc(h.matcher)}</span>` : ""}${h.script ? `<span class="cx-pill mono">${esc(h.script)}</span>` : ""}</span></div>`
    + `<code>${esc(h.command)}</code></div>`).join("")}</div>` : none("ไม่มี hook");

  const draw = (sheet, d) => {
    const c = d.claude || {}, x = d.codex || {};
    const plugins = c.plugins || [], mcp = c.mcp || [], hooks = c.hooks || [], cmcp = x.mcp || [];
    const on = plugins.filter(p => p.enabled).length;
    sheet.querySelector(".cx-body").innerHTML = `
      <div class="cx-agent">✳ Claude Code</div>
      <div class="cx-meta">${c.model ? `<span class="cx-pill mono">model: ${esc(c.model)}</span>` : `<span class="cx-pill">model: ค่าเริ่มต้น</span>`}
        <span class="cx-pill ${c.statusLine ? "on" : "off"}">statusLine ${c.statusLine ? "เปิด" : "ปิด"}</span></div>
      <h3>Plugin ${n(`${on}/${plugins.length}`)}</h3>${pluginRows(plugins)}
      <h3>MCP ${n(mcp.length)}</h3>${mcpRows(mcp)}
      <h3>Hooks ${n(hooks.length)}</h3>${hookRows(hooks)}
      <div class="cx-agent">◎ Codex</div>
      <div class="cx-meta">${x.model ? `<span class="cx-pill mono">model: ${esc(x.model)}</span>` : `<span class="cx-pill">model: ค่าเริ่มต้น</span>`}</div>
      <h3>MCP ${n(cmcp.length)}</h3>${mcpRows(cmcp)}`;
  };

  async function openSettings() {
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    bg.innerHTML = `<div class="sheet cx-sheet"><h2>⚙ Plugin · MCP · Hooks</h2>
      <div class="cx-note">อ่านอย่างเดียว · ไม่แสดงค่า env / token / args ของ server</div>
      <div class="cx-body"><div class="cx-none">กำลังโหลด…</div></div>
      <button class="ghost" id="cx-close" style="margin-top:14px">ปิด</button></div>`;
    document.body.appendChild(bg);
    bg.querySelector("#cx-close").onclick = () => bg.remove();
    bg.onclick = e => { if (e.target === bg) bg.remove(); };
    const sheet = bg.querySelector(".sheet");
    if (cache) draw(sheet, cache);
    try { cache = await api("/settings/agents"); if (bg.isConnected) draw(sheet, cache); }
    catch (e) { if (!cache && bg.isConnected) sheet.querySelector(".cx-body").innerHTML = `<div class="cx-none">โหลดไม่ได้: ${esc(e.message)}</div>`; }
  }

  const homeButton = () => {
    const slot = document.getElementById("ext-home");
    if (!slot || slot.querySelector(".cx-home")) return;
    const b = document.createElement("button");
    b.className = "cx-home";
    b.innerHTML = `<b>⚙ Plugin · MCP · Hooks</b><span>${cache ? `${(cache.claude?.plugins || []).length} plugin · ${(cache.claude?.mcp || []).length + (cache.codex?.mcp || []).length} MCP` : "ดูการตั้งค่า"}</span>`;
    b.onclick = openSettings;
    slot.appendChild(b);
  };
  mawExt.onHome.push(homeButton);
  homeButton(); // home may already be on screen before this deferred script ran
})();
