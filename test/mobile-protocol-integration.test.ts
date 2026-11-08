import {expect,test} from 'bun:test';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {EffectJournal} from '../src/mobile/continuity/effect-journal';
import {JsonLineWire} from '../src/mobile/continuity/protocol/wire';
import {CodexProtocolSession} from '../src/mobile/continuity/protocol/codex';
import {ProtocolTurnHost} from '../src/mobile/continuity/protocol/turn-host';

test('JSONL + Codex + journal commits intent before write and waits for exact final',async()=>{
 const cwd=realpathSync(tmpdir()),nativeId='00000000-0000-4000-8000-000000000001',turnId='00000000-0000-4000-8000-000000000002';
 const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 const roomKey='protocol-room:'+hash('integration-room'),owner=hash([roomKey,'op']);
 const journal=new EffectJournal(':memory:');
 let waiting:((r:IteratorResult<Uint8Array>)=>void)|undefined;
 const queue:Uint8Array[]=[];let ended=false,turnWrites=0,finish!:()=>void;
 const push=(frame:unknown)=>{
  const bytes=new TextEncoder().encode(JSON.stringify(frame)+'\n');
  // Split through real JSONL framing, including Thai final text below.
  for(const b of [bytes.slice(0,13),bytes.slice(13)]){if(waiting){const w=waiting;waiting=undefined;w({done:false,value:b});}else queue.push(b);}
 };
 const wire=new JsonLineWire({
  input:{[Symbol.asyncIterator]:()=>({next:()=>queue.length?Promise.resolve({done:false as const,value:queue.shift()!}):ended?Promise.resolve({done:true as const,value:undefined}):new Promise(r=>waiting=r)})},
  close:async()=>{ended=true;waiting?.({done:true,value:undefined});waiting=undefined;},
  write:async bytes=>{
   const f=JSON.parse(new TextDecoder().decode(bytes));
   if(f.method==='initialize')push({id:f.id,result:{codexHome:cwd,platformFamily:'unix',platformOs:'macos',userAgent:'codex/0.164.0'}});
   if(f.method==='thread/start')push({id:f.id,result:{thread:{id:nativeId,cliVersion:'0.164.0',createdAt:1,updatedAt:1,preview:'',projectId:null,sessionId:nativeId,source:'appServer',cwd,ephemeral:false,model:'fixture',modelProvider:'openai',status:{type:'idle'},turns:[]},cwd,model:'fixture',modelProvider:'openai',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}}});
   if(f.method==='turn/start'){
    turnWrites++;
    expect(journal.status(roomKey,owner,'turn').state).toBe('dispatching');
    push({id:f.id,result:{turn:{id:turnId,status:'inProgress',items:[],error:null}}});
    finish=()=>push({method:'turn/completed',params:{threadId:nativeId,turn:{id:turnId,status:'completed',error:null,itemsView:'full',items:[{type:'agentMessage',id:'answer',phase:'final_answer',text:'จำข้อมูลเดิมได้'}]}}});
   }
  }
 });
 const session=new CodexProtocolSession(wire,{agent:'codex',home:cwd,toolHome:cwd,cwd,model:'fixture',modelProvider:'openai',route:'direct',timeoutMs:1000});
 try{
  const identity=await session.open();const host=new ProtocolTurnHost(journal,'integration-room',identity,session);
  const pending=host.turn('op','ทดสอบ');let complete=false;void pending.then(()=>complete=true);
  await new Promise(r=>setTimeout(r,0));expect(turnWrites).toBe(1);expect(complete).toBe(false);
  finish();expect((await pending).turn.text).toBe('จำข้อมูลเดิมได้');
  expect((await host.turn('op','ทดสอบ')).source).toBe('historical');expect(turnWrites).toBe(1);
 }finally{await session.close();journal.close();}
});
