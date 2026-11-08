import {expect,test} from 'bun:test';
import {protocolDriverFromEntry,protocolPolicyFromEntry,type ProtocolEntryCandidate} from '../src/mobile/continuity/protocol/entry';
import type {ProtocolWire} from '../src/mobile/continuity/protocol/types';
import {createHash} from 'node:crypto';
import {protocolRuntimePolicy} from '../src/mobile/continuity/protocol/entry';
function candidate(agent:'codex'|'claude'='codex'):ProtocolEntryCandidate {
 return {tool:agent,model:'fixture',route:'direct',cwd:'/fixture/project',binary:'/fixture/native',
 eligibility:{candidateOnly:true,liveEligible:false},binding:{kind:agent==='codex'?'codex-app-server-stdio':'claude-stream-json',
 route:'direct',model:'fixture',provider:agent==='codex'?'openai':'anthropic',endpoint:agent==='codex'?null:'https://api.anthropic.com',
 home:'/fixture/home',toolHome:'/fixture/config',cwd:'/fixture/project',nativeBinary:'/fixture/native',nativeSha256:'a'.repeat(64),
 nativeVersion:agent==='codex'?'0.164.0':'2.1.220',sessionId:null}};
}
test('entry DI keeps effective home distinct and performs no protocol I/O',()=>{
 let reads=0,writes=0;
 const wire:ProtocolWire={get messages():AsyncIterable<unknown>{reads++;throw Error('must not read');},send:async()=>{writes++;},close:async()=>{}};
 const c=candidate();const policy=protocolPolicyFromEntry(c,1000);
 expect(policy.toolHome).toBe('/fixture/config');expect(policy.home).toBe('/fixture/home');
 expect(policy.modelProvider).toBe('openai');expect(protocolDriverFromEntry(c,wire,1000).idle).toBe(false);
 expect(reads).toBe(0);expect(writes).toBe(0);
 c.binding.home='/changed';expect(policy.home).toBe('/fixture/home');
});
test('Claude entry label never fabricates native account provider proof',()=>{
 expect(protocolPolicyFromEntry(candidate('claude'),1000).modelProvider).toBeUndefined();
});
test('candidate promotion, binding mismatch and unsupported pins are rejected',()=>{
 for(const change of [(c:any)=>c.eligibility.liveEligible=true,(c:any)=>c.model='other',
   (c:any)=>c.binding.nativeVersion='latest',(c:any)=>c.binding.toolHome='relative']) {
  const c=candidate();change(c);expect(()=>protocolPolicyFromEntry(c,1000)).toThrow('protocol_entry_binding_invalid');
 }
});
test('mapping never accesses candidate env or retains credentials',()=>{
 const c=candidate();Object.defineProperty(c,'env',{get(){throw Error('credential access forbidden');}});
 expect(Object.keys(protocolPolicyFromEntry(c,1000)).sort()).toEqual(['agent','cwd','home','model','modelProvider','route','timeoutMs','toolHome']);
});

test('v2 preserves effective home policy while rejecting presence and resume shape mismatch',async()=>{
 const {protocolPolicyFromEntryV2}=await import('../src/mobile/continuity/protocol/entry');
 const v1=candidate(),{toolHome,...rest}=v1.binding;
 const c:any={...v1,version:2,session:{mode:'fresh'},binding:{...rest,version:2,effectiveToolHome:toolHome,homeEnvironment:{state:'absent'}}};
 expect(protocolPolicyFromEntryV2(c,1000).toolHome).toBe(toolHome);
 expect(()=>protocolPolicyFromEntryV2({...c,version:1},1000)).toThrow('protocol_entry_v2_binding_invalid');
 expect(()=>protocolPolicyFromEntryV2({...c,binding:{...c.binding,homeEnvironment:{state:'absent',value:toolHome}}},1000)).toThrow();
 expect(()=>protocolPolicyFromEntryV2({...c,session:{mode:'resume',id:'different'}},1000)).toThrow();
});

function pilot():any {
 const v1=candidate('claude'),{toolHome,...rest}=v1.binding;
 const pilotPolicy={kind:'claude-context-only-safe',version:1};
 const args=['--print','--output-format','stream-json','--safe-mode','--tools',''];
 const hash=(a:string[])=>createHash('sha256').update(JSON.stringify(a)).digest('hex');
 const policyArgvHash=hash(args.slice(-3));
 return {...v1,version:3,session:{mode:'fresh'},args,pilotPolicy,policyArgvHash,finalArgvHash:hash(args),
  binding:{...rest,version:3,effectiveToolHome:toolHome,homeEnvironment:{state:'absent'},pilotPolicy,policyArgvHash}};
}
test('v3 mapping requires exact policy and argv receipts, never promotes eligibility',()=>{
 expect(protocolRuntimePolicy(pilot(),1000).agent).toBe('claude');
 for(const change of [
  (c:any)=>c.binding.pilotPolicy={kind:'other',version:1},
  (c:any)=>c.binding.policyArgvHash='0'.repeat(64),
  (c:any)=>c.args.splice(-1,1,'Read'),
  (c:any)=>c.finalArgvHash='0'.repeat(64),
  (c:any)=>c.eligibility.liveEligible=true,
  (c:any)=>c.version=2,
 ]) {const c=pilot();change(c);expect(()=>protocolRuntimePolicy(c,1000)).toThrow();}
});
test('versioned mappings do not touch even an enumerable credential accessor',()=>{
 const c=pilot();Object.defineProperty(c,'env',{enumerable:true,get(){throw Error('credential access forbidden');}});
 expect(protocolRuntimePolicy(c,1000).toolHome).toBe('/fixture/config');
 const v2={...candidatePolicyFixtureV2()};
 Object.defineProperty(v2,'env',{enumerable:true,get(){throw Error('credential access forbidden');}});
 expect(protocolRuntimePolicy(v2,1000).agent).toBe('claude');
 function candidatePolicyFixtureV2():any {const p=pilot();return {...p,version:2,binding:{...p.binding,version:2}};}
});
