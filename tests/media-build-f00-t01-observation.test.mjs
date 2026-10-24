import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildF00T01Observation, checkF00T01Observation, inspectMaterialSourceReceipt } from '../scripts/lib/media-build-f00-t01-observation.mjs';

const root = process.cwd();
const fixedTime = new Date('2026-10-23T06:15:00.000Z');
const livePhaseStatuses = [0, 1, 2, 3].map(index => JSON.parse(fs.readFileSync(path.join(root, `docs/implementation/pdp-${index}-phase-dev-status.json`), 'utf8')));
const liveMaterialPinCount = livePhaseStatuses.reduce((sum, status) => sum + Object.keys(status.sourceShaSet ?? {}).length, 0);
const topology = JSON.parse(fs.readFileSync(path.join(root, '.product-experience/surfaces/media-physical-topology.v1.json'), 'utf8'));
const subjectIds = [
  ...topology.manifestCandidates.map(row => row.surfaceId),
  ...topology.compositions.map(row => row.surfaceId),
  ...topology.consumerCrosswalk.map(row => row.surfaceId)
];
const matrixRows = new Map(['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].map((phase, index) => {
  const matrixPath = `docs/implementation/verification/pdp-38/pdp${index}-surface-phase-status-matrix.json`;
  const matrix = JSON.parse(fs.readFileSync(path.join(root, matrixPath), 'utf8'));
  return [phase, new Map(matrix.surfaces.map(row => [row.surfaceId, row]))];
}));
const readG0 = () => ({
  schemaVersion: 'ghatana.lifecycle.media-structured-method-status.v1',
  recordKind: 'GTOOL_METHOD_SOURCE_DEVELOPMENT_PROJECTION_NOT_CLOSURE',
  status: 'SOURCE_DEFINITION_DEV_COMPLETE_CURRENT',
  selectedMethodId: 'ghatana.media-product-development',
  sourceSnapshotFingerprint: `sha256:${'a'.repeat(64)}`,
  sourceSubjectCount: 54,
  sourcePhaseCellCount: 216,
  phaseCounts: Object.fromEntries(['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].map(phase => [phase, {
    rows: 54,
    completeCurrent: 54,
    incomplete: 0,
    unknown: 0,
    nonemptyDefinitionTasks: 0
  }])),
  rows: subjectIds.flatMap(subjectId => ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].map(phase => {
    const matrixRow = matrixRows.get(phase).get(subjectId);
    const matrixApplicability = matrixRow.applicability;
    const applicabilityStatus = ['NOT_APPLICABLE', 'NOT_ACTIVE_ARCHIVED'].includes(matrixRow.developmentStatus) ? 'NOT_APPLICABLE' : 'APPLICABLE';
    const authorityRefs = [...(Array.isArray(matrixApplicability.authorityRefs) ? matrixApplicability.authorityRefs : []), matrixApplicability.authorityRef]
      .filter(ref => typeof ref === 'string' && ref.trim().length > 0);
    return {
      subjectId,
      phase,
      completion: 'COMPLETE',
      currentness: 'CURRENT',
      knownDefinitionTaskCount: 0,
      sourceDevelopmentReady: true,
      applicability: {
        status: applicabilityStatus,
        authorityRef: `docs/implementation/verification/pdp-38/pdp${['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].indexOf(phase)}-surface-phase-status-matrix.json#/surfaces/@surfaceId=${subjectId}`,
        rationale: matrixApplicability.rationale,
        value: {
          status: applicabilityStatus,
          disposition: matrixApplicability.disposition,
          rationale: matrixApplicability.rationale,
          authorityRefs
        }
      }
    };
  })),
  sourcePhaseProgression: {
    schemaVersion: 'ghatana.gtool-source-development-progression.v1',
    recordKind: 'READ_ONLY_OWNER_SOURCE_PHASE_PROJECTION_NOT_STAGE_OR_CLOSURE',
    status: 'ALL_SOURCE_PHASES_COMPLETE',
    phaseOrder: ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'],
    subjectCount: 54,
    sourceCompleteSubjectCount: 54,
    phaseSummary: ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].map(phaseId => ({
      phaseId,
      enteredEligible: 54,
      sourceComplete: 54,
      blockedOnPredecessor: 0,
      activeSourceDevelopment: 0
    })),
    subjects: subjectIds.map(subjectId => ({
      subjectId,
      phaseStates: ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].map(phaseId => ({
        phaseId,
        sourceDevelopmentReady: true,
        phaseDisposition: 'SOURCE_DEV_COMPLETE'
      }))
    })),
    readOnly: true,
    writesPerformed: false,
    stageTransitionPerformed: false
  },
  sourceProgressionAuthority: 'READ_ONLY_OBSERVATION_NOT_STAGE_TRANSITION_OR_CLOSURE',
  errors: [],
  buildImplementationStatus: 'NOT_EVALUATED',
  independentAcceptanceStatus: 'NOT_EVALUATED',
  nativeClosureStatus: 'NOT_EVALUATED',
  deliveryStatus: 'NOT_EVALUATED',
  writesPerformed: false,
  testFixture: 'SYNTHETIC_UNIT_TEST_INPUT_NOT_PRODUCT_EVIDENCE'
});
const withG0 = (status, callback) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'media-f00-t01-'));
  const temporaryG0Path = path.join(directory, 'g0-status.json');
  fs.writeFileSync(temporaryG0Path, JSON.stringify(status));
  try {
    callback(temporaryG0Path, directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
const assertRejectsG0 = (mutate, expectedMessage) => {
  const status = readG0();
  mutate(status);
  withG0(status, temporaryG0Path => {
    assert.throws(() => buildF00T01Observation({ root, g0StatusPath: temporaryG0Path, now: fixedTime }), expectedMessage);
  });
};

test('derives the receipt denominator from live phase sourceShaSet records and reports exact stale selectors', () => {
  const workPackages = JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/MEDIA-BUILD-WORK-PACKAGES.v1.json'), 'utf8'));
  const readback = inspectMaterialSourceReceipt({ root, phaseStatuses: livePhaseStatuses, receipt: workPackages.materialSourceReceipt });
  assert.equal(readback.expectedCount, liveMaterialPinCount);
  assert.equal(readback.receiptCount, workPackages.materialSourceReceipt.count);
  assert.ok(Array.isArray(readback.staleSelectors));
  assert.ok(readback.staleSelectors.length > 0, 'current worktree should expose its source receipt drift instead of treating the receipt as current');
  assert.ok(readback.staleSelectors.every(row => row.phase && row.selector && row.expectedSha256));
});

test('generates an F00.T01 read-only receipt with complete 54 × 4 accounting and source digests', () => {
  const status = readG0();
  withG0(status, temporaryG0Path => {
    const artifact = buildF00T01Observation({ root, g0StatusPath: temporaryG0Path, now: fixedTime });
    assert.equal(artifact.recordedAt, '2026-10-23T06:15:00Z');
    assert.deepEqual(artifact.campaign.campaignDenominator, {
      surfaceIdentities: 54,
      physicalLeaves: 26,
      compositionsIncludingRoot: 7,
      logicalConsumers: 21,
      phaseSurfaceCells: 216
    });
    assert.equal(artifact.reconciliation.phaseMatrices.length, 4);
    assert.ok(artifact.reconciliation.phaseMatrices.every(row => row.rows === 54 && row.uniqueSurfaceIds === 54 && row.sourceCurrentness === 'CURRENT' && row.remainingPhaseLocalTaskCount === 0));
    assert.equal(artifact.reconciliation.gtoolRowIdentityComparison.g0StatusPhaseCells, 216);
    assert.equal(artifact.reconciliation.materialSourcePins.count, liveMaterialPinCount);
    assert.equal(artifact.reconciliation.materialSourcePins.staleOrUnsupportedCount, 0);
    assert.equal(artifact.sourceBaseline.g0Status.sourceSnapshotFingerprint, `sha256:${'a'.repeat(64)}`);
    assert.equal(artifact.sourceBaseline.g0Status.path, temporaryG0Path);
    assert.equal(artifact.taskAndGateBoundaries.gtoolMethodAggregate.status, 'NOT_ASSERTED_BY_SUPPLIED_G0_STATUS_INPUT');
    assert.equal(artifact.canonicalTaskCriterion.taskStatus, 'PLANNING_RECEIPT_ONLY');
    assert.equal(artifact.claimsBoundary.plannerAdmission, 'NOT_ESTABLISHED');
    assert.equal(artifact.claimsBoundary.taskCompletion, 'NOT_ESTABLISHED');
    assert.equal(artifact.claimsBoundary.nativePdpClosure, 'NOT_EVALUATED');
    assert.equal(artifact.claimsBoundary.buildImplementation, 'NOT_EVALUATED');
    assert.equal(artifact.claimsBoundary.delivery, 'NOT_EVALUATED');
  });
});

test('rejects missing G0 phase rows', () => assertRejectsG0(status => { status.rows.pop(); }, /exactly 216 phase rows/u));

test('rejects duplicate G0 subject/phase rows', () => assertRejectsG0(status => { status.rows[1] = structuredClone(status.rows[0]); }, /duplicate subject\/phase rows/u));

test('rejects unknown G0 subject rows', () => assertRejectsG0(status => { status.rows[0].subjectId = 'media.surface.unknown'; }, /G0 subject\/phase cell set/u));

test('rejects missing N/A authority, missing applicability rationale, and matrix applicability mismatch', async t => {
  const notApplicable = () => readG0().rows.find(row => row.applicability.status === 'NOT_APPLICABLE');
  await t.test('missing N/A source authority', () => assertRejectsG0(status => {
    const row = status.rows.find(candidate => candidate.applicability.status === 'NOT_APPLICABLE');
    row.applicability.value.authorityRefs = [];
  }, /no owner source authority reference/u));
  await t.test('missing N/A rationale', () => assertRejectsG0(status => {
    const row = status.rows.find(candidate => candidate.applicability.status === 'NOT_APPLICABLE');
    row.applicability.value.rationale = '';
  }, /no applicability value rationale/u));
  await t.test('disposition differs from the matching Media matrix', () => assertRejectsG0(status => {
    const row = status.rows.find(candidate => candidate.applicability.status === 'APPLICABLE');
    row.applicability.value.disposition = 'UNDECLARED_APPLICABILITY';
  }, /disposition disagrees with Media matrix/u));
  assert.ok(notApplicable(), 'synthetic fixture includes explicit NOT_APPLICABLE rows');
});

test('rejects stale G0 currentness and changed source readiness/task flags', async t => {
  await t.test('stale currentness', () => assertRejectsG0(status => { status.rows[0].currentness = 'STALE'; }, /not COMPLETE and CURRENT/u));
  await t.test('nonzero known task count', () => assertRejectsG0(status => { status.rows[0].knownDefinitionTaskCount = 1; }, /has tasks/u));
  await t.test('source development not ready', () => assertRejectsG0(status => { status.rows[0].sourceDevelopmentReady = false; }, /has tasks or is not source-development ready/u));
  await t.test('unexpected stage transition flag', () => assertRejectsG0(status => { status.sourcePhaseProgression.stageTransitionPerformed = true; }, /read-only and perform no stage transition/u));
});

test('rejects denominator drift, malformed fingerprint, and phase summary disagreement', async t => {
  await t.test('subject denominator drift', () => assertRejectsG0(status => { status.sourceSubjectCount = 53; }, /denominator must be exactly/u));
  await t.test('malformed source snapshot fingerprint', () => assertRejectsG0(status => { status.sourceSnapshotFingerprint = 'sha256:abc'; }, /fingerprint is missing or malformed/u));
  await t.test('phase summary disagreement', () => assertRejectsG0(status => { status.sourcePhaseProgression.phaseSummary[2].sourceComplete = 53; }, /phase summary disagrees/u));
});

test('checks a generated artifact against current G0 and Media source digests', () => {
  withG0(readG0(), (temporaryG0Path, directory) => {
    const artifact = buildF00T01Observation({ root, g0StatusPath: temporaryG0Path, now: fixedTime });
    const artifactPath = path.join(directory, 'observation.json');
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    assert.equal(checkF00T01Observation({ root, g0StatusPath: temporaryG0Path, artifactPath }).recordedAt, artifact.recordedAt);
    const stale = { ...artifact, reconciliation: { ...artifact.reconciliation, topology: { ...artifact.reconciliation.topology, sha256: '0'.repeat(64) } } };
    fs.writeFileSync(artifactPath, JSON.stringify(stale));
    assert.throws(() => checkF00T01Observation({ root, g0StatusPath: temporaryG0Path, artifactPath }), /does not match current G0\/source inputs/u);
  });
});
