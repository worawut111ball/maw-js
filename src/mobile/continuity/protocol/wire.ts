import { ProtocolError, type ProtocolWire } from './types';

export interface JsonLinePort {
  input: AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** Private stdio framing; never retries a possibly delivered write or logs raw protocol frames. */
export class JsonLineWire implements ProtocolWire {
  private used = false;
  private closed = false;
  private closing?: Promise<void>;
  private poisoned = false;
  private writing: Promise<void> = Promise.resolve();
  readonly messages: AsyncIterable<unknown>;
  constructor(private port: JsonLinePort, private maxFrameBytes = 8 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 128 || maxFrameBytes > 32 * 1024 * 1024)
      throw new ProtocolError('protocol_frame_limit_invalid');
    this.messages = { [Symbol.asyncIterator]: () => this.read() };
  }
  private async *read(): AsyncGenerator<unknown> {
    if (this.used) throw new ProtocolError('protocol_single_reader_required');
    this.used = true;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffered = '';
    try {
      for await (const chunk of this.port.input) {
        if (this.closed) return;
        // Bound intermediate allocation even if a port coalesces many frames into one chunk.
        for (let at = 0; at < chunk.length; at += 4096) {
          buffered += decoder.decode(chunk.subarray(at, at + 4096), { stream: true });
          let newline: number;
          while ((newline = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
            if (Buffer.byteLength(line) > this.maxFrameBytes) throw new ProtocolError('protocol_frame_too_large', true);
            if (!line.trim()) continue;
            let frame: unknown;
            try { frame = JSON.parse(line); } catch { throw new ProtocolError('protocol_invalid_json', true); }
            if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new ProtocolError('protocol_invalid_frame', true);
            yield frame;
            if (this.closed) return;
          }
          if (Buffer.byteLength(buffered) > this.maxFrameBytes) throw new ProtocolError('protocol_frame_too_large', true);
        }
      }
      buffered += decoder.decode();
      if (buffered.trim()) throw new ProtocolError('protocol_incomplete_frame', true);
    } catch (error) {
      this.poisoned = true;
      throw error instanceof ProtocolError ? error : new ProtocolError('protocol_read_failed', true);
    }
  }
  send(frame: Record<string, unknown>): Promise<void> {
    if (this.closed || this.poisoned) return Promise.reject(new ProtocolError('protocol_wire_closed', true));
    let text: string;
    try { text = JSON.stringify(frame); } catch { return Promise.reject(new ProtocolError('protocol_invalid_outbound')); }
    if (!text || !frame || typeof frame !== 'object' || Array.isArray(frame)) return Promise.reject(new ProtocolError('protocol_invalid_outbound'));
    const bytes = new TextEncoder().encode(text + '\n');
    if (bytes.byteLength - 1 > this.maxFrameBytes) return Promise.reject(new ProtocolError('protocol_frame_too_large'));
    const attempt = this.writing.then(async () => {
      if (this.closed || this.poisoned) throw new ProtocolError('protocol_wire_closed', true);
      try { await this.port.write(bytes); }
      catch { this.poisoned = true; throw new ProtocolError('protocol_write_uncertain', true); }
    });
    this.writing = attempt.catch(() => {});
    return attempt;
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= this.port.close();
  }
}
