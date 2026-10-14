import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { joinMediaPdp0PhaseExit, mediaPdp0RequiredCommands } from '../scripts/lib/media-discovery-pdp0-phase-exit.mjs';
import { classifySupplementalPdp0PinChange } from '../scripts/record-media-discovery-pdp0-currentness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const directions = read('docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json');
const predecessor = read('docs/implementation/observations/media-discovery-pdp0-exit-2026-10-13-r2.json');
const supplement = read('docs/implementation/observations/media-discovery-predecessor-impact-pdp3-status-guard-2026-10-14-r1.json');
const fingerprint = 'sha256:8a60cf8a09e671b09729563039d31aed69b21934a59cade1af9833ca9af86cb9';

function technical(extraDelta = true, supplementalDigest = supplement.sourceDelta.observedSha256) {
  const digests = { ...predecessor.sourceCurrentness.sourceContentDigests };
  for (const change of directions.predecessorImpactReviews[0].sourceChanges) digests[change.path] = change.observedSha256;
  if (extraDelta) digests[supplement.sourceDelta.path] = supplementalDigest;
  return {
    materialSourceSetFingerprint: fingerprint,
    campaign: { observedHead: 'fixture', branch: 'main' },
    denominators: { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50 },
    physicalCompositeConsumerCells: Array.from({ length: 50 }, (_, i) => ({ cellId: `surface-${i}:PDP-0`, sourceCurrentness: 'CURRENT', applicability: { disposition: 'APPLICABLE', rationale: 'fixture' } })),
    unclassifiedHistoricalPdp0PinChanges: [], externalOwnerContracts: { totalFiles: 30, digestMatches: 30, digestMismatches: [] },
    authority: { changedMeaningIds: [] }, sourceContentDigests: digests,
    phaseDisposition: { historicalDefinitionStatus: 'DEV_COMPLETE', historicalOutstandingMeaningIds: [], currentSourceCurrentness: 'PASS', sourceCurrent: true },
  };
}

const outcomes = mediaPdp0RequiredCommands.map((command) => ({ command, status: 'PASS', exitCode: 0,
  ...(command.startsWith('node --test ') ? { testCount: 1, passedCount: 1, failedCount: 0, skippedCount: 0 } : {}) }));

test('PDP-0 joins exactly the supplemental fifth source delta with four unchanged R2 approvals', () => {
  const result = joinMediaPdp0PhaseExit({ technicalCurrentness: technical(), ownerAcceptance: directions, historicalPdp0Exit: predecessor, testOutcomes: outcomes });
  assert.equal(result.ownerStatusJoin.unchangedPathCount, 141);
  assert.equal(result.ownerStatusJoin.ownerApprovedChangedPathCount, 5);
  assert.equal(result.ownerStatusJoin.unapprovedChangedPathCount, 0);
  assert.equal(result.ownerStatusJoin.missingPathCount, 0);
  assert.equal(result.ownerStatusJoin.additionalPathCount, 0);
});

test('PDP-0 rejects a changed supplemental digest and any sixth unapproved delta', () => {
  const wrongDigest = joinMediaPdp0PhaseExit({ technicalCurrentness: technical(true, `sha256:${'0'.repeat(64)}`), ownerAcceptance: directions, historicalPdp0Exit: predecessor, testOutcomes: outcomes });
  assert.equal(wrongDigest.phaseExit.status, 'FAIL');
  assert.ok(wrongDigest.ownerStatusJoin.paths.some((entry) => entry.path === supplement.sourceDelta.path && entry.disposition === 'UNAPPROVED_CHANGE'));
  const sixth = technical();
  sixth.sourceContentDigests[Object.keys(sixth.sourceContentDigests)[0]] = `sha256:${'1'.repeat(64)}`;
  const extra = joinMediaPdp0PhaseExit({ technicalCurrentness: sixth, ownerAcceptance: directions, historicalPdp0Exit: predecessor, testOutcomes: outcomes });
  assert.equal(extra.phaseExit.status, 'FAIL');
  assert.ok(extra.ownerStatusJoin.unapprovedChangedPathCount > 0);
});

test('currentness classifies only the exact supplemental digest under the immutable decision', () => {
  const pin = { path: supplement.sourceDelta.path, recordedDigest: supplement.sourceDelta.predecessorSha256, currentDigest: supplement.sourceDelta.observedSha256, disposition: 'CHANGED' };
  assert.ok(classifySupplementalPdp0PinChange([pin], supplement));
  assert.equal(classifySupplementalPdp0PinChange([{ ...pin, currentDigest: `sha256:${'0'.repeat(64)}` }], supplement), null);
  assert.equal(classifySupplementalPdp0PinChange([pin], { ...supplement, recordId: 'OTHER' }), null);
  const wrongReceiptDigest = { ...supplement, predecessorCuts: supplement.predecessorCuts.map((cut) => cut.phase === 'PDP-0' ? { ...cut, receiptSha256: `sha256:${'0'.repeat(64)}` } : cut) };
  assert.equal(classifySupplementalPdp0PinChange([pin], wrongReceiptDigest), null);
  const unapproved = { ...supplement, decision: { ...supplement.decision, status: 'REJECTED' } };
  assert.equal(classifySupplementalPdp0PinChange([pin], unapproved), null);
});
