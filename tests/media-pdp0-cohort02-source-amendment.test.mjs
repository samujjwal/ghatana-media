import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { buildSourceAmendmentBatch } from '../scripts/build-media-pdp0-cohort02-source-amendment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const json = (name) => JSON.parse(fs.readFileSync(path.join(root, folder, name), 'utf8'));
const hash = (bytes) => import('node:crypto').then(({createHash}) => createHash('sha256').update(bytes).digest('hex'));

test('candidate rebuilds exact deterministic file postimages from pinned live preimages', async () => {
  const rebuilt = buildSourceAmendmentBatch();
  const storedCandidate = json('cohort-02.source-amendment-candidate.json');
  const storedPostimages = json('cohort-02.source-amendment-postimages.json');
  const storedRecords = json('cohort-02.source-amendment-record-postimages.json');
  assert.deepEqual(rebuilt.candidate, storedCandidate);
  assert.deepEqual(rebuilt.postimageArtifact, storedPostimages);
  assert.deepEqual(rebuilt.nonSourceRecord, storedRecords);
  assert.equal(await hash(rebuilt.capabilityPostimage), storedCandidate.exactTargetPostimages[0].postimageSha256);
  assert.equal(await hash(rebuilt.requirementPostimage), storedCandidate.exactTargetPostimages[1].postimageSha256);
  assert.equal(rebuilt.capabilityPostimage.equals(fs.readFileSync(path.join(root, storedCandidate.exactTargetPostimages[0].postimageRef))), true);
  assert.equal(rebuilt.requirementPostimage.equals(fs.readFileSync(path.join(root, storedCandidate.exactTargetPostimages[1].postimageRef))), true);
  const expectedCombined = await hash(Buffer.from(JSON.stringify({
    targetPostimages: storedCandidate.exactTargetPostimages.map(({targetRef, preimageSha256, postimageSha256}) => ({targetRef, preimageSha256, postimageSha256})),
    recordPostimageSha256: storedCandidate.exactRecordPostimageSha256
  })));
  assert.equal(storedCandidate.candidatePostimageSha256, expectedCombined);
  assert.equal(storedPostimages.candidatePostimageSha256, expectedCombined);
});

test('candidate preserves exact cohort assignment, 231 denominator, 24 reused rows, and separate 462 history', () => {
  const candidate = json('cohort-02.source-amendment-candidate.json');
  const posts = json('cohort-02.source-amendment-record-postimages.json');
  const expected = JSON.parse(fs.readFileSync(path.join(root, '../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-pdp0-resolution-cohort-assignments.json'), 'utf8')).cohorts[1].expectedAuditIds;
  assert.deepEqual(candidate.scope.exactOrderedAssignedAuditIds, expected);
  assert.deepEqual(posts.exactOrderedAssignedAuditIds, expected);
  assert.equal(candidate.scope.exactAssignmentCount, 77);
  assert.equal(candidate.scope.fullCampaignAuditIdDenominator, 231);
  assert.equal(candidate.scope.campaignIdentityDenominator, 54);
  assert.equal(candidate.scope.campaignPathDenominator, 207);
  assert.equal(posts.unmodifiedAssignedRows.length, 24);
  assert.deepEqual(posts.unmodifiedAssignedRows.map((row) => row.auditId), expected.filter((id) => posts.unmodifiedAssignedRows.some((item) => item.auditId === id)));
  assert.equal(posts.historicalLeafAdjudications.historicalRecordCount, 462);
  assert.equal(posts.historicalLeafAdjudications.mutation, 'NONE; preserve the historical 462 rows as a separate population.');
});

test('source YAML postimages make only the declared acceptance-case additions', () => {
  const records = json('cohort-02.source-amendment-record-postimages.json');
  const originalCapabilities = YAML.parse(fs.readFileSync(path.join(root, '.product-experience/pdp-0-product-truth/capabilities.yaml'), 'utf8'));
  const proposedCapabilities = YAML.parse(fs.readFileSync(path.join(root, folder, 'cohort-02.source-amendment-capabilities.postimage.yaml'), 'utf8'));
  const originalRequirements = YAML.parse(fs.readFileSync(path.join(root, '.product-experience/pdp-0-product-truth/requirements.yaml'), 'utf8'));
  const proposedRequirements = YAML.parse(fs.readFileSync(path.join(root, folder, 'cohort-02.source-amendment-requirements.postimage.yaml'), 'utf8'));
  const reqIds = new Map(records.requirementAcceptanceCaseAdditions.map((row) => [row.case.id, row]));
  const capAuditIds = new Set(records.capabilityAcceptanceCaseAdditions.map((row) => row.auditId));
  const reqAuditIds = new Set(records.requirementAcceptanceCaseAdditions.map((row) => row.auditId));

  for (const post of proposedCapabilities.capabilities) {
    const added = (post.acceptanceCases ?? []).filter((item) => [...capAuditIds].some((auditId) => item.given?.includes(auditId)));
    const original = originalCapabilities.capabilities.find((item) => item.id === post.id);
    if (!original) continue;
    assert.deepEqual(added.map((item) => item.given.match(/source feature (AUD-[A-Z]+-\d+)/u)?.[1]), records.capabilityAcceptanceCaseAdditions.filter((row) => row.targetSelector.includes(`@id=${post.id}/`)).map((row) => row.auditId));
    const restored = {...post, acceptanceCases: (post.acceptanceCases ?? []).filter((item) => ![...capAuditIds].some((auditId) => item.given?.includes(auditId)))};
    assert.deepEqual(restored, original, `unexpected semantic source change in ${post.id}`);
  }
  for (const post of proposedRequirements.requirements) {
    const added = (post.acceptanceCases ?? []).filter((item) => [...reqAuditIds].some((auditId) => item.given?.includes(auditId)));
    const original = originalRequirements.requirements.find((item) => item.id === post.id);
    if (!original) continue;
    assert.deepEqual(added.map((item) => item.id), records.requirementAcceptanceCaseAdditions.filter((row) => row.targetSelector.includes(`@id=${post.id}/`)).map((row) => row.case.id));
    const restored = {...post, acceptanceCases: (post.acceptanceCases ?? []).filter((item) => ![...reqAuditIds].some((auditId) => item.given?.includes(auditId)))};
    assert.deepEqual(restored, original, `unexpected semantic source change in ${post.id}`);
  }
});

test('44 supported feature cases and 53 exact requirement cases are specific to their feature and current selectors', () => {
  const posts = json('cohort-02.source-amendment-record-postimages.json');
  assert.equal(posts.capabilityAcceptanceCaseAdditions.length, 44);
  assert.equal(posts.requirementAcceptanceCaseAdditions.length, 53);
  for (const row of posts.capabilityAcceptanceCaseAdditions) {
    assert.match(row.targetSelector, /capabilities\.yaml#capabilities\/@id=/u);
    assert.equal(row.mutation, 'APPEND_FEATURE_SPECIFIC_ACCEPTANCE_CASE');
    assert.ok(row.case.id.includes(row.auditId));
    assert.ok(row.case.given.includes(row.auditId));
    assert.ok(row.case.when.includes(row.targetSelector.split('@id=')[1].split('/')[0]));
    assert.ok(row.case.then.includes('Feature-specific gap to resolve:'));
    assert.equal(row.case.sourceRefs.length, 4);
  }
  for (const row of posts.requirementAcceptanceCaseAdditions) {
    assert.match(row.targetSelector, /requirements\.yaml#requirements\/@id=/u);
    assert.ok(row.case.id.includes(row.auditId));
    assert.ok(row.case.then.includes(row.auditId));
    assert.ok(row.case.then.includes('UNKNOWN'));
  }
});

test('nine overstatements have exact proposed input/output/failure/authority records without invented owner approval', () => {
  const posts = json('cohort-02.source-amendment-record-postimages.json');
  assert.equal(posts.missingMeaningDefinitionProposals.length, 9);
  const expectedKinds = new Map([
    ['AUD-DELIV-019', 'NEW_CAPABILITY_VARIANT'], ['AUD-DUB-015', 'NEW_CAPABILITY_VARIANT'],
    ['AUD-EDIT-016', 'NEW_CAPABILITY_VARIANT'], ['AUD-EDIT-024', 'NEW_CAPABILITY_VARIANT'],
    ['AUD-GEN-010', 'NEW_CAPABILITY_VARIANT'], ['AUD-GEN-020', 'NEW_CAPABILITY_VARIANT'],
    ['AUD-GEN-021', 'EXTEND_EXISTING_CAPABILITY_VARIANT'], ['AUD-GEN-023', 'NEW_CAPABILITY_VARIANT'],
    ['AUD-GEN-024', 'NEW_CAPABILITY_VARIANT']
  ]);
  for (const row of posts.missingMeaningDefinitionProposals) {
    assert.equal(row.mappingChoice, expectedKinds.get(row.auditId));
    assert.ok(row.proposedInputSlots.length >= 2);
    assert.ok(row.proposedSuccessAndNonSuccessOutput.resultVariants.length >= 3);
    assert.ok(row.proposedFailureContract.length >= 2);
    assert.ok(row.currentAuthorityBaseline.length > 0);
    assert.ok(row.additionalAuthorityRequiringOwnerDecision.length > 0);
    assert.equal(row.accountableSourceOwner, 'UNRESOLVED_IN_CURRENT_AUTHORITY_MAP; root must identify the authorized semantic owner before canonical adoption');
    assert.equal(row.adoptionState, 'PROPOSAL_ONLY_PENDING_ROOT_PRODUCT_DECISION_AND_DISTINCT_PEER_REVIEW');
    assert.ok(row.preimageHashes.some((pin) => pin.sourcePath === '.product-experience/pdp-0-product-truth/capabilities.yaml'));
  }
  assert.equal(json('cohort-02.source-amendment-candidate.json').canonicalApply, 'NOT_PERFORMED');
  const candidate = json('cohort-02.source-amendment-candidate.json');
  assert.deepEqual(candidate.sourceOwnerDecisionRequirement.authorityBoundary, {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED'});
  assert.equal(candidate.sourceOwnerDecisionRequirement.requiredSourceOwner.identity, 'ROOT_TO_RESOLVE_FROM_AUTHORITY_MAP');
  assert.equal(candidate.distinctTechnicalPeerRequirement.reviewer.role, 'DISTINCT_TECHNICAL_PEER');
  assert.ok(candidate.blockers.some((item) => item.includes('Root must decide')));
  assert.ok(candidate.blockers.some((item) => item.includes('distinct technical peer')));
});
