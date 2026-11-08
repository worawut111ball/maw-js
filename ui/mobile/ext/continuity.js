// Cross-agent continuity. Server capabilities and current room state gate every action.
(function () {
  let view = null, serial = 0, modal = null;
  const labels = { 'waiting-safe-point':'รอ agent จบรอบ', checkpointed:'กำลังเตรียมบริบท', 'preparing-target':'กำลังเปิดหรือกลับเข้า session เดิม', 'delivering-context':'กำลังส่งบริบท', 'ready-awaiting-user':'พร้อม — รอคำสั่ง', blocked:'พักการสลับ', failed:'สลับไม่สำเร็จ', uncertain:'ต้องตรวจสถานะก่อนทำต่อ' };
  const reasons = { agent_changed:'agent เดิมถูกเปลี่ยนแล้ว', context_facts_unavailable:'ยังเตรียมข้อมูลส่งต่อไม่ได้', context_goal_missing:'ยังไม่มีเป้าหมายงานสำหรับส่งต่อ', source_changed_during_checkpoint:'agent เดิมมีงานใหม่ระหว่างเตรียมข้อมูล', history_changed_during_checkpoint:'ประวัติมีข้อมูลเพิ่ม ต้องเตรียมใหม่', resume_identity_mismatch:'กลับเข้า session เดิมไม่สำเร็จ', target_changed_during_context:'agent ปลายทางถูกเปลี่ยนระหว่างรับข้อมูล', context_receipt_unverified:'ยังยืนยันว่ารับบริบทครบไม่ได้', launch_unverified_source_preserved:'ยังยืนยันการเปิดปลายทางไม่ได้ ต้องตรวจปลายทางก่อนทำต่อ', all_backends_required:'ยังรองรับไม่ครบทั้งสามระบบ', continuity_not_ready:'ยังไม่พร้อมเปิดการสลับ', model_unavailable:'โมเดลนี้ยังไม่พร้อมใช้', stale_room_revision:'สถานะห้องเปลี่ยนแล้ว กรุณาอ่านสถานะล่าสุด', canceled_by_user:'ยกเลิกการสลับแล้ว' };
  const stale = 'สถานะห้องเปลี่ยนแล้ว กรุณาอ่านสถานะล่าสุด';
  const base = v => `/rooms/${encodeURIComponent(v.w.id)}/${encodeURIComponent(v.room.id)}/continuity`;
  const selected = v => view === v && state.ws === v.w.id && state.room === v.room.id;
  const certified = c => c?.ready === true && ['herdr','tmux','superset'].every(b => c.backends?.some(x => x.backend === b && x.ready === true));
  const models = c => Array.isArray(c?.models) ? c.models.filter(m => ['codex','claude'].includes(m.agent) && typeof m.id === 'string' && m.id && typeof m.label === 'string') : [];
  const stamp = d => JSON.stringify([d.room.id,d.room.revision,d.room.active,d.room.operationId || null,d.room.bindings || null,d.operation || null]);
  const request = async (path,body) => {
    let data;
    try { data = await apiRaw(path,body===undefined?{cache:'no-store'}:{method:'POST',body:JSON.stringify(body),cache:'no-store'}); }
    catch(e) { throw new Error(reasons[e.body?.code] || e.message || 'อ่านสถานะการสลับไม่ได้'); }
    if(!data?.ok) throw new Error(reasons[data?.code] || 'อ่านสถานะการสลับไม่ได้');
    return data;
  };
  function closeModal() { if(modal){modal.bg.remove();modal=null;} }
  function clear(v) {
    if(!selected(v))return;
    v.current=null;closeModal();
    document.querySelector('#ext-room-top .continuity-status')?.remove();
    const b=document.querySelector(`[data-xk="${keyIndex}"]`);if(b)b.hidden=true;
  }
  function busy(v,value) {
    v.busy=value;if(!selected(v))return;
    document.querySelectorAll('#ext-room-top .continuity-status button').forEach(b=>b.disabled=value);
    const b=document.querySelector(`[data-xk="${keyIndex}"]`);if(b)b.disabled=value;
    if(modal?.view===v)modal.bg.querySelectorAll('button,select').forEach(b=>b.disabled=value);
  }
  function activate(w,room) {
    closeModal();view={w:{id:w.id},room:{id:room.id},serial:++serial,current:null,caps:null,loading:null,read:0,busy:false};
    document.querySelector('#ext-room-top .continuity-status')?.remove();
    const b=document.querySelector(`[data-xk="${keyIndex}"]`);if(b){b.hidden=true;b.disabled=false;}
    return view;
  }
  function scope(w,room) {
    if(state.ws!==w.id || state.room!==room.id)return null;
    return view?.w.id===w.id && view?.room.id===room.id ? view : activate(w,room);
  }
  function draw(v,data) {
    if(!selected(v))return;
    const slot=document.getElementById('ext-room-top');if(!slot)return;
    let node=slot.querySelector('.continuity-status');
    if(!node){node=document.createElement('div');node.className='continuity-status';slot.appendChild(node);}
    const op=data.operation;
    node.textContent=op?(labels[op.state]||'กำลังตรวจสถานะ')+(op.reason?' · '+(reasons[op.reason]||'ต้องตรวจสถานะ agent ก่อนทำต่อ'):''):'Agent: '+data.room.active;
    const held=(data.held||[]).length;if(held)node.textContent+=` · ข้อความพัก ${held} รายการ`;
    if(op && data.room.operationId===op.id && ['waiting-safe-point','blocked'].includes(op.state)) {
      const action=(label,suffix)=>{
        const b=document.createElement('button');b.textContent=label;b.disabled=v.busy;
        b.onclick=()=>mutate(v,data,async fresh=>{
          await request(base(v)+'/operations/'+encodeURIComponent(op.id)+'/'+suffix,suffix==='cancel'?{expectedRevision:fresh.room.revision}:{});
          if(selected(v))await load(v,true);
        });node.appendChild(b);
      };
      if(op.state==='blocked')action('ลองใหม่','retry');action('ยกเลิกการสลับ','cancel');
    }
  }
  async function load(v,fresh=false) {
    if(!selected(v))return null;
    if(v.loading){await v.loading;if(!selected(v))return null;if(!fresh)return v.current;}
    // Recheck capabilities on each poll/open/action: a previous ready result is never authority to POST.
    const ticket=++v.read;
    const valid=()=>selected(v)&&ticket===v.read;
    const pending=(async()=>{
      try {
        const caps=await request('/continuity/capabilities');if(!valid())return null;
        v.caps=caps;if(!certified(caps)){clear(v);return null;}
        const data=await request(base(v));if(!valid())return null;
        if(data.room?.workspace!==v.w.id || data.room?.room!==v.room.id || typeof data.room.id!=='string' || !Number.isSafeInteger(data.room.revision) || data.room.revision<0 || !['codex','claude'].includes(data.room.active))throw new Error(stale);
        if(modal?.view===v && (modal.stamp!==stamp(data) || modal.models!==JSON.stringify(models(caps))))closeModal();
        v.current=data;draw(v,data);
        const b=document.querySelector(`[data-xk="${keyIndex}"]`);if(b){b.hidden=false;b.disabled=v.busy;}
        return data;
      } catch { if(valid())clear(v);return null; }
    })();
    v.loading=pending;
    try{return await pending;}finally{if(v.loading===pending)v.loading=null;}
  }
  async function mutate(v,snapshot,action) {
    if(!selected(v)||v.busy)return;
    busy(v,true);
    try {
      const data=await load(v,true);
      if(!selected(v))return;
      if(!data || !certified(v.caps))throw new Error('ยังไม่พร้อมสลับ agent');
      if(stamp(data)!==stamp(snapshot))throw new Error(stale);
      await action(data);
    }catch(e){if(selected(v)){closeModal();toast(e.message);}}
    finally{busy(v,false);}
  }
  async function open(w,room) {
    const v=scope(w,room);if(!v || v.busy)return;
    const data=await load(v,true);if(!selected(v))return;
    if(!data || !certified(v.caps))return toast('ยังไม่พร้อมสลับ agent');
    if(data.room.operationId)return toast('ห้องนี้มีการสลับอยู่แล้ว ตรวจสถานะก่อนทำต่อ');
    closeModal();
    const bg=document.createElement('div');bg.className='sheet-bg';
    const sheet=document.createElement('div');sheet.className='sheet';bg.appendChild(sheet);
    const frame={view:v,bg,stamp:stamp(data),models:JSON.stringify(models(v.caps))};modal=frame;
    const heading=document.createElement('h2');heading.textContent='สลับ agent';sheet.appendChild(heading);
    const note=document.createElement('p');note.textContent='รับบริบทแล้วรอคำสั่ง · กลับเจ้าเดิมใช้ session เดิม';sheet.appendChild(note);
    for(const agent of ['codex','claude']) {
      if(agent===data.room.active)continue;
      const catalog=models(v.caps).filter(m=>m.agent===agent);
      if(!catalog.length){const n=document.createElement('p');n.textContent=agent+' — ยังไม่มีข้อมูลโมเดลที่รองรับ';sheet.appendChild(n);continue;}
      const select=document.createElement('select');
      for(const m of catalog){const option=document.createElement('option');option.value=m.id;option.textContent=m.label;select.appendChild(option);}
      const b=document.createElement('button');b.textContent='เปลี่ยนเป็น '+agent;
      b.onclick=()=>{
        if(!selected(v)||modal!==frame||!bg.isConnected)return;
        const model=select.value;
        return mutate(v,data,async fresh=>{
          if(modal!==frame||!models(v.caps).some(m=>m.agent===agent&&m.id===model))throw new Error(stale);
          const result=await request(base(v)+'/switch',{id:requestId(),target:agent,model,expectedRevision:fresh.room.revision});
          if(!selected(v))return;
          closeModal();toast('รับคำขอสลับแล้ว');
          const next=await load(v,true);if(!selected(v)||!next)return;
          if(typeof result.operation?.id!=='string' || next.room.operationId!==result.operation.id || next.operation?.id!==result.operation.id || next.operation.state!=='waiting-safe-point')return;
          await request(base(v)+'/operations/'+encodeURIComponent(result.operation.id)+'/advance',{});
          if(selected(v))await load(v,true);
        });
      };
      sheet.append(select,b);
    }
    const close=document.createElement('button');close.textContent='ปิด';close.onclick=()=>closeModal();sheet.appendChild(close);
    bg.onclick=e=>{if(e.target===bg)closeModal();};document.body.appendChild(bg);
  }
  mawExt.keys.push({label:'⇄ Agent',onClick:({w,room})=>open(w,room)});
  const keyIndex=mawExt.keys.length-1;
  mawExt.onRoom.push(({w,room})=>{if(state.ws===w.id&&state.room===room.id)load(activate(w,room));});
  mawExt.onPoll.push(({w,room})=>{const v=scope(w,room);if(v)load(v);else if(view&&!selected(view))closeModal();});
  if(Array.isArray(mawExt.onHome))mawExt.onHome.push(()=>{closeModal();view=null;});
})();
