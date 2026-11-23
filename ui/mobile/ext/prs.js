// Phone UI pack "prs" — page "🔀 Pull requests" (tile in the home เมนู): open PRs of every repo, AI review in a Claude room, merge on tap.
// Server: GET /prs · POST /prs/review · /prs/auto · /prs/merge  (src/mobile/features/prs.ts). Merge only ever on a double tap here.
(() => {
  if (!window.mawExt) return;
  const css = `
  .pr-page { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; } .pr-page > * { min-width: 0; }
  .pr-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .pr-chip { padding: 4px 10px; border-radius: 999px; background: var(--card2); color: var(--text); font: 600 12.5px var(--font); }
  .pr-chip.ok { background: #22c55e1f; color: #86efac; } .pr-chip.bad { background: #ef44441f; color: #fca5a5; } .pr-chip.dim { color: var(--dim); }
  .pr-top .rf { margin-left: auto; width: 34px; height: 30px; border-radius: 9px; background: var(--card2); color: var(--dim); }
  .pr-when { color: var(--dim); font-size: 11.5px; margin: 6px 2px 2px; }
  .pr-empty { color: var(--dim); text-align: center; padding: 30px 0; }
  /* one box per repo */
  .pr-grp { margin-top: 10px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .pr-gh { display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 12px; text-align: left; color: var(--text); }
  .pr-gh .av { flex: none; width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; font: 800 15px var(--font); color: hsl(var(--h) 80% 80%); background: hsl(var(--h) 45% 22%); }
  .pr-gh .nm { min-width: 0; flex: 1; display: grid; } .pr-gh .nm b { font-size: 14.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pr-gh .nm small { color: var(--dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pr-gh .cnt { flex: none; display: flex; gap: 4px; } .pr-gh .cnt i { font-style: normal; font-size: 11.5px; font-weight: 700; padding: 2px 6px; border-radius: 99px; background: var(--card2); color: var(--text); }
  .pr-gh .cnt i.ok { background: #22c55e1f; color: #86efac; } .pr-gh .cnt i.bad { background: #ef44441f; color: #fca5a5; } .pr-gh .cnt i.dim { color: var(--dim); }
  .pr-gh .cv { flex: none; color: var(--dim); transform: rotate(90deg); transition: transform .15s; } .pr-grp.fold .pr-gh .cv { transform: none; }
  .pr-grp.fold .pr-gb { display: none; }
  .pr-gb { border-top: 1px solid var(--line); }
  .pr-gb .pr-row { padding: 10px 12px; border-bottom: 1px solid var(--line); }
  .pr-gf { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: #ffffff05; }
  .pr-gf a { color: var(--dim); font-size: 12px; text-decoration: none; }
  .pr-s { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
  .pr-s .pill { padding: 2px 8px; border-radius: 99px; font-size: 11.5px; font-weight: 700; background: var(--card2); color: var(--dim); }
  .pr-s .pill.ok { background: #22c55e1f; color: #86efac; } .pr-s .pill.bad { background: #ef44441f; color: #fca5a5; } .pr-s .pill.run { background: #f59e0b1f; color: #fcd34d; }
  .pr-s .who { color: var(--dim); font-size: 11.5px; }
  .pr-auto { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 999px; background: var(--card2); color: var(--dim); font-size: 11.5px; }
  .pr-auto i { width: 22px; height: 13px; border-radius: 99px; background: var(--line); position: relative; } .pr-auto i::after { content: ""; position: absolute; top: 2px; left: 2px; width: 9px; height: 9px; border-radius: 50%; background: var(--dim); transition: left .15s; }
  .pr-auto.on { color: #4ade80; } .pr-auto.on i { background: #14532d; } .pr-auto.on i::after { left: 11px; background: #22c55e; }
  .pr-err { padding: 0 13px 6px; color: var(--danger); font-size: 11.5px; overflow-wrap: anywhere; }
  .pr-t { font-size: 13.5px; line-height: 1.35; color: var(--text); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; } .pr-t b { color: var(--dim); font-weight: 600; margin-right: 4px; }
  .pr-v { font-size: 12.5px; margin-top: 2px; line-height: 1.35; overflow-wrap: anywhere; } .pr-v.ready { color: #86efac; } .pr-v.blocked { color: #fca5a5; } .pr-v.stale, .pr-v.wait { color: var(--dim); }
  .pr-a { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .pr-a button, .pr-a a, .pr-a select { height: 30px; padding: 0 9px; border-radius: 9px; font: 600 12.5px var(--font); background: var(--card2); color: var(--text); border: 1px solid var(--line); display: inline-flex; align-items: center; text-decoration: none; }
  .pr-a select { padding: 0 4px; color: var(--dim); }
  .pr-a .mg { background: #22c55e24; border-color: #22c55e77; color: #bbf7d0; }
  .pr-a .armed { background: #f59e0b; border-color: #f59e0b; color: #1a1003; }
  .pr-a button:disabled { opacity: .5; }
  .pr-a label { display: inline-flex; align-items: center; gap: 4px; color: var(--dim); font-size: 12px; }
  .pr-a a { margin-left: auto; color: var(--accent); }
  .pr-more { display: block; width: 100%; padding: 8px 12px; border-bottom: 1px solid var(--line); text-align: left; color: var(--dim); font-size: 12.5px; }
  .pr-foot { padding: 8px 13px 11px; border-top: 1px solid var(--line); color: var(--dim); font-size: 11.5px; }
  /* แบบคลีน (A, 23 พ.ย. 69): แท็บกรอง · repo พับได้ · แถวละ PR · แตะแล้วปุ่มอยู่ในแผ่นล่าง */
  .pq-tabs { display: flex; gap: 16px; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--dim); padding: 0 2px; overflow-x: auto; scrollbar-width: none; }
  .pq-tabs button { padding: 6px 0 8px; white-space: nowrap; background: none; border: 0; color: inherit; font: inherit; }
  .pq-tabs button.on { color: var(--text); font-weight: 600; box-shadow: inset 0 -2px 0 var(--text); }
  .pq-tabs em { font-style: normal; color: var(--faint, #5c5c66); margin-left: 3px; font-variant-numeric: tabular-nums; }
  .pq-tabs .rf { margin-left: auto; color: var(--dim); }
  .pq-meta { font-size: 10.5px; color: var(--dim); padding: 6px 2px 4px; }
  .pq-box { background: var(--card); border-radius: 14px; overflow: hidden; margin-top: 8px; }
  .pq-gh { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; background: var(--card2); border: 0; color: var(--text); text-align: left; }
  .pq-gh b { flex: 1; min-width: 0; font-size: 13px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pq-gh span { font-size: 10.5px; color: var(--dim); } .pq-gh .cv { color: var(--dim); transform: rotate(90deg); transition: transform .15s; }
  .pq-box.fold .pq-gh { background: var(--card); } .pq-box.fold .pq-gh .cv { transform: none; } .pq-box.fold .pq-gb { display: none; }
  .pq-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; background: none; border: 0; border-top: 1px solid var(--line); color: var(--text); text-align: left; font: inherit; }
  .pq-row:active { background: #ffffff08; }
  .pq-row .t { flex: 1; min-width: 0; display: grid; gap: 2px; }
  .pq-row .t b { font-size: 12.5px; font-weight: 600; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .pq-row .t b i, .pq-sh .st i { font-style: normal; color: var(--dim); font-weight: 500; margin-right: 4px; }
  .pq-row .t small, .pq-sh .sm { font-size: 10.5px; color: var(--dim); display: flex; align-items: center; gap: 5px; min-width: 0; }
  .pq-row .t small span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pq-row .cv { color: var(--dim); flex: none; }
  .pq-d { width: 6px; height: 6px; border-radius: 50%; flex: none; background: #4b5563; }
  .pq-d.ok { background: #22c55e; } .pq-d.bad { background: #ef4444; } .pq-d.run { background: #f59e0b; }
  .pq-gf { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; border-top: 1px solid var(--line); }
  .pq-gf a { color: var(--dim); font-size: 11px; text-decoration: none; }
  .pq-more { display: block; width: 100%; padding: 8px 12px; border: 0; border-top: 1px solid var(--line); background: none; text-align: left; color: var(--dim); font-size: 11.5px; }
  .pq-sh { display: grid; gap: 10px; }
  .pq-sh .st { font-size: 13px; font-weight: 650; line-height: 1.45; }
  .pq-sh .vd { font-size: 11.5px; color: var(--dim); line-height: 1.4; overflow-wrap: anywhere; } .pq-sh .vd.ready { color: #86efac; } .pq-sh .vd.blocked { color: #fca5a5; }
  .pq-opts { display: flex; gap: 14px; align-items: center; font-size: 11.5px; color: var(--dim); }
  .pq-opts button { background: none; border: 0; padding: 4px 0; color: inherit; font: inherit; } .pq-opts button.on { color: var(--text); font-weight: 600; }
  .pq-opts label { margin-left: auto; display: inline-flex; gap: 5px; align-items: center; }
  .pq-btns { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: 8px; }
  .pq-btns button, .pq-btns a { height: 40px; border-radius: 12px; border: 0; background: var(--card2); color: var(--text); font: 600 12.5px var(--font); display: grid; place-items: center; text-decoration: none; }
  .pq-btns .mg { background: #16a34a; color: #fff; } .pq-btns .armed { background: #f59e0b; color: #1a1003; } .pq-btns button:disabled { opacity: .5; }`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  const S = { data: null, at: 0, loading: false, err: "", drafts: new Set(), fold: new Set(), unfold: new Set(), armed: null, busy: new Set(), method: new Map(), del: new Set() };
  const root = document.createElement("div"); root.className = "pr-page";
  const key = (repo, n) => `${repo}#${n}`;
  const hhmm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  const ago = t => { const m = Math.max(0, (Date.now() - Date.parse(t)) / 60000); return m < 60 ? `${Math.round(m)} นาที` : m < 1440 ? `${Math.round(m / 60)} ชม.` : `${Math.round(m / 1440)} วัน`; };
  const hue = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
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
    return `<div class="pr-row"><div class="pr-s"><span class="pill ${sClass(p.status.code)}">${esc(p.status.text)}</span><span class="who">${esc(p.author || "")} · ${ago(p.updatedAt)}</span></div>
      <div class="pr-t"><b>#${p.number}</b> ${esc(p.title)}</div>${vline}
      <div class="pr-a"><button class="${armed === "review" ? "armed" : ""}" data-rv="${esc(k)}" ${busy || p.reviewing ? "disabled" : ""}>${armed === "review" ? "แตะอีกครั้ง = ส่งตรวจ" : "🤖 ตรวจ"}</button>
      ${merge}<a href="${esc(p.url)}" target="_blank" rel="noopener">เปิด</a></div></div>`;
  }

  const isBad = p => /conflict|ci-failed|changes/.test(p.status.code) || p.verdict?.verdict === "blocked" && !p.verdict.stale;
  // repos that need a look first: blocked, then ready, then anything open, drafts-only last
  const sortRepos = list => [...list].sort((a, b) => {
    const sc = r => { const l = r.prs.filter(p => !p.isDraft); return (l.some(isBad) ? 4 : 0) + (l.some(p => p.status.ready) ? 2 : 0) + (l.length ? 1 : 0); };
    return sc(b) - sc(a) || b.prs.length - a.prs.length || a.repo.localeCompare(b.repo);
  });
  const counts = () => {
    const prs = S.data ? S.data.repos.flatMap(r => r.prs) : [];
    const ready = prs.filter(p => p.status.ready).length, bad = prs.filter(p => /conflict|ci-failed|changes/.test(p.status.code)).length, draft = prs.filter(p => p.isDraft).length;
    return { all: prs.length, ready, bad, draft, other: prs.length - ready - bad - draft };
  };
  const clean = () => typeof uiClean === "function" && uiClean();
  const plain = t => String(t || "").replace(/^[^\p{L}\p{N}(#]+/u, "");   // status text without its leading ✅ / ❌ (the dot shows it)
  const kind = p => p.isDraft ? "draft" : p.status.ready ? "ready" : /conflict|ci-failed|changes/.test(p.status.code) ? "bad" : "other";
  const prRow = (repo, p) => `<button class="pq-row" data-open="${esc(key(repo, p.number))}"><span class="t"><b><i>#${p.number}</i>${esc(p.title)}</b>
      <small><span class="pq-d ${sClass(p.status.code)}"></span><span>${esc(plain(p.status.text))} · ${esc(p.author || "")} · ${ago(p.updatedAt)}${p.reviewing ? " · AI กำลังตรวจ" : p.verdict && !p.verdict.stale ? ` · AI ${p.verdict.verdict === "ready" ? "ว่าพร้อม" : "ว่าติด"}` : ""}</span></small></span><span class="cv">›</span></button>`;
  function drawClean() {
    const d = S.data, c = counts(), tab = S.tab || "all";
    if (!d) { root.innerHTML = `<div class="pr-empty">${S.err ? "โหลดไม่ได้: " + esc(S.err) : "กำลังโหลด PR จาก GitHub…"}</div>`; return; }
    const tabs = [["all", "ทั้งหมด", c.all], ["ready", "พร้อม", c.ready], ["bad", "ติด", c.bad], ["other", "อื่นๆ", c.other], ["draft", "draft", c.draft]];
    const groups = sortRepos(d.repos).map(r => {
      const show = r.prs.filter(p => tab === "all" ? !p.isDraft : kind(p) === tab), drafts = tab === "all" ? r.prs.filter(p => p.isDraft) : [];
      if (!show.length && !drafts.length && !(tab === "all" && r.error)) return "";
      const folded = S.fold.has(r.repo) || (tab === "all" && !show.length && !S.unfold.has(r.repo)), showD = S.drafts.has(r.repo), n = r.repo.split("/")[1];
      return `<section class="pq-box ${folded ? "fold" : ""}"><button class="pq-gh" data-fold="${esc(r.repo)}"><b>${esc(n)}</b><span>${show.length}${drafts.length ? ` · draft ${drafts.length}` : ""}</span><span class="cv">›</span></button>
        <div class="pq-gb">${r.error ? `<div class="pr-err">${esc(r.error)}</div>` : ""}${show.map(p => prRow(r.repo, p)).join("")}
          ${drafts.length ? `<button class="pq-more" data-dr="${esc(r.repo)}">${showD ? "▾" : "▸"} draft ${drafts.length} รายการ</button>${showD ? drafts.map(p => prRow(r.repo, p)).join("") : ""}` : ""}
          <div class="pq-gf"><button class="pr-auto ${r.auto ? "on" : ""}" data-auto="${esc(r.repo)}" data-on="${r.auto ? 1 : 0}"><i></i>ตรวจออโต้</button><a href="https://github.com/${esc(r.repo)}/pulls" target="_blank" rel="noopener">GitHub ↗</a></div></div></section>`;
    }).join("");
    root.innerHTML = `<div class="pq-tabs">${tabs.map(([k, t, n]) => `<button class="${k === tab ? "on" : ""}" data-tab="${k}">${t}<em>${n}</em></button>`).join("")}<button class="rf" data-rf>${S.loading ? "…" : "↻"}</button></div>
      <div class="pq-meta">อัปเดต ${hhmm(d.at)} · ห้องตรวจ team2 · AI ตรวจอย่างเดียว ไม่ merge</div>
      ${groups || `<div class="pr-empty">ไม่มี PR ในกลุ่มนี้</div>`}
      <div class="pq-meta">อีก ${d.empty} repo ไม่มี PR เปิด${d.errors ? ` · อ่านไม่ได้ ${d.errors} repo` : ""}</div>`;
    paintSheet();
  }
  // แผ่นล่างของ PR ที่แตะ — ปุ่ม AI ตรวจ / เปิด / Merge (Merge และส่งตรวจยังต้องแตะสองครั้งเหมือนเดิม)
  let sheetEl = null;
  function openSheet(k) {
    sheetEl?.remove();
    const bg = document.createElement("div"); bg.className = "sheet-bg";
    bg.innerHTML = `<div class="sheet pq-sh" data-k="${esc(k)}"></div>`;
    bg.onclick = e => { if (e.target === bg) { bg.remove(); sheetEl = null; } };
    bg.addEventListener("click", onClick);
    bg.addEventListener("change", onChange);
    document.body.appendChild(bg); sheetEl = bg; paintSheet();
  }
  function paintSheet() {
    if (!sheetEl) return;
    const box = sheetEl.querySelector(".pq-sh"), k = box.dataset.k, { repo, number } = find(k);
    const p = S.data?.repos.find(r => r.repo === repo)?.prs.find(x => x.number === number);
    if (!p) { sheetEl.remove(); sheetEl = null; return; }
    const armed = S.armed && S.armed.k === k ? S.armed.kind : "", busy = S.busy.has(k), v = p.verdict, mm = S.method.get(k) || "squash";
    box.innerHTML = `<div class="st"><i>${esc(repo.split("/")[1])} #${p.number}</i><br>${esc(p.title)}</div>
      <div class="sm"><span class="pq-d ${sClass(p.status.code)}"></span>${esc(plain(p.status.text))} · ${esc(p.author || "")} · ${ago(p.updatedAt)}</div>
      ${p.reviewing ? `<div class="vd">AI กำลังตรวจ · ห้อง ${esc(p.reviewing.room)}</div>` : v ? `<div class="vd ${v.stale ? "" : v.verdict}">AI ${v.stale ? `ตรวจก่อนอัปเดตล่าสุด (${v.verdict === "ready" ? "เคยพร้อม" : "เคยติด"})` : (v.verdict === "ready" ? "ว่าพร้อม" : "ว่าติด") + (v.note ? " · " + esc(v.note) : "")}</div>` : ""}
      ${p.status.ready ? `<div class="pq-opts">${["squash", "merge", "rebase"].map(m => `<button class="${m === mm ? "on" : ""}" data-mm2="${m}">${m}</button>`).join("")}
        <label><input type="checkbox" data-del="${esc(k)}" ${S.del.has(k) ? "checked" : ""}>ลบ branch</label></div>` : ""}
      <div class="pq-btns"><button class="${armed === "review" ? "armed" : ""}" data-rv="${esc(k)}" ${busy || p.reviewing ? "disabled" : ""}>${armed === "review" ? "แตะอีกครั้ง" : "AI ตรวจ"}</button>
        <a href="${esc(p.url)}" target="_blank" rel="noopener">เปิด GitHub</a>
        ${p.status.ready ? `<button class="mg ${armed === "merge" ? "armed" : ""}" data-merge="${esc(k)}" ${busy ? "disabled" : ""}>${armed === "merge" ? "แตะอีกครั้ง = merge" : "Merge"}</button>` : ""}</div>`;
  }
  function draw() {
    if (clean()) return drawClean();
    const d = S.data, c = counts();
    if (!d) { root.innerHTML = `<div class="pr-empty">${S.err ? "โหลดไม่ได้: " + esc(S.err) : "กำลังโหลด PR จาก GitHub…"}</div>`; return; }
    const chip = (n, t, cls) => n ? `<span class="pr-chip ${cls}">${t} ${n}</span>` : "";
    root.innerHTML = `<div class="pr-top">${chip(c.ready, "✅ พร้อม", "ok")}${chip(c.bad, "❌ ติด", "bad")}${chip(c.other, "⏳ อื่นๆ", "")}${chip(c.draft, "📝 draft", "dim")}
        <button class="rf" data-rf>${S.loading ? "…" : "↻"}</button></div>
      <div class="pr-when">อัปเดต ${hhmm(d.at)} · ห้องตรวจ team2 · AI ตรวจอย่างเดียว ไม่ merge</div>
      ${sortRepos(d.repos).map(r => {
        const live = r.prs.filter(p => !p.isDraft), drafts = r.prs.filter(p => p.isDraft), showD = S.drafts.has(r.repo);
        const [o, n] = r.repo.split("/"), ok = live.filter(p => p.status.ready).length, bad = live.filter(p => isBad(p)).length;
        const folded = S.fold.has(r.repo) || (!live.length && !S.unfold.has(r.repo));
        return `<section class="pr-grp ${folded ? "fold" : ""}">
          <button class="pr-gh" data-fold="${esc(r.repo)}"><span class="av" style="--h:${hue(n)}">${esc(n[0].toUpperCase())}</span>
            <span class="nm"><b>${esc(n)}</b><small>${esc(o)}</small></span>
            <span class="cnt">${ok ? `<i class="ok">✅ ${ok}</i>` : ""}${bad ? `<i class="bad">❌ ${bad}</i>` : ""}${live.length - ok - bad ? `<i>⏳ ${live.length - ok - bad}</i>` : ""}${drafts.length ? `<i class="dim">📝 ${drafts.length}</i>` : ""}</span><span class="cv">›</span></button>
          <div class="pr-gb">
            ${r.error ? `<div class="pr-err">${esc(r.error)}</div>` : ""}
            ${live.map(p => prHtml(r.repo, p)).join("")}
            ${drafts.length ? `<button class="pr-more" data-dr="${esc(r.repo)}">${showD ? "▾" : "▸"} draft ${drafts.length} รายการ</button>${showD ? drafts.map(p => prHtml(r.repo, p)).join("") : ""}` : ""}
            <div class="pr-gf"><button class="pr-auto ${r.auto ? "on" : ""}" data-auto="${esc(r.repo)}" data-on="${r.auto ? 1 : 0}"><i></i>ตรวจออโต้</button><a href="https://github.com/${esc(r.repo)}/pulls" target="_blank" rel="noopener">GitHub ↗</a></div>
          </div></section>`;
      }).join("") || `<div class="pr-empty">ไม่มี PR เปิดอยู่เลย</div>`}
      <div class="pr-when">อีก ${d.empty} repo ไม่มี PR เปิด${d.errors ? ` · อ่านไม่ได้ ${d.errors} repo` : ""}</div>`;
  }

  const find = k => { const i = k.lastIndexOf("#"); return { repo: k.slice(0, i), number: +k.slice(i + 1) }; };
  function arm(k, kind) {
    clearTimeout(S.armed?.t);
    S.armed = { k, kind, t: setTimeout(() => { S.armed = null; draw(); }, 4000) };
    draw();
  }
  async function onClick(e) {
    const t = e.target.closest("button"); if (!t) return;
    if (t.hasAttribute("data-rf")) return refresh(true);
    if (t.dataset.tab) { S.tab = t.dataset.tab; return draw(); }
    if (t.dataset.open) return openSheet(t.dataset.open);
    if (t.dataset.mm2) { S.method.set(t.closest(".pq-sh").dataset.k, t.dataset.mm2); return paintSheet(); }
    if (t.dataset.fold) { const r = t.dataset.fold, g = t.closest(".pr-grp"); if (g.classList.contains("fold")) { S.fold.delete(r); S.unfold.add(r); } else { S.fold.add(r); S.unfold.delete(r); } return draw(); }
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
      if (kind === "merge") { sheetEl?.remove(); sheetEl = null; }
    } catch (err) { toast(err.message); }
    finally { S.busy.delete(k); }
    refresh(kind === "merge");
  }
  root.addEventListener("click", onClick);

  function onChange(e) {
    const t = e.target;
    if (t.dataset.mm) S.method.set(t.dataset.mm, t.value);
    if (t.dataset.del) t.checked ? S.del.add(t.dataset.del) : S.del.delete(t.dataset.del);
  }
  root.addEventListener("change", onChange);

  async function refresh(fresh) {
    if (S.loading) return;
    S.loading = true; if (root.isConnected) draw();
    try { S.data = await api("/prs" + (fresh ? "?fresh=1" : "")); S.at = Date.now(); S.err = ""; if (fresh) toast("อัปเดต PR แล้ว"); }
    catch (e) { S.err = e.message; if (fresh) toast("โหลด PR ไม่ได้: " + e.message); }
    finally { S.loading = false; if (root.isConnected) draw(); mawExt.refreshTiles?.(); }
  }

  // own screen from the home "เมนู" grid (tile shows the counts)
  mawExt.pages.push({
    key: "prs", icon: "🔀", title: "PR",
    summary() {
      if (!S.data) return { text: S.err ? "โหลดไม่ได้" : "กำลังโหลด…" };
      const c = counts();
      return { text: [c.ready && `✅ ${c.ready} พร้อม`, c.bad && `❌ ${c.bad} ติด`, `${c.all} PR`].filter(Boolean).join(" · "), badge: c.ready || c.bad ? String(c.ready + c.bad) : "", tone: c.bad ? "bad" : c.ready ? "ok" : "" };
    },
    mount(el) { el.appendChild(root); draw(); if (Date.now() - S.at > 30_000) refresh(false); },
  });
  refresh(false);
  setInterval(() => { if (!document.hidden && Date.now() - S.at > (root.isConnected ? 60_000 : 180_000)) refresh(false); }, 15_000);
})();
