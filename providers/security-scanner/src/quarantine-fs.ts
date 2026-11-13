import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { QuarantineSource } from './provider.ts';

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Bounded read-only quarantine source over a directory laid out as `<root>/<tenantId>/<objectRef>`.
 * Names are validated (no separators, no traversal), symlinks and non-regular files are refused, the
 * resolved path must stay inside the root, and size is checked before any bytes are read. The returned
 * tenant is the owning directory, never the requester's claim.
 */
export class FilesystemQuarantineSource implements QuarantineSource {
  readonly #root: string;
  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  async read(
    request: { tenantId: string; maxBytes: number; sourceRef?: string },
    signal: AbortSignal,
  ): Promise<{ tenantId: string; content: Uint8Array } | undefined> {
    const ref = request.sourceRef;
    if (!ref || !SAFE.test(ref) || !SAFE.test(request.tenantId)) return undefined;
    const file = path.join(this.#root, request.tenantId, ref);
    try {
      const st = await lstat(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > request.maxBytes) return undefined;
      const real = await realpath(file);
      if (!real.startsWith(`${await realpath(this.#root)}${path.sep}`)) return undefined;
      const handle = await open(file, 'r');
      try {
        const buf = Buffer.alloc(st.size);
        let off = 0;
        while (off < st.size) {
          signal.throwIfAborted();
          const { bytesRead } = await handle.read(buf, off, st.size - off, off);
          if (bytesRead === 0) break;
          off += bytesRead;
        }
        return { tenantId: request.tenantId, content: buf.subarray(0, off) };
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }
}
