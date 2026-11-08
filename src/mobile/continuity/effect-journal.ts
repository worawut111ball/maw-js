/** Durable effect claims and explicit room locks. Import/construction has no filesystem or provider effects. */
import { Database } from 'bun:sqlite';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, fchmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export interface EffectClaim {
  roomId: string;
  operationId: string;
  step: string;
  payload: unknown;
}
export interface EffectClaimResult {
  state: 'claimed' | 'acknowledged' | 'uncertain';
  result?: unknown;
}
export class EffectJournalError extends Error {
  constructor(public code: string, public status = 409) { super(code); this.name = 'EffectJournalError'; }
}
interface EffectRow {
  payload_hash: string;
  state: 'dispatching' | 'acknowledged' | 'uncertain';
  result_json: string | null;
}
const fail = (code: string, status = 409): never => { throw new EffectJournalError(code, status); };
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\0\r\n]/.test(value)) fail('effect_invalid_identity', 400);
}
/** Canonical JSON, without calling toJSON/getters or conflating non-JSON values with valid payloads. */
function encode(value: unknown): string {
  const seen = new Set<object>();
  let entries = 0;
  const normalize = (v: any, depth: number): any => {
    if (++entries > 100_000 || depth > 64) fail('effect_record_limit', 400);
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (!v || typeof v !== 'object') return fail('effect_invalid_json', 400);
    if (seen.has(v)) fail('effect_invalid_json', 400);
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) fail('effect_invalid_json', 400);
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const out: unknown[] = [];
        for (let i = 0; i < v.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
          if (descriptor && 'value' in descriptor) out.push(normalize(descriptor.value, depth + 1));
          else fail('effect_invalid_json', 400);
        }
        return out;
      }
      const pairs: [string, unknown][] = [];
      for (const key of Object.keys(v).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (!('value' in descriptor)) fail('effect_invalid_json', 400);
        // JSON object semantics: an absent optional field and an explicit undefined field are equivalent.
        if (descriptor.value !== undefined) pairs.push([key, normalize(descriptor.value, depth + 1)]);
      }
      return Object.fromEntries(pairs);
    } finally { seen.delete(v); }
  };
  let serialized: string;
  try { serialized = JSON.stringify(normalize(value, 0)); }
  catch (e) { if (e instanceof EffectJournalError) throw e; return fail('effect_invalid_json', 400); }
  if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) fail('effect_record_limit', 400);
  return serialized;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export class EffectJournal {
  private db?: Database;
  constructor(readonly path: string) {
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) fail('effect_invalid_path', 400);
  }
  private database(): Database {
    if (this.db) return this.db;
    // Only initialization is retried: SQLite may reject simultaneous cold WAL setup before busy_timeout applies.
    // A claimed effect/ACK transaction is never blindly replayed by this loop.
    for (let attempt = 0; ; attempt++) {
    try {
      if (this.path !== ':memory:') {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) fail('effect_store_symlink', 503);
        const fd = openSync(this.path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
      }
      const db = new Database(this.path, { create: true });
      try {
        db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
        db.transaction(() => {
          db.exec('CREATE TABLE IF NOT EXISTS continuity_effect_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);');
          const version = db.query('SELECT version FROM continuity_effect_schema WHERE id=1').get() as { version: number } | null;
          if (version && version.version !== 1) fail('effect_store_version_unsupported', 503);
          if (!version) db.exec('INSERT INTO continuity_effect_schema(id,version) VALUES(1,1);');
          db.exec(`CREATE TABLE IF NOT EXISTS continuity_effect_locks (
            room_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, acquired_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS continuity_effects (
            room_id TEXT NOT NULL, operation_id TEXT NOT NULL, step TEXT NOT NULL,
            payload_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('dispatching','acknowledged','uncertain')),
            result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(room_id,operation_id,step));`);
        }).immediate();
        this.db = db;
        return db;
      } catch (e) { db.close(); throw e; }
    } catch (e: any) {
      if (e instanceof EffectJournalError) throw e;
      const locked = ['SQLITE_BUSY','SQLITE_LOCKED'].includes(e?.code) || [5,6].includes(e?.errno) || /database (?:table )?is locked/i.test(String(e?.message ?? ''));
      if (locked && attempt < 5) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
        continue;
      }
      return fail('effect_store_unavailable', 503);
    }
    }
  }
  private transaction<T>(action: (db: Database) => T): T {
    try { const db = this.database(); return db.transaction(() => action(db)).immediate(); }
    catch (e) { if (e instanceof EffectJournalError) throw e; return fail('effect_store_unavailable', 503); }
  }
  private row(db: Database, roomId: string, operationId: string, step: string): EffectRow | null {
    const row = db.query('SELECT payload_hash,state,result_json FROM continuity_effects WHERE room_id=? AND operation_id=? AND step=?').get(roomId, operationId, step) as EffectRow | null;
    if (row && (typeof row.payload_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.payload_hash) || !['dispatching','acknowledged','uncertain'].includes(row.state))) fail('effect_store_corrupt', 503);
    return row;
  }
  private acquireInside(db: Database, roomId: string, operationId: string): void {
    const lock = db.query('SELECT operation_id FROM continuity_effect_locks WHERE room_id=?').get(roomId) as { operation_id: string } | null;
    if (lock) { if (lock.operation_id !== operationId) fail('effect_room_locked'); return; }
    db.query('INSERT INTO continuity_effect_locks(room_id,operation_id,acquired_at) VALUES(?,?,?)').run(roomId, operationId, Date.now());
  }
  acquire(roomId: string, operationId: string): void {
    identifier(roomId); identifier(operationId);
    this.transaction(db => this.acquireInside(db, roomId, operationId));
  }
  release(roomId: string, operationId: string): void {
    identifier(roomId); identifier(operationId);
    this.transaction(db => {
      const lock = db.query('SELECT operation_id FROM continuity_effect_locks WHERE room_id=?').get(roomId) as { operation_id: string } | null;
      if (!lock) return; // Repeating an explicit release is harmless; it never clears another owner's lock.
      if (lock.operation_id !== operationId) fail('effect_room_locked');
      db.query('DELETE FROM continuity_effect_locks WHERE room_id=? AND operation_id=?').run(roomId, operationId);
    });
  }
  /** Observe a phase without acquiring a lock or granting dispatch permission. */
  status(roomId: string, operationId: string, step: string): {state:'unknown'|'dispatching'|'acknowledged'|'uncertain';result?:unknown} {
    identifier(roomId); identifier(operationId); identifier(step);
    const row=this.row(this.database(),roomId,operationId,step);
    if(!row)return {state:'unknown'};
    if(row.state!=='acknowledged'||row.result_json===null)return {state:row.state};
    try{return {state:row.state,result:JSON.parse(row.result_json)};}catch{return fail('effect_store_corrupt',503);}
  }
  claim(input: EffectClaim): EffectClaimResult {
    if (!input || typeof input !== 'object') fail('effect_invalid_claim', 400);
    const { roomId, operationId, step, payload } = input;
    identifier(roomId); identifier(operationId); identifier(step);
    const payloadHash = hash(encode(payload));
    return this.transaction(db => {
      const existing = this.row(db, roomId, operationId, step);
      if (existing) {
        if (existing.payload_hash !== payloadHash) fail('effect_payload_conflict');
        if (existing.state === 'acknowledged') {
          if (existing.result_json === null) return { state: 'acknowledged' };
          try { return { state: 'acknowledged', result: JSON.parse(existing.result_json) }; }
          catch { return fail('effect_store_corrupt', 503); }
        }
        // An existing claim never grants mutation permission again, including same process/concurrent retries.
        if (existing.state === 'dispatching') db.query("UPDATE continuity_effects SET state='uncertain',updated_at=? WHERE room_id=? AND operation_id=? AND step=? AND state='dispatching'").run(Date.now(), roomId, operationId, step);
        return { state: 'uncertain' };
      }
      // Claiming a new step atomically acquires/verifies the room lock even if the caller omitted acquire().
      this.acquireInside(db, roomId, operationId);
      db.query("INSERT INTO continuity_effects(room_id,operation_id,step,payload_hash,state,result_json,created_at,updated_at) VALUES(?,?,?,?,'dispatching',NULL,?,?)").run(roomId, operationId, step, payloadHash, Date.now(), Date.now());
      return { state: 'claimed' };
    });
  }
  acknowledge(roomId: string, operationId: string, step: string, result: unknown): void {
    identifier(roomId); identifier(operationId); identifier(step);
    const resultJson = result === undefined ? null : encode(result);
    this.transaction(db => {
      const existing = this.row(db, roomId, operationId, step) ?? fail('effect_not_found', 404);
      if (existing.state === 'acknowledged') { if (existing.result_json !== resultJson) fail('effect_result_conflict'); return; }
      // The caller may explicitly reconcile a previously uncertain effect using verified external evidence.
      db.query("UPDATE continuity_effects SET state='acknowledged',result_json=?,updated_at=? WHERE room_id=? AND operation_id=? AND step=?").run(resultJson, Date.now(), roomId, operationId, step);
    });
  }
  uncertain(roomId: string, operationId: string, step: string): void {
    identifier(roomId); identifier(operationId); identifier(step);
    this.transaction(db => {
      const existing = this.row(db, roomId, operationId, step) ?? fail('effect_not_found', 404);
      if (existing.state === 'acknowledged') fail('effect_already_acknowledged');
      db.query("UPDATE continuity_effects SET state='uncertain',updated_at=? WHERE room_id=? AND operation_id=? AND step=?").run(Date.now(), roomId, operationId, step);
    });
  }
  /** Closing the database never releases room ownership, resets uncertainty or replays an effect. */
  close(): void { this.db?.close(); this.db = undefined; }
}
