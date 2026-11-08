import {basename} from 'node:path';
import type {Room} from '../types';
import {ContinuityError} from '../types';
import type {OwnedTransportStatus} from '../../features/continuity';
import {factsBindingHash} from '../facts-resolver';

/** Read-only inventory projection supplied by a trusted owned runtime registry.
 * Does not discover/adopt external sessions or infer live authority from a title.
 */
export function mergeOwnedInventory(projects:any[],rows:{room:Room;transport:OwnedTransportStatus}[]):any[] {
  const result=structuredClone(projects),seen=new Set<string>();
  if(!Array.isArray(rows)||rows.length>1000)throw new ContinuityError('owned_inventory_invalid');
  for(const {room,transport}of rows) {
    const binding=room?.bindings?.[room.active],key=JSON.stringify([room?.workspace,room?.room]);
    if(!room||!binding||!room.cwd?.startsWith('/')||!room.workspace||!room.room||seen.has(key)
      ||transport?.kind!=='owned-protocol'||transport.roomId!==room.id||transport.revision!==room.revision
      ||factsBindingHash(transport.binding)!==factsBindingHash(binding))throw new ContinuityError('owned_inventory_invalid');
    seen.add(key);
    const matches=result.flatMap(p=>p.workspaces.filter((w:any)=>w.id===room.workspace).map((w:any)=>({p,w})));
    if(matches.length>1)throw new ContinuityError('owned_inventory_alias_conflict');
    let workspace=matches[0]?.w;
    if(!workspace) {
      const name=basename(room.cwd)||room.cwd;
      let project=result.find(p=>p.path===room.cwd&&p.source===room.backend);
      if(!project){project={name,source:room.backend,path:room.cwd,workspaces:[]};result.push(project);}
      workspace={id:room.workspace,name:room.workspace,branch:null,rooms:[]};project.workspaces.push(workspace);
    }
    const existing=workspace.rooms.filter((r:any)=>r.id===room.room);
    if(existing.length>1)throw new ContinuityError('owned_inventory_alias_conflict');
    const projected={id:room.room,title:existing[0]?.title??room.room,agent:binding.agent,
      status:transport.state==='busy'?'working':transport.state==='idle'?'idle':'waiting',
      claudeSessionId:binding.agent==='claude'?binding.nativeId:null,generation:binding.generation,
      transportKind:'owned-protocol',logicalRoomId:room.id,protocolBinding:structuredClone(binding),
      transportState:transport.state,revision:room.revision,
      capabilities:{history:true,screen:false,prompt:transport.capabilities.textTurn,keys:false,answer:false,stop:false,close:false,create:false}};
    if(existing.length)workspace.rooms[workspace.rooms.indexOf(existing[0])]=projected;
    else workspace.rooms.push(projected);
  }
  return result;
}
