import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PinnedProtocolEntryLoader,type PinnedProtocolModule} from '../src/mobile/continuity/protocol/entry-loader';
function fixture() {
 const directory=mkdtempSync(join(tmpdir(),'entry-loader-'));
 const c={version:2,tool:'claude',model:'fixture',route:'mind',cwd:'/fixture/project',binary:'/fixture/native',
  session:{mode:'fresh'},eligibility:{candidateOnly:true,liveEligible:false},args:['-p'],
  env:{HOME:'/fixture/home',ANTHROPIC_AUTH_TOKEN:'fixture-private-value'},binding:{version:2,kind:'claude-stream-json',
   route:'mind',model:'fixture',provider:'anthropic',endpoint:'https://fixture.example/api/anthropic',home:'/fixture/home',
   effectiveToolHome:'/fixture/home/.claude',homeEnvironment:{state:'absent'},cwd:'/fixture/project',nativeBinary:'/fixture/native',
   nativeSha256:'a'.repeat(64),nativeVersion:'2.1.220',sessionId:null}};
 const source=`function freeze(x){if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x)}return x;}module.exports.buildProtocolLaunchV2=()=>freeze(${JSON.stringify(c)});`;
 const content={'local-entry.js':'module.exports={};','protocol-entry.js':'module.exports={};','protocol-entry-v2.js':source,'protocol-entry-pilot.js':'module.exports.buildProtocolPilotLaunch=()=>{throw Error("fixture-private-value")};'};
 const hashes:any={};for(const [name,value]of Object.entries(content)){writeFileSync(join(directory,name),value);hashes[name]=createHash('sha256').update(value).digest('hex');}
 return {pin:{directory,hashes} as PinnedProtocolModule,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
test('pinned entry maps owned immutable candidate but never treats a JSON copy as process authority',()=>{
 const f=fixture();try {
  const loader=new PinnedProtocolEntryLoader(f.pin),c=loader.build({version:2});
  const spec=loader.processSpec(c);expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe('fixture-private-value');
  expect(Object.hasOwn(spec.env,'CLAUDE_CONFIG_DIR')).toBe(false);
  spec.env={};expect(loader.processSpec(c).env.HOME).toBe('/fixture/home');
  expect(()=>loader.processSpec(structuredClone(c))).toThrow('protocol_entry_module_unverified');
 }finally{f.cleanup();}
});
test('source inventory drift is rejected both before evaluation and before using a cached candidate',()=>{
 const f=fixture();try {
  const loader=new PinnedProtocolEntryLoader(f.pin),c=loader.build({version:2});
  writeFileSync(join(f.pin.directory,'local-entry.js'),'throw Error("must never evaluate drift")');
  expect(()=>loader.processSpec(c)).toThrow('protocol_entry_module_unverified');
  expect(()=>loader.build({version:2})).toThrow('protocol_entry_module_unverified');
  expect(()=>new PinnedProtocolEntryLoader(f.pin)).toThrow('protocol_entry_module_unverified');
 }finally{f.cleanup();}
});
test('builder errors are sanitized and a complete inventory is mandatory',()=>{
 const f=fixture();try {
  const loader=new PinnedProtocolEntryLoader(f.pin);
  try{loader.build({version:3});throw Error('expected rejection');}catch(e:any){expect(e.message).toBe('protocol_entry_module_unverified');expect(JSON.stringify(e)).not.toContain('fixture-private-value');}
  delete (f.pin.hashes as any)['local-entry.js'];expect(()=>new PinnedProtocolEntryLoader(f.pin)).toThrow();
 }finally{f.cleanup();}
});
