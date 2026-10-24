import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/', import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const r3 = readJson('cohort-02.r3.json');
const r2 = readJson('cohort-02.r2.json');
const selfCheck = readJson('cohort-02-supported-self-check.json');
const assignmentPath = new URL('../../../../../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-pdp0-resolution-cohort-assignments.json', root);
const assignmentBytes = readFileSync(assignmentPath);
const assignment = JSON.parse(assignmentBytes);

test('R3 retains the exact ordered 77-row cohort assignment and campaign denominators', () => {
  const expected = assignment.cohorts[1].expectedAuditIds;
  const ids = r3.rows.map((row) => row.existingAuditId);
  assert.deepEqual(ids, expected);
  assert.equal(new Set(ids).size, 77);
  assert.equal(r3.scope.rowCount, 77);
  assert.equal(r3.scope.fullCampaignAuditIdDenominator, 231);
  assert.equal(r3.scope.campaignProductIdentityDenominator, 54);
  assert.equal(r3.scope.campaignPathDenominator, 207);
  assert.equal(r3.sourceBaseline.assignmentSha256, createHash('sha256').update(assignmentBytes).digest('hex'));
});

test('R3 adds proposals without changing any frozen R2 row data', () => {
  const oldById = new Map(r2.rows.map((row) => [row.existingAuditId, row]));
  for (const row of r3.rows) {
    const { r3Resolution, ...preserved } = row;
    assert.deepEqual(preserved, oldById.get(row.existingAuditId));
  }
  assert.equal(r3.status, 'TECHNICAL_SOURCE_GROUNDED_PROPOSALS_PENDING_ROOT_OWNER_AND_DISTINCT_PEER_REVIEW');
  assert.equal(r3.rows.filter((row) => row.r3Resolution.status === 'NOT_REVISED_IN_R3_SCOPE').length, 24);
});

test('all 53 supported findings receive feature-specific cases; overstatements require new owner definitions', () => {
  const reviews = new Map(selfCheck.supportedRowReviews.map((row) => [row.auditId, row]));
  const revised = r3.rows.filter((row) => row.r3Resolution.status !== 'NOT_REVISED_IN_R3_SCOPE');
  assert.equal(revised.length, 53);
  assert.deepEqual(new Set(revised.map((row) => row.existingAuditId)), new Set(reviews.keys()));

  for (const row of revised) {
    const proposal = row.r3Resolution;
    assert.ok(proposal.proposedCase.given.includes(proposal.featureStatement));
    assert.ok(proposal.proposedCase.when.length > 20);
    assert.ok(proposal.proposedCase.then.includes(proposal.sourceAcceptanceCriterion));
    assert.equal(proposal.proposedCase.negativeCases.length, 2);
    assert.ok(proposal.proposedCase.negativeCases[0].includes(proposal.gap));
    assert.ok(proposal.proposedCase.coverageWarning.includes('Generic'));
    assert.ok(proposal.sourceRefs.every((ref) => typeof ref === 'string' && ref.length > 0));
    assert.ok(proposal.sourceFingerprints.some((item) => item.sha256 && item.sourcePath));
    assert.equal(proposal.authority.ownerDecisionStatus, 'NOT_RECORDED');
    assert.equal(proposal.canonicalMutation, 'NONE; this artifact is a proposal only.');

    if (proposal.priorFindingCategory === 'OVERSTATES_CURRENT_MEANING') {
      assert.equal(proposal.status, 'PROPOSED_OWNER_DEFINITION_REQUIRED');
      assert.equal(proposal.ownerDefinitionProposal.canonicalIdStatus, 'PROPOSED_ONLY_NOT_RESERVED_OR_CANONICAL');
      assert.ok(proposal.ownerDefinitionProposal.ownerDecisionRequired.length >= 3);
    } else {
      assert.equal(proposal.status, 'PROPOSED_FEATURE_CASE_AMENDMENT');
      assert.equal(proposal.ownerDefinitionProposal, null);
    }
  }
  assert.equal(revised.filter((row) => row.r3Resolution.status === 'PROPOSED_OWNER_DEFINITION_REQUIRED').length, 9);
});
