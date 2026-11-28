// Phone UI pack "account" (28 พ.ย. 69) — สลับห้อง agent ระหว่าง Mind กับบัญชีหลัก (แชทเดิมคุยต่อ) · Server: src/mobile/features/account.ts
// · ป้ายบนหัวห้อง "Mind" / "บัญชีหลัก" → แตะแล้วยืนยันเพื่อสลับ (ห้องกำลังทำงาน = เข้าคิว สลับเองเมื่อว่าง)
// · ป้ายบอกโทเคนขาออกวันนี้ของห้อง (ที่ Mind นับ) · หน้าแรกมีการ์ด "ห้องที่ใช้โควตามากวันนี้" · สวิตช์สลับอัตโนมัติเมื่อถึง 90%
// · โควตา Mind ของเราถึง 90% → แถบเตือนบนหน้าแรก/หัวห้อง "สลับทุกห้องไปบัญชีหลัก" · หลังรีเซ็ต (ต่ำกว่า 50%) เสนอสลับกลับ
(() => {
  if (!window.mawExt) return;
  const css = `
  .acc-pill { flex: none; height: 26px; padding: 0 9px; border-radius: 99px; border: 1px solid var(--line); background: var(--card); color: var(--dim); font: 600 11px var(--font); white-space: nowrap; }
  .acc-pill.direct { color: #fbbf24; border-color: #f59e0b66; } .acc-pill.pending { opacity: .6; }
  .acc-bar { display: flex; align-items: center; gap: 10px; margin: 8px 12px 0; padding: 9px 12px; border-radius: 12px; background: #f59e0b1a; border: 1px solid #f59e0b55; color: #fcd34d; font-size: 12.5px; }
  .acc-bar span { flex: 1; min-width: 0; } .acc-bar button { flex: none; height: 30px; padding: 0 11px; border-radius: 9px; border: 0; background: #f59e0b; color: #1a1003; font: 700 12px var(--font); }
  .acc-use { margin: 8px 12px 0; padding: 10px 12px; border-radius: 12px; background: var(--card); border: 1px solid var(--line); font-size: 12.5px; }
  .acc-use h4 { margin: 0 0 6px; font: 600 12px var(--font); color: var(--dim); display: flex; justify-content: space-between; }
  .acc-use div { display: flex; gap: 8px; padding: 3px 0; } .acc-use div span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acc-use div span:last-child { font-variant-numeric: tabular-nums; color: var(--dim); }
  .acc-auto { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font-size: 13px; }
  .acc-bar.back { background: #22c55e14; border-color: #22c55e44; color: #86efac; } .acc-bar.back button { background: #22c55e; color: #04140a; }`;
  if (!document.getElementById("acc-style")) { const s = document.createElement("style"); s.id = "acc-style"; s.textContent = css; document.head.appendChild(s); }
  const LABEL = { mind: "Mind", direct: "บัญชีหลัก" };
  const enc = encodeURIComponent;
  const fmtK = n => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
  const pctOf = n => state.mindMe?.dailyTokenLimit ? ` · ${(n * 100 / state.mindMe.dailyTokenLimit).toFixed(n * 100 / state.mindMe.dailyTokenLimit < 10 ? 1 : 0)}%` : "";
  const agentRooms = () => state.projects.flatMap(p => p.workspaces.flatMap(w => w.rooms.filter(r => (r.agent === "claude" || r.agent === "codex") && !String(w.id).startsWith("herdr:") && r.status !== "ended" && r.status !== "asleep").map(r => [w.id, r.id])));

  // room header pill
  mawExt.onRoom.push(async ({ w, room }) => {
    if (!room || !["claude", "codex"].includes(room.agent) || String(w.id).startsWith("herdr:")) return;
    let info; try { info = await api(`/rooms/${enc(w.id)}/${enc(room.id)}/account`); } catch { return; }
    const slot = document.getElementById("ext-room-actions"); if (!slot || !info.route || state.room !== room.id) return;
    slot.querySelector(".acc-pill")?.remove();
    const b = document.createElement("button");
    b.className = `acc-pill ${info.route} ${info.pending ? "pending" : ""}`;
    b.textContent = info.pending ? `→ ${LABEL[info.pending]}…` : LABEL[info.route] + (info.outToday ? ` ${fmtK(info.outToday)}` : "");
    b.title = `บัญชีที่ห้องนี้ใช้${info.outToday ? ` · วันนี้ห้องนี้ใช้ไป ${info.outToday.toLocaleString()} โทเคนขาออก${pctOf(info.outToday)}${info.route === "mind" ? " ของโควตา Mind" : ""}` : ""} · แตะเพื่อสลับ`;
    b.onclick = () => confirmSwitch([[w.id, room.id]], info.route === "mind" ? "direct" : "mind", room.title);
    slot.prepend(b);
  });

  function confirmSwitch(rooms, to, title) {
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    bg.innerHTML = `<div class="sheet"><h2 style="margin:0 0 8px">สลับไป${to === "direct" ? "บัญชีหลัก" : " Mind"}</h2>
      <p style="margin:0 0 10px;color:var(--dim);font-size:13px">${title ? esc(title) : `${rooms.length} ห้อง`} · ปิด agent แล้วเปิดใหม่ด้วยแชทเดิม (ราว 10 วิ) · ห้องที่กำลังทำงานจะสลับเองเมื่อว่าง${to === "direct" ? " · ใช้ลิมิตบัญชีหลัก ไม่นับโควตา Mind" : ""}</p>
      <label class="acc-auto"><input type="checkbox" data-auto> สลับห้อง Mind ไปบัญชีหลักอัตโนมัติเมื่อโควตาถึง 90%</label>
      <button class="primary" data-go style="width:100%;height:42px">สลับเลย</button><button class="ghost" style="width:100%;margin-top:8px">ยกเลิก</button></div>`;
    document.body.appendChild(bg);
    const auto = bg.querySelector("[data-auto]");
    api("/accounts/auto").then(a => { auto.checked = !!a.on; }).catch(() => auto.closest("label").remove());
    auto.onchange = () => api("/accounts/auto", { method: "POST", body: JSON.stringify({ on: auto.checked }) }).then(a => toast(a.on ? "เปิดสลับอัตโนมัติแล้ว (ทำงานแม้ปิดมือถือ)" : "ปิดสลับอัตโนมัติแล้ว")).catch(err => toast(err.message));
    bg.onclick = async e => {
      if (e.target.closest(".acc-auto")) return;
      if (e.target === bg || e.target.closest(".ghost")) return bg.remove();
      const go = e.target.closest("[data-go]"); if (!go) return;
      go.disabled = true; go.textContent = "กำลังสลับ…";
      try {
        const r = rooms.length === 1
          ? { results: [{ ...(await api(`/rooms/${enc(rooms[0][0])}/${enc(rooms[0][1])}/account`, { method: "POST", body: JSON.stringify({ to }) }).catch(err => ({ ok: false, error: err.message, ...(err.body || {}) }))) }] }
          : await api("/accounts/switch-all", { method: "POST", body: JSON.stringify({ to, rooms }) });
        const ok = r.results.filter(x => x.ok).length, q = r.results.filter(x => x.queued).length, bad = r.results.filter(x => !x.ok && !x.queued);
        toast([ok && `สลับแล้ว ${ok} ห้อง`, q && `${q} ห้องกำลังทำงาน จะสลับเมื่อว่าง`, bad.length && `ไม่สำเร็จ ${bad.length}: ${bad[0].error}`].filter(Boolean).join(" · ") || "ไม่มีห้องที่ต้องสลับ");
      } catch (err) { toast(err.message); }
      bg.remove(); state.room ? renderProject() : renderHome();
    };
  }

  // quota bar (home + room): Mind ≥ 90% → offer to move every room to the main account · < 50% after reset → offer back
  function quotaBar(host) {
    host.querySelector(".acc-bar")?.remove();
    const me = state.mindMe; if (!me?.dailyTokenLimit) return;
    const pct = Math.round(me.usedToday * 100 / me.dailyTokenLimit);
    let back = false; try { back = localStorage.getItem("maw-acc-moved") === "1" && pct < 50; } catch {}
    if (pct < 90 && !back) return;
    const bar = document.createElement("div"); bar.className = `acc-bar ${back ? "back" : ""}`;
    bar.innerHTML = back ? `<span>โควตา Mind รีเซ็ตแล้ว (${pct}%) · สลับห้องกลับไป Mind?</span><button>สลับกลับ</button>`
      : `<span>โควตา Mind ใกล้เต็ม (${pct}%) · สลับห้องไปบัญชีหลัก แชทเดิมคุยต่อ</span><button>สลับทุกห้อง</button>`;
    bar.querySelector("button").onclick = () => { try { localStorage.setItem("maw-acc-moved", back ? "0" : "1"); } catch {} confirmSwitch(agentRooms(), back ? "mind" : "direct"); };
    host.prepend(bar);
  }
  // home card: rooms that used the most output tokens today (60 s cache — transcripts are read incrementally server-side)
  let use = { at: 0, rows: [] };
  async function usageCard(host) {
    if (Date.now() - use.at > 60_000) {
      const list = agentRooms(); if (!list.length) return;
      try { use = { at: Date.now(), rows: (await api(`/accounts/usage?rooms=${enc(JSON.stringify(list))}`)).rooms }; } catch { return; }
    }
    host.querySelector(".acc-use")?.remove();
    const title = (ws, id) => { for (const p of state.projects) for (const w of p.workspaces) if (w.id === ws) { const r = w.rooms.find(r => r.id === id); if (r) return `${p.name} · ${r.title || r.agent}`; } return id; };
    const rows = use.rows.filter(r => r.outToday > 0).sort((a, b) => b.outToday - a.outToday).slice(0, 5);
    if (!rows.length) return;
    const mind = use.rows.filter(r => r.route === "mind").reduce((s, r) => s + (r.outToday || 0), 0);
    const card = document.createElement("div"); card.className = "acc-use";
    card.innerHTML = `<h4><span>ห้องที่ใช้โทเคนมากวันนี้</span><span>ผ่าน Mind ${fmtK(mind)}${pctOf(mind)}</span></h4>` +
      rows.map(r => `<div><span>${esc(title(r.ws, r.room))}</span><span>${r.route === "mind" ? "Mind" : "หลัก"} ${fmtK(r.outToday)}</span></div>`).join("");
    host.prepend(card);
  }
  mawExt.onHome.push(() => { const h = document.getElementById("ext-home"); if (h) { usageCard(h); quotaBar(h); } });
  mawExt.onRoom.push(() => { const s = document.getElementById("screen")?.parentElement; if (s) quotaBar(s); });
})();
