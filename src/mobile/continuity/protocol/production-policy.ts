/** Host-reviewed directional release authority. Not native evidence or a browser enable flag. */
import {ContinuityError,type Room,type Binding} from '../types';
import type {ProtocolAcceptanceProfile} from './service';
export interface ProtocolOneWayProductionPolicy {
  source:'trusted-one-way-production-policy';reference:string;
  evidence:{runId:string;from:'codex';to:'claude'};
  rooms:{room:Pick<Room,'id'|'backend'|'workspace'|'room'|'cwd'>;source:ProtocolAcceptanceProfile;target:ProtocolAcceptanceProfile}[];
}
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=1024&&!/[\x00-\x1f]/.test(v);
const keys=(v:any,names:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...names].sort().join(',');
const profile=(v:any,agent:string)=>keys(v,['hash','namespace','agent','model','route'])&&v.agent===agent&&/^[a-f0-9]{64}$/.test(v.hash)&&/^[a-f0-9]{64}$/.test(v.namespace)&&text(v.model)&&['mind','direct'].includes(v.route);
export function validateOneWayProductionPolicy(value:unknown):ProtocolOneWayProductionPolicy {
  const p=structuredClone(value) as ProtocolOneWayProductionPolicy;
  if(!keys(p,['source','reference','evidence','rooms'])||p.source!=='trusted-one-way-production-policy'||!text(p.reference)
    ||!keys(p.evidence,['runId','from','to'])||!text(p.evidence.runId)||p.evidence.from!=='codex'||p.evidence.to!=='claude'
    ||!Array.isArray(p.rooms)||!p.rooms.length||p.rooms.length>1000)throw new ContinuityError('production_policy_unverified');
  const seen=new Set<string>();
  for(const row of p.rooms){
    if(!keys(row,['room','source','target'])||!keys(row.room,['id','backend','workspace','room','cwd'])
      ||!Object.values(row.room).every(text)||!['herdr','tmux','superset'].includes(row.room.backend)||!row.room.cwd.startsWith('/')
      ||!profile(row.source,'codex')||!profile(row.target,'claude')||seen.has(row.room.id))throw new ContinuityError('production_policy_unverified');
    seen.add(row.room.id);
  }
  return p;
}
export function oneWayRoom(policy:ProtocolOneWayProductionPolicy,room:Pick<Room,'id'|'backend'|'workspace'|'room'|'cwd'>){
  return policy.rooms.find(row=>(['id','backend','workspace','room','cwd'] as const).every(k=>row.room[k]===room[k]));
}
export function oneWayBindingMatches(profile:ProtocolAcceptanceProfile,binding:Binding|undefined):boolean {
  return !!binding&&binding.agent===profile.agent&&binding.model===profile.model&&binding.route===profile.route
    &&new RegExp(`^protocol:${profile.agent}:${profile.namespace}:[1-9][0-9]*$`).test(binding.generation);
}
export const oneWaySwitchDirections=()=>[
  {from:'codex' as const,to:'claude' as const,state:'available' as const},
  {from:'claude' as const,to:'codex' as const,state:'development' as const,reason:'switch_direction_in_development'},
];
