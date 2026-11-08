import { preparedCommand, type PreparedPolicy, type EntryContract } from '../launch/prepared-entry';
/** Pure team-2 entry contract/builders. Never spawn, import their module, read credentials or change PATH. */
import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { ContinuityError, type AgentKind, type Binding } from './types';

export interface LauncherProfile {
  executable: string; entry: string; revision: string;
  boundary?: 'preview-bypass' | 'prepared-host';
  prepared?: PreparedPolicy;
  route: 'mind' | 'direct'; home: string; codexHome?: string;
  nativeExecutables: Record<AgentKind, string>;
  personaVersion: string; rulesVersion: string; skillsVersion: string; hooksVersion: string;
  models: Record<AgentKind, readonly string[]>;
  /** A configured snapshot, not a claim about the model detected in an existing process. */
  defaultModels?: Partial<Record<AgentKind, string>>;
}
export interface LauncherRequest { target: AgentKind; cwd: string; existing?: Binding; model?: string }
export interface LauncherCommand {
  executable: string; args: string[]; cwd: string;
  environment: Record<string, string>; profileHash: string; profileRevision: string;
  target: AgentKind; exactNativeId?: string; model?: string; route: 'mind' | 'direct';
  readOnlyPolicy: 'codex-read-only-sandbox' | 'claude-read-tool-only';
}
export const NATIVE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code: string): never { throw new ContinuityError(code, 409); }
export function validateAbsolutePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || /[\x00\r\n]/.test(path) || path.length > 4096) fail('launcher_path_invalid');
}
export function validateLauncherProfile(profile: LauncherProfile): void {
  if (!profile || (profile.boundary !== undefined && !['preview-bypass', 'prepared-host'].includes(profile.boundary)) || !['mind', 'direct'].includes(profile.route)) fail('launcher_route_unavailable');
  [profile.executable, profile.entry, profile.home, profile.nativeExecutables?.codex, profile.nativeExecutables?.claude].forEach(validateAbsolutePath);
  if (profile.codexHome !== undefined) validateAbsolutePath(profile.codexHome);
  for (const v of [profile.revision, profile.personaVersion, profile.rulesVersion, profile.skillsVersion, profile.hooksVersion]) {
    if (typeof v !== 'string' || !v.trim() || v.length > 256 || /[\x00\r\n]/.test(v)) fail('launcher_contract_version_missing');
  }
  for (const kind of ['claude', 'codex'] as const) {
    const models = profile.models?.[kind];
    if (!Array.isArray(models) || !models.length || models.some(m => typeof m !== 'string' || !MODEL.test(m)) || new Set(models).size !== models.length) fail('model_catalog_unavailable');
    if (profile.defaultModels?.[kind] !== undefined && !models.includes(profile.defaultModels[kind]!)) fail('model_default_unsupported');
  }
}
export function launcherProfileHash(profile: LauncherProfile): string {
  validateLauncherProfile(profile);
  // Deliberately project known metadata: never hash/serialize arbitrary config including auth fields.
  return digest({ prepared: profile.prepared ? { directory: profile.prepared.directory, manifestSha256: profile.prepared.manifestSha256 } : null, boundary: profile.boundary ?? 'preview-bypass', executable: profile.executable, entry: profile.entry, revision: profile.revision, route: profile.route,
    home: profile.home, codexHome: profile.codexHome ?? null, nativeExecutables: { codex: profile.nativeExecutables.codex, claude: profile.nativeExecutables.claude },
    personaVersion: profile.personaVersion, rulesVersion: profile.rulesVersion, skillsVersion: profile.skillsVersion, hooksVersion: profile.hooksVersion,
    models: { codex: [...profile.models.codex], claude: [...profile.models.claude] }, defaultModels: { codex: profile.defaultModels?.codex ?? null, claude: profile.defaultModels?.claude ?? null } });
}
export function buildLauncherCommand(profile: LauncherProfile, request: LauncherRequest, contract?: EntryContract): LauncherCommand {
  const profileHash = launcherProfileHash(profile);
  if (profile.boundary === 'prepared-host' && (!contract || !profile.prepared)) fail('prepared_host_launcher_unimplemented');
  if (!request || !['codex', 'claude'].includes(request.target)) fail('agent_unsupported');
  validateAbsolutePath(request.cwd);
  const existing = request.existing;
  if (existing && (existing.agent !== request.target || !NATIVE_UUID.test(existing.nativeId) || !existing.generation || !Number.isSafeInteger(existing.cursor) || existing.cursor < 0)) fail('exact_native_session_required');
  const model = request.model ?? existing?.model ?? profile.defaultModels?.[request.target];
  if (model !== undefined && (typeof model !== 'string' || !profile.models[request.target].includes(model))) fail('model_unsupported');
  const nativeArgs: string[] = existing ? request.target === 'codex' ? ['resume', existing.nativeId] : ['--resume', existing.nativeId] : [];
  if (model) nativeArgs.push('--model', model);
  if (request.target === 'codex') nativeArgs.push('--sandbox', 'read-only', '--ask-for-approval', 'on-request');
  else nativeArgs.push('--tools', 'Read', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'default');
  // Team-2 entry forwards native argv after --; route is a server profile, not a UI selector.
  const environment: Record<string, string> = { HOME: profile.home,
    [`ARTRON_LOCAL_${request.target.toUpperCase()}_BIN`]: profile.nativeExecutables[request.target] };
  if (profile.codexHome) environment.CODEX_HOME = profile.codexHome;
  const prepared = profile.boundary === 'prepared-host' ? preparedCommand(profile.prepared!, contract!, request.target, profile.route, nativeArgs) : undefined;
  return { executable: profile.executable, args: [profile.entry, profile.route, request.target, '--', ...nativeArgs], cwd: request.cwd,
    environment, ...prepared, profileHash, profileRevision: profile.revision, target: request.target, ...(existing ? { exactNativeId: existing.nativeId } : {}),
    ...(model ? { model } : {}), route: profile.route, readOnlyPolicy: request.target === 'codex' ? 'codex-read-only-sandbox' : 'claude-read-tool-only' };
}
/** POSIX shell literals only for backends whose native API accepts terminal text/command strings. */
export function quoteShellArg(value: string): string {
  if (typeof value !== 'string' || /[\x00\r\n]/.test(value)) fail('shell_argument_invalid');
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
export function launcherShellCommand(command: LauncherCommand): string {
  validateAbsolutePath(command.cwd); validateAbsolutePath(command.executable);
  if (Object.keys(command.environment).some(k => !['HOME', 'CODEX_HOME', 'ARTRON_LOCAL_CODEX_BIN', 'ARTRON_LOCAL_CLAUDE_BIN'].includes(k))) fail('launcher_environment_override');
  const env = Object.entries(command.environment).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`);
  // Do not exec/replace the shell: recovery needs the same terminal after a graceful native /exit.
  return `cd -- ${quoteShellArg(command.cwd)} && ${['/usr/bin/env', ...env, command.executable, ...command.args].map(quoteShellArg).join(' ')}`;
}
