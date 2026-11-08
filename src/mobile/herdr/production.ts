/** Host wiring only: construction/import does not spawn Herdr or open the journal. */
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
import { createCliRunner, parseSnapshot, hash, foregroundAgent } from './inventory';
import { Lifecycle, LifecycleStore, LifecycleError, type Binding, type LifecycleSnapshot, type LifecycleOptions } from './lifecycle';
import { herdrRuntime, type HerdrRuntime } from './runtime';
import type { Runner } from './types';

export function createLifecycleHost(options: {
  runtime: HerdrRuntime; allowDir: (path: string) => string | null; runner?: Runner;
  launchAgent?: LifecycleOptions['launchAgent'];
  storePath?: string; legacyFile?: string; now?: () => number;
}) {
  const runtime = options.runtime, runner = options.runner ?? createCliRunner();
  const store = new LifecycleStore(options.storePath ?? join(homedir(), '.maw', 'herdr-lifecycle.sqlite'));
  const legacy = options.legacyFile ?? join(homedir(), '.maw', 'herdr-autostart.json');
  let initialized = false, initializationError: unknown;
  const ensureInitialized = () => {
    if (initializationError) throw initializationError;
    if (initialized) return;
    try { if (existsSync(legacy)) lifecycle.migrateLegacy(legacy); initialized = true; }
    catch (e) { initializationError = e; throw e; }
  };
  const snapshot = async (): Promise<LifecycleSnapshot> => {
    const raw = parseSnapshot(await runner(['--session', 'default', 'api', 'snapshot']));
    await runtime.refresh();
    const panes: Binding[] = new Array(raw.panes.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, raw.panes.length) }, async () => {
      while (cursor < raw.panes.length) {
        const i = cursor++, p = raw.panes[i], a = raw.agents.find((v: any) => v.pane_id === p.pane_id);
        const ch = runtime.resolve(`herdr:${p.workspace_id}`, p.pane_id);
        if (!ch || ch.terminalId !== p.terminal_id) throw new LifecycleError('inventory_changed');
        let info: any;
        try {
          const out = JSON.parse(await runner(['--session', 'default', 'pane', 'process-info', '--pane', p.pane_id], 5000));
          if (!out.error && out.result?.type === 'pane_process_info' && out.result.process_info?.pane_id === p.pane_id) info = out.result.process_info;
        } catch { /* unverifiable foreground never permits creation/input */ }
        const procs: any[] = Array.isArray(info?.foreground_processes) ? info.foreground_processes : [];
        const fg = info?.foreground_process_group_id;
        const kind = a?.agent ?? p.agent ?? null;
        const agentProcess = foregroundAgent(info, kind);
        const foreground = !!agentProcess;
        const shellReady = Number.isSafeInteger(fg) && fg > 0 && fg === info?.shell_pid && !kind && procs.some(x => x.pid === fg && ['sh','bash','zsh','fish','dash','ksh','nu','xonsh'].includes(basename(String(x.name ?? x.argv0 ?? ''))));
        let conversation = ch.conversation?.kind === 'id' && ['codex', 'claude'].includes(ch.conversation.agent)
          ? { provider: ch.conversation.agent, id: ch.conversation.value } : undefined;
        if (!conversation && ch.conversation?.kind === 'path') {
          const h = await runtime.history(ch, { limit: 1 });
          if (h.kind === 'messages') conversation = { provider: ch.conversation.agent, id: h.conversation };
        }
        panes[i] = {
          workspaceId: p.workspace_id, paneId: p.pane_id, terminalId: p.terminal_id,
          instanceId: foreground ? hash([p.terminal_id, info.shell_pid, fg, [[agentProcess.pid, agentProcess.name]]]) : null,
          cwd: String(p.foreground_cwd ?? a?.cwd ?? p.cwd ?? ''), agentKind: kind,
          name: a?.name ?? null, status: p.agent_status, foreground, shellReady, conversation,
        };
      }
    }));
    return { fresh: true, workspaces: raw.workspaces.map(w => ({ id: w.workspace_id, label: w.label })), panes };
  };
  const liveChannel = async (binding: Binding) => {
    const fresh = await snapshot(), p = fresh.panes.find(p => p.workspaceId === binding.workspaceId && p.paneId === binding.paneId);
    if (!p || !p.instanceId || p.instanceId !== binding.instanceId || p.terminalId !== binding.terminalId) throw new LifecycleError('agent_changed');
    const ch = runtime.resolve(`herdr:${p.workspaceId}`, p.paneId);
    if (!ch) throw new LifecycleError('agent_changed');
    return ch;
  };
  const lifecycle = new Lifecycle({ store, runner, snapshot, launchAgent: options.launchAgent, allowDir: options.allowDir, now: options.now,
    dispatch: async (binding, request) => {
      ensureInitialized();
      const ch = await liveChannel(binding);
      return runtime.dispatch(ch, { ...request, expectedGeneration: ch.generation });
    },
    acknowledgments: async binding => {
      const ch = await liveChannel(binding), history = await runtime.history(ch, { limit: 500 });
      if (history.kind !== 'messages' || history.conversation !== binding.conversation?.id || !binding.instanceId) return [];
      return history.items.filter(x => x.role === 'assistant' && x.text).map(x => ({ role: 'assistant' as const, text: x.text!, instanceId: binding.instanceId!, conversationId: history.conversation, evidenceId: `${history.epoch}:${x.i}` }));
    },
  });
  runtime.setDispatchGuard(ch => { ensureInitialized(); return lifecycle.assertOpen(ch); });
  const controller = new Proxy(lifecycle, { get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? (...args: any[]) => { ensureInitialized(); return value.apply(target, args); } : value;
  } });
  return { lifecycle: controller, snapshot, ensureInitialized, close: () => { lifecycle.stopReadiness(); store.close(); } };
}

let host: ReturnType<typeof createLifecycleHost> | undefined;
export function productionLifecycle(allowDir: (path: string) => string | null) {
  if (!host) host = createLifecycleHost({ runtime: herdrRuntime, allowDir });
  return host;
}
