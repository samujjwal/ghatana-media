import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const census = JSON.parse(readFileSync(join(repo, 'docs/implementation/media-ocr-compat-census.v1.json'), 'utf8'));
const inventory = JSON.parse(readFileSync(join(repo, 'docs/migration/ocr-consumer-inventory.v1.json'), 'utf8'));

test('historical OC-01 shim evidence does not claim current provider admission', () => {
  assert.equal(census.verdict.status, 'COMPAT_SHIM_NOT_ADMITTED');
  assert.match(census.verdict.externalOwner, /#252/);
  assert.equal(existsSync(join(repo, census.adapter)), false);
  const current = inventory.mediaEntries.find(entry => entry.id === 'MEDIA-KERNEL-OCR-COMPAT');
  assert.equal(current.disposition, 'RETIRED');
  assert.match(current.remaining, /not admitted/i);
});
