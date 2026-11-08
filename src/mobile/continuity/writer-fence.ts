/** Cooperative maw writers only. No provider calls, timers, TTL recovery, or external-input proof. */
import { Database } from 'bun:sqlite';
import { constants, openSync, closeSync, fchmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface FenceBinding {
  backend: 'herdr' | 'tmux' | 'superset';
  /** Trusted canonical server namespace, not client-supplied labels/URLs. */
  endpoint: string;
  workspace: string;
  /** Physical pane/terminal ID, never a display name. */
  room: string;
  terminal: string;
  /** Trusted runtime birth identity/composite anchor. A PID alone is not identity proof. */
  runtimeInstance: string;
  nativeId?: string;
}
export type FenceMode = 'read' | 'write';
export interface FenceLease {
  roomId: string; id: string; ownerId: string; mode: FenceMode; generation: number;
  /** Private capability: persist with the trusted workflow; never send to a browser/log. */
  token: string;
}
export interface FenceAcquire {
  roomId: string; id: string; ownerId: string; mode: FenceMode; expectedGeneration: number;
}
export type FenceEffectState = 'dispatching' | 'acknowledged' | 'not-dispatched' | 'uncertain';
export interface FenceEffectResult { dispatch: boolean; state: FenceEffectState }
export interface FenceStatus {
  roomId: string; generation: number; binding: FenceBinding;
  leases: { id: string; ownerId: string; mode: FenceMode; generation: number; state: 'active' | 'uncertain' }[];
  effects: { id: string; leaseId: string; generation: number; state: FenceEffectState }[];
}
export class WriterFenceError extends Error {
  constructor(public code: string, public status = 409) { super(code); this.name = 'WriterFenceError'; }
}
interface RoomRow { room_id: string; generation: number; binding: string }
interface LeaseRow {
  room_id: string; id: string; owner_id: string; mode: FenceMode; generation: number;
  token: string; state: 'active' | 'released' | 'uncertain';
}
interface EffectRow { id: string; lease_id: string; generation: number; payload_hash: string; state: FenceEffectState }
function fail(code: string, status = 409): never { throw new WriterFenceError(code, status); }
function identifier(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !v || v.trim() !== v || v.length > 512 || /[\x00-\x1f\x7f]/.test(v)) fail('fence_invalid_identity', 400);
}
function generation(v: unknown): asserts v is number {
  if (!Number.isSafeInteger(v) || (v as number) < 1) fail('fence_generation_required', 400);
}
function mode(v: unknown): asserts v is FenceMode {
  if (v !== 'read' && v !== 'write') fail('fence_invalid_mode', 400);
}
function binding(v: FenceBinding): string {
  if (!v || !['herdr', 'tmux', 'superset'].includes(v.backend)) fail('fence_invalid_binding', 400);
  for (const key of ['endpoint', 'workspace', 'room', 'terminal', 'runtimeInstance'] as const) identifier(v[key]);
  if (v.nativeId !== undefined) identifier(v.nativeId);
  return JSON.stringify({ backend: v.backend, endpoint: v.endpoint, workspace: v.workspace,
    room: v.room, terminal: v.terminal, runtimeInstance: v.runtimeInstance,
    ...(v.nativeId === undefined ? {} : { nativeId: v.nativeId }) });
}
function resource(v: FenceBinding): string {
  // tmux pane IDs are server-global. Session/directory aliases must not create a second fence.
  return JSON.stringify([v.backend, v.endpoint, ...(v.backend === 'tmux' ? [] : [v.workspace]), v.room]);
}
function terminalAnchor(v: FenceBinding): string {
  // Independent of logical room/workspace/backend labels and runtime incarnation.
  // The endpoint must name the canonical physical terminal namespace across callers.
  return JSON.stringify([v.endpoint, v.terminal]);
}

export class WriterFence {
  private db?: Database;
  private closed = false;
  /** Append-only lease/effect history. Capacity exhaustion blocks, never evicts safety records. */
  constructor(readonly path: string, private readonly maxRecords = 100_000) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) fail('fence_durable_path_required', 400);
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) fail('fence_invalid_capacity', 400);
  }
  private database(): Database {
    if (this.closed) fail('fence_closed', 503);
    if (this.db) return this.db;
    let db: Database | undefined;
    try {
      const parent = dirname(resolve(this.path));
      let part = parse(parent).root;
      for (const segment of parent.slice(part.length).split(sep).filter(Boolean)) {
        part = resolve(part, segment);
        try { mkdirSync(part, { mode: 0o700 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
        const info = lstatSync(part);
        if (info.isSymbolicLink() || !info.isDirectory()) fail('fence_store_symlink', 503);
      }
      for (const file of [this.path, this.path + '-wal', this.path + '-shm']) {
        try { const s = lstatSync(file); if (s.isSymbolicLink() || !s.isFile() || s.nlink !== 1) fail('fence_unsafe_store', 503); }
        catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      }
      const fd = openSync(this.path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
      db = new Database(this.path, { create: true });
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      db.transaction(() => {
        db!.exec('CREATE TABLE IF NOT EXISTS maw_fence_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);');
        const version = db!.query('SELECT version FROM maw_fence_schema WHERE id=1').get() as { version: number } | null;
        if (version && version.version !== 2) fail('fence_store_version', 503);
        db!.exec(`INSERT OR IGNORE INTO maw_fence_schema VALUES(1,2);
          CREATE TABLE IF NOT EXISTS maw_fence_rooms(room_id TEXT PRIMARY KEY, resource TEXT NOT NULL UNIQUE,
            terminal_anchor TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL CHECK(generation>0), binding TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS maw_fence_leases(room_id TEXT NOT NULL REFERENCES maw_fence_rooms(room_id),
            id TEXT NOT NULL, owner_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('read','write')),
            generation INTEGER NOT NULL, token TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','released','uncertain')),
            PRIMARY KEY(room_id,id));
          CREATE TABLE IF NOT EXISTS maw_fence_effects(room_id TEXT NOT NULL, id TEXT NOT NULL,
            lease_id TEXT NOT NULL, generation INTEGER NOT NULL, payload_hash TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('dispatching','acknowledged','not-dispatched','uncertain')),
            PRIMARY KEY(room_id,id), FOREIGN KEY(room_id,lease_id) REFERENCES maw_fence_leases(room_id,id));`);
      }).immediate();
      this.db = db;
      return db;
    } catch (e) { db?.close(); if (e instanceof WriterFenceError) throw e; return fail('fence_store_unavailable', 503); }
  }
  private transaction<T>(fn: (db: Database) => T): T {
    try { const db = this.database(); return db.transaction(() => fn(db)).immediate(); }
    catch (e) { if (e instanceof WriterFenceError) throw e; return fail('fence_store_unavailable', 503); }
  }
  private capacity(db: Database): void {
    const n = db.query(`SELECT (SELECT count(*) FROM maw_fence_rooms)+(SELECT count(*) FROM maw_fence_leases)
      +(SELECT count(*) FROM maw_fence_effects) AS n`).get() as { n: number };
    if (n.n >= this.maxRecords) fail('fence_store_full', 503);
  }
  private room(db: Database, id: string): RoomRow {
    identifier(id);
    const r = db.query('SELECT * FROM maw_fence_rooms WHERE room_id=?').get(id) as RoomRow | null;
    return r ?? fail('fence_room_missing');
  }
  private held(db: Database, lease: FenceLease, required: FenceMode, released = false): LeaseRow {
    if (!lease) fail('fence_lease_required', 400);
    identifier(lease.roomId); identifier(lease.id); identifier(lease.ownerId); identifier(lease.token);
    mode(lease.mode); mode(required); generation(lease.generation);
    const row = db.query('SELECT * FROM maw_fence_leases WHERE room_id=? AND id=?').get(lease.roomId, lease.id) as LeaseRow | null;
    if (!row || row.token !== lease.token || row.owner_id !== lease.ownerId || row.mode !== lease.mode) fail('fence_invalid_lease');
    if (row.generation !== lease.generation || this.room(db, lease.roomId).generation !== lease.generation) fail('fence_stale_generation');
    if (row.state === 'uncertain') fail('fence_uncertain');
    if (row.state === 'released' && !released) fail('fence_lease_released');
    if (required === 'write' && row.mode !== 'write') fail('fence_write_required');
    return row;
  }
  register(roomId: string, target: FenceBinding): { roomId: string; generation: number; binding: FenceBinding } {
    identifier(roomId); const encoded = binding(target), parsed = JSON.parse(encoded), key = resource(parsed), anchor = terminalAnchor(parsed);
    return this.transaction(db => {
      const old = db.query('SELECT * FROM maw_fence_rooms WHERE room_id=?').get(roomId) as RoomRow | null;
      if (old && old.binding !== encoded) fail('fence_binding_changed');
      if (!old) {
        if (db.query('SELECT 1 FROM maw_fence_rooms WHERE resource=?').get(key)) fail('fence_resource_registered');
        if (db.query('SELECT 1 FROM maw_fence_rooms WHERE terminal_anchor=?').get(anchor)) fail('fence_terminal_registered');
        this.capacity(db);
        db.query('INSERT INTO maw_fence_rooms(room_id,resource,terminal_anchor,generation,binding) VALUES(?,?,?,1,?)').run(roomId, key, anchor, encoded);
      }
      return { roomId, generation: old?.generation ?? 1, binding: JSON.parse(encoded) };
    });
  }
  acquire(input: FenceAcquire): FenceLease {
    if (!input) fail('fence_lease_required', 400);
    identifier(input.roomId); identifier(input.id); identifier(input.ownerId); mode(input.mode); generation(input.expectedGeneration);
    return this.transaction(db => {
      const r = this.room(db, input.roomId);
      if (r.generation !== input.expectedGeneration) fail('fence_stale_generation');
      if (db.query('SELECT 1 FROM maw_fence_leases WHERE room_id=? AND id=?').get(input.roomId, input.id)) fail('fence_lease_id_used');
      const locks = db.query("SELECT mode,state FROM maw_fence_leases WHERE room_id=? AND state!='released'").all(input.roomId) as { mode: FenceMode; state: string }[];
      if (locks.some(l => l.state === 'uncertain')) fail('fence_uncertain');
      if (locks.some(l => input.mode === 'write' || l.mode === 'write')) fail('fence_busy');
      this.capacity(db);
      const lease: FenceLease = { roomId: input.roomId, id: input.id, ownerId: input.ownerId, mode: input.mode,
        generation: r.generation, token: randomBytes(32).toString('hex') };
      db.query('INSERT INTO maw_fence_leases VALUES(?,?,?,?,?,?,?)').run(lease.roomId, lease.id, lease.ownerId, lease.mode, lease.generation, lease.token, 'active');
      return lease;
    });
  }
  assert(lease: FenceLease, required: FenceMode): void { this.transaction(db => { this.held(db, lease, required); }); }
  beginEffect(lease: FenceLease, effect: { id: string; payloadHash: string }): FenceEffectResult {
    identifier(effect?.id);
    if (typeof effect.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(effect.payloadHash)) fail('fence_payload_hash_required', 400);
    return this.transaction(db => {
      this.held(db, lease, 'write');
      const old = db.query('SELECT * FROM maw_fence_effects WHERE room_id=? AND id=?').get(lease.roomId, effect.id) as EffectRow | null;
      if (old) {
        if (old.payload_hash !== effect.payloadHash || old.lease_id !== lease.id || old.generation !== lease.generation) fail('fence_effect_conflict');
        return { dispatch: false, state: old.state };
      }
      if (db.query("SELECT 1 FROM maw_fence_effects WHERE room_id=? AND state IN ('dispatching','uncertain')").get(lease.roomId)) fail('fence_effect_pending');
      this.capacity(db);
      db.query('INSERT INTO maw_fence_effects VALUES(?,?,?,?,?,?)').run(lease.roomId, effect.id, lease.id, lease.generation, effect.payloadHash, 'dispatching');
      return { dispatch: true, state: 'dispatching' };
    });
  }
  /** Caller must prove no provider call occurred before using not-dispatched; timeouts are uncertain. */
  finishEffect(lease: FenceLease, effectId: string, outcome: Exclude<FenceEffectState, 'dispatching'>): void {
    identifier(effectId);
    if (!['acknowledged', 'not-dispatched', 'uncertain'].includes(outcome)) fail('fence_invalid_outcome', 400);
    this.transaction(db => {
      this.held(db, lease, 'write');
      const old = db.query('SELECT * FROM maw_fence_effects WHERE room_id=? AND id=?').get(lease.roomId, effectId) as EffectRow | null;
      if (!old || old.lease_id !== lease.id || old.generation !== lease.generation) fail('fence_effect_missing');
      if (old.state !== 'dispatching' && old.state !== outcome) fail('fence_effect_final');
      db.query('UPDATE maw_fence_effects SET state=? WHERE room_id=? AND id=?').run(outcome, lease.roomId, effectId);
      if (outcome === 'uncertain') db.query("UPDATE maw_fence_leases SET state='uncertain' WHERE room_id=? AND id=?").run(lease.roomId, lease.id);
    });
  }
  markUncertain(lease: FenceLease): void {
    this.transaction(db => {
      this.held(db, lease, 'read');
      db.query("UPDATE maw_fence_leases SET state='uncertain' WHERE room_id=? AND id=?").run(lease.roomId, lease.id);
      db.query("UPDATE maw_fence_effects SET state='uncertain' WHERE room_id=? AND lease_id=? AND state='dispatching'").run(lease.roomId, lease.id);
    });
  }
  rebind(lease: FenceLease, target: FenceBinding): FenceLease {
    const encoded = binding(target), parsed = JSON.parse(encoded), key = resource(parsed), anchor = terminalAnchor(parsed);
    return this.transaction(db => {
      this.held(db, lease, 'write');
      const r = this.room(db, lease.roomId);
      if (r.binding === encoded) return { ...lease };
      if (resource(JSON.parse(r.binding)) !== key) fail('fence_physical_resource_changed');
      if (db.query('SELECT 1 FROM maw_fence_rooms WHERE terminal_anchor=? AND room_id!=?').get(anchor, lease.roomId)) fail('fence_terminal_registered');
      if (db.query("SELECT 1 FROM maw_fence_effects WHERE room_id=? AND state IN ('dispatching','uncertain')").get(lease.roomId)) fail('fence_effect_pending');
      if (r.generation === Number.MAX_SAFE_INTEGER) fail('fence_generation_exhausted', 503);
      const next = r.generation + 1;
      db.query('UPDATE maw_fence_rooms SET generation=?,binding=?,terminal_anchor=? WHERE room_id=?').run(next, encoded, anchor, lease.roomId);
      db.query('UPDATE maw_fence_leases SET generation=? WHERE room_id=? AND id=?').run(next, lease.roomId, lease.id);
      return { ...lease, generation: next };
    });
  }
  release(lease: FenceLease): void {
    this.transaction(db => {
      this.held(db, lease, 'read', true);
      if (db.query("SELECT 1 FROM maw_fence_effects WHERE room_id=? AND lease_id=? AND state IN ('dispatching','uncertain')").get(lease.roomId, lease.id)) fail('fence_effect_pending');
      db.query("UPDATE maw_fence_leases SET state='released' WHERE room_id=? AND id=?").run(lease.roomId, lease.id);
    });
  }
  status(roomId: string): FenceStatus {
    return this.transaction(db => {
      const r = this.room(db, roomId);
      const leases = db.query("SELECT id,owner_id AS ownerId,mode,generation,state FROM maw_fence_leases WHERE room_id=? AND state!='released' ORDER BY id").all(roomId) as FenceStatus['leases'];
      const effects = db.query('SELECT id,lease_id AS leaseId,generation,state FROM maw_fence_effects WHERE room_id=? ORDER BY id').all(roomId) as FenceStatus['effects'];
      return { roomId, generation: r.generation, binding: JSON.parse(r.binding), leases, effects };
    });
  }
  close(): void { this.db?.close(); this.db = undefined; this.closed = true; }
}
