// Phone UI pack "prs" — card "🔀 Pull requests" on home: open PRs of every repo, AI review in a Claude room, merge on tap.
// Server: GET /prs · POST /prs/review · /prs/auto · /prs/merge  (src/mobile/features/prs.ts). Merge only ever on a double tap here.
(() => {
  if (!window.mawExt) return;
  const css = `
  .pr-card { margin: 0 0 10px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
  .pr-hd { display: flex; align-items: center; gap: 8px; width: 100%; padding: 11px 13px; text-align: left; color: var(--text); font: 650 15px var(--font); }
  .pr-hd .sum { margin-left: auto; color: var(--dim); font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .pr-hd .car { flex: none; color: var(--dim); font-size: 12px; transition: transform .15s; } .pr-card.open .pr-hd .car { transform: rotate(90deg); }
  .pr-body { display: none; border-top: 1px solid var(--line); } .pr-card.open .pr-body { display: block; }
  .pr-tools { display: flex; align-items: center; gap: 8px; padding: 7px 13px; color: var(--dim); font-size: 12px; }
  .pr-tools .rf { margin-left: auto; padding: 4px 10px; border-radius: 8px; background: var(--card2); color: var(--dim); font-size: 12.5px; }
  .pr-repo { display: flex; align-items: center; gap: 8px; padding: 9px 13px 5px; border-top: 1px solid var(--line); }
  .pr-repo .nm { min-width: 0; flex: 1; font: 600 13px var(--mono); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pr-repo .nm span { color: var(--dim); font-weight: 400; font-size: 11.5px; }
  .pr-auto { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 999px; background: var(--card2); color: var(--dim); font-size: 11.5px; }
  .pr-auto i { width: 22px; height: 13px; border-radius: 99px; background: var(--line); position: relative; } .pr-auto i::after { content: ""; position: absolute; top: 2px; left: 2px; width: 9px; height: 9px; border-radius: 50%; background: var(--dim); transition: left .15s; }
  .pr-auto.on { color: #4ade80; } .pr-auto.on i { background: #14532d; } .pr-auto.on i::after { left: 11px; background: #22c55e; }
  .pr-err { padding: 0 13px 6px; color: var(--danger); font-size: 11.5px; overflow-wrap: anywhere; }
  .pr-row { padding: 6px 13px 8px; }
  .pr-t { font-size: 13.5px; line-height: 1.35; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pr-t b { color: var(--dim); font-weight: 600; margin-right: 4px; }
  .pr-s { font-size: 12.5px; color: var(--dim); margin-top: 2px; line-height: 1.35; overflow-wrap: anywhere; }
  .pr-s.ok { color: #4ade80; } .pr-s.bad { color: #fca5a5; } .pr-s.run { color: #fcd34d; }
  .pr-v { font-size: 12.5px; margin-top: 2px; line-height: 1.35; overflow-wrap: anywhere; } .pr-v.ready { color: #86efac; } .pr-v.blocked { color: #fca5a5; } .pr-v.stale, .pr-v.wait { color: var(--dim); }
  .pr-a { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .pr-a button, .pr-a a, .pr-a select { height: 30px; padding: 0 9px; border-radius: 9px; font: 600 12.5px var(--font); background: var(--card2); color: var(--text); border: 1px solid var(--line); display: inline-flex; align-items: center; text-decoration: none; }
  .pr-a select { padding: 0 4px; color: var(--dim); }
  .pr-a .mg { background: #22c55e24; border-color: #22c55e77; color: #bbf7d0; }
  .pr-a .armed { background: #f59e0b; border-color: #f59e0b; color: #1a1003; }
  .pr-a button:disabled { opacity: .5; }
  .pr-a label { display: inline-flex; align-items: center; gap: 4px; color: var(--dim); font-size: 12px; }
  .pr-a a { margin-left: auto; color: var(--accent); }
  .pr-more { display: block; width: 100%; padding: 6px 13px 9px; text-align: left; color: var(--dim); font-size: 12.5px; }
  .pr-foot { padding: 8px 13px 11px; border-top: 1px solid var(--line); color: var(--dim); font-size: 11.5px; }`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  const S = { data: null, at: 0, loading: false, err: "", open: store.get("maw-prs-open") === "1", drafts: new Set(), armed: null, busy: new Set(), method: new Map(), del: new Set() };
  const root = document.createElement("div"); root.className = "pr-card";
  const key = (repo, n) => `${repo}#${n}`;
  const hhmm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  const sClass = c => c === "ready" ? "ok" : c === "ci-running" || c === "computing" ? "run" : c === "draft" || c === "review" ? "" : "bad";

  function prHtml(repo, p) {
    const k = key(repo, p.number), armed = S.armed && S.armed.k === k ? S.armed.kind : "", busy = S.busy.has(k);
    const v = p.verdict;
    const vline = p.reviewing ? `<div class="pr-v wait">🤖 กำลังตรวจ… · ห้อง ${esc(p.reviewing.room)}</div>`
      : v ? (v.stale ? `<div class="pr-v stale">🤖 ตรวจแล้วก่อนอัปเดตล่าสุด (${v.verdict === "ready" ? "เคยพร้อม" : "เคยติด"})</div>`
        : `<div class="pr-v ${v.verdict}">🤖 ${v.verdict === "ready" ? "พร้อม" : "ติด"}${v.note ? " · " + esc(v.note) : ""}</div>`) : "";
    const mm = S.method.get(k) || "squash";
    const merge = p.status.ready ? `<select data-mm="${esc(k)}">${["squash", "merge", "rebase"].map(m => `<option value="${m}" ${m === mm ? "selected" : ""}>${m}</option>`).join("")}</select>
      <label><input type="checkbox" data-del="${esc(k)}" ${S.del.has(k) ? "checked" : ""}>ลบ branch</label>
      <button class="mg ${armed === "merge" ? "armed" : ""}" data-merge="${esc(k)}" ${busy ? "disabled" : ""}>${armed === "merge" ? "แตะอีกครั้ง = merge" : "Merge"}</button>` : "";
    return `<div class="pr-row"><div class="pr-t"><b>#${p.number}</b>${esc(p.title)}</div>
      <div class="pr-s ${sClass(p.status.code)}">${esc(p.status.text)}${p.author ? ` · ${esc(p.author)}` : ""}</div>${vline}
      <div class="pr-a"><button class="${armed === "review" ? "armed" : ""}" data-rv="${esc(k)}" ${busy || p.reviewing ? "disabled" : ""}>${armed === "review" ? "แตะอีกครั้ง = ส่งตรวจ" : "🤖 ตรวจ"}</button>
      ${merge}<a href="${esc(p.url)}" target="_blank" rel="noopener">เปิด</a></div></div>`;
  }

  function draw() {
    const d = S.data, prs = d ? d.repos.flatMap(r => r.prs) : [];
    const ready = prs.filter(p => p.status.ready).length, bad = prs.filter(p => /conflict|ci-failed|changes/.test(p.status.code)).length;
    const sum = !d ? (S.loading ? "กำลังโหลด…" : S.err ? "โหลดไม่ได้" : "") : [ready && `✅ ${ready} พร้อม`, bad && `❌ ${bad} ติด`, prs.length - ready - bad && `${prs.length - ready - bad} อื่นๆ`].filter(Boolean).join(" · ") || "ไม่มี PR เปิด";
    root.classList.toggle("open", S.open);
    root.innerHTML = `<button class="pr-hd" data-tg><span>🔀 Pull requests${d ? ` (${prs.length})` : ""}</span><span class="sum">${esc(sum)}</span><span class="car">▸</span></button>
      <div class="pr-body">${!d ? `<div class="pr-foot">${S.err ? "โหลดไม่ได้: " + esc(S.err) : "กำลังโหลด PR จาก GitHub…"}</div>` : `
        <div class="pr-tools"><span>${S.loading ? "กำลังอัปเดต…" : "อัปเดต " + hhmm(d.at)}</span><button class="rf" data-rf>↻ โหลดใหม่</button></div>
        ${d.repos.map(r => {
          const live = r.prs.filter(p => !p.isDraft), drafts = r.prs.filter(p => p.isDraft), showD = S.drafts.has(r.repo);
          const [o, n] = r.repo.split("/");
          return `<div class="pr-repo"><span class="nm" title="${esc(r.repo)}">${esc(n)} · ${r.prs.length} <span>${esc(o)}</span></span>
            <button class="pr-auto ${r.auto ? "on" : ""}" data-auto="${esc(r.repo)}" data-on="${r.auto ? 1 : 0}"><i></i>ตรวจออโต้</button></div>
            ${r.error ? `<div class="pr-err">${esc(r.error)}</div>` : ""}
            ${live.map(p => prHtml(r.repo, p)).join("")}
            ${drafts.length ? `<button class="pr-more" data-dr="${esc(r.repo)}">${showD ? "▾" : "▸"} 📝 draft ${drafts.length} รายการ</button>${showD ? drafts.map(p => prHtml(r.repo, p)).join("") : ""}` : ""}`;
        }).join("") || `<div class="pr-foot">ไม่มี PR เปิดอยู่เลย</div>`}
        <div class="pr-foot">อีก ${d.empty} repo ไม่มี PR เปิด${d.errors ? ` · อ่านไม่ได้ ${d.errors} repo` : ""} · "ตรวจ" = ส่ง /review-pr ให้ห้อง Claude ที่ว่าง (ตรวจอย่างเดียว ไม่ merge)</div>`}</div>`;
  }

  const find = k => { const i = k.lastIndexOf("#"); return { repo: k.slice(0, i), number: +k.slice(i + 1) }; };
  function arm(k, kind) {
    clearTimeout(S.armed?.t);
    S.armed = { k, kind, t: setTimeout(() => { S.armed = null; draw(); }, 4000) };
    draw();
  }
  root.addEventListener("click", async e => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.hasAttribute("data-tg")) { S.open = !S.open; store.set("maw-prs-open", S.open ? "1" : "0"); draw(); if (S.open) refresh(false); return; }
    if (t.hasAttribute("data-rf")) return refresh(true);
    if (t.dataset.dr) { S.drafts.has(t.dataset.dr) ? S.drafts.delete(t.dataset.dr) : S.drafts.add(t.dataset.dr); return draw(); }
    if (t.dataset.auto) {
      const on = t.dataset.on !== "1";
      try { await api("/prs/auto", { method: "POST", body: JSON.stringify({ repo: t.dataset.auto, on }) }); toast(on ? `เปิดตรวจออโต้ · ${t.dataset.auto}` : "ปิดตรวจออโต้แล้ว"); refresh(false); }
      catch (err) { toast(err.message); }
      return;
    }
    const rv = t.dataset.rv, mg = t.dataset.merge, k = rv || mg; if (!k) return;
    const kind = rv ? "review" : "merge";
    if (!S.armed || S.armed.k !== k || S.armed.kind !== kind) return arm(k, kind);
    clearTimeout(S.armed.t); S.armed = null;
    const { repo, number } = find(k);
    S.busy.add(k); draw();
    try {
      if (kind === "review") {
        const r = await api("/prs/review", { method: "POST", body: JSON.stringify({ repo, number }) });
        toast(`ส่งให้ AI ตรวจแล้ว · ห้อง ${r.room}`);
      } else {
        const method = S.method.get(k) || "squash", deleteBranch = S.del.has(k);
        const r = await api("/prs/merge", { method: "POST", body: JSON.stringify({ repo, number, method, deleteBranch }) });
        toast(`merge #${number} แล้ว`); if (r.text) console.log("[prs]", r.text);
      }
    } catch (err) { toast(err.message); }
    finally { S.busy.delete(k); }
    refresh(kind === "merge");
  });

  root.addEventListener("change", e => {
    const t = e.target;
    if (t.dataset.mm) S.method.set(t.dataset.mm, t.value);
    if (t.dataset.del) t.checked ? S.del.add(t.dataset.del) : S.del.delete(t.dataset.del);
  });

  async function refresh(fresh) {
    if (S.loading) return;
    S.loading = true; if (root.isConnected) draw();
    try { S.data = await api("/prs" + (fresh ? "?fresh=1" : "")); S.at = Date.now(); S.err = ""; if (fresh) toast("อัปเดต PR แล้ว"); }
    catch (e) { S.err = e.message; if (fresh) toast("โหลด PR ไม่ได้: " + e.message); }
    finally { S.loading = false; if (root.isConnected) draw(); }
  }

  // home is rebuilt every poll — move the same node back in (keeps open/armed state, no flicker)
  function mountHome() {
    const slot = document.getElementById("ext-home"); if (!slot) return;
    if (root.parentNode !== slot) { if (!root.innerHTML) draw(); slot.prepend(root); }
    if (Date.now() - S.at > 60_000 && !S.loading) refresh(false);
  }
  mawExt.onHome.push(mountHome);
  mountHome();   // home may already be on screen before this deferred script ran
  setInterval(() => { if (!document.hidden && root.isConnected && Date.now() - S.at > 60_000) refresh(false); }, 15_000);
})();
