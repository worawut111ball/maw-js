import type { AutoRoom } from '../features/autostart';
import { quoteShellArg } from '../continuity/launcher';
import { preparedCommand, type PreparedPolicy, type EntryContract } from './prepared-entry';
/** Server-owned policy selects exact resume/fresh and permissions; never pass request body as argv. */
export function preparedTmuxBuilder(policy: PreparedPolicy, contract: EntryContract, route: 'mind' | 'direct', approveArgs: (room: Readonly<AutoRoom>) => readonly string[]) {
  return (room: AutoRoom): string | null => {
    if (room.agent === 'shell') return null;
    const command = preparedCommand(policy, contract, room.agent, route, approveArgs(Object.freeze({ ...room })));
    // No native fallback on failure; preserve a shell for inspection when the entry exits.
    return `${[command.executable, ...command.args].map(quoteShellArg).join(' ')}; exec "\${SHELL:-/bin/zsh}" -l`;
  };
}
