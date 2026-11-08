import { mkdirSync, writeFileSync, readFileSync, realpathSync, lstatSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { RoomEvent } from './types';

/** Private immutable artifacts, outside web/share roots. Native transcripts are never edited. */
export class ContinuityArchive {
  readonly root: string;
  constructor(root: string) {
    mkdirSync(root,{recursive:true,mode:0o700});
    if (lstatSync(root).isSymbolicLink()) throw new Error('archive_root_symlink');
    this.root=realpathSync(root); chmodSync(this.root,0o700);
  }
  snapshot(roomId:string,events:RoomEvent[]):string {
    const content=events.map(e=>JSON.stringify(e)).join('\n')+'\n';
    const digest=createHash('sha256').update(content).digest('hex');
    const room=createHash('sha256').update(roomId).digest('hex');
    const dir=join(this.root,room);mkdirSync(dir,{recursive:true,mode:0o700});
    if(lstatSync(dir).isSymbolicLink() || realpathSync(dir)!==resolve(dir))throw new Error('archive_directory_changed');
    const path=join(dir,digest+'.jsonl');
    try{writeFileSync(path,content,{flag:'wx',mode:0o600});}
    catch(e:any){if(e.code!=='EEXIST')throw e; if(lstatSync(path).isSymbolicLink() || readFileSync(path,'utf8')!==content)throw new Error('archive_collision');}
    return path;
  }
}
