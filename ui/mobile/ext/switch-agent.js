// Phone UI pack "switch-agent" — ปุ่มสลับ Codex ↔ Claude ในห้อง tmux: เปิดอีกตัวเป็นหน้าต่างใหม่ในห้องเดิม
// (tmux session เดิม) พร้อมวางบริบทจอห้องเดิมให้อ่านต่อ. ห้องเดิมยังอยู่เหมือนเดิม — นี่คือหน้าต่างข้างๆ ไม่ใช่
// native handoff แบบ timeline เดียว (ของนั้นพักไว้ก่อน — ดู PLAN-visible-switch-and-herdr-chat-20261108.md).
// Server: src/mobile/features/switch-agent.ts.
(() => {
  if (!window.mawExt) return;
  const ICON = { claude: "✳ Claude", codex: "◎ Codex" };
  const other = a => a === "claude" ? "codex" : "claude";

  const st = document.createElement("style");
  st.textContent = `
  .sw-btn { flex: none; background: var(--card2); color: var(--text); border: 1px solid var(--line); border-radius: 9px;
    padding: 4px 9px; font: 12.5px var(--font); white-space: nowrap; }
  .sw-btn.armed { background: var(--accent); color: #fff; border-color: transparent; }
  .sw-btn:disabled { opacity: .45; pointer-events: none; }
  `;
  document.head.appendChild(st);

  function homeButton({ w, room }) {
    const slot = document.getElementById("ext-room-actions");
    if (!slot) return;
    slot.querySelector(".sw-btn")?.remove();
    if (!room || (room.agent !== "claude" && room.agent !== "codex") || w?.id !== "tmux") return;
    const to = other(room.agent);
    const b = document.createElement("button");
    b.className = "sw-btn";
    b.textContent = "→ " + (ICON[to] || to);
    b.title = "เปิด " + (ICON[to] || to) + " เป็นหน้าต่างใหม่ในห้องนี้ พร้อมวางบริบทจอปัจจุบันให้อ่านต่อ";
    b.onclick = async () => {
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.classList.add("armed"); b.textContent = "แตะอีกครั้งเพื่อสลับ"; clearTimeout(b._t);
        b._t = setTimeout(() => { delete b.dataset.armed; b.classList.remove("armed"); b.textContent = "→ " + (ICON[to] || to); }, 4000); return; }
      clearTimeout(b._t); b.disabled = true; b.textContent = "กำลังเปิด…";
      try {
        const res = await api(`/rooms/${encodeURIComponent(w.id)}/${encodeURIComponent(room.id)}/switch-agent`, { method: "POST", body: JSON.stringify({ to }) });
        toast("เปิด " + (ICON[to] || to) + " แล้ว — ห้องเดิมยังอยู่"); await load();
        state.room = res.room; renderProject();
      } catch (e) { toast("สลับไม่ได้: " + (e.message || e)); b.disabled = false; delete b.dataset.armed; b.classList.remove("armed"); b.textContent = "→ " + (ICON[to] || to); }
    };
    slot.appendChild(b);
  }
  mawExt.onRoom.push(homeButton);
})();
