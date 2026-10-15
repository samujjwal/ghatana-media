import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { joinMediaPdp0PhaseExit, mediaPdp0RequiredCommands, parseMediaPdp0PhaseExitArgs } from '../scripts/lib/media-discovery-pdp0-phase-exit.mjs';
import { classifyAdditionalPdp0SourceImpact, classifyPdp0SuccessorImpact, classifySupplementalPdp0PinChange, projectMediaPdp0PinDriftClassifications, resolveMediaPdp0CurrentnessOutputPath } from '../scripts/record-media-discovery-pdp0-currentness.mjs';

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
const pxd164TestCommand = 'node --test tests/media-discovery-pdp0-supplemental-impact-join.test.mjs';
const pxd164TestOutcome = { command: pxd164TestCommand, status: 'PASS', exitCode: 0,
  testCount: 9, passedCount: 9, failedCount: 0, skippedCount: 0 };

test('PDP-0 CLI accepts each supported argument shape before capture', () => {
  assert.deepEqual(parseMediaPdp0PhaseExitArgs(['node', 'cli.mjs', 'cut-a', 'outcomes.json']), {
    suffix: 'cut-a', outcomesPath: 'outcomes.json', currentCutImpactMode: false, additionalImpactPath: null,
    successorImpactMode: false, successorImpactPath: null, legacyOwnerInputPath: null,
  });
  assert.deepEqual(parseMediaPdp0PhaseExitArgs(['node', 'cli.mjs', 'cut-b', 'outcomes.json', 'owner.json']), {
    suffix: 'cut-b', outcomesPath: 'outcomes.json', currentCutImpactMode: false, additionalImpactPath: null,
    successorImpactMode: false, successorImpactPath: null, legacyOwnerInputPath: 'owner.json',
  });
  assert.deepEqual(parseMediaPdp0PhaseExitArgs(['node', 'cli.mjs', 'cut-c', 'outcomes.json', '--current-cut-impact']), {
    suffix: 'cut-c', outcomesPath: 'outcomes.json', currentCutImpactMode: true, additionalImpactPath: null,
    successorImpactMode: false, successorImpactPath: null, legacyOwnerInputPath: null,
  });
  assert.deepEqual(parseMediaPdp0PhaseExitArgs(['node', 'cli.mjs', 'cut-d', 'outcomes.json', '--current-cut-impact', 'impact.json']), {
    suffix: 'cut-d', outcomesPath: 'outcomes.json', currentCutImpactMode: true, additionalImpactPath: 'impact.json',
    successorImpactMode: false, successorImpactPath: null, legacyOwnerInputPath: null,
  });
  assert.throws(() => parseMediaPdp0PhaseExitArgs(['node', 'cli.mjs', 'cut-e', 'outcomes.json', 'owner.json', 'impact.json']), /only alongside --current-cut-impact/);
  assert.deepEqual(parseMediaPdp0PhaseExitArgs(['node', 'cli.mjs', 'cut-f', 'outcomes.json', '--successor-impact', 'successor.json']), {
    suffix: 'cut-f', outcomesPath: 'outcomes.json', currentCutImpactMode: false, additionalImpactPath: null,
    successorImpactMode: true, successorImpactPath: 'successor.json', legacyOwnerInputPath: null,
  });
  assert.throws(() => parseMediaPdp0PhaseExitArgs(['node', 'cli.mjs', 'cut-g', 'outcomes.json', '--successor-impact']), /impact record path is required/);
  assert.throws(() => parseMediaPdp0PhaseExitArgs(['node', 'cli.mjs', 'cut-h', 'outcomes.json', '--successor-impact', 'successor.json', 'extra.json']), /Unexpected/);
});

test('PDP-0 PXD-164 R10 successor disposition binds exactly the decision-log delta and preserves the 50-cell cut', () => {
  const r10ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r10.json';
  const r10CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r10.json';
  const impactPath = 'docs/implementation/observations/media-discovery-pdp0-pxd164-successor-impact-2026-10-14-r1.json';
  const r10Exit = read(r10ExitPath);
  const r10Currentness = read(r10CurrentnessPath);
  const record = read(impactPath);
  const currentDigests = { ...r10Exit.sourceCurrentness.sourceContentDigests,
    '.product-experience/decision-log.md': 'sha256:97ad3104abec9ba6670804394c68a11c663f37171e90ea2a1f2e629aa5619bbc' };
  const pinComparisons = Object.keys(r10Exit.sourceCurrentness.sourceContentDigests).sort().map((sourcePath) => ({
    path: sourcePath,
    recordedDigest: r10Exit.sourceCurrentness.sourceContentDigests[sourcePath],
    currentDigest: currentDigests[sourcePath],
    disposition: currentDigests[sourcePath] === r10Exit.sourceCurrentness.sourceContentDigests[sourcePath] ? 'MATCH' : 'CHANGED',
  }));
  const technicalCurrentness = {
    ...r10Currentness,
    sourceContentDigests: currentDigests,
    materialPathDenominator: { uniquePaths: 146, sharedPaths: 111, cellSpecificPaths: 35 },
    physicalCompositeConsumerCells: r10Currentness.physicalCompositeConsumerCells.map((cell) => ({ ...cell, sourceCurrentness: 'CURRENT', blockers: [] })),
    historicalPdp0PinDriftClassifications: r10Currentness.historicalPdp0PinDriftClassifications.map((entry) => ({
      ...entry,
      ...(typeof entry.predecessorSha256 === 'string' && typeof entry.observedSha256 === 'string'
        ? { impactDelta: { predecessorSha256: entry.predecessorSha256, observedSha256: entry.observedSha256 } }
        : {}),
    })),
    unclassifiedHistoricalPdp0PinChanges: [],
    phaseDisposition: { ...r10Currentness.phaseDisposition, historicalDefinitionStatus: 'DEV_COMPLETE', historicalOutstandingMeaningIds: [], currentSourceCurrentness: 'PASS', sourceCurrent: true },
    authority: { changedMeaningIds: [] },
    externalOwnerContracts: { totalFiles: 30, digestMatches: 30, digestMismatches: [] },
  };
  const classification = classifyPdp0SuccessorImpact(pinComparisons, record, impactPath, technicalCurrentness);
  assert.equal(classification?.classification, 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION');
  assert.equal(classification?.path, '.product-experience/decision-log.md');
  assert.equal(classification?.predecessorSha256, 'sha256:9831b03ecd3f30d2cbfd7a1db62d934035ba20cf1482bb5e621d166eacdb9b4c');
  assert.equal(classification?.observedSha256, 'sha256:97ad3104abec9ba6670804394c68a11c663f37171e90ea2a1f2e629aa5619bbc');
  assert.deepEqual(classification?.meaningIdsChanged, []);

  technicalCurrentness.historicalPdp0PinDriftClassifications.push(classification);
  const joined = joinMediaPdp0PhaseExit({
    technicalCurrentness,
    ownerAcceptance: record,
    ownerAcceptancePath: impactPath,
    historicalPdp0Exit: r10Exit,
    testOutcomes: [...outcomes, pxd164TestOutcome],
  });
  assert.equal(joined.phaseExit.status, 'PASS', JSON.stringify(joined.phaseExit.blockers));
  assert.equal(joined.phaseExit.delegatedOwnerAcceptance, 'NOT_CLAIMED_IMPACT_DISPOSITION_ONLY');
  assert.equal(joined.ownerStatusJoin.predecessorExitRef, r10ExitPath);
  assert.equal(joined.ownerStatusJoin.predecessorPathCount, 146);
  assert.equal(joined.ownerStatusJoin.unchangedPathCount, 145);
  assert.equal(joined.ownerStatusJoin.internallyDispositionedChangedPathCount, 1);
  assert.equal(joined.ownerStatusJoin.unreviewedChangedPathCount, 0);
  assert.equal(joined.delegatedOwnerAcceptance.status, 'INTERNAL_SUCCESSOR_IMPACT_DISPOSITION_ONLY_NOT_OWNER_ACCEPTANCE');
  assert.ok(joined.testOutcomes.some((outcome) => outcome.command === pxd164TestCommand
    && outcome.status === 'PASS' && outcome.exitCode === 0 && outcome.testCount === 9
    && outcome.passedCount === 9 && outcome.failedCount === 0 && outcome.skippedCount === 0));

  for (const invalidOutcome of [
    null,
    { ...pxd164TestOutcome, status: 'FAIL', exitCode: 1 },
    { ...pxd164TestOutcome, testCount: 9, passedCount: 8, failedCount: 0, skippedCount: 0 },
  ]) {
    const invalidOutcomes = outcomes.filter((outcome) => outcome.command !== pxd164TestCommand);
    if (invalidOutcome) invalidOutcomes.push(invalidOutcome);
    const blocked = joinMediaPdp0PhaseExit({
      technicalCurrentness, ownerAcceptance: record, ownerAcceptancePath: impactPath,
      historicalPdp0Exit: r10Exit, testOutcomes: invalidOutcomes,
    });
    assert.equal(blocked.phaseExit.status, 'FAIL');
    assert.ok(blocked.phaseExit.blockers.some((blocker) => blocker.includes(pxd164TestCommand)));
  }

  // The PXD164-only prerequisite must not retroactively change older successor lanes.
  const r8Exit = read('docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r8.json');
  const r8Impact = read('docs/implementation/observations/media-discovery-pdp0-r8-successor-impact-2026-10-14-r2.json');
  const r8StillPasses = joinMediaPdp0PhaseExit({
    technicalCurrentness: { ...technicalCurrentness, materialSourceSetFingerprint: r8Exit.sourceCurrentness.materialSourceSetFingerprint },
    ownerAcceptance: r8Impact,
    ownerAcceptancePath: 'docs/implementation/observations/media-discovery-pdp0-r8-successor-impact-2026-10-14-r2.json',
    historicalPdp0Exit: r8Exit,
    testOutcomes: outcomes,
  });
  assert.notEqual(r8StillPasses.phaseExit.blockers.some((blocker) => blocker.includes(pxd164TestCommand)), true);

  const invalidRecords = [
    { ...record, sourceDelta: { ...record.sourceDelta, predecessorSha256: `sha256:${'0'.repeat(64)}` } },
    { ...record, sourceDelta: { ...record.sourceDelta, observedSha256: `sha256:${'0'.repeat(64)}` } },
    { ...record, predecessorCut: { ...record.predecessorCut, exitSha256: `sha256:${'0'.repeat(64)}` } },
    { ...record, predecessorCut: { ...record.predecessorCut, currentnessSha256: `sha256:${'0'.repeat(64)}` } },
    { ...record, predecessorCut: { ...record.predecessorCut, materialPathCount: 145 } },
    { ...record, predecessorCut: { ...record.predecessorCut, topology: { ...record.predecessorCut.topology, totalCells: 49 } } },
    { ...record, sourceDeltas: [...record.sourceDeltas, { path: 'extra', meaningIdsChanged: [] }] },
    { ...record, authority: { ...record.authority, externalContractOwnerAcceptanceProvided: true } },
    { ...record, authority: { ...record.authority, humanIndependentSignatureProvided: true } },
    { ...record, authority: { ...record.authority, nativeLifecycleReceiptProvided: true } },
    { ...record, decision: { ...record.decision, ownerAcceptance: 'ACCEPTED' } },
    { ...record, decision: { ...record.decision, independentSignoff: 'APPROVED' } },
    { ...record, decision: { ...record.decision, lifecycleClosure: 'CLOSED' } },
    { ...record, decision: { ...record.decision, runtime: 'ADMITTED' } },
    { ...record, decision: { ...record.decision, delivery: 'RELEASE_READY', release: 'AUTHORIZED' } },
  ];
  for (const invalid of invalidRecords) assert.equal(classifyPdp0SuccessorImpact(pinComparisons, invalid, impactPath, technicalCurrentness), null);
  assert.equal(classifyPdp0SuccessorImpact(pinComparisons, record, 'docs/implementation/observations/other.json', technicalCurrentness), null);
  assert.equal(classifyPdp0SuccessorImpact(pinComparisons.map((pin) => pin.path === '.product-experience/decision-log.md'
    ? { ...pin, currentDigest: `sha256:${'f'.repeat(64)}` } : pin), record, impactPath, technicalCurrentness), null);
  const secondDelta = pinComparisons.map((pin) => pin.path === '.product-experience/decision-log.md'
    ? pin : pin.path === pinComparisons[0].path ? { ...pin, currentDigest: `sha256:${'e'.repeat(64)}`, disposition: 'CHANGED' } : pin);
  assert.equal(classifyPdp0SuccessorImpact(secondDelta, record, impactPath, technicalCurrentness), null);
  assert.equal(resolveMediaPdp0CurrentnessOutputPath(true, '2026-10-14-current-cut-r11'), 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r11.json');
});

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

test('PDP-0 does not label an unvalidated additional impact as dispositioned', () => {
  const result = joinMediaPdp0PhaseExit({
    technicalCurrentness: technical(),
    ownerAcceptance: directions,
    additionalSourceImpact: { recordId: 'UNVALIDATED' },
    additionalSourceImpactPath: 'docs/implementation/observations/other.json',
    historicalPdp0Exit: predecessor,
    testOutcomes: outcomes,
  });
  assert.equal(result.ownerStatusJoin.status, 'ACCEPTED_FOR_EXACT_CURRENT_FINGERPRINT_WITH_REVIEWED_DELTA');
  assert.equal(result.additionalSourceImpactDisposition, null);
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

test('additional PDP-0 source impact accepts only the exact internal decision-log disposition', () => {
  const record = {
    schemaVersion: 'media.discovery-pdp0-additional-source-impact.v1',
    recordId: 'MEDIA-DISCOVERY-PDP0-ADDITIONAL-SOURCE-IMPACT-2026-10-14-R1',
    phase: 'PDP-0',
    sourcePath: '.product-experience/decision-log.md',
    predecessorSha256: `sha256:${'1'.repeat(64)}`,
    observedSha256: `sha256:${'2'.repeat(64)}`,
    classification: 'INTERNAL_SCOPED_IMPACT_DISPOSITION',
    pdp0MeaningDisposition: 'NO_PDP0_MEANING_CHANGE',
    pdp0ImpactAssessment: { sourceSelector: '.product-experience/decision-log.md#PXD-163', meaningIdsChanged: [] },
    ownerAcceptance: 'NOT_CLAIMED',
    independentReview: 'NOT_CLAIMED',
    lifecycleClosure: 'NOT_ENTERED',
    runtimeAdmission: 'NOT_ADMITTED',
    delivery: 'BLOCKED',
  };
  const pin = { path: record.sourcePath, recordedDigest: record.predecessorSha256, currentDigest: record.observedSha256, disposition: 'CHANGED' };
  const recordPath = 'docs/implementation/observations/media-discovery-pdp0-pxd163-source-impact-2026-10-14-r1.json';
  assert.equal(classifyAdditionalPdp0SourceImpact([pin], record, recordPath)?.classification, 'INTERNAL_SCOPED_IMPACT_DISPOSITION');
  assert.equal(classifyAdditionalPdp0SourceImpact([pin], { ...record, recordId: 'OTHER' }, recordPath), null);
  assert.equal(classifyAdditionalPdp0SourceImpact([pin], record, 'docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json'), null);
  assert.equal(classifyAdditionalPdp0SourceImpact([{ ...pin, currentDigest: `sha256:${'3'.repeat(64)}` }], record, recordPath), null);
  assert.equal(classifyAdditionalPdp0SourceImpact([pin], { ...record, ownerAcceptance: 'APPROVED' }, recordPath), null);
  assert.equal(classifyAdditionalPdp0SourceImpact([pin], record, '../outside.json'), null);
});

test('PDP-0 successor impact accepts only the exact R6-bound reporter transition and topology', () => {
  const r6ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r6.json';
  const r6CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r6.json';
  const r6Exit = read(r6ExitPath);
  const r6Currentness = read(r6CurrentnessPath);
  const priorPxd163Path = 'docs/implementation/observations/media-discovery-pdp0-pxd163-source-impact-2026-10-14-r1.json';
  const priorPxd163 = read(priorPxd163Path);
  const priorPxd163Pin = { path: priorPxd163.sourcePath, recordedDigest: priorPxd163.predecessorSha256, currentDigest: priorPxd163.observedSha256, disposition: 'CHANGED' };
  const priorPxd163Classification = classifyAdditionalPdp0SourceImpact([priorPxd163Pin], priorPxd163, priorPxd163Path);
  assert.equal(priorPxd163Classification?.classification, 'INTERNAL_SCOPED_IMPACT_DISPOSITION');
  assert.ok(r6Currentness.historicalPdp0PinDriftClassifications.some((entry) => entry.path === priorPxd163.sourcePath
    && entry.authorityRef === priorPxd163Path
    && entry.authoritySha256 === priorPxd163Classification.authoritySha256
    && entry.predecessorSha256 === priorPxd163.predecessorSha256
    && entry.observedSha256 === priorPxd163.observedSha256));
  assert.equal(classifyAdditionalPdp0SourceImpact([{ ...priorPxd163Pin, currentDigest: `sha256:${'0'.repeat(64)}` }], priorPxd163, priorPxd163Path), null);
  const topology = { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50 };
  const impactPath = 'docs/implementation/observations/media-discovery-pdp0-r6-successor-impact-2026-10-14-r1.json';
  const record = read(impactPath);
  const authoritySha256 = `sha256:${createHash('sha256').update(fs.readFileSync(path.join(root, impactPath))).digest('hex')}`;
  const currentDigests = { ...r6Exit.sourceCurrentness.sourceContentDigests,
    'scripts/report-media-pdp-readiness.mjs': 'sha256:4f0400c142d2f3df39c4497839925dad80f1ac90584573b390af386e491faa0f' };
  const pinComparisons = Object.keys(r6Exit.sourceCurrentness.sourceContentDigests).sort().map((sourcePath) => ({
    path: sourcePath,
    recordedDigest: r6Exit.sourceCurrentness.sourceContentDigests[sourcePath],
    currentDigest: currentDigests[sourcePath],
    disposition: currentDigests[sourcePath] === r6Exit.sourceCurrentness.sourceContentDigests[sourcePath] ? 'MATCH' : 'CHANGED',
  }));
  const currentness = {
    denominators: topology,
    physicalCompositeConsumerCells: r6Currentness.physicalCompositeConsumerCells.map((cell) => ({ ...cell, sourceCurrentness: 'CURRENT' })),
  };
  const classification = classifyPdp0SuccessorImpact(pinComparisons, record, impactPath, currentness);
  assert.equal(classification?.classification, 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION');
  assert.equal(classification?.authoritySha256, authoritySha256);
  const currentnessProjection = projectMediaPdp0PinDriftClassifications([classification], pinComparisons);
  assert.equal(currentnessProjection[0].authoritySha256, authoritySha256);
  const successorTechnical = {
    ...r6Currentness,
    sourceContentDigests: currentDigests,
    phaseDisposition: { ...r6Currentness.phaseDisposition, historicalDefinitionStatus: 'DEV_COMPLETE', historicalOutstandingMeaningIds: [], currentSourceCurrentness: 'PASS', sourceCurrent: true },
    authority: { ...r6Currentness.authority, changedMeaningIds: [] },
    unclassifiedHistoricalPdp0PinChanges: [],
    externalOwnerContracts: { totalFiles: 30, digestMatches: 30, digestMismatches: [] },
  };
  const exactJoin = joinMediaPdp0PhaseExit({
    technicalCurrentness: successorTechnical, ownerAcceptance: record, ownerAcceptancePath: impactPath,
    historicalPdp0Exit: r6Exit, testOutcomes: outcomes,
  });
  assert.equal(exactJoin.ownerStatusJoin.status, 'CURRENT_SOURCE_WITH_INTERNAL_SUCCESSOR_IMPACT_DISPOSITION_NOT_OWNER_ACCEPTANCE');
  assert.equal(exactJoin.successorSourceImpactDisposition.authoritySha256, authoritySha256);
  assert.equal(exactJoin.ownerStatusJoin.successorImpact.authoritySha256, authoritySha256);
  assert.equal(exactJoin.phaseExit.delegatedOwnerAcceptance, 'NOT_CLAIMED_IMPACT_DISPOSITION_ONLY');
  for (const ownerAcceptancePath of [undefined, 'docs/implementation/observations/other.json']) {
    const wrongPathJoin = joinMediaPdp0PhaseExit({
      technicalCurrentness: successorTechnical, ownerAcceptance: record, ownerAcceptancePath,
      historicalPdp0Exit: r6Exit, testOutcomes: outcomes,
    });
    assert.equal(wrongPathJoin.ownerStatusJoin.status, 'BLOCKED');
    assert.ok(wrongPathJoin.phaseExit.blockers.includes('PDP0_R6_SUCCESSOR_IMPACT_INVALID'));
  }
  const missingPriorPxd163Join = joinMediaPdp0PhaseExit({
    technicalCurrentness: {
      ...successorTechnical,
      historicalPdp0PinDriftClassifications: successorTechnical.historicalPdp0PinDriftClassifications.filter((entry) => entry.path !== priorPxd163.sourcePath),
    },
    ownerAcceptance: record, ownerAcceptancePath: impactPath, historicalPdp0Exit: r6Exit, testOutcomes: outcomes,
  });
  assert.ok(missingPriorPxd163Join.phaseExit.blockers.includes('PDP0_R6_SUCCESSOR_PXD163_PREDECESSOR_CLASSIFICATION_MISSING'));
  const unreviewedExtraDeltaJoin = joinMediaPdp0PhaseExit({
    technicalCurrentness: {
      ...successorTechnical,
      sourceContentDigests: { ...currentDigests, [priorPxd163.sourcePath]: `sha256:${'0'.repeat(64)}` },
    },
    ownerAcceptance: record, ownerAcceptancePath: impactPath, historicalPdp0Exit: r6Exit, testOutcomes: outcomes,
  });
  assert.ok(unreviewedExtraDeltaJoin.phaseExit.blockers.includes('PDP0_R6_SUCCESSOR_UNREVIEWED_SOURCE_DELTA'));

  const invalidCases = [
    { ...record, recordId: 'OTHER' },
    { ...record, authority: { ...record.authority, userAuthorization: 'Authorize a different transition' } },
    { ...record, sourceDeltas: [{ ...record.sourceDeltas[0], predecessorSha256: `sha256:${'0'.repeat(64)}` }] },
    { ...record, sourceDeltas: [{ ...record.sourceDeltas[0], observedSha256: `sha256:${'0'.repeat(64)}` }] },
    { ...record, sourceDeltas: [{ ...record.sourceDeltas[0], phases: ['PDP-0'] }] },
    { ...record, sourceDeltas: [{ ...record.sourceDeltas[0], changedMeaningIds: ['PXD-163'] }] },
    { ...record, sourceDeltas: [{ ...record.sourceDeltas[0], freshCurrentnessRequired: false }] },
    { ...record, predecessorCuts: [{ ...record.predecessorCuts[0], exitSha256: `sha256:${'0'.repeat(64)}` }] },
    { ...record, predecessorCuts: [{ ...record.predecessorCuts[0], currentnessSha256: `sha256:${'0'.repeat(64)}` }] },
    { ...record, predecessorCuts: [{ ...record.predecessorCuts[0], materialPathCount: 145 }] },
    { ...record, predecessorCuts: [{ ...record.predecessorCuts[0], topology: { ...topology, totalCells: 49 } }] },
    { ...record, authority: { ...record.authority, externalContractOwnerAcceptanceProvided: true } },
    { ...record, decision: { ...record.decision, ownerAcceptance: 'ACCEPTED' } },
    { ...record, decision: { ...record.decision, independentSignoff: 'APPROVED' } },
    { ...record, decision: { ...record.decision, lifecycleClosure: 'CLOSED' } },
    { ...record, decision: { ...record.decision, runtime: 'ADMITTED' } },
    { ...record, decision: { ...record.decision, delivery: 'RELEASE_READY' } },
  ];
  for (const invalid of invalidCases) assert.equal(classifyPdp0SuccessorImpact(pinComparisons, invalid, impactPath, currentness), null);
  assert.equal(classifyPdp0SuccessorImpact(pinComparisons, record, 'docs/implementation/observations/other.json', currentness), null);
  assert.equal(classifyPdp0SuccessorImpact(pinComparisons.map((pin) => pin.path === 'scripts/report-media-pdp-readiness.mjs' ? { ...pin, currentDigest: `sha256:${'1'.repeat(64)}` } : pin), record, impactPath, currentness), null);
  assert.equal(classifyPdp0SuccessorImpact(pinComparisons, record, impactPath, { ...currentness, physicalCompositeConsumerCells: currentness.physicalCompositeConsumerCells.slice(1) }), null);
  const applicabilityChanged = currentness.physicalCompositeConsumerCells.map((cell, index) => index === 0
    ? { ...cell, applicability: { ...cell.applicability, rationale: 'changed' } } : cell);
  assert.equal(classifyPdp0SuccessorImpact(pinComparisons, record, impactPath, { ...currentness, physicalCompositeConsumerCells: applicabilityChanged }), null);
});

test('PDP-0 successor impact accepts only the authorized R8 test transition and rejects every second delta', () => {
  const r8ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r8.json';
  const r8CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r8.json';
  const impactPath = 'docs/implementation/observations/media-discovery-pdp0-r8-successor-impact-2026-10-14-r2.json';
  const r8Exit = read(r8ExitPath);
  const r8Currentness = read(r8CurrentnessPath);
  const record = read(impactPath);
  const currentDigests = { ...r8Exit.sourceCurrentness.sourceContentDigests,
    'tests/pdp-truth-domain.test.mjs': 'sha256:8ef1a6d5e11dc2e10ca32c3e6813fc8671c22a6c7f7038d48300d52f8feae578' };
  const pinComparisons = Object.keys(r8Exit.sourceCurrentness.sourceContentDigests).sort().map((sourcePath) => ({
    path: sourcePath,
    recordedDigest: r8Exit.sourceCurrentness.sourceContentDigests[sourcePath],
    currentDigest: currentDigests[sourcePath],
    disposition: currentDigests[sourcePath] === r8Exit.sourceCurrentness.sourceContentDigests[sourcePath] ? 'MATCH' : 'CHANGED',
  }));
  const technicalCurrentness = {
    ...r8Currentness,
    sourceContentDigests: currentDigests,
    materialPathDenominator: { uniquePaths: 146, sharedPaths: 111, cellSpecificPaths: 35 },
    physicalCompositeConsumerCells: r8Currentness.physicalCompositeConsumerCells.map((cell) => ({ ...cell, sourceCurrentness: 'CURRENT', blockers: [] })),
  };
  const classification = classifyPdp0SuccessorImpact(pinComparisons, record, impactPath, technicalCurrentness);
  assert.equal(classification?.classification, 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION');
  assert.equal(classification?.path, 'tests/pdp-truth-domain.test.mjs');
  assert.equal(classification?.predecessorSha256, 'sha256:0d94c83f6c081f2e67a4ba20752c0cdfff03f26ae1d9d87860d9ba97047964e0');
  assert.equal(classification?.observedSha256, 'sha256:8ef1a6d5e11dc2e10ca32c3e6813fc8671c22a6c7f7038d48300d52f8feae578');
  assert.equal(classification?.ownerAcceptance, 'NOT_CLAIMED');

  const joined = joinMediaPdp0PhaseExit({
    technicalCurrentness: {
      ...technicalCurrentness,
      phaseDisposition: { historicalDefinitionStatus: 'DEV_COMPLETE', historicalOutstandingMeaningIds: [], currentSourceCurrentness: 'PASS', sourceCurrent: true },
      authority: { changedMeaningIds: [] },
      unclassifiedHistoricalPdp0PinChanges: [],
      externalOwnerContracts: { totalFiles: 30, digestMatches: 30, digestMismatches: [] },
    },
    ownerAcceptance: record,
    ownerAcceptancePath: impactPath,
    historicalPdp0Exit: r8Exit,
    testOutcomes: outcomes,
  });
  assert.equal(joined.phaseExit.status, 'PASS');
  assert.equal(joined.ownerStatusJoin.predecessorExitRef, r8ExitPath);
  assert.equal(joined.ownerStatusJoin.predecessorPathCount, 146);
  assert.equal(joined.ownerStatusJoin.unchangedPathCount, 145);
  assert.equal(joined.ownerStatusJoin.internallyDispositionedChangedPathCount, 1);
  assert.equal(joined.ownerStatusJoin.unreviewedChangedPathCount, 0);
  assert.equal(joined.delegatedOwnerAcceptance.status, 'INTERNAL_SUCCESSOR_IMPACT_DISPOSITION_ONLY_NOT_OWNER_ACCEPTANCE');
  assert.equal(joined.phaseExit.delegatedOwnerAcceptance, 'NOT_CLAIMED_IMPACT_DISPOSITION_ONLY');
  assert.equal(joined.independentApproval, 'NOT_CLAIMED_AND_NOT_WAIVED');

  const wrongAuthority = structuredClone(record);
  wrongAuthority.authority.authorizationBasis = 'DIRECT_USER_QUOTE';
  assert.equal(classifyPdp0SuccessorImpact(pinComparisons, wrongAuthority, impactPath, technicalCurrentness), null);
  assert.equal(classifyPdp0SuccessorImpact(pinComparisons, record, 'docs/implementation/observations/other.json', technicalCurrentness), null);
  assert.equal(classifyPdp0SuccessorImpact(pinComparisons.map((pin) => pin.path === 'tests/pdp-truth-domain.test.mjs'
    ? { ...pin, currentDigest: `sha256:${'f'.repeat(64)}` } : pin), record, impactPath, technicalCurrentness), null);
  const extraPath = pinComparisons.find((pin) => pin.path !== 'tests/pdp-truth-domain.test.mjs').path;
  const secondDelta = pinComparisons.map((pin) => pin.path === 'tests/pdp-truth-domain.test.mjs'
    ? pin : pin.path === extraPath ? { ...pin, disposition: 'CHANGED', currentDigest: `sha256:${'e'.repeat(64)}` } : pin);
  assert.equal(classifyPdp0SuccessorImpact(secondDelta, record, impactPath, technicalCurrentness), null);
  assert.equal(classifyPdp0SuccessorImpact(pinComparisons.slice(1), record, impactPath, technicalCurrentness), null);
});
