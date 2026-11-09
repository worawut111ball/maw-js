/** Private owned-child stdio only. Trusted host preflight is mandatory; no native/global defaults. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Transform } from 'node:stream';
import { JsonLineWire } from './wire';
import { ProtocolError, type ProtocolWire } from './types';
import type { SessionExitExpected, SessionExitObservation } from './session-lease';

export interface ProcessLaunchPermit { incarnation: string; launchId: string }
/** Returned ONLY by the trusted constructor preflight, never accepted as launch(userArgv). */
export interface ApprovedProcessSpec {
  binary: string; sha256: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd: string;
}
export interface ProcessSupervisorLimits {
  preflightMs: number; lifetimeMs: number; writeMs: number;
  graceMs: number; terminateMs: number; killWaitMs: number;
  maxFrameBytes: number; maxStdoutBytes: number; maxStderrBytes: number;
  maxPendingWrites: number; maxLaunches: number;
}
export interface ProcessDiagnostics {
  stderrBytes: number; stderrTruncated: boolean;
  /** Never raw stderr. Unknown strings can contain credentials, prompts or hidden reasoning. */
  stderr: '' | '[native stderr omitted]' | '[native stderr limit exceeded]';
}
export interface OwnedProtocolProcess extends ProcessLaunchPermit {
  readonly runtimeBirth: string;
  readonly wire: ProtocolWire;
  diagnostics(): ProcessDiagnostics;
  assertRunning(): Promise<void>;
  cleanup(): Promise<void>;
  observeExit(expected: Readonly<SessionExitExpected>): Promise<SessionExitObservation>;
}
export interface ProcessSupervisorOptions {
  /** Trusted host closure: check exact entry binding/pins/config/hooks/MCP/external ownership BEFORE returning. */
  preflight(candidate: unknown, permit: Readonly<ProcessLaunchPermit>): Promise<ApprovedProcessSpec>;
  /** Trusted host-owned turn/tool/approval accounting, never an HTTP boolean. Errors fail closed. */
  pendingWork(): boolean;
  /** Trusted host-only production ownership; does not grant admission or replay. */
  lifetimeMode?:'bounded'|'owned-session';
  limits?: Partial<ProcessSupervisorLimits>;
}
const defaults: ProcessSupervisorLimits = {
  preflightMs: 10_000, lifetimeMs: 120_000, writeMs: 5_000, graceMs: 250, terminateMs: 500, killWaitMs: 1_000,
  maxFrameBytes: 8 * 1024 * 1024, maxStdoutBytes: 32 * 1024 * 1024, maxStderrBytes: 256 * 1024,
  maxPendingWrites: 4, maxLaunches: 1_024,
};
const failure = (code: string, uncertain = false) => new ProtocolError(code, uncertain);
const validId = (s: unknown): s is string => typeof s === 'string' && !!s && s.length <= 256 && !/[\x00-\x20\x7f]/.test(s);
function bounded<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure(code, true)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(failure(code, true)); });
  });
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && !!Object.getOwnPropertyDescriptor(value, key)?.enumerable
    && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function validateSpec(value: unknown): ApprovedProcessSpec {
  if (!plainRecord(value) || Object.keys(value).sort().join(',') !== 'args,binary,cwd,env,sha256') throw failure('protocol_process_spec_invalid');
  const { binary, cwd, sha256, args, env } = value;
  if (typeof binary !== 'string' || typeof cwd !== 'string' || !isAbsolute(binary) || !isAbsolute(cwd)
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || !Array.isArray(args) || args.length > 256 || !plainRecord(env))
    throw failure('protocol_process_spec_invalid');
  if (realpathSync(binary) !== binary || realpathSync(cwd) !== cwd || !statSync(binary).isFile() || !statSync(cwd).isDirectory())
    throw failure('protocol_process_paths_unverified');
  let bytes = 0;
  const argv: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const d = Object.getOwnPropertyDescriptor(args, String(i));
    if (!d || !('value' in d) || typeof d.value !== 'string' || d.value.includes('\0') || Buffer.byteLength(d.value) > 32_000)
      throw failure('protocol_process_spec_invalid');
    bytes += Buffer.byteLength(d.value); argv.push(d.value);
  }
  const entries = Object.entries(env);
  if (entries.length > 128 || bytes > 64_000) throw failure('protocol_process_spec_invalid');
  const environment: Record<string, string> = Object.create(null);
  bytes = 0;
  for (const [key, item] of entries) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || typeof item !== 'string' || item.includes('\0')) throw failure('protocol_process_spec_invalid');
    bytes += Buffer.byteLength(key) + Buffer.byteLength(item);
    if (bytes > 128_000) throw failure('protocol_process_spec_invalid');
    environment[key] = item;
  }
  return { binary, cwd, sha256, args: argv, env: environment };
}
async function verifyPin(spec: ApprovedProcessSpec): Promise<void> {
  const file = await open(spec.binary, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 512 * 1024 * 1024) throw failure('protocol_process_pin_invalid');
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) throw failure('protocol_process_pin_invalid');
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await file.stat(), atPath = statSync(spec.binary);
    if (hash.digest('hex') !== spec.sha256 || before.dev !== atPath.dev || before.ino !== atPath.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || realpathSync(spec.binary) !== spec.binary)
      throw failure('protocol_process_pin_invalid');
  } finally { await file.close(); }
}

export class ProtocolProcessSupervisor {
  private used = new Set<string>();
  private preflight: ProcessSupervisorOptions['preflight'];
  private pendingWork: ProcessSupervisorOptions['pendingWork'];
  private limits: ProcessSupervisorLimits;
  private lifetimeMode:'bounded'|'owned-session';
  constructor(options: ProcessSupervisorOptions) {
    if (typeof options?.preflight !== 'function' || typeof options?.pendingWork !== 'function') throw failure('protocol_process_preflight_required');
    this.preflight = options.preflight; this.pendingWork = options.pendingWork;
    this.lifetimeMode=options.lifetimeMode??'bounded';
    if(!['bounded','owned-session'].includes(this.lifetimeMode))throw failure('protocol_process_limits_invalid');
    this.limits = { ...defaults, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) {
      const maximum = key.includes('Bytes') ? 64 * 1024 * 1024 : key === 'maxPendingWrites' ? 64 : key === 'maxLaunches' ? 10_000 : 600_000;
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw failure('protocol_process_limits_invalid');
    }
    if (this.limits.maxFrameBytes < 128 || this.limits.maxFrameBytes > 32 * 1024 * 1024) throw failure('protocol_process_limits_invalid');
  }
  async launch(candidate: unknown, permit: ProcessLaunchPermit): Promise<OwnedProtocolProcess> {
    if (!plainRecord(permit) || Object.keys(permit).sort().join(',') !== 'incarnation,launchId'
      || !validId(permit.incarnation) || !validId(permit.launchId)) throw failure('protocol_process_permit_invalid');
    // A failed preflight/spawn attempt cannot be retried through this instance with the same permit.
    const incarnationKey = 'i:' + permit.incarnation, launchKey = 'l:' + permit.launchId;
    if (this.used.has(incarnationKey) || this.used.has(launchKey)) throw failure('protocol_process_launch_replayed', true);
    if (this.used.size / 2 >= this.limits.maxLaunches) throw failure('protocol_process_capacity');
    this.used.add(incarnationKey); this.used.add(launchKey);
    const expected = Object.freeze({ incarnation: permit.incarnation, launchId: permit.launchId });
    let spec: ApprovedProcessSpec;
    try {
      const prepared = await bounded(Promise.resolve().then(() => this.preflight(candidate, expected)), this.limits.preflightMs, 'protocol_process_preflight_failed');
      spec = validateSpec(prepared);
      await bounded(verifyPin(spec), this.limits.preflightMs, 'protocol_process_pin_invalid');
    } catch { throw failure('protocol_process_preflight_failed'); }
    let owned: PrivateProtocolProcess | undefined;
    try {
      // Never a shell, never parent environment inheritance, never a user-provided spawn options object.
      const child = spawn(spec.binary, [...spec.args], { cwd: spec.cwd, env: { ...spec.env }, shell: false,
        detached: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      owned = new PrivateProtocolProcess(child, expected, this.limits, this.pendingWork,this.lifetimeMode);
      await bounded(owned.started(), this.limits.preflightMs, 'protocol_process_spawn_failed');
    } catch { if (owned) await owned.cleanup().catch(() => {}); throw failure('protocol_process_spawn_failed', true); }
    return owned;
  }
}

class PrivateProtocolProcess implements OwnedProtocolProcess {
  readonly incarnation: string;
  readonly launchId: string;
  readonly runtimeBirth = 'owned-child:' + randomUUID();
  readonly wire: ProtocolWire;
  private closing = false;
  private disconnected = false;
  private exitObserved = false;
  private closeObserved = false;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private stderrBytes = 0;
  private stderrTruncated = false;
  private stdoutBytes = 0;
  private pendingWrites = 0;
  private cleanupPromise?: Promise<void>;
  private startPromise: Promise<void>;
  private closePromise: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private output: Transform;
  constructor(private child: ChildProcessWithoutNullStreams, permit: ProcessLaunchPermit,
    private limits: ProcessSupervisorLimits, private pendingWork: () => boolean,lifetimeMode:'bounded'|'owned-session') {
    this.incarnation = permit.incarnation; this.launchId = permit.launchId;
    for (const key of ['incarnation', 'launchId', 'runtimeBirth'] as const)
      Object.defineProperty(this, key, { value: this[key], writable: false, configurable: false, enumerable: true });
    this.startPromise = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(failure('protocol_process_spawn_failed', true))); });
    // Attach a rejection handler immediately; no raw OS error/path/env is exposed.
    void this.startPromise.catch(() => {});
    this.closePromise = new Promise(resolve => child.once('close', () => { this.closeObserved = true; clearTimeout(this.timer); resolve(); }));
    child.once('exit', (code, signal) => { this.exitObserved = true; this.exitCode = code; this.exitSignal = signal; });
    child.on('error', () => { this.disconnected = true; });
    const disconnect = () => { this.disconnected = true; };
    child.stdin.on('error', disconnect); child.stdout.on('error', disconnect); child.stderr.on('error', disconnect);
    child.stdout.once('end', disconnect);
    this.output = new Transform({ highWaterMark: 64 * 1024, transform: (chunk: Buffer, _encoding, callback) => {
      this.stdoutBytes += chunk.length;
      if (this.stdoutBytes > limits.maxStdoutBytes) { callback(failure('protocol_process_output_limit', true)); this.stop(); }
      else callback(null, chunk);
    } });
    this.output.on('error', disconnect);
    child.stdout.pipe(this.output);
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes = Math.min(this.limits.maxStderrBytes + 1, this.stderrBytes + chunk.length);
      if (this.stderrBytes > this.limits.maxStderrBytes) { this.stderrTruncated = true; this.stop(); }
      // Drain without retaining or logging any native stderr content.
    });
    const json = new JsonLineWire({ input: this.output, write: async bytes => {
      await this.assertRunning();
      await bounded(new Promise<void>((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve())), limits.writeMs, 'protocol_process_write_uncertain');
    }, close: () => this.cleanup() }, limits.maxFrameBytes);
    const owner = this;
    const messages: AsyncIterable<unknown> = { async *[Symbol.asyncIterator]() {
      try { for await (const frame of json.messages) yield frame; }
      catch { owner.stop(); throw failure('protocol_process_read_uncertain', true); }
    } };
    this.wire = Object.freeze({ messages, send: async (frame: Record<string, unknown>) => {
      await this.assertRunning();
      if (this.pendingWrites >= limits.maxPendingWrites) throw failure('protocol_process_write_capacity');
      this.pendingWrites++;
      try { await json.send(frame); } catch { this.stop(); throw failure('protocol_process_write_uncertain', true); }
      finally { this.pendingWrites--; }
    }, close: () => json.close() });
    if(lifetimeMode==='bounded')this.timer = setTimeout(() => this.stop(), limits.lifetimeMs);
    this.timer?.unref?.();
  }
  started(): Promise<void> { return this.startPromise; }
  diagnostics(): ProcessDiagnostics {
    return { stderrBytes: this.stderrBytes, stderrTruncated: this.stderrTruncated,
      stderr: this.stderrTruncated ? '[native stderr limit exceeded]' : this.stderrBytes ? '[native stderr omitted]' : '' };
  }
  async assertRunning(): Promise<void> {
    if (this.closing || this.disconnected || this.exitObserved || this.closeObserved || this.child.stdin.destroyed
      || this.child.stdin.writableEnded || this.child.stdout.destroyed || this.child.stdout.readableEnded || this.output.destroyed
      || this.child.stderr.destroyed)
      throw failure('protocol_process_not_running', true);
  }
  cleanup(): Promise<void> {
    this.closing = true;
    return this.cleanupPromise ??= this.closeOwned();
  }
  private stop(): void { this.disconnected = true; void this.cleanup().catch(() => {}); }
  private async closeOwned(): Promise<void> {
    clearTimeout(this.timer);
    try { this.child.stdin.end(); } catch { /* Continue to the owned-handle termination path. */ }
    for (const [signal, timeout] of [[null, this.limits.graceMs], ['SIGTERM', this.limits.terminateMs], ['SIGKILL', this.limits.killWaitMs]] as const) {
      if (signal && !this.exitObserved) { try { this.child.kill(signal); } catch { /* An error does not prove exit. */ } }
      if (this.exitObserved) { this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.output.destroy(); }
      try {
        await bounded(this.closePromise, timeout, 'protocol_process_exit_unverified');
        if (!this.exitObserved) throw failure('protocol_process_exit_unverified', true);
        this.output.destroy();
        return;
      } catch { /* Escalate only this exact owned process handle; never a raw/reused PID. */ }
    }
    throw failure('protocol_process_exit_unverified', true);
  }
  async observeExit(expected: Readonly<SessionExitExpected>): Promise<SessionExitObservation> {
    if (expected?.incarnation !== this.incarnation || expected.launchId !== this.launchId || expected.runtimeBirth !== this.runtimeBirth
      || !this.exitObserved || !this.closeObserved || this.pendingWrites !== 0 || (!Number.isSafeInteger(this.exitCode) && !this.exitSignal))
      throw failure('protocol_process_exit_unverified', true);
    let pending = true;
    try { pending = this.pendingWork() !== false; } catch { /* No user-controlled exception can authorize unlock. */ }
    if (pending) throw failure('protocol_process_exit_unverified', true);
    return { source: 'owned-process-supervisor', incarnation: this.incarnation, launchId: this.launchId, runtimeBirth: this.runtimeBirth,
      exit: { code: this.exitCode, signal: this.exitSignal }, inputClosed: true, outputClosed: true, pendingWork: false };
  }
}
