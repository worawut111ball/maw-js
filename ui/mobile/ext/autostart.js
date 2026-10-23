// Phone UI pack "autostart" — page "เปิดห้องอัตโนมัติ" (⋯ menu): which tmux rooms come back by themselves after the Mac restarts.
// Server: GET /autostart · POST /autostart {session, dir?, agent?, skipPermissions?, on}  (src/mobile/features/autostart.ts)
(() => {
  if (!window.mawExt) return;
  const css = `
  .as { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .as-note { color: var(--dim); font-size: 12.5px; line-height: 1.5; }
  .as-sec { margin: 10px 2px 2px; color: var(--dim); font-size: 12px; font-weight: 600; }
  .as-row { display: grid; gap: 8px; padding: 11px 12px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; min-width: 0; }
  .as-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .as-top .n { flex: 1; min-width: 0; } .as-top b { display: block; font-size: 14.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .as-top small { display: block; color: var(--dim); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .as-sw { flex: none; width: 46px; height: 28px; border-radius: 99px; background: var(--line); position: relative; }
  .as-sw::after { content: ""; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: var(--dim); transition: left .15s; }
  .as-sw.on { background: #14532d; } .as-sw.on::after { left: 21px; background: #22c55e; }
  .as-opts { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .as-opts button { padding: 4px 10px; border-radius: 99px; background: var(--card2); color: var(--dim); font: 600 12px var(--font); }
  .as-opts button.on { background: var(--accent); color: #031022; }
  .as-st { font-size: 11.5px; color: var(--dim); } .as-st.up { color: #4ade80; }`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  let el = null, data = null, busy = false;
  const AG = [["claude", "✳ Claude"], ["codex", "Codex"], ["shell", "Terminal"]];

  async function load() { try { data = await api("/autostart"); } catch (e) { data = { error: e.message }; } draw(); }
  async function save(body) {
    if (busy) return; busy = true;
    try { const r = await api("/autostart", { method: "POST", body: JSON.stringify(body) }); toast(body.on === false ? "เอาออกแล้ว" : "บันทึกแล้ว"); await load(); }
    catch (e) { toast(e.message); } finally { busy = false; }
  }
  function row(r, on) {
    return `<div class="as-row"><div class="as-top"><span class="n"><b>${esc(r.session)}</b><small>‎${esc(tildePath(r.dir))}</small></span>
      <button class="as-sw ${on ? "on" : ""}" data-sw="${esc(r.session)}" aria-label="เปิดเองหลังรีบูต"></button></div>
      ${on ? `<div class="as-opts">${AG.map(([k, l]) => `<button class="${r.agent === k ? "on" : ""}" data-ag="${k}" data-s="${esc(r.session)}">${l}</button>`).join("")}
        ${r.agent === "claude" ? `<button class="${r.skipPermissions ? "on" : ""}" data-skip="${esc(r.session)}" title="--dangerously-skip-permissions">ไม่ถามสิทธิ์</button>` : ""}</div>
        <div class="as-st ${r.running ? "up" : ""}">${r.running ? "● เปิดอยู่ตอนนี้" : "○ ยังไม่ได้เปิด — จะเปิดให้ตอน maw เริ่มทำงาน"}</div>` : ""}</div>`;
  }
  function draw() {
    if (!el || !el.isConnected) return;
    if (!data) { el.innerHTML = `<div class="as-note">กำลังโหลด…</div>`; return; }
    if (data.error) { el.innerHTML = `<div class="as-note">โหลดไม่ได้: ${esc(data.error)}</div>`; return; }
    el.innerHTML = `<div class="as-note">ห้อง tmux ที่เปิดสวิตช์ไว้ จะถูกสร้างใหม่ให้เองตอน maw เริ่มทำงานหลังรีสตาร์ท Mac (หลังใส่รหัสเข้าเครื่อง) · Claude / Codex จะคุยต่อจากแชทล่าสุดในโฟลเดอร์นั้น</div>
      <div class="as-sec">เปิดเองหลังรีบูต (${data.rooms.length})</div>
      ${data.rooms.map(r => row(r, true)).join("") || `<div class="as-note">ยังไม่มี — เปิดสวิตช์ของห้องด้านล่าง</div>`}
      ${data.live.length ? `<div class="as-sec">ห้อง tmux ที่เปิดอยู่ แต่ยังไม่ได้ตั้ง</div>${data.live.map(r => row(r, false)).join("")}` : ""}`;
    el.querySelectorAll("[data-sw]").forEach(b => b.onclick = () => {
      const s = b.dataset.sw, cur = data.rooms.find(r => r.session === s);
      if (cur) return save({ session: s, on: false });
      const l = data.live.find(r => r.session === s); save({ session: s, dir: l.dir, agent: l.agent, on: true });
    });
    el.querySelectorAll("[data-ag]").forEach(b => b.onclick = () => save({ session: b.dataset.s, agent: b.dataset.ag, on: true }));
    el.querySelectorAll("[data-skip]").forEach(b => b.onclick = () => { const r = data.rooms.find(x => x.session === b.dataset.skip); save({ session: r.session, skipPermissions: !r.skipPermissions, on: true }); });
  }
  mawExt.pages.push({ key: "autostart", icon: "⟳", title: "เปิดห้องอัตโนมัติ", hint: "ห้อง tmux ที่กลับมาเองหลังรีสตาร์ท Mac", tile: false,
    mount(root) { el = document.createElement("div"); el.className = "as"; root.appendChild(el); data = null; draw(); load(); } });
})();
