/** Read-only transport observations. No default runner, mutations, native history reads or readiness certification. */
import { isAbsolute, normalize } from 'node:path';
import type { Backend } from './types';
import { NATIVE_UUID } from './launcher';
export interface ObservationTarget { backend: Backend; workspace: string; pane: string; terminal?: string; cwd?: string }
export interface ReadCommand { executable: 'herdr'|'tmux'|'superset'|'/bin/ps'; args: string[] }
export interface ObservedProcess { pid: number; name: string; cwd: string|null }
export interface TransportObservation {
  backend: Backend; workspace: string; pane: string; terminal: string|null; cwd: string|null; observedAt: number;
  /** tmux pane_pid is the first process, never a claim that this is the native agent PID. */
  paneFirstPid: number|null; shellPid: number|null; foregroundGroup: number|null; tty: string|null;
  processes: ObservedProcess[];
  /** Herdr metadata is reported identity, not parsed native-file/ownership proof. */
  reportedNativeSession: {agent:'claude'|'codex'; nativeId:string; source:string}|null;
  reportedStatus: string|null;
  inputEmpty: null; writerExclusive: null; processBirthVerified: false; productionReady: false; gaps: string[];
}
export class ObservationError extends Error { constructor(public code:string){super(code);this.name='ObservationError';} }
function fail(code:string):never{throw new ObservationError(code);}
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>0;
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\0\r\n\t]/.test(v);
function absolute(v:unknown):v is string{return text(v)&&isAbsolute(v)&&normalize(v)===v;}
function target(t:ObservationTarget):void{
  if(!t||!['herdr','tmux','superset'].includes(t.backend)||!text(t.workspace)||!text(t.pane))fail('observation_target_invalid');
  if(t.cwd!==undefined&&!absolute(t.cwd))fail('observation_target_invalid');
  if(t.backend==='herdr'&&(!/^w[A-Za-z0-9]+$/.test(t.workspace)||!new RegExp('^'+t.workspace+':p[A-Za-z0-9]+$').test(t.pane)||!text(t.terminal)))fail('observation_target_invalid');
  if(t.backend==='tmux'&&(!/^%\d+$/.test(t.pane)||!text(t.workspace)))fail('observation_target_invalid');
  if(t.backend==='superset'&&(!NATIVE_UUID.test(t.workspace)||!NATIVE_UUID.test(t.pane)))fail('observation_target_invalid');
}
/** Version-independent field names verified against local tmux 3.6a man page; delimiter collisions fail closed. */
export const TMUX_OBSERVATION_FORMAT='#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_dead}\t#{pane_input_off}';
export function buildObservationCommands(t:ObservationTarget):ReadCommand[]{
  target(t);
  if(t.backend==='herdr')return [
    {executable:'herdr',args:['--session','default','pane','get',t.pane]},
    {executable:'herdr',args:['--session','default','pane','process-info','--pane',t.pane]},
    {executable:'herdr',args:['--session','default','agent','list']},
  ];
  if(t.backend==='tmux')return [{executable:'tmux',args:['display-message','-p','-t',t.pane,TMUX_OBSERVATION_FORMAT]}];
  return [{executable:'superset',args:['agents','explain','--local','--workspace',t.workspace,'--terminal',t.pane,'--json']}];
}
function json(raw:string):any{
  if(typeof raw!=='string'||Buffer.byteLength(raw)>4*1024*1024)fail('observation_response_invalid');
  let value;try{value=JSON.parse(raw);}catch{return fail('observation_response_invalid');}
  if(!value||typeof value!=='object'||Array.isArray(value))fail('observation_response_invalid');return value;
}
function herdr(raw:string,type:string):any{
  const value=json(raw);if(value.error||typeof value.id!=='string'||value.result?.type!==type)fail('observation_response_invalid');return value.result;
}
function base(t:ObservationTarget,at:number):TransportObservation{
  target(t);if(!Number.isFinite(at)||at<0)fail('observation_time_invalid');
  return {backend:t.backend,workspace:t.workspace,pane:t.pane,terminal:null,cwd:null,observedAt:at,paneFirstPid:null,shellPid:null,foregroundGroup:null,tty:null,processes:[],reportedNativeSession:null,reportedStatus:null,inputEmpty:null,writerExclusive:null,processBirthVerified:false,productionReady:false,gaps:['input_buffer_unverified','writer_fence_unverified','process_birth_unverified','native_file_unverified','runtime_policy_unverified','observation_not_atomic']};
}
export function parseHerdrObservation(t:ObservationTarget,raw:{pane:string;process:string;agents:string},at:number):TransportObservation{
  const out=base(t,at);if(t.backend!=='herdr')fail('observation_backend_mismatch');
  const p=herdr(raw.pane,'pane_info').pane,info=herdr(raw.process,'pane_process_info').process_info,agents=herdr(raw.agents,'agent_list').agents;
  if(p?.pane_id!==t.pane||p.workspace_id!==t.workspace||p.terminal_id!==t.terminal||!absolute(p.foreground_cwd??p.cwd)||info?.pane_id!==t.pane||!positive(info.shell_pid)||!positive(info.foreground_process_group_id)||!Array.isArray(info.foreground_processes)||!Array.isArray(agents))fail('observation_binding_changed');
  out.cwd=p.foreground_cwd??p.cwd;if(t.cwd!==undefined&&out.cwd!==t.cwd)fail('observation_binding_changed');
  out.terminal=p.terminal_id;out.shellPid=info.shell_pid;out.foregroundGroup=info.foreground_process_group_id;
  out.processes=info.foreground_processes.map((v:any)=>{
    if(!positive(v?.pid)||!text(v.name)||(v.cwd!=null&&!absolute(v.cwd)))fail('observation_process_invalid');
    return {pid:v.pid,name:v.name,cwd:v.cwd??null};
  });
  if(new Set(out.processes.map(p=>p.pid)).size!==out.processes.length)fail('observation_process_invalid');
  const matching=agents.filter((a:any)=>a?.pane_id===t.pane);if(matching.length>1)fail('observation_agent_ambiguous');
  const a=matching[0];
  if(a){
    if(a.terminal_id!==t.terminal||a.workspace_id!==t.workspace)fail('observation_binding_changed');
    out.reportedStatus=['idle','done','working','blocked','unknown'].includes(a.agent_status)?a.agent_status:null;
    const ref=a.agent_session;
    if(ref!=null){
      if(!['claude','codex'].includes(a.agent)||ref.agent!==a.agent||ref.kind!=='id'||ref.source!=='herdr:'+a.agent||typeof ref.value!=='string'||!NATIVE_UUID.test(ref.value))fail('observation_native_ref_invalid');
      out.reportedNativeSession={agent:a.agent,nativeId:ref.value,source:ref.source};
    }
    const paneRef=p.agent_session;
    if(paneRef!=null&&(!ref||['agent','kind','source','value'].some(k=>paneRef[k]!==ref[k])))fail('observation_native_ref_conflict');
  }
  return out;
}
export function parseTmuxObservation(t:ObservationTarget,raw:string,at:number):TransportObservation{
  const out=base(t,at);if(t.backend!=='tmux')fail('observation_backend_mismatch');
  if(typeof raw!=='string'||Buffer.byteLength(raw)>16384)fail('observation_response_invalid');
  const fields=raw.replace(/\r?\n$/,'').split('\t');
  if(fields.length!==7||fields[0]!==t.pane||!/^\d+$/.test(fields[1])||!positive(Number(fields[1]))||!/^\/dev\/[A-Za-z0-9/_-]+$/.test(fields[2])||!absolute(fields[3])||!text(fields[4])||!['0','1'].includes(fields[5])||!['0','1'].includes(fields[6]))fail('observation_response_invalid');
  if(t.cwd!==undefined&&fields[3]!==t.cwd)fail('observation_binding_changed');
  out.paneFirstPid=Number(fields[1]);out.tty=fields[2];out.cwd=fields[3];
  // pane_current_command is a display hint; pane_input_off is a routing flag, not an empty editor buffer.
  out.gaps.push('native_process_unverified','tmux_server_identity_unverified');
  if(fields[5]==='1')out.gaps.push('pane_dead');if(fields[6]==='1')out.gaps.push('pane_input_disabled');
  return out;
}
/** Superset CLI help confirms the endpoint, but not a stable runtime/process/native-ID schema. */
export function parseSupersetObservation(t:ObservationTarget,raw:string,at:number):TransportObservation{
  const out=base(t,at);if(t.backend!=='superset')fail('observation_backend_mismatch');
  const value=json(raw);if(value.error)fail('observation_response_invalid');out.gaps.push('superset_explain_schema_unverified','native_process_unverified');return out;
}
export type ObservationRunner=(command:ReadCommand)=>Promise<string>;
/** Runs read commands only through an explicitly supplied port. No default execution/fallback. */
export async function observeTransport(t:ObservationTarget,runner:ObservationRunner,now:()=>number=Date.now):Promise<TransportObservation>{
  const scope=structuredClone(t),commands=buildObservationCommands(scope);
  const raw:string[]=[];for(const command of commands)raw.push(await runner(structuredClone(command)));
  const at=now();
  if(scope.backend==='herdr')return parseHerdrObservation(scope,{pane:raw[0],process:raw[1],agents:raw[2]},at);
  return scope.backend==='tmux'?parseTmuxObservation(scope,raw[0],at):parseSupersetObservation(scope,raw[0],at);
}
export interface MacProcessHint {pid:number;ppid:number;group:number;foregroundGroup:number|null;tty:string;startedLocal:string;command:string;birthPrecision:'seconds';ownershipVerified:false}
/** Local macOS ps only. Never request full argv/environment, which can expose credentials. */
export function buildMacProcessCommand(pid:number):ReadCommand{
  if(!positive(pid))fail('observation_pid_invalid');return {executable:'/bin/ps',args:['-p',String(pid),'-o','pid=,ppid=,pgid=,tpgid=,tty=,lstart=,comm=']};
}
export function parseMacProcessHint(raw:string,expectedPid:number):MacProcessHint{
  buildMacProcessCommand(expectedPid);
  if(typeof raw!=='string'||Buffer.byteLength(raw)>16384)fail('observation_process_invalid');
  const m=raw.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([^\r\n]+)$/);
  if(!m||Number(m[1])!==expectedPid||!positive(Number(m[3]))||!Number.isSafeInteger(Number(m[2]))||Number(m[2])<0||!(positive(Number(m[4]))||m[4]==='-1')||!text(m[7]))fail('observation_process_invalid');
  return {pid:expectedPid,ppid:Number(m[2]),group:Number(m[3]),foregroundGroup:m[4]==='-1'?null:Number(m[4]),tty:m[5],startedLocal:m[6].replace(/\s+/g,' '),command:m[7],birthPrecision:'seconds',ownershipVerified:false};
}
/** A difference disproves continuity; matching second-resolution hints cannot prove it. */
export function compareMacProcessHints(a:MacProcessHint,b:MacProcessHint):'changed'|'unproven'{
  return ['pid','ppid','group','foregroundGroup','tty','startedLocal','command'].some(k=>a[k as keyof MacProcessHint]!==b[k as keyof MacProcessHint])?'changed':'unproven';
}
