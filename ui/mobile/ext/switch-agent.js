// Phone UI pack "switch-agent" — ปุ่มสลับ Codex ↔ Claude ในห้อง tmux: เปิดอีกตัวเป็นหน้าต่างใหม่ในห้องเดิม
// (tmux session เดิม) พร้อมวางบริบทจอห้องเดิมให้อ่านต่อ. ห้องเดิมยังอยู่เหมือนเดิม — นี่คือหน้าต่างข้างๆ ไม่ใช่
// native handoff แบบ timeline เดียว (ของนั้นพักไว้ก่อน — ดู PLAN-visible-switch-and-herdr-chat-20261108.md).
// ปุ่มอยู่แถวปุ่มล่าง (mawExt.keys) ไม่ใส่หัวห้อง — หัวห้องแคบ ใส่แล้วล้นขอบจอ (10 พ.ย. 69)
// Server: src/mobile/features/switch-agent.ts.
(() => {
  if (!window.mawExt) return;
  const NAME = { claude: "Claude", codex: "Codex" };
  const other = a => a === "claude" ? "codex" : "claude";
  let armedAt = 0, armedRoom = "";

  mawExt.keys.push({
    label: "สลับเป็น…",
    show: ({ w, room }) => w?.id === "tmux" && (room?.agent === "claude" || room?.agent === "codex"),
    onClick: async ({ w, room }) => {
      const to = other(room.agent), key = w.id + "/" + room.id;
      // two taps: first arms (4 s), second runs — same feel as other risky buttons
      if (armedRoom !== key || Date.now() - armedAt > 4000) { armedAt = Date.now(); armedRoom = key; toast(`แตะอีกครั้งเพื่อเปิด ${NAME[to]} ในห้องนี้`); return; }
      armedAt = 0; armedRoom = "";
      toast(`กำลังเปิด ${NAME[to]}…`);
      try {
        const res = await api(`/rooms/${encodeURIComponent(w.id)}/${encodeURIComponent(room.id)}/switch-agent`, { method: "POST", body: JSON.stringify({ to }) });
        toast(`เปิด ${NAME[to]} แล้ว — ห้องเดิมยังอยู่`); await load();
        state.room = res.room; renderProject();
      } catch (e) { toast("สลับไม่ได้: " + (e.message || e)); }
    },
  });
})();
