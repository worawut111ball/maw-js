// Herdr lifecycle UI. Requires host mount/auth and shared room hooks; never runs a mutation on import.
(() => {
  if (!window.mawExt) return;
  const M = { root: null, timer: null, loading: false, operationId: null };
  const text = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const newId = () => crypto.randomUUID();
  const keep = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const remembered = key => { try { return localStorage.getItem(key); } catch { return null; } };
  // Status/ledger/confirmation reads deliberately bypass apiRaw's offline response cache.
  async function request(path, body) {
    const token = typeof store !== 'undefined' ? store.get('maw-mobile-token') : remembered('maw-mobile-token');
    const response = await fetch('/mobile/herdr' + path, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(45_000),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (token || '') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw Object.assign(new Error(result.error || 'Herdr ไม่พร้อม'), { code: result.code, status: response.status });
    return result;
  }
  function sheet(title) {
    clearTimeout(M.timer); M.timer = null; M.root?.remove();
    const root = document.createElement('div'); root.className = 'sheet-bg';
    root.innerHTML = `<div class="sheet"><h2>${text(title)}</h2><div data-body></div><button class="ghost" data-close>กลับ</button></div>`;
    root.querySelector('[data-close]').onclick = () => { clearTimeout(M.timer); root.remove(); if (M.root === root) M.root = null; };
    document.body.appendChild(root); M.root = root; return root.querySelector('[data-body]');
  }
  const phaseText = {
    provisioning: 'กำลังสร้าง', 'waiting-agent': 'รอ agent / กรุณาตรวจหน้าอนุญาตบนจอ', 'bootstrap-pending': 'รอส่งกติกา',
    ready: 'พร้อมรับงานจากผู้ใช้', partial: 'สำเร็จบางส่วน', uncertain: 'ยังยืนยันผลบางขั้นไม่ได้ — ไม่ส่งซ้ำ',
    closing: 'กำลังปิด', closed: 'ปิดแล้ว', 'blocked-awaiting-binding': 'รอผูกประวัติและความเป็นเจ้าของห้อง',
  };
  const reasonText = code => ({ 'waiting-native': 'รอยืนยัน conversation เดิม', 'waiting-agent': 'รอ agent พร้อมรับข้อความ', conversation_changed: 'conversation เปลี่ยนแล้ว — พัก autostart ของสมาชิกนี้', start_uncertain: 'ยังยืนยันว่าเปิดสำเร็จไม่ได้ — ตรวจจอปลายทางก่อน ห้ามเปิดซ้ำ', member_restore_uncertain: 'ยังยืนยันการคืนสมาชิกไม่ได้ — ไม่เปิดซ้ำ', operation_uncertain: 'ยังยืนยันผลคำสั่งไม่ได้ — ตรวจปลายทางก่อนดำเนินต่อ', agent_changed: 'agent เดิมปิดหรือเปลี่ยนแล้ว', exact_resume_binding_unconfirmed: 'ยังยืนยันบทสนทนาที่คืนมาไม่ได้', exact_conversation_required: 'รอหลักฐานบทสนทนาเดิม', foreign_or_busy_terminal: 'ปลายทางมี agent หรือ process อื่น — ไม่แทนที่', foreign_workspace: 'มี workspace ชื่อเดียวกันที่ยังยืนยันความเป็นเจ้าของไม่ได้', waiting_agent: 'รอ agent พร้อมรับข้อความ' }[code] || (code ? 'ต้องตรวจสถานะล่าสุดก่อนทำต่อ' : ''));
  async function progress(id, root) {
    if (!root.isConnected) return;
    try {
      const { operation: op } = await request('/operations/' + encodeURIComponent(id));
      if (!root.isConnected) return;
      root.innerHTML = `<b>${text(op.label)} · ${text(phaseText[op.phase] || op.phase)}</b>
        <p>autostart <button data-auto>${op.desiredAutostart ? 'เปิด' : 'ปิด'}</button></p>
        ${op.members.map(m => `<div style="padding:8px 0;border-bottom:1px solid var(--line)"><b>${text(m.role)} · ${text(m.agentKind)}</b>
        <div>รุ่นที่ตั้ง: ${text(m.model || 'ค่าเริ่มต้นของ agent')} · ${m.permission === 'bypass' ? 'ไม่ถามสิทธิ์' : 'ถามอนุญาต'}</div>
        <div>${m.closed ? 'ปิดห้องแล้ว' : m.ready ? '✓ ได้รับกติกาแล้ว พร้อมรับงาน' : m.launched ? 'เปิด agent แล้ว · ' + text(m.bootstrap) : 'รอเปิด agent'} ${text(reasonText(m.reason))}</div>
        <button data-member="${text(m.logicalId)}" ${m.closed ? 'disabled' : ''}>autostart ${m.desired ? 'เปิด' : 'ปิด'}</button></div>`).join('')}
        <p>${text(reasonText(op.reason))}</p><button data-resume ${['closing', 'closed', 'blocked-awaiting-binding'].includes(op.phase) ? 'disabled' : ''}>ตรวจและดำเนินต่อ operation เดิม</button>`;
      root.querySelector('[data-auto]').onclick = async () => { try { await request(`/operations/${encodeURIComponent(id)}/autostart`, { on: !op.desiredAutostart }); await progress(id, root); } catch (e) { alert(e.message); } };
      root.querySelectorAll('[data-member]').forEach(b => { b.onclick = async () => {
        const m = op.members.find(m => m.logicalId === b.dataset.member);
        try { await request(`/operations/${encodeURIComponent(id)}/autostart`, { memberId: m.logicalId, on: !m.desired }); await progress(id, root); } catch (e) { alert(e.message); }
      }; });
      root.querySelector('[data-resume]').onclick = async e => {
        e.target.disabled = true;
        try { await request(`/operations/${encodeURIComponent(id)}/continue`, {}); }
        catch (e) { alert('ยังยืนยันผลไม่ได้ — ตรวจ operation เดิมก่อนดำเนินต่อ: ' + e.message); }
        await progress(id, root);
      };
    } catch (e) {
      if (root.isConnected) {
        root.innerHTML = `<p>อ่านสถานะล่าสุดไม่ได้ · เก็บ operation เดิมไว้แล้ว ไม่สร้างซ้ำ · ${text(e.message)}</p>`;
        const exactBody = remembered('maw-herdr-create-' + id);
        if (e.code === 'operation_not_found' && exactBody) {
          const retry = document.createElement('button'); retry.textContent = 'ส่งคำขอสร้างเดิมอีกครั้ง (operation ID เดิม)';
          retry.onclick = async () => { retry.disabled = true; try { await request('/create', JSON.parse(exactBody)); } catch (e) { alert('ยังยืนยันผลไม่ได้ · ' + e.message); } await progress(id, root); }; root.appendChild(retry);
        }
      }
    }
    if (!root.isConnected) return;
    clearTimeout(M.timer); if (!document.hidden) M.timer = setTimeout(() => progress(id, root), 3000);
  }
  window.mawHerdrProgress = id => { keep('maw-herdr-operation', id); M.operationId = id; const root = sheet('สถานะ Herdr'); void progress(id, root); };
  window.mawHerdrCreate = w => {
    const root = sheet('สร้าง Herdr');
    root.innerHTML = `<label>ชื่อ workspace <input data-label maxlength="32" placeholder="my-team" /></label>
      <label>โฟลเดอร์ <input data-cwd placeholder="โฟลเดอร์ที่เลือกบน Mac" value="${text(w?.path || '')}" /></label>
      <label>รูปแบบ <select data-mode><option value="single">agent เดี่ยว</option><option value="team">หัวหน้า 1 + ลูก 3</option></select></label>
      <p>รุ่นด้านล่างเป็น config ที่เลือกก่อนสร้าง หัวหน้าซ้าย / ลูกสามตัวขวา</p><div data-members></div>
      <label><input type="checkbox" data-auto checked /> เปิด autostart</label>
      <p>ส่งกติกาให้ครบแล้วรอผู้ใช้มอบงาน ไม่เริ่มงานเอง</p><button data-create>สร้าง</button><p data-error></p>`;
    const render = () => {
      const roles = root.querySelector('[data-mode]').value === 'team' ? ['head', 'worker1', 'worker2', 'worker3'] : ['agent'];
      root.querySelector('[data-members]').innerHTML = roles.map((role, i) => `<fieldset data-role="${role}" style="margin:8px 0"><legend>${text(role)}</legend>
        <select data-kind><option value="codex">Codex</option><option value="claude">Claude</option></select>
        <input data-model value="${i === 0 ? 'gpt-6-astra' : 'gpt-6.1-sol'}" aria-label="model config" />
        <select data-permission><option value="ask">ถามอนุญาต (ค่าเริ่มต้น)</option><option value="bypass">ไม่ถามสิทธิ์</option></select></fieldset>`).join('');
      root.querySelectorAll('[data-kind]').forEach(s => { s.onchange = () => { s.closest('fieldset').querySelector('[data-model]').value = ''; }; });
    };
    root.querySelector('[data-mode]').onchange = render; render();
    const operationId = newId(); let submitted = false;
    root.querySelector('[data-create]').onclick = async e => {
      if (submitted) return window.mawHerdrProgress(operationId);
      const body = { id: operationId, label: root.querySelector('[data-label]').value.trim(), cwd: root.querySelector('[data-cwd]').value.trim(), mode: root.querySelector('[data-mode]').value,
        autostart: root.querySelector('[data-auto]').checked,
        members: [...root.querySelectorAll('[data-role]')].map(f => ({ role: f.dataset.role, agentKind: f.querySelector('[data-kind]').value, ...(f.querySelector('[data-model]').value.trim() ? { model: f.querySelector('[data-model]').value.trim() } : {}), permission: f.querySelector('[data-permission]').value })) };
      if (!body.cwd || !/^[a-z][a-z0-9_-]{0,31}$/.test(body.label)) { root.querySelector('[data-error]').textContent = 'กรอกชื่อ workspace และโฟลเดอร์ก่อน'; return; }
      try { localStorage.setItem('maw-herdr-create-' + operationId, JSON.stringify(body)); localStorage.setItem('maw-herdr-operation', operationId); }
      catch { root.querySelector('[data-error]').textContent = 'เก็บคำขอสร้างบนมือถือไม่ได้ — ยังไม่ได้ส่ง'; return; }
      submitted = true; e.target.disabled = true;
      try { await request('/create', body); } catch (err) { root.querySelector('[data-error]').textContent = 'ยังยืนยันผลไม่ได้ เก็บ operation เดิมไว้แล้ว · ' + err.message; if (err.status === 400) { submitted = false; e.target.disabled = false; return; } }
      window.mawHerdrProgress(operationId);
    };
  };
  window.mawHerdrStop = async (w, room) => {
    if (!room?.generation || !confirm('หยุดงานปัจจุบันของ ' + room.title + '?')) return;
    const id = newId();
    try { const { delivery } = await request('/stop', { id, ws: w.id, room: room.id, generation: room.generation }); alert(delivery.state === 'acknowledged' ? 'ส่งคำสั่งหยุดแล้ว — ไม่ได้ปิดห้อง' : 'ยังยืนยันการส่งคำสั่งหยุดไม่ได้ — ไม่ส่งซ้ำ'); }
    catch (e) { alert('ยังยืนยันผลคำสั่งหยุดไม่ได้ — ตรวจจอก่อนทำต่อ · ' + e.message); }
  };
  window.mawHerdrClose = async (w, room) => {
    const root = sheet('ยืนยันปิด Herdr');
    try {
      const { preview } = await request('/close/preview', { workspaceId: String(w.id).replace(/^herdr:/, ''), ...(room ? { paneId: room.id } : {}) });
      if (!root.isConnected) return;
      root.innerHTML = `<p>ปิด autostart ของเป้าหมายต่อไปนี้ด้วย · เก็บประวัติแชทไว้</p>${preview.panes.map(p => `<p>${text(p.name || p.paneId)} · ${text(p.agentKind || 'shell')}</p>`).join('')}<button data-confirm>ยืนยันปิด</button><p data-result></p>`;
      root.querySelector('[data-confirm]').onclick = async e => {
        e.target.disabled = true;
        try { const { close } = await request('/close/confirm', { previewId: preview.id }); root.querySelector('[data-result]').textContent = `autostart: ${close.autostartDisabled ? 'ปิดแล้ว' : 'ยังไม่ปิด'} · ห้อง: ${close.runtimeClosed ? 'ปิดแล้ว' : 'ยังยืนยันว่าปิดไม่ได้'}${close.deliveryUnknown ? ' · ไม่ส่งคำสั่งซ้ำ' : ''}`; }
        catch (err) { root.querySelector('[data-result]').textContent = err.message + ' — โหลดรายชื่อสดและยืนยันใหม่เมื่อเป้าหมายเปลี่ยน'; }
      };
    } catch (e) { root.textContent = e.message; }
  };
  mawExt.keys.push({ label: 'หยุดงาน', show: ({ w, room }) => String(w?.id).startsWith('herdr:') && room?.capabilities?.stop && room.status === 'working', onClick: ({ w, room }) => window.mawHerdrStop(w, room) });
  mawExt.keys.push({ label: 'ปิดห้อง', show: ({ w, room }) => String(w?.id).startsWith('herdr:') && room?.capabilities?.close, onClick: ({ w, room }) => window.mawHerdrClose(w, room) });
  mawExt.pages.push({ key: 'herdr', title: 'Herdr', icon: '▦', hint: 'สร้าง agent / ทีม และติดตาม operation', mount: root => {
    root.innerHTML = '<button data-new>สร้าง Herdr</button><button data-last>operation ล่าสุด</button><div data-list></div>';
    root.querySelector('[data-new]').onclick = () => window.mawHerdrCreate();
    root.querySelector('[data-last]').onclick = () => { const id = remembered('maw-herdr-operation'); if (id) window.mawHerdrProgress(id); };
    request('/status').then(r => { if (root.isConnected) root.querySelector('[data-list]').innerHTML = r.operations.map(o => `<button data-op="${text(o.id)}">${text(o.label)} · ${text(phaseText[o.phase] || o.phase)}</button>`).join(''); root.querySelectorAll('[data-op]').forEach(b => b.onclick = () => window.mawHerdrProgress(b.dataset.op)); }).catch(e => { if (root.isConnected) root.querySelector('[data-list]').textContent = e.message; });
  } });
})();
