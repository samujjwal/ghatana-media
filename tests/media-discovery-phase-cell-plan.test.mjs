import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const matrix = read('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
const topology = read('.product-experience/surfaces/media-physical-topology.v1.json');
const ownerEvidence = read('docs/implementation/observations/media-discovery-delegated-owner-evidence-2026-10-13.json');
const pdp1Exit = read('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json');
const pdp1CurrentCutExit = read('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r4.json');
const pdp1FailedAttempt = read('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r3.json');
const pdp2Exit = read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-13-r2.json');
const phases = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];
const requireTools = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const parseYaml = requireTools('yaml').parse;
const surfaceRegistry = parseYaml(fs.readFileSync(path.join(root, '.product-experience/surface-registry.yaml'), 'utf8'));

test('Discovery execution plan retains physical/composite/consumer denominators without double counting', () => {
  assert.equal(topology.manifestCandidates.length, 26);
  assert.equal(topology.compositions.filter(c => c.kind === 'SEMANTIC_COMPOSITION').length, 6);
  assert.equal(topology.compositions.filter(c => c.kind === 'REPOSITORY_ROOT').length, 1);
  assert.equal(topology.consumerCrosswalk.length, 17);
  const ids = [
    ...topology.manifestCandidates.map(x => x.surfaceId),
    ...topology.compositions.map(x => x.surfaceId),
    ...topology.consumerCrosswalk.map(x => x.surfaceId),
  ];
  assert.equal(new Set(ids).size, 50);
  assert.equal(matrix.cells.length, ids.length * phases.length);
  assert.equal(new Set(matrix.cells.map(x => x.cellId)).size, 200);
  assert.deepEqual(new Set(matrix.cells.map(x => x.surfaceId)), new Set(ids));
  for (const id of ids) {
    assert.deepEqual(matrix.cells.filter(x => x.surfaceId === id).map(x => x.phase), phases);
  }
});

test('Discovery plan binds fresh PDP-0 and PDP-1 exits while PDP-2 and PDP-3 remain gated', () => {
  const observation = read('docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r1.json');
  const phaseExit = read('docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r1.json');
  assert.equal(matrix.baseline.pdp0MaterialSetFingerprint, ownerEvidence.source.materialSetFingerprint);
  assert.equal(matrix.currentCut.currentnessObservation, 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r1.json');
  assert.equal(matrix.currentCut.phaseExit, 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r1.json');
  assert.equal(matrix.currentCut.repositoryHead, 'e9dd186786be08c00edd5a418078b8b3e1c8969c');
  assert.equal(matrix.currentCut.phaseExitRecordId, 'MEDIA-PDP0-EXIT-33ca9af86cb9');
  assert.equal(matrix.currentCut.materialSourceSetFingerprint, 'sha256:8a60cf8a09e671b09729563039d31aed69b21934a59cade1af9833ca9af86cb9');
  assert.equal(phaseExit.developmentStatus.currentMaterialSourceSetFingerprint, matrix.currentCut.materialSourceSetFingerprint);
  assert.equal(phaseExit.phaseExit.status, 'PASS');
  assert.equal(phaseExit.phaseExit.nextLegalAction, 'ADVANCE_TO_PDP1_MDC10');
  assert.equal(observation.physicalCompositeConsumerCells.length, 50);
  assert.ok(observation.physicalCompositeConsumerCells.every(x => x.sourceCurrentness === 'CURRENT'));
  assert.equal(phaseExit.sourceCurrentness.materialPathDenominator.uniquePaths, 146);
  assert.equal(phaseExit.developmentStatus.currentMaterialSourceSetFingerprint, 'sha256:8a60cf8a09e671b09729563039d31aed69b21934a59cade1af9833ca9af86cb9');
  const observedBySurface = new Map(observation.physicalCompositeConsumerCells.map(c => [c.surfaceId, c]));
  const pdp0Cells = matrix.cells.filter(c => c.phase === 'PDP-0');
  assert.ok(pdp0Cells.every(c => {
    const observed = observedBySurface.get(c.surfaceId);
    return c.currentnessAtReview === 'CURRENT'
      && c.currentPhaseExitPublished === true
      && c.currentPdp0SourceSetFingerprint === observed?.sourceSetFingerprint
      && c.currentPhaseExitRef === matrix.currentCut.phaseExit
      && c.currentPhaseExitRecordId === phaseExit.recordId
      && c.priorPassReceiptRemainsHistorical === true
      && c.nextLegalAction === 'PDP-0 current exit 2026-10-14-current-cut-r1 PASS; zero phase-local tasks remain.'
      && c.status === 'PDP0_CURRENT_PHASE_EXIT_PASS';
  }));
  assert.equal(pdp1Exit.phaseExit.status, 'PASS');
  assert.equal(pdp1Exit.sourceCurrentness.cells.length, 50);
  assert.equal(pdp1Exit.sourceCurrentness.cells.filter(c => c.sourceCurrentness === 'CURRENT').length, 50);
  assert.equal(pdp1Exit.sourceCurrentness.externalOwnerContracts.totalFiles, 30);
  assert.equal(pdp1Exit.sourceCurrentness.externalOwnerContracts.digestMatches, 30);
  assert.equal(pdp1Exit.testRun.outcomes[0].testCount, 68);
  assert.equal(pdp1Exit.testRun.outcomes[0].skippedCount, 0);
  assert.equal(pdp1Exit.phaseExit.exactCutOwnerAcceptance, 'NOT_RECORDED');
  assert.equal(pdp1Exit.independentApproval, 'NOT_CLAIMED_AND_NOT_WAIVED');
  assert.equal(pdp2Exit.currentPhaseExit.status, 'PASS');
  assert.equal(pdp2Exit.currentPhaseExit.exactCutOwnerAcceptance, 'NOT_RECORDED');
  assert.equal(pdp2Exit.independentApproval, 'NOT_CLAIMED_AND_NOT_WAIVED');
  assert.equal(pdp2Exit.sourceCurrentness.cells.length, 50);
  assert.equal(pdp2Exit.sourceCurrentness.cells.filter(c => c.sourceCurrentness === 'CURRENT').length, 50);
  assert.equal(pdp2Exit.historicalPinReview.changedPinCount, 4);
  assert.equal(pdp2Exit.catalogPopulations.matchesHistoricalStatus, true);
  assert.equal(pdp2Exit.requiredChecks.status, 'PASS');
  assert.equal(pdp2Exit.requiredChecks.outcomes.find(o => o.command.startsWith('node --test'))?.skippedCount, 0);
  assert.equal(pdp2Exit.accessibilityEvidenceBoundary.renderedAndAssistiveTechnologyAcceptance, 'NOT_RUN_NOT_CLAIMED');
  assert.equal(matrix.currentCut.pdp2PhaseExit, 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-13-r2.json');
  assert.equal(matrix.currentCut.pdp1PhaseExit, 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r4.json');
  assert.equal(matrix.currentCut.pdp1CurrentnessObservation, 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r4.json#sourceCurrentness');
  assert.equal(matrix.currentCut.pdp1PhaseExitRecordId, 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R4');
  assert.equal(matrix.currentCut.pdp1ObservedHead, '0bb739239cb97cb422daecc22756cf111dde0e7d');
  assert.equal(matrix.currentCut.pdp1MaterialSourceSetFingerprint, 'sha256:1da1c83eda4ad1f4bed0ad35c27564887ca06b05ea2251a7f1f8b49e1c9176d5');
  assert.equal(pdp1CurrentCutExit.predecessor.exitRef, matrix.currentCut.phaseExit);
  assert.equal(pdp1CurrentCutExit.phaseExit.status, 'PASS');
  assert.equal(pdp1CurrentCutExit.phaseExit.developmentStatus, 'DEV_COMPLETE');
  assert.equal(pdp1CurrentCutExit.phaseExit.exactCutOwnerAcceptance, 'NOT_RECORDED');
  assert.equal(pdp1CurrentCutExit.independentApproval, 'NOT_CLAIMED_AND_NOT_WAIVED');
  assert.equal(pdp1CurrentCutExit.sourceCurrentness.cells.length, 50);
  assert.equal(pdp1CurrentCutExit.sourceCurrentness.cells.filter(c => c.sourceCurrentness === 'CURRENT').length, 50);
  assert.equal(pdp1CurrentCutExit.sourceCurrentness.materialPathDenominator.uniquePaths, 329);
  assert.equal(pdp1CurrentCutExit.sourceCurrentness.externalOwnerContracts.totalFiles, 30);
  assert.equal(pdp1CurrentCutExit.sourceCurrentness.externalOwnerContracts.digestMatches, 30);
  assert.equal(pdp1CurrentCutExit.ownerStatusJoin.status, 'ACCEPTED_FOR_EXACT_CURRENT_FINGERPRINT_WITH_REVIEWED_DELTA');
  assert.deepEqual([
    pdp1CurrentCutExit.ownerStatusJoin.predecessorPathCount,
    pdp1CurrentCutExit.ownerStatusJoin.observedPathCount,
    pdp1CurrentCutExit.ownerStatusJoin.unchangedPathCount,
    pdp1CurrentCutExit.ownerStatusJoin.ownerApprovedChangedPathCount,
    pdp1CurrentCutExit.ownerStatusJoin.unapprovedChangedPathCount,
    pdp1CurrentCutExit.ownerStatusJoin.missingPathCount,
    pdp1CurrentCutExit.ownerStatusJoin.additionalPathCount,
    pdp1CurrentCutExit.ownerStatusJoin.meaningIdsChangedCount,
  ], [329, 329, 325, 4, 0, 0, 0, 0]);
  assert.equal(pdp1CurrentCutExit.testRun.outcomes.find(o => o.command === 'pnpm check:product-experience-local')?.status, 'PASS');
  assert.equal(pdp1CurrentCutExit.phaseExit.exactCutOwnerAcceptance, 'NOT_RECORDED');
  assert.equal(pdp1FailedAttempt.phaseExit.status, 'FAIL');
  assert.equal(pdp1FailedAttempt.testRun.sourceBinding.stable, false);
  assert.ok(pdp1FailedAttempt.phaseExit.blockers.includes('REQUIRED_PDP1_TEST_OR_PARITY_OUTCOME_INVALID'));
  const currentCutTests = pdp1CurrentCutExit.testRun.outcomes.find(o => o.command.startsWith('node --test'));
  assert.deepEqual([currentCutTests.testCount, currentCutTests.passedCount, currentCutTests.failedCount, currentCutTests.skippedCount], [68, 68, 0, 0]);
  const observedPdp1 = new Map(pdp1CurrentCutExit.sourceCurrentness.cells.map(c => [c.surfaceId, c]));
  assert.ok(matrix.cells.filter(c => c.phase === 'PDP-1').every(c => {
    const observed = observedPdp1.get(c.surfaceId);
    return c.currentnessAtReview === 'CURRENT'
      && c.currentPdp1SourceSetFingerprint === observed?.sourceSetFingerprint
      && c.sourceMaterialFingerprintAtReview === pdp1CurrentCutExit.developmentStatus.currentMaterialSourceSetFingerprint
      && c.currentPhaseExitPublished === true
      && c.currentPhaseExitRef === matrix.currentCut.pdp1PhaseExit
      && c.currentPhaseExitRecordId === pdp1CurrentCutExit.observationId
      && c.priorPassReceiptRemainsHistorical === true
      && c.remainingTaskIds.length === 0
      && c.nextLegalAction === pdp1CurrentCutExit.phaseExit.nextLegalAction
      && c.currentCutReviewedHead === pdp1CurrentCutExit.campaign.observedHead
      && c.latestTechnicalSourceCurrentness === 'CURRENT_TO_EXACT_CUT'
      && !Object.hasOwn(c, 'currentnessRecheckTaskId');
  }));
  const observedPdp2 = new Map(pdp2Exit.sourceCurrentness.cells.map(c => [c.surfaceId, c]));
  assert.ok(matrix.cells.filter(c => c.phase === 'PDP-2').every(c => {
    const observed = observedPdp2.get(c.surfaceId);
    return c.currentnessAtReview === 'CURRENT'
      && c.currentPdp2SourceSetFingerprint === observed?.sourceSetFingerprint
      && c.sourceMaterialFingerprintAtReview === pdp2Exit.sourceCurrentness.materialSourceSetFingerprint
      && c.currentPhaseExitPublished === true
      && c.currentPhaseExitRef === matrix.currentCut.pdp2PhaseExit
      && c.currentPhaseExitRecordId === pdp2Exit.observationId
      && c.remainingTaskIds.length === 0;
  }));
  for (const c of matrix.cells.filter(c => c.phase === 'PDP-3')) {
    assert.equal(c.currentnessAtReview, 'MDC30_REVIEWED_WITH_DEFINITION_GAPS');
    assert.equal(c.currentPhaseExitPublished, false);
    assert.equal(c.observedPdp3SourceSetFingerprint, matrix.currentCut.pdp3ObservedSourceSetFingerprint);
    assert.deepEqual(c.remainingTaskIds, ['MDC-30', 'MDC-31', 'MDC-32']);
  }
  assert.equal(matrix.status.pdp0, 'CURRENT_PHASE_EXIT_PASS');
  assert.equal(matrix.status.discovery, 'FAIL');
  assert.equal(matrix.status.pdp1, 'CURRENT_PHASE_EXIT_PASS');
  assert.equal(matrix.currentCut.latestPhaseCurrentnessStatus, 'PDP0_PDP1_CURRENT_PDP2_PDP3_NOT_REESTABLISHED');
  assert.equal(matrix.status.pdp2, 'PRIOR_EXIT_PASS_CURRENTCUT_RECHECK_REQUIRED');
  assert.ok(matrix.cells.filter(c => c.phase === 'PDP-2').every(c => c.currentCutReviewedHead !== pdp1CurrentCutExit.campaign.observedHead));
  assert.equal(matrix.currentCut.pdp2PhaseExit, 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-13-r2.json');
  assert.equal(matrix.status.pdp3, 'MDC30_29_OF_61_LOGICAL_32_GAPS_S06_OPEN_NO_CURRENT_EXIT');
  assert.equal(matrix.status.build, 'NOT_ENTERED');
  assert.equal(matrix.status.nativePdpClosure, 'NOT_ENTERED');
  assert.equal(matrix.status.delivery, 'BLOCKED');
});

test('Every phase cell has executable prescriptive links, owner, scope and no manufactured authoring backlog', () => {
  const topoById = new Map([
    ...topology.manifestCandidates,
    ...topology.compositions,
    ...topology.consumerCrosswalk,
  ].map(s => [s.surfaceId, s]));
  for (const c of matrix.cells) {
    assert.ok(c.owner && c.phaseTaskIds?.length > 0 && c.inspectWhere?.length > 0);
    assert.ok(c.what && c.how && c.acceptWhen && c.nextLegalAction);
    assert.equal(c.historicalDefinitionState, 'DEV_COMPLETE');
    assert.equal(c.historicalOutstandingMeaningIds, 0);
    const t = topoById.get(c.surfaceId);
    assert.ok(t);
    const actual = t.phaseApplicability?.[c.phase]?.disposition;
    const registry = c.surfaceKind === 'CONSUMER_BINDING'
      ? surfaceRegistry.surfaces.find(surface => surface.surfaceId === c.surfaceId)
      : undefined;
    const expected = c.surfaceKind !== 'CONSUMER_BINDING'
      ? actual
      : t.bindingState === 'ARCHIVED'
        ? 'NOT_APPLICABLE_ARCHIVED'
        : c.phase === 'PDP-3' && !registry?.applicablePdpArtifacts?.includes('PDP-3')
          ? 'UNKNOWN_OWNER_DECISION_PENDING'
          : 'APPLICABLE_CONSUMER_BINDING';
    assert.equal(c.phaseApplicabilityDisposition, expected);
    assert.deepEqual(c.phaseTaskIds, matrix.phaseTaskMap[c.phase]);
  }
});

test('MDC-30 records exact transition and state-binding gaps without promoting proposals', () => {
  const observation = read('docs/implementation/observations/media-discovery-pdp3-mdc30-currentness-2026-10-13-r1.json');
  const stepStateFinding = observation.findings.find(f => f.id === 'MDC30-STEP-STATE-BINDING-REVIEW');
  const records = parseYaml(fs.readFileSync(path.join(root, '.product-experience/pdp-3-product-experience/journey-transition-edge-bindings.yaml'), 'utf8')).records;
  const exact = records.filter(r => r.journeyActionDisposition?.startsWith('EXACT')).map(r => r.id);
  const unboundByDisposition = {};
  for (const record of records.filter(r => !r.journeyActionDisposition?.startsWith('EXACT'))) {
    (unboundByDisposition[record.transitionInvocationDisposition] ??= []).push(record.id);
  }

  assert.equal(stepStateFinding.severity, 'BLOCKER');
  assert.deepEqual(stepStateFinding.evidence.exactPdp3JourneyActionOperationBindingIds, exact);
  assert.equal(exact.length, 1);
  assert.deepEqual(stepStateFinding.evidence.unboundTransitionRecordIdsByDisposition, unboundByDisposition);
  assert.equal(Object.values(unboundByDisposition).flat().length, 54);
  assert.deepEqual(Object.fromEntries(Object.entries(unboundByDisposition).map(([k, v]) => [k, v.length])), {
    'P1_EVENT_TRIGGER_PENDING; NO_EXACT_PUBLIC_OPERATION_OR_JOURNEY_ACTION': 44,
    'AUTHORITY_SOURCE_EVENT_REQUIRED; PUBLIC_OPERATION_AND_TRANSPORT_EXPLICITLY_UNBOUND': 6,
    'P1_OPERATION_FAMILY_PROPOSAL_ONLY; NO_EXACT_ACTION_INVOCATION': 3,
    'P1_EXPLICITLY_NO_VERIFICATION_OPERATION_IDENTITY; NO_ROUTE_OR_RUNTIME_ADMISSION': 1,
  });
  const stateAudit = stepStateFinding.evidence.purposeBindingClassification;
  assert.equal(stateAudit.localOrPassiveNoDomainStateChange + stateAudit.readOnlyStateProjection
    + stateAudit.consequentialCommandOrWorkflow + stateAudit.externalSharedIdentityHandoffObservationWithoutMediaMutation, 118);
  assert.equal(stateAudit.consequentialCommandOrWorkflow, stateAudit.consequentialStepRefs.length);
  assert.equal(stateAudit.acceptedMappingStatus.startsWith('NOT_ESTABLISHED'), true);
});

test('PDP-3 consumer cells bind registry owners and contracts while preserving unresolved applicability', () => {
  const topologyById = new Map(topology.consumerCrosswalk.map((surface, index) => [surface.surfaceId, { ...surface, index }]));
  const matrixById = new Map(matrix.cells.filter(cell => cell.phase === 'PDP-3' && cell.surfaceKind === 'CONSUMER_BINDING')
    .map(cell => [cell.surfaceId, cell]));
  assert.equal(matrixById.size, 17);
  for (const [registryIndex, registered] of surfaceRegistry.surfaces.entries()) {
    const crosswalk = topologyById.get(registered.surfaceId);
    const cell = matrixById.get(registered.surfaceId);
    if (!crosswalk || !cell) continue;
    const expectedDisposition = crosswalk.bindingState === 'ARCHIVED'
      ? 'NOT_APPLICABLE_ARCHIVED'
      : registered.applicablePdpArtifacts.includes('PDP-3')
        ? 'APPLICABLE_CONSUMER_BINDING'
        : 'UNKNOWN_OWNER_DECISION_PENDING';
    assert.deepEqual(cell.owner, registered.owners, `${registered.surfaceId} owner trace`);
    assert.deepEqual(cell.consumedPhysicalRefs, crosswalk.physicalRefs ?? [], `${registered.surfaceId} physical crosswalk`);
    assert.deepEqual(cell.phaseApplicabilityAuthorityRefs, [
      `.product-experience/surface-registry.yaml#/surfaces/${registryIndex}`,
      `.product-experience/surfaces/media-physical-topology.v1.json#/consumerCrosswalk/${crosswalk.index}`,
    ]);
    assert.ok(cell.parentSourceAuthorityRefs.includes(registered.contractAuthority));
    assert.ok(cell.inspectWhere.includes(registered.contractAuthority));
    assert.equal(cell.phaseApplicabilityDisposition, expectedDisposition);
    assert.match(cell.nextLegalAction, /MDC-30/u);
    assert.match(cell.nextLegalAction, /MDC-31.*MDC-32/u);
  }
  const integrations = matrixById.get('media.surface.integrations');
  assert.match(integrations.phaseApplicabilityRationale, /omits PDP-3/u);
  assert.match(integrations.phaseApplicabilityRationale, /journeys reference/u);
  assert.equal(matrixById.get('media.surface.desktop-archive').phaseApplicabilityDisposition, 'NOT_APPLICABLE_ARCHIVED');
});

test('PDP-1 composition and consumer cells trace exact canonical authority, owners, and topology crosswalks', () => {
  const registryText = fs.readFileSync(path.join(root, '.product-experience/surface-registry.yaml'), 'utf8');
  const registryRecords = new Map([...registryText.matchAll(/^  - surfaceId: (.+)\n([\s\S]*?)(?=^  - surfaceId:|^channelSurfaceProposals:|$(?![\s\S]))/gm)]
    .map((match, index) => {
      const ownerMatch = match[2].match(/^    owners: \[(.*?)\]$/m);
      const applicabilityMatch = match[2].match(/^    applicablePdpArtifacts: \[(.*?)\]$/m);
      return [match[1], {
        index,
        owners: ownerMatch ? ownerMatch[1].split(',').map(owner => owner.trim()) : [],
        applicablePdpArtifacts: applicabilityMatch ? applicabilityMatch[1].split(',').map(phase => phase.trim()) : [],
      }];
    }));
  const cells = new Map(matrix.cells.filter(c => c.phase === 'PDP-1').map(c => [c.surfaceId, c]));

  const compositions = topology.compositions.filter(c => c.kind === 'SEMANTIC_COMPOSITION');
  assert.equal(compositions.length, 6);
  for (const composition of compositions) {
    const cell = cells.get(composition.surfaceId);
    const applicability = composition.phaseApplicability['PDP-1'];
    assert.equal(cell.surfaceKind, 'SEMANTIC_COMPOSITION');
    assert.equal(cell.owner, composition.canonicalOwner);
    assert.equal(cell.phaseApplicabilityDisposition, applicability.disposition);
    assert.deepEqual(cell.parentSourceAuthorityRefs, [applicability.authorityRef, applicability.objectAuthorityRef]);
    assert.ok(cell.inspectWhere.includes(applicability.authorityRef));
    assert.ok(cell.inspectWhere.includes(applicability.objectAuthorityRef));
    assert.equal(cell.currentnessAtReview, 'CURRENT');
    assert.equal(cell.currentPhaseExitPublished, true);
    assert.equal(cell.remainingTaskIds.length, 0);
  }

  const rootSurface = topology.compositions.find(c => c.kind === 'REPOSITORY_ROOT');
  const rootCell = cells.get(rootSurface.surfaceId);
  assert.equal(rootCell.phaseApplicabilityDisposition, rootSurface.phaseApplicability['PDP-1'].disposition);
  assert.deepEqual(rootCell.parentSourceAuthorityRefs, [rootSurface.phaseApplicability['PDP-1'].authorityRef]);
  assert.deepEqual(rootSurface.phaseApplicability['PDP-1'].domainObjectIds, []);

  assert.equal(topology.consumerCrosswalk.length, 17);
  for (const [crosswalkIndex, crosswalk] of topology.consumerCrosswalk.entries()) {
    const { owners, applicablePdpArtifacts, index: surfaceIndex } = registryRecords.get(crosswalk.surfaceId);
    const cell = cells.get(crosswalk.surfaceId);
    const archived = crosswalk.bindingState === 'ARCHIVED';
    assert.equal(cell.surfaceKind, 'CONSUMER_BINDING');
    assert.deepEqual(cell.owner, owners, crosswalk.surfaceId);
    assert.equal(cell.ownerAuthorityRef, `.product-experience/surface-registry.yaml#/surfaces/${surfaceIndex}`);
    assert.deepEqual(cell.consumerCrosswalkRefs, crosswalk.physicalRefs, crosswalk.surfaceId);
    assert.equal(cell.consumerCrosswalkAuthorityRef, `.product-experience/surfaces/media-physical-topology.v1.json#/consumerCrosswalk/${crosswalkIndex}`);
    assert.equal(cell.phaseApplicabilityDisposition, archived ? 'NOT_APPLICABLE_ARCHIVED' : 'APPLICABLE_CONSUMER_BINDING');
    assert.equal(applicablePdpArtifacts.includes('PDP-1'), !archived, crosswalk.surfaceId);
    assert.equal(cell.currentnessAtReview, 'CURRENT');
    assert.equal(cell.currentPhaseExitPublished, true);
    assert.equal(cell.remainingTaskIds.length, 0);
    assert.equal(cell.status, 'PDP1_CURRENT_PHASE_EXIT_PASS');
  }
});

test('PDP-2 cells bind exact surface owners and applicability to topology and consumer registry', () => {
  const registry = parseYaml(fs.readFileSync(path.join(root, '.product-experience/surface-registry.yaml'), 'utf8'));
  const registryById = new Map(registry.surfaces.map((surface, index) => [surface.surfaceId, {
    ...surface,
    authorityRef: `.product-experience/surface-registry.yaml#/surfaces/${index}`,
  }]));
  const physicalById = new Map(topology.manifestCandidates.map((surface, index) => [surface.surfaceId, {
    ...surface,
    authorityRef: `.product-experience/surfaces/media-physical-topology.v1.json#/manifestCandidates/${index}`,
  }]));
  const compositionById = new Map(topology.compositions.map((surface, index) => [surface.surfaceId, {
    ...surface,
    authorityRef: `.product-experience/surfaces/media-physical-topology.v1.json#/compositions/${index}`,
  }]));
  const crosswalkById = new Map(topology.consumerCrosswalk.map((surface, index) => [surface.surfaceId, {
    ...surface,
    topologyRef: `.product-experience/surfaces/media-physical-topology.v1.json#/consumerCrosswalk/${index}`,
  }]));
  const cells = matrix.cells.filter(cell => cell.phase === 'PDP-2');
  assert.equal(cells.length, 50);
  for (const cell of cells) {
    const physical = physicalById.get(cell.surfaceId);
    const composition = compositionById.get(cell.surfaceId);
    const crosswalk = crosswalkById.get(cell.surfaceId);
    if (physical) {
      const applicability = physical.phaseApplicability['PDP-2'];
      assert.equal(cell.surfaceKind, 'PHYSICAL_CANDIDATE');
      assert.equal(cell.owner, physical.owner);
      assert.equal(cell.ownerAuthorityRef, physical.authorityRef);
      assert.equal(cell.phaseApplicabilityDisposition, applicability.disposition);
      assert.equal(cell.phaseApplicabilityRationale, applicability.rationale);
      assert.equal(cell.surfaceDispositionRationale, physical.dispositionRationale);
      assert.deepEqual(cell.consumerCrosswalkRefs, physical.consumerSurfaceRefs ?? []);
      assert.deepEqual(cell.linkedConsumerApplicability.map(link => link.surfaceId), physical.consumerSurfaceRefs ?? []);
      for (const ref of applicability.authorityRefs ?? []) assert.ok(cell.parentSourceAuthorityRefs.includes(ref));
      if (applicability.disposition === 'NOT_APPLICABLE') {
        assert.ok(applicability.rationale.trim());
        assert.ok(cell.phaseApplicabilityAuthorityRefs.length > 0);
        if (physical.disposition === 'PHYSICAL') {
          assert.ok(physical.dispositionRationale.trim());
          assert.ok(cell.linkedConsumerApplicability.length > 0);
          assert.ok(cell.linkedConsumerApplicability.every(link => link.disposition === 'APPLICABLE_CONSUMER_BINDING' && link.authorityRef && link.rationale));
        }
      }
    } else if (composition) {
      const applicability = composition.phaseApplicability['PDP-2'];
      assert.equal(cell.surfaceKind, composition.kind === 'REPOSITORY_ROOT' ? 'REPOSITORY_ROOT' : 'SEMANTIC_COMPOSITION');
      assert.equal(cell.owner, composition.canonicalOwner);
      assert.equal(cell.ownerAuthorityRef, composition.authorityRef);
      assert.equal(cell.phaseApplicabilityDisposition, applicability.disposition);
      assert.equal(cell.phaseApplicabilityRationale, applicability.rationale);
      for (const ref of applicability.authorityRefs ?? []) assert.ok(cell.parentSourceAuthorityRefs.includes(ref));
    } else {
      assert.ok(crosswalk, `missing consumer crosswalk ${cell.surfaceId}`);
      const registered = registryById.get(cell.surfaceId);
      assert.ok(registered, `missing consumer registry ${cell.surfaceId}`);
      const archived = crosswalk.bindingState === 'ARCHIVED';
      assert.equal(cell.surfaceKind, 'CONSUMER_BINDING');
      assert.deepEqual(cell.owner, registered.owners);
      assert.equal(cell.ownerAuthorityRef, registered.authorityRef);
      assert.deepEqual(cell.phaseApplicabilityAuthorityRefs, [registered.authorityRef, crosswalk.topologyRef]);
      assert.deepEqual(cell.linkedPhysicalSurfaces.map(link => link.surfaceId).sort(), [...(crosswalk.physicalRefs ?? [])].sort());
      assert.equal(cell.phaseApplicabilityDisposition, archived ? 'NOT_APPLICABLE_ARCHIVED' : 'APPLICABLE_CONSUMER_BINDING');
      assert.equal(registered.applicablePdpArtifacts.includes('PDP-2'), !archived);
      assert.ok(cell.phaseApplicabilityRationale.trim());
    }
    assert.equal(cell.currentnessAtReview, 'CURRENT');
    assert.equal(cell.currentPhaseExitPublished, true);
    assert.equal(cell.currentPhaseExitRef, matrix.currentCut.pdp2PhaseExit);
    assert.equal(cell.remainingTaskIds.length, 0);
  }
});

test('machine owner acceptance is an exact source-bound input, never a phase-exit or independent review', () => {
  const approval = read('docs/implementation/observations/media-discovery-delegated-owner-acceptance-pdp0-2026-10-13.json');
  const observation = read('docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-13.json');
  assert.equal(approval.subject.phase, 'PDP-0');
  assert.equal(approval.subject.materialSourceSetFingerprint, observation.materialSourceSetFingerprint);
  assert.equal(approval.subject.surfaceScope.totalPhaseCells, 50);
  assert.equal(approval.subject.observedTechnicalCurrentCells, 50);
  assert.equal(approval.subject.outstandingMeaningIds.length, 0);
  assert.equal(approval.decision.internalDevelopmentDefinitionAcceptance, 'APPROVED_FOR_REUSE');
  assert.equal(approval.decision.actualPhaseExitStatus, 'NOT_PUBLISHED');
  assert.equal(approval.decision.canAdvanceToPdp1, false);
  assert.equal(approval.authority.humanIndependentSignatureProvided, false);
  assert.equal(approval.authority.qualifiedExternalSpecialistSignoffProvided, false);
});
