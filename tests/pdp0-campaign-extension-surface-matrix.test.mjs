import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(root, '../ghatana-tools/package.json'));
const parseYaml = require('yaml').parse;
const matrixPath = 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json';
const extensionPath = '.product-experience/pdp-0-product-truth/campaign-extensions.yaml';
const decisionPath = '.product-experience/decision-log.md';
const extensionRef = `${extensionPath}#records/@id=AUD-SPEC-020/channelApplicability`;
const decisionRef = `${decisionPath}#PXD-188`;
const read = path => readFileSync(resolve(root, path), 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function expectedBindings(extension) {
  const record = extension.records.find(item => item.id === 'AUD-SPEC-020');
  assert.ok(record, 'AUD-SPEC-020 extension exists');
  const channels = record.channelApplicability.records[0].channelApplicability;
  const applicable = new Map();
  const archived = new Map();
  for (const channel of channels) {
    const target = channel.disposition === 'PROPOSED_APPLICABLE'
      ? applicable
      : channel.disposition === 'NOT_APPLICABLE_ARCHIVED' ? archived : null;
    if (!target) continue;
    const resolution = channel.surfaceResolution;
    for (const field of ['physicalSurfaceRefs', 'compositeSurfaceRefs', 'logicalConsumerSurfaceRefs']) {
      for (const surfaceId of resolution[field] ?? []) {
        if (!target.has(surfaceId)) target.set(surfaceId, []);
        target.get(surfaceId).push(channel.channelRef);
      }
    }
  }
  return { record, applicable, archived };
}

test('PDP-0 surface matrix binds the exact proposal-only AUD-SPEC-020 surface resolution', () => {
  const matrix = JSON.parse(read(matrixPath));
  const extension = parseYaml(read(extensionPath));
  const { record, applicable, archived } = expectedBindings(extension);
  const rows = new Map(matrix.surfaces.map(row => [row.surfaceId, row]));

  assert.equal(matrix.surfaces.length, 54);
  assert.deepEqual(matrix.denominatorValidation.stats, {
    physicalManifestCandidates: 26,
    compositions: 7,
    logicalConsumers: 21,
    registrySurfaces: 21,
    archivedConsumers: 1,
    activeLogicalConsumers: 20,
    activeLogicalScopesResolved: 20,
    applicablePhysicalPdp0: 15,
    notApplicableSupportPhysicalPdp0: 8,
    noImplementationAdmittedPhysicalPdp0: 3,
    denominator: 54,
  });
  assert.equal(applicable.size, 37);
  assert.equal(archived.size, 1);
  assert.equal(rows.size, 54);
  assert.ok([...applicable.keys(), ...archived.keys()].every(id => rows.has(id)));

  for (const [surfaceId, channelRefs] of applicable) {
    const row = rows.get(surfaceId);
    const evidence = row.campaignExtensionApplicability;
    assert.equal(evidence?.length, 1, `${surfaceId} has one feature-scope record`);
    assert.deepEqual(evidence[0], {
      featureId: 'AUD-SPEC-020',
      capabilityRef: record.capabilityDefinition.id,
      decisionRef,
      sourceRef: extensionRef,
      applicabilityState: 'PROPOSED; owner disposition pending',
      disposition: 'PROPOSED_APPLICABLE',
      channelRefs: [...new Set(channelRefs)].sort(),
    });
    assert.ok(row.sourceRefs.includes(extensionRef));
    assert.ok(row.sourceRefs.includes(decisionRef));
    assert.equal(row.sourceFingerprints[extensionPath], sha256(read(extensionPath)));
    assert.equal(row.sourceFingerprints[decisionPath], sha256(read(decisionPath)));
  }

  for (const [surfaceId, channelRefs] of archived) {
    const row = rows.get(surfaceId);
    assert.deepEqual(row.campaignExtensionApplicability, [{
      featureId: 'AUD-SPEC-020',
      capabilityRef: record.capabilityDefinition.id,
      decisionRef,
      sourceRef: extensionRef,
      applicabilityState: 'PROPOSED; owner disposition pending',
      disposition: 'NOT_APPLICABLE_ARCHIVED',
      channelRefs: [...new Set(channelRefs)].sort(),
    }]);
    assert.equal(row.applicability.disposition, 'ARCHIVED');
    assert.ok(row.sourceRefs.includes(extensionRef));
    assert.ok(row.sourceRefs.includes(decisionRef));
    assert.equal(row.sourceFingerprints[extensionPath], sha256(read(extensionPath)));
    assert.equal(row.sourceFingerprints[decisionPath], sha256(read(decisionPath)));
  }

  const featureRows = new Set([...applicable.keys(), ...archived.keys()]);
  for (const row of matrix.surfaces) {
    if (!featureRows.has(row.surfaceId)) assert.equal(row.campaignExtensionApplicability, undefined);
  }
  assert.equal(matrix.claimsBoundary.ownerApproval, 'NOT_CLAIMED');
  assert.equal(matrix.claimsBoundary.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(matrix.claimsBoundary.nativeClosure, 'NOT_PERFORMED');
  assert.equal(matrix.claimsBoundary.implementationQualification, 'NOT_EVALUATED');
  assert.equal(matrix.claimsBoundary.delivery, 'NOT_ENTERED');
  assert.equal(record.coordinatorScopeDecision.ownerApproval, 'NOT_CLAIMED');
  assert.equal(record.coordinatorScopeDecision.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(record.coordinatorScopeDecision.executionAdmission, 'NOT_ADMITTED');
  assert.equal(record.coordinatorScopeDecision.runtimeAvailability, 'UNKNOWN');
});

test('PDP-0 surface matrix pins current campaign-extension evidence and its fingerprint set', () => {
  const matrix = JSON.parse(read(matrixPath));
  const extensionSha = sha256(read(extensionPath));
  const decisionSha = sha256(read(decisionPath));
  assert.equal(matrix.sourceFingerprints[extensionPath], extensionSha);
  assert.equal(matrix.sourceFingerprints[decisionPath], decisionSha);
  const serialized = JSON.stringify(Object.entries(matrix.sourceFingerprints).sort(([a], [b]) => a.localeCompare(b)));
  assert.equal(matrix.sourceFingerprintSetSha256, sha256(serialized));
});
