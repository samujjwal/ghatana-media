import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { buildCohort02R4 } from '../scripts/build-media-pdp0-cohort02-r4-amendment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(root, dir, name), 'utf8'));

test('R4 is bound to D peer R3, retains the exact 77/231/54/207 denominators, and corrects reuse to 13', () => {
  const candidate = readJson('cohort-02.source-amendment-candidate.r4.json');
  const r4 = readJson('cohort-02.r4.json');
  const peer = JSON.parse(fs.readFileSync(path.join(root, dir, 'cohort-02.r3.independent-peer.v1.json'), 'utf8'));
  const assignment = JSON.parse(fs.readFileSync(path.join(root, '../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-pdp0-resolution-cohort-assignments.json'), 'utf8')).cohorts[1].expectedAuditIds;
  assert.deepEqual(r4.scope.exactOrderedAssignedAuditIds, assignment);
  assert.equal(candidate.counts.cohortRows, 77);
  assert.equal(candidate.counts.peerSupportedPreserved, 13);
  assert.equal(candidate.counts.peerRequestChangesAddressed, 64);
  assert.equal(candidate.counts.featureCasePairs, 60);
  assert.equal(candidate.counts.capabilityCaseRecordAdditions, 120);
  assert.equal(candidate.counts.newMeaningChoices, 9);
  assert.equal(candidate.counts.overlapChoices, 2);
  assert.deepEqual(peer.decisionCounts, {REQUEST_CHANGES: 64, SUPPORTED: 13});
  assert.equal(r4.scope.fullCampaignAuditIdDenominator, 231);
  assert.equal(r4.scope.registeredIdentityDenominator, 54);
  assert.equal(r4.scope.sourcePathDenominator, 207);
  assert.equal(candidate.sourceBindings.r3PeerSha256, createHash('sha256').update(fs.readFileSync(path.join(root, dir, 'cohort-02.r3.independent-peer.v1.json'))).digest('hex'));
});

test('R4 candidate rebuild produces the exact byte postimages and preserves the 462 historical leaf rows separately', () => {
  const rebuilt = buildCohort02R4();
  const candidate = readJson('cohort-02.source-amendment-candidate.r4.json');
  const sourceAmendment = readJson('cohort-02.source-amendment-postimages.r4.json');
  const artifact = readJson('cohort-02.r4.json');
  assert.deepEqual(rebuilt.candidate, candidate);
  assert.deepEqual(rebuilt.sourceAmendment, sourceAmendment);
  assert.deepEqual(rebuilt.artifact, artifact);
  assert.equal(rebuilt.capabilityPostimage.equals(fs.readFileSync(path.join(root, candidate.exactTargetPostimages[0].postimageRef))), true);
  assert.equal(rebuilt.requirementsPostimage.equals(fs.readFileSync(path.join(root, candidate.exactTargetPostimages[1].postimageRef))), true);
  assert.equal(sourceAmendment.historicalLeafAdjudications.historicalAdjudicationCount, 462);
  assert.equal(sourceAmendment.historicalLeafAdjudications.mutation, 'NONE; kept as a separate historical population.');
  assert.equal(candidate.canonicalApply, 'NOT_PERFORMED');
});

test('all proposed feature cases project exact live slots, success outputs, authority, and source-specific negatives', () => {
  const r4 = readJson('cohort-02.r4.json');
  assert.equal(r4.exactFeatureCasePostimages.length, 60);
  for (const row of r4.exactFeatureCasePostimages) {
    assert.ok(row.sourceFeatureRef.includes(`/@audit_id=${row.auditId}`));
    assert.ok(row.typedInputSelector.endsWith('/ownerDefinition/typedInputSlots'));
    assert.ok(row.outputSelector.endsWith('/ownerDefinition/successOutputs'));
    assert.equal(row.postimageCaseRefs.length, 2);
    assert.equal(row.cases.length, 2);
    assert.ok(row.cases[0].given.includes(row.auditId));
    assert.ok(row.cases[0].given.includes('current typed inputs'));
    assert.ok(row.cases[0].then.includes('owner outcome'));
    assert.ok(row.cases[0].then.includes(row.sourceAcceptanceCriterion));
    assert.ok(row.cases[1].given.includes(row.sourceGap));
    assert.ok(row.cases[1].then.includes('non-success/UNKNOWN'));
    assert.ok(row.parentRequirementRefs.length > 0);
  }
});

test('nine missing-meaning proposals and two overlap proposals expose root options without selecting one', () => {
  const r4 = readJson('cohort-02.r4.json');
  assert.equal(r4.missingMeaningRootDecisionOptions.length, 9);
  assert.equal(r4.overlapRootDecisionOptions.length, 2);
  for (const row of r4.missingMeaningRootDecisionOptions) {
    assert.equal(row.peerRootChoiceOptions.length, 2);
    assert.ok(row.concreteFeatureProposal.proposedInputSlots.length >= 2);
    assert.ok(row.concreteFeatureProposal.proposedSuccessAndNonSuccessOutput.resultVariants.length >= 3);
    assert.ok(row.concreteFeatureProposal.proposedFailureContract.length >= 2);
    assert.ok(row.concreteFeatureProposal.currentAuthorityBaseline.length > 0);
    assert.ok(row.concreteFeatureProposal.additionalAuthorityRequiringOwnerDecision.length > 0);
    assert.equal(row.proposedPdp0OwnerResolution, 'NO OPTION SELECTED; root decision required');
    assert.equal(row.canonicalMutation, 'NONE');
  }
  for (const row of r4.overlapRootDecisionOptions) {
    assert.equal(row.peerRootChoiceOptions.length, 2);
    assert.ok(row.relatedAuditIds.length > 0);
    assert.ok(row.decision.includes('ROOT_CHOICE_REQUIRED'));
  }
});

test('capability source postimage changes only acceptanceCases; requirements source bytes and canonical preimages stay unchanged', () => {
  const r4 = readJson('cohort-02.r4.json');
  const preCapabilities = YAML.parse(fs.readFileSync(path.join(root, '.product-experience/pdp-0-product-truth/capabilities.yaml'), 'utf8'));
  const postCapabilities = YAML.parse(fs.readFileSync(path.join(root, dir, 'cohort-02.source-amendment-capabilities.postimage.r4.yaml'), 'utf8'));
  const addedGiven = new Set(r4.exactFeatureCasePostimages.flatMap((row) => row.cases.map((item) => item.given)));
  for (const post of postCapabilities.capabilities) {
    const original = preCapabilities.capabilities.find((item) => item.id === post.id);
    if (!original) continue;
    const additions = (post.acceptanceCases ?? []).filter((item) => addedGiven.has(item.given));
    const restored = {...post, acceptanceCases: (post.acceptanceCases ?? []).filter((item) => !addedGiven.has(item.given))};
    assert.deepEqual(restored, original, `unexpected non-case change in ${post.id}`);
    const expectedRows = r4.exactFeatureCasePostimages.filter((item) => item.capabilityId === post.id);
    assert.equal(additions.length, expectedRows.length * 2);
  }
  const reqTarget = r4.exactTargetPostimages.find((target) => target.targetRef.endsWith('requirements.yaml'));
  assert.equal(reqTarget.semanticMutationCount, 0);
  assert.equal(reqTarget.preimageSha256, reqTarget.postimageSha256);
});
