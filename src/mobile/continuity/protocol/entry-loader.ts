/** Host-only pinned module loading. No HTTP path/argv/env input and no launch authority. */
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readFileSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {isAbsolute,join} from 'node:path';
import {protocolRuntimePolicy,type ProtocolRuntimeCandidate} from './entry';
import type {ApprovedProcessSpec} from './process-supervisor';
import {ProtocolError} from './types';

const files=['local-entry.js','protocol-entry.js','protocol-entry-v2.js','protocol-entry-pilot.js'] as const;
export interface PinnedProtocolModule {
  /** Trusted operator-selected source directory only. Never populate from a user request. */
  directory:string;
  hashes:Record<typeof files[number],string>;
}
type BuiltCandidate=ProtocolRuntimeCandidate & {args:readonly string[];env:Readonly<Record<string,string>>};
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function fail():never {throw new ProtocolError('protocol_entry_module_unverified');}
function plain(value:unknown):value is Record<string,unknown> {
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
  return Reflect.ownKeys(value).every(k=>typeof k==='string'&&Object.getOwnPropertyDescriptor(value,k)?.enumerable
    &&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)!,'value'));
}
/** Validates exact reviewed sources before module evaluation and every candidate/spec use.
 * Candidates are owned by this loader instance; JSON copies cannot authorize a process spec.
 * A caller still MUST obtain trusted managed-policy/home/external-writer admission separately.
 */
export class PinnedProtocolEntryLoader {
  private pin:PinnedProtocolModule;
  private owned=new WeakSet<object>();
  private v2!:(input:unknown)=>unknown;
  private pilot!:(input:unknown)=>unknown;
  constructor(pin:PinnedProtocolModule) {
    this.pin=structuredClone(pin);this.verify();
    try {
      const require=createRequire(import.meta.url);
      this.v2=require(join(this.pin.directory,'protocol-entry-v2.js')).buildProtocolLaunchV2;
      this.pilot=require(join(this.pin.directory,'protocol-entry-pilot.js')).buildProtocolPilotLaunch;
      if(typeof this.v2!=='function'||typeof this.pilot!=='function')fail();
      this.verify();
    }catch {fail();}
  }
  private verify():void {
    try {
      if(!isAbsolute(this.pin.directory)||realpathSync(this.pin.directory)!==this.pin.directory
        ||Object.keys(this.pin.hashes).sort().join('|')!==[...files].sort().join('|'))fail();
      for(const name of files) {
        const path=join(this.pin.directory,name),expected=this.pin.hashes[name];
        if(!/^[a-f0-9]{64}$/.test(expected)||realpathSync(path)!==path)fail();
        const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try {
          const before=fstatSync(fd);
          if(!before.isFile()||before.size>1024*1024)fail();
          const bytes=readFileSync(fd),after=fstatSync(fd);
          if(bytes.length!==before.size||before.mtimeMs!==after.mtimeMs||sha(bytes)!==expected)fail();
        }finally {closeSync(fd);}
      }
    }catch {fail();}
  }
  build(input:unknown):ProtocolRuntimeCandidate {
    this.verify();
    try {
      if(!plain(input)||![2,3].includes(input.version as number))fail();
      const result=(input.version===3?this.pilot:this.v2)(structuredClone(input));
      if(!plain(result))fail();
      const c=result as unknown as BuiltCandidate;
      protocolRuntimePolicy(c,1000);
      if(!Object.isFrozen(c)||!Object.isFrozen(c.binding)||!Array.isArray(c.args)||!Object.isFrozen(c.args)
        ||c.args.some(a=>typeof a!=='string'||a.includes('\0'))||!plain(c.env)||!Object.isFrozen(c.env)
        ||Object.entries(c.env).some(([k,v])=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)||typeof v!=='string'||v.includes('\0')))fail();
      const homeKey=c.tool==='claude'?'CLAUDE_CONFIG_DIR':'CODEX_HOME',presence=c.binding.homeEnvironment;
      if(c.env.HOME!==c.binding.home||Object.hasOwn(c.env,homeKey)!==(presence.state==='present')
        ||presence.state==='present'&&c.env[homeKey]!==presence.value)fail();
      this.verify();this.owned.add(c);return c;
    }catch {fail();}
  }
  /** Only for a supervisor's trusted preflight AFTER policy admission, never an API return value. */
  processSpec(candidate:ProtocolRuntimeCandidate):ApprovedProcessSpec {
    this.verify();
    if(!this.owned.has(candidate))fail();
    protocolRuntimePolicy(candidate,1000);
    const c=candidate as BuiltCandidate;
    return {binary:c.binary,sha256:c.binding.nativeSha256,args:[...c.args],env:{...c.env},cwd:c.cwd};
  }
}
