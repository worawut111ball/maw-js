import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, rmSync, existsSync, statSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriterFence, WriterFenceError, type FenceBinding } from '../src/mobile/continuity/writer-fence';

const roots: string[] = [], stores: WriterFence[] = [];
const target = (changes: Partial<FenceBinding> = {}): FenceBinding => ({ backend: 'herdr', endpoint: 'synthetic-server',
  workspace: 'workspace-1', room: 'pane-1', terminal: 'terminal-1', nativeId: 'synthetic-native',
  runtimeInstance: 'synthetic-agent:birth-1:terminal-1', ...changes });
const hash = 'a'.repeat(64);
function setup(capacity?: number) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'maw-writer-fence-'))); roots.push(dir);
  const path = join(dir, 'fence.sqlite');
  const fence = new WriterFence(path, capacity); stores.push(fence);
  return { dir, path, fence };
}
function open(path: string) { const f = new WriterFence(path); stores.push(f); return f; }
function acquire(f: WriterFence, id = 'lease-1', mode: 'read' | 'write' = 'write', gen = 1, roomId = 'room-1') {
  return f.acquire({ roomId, id, ownerId: 'workflow-1', mode, expectedGeneration: gen });
}
function fails(code: string, fn: () => unknown) {
  try { fn(); throw new Error('Expected failure: ' + code); }
  catch (e) { expect(e).toBeInstanceOf(WriterFenceError); expect((e as WriterFenceError).code).toBe(code); }
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('cooperative durable maw writer fence (no provider/CLI)', () => {
  test('construction is inert, private durable store is lazy, close does not unlock', () => {
    const { fence, path } = setup(); expect(existsSync(path)).toBe(false);
    fence.register('room-1', target()); expect(statSync(path).mode & 0o777).toBe(0o600);
    acquire(fence); fence.close();
    fails('fence_closed', () => fence.status('room-1'));
    fails('fence_busy', () => acquire(open(path), 'other'));
  });
  test('registration is exact-idempotent and observations do not expose capability', () => {
    const { fence } = setup(); const original = fence.register('room-1', target());
    expect(fence.register('room-1', target())).toEqual(original);
    const lease = acquire(fence);
    const status = fence.status('room-1');
    expect(status.leases).toEqual([{ id: lease.id, ownerId: lease.ownerId, mode: 'write', generation: 1, state: 'active' }]);
    expect(JSON.stringify(status)).not.toContain(lease.token);
    fails('fence_binding_changed', () => fence.register('room-1', target({ terminal: 'replacement' })));
    status.binding.terminal = 'caller-mutated'; expect(fence.status('room-1').binding.terminal).toBe('terminal-1');
  });
  test.each(['herdr', 'tmux', 'superset'] as const)('%s prevents a second logical room fencing the same physical resource', backend => {
    const { fence } = setup(); fence.register('room-1', target({ backend }));
    fails('fence_resource_registered', () => fence.register('alias', target({ backend, terminal: 'new-terminal', nativeId: 'another-native', runtimeInstance: 'birth-2' })));
  });
  test('tmux directory/session aliases do not bypass physical pane uniqueness', () => {
    const { fence } = setup(); fence.register('room-1', target({ backend: 'tmux', workspace: 'session-name' }));
    fails('fence_resource_registered', () => fence.register('alias', target({ backend: 'tmux', workspace: 'dir:/synthetic' })));
  });
  test.each(['herdr', 'tmux', 'superset'] as const)('%s rejects same terminal hidden behind different room/workspace coordinates', backend => {
    const { fence, path } = setup(); fence.register('room-1', target({ backend })); const first = acquire(fence);
    const other = open(path);
    fails('fence_terminal_registered', () => other.register('alias', target({ backend, workspace: 'workspace-alias', room: 'pane-alias',
      nativeId: 'other-native', runtimeInstance: 'other-birth' })));
    fails('fence_room_missing', () => acquire(other, 'alias-writer', 'write', 1, 'alias'));
    fence.assert(first, 'write'); expect(fence.status('room-1').leases).toHaveLength(1);
  });
  test('backend label cannot create a second lock for the same canonical endpoint and terminal', () => {
    const { fence } = setup(); fence.register('room-1', target());
    fails('fence_terminal_registered', () => fence.register('alias', target({ backend: 'tmux', workspace: 'another', room: '%9' })));
  });
  test('rebind cannot steal another registered physical terminal; rejected transaction retains identity/generation', () => {
    const { fence } = setup(); fence.register('room-1', target());
    fence.register('room-2', target({ room: 'pane-2', terminal: 'terminal-2', runtimeInstance: 'birth-2' }));
    const a = acquire(fence), b = acquire(fence, 'other-writer', 'write', 1, 'room-2');
    fails('fence_terminal_registered', () => fence.rebind(b, target({ room: 'pane-2', terminal: 'terminal-1', runtimeInstance: 'birth-3' })));
    expect(fence.status('room-2').generation).toBe(1);
    expect(fence.status('room-2').binding.terminal).toBe('terminal-2');
    fence.assert(a, 'write'); fence.assert(b, 'write');
  });
  test('independent readers coexist; writer cannot enter until every reader releases', () => {
    const { fence, path } = setup(); fence.register('room-1', target()); const other = open(path);
    const a = acquire(fence, 'a', 'read'), b = acquire(other, 'b', 'read');
    fence.assert(a, 'read'); other.assert(b, 'read');
    fails('fence_busy', () => acquire(other, 'w'));
    fence.release(a); fails('fence_busy', () => acquire(other, 'w'));
    other.release(b); const w = acquire(fence, 'w'); fence.assert(w, 'read'); fence.assert(w, 'write');
    fails('fence_busy', () => acquire(other, 'reader', 'read'));
    fails('fence_busy', () => acquire(other, 'writer'));
  });
  test('read capability cannot start effects, rebind, or forge mode', () => {
    const { fence } = setup(); fence.register('room-1', target()); const lease = acquire(fence, 'read', 'read');
    fails('fence_write_required', () => fence.beginEffect(lease, { id: 'send', payloadHash: hash }));
    fails('fence_write_required', () => fence.rebind(lease, target({ nativeId: 'other' })));
    fails('fence_invalid_lease', () => fence.assert({ ...lease, mode: 'write' }, 'write'));
    expect(fence.status('room-1').effects).toEqual([]);
  });
  test('old clients without valid generation fail closed and leave no lease', () => {
    const { fence } = setup(); fence.register('room-1', target());
    for (const expectedGeneration of [undefined, null, 0, -1, 1.1, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      fails('fence_generation_required', () => fence.acquire({ roomId: 'room-1', id: 'old-client', ownerId: 'ui', mode: 'write', expectedGeneration } as any));
    }
    expect(fence.status('room-1').leases).toEqual([]);
    fails('fence_stale_generation', () => acquire(fence, 'stale', 'write', 2));
  });
  test('tokens, owner, room, mode and generation are capabilities, not trusted client claims', () => {
    const { fence } = setup(); fence.register('room-1', target()); fence.register('room-2', target({ room: 'pane-2', terminal: 'terminal-2', runtimeInstance: 'birth-2' }));
    const lease = acquire(fence);
    for (const changes of [{ token: 'forged' }, { ownerId: 'another-owner' }, { roomId: 'room-2' }, { id: 'other-id' }]) {
      fails('fence_invalid_lease', () => fence.release({ ...lease, ...changes }));
    }
    fails('fence_stale_generation', () => fence.assert({ ...lease, generation: 2 }, 'write'));
    fails('fence_lease_id_used', () => acquire(fence));
    fence.release(lease); fence.release(lease);
    fails('fence_lease_released', () => fence.assert(lease, 'read'));
    fails('fence_lease_id_used', () => acquire(fence));
    expect(fence.status('room-1').leases).toEqual([]);
  });
  test('crash after intent: reopened process cannot dispatch/release/rebind accidentally', () => {
    const { fence, path } = setup(); fence.register('room-1', target()); const lease = acquire(fence);
    expect(fence.beginEffect(lease, { id: 'send', payloadHash: hash }).dispatch).toBe(true);
    fence.close(); const restarted = open(path);
    expect(restarted.beginEffect(lease, { id: 'send', payloadHash: hash })).toEqual({ dispatch: false, state: 'dispatching' });
    fails('fence_effect_pending', () => restarted.release(lease));
    fails('fence_effect_pending', () => restarted.rebind(lease, target({ runtimeInstance: 'birth-2' })));
    fails('fence_busy', () => acquire(restarted, 'retry'));
    expect(restarted.status('room-1').effects[0].state).toBe('dispatching');
  });
  test('effect intent allows exactly one dispatch under competing connections; different effect waits', () => {
    const { fence, path } = setup(); fence.register('room-1', target()); const lease = acquire(fence), other = open(path);
    let inputs = 0;
    for (const s of [fence, other, fence, other]) if (s.beginEffect(lease, { id: 'send', payloadHash: hash }).dispatch) inputs++;
    expect(inputs).toBe(1);
    fails('fence_effect_pending', () => other.beginEffect(lease, { id: 'another-key', payloadHash: hash }));
    fails('fence_effect_conflict', () => other.beginEffect(lease, { id: 'send', payloadHash: 'b'.repeat(64) }));
    fence.finishEffect(lease, 'send', 'acknowledged');
    expect(other.beginEffect(lease, { id: 'send', payloadHash: hash })).toEqual({ dispatch: false, state: 'acknowledged' });
    expect(other.beginEffect(lease, { id: 'enter', payloadHash: hash }).dispatch).toBe(true);
    other.finishEffect(lease, 'enter', 'acknowledged'); fence.release(lease);
    const next = acquire(other, 'next');
    fails('fence_effect_conflict', () => other.beginEffect(next, { id: 'send', payloadHash: hash }));
    expect(inputs).toBe(1);
  });
  test('four independent processes racing for write produce one intent; process exit retains the lock', async () => {
    const { fence, path } = setup(); fence.register('room-1', target());
    const modulePath = new URL('../src/mobile/continuity/writer-fence.ts', import.meta.url).pathname;
    const script = `import {WriterFence} from ${JSON.stringify(modulePath)};
      const f=new WriterFence(process.argv[1]);
      try {const l=f.acquire({roomId:'room-1',id:process.argv[2],ownerId:'synthetic-child',mode:'write',expectedGeneration:1});
        console.log(f.beginEffect(l,{id:'single-input',payloadHash:'a'.repeat(64)}).dispatch?'intent':'duplicate');
      } catch(e) { console.log(e.code); } finally {f.close();}`;
    const children = Array.from({ length: 4 }, (_, n) => Bun.spawn([process.execPath, '--eval', script, path, 'child-' + n], { stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(children.map(async child => {
      const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit).toBe(0); expect(err).toBe(''); return out.trim();
    }));
    expect(results.filter(r => r === 'intent')).toHaveLength(1);
    expect(results.filter(r => r === 'fence_busy')).toHaveLength(3);
    expect(fence.status('room-1').effects).toHaveLength(1);
    fails('fence_busy', () => acquire(fence, 'after-exit'));
  });
  test('physical terminal alias registration race across processes grants only one write authority', async () => {
    const { fence, path } = setup(); fence.register('seed', target({ room: 'seed-pane', terminal: 'seed-terminal' }));
    const modulePath = new URL('../src/mobile/continuity/writer-fence.ts', import.meta.url).pathname;
    const script = `import {WriterFence} from ${JSON.stringify(modulePath)};
      const f=new WriterFence(process.argv[1]), id=process.argv[2];
      try {f.register(id,{...${JSON.stringify(target())},workspace:id,room:id});
        f.acquire({roomId:id,id:'write',ownerId:'synthetic-child',mode:'write',expectedGeneration:1}); console.log('writer');
      } catch(e) {console.log(e.code);} finally {f.close();}`;
    const children = Array.from({ length: 4 }, (_, n) => Bun.spawn([process.execPath, '--eval', script, path, 'alias-' + n], { stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(children.map(async child => {
      const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit).toBe(0); expect(err).toBe(''); return out.trim();
    }));
    expect(results.filter(r => r === 'writer')).toHaveLength(1);
    expect(results.filter(r => r === 'fence_terminal_registered')).toHaveLength(3);
  });
  test('timeout after provider call remains uncertain across instances with no time-based reset', () => {
    const { fence, path } = setup(); fence.register('room-1', target()); const lease = acquire(fence);
    fence.beginEffect(lease, { id: 'timeout', payloadHash: hash }); fence.finishEffect(lease, 'timeout', 'uncertain');
    const before = fence.status('room-1'); fence.close(); const restarted = open(path);
    expect(restarted.status('room-1')).toEqual(before);
    fails('fence_uncertain', () => restarted.release(lease));
    fails('fence_uncertain', () => restarted.finishEffect(lease, 'timeout', 'acknowledged'));
    fails('fence_uncertain', () => restarted.rebind(lease, target({ runtimeInstance: 'birth-2' })));
    fails('fence_uncertain', () => acquire(restarted, 'future-time', 'read'));
    expect(restarted.status('room-1').effects[0].state).toBe('uncertain');
  });
  test('exceptions after attempted input cannot release in finally; explicit uncertainty blocks next writer', () => {
    const { fence } = setup(); fence.register('room-1', target()); const lease = acquire(fence); let calls = 0;
    try {
      if (fence.beginEffect(lease, { id: 'send', payloadHash: hash }).dispatch) { calls++; throw new Error('synthetic transport failed after input'); }
    } catch { fence.markUncertain(lease); }
    fails('fence_uncertain', () => fence.release(lease));
    fails('fence_uncertain', () => acquire(fence, 'another'));
    expect(calls).toBe(1); expect(fence.status('room-1').effects[0].state).toBe('uncertain');
  });
  test('known no-dispatch finalization allows release, never reuses effect ID to retry input', () => {
    const { fence } = setup(); fence.register('room-1', target()); const lease = acquire(fence);
    fence.beginEffect(lease, { id: 'validation-rejected', payloadHash: hash });
    fence.finishEffect(lease, 'validation-rejected', 'not-dispatched');
    expect(fence.beginEffect(lease, { id: 'validation-rejected', payloadHash: hash })).toEqual({ dispatch: false, state: 'not-dispatched' });
    fails('fence_effect_final', () => fence.finishEffect(lease, 'validation-rejected', 'acknowledged'));
    fence.release(lease); expect(acquire(fence, 'next').mode).toBe('write');
  });
  test('same UUID and terminal with a new trusted runtime birth increments generation, invalidating old handles', () => {
    const { fence, path } = setup(); fence.register('room-1', target()); const old = acquire(fence);
    const next = fence.rebind(old, target({ runtimeInstance: 'synthetic-agent:birth-2:terminal-1' }));
    expect(next.generation).toBe(2);
    expect(fence.status('room-1').binding.nativeId).toBe(target().nativeId);
    expect(fence.status('room-1').binding.terminal).toBe(target().terminal);
    fails('fence_stale_generation', () => fence.beginEffect(old, { id: 'late-input', payloadHash: hash }));
    fails('fence_stale_generation', () => fence.release(old));
    fence.close(); const restarted = open(path);
    restarted.assert(next, 'write'); restarted.release(next);
    fails('fence_stale_generation', () => acquire(restarted, 'offline-message', 'write', 1));
    expect(acquire(restarted, 'new-message', 'write', 2).generation).toBe(2);
  });
  test('rebind is idempotent for exact identity; cannot migrate physical resources and strand their lock', () => {
    const { fence } = setup(); fence.register('room-1', target()); const lease = acquire(fence);
    expect(fence.rebind(lease, target())).toEqual(lease);
    for (const change of [{ room: 'other' }, { workspace: 'other' }, { endpoint: 'other' }, { backend: 'tmux' as const }]) {
      fails('fence_physical_resource_changed', () => fence.rebind(lease, target(change)));
    }
    expect(fence.status('room-1').generation).toBe(1);
    const next = fence.rebind(lease, target({ nativeId: 'new-native' })); expect(next.generation).toBe(2);
    expect(fence.rebind(next, target({ nativeId: 'new-native' }))).toEqual(next);
  });
  test('missing birth anchor cannot bootstrap or rebind an existing UUID', () => {
    const { fence } = setup();
    fails('fence_invalid_identity', () => fence.register('room-1', target({ runtimeInstance: undefined } as any)));
    fence.register('room-1', target()); const lease = acquire(fence);
    fails('fence_invalid_identity', () => fence.rebind(lease, target({ runtimeInstance: '' })));
    expect(fence.status('room-1').generation).toBe(1);
  });
  test('separate physical rooms do not block each other', () => {
    const { fence } = setup(); fence.register('room-1', target()); fence.register('room-2', target({ room: 'pane-2', terminal: 'terminal-2', runtimeInstance: 'birth-2' }));
    acquire(fence); const other = acquire(fence, 'other-room', 'write', 1, 'room-2');
    expect(fence.beginEffect(other, { id: 'send', payloadHash: hash }).dispatch).toBe(true);
  });
  test('same terminal label on a genuinely different canonical endpoint is a different resource', () => {
    const { fence } = setup(); fence.register('room-1', target()); fence.register('remote', target({ endpoint: 'synthetic-other-server' }));
    acquire(fence); expect(acquire(fence, 'remote-writer', 'write', 1, 'remote').roomId).toBe('remote');
  });
  test('malformed input and incomplete effect identity have zero intent side effects', () => {
    const { fence } = setup(); fence.register('room-1', target()); const lease = acquire(fence);
    for (const payloadHash of ['', 'raw prompt', 'A'.repeat(64), 'a'.repeat(63), undefined]) {
      fails('fence_payload_hash_required', () => fence.beginEffect(lease, { id: 'send', payloadHash } as any));
    }
    fails('fence_invalid_identity', () => fence.beginEffect(lease, { id: 'bad\nkey', payloadHash: hash }));
    fails('fence_invalid_outcome', () => fence.finishEffect(lease, 'send', 'screen-empty' as any));
    fails('fence_effect_missing', () => fence.finishEffect(lease, 'missing', 'acknowledged'));
    expect(fence.status('room-1').effects).toEqual([]);
  });
  test('capacity fails closed without dropping released history or an active lock', () => {
    const { fence, path } = setup(3); fence.register('room-1', target()); const lease = acquire(fence);
    fence.beginEffect(lease, { id: 'first', payloadHash: hash }); fence.finishEffect(lease, 'first', 'acknowledged');
    fails('fence_store_full', () => fence.beginEffect(lease, { id: 'second', payloadHash: hash }));
    fence.release(lease);
    fails('fence_store_full', () => acquire(fence, 'next'));
    expect(fence.status('room-1').effects).toHaveLength(1);
    fails('fence_lease_id_used', () => acquire(open(path)));
  });
  test('invalid memory/relative store cannot silently downgrade durability', () => {
    for (const path of [':memory:', '', './fence.sqlite']) fails('fence_durable_path_required', () => new WriterFence(path));
  });
  test('corrupt store and unknown schema fail closed rather than reset', () => {
    const { fence, path } = setup(); writeFileSync(path, 'synthetic corrupt database');
    fails('fence_store_unavailable', () => fence.register('room-1', target()));
    expect(readFileSync(path, 'utf8')).toBe('synthetic corrupt database');
    const other = setup(); const sql = new Database(other.path);
    sql.exec('CREATE TABLE maw_fence_schema(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO maw_fence_schema VALUES(1,99)'); sql.close();
    fails('fence_store_version', () => other.fence.register('room-1', target()));
  });
  test('previous draft schema without terminal uniqueness is rejected, never silently upgraded/unlocked', () => {
    const { fence, path } = setup(); const sql = new Database(path);
    sql.exec('CREATE TABLE maw_fence_schema(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO maw_fence_schema VALUES(1,1)'); sql.close();
    fails('fence_store_version', () => fence.register('room-1', target()));
    const verify = new Database(path); expect(verify.query('SELECT version FROM maw_fence_schema WHERE id=1').get()).toEqual({ version: 1 }); verify.close();
  });
  test('symlink store/sidecar rejected without modifying the target', () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const { fence, dir, path } = setup(); const untouched = join(dir, 'untouched'); writeFileSync(untouched, 'synthetic keep');
      symlinkSync(untouched, path + suffix);
      fails('fence_unsafe_store', () => fence.register('room-1', target()));
      expect(readFileSync(untouched, 'utf8')).toBe('synthetic keep');
    }
  });
  test('symlink parent rejects before creating descendants outside the store root', () => {
    const { dir } = setup(); const outside = setup(); const link = join(dir, 'linked-parent'); symlinkSync(outside.dir, link);
    const f = open(join(link, 'new-child', 'fence.sqlite'));
    fails('fence_store_symlink', () => f.register('room-1', target()));
    expect(existsSync(join(outside.dir, 'new-child'))).toBe(false);
  });
  test('generation overflow blocks rebind without rounding or modifying binding', () => {
    const { fence, path } = setup(); fence.register('room-1', target());
    const sql = new Database(path); sql.query('UPDATE maw_fence_rooms SET generation=?').run(Number.MAX_SAFE_INTEGER); sql.close();
    const lease = acquire(fence, 'max', 'write', Number.MAX_SAFE_INTEGER);
    fails('fence_generation_exhausted', () => fence.rebind(lease, target({ runtimeInstance: 'birth-2' })));
    expect(fence.status('room-1').binding).toEqual(target());
  });
  test('durable reader crash remains a lock; there is no force/TTL/screen-based unlock API', () => {
    const { fence, path } = setup(); fence.register('room-1', target()); acquire(fence, 'orphan-read', 'read'); fence.close();
    const reopened = open(path); fails('fence_busy', () => acquire(reopened, 'new-writer'));
    for (const method of ['forceRelease', 'expire', 'unlockFromScreen', 'reconcile']) expect((reopened as any)[method]).toBeUndefined();
    expect(reopened.status('room-1').leases[0].state).toBe('active');
  });
});
