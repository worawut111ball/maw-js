/** Fixtures only: fake Herdr runner + real EffectJournal. Isolated zsh evaluates generated shell guards;
 * no Herdr CLI/native agent/server is executed. Review findings live in failing assertions, not source edits.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HerdrEntryPilot, type PilotOptions, type PilotStart } from '../src/mobile/continuity/herdr-pilot';
import type { NativeRecords } from '../src/mobile/continuity/native-records';
import { EffectJournal } from '../src/mobile/continuity/effect-journal';
const roots:string[]=[], journals:EffectJournal[]=[];
afterEach(()=>{for(const j of journals.splice(0))j.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const request:PilotStart={operationId:'fixture-existing-1',agent:'claude',nativeId:'11111111-1111-4111-8111-111111111111',name:'fixture-existing',model:'fixture-model'};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'herdr-pilot-fixture-'));roots.push(root);
 const release=join(root,'release'), artifacts=join(root,'scripts'), bin=join(root,'host-bin');
 mkdirSync(release);mkdirSync(bin);
 for(const name of ['claude','codex'])writeFileSync(join(bin,name),'#!/bin/sh\nexit 99\n',{mode:0o700}); // Never executed.
 writeFileSync(join(release,'activate.zsh'),`typeset -g _ARTRON_ENTRY_PRE_PATH="$PATH"\nexport PATH='${bin}':"$PATH"\ntypeset -g _ARTRON_ENTRY_POST_PATH="$PATH" _ARTRON_ENTRY_ACTIVE='${release}'\nrehash\n`);
 writeFileSync(join(release,'rollback.zsh'),'print -r -- FORBIDDEN_RELEASE_ROLLBACK\n');
 const scope={workspace:'wFixture',pane:'wFixture:p1',terminal:'term_fixture',cwd:'/home/example/project',shellPid:4100};
 const policy={directory:release,manifestSha256:'a'.repeat(64)};
 const nativeExecutables={claude:'/opt/example/native/claude',codex:'/opt/example/native/codex'};
 const calls:string[][]=[], scripts:string[]=[];
 let inputEmpty=true, exitToShell=true, lostPrompt=false, lostExit=false, groupOffset=0;
 let lastPrompt='', agentStatus='idle';
 let declarations='', screen='', active=false, pid=4200, revision=1, exclusive=true;
 let lostStart=false, lostRun=false, receiptMode:'exact'|'echo'|'prefix'|'padded'='exact', drift='', sessionOverride:unknown;
 let nativeOverride:Record<string,unknown>={}, wrapperOverride:Record<string,unknown>={}, validContract=true;
 const prefix='_maw_pilot_'+sha(request.operationId).slice(0,16);
 let currentRequest={...request};
 const reply=(type:string,body:unknown)=>JSON.stringify({id:'fixture-response',result:{type,...body as object}});
 const agent=()=>({pane_id:scope.pane,terminal_id:scope.terminal,workspace_id:scope.workspace,name:currentRequest.name,agent:currentRequest.agent,revision,agent_status:agentStatus,interactive_ready:true,agent_session:sessionOverride??{agent:currentRequest.agent,kind:'id',source:'herdr:'+currentRequest.agent,value:currentRequest.nativeId}});
 const nativeArgs=()=>currentRequest.agent==='claude'?['--resume',currentRequest.nativeId,...(currentRequest.model?['--model',currentRequest.model]:[]),'--permission-mode','default','--tools','Read','--strict-mcp-config','--mcp-config','{"mcpServers":{}}']:['resume',currentRequest.nativeId,...(currentRequest.model?['--model',currentRequest.model]:[]),'--sandbox','read-only','--ask-for-approval','on-request'];
 const journal=new EffectJournal(join(root,'effects.sqlite'));journals.push(journal);
 const options:PilotOptions={scope,policy,route:'mind',nodeExecutable:'/opt/example/node',installedHosts:{claude:join(bin,'claude'),codex:join(bin,'codex')},nativeExecutables,artifactRoot:artifacts,journal,
  contract:{resolveEntry:r=>({...r}),verifyEntry:(r:any)=>{if(!validContract)throw new Error('fixture_release_changed');return {version:1,...r,manifestSha256:policy.manifestSha256,executable:join(release,'launch',r.tool),env:{},capabilities:{executionLaunchesAgent:true,preservesCallerCwd:true,homeSelection:'installed-host',nestedLaunch:false}};}},
  attempts:2,wait:async()=>{},assertExclusive:async()=>exclusive,assertInputEmpty:async()=>inputEmpty,
  runner:async raw=>{
   calls.push([...raw]);const args=raw.slice(2);
   if(args[0]==='pane'&&args[1]==='get')return reply('pane_info',{pane:{pane_id:scope.pane,terminal_id:scope.terminal,workspace_id:scope.workspace,cwd:scope.cwd}});
   if(args[0]==='pane'&&args[1]==='process-info')return reply('pane_process_info',{process_info:{pane_id:scope.pane,shell_pid:scope.shellPid,foreground_process_group_id:active?pid+groupOffset:scope.shellPid,foreground_processes:active?[
    {pid,name:currentRequest.agent,cwd:scope.cwd,argv:[nativeExecutables[currentRequest.agent],...nativeArgs()],...nativeOverride},
    {pid:pid+1,name:'node',argv:['/opt/example/node',join(release,'bin','artron-local.js'),'mind',currentRequest.agent],...wrapperOverride},
   ]:[{pid:scope.shellPid,name:'zsh'}]}});
   if(args[0]==='agent'&&args[1]==='list')return reply('agent_list',{agents:active?[agent()]:[]});
   if(args[0]==='pane'&&args[1]==='run'){
    const command=args[3];expect(command.startsWith("source '")).toBe(true);
    const path=command.slice(8,-1), text=readFileSync(path,'utf8');scripts.push(text);
    const vars=['PATH','ARTRON_ENTRY_ROUTE','_ARTRON_ENTRY_ACTIVE','_ARTRON_ENTRY_PRE_PATH','_ARTRON_ENTRY_POST_PATH',prefix+'_path',prefix+'_route',prefix+'_had'];
    const prelude=declarations+'\n'+drift+'\n';
    const script=prelude+command+`\nprint -r -- __FIXTURE_STATE__\nfor v in ${vars.join(' ')}; do typeset -p "$v" 2>/dev/null; done\n`;
    const child=spawnSync('/bin/zsh',['-f','-i','-c',script],{env:{PATH:'/usr/bin:/bin',HOME:root},encoding:'utf8'});
    if(child.error)throw child.error;
    const [output,state]=child.stdout.split('__FIXTURE_STATE__\n');declarations=state??'';
    screen=output.trimEnd();
    if(receiptMode==='echo')screen=command+'\n'+text.split('\n').filter(l=>l.startsWith('print -r --')).join('\n');
    if(receiptMode==='prefix')screen='prompt> '+screen;
    if(receiptMode==='padded')screen='  '+screen+'  ';
    if(lostRun)throw new Error('fixture_run_ack_lost');
    return reply('pane_command_submitted',{});
   }
   if(args[0]==='pane'&&args[1]==='read')return screen;
   if(args[0]==='agent'&&args[1]==='start'){
    active=true;
    if(lostStart)throw new Error('fixture_start_ack_lost');
    return reply('agent_started',{agent:agent()});
   }
   if(args[0]==='agent'&&args[1]==='prompt'){
    lastPrompt=args[3];if(lostPrompt)throw new Error('fixture_prompt_ack_lost');
    return reply('agent_prompted',{agent:agent()});
   }
   if(args[0]==='agent'&&args[1]==='send-keys'){
    expect(args.slice(3)).toEqual(['ctrl+c','ctrl+c']);
    if(exitToShell)active=false;
    if(lostExit)throw new Error('fixture_exit_ack_lost');
    return reply('ok',{});
   }
   throw new Error('unexpected_fixture_command:'+JSON.stringify(args));
  }};
 return {root,options,calls,scripts,journal,pilot:()=>new HerdrEntryPilot(options),start:async(p=new HerdrEntryPilot(options),r=request)=>{currentRequest={...r};return p.startExact(r);},stop:()=>{active=false;},replace:()=>{pid++;revision++;},retitle:()=>{revision++;},replaceGroup:()=>{groupOffset++;},setInputEmpty:(v:boolean)=>{inputEmpty=v;},stayActive:()=>{exitToShell=false;},lostPrompt:()=>{lostPrompt=true;},lostExit:()=>{lostExit=true;},prompt:()=>lastPrompt,status:(v:string)=>{agentStatus=v;},setExclusive:(v:boolean)=>{exclusive=v;},lostStart:()=>{lostStart=true;},lostRun:()=>{lostRun=true;},receipt:(v:typeof receiptMode)=>{receiptMode=v;},drift:(v:string)=>{drift=v;},session:(v:unknown)=>{sessionOverride=v;},native:(v:Record<string,unknown>)=>{nativeOverride=v;},wrapper:(v:Record<string,unknown>)=>{wrapperOverride=v;},invalidateRelease:()=>{validContract=false;},state:()=>declarations};
}
const mutations=(f:ReturnType<typeof fixture>)=>f.calls.filter(a=>(a[2]==='pane'&&a[3]==='run')||(a[2]==='agent'&&['start','prompt','send-keys'].includes(a[3])));
const starts=(f:ReturnType<typeof fixture>)=>f.calls.filter(a=>a[2]==='agent'&&a[3]==='start');

describe('Herdr exact-existing staged pilot — DI fixture runner only',()=>{
 test('construction is dormant, no default production registry or route mount',()=>{const f=fixture();f.pilot();expect(f.calls).toHaveLength(0);expect(readdirSync(f.root)).not.toContain('scripts');const source=readFileSync(join(import.meta.dir,'../src/mobile/continuity/herdr-pilot.ts'),'utf8');expect(source).not.toContain('createCliRunner(');expect(source).not.toContain('mountHerdr');});
 test.each(['claude','codex'] as const)('%s uses exact existing UUID and pinned runtime, never context/probe',async agent=>{const f=fixture(),r={...request,agent};const o=await f.start(f.pilot(),r);expect(o.native.argv[0]).toBe(f.options.nativeExecutables[agent]);expect(starts(f)).toHaveLength(1);const args=starts(f)[0];expect(args).toContain(request.nativeId);expect(args).toContain(agent==='claude'?'--resume':'resume');expect(args).not.toContain('--last');expect(f.calls.some(a=>a[2]==='agent'&&a[3]==='prompt')).toBe(false);});
 test('invalid/missing native UUID fails before any runner mutation',async()=>{const f=fixture();await expect(f.start(f.pilot(),{...request,nativeId:''})).rejects.toThrow('pilot_request_invalid');expect(f.calls).toHaveLength(0);});
 test('exclusive fence false blocks all mutations',async()=>{const f=fixture();f.setExclusive(false);await expect(f.start()).rejects.toThrow('pilot_exclusive_input_unverified');expect(mutations(f)).toHaveLength(0);});
 test.each(['echo','prefix'] as const)('activation %s never counts as exact observed receipt',async mode=>{const f=fixture();f.receipt(mode);await expect(f.start()).rejects.toThrow('pilot_shell_receipt_missing');expect(starts(f)).toHaveLength(0);});
 test('lost activation ACK is durable uncertain and never sources twice',async()=>{const f=fixture();f.lostRun();await expect(f.start()).rejects.toThrow('fixture_run_ack_lost');f.journal.close();await expect(f.start()).rejects.toThrow('pilot_effect_uncertain');expect(mutations(f)).toHaveLength(1);});
 test('lost start ACK is durable uncertain across new instance/reopen and never restarts',async()=>{const f=fixture();f.lostStart();await expect(f.start()).rejects.toThrow('fixture_start_ack_lost');f.journal.close();await expect(f.start(f.pilot())).rejects.toThrow('pilot_effect_uncertain');expect(starts(f)).toHaveLength(1);});
 test('same-name PID replacement on acknowledged replay is rejected',async()=>{const f=fixture();await f.start();f.replace();await expect(f.start(f.pilot())).rejects.toThrow('pilot_process_replaced');expect(starts(f)).toHaveLength(1);});
 test.each(['binary','args','cwd'] as const)('native %s drift fails runtime proof after start',async kind=>{const f=fixture();f.native(kind==='binary'?{argv:['/opt/foreign/claude']} :kind==='args'?{argv:[f.options.nativeExecutables.claude,'--resume','22222222-2222-4222-8222-222222222222']}:{cwd:'/home/foreign'});await expect(f.start()).rejects.toThrow(kind==='args'?'pilot_native_args_unverified':'pilot_native_binary_unverified');});
 test.each(['route','release','agent'] as const)('foreground wrapper %s drift rejected',async kind=>{const f=fixture();f.wrapper({argv:['/opt/example/node',join(f.options.policy.directory,kind==='release'?'foreign-entry.js':'bin/artron-local.js'),kind==='route'?'direct':'mind',kind==='agent'?'codex':'claude']});await expect(f.start()).rejects.toThrow('pilot_release_route_unverified');});
 test('restore uses locally generated trusted script even when release rollback becomes hostile',async()=>{const f=fixture();await f.start();f.stop();writeFileSync(join(f.options.policy.directory,'rollback.zsh'),'exit 88\n');f.invalidateRelease();await f.pilot().restoreShell(request.operationId);expect(f.scripts.at(-1)).not.toContain('rollback.zsh');expect(f.scripts.at(-1)).not.toContain('source ');expect(f.state()).toContain("path=( /usr/bin /bin )");expect(f.state()).not.toContain('_ARTRON_ENTRY_ACTIVE=');expect(()=>f.journal.acquire(f.options.scope.pane,'next-operation')).not.toThrow();});
 test.each(['path','route','savedPath'] as const)('cleanup %s drift refuses restore and retains lock',async kind=>{const f=fixture();await f.start();f.stop();f.drift(kind==='path'?'export PATH="/foreign:$PATH"':kind==='route'?"export ARTRON_ENTRY_ROUTE=direct":`${'_maw_pilot_'+sha(request.operationId).slice(0,16)}_path=/foreign`);await expect(f.pilot().restoreShell(request.operationId)).rejects.toThrow('pilot_shell_receipt_missing');expect(()=>f.journal.acquire(f.options.scope.pane,'next-operation')).toThrow('effect_room_locked');});
 test('UI title revision change alone does not replace the native process',async()=>{const f=fixture();await f.start();f.retitle();await expect(f.start(f.pilot())).resolves.toBeDefined();expect(starts(f)).toHaveLength(1);});
 test.each(['provider','kind'] as const)('wrong session %s never satisfies strict native identity',async kind=>{const f=fixture();f.session({agent:kind==='provider'?'codex':'claude',kind:kind==='kind'?'path':'id',source:'herdr:claude',value:request.nativeId});await expect(f.start()).rejects.toThrow();});
 test('wrong native session source never satisfies strict native identity',async()=>{const f=fixture();f.session({agent:'claude',kind:'id',source:'foreign-provider',value:request.nativeId});await expect(f.start()).rejects.toThrow();});
 test('foreground Node executable must match the pinned Node path',async()=>{const f=fixture();f.wrapper({name:'node',argv:['/opt/foreign/node',join(f.options.policy.directory,'bin/artron-local.js'),'mind','claude']});await expect(f.start()).rejects.toThrow();});
 test('non-Node foreground process cannot impersonate release wrapper by argv text alone',async()=>{const f=fixture();f.wrapper({name:'foreign-helper',argv:['/opt/foreign/helper',join(f.options.policy.directory,'bin/artron-local.js'),'mind','claude']});await expect(f.start()).rejects.toThrow();});
});

const contextText='สรุป fixture DEMO-17 แล้วรอคำสั่ง';
function nativeRecords(f:ReturnType<typeof fixture>,kind='valid'):()=>Promise<NativeRecords>{
 let reads=0;
 const base=[{sourceId:'old-user',role:'user',text:'old fixture question',index:0},{sourceId:'old-assistant',role:'assistant',text:'old fixture answer',index:1}];
 return async()=>{
  const after=reads++>0;
  let events=structuredClone(base),assistantMessages:NativeRecords['assistantMessages']=[];
  if(after){
   const user={sourceId:'new-user',role:'user',text:kind==='wrongUser'?'unrelated input':contextText,index:2};
   const answer={sourceId:'new-assistant',role:'assistant',text:'DEMO-17 fixture summary',index:3};
   events.push(user,answer);
   if(kind==='concurrent')events.push({sourceId:'concurrent-user',role:'user',text:'another input',index:4});
   if(kind==='rewriteIds')events[0].sourceId='changed-id';
   if(kind==='rewriteText')events[0].text='rewritten old question';
   assistantMessages=[{sourceId:kind==='oldAssistant'?'old-assistant':answer.sourceId,text:answer.text,index:3,replyToSourceId:kind==='wrongReply'?'old-user':user.sourceId,replyToIndex:2,final:kind!=='notFinal'}];
  }
  return {nativeId:request.nativeId,cwd:f.options.scope.cwd,events,assistantMessages,turnComplete:true,pendingTools:false,refused:false,interrupted:false};
 };
}
const prompts=(f:ReturnType<typeof fixture>)=>f.calls.filter(a=>a[2]==='agent'&&a[3]==='prompt');
const exits=(f:ReturnType<typeof fixture>)=>f.calls.filter(a=>a[2]==='agent'&&a[3]==='send-keys');
describe('Herdr pilot empty input and native context/exit evidence',()=>{
 test.each([1,2,3])('input false at check %i prevents the corresponding shell/start dispatch',async denyAt=>{
  const f=fixture();let checks=0;f.options.assertInputEmpty=async scope=>{expect(scope).toEqual(f.options.scope);return ++checks!==denyAt;};
  await expect(f.start()).rejects.toThrow('pilot_input_not_empty');expect(checks).toBe(denyAt);expect(mutations(f)).toHaveLength(denyAt-1);expect(starts(f)).toHaveLength(0);
 });
 test('context input nonempty blocks prompt despite an exclusive fence',async()=>{const f=fixture(),p=f.pilot();await f.start(p);f.setInputEmpty(false);await expect(p.sendContext(request,contextText,nativeRecords(f))).rejects.toThrow('pilot_input_not_empty');expect(prompts(f)).toHaveLength(0);});
 test('exact user prompt followed by its final native reply returns observed only, never retrieval/acceptance proof',async()=>{const f=fixture();const result=await f.pilot().sendContext(request,contextText,nativeRecords(f));expect(result).toEqual({state:'assistant-observed',nativeId:request.nativeId,assistantEventIds:['new-assistant'],summary:'DEMO-17 fixture summary',retrievalVerified:false,acceptance:'unassessed'});expect(prompts(f)).toHaveLength(1);expect(f.prompt()).toBe(contextText);});
 test.each(['wrongUser','concurrent'])('%s input cannot be accepted as the dispatched context',async kind=>{const f=fixture();await expect(f.pilot().sendContext(request,contextText,nativeRecords(f,kind))).rejects.toThrow('pilot_concurrent_input');});
 test.each(['rewriteIds','rewriteText'])('%s in native prefix rejects context receipt',async kind=>{const f=fixture();await expect(f.pilot().sendContext(request,contextText,nativeRecords(f,kind))).rejects.toThrow('pilot_history_rewritten');});
 test.each(['oldAssistant','wrongReply','notFinal'])('%s is never a correlated final reply',async kind=>{const f=fixture();await expect(f.pilot().sendContext(request,contextText,nativeRecords(f,kind))).rejects.toThrow('pilot_context_observation_timeout');});
 test('lost prompt ACK never resends context after reopen',async()=>{const f=fixture();f.lostPrompt();await expect(f.pilot().sendContext(request,contextText,nativeRecords(f))).rejects.toThrow('fixture_prompt_ack_lost');f.journal.close();await expect(f.pilot().sendContext(request,contextText,nativeRecords(f))).rejects.toThrow('pilot_effect_uncertain');expect(prompts(f)).toHaveLength(1);});
 test('exit accepts bare ok only after shell observation; never submits suggestion or /exit',async()=>{const f=fixture(),p=f.pilot();await f.start(p);await p.exitExact(request,nativeRecords(f));expect(exits(f)).toHaveLength(1);expect(prompts(f)).toHaveLength(0);await p.restoreShell(request.operationId);expect(()=>f.journal.acquire(f.options.scope.pane,'next-operation')).not.toThrow();});
 test.each(['pid','group'])('exit refuses replaced %s before sending any keys',async change=>{const f=fixture(),p=f.pilot();await f.start(p);change==='pid'?f.replace():f.replaceGroup();await expect(p.exitExact(request,nativeRecords(f))).rejects.toThrow('pilot_process_replaced');expect(exits(f)).toHaveLength(0);});
 test('exit refuses an unrecorded native process',async()=>{const f=fixture();await expect(f.pilot().exitExact(request)).rejects.toThrow('pilot_owned_process_missing');expect(mutations(f)).toHaveLength(0);});
 test('exit refuses a working agent before sending keys',async()=>{const f=fixture(),p=f.pilot();await f.start(p);f.status('working');await expect(p.exitExact(request,nativeRecords(f))).rejects.toThrow('pilot_target_busy');expect(exits(f)).toHaveLength(0);});
 test('exit ok with no observed shell times out and cleanup cannot run',async()=>{const f=fixture(),p=f.pilot();await f.start(p);f.stayActive();await expect(p.exitExact(request,nativeRecords(f))).rejects.toThrow('pilot_observation_timeout');const before=mutations(f).length;await expect(p.restoreShell(request.operationId)).rejects.toThrow('pilot_shell_not_ready');expect(mutations(f)).toHaveLength(before);expect(()=>f.journal.acquire(f.options.scope.pane,'next-operation')).toThrow('effect_room_locked');});
 test('lost exit ACK cannot replay native keys',async()=>{const f=fixture(),p=f.pilot();await f.start(p);f.stayActive();f.lostExit();await expect(p.exitExact(request,nativeRecords(f))).rejects.toThrow('fixture_exit_ack_lost');f.journal.close();await expect(f.pilot().exitExact(request,nativeRecords(f))).rejects.toThrow('pilot_effect_uncertain');expect(exits(f)).toHaveLength(1);});
 test('restore input nonempty prevents source dispatch and retains room lock',async()=>{const f=fixture(),p=f.pilot();await f.start(p);f.stop();f.setInputEmpty(false);const before=mutations(f).length;await expect(p.restoreShell(request.operationId)).rejects.toThrow('pilot_input_not_empty');expect(mutations(f)).toHaveLength(before);expect(()=>f.journal.acquire(f.options.scope.pane,'next-operation')).toThrow('effect_room_locked');});
});


describe('Completed pilot operations never reacquire a restored room',()=>{
 test.each([[false,false],[false,true],[true,false],[true,true]])('completed restore rejects before acquire: new owner=%s, reopened=%s',async(nextOwner,reopen)=>{
  const f=fixture(),p=f.pilot(),room=f.options.scope.pane;
  await f.start(p);await p.exitExact(request,nativeRecords(f));await p.restoreShell(request.operationId);
  const restore=f.journal.status(room,request.operationId,'restore');
  expect(restore.state).toBe('acknowledged');
  if(nextOwner)f.journal.acquire(room,'next-operation');
  if(reopen)f.journal.close();
  const beforeCalls=f.calls.length,beforeMutations=mutations(f).length;
  const acquire=spyOn(f.journal,'acquire'),release=spyOn(f.journal,'release'),claim=spyOn(f.journal,'claim');
  try{
   await expect(f.start(f.pilot())).rejects.toThrow('pilot_operation_completed');
   expect(acquire).not.toHaveBeenCalled();expect(release).not.toHaveBeenCalled();expect(claim).not.toHaveBeenCalled();
   expect(f.calls).toHaveLength(beforeCalls);expect(mutations(f)).toHaveLength(beforeMutations);
   expect(f.journal.status(room,request.operationId,'restore')).toEqual(restore);
  }finally{acquire.mockRestore();release.mockRestore();claim.mockRestore();}
  if(nextOwner){
   // A stale completed operation must neither steal nor release the new operation's durable lock.
   expect(()=>f.journal.acquire(room,'third-operation')).toThrow('effect_room_locked');
   expect(()=>f.journal.release(room,request.operationId)).toThrow('effect_room_locked');
   expect(f.journal.claim({roomId:room,operationId:'next-operation',step:'fixture-ownership-proof',payload:{owner:'next-operation'}}).state).toBe('claimed');
   f.journal.acknowledge(room,'next-operation','fixture-ownership-proof',{verified:true});
   f.journal.release(room,'next-operation');
  }else{
   // No lock may be reacquired silently when the restored room was free.
   expect(()=>f.journal.acquire(room,'next-operation')).not.toThrow();
   f.journal.release(room,'next-operation');
  }
 });
});


describe('Shell readonly/collision guards and cleanup postconditions',()=>{
 const prefix='_maw_pilot_'+sha(request.operationId).slice(0,16);
 const saved=[prefix+'_path',prefix+'_route',prefix+'_had','_ARTRON_ENTRY_ACTIVE','_ARTRON_ENTRY_PRE_PATH','_ARTRON_ENTRY_POST_PATH'];
 for(const variable of ['PATH','ARTRON_ENTRY_ROUTE']){
  test(`readonly ${variable} before activation prevents start`,async()=>{
   const f=fixture();f.drift(variable==='PATH'?'readonly PATH':"typeset -gr ARTRON_ENTRY_ROUTE=previous");
   await expect(f.start()).rejects.toThrow('pilot_shell_receipt_missing');expect(starts(f)).toHaveLength(0);
   expect(f.scripts).toHaveLength(1);expect(f.journal.status(f.options.scope.pane,request.operationId,'activate').state).toBe('uncertain');
   expect(()=>f.journal.acquire(f.options.scope.pane,'next-operation')).toThrow('effect_room_locked');
  });
 }
 for(const variable of saved){
  test(`pre-existing empty ${variable} collides before activation and prevents start`,async()=>{
   const f=fixture();f.drift(`typeset -g ${variable}=''`);
   await expect(f.start()).rejects.toThrow('pilot_shell_receipt_missing');expect(starts(f)).toHaveLength(0);expect(f.scripts).toHaveLength(1);
   expect(()=>f.journal.acquire(f.options.scope.pane,'next-operation')).toThrow('effect_room_locked');
  });
 }
 for(const variable of ['PATH','ARTRON_ENTRY_ROUTE',...saved]){
  test(`readonly ${variable} during cleanup prevents restore acknowledgement and retains lock`,async()=>{
   const f=fixture(),p=f.pilot();await f.start(p);f.stop();f.drift(`readonly ${variable}`);
   await expect(p.restoreShell(request.operationId)).rejects.toThrow('pilot_shell_receipt_missing');
   expect(f.journal.status(f.options.scope.pane,request.operationId,'restore').state).toBe('uncertain');
   expect(f.state()).toContain('_ARTRON_ENTRY_ACTIVE=');
   expect(()=>f.journal.acquire(f.options.scope.pane,'next-operation')).toThrow('effect_room_locked');
   expect(starts(f)).toHaveLength(1);
  });
 }
 for(const variable of [prefix+'_route',prefix+'_had']){
  test(`missing ${variable} during cleanup is not silently defaulted`,async()=>{
   const f=fixture(),p=f.pilot();await f.start(p);f.stop();f.drift(`unset ${variable}`);
   await expect(p.restoreShell(request.operationId)).rejects.toThrow('pilot_shell_receipt_missing');
   expect(()=>f.journal.acquire(f.options.scope.pane,'next-operation')).toThrow('effect_room_locked');
  });
 }
 test('invalid saved route-presence bit prevents cleanup acknowledgement',async()=>{
  const f=fixture(),p=f.pilot();await f.start(p);f.stop();f.drift(`${prefix}_had=2`);
  await expect(p.restoreShell(request.operationId)).rejects.toThrow('pilot_shell_receipt_missing');
  expect(()=>f.journal.acquire(f.options.scope.pane,'next-operation')).toThrow('effect_room_locked');
 });
 // zsh treats export as a reserved word; only unset can be replaced by this fixture.
 for(const command of ['unset']){
  test(`cleanup postcondition catches no-op ${command} and retains lock`,async()=>{
   const f=fixture(),p=f.pilot();await f.start(p);f.stop();f.drift(`function ${command} { return 0; }`);
   await expect(p.restoreShell(request.operationId)).rejects.toThrow('pilot_shell_receipt_missing');
   expect(f.journal.status(f.options.scope.pane,request.operationId,'restore').state).toBe('uncertain');
   expect(()=>f.journal.acquire(f.options.scope.pane,'next-operation')).toThrow('effect_room_locked');
  });
 }
});


describe('Exit requires native safe-point evidence and post-read identity',()=>{
 test('owned process with no reader fails before any exit dispatch',async()=>{
  const f=fixture(),p=f.pilot();await f.start(p);
  await expect(p.exitExact(request)).rejects.toThrow('pilot_native_reader_required');
  expect(exits(f)).toHaveLength(0);expect(f.journal.status(f.options.scope.pane,request.operationId,'exit').state).toBe('unknown');
 });
 test('ownership missing is checked before invoking even a supplied native reader',async()=>{
  const f=fixture();let reads=0;
  await expect(f.pilot().exitExact(request,async()=>{reads++;return nativeRecords(f)();})).rejects.toThrow('pilot_owned_process_missing');
  expect(reads).toBe(0);expect(mutations(f)).toHaveLength(0);
 });
 const unsafe:[string,Partial<NativeRecords>][]=[
  ['pending tools',{pendingTools:true}],['turn incomplete',{turnComplete:false}],['refused',{refused:true}],['interrupted',{interrupted:true}],
  ['wrong native UUID',{nativeId:'22222222-2222-4222-8222-222222222222'}],['wrong cwd',{cwd:'/home/foreign/project'}],
 ];
 for(const [label,patch] of unsafe){
  test(`UI idle but native ${label} never sends exit keys`,async()=>{
   const f=fixture(),p=f.pilot();await f.start(p);const read=nativeRecords(f);
   await expect(p.exitExact(request,async()=>({...await read(),...patch}))).rejects.toThrow('pilot_native_not_safe');
   expect(exits(f)).toHaveLength(0);expect(f.journal.status(f.options.scope.pane,request.operationId,'exit').state).toBe('uncertain');
   expect(()=>f.journal.acquire(f.options.scope.pane,'next-operation')).toThrow('effect_room_locked');
  });
 }
 for(const change of ['pid','group'] as const){
  test(`native reader changes ${change} during exit: re-observe blocks all keys`,async()=>{
   const f=fixture(),p=f.pilot();await f.start(p);const read=nativeRecords(f);
   await expect(p.exitExact(request,async()=>{const records=await read();change==='pid'?f.replace():f.replaceGroup();return records;})).rejects.toThrow('pilot_process_changed');
   expect(exits(f)).toHaveLength(0);
  });
 }
 test('native reader revokes the exclusive fence before exit: no keys',async()=>{
  const f=fixture(),p=f.pilot();await f.start(p);const read=nativeRecords(f);
  await expect(p.exitExact(request,async()=>{const records=await read();f.setExclusive(false);return records;})).rejects.toThrow('pilot_exclusive_input_unverified');
  expect(exits(f)).toHaveLength(0);
 });
 test('native read failure never dispatches exit keys',async()=>{
  const f=fixture(),p=f.pilot();await f.start(p);
  await expect(p.exitExact(request,async()=>{throw new Error('fixture_native_read_failed');})).rejects.toThrow('fixture_native_read_failed');
  expect(exits(f)).toHaveLength(0);
 });
});

describe('Context receipt re-observes identity and status after native read',()=>{
 for(const change of ['pid','group','working'] as const){
  test(`post-read ${change} change never returns assistant-observed`,async()=>{
   const f=fixture(),p=f.pilot(),read=nativeRecords(f);let reads=0;
   const changedRead=async()=>{const records=await read();if(++reads===2){if(change==='pid')f.replace();else if(change==='group')f.replaceGroup();else f.status('working');}return records;};
   await expect(p.sendContext(request,contextText,changedRead)).rejects.toThrow(change==='working'?'pilot_context_observation_timeout':'pilot_process_changed');
   expect(reads).toBeGreaterThanOrEqual(2);expect(prompts(f)).toHaveLength(1);expect(exits(f)).toHaveLength(0);
  });
 }
});

import {NativeRecordsError} from '../src/mobile/continuity/native-records';
test.each(['native_file_changed','native_truncated'])('temporary %s retries observations without sending another prompt',async code=>{
 const f=fixture(),read=nativeRecords(f);let calls=0;f.options.attempts=3;
 const result=await f.pilot().sendContext(request,contextText,async()=>{if(++calls===2)throw new NativeRecordsError(code);return read();});
 expect(result.state).toBe('assistant-observed');expect(prompts(f)).toHaveLength(1);
 expect(f.journal.status(f.options.scope.pane,request.operationId,'context-observed').state).toBe('acknowledged');
});
test('malformed native history does not retry as transient or acknowledge assistant',async()=>{
 const f=fixture(),read=nativeRecords(f);let calls=0;
 await expect(f.pilot().sendContext(request,contextText,async()=>{if(++calls===2)throw new NativeRecordsError('native_invalid_json');return read();})).rejects.toThrow('native_invalid_json');
 expect(prompts(f)).toHaveLength(1);expect(f.journal.status(f.options.scope.pane,request.operationId,'context-observed').state).toBe('unknown');
});

test('group changed during baseline read prevents prompt dispatch',async()=>{const f=fixture(),read=nativeRecords(f);await expect(f.pilot().sendContext(request,contextText,async()=>{const result=await read();f.replaceGroup();return result;})).rejects.toThrow('pilot_process_changed');expect(prompts(f)).toHaveLength(0);});
test('input proof callback cannot hide a changed group before prompt dispatch',async()=>{const f=fixture(),p=f.pilot();await f.start(p);f.options.assertInputEmpty=async()=>{f.replaceGroup();return true;};await expect(p.sendContext(request,contextText,nativeRecords(f))).rejects.toThrow('pilot_process_changed');expect(prompts(f)).toHaveLength(0);});
