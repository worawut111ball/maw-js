/** Explicit single-pane pilot. Never certifies production, mounts routes, or starts work at import. */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { preparedCommand, type PreparedPolicy, type EntryContract } from '../launch/prepared-entry';
import { quoteShellArg, NATIVE_UUID } from './launcher';
import { EffectJournal } from './effect-journal';
import type { NativeRecords } from './native-records';
import { NativeRecordsError } from './native-records';
import type { Runner } from '../herdr/types';
import { foregroundAgent } from '../herdr/inventory';

export interface PilotScope { workspace: string; pane: string; terminal: string; cwd: string; shellPid: number }
export interface PilotStart { operationId: string; agent: 'claude'|'codex'; nativeId: string; name: string; model?: string }
export interface PilotObservation { pane: any; agent: any | null; process: any; native: any | null }
export interface PilotOptions {
  scope: PilotScope; policy: PreparedPolicy; contract: EntryContract; route: 'mind'|'direct';
  nodeExecutable: string; installedHosts: { codex: string; claude: string }; nativeExecutables: { codex: string; claude: string }; artifactRoot: string; journal: EffectJournal; runner: Runner;
  /** External writer/autostart fence + empty input proof. Missing/false means no mutation. */
  assertExclusive: (scope: PilotScope, operationId: string) => Promise<boolean>;
  assertInputEmpty: (scope: PilotScope) => Promise<boolean>;
  wait?: (ms: number) => Promise<void>; attempts?: number;
}
function fail(code: string): never { throw new Error(code); }
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const writableShell=(names:string[])=>names.map(n=>`[[ "\${parameters[${n}]-}" != *readonly* ]] || return 1\n`).join('');
const absentShell=(names:string[])=>names.map(n=>`[[ "\${+${n}}" == 0 ]] || return 1\n`).join('');
export class HerdrEntryPilot {
  private scope: PilotScope; private policy: PreparedPolicy; private route: 'mind'|'direct'; private hosts: PilotOptions['installedHosts']; private binaries: PilotOptions['nativeExecutables']; private node: string;
  constructor(private options: PilotOptions) {
    this.scope=structuredClone(options.scope); this.policy=structuredClone(options.policy); this.route=options.route; this.hosts=structuredClone(options.installedHosts); this.binaries=structuredClone(options.nativeExecutables); this.node=options.nodeExecutable;
    const s=this.scope;
    if(!/^w[A-Za-z0-9]+$/.test(s.workspace)||!s.pane.startsWith(s.workspace+':p')||!/^[A-Za-z0-9:_-]+$/.test(s.terminal)||!Number.isSafeInteger(s.shellPid)||s.shellPid<1)fail('pilot_scope_invalid');
    for(const p of [s.cwd,options.artifactRoot,this.node,this.hosts.claude,this.hosts.codex,this.binaries.claude,this.binaries.codex])if(!isAbsolute(p)||/[\0\r\n]/.test(p))fail('pilot_path_invalid');
    if(!['mind','direct'].includes(this.route))fail('pilot_route_invalid');
  }
  private async call(args:string[],type:string,timeout=10000):Promise<any> {
    const raw=await this.options.runner(['--session','default',...args],timeout); let v:any;
    try{v=JSON.parse(raw);}catch{return fail('pilot_response_invalid');}
    if(v.error||typeof v.id!=='string'||v.result?.type!==type)fail('pilot_response_invalid');return v.result;
  }
  async observe():Promise<PilotObservation> {
    const pane=(await this.call(['pane','get',this.scope.pane],'pane_info')).pane;
    const process=(await this.call(['pane','process-info','--pane',this.scope.pane],'pane_process_info')).process_info;
    const agents=(await this.call(['agent','list'],'agent_list')).agents;
    if(!Array.isArray(agents)||pane?.pane_id!==this.scope.pane||pane.terminal_id!==this.scope.terminal||pane.workspace_id!==this.scope.workspace||
      (pane.foreground_cwd??pane.cwd)!==this.scope.cwd||process?.pane_id!==this.scope.pane||process.shell_pid!==this.scope.shellPid)fail('pilot_binding_changed');
    const found=agents.filter((a:any)=>a.pane_id===this.scope.pane);if(found.length>1)fail('pilot_agent_ambiguous');
    const agent=found[0]??null;
    if(agent&&(agent.terminal_id!==this.scope.terminal||agent.workspace_id!==this.scope.workspace))fail('pilot_binding_changed');
    return {pane,agent,process,native:agent?foregroundAgent(process,agent.agent):null};
  }
  private shell(o:PilotObservation):boolean {return !o.agent&&o.process.foreground_process_group_id===this.scope.shellPid&&o.process.foreground_processes?.length===1&&o.process.foreground_processes[0].pid===this.scope.shellPid&&['zsh','-zsh'].includes(o.process.foreground_processes[0].name);}
  private async fence(id:string){if(!await this.options.assertExclusive(structuredClone(this.scope),id))fail('pilot_exclusive_input_unverified');}
  private async until(check:(o:PilotObservation)=>boolean):Promise<PilotObservation>{
    for(let i=0;i<(this.options.attempts??30);i++){const o=await this.observe();if(check(o))return o;await (this.options.wait??(ms=>new Promise(r=>setTimeout(r,ms))))(250);}return fail('pilot_observation_timeout');
  }
  private async effect<T>(id:string,step:string,payload:unknown,run:()=>Promise<T>):Promise<T>{
    await this.fence(id);
    const key={roomId:this.scope.pane,operationId:id,step,payload}; const c=this.options.journal.claim(key);
    if(c.state==='acknowledged')return c.result as T;
    if(c.state!=='claimed')fail('pilot_effect_uncertain');
    try{const result=await run();this.options.journal.acknowledge(this.scope.pane,id,step,result);return result;}
    catch(e){this.options.journal.uncertain(this.scope.pane,id,step);throw e;}
  }
  private args(r:PilotStart):string[]{
    if(!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(r.operationId)||!['claude','codex'].includes(r.agent)||!NATIVE_UUID.test(r.nativeId)||! /^(?:[a-z][a-z0-9_-]{0,31})$/.test(r.name)||r.model!==undefined&&!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(r.model))fail('pilot_request_invalid');
    const args=r.agent==='codex'?['resume',r.nativeId]:['--resume',r.nativeId];if(r.model)args.push('--model',r.model);
    args.push(...(r.agent==='codex'?['--sandbox','read-only','--ask-for-approval','on-request']:['--permission-mode','default','--tools','Read','--strict-mcp-config','--mcp-config','{"mcpServers":{}}']));return args;
  }
  private verify(r:PilotStart){return preparedCommand(this.policy,this.options.contract,r.agent,this.route,this.args(r));}
  private script(id:string,step:string,text:string):string {
    const root=this.options.artifactRoot;mkdirSync(root,{recursive:true,mode:0o700});
    if(lstatSync(root).isSymbolicLink()||realpathSync(root)!==root)fail('pilot_artifact_root_changed');
    const path=join(root,hash({id,step,text})+'.zsh');
    try{writeFileSync(path,text,{mode:0o600,flag:'wx'});}catch(e:any){if(e.code!=='EEXIST'||lstatSync(path).isSymbolicLink()||readFileSync(path,'utf8')!==text)fail('pilot_script_changed');}
    return path;
  }
  private async shellStep(id:string,step:string,text:string,receipt:string,beforeSubmit?:()=>unknown):Promise<void>{
    const path=this.script(id,step,text);
    await this.effect(id,step,{path,hash:hash(text),scope:this.scope},async()=>{
      const before=await this.observe();if(!this.shell(before))fail('pilot_shell_not_ready');
      // Read artifact again immediately before submission; no untrusted path comes from API.
      if(lstatSync(path).isSymbolicLink()||readFileSync(path,'utf8')!==text)fail('pilot_script_changed');
      beforeSubmit?.();await this.fence(id);if(!await this.options.assertInputEmpty(structuredClone(this.scope)))fail('pilot_input_not_empty');
      await this.options.runner(['--session','default','pane','run',this.scope.pane,'source '+quoteShellArg(path)]);
      await this.until(o=>this.shell(o));
      for(let i=0;i<(this.options.attempts??30);i++){
        const screen=await this.options.runner(['--session','default','pane','read',this.scope.pane,'--source','visible','--lines','100']);
        if(screen.split(/\r?\n/).some(line=>line.trim()===receipt))return {receipt};
        await (this.options.wait??(ms=>new Promise(r=>setTimeout(r,ms))))(250);
      }
      return fail('pilot_shell_receipt_missing');
    });
  }
  /** Existing native sessions only. Does not infer route/home/account from a successful start ACK. */
  async startExact(request:PilotStart):Promise<PilotObservation>{
    const r=structuredClone(request),args=this.args(r);
    if(this.options.journal.status(this.scope.pane,r.operationId,'restore').state==='acknowledged')fail('pilot_operation_completed');
    this.verify(r);await this.fence(r.operationId);
    this.options.journal.acquire(this.scope.pane,r.operationId);
    const prefix='_maw_pilot_'+hash(r.operationId).slice(0,16),receipt='MAW_ACTIVATED_'+hash({r,policy:this.policy}).slice(0,24);
    const dir=quoteShellArg(this.policy.directory);
    const activate=absentShell([prefix+'_path',prefix+'_route',prefix+'_had','_ARTRON_ENTRY_ACTIVE','_ARTRON_ENTRY_PRE_PATH','_ARTRON_ENTRY_POST_PATH'])+writableShell(['PATH','ARTRON_ENTRY_ROUTE'])+`[[ -n "\${ZSH_VERSION-}" && -o interactive ]] || return 1\n`+
      `typeset -g ${prefix}_path="$PATH" ${prefix}_route="\${ARTRON_ENTRY_ROUTE-}" ${prefix}_had="\${+ARTRON_ENTRY_ROUTE}"\n`+
      `source ${dir}/activate.zsh || return 1\nexport ARTRON_ENTRY_ROUTE=${quoteShellArg(this.route)}\n`+
      `[[ "$PATH" == "$_ARTRON_ENTRY_POST_PATH" && "$_ARTRON_ENTRY_ACTIVE" == ${dir} && "$(whence -p ${r.agent})" == ${quoteShellArg(this.hosts[r.agent])} && "$(whence -w ${r.agent})" == '${r.agent}: command' ]] || return 1\n`+
      `print -r -- '${receipt.slice(0,12)}''${receipt.slice(12)}'\n`;
    await this.shellStep(r.operationId,'activate',activate,receipt,()=>this.verify(r));
    this.verify(r);
    // Journal a separate immediate pre-start PATH/route check; stale activation receipt alone is insufficient.
    const ready='MAW_PRESTART_'+hash(r).slice(0,24);
    await this.shellStep(r.operationId,'prestart',`[[ "$PATH" == "$_ARTRON_ENTRY_POST_PATH" && "$_ARTRON_ENTRY_ACTIVE" == ${dir} && "\${ARTRON_ENTRY_ROUTE-}" == ${quoteShellArg(this.route)} && "$(whence -p ${r.agent})" == ${quoteShellArg(this.hosts[r.agent])} ]] || return 1\nprint -r -- '${ready.slice(0,12)}''${ready.slice(12)}'\n`,ready,()=>this.verify(r));
    await this.effect(r.operationId,'start',{scope:this.scope,r,args,policy:this.policy},async()=>{
      this.verify(r);if(!this.shell(await this.observe()))fail('pilot_shell_not_ready');
      await this.fence(r.operationId);if(!await this.options.assertInputEmpty(structuredClone(this.scope)))fail('pilot_input_not_empty');
      const ack=await this.call(['agent','start',r.name,'--kind',r.agent,'--pane',this.scope.pane,'--timeout','30000','--',...args],'agent_started',35000);
      if(ack.agent?.pane_id!==this.scope.pane||ack.agent?.terminal_id!==this.scope.terminal||ack.agent?.name!==r.name||ack.agent?.agent!==r.agent)fail('pilot_start_ack_mismatch');return {submitted:true};
    });
    // Re-observe even on journal replay. Never adopt a same-name replacement as the previous process.
    const observed=await this.until(o=>o.agent?.name===r.name&&o.agent?.agent===r.agent&&!!o.native&&o.agent?.interactive_ready===true&&o.agent?.agent_session?.value===r.nativeId&&o.agent.agent_session.agent===r.agent&&o.agent.agent_session.kind==='id'&&o.agent.agent_session.source==='herdr:'+r.agent);
    this.verifyRuntime(r,observed);
    const proof=await this.effect(r.operationId,'observed-process',{r},async()=>({pid:observed.native.pid,group:observed.process.foreground_process_group_id,nativeId:r.nativeId}));
    if(proof.pid!==observed.native.pid||proof.group!==observed.process.foreground_process_group_id)fail('pilot_process_replaced');
    return observed;
  }
  /** Records actual assistant output only. This is NOT a verified handoff/retrieval receipt. */
  async sendContext(request:PilotStart,text:string,readNative:()=>Promise<NativeRecords>):Promise<{state:'assistant-observed';nativeId:string;assistantEventIds:string[];summary:string;retrievalVerified:false;acceptance:'unassessed'}> {
    if(!text||text.includes('\0')||Buffer.byteLength(text)>32000)fail('pilot_context_invalid');
    const r=structuredClone(request),before=await this.startExact(r);
    if(!['idle','done'].includes(before.agent.agent_status))fail('pilot_target_busy');
    const baseline=await readNative();
    if(baseline.nativeId!==r.nativeId||baseline.cwd!==this.scope.cwd||baseline.pendingTools||!baseline.turnComplete)fail('pilot_native_not_safe');
    const checkpoint=await this.effect(r.operationId,'context-baseline',{textHash:hash(text),r},async()=>({ids:baseline.events.map(e=>e.sourceId),hashes:baseline.events.map(e=>hash({sourceId:e.sourceId,role:e.role,text:e.text}))}));
    await this.effect(r.operationId,'context-send',{textHash:hash(text),r},async()=>{
      const live=await this.observe();this.verifyRuntime(r,live);
      if(live.native?.pid!==before.native.pid||live.process.foreground_process_group_id!==before.process.foreground_process_group_id||live.agent?.agent_session?.value!==r.nativeId||!['idle','done'].includes(live.agent.agent_status))fail('pilot_process_changed');
      await this.fence(r.operationId);if(!await this.options.assertInputEmpty(structuredClone(this.scope)))fail('pilot_input_not_empty');
      const dispatch=await this.observe();this.verifyRuntime(r,dispatch);
      if(dispatch.native?.pid!==before.native.pid||dispatch.process.foreground_process_group_id!==before.process.foreground_process_group_id||!['idle','done'].includes(dispatch.agent.agent_status))fail('pilot_process_changed');
      const ack=await this.call(['agent','prompt',this.scope.pane,text],'agent_prompted');
      if(ack.agent?.terminal_id!==this.scope.terminal||ack.agent?.agent_session?.value!==r.nativeId)fail('pilot_prompt_ack_changed');return {submitted:true};
    });
    for(let i=0;i<(this.options.attempts??30);i++){
      const live=await this.observe();this.verifyRuntime(r,live);
      if(live.native?.pid!==before.native.pid||live.agent?.agent_session?.value!==r.nativeId)fail('pilot_process_changed');
      let records:NativeRecords;
      try{records=await readNative();}catch(error){
        // Native writers may append between stat/read or leave a partial final line briefly.
        // Retry only observations, never the prompt, and retain the normal bounded deadline.
        if(!(error instanceof NativeRecordsError)||!['native_file_changed','native_truncated'].includes(error.code))throw error;
        await (this.options.wait??(ms=>new Promise(res=>setTimeout(res,ms))))(250);continue;
      }
      const afterRead=await this.observe();this.verifyRuntime(r,afterRead);
      if(afterRead.native?.pid!==before.native.pid||afterRead.process.foreground_process_group_id!==before.process.foreground_process_group_id)fail('pilot_process_changed');
      if(records.nativeId!==r.nativeId||records.cwd!==this.scope.cwd)fail('pilot_history_changed');
      if(checkpoint.ids.some((id:string,i:number)=>records.events[i]?.sourceId!==id||hash({sourceId:records.events[i]?.sourceId,role:records.events[i]?.role,text:records.events[i]?.text})!==checkpoint.hashes[i]))fail('pilot_history_rewritten');
      const old=new Set(checkpoint.ids);const fresh=records.events.filter(e=>!old.has(e.sourceId));
      const users=fresh.filter(e=>e.role==='user');
      if(users.length>1||users.length===1&&users[0].text!==text)fail('pilot_concurrent_input');
      const start=fresh.findIndex(e=>e.role==='user'&&e.text===text);
      const replies=start<0?[]:records.assistantMessages.filter(e=>!old.has(e.sourceId)&&e.replyToSourceId===fresh[start].sourceId&&e.final&&e.text.trim());
      if(['idle','done'].includes(afterRead.agent.agent_status)&&records.turnComplete&&!records.pendingTools&&!records.refused&&!records.interrupted&&replies.length){
        const result={state:'assistant-observed' as const,nativeId:r.nativeId,assistantEventIds:replies.map(e=>e.sourceId),summary:replies.map(e=>e.text).join('\n'),retrievalVerified:false as const,acceptance:'unassessed' as const};
        return this.effect(r.operationId,'context-observed',{r,textHash:hash(text),userSourceId:users[0].sourceId,assistantEventIds:result.assistantEventIds,summaryHash:hash(result.summary)},async()=>result);
      }
      await (this.options.wait??(ms=>new Promise(res=>setTimeout(res,ms))))(250);
    }
    return fail('pilot_context_observation_timeout');
  }
  async exitExact(request:PilotStart,readNative?:()=>Promise<NativeRecords>):Promise<void>{
    const r=structuredClone(request);this.args(r);await this.fence(r.operationId);
    const prior=this.options.journal.status(this.scope.pane,r.operationId,'observed-process');
    if(prior.state!=='acknowledged')fail('pilot_owned_process_missing');
    if(!readNative)fail('pilot_native_reader_required');
    const before=await this.observe();this.verifyRuntime(r,before);
    const proof=prior.result as {pid:number;group:number};
    if(before.native.pid!==proof.pid||before.process.foreground_process_group_id!==proof.group)fail('pilot_process_replaced');
    if(!['idle','done'].includes(before.agent.agent_status))fail('pilot_target_busy');
    await this.effect(r.operationId,'exit',{r,pid:before.native.pid},async()=>{
      const records=await readNative();
      if(records.nativeId!==r.nativeId||records.cwd!==this.scope.cwd||!records.turnComplete||records.pendingTools||records.refused||records.interrupted)fail('pilot_native_not_safe');
      await this.fence(r.operationId);
      const live=await this.observe();this.verifyRuntime(r,live);
      if(live.native?.pid!==before.native.pid||live.process.foreground_process_group_id!==proof.group||live.agent?.agent_session?.value!==r.nativeId||!['idle','done'].includes(live.agent.agent_status))fail('pilot_process_changed');
      await this.call(['agent','send-keys',this.scope.pane,'ctrl+c','ctrl+c'],'ok');return {submitted:true};
    });
    await this.until(o=>this.shell(o));
  }
  private verifyRuntime(r:PilotStart,o:PilotObservation):void {
    if(o.agent?.agent!==r.agent||o.agent?.name!==r.name||o.agent?.agent_session?.agent!==r.agent||o.agent?.agent_session?.kind!=='id'||o.agent?.agent_session?.source!=='herdr:'+r.agent||o.agent?.agent_session?.value!==r.nativeId)fail('pilot_native_session_unverified');
    const argv=o.native?.argv;
    if(!Array.isArray(argv)||argv[0]!==this.binaries[r.agent]||o.native.cwd!==this.scope.cwd)fail('pilot_native_binary_unverified');
    const expected=this.args(r);
    if(!argv.some((_:unknown,i:number)=>expected.every((a,j)=>argv[i+j]===a)))fail('pilot_native_args_unverified');
    const entry=join(this.policy.directory,'bin','artron-local.js');
    const wrappers=o.process.foreground_processes.filter((p:any)=>p.name==='node'&&Array.isArray(p.argv)&&p.argv[0]===this.node&&p.argv.some((a:string,i:number)=>a===entry&&p.argv[i+1]===this.route&&p.argv[i+2]===r.agent));
    if(wrappers.length!==1)fail('pilot_release_route_unverified');
  }
  /** Caller must have stopped the exact native process and observed shell. Never execute a changed release rollback. */
  async restoreShell(operationId:string):Promise<void>{
    await this.fence(operationId);if(!this.shell(await this.observe()))fail('pilot_shell_not_ready');
    const prefix='_maw_pilot_'+hash(operationId).slice(0,16),receipt='MAW_RESTORED_'+hash(operationId).slice(0,24);
    const saved=[prefix+'_path',prefix+'_route',prefix+'_had','_ARTRON_ENTRY_ACTIVE','_ARTRON_ENTRY_PRE_PATH','_ARTRON_ENTRY_POST_PATH'];
    const text=writableShell(['PATH','ARTRON_ENTRY_ROUTE',...saved])+`[[ "\${+${prefix}_route}" == 1 && "\${+${prefix}_had}" == 1 && ( "$${prefix}_had" == 0 || "$${prefix}_had" == 1 ) ]] || return 1\n`+
      `[[ "\${+${prefix}_path}" == 1 && "\${ARTRON_ENTRY_ROUTE-}" == ${quoteShellArg(this.route)} && "$${prefix}_path" == "\${_ARTRON_ENTRY_PRE_PATH-}" && "$PATH" == "\${_ARTRON_ENTRY_POST_PATH-}" && "\${_ARTRON_ENTRY_ACTIVE-}" == ${quoteShellArg(this.policy.directory)} ]] || return 1\n`+
      `export PATH="$${prefix}_path"\nif [[ "$${prefix}_had" == 1 ]]; then export ARTRON_ENTRY_ROUTE="$${prefix}_route"; else unset ARTRON_ENTRY_ROUTE; fi\n`+
      `[[ "$PATH" == "$${prefix}_path" && "\${+ARTRON_ENTRY_ROUTE}" == "$${prefix}_had" && "\${ARTRON_ENTRY_ROUTE-}" == "$${prefix}_route" ]] || return 1\n`+
      `unset ${saved.join(' ')} || return 1\n`+absentShell(saved)+`rehash || return 1\nprint -r -- '${receipt.slice(0,12)}''${receipt.slice(12)}'\n`;
    await this.shellStep(operationId,'restore',text,receipt);this.options.journal.release(this.scope.pane,operationId);
  }
}
