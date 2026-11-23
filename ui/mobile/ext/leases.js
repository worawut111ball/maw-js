// Phone UI pack "leases" — 🗓️ เครื่องเช่า (server/VPS) ใกล้หมดสัญญา: การ์ดเตือนที่หน้าแรก (PLAN-maw-mobile.md §9).
// แสดงเฉพาะรายการที่เหลือ ≤ warnDays (ส้ม) หรือ ≤ dangerDays (แดง) · ไม่มีรายการ = การ์ดเปล่าหาย ไม่กินที่หน้าแรก.
// กดการ์ด = เปิดชีทเพิ่ม/แก้/ลบ (ฟอร์มเดียว ไม่ซับซ้อน — พิมพ์วันที่เองตรงๆ YYYY-MM-DD). Server: src/mobile/features/leases.ts.
(() => {
  if (!window.mawExt) return;

  const st = document.createElement("style");
  st.textContent = `
  .ls-home { display: block; width: calc(100% - 24px); margin: 8px 12px; text-align: left; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
  .ls-home.warn { border-color: color-mix(in srgb, var(--waiting) 50%, var(--line)); }
  .ls-home.danger { border-color: color-mix(in srgb, var(--danger) 55%, var(--line)); }
  .ls-home b { display: block; font-size: 14px; }
  .ls-home span { display: block; font-size: 12px; color: var(--dim); margin-top: 2px; }
  .ls-home .ls-days { font-weight: 700; }
  .ls-home.warn .ls-days { color: var(--waiting); }
  .ls-home.danger .ls-days { color: var(--danger); }
  .ls-sheet .ls-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: var(--card2); border-radius: 10px; padding: 8px 10px; margin-bottom: 6px; }
  .ls-sheet .ls-row .ls-meta { min-width: 0; }
  .ls-sheet .ls-row .ls-meta b { display: block; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ls-sheet .ls-row .ls-meta span { font-size: 12px; color: var(--dim); }
  .ls-sheet .ls-row button { flex: none; background: none; border: 0; color: var(--dim); font-size: 13px; padding: 4px 6px; }
  .ls-sheet .ls-row button.del { color: var(--danger); }
  .ls-sheet form { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  .ls-sheet input { background: var(--card2); border: 1px solid var(--line); border-radius: 9px; padding: 9px 10px; font: 14px var(--font); color: var(--text); }
  .ls-sheet .ls-none { color: var(--dim); font-size: 13px; padding: 6px 2px; }
  `;
  document.head.appendChild(st);

  const post = (body) => api("/leases", { method: "POST", body: JSON.stringify(body) });
  let cache = null;

  function levelOf(d, warnDays, dangerDays) { return d <= dangerDays ? "danger" : d <= warnDays ? "warn" : ""; }

  function fmtDays(d) {
    if (d < 0) return `หมดอายุแล้ว ${-d} วันก่อน`;
    if (d === 0) return "หมดวันนี้";
    return `เหลือ ${d} วัน`;
  }

  function renderRows(sheet, data) {
    const body = sheet.querySelector(".ls-rows");
    if (!data.items.length) { body.innerHTML = `<div class="ls-none">ยังไม่มีรายการ — เพิ่มด้านล่าง</div>`; return; }
    body.innerHTML = data.items.map(it => `<div class="ls-row" data-id="${esc(it.id)}">
        <div class="ls-meta"><b>${esc(it.label)} · ${esc(it.provider)}</b><span>${esc(it.expiresAt)} · ${fmtDays(it.daysLeft)}${it.note ? " · " + esc(it.note) : ""}</span></div>
        <button class="del" data-a="del">ลบ</button>
      </div>`).join("");
    body.querySelectorAll('[data-a="del"]').forEach(b => b.onclick = async () => {
      const id = b.closest(".ls-row").dataset.id;
      try { cache = await post({ id, on: false }); renderRows(sheet, cache); refreshHomeCard(); }
      catch (e) { toast(e.message || String(e)); }
    });
  }

  async function openSheet() {
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    bg.innerHTML = `<div class="sheet ls-sheet"><h2>🗓️ เครื่องเช่า (server/VPS)</h2>
      <div class="ls-rows"><div class="ls-none">กำลังโหลด…</div></div>
      <form><input name="label" placeholder="ชื่อเรียก เช่น atom p&amp;t" maxlength="80" required>
        <input name="provider" placeholder="ผู้ให้บริการ เช่น Atom / P&amp;T" maxlength="80" required>
        <input name="expiresAt" type="date" required>
        <input name="note" placeholder="หมายเหตุ (ไม่บังคับ)" maxlength="200">
        <button type="submit">เพิ่ม / บันทึก</button></form>
      <button class="ghost" id="ls-close" style="margin-top:10px">ปิด</button></div>`;
    document.body.appendChild(bg);
    bg.querySelector("#ls-close").onclick = () => bg.remove();
    bg.onclick = e => { if (e.target === bg) bg.remove(); };
    const sheet = bg.querySelector(".sheet");
    const form = sheet.querySelector("form");
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = { label: fd.get("label"), provider: fd.get("provider"), expiresAt: fd.get("expiresAt"), note: fd.get("note") || undefined };
      try { cache = await post(body); renderRows(sheet, cache); refreshHomeCard(); form.reset(); }
      catch (e2) { toast(e2.message || String(e2)); }
    };
    if (cache) renderRows(sheet, cache);
    try { cache = await api("/leases"); if (bg.isConnected) renderRows(sheet, cache); }
    catch (e) { if (bg.isConnected) sheet.querySelector(".ls-rows").innerHTML = `<div class="ls-none">โหลดไม่ได้: ${esc(e.message)}</div>`; }
  }

  function refreshHomeCard() {
    const slot = document.getElementById("ext-home");
    if (!slot) return;
    slot.querySelector(".ls-home")?.remove();
    if (!cache) return;
    const worst = cache.items.find(it => it.daysLeft <= cache.warnDays);
    if (!worst) return;   // ไม่มีอะไรใกล้หมด → ไม่โชว์การ์ด ไม่กินที่หน้าแรก
    const level = levelOf(worst.daysLeft, cache.warnDays, cache.dangerDays);
    const extra = cache.items.filter(it => it.daysLeft <= cache.warnDays).length - 1;
    const b = document.createElement("button");
    b.className = `ls-home ${level}`;
    b.innerHTML = `<b>🗓️ ${esc(worst.label)} · ${esc(worst.provider)}</b>
      <span class="ls-days">${fmtDays(worst.daysLeft)}</span>
      <span>หมด ${esc(worst.expiresAt)}${extra > 0 ? ` · อีก ${extra} รายการใกล้หมด` : ""}</span>`;
    b.onclick = openSheet;
    slot.appendChild(b);
  }

  // หน้าแรกวาดใหม่ทุก poll (2.5 วิ) — วันหมดอายุเครื่องเช่าไม่เปลี่ยนบ่อย → ขอจาก server ไม่เกินทุก 5 นาที (ประหยัดเน็ต)
  let fetchedAt = 0;
  const homeHook = async () => {
    if (cache && Date.now() - fetchedAt < 300_000) return refreshHomeCard();
    try { cache = await api("/leases"); fetchedAt = Date.now(); } catch { /* เงียบ — ไม่ให้หน้าแรกพังเพราะฟีเจอร์นี้ */ return; }
    refreshHomeCard();
  };
  mawExt.onHome.push(homeHook);
  homeHook();   // home อาจวาดไปก่อน script นี้โหลดเสร็จ (deferred)
})();
