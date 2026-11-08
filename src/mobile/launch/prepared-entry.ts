/** Read-only dependency contract. Host supplies the trusted candidate module; never imports a user path. */
import { isAbsolute, normalize, join } from 'node:path';
export interface PreparedPolicy { directory: string; manifestSha256: string }
export interface PreparedRequest { directory: string; tool: 'codex' | 'claude'; route: 'mind' | 'direct'; args: string[] }
export interface EntryContract {
  resolveEntry(request: PreparedRequest): unknown;
  verifyEntry(descriptor: unknown): unknown;
}
export interface PreparedCommand { executable: string; args: string[]; environment: Record<string, string> }
/** args must already be built by the caller's native permission/resume policy, never taken raw from an API. */
export function preparedCommand(policy: PreparedPolicy, contract: EntryContract, tool: PreparedRequest['tool'], route: PreparedRequest['route'], approvedArgs: readonly string[]): PreparedCommand {
  const fail = (): never => { throw new Error('prepared_entry_contract_invalid'); };
  if (!policy || !isAbsolute(policy.directory) || normalize(policy.directory) !== policy.directory || /[\0\r\n]/.test(policy.directory) || !/^[a-f0-9]{64}$/.test(policy.manifestSha256)) fail();
  if (!['codex', 'claude'].includes(tool) || !['mind', 'direct'].includes(route) || !Array.isArray(approvedArgs) || approvedArgs.some(a => typeof a !== 'string' || /[\0\r\n]/.test(a))) fail();
  // Snapshot before invoking dependencies: a resolver may mutate its inputs.
  const directory = policy.directory, digest = policy.manifestSha256, args = [...approvedArgs];
  const canonical: any = contract.verifyEntry(contract.resolveEntry({ directory, tool, route, args: [...args] }));
  if (!canonical || canonical.version !== 1 || canonical.directory !== directory || canonical.manifestSha256 !== digest || canonical.tool !== tool || canonical.route !== route ||
    canonical.executable !== join(directory, 'launch', tool + (route === 'direct' ? '-direct' : '')) ||
    !Array.isArray(canonical.args) || canonical.args.length !== args.length || canonical.args.some((a: unknown, i: number) => a !== args[i]) ||
    !canonical.env || Object.getPrototypeOf(canonical.env) !== Object.prototype || Reflect.ownKeys(canonical.env).length ||
    canonical.capabilities?.executionLaunchesAgent !== true || canonical.capabilities?.preservesCallerCwd !== true ||
    canonical.capabilities?.homeSelection !== 'installed-host' || canonical.capabilities?.nestedLaunch !== false) fail();
  return { executable: canonical.executable, args: [...canonical.args], environment: { ...canonical.env } };
}
