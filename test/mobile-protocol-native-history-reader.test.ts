import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readProtocolNativeHistory} from '../src/mobile/continuity/protocol/native-history-reader';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'maw-native-history-')));roots.push(root);const project=join(root,'projects','project');mkdirSync(project,{recursive:true});
 const rows=(sessionId=id,cwd=root)=>[
  {type:'user',uuid:'u1',parentUuid:null,sessionId,cwd,message:{role:'user',content:'fixture question'}},
  {type:'assistant',uuid:'a1',parentUuid:'u1',sessionId,cwd,message:{role:'assistant',model:'fixture-model',stop_reason:'end_turn',content:[{type:'thinking',thinking:'private reasoning must not appear'},{type:'text',text:'fixture answer'}]}}
 ];
 const write=(file=join(project,id+'.jsonl'),session=id,cwd=root)=>writeFileSync(file,rows(session,cwd).map(x=>JSON.stringify(x)).join('\n')+'\n');
 return {root,project,write,input:{agent:'claude' as const,nativeId:id,effectiveToolHome:root,cwd:root}};
}
test('exact UUID reads full stable native history and excludes hidden reasoning',async()=>{
 const f=fixture();f.write();const r=await readProtocolNativeHistory(f.input);expect(r.nativeId).toBe(id);expect(r.turnComplete).toBe(true);expect(r.events.map(e=>e.text)).toEqual(['fixture question','fixture answer']);expect(JSON.stringify(r)).not.toContain('private reasoning');
});
test('missing exact UUID never selects a different or latest transcript',async()=>{
 const f=fixture();f.write(join(f.project,other+'.jsonl'),other);await expect(readProtocolNativeHistory(f.input)).rejects.toMatchObject({code:'protocol_native_history_unavailable'});
});
test('duplicate UUID paths are ambiguous, not latest wins',async()=>{
 const f=fixture();f.write();mkdirSync(join(f.root,'projects','duplicate'));f.write(join(f.root,'projects','duplicate',id+'.jsonl'));await expect(readProtocolNativeHistory(f.input)).rejects.toThrow('protocol_native_history_unavailable');
});
for(const mismatch of ['session','cwd'])test('filename cannot override native '+mismatch+' identity',async()=>{
 const f=fixture();f.write(undefined,mismatch==='session'?other:id,mismatch==='cwd'?'/different':f.root);await expect(readProtocolNativeHistory(f.input)).rejects.toThrow('protocol_native_history_unavailable');
});
test('symlinked exact transcript is never adopted',async()=>{
 const f=fixture();const outside=join(f.root,'other.jsonl');f.write(outside);symlinkSync(outside,join(f.project,id+'.jsonl'));await expect(readProtocolNativeHistory(f.input)).rejects.toThrow('protocol_native_history_unavailable');
});
test('Codex exact rollout suffix preserves native turn correlation',async()=>{
 const f=fixture(),dir=join(f.root,'sessions','2026','11','08');mkdirSync(dir,{recursive:true});
 const rows=[{type:'session_meta',payload:{id,cwd:f.root}},{type:'event_msg',payload:{type:'task_started',turn_id:other}},
 {type:'turn_context',payload:{turn_id:other,cwd:f.root,model:'fixture-codex'}},
 {type:'response_item',payload:{type:'message',id:'u1',role:'user',content:[{type:'input_text',text:'fixture question'}]}},
 {type:'response_item',payload:{type:'message',id:'a1',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'fixture answer'}]}},
 {type:'event_msg',payload:{type:'task_complete',turn_id:other}}];
 writeFileSync(join(dir,'rollout-2026-11-08-'+id+'.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
 const r=await readProtocolNativeHistory({...f.input,agent:'codex'});expect(r.turnComplete).toBe(true);expect(r.assistantMessages[0].turnId).toBe(other);expect(r.events).toHaveLength(2);
});
