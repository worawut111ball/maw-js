/** Isolated fixture Node children only: no native CLI, model, network or server. */
import {afterEach,expect,test} from 'bun:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProtocolProcessSupervisor,type OwnedProtocolProcess,type ProcessSupervisorOptions} from '../src/mobile/continuity/protocol/process-supervisor';

const children:OwnedProtocolProcess[]=[],dirs:string[]=[];
afterEach(async()=>{
  const results=await Promise.allSettled(children.splice(0).map(child=>child.cleanup()));
  for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});
  for(const result of results)expect(result.status).toBe('fulfilled');
});
const node=Bun.which('node');if(!node)throw Error('fixture Node required');
const script=`#!${realpathSync(node)}
import {createInterface} from 'node:readline';
// Independent fixture safety bound, including a hypothetical constructor failure.
setTimeout(()=>process.exit(0),5000);
process.stdout.write(JSON.stringify({ready:true})+'\\n');
for await(const line of createInterface({input:process.stdin})){
  process.stdout.write(JSON.stringify({echo:JSON.parse(line)})+'\\n');
}
`;
function fixture(lifetimeMode?:ProcessSupervisorOptions['lifetimeMode']){
  const cwd=realpathSync(mkdtempSync(join(tmpdir(),'maw-production-lifetime-')));dirs.push(cwd);
  const binary=join(cwd,'child.mjs');writeFileSync(binary,script,{mode:0o700});
  let checks=0,pending=false;
  const options:ProcessSupervisorOptions={
    ...(lifetimeMode===undefined?{}:{lifetimeMode}),pendingWork:()=>pending,
    preflight:async()=>{checks++;return {binary,cwd,sha256:createHash('sha256').update(script).digest('hex'),args:[],env:{}};},
    limits:{lifetimeMs:50,preflightMs:2000,graceMs:30,terminateMs:100,killWaitMs:1000},
  };
  const supervisor=new ProtocolProcessSupervisor(options),permit={incarnation:randomUUID(),launchId:randomUUID()};
  return {supervisor,permit,options,checks:()=>checks,pending:(value:boolean)=>{pending=value;},launch:async()=>{
    const owned=await supervisor.launch({fixtureOnly:true},permit);children.push(owned);return owned;
  }};
}
const expected=(child:OwnedProtocolProcess)=>({incarnation:child.incarnation,launchId:child.launchId,runtimeBirth:child.runtimeBirth});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('owned-session survives the 50ms bound, retains usable pipes, and explicit cleanup proves exact exit',async()=>{
  const f=fixture('owned-session'),child=await f.launch(),iterator=child.wire.messages[Symbol.asyncIterator]();
  expect(await iterator.next()).toMatchObject({value:{ready:true},done:false});
  await delay(150);await child.assertRunning();
  await expect(child.observeExit(expected(child))).rejects.toMatchObject({code:'protocol_process_exit_unverified'});
  await child.wire.send({id:'after-lifetime',text:'synthetic public fixture'});
  expect(await iterator.next()).toMatchObject({value:{echo:{id:'after-lifetime',text:'synthetic public fixture'}},done:false});
  const first=child.cleanup();expect(child.cleanup()).toBe(first);await first;
  expect(await child.observeExit(expected(child))).toMatchObject({source:'owned-process-supervisor',...expected(child),inputClosed:true,outputClosed:true,pendingWork:false});
  await expect(child.observeExit({...expected(child),runtimeBirth:'foreign-birth'})).rejects.toMatchObject({code:'protocol_process_exit_unverified'});
  f.pending(true);await expect(child.observeExit(expected(child))).rejects.toMatchObject({code:'protocol_process_exit_unverified'});
  await expect(child.assertRunning()).rejects.toMatchObject({code:'protocol_process_not_running'});
  await expect(child.wire.send({id:'no-retry'})).rejects.toMatchObject({code:'protocol_process_not_running'});
  await expect(f.launch()).rejects.toMatchObject({code:'protocol_process_launch_replayed'});
  expect(f.checks()).toBe(1);
},5000);

for(const mode of [undefined,'bounded'] as const)test(`${mode??'default'} mode still expires at the 50ms lifetime without relaunch`,async()=>{
  const f=fixture(mode),child=await f.launch();
  // Do not require startup output before the intentionally short lifetime expires.
  await delay(150);
  await expect(child.assertRunning()).rejects.toMatchObject({code:'protocol_process_not_running'});
  await child.cleanup();
  expect(await child.observeExit(expected(child))).toMatchObject({source:'owned-process-supervisor',...expected(child),inputClosed:true,outputClosed:true});
  await expect(f.launch()).rejects.toMatchObject({code:'protocol_process_launch_replayed'});expect(f.checks()).toBe(1);
},5000);

test('lifetime mode is constructor-only: candidate fields cannot disable the default bound',async()=>{
  const f=fixture();
  const child=await f.supervisor.launch({lifetimeMode:'owned-session',limits:{lifetimeMs:999999}},f.permit);children.push(child);
  await delay(150);await expect(child.assertRunning()).rejects.toMatchObject({code:'protocol_process_not_running'});
  await child.cleanup();expect(await child.observeExit(expected(child))).toMatchObject(expected(child));expect(f.checks()).toBe(1);
  expect(()=>new ProtocolProcessSupervisor({...f.options,lifetimeMode:'browser-request' as any})).toThrow('protocol_process_limits_invalid');
},5000);
