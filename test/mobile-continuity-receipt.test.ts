import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareReceipt, verifyReceipt, type PreparedReceipt } from '../src/mobile/continuity/context-receipt';
import { parseNativeRecords, type NativeRecords } from '../src/mobile/continuity/native-records';
import { ContinuityArchive } from '../src/mobile/continuity/archive';
import { buildContext } from '../src/mobile/continuity/context';
const native='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',cwd='/home/example/project';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
async function setup(){
 const root=mkdtempSync(join(tmpdir(),'continuity-receipt-'));roots.push(root);
 const facts={goal:'รับข้อมูลตัวอย่างแล้วรอผู้ใช้',constraints:['ห้ามแก้ไฟล์'],pendingTasks:['ตรวจหลักฐาน'],nested:{path:'ตัวอย่าง/with spaces.txt',count:2},flags:[true,null,'1']};
 const context=buildContext({room:{id:'room-example',workspace:'ws-demo',room:'pane-demo',backend:'herdr',cwd,revision:0,active:'codex',bindings:{codex:{agent:'codex',nativeId:native,generation:'process-original',cursor:0}}},events:[{seq:1,sourceId:'source-original',agent:'codex',nativeId:native,role:'user',text:'ข้อมูลอ้างอิงเท่านั้น'}],facts:{goal:facts.goal,constraints:facts.constraints,decisions:[],pendingTasks:facts.pendingTasks,fileState:[],checks:[]},handoffId:'operation-example',archivePath:join(root,'private-archive.jsonl')});
 const input={context,roomId:'room-example',nativeId:native,generation:'current-process',expectedFacts:facts,privateRoot:root,operationId:'operation-example'};
 const prepared=await prepareReceipt(input),challenge=JSON.parse(readFileSync(prepared.manifest.challengePath,'utf8'));
 return {root,facts,input,prepared,challenge};
}
function response(p:PreparedReceipt,token:string,facts:unknown){return {disposition:'accepted-reference',contextHash:p.manifest.contextHash,throughSeq:p.manifest.throughSeq,retrievalToken:token,facts,summary:'รับข้อมูลอ้างอิงแล้ว รอผู้ใช้สั่งตรวจหลักฐาน'};}
function records(agent:'claude'|'codex',p:PreparedReceipt,reply:unknown,options:{toolName?:string;path?:string;output?:string;isError?:boolean;omitTools?:boolean;userText?:string;hidden?:string;finalText?:string;omitErrorFlag?:boolean;fileEvidence?:boolean;fileEvidencePatch?:Record<string,unknown>;fileEvidenceType?:string;reads?:{path:string;output:string;offset?:number;limit?:number}[]}={}):NativeRecords {
 const content=options.finalText??JSON.stringify(reply),callId='read-challenge',path=options.path??(p.manifest.challengePath??p.manifest.contextPath),output=options.output??readFileSync(p.manifest.challengePath??p.manifest.contextPath,'utf8');
 let rows:any[];
 if(agent==='claude'){
  const row=(type:string,uuid:string,parentUuid:string|null,value:any,stop='end_turn')=>({type,uuid,parentUuid,sessionId:native,cwd,message:{role:type,content:value,...(type==='assistant'?{stop_reason:stop}:{})}});
  rows=[row('user','user-exact',null,options.userText??p.requestText)];
  if(!options.omitTools){let parent='user-exact';for(const [i,r] of (options.reads??[{path,output}]).entries()){const id=callId+i,call='call-'+i,result='result-'+i;rows.push(row('assistant',call,parent,[{type:'tool_use',id,name:options.toolName??'Read',input:{file_path:r.path,...(r.offset?{offset:r.offset}:{}),...(r.limit?{limit:r.limit}:{})}}],'tool_use'));const resultRow:any=row('user',result,call,[{type:'tool_result',tool_use_id:id,...(options.omitErrorFlag?{}:{is_error:options.isError??false}),content:r.output}]);if(options.fileEvidence){const nativeLines=readFileSync(r.path,'utf8').split('\n'),start=r.offset??1,selected=nativeLines.slice(start-1,start-1+(r.limit??nativeLines.length));resultRow.toolUseResult={type:options.fileEvidenceType??'text',file:{filePath:r.path,content:selected.join('\n'),startLine:start,numLines:selected.length,totalLines:nativeLines.length,...options.fileEvidencePatch}};}rows.push(resultRow);parent=result;}}
  if(options.hidden)rows.push(row('assistant','hidden-record',options.omitTools?'user-exact':'result-'+((options.reads?.length??1)-1),[{type:'thinking',thinking:options.hidden}]));
  rows.push(row('assistant','assistant-final',options.hidden?'hidden-record':options.omitTools?'user-exact':'result-'+((options.reads?.length??1)-1),[{type:'text',text:content}]));
 }else{
  rows=[{type:'session_meta',payload:{id:native,cwd}},{type:'event_msg',payload:{type:'task_started',turn_id:'turn-exact'}},{type:'turn_context',payload:{turn_id:'turn-exact',cwd}},{type:'response_item',payload:{type:'message',id:'user-exact',role:'user',content:[{type:'input_text',text:options.userText??p.requestText}]}}];
  if(!options.omitTools){for(const [i,r] of (options.reads??[{path,output}]).entries()){rows.push({type:'response_item',payload:{type:'function_call',call_id:callId+i,name:options.toolName??'Read',arguments:JSON.stringify({path:r.path,...(r.offset?{offset:r.offset}:{}),...(r.limit?{limit:r.limit}:{})})}});rows.push({type:'response_item',payload:{type:'function_call_output',call_id:callId+i,is_error:options.isError??false,output:r.output}});}}
  if(options.hidden)rows.push({type:'response_item',payload:{type:'reasoning',summary:[{text:options.hidden}],encrypted_content:options.hidden}});
  rows.push({type:'response_item',payload:{type:'message',id:'assistant-final',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:content}]}},{type:'event_msg',payload:{type:'task_complete',turn_id:'turn-exact'}});
 }
 return parseNativeRecords(agent,native,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
}
const verify=(h:Awaited<ReturnType<typeof setup>>,data:NativeRecords)=>verifyReceipt(h.prepared.manifest,data,data.lastUserSourceId!);

describe('Private immutable receipt preparation',()=>{
 test('creates independent private challenge/context files without leaking token to request or manifests',async()=>{const h=await setup();for(const path of [h.prepared.manifest.contextPath,h.prepared.manifest.challengePath])expect(statSync(path).mode&0o777).toBe(0o600);expect(statSync(h.prepared.manifest.privateRoot).mode&0o777).toBe(0o700);expect(h.prepared.requestText).not.toContain(h.challenge.retrievalToken);expect(JSON.stringify(h.prepared.modelManifest)).not.toContain(h.challenge.retrievalToken);expect(JSON.stringify(h.prepared.manifest)).not.toContain(h.challenge.retrievalToken);expect(Object.keys(h.prepared.modelManifest).sort()).toEqual(['challengePath','contextPath']);expect(sha(readFileSync(h.prepared.manifest.challengePath,'utf8'))).toBe(h.prepared.manifest.challengeHash);});
 test('re-preparing the same operation creates new artifacts and never overwrites old challenge',async()=>{const h=await setup(),old=readFileSync(h.prepared.manifest.challengePath,'utf8'),next=await prepareReceipt(h.input);expect(next.manifest.challengePath).not.toBe(h.prepared.manifest.challengePath);expect(readFileSync(h.prepared.manifest.challengePath,'utf8')).toBe(old);expect(JSON.parse(readFileSync(next.manifest.challengePath,'utf8')).retrievalToken).not.toBe(h.challenge.retrievalToken);});
 test('rejects incorrect context digest, room/operation/cursor binding and unprovable cwd before creating an artifact',async()=>{const h=await setup();await expect(prepareReceipt({...h.input,context:{...h.input.context,hash:'0'.repeat(64)}})).rejects.toThrow('receipt_context_invalid');for(const over of [{roomId:'another-room'},{operationId:'another-operation'},{context:{...h.input.context,throughSeq:2}}])await expect(prepareReceipt({...h.input,...over})).rejects.toThrow('receipt_context_binding_mismatch');const text='reference without trusted cwd header';await expect(prepareReceipt({...h.input,context:{text,hash:sha(text),throughSeq:1}})).rejects.toThrow('receipt_context_header_invalid');});
});

describe('Native-turn Read and copied-facts receipt verification',()=>{
 for(const agent of ['claude','codex'] as const)test(`${agent}: real native parser proves only challenge Read and exact copied facts`,async()=>{const h=await setup(),reply=response(h.prepared,h.challenge.retrievalToken,h.facts),data=records(agent,h.prepared,reply),result=await verify(h,data);expect(result.verified).toBe(true);if(!result.verified||result.mode==='native-full-retrieval')return;expect(result.proof).toMatchObject({readChallenge:true,copiedFacts:true,contextRetrievalVerified:false,archiveRetrievalVerified:false,semanticUnderstanding:false});expect(result.proof.userSourceId).toBe(data.lastUserSourceId!);expect(JSON.stringify(result)).not.toContain(h.challenge.retrievalToken);expect(result.summary).toBe(reply.summary);});
 test('facts deep equality ignores object key order but rejects scalar/array/detail changes',async()=>{const h=await setup();const reordered={flags:h.facts.flags,nested:{count:2,path:h.facts.nested.path},pendingTasks:h.facts.pendingTasks,constraints:h.facts.constraints,goal:h.facts.goal};expect((await verify(h,records('claude',h.prepared,response(h.prepared,h.challenge.retrievalToken,reordered)))).verified).toBe(true);for(const wrong of [{...h.facts,nested:{...h.facts.nested,count:'2'}},{...h.facts,flags:[null,true,'1']},{goal:h.facts.goal}])expect((await verify(h,records('claude',h.prepared,response(h.prepared,h.challenge.retrievalToken,wrong)))).verified).toBe(false);});
 test('token echoed in final/user or hidden reasoning without successful Read is not proof',async()=>{const h=await setup(),reply=response(h.prepared,h.challenge.retrievalToken,h.facts);for(const agent of ['claude','codex'] as const){const data=records(agent,h.prepared,reply,{omitTools:true,hidden:h.challenge.retrievalToken});expect(JSON.stringify(data)).not.toContain('encrypted_content');expect((await verify(h,data)).verified).toBe(false);}const noToken=records('claude',h.prepared,reply,{output:'read output without the token',hidden:h.challenge.retrievalToken});expect((await verify(h,noToken)).verified).toBe(false);});
 test('native UUID/cwd, exact user text and exact source identity all have to match',async()=>{const h=await setup(),good=records('claude',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts));for(const data of [{...good,nativeId:other},{...good,cwd:'/home/example/other'}])expect((await verify(h,data)).verified).toBe(false);expect((await verify(h,records('claude',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts),{userText:h.prepared.requestText+' '}))).verified).toBe(false);expect((await verifyReceipt(h.prepared.manifest,good,'wrong-source')).verified).toBe(false);});
 test('pending tools, incomplete/interrupted/refused/unknown completion never pass',async()=>{const h=await setup(),good=records('codex',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts));for(const change of [{turnComplete:false},{turnComplete:undefined},{pendingTools:true},{pendingTools:undefined},{refused:true},{interrupted:true}])expect((await verify(h,{...good,...change} as NativeRecords)).verified).toBe(false);});
 test('assistant final must correspond to its exact native event and the latest user turn',async()=>{const h=await setup(),good=records('claude',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts));for(const change of [{final:false},{replyToSourceId:'another-prompt'},{replyToIndex:999},{sourceId:'fabricated-reply'}]){const data=structuredClone(good);Object.assign(data.assistantMessages[0],change);expect((await verify(h,data)).verified).toBe(false);}const next=structuredClone(good);next.events.push({sourceId:'later-user',index:99,role:'user',text:'new instruction'});expect((await verify(h,next)).verified).toBe(false);});
 test('wrong tool, wrong path, failed/unknown Read and foreign-turn token are rejected',async()=>{const h=await setup(),reply=response(h.prepared,h.challenge.retrievalToken,h.facts);for(const options of [{toolName:'Bash'},{path:join(h.root,'unrelated.json')},{isError:true}])expect((await verify(h,records('codex',h.prepared,reply,options)))).toMatchObject({verified:false});const good=records('claude',h.prepared,reply);for(const which of ['unknown-success','foreign-turn','input-mismatch']){const data=structuredClone(good),result=data.events.find(e=>e.metadata?.phase==='result')!;if(which==='unknown-success')delete result.metadata!.resultError;if(which==='foreign-turn')result.metadata!.replyToSourceId='old-user';if(which==='input-mismatch')result.metadata!.toolInput={file_path:h.prepared.manifest.contextPath};expect((await verify(h,data)).verified).toBe(false);}});
 test('any non-Read tool in the receipt turn blocks acceptance even if challenge was also read',async()=>{const h=await setup(),data=records('claude',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts));const tool=structuredClone(data.events.find(e=>e.metadata?.phase==='call')!);tool.sourceId+='-write';tool.metadata!.toolName='Write';tool.metadata!.toolCallId='write-disallowed';data.events.splice(2,0,tool);expect((await verify(h,data)).verified).toBe(false);});
 test('assistant JSON requires accepted-reference, exact hash/cursor/token and nonempty summary',async()=>{const h=await setup(),reply=response(h.prepared,h.challenge.retrievalToken,h.facts);for(const patch of [{disposition:'unknown'},{disposition:'rejected'},{contextHash:'0'.repeat(64)},{throughSeq:2},{retrievalToken:'x'.repeat(43)},{summary:'   '},{extraAuthority:true}])expect((await verify(h,records('claude',h.prepared,{...reply,...patch}))).verified).toBe(false);const invalid=records('claude',h.prepared,'not a JSON object');expect((await verify(h,invalid)).verified).toBe(false);});
 test('read result must genuinely contain token and match its public output, not injected metadata',async()=>{const h=await setup(),data=records('claude',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts));const result=data.events.find(e=>e.metadata?.phase==='result')!;result.text='result text did not contain the challenge';expect((await verify(h,data)).verified).toBe(false);});
 test('changing challenge/context bytes or symlink replacement invalidates a previous proof',async()=>{for(const artifact of ['challengePath','contextPath'] as const){const h=await setup(),data=records('claude',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts));writeFileSync(h.prepared.manifest[artifact],'tampered',{mode:0o600});expect((await verify(h,data)).verified).toBe(false);}const h=await setup(),data=records('claude',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts)),outside=join(h.root,'outside.json');writeFileSync(outside,readFileSync(h.prepared.manifest.challengePath),{mode:0o600});unlinkSync(h.prepared.manifest.challengePath);symlinkSync(outside,h.prepared.manifest.challengePath);expect((await verify(h,data)).verified).toBe(false);});
 test('trusted manifest tampering, unavailable/private artifacts and mutated caller facts fail closed',async()=>{const h=await setup(),data=records('codex',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts));for(const patch of [{roomId:'another-room'},{generation:'replacement-process'},{expectedFacts:{only:'different'}}])expect((await verifyReceipt({...h.prepared.manifest,...patch},data,data.lastUserSourceId!)).verified).toBe(false);chmodSync(h.prepared.manifest.challengePath,0o644);expect((await verify(h,data)).verified).toBe(false);expect(existsSync(h.prepared.manifest.challengePath)).toBe(true);});
});

 test('cwd remains bound to the immutable challenge even if both manifest and supplied records are changed',async()=>{const h=await setup(),data=records('claude',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts));const otherCwd='/home/example/other';expect((await verifyReceipt({...h.prepared.manifest,cwd:otherCwd},{...data,cwd:otherCwd},data.lastUserSourceId!)).verified).toBe(false);});

async function retrievalSetup(count=3,large=false){
 const h=await setup(),archive=new ContinuityArchive(join(h.root,'archive'));
 const events=Array.from({length:count},(_,i)=>({seq:i+1,sourceId:'archive-source-'+i,agent:'codex' as const,nativeId:native,role:'user' as const,text:('ข้อมูล archive '+i+'\nข้อความบรรทัดถัดไป').repeat(large?500:1)}));
 const archivePath=archive.snapshot(h.input.roomId,events);
 const context=buildContext({room:{id:h.input.roomId,workspace:'ws-demo',room:'pane-demo',backend:'herdr',cwd,revision:0,active:'codex',bindings:{}},events,facts:{goal:'อ่านหลักฐาน',constraints:[],decisions:[],pendingTasks:[],fileState:[],checks:[]},handoffId:h.input.operationId,archivePath,...(large?{maxBytes:8000}:{})});
 const input={...h.input,context,retrieval:{archiveRoot:archive.root,required:true}};
 const prepared=await prepareReceipt(input),challenge=JSON.parse(readFileSync(prepared.manifest.challengePath,'utf8'));
 return {...h,input,prepared,challenge,archivePath};
}
function allReads(h:Awaited<ReturnType<typeof retrievalSetup>>){return [h.prepared.manifest.challengePath,h.prepared.manifest.contextPath,h.archivePath].map(path=>({path,output:readFileSync(path,'utf8')}));}
const numbered=(text:string,offset=1)=>text.replace(/\n$/,'').split('\n').map((s,i)=>`${String(i+offset).padStart(6)}→${s}`).join('\n');

describe('Full context/archive retrieval with real immutable archive and real native parser',()=>{
 for(const agent of ['claude','codex'] as const)test(`${agent}: exact complete outputs yield separate path/hash/cursor proof without semantic claim`,async()=>{
  const h=await retrievalSetup(),data=records(agent,h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts),{reads:allReads(h)}),result=await verify(h,data);
  expect(result.verified).toBe(true);if(!result.verified||result.mode==='native-full-retrieval')return;
  expect(result.proof.contextRetrievalVerified).toBe(false);
  expect(result.retrievalProof).toMatchObject({contextRetrievalVerified:true,archiveRetrievalVerified:true,semanticUnderstanding:false,firstSeq:1,throughSeq:3,eventCount:3,context:{hash:h.input.context.hash,complete:true},archive:{path:h.archivePath,complete:true}});
  expect(result.retrievalProof?.context.reads.length).toBe(1);expect(result.retrievalProof?.archive.reads[0].nativeOutputHash).toBe(sha(readFileSync(h.archivePath,'utf8')));
  expect(JSON.stringify(result)).not.toContain(h.challenge.retrievalToken);expect(JSON.stringify(result)).not.toContain('ข้อความบรรทัดถัดไป');
 });
 test('required archive missing is rejected, legacy missing remains limited, actual archive automatically upgrades unchanged API',async()=>{
  const old=await setup();await expect(prepareReceipt({...old.input,retrieval:{archiveRoot:join(old.root,'missing'),required:true}})).rejects.toThrow('receipt_archive_unavailable');
  expect(old.prepared.manifest.retrieval).toBeUndefined();
  const h=await retrievalSetup(),{retrieval,...unchanged}=h.input,auto=await prepareReceipt(unchanged);expect(auto.manifest.retrieval?.archive.path).toBe(h.archivePath);
 });
 test('challenge-only, either missing file, preview and content hashes alone never prove retrieval',async()=>{
  const h=await retrievalSetup(),reads=allReads(h),reply=response(h.prepared,h.challenge.retrievalToken,h.facts);
  for(const attempted of [[reads[0]],[reads[0],reads[1]],[reads[0],reads[2]],[reads[0],{...reads[1],output:sha(reads[1].output)},reads[2]],[reads[0],reads[1],{...reads[2],output:reads[2].output.split('\n')[0]+'\n'}]])expect((await verify(h,records('codex',h.prepared,reply,{reads:attempted}))).verified).toBe(false);
 });
 test('numbered Read chunks must cover every line, with no missing middle or wrong offset',async()=>{
  const h=await retrievalSetup(),reads=allReads(h),lines=reads[2].output.trimEnd().split('\n');
  const chunks=[reads[0],{...reads[1],output:numbered(reads[1].output)},...lines.map((line,i)=>({path:h.archivePath,offset:i+1,limit:1,output:numbered(line,i+1)}))];
  const result=await verify(h,records('claude',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts),{reads:chunks}));expect(result.verified).toBe(true);if(result.verified)expect(result.retrievalProof?.archive.reads.map(r=>r.firstLine)).toEqual([1,2,3]);
  for(const bad of [chunks.filter((_,i)=>i!==3),chunks.map((r,i)=>i===3?{...r,offset:1}:r),chunks.map((r,i)=>i===3?{...r,output:r.output+'\n[truncated]'}:r)])expect((await verify(h,records('claude',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts),{reads:bad}))).verified).toBe(false);
 });
 test('raw chunks and documented text envelopes pass only on exact bytes; truncated or unknown envelopes fail closed',async()=>{
  const h=await retrievalSetup(),reads=allReads(h),lines=reads[2].output.trimEnd().split('\n');
  const chunks=[reads[0],{...reads[1],output:JSON.stringify({text:reads[1].output,exit_code:0})},...lines.map((line,i)=>({path:h.archivePath,offset:i+1,limit:1,output:line+'\n'}))];
  expect((await verify(h,records('codex',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts),{reads:chunks}))).verified).toBe(true);
  for(const wrap of [{text:reads[1].output,truncated:true},{text:reads[1].output,unknown:'ignored?'},{text:reads[1].output,exit_code:1}])expect((await verify(h,records('codex',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts),{reads:[reads[0],{...reads[1],output:JSON.stringify(wrap)},reads[2]]}))).verified).toBe(false);
 });
 for(const count of [0,1])test(`native JSON normalization and empty archive remain exact (${count} events)`,async()=>{
  const h=await retrievalSetup(count);for(const agent of ['claude','codex'] as const){const result=await verify(h,records(agent,h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts),{reads:allReads(h)}));expect(result.verified).toBe(true);if(result.verified&&count===1)expect(result.retrievalProof?.archive.reads[0].format).toBe('native-jsonl-object');}
 });
 test('archive bytes, manifest metadata and same-turn/cwd/process evidence cannot be substituted',async()=>{
  const h=await retrievalSetup(),good=records('codex',h.prepared,response(h.prepared,h.challenge.retrievalToken,h.facts),{reads:allReads(h)});
  for(const patch of [{throughSeq:999},{firstSeq:2},{eventCount:1},{archive:{...h.prepared.manifest.retrieval!.archive,hash:'0'.repeat(64)}}]){
   const manifest=structuredClone(h.prepared.manifest);Object.assign(manifest.retrieval!,patch);expect((await verifyReceipt(manifest,good,good.lastUserSourceId!)).verified).toBe(false);
  }
  for(const patch of [{replyToSourceId:'earlier-turn'},{resultError:true}]){const data=structuredClone(good),result=data.events.filter(e=>e.metadata?.phase==='result').at(-1)!;Object.assign(result.metadata!,patch);expect((await verify(h,data)).verified).toBe(false);}
  writeFileSync(h.archivePath,'changed\n',{mode:0o600});expect((await verify(h,good)).verified).toBe(false);
 });
 test('wrong archive room/root, cursor/count and projected context events are rejected at preparation',async()=>{
  const h=await retrievalSetup();await expect(prepareReceipt({...h.input,roomId:'other-room'})).rejects.toThrow();
  await expect(prepareReceipt({...h.input,retrieval:{archiveRoot:h.root,required:true}})).rejects.toThrow('receipt_archive_scope');
  for(const patch of [{throughSeq:4},{archiveEventCount:2},{retrieval:{path:h.archivePath,format:'jsonl',lookup:'seq',availableThrough:2}},{events:[]}]){
   const [prefix,body]=h.input.context.text.split('\n'),header={...JSON.parse(body),...patch},text=prefix+'\n'+JSON.stringify(header);
   await expect(prepareReceipt({...h.input,context:{text,hash:sha(text),throughSeq:header.throughSeq}})).rejects.toThrow();
  }
 });
});

 test('context omission cannot hide archive content from mandatory full retrieval',async()=>{
  const h=await retrievalSetup(3,true);expect(h.input.context.omitted).toEqual([1,2,3]);
  const reads=allReads(h),reply=response(h.prepared,h.challenge.retrievalToken,h.facts);
  expect((await verify(h,records('claude',h.prepared,reply,{reads}))).verified).toBe(true);
  expect((await verify(h,records('claude',h.prepared,reply,{reads:reads.slice(0,2)}))).verified).toBe(false);
 });
 test('archive replacement by symlink or another immutable version fails closed',async()=>{
  const h=await retrievalSetup(),reads=allReads(h),reply=response(h.prepared,h.challenge.retrievalToken,h.facts);
  const changed=reads.map((r,i)=>i===2?{...r,output:r.output.replace('archive 1','archive 9')}:r);
  expect((await verify(h,records('codex',h.prepared,reply,{reads:changed}))).verified).toBe(false);
  const copy=join(h.root,'archive-copy');writeFileSync(copy,reads[2].output,{mode:0o600});unlinkSync(h.archivePath);symlinkSync(copy,h.archivePath);
  expect((await verify(h,records('codex',h.prepared,reply,{reads}))).verified).toBe(false);
 });

for(const agent of ['claude','codex'] as const)test(`${agent}: token in summary is rejected before public receipt, including full retrieval`,async()=>{
 for(const full of [false,true]){
  const h=full?await retrievalSetup():await setup(),token=h.challenge.retrievalToken;
  const options=full?{reads:allReads(h as Awaited<ReturnType<typeof retrievalSetup>>)}:{};
  // A valid full Read receipt remains accepted; the summary guard does not relax retrieval checks.
  const valid=response(h.prepared,token,h.facts);
  expect((await verify(h,records(agent,h.prepared,valid,options))).verified).toBe(true);
  for(const summary of [token,`ข้อมูลอ้างอิง ${token} รอผู้ใช้`,JSON.stringify({retrievalToken:token})]){
   const rejected=await verify(h,records(agent,h.prepared,{...valid,summary},options));
   expect(rejected).toEqual({verified:false,state:'rejected',reason:'receipt_summary_contains_token'});
   expect(JSON.stringify(rejected)).not.toContain(token);
   expect(rejected).not.toHaveProperty('summary');
   expect(rejected).not.toHaveProperty('retrievalProof');
  }
 }
});

async function nativeRetrievalSetup(referenceKind?:'synthetic'|'room-context',count=3){
 const h=await retrievalSetup(count);
 const input={...h.input,mode:'native-full-retrieval' as const,version:1 as const,retrieval:{...h.input.retrieval,required:true as const},...(referenceKind?{referenceKind}:{})};
 const prepared=await prepareReceipt(input);
 const reads=[prepared.manifest.contextPath,prepared.manifest.retrieval.archive.path].map(path=>({path,output:readFileSync(path,'utf8')}));
 return {...h,input,prepared,reads};
}
const verifyNative=(h:Awaited<ReturnType<typeof nativeRetrievalSetup>>,data:NativeRecords)=>verifyReceipt(h.prepared.manifest,data,data.lastUserSourceId!);
describe('Opt-in native-full-retrieval protocol v1',()=>{
 for(const agent of ['claude','codex'] as const)test(`${agent}: two actual full Reads and ordinary final prose verify independent retrieval only`,async()=>{
  const h=await nativeRetrievalSetup('synthetic'),summary='อ่านไฟล์อ้างอิงทั้งสองแล้ว มีข้อมูลทดสอบสามเหตุการณ์ รอคำสั่งถัดไป';
  const result=await verifyNative(h,records(agent,h.prepared,null,{reads:h.reads,finalText:summary}));
  expect(result).toMatchObject({verified:true,state:'verified',mode:'native-full-retrieval',version:1,acceptance:'unassessed',nativeId:native,generation:h.input.generation,contextHash:h.input.context.hash,throughSeq:3,summary,retrievalProof:{contextRetrievalVerified:true,archiveRetrievalVerified:true,semanticUnderstanding:false}});
  expect(result).not.toHaveProperty('proof');expect(result).not.toHaveProperty('disposition');
  expect(h.prepared.manifest).not.toHaveProperty('challengePath');expect(h.prepared.manifest).not.toHaveProperty('retrievalTokenHash');
  expect(h.prepared.manifest).not.toHaveProperty('expectedFacts');expect(existsSync(join(h.prepared.manifest.privateRoot,'challenge.json'))).toBe(false);
  expect(h.prepared.modelManifest).toEqual({contextPath:h.prepared.manifest.contextPath,archivePath:h.archivePath});
  expect(h.prepared.requestText).not.toContain('retrievalToken');expect(h.prepared.requestText).not.toContain('ไม่ใช่ความลับ');
  expect(statSync(h.prepared.manifest.bindingPath).mode&0o777).toBe(0o600);
 });
 test('provenance defaults to room-context; only trusted synthetic opt-in changes request wording',async()=>{
  const normal=await nativeRetrievalSetup(),synthetic=await nativeRetrievalSetup('synthetic');
  expect(normal.prepared.manifest.referenceKind).toBe('room-context');expect(normal.prepared.requestText).toContain('ข้อมูลอ้างอิงของห้องนี้');expect(normal.prepared.requestText).not.toContain('ข้อมูลทดสอบสังเคราะห์');
  expect(synthetic.prepared.requestText).toContain('ข้อมูลทดสอบสังเคราะห์');
  const manifest=structuredClone(normal.prepared.manifest);manifest.referenceKind='synthetic';const data=records('claude',normal.prepared,null,{reads:normal.reads,finalText:'อ่านแล้ว'});
  expect((await verifyReceipt(manifest,data,data.lastUserSourceId!)).verified).toBe(false);
 });
 test('missing opt-in version/required retrieval and unknown protocols are rejected before preparation',async()=>{
  const h=await nativeRetrievalSetup();
  for(const patch of [{version:undefined},{version:2},{mode:'unknown'},{retrieval:undefined},{retrieval:{archiveRoot:h.input.retrieval.archiveRoot,required:false}},{referenceKind:'model-asserted'}])await expect(prepareReceipt({...h.input,...patch} as any)).rejects.toThrow();
  const old=await setup();expect(old.prepared.manifest.mode).not.toBe('native-full-retrieval');
  const legacyData=records('claude',old.prepared,null,{reads:[{path:old.prepared.manifest.contextPath,output:readFileSync(old.prepared.manifest.contextPath,'utf8')}],finalText:'อ่านแล้ว'});
  expect((await verify(old,legacyData))).toMatchObject({verified:false,reason:'receipt_response_not_json'});
 });
 for(const agent of ['claude','codex'] as const)test(`${agent}: no Reads, partial files, unknown success and nonRead cannot substitute for full retrieval`,async()=>{
  const h=await nativeRetrievalSetup(),summary='สรุปธรรมดา ไม่ใช่หลักฐานว่าอ่านแล้ว';
  for(const options of [{omitTools:true},{reads:[h.reads[0]]},{reads:[h.reads[1]]},{reads:[h.reads[0],{...h.reads[1],output:sha(h.reads[1].output)}]},{reads:h.reads,isError:true},{reads:h.reads,toolName:'Bash'}])expect((await verifyNative(h,records(agent,h.prepared,null,{...options,finalText:summary}))).verified).toBe(false);
  const good=records(agent,h.prepared,null,{reads:h.reads,finalText:summary});delete good.events.find(e=>e.metadata?.phase==='result')!.metadata!.resultError;expect((await verifyNative(h,good)).verified).toBe(false);
 });
 test('mode/version/request/generation/cursor changes cannot reuse an existing immutable manifest',async()=>{
  const h=await nativeRetrievalSetup(),good=records('codex',h.prepared,null,{reads:h.reads,finalText:'ข้อมูลอ้างอิงครบแล้ว'});
  for(const patch of [{mode:undefined},{mode:'challenge-receipt'},{mode:'unknown'},{version:2},{generation:'replacement'},{throughSeq:4},{requestHash:'0'.repeat(64)},{retrieval:undefined},{bindingHash:'0'.repeat(64)}])expect((await verifyReceipt({...h.prepared.manifest,...patch} as any,good,good.lastUserSourceId!)).verified).toBe(false);
  const legacy=await retrievalSetup(),legacyGood=records('claude',legacy.prepared,response(legacy.prepared,legacy.challenge.retrievalToken,legacy.facts),{reads:allReads(legacy)});
  expect((await verifyReceipt({...legacy.prepared.manifest,mode:'native-full-retrieval'} as any,legacyGood,legacyGood.lastUserSourceId!)).verified).toBe(false);
 });
 test('exact current prompt/final/completion/artifacts remain mandatory with prose summary',async()=>{
  const h=await nativeRetrievalSetup(),good=records('claude',h.prepared,null,{reads:h.reads,finalText:'ข้อมูลอ้างอิงครบแล้ว'});
  for(const patch of [{nativeId:other},{cwd:'/home/example/other'},{turnComplete:false},{pendingTools:true},{refused:true},{interrupted:true},{lastUserSourceId:'earlier'}])expect((await verifyNative(h,{...good,...patch})).verified).toBe(false);
  for(const patch of [{final:false},{replyToSourceId:'earlier'}]){const data=structuredClone(good);Object.assign(data.assistantMessages.at(-1)!,patch);expect((await verifyNative(h,data)).verified).toBe(false);}
  expect((await verifyNative(h,records('claude',h.prepared,null,{reads:h.reads,finalText:'  '}))).verified).toBe(false);
  expect((await verifyNative(h,records('claude',h.prepared,null,{reads:h.reads,finalText:'อ่านแล้ว',userText:h.prepared.requestText+' drift'}))).verified).toBe(false);
  writeFileSync(h.prepared.manifest.bindingPath,'tampered',{mode:0o600});expect((await verifyNative(h,good)).verified).toBe(false);
 });
 test('native mode uses shared numbered coverage, rejects missing middle even with a completed final',async()=>{
  const h=await nativeRetrievalSetup(),lines=h.reads[1].output.trimEnd().split('\n');
  const reads=[{...h.reads[0],output:numbered(h.reads[0].output)},...lines.map((line,i)=>({path:h.archivePath,offset:i+1,limit:1,output:numbered(line,i+1)}))];
  expect((await verifyNative(h,records('claude',h.prepared,null,{reads,finalText:'อ่านข้อมูลครบแล้ว'}))).verified).toBe(true);
  expect((await verifyNative(h,records('claude',h.prepared,null,{reads:reads.filter((_,i)=>i!==2),finalText:'อ่านข้อมูลครบแล้ว'}))).verified).toBe(false);
 });
});

const nativeNumbered=(text:string,start=1)=>text.split('\n').map((line,i)=>`${String(start+i).padStart(6)}→${line}`).join('\n');
describe('Parser-validated Claude Read success provenance without is_error',()=>{
 test('raw Read file success evidence verifies without fabricating resultError or exitCode',async()=>{
  const h=await nativeRetrievalSetup(),data=records('claude',h.prepared,null,{reads:h.reads,finalText:'อ่านข้อมูลอ้างอิงครบแล้ว',omitErrorFlag:true,fileEvidence:true});
  for(const result of data.events.filter(e=>e.metadata?.phase==='result')){expect(result.metadata).not.toHaveProperty('resultError');expect(result.metadata).not.toHaveProperty('exitCode');expect(result.metadata?.successEvidence).toMatchObject({source:'claude-read-file',version:1});}
  const result=await verifyNative(h,data);expect(result).toMatchObject({verified:true,acceptance:'unassessed',retrievalProof:{semanticUnderstanding:false}});
 });
 test('single JSONL event plus exact terminal empty numbered line and reminder is full retrieval',async()=>{
  const h=await nativeRetrievalSetup('synthetic',1),reads=h.reads.map(r=>({...r,output:nativeNumbered(r.output)+'\n<system-reminder>ข้อความระบบของเครื่องมือ</system-reminder>'}));
  const data=records('claude',h.prepared,null,{reads,finalText:'อ่านข้อมูลอ้างอิงครบแล้ว',omitErrorFlag:true,fileEvidence:true}),result=await verifyNative(h,data);
  expect(result.verified).toBe(true);if(result.verified){expect(result.retrievalProof?.archive.lines).toBe(1);expect(result.retrievalProof?.archive.reads[0]).toMatchObject({firstLine:1,lastLine:2,terminalEmptyLine:true,successEvidenceSource:'claude-read-file',format:'numbered-lines'});}
 });
 test('canonical JSON native normalization preserves positive evidence only on exact file hash',async()=>{
  const h=await nativeRetrievalSetup('synthetic',1),data=records('claude',h.prepared,null,{reads:h.reads,finalText:'อ่านแล้ว',omitErrorFlag:true,fileEvidence:true}),result=await verifyNative(h,data);
  const m=data.events.filter(e=>e.metadata?.phase==='result').at(-1)!.metadata!, evidence=m.successEvidence as any;
  expect(evidence).toBeDefined();expect(evidence.fileContentHash).toBe(sha(h.reads[1].output));expect(evidence.publicOutputHash).toBe(sha(data.events.filter(e=>e.metadata?.phase==='result').at(-1)!.text));expect(sha(JSON.stringify(m.toolOutput)+'\n')).toBe(sha(h.reads[1].output));
  expect(result).toMatchObject({verified:true});if(result.verified)expect(result.retrievalProof?.archive.reads[0].format).toBe('native-jsonl-object');
 });
 test('native Read chunks include actual terminal empty line; missing terminal or middle never certifies',async()=>{
  const h=await nativeRetrievalSetup(),lines=h.reads[1].output.split('\n'),reads=[{...h.reads[0],output:nativeNumbered(h.reads[0].output)},...lines.map((line,i)=>({path:h.archivePath,offset:i+1,limit:1,output:nativeNumbered(line,i+1)}))];
  const check=(attempt:typeof reads)=>verifyNative(h,records('claude',h.prepared,null,{reads:attempt,finalText:'อ่านแล้ว',omitErrorFlag:true,fileEvidence:true}));
  expect((await check(reads)).verified).toBe(true);expect((await check(reads.slice(0,-1))).verified).toBe(false);expect((await check(reads.filter((_,i)=>i!==2))).verified).toBe(false);
 });
 test('unknown/unverified/mismatched sibling file metadata does not infer success from output prose',async()=>{
  const h=await nativeRetrievalSetup();
  for(const options of [{fileEvidence:false},{fileEvidenceType:'unknown'},{fileEvidencePatch:{filePath:'/home/example/other'}},{fileEvidencePatch:{startLine:2}},{fileEvidencePatch:{numLines:999}},{fileEvidencePatch:{totalLines:999}},{fileEvidencePatch:{content:'different'}},{fileEvidencePatch:{truncated:true}},{fileEvidencePatch:{error:true}}]){
   const data=records('claude',h.prepared,null,{reads:h.reads,finalText:'อ่านแล้ว',omitErrorFlag:true,fileEvidence:true,...options});expect((await verifyNative(h,data)).verified).toBe(false);
  }
 });
 test('explicit native errors or nonzero exit always override otherwise valid successEvidence',async()=>{
  const h=await nativeRetrievalSetup(),good=records('claude',h.prepared,null,{reads:h.reads,finalText:'อ่านแล้ว',omitErrorFlag:true,fileEvidence:true});
  for(const patch of [{resultError:true},{exitCode:1},{resultError:false,exitCode:1}]){const data=structuredClone(good),result=data.events.find(e=>e.metadata?.phase==='result')!;Object.assign(result.metadata!,patch);expect(result.metadata?.successEvidence).toBeDefined();expect((await verifyNative(h,data))).toMatchObject({verified:false,reason:'receipt_read_not_successful'});}
 });
 test('provenance field tampering, foreign prompt/ranges and output hash mismatch remain rejected',async()=>{
  const h=await nativeRetrievalSetup(),good=records('claude',h.prepared,null,{reads:h.reads,finalText:'อ่านแล้ว',omitErrorFlag:true,fileEvidence:true});
  for(const patch of [{source:'unverified'},{version:2},{toolCallId:'other'},{replyToSourceId:'old-turn'},{replyToIndex:99},{filePath:'/home/example/other'},{startLine:2},{numLines:999},{totalLines:999},{fileContentHash:'0'.repeat(64)},{publicOutputHash:'0'.repeat(64)},{extra:true}]){
   const data=structuredClone(good),result=data.events.find(e=>e.metadata?.phase==='result')!;Object.assign(result.metadata!.successEvidence as object,patch);expect((await verifyNative(h,data)).verified).toBe(false);
  }
 });
 test('terminal empty rendering is not accepted for source without LF or if blank/content differs',async()=>{
  const h=await nativeRetrievalSetup('synthetic',1);
  for(const reads of [h.reads.map((r,i)=>({...r,output:nativeNumbered(r.output)+(i===0?'\n     3→':'')})),h.reads.map((r,i)=>({...r,output:nativeNumbered(r.output)+(i===1?'not-empty':'')}))]){
   expect((await verifyNative(h,records('claude',h.prepared,null,{reads,finalText:'อ่านแล้ว',omitErrorFlag:true,fileEvidence:true}))).verified).toBe(false);
  }
 });
});
