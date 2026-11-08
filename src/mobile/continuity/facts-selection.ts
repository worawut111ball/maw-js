/** Host-only persistence for explicit facts selections. No authentication or implicit source selection. */
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveFacts, type Snapshot, type SelectionSet, type Resolution } from './facts-resolver';
import { ContinuityError, type Room } from './types';
import type { EngineOptions, FactsSnapshot } from './engine';
type Resolved = Extract<Resolution,{state:'resolved'}>;
interface RecordV1 { version:1; id:string; actorId:string; selection:SelectionSet; resolution:Resolved }
const MAX=2*1024*1024;
const fail=(code:string):never=>{throw new ContinuityError(code);};
const id=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=512&&!/[\0\r\n]/.test(v);
function encode(v:any):string {
 const sorted=(x:any):any=>Array.isArray(x)?x.map(sorted):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])])):x;
 return JSON.stringify(sorted(v));
}
/** Local trusted caller supplies IDs; recording an actor label does not authenticate that actor. */
export class FactsSelectionStore {
 constructor(readonly root:string){if(!isAbsolute(root)||root!==resolve(root)||root.includes('\0'))fail('facts_store_path_invalid');}
 private directory(create:boolean):string {
  if(create)mkdirSync(this.root,{recursive:true,mode:0o700});
  if(!existsSync(this.root))fail('facts_selection_missing');
  const s=lstatSync(this.root);if(s.isSymbolicLink()||!s.isDirectory()||(s.mode&0o077)!==0)fail('facts_store_not_private');
  const dir=realpathSync(this.root);
  if(create)this.syncAncestors(dir);
  return dir;
 }
 private file(dir:string,key:string):string {if(!id(key))fail('facts_selection_id_invalid');return join(dir,createHash('sha256').update(key).digest('hex')+'.json');}
 private readRaw(path:string):string {
  let fd:number;
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e:any){if(e.code==='ENOENT')fail('facts_selection_missing');return fail('facts_selection_unreadable');}
  try{
   const before=fstatSync(fd);if(!before.isFile()||(before.mode&0o077)!==0||before.size>MAX)fail('facts_selection_unreadable');
   const buffer=Buffer.alloc(MAX+1);let n=0;
   while(n<buffer.length){const got=readSync(fd,buffer,n,buffer.length-n,null);if(!got)break;n+=got;}
   const after=fstatSync(fd);if(n>MAX||n!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail('facts_selection_changed');
   return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,n));
  }finally{closeSync(fd);}
 }
 /** Persist resolved facts/provenance before any engine can consume the selection. No overwrite/update API. */
 approve(key:string,actorId:string,snapshot:Snapshot,selection:SelectionSet):Resolved {
  if(!id(key)||!id(actorId))fail('facts_selection_id_invalid');
  const result=resolveFacts(snapshot,selection);if(result.state!=='resolved')return fail('facts_'+result.reason);
  const body:RecordV1={version:1,id:key,actorId,selection:structuredClone(selection),resolution:result},raw=encode(body);
  if(Buffer.byteLength(raw)>MAX)fail('facts_selection_too_large');
  const dir=this.directory(true),path=this.file(dir,key),temporary=join(dir,'.pending-'+randomUUID());
  let fd:number|undefined;
  try{
   fd=openSync(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   writeFileSync(fd,raw);fsyncSync(fd);closeSync(fd);fd=undefined;
   try{linkSync(temporary,path);}catch(e:any){if(e.code!=='EEXIST')throw e;if(this.readRaw(path)!==raw)fail('facts_selection_conflict');}
   const directoryFd=openSync(dir,constants.O_RDONLY);try{fsyncSync(directoryFd);}finally{closeSync(directoryFd);}
  }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch(e:any){if(e.code!=='ENOENT')throw e;}}
  return structuredClone(result);
 }
 private syncDirectory(dir:string):void {
  const fd=openSync(dir,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{if(!fstatSync(fd).isDirectory())fail('facts_store_not_private');fsyncSync(fd);}finally{closeSync(fd);}
 }
 private syncAncestors(dir:string):void {
  // mkdir({recursive:true}) may publish multiple new parents. Flush bottom-up, also when another
  // process performed the mkdir, rather than assuming an existing pathname was durably provisioned.
  for(let current=dir;;current=dirname(current)){
   this.syncDirectory(current);if(dirname(current)===current)break;
  }
 }
 /** Exact ID lookup with a durability barrier, including a publisher paused immediately after link(). */
 read(key:string,snapshot:Snapshot):Resolved {
  const dir=this.directory(false),raw=this.readRaw(this.file(dir,key));let record:RecordV1;
  try{record=JSON.parse(raw);}catch{return fail('facts_selection_corrupt');}
  if(!record||record.version!==1||record.id!==key||!id(record.actorId)||Object.keys(record).sort().join(',')!=='actorId,id,resolution,selection,version'||encode(record)!==raw)fail('facts_selection_corrupt');
  const result=resolveFacts(snapshot,record.selection);if(result.state!=='resolved')return fail('facts_'+result.reason);
  if(encode(record.resolution)!==encode(result))fail('facts_provenance_mismatch');
  // Publisher fsyncs file contents before link. The reader must flush the link too: visibility alone
  // does not prove the publishing process reached its own directory barrier before crashing.
  this.syncAncestors(dir);
  return result;
 }
}
/** selectId must use an authenticated, persisted host selection. This callback never chooses from transcript text. */
export function createFactsProvider(store:FactsSelectionStore,selectId:(room:Room,snapshot:FactsSnapshot)=>Promise<string|null>):NonNullable<EngineOptions['facts']> {
 return async(room,snapshot)=>{
  const baseline=structuredClone(snapshot);
  if(room.id!==baseline.roomId||room.revision!==baseline.roomRevision)fail('facts_room_changed');
  const key=await selectId(structuredClone(room),structuredClone(baseline));
  if(!key)return fail('facts_selection_missing');
  return store.read(key,baseline).facts;
 };
}
