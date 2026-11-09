import { opendir, realpath, open, stat } from 'fs/promises';
import { constants } from 'fs';
import { homedir } from 'os';
import { join, isAbsolute, relative, basename } from 'path';
import { randomUUID, createHash } from 'crypto';
import { hash } from './inventory';
import type { ConversationRef, HistoryOptions, HistoryQuery, HistoryItem, HistoryResult } from './types';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inside=(root:string,file:string)=>{const p=relative(root,file);return p!==''&&!p.startsWith('..')&&!isAbsolute(p);};
const cleanText=(v:unknown):string=>typeof v==='string'?v:'';
function nativeId(agent:string,rows:any[]):string|null {
  if(agent==='codex'){const row=rows.find(v=>v.type==='session_meta');return typeof row?.payload?.id==='string'?row.payload.id:null;}
  const ids=new Set(rows.filter(v=>typeof v.sessionId==='string').map(v=>v.sessionId));return ids.size===1?[...ids][0] as string:null;
}
const LOC = Symbol('history-record');
type Location = {record:number;slot:number;output?:number};
function parseHistory(agent:string,rows:any[],prune=true):HistoryItem[]{
  const items:HistoryItem[]=[], tools=new Map<string,HistoryItem>(), dequeued=new Set<HistoryItem>();
  let record=-1,slot=0;
  const push=(it:Omit<HistoryItem,'i'>)=>{const v={...it,i:items.length,[LOC]:{record,slot:slot++} as Location};items.push(v);return v;};
  const parents=new Map<string,string|null>(), logical=new Set<string>(), turns=new Set<string>(), owners:(string|undefined)[]=[];let leaf:string|undefined;
  for(const e of rows){
    record++;slot=0;
    const before=items.length;if(e.isSidechain)continue;
    if(agent==='claude'&&typeof e.uuid==='string'){leaf=e.uuid;const parent=e.parentUuid??e.logicalParentUuid??null;parents.set(e.uuid,parent);if(!e.parentUuid&&e.logicalParentUuid)logical.add(e.uuid);if(e.type==='user'&&!e.isMeta&&!e.isCompactSummary)turns.add(e.uuid);}
    const p=agent==='codex'?e.payload:e.message, ts=e.timestamp??null;
    if(agent==='claude'&&e.type==='queue-operation'){
      if(e.operation==='enqueue'&&typeof e.content==='string')push({role:'user',text:e.content,ts,queued:true});
      else if(['remove','dequeue'].includes(e.operation)){const q=items.find(x=>x.queued&&(!e.content||x.text===e.content));if(q){q.queued=false;dequeued.add(q);}}
      continue;
    }
    if(agent==='claude'&&e.isCompactSummary){push({role:'system',text:'🗜 บีบบทสนทนาแล้ว',ts});continue;}
    if(agent==='claude'&&e.isMeta)continue;
    if(agent==='codex'&&e.type==='event_msg'&&p?.type==='turn_aborted'){push({role:'system',text:'⏹ หยุดงานกลางคัน',ts});continue;}
    if(agent==='codex'&&e.type!=='response_item')continue;
    const role=agent==='claude'?e.type:p?.role;
    const content=typeof p?.content==='string'?[{type:'text',text:p.content}]:Array.isArray(p?.content)?p.content:[];
    if(['user','assistant'].includes(role)){
      const text=content.filter((b:any)=>['text','input_text','output_text'].includes(b.type)).map((b:any)=>cleanText(b.text)).join('\n');
      const images=content.flatMap((b:any)=>b.type==='image'&&b.source?.type==='base64'&&/^image\/(png|jpeg|webp|gif)$/.test(b.source.media_type)&&typeof b.source.data==='string'?[`data:${b.source.media_type};base64,${b.source.data}`]:[]);
      const queued=[...dequeued].find(x=>x.text===text&&x.role==='user');if(queued){dequeued.delete(queued);owners[queued.i]=e.uuid;}
      if(text.trim()||images.length){if(!queued)push({role:role as 'user'|'assistant',text,ts,...(images.length?{images}:{})});else slot++;}
    }
    for(const b of content){
      if(b.type==='tool_use'){const v=push({role:['Agent','Task'].includes(b.name)?'agent':'tool',ts,tool:{name:String(b.name),summary:String(b.name),input:JSON.stringify(b.input??{}),output:null,error:false}});tools.set(b.id,v);}
      if(b.type==='tool_result'){const t=tools.get(b.tool_use_id);if(t?.tool){t.tool.output=typeof b.content==='string'?b.content:JSON.stringify(b.content??'');t.tool.error=!!b.is_error;(t as any)[LOC].output=record;}}
      if(b.type==='thinking'&&typeof b.thinking==='string'&&b.thinking.trim())push({role:'assistant',text:b.thinking,ts});
    }
    if(agent==='codex'&&['function_call','custom_tool_call'].includes(p?.type)){const v=push({role:'tool',ts,tool:{name:String(p.name??'Tool'),summary:String(p.name??'Tool'),input:typeof(p.arguments??p.input)==='string'?(p.arguments??p.input):JSON.stringify(p.arguments??p.input??{}),output:null,error:false}});tools.set(p.call_id,v);}
    if(agent==='codex'&&['function_call_output','custom_tool_call_output'].includes(p?.type)){const t=tools.get(p.call_id);if(t?.tool){t.tool.output=typeof p.output==='string'?p.output:JSON.stringify(p.output??'');(t as any)[LOC].output=record;}}
    for(let j=before;j<items.length;j++)owners[j]=e.uuid;
  }
  // Keep compaction/missing links. Drop only abandoned sibling branches containing a real user turn.
  if(prune&&agent==='claude'&&leaf){const children=new Map<string,string[]>();for(const [u,p]of parents)if(p&&!logical.has(u))children.set(p,[...(children.get(p)??[]),u]);const path=new Set<string>();for(let u:string|null|undefined=leaf;u&&!path.has(u);u=parents.get(u))path.add(u);const dead=new Set<string>();
    for(const u of path){const parent=parents.get(u);if(!parent||logical.has(u))continue;for(const sibling of children.get(parent)??[]){if(sibling===u||path.has(sibling))continue;const branch:string[]=[],todo=[sibling],seen=new Set<string>();while(todo.length){const n=todo.pop()!;if(seen.has(n))continue;seen.add(n);branch.push(n);todo.push(...children.get(n)??[]);}if(branch.some(x=>turns.has(x)))branch.forEach(x=>dead.add(x));}}
    const filtered=items.filter((_,i)=>!owners[i]||!dead.has(owners[i]!)).map((v,i)=>({...v,i}));(filtered as any).branchKey=[...dead].sort();return filtered;
  }
  return items;
}
// Indexes retain byte ranges and redacted structural metadata, never message bodies.
const CHUNK=64*1024, RECORD_CAP=8*1024*1024, META_CAP=32*1024*1024, RECORDS_CAP=200_000;
class ReaderLimit extends Error { constructor(readonly reason:string){super(reason);} }
const masked=(x:any):string=>typeof x==='string'&&x.trim()?hash(['history-text',x]):'';
function structure(e:any):any {
  const blocks=(v:any)=>typeof v==='string'?masked(v):Array.isArray(v)?[...v.filter(b=>!['text','input_text','output_text'].includes(b.type)).map(b=>{
    if(b.type==='image')return {type:b.type,source:{type:b.source?.type,media_type:b.source?.media_type,data:typeof b.source?.data==='string'?'AA==':undefined}};
    return {type:b.type,text:masked(b.text),thinking:masked(b.thinking),id:b.id,tool_use_id:b.tool_use_id,name:b.name==='Agent'||b.name==='Task'?b.name:'Tool',content:typeof b.content==='string'?masked(b.content):'',is_error:!!b.is_error,input:{}};
  }),{type:'text',text:masked(v.filter(b=>['text','input_text','output_text'].includes(b.type)).map(b=>cleanText(b.text)).join('\n'))}]:[];
  return {type:e.type,uuid:e.uuid,parentUuid:e.parentUuid,logicalParentUuid:e.logicalParentUuid,sessionId:e.sessionId,
    isSidechain:e.isSidechain,isMeta:e.isMeta,isCompactSummary:e.isCompactSummary,operation:e.operation,content:masked(e.content),
    message:e.message?{content:blocks(e.message.content)}:undefined,
    payload:e.payload?{id:e.payload.id,type:e.payload.type,role:e.payload.role,content:blocks(e.payload.content),name:e.payload.name==='Agent'||e.payload.name==='Task'?e.payload.name:'Tool',call_id:e.payload.call_id,arguments:masked(e.payload.arguments),input:masked(e.payload.input),output:masked(typeof e.payload.output==='string'?e.payload.output:JSON.stringify(e.payload.output??'')),rollback:e.type==='event_msg'&&e.payload.type==='thread_rolled_back'?hash(e):undefined}:undefined};
}
type Range={offset:number;length:number};
type Index={signature:string;fileKey:string;size:number;mtime:number;epoch:string;rows:any[];ranges:Range[];metadataBytes:number;
  offset:number;lineStart:number;scratch:Buffer;hasher:ReturnType<typeof createHash>;committedHasher:ReturnType<typeof createHash>;
  fullDigest?:string;branch?:string;entries?:{loc:Location;queued?:boolean}[];native?:string;ready:boolean;
  verify?:{previous:Index;offset:number;hasher:ReturnType<typeof createHash>}};
export class HistoryResolver {
  private indexes=new Map<string,Index>();
  private busy=new Set<string>();
  private activeReads=0;
  /** Local diagnostics only: no file paths, IDs or message contents. Resets for each read. */
  lastReadBytes=0;
  constructor(private options:HistoryOptions={}){}
  async read(ref:ConversationRef|null,query:HistoryQuery={}):Promise<HistoryResult>{
    let readBytes=0;
    const unavailable=(reason:string):HistoryResult=>({ok:true,kind:'none',available:false,reason});
    if(!ref)return unavailable('native_session_missing');
    if(ref.source.startsWith('herdr:')&&ref.source!==`herdr:${ref.agent}`||!(this.options.allowedSources??['herdr:claude','herdr:codex']).includes(ref.source))return unavailable('native_source_unsupported');
    const limit=Number(query.limit??150),before=query.before===undefined?undefined:Number(query.before);
    if(!Number.isFinite(limit)||limit<1||before!==undefined&&(!Number.isSafeInteger(before)||before<0))return unavailable('history_query_invalid');
    if(this.activeReads>=4)return unavailable('history_indexing');
    this.activeReads++;
    let acquired=false;
    let file:string|undefined,handle:Awaited<ReturnType<typeof open>>|undefined;
    try{
      const root=await realpath(ref.agent==='claude'?(this.options.claudeRoot??join(homedir(),'.claude','projects')):(this.options.codexRoot??join(homedir(),'.codex','sessions')));
      let candidates:string[]=[];
      if(ref.kind==='path'){
        if(!isAbsolute(ref.value)||ref.value.includes('\0'))return unavailable('native_path_invalid');
        const f=await realpath(ref.value);if(!inside(root,f)||!f.endsWith('.jsonl'))return unavailable('native_path_outside_root');candidates=[f];
      }else{
        if(!UUID.test(ref.value))return unavailable('native_id_invalid');
        let count=0;const walk=async(dir:string,depth:number)=>{if(depth>8)return;const entries=await opendir(dir);for await(const entry of entries){
          if(++count>(this.options.maxFiles??20_000))throw new ReaderLimit('history_scan_limit');if(entry.isSymbolicLink())continue;
          const f=join(dir,entry.name);if(entry.isDirectory())await walk(f,depth+1);else if(entry.isFile()&&entry.name.endsWith('.jsonl')&&(entry.name===`${ref.value}.jsonl`||entry.name.endsWith(`-${ref.value}.jsonl`)))candidates.push(f);
        }};await walk(root,0);
      }
      if(candidates.length!==1)return unavailable(candidates.length?'native_session_ambiguous':'native_file_missing');
      file=await realpath(candidates[0]);if(!inside(root,file))return unavailable('native_path_outside_root');
      if(this.busy.has(file))return unavailable('history_indexing');this.busy.add(file);acquired=true;
      handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const meta=await handle.stat();
      if(!meta.isFile())return unavailable('history_unavailable');
      if(!Number.isSafeInteger(meta.size)||meta.size<0)return unavailable('history_file_size_invalid');
      const signature=hash([meta.dev,meta.ino,meta.birthtimeMs,meta.size,meta.mtimeMs,meta.ctimeMs]);
      const fileKey=hash([ref.agent,meta.dev,meta.ino,meta.birthtimeMs]);
      const budget=this.options.maxBytes??16*1024*1024;
      if(!Number.isSafeInteger(budget)||budget<1||budget>16*1024*1024)return unavailable('history_read_budget_invalid');
      const readRange=async(offset:number,length:number)=>{
        if(length>budget-readBytes)throw new ReaderLimit('history_page_size_limit');
        const bytes=Buffer.alloc(length);let n=0;while(n<length){const r=await handle!.read(bytes,n,length-n,offset+n);if(!r.bytesRead)throw new ReaderLimit('history_changed');n+=r.bytesRead;readBytes+=r.bytesRead;}return bytes;
      };
      const prior=this.indexes.get(file);
      let idx=prior;
      // Growth is only permission to continue verification, never proof of append.
      // Keep the original ready index/digest and verification cursor until the
      // entire fixed prefix passes; otherwise an active writer restarts us forever.
      if(idx?.verify&&idx.fileKey===fileKey&&meta.size>idx.size){
        idx.signature=signature;idx.size=meta.size;idx.mtime=meta.mtimeMs;
      }else if(!idx||idx.signature!==signature||idx.fileKey!==fileKey){
        const canVerify=prior?.ready&&prior.fileKey===fileKey&&meta.size>=prior.size;
        idx={signature,fileKey,size:meta.size,mtime:meta.mtimeMs,epoch:randomUUID(),rows:[],ranges:[],metadataBytes:0,offset:0,lineStart:0,scratch:Buffer.alloc(0),hasher:createHash('sha256'),committedHasher:createHash('sha256'),ready:false,
          ...(canVerify?{verify:{previous:prior!,offset:0,hasher:createHash('sha256')}}:{})};
        this.indexes.set(file,idx);
        // Metadata is capped per file and globally by a small, bounded LRU.
        while(this.indexes.size>4)this.indexes.delete(this.indexes.keys().next().value!);
      }
      const stable=async()=>{const after=await handle!.stat(),at=await stat(file!);return await realpath(candidates[0])===file&&hash([after.dev,after.ino,after.birthtimeMs,after.size,after.mtimeMs,after.ctimeMs])===signature&&hash([at.dev,at.ino,at.birthtimeMs,at.size,at.mtimeMs,at.ctimeMs])===signature;};
      if(idx.verify){
        const v=idx.verify;
        while(v.offset<v.previous.size&&readBytes<budget){const bytes=await readRange(v.offset,Math.min(CHUNK,v.previous.size-v.offset,budget-readBytes));v.hasher.update(bytes);v.offset+=bytes.length;}
        if(!await stable()){this.indexes.delete(file);return unavailable('history_indexing');}
        if(v.offset<v.previous.size)return unavailable('history_indexing');
        if(v.hasher.digest('hex')===v.previous.fullDigest){
          const old=v.previous;idx.rows=old.rows.slice();idx.ranges=old.ranges.slice();idx.metadataBytes=old.metadataBytes;idx.offset=old.lineStart;idx.lineStart=old.lineStart;
          idx.hasher=old.committedHasher.copy();idx.committedHasher=old.committedHasher.copy();idx.epoch=old.epoch;idx.branch=old.branch;
        }
        // A mismatching prefix rebuilds from zero under a new epoch; never treat it as append.
        delete idx.verify;
      }
      if(!idx.ready){
        while(idx.offset<idx.size&&readBytes<budget){
          const chunk=await readRange(idx.offset,Math.min(CHUNK,idx.size-idx.offset,budget-readBytes));
          let start=0;
          for(let end=chunk.indexOf(10);end!==-1;end=chunk.indexOf(10,start)){
            const part=chunk.subarray(start,end+1);if(idx.scratch.length+part.length>RECORD_CAP)throw new ReaderLimit('history_record_size_limit');
            idx.hasher.update(part);const line=idx.scratch.length?Buffer.concat([idx.scratch,part]):part;
            let row:any;try{row=JSON.parse(line.toString('utf8'));}catch{}
            if(row&&typeof row==='object'){
              const redacted=structure(row),size=Buffer.byteLength(JSON.stringify(redacted));
              if(idx.rows.length>=RECORDS_CAP||idx.metadataBytes+size>META_CAP)throw new ReaderLimit('history_index_size_limit');
              idx.rows.push(redacted);idx.ranges.push({offset:idx.lineStart,length:line.length});idx.metadataBytes+=size;
            }
            idx.lineStart=idx.offset+end+1;idx.scratch=Buffer.alloc(0);idx.committedHasher=idx.hasher.copy();start=end+1;
          }
          const rest=chunk.subarray(start);if(idx.scratch.length+rest.length>RECORD_CAP)throw new ReaderLimit('history_record_size_limit');
          idx.hasher.update(rest);idx.scratch=rest.length?Buffer.concat([idx.scratch,rest]):idx.scratch;idx.offset+=chunk.length;
        }
        if(!await stable()){this.indexes.delete(file);return unavailable('history_indexing');}
        if(idx.offset<idx.size)return unavailable('history_indexing');
        idx.fullDigest=idx.hasher.copy().digest('hex');idx.scratch=Buffer.alloc(0); // incomplete EOF is never an event
        const native=nativeId(ref.agent,idx.rows);
        if(!native||!UUID.test(native)||(ref.kind==='id'&&native!==ref.value)||!(basename(file)===`${native}.jsonl`||ref.agent==='codex'&&basename(file).endsWith(`-${native}.jsonl`)))throw new ReaderLimit('native_metadata_mismatch');
        if(ref.agent==='codex'&&idx.rows.some(e=>e.type==='session_meta'&&e.payload?.id!==native))throw new ReaderLimit('native_metadata_mismatch');
        if(ref.agent==='claude'&&idx.rows.some(e=>e.type==='session_meta'))throw new ReaderLimit('native_provider_mismatch');
        if(ref.agent==='claude'){
          const ids=new Set(idx.rows.filter(e=>!e.isSidechain&&typeof e.uuid==='string').map(e=>e.uuid));
          if(idx.rows.some(e=>!e.isSidechain&&e.parentUuid&&!ids.has(e.parentUuid)))throw new ReaderLimit('history_ancestry_unverified');
        }
        const items=parseHistory(ref.agent,idx.rows),branch=hash([(items as any).branchKey??null,idx.rows.filter(e=>e.type==='event_msg'&&e.payload?.type==='thread_rolled_back')]);
        if(idx.branch&&idx.branch!==branch)idx.epoch=randomUUID();idx.branch=branch;idx.native=native;
        if(items.length>RECORDS_CAP)throw new ReaderLimit('history_index_size_limit');
        idx.entries=items.map(it=>({loc:(it as any)[LOC],...(it.queued===undefined?{}:{queued:it.queued})}));idx.ready=true;
      }
      if(ref.kind==='id'&&idx.native!==ref.value)throw new ReaderLimit('native_metadata_mismatch');
      if(query.epoch&&query.epoch!==idx.epoch&&query.before!==undefined)return unavailable('history_epoch_changed');
      const end=Math.min(idx.entries!.length,before??idx.entries!.length),floor=Math.max(0,end-Math.min(500,Math.floor(limit)));
      // A page is a contiguous suffix ending at before; shorten it by bytes, never skip a record.
      let start=end,pageBytes=0;const selected=new Set<number>();
      while(start>floor){const e=idx.entries![start-1],records=[e.loc.record,...(e.loc.output===undefined?[]:[e.loc.output])];
        const add=[...new Set(records)].filter(i=>!selected.has(i)),cost=add.reduce((n,i)=>n+idx!.ranges[i].length,0);
        if(pageBytes+cost>budget){if(start===end)throw new ReaderLimit('history_page_size_limit');break;}
        add.forEach(i=>selected.add(i));pageBytes+=cost;start--;
      }
      const entries=idx.entries!.slice(start,end),needed=[...selected].sort((a,b)=>a-b);
      if(pageBytes>budget-readBytes)return unavailable('history_indexing'); // indexing completed; page gets a fresh bounded request
      const raw=new Map<number,any>();for(const i of needed){const range=idx.ranges[i];raw.set(i,JSON.parse((await readRange(range.offset,range.length)).toString('utf8')));}
      if(!await stable()){this.indexes.delete(file);return unavailable('history_indexing');}
      const output=entries.map((entry,n)=>{
        const rowIds=[entry.loc.record,...(entry.loc.output===undefined?[]:[entry.loc.output])];
        const candidates=parseHistory(ref.agent,rowIds.map(i=>raw.get(i)),false);
        const item=candidates.find(it=>(it as any)[LOC].record===0&&(it as any)[LOC].slot===entry.loc.slot);
        if(!item)throw new ReaderLimit('history_changed');
        const copy={...item,i:start+n};delete (copy as any)[LOC];if(entry.queued!==undefined)copy.queued=entry.queued;return copy;
      });
      return {ok:true,kind:'messages',epoch:idx.epoch,total:idx.entries!.length,start,items:output,conversation:idx.native!};
    }catch(e){if(file)this.indexes.delete(file);return unavailable(e instanceof ReaderLimit?e.reason:'history_unavailable');}
    finally{try{if(handle)await handle.close();}finally{if(acquired&&file)this.busy.delete(file);this.lastReadBytes=readBytes;this.activeReads--;}}
  }
}
