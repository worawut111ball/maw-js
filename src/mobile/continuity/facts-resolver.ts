/** Pure reference-data resolver. No filesystem, network, launch, or authorization effects. */
import { createHash } from 'node:crypto';
import { ContinuityError } from './types';

export const FACT_FIELDS = ['goal', 'constraints', 'decisions', 'pendingTasks', 'fileState', 'checks'] as const;
export type FactField = typeof FACT_FIELDS[number];
export interface Event {
  seq:number; sourceId:string; agent:'claude'|'codex'; nativeId:string; role:string; text:string;
  ts?:string; metadata?:Record<string,unknown>;
}
export interface Snapshot {
  roomId:string; roomRevision:number;
  sourceBinding:{agent:'claude'|'codex';nativeId:string;generation:string;cursor:number;model?:string;route?:string};
  throughSeq:number; archivePath:string; archiveHash:string; events:Event[];
}
/** Host must obtain this selection through its trusted UI/service boundary, not transcript metadata. */
export interface SelectionSet {
  version:1; roomId:string; roomRevision:number; archiveHash:string; throughSeq:number; sourceBindingHash:string;
  selections:{field:FactField;seq:number;sourceId:string;agent:'claude'|'codex';nativeId:string;eventHash:string}[];
}
export interface Facts {
  goal:string;constraints:string[];decisions:string[];pendingTasks:string[];fileState:string[];checks:string[];
}
export interface Provenance {
  field:FactField;value:string|string[];seq:number;sourceId:string;agent:'claude'|'codex';nativeId:string;
  role:string;eventHash:string;pointer:string;
}
export type Resolution = {state:'resolved';version:1;facts:Facts;provenance:Provenance[];factsHash:string;
  scope:{roomId:string;roomRevision:number;archiveHash:string;throughSeq:number;sourceBinding:Snapshot['sourceBinding']};
  trust:{authority:'reference-only';permitsActions:false;changesIdentity:false;semanticTruthVerified:false}}
  | {state:'missing'|'conflict'|'invalid';reason:string};
export const FACT_LIMITS = Object.freeze({events:100000,archiveBytes:64*1024*1024,eventBytes:1024*1024,
  selections:256,arrayItems:128,stringBytes:16384,factsBytes:48000,depth:32,nodes:500000});
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const hashPattern=/^[a-f0-9]{64}$/;
const uint=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const id=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=1024&&!/[\0\r\n]/.test(v);
const plain=(v:any):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const keys=(v:object,allowed:readonly string[])=>Object.keys(v).every(k=>allowed.includes(k));
class Invalid extends Error{}
function fail(reason:string):never {throw new Invalid(reason);}
/** Reject accessors/non-JSON values before clone; don't execute getters supplied as "data". */
function jsonData(input:unknown):void {
  let nodes=0;const seen=new Set<object>();
  function walk(v:unknown,depth:number):void {
    if(++nodes>FACT_LIMITS.nodes||depth>FACT_LIMITS.depth)fail('data_limit');
    if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
    if(typeof v!=='object'||(!Array.isArray(v)&&!plain(v))||seen.has(v))fail('non_json_input');
    seen.add(v);
    for(const key of Object.keys(v)){
      if(['__proto__','constructor','prototype'].includes(key))fail('unsafe_key');
      const d=Object.getOwnPropertyDescriptor(v,key)!;
      if(!('value'in d))fail('non_json_input');walk(d.value,depth+1);
    }
    if(Array.isArray(v))for(let i=0;i<v.length;i++)if(!Object.hasOwn(v,i))fail('non_json_input');
    seen.delete(v);
  }
  walk(input,0);
}
function canonical(v:any):string {
  const sorted=(x:any):any=>Array.isArray(x)?x.map(sorted):plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])])):x;
  return JSON.stringify(sorted(v));
}
export function factsBindingHash(binding:Snapshot['sourceBinding']):string { jsonData(binding);return sha(canonical(binding)); }
function text(v:unknown):v is string {
  return typeof v==='string'&&!!v.trim()&&!v.includes('\0')&&Buffer.byteLength(v)<=FACT_LIMITS.stringBytes;
}
/** v1 deliberately accepts compact JSON.stringify output only: duplicate keys/quotes/prose fail closed. */
function envelope(raw:string):Partial<Facts> {
  if(Buffer.byteLength(raw)>FACT_LIMITS.eventBytes)fail('event_limit');
  let v:any;try{v=JSON.parse(raw);}catch{return fail('structured_event_required');}
  if(JSON.stringify(v)!==raw)fail('noncanonical_structured_event');
  jsonData(v);
  if(!plain(v)||!keys(v,['kind','version','facts'])||Object.keys(v).length!==3||v.kind!=='continuity-facts'||v.version!==1||!plain(v.facts)||!keys(v.facts,FACT_FIELDS))fail('facts_schema_invalid');
  for(const [field,value]of Object.entries(v.facts)){
    if(field==='goal'){if(!text(value))fail('facts_value_invalid');}
    else if(!Array.isArray(value)||value.length>FACT_LIMITS.arrayItems||!value.every(text))fail('facts_value_invalid');
  }
  return v.facts;
}

export function resolveFacts(snapshot:Snapshot,selection:SelectionSet):Resolution {
  try {
    jsonData({snapshot,selection});
    snapshot=structuredClone(snapshot);selection=structuredClone(selection);
    const s=snapshot,b=s.sourceBinding;
    if(!plain(s)||!keys(s,['roomId','roomRevision','sourceBinding','throughSeq','archivePath','archiveHash','events'])||!id(s.roomId)||!uint(s.roomRevision)||!uint(s.throughSeq)||!hashPattern.test(s.archiveHash)
      ||!id(s.archivePath)||!s.archivePath.startsWith('/')||!plain(b)||!['claude','codex'].includes(b.agent)||!id(b.nativeId)||!id(b.generation)||!uint(b.cursor)
      ||!keys(b,['agent','nativeId','generation','cursor','model','route'])||(b.model!==undefined&&!id(b.model))||(b.route!==undefined&&!id(b.route))
      ||!Array.isArray(s.events)||s.events.length>FACT_LIMITS.events)fail('snapshot_invalid');
    let last=0,bytes=0;const seen=new Set<string>();
    for(const e of s.events){
      if(!plain(e)||!uint(e.seq)||e.seq<=last||!id(e.sourceId)||!id(e.nativeId)||!['claude','codex'].includes(e.agent)||!id(e.role)||typeof e.text!=='string'||e.text.includes('\0'))fail('history_invalid');
      const key=JSON.stringify([e.agent,e.nativeId,e.sourceId]);if(seen.has(key))fail('source_conflict');seen.add(key);last=e.seq;
      bytes+=Buffer.byteLength(JSON.stringify(e))+1;if(bytes>FACT_LIMITS.archiveBytes)fail('archive_limit');
    }
    if(s.throughSeq!==last||b.cursor>last)fail('history_cursor_unavailable');
    if(sha(s.events.map(e=>JSON.stringify(e)).join('\n')+'\n')!==s.archiveHash)fail('archive_hash_mismatch');
    if(!plain(selection)||!keys(selection,['version','roomId','roomRevision','archiveHash','throughSeq','sourceBindingHash','selections'])||selection.version!==1)fail('selection_invalid');
    if(selection.roomId!==s.roomId||selection.roomRevision!==s.roomRevision||selection.archiveHash!==s.archiveHash||selection.throughSeq!==s.throughSeq||selection.sourceBindingHash!==factsBindingHash(b))fail('selection_scope_mismatch');
    if(!Array.isArray(selection.selections)||selection.selections.length>FACT_LIMITS.selections)fail('selection_limit');
    const provenance:Provenance[]=[],selected=new Set<string>();
    for(const pick of selection.selections){
      if(!plain(pick)||!keys(pick,['field','seq','sourceId','agent','nativeId','eventHash'])||!FACT_FIELDS.includes(pick.field)||!uint(pick.seq)||!hashPattern.test(pick.eventHash))fail('selection_invalid');
      const key=canonical(pick);if(selected.has(key))fail('duplicate_selection');selected.add(key);
      const e=s.events.find(e=>e.seq===pick.seq&&e.sourceId===pick.sourceId&&e.agent===pick.agent&&e.nativeId===pick.nativeId);
      if(!e||sha(e.text)!==pick.eventHash)fail('selection_source_mismatch');
      // A trusted explicit selection records a reference claim, even for assistant/tool sources. It grants no authority.
      const values=envelope(e.text),value=values[pick.field];
      if(value===undefined)fail('selected_field_missing');
      provenance.push({field:pick.field,value,seq:e.seq,sourceId:e.sourceId,agent:e.agent,nativeId:e.nativeId,role:e.role,eventHash:pick.eventHash,pointer:'/facts/'+pick.field});
    }
    provenance.sort((a,b)=>FACT_FIELDS.indexOf(a.field)-FACT_FIELDS.indexOf(b.field)||a.seq-b.seq||a.sourceId.localeCompare(b.sourceId));
    const goals=[...new Set(provenance.filter(p=>p.field==='goal').map(p=>p.value as string))];
    if(!goals.length)return {state:'missing',reason:'explicit_goal_missing'};
    if(goals.length!==1)return {state:'conflict',reason:'explicit_goals_conflict'};
    const facts:Facts={goal:goals[0],constraints:[],decisions:[],pendingTasks:[],fileState:[],checks:[]};
    for(const p of provenance)if(p.field!=='goal')facts[p.field].push(...p.value as string[]);
    if(Buffer.byteLength(canonical(facts))>FACT_LIMITS.factsBytes)fail('facts_limit');
    const scope={roomId:s.roomId,roomRevision:s.roomRevision,archiveHash:s.archiveHash,throughSeq:s.throughSeq,sourceBinding:b};
    const trust={authority:'reference-only' as const,permitsActions:false as const,changesIdentity:false as const,semanticTruthVerified:false as const};
    return {state:'resolved',version:1,facts,provenance,scope,trust,factsHash:sha(canonical({version:1,facts,provenance,scope,trust}))};
  }catch(e){return {state:'invalid',reason:e instanceof Invalid?e.message:'input_invalid'};}
}

export type FactCandidate=SelectionSet['selections'][number]&{value:string|string[]};
/** Enumerate structurally valid reference candidates only; never select/approve them. */
export function listFactCandidates(snapshot:Snapshot):FactCandidate[] {
  const check=resolveFacts(snapshot,{version:1,roomId:snapshot.roomId,roomRevision:snapshot.roomRevision,
    archiveHash:snapshot.archiveHash,throughSeq:snapshot.throughSeq,sourceBindingHash:factsBindingHash(snapshot.sourceBinding),selections:[]});
  if(check.state!=='missing'||check.reason!=='explicit_goal_missing')throw new ContinuityError('facts_snapshot_invalid');
  const out:FactCandidate[]=[];
  for(const e of snapshot.events) {
    let fields:Partial<Facts>;
    try{fields=envelope(e.text);}catch{continue;}
    for(const field of FACT_FIELDS)if(fields[field]!==undefined)out.push({field,seq:e.seq,sourceId:e.sourceId,
      agent:e.agent,nativeId:e.nativeId,eventHash:sha(e.text),value:structuredClone(fields[field]!)});
    if(out.length>FACT_LIMITS.selections)throw new ContinuityError('facts_candidates_limit',413);
  }
  return out;
}
