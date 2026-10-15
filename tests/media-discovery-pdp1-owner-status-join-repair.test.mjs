import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  pdp1OwnerStatusJoinObservation,
  loadPdp1OwnerWireImpactInput,
  validatePdp1OperationParityProjectionImpact,
  validatePdp1ThreeSourceTransitionDisposition,
} from '../scripts/record-media-discovery-pdp1-phase-exit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const sha256 = (relativePath) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex')}`;
const r16Path = 'docs/implementation/observations/media-discovery-pdp1-exit-current-cut-r16.json';
const r21Path = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r21.json';
const transitionPath = 'docs/implementation/observations/media-pdp1-three-source-transition-no-meaning-disposition-2026-10-14.json';
const operationParityPath = '.product-experience/interface-parity/operation-parity.yaml';
const statusTestPath = 'tests/media-pdp-p1-dev-status.test.mjs';
const additionalImpactPath = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r2.json';

function currentR21Inputs() {
  const r21 = readJson(r21Path);
  const observedDigests = { ...r21.sourceCurrentness.sourceContentDigests };
  const parityImpact = r21.ownerStatusJoin.operationParityProjectionImpact;
  const currentCutOutcome = r21.ownerStatusJoin.currentCutSourceImpactReview.validationDetails.outcome;
  const testRun = {
    ...r21.testRun,
    outcomes: [
      ...r21.testRun.outcomes,
      currentCutOutcome,
      parityImpact.testOutcome,
      parityImpact.impactTestOutcome,
    ],
  };
  return { r21, observedDigests, testRun };
}

function assertJoinInputIsOutsideTheCurrentSourceCut(r21) {
  assert.equal(Object.keys(r21.sourceCurrentness.sourceContentDigests).length, 329);
  assert.equal(Object.hasOwn(r21.sourceCurrentness.sourceContentDigests,
    'tests/media-discovery-pdp1-owner-status-join-repair.test.mjs'), false);
}

let currentJoin;
let currentInputs;
function joinedR21CurrentCut() {
  if (currentJoin) return currentJoin;
  currentInputs = currentR21Inputs();
  const additionalSourceImpactInput = {
    path: additionalImpactPath,
    record: readJson(additionalImpactPath),
  };
  currentJoin = pdp1OwnerStatusJoinObservation(
    currentInputs.observedDigests,
    currentInputs.r21.sourceCurrentness.materialSourceSetFingerprint,
    currentInputs.testRun,
    additionalSourceImpactInput,
    loadPdp1OwnerWireImpactInput(),
  );
  return currentJoin;
}

test('owner-status join approves the operation-parity transition only with its exact valid impact', () => {
  const { r21, observedDigests, testRun } = currentR21Inputs();
  assertJoinInputIsOutsideTheCurrentSourceCut(r21);

  const validImpact = validatePdp1OperationParityProjectionImpact(undefined, { observedDigests, testRun });
  assert.equal(validImpact.valid, true, JSON.stringify(validImpact.rowChecks));

  const join = joinedR21CurrentCut();
  assert.equal(join.valid, true, JSON.stringify({ operation: join.operationParityProjectionImpact, unapproved: join.unapprovedChangedPaths }));
  assert.equal(join.operationParityProjectionImpact.valid, true);
  const parityChange = join.changedPathsComparedToR16.find((entry) => entry.path === operationParityPath);
  assert.ok(parityChange, 'the exact operation-parity transition should be part of the join comparison');
  assert.equal(parityChange.approvedForExactTransition, true);

  const staleDigests = { ...observedDigests, [operationParityPath]: 'sha256:8b95782fe47cb7e44ec159c168399f78a674dbc1c6f72065881c278f7e3c13d6' };
  assert.equal(validatePdp1OperationParityProjectionImpact(undefined, { observedDigests: staleDigests }).valid, false);
  assert.equal(validatePdp1OperationParityProjectionImpact(null, { observedDigests }).valid, false,
    'a missing impact record must fail closed');

  const r16 = readJson(r16Path);
  const unchangedPath = Object.keys(r16.sourceCurrentness.sourceContentDigests).find((sourcePath) =>
    ![operationParityPath, statusTestPath].includes(sourcePath)
      && r16.sourceCurrentness.sourceContentDigests[sourcePath] === sha256(sourcePath));
  assert.ok(unchangedPath, 'fixture needs a live path demonstrably unchanged at R16');
  const unrelatedDigests = {
    ...observedDigests,
    [operationParityPath]: 'sha256:8b95782fe47cb7e44ec159c168399f78a674dbc1c6f72065881c278f7e3c13d6',
    [unchangedPath]: `sha256:${'f'.repeat(64)}`,
  };
  const rejectedJoin = pdp1OwnerStatusJoinObservation(
    unrelatedDigests,
    r21.sourceCurrentness.materialSourceSetFingerprint,
    currentInputs.testRun,
    { path: additionalImpactPath, record: readJson(additionalImpactPath) },
    loadPdp1OwnerWireImpactInput(),
  );
  assert.equal(rejectedJoin.valid, false);
  assert.equal(rejectedJoin.operationParityProjectionImpact.valid, false);
  const staleParityChange = rejectedJoin.changedPathsComparedToR16.find((entry) => entry.path === operationParityPath);
  assert.ok(!staleParityChange || staleParityChange.approvedForExactTransition === false);
  const unrelatedChange = rejectedJoin.changedPathsComparedToR16.find((entry) => entry.path === unchangedPath);
  assert.ok(unrelatedChange);
  assert.equal(unrelatedChange.approvedForExactTransition, false);
  assert.ok(rejectedJoin.unapprovedChangedPaths.includes(unchangedPath));
});

test('owner-status join projects the R6 status-test predecessor into the three-source row and exact hashes', () => {
  const { r21, observedDigests } = currentR21Inputs();
  assertJoinInputIsOutsideTheCurrentSourceCut(r21);
  const join = joinedR21CurrentCut();
  const statusRow = join.threeSourceTransitionDisposition.rows.find((row) => row.path === statusTestPath);
  const r6 = readJson('docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r6.json');

  assert.equal(r6.sourceDelta.predecessorSha256, 'sha256:3ff1576a4a3987f5b1e05d15ae77e35a62745260e127ebcb28c1bb49ef7ef82e');
  assert.equal(r6.sourceDelta.observedSha256, 'sha256:5201e4b1915f35594641f8683ee3c499bb563259ed5f3387f027ce787bf0899d');
  assert.equal(statusRow.predecessorSha256, r6.sourceDelta.observedSha256,
    'the R6 observed hash must become the predecessor of the R16-to-current row');
  assert.equal(statusRow.observedSha256, sha256(statusTestPath));
  assert.equal(join.currentCutSourceImpactReview.validationDetails.exactHashes, true);

  const transition = readJson(transitionPath);
  const transitionInputs = {
    observedDigests,
    statusPins: readJson('docs/implementation/pdp-1-phase-dev-status.json').sourceShaSet,
    semanticPins: readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json').sourceFingerprints,
    recordPath: transitionPath,
  };
  for (const mutate of [
    (record) => { delete record.sourceTransitions.find((row) => row.path === statusTestPath).predecessorSha256; },
    (record) => { record.sourceTransitions.find((row) => row.path === statusTestPath).predecessorSha256 = r6.sourceDelta.predecessorSha256; },
  ]) {
    const invalidRecord = structuredClone(transition);
    mutate(invalidRecord);
    assert.equal(validatePdp1ThreeSourceTransitionDisposition(invalidRecord, transitionInputs).valid, false);
  }
});
