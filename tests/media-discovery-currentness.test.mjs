import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureRepositorySourceCurrentness as captureRepository } from '@ghatana/verification-planner';
import { observeMediaDiscoveryCurrentness, resolveMediaPdp0Cells } from '../scripts/media-discovery-currentness.mjs';

const dimensions = {
  ownerGraphFingerprint: digest('a'),
  physicalCatalogFingerprint: digest('b'),
  providerRegistryFingerprint: digest('c'),
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-discovery-currentness-'));
  fs.mkdirSync(path.join(root, '.product-experience'), { recursive: true });
  fs.writeFileSync(path.join(root, '.product-experience/truth.md'), 'current truth\n');
  const cell = {
    cellId: 'media-root:PDP-0',
    surfaceId: 'media-root',
    phase: 'PDP-0',
    paths: ['.product-experience/truth.md'],
    ...dimensions,
  };
  return { root, cell };
}

function digest(char) { return `sha256:${char.repeat(64)}`; }

test('journal reset performs full validation and fails closed until continuity resumes', () => {
  const { root, cell } = fixture();
  const initial = observeMediaDiscoveryCurrentness(root, [cell]);
  assert.equal(initial.continuity, 'UNKNOWN');
  assert.equal(initial.cells[0].sourceCurrentness, 'UNKNOWN');
  assert.ok(initial.blockers.includes('LIFECYCLE_CONTINUITY_RESET_OR_UNKNOWN'));
  const resumed = observeMediaDiscoveryCurrentness(root, [cell]);
  assert.equal(resumed.continuity, 'CONTINUOUS');
  assert.equal(resumed.cells[0].sourceCurrentness, 'CURRENT');
  assert.equal(resumed.zeroWorkEligible, true);
  assert.deepEqual(resumed.cells[0].expectedPaths, ['.product-experience/truth.md']);
});

test('continuous captures reuse root-wide digests and project exact per-cell paths', () => {
  const { root, cell } = fixture();
  observeMediaDiscoveryCurrentness(root, [cell]);
  observeMediaDiscoveryCurrentness(root, [cell]);
  const reused = observeMediaDiscoveryCurrentness(root, [cell]);
  assert.equal(reused.cells[0].sourceCurrentness, 'CURRENT');
  assert.deepEqual(Object.keys(reused.cells[0].fileContentDigests), cell.paths);
  assert.deepEqual(reused.cells[0].changedPaths, []);
});

test('membership additions and missing expected paths fail closed', () => {
  const { root, cell } = fixture();
  observeMediaDiscoveryCurrentness(root, [cell]);
  fs.writeFileSync(path.join(root, 'unexpected.md'), 'new repository member');
  const membership = observeMediaDiscoveryCurrentness(root, [cell]);
  assert.equal(membership.continuity, 'UNKNOWN');
  assert.ok(membership.blockers.includes('UNEXPECTED_REPOSITORY_MEMBERSHIP_CHANGE'));

  const missing = observeMediaDiscoveryCurrentness(root, [{
    ...cell,
    paths: [...cell.paths, '.product-experience/missing.md'],
  }]);
  assert.equal(missing.cells[0].sourceCurrentness, 'UNKNOWN');
  assert.ok(missing.cells[0].blockers.includes('EXPECTED_SOURCE_PATH_MISSING'));
});

test('missing, invalid, or inconsistent fingerprints are rejected before capture', () => {
  const { root, cell } = fixture();
  assert.throws(() => observeMediaDiscoveryCurrentness(root, [{ ...cell, ownerGraphFingerprint: null }]), /valid ownerGraphFingerprint/);
  assert.throws(() => observeMediaDiscoveryCurrentness(root, [{ ...cell, providerRegistryFingerprint: 'sha256:bad' }]), /valid providerRegistryFingerprint/);
  assert.throws(() => observeMediaDiscoveryCurrentness(root, [cell, {
    ...cell,
    cellId: 'other:PDP-0',
    ownerGraphFingerprint: digest('d'),
  }]), /same valid ownerGraphFingerprint/);
});

test('lock ownership failure remains unknown', () => {
  const { root, cell } = fixture();
  const directory = path.join(root, 'build/verification-index/source-currentness');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'capture.lock'), JSON.stringify({ pid: process.pid }));
  const result = observeMediaDiscoveryCurrentness(root, [cell]);
  assert.equal(result.continuity, 'UNKNOWN');
  assert.equal(result.cells[0].sourceCurrentness, 'UNKNOWN');
  assert.ok(result.blockers.includes('LIFECYCLE_CAPTURE_UNKNOWN'));
});

test('persistence failure returned by Lifecycle cannot produce currentness', () => {
  const { root, cell } = fixture();
  let calls = 0;
  const result = observeMediaDiscoveryCurrentness(root, [cell], {
    capture: (captureRoot, options) => {
      calls += 1;
      const actual = captureRepository(captureRoot, options);
      if (calls === 1) return actual;
      return {
        ...actual,
        status: 'UNKNOWN',
        freshness: 'UNKNOWN',
        zeroWorkEligible: false,
        journal: { ...actual.journal, continuity: 'UNKNOWN', resetReason: 'SOURCE_CURRENTNESS_PERSIST_FAILED' },
      };
    },
  });
  assert.equal(result.continuity, 'UNKNOWN');
  assert.equal(result.cells[0].sourceCurrentness, 'UNKNOWN');
  assert.ok(result.blockers.includes('LIFECYCLE_CAPTURE_UNKNOWN'));
});

test('external fingerprint changes since the prior capture fail closed', () => {
  const { root, cell } = fixture();
  observeMediaDiscoveryCurrentness(root, [cell]);
  observeMediaDiscoveryCurrentness(root, [cell]);
  let calls = 0;
  const result = observeMediaDiscoveryCurrentness(root, [cell], {
    capture: (captureRoot, options) => {
      const actual = captureRepository(captureRoot, options);
      calls += 1;
      return calls === 1 ? {
        ...actual,
        zeroWorkEligible: false,
        journal: { ...actual.journal, externalChanges: [{ dimension: 'provider-registry' }] },
      } : actual;
    },
  });
  assert.equal(result.cells[0].sourceCurrentness, 'UNKNOWN');
  assert.ok(result.blockers.includes('EXTERNAL_FINGERPRINT_CHANGE_SINCE_PRIOR_CAPTURE'));
});

test('a material edit between root-wide captures is reported as a source race', () => {
  const { root, cell } = fixture();
  observeMediaDiscoveryCurrentness(root, [cell]);
  let calls = 0;
  const result = observeMediaDiscoveryCurrentness(root, [cell], {
    capture: (captureRoot, options) => {
      const actual = captureRepository(captureRoot, options);
      calls += 1;
      if (calls === 1) fs.writeFileSync(path.join(root, '.product-experience/truth.md'), 'raced truth\n');
      return actual;
    },
  });
  assert.equal(result.continuity, 'UNKNOWN');
  assert.ok(result.blockers.includes('SOURCE_RACE_DURING_CAPTURE'));
});

test('stable changed cell paths stay unknown despite caller-supplied authorization strings', () => {
  const { root, cell } = fixture();
  observeMediaDiscoveryCurrentness(root, [cell]);
  observeMediaDiscoveryCurrentness(root, [cell]);
  fs.writeFileSync(path.join(root, '.product-experience/truth.md'), 'stable edit\n');
  const changed = observeMediaDiscoveryCurrentness(root, [cell], {
    changeAuthorizations: {
      '.product-experience/truth.md': {
        sourcePath: '.product-experience/truth.md',
        classification: 'NON_SEMANTIC_DOCUMENTATION_UPDATE',
        authorityRef: 'owner-decision#MDO-02',
        authorizedBy: 'media-product-owner',
      },
    },
  });
  assert.equal(changed.cells[0].sourceCurrentness, 'UNKNOWN');
  assert.deepEqual(changed.cells[0].changedPaths, ['.product-experience/truth.md']);
  assert.ok(changed.cells[0].blockers.includes('SOURCE_PATH_CHANGED_SINCE_PRIOR_CAPTURE'));
  assert.equal(changed.cells[0].zeroWorkEligible, false);
  assert.equal(changed.zeroWorkEligible, false);

  const stable = observeMediaDiscoveryCurrentness(root, [cell]);
  assert.equal(stable.cells[0].sourceCurrentness, 'CURRENT');
  assert.deepEqual(stable.cells[0].changedPaths, []);
});

test('PDP-0 resolver binds the authoritative 26/6+1/17 inventory without losing applicability details', () => {
  const resolved = resolveMediaPdp0Cells(process.cwd(), dimensions);
  assert.deepEqual(resolved.denominator, {
    physicalCandidates: 26,
    semanticCompositions: 6,
    repositoryRoots: 1,
    consumers: 17,
    totalCells: 50,
  });
  assert.equal(new Set(resolved.cells.map((cell) => cell.cellId)).size, 50);
  assert.equal(resolved.cells.every((cell) => cell.phase === 'PDP-0' && cell.paths.includes(resolved.basis.ownerDecision)), true);

  const byId = new Map(resolved.cells.map((cell) => [cell.surfaceId, cell]));
  const streaming = byId.get('media.physical.modules-video-streaming');
  assert.equal(streaming.cellType, 'PHYSICAL_CANDIDATE');
  assert.equal(streaming.applicability.disposition, 'NO_IMPLEMENTATION_ADMITTED');
  assert.ok(streaming.applicability.capabilityIntentIds.includes('media.stream.session.open'));
  const vision = byId.get('media.composition.vision-and-multimodal-analysis');
  const root = byId.get('media.composition.repository-root');
  assert.ok(vision.paths.includes('modules/video-streaming/build.gradle.kts'));
  assert.ok(vision.meaningRefs.capabilityIntentIds.includes('media.stream.session.open'));
  assert.ok(root.paths.includes('modules/video-streaming/build.gradle.kts'));
  assert.ok(root.paths.includes('.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml'));
  assert.ok(resolved.cells.every((cell) => cell.paths.length > 0 && cell.applicability?.rationale));
  assert.ok(resolved.cells.every((cell) => cell.meaningRefs && cell.mappings));
  assert.equal(byId.get('media.physical.adapters-ledger').applicability.disposition, 'NOT_APPLICABLE_SUPPORT');

  const voiceUi = byId.get('media.physical.modules-intelligence-ai-voice-libs-ai-voice-ui-react');
  assert.deepEqual(voiceUi.applicability.capabilityIntentIds, ['media.speech.synthesis.text-to-speech']);
  const consumer = byId.get('media.surface.ui-library');
  assert.equal(consumer.applicability.disposition, 'APPLICABLE_CONSUMER');
  assert.equal(consumer.mappings.registryAuthority, '.product-experience/surface-registry.yaml');
  const agentTools = byId.get('media.surface.agent-tools');
  assert.equal(agentTools.mappings.bindingState, 'CONTRACT_ONLY');
  assert.equal(agentTools.mappings.handlerSourceObservation.classification, 'LEGACY_SUBSUMED_NOT_ADMITTED');
  assert.equal(agentTools.mappings.handlerSourceObservation.operationAssociation, 'media.physical.runtime-contracts');
  assert.deepEqual(agentTools.mappings.physicalRefs, ['media.physical.runtime-contracts', 'media.physical.libs-common']);
  assert.ok(agentTools.paths.includes('.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml'));
  assert.equal(agentTools.paths.some((sourcePath) => sourcePath === agentTools.mappings.handlerSourceObservation.sourcePath), false);
  assert.equal(agentTools.paths.filter((sourcePath) => sourcePath.startsWith(`${agentTools.mappings.handlerSourceObservation.sourcePath}/`)).length, 6);
  for (const cell of resolved.cells.filter((entry) => entry.cellType === 'CONSUMER')) {
    for (const physicalId of cell.mappings.physicalRefs) {
      assert.ok(byId.get(physicalId).mappings.consumerSurfaceRefs.includes(cell.surfaceId));
    }
  }
});
