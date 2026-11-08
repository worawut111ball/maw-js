import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { HerdrError, type Runner, type HerdrChannel, type ConversationRef, type HerdrProject } from './types';
export const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const validId = (value:unknown):value is string => typeof value==='string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
const obj = (v:any) => v && typeof v==='object' && !Array.isArray(v);
export interface Snapshot { workspaces:any[];tabs:any[];panes:any[];agents:any[];version:string;protocol:number }
export function parseSnapshot(raw:string):Snapshot {
  if(Buffer.byteLength(raw)>4*1024*1024)throw new HerdrError('output_limit',502);
  let value:any; try { value=JSON.parse(raw); } catch { throw new HerdrError('invalid_inventory',502); }
  const s=value?.result?.snapshot;
  if (!obj(value)||typeof value.id!=='string'||value.error||value.result?.type!=='session_snapshot'||!obj(s)||s.protocol!==22||typeof s.version!=='string') throw new HerdrError('invalid_inventory',502);
  for(const k of ['workspaces','tabs','panes','agents','layouts']) if(!Array.isArray(s[k])) throw new HerdrError('invalid_inventory',502);
  for(const [k,field] of [['workspaces','workspace_id'],['tabs','tab_id'],['panes','pane_id'],['agents','pane_id']]) {
    const entries=s[k]; if(entries.some((v:any)=>!obj(v)||!validId(v[field]))||new Set(entries.map((v:any)=>v[field])).size!==entries.length) throw new HerdrError('invalid_inventory',502);
  }
  const w=new Set(s.workspaces.map((v:any)=>v.workspace_id)), tabs=new Map(s.tabs.map((v:any)=>[v.tab_id,v.workspace_id]));
  if(s.workspaces.some((v:any)=>typeof v.label!=='string'||!Number.isInteger(v.number)||!Number.isInteger(v.pane_count)||!Number.isInteger(v.tab_count)||!validId(v.active_tab_id)||typeof v.focused!=='boolean'||!['idle','working','blocked','done','unknown'].includes(v.agent_status))||s.tabs.some((v:any)=>!w.has(v.workspace_id)||typeof v.label!=='string'||!Number.isInteger(v.number)||!Number.isInteger(v.pane_count)||typeof v.focused!=='boolean')) throw new HerdrError('invalid_inventory',502);
  for(const p of s.panes) if(!w.has(p.workspace_id)||tabs.get(p.tab_id)!==p.workspace_id||!validId(p.terminal_id)||typeof p.focused!=='boolean'||!Number.isSafeInteger(p.revision)||p.revision<0||!['unknown','idle','working','blocked','done'].includes(p.agent_status)) throw new HerdrError('invalid_inventory',502);
  for(const a of s.agents) if(typeof a.focused!=='boolean'||!Number.isSafeInteger(a.revision)||a.revision<0||!['unknown','idle','working','blocked','done'].includes(a.agent_status)||(a.agent!=null&&typeof a.agent!=='string')||(a.name!=null&&typeof a.name!=='string')||(a.launch_pending!==undefined&&typeof a.launch_pending!=='boolean')||!s.panes.some((p:any)=>p.pane_id===a.pane_id&&p.terminal_id===a.terminal_id&&p.workspace_id===a.workspace_id&&p.tab_id===a.tab_id)) throw new HerdrError('invalid_inventory',502);
  return s;
}
/** argv only, bounded bytes/time/queue. No process is spawned until invoked. */
export function createCliRunner(options:{binary?:string;maxBytes?:number;maxConcurrent?:number;maxQueue?:number}={}):Runner {
  const binary=options.binary??'herdr', maxBytes=options.maxBytes??4*1024*1024, concurrency=options.maxConcurrent??4, maxQueue=options.maxQueue??32;
  let active=0; const queue:(()=>void)[]=[];
  return async(args,timeoutMs=10_000)=>{
    if(active>=concurrency){ if(queue.length>=maxQueue)throw new HerdrError('runner_busy',503); await new Promise<void>(r=>queue.push(r)); } else active++;
    try { return await new Promise<string>((resolve,reject)=>{
      let out:Buffer[]=[], size=0, settled=false;
      const child=spawn(binary,args,{stdio:['ignore','pipe','pipe'],env:{...process.env,PATH:['/opt/homebrew/bin','/usr/local/bin',process.env.PATH??''].join(':')}});
      const done=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(Buffer.concat(out).toString('utf8'));};
      const timer=setTimeout(()=>{child.kill('SIGKILL');done(new HerdrError('herdr_timeout',504));},Math.max(1,Math.min(timeoutMs,120_000)));
      child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>maxBytes){child.kill('SIGKILL');done(new HerdrError('output_limit',502));}else out.push(b);});
      child.stderr.on('data',(b:Buffer)=>{size+=b.length;if(size>maxBytes){child.kill('SIGKILL');done(new HerdrError('output_limit',502));}});
      child.on('error',()=>done(new HerdrError('herdr_unavailable',503)));
      child.on('close',code=>done(code===0?undefined:new HerdrError('herdr_failed',502)));
    }); }finally{const next=queue.shift();if(next)next();else active--;}
  };
}
export function conversationRef(value:any):ConversationRef|null {
  return obj(value)&&['claude','codex'].includes(value.agent)&&['id','path'].includes(value.kind)&&typeof value.value==='string'&&value.value.length<=4096&&typeof value.source==='string'
    ?{agent:value.agent,kind:value.kind,value:value.value,source:value.source}:null;
}
/** One verified agent PID; foreground helpers do not change agent identity. */
export function foregroundAgent(info:any, agent:string|null):any|null {
  if(!['codex','claude'].includes(agent??'') || !Number.isSafeInteger(info?.shell_pid) || info.shell_pid<=0 || !Number.isSafeInteger(info?.foreground_process_group_id) || info.foreground_process_group_id<=0 || !Array.isArray(info.foreground_processes)) return null;
  const names=agent==='claude'?['claude','claude-code','claude.exe']:['codex'];
  const matches=info.foreground_processes.filter((p:any)=>Number.isSafeInteger(p.pid)&&p.pid>0&&p.pid!==info.shell_pid&&typeof p.name==='string'&&names.includes(p.name.split('/').pop()));
  return matches.length===1?matches[0]:null;
}
export const foregroundFingerprint=(info:any, agent:any)=>hash([info.shell_pid,info.foreground_process_group_id,agent.pid,agent.name]);
export class InventoryStore {
  snapshot:Snapshot|null=null; observedAt=0; available=false;
  private channels=new Map<string,HerdrChannel>(); private processes=new Map<string,string>(); private flight:Promise<void>|null=null;
  constructor(public runner:Runner,private now=Date.now,private continuityMs=15_000){}
  refresh():Promise<void>{ if(this.flight)return this.flight; this.flight=this.read().finally(()=>this.flight=null);return this.flight; }
  private async read(){
    try{
      const raw=await this.runner(['--session','default','api','snapshot'],10_000), snapshot=parseSnapshot(raw);
      const gap=!this.available||this.now()-this.observedAt>this.continuityMs;
      const next=new Map<string,HerdrChannel>(), processes=new Map<string,string>();
      // Bounded workers even for injected transports; no unbounded process-info fan-out.
      let i=0; const evidence=new Map<string,string>();
      await Promise.all(Array.from({length:Math.min(4,snapshot.panes.length)},async()=>{while(i<snapshot.panes.length){const p=snapshot.panes[i++];if(!(snapshot.agents.find((a:any)=>a.pane_id===p.pane_id)?.agent??p.agent))continue;try{
        const v=JSON.parse(await this.runner(['--session','default','pane','process-info','--pane',p.pane_id],5000));const info=v.result?.process_info;
        if(v.error||v.result?.type!=='pane_process_info'||info?.pane_id!==p.pane_id||!Number.isInteger(info.shell_pid)||info.shell_pid<=0||!Number.isInteger(info.foreground_process_group_id)||info.foreground_process_group_id<=0||!Array.isArray(info.foreground_processes))continue;
        const detected=snapshot.agents.find((a:any)=>a.pane_id===p.pane_id)?.agent??p.agent;
        const agent=foregroundAgent(info,detected);
        if(!agent)continue;
        evidence.set(p.pane_id,foregroundFingerprint(info,agent));
      }catch{/* unverifiable instance remains manual-only */}}}));
      for(const p of snapshot.panes){
        const a=snapshot.agents.find((a:any)=>a.pane_id===p.pane_id), conversation=conversationRef(a?.agent_session??p.agent_session);
        const agent=typeof (a?.agent??p.agent)==='string'?(a?.agent??p.agent):null;
        if(conversation&&conversation.agent!==agent)throw new HerdrError('native_provider_mismatch',502);
        const paneRef=conversationRef(p.agent_session),agentRef=conversationRef(a?.agent_session);
        if(paneRef&&agentRef&&hash(paneRef)!==hash(agentRef))throw new HerdrError('native_binding_conflict',502);
        const fingerprint=hash([p.workspace_id,p.pane_id,p.terminal_id,agent,conversation,evidence.get(p.pane_id)??null]);
        const prev=this.channels.get(p.pane_id), same=!gap&&this.processes.get(p.pane_id)===fingerprint;
        const generation=same?prev!.generation:randomUUID();
        const ready=evidence.has(p.pane_id)&&['claude','codex'].includes(agent??'')&&['idle','working','done','blocked'].includes(p.agent_status)&&!p.restore_error&&(!a?.launch_pending||p.agent_status==='blocked');
        const capable={history:!!conversation,screen:true,prompt:ready&&p.agent_status!=='blocked',keys:ready,answer:ready&&p.agent_status==='blocked',stop:ready&&p.agent_status==='working',close:false,create:false};
        const ch:HerdrChannel={kind:'herdr',endpointId:'local',session:'default',workspaceId:p.workspace_id,paneId:p.pane_id,terminalId:p.terminal_id,label:a?.name||p.terminal_title_stripped||p.pane_id,agent,generation,conversation,continuityToken:evidence.has(p.pane_id)?generation:null,capabilities:capable};
        next.set(p.pane_id,ch);processes.set(p.pane_id,fingerprint);
      }
      this.snapshot=snapshot;this.channels=next;this.processes=processes;this.observedAt=this.now();this.available=true;
    }catch(e){this.available=false;throw e;}
  }
  resolve(ws:string,room:string):HerdrChannel|null {if(!this.available||this.now()-this.observedAt>this.continuityMs)return null;const c=this.channels.get(room);return c&&ws===`herdr:${c.workspaceId}`?structuredClone(c):null;}
  async current(channel:HerdrChannel):Promise<HerdrChannel>{await this.refresh();const c=this.resolve(`herdr:${channel.workspaceId}`,channel.paneId);if(!c||c.terminalId!==channel.terminalId||c.generation!==channel.generation)throw new HerdrError('room_changed');return c;}
  projects():HerdrProject[]{if(!this.available||!this.snapshot)return [];return [{name:'Herdr · default',source:'herdr',workspaces:this.snapshot.workspaces.map(w=>({id:`herdr:${w.workspace_id}`,name:w.label,branch:null,rooms:this.snapshot!.panes.filter(p=>p.workspace_id===w.workspace_id).map(p=>{const c=this.channels.get(p.pane_id)!;return {id:p.pane_id,title:c.label,agent:c.agent,status:p.agent_status==='blocked'?'waiting':p.agent_status,claudeSessionId:null,generation:c.generation,capabilities:{...c.capabilities},continuityToken:c.continuityToken};})}))}];}
}
