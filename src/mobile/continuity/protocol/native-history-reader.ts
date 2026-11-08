/** Exact native UUID lookup for trusted host profiles. No latest-session fallback or import-time I/O. */
import {readdir,lstat,realpath} from 'node:fs/promises';
import {join,isAbsolute,normalize} from 'node:path';
import {readNativeRecords,type NativeAgent,type NativeRecords} from '../native-records';
import {ContinuityError} from '../types';

export interface ProtocolNativeHistoryRequest {
  agent:NativeAgent;nativeId:string;effectiveToolHome:string;cwd:string;
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail=():never=>{throw new ContinuityError('protocol_native_history_unavailable');};
/** Host supplies home/cwd from the admitted profile, never an HTTP path. Metadata scan only;
 * the one matching file is then read in full by the bounded stable native reader.
 */
export async function readProtocolNativeHistory(input:ProtocolNativeHistoryRequest):Promise<NativeRecords> {
  try {
    if(!input||!['claude','codex'].includes(input.agent)||!uuid.test(input.nativeId)
      ||![input.effectiveToolHome,input.cwd].every(p=>typeof p==='string'&&isAbsolute(p)&&normalize(p)===p&&!/[\0\r\n]/.test(p)))fail();
    const home=await realpath(input.effectiveToolHome);
    if(home!==input.effectiveToolHome||(await lstat(home)).isSymbolicLink())fail();
    const root=join(home,input.agent==='claude'?'projects':'sessions');
    if(await realpath(root)!==root||!(await lstat(root)).isDirectory())fail();
    const found:string[]=[];let count=0;
    const walk=async(dir:string,depth:number):Promise<void>=>{
      if(depth>8)fail();
      for(const entry of await readdir(dir,{withFileTypes:true})){
        if(++count>20_000)fail();
        if(entry.isSymbolicLink())continue;
        const file=join(dir,entry.name);
        if(entry.isDirectory())await walk(file,depth+1);
        else if(entry.isFile()&&(input.agent==='claude'?entry.name===input.nativeId+'.jsonl':entry.name.endsWith('-'+input.nativeId+'.jsonl'))){found.push(file);if(found.length>1)fail();}
      }
    };
    await walk(root,0);if(found.length!==1)fail();
    return await readNativeRecords(input.agent,input.nativeId,found[0],{allowedRoot:root,expectedCwd:input.cwd});
  }catch{return fail();}
}
