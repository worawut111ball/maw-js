import {expect,test} from 'bun:test';
import {ProtocolContinuityAdapter,protocolRoomBinding,type ProtocolAdapterPorts} from '../src/mobile/continuity/protocol/adapter';
import type {Room,Binding} from '../src/mobile/continuity/types';
function fixture(){
 const entry:any={version:2,kind:'codex-app-server-stdio',home:'/fixture/home',effectiveToolHome:'/fixture/home/.codex',homeEnvironment:{state:'absent'},provider:'openai',endpoint:null};
 const targetEntry:any={...entry,kind:'claude-stream-json',effectiveToolHome:'/fixture/home/.claude',provider:'anthropic',endpoint:'https://api.anthropic.com'};
 const source:Binding={agent:'codex',nativeId:'source',model:'fixture',route:'direct',generation:'protocol:codex:1',cursor:0};
 source.generation=protocolRoomBinding({...source,model:'fixture',route:'direct'},1,entry).generation;
 const room:Room={id:'r',workspace:'w',room:'p',backend:'herdr',cwd:'/fixture',revision:0,active:'codex',bindings:{codex:source}};
 const order:string[]=[];let mismatch=false,exitFails=false;
 const from:any={inspect:async()=>({identity:{agent:'codex',nativeId:'source',model:'fixture',route:'direct'},generation:1,binding:entry,idle:true,pendingApproval:false}),close:async()=>{order.push('exit');if(exitFails)throw Error('exit unknown');}};
 const to:any={startWithContext:async(input:any)=>{order.push('start');expect(input.firstTurn.text).toBe('context');return {source:'live',identity:{agent:'claude',nativeId:'target',model:'fixture',route:'direct'},generation:2,firstTurn:{operationId:'op:context',state:'completed'}};}};
 let current=from;
 const ports:ProtocolAdapterPorts={runtime:()=>current,install:(_id,r)=>{order.push('install');current=r;},create:()=>to,
  preflight:async()=>({ready:true}),candidate:async()=>({tool:mismatch?'codex':'claude',cwd:'/fixture',model:'fixture',binding:targetEntry,session:{mode:'fresh'}} as any),history:async()=>[],
  verifyContext:async(_r,b,c)=>{order.push('verify');return {state:'acknowledged',nativeId:b.nativeId,hash:c.hash,throughSeq:c.throughSeq};},timeoutMs:1000};
 return {room,ports,order,entry,targetEntry,adapter:new ProtocolContinuityAdapter(ports),mismatch:()=>mismatch=true,exitFail:()=>exitFails=true};
}
const context={id:'op',text:'context',hash:'fixture-hash',throughSeq:0};
test('revoked switch authority after deferred source inspection preserves the source',async()=>{
 const h=fixture(),source=h.ports.runtime('r')!,inspect=source.inspect.bind(source);
 let release!:()=>void,entered!:()=>void,revoked=false;
 const waiting=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 source.inspect=async()=>{entered();await gate;return inspect();};
 h.ports.beforeSourceClose=async(room,target,delivery,candidate)=>{
  expect(room.id).toBe('r');expect(target).toBe('claude');expect(delivery.id).toBe(context.id);expect(candidate.tool).toBe('claude');
  if(revoked)throw Error('permit revoked');
 };
 const running=h.adapter.launchWithContext(h.room,'claude',context);
 await waiting;revoked=true;release();
 await expect(running).rejects.toThrow('permit revoked');expect(h.order).toEqual([]);
});
test('owned source exits before target starts; receipt requires separate trusted verification',async()=>{
 const h=fixture();const result=await h.adapter.launchWithContext(h.room,'claude',context);
 expect(h.order).toEqual(['exit','install','start','verify']);expect(result.binding.generation).toMatch(/^protocol:claude:[a-f0-9]{64}:2$/);expect(result.receipt.state).toBe('acknowledged');
});
test('wrong target and unknown exit cannot start target',async()=>{
 const h=fixture();h.mismatch();await expect(h.adapter.launchWithContext(h.room,'claude',context)).rejects.toMatchObject({code:'protocol_candidate_scope_mismatch'});expect(h.order).toEqual([]);
 const e=fixture();e.exitFail();await expect(e.adapter.launchWithContext(e.room,'claude',context)).rejects.toThrow();expect(e.order).toEqual(['exit']);
});
test('missing owned registry never adopts external pane and exact resume never falls back fresh',async()=>{
 const h=fixture();h.ports.runtime=()=>undefined;expect((await h.adapter.preflight(h.room,'claude')).ready).toBe(false);
 const e=fixture();const existing:Binding={agent:'claude',nativeId:'old',generation:'old',cursor:0};
 await expect(e.adapter.launchWithContext(e.room,'claude',context,existing)).rejects.toMatchObject({code:'protocol_candidate_scope_mismatch'});expect(e.order).toEqual([]);
});

 test('same UUID and counter in another home cannot retain the room namespace',async()=>{
  const h=fixture();const before=await h.adapter.inspect(h.room);
  h.entry.effectiveToolHome='/fixture/other/.codex';
  const after=await h.adapter.inspect(h.room);expect(after.binding.generation).not.toBe(before.binding.generation);
  await expect(h.adapter.checkpoint(h.room)).rejects.toMatchObject({code:'source_not_safe'});
  h.entry.effectiveToolHome='/fixture/home/.codex';expect((await h.adapter.inspect(h.room)).binding.generation).toBe(before.binding.generation);
 });
 test('matching target UUID with foreign saved namespace is rejected before source exit',async()=>{
  const h=fixture();const original=h.ports.candidate;
  h.ports.candidate=async(...args)=>({...await original(...args),session:{mode:'resume',id:'old'}});
  const identity={agent:'claude' as const,nativeId:'old',model:'fixture',route:'direct'};
  const existing=protocolRoomBinding(identity,1,{...h.targetEntry,effectiveToolHome:'/other/.claude'});
  await expect(h.adapter.launchWithContext(h.room,'claude',context,existing)).rejects.toMatchObject({code:'protocol_resume_namespace_mismatch'});expect(h.order).toEqual([]);
 });
