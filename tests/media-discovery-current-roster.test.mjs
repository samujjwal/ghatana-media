import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveMediaPdp0Cells } from '../scripts/media-discovery-currentness.mjs';

const dimensions = {
  ownerGraphFingerprint: 'sha256:' + 'a'.repeat(64),
  physicalCatalogFingerprint: 'sha256:' + 'b'.repeat(64),
  providerRegistryFingerprint: 'sha256:' + 'c'.repeat(64),
};

test('PDP-0 current resolver accounts for all 54 topology and registry identities', () => {
  const resolved = resolveMediaPdp0Cells(process.cwd(), dimensions);
  assert.deepEqual(resolved.denominator, {
    physicalCandidates: 26,
    semanticCompositions: 6,
    repositoryRoots: 1,
    consumers: 21,
    totalCells: 54,
  });
  assert.equal(new Set(resolved.cells.map(({ cellId }) => cellId)).size, 54);
});

test('PDP-0 current resolver rejects consumer roster drift against the surface registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-pdp0-roster-drift-'));
  try {
    for (const relative of [
      'docs/implementation/pdp-0-phase-dev-status.json',
      '.product-experience/surfaces/media-physical-topology.v1.json',
      '.product-experience/surface-registry.yaml',
      '.product-experience/reviews/2026-10-13-pdp0-discovery-delegated-review.md',
    ]) {
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(process.cwd(), relative), destination);
    }
    const topologyPath = path.join(root, '.product-experience/surfaces/media-physical-topology.v1.json');
    const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
    topology.consumerCrosswalk.pop();
    fs.writeFileSync(topologyPath, JSON.stringify(topology));
    assert.throws(
      () => resolveMediaPdp0Cells(root, dimensions),
      /consumer inventory does not exactly match the authoritative surface registry/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
