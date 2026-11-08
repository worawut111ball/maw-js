/** Trusted host-only loader. No environment/API auto-discovery and no native agent execution. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { type EntryContract, type PreparedPolicy } from './prepared-entry';
import { preparedTmuxBuilder } from './tmux-entry';
import type { AutoRoom } from '../features/autostart';

export interface HostRoomPolicy {
  session: string; cwd: string; agent: 'codex' | 'claude';
  start: { kind: 'fresh' } | { kind: 'resume'; nativeId: string };
  model?: string; permission: 'ask' | 'bypass';
}
export type HostEntryConfig = { enabled: false } | {
  enabled: true; release: PreparedPolicy; route: 'mind' | 'direct'; rooms: HostRoomPolicy[];
};
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fail(): never { throw new Error('trusted_entry_unavailable'); }
/** Authenticate the snapshot before executing its verifier, including the pinned Node binary. */
function inspectRelease(policy: PreparedPolicy): string {
  if (!isAbsolute(policy.directory) || realpathSync(policy.directory) !== policy.directory || !/^[a-f0-9]{64}$/.test(policy.manifestSha256)) fail();
  const bytes = readFileSync(join(policy.directory, 'manifest.json'));
  if (sha(bytes) !== policy.manifestSha256) fail();
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.version !== 1 || manifest.destination !== policy.directory || !manifest.files || !manifest.binaries) fail();
  const required = ['src/local-entry.js', 'src/config.js', 'src/entry-bundle.js', 'src/entry-descriptor.js', 'bin/artron-local.js', 'bin/verify-bundle.js', 'activate.zsh', 'rollback.zsh'];
  for (const tool of ['claude', 'codex']) for (const suffix of ['', '-direct']) required.push('bin/' + tool + suffix, 'launch/' + tool + suffix);
  for (const rel of required) {
    const mode = rel.startsWith('launch/') || (rel.startsWith('bin/') && rel !== 'bin/verify-bundle.js') ? 0o700 : 0o600;
    if (manifest.files[rel]?.mode !== mode) fail();
  }
  for (const [rel, entry] of Object.entries(manifest.files) as [string, any][]) {
    const file = resolve(policy.directory, rel);
    if (!file.startsWith(policy.directory + sep) || realpathSync(file) !== file) fail();
    const st = statSync(file);
    if (!st.isFile() || (st.mode & 0o777) !== entry.mode || sha(readFileSync(file)) !== entry.sha256) fail();
  }
  for (const key of ['node', 'claude', 'codex', 'hostClaude', 'hostCodex']) {
    const entry = manifest.binaries[key];
    if (!entry || typeof entry.path !== 'string' || !isAbsolute(entry.path) || realpathSync(entry.path) !== entry.path) fail();
    const st = statSync(entry.path);
    if (!st.isFile() || !(st.mode & 0o111) || sha(readFileSync(entry.path)) !== entry.sha256) fail();
  }
  return manifest.binaries.node.path;
}
// stdin contains descriptor data, never executable code. Only the pinned snapshot module is loaded.
const BRIDGE = `const fs=require('node:fs'); const path=require('node:path');
const r=JSON.parse(fs.readFileSync(0,'utf8'));
const m=require(path.join(r.directory,'src/entry-descriptor.js'));
const result=r.method==='resolve'?m.resolveEntry(r.value):m.verifyEntry(r.value);
process.stdout.write(JSON.stringify(result));`;
export function loadTrustedEntry(config: HostEntryConfig): { policy: PreparedPolicy; contract: EntryContract; commandFor: (room: AutoRoom) => string | null } | undefined {
  if (!config.enabled) return undefined;
  const frozen = structuredClone(config), policy = Object.freeze({ ...frozen.release });
  if (!['mind', 'direct'].includes(frozen.route)) fail();
  const rooms = new Map<string, HostRoomPolicy>();
  for (const room of frozen.rooms) {
    if (rooms.has(room.session) || !/^[\w.-]{1,40}$/.test(room.session) || !isAbsolute(room.cwd) || /[\0\r\n]/.test(room.cwd) || !['codex', 'claude'].includes(room.agent) || !['ask', 'bypass'].includes(room.permission) ||
      !room.start || !['fresh', 'resume'].includes(room.start.kind) || (room.start.kind === 'resume' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(room.start.nativeId)) ||
      (room.model !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(room.model))) fail();
    rooms.set(room.session, room);
  }
  const invoke = (method: 'resolve' | 'verify', value: any): unknown => {
    // Do not permit a descriptor/request to redirect module resolution to another release.
    if (!value || value.directory !== policy.directory) fail();
    try {
      const node = inspectRelease(policy);
      const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
      return JSON.parse(execFileSync(node, ['-e', BRIDGE], { cwd: policy.directory, env,
        input: JSON.stringify({ directory: policy.directory, method, value }), encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }));
    } catch { return fail(); } // Never expose child stderr/environment in API errors.
  };
  inspectRelease(policy);
  const contract: EntryContract = { resolveEntry: request => invoke('resolve', request), verifyEntry: descriptor => invoke('verify', descriptor) };
  const commandFor = preparedTmuxBuilder(policy, contract, frozen.route, room => {
    const rule = rooms.get(room.session);
    if (!rule || rule.agent !== room.agent || rule.cwd !== room.dir || room.skipPermissions !== (rule.agent === 'claude' && rule.permission === 'bypass')) fail();
    const args = rule.start.kind === 'resume' ? [rule.agent === 'codex' ? 'resume' : '--resume', rule.start.nativeId] : [];
    if (rule.model) args.push('--model', rule.model);
    if (rule.agent === 'codex') args.push(...(rule.permission === 'bypass' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--ask-for-approval', 'on-request']));
    else args.push(...(rule.permission === 'bypass' ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'default']));
    return args;
  });
  return { policy, contract, commandFor };
}
