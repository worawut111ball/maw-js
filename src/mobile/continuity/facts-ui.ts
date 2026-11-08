import {randomUUID} from 'node:crypto';
import {FactsSelectionStore} from './facts-selection';
import {factsBindingHash,listFactCandidates,type Snapshot,type SelectionSet} from './facts-resolver';
import {ContinuityError,type Room} from './types';

/** Mounted only behind mobile authentication. Actor is trusted host configuration,
 * never a request field. Snapshot callback owns safe native-history import/archive.
 */
export class FactsUIService {
  private previews=new Map<string,Snapshot>();
  constructor(private selections:FactsSelectionStore,private actorId:string,
    private snapshot:(room:Room)=>Promise<Snapshot>) {}
  private scoped(room:Room,snapshot:Snapshot):void {
    const active=room.bindings[room.active];
    if(!active||snapshot.roomId!==room.id||snapshot.roomRevision!==room.revision
      ||factsBindingHash(active)!==factsBindingHash(snapshot.sourceBinding))throw new ContinuityError('facts_room_changed');
  }
  async preview(room:Room) {
    if(room.operationId)throw new ContinuityError('operation_in_progress');
    const s=structuredClone(await this.snapshot(structuredClone(room)));this.scoped(room,s);
    if(Buffer.byteLength(JSON.stringify(s))>256*1024)throw new ContinuityError('facts_preview_too_large',413);
    const candidates=listFactCandidates(s),id=randomUUID();
    if(this.previews.size>=64)this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(id,s);
    return {id,roomId:s.roomId,roomRevision:s.roomRevision,sourceBindingHash:factsBindingHash(s.sourceBinding),
      archiveHash:s.archiveHash,throughSeq:s.throughSeq,
      contextText:s.events.map(e=>`[${e.seq}] ${e.role}: ${e.text}`).join('\n'),candidates,selectionRequired:true};
  }
  async approve(room:Room,request:{id:string;previewId:string;expectedRevision:number;selections:SelectionSet['selections']}) {
    const old=this.previews.get(request.previewId);
    if(!old)throw new ContinuityError('facts_preview_expired');
    if(request.expectedRevision!==room.revision)throw new ContinuityError('stale_room_revision');
    this.scoped(room,old);
    const current=structuredClone(await this.snapshot(structuredClone(room)));this.scoped(room,current);
    if(current.archiveHash!==old.archiveHash||current.throughSeq!==old.throughSeq)throw new ContinuityError('facts_preview_changed');
    const selection:SelectionSet={version:1,roomId:current.roomId,roomRevision:current.roomRevision,archiveHash:current.archiveHash,
      throughSeq:current.throughSeq,sourceBindingHash:factsBindingHash(current.sourceBinding),selections:structuredClone(request.selections)};
    const result=this.selections.approve(request.id,this.actorId,current,selection);
    return {id:request.id,previewId:request.previewId,roomRevision:current.roomRevision,factsHash:result.factsHash};
  }
  async verify(room:Room,selectionId:string):Promise<void> {
    const current=structuredClone(await this.snapshot(structuredClone(room)));this.scoped(room,current);
    this.selections.read(selectionId,current);
  }
}
