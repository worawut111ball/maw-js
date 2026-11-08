import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtocolProcessSupervisor, type ApprovedProcessSpec, type OwnedProtocolProcess, type ProcessLaunchPermit, type ProcessSupervisorLimits } from '../src/mobile/continuity/protocol/process-supervisor';
import { ProtocolSessionLeases } from '../src/mobile/continuity/protocol/session-lease';
import { EffectJournal } from '../src/mobile/continuity/effect-journal';

const children: OwnedProtocolProcess[] = [], dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(children.splice(0).map(child => child.cleanup()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixtureNode = Bun.which('node');
if (!fixtureNode) throw Error('fixture Node executable required');
const script = `#!${realpathSync(fixtureNode)}
import {createInterface} from 'node:readline';
import {writeFileSync,writeSync,closeSync} from 'node:fs';
const mode=process.argv[2];
writeFileSync(process.env.FIXTURE_MARKER,'started');
if(mode==='ignoreterm'||mode==='eof'||mode==='no-read') {process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
process.stdout.write(JSON.stringify({ready:true,inherited:process.env.MAW_SUPERVISOR_FIXTURE_PARENT_ONLY??null,explicit:process.env.FIXTURE_EXPLICIT,args:process.argv.slice(3)})+'\\n');
if(mode!=='no-read'){
 for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  const value=JSON.parse(line);
  if(value.action==='eof') {closeSync(1);continue;}
  if(value.action==='stderr') {process.stderr.write('Bearer fixture-private-value\\x1b[31m'+'x'.repeat(value.bytes||1));continue;}
  if(value.action==='flood') {process.stdout.write(JSON.stringify({text:'x'.repeat(4000)})+'\\n');continue;}
  if(value.action==='malformed') {process.stdout.write('fixture-private-value NOT JSON\\n');continue;}
  if(value.action==='partial') {writeSync(1,'{"private":"fixture-private-value');closeSync(1);continue;}
  process.stdout.write(JSON.stringify({echo:value})+'\\n');
 }
}
`;
function fixture(mode = 'echo', limits: Partial<ProcessSupervisorLimits> = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'maw-private-stdio-'))); dirs.push(cwd);
  const binary = join(cwd, 'fixture-child.mjs'), marker = join(cwd, 'child-started');
  writeFileSync(binary, script, { mode: 0o700 });
  const spec: ApprovedProcessSpec = { binary, sha256: createHash('sha256').update(script).digest('hex'), cwd,
    args: [mode], env: { FIXTURE_MARKER: marker, FIXTURE_EXPLICIT: 'fixture-value' } };
  const hooks: { pending: boolean; preflight?: (candidate: unknown, permit: Readonly<ProcessLaunchPermit>) => Promise<ApprovedProcessSpec> } = { pending: false };
  let checks = 0;
  const options = { preflight: async (candidate: unknown, permit: Readonly<ProcessLaunchPermit>) => {
    checks++; expect(existsSync(marker)).toBe(false); return hooks.preflight ? hooks.preflight(candidate, permit) : spec;
  }, pendingWork: () => hooks.pending, limits: { preflightMs: 2_000, lifetimeMs: 10_000, graceMs: 30, terminateMs: 50, killWaitMs: 1_000, writeMs: 100, ...limits } };
  const supervisor = new ProtocolProcessSupervisor(options);
  const permit: ProcessLaunchPermit = { incarnation: randomUUID(), launchId: randomUUID() };
  const launch = async (candidate: unknown = { candidateOnly: true, liveEligible: false }, grant = permit) => {
    const owned = await supervisor.launch(candidate, grant); children.push(owned); return owned;
  };
  return { cwd, binary, marker, spec, supervisor, options, hooks, permit, launch, checks: () => checks };
}
const expected = (owned: OwnedProtocolProcess) => ({ incarnation: owned.incarnation, launchId: owned.launchId, runtimeBirth: owned.runtimeBirth });
async function next(iterator: AsyncIterator<unknown>) {
  const result = await iterator.next(); expect(result.done).not.toBe(true); return result.value as any;
}
async function waitUntil(check: () => boolean | Promise<boolean>, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) { if (Date.now() > deadline) throw Error('fixture observation deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
test('trusted preflight precedes child launch, JSONL roundtrip and exact owned exit after cleanup', async () => {
  const f = fixture(), owned = await f.launch(); expect(f.checks()).toBe(1);
  const iterator = owned.wire.messages[Symbol.asyncIterator](); expect(await next(iterator)).toMatchObject({ ready: true });
  await owned.assertRunning();
  await expect(owned.observeExit(expected(owned))).rejects.toMatchObject({ code: 'protocol_process_exit_unverified' });
  await owned.wire.send({ id: 1, text: 'synthetic public prompt' }); expect(await next(iterator)).toEqual({ echo: { id: 1, text: 'synthetic public prompt' } });
  await owned.cleanup(); await owned.wire.close();
  expect(await owned.observeExit(expected(owned))).toMatchObject({ source: 'owned-process-supervisor', ...expected(owned), inputClosed: true, outputClosed: true, pendingWork: false });
  await expect(owned.assertRunning()).rejects.toMatchObject({ code: 'protocol_process_not_running' });
});
test('exact explicit environment without inheritance and shell metacharacters remain literal argv', async () => {
  const f = fixture(); f.spec.args = ['echo', 'literal;$(fixture-no-command)', '*', 'two words'];
  const prior = process.env.MAW_SUPERVISOR_FIXTURE_PARENT_ONLY; process.env.MAW_SUPERVISOR_FIXTURE_PARENT_ONLY = 'fixture-parent-value';
  try {
    const owned = await f.launch(), iterator = owned.wire.messages[Symbol.asyncIterator]();
    expect(await next(iterator)).toMatchObject({ inherited: null, explicit: 'fixture-value', args: ['literal;$(fixture-no-command)', '*', 'two words'] });
  } finally { if (prior === undefined) delete process.env.MAW_SUPERVISOR_FIXTURE_PARENT_ONLY; else process.env.MAW_SUPERVISOR_FIXTURE_PARENT_ONLY = prior; }
});
test('candidate flags cannot authorize launch, trusted denial is sanitized and never retried', async () => {
  const f = fixture(); f.hooks.preflight = async () => { throw Error('fixture-private-value'); };
  const candidate = { candidateOnly: true, liveEligible: true, env: { FIXTURE_TOKEN: 'fixture-private-value' } };
  await expect(f.launch(candidate)).rejects.toMatchObject({ code: 'protocol_process_preflight_failed' });
  await expect(f.launch(candidate)).rejects.toMatchObject({ code: 'protocol_process_launch_replayed' });
  expect(f.checks()).toBe(1); expect(existsSync(f.marker)).toBe(false);
});
test('preflight boolean and raw shell/options object cannot become an approved process specification', async () => {
  for (const result of [true, { shell: true }, { binary: '/bin/sh', args: [] }]) {
    const f = fixture(); f.hooks.preflight = async () => result as any;
    await expect(f.launch()).rejects.toMatchObject({ code: 'protocol_process_preflight_failed' }); expect(existsSync(f.marker)).toBe(false);
  }
  expect(() => new ProtocolProcessSupervisor({} as any)).toThrow('protocol_process_preflight_required');
});
test('deferred preflight cannot spawn before approval; preflight timeout never spawns on later resolution', async () => {
  const f = fixture('echo', { preflightMs: 30 }); let approve!: (s: ApprovedProcessSpec) => void;
  f.hooks.preflight = () => new Promise(resolve => { approve = resolve; });
  const pending = f.launch(); await waitUntil(() => !!approve); expect(existsSync(f.marker)).toBe(false);
  await expect(pending).rejects.toMatchObject({ code: 'protocol_process_preflight_failed' });
  approve(f.spec); await new Promise(resolve => setTimeout(resolve, 10));
  expect(existsSync(f.marker)).toBe(false); expect(f.checks()).toBe(1);
});
test('pin mismatch and invalid canonical cwd reject before any child startup', async () => {
  for (const shape of ['pin', 'cwd', 'accessor'] as const) {
    const f = fixture();
    if (shape === 'pin') f.spec.sha256 = '0'.repeat(64);
    if (shape === 'cwd') f.spec.cwd = join(f.cwd, 'missing');
    if (shape === 'accessor') Object.defineProperty(f.spec.env, 'FIXTURE_TOKEN', { enumerable: true, get: () => { throw Error('fixture-private-value'); } });
    await expect(f.launch()).rejects.toMatchObject({ code: 'protocol_process_preflight_failed' }); expect(existsSync(f.marker)).toBe(false);
  }
});
test('same incarnation or launch ID cannot acquire another process, including after cleanup', async () => {
  const f = fixture(), owned = await f.launch(); await owned.cleanup();
  await expect(f.launch()).rejects.toMatchObject({ code: 'protocol_process_launch_replayed' });
  await expect(f.launch({}, { incarnation: f.permit.incarnation, launchId: randomUUID() })).rejects.toMatchObject({ code: 'protocol_process_launch_replayed' });
  await expect(f.launch({}, { incarnation: randomUUID(), launchId: f.permit.launchId })).rejects.toMatchObject({ code: 'protocol_process_launch_replayed' }); expect(f.checks()).toBe(1);
});
test('EOF while owned child is alive is not exit proof and cannot accept another input', async () => {
  const f = fixture('eof'), owned = await f.launch(), iterator = owned.wire.messages[Symbol.asyncIterator](); await next(iterator);
  await owned.wire.send({ action: 'eof' }); expect((await iterator.next()).done).toBe(true);
  await expect(owned.assertRunning()).rejects.toMatchObject({ code: 'protocol_process_not_running' });
  await expect(owned.observeExit(expected(owned))).rejects.toMatchObject({ code: 'protocol_process_exit_unverified' });
  await expect(owned.wire.send({ text: 'must not resend' })).rejects.toMatchObject({ code: 'protocol_process_not_running' });
  await owned.cleanup(); expect((await owned.observeExit(expected(owned))).exit.signal).toBe('SIGKILL'); expect(f.checks()).toBe(1);
});
test('cleanup waits for real exit of a SIGTERM-ignoring owned child and is idempotent', async () => {
  const f = fixture('ignoreterm'), owned = await f.launch(); await next(owned.wire.messages[Symbol.asyncIterator]());
  const first = owned.cleanup(), second = owned.cleanup(); expect(first).toBe(second);
  await expect(owned.observeExit(expected(owned))).rejects.toMatchObject({ code: 'protocol_process_exit_unverified' });
  await first; expect((await owned.observeExit(expected(owned))).exit).toEqual({ code: null, signal: 'SIGKILL' });
});
test('exit evidence rejects wrong incarnation/launch/birth and trusted pending work', async () => {
  const f = fixture(), owned = await f.launch(); await next(owned.wire.messages[Symbol.asyncIterator]()); await owned.cleanup();
  for (const key of ['incarnation', 'launchId', 'runtimeBirth'] as const)
    await expect(owned.observeExit({ ...expected(owned), [key]: 'foreign' })).rejects.toMatchObject({ code: 'protocol_process_exit_unverified' });
  f.hooks.pending = true; await expect(owned.observeExit(expected(owned))).rejects.toMatchObject({ code: 'protocol_process_exit_unverified' });
  f.hooks.pending = false; expect((await owned.observeExit(expected(owned))).pendingWork).toBe(false);
});
test('trusted callbacks are captured and diagnostics never contain raw private stderr', async () => {
  const f = fixture(), owned = await f.launch(); f.options.pendingWork = () => true;
  f.options.preflight = async () => { throw Error('changed'); };
  const iterator = owned.wire.messages[Symbol.asyncIterator](); await next(iterator);
  await owned.wire.send({ action: 'stderr', bytes: 8 }); await waitUntil(() => owned.diagnostics().stderrBytes > 0);
  expect(owned.diagnostics().stderr).toBe('[native stderr omitted]'); expect(JSON.stringify(owned.diagnostics())).not.toContain('fixture-private-value');
  await owned.cleanup(); expect((await owned.observeExit(expected(owned))).pendingWork).toBe(false);
});
test('stderr cap drains bounded metadata and terminates only the owned child without relaunch', async () => {
  const f = fixture('echo', { maxStderrBytes: 128 }), owned = await f.launch(), iterator = owned.wire.messages[Symbol.asyncIterator](); await next(iterator);
  await owned.wire.send({ action: 'stderr', bytes: 4_000 }); await waitUntil(() => owned.diagnostics().stderrTruncated);
  await owned.cleanup(); expect(owned.diagnostics()).toEqual({ stderrBytes: 129, stderrTruncated: true, stderr: '[native stderr limit exceeded]' });
  expect(f.checks()).toBe(1); expect(JSON.stringify(owned.diagnostics())).not.toContain('fixture-private-value');
});
for (const action of ['malformed', 'partial', 'flood']) test(`native ${action} output fails closed and never replays an input`, async () => {
  const f = fixture('echo', { maxStdoutBytes: 1_024 }), owned = await f.launch(), iterator = owned.wire.messages[Symbol.asyncIterator](); await next(iterator);
  await owned.wire.send({ action });
  await expect(iterator.next()).rejects.toMatchObject({ code: 'protocol_process_read_uncertain', uncertain: true });
  await owned.cleanup(); await expect(owned.wire.send({ text: 'not retried' })).rejects.toMatchObject({ code: 'protocol_process_not_running' }); expect(f.checks()).toBe(1);
});
test('lifetime timeout revokes input, cleans up and cannot automatically relaunch', async () => {
  const f = fixture('ignoreterm', { lifetimeMs: 500 }), owned = await f.launch(); await next(owned.wire.messages[Symbol.asyncIterator]());
  await waitUntil(async () => { try { await owned.assertRunning(); return false; } catch { return true; } });
  await owned.cleanup(); expect(f.checks()).toBe(1); expect((await owned.observeExit(expected(owned))).exit.signal).toBe('SIGKILL');
});
test('backpressured write is bounded, queued input is not admitted and failed input is never resent', async () => {
  const f = fixture('no-read', { writeMs: 40, maxPendingWrites: 1 }), owned = await f.launch(); await next(owned.wire.messages[Symbol.asyncIterator]());
  const pending = owned.wire.send({ text: 'x'.repeat(2 * 1024 * 1024) });
  await expect(owned.wire.send({ id: 'queued' })).rejects.toMatchObject({ code: 'protocol_process_write_capacity' });
  await expect(pending).rejects.toMatchObject({ code: 'protocol_process_write_uncertain', uncertain: true }); await owned.cleanup();
  await expect(owned.wire.send({ text: 'explicit retry forbidden' })).rejects.toMatchObject({ code: 'protocol_process_not_running' }); expect(f.checks()).toBe(1);
});
test('two owned children have distinct births and cleaning one cannot prove exit of the other', async () => {
  const a = fixture(), b = fixture(), one = await a.launch(), two = await b.launch();
  await next(one.wire.messages[Symbol.asyncIterator]()); const iterator = two.wire.messages[Symbol.asyncIterator](); await next(iterator);
  expect(one.runtimeBirth).not.toBe(two.runtimeBirth); await one.cleanup(); await two.assertRunning();
  await expect(two.observeExit(expected(one))).rejects.toMatchObject({ code: 'protocol_process_exit_unverified' });
  await two.wire.send({ id: 2 }); expect(await next(iterator)).toEqual({ echo: { id: 2 } });
});
test('lease integration binds owned birth and cannot release lifetime on EOF before actual cleanup', async () => {
  const f = fixture('eof'), journal = new EffectJournal(join(f.cwd, 'effects.sqlite'));
  let owned!: OwnedProtocolProcess;
  const leases = new ProtocolSessionLeases(journal, { observeExit: expected => owned.observeExit(expected) });
  try {
    const result = leases.reserve({ roomId: 'fixture-room', operationId: 'fixture-op', agent: 'codex', toolHome: f.cwd, mode: 'fresh' });
    if (result.state !== 'reserved') throw Error('fixture requires reservation');
    const permit = leases.beginLaunch(result.lease); owned = await f.launch({}, permit);
    leases.bindRuntime(result.lease, { launchId: permit.launchId, runtimeBirth: owned.runtimeBirth });
    const iterator = owned.wire.messages[Symbol.asyncIterator](); await next(iterator);
    leases.verifyNative(result.lease, { agent: 'codex', nativeId: '11111111-1111-4111-8111-111111111111' });
    await owned.wire.send({ action: 'eof' }); await iterator.next();
    await expect(leases.release(result.lease)).rejects.toMatchObject({ code: 'session_exit_unverified' });
    await owned.cleanup(); expect((await leases.release(result.lease)).state).toBe('released');
  } finally { journal.close(); }
});
test('launch record capacity is fail closed and never evicts old permits', async () => {
  const f = fixture('echo', { maxLaunches: 1 }), owned = await f.launch(); await owned.cleanup();
  await expect(f.launch({}, { incarnation: randomUUID(), launchId: randomUUID() })).rejects.toMatchObject({ code: 'protocol_process_capacity' }); expect(f.checks()).toBe(1);
});
