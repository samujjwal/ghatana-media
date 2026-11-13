import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export type FakeBehavior =
  | 'normal'
  | 'hang' // accept and never answer
  | 'drop-mid-stream' // destroy after first bytes of INSTREAM
  | 'drop-before-reply' // read whole stream then close without verdict
  | 'garbage' // ambiguous reply
  | 'size-limit'; // clamd StreamMaxLength style error

export interface FakeClamd {
  readonly endpoint: { kind: 'tcp'; host: string; port: number } | { kind: 'unix'; path: string };
  behavior: FakeBehavior;
  version: string;
  /** Number of INSTREAM commands fully received. */
  streams: number;
  connections: number;
  /** Destroy this many upcoming connections immediately (crash/restart simulation). */
  dropNext: number;
  close(): Promise<void>;
}

/** Minimal clamd protocol double: zINSTREAM + zVERSION, EICAR substring => FOUND. Test fixture only. */
export async function startFakeClamd(opts: { unix?: boolean; version?: string } = {}): Promise<FakeClamd> {
  const state = { behavior: 'normal' as FakeBehavior, version: opts.version ?? 'ClamAV 1.4.2/27500/Tue Nov 11 08:30:12 2025', streams: 0, connections: 0, dropNext: 0 };
  let dir: string | undefined;
  const server = net.createServer((socket) => {
    state.connections++;
    if (state.dropNext > 0) {
      state.dropNext--;
      socket.on('error', () => {});
      return void socket.destroy();
    }
    let buf = Buffer.alloc(0);
    let mode: 'cmd' | 'stream' = 'cmd';
    let payload: Buffer[] = [];
    socket.on('error', () => {});
    socket.on('data', (data) => {
      buf = Buffer.concat([buf, typeof data === 'string' ? Buffer.from(data) : data]);
      if (state.behavior === 'hang') return;
      if (mode === 'cmd') {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        const cmd = buf.subarray(0, nul).toString();
        buf = buf.subarray(nul + 1);
        if (cmd === 'zVERSION') {
          if (state.behavior === 'garbage') socket.write('what is this\0');
          else socket.write(`${state.version}\0`);
          return;
        }
        if (cmd === 'zINSTREAM') mode = 'stream';
        else return void socket.end('UNKNOWN COMMAND\0');
      }
      if (mode === 'stream') {
        if (state.behavior === 'drop-mid-stream') return void socket.destroy();
        for (;;) {
          if (buf.length < 4) return;
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            buf = buf.subarray(4);
            state.streams++;
            const content = Buffer.concat(payload);
            if (state.behavior === 'drop-before-reply') return void socket.destroy();
            if (state.behavior === 'size-limit') return void socket.write('INSTREAM size limit exceeded. ERROR\0');
            if (state.behavior === 'garbage') return void socket.write('stream: maybe\0');
            socket.write(content.includes(Buffer.from(EICAR)) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
            return;
          }
          if (buf.length < 4 + len) return;
          payload.push(buf.subarray(4, 4 + len));
          buf = buf.subarray(4 + len);
        }
      }
    });
  });
  const endpoint = await new Promise<FakeClamd['endpoint']>((resolve) => {
    if (opts.unix) {
      dir = mkdtempSync(path.join(tmpdir(), 'fake-clamd-'));
      const p = path.join(dir, 'clamd.sock');
      server.listen(p, () => resolve({ kind: 'unix', path: p }));
    } else {
      server.listen(0, '127.0.0.1', () => resolve({ kind: 'tcp', host: '127.0.0.1', port: (server.address() as net.AddressInfo).port }));
    }
  });
  return Object.assign(state, {
    endpoint,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (dir) rmSync(dir, { recursive: true, force: true });
          resolve();
        });
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  }) as unknown as FakeClamd;
}
