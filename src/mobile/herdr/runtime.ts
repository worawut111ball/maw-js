import { homedir } from 'os';
import { join } from 'path';
import { InventoryStore, createCliRunner, hash, conversationRef } from './inventory';
import { HistoryResolver } from './history';
import { DeliveryLedger, withRoomLock } from './delivery';
import { HerdrError, type HerdrChannel, type RuntimeOptions, type HerdrRuntime, type DispatchRequest, type Dialog, type DialogResult } from './types';
export * from './types';
export { createCliRunner } from './inventory';
export const roomLockKey=(c:HerdrChannel)=>`herdr:local:default:${c.workspaceId}:${c.paneId}`;
export const deliveryScope=(c:HerdrChannel)=>`local/default/${c.workspaceId}/${c.paneId}/${c.terminalId}/${c.generation}`;
const KEYS:Record<string,string>={enter:'enter',up:'up',down:'down',left:'left',right:'right',tab:'tab',btab:'shift+tab',esc:'esc',ctrlc:'ctrl+c',ctrlu:'ctrl+u',bspace:'backspace',space:'space',y:'y',n:'n',...Object.fromEntries(Array.from({length:10},(_,i)=>[String(i),String(i)]))};
const ID=/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const ACTIONS=['prompt','key','literal','answer','stop','bootstrap'];
function defaultParser(raw:string):Dialog|null {
  const text=raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');
  const options=text.split('\n').flatMap(line=>{const m=line.match(/^\s*([❯>]?)\s*(\d)[.)]\s+(.+)$/);return m?[{n:+m[2],label:m[3].trim(),sel:!!m[1],free:/^type something/i.test(m[3])}]:[];});
  return options.length&&/allow|permission|approve|would you|type something|select|choose|ต้องการ|อนุญาต|question/i.test(text)?{kind:'menu',question:text.split('\n').filter(l=>!/^\s*[❯>]?\s*\d[.)]/.test(l)).slice(-12).join('\n'),options}:null;
}
function tokenFor(channel:HerdrChannel,dialog:Dialog):string {
  const normalize=(v:unknown)=>typeof v==='string'?v.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').split('\n').filter(l=>!/automatically deny|\bcountdown\b/i.test(l)).join('\n').trim():null;
  // Explicit schema: body/footer/sig/cursor/selection/free input/countdown are presentation, not question identity.
  const stable={kind:dialog.kind??'permission',agent:dialog.agent??null,title:normalize(dialog.title),question:normalize(dialog.question),
    detail:dialog.kind==='menu'?null:normalize(dialog.detail),tab:dialog.tab??null,
    tabs:Array.isArray(dialog.tabs)?dialog.tabs.map((v:any)=>typeof v==='string'?normalize(v):normalize(v.label??v.title??v.name)):[],
    options:dialog.options?.map(o=>({n:o.n,label:o.free?'[free-text]':normalize(o.label),hint:o.free?null:normalize(o.hint)}))??[]};
  return hash([channel.generation,stable]);
}
export function createHerdrRuntime(options:RuntimeOptions={}):HerdrRuntime {
  const nativeRunner=createCliRunner();
  const runner=options.runner??(async(args:string[],timeout?:number)=>{if(process.env.MAW_TEST_MODE||process.env.NODE_ENV==='test')throw new HerdrError('real_cli_disabled_in_tests',503);return nativeRunner(args,timeout);});
  const now=options.now??Date.now;
  const inventory=new InventoryStore(runner,now,options.continuityMs??15_000);
  const history=new HistoryResolver(options.history);
  const ledger=new DeliveryLedger(options.ledgerPath??((process.env.MAW_TEST_MODE||process.env.NODE_ENV==='test')?':memory:':join(homedir(),'.maw','herdr','delivery.sqlite')),now);
  let parseDialog=options.parseDialog??defaultParser, guard=options.canDispatch??(()=>true);
  const checkGuard=async(c:HerdrChannel)=>{if(!(await guard(c)))throw new HerdrError('room_closing');};
  const read=async(c:HerdrChannel,lines:number)=>{
    const n=Number(lines);if(!Number.isFinite(n)||n<1)throw new HerdrError('invalid_lines',400);
    const text=await runner(['--session','default','pane','read',c.paneId,'--source','visible','--lines',String(Math.min(1500,Math.floor(n))),'--format','text'],10_000);
    if(Buffer.byteLength(text)>4*1024*1024)throw new HerdrError('output_limit',502);return text;
  };
  const getDialog=async(c:HerdrChannel):Promise<DialogResult>=>{const raw=await read(c,240), prompt=parseDialog(raw);return {ok:true,prompt,generation:c.generation,...(prompt?{dialogToken:tokenFor(c,prompt)}:{})};};
  const runtime:HerdrRuntime={
    async refresh(){await inventory.refresh();},
    async listProjects(){await inventory.refresh();return inventory.projects();},
    resolve(ws,room){return inventory.resolve(ws,room);},
    async screen(channel,lines=150){const c=await inventory.current(channel);const text=await read(c,lines);await inventory.current(c);return text;},
    async history(channel,query={}){const c=await inventory.current(channel);const result=await history.read(c.conversation,query);await inventory.current(c);return result;},
    async dialog(channel){const c=await inventory.current(channel);const result=await getDialog(c);await inventory.current(c);return result;},
    deliveryStatus(id,channel){if(!ID.test(id))throw new HerdrError('invalid_request_id',400);return ledger.status(id,channel?deliveryScope(channel):undefined);},
    resolveDelivery(id,channel){if(!ID.test(id))throw new HerdrError('invalid_request_id',400);return ledger.resolve(id,deliveryScope(channel));},
    async dispatch(channel,request){
      if(!request||!ID.test(request.id)||!ACTIONS.includes(request.action)||typeof request.expectedGeneration!=='string'||!request.expectedGeneration)throw new HerdrError('invalid_dispatch',400);
      if(request.text!==undefined&&(typeof request.text!=='string'||request.text.includes('\0')||Buffer.byteLength(request.text)>32_000))throw new HerdrError('invalid_text',400);
      if(request.resolveParent!==undefined&&typeof request.resolveParent!=='boolean')throw new HerdrError('invalid_resolution',400);
      if(request.resolveParent&&(!request.parentId||request.offline))throw new HerdrError('explicit_resolution_required');
      if(request.parentId!==undefined&&!ID.test(request.parentId))throw new HerdrError('invalid_parent_id',400);
      // Fingerprint includes explicit action/target/generation and exact text (attachments are part of exact text).
      const payload=Object.fromEntries(Object.entries(request).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)));
      return withRoomLock(roomLockKey(channel),async()=>{
        const scope=deliveryScope(channel);
        const old=ledger.status(request.id,channel?scope:undefined);
        if(old.state!=='unknown')return ledger.claim(request.id,scope,payload,channel.generation).result;
        const parent=request.parentId?ledger.parent(request.parentId):null;
        if(request.parentId&&!parent&&(request.offline||request.resolveParent))throw new HerdrError('parent_not_found');
        if(request.parentId===request.id)throw new HerdrError('invalid_parent_id',400);
        if(request.resolveParent&&(parent?.scope!==scope||parent.state!=='uncertain'))throw new HerdrError('parent_scope_mismatch');
        if(request.offline&&ledger.hasUncertain(scope))throw new HerdrError('queue_delivery_uncertain');
        const claim=ledger.claim(request.id,scope,payload,channel.generation);if(!claim.claimed)return claim.result;
        let mutated=false;
        try{
          if(channel.generation!==request.expectedGeneration)throw new HerdrError('room_changed');
          let c=await inventory.current(channel);await checkGuard(c);await options.beforeDispatch?.(c);
          if(!c.capabilities.keys)throw new HerdrError('agent_foreground_unverified');
          if(request.offline){
            if(!Number.isFinite(request.createdAt)||now()-request.createdAt!>30*60_000||request.createdAt!>now()+5000)throw new HerdrError('offline_message_stale');
            if(!request.continuityToken||!c.continuityToken||c.continuityToken!==request.continuityToken)throw new HerdrError('agent_continuity_unverified');
          }
          const initial=await getDialog(c);
          const validateDialog=(d:DialogResult)=>{if(!d.prompt||!request.expectedDialogToken||d.dialogToken!==request.expectedDialogToken)throw new HerdrError('dialog_changed');};
          const mutate=async(args:string[],requireDialog=false)=>{
            c=await inventory.current(c);await checkGuard(c);if(!c.capabilities.keys)throw new HerdrError('agent_foreground_unverified');
            if(requireDialog){const latest=await getDialog(c);validateDialog(latest);
              if(args[0]==='pane'&&args[1]==='send-text'||request.action==='answer'&&request.text!==undefined&&args[0]==='agent'&&args[1]==='send-keys'&&['ctrl+u','enter'].includes(args[3])){
                const freeN=request.n??initial.prompt?.options?.find(o=>o.free&&o.sel)?.n;
                if(!latest.prompt?.options?.some(o=>o.n===freeN&&o.free&&o.sel))throw new HerdrError('free_text_not_selected');
              }
            }
            if(request.action==='key'){const latest=await getDialog(c);if(latest.prompt||request.expectedDialogToken)validateDialog(latest);if(request.key==='ctrlc'&&!c.capabilities.stop&&!latest.prompt)throw new HerdrError('stop_unsupported');}
            if(args[0]==='agent'&&args[1]==='prompt'&&(!c.capabilities.prompt||(await getDialog(c)).prompt))throw new HerdrError('agent_blocked');
            if(request.action==='stop'&&(!c.capabilities.stop||(await getDialog(c)).prompt))throw new HerdrError('stop_unsupported');
            mutated=true;const raw=await runner(['--session','default',...args],10_000);
            let ack:any;try{ack=JSON.parse(raw);}catch{throw new HerdrError('invalid_acknowledgement',502);}
            if(!ack||typeof ack.id!=='string'||!ack.id||'error' in ack||!ack.result)throw new HerdrError('invalid_acknowledgement',502);
            if(args[0]==='agent'&&args[1]==='prompt'){
              const a=ack.result.agent;
              if(ack.result.type!=='agent_prompted'||!a||a.pane_id!==c.paneId||a.workspace_id!==c.workspaceId||a.terminal_id!==c.terminalId||a.agent!==c.agent||(c.conversation&&a.agent_session&&hash(conversationRef(a.agent_session))!==hash(c.conversation)))throw new HerdrError('ack_target_mismatch',502);
            }else if(ack.result.type!=='ok')throw new HerdrError('invalid_acknowledgement',502);
            // Protocol22 keys/text ACK is bare ok (no target); revalidate the observed binding after it.
            await inventory.current(c);
          };
          const key=async(k:string,dialog=false)=>{if(!KEYS[k])throw new HerdrError('unsupported_key',400);await mutate(['agent','send-keys',c.paneId,KEYS[k]],dialog);};
          const awaitDialog=async(predicate:(dialog:Dialog)=>boolean)=>{
            for(let attempt=0;attempt<6;attempt++){
              const latest=await getDialog(c);validateDialog(latest);if(predicate(latest.prompt!))return latest;
              if(attempt<5)await new Promise(resolve=>setTimeout(resolve,50));
            }
            throw new HerdrError('dialog_selection_not_ready');
          };
          const leaveFree=async()=>{const latest=await getDialog(c);validateDialog(latest);if(latest.prompt?.options?.some(o=>o.free&&o.sel)){await key('up',true);await awaitDialog(d=>!d.options?.some(o=>o.free&&o.sel));}};
          switch(request.action){
            case 'prompt':case 'bootstrap':
              if(!request.text?.trim())throw new HerdrError('text_required',400);
              if(!c.capabilities.prompt||initial.prompt)throw new HerdrError('agent_blocked');
              // Herdr protocol22 CLI consumes TEXT positionally and does not accept a '--' separator.
              // argv spawning keeps text a single argument without shell interpretation.
              await mutate(['agent','prompt',c.paneId,request.text]);break;
            case 'stop':
              if(!c.capabilities.stop||initial.prompt)throw new HerdrError('stop_unsupported');
              await key('ctrlc');break;
            case 'key':
              if(!request.key||!KEYS[request.key])throw new HerdrError('unsupported_key',400);
              if(initial.prompt||request.expectedDialogToken)validateDialog(initial);
              if(c.capabilities.answer&&!initial.prompt)throw new HerdrError('dialog_unreadable');
              if(initial.prompt&&/^\d$/.test(request.key))await leaveFree();
              await key(request.key,!!initial.prompt);break;
            case 'literal':
              validateDialog(initial);if(request.text===undefined)throw new HerdrError('text_required',400);
              if(!initial.prompt!.options?.some(o=>o.free&&o.sel))throw new HerdrError('free_text_not_selected');
              await mutate(['pane','send-text',c.paneId,request.text],true);break;
            case 'answer':{
              validateDialog(initial);const option=initial.prompt!.options?.find(o=>o.n===request.n);if(!option)throw new HerdrError('answer_not_available');
              if(request.text!==undefined){
                if(!option.free)throw new HerdrError('free_text_not_available');
                if(!option.sel){await leaveFree();await key(String(option.n),true);await awaitDialog(d=>!!d.options?.some(o=>o.n===request.n&&o.free&&o.sel));}
                let refreshed=await getDialog(c);validateDialog(refreshed);const selected=refreshed.prompt!.options?.find(o=>o.n===request.n);if(!selected?.sel||!selected.free)throw new HerdrError('free_text_not_selected');
                if(!/^type something\.?$/i.test(selected.label))await key('ctrlu',true);
                await mutate(['pane','send-text',c.paneId,request.text],true);
                // Re-read and require the same question/tab/options before submitting typed text.
                refreshed=await getDialog(c);validateDialog(refreshed);await key('enter',true);
              }else{await leaveFree();await key(String(option.n),true);}
              break;
            }
          }
          try{const result=ledger.complete(request.id,'acknowledged');if(request.resolveParent&&request.parentId)ledger.resolve(request.parentId,scope,request.id);return result;}
          catch{return {id:request.id,state:'uncertain',ok:false,code:'ack_persist_failed',generation:channel.generation};}
        }catch(e){
          const code=e instanceof HerdrError?e.code:'herdr_failed';
          if(!mutated)return ledger.complete(request.id,'definitely-rejected',code);
          try{return ledger.complete(request.id,'uncertain',code);}
          catch{return {id:request.id,state:'uncertain',ok:false,code:'delivery_store_unavailable',generation:channel.generation};}
        }
      });
    },
    setDialogParser(parser){parseDialog=parser;},setDispatchGuard(callback){guard=callback;},close(){ledger.close();},
  };
  return runtime;
}
export const herdrRuntime=createHerdrRuntime();
export const setDialogParser=(parser:(text:string)=>Dialog|null)=>herdrRuntime.setDialogParser(parser);
