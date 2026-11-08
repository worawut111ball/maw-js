/** Cross-provider continuity contracts. Types only: no runtime/import side effects. */
export type AgentKind = 'codex' | 'claude';
export type Backend = 'herdr' | 'tmux' | 'superset';
export interface Binding {
  agent: AgentKind; nativeId: string; generation: string; model?: string; route?: string; cursor: number;
}
export interface Room {
  id: string; workspace: string; room: string; backend: Backend; cwd: string; revision: number;
  active: AgentKind; bindings: Partial<Record<AgentKind, Binding>>; operationId?: string;
}
export interface RoomEvent {
  seq: number; sourceId: string; agent: AgentKind; nativeId: string; role: string; text: string;
  ts?: string; metadata?: Record<string, unknown>;
}
export type OperationState = 'waiting-safe-point' | 'checkpointed' | 'preparing-target' | 'delivering-context' | 'ready-awaiting-user' | 'blocked' | 'failed' | 'uncertain';
export interface Operation {
  id: string; roomId: string; target: AgentKind; model?: string; expectedRevision: number;
  state: OperationState; reason?: string; from: Binding; targetBinding?: Binding;
  checkpointSeq?: number; contextHash?: string; createdAt: number;
}
export interface BeginRequest { id: string; target: AgentKind; model?: string; expectedRevision: number }
export interface HeldMessage { id: string; text: string; intendedGeneration: string }
export interface Inspection {
  binding: Binding; idle: boolean; pendingTools: boolean; pendingPermission: boolean; uncertainDelivery: boolean;
}
export interface ContextDelivery { id: string; text: string; hash: string; throughSeq: number }
export interface DeliveryReceipt { state: 'acknowledged' | 'uncertain' | 'rejected'; nativeId?: string; hash?: string; throughSeq?: number }
export interface Adapter {
  inspect(room: Room): Promise<Inspection>;
  preflight(room: Room, target: AgentKind, model?: string): Promise<{ ready: boolean; reason?: string }>;
  checkpoint(room: Room): Promise<Omit<RoomEvent, 'seq'>[]>;
  launch(room: Room, target: AgentKind, existing?: Binding, model?: string): Promise<Binding>;
  deliver(room: Room, binding: Binding, context: ContextDelivery): Promise<DeliveryReceipt>;
}
export type ContinuityAdapter = Adapter;
export interface Store {
  room(id: string): Room | null;
  register(room: Room): Room;
  events(roomId: string, after?: number, limit?: number): RoomEvent[];
  append(roomId: string, events: Omit<RoomEvent, 'seq'>[]): RoomEvent[];
  begin(roomId: string, request: BeginRequest): Operation;
  operation(id: string): Operation | null;
  latestOperation(roomId: string): Operation | null;
  cancel(id: string, expectedRevision: number): Room;
  saveOperation(op: Operation): void;
  compareAndSave(op: Operation, expectedState: Operation['state']): boolean;
  complete(id: string, binding: Binding): Room;
  hold(roomId: string, message: HeldMessage): HeldMessage;
  held(roomId: string): HeldMessage[];
  close(): void;
}
export class ContinuityError extends Error {
  constructor(public code: string, public status = 409) { super(code); this.name = 'ContinuityError'; }
}
