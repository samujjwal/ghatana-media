import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(repo, 'adapters/data-cloud-media/src/main/java');
const census = JSON.parse(readFileSync(
  join(repo, 'docs/implementation/media-data-cloud-census.v1.json'), 'utf8'));

const sources = [];
(function walk(p) {
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.java')) sources.push(readFileSync(full, 'utf8'));
  }
})(dir);

test('DC-01: adapters only consume declared public Data Cloud + Media imports', () => {
  const allowed = [/^java\./, /^com\.ghatana\.datacloud\./, /^com\.ghatana\.audio\.video\./,
    /^com\.ghatana\.stt\./, /^com\.ghatana\.core\./, /^io\.activej\./, /^org\.slf4j\./,
    /^tools\.jackson\./, /^com\.ghatana\.media\./, /^com\.ghatana\.kernel\./, /^com\.ghatana\.platform\./];
  for (const src of sources) {
    for (const m of src.matchAll(/^import\s+(?:static\s+)?([\w.]+)/gm)) {
      assert.ok(allowed.some((re) => re.test(m[1])),
        `private cross-repo import in adapter: ${m[1]}`);
    }
  }
});

test('DC-01: zero mapped capability IDs is explicit, never fabricated', () => {
  assert.equal(census.projectionOwnership.capabilityIds.mappedPdp0CapabilityIds, 0);
  assert.match(census.projectionOwnership.capabilityIds.disposition, /NO_DIRECT_CAPABILITY/);
});

test('DC-02: projector keeps exact-source binding checks before emitting', () => {
  const proj = sources.find((s) => s.includes('MediaSemanticObservationProjector'));
  for (const check of ['requireSameTenant', 'requireExactVersion',
    'requireClassificationFloor', 'requireRedactionEvidence']) {
    assert.ok(proj.includes(check), `projector missing ${check}`);
  }
});
