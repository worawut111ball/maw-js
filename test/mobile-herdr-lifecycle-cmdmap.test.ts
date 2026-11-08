import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runInNewContext } from 'vm';
import { Lifecycle, LifecycleStore, type Binding, type LifecycleSnapshot, type AssistantAck } from '../src/mobile/herdr/lifecycle';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
function fixture(autoAck = true) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-cmdmap-')), store = new LifecycleStore(join(dir, 'state.sqlite'));
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true }); });
  const snapshot: LifecycleSnapshot = { fresh: true, workspaces: [], panes: [] }, calls: string[][] = [], deliveries: any[] = [];
  const acks = new Map<string, AssistantAck[]>(); let serial = 0;
  const cwd = '/home/example/project';
  const shell = (ws: string): Binding => ({ workspaceId: ws, paneId: `${ws}:p${++serial}`, terminalId: `terminal-${serial}`, cwd, instanceId: null, agentKind: null, name: null, status: 'unknown', foreground: false, shellReady: true });
  const lifecycle = new Lifecycle({ store, allowDir: p => p === cwd ? p : null, snapshot: async () => structuredClone(snapshot),
    runner: async args => {
      calls.push(args); const a = args.slice(2), opt = (k: string) => a[a.indexOf(k) + 1];
      const reply = (type: string, fields: any = {}) => JSON.stringify({ id: 'synthetic', result: { type, ...fields } });
      if (a[0] === 'workspace' && a[1] === 'create') {
        const w = { id: 'w7', label: opt('--label') }, p = shell(w.id); snapshot.workspaces.push(w); snapshot.panes.push(p);
        return reply('workspace_created', { workspace: { workspace_id: w.id, label: w.label }, root_pane: { workspace_id: w.id, pane_id: p.paneId, terminal_id: p.terminalId } });
      }
      if (a[0] === 'pane' && a[1] === 'split') {
        const p = shell('w7'); snapshot.panes.push(p); return reply('pane_info', { pane: { workspace_id: p.workspaceId, pane_id: p.paneId, terminal_id: p.terminalId } });
      }
      if (a[0] === 'agent' && a[1] === 'start') {
        const p = snapshot.panes.find(p => p.paneId === opt('--pane'))!;
        Object.assign(p, { name: a[2], agentKind: opt('--kind'), instanceId: `instance-${serial}-${p.paneId}`, foreground: true, shellReady: false, status: 'idle', conversation: { provider: opt('--kind'), id: a.includes('resume') ? a[a.indexOf('resume') + 1] : `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}` } });
        return reply('agent_started', { agent: { pane_id: p.paneId, workspace_id: p.workspaceId, name: p.name, agent: p.agentKind } });
      }
      if (a[0] === 'workspace' && a[1] === 'close') { snapshot.workspaces = []; snapshot.panes = []; return reply('workspace_closed'); }
      throw new Error('Unexpected DI command');
    },
    dispatch: async (binding, req) => {
      deliveries.push(req); const marker = req.text?.match(/HERDR_ACK:[a-f0-9-]+:[a-z0-9]+/g)?.at(-1);
      if (marker && autoAck) acks.set(binding.paneId, [{ role: 'assistant', text: marker, instanceId: binding.instanceId!, conversationId: binding.conversation!.id, evidenceId: 'assistant-record-' + binding.paneId }]);
      return { state: 'acknowledged', ok: true };
    }, acknowledgments: async b => acks.get(b.paneId) ?? [],
  });
  return { lifecycle, store, snapshot, calls, deliveries, cwd, acks };
}
test('rules are a real private markdown artifact, and new team has equal right splits', async () => {
  const h = fixture(), op = await h.lifecycle.create({ id: 'team-1', mode: 'team', label: 'demo-team', cwd: h.cwd });
  expect(op.phase).toBe('ready'); expect(statSync(op.rulesPath!).mode & 0o777).toBe(0o600);
  const rules = h.lifecycle.rulesMarkdown(op.id);
  for (const m of op.members) { expect(rules).toContain(m.binding!.paneId); expect(rules).toContain(`HERDR_ACK:${m.marker}:${m.role}`); }
  const splits = h.calls.filter(a => a[3] === 'split');
  expect(splits[1][splits[1].indexOf('--ratio') + 1]).toBe(String(1 / 3)); expect(splits[2][splits[2].indexOf('--ratio') + 1]).toBe('0.5');
});
test('member exit restores exact conversation into a newly returned pane, without repeated rules', async () => {
  const h = fixture(), op = await h.lifecycle.create({ id: 'team-2', mode: 'team', label: 'demo-team', cwd: h.cwd });
  const missing = op.members[2]; h.snapshot.panes = h.snapshot.panes.filter(p => p.paneId !== missing.binding!.paneId);
  await h.lifecycle.reconcile(); const recovered = h.lifecycle.status(op.id).members[2];
  expect(recovered.ready).toBe(true); expect(recovered.binding!.paneId).not.toBe(missing.binding!.paneId);
  expect(recovered.conversation!.id).toBe(missing.conversation!.id); expect(h.deliveries).toHaveLength(4);
  expect(h.calls.filter(a => a[3] === 'start')).toHaveLength(5);
});
test('foreign occupant and closed member are never auto-adopted or restored', async () => {
  const h = fixture(), op = await h.lifecycle.create({ id: 'team-3', mode: 'team', label: 'demo-team', cwd: h.cwd });
  h.snapshot.panes[1].instanceId = 'foreign'; const before = h.calls.length;
  await h.lifecycle.reconcile(); expect(h.calls).toHaveLength(before);
  expect(h.lifecycle.status(op.id).members[1].reason).toBe('foreign_or_busy_terminal');
  h.lifecycle.setAutostart(op.id, false, op.members[2].logicalId); h.snapshot.panes = h.snapshot.panes.filter(p => p.paneId !== op.members[2].binding!.paneId);
  await h.lifecycle.reconcile(); expect(h.calls).toHaveLength(before);
});
test('close does not report closed while a persisted start is still dispatching', async () => {
  const h = fixture(), op = await h.lifecycle.create({ id: 'single-1', mode: 'single', label: 'demo-room', cwd: h.cwd });
  h.store.change(s => { s.operations[op.id].steps['late-start'] = { state: 'dispatching' }; return null; });
  const preview = await h.lifecycle.closePreview({ workspaceId: op.workspaceId! });
  const result = await h.lifecycle.closeConfirm(preview.id);
  expect(result.autostartDisabled).toBe(true); expect(result.runtimeClosed).toBe(false); expect(result.deliveryUnknown).toBe(true);
  h.store.change(s => { s.operations[op.id].steps['late-start'] = { state: 'acknowledged', result: {} }; return null; });
  expect((await h.lifecycle.closeStatus(preview.id)).runtimeClosed).toBe(true);
});
test('readiness continues beyond initial backoff and cancelling an old handle cannot stop a new loop', async () => {
  const h = fixture(), queue: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule = (fn: () => void, ms: number) => { const item = { fn, ms, cancelled: false }; queue.push(item); return () => { item.cancelled = true; }; };
  const oldCancel = h.lifecycle.startReadiness(schedule);
  for (let i = 0; i < 7; i++) { queue[i].fn(); await Bun.sleep(0); }
  expect(queue).toHaveLength(8); expect(queue.slice(3).every(x => x.ms === 60_000)).toBe(true);
  expect(h.lifecycle.readiness.checks).toBe(7);
  const cancel = h.lifecycle.startReadiness(schedule); oldCancel(); expect(h.lifecycle.readiness.running).toBe(true);
  cancel(); expect(h.lifecycle.readiness.running).toBe(false); expect(h.calls).toHaveLength(0);
});
test('UI import registers the real page mount and hooks without fetch, timer, or mutation', () => {
  const ext = { pages: [] as any[], keys: [] as any[] }; let effects = 0;
  const context = { window: { mawExt: ext }, mawExt: ext, fetch: () => { effects++; throw new Error('unexpected import fetch'); }, setTimeout: () => { effects++; }, clearTimeout() {} };
  runInNewContext(readFileSync(join(import.meta.dir, '../ui/mobile/ext/herdr.js'), 'utf8'), context);
  expect(effects).toBe(0); expect(ext.pages[0].mount).toBeFunction(); expect(ext.keys).toHaveLength(2);
  expect((context.window as any).mawHerdrCreate).toBeFunction();
});

test('migration failure stops creation before any CLI mutation through initialization guard', async () => {
  const h = fixture(); h.lifecycle.setInitializationGuard(() => { throw new Error('invalid legacy store'); });
  await expect(h.lifecycle.create({ id: 'guarded', mode: 'single', label: 'demo-room', cwd: h.cwd })).rejects.toThrow();
  expect(h.calls).toHaveLength(0);
});


test('late verified ACK promotes partial/uncertain to ready without starting or sending again; closing is excluded', async () => {
  for (const phase of ['partial', 'uncertain', 'closing'] as const) {
    const h = fixture(false), op = await h.lifecycle.create({ id: 'late-' + phase, mode: 'team', label: 'demo-team', cwd: h.cwd });
    expect(op.phase).toBe('partial');
    h.store.change(s => { s.operations[op.id].phase = phase; if (phase === 'uncertain') s.operations[op.id].members[0].bootstrap = 'uncertain'; return null; });
    for (const m of op.members) h.acks.set(m.binding!.paneId, [{ role: 'assistant', text: `HERDR_ACK:${m.marker}:${m.role}`, instanceId: m.binding!.instanceId!, conversationId: m.conversation!.id, evidenceId: 'late-assistant-' + m.role }]);
    const calls = h.calls.length, dispatched = h.deliveries.length;
    await h.lifecycle.reconcile(); const after = h.lifecycle.status(op.id);
    expect(after.phase).toBe(phase === 'closing' ? 'closing' : 'ready');
    expect(after.members.every(m => m.ready)).toBe(phase !== 'closing');
    expect(h.calls).toHaveLength(calls); expect(h.deliveries).toHaveLength(dispatched);
  }
});

test('late marker from a replacement agent does not acknowledge the previous member', async () => {
  const h = fixture(false), op = await h.lifecycle.create({ id: 'late-foreign', mode: 'single', label: 'demo-room', cwd: h.cwd });
  const m = op.members[0]; h.snapshot.panes[0].instanceId = 'replacement';
  h.acks.set(m.binding!.paneId, [{ role: 'assistant', text: `HERDR_ACK:${m.marker}:${m.role}`, instanceId: 'replacement', conversationId: m.conversation!.id, evidenceId: 'foreign-ack' }]);
  await h.lifecycle.reconcile(); expect(h.lifecycle.status(op.id).members[0].ready).toBe(false);
});

test('readiness catches synchronous migration failure and schedules the next bounded check without CLI', async () => {
  const h = fixture(), queue: (() => void)[] = [];
  h.lifecycle.setInitializationGuard(() => { throw new Error('invalid legacy'); });
  const stop = h.lifecycle.startReadiness((fn, _ms) => { queue.push(fn); return () => {}; });
  queue[0](); await Bun.sleep(0);
  expect(h.lifecycle.readiness.lastError).toBe('inventory_or_store_unavailable'); expect(queue).toHaveLength(2); expect(h.calls).toHaveLength(0);
  stop();
});


test('new native session appears only after bootstrap and late ACK binds it without resending', async () => {
  const h = fixture(false);
  const originalSnapshot = h.lifecycle.options.snapshot;
  let hideConversation = true;
  h.lifecycle.options.snapshot = async () => {
    const snapshot = await originalSnapshot();
    if (hideConversation) for (const pane of snapshot.panes) delete pane.conversation;
    return snapshot;
  };
  const op = await h.lifecycle.create({ id: 'late-conversation', mode: 'single', label: 'demo-room', cwd: h.cwd });
  expect(h.deliveries).toHaveLength(1); expect(op.members[0].ready).toBe(false);
  hideConversation = false;
  const m = op.members[0], live = h.snapshot.panes[0];
  h.acks.set(live.paneId, [{ role: 'assistant', text: `HERDR_ACK:${m.marker}:${m.role}`, instanceId: live.instanceId!, conversationId: live.conversation!.id, evidenceId: 'late-native-ack' }]);
  await h.lifecycle.reconcile();
  const ready = h.lifecycle.status(op.id);
  expect(ready.phase).toBe('ready'); expect(ready.members[0].conversation).toEqual(live.conversation);
  expect(h.deliveries).toHaveLength(1); expect(h.calls.filter(a => a[3] === 'start')).toHaveLength(1);
});

test('bootstrap retries use a fresh durable ID only after definite rejection, never uncertainty', async () => {
  for (const state of ['definitely-rejected', 'uncertain'] as const) {
    const h = fixture();
    const send = h.lifecycle.options.dispatch;
    const ids: string[] = [];
    h.lifecycle.options.dispatch = async (binding, request) => {
      ids.push(request.id);
      if (ids.length === 1 || request.id === ids[0]) return { state, ok: false };
      return send(binding, request);
    };
    const op = await h.lifecycle.create({ id: 'bootstrap-' + state, mode: 'single', label: 'demo-room', cwd: h.cwd });
    const next = await h.lifecycle.continueOperation(op.id);
    if (state === 'definitely-rejected') {
      expect(ids).toHaveLength(2); expect(ids[1]).not.toBe(ids[0]); expect(next.phase).toBe('ready');
    } else {
      expect(ids).toHaveLength(1); expect(next.phase).toBe('uncertain');
    }
  }
});

test('continuing a member with a different native conversation clears ready and sends nothing', async () => {
  const h = fixture();
  const op = await h.lifecycle.create({ id: 'conversation-replaced', mode: 'single', label: 'demo-room', cwd: h.cwd });
  h.snapshot.panes[0].conversation = { provider: 'codex', id: '11111111-1111-4111-8111-111111111111' };
  const sent = h.deliveries.length;
  const after = await h.lifecycle.continueOperation(op.id);
  expect(after.phase).toBe('partial'); expect(after.members[0].ready).toBe(false);
  expect(after.members[0].reason).toBe('conversation_changed'); expect(h.deliveries).toHaveLength(sent);
  expect(after.members[0].conversation).toEqual(op.members[0].conversation);
});

test('standalone assistant ACK line permits trailing explanation but not a marker embedded in prose', async () => {
  const h = fixture(false), op = await h.lifecycle.create({id:'ack-line',mode:'single',label:'demo-room',cwd:h.cwd});
  const m=op.members[0], live=h.snapshot.panes[0];
  const record={role:'assistant' as const,instanceId:live.instanceId!,conversationId:live.conversation!.id,evidenceId:'ack-line-evidence',text:''};
  h.acks.set(live.paneId,[{...record,text:`Not acknowledged: HERDR_ACK:${m.marker}:${m.role}`}]);
  await h.lifecycle.reconcile(); expect(h.lifecycle.status(op.id).members[0].ready).toBe(false);
  h.acks.set(live.paneId,[{...record,text:`HERDR_ACK:${m.marker}:${m.role}\n\nWait user cmd.`}]);
  await h.lifecycle.reconcile(); expect(h.lifecycle.status(op.id).members[0].ready).toBe(true);
  const start=h.calls.find(a=>a[3]==='start')!;expect(start[start.indexOf('--timeout')+1]).toBe('60000');
});
