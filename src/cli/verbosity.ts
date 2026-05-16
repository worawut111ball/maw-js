/**
 * Verbosity plumbing — global quiet/silent state for the CLI.
 *
 * Shipped by #343 part A (task #2). Consumers (task #3) import the
 * predicates + surfaces to gate their own warnings/info.
 *
 * Contract:
 *   isQuiet()         → --quiet/-q or MAW_QUIET=1, OR isSilent()
 *   isSilent()        → --silent/-s or MAW_SILENT=1
 *   setVerbosityFlags → called once at CLI entry with parsed flags
 *   verbose(fn)       → runs fn unless isQuiet()
 *   warn(msg)         → "⚠ msg" to stderr unless isQuiet()
 *   info(msg)         → msg to stderr unless isQuiet()
 *   error(msg)        → always stderr (even --silent) — errors must be visible
 *
 * Precedence: --silent implies --quiet. Explicit flag (including false) wins
 * over env. If a flag key is absent from the object, env is consulted.
 */

import { warn as formatWarn } from "./output";

interface VerbosityFlags {
  quiet?: boolean;
  silent?: boolean;
}

// Module-level state. Set once via setVerbosityFlags(); reset between tests
// by calling setVerbosityFlags({}).
let storedFlags: VerbosityFlags = {};

export function setVerbosityFlags(flags: VerbosityFlags): void {
  storedFlags = { ...flags };
}

export function isSilent(): boolean {
  if (storedFlags.silent !== undefined) return storedFlags.silent;
  return process.env.MAW_SILENT === "1";
}

export function isQuiet(): boolean {
  // --silent implies --quiet
  if (isSilent()) return true;
  if (storedFlags.quiet !== undefined) return storedFlags.quiet;
  if (process.env.MAW_QUIET === "1") return true;
  // #388.5 — help/version invocations: suppress bootstrap "loaded config:" /
  // "loaded N plugins" chatter. Checked against argv directly because these
  // lines fire from import-time side-effects (e.g. ssh.ts top-level
  // loadConfig()) before cli.ts can call setVerbosityFlags(). Covers nested
  // forms too — `maw oracle scan --help` etc.
  return process.argv.some(
    a => a === "--help" || a === "-h" || a === "--version" || a === "-v",
  );
}

export function verbose(fn: () => void): void {
  if (!isQuiet()) fn();
}

export function warn(msg: string): void {
  if (!isQuiet()) process.stderr.write(`${formatWarn(msg)}\n`);
}

export function info(msg: string): void {
  if (!isQuiet()) process.stderr.write(`${msg}\n`);
}

export function error(msg: string): void {
  // Always emit — errors stay visible under --silent for exit code integrity.
  process.stderr.write(`${msg}\n`);
}
