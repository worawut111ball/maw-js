import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createAdapters, createTransportAdapter, buildExitCommands, buildInspectCommands, buildLaunchCommands, buildSendCommands, REQUIRED_CAPABILITIES,
  type AdapterOptions, type BackendCertification, type ContextEvidence, type LaunchEvidence, type RuntimeObservation, type VerifiedTransport } from '../src/mobile/continuity/adapters';
import { buildLauncherCommand, launcherProfileHash, launcherShellCommand, quoteShellArg, type LauncherProfile } from '../src/mobile/continuity/launcher';
import { type AgentKind, type Backend, type Binding, type ContextDelivery, type Room } from '../src/mobile/continuity/types';
const NOW = 1_000_000;
const cwd = '/home/example/project';
const profile: LauncherProfile = {
  executable: '/usr/bin/node', entry: '/opt/example/artron/bin/artron-local.js', revision: 'fixture-entry-v1', route: 'direct', home: '/home/example', codexHome: '/home/example/.codex',
  nativeExecutables: { codex: '/opt/example/native/codex', claude: '/opt/example/native/claude' },
  personaVersion: 'fixture-persona-v1', rulesVersion: 'fixture-rules-v1', skillsVersion: 'fixture-skills-v1', hooksVersion: 'fixture-hooks-v1',
  models: { codex: ['fixture-codex', 'fixture-codex-2'], claude: ['fixture-claude'] }, defaultModels: { codex: 'fixture-codex', claude: 'fixture-claude' },
};
const nativeId = (kind: AgentKind) => kind === 'codex' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002';
function certificate(backend: Backend, source: 'fixture' | 'production' = 'fixture'): BackendCertification {
  return { backend, source, evidenceId: 'fixture-cert-' + backend, profileHash: launcherProfileHash(profile), verifiedAt: NOW - 1000, expiresAt: NOW + 100_000,
    checks: Object.fromEntries(REQUIRED_CAPABILITIES.map(k => [k, true])) as BackendCertification['checks'] };
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture(backend: Backend, initial: AgentKind = 'codex') {
  const binding: Binding = { agent: initial, nativeId: nativeId(initial), generation: 'initial-process', cursor: 0, route: 'direct', model: profile.defaultModels![initial] };
  const room: Room = { id: 'logical-room', backend, workspace: backend === 'herdr' ? 'herdr:w7' : backend === 'tmux' ? 'tmux' : '00000000-0000-4000-8000-000000000007',
    room: backend === 'herdr' ? 'w7:p1' : backend === 'tmux' ? '%7' : '00000000-0000-4000-8000-000000000008',
    cwd, revision: 1, active: initial, bindings: { [initial]: binding }, operationId: 'switch-1' };
  let live = structuredClone(binding), processId = 'process-1', serial = 1;
  const counts = { inspect: 0, checkpoint: 0, launch: 0, deliver: 0 };
  let inspectFault: ((o: RuntimeObservation) => void) | undefined;
  let launchFault: ((o: LaunchEvidence) => void) | undefined;
  let deliveryFault: ((o: ContextEvidence) => void) | undefined;
  let failLaunch = false, failDeliver = false;
  const policy = (value: string | undefined, pid = processId) => value === undefined ? undefined : { source: 'verified-host-report' as const, value, processId: pid, evidenceId: 'host-event-' + pid + '-' + value };
  const transport: VerifiedTransport = {
    async inspect(_room, _expected) {
      counts.inspect++;
      const o: RuntimeObservation = { roomId: room.id, backend, workspace: room.workspace, room: room.room, cwd, binding: structuredClone(live), processId, nativeMetadataId: live.nativeId,
        observedAt: NOW, generationVerified: true, noConcurrentWriter: true, status: 'idle', turnComplete: true, pendingTools: false, pendingPermission: false, uncertainDelivery: false,
        routeEvidence: policy(live.route), modelEvidence: policy(live.model) };
      inspectFault?.(o); return o;
    },
    async checkpoint(_room, source) {
      counts.checkpoint++;
      return { complete: true, binding: structuredClone(source.binding), throughEventId: 'native-event-1',
        events: [{ sourceId: 'native-event-1', agent: live.agent, nativeId: live.nativeId, role: 'assistant', text: 'งานเดิมและข้อจำกัดของห้องนี้' }] };
    },
    async launch(_room, request) {
      counts.launch++; if (failLaunch) throw new Error('launch response lost');
      const oldProcess = processId; processId = 'process-' + (++serial);
      live = { agent: request.launcher.target, nativeId: request.launcher.exactNativeId ?? nativeId(request.launcher.target), generation: 'binding-' + serial, cursor: 0,
        model: request.launcher.model, route: request.launcher.route };
      const o: LaunchEvidence = { binding: structuredClone(live), roomId: room.id, cwd, processId, nativeMetadataId: live.nativeId,
        sourceProcessId: oldProcess, sourceGeneration: request.source.binding.generation, sourceExited: true, noConcurrentWriter: true, foreground: true, readOnlyEnforced: true,
        launcherProfileHash: request.launcher.profileHash, home: profile.home, codexHome: profile.codexHome,
        personaVersion: profile.personaVersion, rulesVersion: profile.rulesVersion, skillsVersion: profile.skillsVersion, hooksVersion: profile.hooksVersion,
        routeEvidence: policy(live.route), modelEvidence: policy(live.model) };
      launchFault?.(o); return o;
    },
    async deliver(_room, current, context) {
      counts.deliver++; if (failDeliver) throw new Error('delivery response lost');
      const o: ContextEvidence = { state: 'acknowledged', requestId: context.id, nativeId: current.nativeId, generation: current.generation, processId, role: 'assistant', assistantEventId: 'assistant-summary-' + serial,
        hash: context.hash, throughSeq: context.throughSeq, summary: 'รับเป้าหมาย ข้อจำกัด งานค้าง และรอผู้ใช้สั่ง', retrieval: { verified: true, roomId: room.id, manifestHash: context.hash, throughSeq: context.throughSeq },
        readOnlyEnforced: true, writesObserved: false, pendingWorkStarted: false };
      deliveryFault?.(o); return o;
    },
  };
  const options: AdapterOptions = { launcher: structuredClone(profile), transport, certification: certificate(backend), mode: 'fixture', allowDir: p => p === cwd ? p : null, now: () => NOW };
  const adapter = createTransportAdapter(backend, options);
  return { room, adapter, options, counts, transport, setInspect: (fn?: typeof inspectFault) => { inspectFault = fn; }, setLaunch: (fn?: typeof launchFault) => { launchFault = fn; },
    setDelivery: (fn?: typeof deliveryFault) => { deliveryFault = fn; }, failLaunch: () => { failLaunch = true; }, failDeliver: () => { failDeliver = true; },
    replace: (patch: Partial<Binding>) => { Object.assign(live, patch); } };
}
function context(id = 'context-1'): ContextDelivery { const text = 'รับบริบทเพื่อสรุปแล้วรอผู้ใช้\n$(touch NEVER_RUN) `literal`'; return { id, text, hash: sha(text), throughSeq: 7 }; }

describe('launcher builders from the verified team-2 preview interface', () => {
  test('fresh/exact resume for both native kinds, no latest fallback, read-only policy and preserved homes', () => {
    for (const target of ['claude', 'codex'] as const) for (const resume of [false, true]) {
      const cmd = buildLauncherCommand(profile, { target, cwd, ...(resume ? { existing: { agent: target, nativeId: nativeId(target), generation: 'old', cursor: 4 } } : {}) });
      expect(cmd.args.slice(0, 4)).toEqual([profile.entry, 'direct', target, '--']);
      expect(cmd.environment.HOME).toBe(profile.home); expect(cmd.environment.CODEX_HOME).toBe(profile.codexHome!); expect(cmd.environment).not.toHaveProperty('PATH');
      expect(cmd.args).not.toContain('--last'); expect(cmd.args).not.toContain('--continue');
      expect(cmd.args.includes(nativeId(target))).toBe(resume);
      expect(cmd.args).toContain(target === 'codex' ? 'read-only' : 'Read'); expect(cmd.args.some(x => x.includes('dangerously'))).toBe(false);
    }
  });
  test('model catalog, foreign native IDs, malformed path and prepared-host boundary do not silently launch', () => {
    expect(() => buildLauncherCommand(profile, { target: 'claude', cwd, model: 'unknown' })).toThrow('model_unsupported');
    expect(() => buildLauncherCommand(profile, { target: 'claude', cwd, existing: { agent: 'codex', nativeId: nativeId('codex'), generation: 'g', cursor: 0 } })).toThrow('exact_native_session_required');
    expect(() => buildLauncherCommand(profile, { target: 'codex', cwd, existing: { agent: 'codex', nativeId: '--last', generation: 'g', cursor: 0 } })).toThrow();
    expect(() => buildLauncherCommand(profile, { target: 'codex', cwd: '/home/example/../other' })).toThrow();
    expect(() => buildLauncherCommand({ ...profile, boundary: 'prepared-host' }, { target: 'codex', cwd })).toThrow('prepared_host_launcher_unimplemented');
  });
  test('shell-only staging quotes all argv without executing substitutions and never replaces the shell', () => {
    const values = ["a'b", '$VALUE', '$(printf NEVER)', '`echo NEVER`', 'ไฟล์ มีช่องว่าง'];
    const script = 'set -- ' + values.map(quoteShellArg).join(' ') + '; printf "%s\\n" "$@"';
    const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
    expect(result.status).toBe(0); expect(result.stdout.trim().split('\n')).toEqual(values);
    const cmd = launcherShellCommand(buildLauncherCommand(profile, { target: 'codex', cwd }));
    expect(cmd).toStartWith("cd -- '/home/example/project' && '/usr/bin/env'"); expect(cmd).not.toContain('PATH='); expect(cmd).not.toContain('exec ');
  });
});

for (const backend of ['herdr', 'tmux', 'superset'] as const) describe(backend + ' injected continuity adapter', () => {
  for (const initial of ['codex', 'claude'] as const) test(initial + ' A→B→A→B retains native IDs and advances only with verified summary/retrieval', async () => {
    const h = fixture(backend, initial); let room = structuredClone(h.room); const other: AgentKind = initial === 'codex' ? 'claude' : 'codex';
    for (const [i, target] of [other, initial, other].entries()) {
      room.operationId = 'switch-' + (i + 1);
      expect((await h.adapter.preflight(room, target)).ready).toBe(true);
      const checkpoint = await h.adapter.checkpoint(room); expect(checkpoint[0].nativeId).toBe(room.bindings[room.active]!.nativeId);
      const launched = await h.adapter.launch(room, target, room.bindings[target]); expect(launched.nativeId).toBe(nativeId(target));
      const receipt = await h.adapter.deliver(room, launched, context('context-' + i)); expect(receipt.state).toBe('acknowledged');
      room.active = target; room.bindings[target] = { ...launched, cursor: receipt.throughSeq! }; room.revision++;
    }
    expect(h.counts.launch).toBe(3); expect(h.counts.deliver).toBe(3);
  });
  test('busy, pending tools, permission and unknown delivery are never an idle safe point', async () => {
    for (const patch of [{ status: 'working' }, { turnComplete: false }, { pendingTools: true }, { pendingTools: null }, { pendingPermission: true }, { uncertainDelivery: null }]) {
      const h = fixture(backend); h.setInspect(o => Object.assign(o, patch)); expect((await h.adapter.inspect(h.room)).idle).toBe(false);
      await expect(h.adapter.launch(h.room, 'claude')).rejects.toThrow('source_not_at_safe_point'); expect(h.counts.launch).toBe(0);
    }
  });
  test('route/model drift with unchanged native/generation is rejected, not inferred back from config', async () => {
    for (const patch of [{ route: 'mind' }, { model: 'fixture-codex-2' }]) {
      const h = fixture(backend); h.replace(patch);
      await expect(h.adapter.inspect(h.room)).rejects.toThrow('runtime_identity_unverified'); expect(h.counts.launch).toBe(0);
    }
    const h = fixture(backend); h.setInspect(o => { o.routeEvidence = { ...o.routeEvidence!, source: 'config' as any }; });
    await expect(h.adapter.inspect(h.room)).rejects.toThrow('runtime_identity_unverified');
  });
  test('launch ACK without ownership/native/model/home/host policy proof cannot return a successful binding', async () => {
    for (const change of [(o: LaunchEvidence) => { o.nativeMetadataId = nativeId('codex'); }, (o: LaunchEvidence) => { o.readOnlyEnforced = false; }, (o: LaunchEvidence) => { o.home = '/home/foreign'; }, (o: LaunchEvidence) => { o.routeEvidence = undefined; }]) {
      const h = fixture(backend); h.setLaunch(change); await expect(h.adapter.launch(h.room, 'claude')).rejects.toThrow('launch_identity_unverified');
    }
  });
  test('delivery submit ACK or missing summary/retrieval is uncertain and never retries', async () => {
    for (const change of [(o: ContextEvidence) => { o.summary = ''; }, (o: ContextEvidence) => { o.retrieval!.verified = false; }, (o: ContextEvidence) => { o.role = 'user'; }, (o: ContextEvidence) => { o.writesObserved = true; }, (o: ContextEvidence) => { o.pendingWorkStarted = true; }]) {
      const h = fixture(backend); const b = await h.adapter.launch(h.room, 'claude'); h.setDelivery(change);
      expect((await h.adapter.deliver(h.room, b, context())).state).toBe('uncertain');
      expect((await h.adapter.deliver(h.room, b, context())).state).toBe('uncertain'); expect(h.counts.deliver).toBe(1);
    }
  });
  test('backend builders have explicit targets, one native submit and no interrupt/server control', () => {
    const { room } = fixture(backend), launch = buildLaunchCommands(room, buildLauncherCommand(profile, { target: 'claude', cwd }));
    expect(launch.map(c => c.effect)).toEqual(['launch-stage', 'launch-submit']);
    const send = buildSendCommands(room, context().text); expect(send[0].args).toContain(context().text);
    if (backend === 'herdr') expect(send).toHaveLength(1);
    expect(buildExitCommands(room)[0].args).toContain('/exit');
    expect(buildInspectCommands(room).every(c => c.effect === 'read')).toBe(true);
    expect([...send, ...launch].some(c => c.args.some(a => ['kill-pane', 'kill-session', 'kill-server', 'start-server', 'respawn-pane', 'ctrl+c'].includes(a)))).toBe(false);
  });
});

test('missing/expired/incomplete certs and production without host boundary stay blocked with zero transport calls', async () => {
  const h = fixture('herdr');
  for (const mutate of [(o: AdapterOptions) => { o.certification.expiresAt = NOW - 1; }, (o: AdapterOptions) => { o.certification.checks.ttySignals = false; }, (o: AdapterOptions) => { o.certification.profileHash = 'drift'; }, (o: AdapterOptions) => { o.mode = 'production'; o.certification.source = 'production'; }]) {
    const options = { ...h.options, certification: structuredClone(h.options.certification) }; mutate(options);
    expect((await createTransportAdapter('herdr', options).preflight(h.room, 'claude')).ready).toBe(false);
  }
  expect(h.counts.launch).toBe(0); expect(h.counts.deliver).toBe(0);
  for (const [backend, a] of Object.entries(createAdapters())) {
    expect(await a.preflight(h.room, 'claude')).toEqual({ ready: false, reason: 'production_transport_uncertified' });
    await expect(a.launch(h.room, 'claude')).rejects.toThrow('launcher_transport_unavailable');
  }
});
test('concurrent launch/delivery of same operation share a result, different payload conflicts and timeout never relaunches', async () => {
  const h = fixture('tmux'); const [a, b] = await Promise.all([h.adapter.launch(h.room, 'claude'), h.adapter.launch(h.room, 'claude')]);
  expect(a).toEqual(b); expect(h.counts.launch).toBe(1);
  const receipts = await Promise.all([h.adapter.deliver(h.room, a, context()), h.adapter.deliver(h.room, a, context())]);
  expect(receipts[0].state).toBe('acknowledged'); expect(h.counts.deliver).toBe(1);
  await expect(h.adapter.deliver(h.room, a, { ...context(), text: 'different', hash: sha('different') })).rejects.toThrow('adapter_request_conflict');
  const failed = fixture('herdr'); failed.failLaunch(); await expect(failed.adapter.launch(failed.room, 'claude')).rejects.toThrow(); await expect(failed.adapter.launch(failed.room, 'claude')).rejects.toThrow(); expect(failed.counts.launch).toBe(1);
});

test('target route/model drift during context delivery keeps the receipt uncertain on every backend', async () => {
  for (const backend of ['herdr', 'tmux', 'superset'] as const) for (const patch of [{ route: 'mind' }, { model: 'unobserved-change' }]) {
    const h = fixture(backend), b = await h.adapter.launch(h.room, 'claude');
    h.setDelivery(() => { h.replace(patch); });
    expect((await h.adapter.deliver(h.room, b, context())).state).toBe('uncertain'); expect(h.counts.deliver).toBe(1);
  }
});
test('a missing exact native resume never falls back to fresh or changes the source binding', async () => {
  for (const backend of ['herdr', 'tmux', 'superset'] as const) {
    const h = fixture(backend); h.room.bindings.claude = { agent: 'claude', nativeId: nativeId('claude'), generation: 'previous-claude', cursor: 4, route: 'direct', model: 'fixture-claude' };
    h.failLaunch(); const before = structuredClone(h.room.bindings);
    await expect(h.adapter.launch(h.room, 'claude', h.room.bindings.claude)).rejects.toThrow();
    await expect(h.adapter.launch(h.room, 'claude', h.room.bindings.claude)).rejects.toThrow();
    expect(h.counts.launch).toBe(1); expect(h.room.bindings).toEqual(before);
  }
});
test('stale or incomplete safe-point evidence blocks checkpoint and launch rather than assuming idle', async () => {
  const h = fixture('tmux'); h.setInspect(o => { o.observedAt = NOW - 5001; });
  await expect(h.adapter.inspect(h.room)).rejects.toThrow('runtime_identity_unverified');
  await expect(h.adapter.launch(h.room, 'claude')).rejects.toThrow(); expect(h.counts.launch).toBe(0);
  h.setInspect(); h.transport.checkpoint = async (_room, source) => ({ binding: source.binding, complete: false, throughEventId: 'partial', events: [] });
  await expect(h.adapter.checkpoint(h.room)).rejects.toThrow('checkpoint_unverified');
});
test('backend and cross-workspace address mismatch fail before dispatch', () => {
  const h = fixture('herdr');
  expect(() => buildSendCommands({ ...h.room, room: 'w8:p1' }, 'context')).toThrow('backend_address_invalid');
  expect(() => buildSendCommands(h.room, '--wait')).toThrow('leading_option_text_unsupported');
  expect(() => buildLaunchCommands(h.room, { ...buildLauncherCommand(profile, { target: 'codex', cwd }), environment: { PATH: '/tmp/not-allowed' } })).toThrow('launcher_environment_override');
});
test('definite rejection requires scoped pre-dispatch proof, not an error response after input', async () => {
  const h = fixture('herdr'), b = await h.adapter.launch(h.room, 'claude');
  h.setDelivery(o => { o.state = 'rejected'; });
  expect((await h.adapter.deliver(h.room, b, context('unproven-reject'))).state).toBe('uncertain');
  h.setDelivery(o => { o.state = 'rejected'; o.rejectedBeforeDispatch = true; });
  expect((await h.adapter.deliver(h.room, b, context('proven-reject'))).state).toBe('rejected');
});
