import { expect, test } from 'bun:test';
import { preparedCommand, type EntryContract } from '../src/mobile/launch/prepared-entry';
import { preparedTmuxBuilder } from '../src/mobile/launch/tmux-entry';
import { ensure } from '../src/mobile/features/autostart';
import { buildLauncherCommand, type LauncherProfile } from '../src/mobile/continuity/launcher';
const policy = { directory: '/fixture/candidate03', manifestSha256: 'a'.repeat(64) };
const contract: EntryContract = {
  resolveEntry: r => ({ ...r, version: 1, manifestSha256: policy.manifestSha256, executable: `${r.directory}/launch/${r.tool}${r.route === 'direct' ? '-direct' : ''}`, env: {}, capabilities: { executionLaunchesAgent: true, preservesCallerCwd: true, homeSelection: 'installed-host', nestedLaunch: false } }),
  verifyEntry: d => structuredClone(d),
};
const profile: LauncherProfile = { boundary: 'prepared-host', prepared: policy, executable: '/fixture/node', entry: '/fixture/entry', home: '/fixture/home', route: 'mind', revision: '03', nativeExecutables: { codex: '/fixture/codex', claude: '/fixture/claude' }, personaVersion: '1', rulesVersion: '1', skillsVersion: '1', hooksVersion: '1', models: { codex: ['fixture'], claude: ['fixture'] } };
test('canonical verify result only; reject mutated args, route, digest, env and capabilities', () => {
  const base = preparedCommand(policy, contract, 'codex', 'mind', ['resume', 'id']);
  expect(base.environment).toEqual({});
  for (const change of [ { args: ['--dangerously-bypass-approvals-and-sandbox'] }, { route: 'direct' }, { manifestSha256: 'b'.repeat(64) }, { env: [] }, { env: { HOME: '/other' } }, { capabilities: {} }, { executable: '/bin/false' } ]) {
    expect(() => preparedCommand(policy, { ...contract, verifyEntry: d => ({ ...d as any, ...change }) }, 'codex', 'mind', ['resume', 'id'])).toThrow();
  }
  expect(() => preparedCommand(policy, { ...contract, verifyEntry: () => { throw Error('stale'); } }, 'codex', 'mind', [])).toThrow('stale');
});
test('continuity native args policy survives prepared entry; no HOME overlay, exact resume', () => {
  for (const target of ['claude', 'codex'] as const) {
    const id = '00000000-0000-4000-8000-000000000001';
    const cmd = buildLauncherCommand(profile, { target, cwd: '/fixture/project', existing: { agent: target, nativeId: id, generation: 'g', cursor: 0 }, model: 'fixture' }, contract);
    expect(cmd.executable).toBe(`${policy.directory}/launch/${target}`);
    expect(cmd.args).toContain(id); expect(cmd.environment).toEqual({});
    expect(cmd.args).toContain(target === 'codex' ? '--sandbox' : '--strict-mcp-config');
    expect(cmd.args).not.toContain('--last');
    if (target === 'claude') expect(cmd.args[cmd.args.indexOf('--permission-mode') + 1]).toBe('default');
  }
  expect(() => buildLauncherCommand(profile, { target: 'codex', cwd: '/fixture/project', model: 'evil' }, contract)).toThrow('model_unsupported');
});
test('tmux trusted builder quotes argv and verify failure never creates session or falls back', () => {
  const room = { session: 'fixture', dir: '/fixture/project', agent: 'claude' as const, skipPermissions: false };
  const builder = preparedTmuxBuilder(policy, contract, 'direct', () => ['--resume', "ไทย ' spaced"]);
  expect(builder(room)).toContain("'ไทย '\\'' spaced'"); expect(builder(room)).not.toContain('||');
  const calls: string[][] = [];
  const tmux = (args: string[]) => { calls.push(args); if (args[0] === 'has-session') throw Error('missing'); return ''; };
  expect(ensure([room], tmux, builder)).toEqual(['fixture']);
  calls.length = 0;
  const bad = preparedTmuxBuilder(policy, { ...contract, verifyEntry: () => { throw Error('drift'); } }, 'mind', () => []);
  expect(ensure([room], tmux, bad)).toEqual([]); expect(calls.map(a => a[0])).toEqual(['has-session']);
});
