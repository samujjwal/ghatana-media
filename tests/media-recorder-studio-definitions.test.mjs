import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { verifyRecorderStudioDefinitions } from '../scripts/check-media-recorder-studio-definitions.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = filename => fs.readFileSync(path.join(repo, filename), 'utf8');

test('PDP0–2 Recorder Studio requirements/surfaces/parity are structurally complete', () => {
  const result = verifyRecorderStudioDefinitions();
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
  assert.equal(result.stats.recorderCases, 78);
  assert.equal(result.stats.manualEditKinds, 42);
  assert.equal(result.stats.proposedPdpCells, 216);
});
test('rejects an omitted PDP2 acceptance binding', () => {
  const source = read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const changed = source.replace('MEDIA-REC-P0-AC-078', 'MEDIA-REC-P0-AC-077');
  const result = verifyRecorderStudioDefinitions({overrides:{p2:changed}});
  assert.ok(result.errors.some(s => s.includes('PDP2 surface interface profiles')), result.errors.join('\n'));
});
test('rejects a missing keyboard/manual parity operation', () => {
  const source = read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const changed = source.replace(/^  - kind: roll\n/m, '  - kind: unsupported-roll\n');
  const result = verifyRecorderStudioDefinitions({overrides:{p2:changed}});
  assert.ok(result.errors.some(s => s.includes('42 versioned PDP1 edit discriminants')), result.errors.join('\n'));
});
test('rejects removal or duplication of a logical surface', () => {
  const j = JSON.parse(read('.product-experience/surfaces/media-physical-topology.v1.json'));
  j.consumerCrosswalk = j.consumerCrosswalk.slice(0, -1);
  const result = verifyRecorderStudioDefinitions({overrides:{topology:JSON.stringify(j)}});
  assert.ok(result.errors.some(s => s.includes('successor consumer denominator') || s.includes('surface-registry')), result.errors.join('\n'));
});
test('rejects fictional Media domain identities', () => {
  const source = read('.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml');
  const changed = source.replace('extends: media.domain.media-run', 'extends: media.domain.media-job');
  const result = verifyRecorderStudioDefinitions({overrides:{p1:changed}});
  assert.ok(result.errors.some(s => s.includes('merges Media job and attempt')), result.errors.join('\n'));
});

test('rejects a valid but incorrectly grouped capability without changing case counts', () => {
  const source = read('.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml');
  // The capability exists in Media, but it is not REC-C01's authority.
  const changed = source.replace('ownerCapabilityGroup: REC-C01', 'ownerCapabilityGroup: REC-C07');
  const result = verifyRecorderStudioDefinitions({overrides:{p0:changed}});
  assert.ok(result.errors.some(s => s.includes('capability leaf not bound by feature capability group')), result.errors.join('\n'));
});
test('rejects a source-valid acceptance case attached to a different owner surface', () => {
  const source = read('.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml');
  const changed = source.replace('ownerSurface: media.surface.recorder-orchestrator',
    'ownerSurface: media.surface.production-studio');
  const result = verifyRecorderStudioDefinitions({overrides:{p0:changed}});
  assert.ok(result.errors.some(s => s.includes('case surface differs from feature owner surface')), result.errors.join('\n'));
});
test('rejects removal of a capability leaf that still owns acceptance cases', () => {
  const source = read('.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml');
  const changed = source.replace(', media.deliver.publish-governed, media.job.watch', '');
  const result = verifyRecorderStudioDefinitions({overrides:{p0:changed}});
  assert.ok(result.errors.some(s => s.includes('capability leaf not bound by feature capability group')), result.errors.join('\n'));
});

test('native YAML grammar and duplicate-key checks cover Recorder Studio changed sources', () => {
  for (const filename of [
    '.product-experience/surface-registry.yaml',
    '.product-experience/pdp-0-product-truth/requirements.yaml',
    '.product-experience/pdp-0-product-truth/journey-catalog.yaml',
    '.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml',
    '.product-experience/pdp-1-domain-data/domain-objects.yaml',
    '.product-experience/pdp-1-domain-data/versioning.yaml',
    '.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml',
    '.product-experience/pdp-2-design-interface-system/interface-grammar.yaml',
    '.product-experience/pdp-2-design-interface-system/media-editing-grammar.yaml',
    '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml',
  ]) {
    const document = parseDocument(read(filename), { uniqueKeys: true, strict: true });
    assert.deepEqual(document.errors.map(error => error.message), [], filename);
  }
});
test('native YAML parser rejects malformed Recorder Studio authoring', () => {
  const source = read('.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml');
  const document = parseDocument(source + '\ninvalid: [unterminated', { uniqueKeys: true, strict: true });
  assert.notEqual(document.errors.length, 0);
});

test('mandatory definition checker rejects invalid YAML in changed journey source', () => {
  const source = read('.product-experience/pdp-0-product-truth/journey-catalog.yaml');
  const result = verifyRecorderStudioDefinitions({ overrides: {
    journeyCatalog: source + '\ninvalid: [unterminated',
  }});
  assert.ok(result.errors.some(error => error.includes('journeyCatalog: invalid or duplicate YAML mapping')),
    result.errors.join('\n'));
});

test('mandatory definition checker rejects duplicate keys in changed interface grammar', () => {
  const source = read('.product-experience/pdp-2-design-interface-system/interface-grammar.yaml');
  const result = verifyRecorderStudioDefinitions({ overrides: {
    interfaceGrammar: source + '\nrecorderStudioDuplicateProbe: value\nrecorderStudioDuplicateProbe: other',
  }});
  assert.ok(result.errors.some(error => error.includes('interfaceGrammar: invalid or duplicate YAML mapping')),
    result.errors.join('\n'));
});
