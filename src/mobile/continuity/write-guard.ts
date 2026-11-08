/** Per-host-instance guard only. No registry, provider calls, timers or import-time I/O. */
import type { ReplyChannel } from '../api';
import type { Room } from './types';
import { ContinuityError } from './types';
export interface ContinuityWriteOptions {
  resolveRoom(ws:string,room:string):Promise<Room|null>;
  /** Trusted canonical host mapping only; absent/null is not evidence that a raw channel is unmanaged. */
  resolveChannel?(channel:ReplyChannel):Promise<Room|null>;
}
export interface ContinuityWriteGuard {
  assertRoom(ws:string,room:string):Promise<void>;
  assertChannel(channel:ReplyChannel|null):Promise<void>;
}
const blocked=():never=>{throw new ContinuityError('continuity_delivery_not_certified');};
export function continuityWriteFailure(set:any) {
  set.status=409;set.headers['cache-control']='no-store';
  return {ok:false,code:'continuity_delivery_not_certified',state:'definitely-rejected',error:'ห้องนี้ยังไม่เปิดการส่งตรงผ่าน continuity กรุณาเก็บข้อความไว้ก่อน'};
}
export function createContinuityWriteGuard(options?:ContinuityWriteOptions):ContinuityWriteGuard {
  return {
    async assertRoom(ws,room){
      if(options===undefined)return;
      try{if(await options.resolveRoom(ws,room)===null)return;}catch{/* Never expose resolver exceptions or fall back. */}
      blocked();
    },
    async assertChannel(channel){
      if(options===undefined)return;
      const physical=channel??blocked();
      // A raw pane/terminal has no canonical ws/room attestation. Never invent one from a label or latest room.
      try{if(options.resolveChannel)await options.resolveChannel(physical);}catch{/* Same safe rejection. */}
      blocked(); // null = unmappable; a mapped managed Room is blocked by the current certification gate too.
    },
  };
}

/** Request-local attempt accounting. A helper call may already have effects even if it throws. */
export function createContinuityWriteAttempt(guard:ContinuityWriteGuard|undefined,ws:string,room:string) {
  const revoked={};let started=false;
  const check=async()=>{try{await guard?.assertRoom(ws,room);}catch{throw revoked;}};
  const uncertain=(set:any)=>{set.status=409;set.headers['cache-control']='no-store';return {ok:false,code:'continuity_partial_write',state:'uncertain',error:'มีคำสั่งก่อนหน้าเริ่มไปแล้ว แต่ปลายทางเปลี่ยน — หยุดไว้และตรวจสถานะก่อน ห้ามส่งซ้ำอัตโนมัติ'};};
  return {
    check,hasStarted:()=>started,uncertain,
    async run<T>(effect:()=>Promise<T>):Promise<T>{await check();started=true;return effect();},
    failure(error:unknown,set:any){
      if(error!==revoked)return undefined;
      if(!started)return continuityWriteFailure(set);
      return uncertain(set);
    },
  };
}
