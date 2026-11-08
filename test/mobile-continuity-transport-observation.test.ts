import { describe, expect, test } from 'bun:test';
import { buildObservationCommands, TMUX_OBSERVATION_FORMAT, parseHerdrObservation, parseTmuxObservation, parseSupersetObservation, observeTransport, buildMacProcessCommand, parseMacProcessHint, compareMacProcessHints, type ObservationTarget } from '../src/mobile/continuity/transport-observation';
const uuid='11111111-1111-4111-8111-111111111111';
const h:ObservationTarget={backend:'herdr',workspace:'wFixture',pane:'wFixture:p1',terminal:'term_fixture',cwd:'/home/example/project'};
const t:ObservationTarget={backend:'tmux',workspace:'tmux',pane:'%7',cwd:'/home/example/project'};
const s:ObservationTarget={backend:'superset',workspace:uuid,pane:'22222222-2222-4222-8222-222222222222'};
const envelope=(type:string,value:object)=>JSON.stringify({id:'fixture',result:{type,...value}});
function herdrFixture(){
 const ref={agent:'claude',kind:'id',source:'herdr:claude',value:uuid};
 const pane={pane_id:h.pane,workspace_id:h.workspace,terminal_id:h.terminal,cwd:h.cwd,agent_session:ref};
 const process={pane_id:h.pane,shell_pid:100,foreground_process_group_id:200,foreground_processes:[{pid:200,name:'claude',cwd:h.cwd,argv:['claude','--secret-value','MUST_NOT_EXPORT'],birth:'invented-birth'}]};
 const agent={pane_id:h.pane,workspace_id:h.workspace,terminal_id:h.terminal,agent:'claude',agent_session:{...ref},agent_status:'idle',model:'configured-model',route:'mind'};
 const raw=()=>({pane:envelope('pane_info',{pane}),process:envelope('pane_process_info',{process_info:process}),agents:envelope('agent_list',{agents:[agent]})});
 return {pane,process,agent,raw};
}
const tmux='%7\t100\t/dev/ttys007\t/home/example/project\tclaude\t0\t0\n';
const ps=' 200 100 200 200 ttys007 Sun Nov  8 05:18:00 2026 /opt/example/native/claude\n';
describe('Read-only transport observation command builders',()=>{
 test('Herdr uses explicit default session and three read commands, never input/start/keys',()=>{const commands=buildObservationCommands(h);expect(commands.map(c=>c.args.slice(2,4))).toEqual([['pane','get'],['pane','process-info'],['agent','list']]);expect(commands.every(c=>c.args.slice(0,2).join(' ')==='--session default')).toBe(true);});
 test('tmux only displays scoped pane metadata and never queries paste buffers as input',()=>{expect(buildObservationCommands(t)).toEqual([{executable:'tmux',args:['display-message','-p','-t','%7',TMUX_OBSERVATION_FORMAT]}]);});
 test('Superset explain uses --local and exact workspace/terminal UUIDs',()=>{expect(buildObservationCommands(s)).toEqual([{executable:'superset',args:['agents','explain','--local','--workspace',s.workspace,'--terminal',s.pane,'--json']}]);});
 for(const target of [{...h,pane:'wForeign:p1'},{...h,terminal:''},{...h,cwd:'/home/example/../foreign'},{...t,pane:'%7;touch x'},{...s,pane:'not-a-uuid'}]){
  test(`invalid scope cannot generate commands: ${JSON.stringify(target)}`,()=>expect(()=>buildObservationCommands(target)).toThrow('observation_target_invalid'));
 }
});
describe('Herdr protocol observations are reported hints, never invented proof',()=>{
 test('correlates pane/terminal/process/session and strips argv/config/birth claims',()=>{const f=herdrFixture(),o=parseHerdrObservation(h,f.raw(),1000);expect(o.reportedNativeSession).toEqual({agent:'claude',nativeId:uuid,source:'herdr:claude'});expect(o.processes).toEqual([{pid:200,name:'claude',cwd:h.cwd!}]);expect(o.shellPid).toBe(100);expect(o.foregroundGroup).toBe(200);expect(o.reportedStatus).toBe('idle');expect(o.inputEmpty).toBeNull();expect(o.writerExclusive).toBeNull();expect(o.processBirthVerified).toBe(false);expect(o.productionReady).toBe(false);expect(JSON.stringify(o)).not.toContain('MUST_NOT_EXPORT');expect(JSON.stringify(o)).not.toContain('configured-model');expect(JSON.stringify(o)).not.toContain('invented-birth');});
 for(const field of ['pane_id','workspace_id','terminal_id','cwd'])test(`pane ${field} mismatch rejected`,()=>{const f=herdrFixture();(f.pane as any)[field]='foreign';expect(()=>parseHerdrObservation(h,f.raw(),1)).toThrow('observation_binding_changed');});
 for(const field of ['agent','kind','source','value'])test(`native reference ${field} mismatch rejected`,()=>{const f=herdrFixture();(f.agent.agent_session as any)[field]='foreign';expect(()=>parseHerdrObservation(h,f.raw(),1)).toThrow('observation_native_ref_invalid');});
 test('native UUID array is not coerced to a string',()=>{const f=herdrFixture();(f.agent.agent_session as any).value=[uuid];expect(()=>parseHerdrObservation(h,f.raw(),1)).toThrow('observation_native_ref_invalid');});
 test('pane/agent native reference conflict is rejected',()=>{const f=herdrFixture();f.pane.agent_session={...f.pane.agent_session,value:s.pane};expect(()=>parseHerdrObservation(h,f.raw(),1)).toThrow('observation_native_ref_conflict');});
 test('same-name duplicate native processes never become owned/ready',()=>{const f=herdrFixture();f.process.foreground_processes.push({...f.process.foreground_processes[0],pid:201});const o=parseHerdrObservation(h,f.raw(),1);expect(o.processes).toHaveLength(2);expect(o.productionReady).toBe(false);expect(o.gaps).toContain('process_birth_unverified');});
 test('duplicated PID is malformed',()=>{const f=herdrFixture();f.process.foreground_processes.push({...f.process.foreground_processes[0]});expect(()=>parseHerdrObservation(h,f.raw(),1)).toThrow('observation_process_invalid');});
 test('duplicate agent records are ambiguous',()=>{const f=herdrFixture(),raw=f.raw();raw.agents=envelope('agent_list',{agents:[f.agent,f.agent]});expect(()=>parseHerdrObservation(h,raw,1)).toThrow('observation_agent_ambiguous');});
 test('a pure shell snapshot does not manufacture native identity',()=>{const f=herdrFixture(),raw=f.raw();raw.agents=envelope('agent_list',{agents:[]});const o=parseHerdrObservation(h,raw,1);expect(o.reportedNativeSession).toBeNull();expect(o.reportedStatus).toBeNull();expect(o.productionReady).toBe(false);});
 test('provider error and invalid envelope are rejected without exposing response contents',()=>{const f=herdrFixture(),raw=f.raw();raw.pane=JSON.stringify({error:'private-fixture-data'});expect(()=>parseHerdrObservation(h,raw,1)).toThrow('observation_response_invalid');});
});
describe('tmux and Superset keep unknown capabilities unknown',()=>{
 test('tmux pane PID is explicitly first-process PID; current command does not become native identity',()=>{const o=parseTmuxObservation(t,tmux,1);expect(o.paneFirstPid).toBe(100);expect(o.shellPid).toBeNull();expect(o.foregroundGroup).toBeNull();expect(o.reportedNativeSession).toBeNull();expect(o.inputEmpty).toBeNull();expect(o.processes).toEqual([]);expect(o.productionReady).toBe(false);});
 test('disabled input routing never means empty input buffer',()=>{const o=parseTmuxObservation(t,tmux.replace(/0\n$/,'1\n'),1);expect(o.inputEmpty).toBeNull();expect(o.gaps).toContain('pane_input_disabled');});
 test('dead pane remains unavailable',()=>expect(parseTmuxObservation(t,tmux.replace('\t0\t0','\t1\t0'),1).gaps).toContain('pane_dead'));
 for(const raw of [tmux.replace('%7','%8'),tmux.replace('\t100\t','\t0\t'),tmux.replace('project','project\tunsafe'),tmux+'extra\n',tmux.replace('claude','claude\nunsafe')])test(`invalid tmux frame ${JSON.stringify(raw)}`,()=>expect(()=>parseTmuxObservation(t,raw,1)).toThrow('observation_response_invalid'));
 test('Superset JSON fields cannot manufacture native ID/PID/empty-input/model proof',()=>{const o=parseSupersetObservation(s,JSON.stringify({data:{status:'idle',pid:200,nativeId:uuid,inputEmpty:true,route:'mind'}}),1);expect(o.reportedNativeSession).toBeNull();expect(o.processes).toEqual([]);expect(o.reportedStatus).toBeNull();expect(o.inputEmpty).toBeNull();expect(o.productionReady).toBe(false);expect(o.gaps).toContain('superset_explain_schema_unverified');});
 test('Superset malformed/error JSON fails closed',()=>{for(const raw of ['not-json','[]','null','{"error":"failed"}'])expect(()=>parseSupersetObservation(s,raw,1)).toThrow('observation_response_invalid');});
});
describe('DI collection and local macOS process birth hints',()=>{
 test('DI runs only read commands and exposes a non-atomic observation gap',async()=>{const calls:unknown[]=[],f=herdrFixture(),raw=f.raw(),values=[raw.pane,raw.process,raw.agents];const o=await observeTransport(h,async c=>{calls.push(c);return values.shift()!;},()=>1000);expect(calls).toEqual(buildObservationCommands(h));expect(o.observedAt).toBe(1000);expect(o.gaps).toContain('observation_not_atomic');});
 test('failed read never falls back to synthetic state',async()=>{await expect(observeTransport(t,async()=>{throw new Error('fixture_offline');})).rejects.toThrow('fixture_offline');});
 test('ps query is explicit PID, no environment/full argv collection',()=>{expect(buildMacProcessCommand(200)).toEqual({executable:'/bin/ps',args:['-p','200','-o','pid=,ppid=,pgid=,tpgid=,tty=,lstart=,comm=']});for(const pid of [0,-1,NaN,1.5])expect(()=>buildMacProcessCommand(pid)).toThrow('observation_pid_invalid');});
 test('ps start time is local second-resolution hint, never a verified process birth token',()=>{const o=parseMacProcessHint(ps,200);expect(o.startedLocal).toBe('Sun Nov 8 05:18:00 2026');expect(o.birthPrecision).toBe('seconds');expect(o.ownershipVerified).toBe(false);expect(compareMacProcessHints(o,{...o})).toBe('unproven');expect(compareMacProcessHints(o,{...o,startedLocal:'Sun Nov 8 05:18:01 2026'})).toBe('changed');expect(compareMacProcessHints(o,{...o,pid:201})).toBe('changed');});
 test('ps without controlling terminal does not invent a group',()=>expect(parseMacProcessHint(ps.replace('200 200 ttys007','200 -1 ??'),200).foregroundGroup).toBeNull());
 test('ps PID mismatch, multiple records and missing output reject',()=>{for(const raw of [ps.replace('200 100','201 100'),ps+ps,''])expect(()=>parseMacProcessHint(raw,200)).toThrow('observation_process_invalid');});
 test('wrong backend and invalid observation time reject',()=>{expect(()=>parseHerdrObservation(t,herdrFixture().raw(),1)).toThrow('observation_backend_mismatch');expect(()=>parseTmuxObservation(t,tmux,NaN)).toThrow('observation_time_invalid');});
});

describe('Other backends use the same explicit read-only DI collector',()=>{
 test('tmux collector does not invent native metadata from a pane command',async()=>{const commands:unknown[]=[];const o=await observeTransport(t,async command=>{commands.push(command);return tmux;},()=>2);expect(commands).toEqual(buildObservationCommands(t));expect(o.productionReady).toBe(false);expect(o.reportedNativeSession).toBeNull();});
 test('Superset collector exposes the schema gap without echoing unverified provider data',async()=>{const commands:unknown[]=[];const o=await observeTransport(s,async command=>{commands.push(command);return JSON.stringify({data:{status:'idle',prompt:'PRIVATE_FIXTURE'}});},()=>2);expect(commands).toEqual(buildObservationCommands(s));expect(JSON.stringify(o)).not.toContain('PRIVATE_FIXTURE');expect(o.gaps).toContain('superset_explain_schema_unverified');});
 test('target UUIDs must be strings rather than coercible arrays',()=>{expect(()=>buildObservationCommands({...s,pane:[s.pane] as any})).toThrow('observation_target_invalid');});
});
