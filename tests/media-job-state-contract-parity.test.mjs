import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const contracts = readFileSync(join(repo, 'libs/audio-video-types/src/contracts.ts'), 'utf8');
const operations = readFileSync(join(repo, '.product-experience/pdp-1-domain-data/operations.yaml'), 'utf8');

const enumValues = (source, schemaName) => {
  const match = source.match(new RegExp(schemaName + '\\s*=\\s*z\\.enum\\(\\[([^\\]]+)\\]\\)'));
  assert.ok(match, `${schemaName} enum not found in contracts.ts`);
  return [...match[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
};

const pdp1CanonicalStates = (() => {
  const block = operations.match(/canonicalStateEnum:\s*\n((?:\s*-\s*[A-Z_]+\s*\n)+)/);
  assert.ok(block, 'PDP-1 canonicalStateEnum not found in operations.yaml');
  return [...block[1].matchAll(/-\s*([A-Z_]+)/g)].map((m) => m[1]);
})();

const javaRuntimeStates = (() => {
  const java = readFileSync(
    join(repo, 'runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java'),
    'utf8');
  const match = java.match(/enum JobStatus\s*\{([^}]+)\}/);
  assert.ok(match, 'Java JobStatus enum not found');
  return [...match[1].matchAll(/([A-Z_]+)/g)].map((m) => m[1]);
})();

test('TY-01: TS MediaJobStateSchema exactly equals the PDP-1 nine canonical job states', () => {
  assert.deepEqual(enumValues(contracts, 'MediaJobStateSchema'), pdp1CanonicalStates);
  assert.equal(pdp1CanonicalStates.length, 9);
});

test('TY-01: legacy spellings stay observable but never claim a canonical state', () => {
  const legacy = enumValues(contracts, 'LegacyMediaJobStateSchema');
  assert.deepEqual(legacy, ['CANCELLING', 'RETRYING']);
  for (const state of legacy) {
    assert.ok(!pdp1CanonicalStates.includes(state),
      `${state} is a machine-scoped legacy spelling, not a canonical PDP-1 state`);
  }
  // The observation schema must keep rawState and an explicit disposition.
  assert.match(contracts, /rawState must preserve the observed state/);
  assert.match(contracts, /canonicalState: MediaJobStateSchema\.nullable\(\)/);
});

test('TY-01: Java runtime JobStatus is a distinct projection, not the PDP-1 state enum', () => {
  // Runtime status is coarser by design; every runtime value either maps to a
  // canonical state or is documented NOT_MAPPED_RUNTIME_ONLY in PDP-1.
  for (const state of javaRuntimeStates) {
    assert.ok(pdp1CanonicalStates.includes(state)
        || operations.includes(`sourceStatus: ${state}`),
      `runtime status ${state} has no PDP-1 mapping disposition`);
  }
});
