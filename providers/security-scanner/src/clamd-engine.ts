import net from 'node:net';
import { ScanEngineError } from './errors.ts';
import type { EngineIdentity, EngineScanOutcome, ScanEngine } from './engine.ts';

export type ClamdEndpoint =
  | { readonly kind: 'tcp'; readonly host: string; readonly port: number }
  | { readonly kind: 'unix'; readonly path: string };

export interface ClamdEngineOptions {
  readonly endpoint: ClamdEndpoint;
  /** Hard ceiling on bytes streamed to clamd. Must not exceed clamd StreamMaxLength. */
  readonly maxBytes: number;
  readonly connectTimeoutMs?: number;
  /** Budget for one whole command round trip, including streaming and the verdict line. */
  readonly commandTimeoutMs?: number;
  readonly chunkBytes?: number;
  /** Total attempts for retryable transport failures (>=1). Scans are read-only, so retry is safe. */
  readonly maxAttempts?: number;
  readonly retryBackoffMs?: number;
}

const MAX_RESPONSE_BYTES = 4096;

/**
 * clamd client using the documented `zINSTREAM` / `zVERSION` null-terminated commands.
 * It never trusts ambiguous replies: anything other than an exact `OK` / `<name> FOUND` /
 * `... ERROR` line is PROTOCOL_AMBIGUOUS, which the provider maps to UNKNOWN.
 */
export class ClamdEngine implements ScanEngine {
  readonly #o: Required<Omit<ClamdEngineOptions, 'endpoint'>> & { endpoint: ClamdEndpoint };

  constructor(options: ClamdEngineOptions) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
    this.#o = {
      endpoint: options.endpoint,
      maxBytes: options.maxBytes,
      connectTimeoutMs: options.connectTimeoutMs ?? 2_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 30_000,
      chunkBytes: Math.min(Math.max(options.chunkBytes ?? 64 * 1024, 1), 1024 * 1024),
      maxAttempts: Math.max(1, options.maxAttempts ?? 2),
      retryBackoffMs: Math.max(0, options.retryBackoffMs ?? 50),
    };
  }

  async identity(signal?: AbortSignal): Promise<EngineIdentity> {
    const line = await this.#withRetry(() => this.#exchange(Buffer.from('zVERSION\0'), undefined, signal));
    return parseVersion(line);
  }

  async scan(content: Uint8Array, signal?: AbortSignal): Promise<EngineScanOutcome> {
    if (content.byteLength > this.#o.maxBytes) {
      throw new ScanEngineError('OVERSIZED', `content exceeds ${this.#o.maxBytes} bytes`);
    }
    if (content.byteLength === 0) {
      throw new ScanEngineError('PROTOCOL_AMBIGUOUS', 'empty content is not scannable');
    }
    const line = await this.#withRetry(() =>
      this.#exchange(Buffer.from('zINSTREAM\0'), content, signal),
    );
    return parseScanReply(line);
  }

  async #withRetry(op: () => Promise<string>): Promise<string> {
    let last: unknown;
    for (let attempt = 1; attempt <= this.#o.maxAttempts; attempt++) {
      try {
        return await op();
      } catch (error) {
        last = error;
        if (!(error instanceof ScanEngineError) || !error.retryable || attempt === this.#o.maxAttempts) {
          throw error;
        }
        await new Promise((r) => setTimeout(r, this.#o.retryBackoffMs * attempt));
      }
    }
    throw last;
  }

  #exchange(command: Buffer, content: Uint8Array | undefined, signal?: AbortSignal): Promise<string> {
    const o = this.#o;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const socket =
        o.endpoint.kind === 'tcp'
          ? net.createConnection({ host: o.endpoint.host, port: o.endpoint.port })
          : net.createConnection({ path: o.endpoint.path });
      const chunks: Buffer[] = [];
      let received = 0;
      let connectTimer: NodeJS.Timeout | undefined = setTimeout(
        () => fail(new ScanEngineError('TIMEOUT', 'clamd connect timeout')),
        o.connectTimeoutMs,
      );
      const commandTimer = setTimeout(
        () => fail(new ScanEngineError('TIMEOUT', 'clamd command timeout')),
        o.commandTimeoutMs,
      );
      const onAbort = () => fail(new ScanEngineError('TIMEOUT', 'scan aborted by caller'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) queueMicrotask(onAbort);

      function cleanup(): void {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = undefined;
        clearTimeout(commandTimer);
        signal?.removeEventListener('abort', onAbort);
        socket.destroy();
      }
      function fail(error: ScanEngineError): void {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
      function succeed(line: string): void {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(line);
      }

      socket.on('connect', () => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = undefined;
        socket.write(command);
        if (content) {
          // Chunk framing: 4-byte big-endian length + data, terminated by a zero-length chunk.
          for (let offset = 0; offset < content.byteLength; offset += o.chunkBytes) {
            const slice = content.subarray(offset, Math.min(offset + o.chunkBytes, content.byteLength));
            const header = Buffer.alloc(4);
            header.writeUInt32BE(slice.byteLength, 0);
            socket.write(header);
            socket.write(slice);
          }
          socket.write(Buffer.alloc(4));
        }
      });
      socket.on('data', (data: Buffer) => {
        received += data.length;
        if (received > MAX_RESPONSE_BYTES) {
          fail(new ScanEngineError('PROTOCOL_AMBIGUOUS', 'clamd reply exceeds bound'));
          return;
        }
        chunks.push(data);
        const text = Buffer.concat(chunks);
        const end = text.indexOf(0);
        if (end >= 0) succeed(text.subarray(0, end).toString('utf8'));
      });
      socket.on('error', (error: NodeJS.ErrnoException) => {
        const refused = error.code === 'ECONNREFUSED' || error.code === 'ENOENT' || error.code === 'EACCES';
        fail(
          new ScanEngineError(
            refused ? 'UNAVAILABLE' : 'CONNECTION_DROPPED',
            `clamd transport error: ${error.code ?? error.message}`,
            { cause: error },
          ),
        );
      });
      socket.on('close', () => {
        if (settled) return;
        // Closed without a NUL-terminated reply: a trailing newline-terminated reply is also
        // accepted by clamd for non-z commands, but we only issue z commands, so this is a drop.
        fail(new ScanEngineError('CONNECTION_DROPPED', 'clamd closed the connection before a verdict'));
      });
    });
  }
}

export function parseScanReply(line: string): EngineScanOutcome {
  const reply = line.trim();
  if (/ ERROR$/u.test(reply)) {
    if (/size limit exceeded/iu.test(reply)) {
      throw new ScanEngineError('OVERSIZED', 'clamd rejected the stream as oversized');
    }
    throw new ScanEngineError('UNAVAILABLE', 'clamd reported an engine error');
  }
  const found = /^stream: (.+) FOUND$/u.exec(reply);
  if (found && found[1]) return { kind: 'INFECTED', signatureName: found[1] };
  if (reply === 'stream: OK') return { kind: 'CLEAN' };
  throw new ScanEngineError('PROTOCOL_AMBIGUOUS', 'unrecognised clamd reply');
}

export function parseVersion(line: string): EngineIdentity {
  // "ClamAV 1.4.2/27500/Tue Nov 11 08:30:12 2025"
  const match = /^(ClamAV \d+\.\d+\.\d+(?:[-\w.]*)?)(?:\/(\d+)\/(.+))?$/u.exec(line.trim());
  if (!match || !match[1]) {
    throw new ScanEngineError('PROTOCOL_AMBIGUOUS', 'unrecognised clamd version reply');
  }
  const date = match[3] ? new Date(`${match[3]} UTC`) : undefined;
  return {
    name: 'ClamAV',
    version: match[1],
    ...(match[2] ? { definitionsVersion: match[2] } : {}),
    ...(date && !Number.isNaN(date.getTime()) ? { definitionsDate: date } : {}),
  };
}
