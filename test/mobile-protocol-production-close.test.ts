import {describe,test,expect} from 'bun:test';
import {createOneWayClose} from '../scripts/serve-one-way';

describe('production shutdown outcome',()=>{
  test('cleanup failure still stops server and all callers retain sanitized rejection',async()=>{
    const calls:string[]=[];
    const close=createOneWayClose(async()=>{calls.push('cleanup');throw Error('private-detail');},()=>{calls.push('stop');});
    const first=close();expect(close()).toBe(first);
    await expect(first).rejects.toThrow('production_shutdown_failed');
    expect(close()).toBe(first);
    await expect(close()).rejects.toThrow('production_shutdown_failed');
    expect(calls).toEqual(['cleanup','stop']);
  });
  test('stop failure is retained without replaying cleanup',async()=>{
    let cleanup=0,stop=0;
    const close=createOneWayClose(async()=>{cleanup++;},()=>{stop++;throw Error('private');});
    await expect(close()).rejects.toThrow('production_shutdown_failed');
    await expect(close()).rejects.toThrow('production_shutdown_failed');
    expect([cleanup,stop]).toEqual([1,1]);
  });
  test('concurrent close waits for owned cleanup before stopping once',async()=>{
    let release!:()=>void;const calls:string[]=[];
    const held=new Promise<void>(resolve=>{release=resolve;});
    const close=createOneWayClose(async()=>{calls.push('cleanup');await held;},()=>{calls.push('stop');});
    const first=close();expect(close()).toBe(first);expect(calls).toEqual(['cleanup']);
    release();await first;await close();expect(calls).toEqual(['cleanup','stop']);
  });
});
