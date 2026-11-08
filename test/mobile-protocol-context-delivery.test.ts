import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {verifyProtocolContextDelivery} from '../src/mobile/continuity/protocol/context-delivery';
import {parseNativeRecords} from '../src/mobile/continuity/native-records';
const nativeId='11111111-1111-4111-8111-111111111111',turnId='22222222-2222-4222-8222-222222222222';
function fixture(agent:'claude'|'codex'='claude') {
  const text='reference context',cwd='/fixture',model='fixture-model';
  const rows=agent==='claude'?[
    {type:'user',uuid:turnId,parentUuid:null,sessionId:nativeId,cwd,message:{role:'user',content:text}},
    {type:'assistant',uuid:'answer',parentUuid:turnId,sessionId:nativeId,cwd,message:{role:'assistant',model,stop_reason:'end_turn',content:[{type:'text',text:'summary'}]}}
  ]:[{type:'session_meta',payload:{id:nativeId,cwd}},{type:'event_msg',payload:{type:'task_started',turn_id:turnId}},
    {type:'turn_context',payload:{turn_id:turnId,cwd,model}},
    {type:'response_item',payload:{type:'message',id:'u',role:'user',content:[{type:'input_text',text}]}},
    {type:'response_item',payload:{type:'message',id:'a',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'summary'}]}},
    {type:'event_msg',payload:{type:'task_complete',turn_id:turnId}}];
  const records=parseNativeRecords(agent,nativeId,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  return {room:{id:'room',workspace:'w',room:'r',backend:'herdr' as const,cwd,revision:1,active:agent,bindings:{},operationId:'handoff'},
    binding:{agent,nativeId,generation:`protocol:${agent}:${'a'.repeat(64)}:1`,model,route:'mind',cursor:0},
    context:{id:'handoff',text,hash:createHash('sha256').update(text).digest('hex'),throughSeq:2},
    start:{source:'live' as const,identity:{agent,nativeId,cwd,model,route:'mind',home:'/home'},generation:1,
      firstTurn:{operationId:'handoff:context',nativeId,turnId,state:'completed' as const,text:'summary'}},records};
}
for(const agent of ['claude','codex'] as const)test(agent+' exact native context turn verifies delivery only',()=>{
  const f=fixture(agent);expect(verifyProtocolContextDelivery(f)).toEqual({state:'acknowledged',nativeId,hash:f.context.hash,throughSeq:2});
});
const mutations:Record<string,(f:ReturnType<typeof fixture>)=>void>={
  'wrong operation':f=>{f.room.operationId='other';},'changed context hash':f=>{f.context.text+=' changed';},
  'invalid cursor':f=>{f.context.throughSeq=-1;},'historical start':f=>{(f.start as any).source='historical';},
  'foreign native':f=>{f.start.identity.nativeId=turnId;},'wrong generation':f=>{f.start.generation=2;},
  'wrong model':f=>{f.records.model='other';},'wrong route':f=>{f.start.identity.route='direct';},
  'pending tools':f=>{f.records.pendingTools=true;},'refusal':f=>{f.records.refused=true;},
  'interrupted':f=>{f.records.interrupted=true;},'incomplete':f=>{f.records.turnComplete=false;},
  'wrong turn':f=>{f.start.firstTurn.turnId=nativeId;},'wrong native user text':f=>{f.records.events[0].text='different';},
  'wrong final text':f=>{f.start.firstTurn.text='different';},'duplicate answer':f=>{f.records.assistantMessages.push({...f.records.assistantMessages[0]});},
  'duplicate user':f=>{f.records.events.push({...f.records.events[0]});},'later user':f=>{f.records.lastUserSourceId='later';},
  'wrong parent index':f=>{f.records.assistantMessages[0].replyToIndex=99;},
  'nonboolean completion':f=>{(f.records as any).turnComplete=1;},
  'missing pending flag':f=>{delete (f.records as any).pendingTools;},
  'later assistant':f=>{f.records.events.push({...f.records.events[1],sourceId:'later',index:9});},
  'completed tool in current turn':f=>{
    const index=f.records.events[1].index;
    f.records.events[1].index++;f.records.assistantMessages[0].index++;
    f.records.events.splice(1,0,{sourceId:'tool',role:'tool',text:'done',index});
  },
};
for(const agent of ['claude','codex'] as const)for(const [name,mutate]of Object.entries(mutations))test(agent+' reject '+name,()=>{
  const f=fixture(agent);mutate(f);expect(()=>verifyProtocolContextDelivery(f)).toThrow('protocol_context_delivery_unverified');
});
test('historical tool does not invalidate a later context-only turn',()=>{
  const f=fixture();
  for(const e of f.records.events){e.index+=2;if(typeof e.metadata?.replyToIndex==='number')e.metadata.replyToIndex+=2;}
  for(const a of f.records.assistantMessages){a.index+=2;a.replyToIndex+=2;}
  f.records.lastUserIndex!+=2;
  f.records.events.unshift({sourceId:'historical-tool',role:'tool',text:'old',index:0});
  expect(verifyProtocolContextDelivery(f).state).toBe('acknowledged');
});
