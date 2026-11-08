import { readdir, realpath, open, stat } from 'fs/promises';
import { constants } from 'fs';
import { homedir } from 'os';
import { join, isAbsolute, relative, basename } from 'path';
import { randomUUID } from 'crypto';
import { hash } from './inventory';
import type { ConversationRef, HistoryOptions, HistoryQuery, HistoryItem, HistoryResult } from './types';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inside=(root:string,file:string)=>{const p=relative(root,file);return p!==''&&!p.startsWith('..')&&!isAbsolute(p);};
const cleanText=(v:unknown):string=>typeof v==='string'?v:'';
function events(text:string):any[]{return text.split('\n').filter((line,i,all)=>i<all.length-1||line.endsWith('}')).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});}
function nativeId(agent:string,rows:any[]):string|null {
  if(agent==='codex'){const row=rows.find(v=>v.type==='session_meta');return typeof row?.payload?.id==='string'?row.payload.id:null;}
  const ids=new Set(rows.filter(v=>typeof v.sessionId==='string').map(v=>v.sessionId));return ids.size===1?[...ids][0] as string:null;
}
function parseHistory(agent:string,rows:any[]):HistoryItem[]{
  const items:HistoryItem[]=[], tools=new Map<string,HistoryItem>(), dequeued=new Set<HistoryItem>();
  const push=(it:Omit<HistoryItem,'i'>)=>{const v={...it,i:items.length};items.push(v);return v;};
  const parents=new Map<string,string|null>(), logical=new Set<string>(), turns=new Set<string>(), owners:(string|undefined)[]=[];let leaf:string|undefined;
  for(const e of rows){
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
      const queued=[...dequeued].find(x=>x.text===text&&x.role==='user');if(queued)dequeued.delete(queued);
      if(text.trim()||images.length){if(!queued)push({role:role as 'user'|'assistant',text,ts,...(images.length?{images}:{})});}
    }
    for(const b of content){
      if(b.type==='tool_use'){const v=push({role:['Agent','Task'].includes(b.name)?'agent':'tool',ts,tool:{name:String(b.name),summary:String(b.name),input:JSON.stringify(b.input??{}),output:null,error:false}});tools.set(b.id,v);}
      if(b.type==='tool_result'){const t=tools.get(b.tool_use_id);if(t?.tool){t.tool.output=typeof b.content==='string'?b.content:JSON.stringify(b.content??'');t.tool.error=!!b.is_error;}}
      if(b.type==='thinking'&&typeof b.thinking==='string'&&b.thinking.trim())push({role:'assistant',text:b.thinking,ts});
    }
    if(agent==='codex'&&['function_call','custom_tool_call'].includes(p?.type)){const v=push({role:'tool',ts,tool:{name:String(p.name??'Tool'),summary:String(p.name??'Tool'),input:typeof(p.arguments??p.input)==='string'?(p.arguments??p.input):JSON.stringify(p.arguments??p.input??{}),output:null,error:false}});tools.set(p.call_id,v);}
    if(agent==='codex'&&['function_call_output','custom_tool_call_output'].includes(p?.type)){const t=tools.get(p.call_id);if(t?.tool)t.tool.output=typeof p.output==='string'?p.output:JSON.stringify(p.output??'');}
    for(let j=before;j<items.length;j++)owners[j]=e.uuid;
  }
  // Keep compaction/missing links. Drop only abandoned sibling branches containing a real user turn.
  if(agent==='claude'&&leaf){const children=new Map<string,string[]>();for(const [u,p]of parents)if(p&&!logical.has(u))children.set(p,[...(children.get(p)??[]),u]);const path=new Set<string>();for(let u:string|null|undefined=leaf;u&&!path.has(u);u=parents.get(u))path.add(u);const dead=new Set<string>();
    for(const u of path){const parent=parents.get(u);if(!parent||logical.has(u))continue;for(const sibling of children.get(parent)??[]){if(sibling===u||path.has(sibling))continue;const branch:string[]=[],todo=[sibling],seen=new Set<string>();while(todo.length){const n=todo.pop()!;if(seen.has(n))continue;seen.add(n);branch.push(n);todo.push(...children.get(n)??[]);}if(branch.some(x=>turns.has(x)))branch.forEach(x=>dead.add(x));}}
    const filtered=items.filter((_,i)=>!owners[i]||!dead.has(owners[i]!)).map((v,i)=>({...v,i}));(filtered as any).branchKey=[...dead].sort();return filtered;
  }
  return items;
}
export class HistoryResolver {
  private epochs=new Map<string,{size:number;digest:string;fileKey:string;branch:string;epoch:string}>();
  constructor(private options:HistoryOptions={}){}
  async read(ref:ConversationRef|null,query:HistoryQuery={}):Promise<HistoryResult>{
    const unavailable=(reason:string):HistoryResult=>({ok:true,kind:'none',available:false,reason});
    if(!ref)return unavailable('native_session_missing');
    if(ref.source.startsWith('herdr:')&&ref.source!==`herdr:${ref.agent}`||!(this.options.allowedSources??['herdr:claude','herdr:codex']).includes(ref.source))return unavailable('native_source_unsupported');
    try{
      const root=await realpath(ref.agent==='claude'?(this.options.claudeRoot??join(homedir(),'.claude','projects')):(this.options.codexRoot??join(homedir(),'.codex','sessions')));
      let candidates:string[]=[];
      if(ref.kind==='path'){
        if(!isAbsolute(ref.value)||ref.value.includes('\0'))return unavailable('native_path_invalid');
        const file=await realpath(ref.value);if(!inside(root,file)||!file.endsWith('.jsonl'))return unavailable('native_path_outside_root');candidates=[file];
      }else{
        if(!UUID.test(ref.value))return unavailable('native_id_invalid');
        let count=0;const walk=async(dir:string,depth:number)=>{if(depth>8)return;for(const entry of await readdir(dir,{withFileTypes:true})){if(++count>(this.options.maxFiles??20_000))throw new Error('scan_limit');if(entry.isSymbolicLink())continue;const f=join(dir,entry.name);if(entry.isDirectory())await walk(f,depth+1);else if(entry.isFile()&&entry.name.endsWith('.jsonl')&&(entry.name===`${ref.value}.jsonl`||entry.name.endsWith(`-${ref.value}.jsonl`)))candidates.push(f);}};
        await walk(root,0);
      }
      if(candidates.length!==1)return unavailable(candidates.length?'native_session_ambiguous':'native_file_missing');
      const file=await realpath(candidates[0]);if(!inside(root,file))return unavailable('native_path_outside_root');
      const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
      let body:Buffer,meta:any;
      try{meta=await handle.stat();if(!meta.isFile()||meta.size>(this.options.maxBytes??64*1024*1024))return unavailable('history_size_limit');
        body=Buffer.alloc(meta.size);let offset=0;while(offset<body.length){const {bytesRead}=await handle.read(body,offset,body.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
        const after=await handle.stat();const again=await realpath(candidates[0]),atPath=await stat(file);
        if(offset!==body.length||again!==file||atPath.ino!==meta.ino||atPath.dev!==meta.dev||after.ino!==meta.ino||after.size!==body.length||after.mtimeMs!==meta.mtimeMs)return unavailable('history_changed');
      }finally{await handle.close();}
      const rows=events(body!.toString('utf8')), native=nativeId(ref.agent,rows);
      if(!native||!UUID.test(native)||(ref.kind==='id'&&native!==ref.value)||!(basename(file)===`${native}.jsonl`||ref.agent==='codex'&&basename(file).endsWith(`-${native}.jsonl`)))return unavailable('native_metadata_mismatch');
      if(ref.agent==='claude'&&rows.some(e=>e.type==='session_meta'))return unavailable('native_provider_mismatch');
      const items=parseHistory(ref.agent,rows),fileKey=hash([ref.agent,native,meta.dev,meta.ino,meta.birthtimeMs]);
      const branch=hash([(items as any).branchKey??null,rows.filter(e=>e.type==='event_msg'&&e.payload?.type==='thread_rolled_back')]);
      const previous=this.epochs.get(file),unchanged=previous&&previous.fileKey===fileKey&&previous.branch===branch&&body!.length>=previous.size&&hash(body!.subarray(0,previous.size).toString('utf8'))===previous.digest;
      const epoch=unchanged?previous.epoch:randomUUID();
      this.epochs.set(file,{fileKey,branch,size:body!.length,digest:hash(body!.toString('utf8')),epoch});
      if(this.epochs.size>128)this.epochs.delete(this.epochs.keys().next().value!);
      if(query.epoch&&query.epoch!==epoch&&query.before!==undefined)return unavailable('history_epoch_changed');
      const limit=Number(query.limit??150),before=Number(query.before??items.length);
      if(!Number.isFinite(limit)||!Number.isFinite(before)||limit<1||before<0)return unavailable('history_query_invalid');
      const end=Math.min(items.length,Math.floor(before)),start=Math.max(0,end-Math.min(500,Math.floor(limit)));
      return {ok:true,kind:'messages',epoch,total:items.length,start,items:items.slice(start,end),conversation:native};
    }catch{return unavailable('history_unavailable');}
  }
}
