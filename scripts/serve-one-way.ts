/** Explicit post-review operator entry. Import does not launch a server or native agent. */
import {constants,openSync,closeSync,fstatSync,readFileSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareOneWayServerHost,type OneWayServerStartup} from '../src/core/protocol-startup';

/** Retain the same outcome for every caller; server shutdown is attempted even if owned cleanup fails. */
export function createOneWayClose(cleanup:()=>Promise<unknown>,stop:()=>unknown|Promise<unknown>){
  let closePromise:Promise<void>|undefined;
  return ()=>closePromise??=(async()=>{
    let failed=false;
    try{await cleanup();}catch{failed=true;}
    try{await stop();}catch{failed=true;}
    if(failed)throw Error('production_shutdown_failed');
  })();
}

export async function runOneWayServer(pin:{path:string;sha256:string},port:number){
  if(!isAbsolute(pin.path)||realpathSync(pin.path)!==pin.path||!/^[a-f0-9]{64}$/.test(pin.sha256)
    ||!Number.isInteger(port)||port<1||port>65535)throw Error('production_entry_unverified');
  const verify=()=>{
    const fd=openSync(pin.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const before=fstatSync(fd);if(!before.isFile()||(before.mode&0o077)!==0||before.size>256*1024)throw Error('production_entry_unverified');
      const bytes=readFileSync(fd),after=fstatSync(fd);
      if(bytes.length!==before.size||before.mtimeMs!==after.mtimeMs||createHash('sha256').update(bytes).digest('hex')!==pin.sha256)throw Error('production_entry_unverified');
    }finally{closeSync(fd);}
  };
  verify();const module=await import(pathToFileURL(pin.path).href);verify();
  if(typeof module.createStartup!=='function')throw Error('production_entry_unverified');
  const input:OneWayServerStartup=await module.createStartup();verify();
  const prepared=await prepareOneWayServerHost(input);
  try{
    // Existing server module uses MAW_CLI to suppress its automatic standalone start.
    process.env.MAW_CLI='1';
    const {startServer}=await import('../src/core/server');
    const server=await startServer(port,{mobile:prepared.mobile});
    const close=createOneWayClose(()=>prepared.close(),()=>server.stop(true));
    for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void close().then(()=>process.exit(0),()=>process.exit(1));});
    return {server,close};
  }catch(error){await prepared.close();throw error;}
}
if(import.meta.main){
  const [path,sha256,rawPort='3456',...extra]=process.argv.slice(2);
  if(!path||!sha256||extra.length)throw Error('usage: bun scripts/serve-one-way.ts <reviewed-private-host-module> <sha256> [port]');
  await runOneWayServer({path,sha256},Number(rawPort));
}
