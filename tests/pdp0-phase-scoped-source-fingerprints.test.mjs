import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprint, fingerprintPxdDecisionSection, projectPdp0DirectCriterionReviews,
  pdp0OwnerCandidateClaimIds, projectPdp0OwnerCandidates, projectPdp0OwnerTargetObservations,
  projectPdp0SourceManifest,
} from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';

function artifact(artifactId, owningPhase, dependencies = []) {
  return {artifactId, title: artifactId, owner: 'media', authorityClass: owningPhase, owningPhase,
    path: `.product-experience/${artifactId}.yaml`, surfaceIds: [], semanticStatus: 'DRAFT',
    generatedOrAuthored: 'AUTHORED', generatedFrom: ['canonical-source-file'], dependencyBasis: 'explicit',
    dependencies, dependents: ['ignored-downstream-dependent'], schema: 'pdp.artifact.v1',
    verification: 'SOURCE_ONLY', acceptanceState: 'PENDING', explorerProjection: 'SOURCE_RECORD',
    semanticFingerprint: {status: 'PENDING', contentSha256: 'abc', contentFingerprintSemantics: 'provenance only'}, legacyPlanTaskRefs: []};
}

function manifestFixture() {
  return {
    schemaVersion: 'media.source-manifest.v2', productId: 'media',
    authorityModel: {canonicalPdpPhases: ['PDP-0','PDP-1','PDP-2','PDP-3'], explorerOutsidePdpPhases: true,
      canonicalLocationPolicy: 'repository-relative-only', semanticFingerprintAuthority: 'kernel', currentnessAuthority: 'lifecycle'},
    migrationReference: {title: 'Migration', path: 'migration.md', classification: 'REFERENCE', executionRole: 'PLAN', semanticAuthority: false},
    externalOwnerObservations: {status: 'SOURCE_OBSERVATION_ONLY', repositories: [
      {repositoryId: 'ghatana-tools', available: true, revision: 'tools-1', workingTree: 'CLEAN', files: [{path: 'tools/a', sha256: 'a'}]},
      {repositoryId: 'unreferenced', available: true, revision: 'other-1', workingTree: 'CLEAN', files: [{path: 'other/a', sha256: 'x'}]},
    ]},
    supplementalDecisionReference: {title: 'Overlay', path: 'overlay.md', classification: 'ACCEPTED'},
    productArtifactIndex: {status: 'generated', authoritySource: 'authority.yaml', taskDependencySource: 'traceability.yaml', generator: 'generate.mjs', records: [
      artifact('P0-A', 'PDP-0', ['P0-B', 'P1-C']), artifact('P0-B', 'PDP-0'), artifact('P1-C', 'PDP-1', ['P0-A']),
    ]},
  };
}

test('PDP-0 manifest projection ignores P1 records, edges, and unreferenced repositories while retaining P0 edges and referenced external evidence', () => {
  const decisions = {decisions: [{id: 'reuse', sourceObservation: 'source-manifest.yaml#externalOwnerObservations/ghatana-tools'}]};
  const baseline = projectPdp0SourceManifest(manifestFixture(), decisions);
  const changedDownstream = manifestFixture();
  changedDownstream.productArtifactIndex.records.find(row => row.artifactId === 'P1-C').dependencies = ['P0-B'];
  changedDownstream.productArtifactIndex.records.push(artifact('P1-D', 'PDP-1', ['P1-C']));
  changedDownstream.externalOwnerObservations.repositories.find(row => row.repositoryId === 'unreferenced').revision = 'other-2';
  assert.equal(fingerprint(projectPdp0SourceManifest(changedDownstream, decisions)), fingerprint(baseline));
  assert.deepEqual(baseline.productArtifactIndex.records.find(row => row.artifactId === 'P0-A').dependencies, ['P0-B']);

  const p0EdgeChange = manifestFixture();
  p0EdgeChange.productArtifactIndex.records.find(row => row.artifactId === 'P0-A').dependencies = [];
  assert.notEqual(fingerprint(projectPdp0SourceManifest(p0EdgeChange, decisions)), fingerprint(baseline));
  const downstreamDependentChange = manifestFixture();
  downstreamDependentChange.productArtifactIndex.records.find(row => row.artifactId === 'P0-A').dependents = ['another-p1-artifact'];
  assert.equal(fingerprint(projectPdp0SourceManifest(downstreamDependentChange, decisions)), fingerprint(baseline));
  const externalChange = manifestFixture();
  externalChange.externalOwnerObservations.repositories.find(row => row.repositoryId === 'ghatana-tools').revision = 'tools-2';
  assert.notEqual(fingerprint(projectPdp0SourceManifest(externalChange, decisions)), fingerprint(baseline));
  const missingEvidence = manifestFixture();
  missingEvidence.externalOwnerObservations.repositories = missingEvidence.externalOwnerObservations.repositories.filter(row => row.repositoryId !== 'ghatana-tools');
  assert.throws(() => projectPdp0SourceManifest(missingEvidence, decisions), /missing external-owner evidence/);
  const missingDependency = manifestFixture();
  missingDependency.productArtifactIndex.records[0].dependencies.push('MISSING');
  assert.throws(() => projectPdp0SourceManifest(missingDependency, decisions), /missing dependency/);
  const unknown = manifestFixture();
  unknown.authorityModel.newPdp1OnlyField = true;
  assert.throws(() => projectPdp0SourceManifest(unknown, decisions), /unclassified field/);
});

test('anchored PXD digest excludes later appended decisions but detects edits to the exact section', () => {
  const log = '# Decisions\n\n### PXD-101 — A\nA precise decision.\n\n### PXD-102 — B\nAnother decision.\n';
  const baseline = fingerprintPxdDecisionSection(log, 'PXD-101');
  const appended = `${log}\n### PXD-103 — Later\nNew unrelated decision.\n`;
  assert.equal(fingerprintPxdDecisionSection(appended, 101).sha256, baseline.sha256);
  const changed = log.replace('A precise decision.', 'A materially different decision.');
  assert.notEqual(fingerprintPxdDecisionSection(changed, 101).sha256, baseline.sha256);
  assert.throws(() => fingerprintPxdDecisionSection(log, 'PXD-999'), /found 0/);
  assert.throws(() => fingerprintPxdDecisionSection(`${log}\n### PXD-101 — duplicate\n`, 101), /found 2/);
});

function criterion(taskId, scope = `${taskId} exact scope`) {
  return {taskId, status: 'APPROVED_DIRECT_DEFINITION_CRITERION', scope,
    sourceFingerprints: {'.product-experience/pdp-0-product-truth/requirements.yaml': 'p0-hash', 'tests/pdp1-operation.test.mjs': 'p1-test-hash', '.product-experience/decision-log.md': 'global-log-hash'},
    currentCorrectiveReview: {status: 'APPROVED_CURRENT_SOURCE_REVIEW', decisionRef: `.product-experience/decision-log.md#${taskId}`, phaseScope: 'PDP-0',
      sourceFingerprints: {
        '.product-experience/decision-log.md': 'whole-log',
        '.product-experience/source-manifest.yaml': 'whole-manifest',
        'docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json': 'whole-candidate',
        '.product-experience/gaps.yaml': 'global-gap-view',
        'docs/PRODUCT-DEFINITION-COVERAGE.md': 'generated-coverage',
        'apps/media-experience-explorer/specification-artifacts.json': 'explorer-projection',
        '.product-experience/pdp-1-domain-data/operations.yaml': 'downstream-source',
        '.product-experience/pdp-0-product-truth/capabilities.yaml': 'p0-capabilities',
      }}};
}

test('direct-criterion projection excludes non-P0 records and responds to P0 source-review changes', () => {
  const source = {schemaVersion: 'v1', decisionRef: 'global', authority: 'coordinator', records: [criterion('P1-01'), criterion('P0-07'), criterion('P0-01')]};
  const owner = file => file === 'tests/pdp1-operation.test.mjs' || file === '.product-experience/pdp-1-domain-data/operations.yaml' ? 'PDP-1' : undefined;
  const baseline = projectPdp0DirectCriterionReviews(source, owner);
  assert.deepEqual(Object.keys(baseline.records.find(row => row.taskId === 'P0-07').currentCorrectiveReview.sourceFingerprints),
    ['.product-experience/pdp-0-product-truth/capabilities.yaml']);
  const p1Change = structuredClone(source);
  p1Change.records[0].scope = 'different PDP-1 scope';
  p1Change.records.find(row => row.taskId === 'P0-07').sourceFingerprints['tests/pdp1-operation.test.mjs'] = 'new-p1-test-hash';
  p1Change.records.find(row => row.taskId === 'P0-07').sourceFingerprints['.product-experience/decision-log.md'] = 'new-global-log-hash';
  p1Change.records.find(row => row.taskId === 'P0-07').currentCorrectiveReview.sourceFingerprints['.product-experience/pdp-1-domain-data/operations.yaml'] = 'new-downstream-source';
  assert.equal(fingerprint(projectPdp0DirectCriterionReviews(p1Change, owner)), fingerprint(baseline));
  const p0Change = structuredClone(source);
  p0Change.records.find(row => row.taskId === 'P0-07').scope = 'changed P0 meaning';
  assert.notEqual(fingerprint(projectPdp0DirectCriterionReviews(p0Change, owner)), fingerprint(baseline));
  const namedP0Source = structuredClone(source);
  namedP0Source.records.find(row => row.taskId === 'P0-01').sourceFingerprints['tests/pdp1-p0-source-assertion.test.mjs'] = 'p0-named-source';
  namedP0Source.records.find(row => row.taskId === 'P0-01').sourceFingerprints['tests/pdp2-unknown-owner.test.mjs'] = 'unknown-source';
  const namedOwner = file => file === 'tests/pdp1-p0-source-assertion.test.mjs' ? 'PDP-0' : owner(file);
  const namedProjection = projectPdp0DirectCriterionReviews(namedP0Source, namedOwner);
  const namedPins = namedProjection.records.find(row => row.taskId === 'P0-01').sourceFingerprints;
  assert.equal(namedPins['tests/pdp1-p0-source-assertion.test.mjs'], 'p0-named-source', 'a declared P0 owner remains gating despite its filename');
  assert.equal(namedPins['tests/pdp2-unknown-owner.test.mjs'], 'unknown-source', 'an unknown owner remains gating despite its filename');
  const unknown = structuredClone(source);
  unknown.records.find(row => row.taskId === 'P0-01').unclassified = true;
  assert.throws(() => projectPdp0DirectCriterionReviews(unknown), /unclassified field/);
});

test('direct-criterion projection validates bounded P0 current-source pin and quality-projection refreshes', () => {
  const hash = 'a'.repeat(64);
  const sourcePins = {'source.yaml': hash};
  const pinRefresh = decision => ({status: 'CURRENT_SOURCE_PIN_REFRESH_ONLY', phaseScope: 'PDP-0',
    decisionContextRef: `.product-experience/decision-log.md#${decision}`, preservesReviewRef: '.product-experience/decision-log.md#PXD-196',
    predecessorSourceFingerprints: sourcePins, currentSourceFingerprints: sourcePins,
    scopedClauseFingerprints: [{sourceRef: 'source.yaml#clause', claimIdentities: ['CLAIM-1'], predecessorSha256: hash, currentSha256: hash}],
    semanticReview: 'NOT_PERFORMED', ownerApproval: 'NOT_CLAIMED', acceptanceEffect: 'none',
    decisionContextFingerprint: {sourceRef: `.product-experience/decision-log.md#${decision}-section`, sha256: hash}});
  const changedJoins = [
    ...['media.compose.multitrack-timeline', 'media.compose.reusable-composition', 'media.compose.safe-area'].map(capabilityId => ({capabilityId,
      previousInputArtifactTypesSha256: hash, currentInputArtifactTypesSha256: hash,
      previousOutputArtifactTypesSha256: 'b'.repeat(64), currentOutputArtifactTypesSha256: hash})),
    {capabilityId: 'media.speech.synthesis.speaker.condition', previousInputArtifactTypesSha256: 'b'.repeat(64), currentInputArtifactTypesSha256: hash,
      previousOutputArtifactTypesSha256: hash, currentOutputArtifactTypesSha256: hash},
    {capabilityId: 'media.master.audio.stereo-width', previousInputArtifactTypesSha256: 'b'.repeat(64), currentInputArtifactTypesSha256: hash,
      previousOutputArtifactTypesSha256: hash, currentOutputArtifactTypesSha256: hash},
  ];
  const projectionRefresh = {status: 'CURRENT_PDP0_QUALITY_PROJECTION_REFRESH', phaseScope: 'PDP-0',
    decisionContextRefs: ['.product-experience/decision-log.md#PXD-207', '.product-experience/decision-log.md#PXD-208'],
    preservesReviewRef: '.product-experience/decision-log.md#PXD-196',
    projectionArtifactRef: 'docs/implementation/verification/pdp-38/p0-quality-current-source-review-current.json', projectionArtifactSha256: hash,
    sourceFingerprints: sourcePins,
    decisionContextFingerprints: {'.product-experience/decision-log.md#PXD-207-section': hash, '.product-experience/decision-log.md#PXD-208-section': hash},
    changedJoins, semanticDecision: 'NOT_MADE', ownerApproval: 'NOT_CLAIMED', acceptanceEffect: 'none'};
  const source = {schemaVersion: 'v1', decisionRef: 'global', authority: 'coordinator', records: [
    {...criterion('P0-02'), currentSourcePinRefresh: pinRefresh('PXD-207')},
    {...criterion('P0-05'), currentSourcePinRefresh: pinRefresh('PXD-208')},
    {...criterion('P0-06'), currentProjectionRefresh: projectionRefresh}, criterion('P0-07'),
  ]};
  const baseline = projectPdp0DirectCriterionReviews(source);
  assert.equal(baseline.records.find(row => row.taskId === 'P0-02').currentSourcePinRefresh.semanticReview, 'NOT_PERFORMED');
  assert.equal(baseline.records.find(row => row.taskId === 'P0-06').currentProjectionRefresh.changedJoins.length, 5);
  const falseCurrentness = structuredClone(source);
  falseCurrentness.records.find(row => row.taskId === 'P0-02').currentSourcePinRefresh.scopedClauseFingerprints[0].currentSha256 = 'c'.repeat(64);
  assert.throws(() => projectPdp0DirectCriterionReviews(falseCurrentness), /non-equal currentness/);
  const misplacedRefresh = structuredClone(source);
  misplacedRefresh.records.push({...criterion('P0-04'), currentSourcePinRefresh: pinRefresh('PXD-208')});
  assert.throws(() => projectPdp0DirectCriterionReviews(misplacedRefresh), /cannot carry currentSourcePinRefresh/);
  const wrongPhaseReview = structuredClone(source);
  wrongPhaseReview.records[0].currentCorrectiveReview.phaseScope = 'PDP-1';
  assert.throws(() => projectPdp0DirectCriterionReviews(wrongPhaseReview), /current review must declare PDP-0 phaseScope/);
});

test('P0-07 currentness refresh is limited to unchanged import channel and identity clauses', () => {
  const hash = 'a'.repeat(64);
  const predecessor = {
    '.product-experience/pdp-0-product-truth/capabilities.yaml': hash,
    '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml': hash,
    '.product-experience/pdp-0-product-truth/applications-channels.yaml': hash,
    '.product-experience/pdp-0-product-truth/requirements.yaml': hash,
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json': hash,
    '.product-experience/decision-log.md#PXD-196-section': hash,
  };
  const current = {...predecessor};
  delete current['.product-experience/decision-log.md#PXD-196-section'];
  current['docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json'] = hash;
  current['.product-experience/decision-log.md#PXD-209-section'] = hash;
  const refresh = {status: 'CURRENT_SOURCE_PIN_REFRESH_ONLY', phaseScope: 'PDP-0', decisionContextRef: '.product-experience/decision-log.md#PXD-209',
    preservesReviewRef: '.product-experience/decision-log.md#PXD-196', predecessorSourceFingerprints: predecessor, currentSourceFingerprints: current,
    decisionContextFingerprint: {sourceRef: '.product-experience/decision-log.md#PXD-209-section', sha256: hash},
    scopedClauseFingerprints: [
      {sourceRef: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@capabilityRef=media.artifact.import/channelApplicability',
        claimIdentities: ['media.artifact.import'], predecessorSha256: 'b2cd8ef702d6f2fdadc205b4bc645599692eea15c47cf113ebc5e728321cffef', currentSha256: 'b2cd8ef702d6f2fdadc205b4bc645599692eea15c47cf113ebc5e728321cffef'},
      {sourceRef: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@capabilityRef=media.artifact.import/{requirementRefs,profileRef,boundsRef}',
        claimIdentities: ['media.artifact.import'], predecessorSha256: 'e8e181a315742cbe359740b3f74afa3e395ecdb027a152b6058f7717c8aa8098', currentSha256: 'e8e181a315742cbe359740b3f74afa3e395ecdb027a152b6058f7717c8aa8098'},
    ], crosswalkImpact: 'AUD-ASSET-012 import/export mapping adds no channel-applicability meaning',
    semanticReview: 'NOT_PERFORMED', ownerApproval: 'NOT_CLAIMED', acceptanceEffect: 'none'};
  const source = {schemaVersion: 'v1', decisionRef: 'global', authority: 'coordinator', records: [
    {...criterion('P0-07'), currentSourcePinRefresh: refresh},
  ]};
  const projected = projectPdp0DirectCriterionReviews(source);
  assert.equal(projected.records[0].currentSourcePinRefresh.crosswalkImpact, refresh.crosswalkImpact);
  const changedClause = structuredClone(source);
  changedClause.records[0].currentSourcePinRefresh.scopedClauseFingerprints[0].currentSha256 = 'c'.repeat(64);
  assert.throws(() => projectPdp0DirectCriterionReviews(changedClause), /non-equal currentness/);
  const changedBoundary = structuredClone(source);
  changedBoundary.records[0].currentSourcePinRefresh.semanticReview = 'APPROVED';
  assert.throws(() => projectPdp0DirectCriterionReviews(changedBoundary), /bounded status or authority boundary/);
});

test('owner-target observation projection ignores downstream target rows and retains exact P0 target observations', () => {
  const source = {schemaVersion: 'v1', scope: 'mixed phase observations', decisionRef: 'PXD-195', records: [
    {claimId: 'P0-TARGET', targetRef: '.product-experience/pdp-0-product-truth/requirements.yaml#/requirements/@id=REQ-1',
      currentTargetValueSha256: 'p0-value', disposition: 'OBSERVED'},
    {claimId: 'P1-TARGET', targetRef: '.product-experience/pdp-1-domain-data/operations.yaml#/operations/@id=OP-1',
      currentTargetValueSha256: 'p1-value', disposition: 'OBSERVED'},
  ]};
  const baseline = projectPdp0OwnerTargetObservations(source);
  const downstreamChanged = structuredClone(source);
  downstreamChanged.decisionRef = 'PXD-201';
  downstreamChanged.scope = 'new mixed phase scope';
  downstreamChanged.records[1].currentTargetValueSha256 = 'new P1 value';
  assert.equal(fingerprint(projectPdp0OwnerTargetObservations(downstreamChanged)), fingerprint(baseline));
  const p0Changed = structuredClone(source);
  p0Changed.records[0].currentTargetValueSha256 = 'new P0 value';
  assert.notEqual(fingerprint(projectPdp0OwnerTargetObservations(p0Changed)), fingerprint(baseline));

});

function candidateRecord(claimId, ownerPhase, {p1Observation = 'old', p0Text = 'exact P0 claim'} = {}) {
  return {
    claimId, exactSourceText: ownerPhase === 'PDP-0' ? p0Text : 'P1 claim', sourceTextSha256: 'source-hash', ownerPhase,
    ownerSourceFile: ownerPhase === 'PDP-0' ? '.product-experience/pdp-0-product-truth/source.yaml' : '.product-experience/pdp-1-domain-data/source.yaml',
    priorLocatorRef: 'source.yaml#/rule', currentLocatorResolution: 'RESOLVED_EXACT_SOURCE_VALUE',
    currentTargetValueSha256: 'target-hash', currentTargetValuePreview: 'exact current value', semanticDisposition: 'CLAIM_SPECIFIC',
    materialGap: 'No acceptance asserted', priorTargetValueSha256: 'prior-hash', targetHashEncoding: 'raw',
    targetSnapshotStatus: 'LIVE_OBSERVATION_UNREVIEWED', ownerSourceSha256: 'owner-hash', sourcePlanCommit: 'source-commit',
    sourcePlanPath: 'plan.md', sourcePlanLineNumbers: [1], exactParentContext: [{line: 1, text: 'context', sha256: 'context-hash'}],
    currentProposalObservation: {status: 'PENDING', currentSourceFileSha256: 'p0-file', reason: 'P0 owner source observation'},
    ownerSemanticReview: {disposition: 'SOURCE_RULE_CONTENT_SUPPORTS_CLAIM_AT_DEFINITION_LEVEL', reason: 'bounded',
      proposedTargetRef: 'source.yaml#/rule', exactContractRefs: ['source.yaml#/rule'], materialPredicates: ['predicate'], negativeCases: ['mutation fails'],
      oracleRef: 'tests/test.mjs', acceptanceEffect: 'none', runtimeStatus: 'NOT_EVALUATED',
      materialBindings: [
        {ref: '.product-experience/pdp-0-product-truth/reuse-decisions.yaml#rule', requiredSourcePhrase: 'P0 phrase', sourceFileSha256: 'p0-file', sourceValueSha256: 'p0-value', currentProposalObservation: {status: 'PENDING', currentSourceFileSha256: 'p0-binding'}},
        {ref: '.product-experience/pdp-1-domain-data/operations.yaml#rule', requiredSourcePhrase: 'P1 phrase', sourceFileSha256: 'p1-file', sourceValueSha256: 'p1-value', currentProposalObservation: {status: 'PENDING', currentSourceFileSha256: p1Observation}},
      ]},
  };
}

test('owner-candidate projection is exact by reviewed IDs, strips nested P1 observations, and retains P0 semantics', () => {
  assert.equal(pdp0OwnerCandidateClaimIds.length, 148);
  const candidate = {schemaVersion: 1, artifactId: 'mixed-candidate', scope: 'P0/P1 candidate', authority: 'no acceptance',
    population: {claimCount: 149, ownerPhaseCounts: {'PDP-0': 148, 'PDP-1': 1}, locatorResolutionCounts: {RESOLVED_EXACT_SOURCE_VALUE: 149}},
    currentProposalObservationReason: 'P1 global observation', laterPhaseHandoffs: [{handoffId: 'P1'}],
    focusedPdp1SourceObservations: {phase: 'PDP-1', sourceFileSha256: 'old'},
    records: [...pdp0OwnerCandidateClaimIds.map(id => candidateRecord(id, 'PDP-0')), candidateRecord('C-P1', 'PDP-1')]};
  const p0ClaimId = pdp0OwnerCandidateClaimIds[0];
  const baseline = projectPdp0OwnerCandidates(candidate);
  const p1Changes = structuredClone(candidate);
  p1Changes.records.find(row => row.claimId === 'C-P1').exactSourceText = 'different P1 claim';
  p1Changes.records.find(row => row.claimId === p0ClaimId).ownerSemanticReview.materialBindings[1].sourceFileSha256 = 'new P1 file hash';
  p1Changes.records.find(row => row.claimId === p0ClaimId).ownerSemanticReview.materialBindings[1].sourceValueSha256 = 'new P1 value hash';
  p1Changes.records.find(row => row.claimId === p0ClaimId).ownerSemanticReview.materialBindings[1].currentProposalObservation.currentSourceFileSha256 = 'new';
  p1Changes.focusedPdp1SourceObservations.sourceFileSha256 = 'new';
  p1Changes.currentProposalObservationReason = 'new P1 observation';
  assert.equal(fingerprint(projectPdp0OwnerCandidates(p1Changes)), fingerprint(baseline));

  const p0TextChange = structuredClone(candidate);
  p0TextChange.records.find(row => row.claimId === p0ClaimId).ownerSemanticReview.materialPredicates[0] = 'weakened predicate';
  assert.notEqual(fingerprint(projectPdp0OwnerCandidates(p0TextChange)), fingerprint(baseline));
  const p0BindingChange = structuredClone(candidate);
  p0BindingChange.records.find(row => row.claimId === p0ClaimId).ownerSemanticReview.materialBindings[0].sourceValueSha256 = 'changed P0 value hash';
  assert.notEqual(fingerprint(projectPdp0OwnerCandidates(p0BindingChange)), fingerprint(baseline));
  const p0ObservationChange = structuredClone(candidate);
  p0ObservationChange.records.find(row => row.claimId === p0ClaimId).currentProposalObservation.currentSourceFileSha256 = 'changed P0 owner observation';
  assert.notEqual(fingerprint(projectPdp0OwnerCandidates(p0ObservationChange)), fingerprint(baseline));
  const missing = structuredClone(candidate);
  missing.records = missing.records.filter(row => row.claimId !== p0ClaimId);
  assert.throws(() => projectPdp0OwnerCandidates(missing), /membership differs/);
  const duplicate = structuredClone(candidate);
  duplicate.records.push(structuredClone(duplicate.records[0]));
  assert.throws(() => projectPdp0OwnerCandidates(duplicate), /must be unique/);
  const unknown = structuredClone(candidate);
  unknown.records.find(row => row.claimId === p0ClaimId).ownerSemanticReview.materialBindings[0].newField = true;
  assert.throws(() => projectPdp0OwnerCandidates(unknown), /unclassified field/);
  assert.throws(() => projectPdp0OwnerCandidates(candidate, ['wrong']), /frozen PDP-0 owner-candidate membership/);
});
