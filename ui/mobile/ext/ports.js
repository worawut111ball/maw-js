// Phone UI pack "ports" — dev servers of this project (PLAN-maw-mobile.md §9).
// Tab "พอร์ต": every listening port whose process runs inside the workspace folder · เปิด · หยุด (2 แตะ, ค้าง → บังคับหยุด) ·
// รันใหม่ (2 แตะ, เฉพาะที่รู้ terminal: ctrl+c แล้ว ↑ Enter). Server: src/mobile/features/ports.ts. Refresh 5 s while visible.
(() => {
  if (!window.mawExt) return;
  const enc = encodeURIComponent, POLL_MS = 5000;

  const st = document.createElement("style");
  st.textContent = `
  .pt-card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; margin: 8px 12px; }
  .pt-top { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
  .pt-port { font: 700 24px/1.1 var(--mono); color: var(--accent); flex: none; font-variant-numeric: tabular-nums; }
  .pt-more { font: 12px var(--mono); color: var(--dim); }
  .pt-name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pt-up { flex: none; color: var(--dim); font-size: 12px; }
  .pt-cmd { font: 12px/1.4 var(--mono); color: var(--dim); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pt-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; font-size: 12px; color: var(--dim); }
  .pt-tag { padding: 1px 8px; border-radius: 999px; background: var(--card2); }
  .pt-tag.warn { color: var(--waiting); }
  .pt-acts { display: flex; gap: 6px; margin-top: 8px; }
  .pt-btn { flex: 1; min-height: 34px; border-radius: 9px; background: var(--card2); color: var(--text); border: 1px solid var(--line); font: 13px var(--font); text-align: center; text-decoration: none; display: flex; align-items: center; justify-content: center; }
  .pt-btn.bad { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
  .pt-btn.armed { background: var(--danger); color: #fff; font-weight: 700; border-color: transparent; }
  .pt-btn:disabled, .pt-btn.off { opacity: .4; pointer-events: none; }
  .pt-head { display: flex; align-items: center; gap: 8px; margin: 8px 14px 0; color: var(--dim); font-size: 12px; }
  .pt-head span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
  .pt-head button { flex: none; color: var(--accent); background: none; border: 0; font: 13px var(--font); padding: 4px; }
  `;
  document.head.appendChild(st);

  const up = (s) => s == null ? "" : s < 60 ? `${s} วิ` : s < 3600 ? `${Math.floor(s / 60)} นาที` : s < 86400 ? `${Math.floor(s / 3600)} ชม. ${Math.floor(s % 3600 / 60)} น.` : `${Math.floor(s / 86400)} วัน`;
  const short = (c) => String(c || "").replace(/(^|\s)\/\S*\/(?=[^/\s]+)/g, "$1"); // drop folders from paths: /opt/homebrew/bin/bun → bun
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });
  const busy = (el) => !!el.querySelector(".pt-btn.armed, .pt-btn:disabled");

  /** Two-tap confirm (same feel as the Superset tab): first tap arms red, second runs; disarms after 4 s. */
  function arm(btn, run, confirmText) {
    const label = btn.textContent;
    btn.onclick = async () => {
      if (!btn.dataset.armed) {
        btn.dataset.armed = "1"; btn.classList.add("armed"); btn.textContent = confirmText;
        clearTimeout(btn._t); btn._t = setTimeout(() => { delete btn.dataset.armed; btn.classList.remove("armed"); btn.textContent = label; }, 4000);
        return;
      }
      clearTimeout(btn._t); btn.classList.remove("armed"); btn.disabled = true; btn.textContent = "กำลังทำ…";
      try { await run(); } catch (e) { toast(e.message || String(e)); }
      finally { if (btn.isConnected) { delete btn.dataset.armed; btn.disabled = false; btn.textContent = label; } }
    };
  }

  function card(w, x, el) {
    const d = document.createElement("div"); d.className = "pt-card";
    const href = `${location.protocol}//${location.hostname}:${x.port}`;
    const term = x.terminal ? (x.terminal.kind === "tmux" ? "tmux " : "") + x.terminal.label : null;
    d.innerHTML = `<div class="pt-top"><span class="pt-port">:${x.port}</span>${x.ports.length > 1 ? `<span class="pt-more">+${esc(x.ports.slice(1).join(", "))}</span>` : ""}
        <span class="pt-name">${esc(x.name)}</span><span class="pt-up">${esc(up(x.uptime))}</span></div>
      <div class="pt-cmd">${esc(short(x.command))}</div>
      <div class="pt-meta"><span class="pt-tag">pid ${x.pid}</span>${term ? `<span class="pt-tag">${esc(term)}</span>` : `<span class="pt-tag">ไม่รู้ terminal</span>`}
        ${x.agent ? `<span class="pt-tag warn">agent รัน</span>` : ""}${x.localOnly ? `<span class="pt-tag warn">เปิดเฉพาะใน Mac</span>` : ""}</div>
      <div class="pt-acts"><a class="pt-btn ${x.localOnly ? "off" : ""}" href="${esc(href)}" target="_blank" rel="noopener">เปิด</a>
        <button class="pt-btn bad" data-a="stop">หยุด</button>
        ${x.terminal && !x.agent ? `<button class="pt-btn" data-a="rerun">รันใหม่</button>` : ""}</div>`;
    const base = `/workspaces/${enc(w.id)}/ports/${x.pid}`;
    const stop = d.querySelector('[data-a="stop"]');
    arm(stop, async () => {
      const force = stop.dataset.force === "1";
      const r = await post(base + "/stop", { force });
      if (r.stopped) { toast(r.portFree ? `หยุดแล้ว · พอร์ต ${x.port} ว่าง` : `หยุดแล้ว แต่พอร์ต ${x.port} ยังมีคนใช้`); return refresh(w, el, true); }
      stop.dataset.force = "1"; stop.textContent = "บังคับหยุด"; toast("ยังไม่หยุด — แตะ \"บังคับหยุด\" (kill -9)");
      arm(stop, async () => { const r2 = await post(base + "/stop", { force: true }); toast(r2.stopped ? "บังคับหยุดแล้ว" : "ยังหยุดไม่ได้"); refresh(w, el, true); }, "แตะอีกครั้ง = kill -9");
    }, "แตะอีกครั้งเพื่อหยุด");
    const rr = d.querySelector('[data-a="rerun"]');
    if (rr) arm(rr, async () => {
      const r = await post(base + "/restart");
      toast(`กด ctrl+c แล้วรันคำสั่งเดิมใน ${r.terminal}`);
      setTimeout(() => refresh(w, el, true), 2500);
    }, "แตะอีกครั้งเพื่อรันใหม่");
    return d;
  }

  function draw(w, el, data, force) {
    if (!force && busy(el)) return; // don't wipe a button waiting for its second tap
    el.innerHTML = `<div class="pt-head"><span>${esc(data.path || "")}</span><button data-rf>รีเฟรช</button></div>`;
    el.querySelector("[data-rf]").onclick = () => refresh(w, el, true);
    if (!data.ports.length) { el.insertAdjacentHTML("beforeend", `<div class="empty">ไม่มีพอร์ตที่โปรเจคนี้เปิดอยู่<br><span style="font-size:12.5px">รัน dev server ใน terminal ของโปรเจคแล้วจะขึ้นที่นี่</span></div>`); return; }
    for (const x of data.ports) el.appendChild(card(w, x, el));
  }

  async function refresh(w, el, manual) {
    try {
      const d = await api(`/workspaces/${enc(w.id)}/ports`);
      if (!el.isConnected) return;
      draw(w, el, d, manual);
    } catch (e) {
      if (!el.isConnected) return;
      if (!el.querySelector(".pt-card")) el.innerHTML = `<div class="empty">โหลดไม่ได้: ${esc(e.message)}</div>`;
      else if (manual) toast("โหลดไม่ได้: " + e.message);
    }
  }

  mawExt.tabs.push({
    key: "ports", folder: true, label: "พอร์ต",
    render(w, el) {
      if (!w || w.id === "tmux") { el.innerHTML = `<div class="empty">ห้อง tmux ไม่มีโฟลเดอร์โปรเจค — ดูพอร์ตได้จากโปรเจคของ Superset หรือโฟลเดอร์</div>`; return; }
      el.innerHTML = `<div class="empty">กำลังดูพอร์ต…</div>`;
      refresh(w, el, false);
      const t = setInterval(() => {
        if (!el.isConnected) return clearInterval(t);
        if (!document.hidden) refresh(w, el, false);
      }, POLL_MS);
    },
  });
})();
