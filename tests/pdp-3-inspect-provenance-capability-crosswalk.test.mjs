import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const parse = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml').parse;
const base = '.product-experience/pdp-3-product-experience/screen-contracts';
const screenFiles = [
  'inspect-provenance.yaml',
  'inspect-output.yaml',
  'review-outputs.yaml',
  'review-quality.yaml',
  'compare-results.yaml',
  'compare-caption-versions.yaml',
];

test('inspect-provenance screen actions retain the complete registry capability crosswalk', () => {
  for (const file of screenFiles) {
    const screen = parse(readFileSync(`${base}/${file}`, 'utf8'));
    const row = screen.actionConsequences.find(({ actionId }) => actionId === 'media.action.inspect-provenance');
    assert.ok(row, `${file} exposes media.action.inspect-provenance`);
    assert.deepEqual(row.capabilityRefs, [
      'media.artifact.inspect',
      'media.artifact.provenance.export',
      'media.provenance.source-lineage.inspect',
    ], `${file} preserves every action-registry capability`);
    assert.deepEqual(row.requirementRefs, [
      'MEDIA-REQ-CAP-ARTIFACT',
      'MEDIA-REQ-CAP-PROVENANCE',
    ], `${file} preserves the exact P0 capability requirement crosswalk`);
  }
});
