// Phone UI pack "modes" (P2) — permission-mode chip, model / effort sheet, compact, rewind.
// Server routes: src/mobile/features/modes.ts. Claude rooms only.
(function () {
  const MODES = {
    default: { label: "○ default", cls: "def", hint: "ถามก่อนแก้ไฟล์" },
    acceptEdits: { label: "⏵⏵ accept edits", cls: "acc", hint: "แก้ไฟล์ได้เลยไม่ต้องถาม" },
    plan: { label: "⏸ plan mode", cls: "plan", hint: "วางแผนอย่างเดียว ยังไม่แก้" },
    bypass: { label: "⏵⏵ bypass", cls: "byp", hint: "ข้ามการขออนุญาตทั้งหมด" },
    auto: { label: "⏵⏵ auto mode", cls: "auto", hint: "ให้ระบบตัดสินใจเอง" },
    dontAsk: { label: "⏵⏵ don't ask", cls: "byp", hint: "ไม่ถาม ปฏิเสธสิ่งที่ไม่อนุญาต" },
    unknown: { label: "? โหมด", cls: "unk", hint: "อ่านจากจอไม่ได้ (อาจมีเมนูค้างอยู่)" },
  };
  const MODELS = [["default", "Default"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"], ["fable", "Fable"], ["opus[1m]", "Opus 1M"], ["sonnet[1m]", "Sonnet 1M"], ["fable[1m]", "Fable 1M"]];
  const EFFORTS = ["low", "medium", "high", "xhigh", "max", "auto"];
  const mm = { key: "", data: null, at: 0, busy: false, inflight: false };

  const css = document.createElement("style");
  css.textContent = `
  .mm-row { display: flex; align-items: center; gap: 8px; padding: 6px 14px 0; min-width: 0; }
  .mm-chip { flex: none; height: 30px; padding: 0 12px; border-radius: 15px; font: 600 12.5px var(--font); border: 1px solid transparent; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; transition: opacity .15s; }
  .mm-chip:active { opacity: .6; }
  .mm-chip.busy { opacity: .55; }
  .mm-chip .cy { font-size: 11px; opacity: .7; font-weight: 500; }
  .mm-def { background: #64748b22; color: #a3adc2; border-color: #64748b55; }
  .mm-acc { background: #a855f722; color: #d0a6ff; border-color: #a855f766; }
  .mm-plan { background: #14b8a622; color: #5eead4; border-color: #14b8a666; }
  .mm-byp { background: #ef444422; color: #fca5a5; border-color: #ef444466; }
  .mm-auto { background: #f59e0b22; color: #fcd34d; border-color: #f59e0b66; }
  .mm-unk { background: var(--card2); color: var(--dim); border-color: var(--line); }
  .mm-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim); font-size: 12px; }
  .mm-sheet .mm-sub { color: var(--dim); font-size: 13px; margin-bottom: 12px; }
  .mm-sheet h3 { margin: 16px 0 8px; font-size: 13px; color: var(--dim); font-weight: 600; letter-spacing: .02em; }
  .mm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; }
  .mm-grid button { height: 42px; border-radius: 10px; background: var(--card2); color: var(--text); border: 1px solid var(--line); font: 600 13.5px var(--font); padding: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mm-grid button.on { background: var(--accent); color: #031022; border-color: var(--accent); }
  .mm-grid button:disabled { opacity: .45; }
  .mm-acts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px; }
  .mm-acts button { min-height: 50px; border-radius: 12px; background: var(--card2); color: var(--text); border: 1px solid var(--line); font: 600 14px var(--font); padding: 6px 8px; line-height: 1.25; }
  .mm-acts button small { display: block; font-weight: 400; font-size: 11.5px; color: var(--dim); margin-top: 2px; }
  .mm-acts button.arm { background: #f59e0b26; border-color: #f59e0b; color: #fcd34d; }
  .mm-acts button.arm small { color: #fcd34d; }
  .mm-close { width: 100%; margin-top: 16px; height: 44px; border-radius: 12px; background: transparent; color: var(--dim); border: 1px solid var(--line); font: 600 14px var(--font); }
  .mm-note { color: var(--dim); font-size: 12px; margin-top: 6px; }
  `;
  document.head.appendChild(css);

  const isClaude = room => room && room.agent === "claude";
  const base = (w, room) => `/rooms/${encodeURIComponent(w.id)}/${encodeURIComponent(room.id)}`;
  const shortModel = d => d ? String(d.model || d.modelId || "").replace(/\s*\(1M context\)/g, " 1M").replace(/^Claude\s+/, "") : "";

  function drawChip(w, room) {
    const slot = document.getElementById("ext-room-top");
    if (!slot || !isClaude(room)) return;
    const d = mm.key === room.id ? mm.data : null;
    const m = MODES[d?.mode] || MODES.unknown;
    const meta = d ? [shortModel(d), d.effort ? `effort ${d.effort}` : ""].filter(Boolean).join(" · ") : "";
    let row = slot.querySelector(".mm-row");
    if (!row) { row = document.createElement("div"); row.className = "mm-row"; slot.appendChild(row); }
    row.innerHTML = `<button class="mm-chip mm-${m.cls}${mm.busy ? " busy" : ""}" aria-label="สลับโหมด (shift+tab)">${esc(d ? m.label : "… โหมด")}<span class="cy">⇄</span></button><span class="mm-meta">${esc(meta)}</span>`;
    row.querySelector(".mm-chip").onclick = () => cycle(w, room);
  }

  async function load(w, room, force) {
    if (!isClaude(room) || mm.inflight) return;
    if (!force && mm.key === room.id && Date.now() - mm.at < 4000) return;
    mm.inflight = true;
    try {
      const d = await api(`${base(w, room)}/mode?${qs({ sid: room.claudeSessionId || "", agent: room.agent })}`);
      if (state.room !== room.id) return;
      mm.key = room.id; mm.data = d; mm.at = Date.now();
      drawChip(w, room);
    } catch { /* keep last value */ } finally { mm.inflight = false; }
  }

  async function cycle(w, room) {
    if (mm.busy) return;
    mm.busy = true; drawChip(w, room);
    try {
      const r = await api(`${base(w, room)}/mode/cycle`, { method: "POST", body: JSON.stringify({ agent: room.agent }) });
      mm.key = room.id; mm.data = { ...(mm.data || {}), mode: r.mode }; mm.at = Date.now();
      const m = MODES[r.mode] || MODES.unknown;
      toast(`${m.label} — ${m.hint}`);
    } catch (e) { toast(e.message); }
    finally { mm.busy = false; drawChip(w, room); }
  }

  function openSheet(w, room) {
    const d = mm.key === room.id ? mm.data : null;
    const m = MODES[d?.mode] || MODES.unknown;
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    const curModel = d?.modelId || "";
    const modelOn = alias => {
      if (!curModel) return false;
      const id = curModel.toLowerCase(), one = /\[1m\]/.test(id), fam = alias.replace("[1m]", "");
      return alias !== "default" && id.includes(fam) && one === alias.includes("[1m]");
    };
    bg.innerHTML = `<div class="sheet mm-sheet"><h2>⚙ โหมด & model</h2>
      <div class="mm-sub">${esc(m.label)} · ${esc(shortModel(d) || "ไม่ทราบ model")}${d?.effort ? ` · effort ${esc(d.effort)}` : ""}</div>
      <h3>MODEL</h3><div class="mm-grid">${MODELS.map(([a, l]) => `<button data-model="${esc(a)}" class="${modelOn(a) ? "on" : ""}">${esc(l)}</button>`).join("")}</div>
      <h3>EFFORT</h3><div class="mm-grid">${EFFORTS.map(e => `<button data-eff="${e}" class="${d?.effort === e ? "on" : ""}">${e}</button>`).join("")}</div>
      <div class="mm-note">บาง model ไม่รองรับ xhigh / max — Claude จะแจ้งบนจอเอง</div>
      <h3>บทสนทนา</h3><div class="mm-acts">
        <button data-act="compact">🗜 Compact<small>ย่อบทสนทนาให้ context ว่าง</small></button>
        <button data-act="rewind">⏪ Rewind<small>ย้อนกลับไปจุดก่อนหน้า</small></button></div>
      <button class="mm-close">ปิด</button></div>`;
    document.body.appendChild(bg);
    const close = () => bg.remove();
    bg.onclick = e => { if (e.target === bg) close(); };
    bg.querySelector(".mm-close").onclick = close;
    const post = async (path, payload, okMsg) => {
      bg.querySelectorAll(".mm-grid button").forEach(b => b.disabled = true);
      try { await api(base(w, room) + path, { method: "POST", body: JSON.stringify({ ...payload, agent: room.agent }) }); toast(okMsg); close(); setTimeout(() => load(w, room, true), 1500); }
      catch (e) { toast(e.message); bg.querySelectorAll(".mm-grid button").forEach(b => b.disabled = false); }
    };
    bg.querySelectorAll("[data-model]").forEach(b => b.onclick = () => post("/model", { model: b.dataset.model }, `เปลี่ยน model → ${b.textContent}`));
    bg.querySelectorAll("[data-eff]").forEach(b => b.onclick = () => post("/effort", { level: b.dataset.eff }, `ตั้ง effort → ${b.dataset.eff}`));
    // two-tap confirm: first tap arms the button for 3 s, second tap sends
    bg.querySelectorAll("[data-act]").forEach(b => {
      const orig = b.innerHTML;
      b.onclick = async () => {
        if (!b.classList.contains("arm")) {
          b.classList.add("arm"); b.innerHTML = `${b.dataset.act === "compact" ? "🗜" : "⏪"} แตะอีกครั้งเพื่อยืนยัน<small>ยกเลิกเองใน 3 วินาที</small>`;
          clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove("arm"); b.innerHTML = orig; }, 3000);
          return;
        }
        clearTimeout(b._t);
        try {
          if (b.dataset.act === "compact") { await roomSend("/compact"); toast("🗜 สั่ง compact แล้ว — รอ Claude ย่อบทสนทนา"); }
          else { await roomSend("/rewind"); toast("⏪ เปิดรายการ Rewind แล้ว — ไปแท็บ \"จอ\" แล้วเลือกจุดด้วย ↑ ↓ ⏎"); }
          close();
        } catch (e) { toast(e.message); }
      };
    });
  }

  mawExt.keys.push({ label: "⚙ โหมด", cls: "mm-key", onClick: ({ w, room }) => isClaude(room) ? openSheet(w, room) : toast("ใช้ได้เฉพาะห้อง Claude") });
  const keyIdx = mawExt.keys.length - 1;

  mawExt.onRoom.push(({ w, room }) => {
    const btn = document.querySelector(`[data-xk="${keyIdx}"]`);
    if (btn) btn.hidden = !isClaude(room);
    if (!isClaude(room)) return;
    if (mm.key !== room.id) { mm.key = room.id; mm.data = null; mm.at = 0; }
    drawChip(w, room);
    load(w, room, !mm.data);
  });
  mawExt.onPoll.push(({ w, room }) => {
    if (!isClaude(room) || mm.busy || document.querySelector(".mm-sheet")) return;
    if (!document.querySelector("#ext-room-top .mm-row")) drawChip(w, room);
    load(w, room, false);
  });
})();
