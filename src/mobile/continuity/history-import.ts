/** Host-only historical import. No path input, provider mutation, discovery or import-time I/O. */
import { isAbsolute, normalize } from 'node:path';
import type { NativeRecords } from './native-records';
import { ContinuityError, type Binding, type Room, type RoomEvent, type Store } from './types';

export type HistorySourceBinding = Omit<Binding, 'cursor'>;
export interface HistoryImportObservation {
  roomId: string; backend: Room['backend']; workspace: string; room: string; cwd: string;
  /** Fresh observed process identity, never merely copied configured metadata. */
  binding: HistorySourceBinding;
}
export interface HistoryImportReadRequest {
  room: Room;
  binding: Binding;
}
export interface HistoryImportPorts {
  store: Pick<Store, 'importHistory'>;
  inspect(room: Readonly<Room>): Promise<HistoryImportObservation>;
  /** Host-owned exact native resolver + bounded full reader. No API/model-provided paths or latest lookup. */
  read(request: HistoryImportReadRequest): Promise<NativeRecords>;
}
export interface HistoryImportResult {
  room: Room;
  inserted: RoomEvent[];
  observedEvents: number;
  /** Historical source identity only, not a live readiness assertion or retrieval receipt. */
  source: HistorySourceBinding;
}
export const HISTORY_IMPORT_LIMITS = Object.freeze({ maxEvents: 100_000, maxBytes: 64 * 1024 * 1024, maxEventBytes: 2 * 1024 * 1024 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\0\r\n]/.test(v);
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const fail = (code: string): never => { throw new ContinuityError(code); };
function clone<T>(value: T): T {
  try { return structuredClone(value); } catch { return fail('history_import_invalid_data'); }
}
function source(binding: Binding): HistorySourceBinding {
  const { cursor: _cursor, ...identity } = binding;
  return clone(identity);
}
function validRoom(room: Room): Binding {
  if (!plain(room) || Object.keys(room).some(k => !['id','workspace','room','backend','cwd','revision','active','bindings','operationId'].includes(k))
    || !text(room.id,256) || !text(room.workspace) || !text(room.room) || !['herdr','tmux','superset'].includes(room.backend)
    || !text(room.cwd,4096) || !isAbsolute(room.cwd) || normalize(room.cwd) !== room.cwd || !uint(room.revision)
    || !['claude','codex'].includes(room.active) || !plain(room.bindings)) fail('history_import_room_invalid');
  if (room.operationId !== undefined) fail('operation_in_progress');
  for (const [agent,b] of Object.entries(room.bindings)) {
    if (!['claude','codex'].includes(agent) || !plain(b) || b.agent !== agent || !UUID.test(b.nativeId) || !text(b.generation)
      || !uint(b.cursor) || b.model !== undefined && !text(b.model,256) || b.route !== undefined && !text(b.route,256)
      || Object.keys(b).some(k => !['agent','nativeId','generation','cursor','model','route'].includes(k))) fail('history_import_binding_invalid');
  }
  return room.bindings[room.active] ?? fail('history_import_binding_missing');
}
function assertObserved(room: Room, expected: Binding, observed: HistoryImportObservation): void {
  const actual = observed?.binding;
  if (!plain(observed) || !plain(actual) || observed.roomId !== room.id || observed.backend !== room.backend
    || observed.workspace !== room.workspace || observed.room !== room.room || observed.cwd !== room.cwd
    || actual.agent !== expected.agent || actual.nativeId !== expected.nativeId || actual.generation !== expected.generation
    || actual.model !== expected.model || actual.route !== expected.route) fail('history_import_binding_changed');
}
/** Validate projection identity before any write; snapshot completeness remains a trusted full-reader contract. */
function project(room: Room, binding: Binding, records: NativeRecords): Omit<RoomEvent,'seq'>[] {
  if (!plain(records) || records.nativeId !== binding.nativeId || records.cwd !== room.cwd) fail('history_import_native_mismatch');
  if (binding.model !== undefined && records.model !== undefined && binding.model !== records.model) fail('history_import_native_model_changed');
  if (!Array.isArray(records.events) || records.events.length > HISTORY_IMPORT_LIMITS.maxEvents || !Array.isArray(records.assistantMessages)
    || ['turnComplete','pendingTools','refused','interrupted'].some(k => typeof records[k as keyof NativeRecords] !== 'boolean')) fail('history_import_snapshot_invalid');
  const prefix = `${binding.agent}:${binding.nativeId}:`, ids = new Set<string>(), users = new Map<string,number>();
  let lastIndex = -1, bytes = 0;
  const events = records.events.map(event => {
    if (!plain(event) || !text(event.sourceId,1024) || !['user','assistant','tool'].includes(event.role) || !uint(event.index) || event.index < lastIndex
      || typeof event.text !== 'string' || event.text.includes('\0') || event.ts !== undefined && !text(event.ts,128)
      || event.metadata !== undefined && !plain(event.metadata) || ids.has(event.sourceId)) fail('history_import_event_invalid');
    if (!(event.role === 'tool' ? ['tool-call:','tool-result:'] : ['message:']).some(kind => event.sourceId.startsWith(prefix + kind) && event.sourceId.length > (prefix + kind).length)) fail('history_import_event_identity_changed');
    lastIndex = event.index; ids.add(event.sourceId);
    if (event.role === 'user') users.set(event.sourceId,event.index);
    const value: Omit<RoomEvent,'seq'> = { sourceId:event.sourceId,agent:binding.agent,nativeId:binding.nativeId,role:event.role,text:event.text,
      ...(event.ts !== undefined ? {ts:event.ts} : {}), ...(event.metadata !== undefined ? {metadata:clone(event.metadata)} : {}) };
    let size: number;
    try { size = Buffer.byteLength(JSON.stringify(value)); } catch { return fail('history_import_event_invalid'); }
    if (size > HISTORY_IMPORT_LIMITS.maxEventBytes || (bytes += size) > HISTORY_IMPORT_LIMITS.maxBytes) fail('history_import_too_large');
    return value;
  });
  // Check observable projection consistency. Shape alone cannot attest that earlier complete turns were not omitted.
  const latest = [...users].at(-1);
  if (records.lastUserSourceId !== latest?.[0] || records.lastUserIndex !== latest?.[1]) fail('history_import_snapshot_incomplete');
  for (const event of records.events) {
    if (event.role === 'user') continue;
    const metadata = event.metadata;
    if (!metadata || typeof metadata.replyToSourceId !== 'string' || users.get(metadata.replyToSourceId) !== metadata.replyToIndex
      || !uint(metadata.replyToIndex) || metadata.replyToIndex >= event.index) fail('history_import_snapshot_incomplete');
  }
  const eventById = new Map(records.events.map(event => [event.sourceId,event]));
  for (const answer of records.assistantMessages) {
    const event = eventById.get(answer.sourceId);
    if (!event || event.role !== 'assistant' || event.text !== answer.text || event.index !== answer.index
      || event.metadata?.replyToSourceId !== answer.replyToSourceId || event.metadata?.replyToIndex !== answer.replyToIndex
      || event.metadata?.final !== answer.final) fail('history_import_snapshot_incomplete');
  }
  return events;
}
/** Trusted host call only. The final synchronous store call owns registration + all event batches atomically. */
export async function importOldRoomHistory(input: Room, ports: HistoryImportPorts): Promise<HistoryImportResult> {
  const room = clone(input), binding = clone(validRoom(room));
  if (!ports || typeof ports.inspect !== 'function' || typeof ports.read !== 'function' || typeof ports.store?.importHistory !== 'function') fail('history_import_ports_missing');
  let before: HistoryImportObservation;
  try { before = clone(await ports.inspect(clone(room))); } catch { return fail('history_import_observation_unavailable'); }
  assertObserved(room,binding,before);
  let records: NativeRecords;
  try { records = clone(await ports.read({room:clone(room),binding:clone(binding)})); } catch { return fail('history_import_read_failed'); }
  const events = project(room,binding,records);
  let after: HistoryImportObservation;
  try { after = clone(await ports.inspect(clone(room))); } catch { return fail('history_import_observation_unavailable'); }
  assertObserved(room,binding,after);
  // No await between the post-read observation and this transaction. Store rechecks current Room under its lock.
  const committed = ports.store.importHistory(room,events);
  return { ...committed, observedEvents:events.length, source:source(binding) };
}
