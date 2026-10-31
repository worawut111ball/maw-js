// Phone UI pack "docs" — menu "📄 เอกสาร": ISO work products (folders "WP05 …") of every repo, read page by page on the
// phone (the Mac renders Word/Excel/PDF to images), jump between [TBD] marks, send a fix to a Claude room.
// Server: GET /docs · POST /docs/render {id} · GET /docs/page?id=&n=  (src/mobile/features/docs.ts)
(() => {
  if (!window.mawExt) return;
  const D = { data: null, at: 0, err: "", file: null, meta: null, polling: false, el: null, urls: [], marks: [], latest: null };
  const css = `
  .dc { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; } .dc > * { min-width: 0; }
  .dc-note { color: var(--dim); font-size: 12.5px; line-height: 1.5; }
  .dc-chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding: 2px 0 4px; } .dc-chips::-webkit-scrollbar { display: none; }
  .dc-chip { flex: none; display: grid; gap: 1px; padding: 7px 12px; border-radius: 12px; background: var(--card2); border: 1px solid var(--line); color: var(--dim); text-align: left; }
  .dc-chip b { font-size: 13.5px; color: var(--text); font-weight: 600; white-space: nowrap; } .dc-chip small { font-size: 11px; white-space: nowrap; }
  .dc-chip.on { background: var(--accent); border-color: var(--accent); } .dc-chip.on b, .dc-chip.on small { color: #031022; }
  .dc-chip .y { color: #fde047; font-weight: 700; } .dc-chip.on .y { color: #031022; }
  .dc-head { display: flex; align-items: flex-end; gap: 10px; padding: 4px 2px 0; }
  .dc-head .t { flex: 1; min-width: 0; } .dc-head h2 { margin: 0; font-size: 20px; line-height: 1.25; overflow-wrap: anywhere; }
  .dc-head small { display: block; color: var(--dim); font-size: 11.5px; overflow-wrap: anywhere; margin-top: 2px; }
  .dc-set { background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .dc-tbd { flex: none; padding: 2px 8px; border-radius: 99px; background: #fde04733; color: #fde047; font: 700 11.5px var(--font); font-variant-numeric: tabular-nums; }
  .dc-tbd.zero { background: #22c55e22; color: #4ade80; }
  .dc-wp { padding: 8px 12px 2px; color: var(--dim); font-size: 11.5px; font-weight: 600; letter-spacing: .02em; border-top: 1px solid var(--line); }
  .dc-f { display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 12px; text-align: left; color: var(--text); }
  .dc-f .ext { flex: none; width: 38px; padding: 3px 0; border-radius: 6px; text-align: center; font: 700 10.5px var(--mono); text-transform: uppercase; background: var(--card2); color: var(--dim); }
  .dc-f .ext.docx, .dc-f .ext.doc { background: #2563eb33; color: #93c5fd; } .dc-f .ext.xlsx, .dc-f .ext.xls { background: #16a34a33; color: #86efac; }
  .dc-f .ext.pdf { background: #dc262633; color: #fca5a5; } .dc-f .ext.txt { background: #64748b33; color: #cbd5e1; } .dc-f .ext.pptx, .dc-f .ext.ppt { background: #ea580c33; color: #fdba74; }
  .dc-f .n { flex: 1; min-width: 0; } .dc-f .n b { display: block; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; line-height: 1.35; }
  .dc-f.old { opacity: .55; } .dc-old { padding: 2px 12px 8px; color: var(--dim); font-size: 12px; } .dc-old a { color: var(--accent); }
  .dc-f .n span { display: block; color: var(--dim); font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .dc-top { position: sticky; top: 0; z-index: 2; display: grid; gap: 6px; padding: 8px 0; background: var(--bg); }
  .dc-top .t { font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; } .dc-top .p { color: var(--dim); font-size: 11.5px; overflow-wrap: anywhere; }
  .dc-bar { display: flex; gap: 6px; flex-wrap: wrap; }
  .dc-bar button { padding: 6px 12px; border-radius: 99px; background: var(--card2); color: var(--text); font: 600 12.5px var(--font); }
  .dc-bar button.y { background: #fde047; color: #1a1600; }
  .dc-list { display: grid; gap: 4px; max-height: 38dvh; overflow-y: auto; }
  .dc-t { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border-radius: 10px; background: var(--card); border: 1px solid var(--line); }
  .dc-t .pg { flex: none; color: #fde047; font: 700 12px var(--font); padding-top: 1px; } .dc-t .x { flex: 1; min-width: 0; font-size: 12.5px; line-height: 1.45; overflow-wrap: anywhere; }
  .dc-t button { flex: none; padding: 4px 10px; border-radius: 99px; background: var(--accent); color: #031022; font: 700 12px var(--font); }
  .dc-pages { display: grid; gap: 10px; }
  .dc-pg { scroll-margin-top: 150px; position: relative; background: #fff; border-radius: 6px; overflow: hidden; aspect-ratio: 800 / 1131; max-width: 100%; }
  .dc-pg img { display: block; width: 100%; height: auto; }
  .dc-pg .no { position: absolute; right: 6px; bottom: 6px; padding: 1px 7px; border-radius: 99px; background: #0009; color: #fff; font: 600 11px var(--font); }
  .dc-pg.hit { outline: 3px solid #fde047; outline-offset: 2px; }
  .dc-sheet textarea { width: 100%; min-height: 96px; margin: 8px 0; padding: 10px; border-radius: 10px; background: var(--card2); color: var(--text); border: 1px solid var(--line); font: 14px var(--font); }
  .dc-sheet .ctx { padding: 8px 10px; border-radius: 10px; background: #fde04722; color: var(--text); font-size: 12.5px; line-height: 1.45; overflow-wrap: anywhere; }
  .dc-pg .mk { position: absolute; left: 6px; top: 6px; z-index: 1; padding: 5px 10px; border-radius: 99px; background: #dc2626; color: #fff; font: 700 12px var(--font); box-shadow: 0 1px 4px #0006; }
  .dc-pg .mc { position: absolute; right: 6px; top: 6px; padding: 2px 8px; border-radius: 99px; background: #fde047; color: #1a1600; font: 700 11px var(--font); }
  .dc-bar button.r { background: #dc2626; color: #fff; }
  .dc-ed { position: fixed; inset: 0; z-index: 120; background: #0b0d16; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom); }
  .dc-ed .tb { display: flex; gap: 6px; align-items: center; padding: 8px 10px; overflow-x: auto; }
  .dc-ed .tb button { flex: none; padding: 7px 12px; border-radius: 99px; background: var(--card2); color: var(--text); font: 600 13px var(--font); }
  .dc-ed .tb button.on { outline: 2px solid var(--accent); }
  .dc-ed .tb .sp { flex: 1; }
  .dc-ed .cv { position: relative; display: flex; align-items: flex-start; justify-content: center; overflow: auto; }
  .dc-ed .cv .box { position: relative; background: #fff; }
  .dc-ed .cv img, .dc-ed .cv canvas { display: block; width: 100%; height: 100%; }
  .dc-ed .cv canvas { position: absolute; inset: 0; touch-action: none; }
  .dc-ed .ft { display: grid; gap: 8px; padding: 8px 12px 10px; background: var(--card); border-top: 1px solid var(--line); }
  .dc-ed textarea { width: 100%; min-height: 54px; padding: 8px 10px; border-radius: 10px; background: var(--card2); color: var(--text); border: 1px solid var(--line); font: 14px var(--font); }
  .dc-ed .row2 { display: flex; gap: 8px; } .dc-ed .row2 button { flex: 1; padding: 11px; border-radius: 12px; font: 700 14px var(--font); background: var(--card2); color: var(--text); }
  .dc-ed .row2 .go { background: #dc2626; color: #fff; }
  .dc-q { display: grid; gap: 8px; margin: 8px 0; }
  .dc-qi { display: flex; gap: 10px; align-items: center; padding: 8px; border-radius: 12px; background: var(--card2); }
  .dc-qi img { flex: none; width: 64px; height: 90px; object-fit: cover; object-position: top; border-radius: 6px; background: #fff; }
  .dc-qi .n { flex: 1; min-width: 0; font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; } .dc-qi .n b { display: block; } .dc-qi .n span { color: var(--dim); font-size: 12px; }
  .dc-qi button { flex: none; padding: 6px 10px; border-radius: 99px; background: var(--card); color: var(--text); font: 600 12px var(--font); }
  .dc-cmp { position: fixed; inset: 0; z-index: 120; background: #0b0d16; overflow-y: auto; padding: calc(10px + env(safe-area-inset-top)) 12px calc(16px + env(safe-area-inset-bottom)); display: grid; gap: 8px; align-content: start; }
  .dc-cmp h3 { margin: 6px 0 0; font-size: 14px; } .dc-cmp img { width: 100%; border-radius: 6px; background: #fff; }
  .dc-sheet select { width: 100%; padding: 9px; border-radius: 10px; background: var(--card2); color: var(--text); border: 1px solid var(--line); font: 14px var(--font); }`;
  if (!document.getElementById("dc-style")) { const s = document.createElement("style"); s.id = "dc-style"; s.textContent = css; document.head.appendChild(s); }

  const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const when = ms => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const size = n => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  const tbdOfSet = s => s.wps.reduce((a, w) => a + w.files.reduce((b, f) => b + (f.old ? 0 : f.tbd || 0), 0), 0);   // latest versions only
  const tbdBadge = n => n == null ? "" : `<span class="dc-tbd ${n ? "" : "zero"}">${n ? `TBD ${n}` : "✓"}</span>`;

  // the open document and the page being read survive a reload
  const saveView = () => store.set("maw-docs-view", JSON.stringify(D.file ? { id: D.file.id, set: D.file.set.id, page: D.page || 1 } : null));
  function reopen() {
    if (D.file || !D.data || reopen.done) return; reopen.done = true;
    let v = null; try { v = JSON.parse(store.get("maw-docs-view") || "null"); } catch {}
    const s = v && D.data.sets.find(x => x.id === v.set), f = s?.wps.flatMap(w => w.files).find(x => x.id === v.id);
    if (!f) return;
    D.sel = s.id; D.file = { ...f, set: s }; D.meta = null; D.hit = -1; D.page = v.page; D.goTo = v.page; draw(); render();
  }
  async function refresh(force) {
    try { D.data = await api("/docs" + (force ? "?refresh=1" : "")); D.at = Date.now(); D.err = ""; } catch (e) { D.err = e.message; }
    if (!D.file) { reopen(); if (!D.file) draw(); }
    mawExt.refreshTiles?.();
  }

  const fileRow = (s, f) => `<button class="dc-f ${f.old ? "old" : ""}" data-f="${esc(f.id)}" data-s="${esc(s.id)}"><span class="ext ${esc(f.ext)}">${esc(f.ext)}</span><span class="n"><b>${esc(f.name)}</b><span>${f.old ? "รุ่นเก่า · " : ""}${when(f.mtime)} · ${size(f.size)}</span></span>${f.old ? "" : tbdBadge(f.tbd)}</button>`;
  function fileRows(s, w) {
    const cur = w.files.filter(f => !f.old), old = w.files.filter(f => f.old), key = s.id + "|" + w.wp, show = D.oldOpen?.has(key);
    return cur.map(f => fileRow(s, f)).join("") + (old.length ? (show ? old.map(f => fileRow(s, f)).join("") : `<div class="dc-old"><a href="#" data-old="${esc(key)}">รุ่นเก่า ${old.length} ไฟล์</a></div>`) : "");
  }
  // chips strip keeps its scroll across redraws; the chosen one stays in view
  function keepChip() {
    const c = D.el.querySelector(".dc-chips"); if (!c) return;
    c.scrollLeft = D.chipX || 0;
    const on = c.querySelector(".on"); if (on && (on.offsetLeft < c.scrollLeft || on.offsetLeft + on.offsetWidth > c.scrollLeft + c.clientWidth)) on.scrollIntoView({ inline: "nearest", block: "nearest" });
    c.onscroll = () => { D.chipX = c.scrollLeft; };
  }
  function draw() {
    const el = D.el; if (!el || !el.isConnected) return;
    if (D.file) return drawDoc();
    if (!D.data) { el.innerHTML = `<div class="dc-note">${D.err ? "โหลดไม่ได้: " + esc(D.err) : "กำลังหาเอกสารในเครื่อง…"}</div>`; return; }
    const sets = D.data.sets;
    if (!sets.find(x => x.id === D.sel)) D.sel = sets.find(x => x.id === store.get("maw-docs-set"))?.id || sets[0]?.id;
    const s = sets.find(x => x.id === D.sel);
    const nFiles = x => x.wps.reduce((a, w) => a + w.files.filter(f => !f.old).length, 0);
    el.innerHTML = sets.length ? `<div class="dc-chips">${sets.map(x => { const t = tbdOfSet(x); return `<button class="dc-chip ${x.id === D.sel ? "on" : ""}" data-sel="${esc(x.id)}"><b>${esc(x.label)}</b><small>${x.sub ? esc(x.sub) + " · " : ""}${t ? `<span class="y">TBD ${t}</span>` : "✓ ครบ"}</small></button>`; }).join("")}</div>
      <div class="dc-head"><div class="t"><h2>${esc(s.label)}</h2><small>${esc(s.path)} · ${s.wps.length} WP · ${nFiles(s)} ไฟล์</small></div>${tbdBadge(tbdOfSet(s))}</div>
      <div class="dc-set">${s.wps.map(w => `<div class="dc-wp">${esc(w.wp)} ${esc(w.title)}</div>${w.files.length ? fileRows(s, w) : `<div class="dc-note" style="padding:4px 12px 8px">— ยังไม่มีไฟล์</div>`}`).join("")}</div>
      <div class="dc-note">ป้ายเหลือง = จุด [TBD] ที่ยังต้องเติม (นับเฉพาะรุ่นล่าสุด) · ${D.data.indexing ? "กำลังสแกนใหม่…" : `สแกนล่าสุด ${when(D.data.at || Date.now())}`} · <a href="#" id="dc-re" style="color:var(--accent)">สแกนใหม่</a></div>`
      : `<div class="dc-note">ยังไม่เจอโฟลเดอร์ WP (WP05, WP18 …) ในเครื่อง</div>`;
    el.querySelectorAll("[data-sel]").forEach(b => b.onclick = e => { e.preventDefault(); D.sel = b.dataset.sel; store.set("maw-docs-set", D.sel); draw(); });
    keepChip();
    el.querySelectorAll("[data-old]").forEach(a => a.onclick = e => { e.preventDefault(); (D.oldOpen ||= new Set()).add(a.dataset.old); draw(); });
    el.querySelectorAll("[data-f]").forEach(b => b.onclick = e => {
      e.preventDefault();
      const s = sets.find(x => x.id === b.dataset.s), f = s.wps.flatMap(w => w.files).find(x => x.id === b.dataset.f);
      D.file = { ...f, set: s }; D.meta = null; D.hit = -1; D.page = 1; draw(); render();
    });
    const re = document.getElementById("dc-re"); if (re) re.onclick = e => { e.preventDefault(); D.data.indexing = true; draw(); refresh(true); };
  }

  async function render() {
    const f = D.file; if (!f || D.polling) return;
    D.polling = true;
    try {
      for (;;) {
        const r = await api("/docs/render", { method: "POST", body: JSON.stringify({ id: f.id }) });
        if (D.file !== f) return;
        if (r.state === "ready") { D.meta = r; await loadMarks(); drawDoc(); return; }
        await new Promise(res => setTimeout(res, 1500));
        if (D.file !== f || !D.el?.isConnected) return;
      }
    } catch (e) { if (D.file === f) { D.meta = { error: e.message }; drawDoc(); } }
    finally { D.polling = false; }
  }

  function freeUrls() { for (const u of D.urls) URL.revokeObjectURL(u); D.urls = []; queue.length = 0; }
  function drawDoc() {
    const el = D.el, f = D.file, m = D.meta; if (!el || !el.isConnected) return;
    freeUrls();
    const tbd = m?.tbd || [];
    el.innerHTML = `<div class="dc-top"><div class="t">${esc(f.name)}</div><div class="p">${esc(f.set.label)}${f.set.sub ? " · " + esc(f.set.sub) : ""} · ${when(f.mtime)}</div>
        <div class="dc-bar"><button id="dc-back">← รายการ</button>${tbd.length ? `<button class="y" id="dc-next">ไป TBD ถัดไป (${tbd.length})</button>` : ""}<button id="dc-say">💬 สั่งแก้ไฟล์นี้</button>${pending().length ? `<button class="r" id="dc-q">📝 รอส่ง ${pending().length} จุด</button>` : ""}${sent().length ? `<button id="dc-sent">✅ ส่งแล้ว ${sent().length}</button>` : ""}</div></div>
      ${!m ? `<div class="dc-note">กำลังแปลงเอกสารเป็นภาพ… ครั้งแรกของแต่ละไฟล์ใช้ราว 10–40 วินาที ครั้งต่อไปเปิดทันที</div>`
        : m.error ? `<div class="dc-note">เปิดไม่ได้: ${esc(m.error)}</div>`
        : `${tbd.length ? `<div class="dc-list">${tbd.map((t, i) => `<div class="dc-t"><span class="pg">หน้า ${t.page}</span><span class="x" data-go="${i}">${esc(t.text)}</span><button data-fix="${i}">ตอบ</button></div>`).join("")}</div>` : `<div class="dc-note">ไม่มี [TBD] ในไฟล์นี้ ✓</div>`}
           <div class="dc-note">${m.pages} หน้า · แตะหน้าเพื่อซูม (โหลดภาพคมชัดตอนซูม)</div>
           <div class="dc-pages">${Array.from({ length: m.pages }, (_, i) => `<div class="dc-pg" data-n="${i + 1}" id="dc-p${i + 1}"><button class="mk" data-mk="${i + 1}">✏️ ขีด</button>${pendingOn(i + 1) ? `<span class="mc">${pendingOn(i + 1)} จุด</span>` : ""}<span class="no">${i + 1}</span></div>`).join("")}</div>`}`;
    document.getElementById("dc-back").onclick = () => { freeUrls(); D.file = null; D.meta = null; saveView(); draw(); };
    saveView();
    document.getElementById("dc-say").onclick = () => fixSheet(null);
    const q = document.getElementById("dc-q"); if (q) q.onclick = queueSheet;
    const sn = document.getElementById("dc-sent"); if (sn) sn.onclick = sentSheet;
    el.querySelectorAll("[data-mk]").forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); editor(+b.dataset.mk); });
    const next = document.getElementById("dc-next");
    if (next) next.onclick = () => { D.hit = (D.hit + 1) % tbd.length; goPage(tbd[D.hit].page); };
    el.querySelectorAll("[data-go]").forEach(x => x.onclick = e => { e.preventDefault(); D.hit = +x.dataset.go; goPage(tbd[D.hit].page); });
    el.querySelectorAll("[data-fix]").forEach(b => b.onclick = e => { e.preventDefault(); fixSheet(tbd[+b.dataset.fix]); });
    if (m && !m.error) lazyPages();
  }
  function goPage(n) {
    const p = document.getElementById("dc-p" + n); if (!p) return;
    document.querySelectorAll(".dc-pg.hit").forEach(x => x.classList.remove("hit"));
    p.classList.add("hit"); load(p, true); p.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // pages download two at a time (on 4G a burst of ten makes every one of them late) — nearest to the screen first
  const queue = []; let active = 0;
  async function getPage(f, n, hd) {
    const t0 = performance.now();
    const res = await fetch(`/mobile/docs/page?id=${encodeURIComponent(f.id)}&n=${n}${hd ? "&hd=1" : ""}`, { headers: { authorization: "Bearer " + (store.get("maw-mobile-token") || "") } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const url = URL.createObjectURL(await res.blob()); D.urls.push(url);
    if (typeof perfNote === "function") perfNote("/docs/page" + (hd ? "-hd" : ""), performance.now() - t0);
    return url;
  }
  function pump() {
    while (active < 2 && queue.length) {
      const p = queue.shift(), f = D.file;
      if (!p.isConnected || D.file !== f) continue;
      active++;
      getPage(f, p.dataset.n).then(url => {
        if (D.file !== f) return;
        const img = document.createElement("img"); img.src = url; img.alt = "หน้า " + p.dataset.n;
        img.onclick = e => zoomPage(e, f, p.dataset.n, url);
        p.prepend(img); p.style.aspectRatio = "auto";
      }).catch(() => { delete p.dataset.loaded; }).finally(() => { active--; pump(); });
    }
  }
  function load(p, first) {
    if (p.dataset.loaded) return; p.dataset.loaded = 1;
    first ? queue.unshift(p) : queue.push(p); pump();
  }
  // zoom: show the page we have at once, swap in the 1600 px one when it arrives
  async function zoomPage(e, f, n, url) {
    e.preventDefault(); e.stopPropagation();
    const z = document.createElement("div"); z.className = "zoom";
    z.innerHTML = `<img src="${url}" alt="หน้า ${esc(n)}"><button class="x" aria-label="ปิด">✕</button>`;
    z.onclick = () => z.remove();
    document.body.appendChild(z);
    try { const hd = await getPage(f, n, true); const img = z.querySelector("img"); if (img) img.src = hd; } catch { /* keep the small one */ }
  }
  function lazyPages() {
    const io = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { load(e.target); io.unobserve(e.target); } }, { rootMargin: "600px 0px" });
    // which page is being read (top of the screen) → remembered for a reload
    const seen = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { D.page = +e.target.dataset.n; clearTimeout(D.saveT); D.saveT = setTimeout(saveView, 400); } }, { rootMargin: "-20% 0px -70% 0px" });
    D.el.querySelectorAll(".dc-pg").forEach(p => { io.observe(p); seen.observe(p); });
    if (D.goTo > 1) { const n = D.goTo; D.goTo = 0; requestAnimationFrame(() => { const p = document.getElementById("dc-p" + n); if (p) { load(p, true); p.scrollIntoView({ block: "start" }); } }); }
  }

  // ── send a fix to a Claude/Codex room: the room working in this project first ──
  function agentRooms() {
    const out = [];
    for (const p of state.projects || []) for (const w of p.workspaces) for (const r of w.rooms)
      if (r.agent && r.status !== "ended" && r.status !== "asleep") out.push({ ws: w.id, room: r.id, label: `${p.name} · ${r.title}`, project: p.name });
    return out;
  }
  function fixSheet(t) {
    const f = D.file, rooms = agentRooms();
    if (!rooms.length) { toast("ไม่มีห้อง Claude / Codex ที่เปิดอยู่"); return; }
    const words = f.set.path.toLowerCase().split(/[\/ ]+/);
    const last = store.get("maw-docs-room");
    const pick = rooms.find(r => r.ws + "|" + r.room === last) || rooms.find(r => words.includes(r.project.toLowerCase())) || rooms[0];
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    bg.innerHTML = `<div class="sheet dc-sheet"><h2>${t ? `ตอบ TBD หน้า ${t.page}` : "สั่งแก้ไฟล์นี้"}</h2>
      <div class="dc-note" style="overflow-wrap:anywhere">${esc(f.set.path)}/…/${esc(f.name)}</div>
      ${t ? `<div class="ctx">${esc(t.text)}</div>` : ""}
      <textarea id="dc-txt" placeholder="${t ? "คำตอบสำหรับจุดนี้ เช่น วันที่อนุมัติ 5/11/69" : "อยากให้แก้อะไรในเอกสารนี้"}"></textarea>
      <div class="dc-note">ส่งเข้าห้อง</div><select id="dc-room">${rooms.map(r => `<option value="${esc(r.ws + "|" + r.room)}" ${r === pick ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select>
      <div class="row" style="gap:8px;margin-top:12px"><button class="ghost" id="dc-x" style="flex:1">ยกเลิก</button><button class="primary" id="dc-go" style="flex:1">ส่ง</button></div></div>`;
    document.body.appendChild(bg);
    const close = () => bg.remove();
    bg.onclick = e => { if (e.target === bg) close(); };
    bg.querySelector("#dc-x").onclick = close;
    const txt = bg.querySelector("#dc-txt"); setTimeout(() => txt.focus(), 50);
    bg.querySelector("#dc-go").onclick = async () => {
      const say = txt.value.trim(); if (!say) { toast("พิมพ์สิ่งที่ต้องแก้ก่อน"); return; }
      const [ws, room] = bg.querySelector("#dc-room").value.split("|");
      const where = t ? `หน้า ${t.page} ตรง "${t.text}"` : "";
      const wp = f.set.wps.find(w => w.files.some(x => x.id === f.id));
      const text = `📄 แก้เอกสาร ${f.set.path}/${wp ? `${wp.wp} ${wp.title}/` : ""}${f.name}${where ? " — " + where : ""}\n${say}`;
      try { await api(`/rooms/${encodeURIComponent(ws)}/${encodeURIComponent(room)}/send`, { method: "POST", body: JSON.stringify({ text }) }); store.set("maw-docs-room", ws + "|" + room); toast("ส่งเข้าห้องแล้ว"); close(); }
      catch (e) { toast("ส่งไม่ได้: " + e.message); }
    };
  }

  // ── pen marks ──
  const pending = () => D.marks.filter(m => !m.sentAt), sent = () => D.marks.filter(m => m.sentAt);
  const pendingOn = n => pending().filter(m => m.page === n).length;
  async function loadMarks() {
    try { const r = await api(`/docs/marks?id=${encodeURIComponent(D.file.id)}`); D.marks = r.marks; D.latest = r.latest; } catch { D.marks = []; }
  }
  async function markImg(mid) {
    const res = await fetch(`/mobile/docs/mark-img?mid=${encodeURIComponent(mid)}`, { headers: { authorization: "Bearer " + (store.get("maw-mobile-token") || "") } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const u = URL.createObjectURL(await res.blob()); D.urls.push(u); return u;
  }
  /** Full-screen page with a pen on top: red ink or yellow highlighter, undo, a note → kept in the queue. */
  async function editor(n) {
    const f = D.file;
    const ed = document.createElement("div"); ed.className = "dc-ed";
    ed.innerHTML = `<div class="tb"><button class="on" data-tool="pen">🖊 ปากกาแดง</button><button data-tool="hi">🖍 ไฮไลต์</button><button id="ed-undo">↶ ย้อน</button><button id="ed-clr">ล้าง</button><span class="sp"></span><span style="color:var(--dim);font-size:12px;flex:none">หน้า ${n}</span></div>
      <div class="cv"><div class="dc-note" style="padding:20px">กำลังโหลดหน้า…</div></div>
      <div class="ft"><textarea id="ed-note" placeholder="บอกสั้นๆ ว่าแก้อะไร เช่น เปลี่ยนเป็น 1.0.3 · รูปนี้เก่า · ลบย่อหน้านี้"></textarea>
        <div class="row2"><button id="ed-x">ยกเลิก</button><button class="go" id="ed-ok">เก็บไว้ในรายการ</button></div></div>`;
    document.body.appendChild(ed);
    const close = () => ed.remove();
    ed.querySelector("#ed-x").onclick = close;
    let url; try { url = await getPage(f, n, true); } catch (e) { ed.querySelector(".cv").innerHTML = `<div class="dc-note" style="padding:20px">โหลดไม่ได้: ${esc(e.message)}</div>`; return; }
    const img = new Image(); img.src = url; await img.decode().catch(() => {});
    const cv = ed.querySelector(".cv"), r = img.naturalHeight / img.naturalWidth || 1.414;
    const W = Math.min(cv.clientWidth, (cv.clientHeight - 4) / r), H = W * r;
    cv.innerHTML = `<div class="box" style="width:${W}px;height:${H}px"></div>`;
    const box = cv.querySelector(".box"); box.appendChild(img);
    const c = document.createElement("canvas"), dpr = devicePixelRatio || 1; c.width = W * dpr; c.height = H * dpr; box.appendChild(c);
    const g = c.getContext("2d");
    const strokes = []; let tool = "pen", cur = null;
    const style = (ctx, t, scale) => { ctx.lineCap = ctx.lineJoin = "round"; ctx.strokeStyle = t === "pen" ? "#e11d2a" : "rgba(253,224,71,.45)"; ctx.lineWidth = (t === "pen" ? 3 : 16) * scale; };
    const paint = (ctx, w, h, scale) => { for (const s of strokes) { style(ctx, s.t, scale); ctx.beginPath(); s.p.forEach(([x, y], i) => i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)); ctx.stroke(); } };
    const redraw = () => { g.clearRect(0, 0, c.width, c.height); paint(g, c.width, c.height, dpr); };
    const at = e => { const b = c.getBoundingClientRect(); return [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height]; };
    c.onpointerdown = e => { c.setPointerCapture(e.pointerId); cur = { t: tool, p: [at(e)] }; strokes.push(cur); redraw(); };
    c.onpointermove = e => { if (!cur) return; cur.p.push(at(e)); redraw(); };
    c.onpointerup = c.onpointercancel = () => { cur = null; };
    ed.querySelectorAll("[data-tool]").forEach(b => b.onclick = () => { tool = b.dataset.tool; ed.querySelectorAll("[data-tool]").forEach(x => x.classList.toggle("on", x === b)); });
    ed.querySelector("#ed-undo").onclick = () => { strokes.pop(); redraw(); };
    ed.querySelector("#ed-clr").onclick = () => { strokes.length = 0; redraw(); };
    ed.querySelector("#ed-ok").onclick = async e => {
      const note = ed.querySelector("#ed-note").value.trim();
      if (!strokes.length && !note) { toast("ขีดหรือพิมพ์อย่างน้อยหนึ่งอย่าง"); return; }
      const b = e.currentTarget; b.disabled = true; b.textContent = "กำลังเก็บ…";
      // the page as the AI will see it: page + ink, 1200 px wide JPEG (small enough for a 4G upload)
      const out = document.createElement("canvas"), OW = Math.min(1200, img.naturalWidth || 1200), OH = Math.round(OW * r);
      out.width = OW; out.height = OH;
      const o = out.getContext("2d"); o.fillStyle = "#fff"; o.fillRect(0, 0, OW, OH); o.drawImage(img, 0, 0, OW, OH); paint(o, OW, OH, OW / W);
      try {
        await api("/docs/marks", { method: "POST", body: JSON.stringify({ id: f.id, page: n, note, image: out.toDataURL("image/jpeg", 0.78) }) });
        toast("เก็บไว้แล้ว — ส่งทั้งหมดได้ที่ปุ่ม 📝 รอส่ง"); close();
        await loadMarks(); if (D.file === f) { const y = window.scrollY; drawDoc(); goPage(n); }
      } catch (err) { toast("เก็บไม่ได้: " + err.message); b.disabled = false; b.textContent = "เก็บไว้ในรายการ"; }
    };
  }
  function sheet(html) {
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    bg.innerHTML = `<div class="sheet dc-sheet">${html}</div>`;
    document.body.appendChild(bg);
    bg.onclick = e => { if (e.target === bg) bg.remove(); };
    return bg;
  }
  async function thumbs(bg) {
    for (const im of bg.querySelectorAll("img[data-mid]")) markImg(im.dataset.mid).then(u => { im.src = u; }).catch(() => {});
  }
  function queueSheet() {
    const f = D.file, list = pending().sort((a, b) => a.page - b.page), rooms = agentRooms();
    const words = f.set.path.toLowerCase().split(/[\/ ]+/), last = store.get("maw-docs-room");
    const pick = rooms.find(r => r.ws + "|" + r.room === last) || rooms.find(r => words.includes(r.project.toLowerCase())) || rooms[0];
    const bg = sheet(`<h2>รอส่ง ${list.length} จุด</h2><div class="dc-note">AI จะได้ภาพแต่ละหน้าที่ขีดไว้ + โน้ต แล้วแก้ในไฟล์ ${esc(D.latest?.name || f.name)}</div>
      <div class="dc-q">${list.map(m => `<div class="dc-qi"><img data-mid="${esc(m.mid)}" alt=""><div class="n"><b>หน้า ${m.page}</b>${esc(m.note) || '<span>— ไม่มีโน้ต (ดูจากที่ขีด)</span>'}</div><button data-del="${esc(m.mid)}">ลบ</button></div>`).join("")}</div>
      ${rooms.length ? `<div class="dc-note">ส่งเข้าห้อง</div><select id="dc-room">${rooms.map(r => `<option value="${esc(r.ws + "|" + r.room)}" ${r === pick ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select>` : `<div class="dc-note">ไม่มีห้อง Claude / Codex ที่เปิดอยู่</div>`}
      <div class="row" style="gap:8px;margin-top:12px"><button class="ghost" id="dc-x" style="flex:1">ปิด</button><button class="primary" id="dc-send" style="flex:1;margin-top:0" ${rooms.length ? "" : "disabled"}>ส่งทั้งหมดให้ AI แก้</button></div>`);
    thumbs(bg);
    bg.querySelector("#dc-x").onclick = () => bg.remove();
    bg.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
      try { await api("/docs/marks/delete", { method: "POST", body: JSON.stringify({ id: f.id, mid: b.dataset.del }) }); await loadMarks(); bg.remove(); drawDoc(); if (pending().length) queueSheet(); } catch (e) { toast(e.message); }
    });
    const go = bg.querySelector("#dc-send");
    go.onclick = async () => {
      const [ws, room] = bg.querySelector("#dc-room").value.split("|");
      go.disabled = true; go.textContent = "กำลังส่ง…";
      try {
        const r = await api("/docs/marks/send", { method: "POST", body: JSON.stringify({ id: f.id, ws, room }) });
        store.set("maw-docs-room", ws + "|" + room); toast(`ส่ง ${r.sent} จุดเข้าห้องแล้ว`); bg.remove(); await loadMarks(); drawDoc();
      } catch (e) { toast("ส่งไม่ได้: " + e.message); go.disabled = false; go.textContent = "ส่งทั้งหมดให้ AI แก้"; }
    };
  }
  function sentSheet() {
    const list = sent().sort((a, b) => b.sentAt - a.sentAt || a.page - b.page);
    const newer = D.latest && list.some(m => D.latest.mtime > m.ver);
    const bg = sheet(`<h2>ส่งให้ AI แก้แล้ว ${list.length} จุด</h2><div class="dc-note">${newer ? `ไฟล์มีรุ่นใหม่แล้ว (${esc(D.latest.name)} · ${when(D.latest.mtime)}) — กด "เทียบ" ดูก่อน/หลัง` : "ไฟล์ยังไม่ถูกแก้หลังส่ง — รอ AI แก้เสร็จแล้วกด \"เทียบ\""}</div>
      <div class="dc-q">${list.map(m => `<div class="dc-qi"><img data-mid="${esc(m.mid)}" alt=""><div class="n"><b>หน้า ${m.page}</b>${esc(m.note) || ""}<br><span>ส่ง ${when(m.sentAt)}</span></div><button data-cmp="${esc(m.mid)}">เทียบ</button></div>`).join("")}</div>
      <button class="ghost" id="dc-x" style="width:100%;margin-top:8px">ปิด</button>`);
    thumbs(bg);
    bg.querySelector("#dc-x").onclick = () => bg.remove();
    bg.querySelectorAll("[data-cmp]").forEach(b => b.onclick = () => { bg.remove(); compare(list.find(m => m.mid === b.dataset.cmp)); });
  }
  /** Before = the page as marked · after = the same page of the newest version (◀ ▶ when pages moved). */
  async function compare(m) {
    const z = document.createElement("div"); z.className = "dc-cmp";
    let off = 0;
    const after = D.latest || { id: D.file.id, name: D.file.name, mtime: D.file.mtime };
    z.innerHTML = `<div class="dc-bar"><button id="cx">✕ ปิด</button><button id="cp">◀ หน้าก่อน</button><button id="cn">หน้าถัดไป ▶</button></div>
      <h3>ก่อน — หน้า ${m.page} ที่ขีดไว้${m.note ? ` · ${esc(m.note)}` : ""}</h3><img id="cb" alt="ก่อน">
      <h3 id="ah">หลัง — ${esc(after.name)}</h3><div class="dc-note" id="as">กำลังโหลด…</div><img id="ca" alt="หลัง">`;
    document.body.appendChild(z);
    z.querySelector("#cx").onclick = () => z.remove();
    markImg(m.mid).then(u => { z.querySelector("#cb").src = u; }).catch(() => {});
    let pages = 0;
    try {
      for (;;) { const r = await api("/docs/render", { method: "POST", body: JSON.stringify({ id: after.id }) }); if (r.state === "ready") { pages = r.pages; break; } await new Promise(res => setTimeout(res, 1500)); if (!z.isConnected) return; }
    } catch (e) { z.querySelector("#as").textContent = "เปิดรุ่นใหม่ไม่ได้: " + e.message; return; }
    const show = async () => {
      const n = Math.min(Math.max(1, m.page + off), pages);
      z.querySelector("#ah").textContent = `หลัง — ${after.name} · หน้า ${n}${after.mtime > m.ver ? "" : " (ยังเป็นรุ่นเดิม)"}`;
      z.querySelector("#as").textContent = "";
      try { z.querySelector("#ca").src = await getPage({ id: after.id }, n, true); } catch (e) { z.querySelector("#as").textContent = e.message; }
    };
    z.querySelector("#cp").onclick = () => { off--; show(); };
    z.querySelector("#cn").onclick = () => { off++; show(); };
    show();
  }

  mawExt.pages.push({
    key: "docs", icon: "📄", title: "เอกสาร",
    summary() {
      if (!D.data) return { text: D.err ? "โหลดไม่ได้" : "ISO · …" };
      const n = D.data.sets.reduce((a, s) => a + tbdOfSet(s), 0), files = D.data.sets.reduce((a, s) => a + s.wps.reduce((b, w) => b + w.files.length, 0), 0);
      return { text: `${files} ไฟล์${n ? ` · TBD ${n}` : ""}`, badge: "" };
    },
    mount(el) { D.el = document.createElement("div"); D.el.className = "dc"; el.appendChild(D.el); reopen(); draw(); if (D.file && !D.meta) render(); if (Date.now() - D.at > 60_000) refresh(false); },
  });
  refresh(false);
})();
