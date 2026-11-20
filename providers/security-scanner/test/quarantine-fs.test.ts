import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { FilesystemQuarantineSource, openQuarantineObjectAt } from '../src/quarantine-fs.ts';

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fdRoot = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
const descriptorPlatform = ['linux', 'darwin', 'freebsd', 'openbsd', 'netbsd'].includes(process.platform);

describe('FilesystemQuarantineSource descriptor confinement', () => {
  it('continues reading the opened tenant directory after its pathname is replaced by a symlink', async (t) => {
    if (!descriptorPlatform || process.platform === 'win32' || typeof constants.O_DIRECTORY !== 'number'
      || typeof constants.O_NOFOLLOW !== 'number') {
      t.skip('descriptor-relative no-follow directory opens require POSIX flags');
      return;
    }

    const root = mkdtempSync(path.join(tmpdir(), 'scanner-quarantine-fd-'));
    const tenantDir = path.join(root, 'tenant-a');
    const movedTenantDir = path.join(root, 'tenant-a-original');
    const outside = path.join(root, 'outside');
    const owned = Buffer.from('tenant-a quarantine bytes');
    const foreign = Buffer.from('tenant-b secret bytes');
    let rootHandle: Awaited<ReturnType<typeof open>> | undefined;
    let tenantHandle: Awaited<ReturnType<typeof open>> | undefined;
    let objectHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      mkdirSync(tenantDir);
      mkdirSync(outside);
      writeFileSync(path.join(tenantDir, 'object-1'), owned);
      writeFileSync(path.join(outside, 'object-1'), foreign);

      rootHandle = await open(root, directoryFlags);
      tenantHandle = await open(path.join(fdRoot, String(rootHandle.fd), 'tenant-a'), directoryFlags);

      // Simulate a concurrent attacker replacing a checked tenant path after the directory
      // handle is acquired. Descriptor-relative access must stay on the original directory.
      renameSync(tenantDir, movedTenantDir);
      symlinkSync(outside, tenantDir);
      objectHandle = await openQuarantineObjectAt(tenantHandle, 'object-1');
      assert.deepEqual(await objectHandle.readFile(), owned);

      // A fresh lookup through the attacker-controlled tenant pathname fails closed.
      const result = await new FilesystemQuarantineSource(root).read({
        tenantId: 'tenant-a', documentId: 'doc-1', version: 1, maxBytes: 1024, sourceRef: 'object-1',
      }, new AbortController().signal);
      assert.equal(result, undefined);
    } finally {
      await objectHandle?.close();
      await tenantHandle?.close();
      await rootHandle?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a final-component symlink and invalid read bounds', async (t) => {
    if (!descriptorPlatform || process.platform === 'win32') {
      t.skip('descriptor-relative quarantine access is unavailable on this platform');
      return;
    }
    const root = mkdtempSync(path.join(tmpdir(), 'scanner-quarantine-link-'));
    const tenantDir = path.join(root, 'tenant-a');
    const outside = path.join(root, 'outside');
    mkdirSync(tenantDir);
    writeFileSync(outside, Buffer.from('outside quarantine'));
    symlinkSync(outside, path.join(tenantDir, 'object-1'));
    const source = new FilesystemQuarantineSource(root);
    const base = { tenantId: 'tenant-a', documentId: 'doc-1', version: 1, sourceRef: 'object-1' };
    try {
      assert.equal(await source.read({ ...base, maxBytes: 1024 }, new AbortController().signal), undefined);
      assert.equal(await source.read({ ...base, maxBytes: 0 }, new AbortController().signal), undefined);
      assert.equal(await source.read({ ...base, maxBytes: Number.MAX_SAFE_INTEGER + 1 }, new AbortController().signal), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
