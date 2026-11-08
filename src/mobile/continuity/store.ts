/** Durable logical-room state. Construction/import never opens a file, timer or provider. */
import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync, existsSync, openSync, closeSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { ContinuityError, type AgentKind, type Binding, type Room, type RoomEvent, type Operation, type BeginRequest, type HeldMessage, type Store, type OperationState } from './types';
export { ContinuityError, ContinuityError as StoreError } from './types';
const agents: AgentKind[] = ['codex','claude'];
const states: OperationState[] = ['waiting-safe-point','checkpointed','preparing-target','delivering-context','ready-awaiting-user','blocked','failed','uncertain'];
const fail = (code:string,status=409):never => { throw new ContinuityError(code,status); };
const text = (v:unknown,max=4096):v is string => typeof v==='string' && v.length>0 && v.length<=max && !v.includes('\0');
const uint = (v:unknown):v is number => Number.isSafeInteger(v) && (v as number)>=0;
const object = (v:any):boolean => !!v && typeof v==='object' && !Array.isArray(v);
/** Sort object keys so retries do not depend on JavaScript property insertion order. */
function canonical(value:unknown):string {
  try { const encoded=JSON.stringify(value,(_key,v)=>{
    if(typeof v==='number'&&!Number.isFinite(v)||typeof v==='bigint'||typeof v==='function'||typeof v==='symbol') fail('invalid_serialized_value',400);
    if(v&&typeof v==='object'&&!Array.isArray(v))return Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,v[k]]));
    return v;
  });if(encoded===undefined||Buffer.byteLength(encoded)>2*1024*1024)fail('record_size_limit',400);return encoded; }
  catch(e){if(e instanceof ContinuityError)throw e;return fail('invalid_serialized_value',400);}
}
const digest = (v:unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const clone = <T>(v:T):T => JSON.parse(canonical(v));
function binding(v:any):asserts v is Binding {
  if(!object(v)||!agents.includes(v.agent)||!text(v.nativeId,512)||!text(v.generation,512)||!uint(v.cursor)||(v.model!==undefined&&!text(v.model,256))||(v.route!==undefined&&!text(v.route,256)))fail('invalid_binding',400);
}
function room(v:any):asserts v is Room {
  if(!object(v)||!text(v.id,256)||!text(v.workspace,512)||!text(v.room,512)||!['herdr','tmux','superset'].includes(v.backend)||!text(v.cwd)||!v.cwd.startsWith('/')||/[\r\n]/.test(v.cwd)||!uint(v.revision)||!agents.includes(v.active)||!object(v.bindings)||(v.operationId!==undefined&&!text(v.operationId,256)))fail('invalid_room',400);
  for(const [agent,b] of Object.entries(v.bindings)){binding(b);if(!agents.includes(agent as AgentKind)||b.agent!==agent)fail('invalid_binding',400);}
  if(!v.bindings[v.active])fail('active_binding_missing',400);
}
function operation(v:any):asserts v is Operation {
  if(!object(v)||!text(v.id,256)||!text(v.roomId,256)||!agents.includes(v.target)||!uint(v.expectedRevision)||!states.includes(v.state)||!uint(v.createdAt)||(v.model!==undefined&&!text(v.model,256))||(v.reason!==undefined&&!text(v.reason,4096))||(v.checkpointSeq!==undefined&&!uint(v.checkpointSeq))||(v.contextHash!==undefined&&!text(v.contextHash,512)))fail('invalid_operation',400);
  binding(v.from);if(v.targetBinding!==undefined){binding(v.targetBinding);if(v.targetBinding.agent!==v.target)fail('target_binding_mismatch');}
}
function event(v:any):void {
  if(!object(v)||!text(v.sourceId,1024)||!agents.includes(v.agent)||!text(v.nativeId,512)||!text(v.role,128)||typeof v.text!=='string'||v.text.includes('\0')||(v.ts!==undefined&&!text(v.ts,128))||(v.metadata!==undefined&&!object(v.metadata)))fail('invalid_event',400);
  canonical(v);
}
const immutable = (o:Operation) => ({id:o.id,roomId:o.roomId,target:o.target,model:o.model,expectedRevision:o.expectedRevision,from:o.from,createdAt:o.createdAt});
const targetIdentity = (b:Binding) => ({agent:b.agent,nativeId:b.nativeId,generation:b.generation,model:b.model,route:b.route});
const transitions:Record<OperationState,OperationState[]> = {
  'waiting-safe-point':['waiting-safe-point','checkpointed','blocked','failed','uncertain'],
  checkpointed:['checkpointed','preparing-target','blocked','failed','uncertain'],
  'preparing-target':['preparing-target','delivering-context','blocked','failed','uncertain'],
  'delivering-context':['delivering-context','blocked','failed','uncertain'],
  'ready-awaiting-user':[],
  blocked:['blocked','waiting-safe-point','failed','uncertain'],
  failed:['failed','waiting-safe-point','uncertain'],
  uncertain:['uncertain','waiting-safe-point','failed'],
};
export class ContinuityStore implements Store {
  private db?:Database;
  constructor(readonly path:string) {}
  private database():Database {
    if(this.db)return this.db;
    try {
      if(this.path!==':memory:'){
        mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
        if(existsSync(this.path)&&lstatSync(this.path).isSymbolicLink())fail('store_symlink_rejected',503);
        if(!existsSync(this.path)){try{closeSync(openSync(this.path,'wx',0o600));}catch(e:any){if(e.code!=='EEXIST')throw e;}}
        chmodSync(this.path,0o600);
      }
      const db=new Database(this.path,{create:true});
      try {
        const version=(db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
        if(version!==0&&version!==1)fail('store_version_unsupported',503);
        db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
        db.transaction(()=>{
          db.exec(`CREATE TABLE IF NOT EXISTS continuity_rooms (
            id TEXT PRIMARY KEY, backend TEXT NOT NULL, workspace TEXT NOT NULL, runtime_room TEXT NOT NULL,
            revision INTEGER NOT NULL, active_operation TEXT, registration_hash TEXT NOT NULL, body TEXT NOT NULL,
            UNIQUE(backend,workspace,runtime_room));
            CREATE TABLE IF NOT EXISTS continuity_operations (
            id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES continuity_rooms(id), state TEXT NOT NULL,
            request_hash TEXT NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS continuity_events (
            room_id TEXT NOT NULL REFERENCES continuity_rooms(id), seq INTEGER NOT NULL, agent TEXT NOT NULL,
            native_id TEXT NOT NULL, source_id TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL,
            PRIMARY KEY(room_id,seq), UNIQUE(room_id,agent,native_id,source_id));
            CREATE TABLE IF NOT EXISTS continuity_held (
            ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            room_id TEXT NOT NULL REFERENCES continuity_rooms(id), fingerprint TEXT NOT NULL, body TEXT NOT NULL);
            PRAGMA user_version=1;`);
        }).immediate();
        this.db=db;return db;
      }catch(e){db.close();throw e;}
    }catch(e){if(e instanceof ContinuityError)throw e;return fail('store_unavailable',503);}
  }
  private access<T>(fn:(db:Database)=>T):T {try{return fn(this.database());}catch(e){if(e instanceof ContinuityError)throw e;return fail('store_unavailable',503);}}
  private transaction<T>(fn:()=>T):T{return this.access(db=>db.transaction(fn).immediate());}
  private readRoom(id:string):Room|null {
    const row=this.database().query('SELECT body,revision,active_operation FROM continuity_rooms WHERE id=?').get(id) as any;
    if(!row)return null;let r:any;try{r=JSON.parse(row.body);room(r);}catch{return fail('store_corrupt',503);}
    if(r.id!==id||r.revision!==row.revision||(r.operationId??null)!==row.active_operation)fail('store_corrupt',503);return r;
  }
  private requiredRoom(id:string):Room{return this.readRoom(id)??fail('room_not_found',404);}
  private readOperation(id:string):Operation|null {
    const row=this.database().query('SELECT room_id,state,body FROM continuity_operations WHERE id=?').get(id) as any;
    if(!row)return null;let o:any;try{o=JSON.parse(row.body);operation(o);}catch{return fail('store_corrupt',503);}
    if(o.id!==id||o.roomId!==row.room_id||o.state!==row.state)fail('store_corrupt',503);return o;
  }
  room(id:string):Room|null {if(!text(id,256))fail('invalid_room_id',400);return this.access(()=>clone(this.readRoom(id)));}
  register(input:Room):Room {
    room(input);if(input.operationId!==undefined)fail('cannot_import_active_operation',400);
    const body=canonical(input),fingerprint=digest(input);
    return this.transaction(()=>{
      const existing=this.database().query('SELECT registration_hash FROM continuity_rooms WHERE id=?').get(input.id) as {registration_hash:string}|null;
      if(existing){if(existing.registration_hash!==fingerprint)fail('room_registration_conflict');return clone(this.requiredRoom(input.id));}
      if(this.database().query('SELECT id FROM continuity_rooms WHERE backend=? AND workspace=? AND runtime_room=?').get(input.backend,input.workspace,input.room))fail('room_alias_conflict');
      this.database().query('INSERT INTO continuity_rooms(id,backend,workspace,runtime_room,revision,active_operation,registration_hash,body) VALUES(?,?,?,?,?,NULL,?,?)').run(input.id,input.backend,input.workspace,input.room,input.revision,fingerprint,body);
      return clone(input);
    });
  }
  events(roomId:string,after=0,limit=500):RoomEvent[]{
    if(!uint(after)||!uint(limit)||limit<1||limit>10_000)fail('invalid_event_page',400);
    return this.access(()=>{this.requiredRoom(roomId);return (this.database().query('SELECT body FROM continuity_events WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?').all(roomId,after,limit) as {body:string}[]).map(row=>{const e=JSON.parse(row.body);event(e);if(!uint(e.seq)||e.seq<1)fail('store_corrupt',503);return e;});});
  }
  append(roomId:string,input:Omit<RoomEvent,'seq'>[]):RoomEvent[]{
    if(!Array.isArray(input)||input.length>2000)fail('invalid_event_batch',400);
    for(const e of input){event(e);if(Object.hasOwn(e,'seq'))fail('event_sequence_is_server_owned',400);}
    return this.transaction(()=>{
      this.requiredRoom(roomId);let seq=(this.database().query('SELECT COALESCE(MAX(seq),0) AS n FROM continuity_events WHERE room_id=?').get(roomId) as {n:number}).n;
      const inserted:RoomEvent[]=[];
      for(const e of input){
        const fingerprint=digest(e),existing=this.database().query('SELECT fingerprint FROM continuity_events WHERE room_id=? AND agent=? AND native_id=? AND source_id=?').get(roomId,e.agent,e.nativeId,e.sourceId) as {fingerprint:string}|null;
        if(existing){if(existing.fingerprint!==fingerprint)fail('event_source_conflict');continue;}
        if(!uint(seq+1))fail('event_sequence_exhausted',503);const value={...clone(e),seq:++seq};
        this.database().query('INSERT INTO continuity_events(room_id,seq,agent,native_id,source_id,fingerprint,body) VALUES(?,?,?,?,?,?,?)').run(roomId,seq,e.agent,e.nativeId,e.sourceId,fingerprint,canonical(value));inserted.push(value);
      }return inserted;
    });
  }
  begin(roomId:string,request:BeginRequest):Operation {
    if(!request||!text(request.id,256)||!agents.includes(request.target)||!uint(request.expectedRevision)||(request.model!==undefined&&!text(request.model,256)))fail('invalid_switch_request',400);
    const fingerprint=digest({roomId,id:request.id,target:request.target,model:request.model,expectedRevision:request.expectedRevision});
    return this.transaction(()=>{
      const row=this.database().query('SELECT room_id,request_hash FROM continuity_operations WHERE id=?').get(request.id) as any;
      if(row){if(row.room_id!==roomId||row.request_hash!==fingerprint)fail('request_id_conflict');return clone(this.readOperation(request.id)!);}
      const r=this.requiredRoom(roomId);if(r.revision!==request.expectedRevision)fail('stale_room_revision');if(r.operationId)fail('operation_in_progress');
      const o:Operation={id:request.id,roomId,target:request.target,...(request.model?{model:request.model}:{}),expectedRevision:r.revision,state:'waiting-safe-point',from:clone(r.bindings[r.active]!),createdAt:Date.now()};
      this.database().query('INSERT INTO continuity_operations(id,room_id,state,request_hash,body) VALUES(?,?,?,?,?)').run(o.id,roomId,o.state,fingerprint,canonical(o));
      r.operationId=o.id;
      const update=this.database().query('UPDATE continuity_rooms SET active_operation=?,body=? WHERE id=? AND revision=? AND active_operation IS NULL').run(o.id,canonical(r),roomId,request.expectedRevision);
      if(update.changes!==1)fail('operation_in_progress');return o;
    });
  }
  operation(id:string):Operation|null {if(!text(id,256))fail('invalid_operation_id',400);return this.access(()=>clone(this.readOperation(id)));}
  latestOperation(roomId:string):Operation|null {
    if(!text(roomId,256))fail('invalid_room_id',400);
    return this.access(()=>{
      if(!this.readRoom(roomId))return null;
      // Row insertion order is durable even when Date.now ties or the system clock goes backwards.
      const row=this.database().query('SELECT id FROM continuity_operations WHERE room_id=? ORDER BY rowid DESC LIMIT 1').get(roomId) as {id:string}|null;
      return row?clone(this.readOperation(row.id)):null;
    });
  }
  cancel(id:string,expectedRevision:number):Room {
    if(!text(id,256)||!uint(expectedRevision))fail('invalid_cancel_request',400);
    return this.transaction(()=>{
      const o=this.readOperation(id)??fail('operation_not_found',404),r=this.requiredRoom(o.roomId);
      if(o.state==='failed'&&o.reason==='canceled_by_user'){
        if(o.expectedRevision!==expectedRevision)fail('stale_room_revision');
        return clone(r); // Retry never clears a newer active operation.
      }
      if(r.revision!==expectedRevision||o.expectedRevision!==expectedRevision)fail('stale_room_revision');
      if(r.operationId!==id)fail('operation_not_active');
      if(!['waiting-safe-point','blocked'].includes(o.state)||o.targetBinding!==undefined)fail('cancel_not_safe');
      if(!uint(r.revision+1))fail('room_revision_exhausted',503);
      const prior=o.state;o.state='failed';o.reason='canceled_by_user';
      const changed=this.database().query('UPDATE continuity_operations SET state=?,body=? WHERE id=? AND room_id=? AND state=?').run(o.state,canonical(o),id,o.roomId,prior);
      if(changed.changes!==1)fail('operation_changed');
      r.revision++;delete r.operationId;
      const updated=this.database().query('UPDATE continuity_rooms SET revision=?,active_operation=NULL,body=? WHERE id=? AND active_operation=? AND revision=?').run(r.revision,canonical(r),r.id,id,expectedRevision);
      if(updated.changes!==1)fail('operation_changed');return clone(r);
    });
  }
  private checkUpdate(before:Operation,after:Operation):void {
    if(before.state==='failed'&&before.reason==='canceled_by_user')fail('operation_canceled');
    if(canonical(immutable(before))!==canonical(immutable(after)))fail('operation_identity_conflict');
    if(!transitions[before.state].includes(after.state))fail('invalid_operation_transition');
    if(before.targetBinding&&(!after.targetBinding||canonical(targetIdentity(before.targetBinding))!==canonical(targetIdentity(after.targetBinding))))fail('target_binding_mismatch');
    if(before.checkpointSeq!==undefined&&(after.checkpointSeq===undefined||after.checkpointSeq<before.checkpointSeq))fail('checkpoint_cursor_regression');
  }
  saveOperation(op:Operation):void {
    operation(op);this.transaction(()=>{
      const before=this.readOperation(op.id)??fail('operation_not_found',404),r=this.requiredRoom(before.roomId);
      if(r.operationId!==op.id||r.revision!==op.expectedRevision)fail('operation_not_active');this.checkUpdate(before,op);
      this.database().query('UPDATE continuity_operations SET state=?,body=? WHERE id=? AND room_id=?').run(op.state,canonical(op),op.id,op.roomId);
    });
  }
  compareAndSave(op:Operation,expectedState:OperationState):boolean {
    operation(op);if(!states.includes(expectedState))fail('invalid_operation_state',400);
    return this.transaction(()=>{
      const before=this.readOperation(op.id);if(!before||before.roomId!==op.roomId||before.state!==expectedState)return false;
      const r=this.requiredRoom(before.roomId);if(r.operationId!==op.id||r.revision!==op.expectedRevision)return false;
      this.checkUpdate(before,op);
      const result=this.database().query('UPDATE continuity_operations SET state=?,body=? WHERE id=? AND room_id=? AND state=? AND EXISTS(SELECT 1 FROM continuity_rooms r WHERE r.id=? AND r.active_operation=? AND r.revision=?)').run(op.state,canonical(op),op.id,op.roomId,expectedState,op.roomId,op.id,op.expectedRevision);
      return result.changes===1;
    });
  }
  complete(id:string,target:Binding):Room {
    binding(target);return this.transaction(()=>{
      const o=this.readOperation(id)??fail('operation_not_found',404),r=this.requiredRoom(o.roomId);
      if(o.state==='ready-awaiting-user'){
        if(!o.targetBinding||canonical(o.targetBinding)!==canonical(target))fail('completion_conflict');return clone(r);
      }
      if(o.state!=='delivering-context')fail('context_not_delivering');
      if(r.operationId!==id||r.revision!==o.expectedRevision)fail('operation_not_active');
      if(target.agent!==o.target)fail('target_binding_mismatch');
      if(o.targetBinding&&canonical(targetIdentity(o.targetBinding))!==canonical(targetIdentity(target)))fail('target_binding_mismatch');
      if(r.bindings[o.target]&&r.bindings[o.target]!.nativeId!==target.nativeId)fail('exact_native_session_required');
      if(o.checkpointSeq===undefined||target.cursor!==o.checkpointSeq||(r.bindings[o.target]?.cursor??0)>target.cursor)fail('context_cursor_mismatch');
      if(!o.contextHash)fail('context_manifest_missing');
      if(!uint(r.revision+1))fail('room_revision_exhausted',503);
      r.bindings[o.target]=clone(target);r.active=o.target;r.revision++;delete r.operationId;
      o.state='ready-awaiting-user';o.targetBinding=clone(target);
      this.database().query('UPDATE continuity_operations SET state=?,body=? WHERE id=? AND room_id=? AND state=?').run(o.state,canonical(o),id,o.roomId,'delivering-context');
      this.database().query('UPDATE continuity_rooms SET revision=?,active_operation=NULL,body=? WHERE id=? AND active_operation=? AND revision=?').run(r.revision,canonical(r),r.id,id,o.expectedRevision);
      return clone(r);
    });
  }
  hold(roomId:string,message:HeldMessage):HeldMessage {
    if(!object(message)||!text(message.id,256)||typeof message.text!=='string'||message.text.includes('\0')||!text(message.intendedGeneration,512))fail('invalid_held_message',400);
    const fingerprint=digest(message);return this.transaction(()=>{
      this.requiredRoom(roomId);const existing=this.database().query('SELECT room_id,fingerprint,body FROM continuity_held WHERE id=?').get(message.id) as any;
      if(existing){if(existing.room_id!==roomId||existing.fingerprint!==fingerprint)fail('held_message_conflict');return JSON.parse(existing.body);}
      this.database().query('INSERT INTO continuity_held(id,room_id,fingerprint,body) VALUES(?,?,?,?)').run(message.id,roomId,fingerprint,canonical(message));return clone(message);
    });
  }
  held(roomId:string):HeldMessage[]{return this.access(()=>{this.requiredRoom(roomId);return (this.database().query('SELECT body FROM continuity_held WHERE room_id=? ORDER BY ordinal').all(roomId) as {body:string}[]).map(r=>JSON.parse(r.body));});}
  close():void {this.db?.close();this.db=undefined;}
}
