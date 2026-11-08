/** Private native protocol contracts. No PTY, process launch or provider HTTP side effects. */
export type ProtocolAgent = 'codex' | 'claude';
export interface ProtocolWire {
  /** One parsed native JSON frame; the host enforces byte/frame limits. */
  readonly messages: AsyncIterable<unknown>;
  send(frame: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}
export interface ProtocolPolicy {
  agent: ProtocolAgent;
  cwd: string;
  home: string;
  /** Canonical native configuration home supplied by trusted host entry selection. */
  toolHome?: string;
  model: string;
  route: string;
  /** Expected native provider, not a claim about account or quota. */
  modelProvider?: string;
  timeoutMs: number;
}
export interface ProtocolIdentity {
  agent: ProtocolAgent; nativeId: string; model: string;
  cwd: string;
  /** Trusted host launch metadata only. Native init frames do NOT prove these fields. */
  home: string; route: string;
}
export type NativeProtocolObservation = Readonly<Pick<ProtocolIdentity,'agent'|'nativeId'|'model'|'cwd'>>;
export interface ProtocolApproval {
  id: string; nativeId: string; turnId: string; tool: string;
  /** Data for authenticated host UI only; never interpreted as host instructions. */
  details: unknown;
}
export interface ProtocolTurn {
  operationId: string; nativeId: string; turnId: string;
  text: string; state: 'completed';
}
export interface ProtocolHooks {
  /** Absence, disconnect or unsupported request must deny, never auto-approve. */
  approve?: (request: ProtocolApproval) => Promise<'allow' | 'deny'>;
}
export interface NativeProtocolSession {
  /** Exact resume only when nativeId is supplied; never fallback to a fresh session. */
  open(nativeId?: string): Promise<ProtocolIdentity>;
  turn(operationId: string, text: string): Promise<ProtocolTurn>;
  readonly idle: boolean;
  readonly pendingApproval: boolean;
  /** Keep native observations separate from composite host launch metadata. */
  readonly nativeObservation?: NativeProtocolObservation;
  close(): Promise<void>;
}
/** Native protocols that report identity only after their first user message.
 * prepare is control readiness, never native identity or permission to dispatch.
 * Host must persist launch/first-turn intent and attest the entry before startTurn.
 */
export interface StagedNativeProtocolSession extends NativeProtocolSession {
  prepare(nativeId?: string): Promise<void>;
  startTurn(operationId: string, text: string): Promise<{identity: ProtocolIdentity; turn: ProtocolTurn}>;
}
export class ProtocolError extends Error {
  constructor(readonly code: string, readonly uncertain = false) {
    super(code); this.name = 'ProtocolError';
  }
}
