import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContinuityWriteGuard, type ContinuityWriteGuard } from '../src/mobile/continuity/write-guard';
import { mount as docs } from '../src/mobile/features/docs';
import { mount as ports, type PortControlDeps } from '../src/mobile/features/ports';
import { guardedRetroDeps, startRetroLoop, runRetro, retroPass, DEFAULTS, type RetroDeps } from '../src/mobile/features/retro';
import { guardedPrsDeps, startPrsLoop, resetCache, sendReview, type PrsDeps } from '../src/mobile/features/prs';
const channel = { kind:'tmux' as const, pane:'%synthetic', label:'fixture' };
const idle='⏺ done\n\n────────\n❯ \n────────\n  ? for shortcuts';
const blocked=createContinuityWriteGuard({resolveRoom:async()=>({} as any)});
const request=(app:any,path:string,body:unknown={})=>app.handle(new Request('http://fixture'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
const ws='00000000-0000-4000-8000-000000000001';

describe('Feature writes use mount-local continuity policy',()=>{
 test('docs rejects before looking up a document or resolving a terminal',async()=>{
  const app=new Elysia();let seen:any;docs(app,{assertRoom:async(...args)=>{seen=args;throw new Error('private');},assertChannel:async()=>{throw new Error('unexpected channel');}});
  const r=await request(app,'/docs/marks/send',{id:'never-read-document',ws:'exact-ws',room:'exact-room'});
  expect(r.status).toBe(409);expect(await r.json()).toMatchObject({code:'continuity_delivery_not_certified',state:'definitely-rejected'});expect(seen).toEqual(['exact-ws','exact-room']);
 });
 function portFixture(guard?:ContinuityWriteGuard,terminal:any=channel){
  const calls:string[]=[];const app=new Elysia();
  const d:PortControlDeps={portsOf:async()=>({root:'/synthetic',list:[{pid:123,terminal,agent:null,ports:[1234]} as any]}),kill:()=>{calls.push('kill');},waitGone:async()=>true,pressKey:async(_ch,key)=>{calls.push(key);},sleep:async()=>{},portFree:()=>true};
  ports(app,guard,d);return {app,calls,d};
 }
 for(const action of ['stop','restart'])test(`ports ${action} has no key/process effect when policy blocks`,async()=>{
  const h=portFixture(blocked),r=await request(h.app,`/workspaces/${ws}/ports/123/${action}`);
  expect(r.status).toBe(409);expect(h.calls).toEqual([]);
 });
 test('ports stop cannot assume process without terminal is unmanaged',async()=>{
  const h=portFixture(blocked,null),r=await request(h.app,`/workspaces/${ws}/ports/123/stop`);expect(r.status).toBe(409);expect(h.calls).toEqual([]);
 });
 test('ports rechecks policy between ctrl-c and subsequent keys',async()=>{
  let reads=0;const h=portFixture({assertRoom:async()=>{},assertChannel:async()=>{if(++reads>1)throw new Error('scope changed');}});
  const r=await request(h.app,`/workspaces/${ws}/ports/123/restart`);expect(r.status).toBe(409);expect(await r.json()).toMatchObject({state:'uncertain',code:'continuity_write_interrupted'});expect(h.calls).toEqual(['ctrlc']);
 });
 test('default unconfigured ports keeps existing behavior with injected fake effects',async()=>{
  const h=portFixture(createContinuityWriteGuard());expect((await request(h.app,`/workspaces/${ws}/ports/123/restart`)).status).toBe(200);expect(h.calls).toEqual(['ctrlc','up','enter']);
 });
 function retroFixture(){
  const effects:string[]=[];const now=Date.now();let data:any={...DEFAULTS,mode:'auto',minMinutes:1,idleMinutes:1,sessions:{}};
  const d:RetroDeps={rooms:()=>new Map([['synthetic-session',{sessionId:'synthetic-session',status:'idle',channel,pid:1} as any]]),read:async()=>{effects.push('read');return idle;},type:async()=>{effects.push('type');},notify:async()=>{effects.push('notify');},hook:()=>undefined,activity:()=>({minutes:[Math.floor((now-20*60000)/60000),Math.floor((now-19*60000)/60000)],lastTs:now-19*60000,retros:[],cwd:'/synthetic'}),skillExists:()=>true,load:()=>structuredClone(data),save:f=>{data=structuredClone(f);},now:()=>now};
  return {d,effects};
 }
 test('manual retro and background pass both reject before terminal reads',async()=>{
  const h=retroFixture(),d=guardedRetroDeps(h.d,blocked);
  expect((await runRetro(d,'synthetic-session','rrr')).ok).toBe(false);
  expect((await retroPass(d)).ran).toEqual([]);expect(h.effects).toEqual([]);
 });
 test('retro rechecks immediately before typing after a previously allowed read',async()=>{
  const h=retroFixture();let checks=0;const d=guardedRetroDeps(h.d,{assertChannel:async()=>{if(++checks===2)throw new Error('changed');}});
  await expect(runRetro(d,'synthetic-session','rrr')).rejects.toThrow('changed');expect(h.effects).toEqual(['read']);
 });
 test('actual retro timer callback keeps separate policies and supports disposal',async()=>{
  const a=retroFixture(),b=retroFixture();let ta!:()=>Promise<void>,tb!:()=>Promise<void>,canceled=0;
  const stopA=startRetroLoop(guardedRetroDeps(a.d,blocked),tick=>{ta=tick;return ()=>{canceled++;};});
  const stopB=startRetroLoop(guardedRetroDeps(b.d,createContinuityWriteGuard()),tick=>{tb=tick;return ()=>{canceled++;};});
  await ta();await tb();expect(a.effects).toEqual([]);expect(b.effects).toContain('type');
  stopA();stopB();await ta();expect(canceled).toBe(2);expect(a.effects).toEqual([]);
 });
 test('guarded dependency wrapper never mutates another instance',async()=>{
  const h=retroFixture();guardedRetroDeps(h.d,blocked);expect((await runRetro(h.d,'synthetic-session','rrr')).ok).toBe(true);expect(h.effects).toEqual(['read','type']);
 });
 test('PR review cannot choose a blocked room, including automatic callers of sendReview',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'maw-feature-guard-'));const effects:string[]=[];
  const d:PrsDeps={gh:async()=>({code:0,stdout:JSON.stringify({state:'OPEN',url:'https://example.invalid/pr/1'}),stderr:''}),localRepos:()=>[{repo:'fixture/project',path:'/synthetic'}],rooms:()=>new Map([['synthetic-session',{sessionId:'synthetic-session',status:'idle',channel,pid:1} as any]]),read:async()=>{effects.push('read');return idle;},type:async()=>{effects.push('type');},chan:()=>channel,notify:async()=>{},configFile:join(dir,'config.json'),verdictDir:join(dir,'verdicts'),now:()=>Date.now()};
  const r=await sendReview('fixture/project',1,guardedPrsDeps(d,blocked));expect(r.ok).toBe(false);expect(effects).toEqual([]);
 });
});

import { mount as herdrFeature } from '../src/mobile/features/herdr';
import { mount as resumeFeature } from '../src/mobile/features/resume';
import { mount as supersetFeature } from '../src/mobile/features/superset';
import { mount as autostartFeature, ensureGuarded } from '../src/mobile/features/autostart';
describe('Unbound lifecycle writes require a separate continuity contract',()=>{
 test('Herdr mutation handlers reject before touching lifecycle deps',async()=>{
  const app=new Elysia();let calls=0;
  const lifecycle=new Proxy({}, {get(){calls++;throw new Error('lifecycle must not be touched');}});
  herdrFeature(app,{lifecycle} as any,blocked);
  for(const path of ['/herdr/create','/herdr/operations/id/continue','/herdr/operations/id/autostart','/herdr/close/preview','/herdr/close/confirm','/herdr/stop']){
   const r=await request(app,path,{});expect(r.status).toBe(409);expect(await r.json()).toMatchObject({code:'continuity_delivery_not_certified'});
  }
  expect(calls).toBe(0);
 });
 test('Superset mutation handlers reject before CLI calls or payload validation',async()=>{
  const app=new Elysia();supersetFeature(app,blocked);
  for(const path of ['/superset/workspaces','/superset/workspaces/id/archive','/superset/automations','/superset/automations/id/resume','/superset/tasks/id/start','/superset/workspaces/id/scripts/id/run']){
   const r=await request(app,path,{});expect(r.status).toBe(409);expect(await r.json()).toMatchObject({state:'definitely-rejected'});
  }
 });
 test('resume rejects before looking up sessions or running a launcher',async()=>{
  const app=new Elysia();resumeFeature(app,blocked);
  const r=await request(app,`/workspaces/${ws}/resume`,{sessionId:ws});expect(r.status).toBe(409);
 });
 test('autostart config and boot writer both check the same policy',async()=>{
  const app=new Elysia();const file=join(mkdtempSync(join(tmpdir(),'maw-autostart-guard-')),'config.json');let calls=0;
  autostartFeature(app,{file,tmux:()=>{calls++;throw new Error('unexpected');},allow:x=>x,panes:()=>[]},blocked);
  expect((await request(app,'/autostart',{session:'fixture',dir:'/synthetic',on:true})).status).toBe(409);
  await expect(ensureGuarded(()=>{calls++;return [];},()=>{calls++;return '';},undefined,blocked)).rejects.toThrow('continuity_delivery_not_certified');expect(calls).toBe(0);
 });
 test('default autostart boot behavior remains available using fake terminal',async()=>{
  const calls:string[][]=[];
  const result=await ensureGuarded(()=>[{session:'fixture',dir:'/synthetic',agent:'shell',skipPermissions:false}],args=>{calls.push(args);if(args[0]==='has-session')throw new Error('absent');return '';},undefined,createContinuityWriteGuard());
  expect(result).toEqual(['fixture']);expect(calls.map(x=>x[0])).toEqual(['has-session','new-session']);
 });
});

test('actual PR automatic scheduler uses guarded dependencies, never global unguarded deps',async()=>{
 resetCache();const dir=mkdtempSync(join(tmpdir(),'maw-pr-loop-guard-'));const config=join(dir,'config.json');
 writeFileSync(config,JSON.stringify({extraRepos:[],auto:{'fixture/project':true},reviewRoom:null}));
 const effects:string[]=[];let checks=0,tick!:()=>Promise<void>;
 const pr={number:71,title:'fixture',state:'OPEN',url:'https://example.invalid/pr/71',isDraft:false,updatedAt:'2026-11-08T00:00:00Z',statusCheckRollup:[],mergeable:'MERGEABLE',mergeStateStatus:'CLEAN'};
 const d:PrsDeps={gh:async args=>({code:0,stdout:JSON.stringify(args.includes('view')?pr:args.includes('list')?[pr]:[]),stderr:''}),localRepos:()=>[{repo:'fixture/project',path:'/synthetic'}],rooms:()=>new Map([['fixture-session',{sessionId:'fixture-session',status:'idle',channel,pid:1} as any]]),read:async()=>{effects.push('read');return idle;},type:async()=>{effects.push('type');},chan:()=>channel,notify:async()=>{effects.push('notify');},configFile:config,verdictDir:join(dir,'verdicts'),now:()=>Date.now()};
 const guarded=guardedPrsDeps(d,{assertChannel:async()=>{checks++;throw new Error('blocked');}});
 const stop=startPrsLoop(guarded,fn=>{tick=fn;return ()=>{};});
 await tick();expect(checks).toBeGreaterThan(0);expect(effects).toEqual([]);stop();const previous=checks;await tick();expect(checks).toBe(previous);
 resetCache();
});
