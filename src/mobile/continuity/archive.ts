import { mkdirSync, writeFileSync, readFileSync, realpathSync, lstatSync, chmodSync, openSync, closeSync, fsyncSync, fstatSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
    catch(e:any){if(e.code!=='EEXIST')throw e;}
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{if(!fstatSync(fd).isFile()||readFileSync(fd,'utf8')!==content)throw new Error('archive_collision');fsyncSync(fd);}finally{closeSync(fd);}
    // Flush file before publication barriers, including newly provisioned parent directories.
    for(let parent=dir;;parent=dirname(parent)){
      const directory=openSync(parent,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{if(!fstatSync(directory).isDirectory())throw new Error('archive_directory_changed');fsyncSync(directory);}finally{closeSync(directory);}
      if(dirname(parent)===parent)break;
    }
    return path;
  }
}
