// Cross-agent continuity. Server capabilities and current room state gate every action.
(function () {
  let view = null, serial = 0, modal = null;
  const labels = { 'waiting-safe-point':'รอ agent จบรอบ', checkpointed:'กำลังเตรียมบริบท', 'preparing-target':'กำลังเปิดหรือกลับเข้า session เดิม', 'delivering-context':'กำลังส่งบริบท', 'ready-awaiting-user':'พร้อม — รอคำสั่ง', blocked:'พักการสลับ', failed:'สลับไม่สำเร็จ', uncertain:'ต้องตรวจสถานะก่อนทำต่อ' };
  const reasons = { staged_source_target_unverified:'ยังยืนยันสถานะ agent ต้นทางและปลายทางไม่ได้ กรุณาตรวจ operation เดิมก่อนส่งซ้ำ', facts_selection_unavailable:'Mac ยังไม่มีบริการเลือก facts ที่พร้อมใช้', facts_preview_changed:'ข้อมูลอ้างอิงเปลี่ยนแล้ว ต้องอ่าน preview และเลือกใหม่', facts_room_changed:'binding ของข้อมูลอ้างอิงเปลี่ยนแล้ว', facts_preview_expired:'preview หมดอายุ ต้องอ่านและเลือกใหม่', facts_selection_scope_mismatch:'receipt facts ไม่ตรงคำขอสลับ', room_backend_not_ready:'Backend ของห้องนี้ยังไม่พร้อมสลับ', agent_changed:'agent เดิมถูกเปลี่ยนแล้ว', context_facts_unavailable:'ยังเตรียมข้อมูลส่งต่อไม่ได้', context_goal_missing:'ยังไม่มีเป้าหมายงานสำหรับส่งต่อ', source_changed_during_checkpoint:'agent เดิมมีงานใหม่ระหว่างเตรียมข้อมูล', history_changed_during_checkpoint:'ประวัติมีข้อมูลเพิ่ม ต้องเตรียมใหม่', resume_identity_mismatch:'กลับเข้า session เดิมไม่สำเร็จ', target_changed_during_context:'agent ปลายทางถูกเปลี่ยนระหว่างรับข้อมูล', context_receipt_unverified:'ยังยืนยันว่ารับบริบทครบไม่ได้', launch_unverified_source_preserved:'ยังยืนยันการเปิดปลายทางไม่ได้ ต้องตรวจปลายทางก่อนทำต่อ', all_backends_required:'ยังรองรับไม่ครบทั้งสามระบบ', continuity_not_ready:'ยังไม่พร้อมเปิดการสลับ', model_unavailable:'โมเดลนี้ยังไม่พร้อมใช้', stale_room_revision:'สถานะห้องเปลี่ยนแล้ว กรุณาอ่านสถานะล่าสุด', canceled_by_user:'ยกเลิกการสลับแล้ว' };
  const stale = 'สถานะห้องเปลี่ยนแล้ว กรุณาอ่านสถานะล่าสุด';
  const base = v => `/rooms/${encodeURIComponent(v.w.id)}/${encodeURIComponent(v.room.id)}/continuity`;
  const physicalStamp = (w,r) => {const b=r.protocolBinding;return JSON.stringify([w.id,r.id,r.agent??null,r.generation??null,r.claudeSessionId??null,r.transportKind??null,r.logicalRoomId??null,r.revision??null,b?[b.agent,b.nativeId,b.generation,b.model??null,b.route??null]:null]);};
  const currentPhysical = v => {
    if(!Array.isArray(state.projects))return v.physical;
    const w=state.projects.flatMap(p=>p.workspaces||[]).find(w=>w.id===v.w.id),r=w?.rooms?.find(r=>r.id===v.room.id);
    return r?physicalStamp(w,r):null;
  };
  const selected = v => !!v && view === v && state.ws === v.w.id && state.room === v.room.id && currentPhysical(v)===v.physical;
  const certified = (c,room) => c?.ready===true && (c.scope==='room-backend'
    ? ['herdr','tmux','superset'].includes(room?.backend)&&c.backends?.some(x=>x.backend===room.backend&&x.ready===true)
    : (c.scope===undefined||c.scope==='all-backends')&&['herdr','tmux','superset'].every(b=>c.backends?.some(x=>x.backend===b&&x.ready===true)));
  const capStamp=c=>JSON.stringify([models(c),c?.scope??'all-backends',c?.factsSelectionAvailable===true]);
  const models = c => Array.isArray(c?.models) ? c.models.filter(m => ['codex','claude'].includes(m.agent) && typeof m.id === 'string' && m.id && m.id.length<=160 && typeof m.label === 'string' && m.label) : [];
  const stamp = d => JSON.stringify([d.room.id,d.room.revision,d.room.active,d.room.operationId || null,d.room.bindings || null,d.operation || null]);
  const request = async (path,body) => {
    let data;
    try { data = await apiRaw(path,body===undefined?{cache:'no-store'}:{method:'POST',body:JSON.stringify(body),cache:'no-store'}); }
    catch(e) { const error=new Error(reasons[e.body?.code] || e.message || 'อ่านสถานะการสลับไม่ได้');error.code=e.body?.code;error.status=e.status;throw error; }
    if(!data?.ok){const error=new Error(reasons[data?.code] || 'อ่านสถานะการสลับไม่ได้');error.code=data?.code;throw error;}
    return data;
  };
  // Owned transport is authoritative only from the scoped host endpoint, never from a ready operation.
  const owned = new Map(), transportReads = new Map();
  const transportKey = (ws,room) => JSON.stringify([ws,room]);
  const transportPath = (ws,room) => `/rooms/${encodeURIComponent(ws)}/${encodeURIComponent(room)}/continuity`;
  const validBinding = b => b && ['codex','claude'].includes(b.agent) &&
    ['nativeId','generation','model','route'].every(k=>typeof b[k]==='string'&&b[k].length>0) && Number.isSafeInteger(b.cursor)&&b.cursor>=0;
  const ownedMarkerKey = key=>'maw-continuity-owned-v1:'+key;
  function knownTransport(ws,room){
    const key=transportKey(ws,room);
    if(!owned.has(key))try{
      const marker=JSON.parse(localStorage.getItem(ownedMarkerKey(key))||'null');
      // Persisted metadata only revokes TUI fallback. It never certifies a live runtime or textTurn.
      if(marker?.kind==='owned-protocol'&&typeof marker.roomId==='string'&&marker.roomId&&Number.isSafeInteger(marker.revision)&&validBinding(marker.binding))owned.set(key,{...marker,state:'unavailable',capabilities:{textTurn:false,attachments:false,keys:false}});
    }catch{}
    if(!owned.has(key)&&Array.isArray(state.projects)){
      const r=state.projects.flatMap(p=>p.workspaces||[]).find(w=>w.id===ws)?.rooms?.find(r=>r.id===room);
      // Inventory revokes legacy routing only; status endpoint must still grant live readiness.
      if(r?.transportKind==='owned-protocol'&&typeof r.logicalRoomId==='string'&&validBinding(r.protocolBinding)&&Number.isSafeInteger(r.revision))owned.set(key,{kind:'owned-protocol',roomId:r.logicalRoomId,revision:r.revision,binding:r.protocolBinding,state:'unavailable',capabilities:{textTurn:false,attachments:false,keys:false}});
    }
    return owned.get(key);
  }
  function transportControls(ws,room,t) {
    if(state.ws!==ws||state.room!==room)return;
    const app=document.getElementById('app');if(app)app.dataset.ownedProtocol='';
    let style=document.getElementById('continuity-owned-style');
    if(!style){style=document.createElement('style');style.id='continuity-owned-style';style.textContent='#app[data-owned-protocol] .keys,#app[data-owned-protocol] [data-m="raw"],#app[data-owned-protocol] .perm,#app[data-owned-protocol] #draft,#app[data-owned-protocol] #sugg,#app[data-owned-protocol] #spin,#app[data-owned-protocol] #cprog{display:none!important}';document.head.appendChild(style);}
    const slot=document.getElementById('ext-room-top');if(!slot)return;
    let note=slot.querySelector('.continuity-transport');if(!note){note=document.createElement('p');note.className='continuity-transport';slot.prepend(note);}
    note.textContent='Owned protocol · '+({idle:'พร้อมรับข้อความ',busy:'กำลังทำงาน',uncertain:'ยังยืนยันสถานะไม่ได้',unavailable:'ยังไม่พร้อม'}[t.state]||'ยังไม่พร้อม')+' · รองรับข้อความเท่านั้น · ไม่มีปุ่มควบคุม TUI';
  }
  async function readTransport(ws,room) {
    const key=transportKey(ws,room);knownTransport(ws,room);
    if(transportReads.has(key))return transportReads.get(key);
    const read=(async()=>{
      try{
        if(!owned.has(key)){const caps=await request('/continuity/capabilities');if(caps.roomStateAvailable===false)return null;}
        const out=await request(transportPath(ws,room)+'/transport'),t=out.transport;
        if(t?.kind!=='owned-protocol'||typeof t.roomId!=='string'||!t.roomId||!Number.isSafeInteger(t.revision)||t.revision<0||!validBinding(t.binding)||!['idle','busy','uncertain','unavailable'].includes(t.state)||typeof t.capabilities?.textTurn!=='boolean'||t.capabilities.attachments!==false||t.capabilities.keys!==false)throw new Error('รูปแบบ owned transport ไม่ถูกต้อง');
        if(owned.has(key)&&owned.get(key).roomId!==t.roomId)throw new Error('logical room เปลี่ยนแล้ว');
        owned.set(key,freeze(structuredClone(t)));
        try{localStorage.setItem(ownedMarkerKey(key),JSON.stringify({kind:t.kind,roomId:t.roomId,revision:t.revision,binding:t.binding}));}catch{}
        transportControls(ws,room,t);return t;
      }catch(e){
        if(e.status===404&&!owned.has(key))return null; // optional route absent: not an owned declaration
        if(owned.has(key)){const t={...owned.get(key),state:'unavailable',capabilities:{textTurn:false,attachments:false,keys:false}};owned.set(key,t);transportControls(ws,room,t);}
        throw e;
      }
    })();transportReads.set(key,read);
    try{return await read;}finally{if(transportReads.get(key)===read)transportReads.delete(key);}
  }
  window.mawContinuityTransport = {
    known:knownTransport,
    async guard(path){
      const match=path.match(/^\/rooms\/([^/]+)\/([^/]+)\/(send|screen|chat|suggestion|prompt)(?:[/?]|$)/);if(!match)return;
      const ws=decodeURIComponent(match[1]),room=decodeURIComponent(match[2]);
      const t=await readTransport(ws,room);
      if(t)throw new Error('ห้องนี้ใช้ owned protocol — ไม่ใช้ TUI endpoint');
    },
    async screen(scr,ws,room,current){
      const ticket={};scr._ownedRequest=ticket;
      const valid=()=>current()&&scr._ownedRequest===ticket;
      const t=await readTransport(ws,room);if(!valid())return true;
      if(!t){delete document.getElementById('app')?.dataset.ownedProtocol;return false;}
      scr.dataset.ownedProtocol=t.roomId;scr._chatRequest={}; // fence any earlier native chat response
      const v=view;if(selected(v))void load(v);
      const prior=scr._ownedHistory?.roomId===t.roomId?scr._ownedHistory:{roomId:t.roomId,after:0,items:[],trimmed:false};
      const h={...prior,items:[...prior.items]};let more=false;
      for(let page=0;page<10;page++){
        const result=await request(transportPath(ws,room)+`/events?after=${h.after}&limit=500`);
        if(!valid()||owned.get(transportKey(ws,room))?.roomId!==t.roomId)return true;
        if(!Array.isArray(result.items)||result.items.length>500)throw new Error('รูปแบบประวัติไม่ถูกต้อง');
        let seq=h.after;for(const e of result.items){if(!Number.isSafeInteger(e.seq)||e.seq<=seq||typeof e.text!=='string'||typeof e.role!=='string'||!['codex','claude'].includes(e.agent)||typeof e.nativeId!=='string'||typeof e.sourceId!=='string')throw new Error('ประวัติไม่ตรง contract');seq=e.seq;}
        h.items.push(...result.items);h.after=seq;
        if(h.items.length>5000){h.items=h.items.slice(-5000);h.trimmed=true;}
        more=result.items.length===500;if(!more)break;
      }
      if(!valid())return true;scr._ownedHistory=h;
      const signature=JSON.stringify([t.roomId,h.items,more]);
      if(scr._ownedSig!==signature){
        const bottom=scr.scrollTop+scr.clientHeight>=scr.scrollHeight-60,top=scr.scrollTop;
        scr.textContent='';const label=document.createElement('p');label.textContent='ประวัติที่บันทึกไว้ · ไม่ใช่จอ TUI'+(h.trimmed?' · แสดง 5000 รายการล่าสุด':'')+(more?' · กำลังอ่านหน้าถัดไปในรอบตรวจต่อไป':'');scr.appendChild(label);
        for(const e of h.items){const row=document.createElement('div'),who=document.createElement('small'),body=document.createElement('pre');row.className='msg';who.textContent=`#${e.seq} · ${e.agent} · ${e.role}`;body.style.whiteSpace='pre-wrap';body.textContent=e.text;row.append(who,body);scr.appendChild(row);}
        scr._ownedSig=signature;scr.scrollTop=bottom?scr.scrollHeight:top;
      }
      if(typeof paintPending==='function')paintPending();return true;
    }
  };
  function closeModal() { if(modal){modal.bg.remove();modal=null;} }
  function trigger(v) {
    if(!selected(v))return;
    const slot=document.getElementById('ext-room-actions');if(!slot)return;
    let b=slot.querySelector('[data-continuity-switch]');
    if(!b){b=document.createElement('button');b.className='continuity-switch-trigger';b.dataset.continuitySwitch='';b.textContent='เปลี่ยน agent / โมเดล';slot.appendChild(b);}
    b.disabled=v.busy||!v.current||!certified(v.caps,v.current?.room);
    b.title=b.disabled?'ยังไม่พร้อมสลับ — รอ capability และสถานะห้องที่ยืนยันจาก Mac':'เลือก agent และโมเดลจากข้อมูลที่ Mac รองรับ';
    b.onclick=()=>open(v.w,v.room);
  }
  function clear(v) {
    if(!selected(v))return;
    v.current=null;v.history=null;closeModal();trigger(v);
    document.querySelector('#ext-room-top .continuity-status')?.remove();
    document.querySelector('#ext-room-top .continuity-client-only')?.remove();
    if(v.intent){const node=clientNode(v);node.classList.add('continuity-client-only');document.getElementById('ext-room-top')?.appendChild(node);}
    const b=document.querySelector(`[data-xk="${keyIndex}"]`);if(b)b.hidden=true;
  }
  function busy(v,value) {
    v.busy=value;if(!selected(v))return;trigger(v);
    document.querySelectorAll('#ext-room-top .continuity-status button, #ext-room-top .continuity-client-only button').forEach(b=>b.disabled=value);
    const b=document.querySelector(`[data-xk="${keyIndex}"]`);if(b)b.disabled=value;
    if(modal?.view===v){modal.bg.querySelectorAll('button,select,input').forEach(b=>{if(!b.hasAttribute('data-continuity-close'))b.disabled=value;});if(!value)modal.update?.();}
  }
  function activate(w,room) {
    document.querySelector('#ext-room-top .continuity-client-only')?.remove();
    const previous=view;closeModal();view={w:{id:w.id},room:{id:room.id,agent:room.agent,generation:room.generation,claudeSessionId:room.claudeSessionId,transportKind:room.transportKind,logicalRoomId:room.logicalRoomId,revision:room.revision,protocolBinding:room.protocolBinding},physical:physicalStamp(w,room),serial:++serial,current:null,caps:null,loading:null,read:0,busy:false,history:previous?.w.id===w.id&&previous?.room.id===room.id?previous.history:null};
    document.querySelector('#ext-room-top .continuity-status')?.remove();
    const b=document.querySelector(`[data-xk="${keyIndex}"]`);if(b){b.hidden=true;b.disabled=false;}
    view.intent=restoreIntent(view);trigger(view);return view;
  }
  function scope(w,room) {
    if(state.ws!==w.id || state.room!==room.id)return null;
    return view?.w.id===w.id && view?.room.id===room.id && view.physical===physicalStamp(w,room) ? view : activate(w,room);
  }
  function draw(v,data) {
    if(!selected(v))return;
    const slot=document.getElementById('ext-room-top');if(!slot)return;
    let node=slot.querySelector('.continuity-status');
    if(!node){node=document.createElement('div');node.className='continuity-status';slot.appendChild(node);}
    const heldOpen=node.querySelector('.continuity-held')?.open===true;
    const op=data.operation;
    const historicalReady=op?.state==='ready-awaiting-user'&&!(op.roomId===data.room.id&&data.room.active===op.target&&data.room.revision===op.expectedRevision+1&&op.targetBinding&&switchBindingKey(data.room.bindings?.[op.target])===switchBindingKey(op.targetBinding));
    node.dataset.state=historicalReady?'historical':op?.state||'idle';
    node.textContent=historicalReady?'operation เดิมเสร็จแล้ว — binding ปัจจุบันเปลี่ยนหรือยังไม่ยืนยัน':op?(labels[op.state]||'กำลังตรวจสถานะ')+(op.reason?' · '+(reasons[op.reason]||'ต้องตรวจสถานะ agent ก่อนทำต่อ'):''):'Agent: '+data.room.active;
    const activeBinding=data.room.bindings?.[data.room.active];
    const info=document.createElement('div');info.className='continuity-current';info.textContent=`Agent: ${data.room.active} · โมเดล: ${activeBinding?.model||'—'} · route: ${activeBinding?.route||'—'}`;node.appendChild(info);
    const held=(data.held||[]).length;if(held)node.appendChild(document.createTextNode(` · ข้อความพัก ${held} รายการ`));
    if(op && data.room.operationId===op.id && ['waiting-safe-point','blocked'].includes(op.state)) {
      const action=(label,suffix)=>{
        const b=document.createElement('button');b.textContent=label;b.disabled=v.busy;
        b.onclick=()=>{if(unresolved(v))return toast('ตรวจสถานะคำขอเดิมก่อนทำต่อ');return mutate(v,data,async fresh=>{
          await request(base(v)+'/operations/'+encodeURIComponent(op.id)+'/'+suffix,suffix==='cancel'?{expectedRevision:fresh.room.revision}:{});
          if(selected(v))await load(v,true);
        });};node.appendChild(b);
      };
      if(!op.targetBinding){if(op.state==='blocked')action('ลองใหม่','retry');else action('ดำเนินการสลับต่อ','advance');action('ยกเลิกการสลับ','cancel');}
    }
    slot.querySelector('.continuity-client-only')?.remove();
    if(v.intent)node.appendChild(clientNode(v));
    const heldRows=Array.isArray(data.held)?data.held:[];
    if(heldRows.length){
      const box=document.createElement('details'),title=document.createElement('summary');
      box.className='continuity-held';box.open=heldOpen;title.textContent='ข้อความพักที่บันทึกไว้ — ยังไม่ส่งถึง agent';box.appendChild(title);
      for(const row of heldRows){
        if(typeof row.text!=='string')continue;
        const item=document.createElement('pre');item.style.whiteSpace='pre-wrap';item.textContent=row.text;box.appendChild(item);
      }
      node.appendChild(box);
    }
    if(v.history?.roomId!==data.room.id)v.history=null;
    else if(v.history&&v.history.revision!==data.room.revision)v.history={...v.history,revision:data.room.revision,loading:false,stale:true};
    const h=v.history;
    const read=document.createElement('button');read.className='continuity-history-load';
    read.textContent=h?.loading?'กำลังอ่านประวัติ':h?.ended?'อ่านประวัติใหม่':h?'อ่านประวัติเพิ่ม':'อ่านประวัติที่บันทึกไว้';
    read.disabled=!!h?.loading;read.onclick=()=>readHistory(v,data);node.appendChild(read);
    if(h){
      const box=document.createElement('div');box.className='continuity-history';
      const title=document.createElement('p');title.textContent='ประวัติที่บันทึกไว้ · อาจไม่รวมข้อความล่าสุด'+(h.stale?' · เก็บจากสถานะก่อนหน้า':'');box.appendChild(title);
      for(const item of h.items){
        const row=document.createElement('div'),label=document.createElement('small'),body=document.createElement('pre');
        label.textContent=`#${item.seq} · ${item.agent} · ${item.role} · ${item.ts||'—'}`;
        body.style.whiteSpace='pre-wrap';body.textContent=item.text;row.append(label,body);box.appendChild(row);
      }
      if(h.error||(!h.loading&&!h.items.length)){const note=document.createElement('p');note.textContent=h.error||'ไม่มีประวัติที่บันทึกไว้';box.appendChild(note);}
      node.appendChild(box);
    }
  }
  async function readHistory(v,data){
    if(!selected(v)||!v.current||v.current.room.id!==data.room.id||v.current.room.revision!==data.room.revision||v.history?.loading)return;
    if(!v.history||v.history.ended)v.history={roomId:data.room.id,revision:data.room.revision,items:[],after:0,loading:false,ended:false,error:null};
    const h=v.history;h.loading=true;h.error=null;draw(v,v.current);
    const valid=()=>selected(v)&&v.history===h&&v.current?.room.id===h.roomId&&v.current?.room.revision===h.revision;
    try{
      const result=await request(base(v)+`/events?after=${h.after}&limit=100`);if(!valid())return;
      if(!Array.isArray(result.items)||result.items.length>100)throw new Error('รูปแบบประวัติไม่ถูกต้อง');
      let cursor=h.after;
      for(const item of result.items){
        if(!Number.isSafeInteger(item.seq)||item.seq<=cursor||!['codex','claude'].includes(item.agent)||typeof item.sourceId!=='string'||typeof item.nativeId!=='string'||typeof item.role!=='string'||typeof item.text!=='string'||(item.ts!==undefined&&typeof item.ts!=='string'))throw new Error('ลำดับหรือข้อมูลประวัติไม่ถูกต้อง');
        cursor=item.seq;
      }
      if(h.items.length+result.items.length>5000)throw new Error('ถึงขีดจำกัดการแสดงประวัติรอบนี้');
      h.items.push(...result.items);h.after=cursor;h.ended=result.items.length===0;h.stale=false;
    }catch(e){if(valid())h.error=e.message||'อ่านประวัติไม่ได้';}
    finally{if(valid()){h.loading=false;draw(v,v.current);}}
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
        v.caps=caps;if(!caps.ready||!(caps.scope==='room-backend'||certified(caps))){clear(v);return null;}
        const data=await request(base(v));if(!valid())return null;
        if(data.room?.workspace!==v.w.id || data.room?.room!==v.room.id || typeof data.room.id!=='string' || !Number.isSafeInteger(data.room.revision) || data.room.revision<0 || !['codex','claude'].includes(data.room.active))throw new Error(stale);
        if(!certified(caps,data.room)){clear(v);return null;}
        if(modal?.view===v && (modal.stamp!==stamp(data) || modal.models!==JSON.stringify(models(caps)) || modal.capStamp!==capStamp(caps)))closeModal();
        v.current=data;draw(v,data);trigger(v);
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
      if(!data || !certified(v.caps,v.current?.room))throw new Error('ยังไม่พร้อมสลับ agent');
      if(stamp(data)!==stamp(snapshot))throw new Error(stale);
      await action(data);
    }catch(e){if(selected(v)){closeModal();toast(e.message);}}
    finally{busy(v,false);}
  }
  const switchBindingKey=b=>JSON.stringify([b?.agent,b?.nativeId,b?.generation,b?.model??null,b?.route??null,b?.cursor]);
  const factFields=['goal','constraints','decisions','pendingTasks','fileState','checks'];
  const factLabels={goal:'เป้าหมาย',constraints:'ข้อจำกัด',decisions:'ข้อสรุป',pendingTasks:'งานค้าง',fileState:'สถานะไฟล์',checks:'ผลตรวจ'};
  const apiReference=v=>typeof v==='string'&&v.length>=1&&v.length<=1024&&!/[\0\r\n]/.test(v);
  const apiID=v=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(v);
  const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  const token=v=>typeof v==='string'&&v.length>0;
  const intentKey=v=>'maw-continuity-switch-v1:'+JSON.stringify([v.w.id,v.room.id]);
  const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
  function restoreIntent(v){
    try{const i=JSON.parse(localStorage.getItem(intentKey(v))||'null');
      if(i?.version!==1||i.request?.ws!==v.w.id||i.request?.room!==v.room.id||!token(i.request?.switchBody?.id)||!token(i.request.logicalRoomId))return null;
      i.request=freeze(i.request);i.status='uncertain';i.message='พบคำขอเดิมในอุปกรณ์ — ตรวจสถานะก่อน ไม่ส่งซ้ำ';return i;
    }catch{return null;}
  }
  function persistIntent(v){
    try{const raw=JSON.stringify(v.intent);localStorage.setItem(intentKey(v),raw);return localStorage.getItem(intentKey(v))===raw;}catch{return false;}
  }
  function note(v,status,message){
    if(v.intent){v.intent.status=status;v.intent.message=message;persistIntent(v);}
    if(selected(v)){if(v.current)draw(v,v.current);else clear(v);trigger(v);}
  }
  const unresolved=v=>v.intent&&['dispatching','uncertain'].includes(v.intent.status);
  function operationMatches(v,op){
    const r=v.intent?.request,b=r?.switchBody;
    return !!r&&Object.hasOwn(labels,op?.state)&&op?.id===b.id&&op.roomId===r.logicalRoomId&&op.target===b.target&&op.model===b.model&&op.expectedRevision===b.expectedRevision&&switchBindingKey(op.from)===r.sourceKey;
  }
  function clientNode(v){
    const client=document.createElement('div');client.className='continuity-client-status';client.setAttribute('role','status');client.textContent=v.intent.message;
    if(unresolved(v)){const check=document.createElement('button');check.textContent='ตรวจสถานะคำขอเดิม · อ่านอย่างเดียว';check.disabled=v.busy;check.onclick=()=>inspectIntent(v);client.appendChild(check);}
    return client;
  }
  async function inspectIntent(v){
    if(!selected(v)||v.busy||!v.intent)return;
    const intent=v.intent;busy(v,true);
    try{
      const result=await request(base(v)+'/operations/'+encodeURIComponent(intent.request.switchBody.id));
      if(!selected(v)||v.intent!==intent)return;
      if(!operationMatches(v,result.operation))return note(v,'uncertain','ผลตรวจไม่ตรง operation เดิม — ไม่ส่งซ้ำหรือเลือกปลายทางแทน');
      note(v,'confirmed','พบ operation เดิมสถานะ '+result.operation.state+' · ข้อมูลย้อนหลัง ไม่ยืนยันว่า agent ปัจจุบันพร้อม');
    }catch(e){if(selected(v)&&v.intent===intent)note(v,'uncertain',(e.status===404?'ยังไม่พบ operation เดิม — ไม่ถือว่าไม่เคยเริ่ม':'อ่านสถานะคำขอเดิมไม่ได้')+' · ไม่ส่งซ้ำหรือเปลี่ยนปลายทาง');}
    finally{busy(v,false);if(selected(v)&&v.current)draw(v,v.current);}
  }
  function validPreview(p,data){
    if(!p||!apiID(p.id)||p.roomId!==data.room.id||p.roomRevision!==data.room.revision||p.selectionRequired!==true||!hash(p.sourceBindingHash)||!hash(p.archiveHash)||!Number.isSafeInteger(p.throughSeq)||p.throughSeq<0||typeof p.contextText!=='string'||!Array.isArray(p.candidates)||p.candidates.length>1024)throw new Error('รูปแบบหรือขอบเขต preview ไม่ตรงกับห้องนี้');
    const seen=new Set();
    for(const c of p.candidates){
      const key=JSON.stringify([c.field,c.seq,c.sourceId,c.agent,c.nativeId,c.eventHash]);
      if(!factFields.includes(c.field)||!Number.isSafeInteger(c.seq)||c.seq<1||c.seq>p.throughSeq||!apiReference(c.sourceId)||!['codex','claude'].includes(c.agent)||!apiReference(c.nativeId)||!hash(c.eventHash)||!(typeof c.value==='string'||Array.isArray(c.value)&&c.value.every(x=>typeof x==='string'))||c.field==='goal'&&(typeof c.value!=='string'||!c.value.trim())||seen.has(key))throw new Error('ข้อมูล facts หรือ provenance ไม่ถูกต้อง');
      seen.add(key);
    }
    return p;
  }
  const previewStamp=p=>JSON.stringify([p.roomId,p.roomRevision,p.sourceBindingHash,p.archiveHash,p.throughSeq,p.contextText,p.candidates]);
  async function open(w,room) {
    const v=scope(w,room);if(!v||v.busy)return;
    const data=await load(v,true);if(!selected(v))return;
    if(!data||!certified(v.caps,data.room))return toast('ยังไม่พร้อมสลับ agent');
    if(unresolved(v))return toast('ยังไม่ทราบผลคำขอเดิม — ตรวจสถานะก่อน ไม่สร้างคำขอใหม่');
    if(data.room.operationId)return toast('ห้องนี้มีการสลับอยู่แล้ว ตรวจสถานะก่อนทำต่อ');
    closeModal();
    const bg=document.createElement('div');bg.className='sheet-bg';
    const sheet=document.createElement('div');sheet.className='sheet';bg.appendChild(sheet);
    const frame={view:v,bg,stamp:stamp(data),models:JSON.stringify(models(v.caps)),capStamp:capStamp(v.caps),preview:null,previewRead:0};modal=frame;
    const alive=()=>selected(v)&&modal===frame&&bg.isConnected;
    const heading=document.createElement('h2');heading.textContent='เปลี่ยน agent / โมเดล';sheet.appendChild(heading);
    const noteText=document.createElement('p');noteText.textContent='รับบริบทแล้วรอคำสั่ง · กลับเจ้าเดิมใช้ session เดิม · ไม่ส่ง draft หรือข้อความพักอัตโนมัติ';sheet.appendChild(noteText);
    const catalog=models(v.caps),agents=[...new Set(catalog.map(m=>m.agent))];
    const provider=document.createElement('select');provider.dataset.continuityProvider='';provider.setAttribute('aria-label','Agent / provider');
    for(const agent of agents){const o=document.createElement('option');o.value=agent;o.textContent=agent;provider.appendChild(o);}
    provider.value=agents.find(a=>a!==data.room.active)||agents[0]||'';
    const select=document.createElement('select');select.dataset.continuityModel='';select.setAttribute('aria-label','โมเดล');
    const confirm=document.createElement('button');confirm.dataset.continuityConfirm='';
    const status=document.createElement('p');status.setAttribute('role','status');status.className='continuity-preview-status';
    const previewButton=document.createElement('button');previewButton.dataset.continuityPreview='';previewButton.textContent='ดูบริบทอ้างอิงและเลือก facts';
    const context=document.createElement('pre');context.className='continuity-preview';context.hidden=true;
    const facts=document.createElement('div');facts.className='continuity-facts';
    const picks=()=>frame.preview?frame.preview.candidates.filter((_,i)=>facts.querySelector(`[data-fact="${i}"]`)?.checked).map(c=>({field:c.field,seq:c.seq,sourceId:c.sourceId,agent:c.agent,nativeId:c.nativeId,eventHash:c.eventHash})):[];
    const choices=()=>JSON.stringify([provider.value,select.value,picks()]);
    const update=()=>{
      confirm.textContent='เปลี่ยนเป็น '+(provider.value||'—');
      const chosen=picks();previewButton.disabled=v.busy||v.caps?.factsSelectionAvailable!==true;
      confirm.disabled=v.busy||unresolved(v)||!frame.preview||!chosen.some(c=>c.field==='goal')||chosen.length>256||!catalog.some(m=>m.agent===provider.value&&m.id===select.value)||v.caps?.factsSelectionAvailable!==true;
    };
    frame.update=update;
    const fillModels=()=>{select.textContent='';for(const m of catalog.filter(m=>m.agent===provider.value)){const o=document.createElement('option');o.value=m.id;o.textContent=m.label;select.appendChild(o);}update();};
    provider.onchange=fillModels;select.onchange=update;fillModels();
    if(catalog.length)sheet.append(provider,select);else{const empty=document.createElement('p');empty.textContent='ยังไม่มีข้อมูลโมเดลที่รองรับ';sheet.appendChild(empty);}
    previewButton.disabled=v.caps.factsSelectionAvailable!==true;
    if(previewButton.disabled)status.textContent='Mac ยังไม่มีบริการ preview/facts ที่พร้อมใช้ — ยังไม่ส่งคำขอสลับ';
    previewButton.onclick=async()=>{
      if(!alive()||v.busy||v.caps?.factsSelectionAvailable!==true)return;
      const ticket=++frame.previewRead;frame.preview=null;context.hidden=true;facts.textContent='';status.textContent='กำลังอ่านบริบทจาก Mac';busy(v,true);update();
      try{
        const fresh=await load(v,true);if(!alive()||!fresh)return;
        if(stamp(fresh)!==frame.stamp||v.caps.factsSelectionAvailable!==true)throw new Error(stale);
        const result=await request(base(v)+'/facts/preview');if(!alive()||ticket!==frame.previewRead)return;
        const p=validPreview(result.preview,fresh);frame.preview=freeze(structuredClone(p));context.textContent=p.contextText;context.hidden=false;
        for(const [i,c] of p.candidates.entries()){
          const row=document.createElement('label'),check=document.createElement('input'),body=document.createElement('div'),label=document.createElement('strong'),provenance=document.createElement('small'),value=document.createElement('pre');
          check.type=c.field==='goal'?'radio':'checkbox';if(c.field==='goal')check.name='continuity-goal';check.dataset.fact=String(i);check.checked=false;check.onchange=update;
          label.textContent=factLabels[c.field];provenance.textContent=` · #${c.seq} · ${c.agent} · ${c.sourceId} · native ${c.nativeId} · hash ${c.eventHash}`;
          value.textContent=Array.isArray(c.value)?c.value.join('\n'):c.value;body.append(label,provenance,value);row.append(check,body);facts.appendChild(row);
        }
        status.textContent=p.candidates.some(c=>c.field==='goal')?'เลือกเป้าหมายและ facts ที่อนุญาตเอง · ข้อมูลอ้างอิงไม่ใช่สิทธิ์ให้รันงาน':'ไม่มีข้อมูลเป้าหมายที่เลือกได้ — หยุดก่อนสลับ';
      }catch(e){if(alive()){frame.preview=null;status.textContent='อ่าน preview ไม่ได้ · '+(e.message||'ไม่ทราบสาเหตุ')+' — ยังไม่ส่งคำขอสลับ';}}
      finally{if(alive()){busy(v,false);previewButton.disabled=v.caps?.factsSelectionAvailable!==true;update();}}
    };
    confirm.onclick=()=>{
      if(!alive()||v.busy||unresolved(v)||confirm.disabled||!frame.preview)return;
      const snapshot=frame.preview,choice=choices(),target=provider.value,model=select.value,selections=picks();
      return mutate(v,data,async fresh=>{
        const unchanged=()=>alive()&&choices()===choice&&v.caps?.factsSelectionAvailable===true&&models(v.caps).some(m=>m.agent===target&&m.id===model);
        if(!unchanged())throw new Error(stale);
        const reread=await request(base(v)+'/facts/preview');if(!unchanged())throw new Error(stale);
        if(previewStamp(validPreview(reread.preview,fresh))!==previewStamp(snapshot))throw new Error('บริบทหรือ facts เปลี่ยนแล้ว — อ่าน preview และเลือกใหม่');
        sourceBinding(fresh);if(!Number.isSafeInteger(fresh.room.bindings[fresh.room.active].cursor))throw new Error(stale);
        const id=requestId(),selectionBody={id,previewId:snapshot.id,expectedRevision:fresh.room.revision,selections},switchBody={id,target,model,expectedRevision:fresh.room.revision,factsSelectionId:id};
        v.intent={version:1,request:freeze({ws:v.w.id,room:v.room.id,physical:v.physical,logicalRoomId:fresh.room.id,sourceKey:switchBindingKey(fresh.room.bindings?.[fresh.room.active]),selectionBody,switchBody}),status:'dispatching',stage:'selection',message:'กำลังบันทึก facts ที่เลือก — ยังไม่เริ่มสลับ'};
        if(!persistIntent(v)){v.intent.status='failed';v.intent.message='บันทึกคำขอในอุปกรณ์ไม่สำเร็จ — ยังไม่ส่ง อย่าปิดหน้านี้';draw(v,fresh);throw new Error(v.intent.message);}
        draw(v,fresh);
        try{
          const saved=await request(base(v)+'/facts/selections',selectionBody);if(!unchanged())return note(v,'uncertain','เปลี่ยนห้องหรือข้อมูลระหว่างบันทึก facts — ไม่เริ่มสลับ');
          if(saved.selection?.id!==id||saved.selection.previewId!==snapshot.id||saved.selection.roomRevision!==fresh.room.revision||!hash(saved.selection.factsHash))throw new Error('receipt facts ไม่ตรง — ยังไม่เริ่มสลับ');
          v.intent.selectionReceipt=freeze(structuredClone(saved.selection));
          const latest=await load(v,true);if(!unchanged()||!latest||stamp(latest)!==frame.stamp)return note(v,'failed','ห้องหรือข้อมูลเปลี่ยนหลังบันทึก facts — ยังไม่เริ่มสลับ');
          v.intent.stage='switch';v.intent.message='กำลังส่งคำขอสลับ — รอ receipt จาก Mac';
          if(!persistIntent(v))return note(v,'failed','บันทึก intent ก่อนสลับไม่สำเร็จ — ยังไม่ส่งคำขอสลับ');
          const result=await request(base(v)+'/switch',switchBody);
          if(!operationMatches(v,result.operation))throw new Error('receipt operation ไม่ตรงคำขอเดิม');
          v.intent.status='accepted';v.intent.message='Mac รับคำขอ operation เดิมแล้ว — สถานะการสลับแสดงแยกด้านบน';persistIntent(v);
          if(!selected(v))return;
          closeModal();toast('รับคำขอสลับแล้ว');
          const next=await load(v,true);if(!selected(v)||!next||!operationMatches(v,next.operation))return;
          if(next.room.operationId!==id||next.operation.state!=='waiting-safe-point')return;
          v.intent.stage='advance';v.intent.message='กำลังดำเนิน operation เดิม — ไม่ส่ง draft หรือข้อความพัก';if(!persistIntent(v))return note(v,'uncertain','บันทึก intent ก่อนดำเนินต่อไม่สำเร็จ — พัก operation เดิม');
          const resultAdvance=await request(base(v)+'/operations/'+encodeURIComponent(id)+'/advance',{});
          if(resultAdvance.operation?.id!==id)throw new Error('ผลดำเนินการไม่ตรง operation เดิม');
          v.intent.message='Mac รับ operation เดิมแล้ว — เก็บ draft และข้อความพักไว้ ไม่ส่งอัตโนมัติ';persistIntent(v);
          if(selected(v))await load(v,true);
        }catch(e){
          v.intent.status='uncertain';v.intent.message=(v.intent.stage==='selection'?'ยังยืนยันการบันทึก facts ไม่ได้ — ยังไม่เริ่มสลับ · ':'ยังยืนยันคำขอเดิมไม่ได้ · ')+(e.message||'ไม่ทราบผล')+' — ไม่ส่งซ้ำอัตโนมัติ';persistIntent(v);
          if(selected(v)){closeModal();draw(v,v.current||fresh);}
        }
      });
    };
    const close=document.createElement('button');close.textContent='ปิด';close.dataset.continuityClose='';close.onclick=()=>closeModal();
    sheet.append(previewButton,status,context,facts,confirm,close);bg.onclick=e=>{if(e.target===bg)closeModal();};document.body.appendChild(bg);update();
  }
  // Explicit awaited queue hook; switch readiness is deliberately independent of stored-room availability.
  const bindingKey = b => JSON.stringify([b?.agent,b?.nativeId,b?.generation,b?.model ?? null,b?.route ?? null]);
  const sourceBinding = d => {
    const b=d.room?.bindings?.[d.room.active];
    if(!b || b.agent!==d.room.active || typeof b.nativeId!=='string' || !b.nativeId || typeof b.generation!=='string' || !b.generation)throw new Error('ยังยืนยัน binding สำหรับพักข้อความไม่ได้');
    return {agent:b.agent,nativeId:b.nativeId,generation:b.generation,...(b.model!==undefined?{model:b.model}:{}),...(b.route!==undefined?{route:b.route}:{})};
  };
  const heldBody = i => ({id:i.id,text:i.text,intendedGeneration:i.intendedGeneration,expectedOperationId:i.expectedOperationId,expectedRevision:i.expectedRevision});
  async function heldRequest(path,body) {
    const data=await apiRaw(path,body===undefined?{cache:'no-store'}:{method:'POST',body:JSON.stringify(body),cache:'no-store'});
    if(!data?.ok){const e=new Error('อ่านหรือบันทึกข้อความพักไม่ได้');e.body=data;throw e;}return data;
  }
  function acceptTurn(p,intent,r,persist){
    if(r?.id!==intent.body.id||r.roomId!==intent.roomId||switchBindingKey(r.binding)!==switchBindingKey(intent.body.binding)||!['live','historical'].includes(r.source)||!['completed','uncertain'].includes(r.state))throw new Error('receipt protocol ไม่ตรงคำขอเดิม');
    if(r.state==='completed'&&(!r.turn||r.turn.state!=='completed'||r.turn.operationId!==r.id||r.turn.nativeId!==intent.body.binding.nativeId||typeof r.turn.turnId!=='string'||!r.turn.turnId||typeof r.turn.text!=='string'))throw new Error('final protocol ไม่ตรงคำขอเดิม');
    p.continuityReceipt=r;p.state=r.state==='completed'?'continuity-completed':'continuity-uncertain';
    p.err=r.state==='completed'?(r.source==='live'?'protocol ตอบจบรอบแล้ว':'พบผล protocol เดิมที่จบรอบแล้ว — ไม่ใช่หลักฐานพร้อมส่งใหม่'):'ยังยืนยันผล protocol ไม่ได้ — ไม่ส่งซ้ำ';
    if(!persist())p.err+=' · เก็บผลในอุปกรณ์ไม่สำเร็จ ต้องตรวจคำขอเดิม';
    return {handled:true};
  }
  mawExt.beforeSend ||= [];
  mawExt.beforeSend.push(async({pending:p,phase,persist,unchanged})=>{
    const visit=view,ws=p.ws,room=p.room;
    const sameRoom=()=>selected(visit) && view===visit && !!visit && visit.w.id===ws && visit.room.id===room && state.ws===ws && state.room===room;
    const stop=message=>{
      p.continuityScope=true;
      p.state=p.continuityAttempted || p.requestStarted || p.state==='uncertain' ? 'continuity-uncertain' : 'continuity-local';
      p.err=message;
      if(!persist())p.err+=' · บันทึกในอุปกรณ์ไม่สำเร็จ อย่าปิดหน้านี้';
      return {handled:true};
    };
    try {
      const caps=await heldRequest('/continuity/capabilities');
      if(caps.roomStateAvailable===false && !p.continuityIntent && !p.continuityScope)return {handled:false};
      if(caps.roomStateAvailable!==true)return stop('ตรวจห้อง continuity ไม่ได้ — พักในอุปกรณ์ ยังไม่ส่ง');
      if(!sameRoom())return stop('เปลี่ยนห้องแล้ว — พักข้อความเดิม ไม่ส่งไปห้องเก่า');
      const path=`/rooms/${encodeURIComponent(ws)}/${encodeURIComponent(room)}/continuity`;
      let data;
      try {data=await heldRequest(path);}catch(e){if(e.status===404&&e.body?.code==='room_not_found'&&!p.continuityIntent&&!p.continuityScope&&sameRoom())return {handled:false};throw e;}
      if(!sameRoom())return stop('เปลี่ยนห้องแล้ว — พักข้อความเดิม ไม่ส่งไปห้องเก่า');
      const validate=d=>{
        if(d.room?.workspace!==ws || d.room?.room!==room || typeof d.room.id!=='string' || !d.room.id || !Number.isSafeInteger(d.room.revision)||d.room.revision<0)throw new Error('ข้อมูลห้องเปลี่ยนแล้ว — พักข้อความเดิม');
        return sourceBinding(d);
      };
      const binding=validate(data);p.continuityScope=true;
      // A previously attempted native delivery is never reclassified as an unsent held capture.
      if(p.requestStarted || ['uncertain','held'].includes(p.state)) {
        // Keep the native/provider identity separate from any continuity binding/generation.
        if(!p.continuityNativeAttempt)p.continuityNativeAttempt=Object.freeze({uid:p.uid,ws:p.ws,room:p.room,generation:p.generation});
        return stop('ข้อความเดิมเคยเริ่มส่งแล้ว — ตรวจ delivery เดิมก่อน ไม่สร้างข้อความพักใหม่');
      }
      if(p.continuityMissingFiles || p.files.length || (p.expectedFiles||0)>0 || p.paths?.length)return stop('ข้อความพร้อมไฟล์พักในอุปกรณ์ — ยังไม่รองรับบันทึกไฟล์พัก ไม่อัปโหลดหรือส่ง');
      // An existing owned intent is inspection-only, even if capability/transport later disappears.
      if(p.continuityTurnIntent){
        if(phase!=='reconcile')return stop('มีคำขอ protocol เดิม — ตรวจสถานะเดิม ไม่ส่งซ้ำ');
        const i=p.continuityTurnIntent;
        if(i.ws!==ws||i.room!==room||i.roomId!==data.room.id)return stop('intent protocol ไม่ตรงห้อง — ไม่เลือกปลายทางใหม่');
        try{return acceptTurn(p,i,(await heldRequest(path+'/turns/'+encodeURIComponent(i.body.id))).receipt,persist);}
        catch{return stop('ยังอ่านผลคำขอ protocol เดิมไม่ได้ — ไม่ส่งซ้ำ');}
      }
      const transport=await readTransport(ws,room);
      if(!sameRoom())return stop('เปลี่ยนห้องแล้ว — ไม่ส่งคำขอห้องเก่า');
      if(transport){
        if(phase!=='capture'||p.continuityIntent||p.continuityAttempted)return stop('รายการเดิมพักไว้ — ไม่ส่งต่ออัตโนมัติ');
        if(transport.roomId!==data.room.id||transport.revision!==data.room.revision||switchBindingKey(transport.binding)!==switchBindingKey(data.room.bindings?.[data.room.active]))return stop('binding ของ owned transport เปลี่ยนแล้ว — ไม่ส่ง');
        if(transport.state!=='idle'||transport.capabilities.textTurn!==true)return stop('owned protocol ยังไม่พร้อมรับข้อความ — พักในอุปกรณ์');
        if(!p.text||p.text.length>8000||p.text.includes('\0'))return stop('รองรับข้อความ 1–8000 ตัวอักษร — เก็บต้นฉบับไว้');
        const intent=freeze({ws,room,roomId:transport.roomId,body:{id:requestId(),text:p.text,expectedRevision:transport.revision,binding:structuredClone(transport.binding)}});
        p.continuityTurnIntent=intent;p.state='continuity-uncertain';p.err='กำลังส่ง protocol — ยังยืนยันผลไม่ได้';
        if(!persist())return stop('บันทึก intent ในอุปกรณ์ไม่สำเร็จ — ไม่ส่ง protocol');
        const latest=await heldRequest(path),t=await readTransport(ws,room);
        if(!sameRoom()||unchanged&&!unchanged()||latest.room?.id!==intent.roomId||latest.room?.revision!==intent.body.expectedRevision||switchBindingKey(latest.room?.bindings?.[latest.room?.active])!==switchBindingKey(intent.body.binding)||!t||t.roomId!==intent.roomId||t.revision!==intent.body.expectedRevision||switchBindingKey(t.binding)!==switchBindingKey(intent.body.binding)||t.state!=='idle'||t.capabilities.textTurn!==true)return stop('draft/ห้อง/binding เปลี่ยนก่อนส่ง — ไม่ส่งคำขอเดิม');
        p.continuityAttempted=true;if(!persist())return stop('บันทึก intent ไม่สำเร็จ — ไม่ส่ง protocol');
        if(!sameRoom()||unchanged&&!unchanged())return stop('draft หรือห้องเปลี่ยนแล้ว — ไม่ส่ง');
        try{return acceptTurn(p,intent,(await heldRequest(path+'/turns',intent.body)).receipt,persist);}
        catch{p.state='continuity-uncertain';p.err='ยังยืนยันผล protocol ไม่ได้ — ตรวจคำขอเดิม ไม่ส่งซ้ำ';persist();return {handled:true};}
      }
      let intent=p.continuityIntent;
      const accept=receipt=>{
        if(!intent || receipt?.version!==2 || receipt.id!==intent.id || receipt.text!==intent.text || receipt.intendedGeneration!==intent.intendedGeneration || receipt.originOperationId!==intent.expectedOperationId || receipt.originRevision!==intent.expectedRevision || bindingKey(receipt.intendedBinding)!==bindingKey(p.continuityBinding))throw new Error('receipt ข้อความพักไม่ตรง — ยังไม่ยืนยันการบันทึก');
        p.continuityReceipt=receipt;p.state='continuity-held';p.err='ข้อความพักที่ Mac — ยังไม่ส่งถึง agent';
        if(!persist())p.err+=' · เก็บสถานะในอุปกรณ์ไม่สำเร็จ ต้องตรวจด้วยคำขอเดิมเมื่อเปิดใหม่';
        return {handled:true};
      };
      if(phase==='reconcile') {
        if(!intent || intent.ws!==ws || intent.room!==room || intent.logicalRoomId!==data.room.id)return stop('intent เดิมไม่ตรงห้อง — ไม่สร้างคำขอใหม่');
        const stored=Array.isArray(data.held)?data.held.find(m=>m.id===intent.id):null;
        if(stored)return accept(stored); // Read-only reconciliation of an exact committed receipt, never delivery.
      }
      if(!data.room.operationId)return stop('ห้อง continuity ยังไม่เปิด native delivery — พักในอุปกรณ์ ไม่ส่งอัตโนมัติ');
      if(!/^[a-zA-Z0-9_.:-]{1,160}$/.test(data.room.operationId) || data.operation?.id!==data.room.operationId)throw new Error('ข้อมูล operation ไม่ตรง — พักข้อความเดิม');
      if(!p.text || p.text.length>8000 || p.text.includes('\0'))return stop('ข้อความพักต้องยาว 1–8000 ตัวอักษร — เก็บต้นฉบับไว้ในอุปกรณ์');
      if(!intent) {
        if(phase==='reconcile')return stop('ไม่มี intent เดิม — ไม่สร้างคำขอใหม่');
        p.continuityBinding=Object.freeze(binding);
        intent=Object.freeze({id:requestId(),ws,room,logicalRoomId:data.room.id,text:p.text,expectedOperationId:data.room.operationId,expectedRevision:data.room.revision,intendedGeneration:binding.generation});
        p.continuityIntent=intent;
      }
      const matches=d=>{
        const b=validate(d);
        return sameRoom() && intent.ws===ws && intent.room===room && intent.logicalRoomId===d.room.id && intent.text===p.text && intent.expectedOperationId===d.room.operationId && intent.expectedRevision===d.room.revision && intent.intendedGeneration===b.generation && bindingKey(p.continuityBinding)===bindingKey(b);
      };
      if(!matches(data))return stop('binding/generation หรือ operation เปลี่ยนแล้ว — ไม่เปลี่ยนปลายทางข้อความเดิม');
      p.state='continuity-uncertain';p.err='กำลังตรวจและบันทึกข้อความพัก — ยังไม่ส่งถึง agent';
      if(!persist())return stop('บันทึก intent ในอุปกรณ์ไม่สำเร็จ — ไม่ส่งคำขอไป Mac');
      const latest=await heldRequest(path);
      if(!matches(latest))return stop('binding/generation หรือห้องเปลี่ยนก่อนบันทึก — ไม่ส่งคำขอเดิม');
      p.continuityAttempted=true;
      if(!persist())return stop('บันทึก intent ในอุปกรณ์ไม่สำเร็จ — ไม่ส่งคำขอไป Mac');
      if(!sameRoom())return stop('เปลี่ยนห้องแล้ว — ไม่ส่งคำขอห้องเก่า');
      try {
        const result=await heldRequest(path+'/held',heldBody(intent));
        return accept(result.message);
      } catch {
        p.state='continuity-uncertain';p.err='ยังยืนยันการบันทึกไม่ได้ — ไม่ส่งซ้ำอัตโนมัติ ตรวจด้วยคำขอเดิม';persist();return {handled:true};
      }
    }catch {return stop('ตรวจสถานะ continuity ไม่ได้ — พักในอุปกรณ์ ไม่ส่ง');}
  });
  mawExt.keys.push({label:'⇄ Agent',show:()=>false,onClick:({w,room})=>open(w,room)});
  const keyIndex=mawExt.keys.length-1;
  mawExt.onRoom.push(({w,room})=>{if(state.ws===w.id&&state.room===room.id){const t=knownTransport(w.id,room.id);if(t)transportControls(w.id,room.id,t);else delete document.getElementById('app')?.dataset.ownedProtocol;const v=activate(w,room);void readTransport(w.id,room.id).catch(()=>{});load(v);}});
  mawExt.onPoll.push(({w,room})=>{const v=scope(w,room);if(v)load(v);else if(view&&!selected(view))closeModal();});
  if(Array.isArray(mawExt.onHome))mawExt.onHome.push(()=>{closeModal();view=null;});
})();
