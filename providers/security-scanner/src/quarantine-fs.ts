import { constants as fsConstants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { QuarantineSource } from './provider.ts';

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function descriptorRoot(): string | undefined {
  if (process.platform === 'linux') return '/proc/self/fd';
  if (['darwin', 'freebsd', 'openbsd', 'netbsd'].includes(process.platform)) return '/dev/fd';
  return undefined;
}

/** @internal Open a single validated object name through an already-open tenant directory. */
export async function openQuarantineObjectAt(directory: FileHandle, objectRef: string): Promise<FileHandle> {
  const fdRoot = descriptorRoot();
  if (!fdRoot || !SAFE.test(objectRef) || typeof fsConstants.O_NOFOLLOW !== 'number'
    || typeof fsConstants.O_NONBLOCK !== 'number') throw new Error('descriptor-relative quarantine access unavailable');
  return open(path.join(fdRoot, String(directory.fd), objectRef), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
}

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
    request: Parameters<QuarantineSource['read']>[0],
    signal: AbortSignal,
  ): Promise<{ tenantId: string; content: Uint8Array } | undefined> {
    const ref = request.sourceRef;
    if (!ref || !SAFE.test(ref) || !SAFE.test(request.tenantId)
      || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1) return undefined;

    // Resolve children from open directory handles. A sequence of lstat/realpath/open(path)
    // checks is vulnerable to replacing a checked tenant directory or object with a symlink
    // between validation and open. Descriptor-relative resolution keeps each lookup anchored
    // to the directory object that was actually opened; O_NOFOLLOW rejects a symlink at every
    // untrusted path component and O_NONBLOCK prevents a substituted FIFO from hanging a scan.
    const fdRoot = descriptorRoot();
    if (!fdRoot || typeof fsConstants.O_DIRECTORY !== 'number'
      || typeof fsConstants.O_NOFOLLOW !== 'number' || typeof fsConstants.O_NONBLOCK !== 'number') return undefined;

    let rootHandle: FileHandle | undefined;
    let tenantHandle: FileHandle | undefined;
    let fileHandle: FileHandle | undefined;
    try {
      const canonicalRoot = await realpath(this.#root);
      const directoryFlags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
      rootHandle = await open(canonicalRoot, directoryFlags);
      const rootFdPath = path.join(fdRoot, String(rootHandle.fd));
      tenantHandle = await open(path.join(rootFdPath, request.tenantId), directoryFlags);
      fileHandle = await openQuarantineObjectAt(tenantHandle, ref);

      const st = await fileHandle.stat();
      if (!st.isFile() || st.size > request.maxBytes) return undefined;
      // Confirm the descriptor still resolves beneath the configured root. This also catches
      // filesystem implementations that expose descriptor paths differently than expected.
      const openedFile = await realpath(path.join(fdRoot, String(fileHandle.fd)));
      const relative = path.relative(canonicalRoot, openedFile);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;

      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        signal.throwIfAborted();
        const { bytesRead } = await fileHandle.read(buf, off, st.size - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      return { tenantId: request.tenantId, content: buf.subarray(0, off) };
    } catch {
      return undefined;
    } finally {
      await fileHandle?.close().catch(() => undefined);
      await tenantHandle?.close().catch(() => undefined);
      await rootHandle?.close().catch(() => undefined);
    }
  }
}
