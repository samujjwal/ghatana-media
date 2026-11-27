import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ScannerJobLedger } from '../src/job-ledger.ts';
import type { DocumentContentScanInput } from '../src/contract.ts';

const input: DocumentContentScanInput = {
  documentId: 'doc', version: 1, checksum: { algorithm: 'SHA-256', value: 'a'.repeat(64) },
  sizeBytes: 1, mimeType: 'application/pdf', tenantRef: 'tenant', sourceRef: 'object',
};

test('replay reservations, expired claims, cancellation and tombstones survive independent connections', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scanner-ledger-'));
  const file = path.join(dir, 'jobs.sqlite');
  let a = new ScannerJobLedger(file);
  const b = new ScannerJobLedger(file);
  try {
    const first = a.reserve('tenant', 'principal', 'key', 'fp', input, 0, 1, 2);
    assert.equal(first.kind, 'accepted');
    if (first.kind !== 'accepted') throw new Error('reservation failed');
    const id = first.job.id;
    const duplicate = b.reserve('tenant', 'principal', 'key', 'fp', input, 1, 1, 2);
    assert.equal(duplicate.kind, 'accepted');
    if (duplicate.kind !== 'accepted') throw new Error('replay failed');
    assert.equal(duplicate.job.id, id);
    assert.equal(b.reserve('tenant', 'principal', 'key', 'changed', input, 1, 1, 2).kind, 'conflict');
    assert.equal(b.reserve('tenant', 'principal', 'new', 'fp', input, 1, 1, 2).kind, 'busy');
    const old = a.claim(1, 10, [])!;
    assert.equal(old.id, id);
    assert.equal(b.claim(10, 10, []), undefined);
    a.close();
    a = new ScannerJobLedger(file);
    const resumed = b.claim(11, 10, [])!;
    assert.equal(resumed.id, id);
    assert.notEqual(resumed.claimToken, old.claimToken);
    assert.equal(a.finish(id, old.claimToken!, 12, undefined), false);
    assert.equal(a.cancel(id, 12)?.state, 'CANCELLED');
    assert.equal(b.finish(id, resumed.claimToken!, 13, undefined), false);
    assert.equal(a.read(id)?.state, 'CANCELLED');
    b.prune(30, 10, 1);
    assert.equal(a.read(id)?.state, 'EXPIRED');
    const expired = a.reserve('tenant', 'principal', 'key', 'fp', input, 31, 1, 2);
    if (expired.kind !== 'accepted') throw new Error('expired identity was lost');
    assert.equal(expired.job.id, id);
    assert.equal(expired.job.state, 'EXPIRED');
    assert.equal(a.reserve('tenant', 'other', 'key', 'fp', input, 32, 1, 2).kind, 'accepted');
    assert.equal(a.reserve('tenant', 'principal', 'key', 'changed', input, 33, 1, 2).kind, 'conflict');
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
