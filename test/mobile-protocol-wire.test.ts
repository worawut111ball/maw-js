import { expect, test } from 'bun:test';
import { JsonLineWire } from '../src/mobile/continuity/protocol/wire';
const bytes = (text:string) => new TextEncoder().encode(text);
async function *chunks(...values: Uint8Array[]) { yield* values; }
const wire = (input: AsyncIterable<Uint8Array>, limit=1024) => new JsonLineWire({ input, write:async()=>{},close:async()=>{} },limit);
test('native JSONL tolerates UTF-8 split across chunks and coalesced messages',async()=>{
  const data=bytes('{"text":"ข้อมูล"}\n{"id":2}\r\n');
  const out=[]; for await(const value of wire(chunks(data.slice(0,11),data.slice(11,14),data.slice(14))).messages)out.push(value);
  expect(out).toEqual([{text:'ข้อมูล'},{id:2}]);
});
test('reject incomplete, malformed and non-object native frames without exposing payload',async()=>{
  for(const [body,code]of [['{"private":"unfinished"','protocol_incomplete_frame'],['not-json\n','protocol_invalid_json'],['[]\n','protocol_invalid_frame']]as const){
    const consume=async()=>{for await(const _ of wire(chunks(bytes(body))).messages){}};
    await expect(consume()).rejects.toMatchObject({code,uncertain:true});
  }
});
test('byte limit applies to each frame, not a coalesced chunk',async()=>{
  const many=Array.from({length:100},(_,id)=>JSON.stringify({id})+'\n').join('');
  let count=0;for await(const _ of wire(chunks(bytes(many)),128).messages)count++;expect(count).toBe(100);
  const consume=async()=>{for await(const _ of wire(chunks(bytes(JSON.stringify({text:'ก'.repeat(80)})+'\n')),128).messages){}};
  await expect(consume()).rejects.toMatchObject({code:'protocol_frame_too_large'});
});
test('invalid UTF-8 fails closed and stream cannot be consumed twice',async()=>{
  const bad=wire(chunks(new Uint8Array([0xff,10])));await expect(bad.messages[Symbol.asyncIterator]().next()).rejects.toMatchObject({code:'protocol_read_failed'});
  const w=wire(chunks(bytes('{}\n')));await w.messages[Symbol.asyncIterator]().next();await expect(w.messages[Symbol.asyncIterator]().next()).rejects.toMatchObject({code:'protocol_single_reader_required'});
});
test('failed write poisons queued frames and never replays the first attempt',async()=>{
  let writes=0,closes=0;const w=new JsonLineWire({input:chunks(),write:async()=>{writes++;throw Error('private native error');},close:async()=>{closes++;}});
  const results=await Promise.allSettled([w.send({id:1}),w.send({id:2})]);
  expect(results.map(r=>r.status)).toEqual(['rejected','rejected']);expect(writes).toBe(1);
  await w.close();await w.close();expect(closes).toBe(1);await expect(w.send({id:3})).rejects.toMatchObject({code:'protocol_wire_closed'});
});
