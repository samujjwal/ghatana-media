import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
import {buildCohort02R5} from '../scripts/build-media-pdp0-cohort02-r5-amendment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const CAP = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (ref) => JSON.parse(fs.readFileSync(path.join(ROOT, ref), 'utf8'));

test('R5 is additive to the failed R4 history and repairs all 120 cases from current owner-defined capability records', () => {
  const r4BytesBefore = fs.readFileSync(path.join(ROOT, `${DIR}/cohort-02.r4.json`));
  const r4CandidateBytesBefore = fs.readFileSync(path.join(ROOT, `${DIR}/cohort-02.source-amendment-candidate.r4.json`));
  const r4PeerBytesBefore = fs.readFileSync(path.join(ROOT, `${DIR}/cohort-02.r4.independent-peer.v1.json`));
  const currentCapabilityBytes = fs.readFileSync(path.join(ROOT, CAP));
  const liveCapabilities = YAML.parse(currentCapabilityBytes.toString('utf8')).capabilities;
  const byId = new Map(liveCapabilities.map((capability) => [capability.id, capability]));
  const r4 = readJson(`${DIR}/cohort-02.r4.json`);
  const r4Candidate = readJson(`${DIR}/cohort-02.source-amendment-candidate.r4.json`);
  const r4Peer = readJson(`${DIR}/cohort-02.r4.independent-peer.v1.json`);

  assert.equal(r4Peer.decisionCounts.REQUEST_CHANGES, 64);
  assert.equal(r4Peer.decisionCounts.SUPPORTED, 13);
  assert.equal(r4Peer.rows.reduce((sum, row) => sum + (row.caseRenderingDefectCount ?? 0), 0), 120);
  const result = buildCohort02R5();
  const {artifact, sourceAmendment, candidate} = result;
  assert.deepEqual(readJson(`${DIR}/cohort-02.r5.json`), artifact);
  assert.deepEqual(readJson(`${DIR}/cohort-02.source-amendment-postimages.r5.json`), sourceAmendment);
  assert.deepEqual(readJson(`${DIR}/cohort-02.source-amendment-candidate.r5.json`), candidate);
  assert.ok(result.capabilityPostimage.equals(fs.readFileSync(path.join(ROOT, `${DIR}/cohort-02.source-amendment-capabilities.postimage.r5.yaml`))));
  assert.ok(result.requirementsPostimage.equals(fs.readFileSync(path.join(ROOT, `${DIR}/cohort-02.source-amendment-requirements.postimage.r5.yaml`))));
  assert.equal(artifact.predecessorSha256, sha(r4BytesBefore));
  assert.equal(candidate.predecessorCandidateSha256, sha(r4CandidateBytesBefore));
  assert.equal(artifact.r4PeerReviewSha256, sha(r4PeerBytesBefore));
  assert.equal(artifact.r4PeerDisposition, 'INDEPENDENT_REVIEW_COMPLETE; 13 SUPPORTED; 64 REQUEST_CHANGES; CANONICAL OWNER DISPOSITION UNKNOWN');
  assert.equal(artifact.supersededCandidateDisposition, 'R4_RETAINED_AS_FAILED_REVIEW_HISTORY; NEVER_APPLIED; R5 IS A NEW CANDIDATE');
  assert.deepEqual(result.candidate.counts, {
    cohortRows: 77,
    peerSupportedPreserved: 13,
    peerRequestChangesAddressed: 64,
    featureRowsRepaired: 44,
    distinctRebindRows: 9,
    rebindTargetOperations: 16,
    featureCasePairs: 60,
    capabilityCaseRecordAdditions: 120,
    newMeaningChoices: 9,
    overlapChoices: 2,
    historicalLeafAdjudicationsPreserved: 462,
  });
  assert.equal(candidate.rootOwnerDecisionRequirement.selectedOptions, 0);
  assert.equal(candidate.distinctPeerReviewRequirement.verdictRequiredPerChangedAuditRow, 'PASS');
  assert.equal(candidate.canonicalApply, 'NOT_PERFORMED');
  assert.equal(sourceAmendment.canonicalApply, 'NOT_PERFORMED');
  assert.equal(sourceAmendment.predecessorFailedR4.retainedUnmodified, true);

  const featureRows = artifact.exactFeatureCasePostimages;
  assert.equal(featureRows.filter((row) => row.mappingKind === 'FEATURE_CASE_REPAIR_EXACT_EXISTING_MAPPING').length, 44);
  const rebindRows = featureRows.filter((row) => row.mappingKind === 'R2_REBIND_TARGET_FEATURE_CASE');
  assert.equal(new Set(rebindRows.map((row) => row.auditId)).size, 9);
  assert.equal(rebindRows.length, 16);
  assert.equal(featureRows.length, 60);
  assert.equal(featureRows.reduce((sum, row) => sum + row.cases.length, 0), 120);

  for (const row of featureRows) {
    const live = byId.get(row.capabilityId);
    assert.ok(live, `${row.auditId}: mapped capability exists in current capabilities.yaml`);
    assert.equal(row.operation, live.operation, `${row.auditId}/${row.capabilityId}: operation comes from the live capability record`);
    assert.ok(typeof row.operation === 'string' && row.operation.length > 0 && row.operation !== 'undefined');
    assert.deepEqual(row.currentTypedInputSlots, live.ownerDefinition.typedInputSlots);
    assert.deepEqual(row.currentSuccessOutputs, live.ownerDefinition.successOutputs);
    assert.ok(row.currentTypedInputSlots.length > 0, `${row.auditId}/${row.capabilityId}: exact typed input slots are nonempty`);
    assert.ok(row.currentSuccessOutputs.length > 0, `${row.auditId}/${row.capabilityId}: exact success output shape is nonempty`);
    assert.deepEqual(row.currentNonSuccessOutputs, live.ownerDefinition.nonSuccessOutputs);
    assert.deepEqual(row.currentErrors, live.ownerDefinition.errors);
    assert.deepEqual(row.currentAuthority, live.requiredAuthority);
    assert.deepEqual(row.currentExplicitUnsupportedCases, live.explicitUnsupportedCases);
    assert.equal(row.typedInputSelector, `${CAP}#capabilities/@id=${row.capabilityId}/ownerDefinition/typedInputSlots`);
    assert.equal(row.outputSelector, `${CAP}#capabilities/@id=${row.capabilityId}/ownerDefinition/successOutputs`);
    assert.equal(row.caseSemanticBasis, 'CURRENT_CAPABILITY_OWNER_DEFINITION_AND_SOURCE_FEATURE_CRITERION');
    assert.ok(row.peerRationale.sourceGap.length > 0, 'peer/source gap is preserved separately from acceptance text');
    assert.ok(row.cases[0].given.includes(JSON.stringify(live.ownerDefinition.typedInputSlots)));
    assert.ok(row.cases[0].when.includes(`${live.id}.${live.operation}`));
    assert.ok(row.cases[0].then.includes(JSON.stringify(live.ownerDefinition.successOutputs)));
    assert.ok(row.cases[0].then.includes(row.sourceAcceptanceCriterion));
    assert.ok(row.cases[1].given.includes(JSON.stringify(live.ownerDefinition.typedInputSlots)));
    assert.ok(row.cases[1].given.includes(JSON.stringify(live.explicitUnsupportedCases)));
    assert.ok(row.cases[1].when.includes(`${live.id}.${live.operation}`));
    assert.ok(row.cases[1].then.includes(JSON.stringify(live.ownerDefinition.nonSuccessOutputs)));
    assert.ok(row.cases[1].then.includes(JSON.stringify(live.ownerDefinition.errors)));
    for (const acceptanceCase of row.cases) {
      for (const field of ['given', 'when', 'then']) {
        assert.ok(acceptanceCase[field].length > 0);
        assert.doesNotMatch(acceptanceCase[field], /\bundefined\b/u);
        assert.doesNotMatch(acceptanceCase[field], /\btyped inputs \[\]\b/u);
        assert.doesNotMatch(acceptanceCase[field], /\boutput \[\]\b/u);
      }
    }
  }

  assert.equal(sha(fs.readFileSync(path.join(ROOT, CAP))), sha(currentCapabilityBytes), 'R5 build must not write capabilities.yaml');
  assert.equal(sha(fs.readFileSync(path.join(ROOT, `${DIR}/cohort-02.r4.json`))), sha(r4BytesBefore));
  assert.equal(sha(fs.readFileSync(path.join(ROOT, `${DIR}/cohort-02.source-amendment-candidate.r4.json`))), sha(r4CandidateBytesBefore));
  assert.equal(sha(fs.readFileSync(path.join(ROOT, `${DIR}/cohort-02.r4.independent-peer.v1.json`))), sha(r4PeerBytesBefore));
  assert.equal(r4.artifactId, 'media-pdp0-parent-case-resolution-cohort-02-r4');
});
