// Phone UI pack "vault" — menu "📦 คลังไฟล์": put photos / files from any phone on the Mac (originals, never resized),
// take them back on any other device — one at a time, many as one zip, or "save to Photos" through the share sheet.
// Server: GET /vault · POST /vault/upload · GET /vault/thumb/:id · POST /vault/link · POST /vault/zip · POST /vault/delete
(() => {
  if (!window.mawExt) return;
  const V = { data: null, err: "", el: null, sel: new Set(), picking: false, filter: "all", up: null, thumbs: new Map(), at: 0 };
  const css = `
  .vt { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; } .vt > * { min-width: 0; }
  .vt-note { color: var(--dim); font-size: 12.5px; line-height: 1.5; }
  .vt-top { display: flex; gap: 8px; align-items: stretch; }
  .vt-add { flex: 1; padding: 13px; border-radius: 14px; background: var(--accent); color: #031022; font: 700 15px var(--font); }
  .vt-pick { flex: none; padding: 0 14px; border-radius: 14px; background: var(--card2); color: var(--text); font: 600 13.5px var(--font); }
  .vt-pick.on { outline: 2px solid var(--accent); }
  .vt-bar { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; } .vt-bar::-webkit-scrollbar { display: none; }
  .vt-bar button { flex: none; padding: 6px 12px; border-radius: 99px; background: var(--card2); color: var(--dim); font: 600 12.5px var(--font); }
  .vt-bar button.on { background: var(--accent); color: #031022; }
  .vt-up { padding: 10px 12px; border-radius: 12px; background: var(--card); border: 1px solid var(--line); font-size: 13px; }
  .vt-up .bar { height: 6px; border-radius: 99px; background: var(--card2); margin-top: 6px; overflow: hidden; } .vt-up .bar i { display: block; height: 100%; background: var(--accent); width: 0; transition: width .2s; }
  .vt-day { margin: 6px 2px 0; color: var(--dim); font-size: 12px; font-weight: 600; }
  .vt-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
  .vt-it { position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--card2); }
  .vt-it img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .vt-it .ic { position: absolute; inset: 0; display: grid; place-items: center; align-content: center; gap: 4px; padding: 6px; text-align: center; color: var(--dim); font-size: 11px; overflow-wrap: anywhere; }
  .vt-it .ic b { font-size: 26px; }
  .vt-it .tag { position: absolute; left: 4px; bottom: 4px; padding: 1px 6px; border-radius: 99px; background: #000a; color: #fff; font: 600 10px var(--font); }
  .vt-it .ck { position: absolute; right: 5px; top: 5px; width: 22px; height: 22px; border-radius: 50%; border: 2px solid #fff; background: #0005; }
  .vt-it.sel .ck { background: var(--accent); border-color: var(--accent); } .vt-it.sel .ck::after { content: "✓"; display: block; text-align: center; color: #031022; font: 800 13px/18px var(--font); }
  .vt-it.sel img { opacity: .75; }
  .vt-act { position: sticky; bottom: 8px; display: flex; gap: 6px; padding: 8px; border-radius: 16px; background: var(--card); border: 1px solid var(--line); box-shadow: 0 4px 16px #0008; }
  .vt-act button { flex: 1; padding: 10px 6px; border-radius: 12px; background: var(--card2); color: var(--text); font: 700 13px var(--font); }
  .vt-act button.go { background: var(--accent); color: #031022; } .vt-act button.del { color: #fca5a5; }
  .vt-view { position: fixed; inset: 0; z-index: 120; background: #000; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom); }
  .vt-view .hd { display: flex; gap: 8px; align-items: center; padding: 8px 12px; color: #fff; font-size: 13px; } .vt-view .hd span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .vt-view .bd { display: grid; place-items: center; overflow: auto; } .vt-view img, .vt-view video { max-width: 100vw; max-height: 100%; }
  .vt-view .ft { display: flex; gap: 6px; padding: 8px 12px; } .vt-view .ft button, .vt-view .hd button { flex: 1; padding: 11px; border-radius: 12px; background: #ffffff1f; color: #fff; font: 700 13px var(--font); }
  .vt-view .hd button { flex: none; padding: 8px 12px; }`;
  if (!document.getElementById("vt-style")) { const s = document.createElement("style"); s.id = "vt-style"; s.textContent = css; document.head.appendChild(s); }

  const auth = () => ({ authorization: "Bearer " + (store.get("maw-mobile-token") || "") });
  const size = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + " GB" : n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const dayOf = ms => { const d = new Date(ms), t = new Date(), y = new Date(Date.now() - 864e5); return d.toDateString() === t.toDateString() ? "วันนี้" : d.toDateString() === y.toDateString() ? "เมื่อวาน" : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear() + 543 - 2500}`; };
  const hhmm = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  // what to call this phone in the list ("ฝากจาก …") — the user can rename it once
  const devName = () => store.get("maw-device-name") || (/iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "Android" : /Mac/.test(navigator.userAgent) ? "Mac" : "เครื่องอื่น");
  const ICON = { video: "🎬", file: "📄", image: "🖼" };

  async function refresh() {
    try { V.data = await api("/vault"); V.err = ""; V.at = Date.now(); } catch (e) { V.err = e.message; }
    draw(); mawExt.refreshTiles?.();
  }
  const shown = () => (V.data?.items || []).filter(x => V.filter === "all" || x.kind === V.filter);

  function draw() {
    const el = V.el; if (!el || !el.isConnected) return;
    if (!V.data) { el.innerHTML = `<div class="vt-note">${V.err ? "โหลดไม่ได้: " + esc(V.err) : "กำลังโหลด…"}</div>`; return; }
    const items = shown(), all = V.data.items;
    const count = k => all.filter(x => k === "all" || x.kind === k).length;
    const groups = []; for (const it of items) { const d = dayOf(it.at); (groups.at(-1)?.d === d ? groups.at(-1).list : (groups.push({ d, list: [] }), groups.at(-1).list)).push(it); }
    el.innerHTML = `<div class="vt-top"><button class="vt-add" id="vt-add">＋ อัปโหลดรูป / ไฟล์</button>${all.length ? `<button class="vt-pick ${V.picking ? "on" : ""}" id="vt-pick">${V.picking ? "ยกเลิก" : "เลือก"}</button>` : ""}</div>
      <input type="file" id="vt-in" multiple hidden>
      ${V.up ? `<div class="vt-up">${esc(V.up.text)}<div class="bar"><i style="width:${V.up.pct}%"></i></div></div>` : ""}
      <div class="vt-note">เก็บไฟล์ต้นฉบับบน Mac (ไม่ย่อรูป) · ${all.length} ไฟล์ · ใช้ไป ${size(V.data.used)} · Mac เหลือที่ว่าง ${size(V.data.free)} · เครื่องนี้ชื่อ <a href="#" id="vt-dev" style="color:var(--accent)">${esc(devName())}</a></div>
      ${all.length ? `<div class="vt-bar">${[["all", "ทั้งหมด"], ["image", "รูป"], ["video", "วิดีโอ"], ["file", "ไฟล์"]].map(([k, l]) => `<button class="${V.filter === k ? "on" : ""}" data-f="${k}">${l} ${count(k)}</button>`).join("")}</div>` : ""}
      ${items.length ? groups.map(g => `<div class="vt-day">${esc(g.d)}</div><div class="vt-grid">${g.list.map(it => `<button class="vt-it ${V.sel.has(it.id) ? "sel" : ""}" data-id="${esc(it.id)}">
          ${it.kind !== "file" || /pdf$/.test(it.mime) ? `<img data-th="${esc(it.id)}" alt="">` : ""}<span class="ic"><b>${ICON[it.kind]}</b>${it.kind === "file" ? esc(it.name) : ""}</span>
          <span class="tag">${it.kind === "video" ? "▶ " : ""}${esc(it.dev)} · ${hhmm(it.at)}</span>${V.picking ? `<span class="ck"></span>` : ""}</button>`).join("")}</div>`).join("")
        : `<div class="vt-note" style="padding:24px 0;text-align:center">${all.length ? "ไม่มีไฟล์ประเภทนี้" : "ยังไม่มีไฟล์ — กด ＋ อัปโหลด จากมือถือเครื่องไหนก็ได้ แล้วไปโหลดอีกเครื่อง"}</div>`}
      ${V.picking && V.sel.size ? `<div class="vt-act"><button class="go" id="vt-dl">⬇️ โหลด ${V.sel.size}</button><button id="vt-share">📤 บันทึก/แชร์</button><button class="del" id="vt-del">🗑 ลบ</button></div>` : ""}`;
    el.querySelector("#vt-add").onclick = () => el.querySelector("#vt-in").click();
    el.querySelector("#vt-in").onchange = e => { const files = [...e.target.files]; e.target.value = ""; if (files.length) upload(files); };
    el.querySelector("#vt-dev").onclick = e => { e.preventDefault(); renameDevice(); };
    const pk = el.querySelector("#vt-pick"); if (pk) pk.onclick = () => { V.picking = !V.picking; V.sel.clear(); draw(); };
    el.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { V.filter = b.dataset.f; draw(); });
    el.querySelectorAll(".vt-it").forEach(b => b.onclick = e => {
      e.preventDefault(); const id = b.dataset.id;
      if (V.picking) { V.sel.has(id) ? V.sel.delete(id) : V.sel.add(id); draw(); } else view(V.data.items.find(x => x.id === id));
    });
    const dl = el.querySelector("#vt-dl"); if (dl) dl.onclick = () => download([...V.sel]);
    const sh = el.querySelector("#vt-share"); if (sh) sh.onclick = () => share([...V.sel]);
    const del = el.querySelector("#vt-del"); if (del) del.onclick = () => remove([...V.sel], del);
    thumbs();
  }

  // thumbnails: fetched with the token, three at a time, cached for the session
  let tq = [], tActive = 0;
  function thumbs() {
    for (const im of V.el.querySelectorAll("img[data-th]")) {
      const id = im.dataset.th, have = V.thumbs.get(id);
      if (have) { if (have !== "none") { im.src = have; im.nextElementSibling.style.display = "none"; } else im.remove(); continue; }
      tq.push(im);
    }
    pumpThumbs();
  }
  function pumpThumbs() {
    while (tActive < 3 && tq.length) {
      const im = tq.shift(), id = im.dataset.th; if (V.thumbs.has(id)) continue;
      tActive++;
      fetch(`/mobile/vault/thumb/${encodeURIComponent(id)}`, { headers: auth() })
        .then(r => r.ok ? r.blob() : null)
        .then(b => { const u = b ? URL.createObjectURL(b) : "none"; V.thumbs.set(id, u); document.querySelectorAll(`img[data-th="${CSS.escape(id)}"]`).forEach(x => { if (u === "none") x.remove(); else { x.src = u; x.nextElementSibling.style.display = "none"; } }); })
        .catch(() => {}).finally(() => { tActive--; pumpThumbs(); });
    }
  }

  // ── upload: one file after another, with progress (XHR — fetch has no upload progress) ──
  async function upload(files) {
    const total = files.reduce((a, f) => a + f.size, 0); let done = 0, ok = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        await new Promise((res, rej) => {
          const x = new XMLHttpRequest();
          x.open("POST", `/mobile/vault/upload?name=${encodeURIComponent(f.name || "file")}&dev=${encodeURIComponent(devName())}`);
          x.setRequestHeader("authorization", auth().authorization);
          x.upload.onprogress = e => { V.up = { text: `กำลังอัป ${i + 1}/${files.length} · ${f.name}`, pct: Math.round((done + e.loaded) / total * 100) }; draw(); };
          x.onload = () => { let b = {}; try { b = JSON.parse(x.responseText); } catch {} x.status < 300 && b.ok !== false ? res() : rej(new Error(b.error || "HTTP " + x.status)); };
          x.onerror = () => rej(new Error("เน็ตหลุด")); x.send(f);
        });
        ok++;
      } catch (e) { toast(`อัป ${f.name} ไม่ได้: ${e.message}`); if (/พื้นที่/.test(e.message)) break; }
      done += f.size;
    }
    V.up = null; toast(`อัปแล้ว ${ok}/${files.length} ไฟล์`); refresh();
  }
  function renameDevice() {
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    bg.innerHTML = `<div class="sheet"><h2>ชื่อเครื่องนี้</h2><div class="vt-note">ใช้บอกว่าไฟล์ฝากมาจากเครื่องไหน</div>
      <input id="vt-name" value="${esc(devName())}" style="width:100%;margin:10px 0;padding:10px;border-radius:10px;background:var(--card2);color:var(--text);border:1px solid var(--line);font:15px var(--font)">
      <div class="row" style="gap:8px"><button class="ghost" id="vt-x" style="flex:1">ยกเลิก</button><button class="primary" id="vt-ok" style="flex:1;margin-top:0">บันทึก</button></div></div>`;
    document.body.appendChild(bg);
    bg.onclick = e => { if (e.target === bg) bg.remove(); };
    bg.querySelector("#vt-x").onclick = () => bg.remove();
    bg.querySelector("#vt-ok").onclick = () => { const n = bg.querySelector("#vt-name").value.trim().slice(0, 40); if (n) store.set("maw-device-name", n); bg.remove(); draw(); };
  }

  // ── take files back ──
  function clickLink(url, name) { const a = document.createElement("a"); a.href = url; if (name) a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  async function download(ids) {
    try {
      if (ids.length <= 5) {
        const { links } = await api("/vault/link", { method: "POST", body: JSON.stringify({ ids }) });
        for (const l of links) { clickLink(l.url, l.name); await new Promise(r => setTimeout(r, 600)); }
        toast(`กำลังโหลด ${links.length} ไฟล์ — ดูในแถบดาวน์โหลด`);
      } else {
        const z = await api("/vault/zip", { method: "POST", body: JSON.stringify({ ids }) });
        clickLink(z.url); toast(`กำลังโหลด zip ${z.count} ไฟล์ (${size(z.size)})`);
      }
      V.picking = false; V.sel.clear(); draw();
    } catch (e) { toast("โหลดไม่ได้: " + e.message); }
  }
  // the share sheet: "save N images" to the iPhone's Photos, or send on to LINE / Drive …
  async function share(ids) {
    const items = V.data.items.filter(x => ids.includes(x.id));
    const bytes = items.reduce((a, x) => a + x.size, 0);
    if (bytes > 200 * 1048576) { toast("เกิน 200 MB — ใช้ปุ่มโหลดแทน"); return; }
    if (!navigator.canShare) { toast("เครื่องนี้แชร์ไฟล์ไม่ได้ — ใช้ปุ่มโหลด"); return; }
    try {
      toast("กำลังเตรียมไฟล์…");
      const { links } = await api("/vault/link", { method: "POST", body: JSON.stringify({ ids }) });
      const files = await Promise.all(links.map(async l => new File([await (await fetch(l.url)).blob()], l.name, { type: l.mime })));
      if (!navigator.canShare({ files })) { toast("แชร์ไฟล์ชนิดนี้ไม่ได้ — ใช้ปุ่มโหลด"); return; }
      await navigator.share({ files });
      V.picking = false; V.sel.clear(); draw();
    } catch (e) { if (e.name !== "AbortError") toast("แชร์ไม่ได้: " + e.message); }
  }
  async function remove(ids, btn) {
    if (!btn.dataset.armed) { btn.dataset.armed = 1; btn.textContent = `แตะอีกครั้งเพื่อลบ ${ids.length}`; setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = "🗑 ลบ"; } }, 3000); return; }
    try { const r = await api("/vault/delete", { method: "POST", body: JSON.stringify({ ids }) }); toast(`ลบแล้ว ${r.removed} ไฟล์ (เก็บในถังขยะบน Mac 30 วัน)`); V.picking = false; V.sel.clear(); refresh(); }
    catch (e) { toast("ลบไม่ได้: " + e.message); }
  }
  // one item full screen: image / video plays from a signed link (streams, seeks), plus download / share / delete
  async function view(it) {
    const z = document.createElement("div"); z.className = "vt-view";
    z.innerHTML = `<div class="hd"><span>${esc(it.name)}<br><small style="color:#aaa">${size(it.size)} · จาก ${esc(it.dev)} · ${dayOf(it.at)} ${hhmm(it.at)}</small></span><button id="vx">✕</button></div>
      <div class="bd"><span style="color:#aaa">กำลังเปิด…</span></div>
      <div class="ft"><button id="vd">⬇️ โหลด</button><button id="vs">📤 บันทึก/แชร์</button><button id="vr" style="color:#fca5a5">🗑 ลบ</button></div>`;
    document.body.appendChild(z);
    z.querySelector("#vx").onclick = () => z.remove();
    z.querySelector("#vd").onclick = () => download([it.id]);
    z.querySelector("#vs").onclick = () => share([it.id]);
    z.querySelector("#vr").onclick = e => { remove([it.id], e.currentTarget).then(() => { if (!V.data.items.some(x => x.id === it.id)) z.remove(); }); };
    try {
      const { links } = await api("/vault/link", { method: "POST", body: JSON.stringify({ ids: [it.id] }) });
      const url = links[0].url + "&inline=1", bd = z.querySelector(".bd");
      bd.innerHTML = it.kind === "image" && !/heic|heif/.test(it.mime) ? `<img src="${url}" alt="">`
        : it.kind === "video" ? `<video src="${url}" controls playsinline></video>`
        : `<div style="color:#ccc;text-align:center;padding:20px">${ICON[it.kind]}<br>${esc(it.name)}<br><small>กด ⬇️ โหลด เพื่อเปิดในเครื่อง</small></div>`;
    } catch (e) { z.querySelector(".bd").innerHTML = `<span style="color:#f88">${esc(e.message)}</span>`; }
  }

  mawExt.pages.push({
    key: "vault", icon: "📦", title: "คลังไฟล์",
    summary() { return V.data ? { text: `${V.data.items.length} ไฟล์ · ${size(V.data.used)}` } : { text: V.err ? "โหลดไม่ได้" : "รูป · ไฟล์ · …" }; },
    mount(el) { V.el = document.createElement("div"); V.el.className = "vt"; el.appendChild(V.el); draw(); refresh(); },
  });
  refresh();
  setInterval(() => { if (!document.hidden && V.el?.isConnected && !V.up && Date.now() - V.at > 20_000) refresh(); }, 5_000);
})();
