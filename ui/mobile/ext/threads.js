// Phone UI pack "threads" (26 พ.ย. 69) — เธรดประจำโปรเจคแบบ Discord (แบบ B: ลิ้นชักมีโปรเจคละ 1 บรรทัด "# เธรด ›")
// คำสั่งรัน · deploy · 🔒 รหัส · ไฟล์ · บันทึกงาน · สร้างเพิ่มเองได้ · Server: src/mobile/features/threads.ts
// รหัสอยู่ใน Keychain ของ Mac — หน้านี้ได้ค่าเฉพาะตอนกด "ดู"/"คัดลอก" (ซ่อนเองใน 30 วิ) · ไม่ส่งให้ agent เอง
// "ส่งเข้าห้อง →" เลือกห้อง agent ของโปรเจค แล้วใส่คำสั่งลงช่องพิมพ์ (กดส่งเอง)
(() => {
  if (!window.mawExt) return;
  const css = `
  .drw-thr { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 14px; border: 0; border-top: 1px solid var(--line); background: none; color: var(--accent); font: 12px var(--font); text-align: left; }
  .drw-thr .h { font-weight: 700; width: 12px; text-align: center; color: var(--dim); }
  .drw-thr .t { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .th-main { padding: 10px 12px calc(230px + env(safe-area-inset-bottom)); display: grid; gap: 10px; align-content: start; }
  .th-list { background: var(--card); border-radius: 14px; overflow: hidden; }
  .th-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 12px; border: 0; background: none; color: var(--text); text-align: left; font: 13px var(--font); }
  .th-row + .th-row { border-top: 1px solid var(--line); }
  .th-row .h { width: 26px; height: 26px; border-radius: 8px; background: var(--card2, #23232a); display: grid; place-items: center; color: var(--dim); font-weight: 700; font-size: 12px; flex: none; }
  .th-row .t { flex: 1; min-width: 0; font-weight: 600; } .th-row em { font-style: normal; color: var(--dim); font-size: 11px; }
  .th-new { display: flex; gap: 8px; } .th-new input { flex: 1; min-width: 0; }
  .th-in { padding: 9px 11px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--text); font: 14px var(--font); outline: 0; width: 100%; box-sizing: border-box; }
  textarea.th-in { min-height: 64px; resize: vertical; } textarea.th-in.mono, .th-in.mono { font: 12.5px var(--mono); }
  .th-go { flex: none; padding: 0 14px; height: 38px; border-radius: 10px; border: 0; background: var(--accent); color: #031022; font: 700 13px var(--font); } .th-go:disabled { opacity: .5; }
  .th-it { background: var(--card); border-radius: 14px; padding: 10px 12px; display: grid; gap: 6px; }
  .th-it .top { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; }
  .th-it .top small { margin-left: auto; font-weight: 400; color: var(--dim); font-size: 10.5px; white-space: nowrap; }
  .th-it p { margin: 0; font-size: 12px; color: var(--dim); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  .th-code { font: 11.5px/1.5 var(--mono); background: #0a0a0c; border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px; white-space: pre-wrap; word-break: break-all; color: #d4d4dc; margin: 0; user-select: text; }
  .th-sec { font: 12.5px var(--mono); color: var(--dim); letter-spacing: 1px; overflow-wrap: anywhere; user-select: text; } .th-sec.shown { color: #fbbf24; letter-spacing: 0; }
  .th-acts { display: flex; gap: 6px; flex-wrap: wrap; }
  .th-acts button { padding: 5px 10px; border-radius: 9px; border: 0; background: var(--card2, #23232a); color: var(--text); font: 11.5px var(--font); }
  .th-acts .pri { background: var(--accent); color: #04101f; font-weight: 600; } .th-acts .armed { background: #ef4444; color: #fff; }
  .th-comp { position: fixed; left: 0; right: 0; bottom: 0; z-index: 5; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); background: var(--bg); border-top: 1px solid var(--line); display: grid; gap: 8px; }
  body.drw-pinned .th-comp { left: 300px; }
  .th-kinds { display: flex; gap: 6px; flex-wrap: wrap; }
  .th-kinds button { padding: 5px 11px; border-radius: 99px; border: 1px solid var(--line); background: var(--card); color: var(--dim); font: 12px var(--font); }
  .th-kinds button.on { color: var(--text); border-color: #5a5a66; background: var(--card2, #23232a); }
  .th-note { font-size: 11px; color: var(--dim); }
  .th-empty { color: var(--dim); text-align: center; padding: 26px 8px; font-size: 13px; }`;
  if (!document.getElementById("th-style")) { const s = document.createElement("style"); s.id = "th-style"; s.textContent = css; document.head.appendChild(s); }

  // same key the server files the project under (Thai kept)
  const pkey = name => String(name ?? "").normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+/, "").slice(0, 80);
  const S = { sum: null, sumAt: 0, project: null, tid: null, kind: "note", reveal: new Map() };
  const q = p => "project=" + encodeURIComponent(p);
  const ago = t => { const m = Math.max(0, (Date.now() - t) / 60000); return m < 60 ? `${Math.round(m)} นาที` : m < 1440 ? `${Math.round(m / 60)} ชม.` : new Date(t).toLocaleDateString("th-TH", { day: "numeric", month: "short" }); };

  async function loadSummary() {
    if (Date.now() - S.sumAt < 60_000) return;
    S.sumAt = Date.now();
    try { S.sum = (await api("/threads/summary")).projects || {}; document.querySelectorAll(".drw-thr").forEach(b => { b.querySelector(".t").textContent = rowText(b.dataset.thr); }); } catch { /* offline */ }
  }
  const rowText = name => { const s = S.sum?.[pkey(name)]; return s ? `เธรด ${s.count} · ${s.names.join(" · ")}` : "เธรด · คำสั่ง · deploy · รหัส · ไฟล์"; };
  /** One line per project in the drawer (called by openDrawer for every project group). */
  mawExt.threadsRow = p => { loadSummary(); return `<button class="drw-thr" data-thr="${esc(p.name)}"><span class="h">#</span><span class="t">${esc(rowText(p.name))}</span><span>›</span></button>`; };
  document.addEventListener("click", e => {
    const b = e.target.closest?.("[data-thr]"); if (!b) return;
    e.stopPropagation(); document.querySelector(".drw-bg:not(.pinned)")?.remove();
    openThreads(b.dataset.thr);
  }, true);

  function shell(title, sub) {
    state.page = "threads"; state.project = null; state.room = null;
    $app.dataset.view = "";
    $app.innerHTML = `${uiClean() ? `<i class="uiclean" hidden></i>` : ""}<header class="phd"><button class="iconbtn cb" id="back" aria-label="กลับ">${SVG.back || "←"}</button><h1>${esc(title)}<small style="display:block;font-size:11px;font-weight:400;color:var(--dim)">${esc(sub)}</small></h1>${rcHtml()}</header><main class="th-main" id="thbody"><div class="th-empty">กำลังโหลด…</div></main>`;
    document.getElementById("back").onclick = () => history.back();
    return document.getElementById("thbody");
  }
  async function openThreads(project, push = true) {
    if (push) history.pushState({ v: "pg" }, "");
    S.project = project; S.tid = null;
    const main = shell("# เธรด", project);
    try {
      const r = await api(`/threads?${q(project)}`); S.sumAt = 0;
      main.innerHTML = `<div class="th-list">${r.threads.map(t => `<button class="th-row" data-tid="${esc(t.id)}"><span class="h">${esc(t.icon)}</span><span class="t">${esc(t.name)}</span><em>${t.count}</em><span style="color:var(--dim)">›</span></button>`).join("")}</div>
        <div class="th-new"><input class="th-in" placeholder="ชื่อเธรดใหม่ เช่น ข้อมูลลูกค้า" maxlength="40"><button class="th-go">＋ สร้าง</button></div>
        <div class="th-note">เก็บบน Mac เท่านั้น (~/.maw/threads) · รหัสอยู่ใน Keychain ของ Mac</div>`;
      main.querySelectorAll("[data-tid]").forEach(b => b.onclick = () => openThread(project, b.dataset.tid));
      const inp = main.querySelector(".th-new input"), go = main.querySelector(".th-new .th-go");
      go.onclick = async () => { const name = inp.value.trim(); if (!name) return inp.focus(); go.disabled = true;
        try { const t = (await api("/threads", { method: "POST", body: JSON.stringify({ project, name }) })).thread; openThread(project, t.id); } catch (err) { toast(err.message); go.disabled = false; } };
    } catch (e) { main.innerHTML = `<div class="th-empty">โหลดไม่ได้: ${esc(e.message)}</div>`; }
  }
  mawExt.openThreads = openThreads;

  function itemHtml(it) {
    const head = `<div class="top">${it.pinned ? "📌 " : ""}${it.kind === "secret" ? "🔒 " : it.kind === "file" ? "📎 " : ""}${esc(it.title)}<small>${ago(it.at)}</small></div>`;
    const pin = `<button data-pin="${it.pinned ? 0 : 1}">${it.pinned ? "เลิกปัก" : "ปักหมุด"}</button>`, del = `<button data-del>ลบ</button>`;
    if (it.kind === "cmd") return `<div class="th-it" data-iid="${esc(it.id)}">${head}${it.body ? `<p>${esc(it.body)}</p>` : ""}<pre class="th-code">${esc(it.code)}</pre>
      <div class="th-acts"><button data-copy>คัดลอก</button><button class="pri" data-send>ส่งเข้าห้อง →</button>${pin}${del}</div></div>`;
    if (it.kind === "secret") { const v = S.reveal.get(it.id);
      return `<div class="th-it" data-iid="${esc(it.id)}">${head}${it.body ? `<p>${esc(it.body)}</p>` : ""}<div class="th-sec ${v != null ? "shown" : ""}">${v != null ? esc(v) : "••••••••••••"}</div>
      <div class="th-acts"><button data-reveal>${v != null ? "ซ่อน" : "ดู"}</button><button data-scopy>คัดลอก</button>${pin}${del}</div></div>`; }
    if (it.kind === "file") return `<div class="th-it" data-iid="${esc(it.id)}">${head}<p>${esc(it.file?.name || "")} · ${((it.file?.size || 0) / 1024 / 1024).toFixed(2)} MB</p>
      <div class="th-acts"><button class="pri" data-open>เปิด</button><button data-dl>ดาวน์โหลด</button>${pin}${del}</div></div>`;
    return `<div class="th-it" data-iid="${esc(it.id)}">${head}${it.body ? `<p>${esc(it.body)}</p>` : ""}<div class="th-acts"><button data-copy>คัดลอก</button>${pin}${del}</div></div>`;
  }
  async function openThread(project, tid, push = true) {
    if (push) history.pushState({ v: "pg" }, "");
    S.project = project; S.tid = tid;
    const main = shell("เธรด", project);
    document.getElementById("back").onclick = () => openThreads(project, false);   // back to this project's thread list
    let items = [], thread = null;
    async function refresh() {
      try { const r = await api(`/threads/${encodeURIComponent(tid)}?${q(project)}`); items = r.items; thread = r.thread; }
      catch (e) { main.innerHTML = `<div class="th-empty">โหลดไม่ได้: ${esc(e.message)}</div>`; return; }
      $app.querySelector("header.phd h1").firstChild.textContent = `${thread.icon} ${thread.name}`;
      main.innerHTML = (items.length ? items.map(itemHtml).join("") : `<div class="th-empty">ยังไม่มีรายการ · เพิ่มจากช่องด้านล่าง</div>`)
        + `<div class="th-acts" style="justify-content:center;margin-top:8px"><button data-delthread>ลบเธรดนี้</button></div>`;
      wire();
    }
    const itOf = el => items.find(x => x.id === el.closest("[data-iid]")?.dataset.iid);
    const post = (path, body = {}) => api(`/threads/${encodeURIComponent(tid)}${path}`, { method: "POST", body: JSON.stringify({ project, ...body }) });
    const armed = (b, label) => { if (b.classList.contains("armed")) return true; b.classList.add("armed"); const o = b.textContent; b.textContent = label; setTimeout(() => { if (b.isConnected) { b.classList.remove("armed"); b.textContent = o; } }, 4000); return false; };
    function wire() {
      main.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => { const it = itOf(b); copy(it.code ?? it.body ?? it.title); });
      main.querySelectorAll("[data-send]").forEach(b => b.onclick = () => sendToRoom(project, itOf(b).code));
      main.querySelectorAll("[data-pin]").forEach(b => b.onclick = async () => { await post(`/items/${itOf(b).id}/update`, { pinned: b.dataset.pin === "1" }).catch(e => toast(e.message)); refresh(); });
      main.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => { if (!armed(b, "แตะอีกครั้ง = ลบ")) return; const it = itOf(b); S.reveal.delete(it.id); await post(`/items/${it.id}/delete`).catch(e => toast(e.message)); refresh(); });
      main.querySelectorAll("[data-reveal]").forEach(b => b.onclick = async () => {
        const it = itOf(b);
        if (S.reveal.has(it.id)) { S.reveal.delete(it.id); return refresh(); }
        try { S.reveal.set(it.id, (await post(`/items/${it.id}/reveal`)).value); setTimeout(() => { if (S.reveal.delete(it.id) && S.tid === tid) refresh(); }, 30_000); refresh(); } catch (e) { toast(e.message); }
      });
      main.querySelectorAll("[data-scopy]").forEach(b => b.onclick = async () => {
        const it = itOf(b);
        try { const v = S.reveal.get(it.id) ?? (await post(`/items/${it.id}/reveal`)).value; copy(v, "คัดลอกรหัสแล้ว"); } catch (e) { toast(e.message); }
      });
      main.querySelectorAll("[data-open], [data-dl]").forEach(b => b.onclick = () => fetchFile(project, tid, itOf(b), b.hasAttribute("data-open")));
      const dt = main.querySelector("[data-delthread]"); if (dt) dt.onclick = async () => { if (!armed(dt, "แตะอีกครั้ง = ลบทั้งเธรด (รวมรหัสใน Keychain)")) return;
        try { await api(`/threads/${encodeURIComponent(tid)}/delete`, { method: "POST", body: JSON.stringify({ project }) }); openThreads(project, false); } catch (e) { toast(e.message); } };
    }
    // composer: โน้ต · คำสั่ง · 🔒 รหัส · ＋ ไฟล์
    const comp = document.createElement("div"); comp.className = "th-comp";
    const drawComp = () => {
      const k = S.kind;
      comp.innerHTML = `<div class="th-kinds">${[["note", "โน้ต"], ["cmd", "{ } คำสั่ง"], ["secret", "🔒 รหัส"], ["file", "＋ ไฟล์"]].map(([v, l]) => `<button class="${k === v ? "on" : ""}" data-k="${v}">${l}</button>`).join("")}</div>`
        + (k === "file" ? `<input type="file" class="th-in" multiple><div class="th-note">ไฟล์ละไม่เกิน 200 MB</div>`
          : `<input class="th-in" data-title placeholder="${k === "secret" ? "ชื่อรหัส เช่น DB dev (postgres)" : k === "cmd" ? "ชื่อคำสั่ง เช่น รัน backend dev" : "หัวข้อ"}" maxlength="120">`
            + (k === "cmd" ? `<textarea class="th-in mono" data-code placeholder="คำสั่ง" spellcheck="false" autocapitalize="off"></textarea>` : "")
            + (k === "secret" ? `<input class="th-in mono" data-secret type="password" placeholder="ค่า (เก็บใน Keychain ของ Mac)" autocomplete="off">` : "")
            + `<div style="display:flex;gap:8px"><input class="th-in" data-body placeholder="คำอธิบาย (ไม่บังคับ)" maxlength="4000"><button class="th-go" data-add>เพิ่ม</button></div>`);
      comp.querySelectorAll("[data-k]").forEach(b => b.onclick = () => { S.kind = b.dataset.k; drawComp(); });
      const add = comp.querySelector("[data-add]");
      if (add) add.onclick = async () => {
        const val = s => comp.querySelector(s)?.value ?? "";
        add.disabled = true;
        try { await post("/items", { kind: S.kind, title: val("[data-title]").trim(), body: val("[data-body]").trim() || undefined, code: S.kind === "cmd" ? val("[data-code]") : undefined, secret: S.kind === "secret" ? val("[data-secret]") : undefined });
          drawComp(); refresh(); toast(S.kind === "secret" ? "เก็บรหัสใน Keychain แล้ว" : "เพิ่มแล้ว"); }
        catch (e) { toast(e.message); add.disabled = false; }
      };
      const fi = comp.querySelector('input[type="file"]');
      if (fi) fi.onchange = async () => {
        for (const f of fi.files) {
          toast(`กำลังอัปโหลด ${f.name}…`);
          try { const r = await fetch(`/mobile/threads/${encodeURIComponent(tid)}/files?${q(project)}&name=${encodeURIComponent(f.name)}`, { method: "POST", body: f, headers: { authorization: "Bearer " + (store.get("maw-mobile-token") || "") } });
            const j = await r.json().catch(() => ({})); if (!r.ok || j.ok === false) throw new Error(j.error || "HTTP " + r.status); }
          catch (e) { toast(`${f.name}: ${e.message}`); }
        }
        fi.value = ""; refresh();
      };
    };
    drawComp(); $app.appendChild(comp);
    refresh();
  }
  mawExt.openThread = openThread;

  function copy(text, ok = "คัดลอกแล้ว") { navigator.clipboard?.writeText(String(text ?? "")).then(() => toast(ok), () => toast("คัดลอกไม่ได้ในเบราว์เซอร์นี้")); }
  async function fetchFile(project, tid, it, inline) {
    try {
      const r = await fetch(`/mobile/threads/${encodeURIComponent(tid)}/files/${encodeURIComponent(it.id)}?${q(project)}${inline ? "&inline=1" : ""}`, { headers: { authorization: "Bearer " + (store.get("maw-mobile-token") || "") } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const url = URL.createObjectURL(await r.blob());
      if (inline) window.open(url, "_blank"); else { const a = document.createElement("a"); a.href = url; a.download = it.file?.name || "file"; a.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { toast("เปิดไฟล์ไม่ได้: " + e.message); }
  }
  // "ส่งเข้าห้อง →": pick one of this project's agent rooms → open it → the command goes into its input box (not sent)
  function sendToRoom(project, code) {
    const p = state.projects.find(x => x.name === project);
    const rooms = p ? p.workspaces.flatMap(w => w.rooms.filter(r => r.agent).map(r => ({ w, r }))) : [];
    if (!rooms.length) { copy(code, "ไม่มีห้อง agent ในโปรเจคนี้ · คัดลอกคำสั่งไว้แล้ว"); return; }
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    bg.innerHTML = `<div class="sheet"><h2 style="margin:0 0 10px">ส่งเข้าห้องไหน</h2><div class="th-list">${rooms.map(({ w, r }, k) => `<button class="th-row" data-k="${k}"><span class="h">${dot(r.status)}</span><span class="t">${esc(r.title)}</span><em>${esc(r.agent)}</em></button>`).join("")}</div>
      <div class="th-note" style="margin-top:8px">ใส่ลงช่องพิมพ์ของห้องนั้น — ยังไม่ส่ง กด Enter เอง</div><button class="ghost" style="margin-top:12px;width:100%">ยกเลิก</button></div>`;
    document.body.appendChild(bg);
    bg.onclick = async e => {
      const b = e.target.closest("[data-k]"); if (!b) { if (e.target === bg || e.target.closest(".ghost")) bg.remove(); return; }
      bg.remove(); const { w, r } = rooms[+b.dataset.k];
      goRoom(project, w.id, r.id);
      for (let k = 0; k < 30 && !document.getElementById("msg"); k++) await new Promise(res => setTimeout(res, 100));
      putInBox(code);
    };
  }
})();
