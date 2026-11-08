import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EffectJournal } from '../src/mobile/continuity/effect-journal';
import { Database } from 'bun:sqlite';
import { ProtocolSessionLeases, type SessionLease, type SessionReservation, type SessionExitExpected } from '../src/mobile/continuity/protocol/session-lease';

const lower = 'abcdefab-1234-4000-8000-abcdefabcdef';
const dirs: string[] = [], journals: EffectJournal[] = [];
afterEach(() => { for (const j of journals.splice(0)) j.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'maw-session-lease-'))); dirs.push(home);
  const path = join(home, 'journal.sqlite');
  const open = () => { const j = new EffectJournal(path); journals.push(j); return j; };
  const journal = open();
  const observed: SessionExitExpected[] = [];
  const hooks: { exit?: (expected: SessionExitExpected) => Promise<unknown> } = {};
  const exit = async (expected: SessionExitExpected) => { observed.push(expected); return hooks.exit ? hooks.exit(expected) : proof(expected); };
  const manager = new ProtocolSessionLeases(journal, { observeExit: exit });
  const input: SessionReservation = { roomId: 'room-a', operationId: 'op-1', agent: 'codex', toolHome: home, mode: 'resume', nativeId: lower };
  const other = () => new ProtocolSessionLeases(open(), { observeExit: exit });
  return { home, path, open, journal, manager, other, input, hooks, observed };
}
const proof = (expected: SessionExitExpected) => ({ ...expected, source: 'owned-process-supervisor', exit: { code: 0, signal: null }, inputClosed: true, outputClosed: true, pendingWork: false });
function reserve(manager: ProtocolSessionLeases, input: SessionReservation): SessionLease {
  const result = manager.reserve(input); if (result.state !== 'reserved') throw Error('expected new authority'); return result.lease;
}
function launch(manager: ProtocolSessionLeases, lease: SessionLease, birth = 'fixture-supervisor:birth-1') {
  const permit = manager.beginLaunch(lease);
  manager.bindRuntime(lease, { launchId: permit.launchId, runtimeBirth: birth }); return permit;
}
function active(manager: ProtocolSessionLeases, input: SessionReservation) {
  const lease = reserve(manager, input); launch(manager, lease);
  manager.verifyNative(lease, { agent: input.agent, nativeId: input.nativeId ?? lower }); return lease;
}
function rejects(fn: () => unknown, code: string) { expect(fn).toThrow(code); }

test('reservation persists before launch and exact resume owns tuple before a second host can spawn', () => {
  const f = setup(), lease = reserve(f.manager, f.input), competitor = f.other();
  expect(f.manager.assertOwned(lease)).toMatchObject({ state: 'reserved', generation: 1, nativeId: lower });
  rejects(() => competitor.reserve({ ...f.input, roomId: 'room-b', operationId: 'op-b' }), 'session_reservation_uncertain');
  expect(f.observed).toEqual([]); expect(f.manager.beginLaunch(lease).incarnation).toBe(lease.incarnation);
  rejects(() => f.manager.beginLaunch(lease), 'session_launch_not_permitted');
});
test('an independent database reader sees committed reservation/native lock and launch permit before caller launch boundary', () => {
  const f = setup(), lease = reserve(f.manager, f.input), db = new Database(f.path, { readonly: true });
  try {
    expect(db.query("SELECT state FROM continuity_effects WHERE step='reservation'").get()).toEqual({ state: 'dispatching' });
    expect(db.query("SELECT count(*) AS n FROM continuity_effect_locks WHERE room_id LIKE 'protocol-lifetime-native:%' AND room_id NOT LIKE '%:generations'").get()).toEqual({ n: 1 });
    f.manager.beginLaunch(lease);
    expect(db.query("SELECT state FROM continuity_effects WHERE step='launch-permit'").get()).toEqual({ state: 'acknowledged' });
    // ACK means only the permit was committed, not that native launch succeeded.
    expect(f.manager.assertOwned(lease).state).toBe('launching');
  } finally { db.close(); }
});
test('new instance and original instance cannot obtain authority from same-operation idempotency', () => {
  const f = setup(), lease = reserve(f.manager, f.input);
  rejects(() => f.other().reserve(f.input), 'session_reservation_uncertain');
  rejects(() => f.manager.reserve(f.input), 'session_reservation_uncertain');
  rejects(() => f.other().assertOwned(lease), 'session_invalid_lease');
  rejects(() => f.manager.assertOwned({ ...lease }), 'session_invalid_lease');
  expect(f.manager.beginLaunch(lease).incarnation).toBe(lease.incarnation);
});
test('changed operation payload never mints a second authority', () => {
  const f = setup(); reserve(f.manager, f.input);
  rejects(() => f.other().reserve({ ...f.input, agent: 'claude' }), 'effect_payload_conflict');
});
test('UUID uppercase and toolHome symlink aliases share a lifetime lock across connections', () => {
  const f = setup(), alias = join(f.home, 'alias'); symlinkSync(f.home, alias);
  reserve(f.manager, f.input);
  rejects(() => f.other().reserve({ ...f.input, roomId: 'different', operationId: 'other', nativeId: lower.toUpperCase(), toolHome: alias }), 'session_reservation_uncertain');
});
test('different agent or genuinely different toolHome has an independent native namespace', () => {
  const f = setup(), g = setup(); reserve(f.manager, f.input);
  expect(f.other().reserve({ ...f.input, roomId: 'claude-room', agent: 'claude' }).state).toBe('reserved');
  expect(f.other().reserve({ ...f.input, roomId: 'other-home', toolHome: g.home }).state).toBe('reserved');
});
test('fresh reserves before launch, cannot claim active before runtime and links only verified UUID', () => {
  const f = setup(), input = { ...f.input, mode: 'fresh' as const, nativeId: undefined }, lease = reserve(f.manager, input);
  expect(f.manager.assertOwned(lease)).toMatchObject({ state: 'reserved' });
  expect(f.manager.assertOwned(lease).nativeId).toBeUndefined();
  rejects(() => f.manager.verifyNative(lease, { agent: 'codex', nativeId: lower }), 'session_native_not_permitted');
  launch(f.manager, lease);
  expect(f.manager.verifyNative(lease, { agent: 'codex', nativeId: lower })).toMatchObject({ state: 'active', generation: 1 });
  rejects(() => f.other().reserve({ ...f.input, roomId: 'other' }), 'session_reservation_uncertain');
});
test('fresh UUID collision never steals existing authority; supervisor exit releases only its own reservation', async () => {
  const f = setup(), old = active(f.manager, f.input), other = f.other();
  const fresh = reserve(other, { ...f.input, roomId: 'fresh', operationId: 'new', mode: 'fresh', nativeId: undefined });
  launch(other, fresh); rejects(() => other.verifyNative(fresh, { agent: 'codex', nativeId: lower }), 'session_native_uncertain');
  await other.release(fresh);
  expect(f.manager.assertOwned(old).state).toBe('active');
  rejects(() => f.other().reserve({ ...f.input, roomId: 'third' }), 'session_reservation_uncertain');
});
test('native mismatch on exact resume fails closed without fresh fallback', () => {
  const f = setup(), lease = reserve(f.manager, f.input); launch(f.manager, lease);
  rejects(() => f.manager.verifyNative(lease, { agent: 'codex', nativeId: '11111111-1111-4111-8111-111111111111' }), 'session_native_uncertain');
  rejects(() => f.manager.assertOwned(lease), 'session_not_owned');
  rejects(() => f.manager.beginLaunch(lease), 'session_launch_not_permitted');
  rejects(() => f.other().reserve({ ...f.input, roomId: 'new' }), 'session_reservation_uncertain');
});
test('generation increases for same UUID after trusted exit, stale handles remain invalid', async () => {
  const f = setup(), first = active(f.manager, f.input);
  expect(f.manager.assertOwned(first).generation).toBe(1);
  await f.manager.release(first); rejects(() => f.manager.assertOwned(first), 'session_not_owned');
  const second = active(f.manager, { ...f.input, operationId: 'op-2' });
  expect(f.manager.assertOwned(second).generation).toBe(2); expect(second.incarnation).not.toBe(first.incarnation);
  rejects(() => f.manager.beginLaunch(first), 'session_launch_not_permitted');
});
test('historical completion precedes reacquire and returns no live handle even while another incarnation owns native UUID', async () => {
  const f = setup(), first = active(f.manager, f.input), receipt = await f.manager.release(first);
  const other = f.other(), second = active(other, { ...f.input, roomId: 'new-room', operationId: 'new-op' });
  const result = f.other().reserve(f.input);
  expect(result).toEqual({ state: 'historical', receipt }); expect(result).not.toHaveProperty('lease');
  expect(other.assertOwned(second).state).toBe('active');
});
for (const phase of ['reserved', 'launching', 'active'] as const) test(`crash/reopen during ${phase} never replays launch or drops lifetime lock`, () => {
  const f = setup(), lease = reserve(f.manager, f.input);
  if (phase !== 'reserved') launch(f.manager, lease);
  if (phase === 'active') f.manager.verifyNative(lease, { agent: 'codex', nativeId: lower });
  f.journal.close(); const reopened = f.other();
  rejects(() => reopened.reserve(f.input), 'session_reservation_uncertain');
  rejects(() => reopened.reserve({ ...f.input, roomId: 'other', operationId: 'other' }), 'session_reservation_uncertain');
  rejects(() => reopened.beginLaunch(lease), 'session_invalid_lease');
});
test('uncertain retains authority locks indefinitely; only scoped trusted exit can release', async () => {
  const f = setup(), lease = active(f.manager, f.input); f.manager.markUncertain(lease);
  rejects(() => f.manager.assertOwned(lease), 'session_not_owned');
  rejects(() => f.other().reserve(f.input), 'session_reservation_uncertain');
  for (const name of ['expire', 'forceRelease', 'unlock', 'resume', 'turnComplete']) expect((f.manager as any)[name]).toBeUndefined();
  await f.manager.release(lease);
  expect(f.other().reserve({ ...f.input, operationId: 'after-exit' }).state).toBe('reserved');
});
for (const shape of ['boolean', 'incarnation', 'launchId', 'runtimeBirth', 'source', 'input', 'output', 'pending', 'noExit'] as const)
  test(`release rejects ${shape} evidence and never unlocks`, async () => {
    const f = setup(), lease = active(f.manager, f.input);
    f.hooks.exit = async expected => {
      const p: any = proof(expected);
      if (shape === 'boolean') return true;
      if (['incarnation', 'launchId', 'runtimeBirth', 'source'].includes(shape)) p[shape] = 'foreign';
      if (shape === 'input') p.inputClosed = false;
      if (shape === 'output') p.outputClosed = false;
      if (shape === 'pending') p.pendingWork = true;
      if (shape === 'noExit') p.exit = { code: null, signal: null };
      return p;
    };
    await expect(f.manager.release(lease)).rejects.toMatchObject({ code: 'session_exit_unverified', uncertain: true });
    rejects(() => f.other().reserve({ ...f.input, roomId: 'new-room' }), 'session_reservation_uncertain');
  });
test('exit observer throw cannot unlock; retry observation is allowed but launch is not', async () => {
  const f = setup(), lease = active(f.manager, f.input); f.hooks.exit = async () => { throw Error('private failure'); };
  await expect(f.manager.release(lease)).rejects.toMatchObject({ code: 'session_exit_unverified' });
  rejects(() => f.manager.beginLaunch(lease), 'session_launch_not_permitted');
  f.hooks.exit = undefined; await f.manager.release(lease);
});
test('pending exit observation prevents new operations and duplicate release', async () => {
  const f = setup(), lease = active(f.manager, f.input); let finish!: (value: unknown) => void;
  f.hooks.exit = expected => new Promise(resolve => { finish = () => resolve(proof(expected)); });
  const releasing = f.manager.release(lease);
  rejects(() => f.manager.assertOwned(lease), 'session_not_owned');
  await expect(f.manager.release(lease)).rejects.toMatchObject({ code: 'session_exit_unverified' });
  rejects(() => f.other().reserve({ ...f.input, roomId: 'other' }), 'session_reservation_uncertain');
  finish(undefined); await releasing;
});
test('no arbitrary prelaunch release, PID-only birth, wrong launch identity or external lease JSON', async () => {
  const f = setup(), lease = reserve(f.manager, f.input);
  await expect(f.manager.release(lease)).rejects.toMatchObject({ code: 'session_exit_unverified' });
  const permit = f.manager.beginLaunch(lease);
  rejects(() => f.manager.bindRuntime(lease, { launchId: permit.launchId, runtimeBirth: '12345' }), 'session_runtime_mismatch');
  rejects(() => f.manager.bindRuntime(lease, { launchId: 'foreign', runtimeBirth: 'supervisor:birth' }), 'session_runtime_mismatch');
  rejects(() => f.manager.assertOwned(JSON.parse(JSON.stringify(lease))), 'session_invalid_lease');
});
test('trusted dependency captured, observation expectation immutable and view detached', async () => {
  const f = setup(); const options = { observeExit: async (expected: SessionExitExpected) => { expect(Object.isFrozen(expected)).toBe(true); return proof(expected); } };
  const manager = new ProtocolSessionLeases(f.journal, options); options.observeExit = async () => { throw Error('replaced'); };
  const lease = active(manager, f.input), view = manager.assertOwned(lease); view.nativeId = 'changed'; view.runtimeBirth = 'changed';
  expect(manager.assertOwned(lease).nativeId).toBe(lower); await manager.release(lease);
});
test('storage failures before reservation produce no authority and never fall back to memory', () => {
  const f = setup(); f.journal.claim = () => { throw Error('fixture disk unavailable'); };
  expect(() => f.manager.reserve(f.input)).toThrow('fixture disk unavailable');
  expect(() => new ProtocolSessionLeases(new EffectJournal(':memory:'), { observeExit: async () => true })).toThrow('session_durable_store_required');
});
test('invalid home/mode/native identity rejects before durable claim', () => {
  const f = setup(); let calls = 0; f.journal.claim = () => { calls++; throw Error('must not claim'); };
  for (const input of [{ ...f.input, toolHome: 'relative' }, { ...f.input, toolHome: join(f.home, 'missing') },
    { ...f.input, nativeId: undefined }, { ...f.input, mode: 'fresh', nativeId: lower }, { ...f.input, agent: 'unknown' }])
    expect(() => f.manager.reserve(input as SessionReservation)).toThrow();
  const file = join(f.home, 'not-a-directory'); writeFileSync(file, 'fixture');
  expect(() => f.manager.reserve({ ...f.input, toolHome: file })).toThrow('session_home_unverified'); expect(calls).toBe(0);
});
test('reservation and unverified runtime are never active turn authority', () => {
  const f = setup(), lease = reserve(f.manager, f.input);
  rejects(() => f.manager.assertActive(lease), 'session_not_active');
  launch(f.manager, lease); rejects(() => f.manager.assertActive(lease), 'session_not_active');
  f.manager.verifyNative(lease, { agent: 'codex', nativeId: lower });
  expect(f.manager.assertActive(lease).state).toBe('active');
  // A completed turn is deliberately not an event in this lifetime API.
  rejects(() => f.other().reserve({ ...f.input, roomId: 'after-completed-turn' }), 'session_reservation_uncertain');
});
test('failed persistence of launch permit never returns a permit or permits a retry', () => {
  const f = setup(), lease = reserve(f.manager, f.input), claim = f.journal.claim.bind(f.journal);
  f.journal.claim = input => { if (input.step === 'launch-permit') throw Error('fixture disk failure'); return claim(input); };
  rejects(() => f.manager.beginLaunch(lease), 'session_launch_uncertain');
  f.journal.claim = claim;
  rejects(() => f.manager.beginLaunch(lease), 'session_launch_not_permitted');
  rejects(() => f.other().reserve({ ...f.input, roomId: 'other' }), 'session_reservation_uncertain');
});
test('generation acknowledgement failure strands native lock instead of reusing its generation', () => {
  const f = setup(), ack = f.journal.acknowledge.bind(f.journal);
  f.journal.acknowledge = (room, op, step, result) => { if (room.endsWith(':generations')) throw Error('fixture generation commit failure'); return ack(room, op, step, result); };
  rejects(() => f.manager.reserve(f.input), 'session_reservation_uncertain');
  rejects(() => f.other().reserve(f.input), 'session_reservation_uncertain');
  rejects(() => f.other().reserve({ ...f.input, roomId: 'other' }), 'session_reservation_uncertain');
});
test('exit persistence failure retains both locks and refuses historical success until committed', async () => {
  const f = setup(), lease = active(f.manager, f.input), ack = f.journal.acknowledge.bind(f.journal);
  f.journal.acknowledge = (room, op, step, result) => { if (step === 'exit') throw Error('fixture exit commit failure'); return ack(room, op, step, result); };
  await expect(f.manager.release(lease)).rejects.toMatchObject({ code: 'session_exit_unverified' });
  rejects(() => f.other().reserve(f.input), 'session_reservation_uncertain');
  rejects(() => f.other().reserve({ ...f.input, roomId: 'other' }), 'session_reservation_uncertain');
});
test('crash after historical ACK before native unlock never grants launch via replay', async () => {
  const f = setup(), lease = active(f.manager, f.input), release = f.journal.release.bind(f.journal);
  f.journal.release = (room, op) => { if (room.startsWith('protocol-lifetime-native:')) throw Error('fixture unlock interrupted'); return release(room, op); };
  await expect(f.manager.release(lease)).rejects.toMatchObject({ code: 'session_exit_unverified' });
  expect(f.other().reserve(f.input).state).toBe('historical');
  rejects(() => f.other().reserve({ ...f.input, roomId: 'other' }), 'session_reservation_uncertain');
  // Same surviving capability may finish local unlock after a verified exit, never repeat launch.
  f.journal.release = release; await f.manager.release(lease);
  expect(f.observed).toHaveLength(1);
});
