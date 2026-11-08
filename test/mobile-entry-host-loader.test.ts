import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadTrustedEntry, type HostEntryConfig } from '../src/mobile/launch/host-loader';
import { preparedCommand } from '../src/mobile/launch/prepared-entry';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'maw-entry-loader-'))); dirs.push(dir);
  const files: Record<string, any> = {};
  const names = ['src/local-entry.js', 'src/config.js', 'src/entry-bundle.js', 'src/entry-descriptor.js', 'bin/artron-local.js', 'bin/verify-bundle.js', 'activate.zsh', 'rollback.zsh'];
  for (const tool of ['claude', 'codex']) for (const suffix of ['', '-direct']) names.push('bin/' + tool + suffix, 'launch/' + tool + suffix);
  const source = `exports.resolveEntry=r=>({...r,observedClaudeCode:process.env.CLAUDECODE,version:1,manifestSha256:require('crypto').createHash('sha256').update(require('fs').readFileSync(r.directory+'/manifest.json')).digest('hex'),executable:r.directory+'/launch/'+r.tool+(r.route==='direct'?'-direct':''),env:{},capabilities:{executionLaunchesAgent:true,preservesCallerCwd:true,homeSelection:'installed-host',nestedLaunch:false}});exports.verifyEntry=d=>exports.resolveEntry(d);`;
  for (const rel of names) {
    const file = join(dir, rel); mkdirSync(join(file, '..'), { recursive: true });
    const content = rel === 'src/entry-descriptor.js' ? source : '# fixture never executed\n';
    const mode = rel.startsWith('launch/') || (rel.startsWith('bin/') && rel !== 'bin/verify-bundle.js') ? 0o700 : 0o600;
    writeFileSync(file, content); chmodSync(file, mode); files[rel] = { mode, sha256: sha(content) };
  }
  const runtime = realpathSync(process.execPath), native = realpathSync('/bin/echo');
  const binaries = Object.fromEntries(['node', 'claude', 'codex', 'hostClaude', 'hostCodex'].map(k => { const path = k === 'node' ? runtime : native; return [k, { path, sha256: sha(readFileSync(path)) }]; }));
  const manifest = JSON.stringify({ version: 1, destination: dir, files, binaries }); writeFileSync(join(dir, 'manifest.json'), manifest);
  const config: HostEntryConfig = { enabled: true, release: { directory: dir, manifestSha256: sha(manifest) }, route: 'mind', rooms: [{ session: 'team', cwd: '/fixture/project', agent: 'codex', permission: 'ask', start: { kind: 'resume', nativeId: '00000000-0000-4000-8000-000000000001' } }] };
  return { dir, config };
}
test('default opt-out never reads a release or starts a verifier', () => {
  expect(loadTrustedEntry({ enabled: false })).toBeUndefined();
});
test('trusted loader verifies snapshot before module execution; canonical args and room policy', () => {
  const { config, dir } = fixture(); const host = loadTrustedEntry(config)!;
  const room = { session: 'team', dir: '/fixture/project', agent: 'codex' as const, skipPermissions: false };
  const cmd = host.commandFor(room)!;
  expect(cmd).toContain("'resume' '00000000-0000-4000-8000-000000000001'"); expect(cmd).not.toContain('||');
  expect(() => host.commandFor({ ...room, dir: '/foreign' })).toThrow();
  expect(() => host.commandFor({ ...room, session: 'foreign' })).toThrow();
  expect(() => host.contract.resolveEntry({ directory: '/foreign', tool: 'codex', route: 'mind', args: [] })).toThrow();
  // Modifying the config after construction cannot redirect the trusted policy.
  if (config.enabled) config.release.directory = '/foreign';
  expect(host.policy.directory).toBe(dir);
  writeFileSync(join(dir, 'src/entry-descriptor.js'), 'throw new Error("must not execute altered snapshot")');
  expect(() => preparedCommand(host.policy, host.contract, 'codex', 'mind', [])).toThrow('trusted_entry_unavailable');
});
test('digest mismatch, mode drift and invalid resume policy reject before module execution', () => {
  const { config, dir } = fixture();
  if (!config.enabled) throw Error('fixture');
  expect(() => loadTrustedEntry({ ...config, release: { ...config.release, manifestSha256: '0'.repeat(64) } })).toThrow();
  expect(() => loadTrustedEntry({ ...config, rooms: [{ ...config.rooms[0], start: { kind: 'resume', nativeId: '--last' } }] })).toThrow();
  chmodSync(join(dir, 'src/entry-descriptor.js'), 0o700);
  expect(() => loadTrustedEntry(config)).toThrow();
});

 test('Claude ask uses native default; verifier preserves CLAUDECODE and explicit resume', () => {
  const { config } = fixture(); if (!config.enabled) throw Error('fixture');
  config.rooms[0].agent = 'claude';
  const before = process.env.CLAUDECODE;
  try {
    process.env.CLAUDECODE = 'fixture-native-guard';
    const h = loadTrustedEntry(config)!;
    const d: any = h.contract.resolveEntry({ directory: h.policy.directory, tool: 'claude', route: 'mind', args: [] });
    expect(d.observedClaudeCode).toBe('fixture-native-guard');
    const cmd = h.commandFor({ session: 'team', dir: '/fixture/project', agent: 'claude', skipPermissions: false })!;
    expect(cmd).toContain("'--permission-mode' 'default'"); expect(cmd).not.toContain("'manual'");
    expect(cmd).toContain("'--resume'");
  } finally { if (before === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = before; }
});
