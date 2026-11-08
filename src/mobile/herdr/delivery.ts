import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'fs';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import { hash } from './inventory';
import { HerdrError, type DeliveryResult, type DeliveryState } from './types';
const owner=randomUUID();
const active=new Set<string>();
const locks=new Map<string,Promise<unknown>>();
/** Same coordinator is available to lifecycle and runtime. No lock is created on import. */
export async function withRoomLock<T>(key:string,action:()=>Promise<T>):Promise<T>{
  const previous=locks.get(key)??Promise.resolve();let release!:()=>void;
  const gate=new Promise<void>(r=>release=r);const tail=previous.catch(()=>{}).then(()=>gate);locks.set(key,tail);
  await previous.catch(()=>{});try{return await action();}finally{release();if(locks.get(key)===tail)locks.delete(key);}
}
interface Row {id:string;scope:string;fingerprint:string;generation:string;state:DeliveryState;code:string|null;owner:string;created:number;parent_id?:string|null;action?:string|null}
export class DeliveryLedger {
  private db:Database|null=null;private readonly namespace:string;private claimed=new Set<string>();
  constructor(private file:string,private now=Date.now,private maxRows=10_000){this.namespace=file===':memory:'?randomUUID():resolve(file);}
  private database():Database{
    if(this.db)return this.db;
    try{
      if(this.file!==':memory:')mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
      const db=new Database(this.file,{create:true,strict:true});
      try{
        if(this.file!==':memory:')chmodSync(this.file,0o600);
        db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        db.exec("CREATE TABLE IF NOT EXISTS herdr_delivery (id TEXT PRIMARY KEY, scope TEXT NOT NULL, fingerprint TEXT NOT NULL, generation TEXT NOT NULL, state TEXT NOT NULL, code TEXT, parent_id TEXT, action TEXT, owner TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS herdr_delivery_scope ON herdr_delivery(scope,created);");
        const columns=new Set((db.query('PRAGMA table_info(herdr_delivery)').all() as {name:string}[]).map(v=>v.name));
        if(!columns.has('parent_id'))db.exec('ALTER TABLE herdr_delivery ADD COLUMN parent_id TEXT');
        if(!columns.has('action'))db.exec('ALTER TABLE herdr_delivery ADD COLUMN action TEXT');
        this.db=db;return db;
      }catch(e){db.close();throw e;}
    }catch{throw new HerdrError('delivery_store_unavailable',503);}
  }
  private recover(row:Row):Row{
    if(row.state==='dispatching'&&(row.owner!==owner||!active.has(`${this.namespace}/${row.id}`))){
      this.database().query("UPDATE herdr_delivery SET state='uncertain',code='process_interrupted',updated=? WHERE id=? AND state='dispatching'").run(this.now(),row.id);return {...row,state:'uncertain',code:'process_interrupted'};
    }return row;
  }
  private result(row:Row):DeliveryResult{return {id:row.id,state:row.state,ok:row.state==='acknowledged',generation:row.generation,...(row.code?{code:row.code}:{}),...(row.parent_id?{parentId:row.parent_id}:{})};}
  claim(id:string,scope:string,payload:unknown,generation:string):{claimed:boolean;result:DeliveryResult}{
    const fingerprint=hash(payload);let outcome:{claimed:boolean;result:DeliveryResult};
    try{outcome=this.database().transaction(()=>{
      const row=this.database().query('SELECT * FROM herdr_delivery WHERE id=?').get(id) as Row|null;
      if(row){if(row.scope!==scope||row.fingerprint!==fingerprint)throw new HerdrError('request_id_conflict');return {claimed:false,result:this.result(this.recover(row))};}
      const count=this.database().query('SELECT COUNT(*) AS n FROM herdr_delivery').get() as {n:number};
      if(count.n>=this.maxRows)throw new HerdrError('delivery_store_full',503);
      this.database().query("INSERT INTO herdr_delivery(id,scope,fingerprint,generation,state,owner,created,updated,parent_id,action) VALUES(?,?,?,?,'dispatching',?,?,?,?,?)").run(id,scope,fingerprint,generation,owner,this.now(),this.now(),(payload as any)?.parentId??null,(payload as any)?.action??null);
      return {claimed:true,result:{id,state:'dispatching' as const,ok:false,generation}};
    }).immediate();}catch(e){if(e instanceof HerdrError)throw e;throw new HerdrError('delivery_store_unavailable',503);}
    if(outcome.claimed){active.add(`${this.namespace}/${id}`);this.claimed.add(id);}return outcome;
  }
  complete(id:string,state:'acknowledged'|'definitely-rejected'|'uncertain',code?:string):DeliveryResult{
    try{this.database().query('UPDATE herdr_delivery SET state=?,code=?,updated=? WHERE id=? AND owner=?').run(state,code??null,this.now(),id,owner);
      const row=this.database().query('SELECT * FROM herdr_delivery WHERE id=?').get(id) as Row|null;if(!row)throw new Error();return this.result(row);
    }catch{throw new HerdrError('delivery_store_unavailable',503);}finally{active.delete(`${this.namespace}/${id}`);this.claimed.delete(id);}
  }
  status(id:string,scope?:string):DeliveryResult{
    try{const row=this.database().query('SELECT * FROM herdr_delivery WHERE id=?').get(id) as Row|null;
      if(!row||scope&&row.scope!==scope)return {id,state:'unknown',ok:false,code:'delivery_unknown'};
      return this.result(this.recover(row));
    }catch(e){if(e instanceof HerdrError)throw e;throw new HerdrError('delivery_store_unavailable',503);}
  }
  hasUncertain(scope:string):boolean{
    try{const rows=this.database().query("SELECT * FROM herdr_delivery WHERE scope=? AND state IN ('dispatching','uncertain')").all(scope) as Row[];return rows.some(row=>{const current=this.recover(row);return ['dispatching','uncertain'].includes(current.state)&&!current.code?.startsWith('superseded_by:')&&current.code!=='resolved_by_user';});}
    catch(e){if(e instanceof HerdrError)throw e;throw new HerdrError('delivery_store_unavailable',503);}
  }

  parent(id:string):{scope:string;state:DeliveryState}|null{
    try{const row=this.database().query('SELECT * FROM herdr_delivery WHERE id=?').get(id) as Row|null;return row?{scope:row.scope,state:this.recover(row).state}:null;}
    catch(e){if(e instanceof HerdrError)throw e;throw new HerdrError('delivery_store_unavailable',503);}
  }
  resolve(id:string,scope:string,replacement?:string):DeliveryResult{
    try{return this.database().transaction(()=>{
      const row=this.database().query('SELECT * FROM herdr_delivery WHERE id=?').get(id) as Row|null;
      if(!row||row.scope!==scope)throw new HerdrError('parent_scope_mismatch');
      const current=this.recover(row);if(current.state!=='uncertain')throw new HerdrError('parent_not_uncertain');
      if(replacement){const next=this.database().query('SELECT * FROM herdr_delivery WHERE id=?').get(replacement) as Row|null;if(!next||next.scope!==scope||next.state!=='acknowledged')throw new HerdrError('replacement_not_acknowledged');}
      this.database().query('UPDATE herdr_delivery SET code=?,updated=? WHERE id=?').run(replacement?`superseded_by:${replacement}`:'resolved_by_user',this.now(),id);
      return this.result({...current,code:replacement?`superseded_by:${replacement}`:'resolved_by_user'});
    }).immediate();}catch(e){if(e instanceof HerdrError)throw e;throw new HerdrError('delivery_store_unavailable',503);}
  }
  close(){for(const id of this.claimed)active.delete(`${this.namespace}/${id}`);this.claimed.clear();this.db?.close();this.db=null;}
}
