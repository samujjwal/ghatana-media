#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildMediaProductDefinitionResidualReport } from './lib/media-product-definition-residuals.mjs';
import { enumerateExpectedMediaObligations } from './lib/media-obligation-denominator-audit.mjs';

export const taskIds = [8, 11, 9, 10].flatMap((n, phase) => Array.from({length:n}, (_,i) => `P${phase}-${String(i+1).padStart(2,'0')}`));
export function validateTaskPopulation(tasks) {
  const ids = tasks.map(t => t.id);
  if (ids.length !== 38 || new Set(ids).size !== 38 || taskIds.some(id => !ids.includes(id))) throw new Error('Readiness must contain exactly the 38 mandated PDP task identities');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parseYaml=createRequire(path.resolve(root,'../ghatana-tools/package.json'))('yaml').parse;
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
export function verificationCutChanged(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(file => before[file] !== after[file]).sort();
}
function hasCompleteCurrentP0CriterionScopes(definitionCriterionReviews) {
  return p0ReviewedScopeCriteria.every(id=>{
    const review=definitionCriterionReviews[id];
    const correction=review?.currentCorrectiveReview;
    return review?.status==='APPROVED_DIRECT_DEFINITION_CRITERION'
      && review.sourceCutCurrent===true
      && correction?.status==='APPROVED_CURRENT_CORRECTION'
      && correction.phaseScope==='PDP-0'
      && typeof correction.decisionRef==='string'&&correction.decisionRef.trim();
  });
}
const suites = {
  'P0-01': ['tests/pdp-truth-domain-channel-profile-applicability.test.mjs', 'tests/pdp-truth-domain.test.mjs', 'tests/pdp0-development-handoff.test.mjs', 'tests/pdp0-animation-authored-provenance.test.mjs', 'tests/pdp0-capability-leaf-review-authority-boundary.test.mjs', 'tests/pdp0-capability-intent-current-source-observation.test.mjs', 'tests/pdp0-capability-outcome-meaning.test.mjs', 'tests/pdp0-capability-source-backed-outcomes.test.mjs', 'tests/pdp0-pxd117-phase-noise-measurement-regression.test.mjs', 'tests/pdp0-result-variant-trust-bindings.test.mjs', 'tests/pdp-capability-family-definition.test.mjs'],
  'P0-02': ['tests/pdp-truth-domain.test.mjs', 'tests/media-operation-bounds.test.mjs', 'tests/media-measure-applicability-crosswalk.test.mjs', 'tests/pdp-truth-domain-output-producer-applicability.test.mjs', 'tests/pdp-truth-domain-nfr-measurement-methods.test.mjs', 'tests/pdp0-bounded-resource-admission.test.mjs'],
  'P0-03': ['tests/pdp-migration-current-source-claim-dispositions.test.mjs', 'tests/pdp-migration-semantic-reconciliation.test.mjs', 'tests/pdp-migration-capability-material-claims.test.mjs', 'tests/pdp-migration-preservation-identity-wire-claims.test.mjs', 'tests/pdp-migration-pxd120-current-target-observations.test.mjs', 'tests/pdp-migration-constitution-claims.test.mjs', 'tests/pdp-leaf-trust-reconstruction-dispositions.test.mjs', 'tests/pdp-truth-domain-migration-199-owner-candidate.test.mjs', 'tests/pdp-migration-mpsem-0077-c002-persona-parity.test.mjs', 'tests/pdp-migration-p0-current-material-reviews.test.mjs', 'tests/pdp0-result-variant-trust-bindings.test.mjs'],
  'P0-04': ['tests/pdp-0-final.test.mjs', 'tests/media-product-definition-resolved-intents.test.mjs'],
  'P0-05': ['tests/pdp-truth-domain.test.mjs', 'tests/pdp0-constitution-normative-completeness.test.mjs', 'tests/pdp0-requirement-source-boundaries.test.mjs', 'tests/pdp0-policy-authority-boundary.test.mjs'],
  'P0-06': ['tests/pdp-0-06-measures-provenance.test.mjs', 'tests/media-measure-applicability-crosswalk.test.mjs', 'tests/pdp-truth-domain-quality-applicability.test.mjs', 'tests/pdp-truth-domain.test.mjs', 'tests/pdp0-phase-noise-output-semantics.test.mjs', 'tests/pdp0-quality-current-source-review.test.mjs'],
  'P0-07': ['tests/pdp-truth-domain-channel-profile-applicability.test.mjs', 'tests/media-p0-07-feature-channel-review.test.mjs', 'tests/pdp-truth-domain.test.mjs', 'tests/pdp0-feature-review-current-source-observation.test.mjs'],
  'P0-08': ['tests/pdp-0-final.test.mjs', 'tests/media-product-definition-resolved-intents.test.mjs', 'tests/pdp-migration-current-source-claim-dispositions.test.mjs', 'tests/pdp0-development-handoff.test.mjs', 'tests/pdp0-animation-authored-provenance.test.mjs', 'tests/pdp0-phase-noise-output-semantics.test.mjs', 'tests/pdp0-bounded-resource-admission.test.mjs', 'tests/pdp0-requirement-source-boundaries.test.mjs', 'tests/pdp0-capability-leaf-review-authority-boundary.test.mjs', 'tests/pdp0-capability-intent-current-source-observation.test.mjs', 'tests/pdp0-capability-outcome-meaning.test.mjs', 'tests/pdp0-policy-authority-boundary.test.mjs', 'tests/media-pdp-readiness.test.mjs'],
  'P1-06': ['tests/media-typed-contract-bindings.test.mjs'],
  'P2-01': ['tests/pdp-2-tools-experience-language-contract.test.mjs', 'tests/pdp-2-experience-language-projection.test.mjs'],
  'P1-01': ['tests/media-domain-identity-reconciliation.test.mjs', 'tests/pdp-truth-domain-owner-identity-contracts.test.mjs'],
  'P1-02': ['tests/media-state-machine-extraction.test.mjs', 'tests/pdp1-transition-guard-definition-evaluator.test.mjs', 'tests/pdp-truth-domain-race-semantics.test.mjs', 'tests/pdp-truth-domain-transition-coverage.test.mjs'],
  'P1-03': ['tests/pdp-truth-domain.test.mjs', 'tests/pdp-job-submit-parameter-contract.test.mjs'],
  'P1-07': ['tests/media-agent-tool-definition-contracts.test.mjs', 'tests/media-agent-tool-contracts.test.mjs'],
  'P1-09': ['tests/media-temporal-spatial-definition-model.test.mjs', 'tests/media-descriptor-definition-oracles.test.mjs'],
  'P2-05': ['tests/pdp-design-composition.test.mjs'],
  'P2-04': ['tests/media-ui-reuse-inventory.test.mjs', 'tests/pdp-design-reuse-disposition.test.mjs'],
  'P2-07': ['tests/pdp-design-interface-parity.test.mjs'],
  'P3-01': ['tests/pdp-experience-definition-mapping.test.mjs'],
  'P3-02': ['tests/pdp-3-screen-journey-crosslinks.test.mjs'],
  'P3-03': ['tests/pdp-experience-step-semantics.test.mjs'],
  'P3-04': ['tests/pdp-experience-action-inventory.test.mjs'],
};
const p0Criteria = ['P0-01','P0-02','P0-03','P0-04','P0-05','P0-06','P0-07','P0-08'];
const p0ReviewedScopeCriteria = ['P0-01','P0-02','P0-05','P0-06','P0-07'];
// P0-08 is the internal integrated review: rerun every bounded PDP-0 source
// criterion on the final cut, plus the dev-status reporter's own invariants.
// Several legacy aggregate tests also assert downstream PDP-1 through PDP-3
// readiness. Keep those checks in their phase suites and exclude them here so
// unfinished downstream work cannot block a PDP-0 handoff.
const p0MigrationBoundedTestNames = [
  'all current master-plan source claims have one exact, non-accepting owner disposition',
  'high-risk migration claims resolve to their semantically correct phase owners',
  'PDP-38 migration overlay exactly partitions all 260 historical unresolved blocks',
  'REV-10 finding label is metadata while its governance rules stay on the exact P0 owner',
  'the MPSEM-0066 lead-in is classified from its exact colon-and-list source structure',
  'the REV-03 table label is metadata while its problem and required resolution stay separate claims',
  'high-risk cover, identity, phase, and one-owner mappings reject unrelated stable targets',
  'model-acquisition review preserves the pinned snapshot and records the new owner policy delta',
  'known migration target corrections preserve the full claim clauses at exact owner sources',
  'mixed four-phase summary is decomposed into exact current owner sources',
  'erasure negative boundary maps to the actual metadata-only confirmation rule',
  'license and adapter-sequencing claims preserve their exact owner-defined rules',
  'semantic assertions reject a stable but unrelated candidate target',
  'PXD-108 pins remain immutable while PXD-130 separately observes current source files',
  'PDP-0 capability claims target exact owner semantics with pinned source values',
  'PDP-0 privacy authority claim targets exact policy semantics and preserves its default rules',
  'best-effort diagnostics do not decide business outcome or replace required audit intent',
  'model, worker, recipe, and isolation claims target exact owner boundaries without admission promotion',
  'privacy, preservation, person-inference and wire-compatibility claims bind exact current owner rules',
  'PXD-108 and PXD-100 person-inference observations stay historical while PXD-130 records the live source',
  'material mutations cannot erase privacy axes, uncertainty, preservation limits or exact wire compatibility',
  'PXD-120 records exact current owner observations for the active phase cohort',
  'the PXD-120 observation set is exact and adds no claim beyond its bounded scope',
  'the fixed constitution, density, audit, and locale cohort resolves to exact owner clauses and current value pins',
  'material, source, target and acceptance mutations fail the cohort validator',
  'fail-closed, policy separation and audit clauses reject weakened variants',
  'P0-122 current capability contracts and historical trust rows reconcile without asserting equivalence',
  'rights result variants select one exact active trust outcome',
  'simulation pass variants are limited to the eleven output leaves',
  'P0 trust regression rejects foreign, mismatched, or incomplete semantic references',
  'PXD-122 spatial source outputs require the exact source-derived reconstruction selector',
  'the 199-row cohort preserves historical claim identity and phase-scoped live source locators',
  'current proposal observations preserve historical source and owner pins',
  'only exact heading/table-label spans are classified as non-normative source metadata',
  'claim-specific material clauses for PDP-0 resolve exactly and reject weakened or substituted targets',
  'quality invalidation is scoped to exact dependency closure and temporal context',
  'material-change disclosure covers narration, rights, egress, spend, and publication before effect',
  'five P0 migration reviews bind current owner meaning and reject cross-phase promotion',
  'P0 migration review selections reject unrelated or weakened source material',
].map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
suites['P0-08'] = [...new Set([
  ...p0Criteria.filter(id => id !== 'P0-08').flatMap(id => suites[id]),
  'tests/pdp0-capability-semantic-current-source-review.test.mjs',
  'tests/media-pdp-readiness.test.mjs',
])].filter(file => ![
  'tests/pdp-truth-domain.test.mjs',
  'tests/pdp-0-final.test.mjs',
  'tests/pdp-truth-domain-schema-validation.test.mjs',
  'tests/media-product-definition-residuals.test.mjs',
].includes(file));
// Direct task criteria must not inherit failures from unrelated phase work.
// Those broader diagnostics remain in the full integration verification.
const directTestNames = {
  'P0-01': 'P0 assigns every capability leaf explicit channel applicability|all 462 leaves have exact profile-channel applicability or a source-backed exclusion|15 review dimensions resolve every requirement type and all 462 exact leaf joins|PDP-0 hands off all 462 stable capability intents|PDP-0 handoff rejects missing, duplicate, or weakened capability meaning|P0 owner intent binding observation|P0 capability outcomes state exact result meaning|P0 outcome validation rejects generic|source-backed capability result contracts|PXD-117 phase/noise-floor capability keeps its exact P0 measurement identity|current P0 owner review and trust records preserve measurement semantics and fail closed|current P0 quality joins use the measurement record as the phase metric subject|project creation requires a title|phase analysis declares a measurement record|scientific demo separates visual plausibility|export creates a delivery package|P0 capability semantic review|source-free animation authoring|PXD-128 result variants cover every audited leaf|capability families are exact leaf groupings without inherited operations or readiness',
  'P0-02': 'P0 model acquisition and reuse policy|P0 channel and dependency update semantics|P0 bounded invocation admission|trustworthy-output applicability follows output-producer role|every declared NFR has one complete owner measurement method|performance method binds all six proposed budgets|missing method material and attempted qualification promotion fail validation|SLO and human/specialist methods remain gated|actual PDP-0 owner applicability source closes all pairs|same-count substitution, duplicates and stale binding projections',
  'P0-04': 'P0-04|PDP-0 preserves exact collaborator|PDP-0 requirement trace targets',
  'P0-05': 'P0 model acquisition and reuse policy|P0 channel and dependency update semantics|P0 input inspection, simulation, trust, and mission rules have no PDP-1 contract prerequisites|historical migration source stays provenance|P0 policy assigns one semantic authority|identity, consent, rights, version and revocation checks fail closed|policy definitions do not claim runtime',
  'P0-06': 'P0-06 maps all measures to stable capability meaning|P0 quality applicability is complete from capability intent and semantic artifact types alone|P0 quality checks reject foreign semantic types and missing applicability decisions|actual PDP-0 owner applicability source closes all pairs and exact binding projections|P0 applicability needs exact capability intent and rejects operation or wire schemas as substitutes|same-count substitution, duplicates and stale binding projections are rejected|unknown applicability, missing evidence and invented measurements remain errors',
  'P0-07': 'P0-07|complete product feature review matrix|every feature leaf has an exact proposal-time channel|channel applicability|P0 channel and dependency|all 462 leaves have exact profile-channel applicability|channel rules keep protocol|15 review dimensions resolve|P0 current-source observation|every active P0 capability adjudication',
  'P2-01': 'Tools public ExperienceLanguage|PDP-2 disclosure density|PDP-2 recovery and accessibility|PDP-2 projects exact owner',
};
directTestNames['P0-08'] = [
  ...p0Criteria.filter(id => id !== 'P0-08' && id !== 'P0-04').map(id => directTestNames[id]).filter(Boolean),
  'P0-04 owner intent decisions are auditable and preserve collaborative actor references',
  'P0-04 journey actors and requirement intent targets remain source-bound',
  'PDP-0 projects only the exact resolved P0-04 user intent actor and priority decisions',
  'PDP-0 preserves exact collaborator actor lists and only resolved initiating actors',
  'PDP-0 requirement trace targets are limited to resolvable intents and unresolved targets stay in the review',
  ...p0MigrationBoundedTestNames,
  'P0 capability semantic review pins current source checks without claiming historical equivalence or acceptance',
  'approved PDP-0 media decisions include only current direct and scoped corrective approvals',
  'current PDP-0 corrective source fingerprints exclude generated verification logs',
  'PDP-0 development status can close only with the exact full source inventory and no outstanding meaning',
  'persisting phase status writes a separate file and preserves the historical 38-task report',
].join('|');
const implementationScopes = {
  'P1-01': 'Canonical identity and tenant-scoped relationship definitions; source-only observations remain distinguished. Persistence and independent acceptance are not established by these tests.',
  'P1-02': 'Source state meanings and owner-defined guard/transition semantics. Definition checks do not establish runtime crash, delivery, retry or cancellation qualification.',
  'P1-03': 'Exact owner-defined operation slices and the action-to-operation disposition census. Unbound operations remain open; a complete inventory is not a complete operation contract.',
  'P1-09': 'Exact rational timebase, sample-boundary, distinct pixel-center/boundary and selected SI conversion definitions; typed technical descriptors, VFR maps, display aspect and fidelity/provenance requirements with negative cases. Legacy wire alignment, metadata capture and scientific specialist acceptance remain open.',
  'P2-05': 'All selected central composition links resolve and reject invalid grammar references; rendered instances and independent conformance remain unaccepted.',
  'P2-04': 'All 31 component families have exact public-export candidate or contract-only dispositions. Source exports are not independent reuse, accessibility, package-owner or visual acceptance.',
  'P2-07': 'Interface identity inventory and bounded non-operation dispositions; no cross-channel semantic equivalence or runtime admission inferred.',
  'P3-01': 'Typed source-to-public candidate mapping with fail-closed action semantics; remaining field blockers are reported separately.',
  'P3-02': 'Exact screen registry, source contract and composition references. Complete state, authority, recovery and independent screen acceptance remain open.',
  'P3-03': 'Ordered journey step action/definition semantics; unbound canonical relationships and scenario acceptance remain open.',
  'P3-04': 'All action roles and typed owner-definition source envelopes; classification does not admit unbound consequential effects.',
};
export function resolveCriterionReviewSourceCut(record, fileDigest) {
  const matches = pins => Boolean(pins && Object.keys(pins).length && Object.entries(pins).every(([file, hash]) => fileDigest(file) === hash));
  const historicalSourceCutCurrent = matches(record.sourceFingerprints);
  const correction = record.currentCorrectiveReview;
  const corrected = correction?.status === 'APPROVED_CURRENT_CORRECTION';
  return {...record, historicalSourceCutCurrent,
    sourceCutCurrent: corrected ? matches(correction.sourceFingerprints) : historicalSourceCutCurrent};
}

/** Select decision references that describe current, bounded PDP-0 source reviews. */
export function selectApprovedMediaDecisions(definitionCriterionReviews = {}, migrationP0Review = null) {
  const decisions = [];
  for (const review of Object.values(definitionCriterionReviews)) {
    if (review?.status !== 'APPROVED_DIRECT_DEFINITION_CRITERION' || review.sourceCutCurrent !== true) continue;
    if (typeof review.decisionRef === 'string' && review.decisionRef.trim()) decisions.push(review.decisionRef);
    const correction = review.currentCorrectiveReview;
    if (correction?.status === 'APPROVED_CURRENT_CORRECTION' && correction.phaseScope === 'PDP-0'
        && typeof correction.decisionRef === 'string' && correction.decisionRef.trim()) decisions.push(correction.decisionRef);
  }
  const expectedMigrationClaims = ['MPSEM-0078-C003','MPSEM-0181-C001','MPSEM-0278-C001','MPSEM-0367-C002','MPSEM-0475-C003'];
  const migrationClaimIds = migrationP0Review?.records?.map(record => record?.claimId).sort() ?? [];
  const migrationApproved = migrationP0Review?.authorizationStatus === 'APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE'
    && migrationP0Review.status === 'APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE'
    && migrationP0Review.acceptanceEffect === 'none' && migrationP0Review.runtimeStatus === 'NOT_EVALUATED'
    && migrationP0Review.cliAdmission === 'NOT_ADMITTED'
    && typeof migrationP0Review.decisionRef === 'string' && migrationP0Review.decisionRef.trim()
    && Array.isArray(migrationP0Review.records) && migrationP0Review.records.length === expectedMigrationClaims.length
    && JSON.stringify(migrationClaimIds) === JSON.stringify(expectedMigrationClaims)
    && migrationP0Review.records.every(record => record?.ownerPhase === 'PDP-0'
      && record.coordinatorDisposition === 'APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE'
      && record.coordinatorDecisionRef === migrationP0Review.decisionRef
      && record.ownerProposalObservation?.status === 'PENDING_COORDINATOR_MATERIAL_REVIEW'
      && record.acceptanceEffect === 'none' && record.runtimeStatus === 'NOT_EVALUATED');
  if (migrationApproved) decisions.push(migrationP0Review.decisionRef);
  return [...new Set(decisions)].sort();
}

export function assessCurrentTaskDependencies(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  return tasks.map(task => {
    const text = typeof task.dependencies === 'string' ? task.dependencies : '';
    const ids = new Set(text.match(/\b(?:P[0-3]|G|X)-\d{2}\b/g) ?? []);
    for (const range of text.matchAll(/\bP([0-3])-(\d{2})\s+through\s+P\1-(\d{2})\b/g)) {
      for (let n = Number(range[2]); n <= Number(range[3]); n += 1) ids.add(`P${range[1]}-${String(n).padStart(2, '0')}`);
    }
    const records = [...ids].map(id => {
      const dependency = byId.get(id);
      return { id, boundary: dependency ? 'MANDATED_PDP_TASK' : 'EXTERNAL_DEPENDENCY_ONLY',
        sourceCriterion: dependency?.taskSpecificSourceDone ?? 'NOT_EVALUATED',
        independentAcceptance: dependency?.independentReviewAccepted ?? 'NOT_EVALUATED',
        lifecycleCurrentness: dependency?.LifecyclePhaseReceiptCurrent ?? 'NOT_EVALUATED',
        readiness: 'NOT_ESTABLISHED',
      };
    });
    return { ...task, currentDependencyAssessment: {
      status: records.length ? 'NOT_ESTABLISHED' : 'NO_EXPLICIT_DEPENDENCY_IDENTIFIED_IN_CAPTURED_PLAN',
      method: 'Current direct source criteria are observed separately; they do not establish dependency acceptance or Lifecycle currentness. Captured audit flags remain historical.',
      records,
    } };
  });
}

export function buildReadiness({audit, residual, verification = {}, mainSha, fingerprints, definitionCensus = null, sourceWorkingTree = null, definitionCriterionReviews = {}}) {
  const tasks = assessCurrentTaskDependencies(audit.tasks.filter(t => taskIds.includes(t.id)).map(t => {
    const ownerReview=definitionCriterionReviews[t.id];
    const correctionOpen=Boolean(ownerReview?.currentCorrectiveReview && ownerReview.currentCorrectiveReview.status!=='APPROVED_CURRENT_CORRECTION');
    const reviewedDefinition=ownerReview?.status==='APPROVED_DIRECT_DEFINITION_CRITERION' && ownerReview?.sourceCutCurrent===true && !correctionOpen;
    const knownMet = t.id === 'P0-04' || t.ledgerStatus === 'complete' || reviewedDefinition;
    const check = verification[t.id];
    const verified = knownMet && check?.status === 'PASS';
    return {
      id:t.id, title:t.title, originalLedgerStatus:t.ledgerStatus,
      originalFullTaskDone: t.ledgerStatus === 'complete',
      taskSpecificSourceDone: correctionOpen ? 'REOPENED_SOURCE_CONTRACT_CORRECTION_REQUIRED' : verified ? 'VERIFIED_IN_CURRENT_SOURCE' : knownMet ? 'PRIOR_SOURCE_AUDIT_MET_REVALIDATION_REQUIRED' : 'NOT_ESTABLISHED',
      definitionCriterionSatisfied:verified,
      definitionCriterionOwnerReview:ownerReview ?? null,
      dependencyReady: t.unmetPlanDependencies?.length ? 'NOT_ESTABLISHED' : 'PRIOR_AUDIT_NO_UNMET_DEPENDENCY_IDENTIFIED',
      independentOrPublisherAccepted:'NOT_EVALUATED', independentReviewAccepted:'NOT_EVALUATED',
      nativePhaseProofCurrent:'NOT_EVALUATED', LifecyclePhaseReceiptCurrent:'NOT_EVALUATED',
      overallDone:t.ledgerStatus,
      taskSpecificDoneClause:t.taskSpecificDoneClause,
      dependencies:t.planDependencies,
      previousAuditAssessment:t.assessment,
      previousAuditResiduals:t.unmetPredicates,
      priorEvidenceSources:t.evidenceSources,
      verification: check ?? {status:'NOT_RUN'},
      currentImplementationEvidence: implementationScopes[t.id] ? {
        scope:implementationScopes[t.id],
        sourceTests:check?.status ?? 'NOT_RUN',
        wholeTaskCriterionEstablished:false,
        acceptance:'NOT_CLAIMED',
      } : null,
    };
  }));
  validateTaskPopulation(tasks);
  return {
    schemaVersion:'media.pdp-38-readiness.v1', mainSha, sourceWorkingTree,
    authority:'Diagnostic scope overlay. Original ledger and independent/Lifecycle authorities are unchanged. Previous audit residuals are historical, not a live semantic census.',
    taskCount:38, sourceFingerprints:fingerprints, authoredOwnerDefinitionCensus:definitionCensus, tasks,
    phases:[0,1,2,3].map(p => ({id:`PDP-${p}`,definition:'INCOMPLETE',sourceValidation:'SEE_VERIFICATION_RECORDS',semanticAcceptance:'NOT_ESTABLISHED',independentReview:'NOT_EVALUATED',proofAdmission:'NOT_EVALUATED',lifecycleCurrent:'NOT_EVALUATED'})),
    currentCounters:{
      capabilityLeaves:residual.capabilityCoverage.leafCount,
      currentUnresolvedCapabilityMeanings:residual.capabilityCoverage.unresolvedCount,
      historicalUnresolvedCapabilityTargets:residual.capabilityCoverage.historicalOperationApplicability.unresolvedCount,
      authoredCapabilityContractRecords:definitionCensus?.capabilityDefinitionCollections?.records?.count ?? null,
      historicalMigrationSemanticUnresolved:residual.migrationSemantics.unresolvedCount,
      historicalMigrationMixed:residual.migrationSemantics.mixedRequiresDecompositionCount,
      interfaceIdentities:residual.operationParity.totalObservedIdentities,
      interfaceUnresolved:residual.operationParity.unresolvedIdentityCount,
      acceptedInterfaceBindings:residual.operationParity.acceptedBindingCount,
      designGates:residual.designConformance.gateCount,
      designOpenGates:residual.designConformance.openGateCount,
      screens:residual.productExperience.screenViewCount, journeys:residual.productExperience.journeyCount,
      steps:residual.productExperience.stepCount,
      stepsWithoutDirectActionRef:residual.productExperience.stepsWithoutActionBindings,
      unresolvedCurrentStepBindingRoles:residual.productExperience.journeyTrace?.currentStepBindingObservation?.actionDispositionCounts?.unresolvedStepActionBinding ?? null,
      projectionBlockers:Object.fromEntries(residual.projections.map(p=>[p.phase,p.unresolvedFieldCount])),
      obligations:residual.lifecycle.obligationCount,
      sourceEnumeratedObligations:definitionCensus?.lifecycleSourceEnumeration?.count ?? null,
      persistedObligationPopulationCountMatchesSource:definitionCensus?.lifecycleSourceEnumeration ? residual.lifecycle.obligationCount===definitionCensus.lifecycleSourceEnumeration.count && !definitionCensus.lifecycleSourceEnumeration.issues.length : null,
      obligationsWithoutCases:residual.lifecycle.obligationsWithoutCaseIds,
      localReceiptRecords:residual.lifecycle.localReceiptRecordCount,
      authoritativeReceiptCount:residual.lifecycle.receiptEvaluation.authoritativeReceiptCount,
      currentness:residual.lifecycle.currentnessEvaluation,
    }, diagnostics:residual.diagnostics,
  };
}

/** Development-only PDP-0 summary. This deliberately carries no acceptance or lifecycle vocabulary. */
export function buildPdp0DevStatus({mainSha, sourceShaSet, verification = {}, definitionCriterionReviews = {}, sourceInventory, exportedHandoffIds = [], approvedMediaDecisions = [], outstandingMeaningIds = []}) {
  const expectedSourceRecordCount = {
    capabilityLeafAdjudications:462, requirementGroups:38, intents:19, journeys:30,
    profileBoundCapabilityLeaves:462, qualityDimensions:6, qualityMetricDefinitions:16,
    qualityApplicabilityLeaves:462, channelApplicabilityLeaves:462, featureReviewDimensions:15,
    featureReviewCapabilityLeaves:462, masterPlanClaims:129, constitutionalRequirements:32,
  };
  const directDevelopmentCriteria = Object.fromEntries(p0Criteria.map(id => {
    const tests = verification[id];
    return [id, {testStatus:tests?.status ?? 'NOT_RUN', testCount:tests?.testCount ?? 0, passedTestCount:tests?.passedTestCount ?? 0, skippedTestCount:tests?.skippedTestCount ?? 0}];
  }));
  const openIds = [...new Set(outstandingMeaningIds)].sort();
  const completeTestEvidence = p0Criteria.every(id => {
    const result=verification[id];
    const expectedSkippedTestCount=id==='P0-03'?10:0;
    return result?.status==='PASS' && result.command?.trim() && result.outputSha256?.trim()
      && result.testCount>0 && result.passedTestCount>0
      && result.skippedTestCount===expectedSkippedTestCount
      && result.passedTestCount+result.skippedTestCount===result.testCount
      && Object.keys(result.testSourceFingerprints ?? {}).length>0
      && Object.values(result.testSourceFingerprints ?? {}).every(value=>typeof value==='string'&&value.length>0)
      && !(result.sourceCut?.changedDuringVerification?.length)
      && !(result.sourceCut?.changedBeforeReport?.length);
  });
  const expectedInventoryKeys=Object.keys(expectedSourceRecordCount).sort();
  const sourceRecordKeys=Object.keys(sourceInventory?.sourceRecordCount ?? {}).sort();
  const resolvedKeys=Object.keys(sourceInventory?.semanticallyResolvedCount ?? {}).sort();
  const completeInventories=sourceInventory?.sourceCutStable===true
    && Object.keys(sourceShaSet ?? {}).length>0
    && Object.entries(sourceShaSet ?? {}).every(([file,value])=>typeof file==='string'&&file.length>0&&typeof value==='string'&&value.length>0)
    && Object.keys(sourceInventory?.integrityChecks ?? {}).length>0
    && Object.values(sourceInventory.integrityChecks).every(value=>value===true)
    && JSON.stringify(sourceRecordKeys)===JSON.stringify(expectedInventoryKeys)
    && JSON.stringify(resolvedKeys)===JSON.stringify(expectedInventoryKeys)
    && expectedInventoryKeys.every(key=>sourceInventory.sourceRecordCount[key]===expectedSourceRecordCount[key]
      && sourceInventory.semanticallyResolvedCount[key]===expectedSourceRecordCount[key])
    && Array.isArray(sourceInventory.sourceReconciliations)
    && sourceInventory.sourceReconciliations.length>0
    && sourceInventory.sourceReconciliations.every(row=>typeof row.id==='string'&&row.id.trim()
      && ['RECONCILED','HISTORICAL_SOURCE_ONLY'].includes(row.status)&&row.currentOwnerRef);
  const currentP0CriterionScopesComplete=hasCompleteCurrentP0CriterionScopes(definitionCriterionReviews);
  const uniqueHandoffIds=exportedHandoffIds.length>0
    && exportedHandoffIds.every(id=>typeof id==='string'&&id.trim().length>0)
    && new Set(exportedHandoffIds).size===exportedHandoffIds.length;
  const allDirectTestsPass = completeTestEvidence && completeInventories
    && sourceInventory.integrityChecks.currentP0CriterionScopesComplete===true
    && currentP0CriterionScopesComplete && uniqueHandoffIds;
  return {
    schemaVersion:'media.phase-dev-status.v1', phase:'PDP-0', mainSha, sourceShaSet,
    sourceRecordCount:sourceInventory.sourceRecordCount, semanticallyResolvedCount:sourceInventory.semanticallyResolvedCount,
    outstandingMeaningIds:openIds,
    testsActuallyRun:Object.fromEntries(p0Criteria.map(id => [id, verification[id]?.command ? {
      command:verification[id].command,status:verification[id].status,testCount:verification[id].testCount,
      passedTestCount:verification[id].passedTestCount,skippedTestCount:verification[id].skippedTestCount ?? 0,outputSha256:verification[id].outputSha256,
      testSourceFingerprints:verification[id].testSourceFingerprints ?? {},
      sourceCut:verification[id].sourceCut ?? null,
    } : {status:'NOT_RUN'}])),
    directDevelopmentCriteria, exportedHandoffIds:[...new Set(exportedHandoffIds)].sort(),
    approvedMediaDecisions:[...new Set(approvedMediaDecisions)].sort(),
    sourceReconciliations:sourceInventory.sourceReconciliations ?? [],
    status:openIds.length === 0 && allDirectTestsPass ? 'DEV_COMPLETE' : 'IN_PROGRESS',
  };
}
export function writePdp0DevStatus(status, repositoryRoot = root) {
  const outputPath=path.join(repositoryRoot,'docs/implementation/pdp-0-phase-dev-status.json');
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});
  fs.writeFileSync(outputPath,JSON.stringify(status,null,2)+'\n');
  return outputPath;
}
export function buildCurrentDefinitionCensus(repositoryRoot) {
 const read=(file)=>parseYaml(fs.readFileSync(path.join(repositoryRoot,'.product-experience',file),'utf8'));
 const domain=read('pdp-1-domain-data/domain-objects.yaml');
 const states=read('pdp-1-domain-data/states.yaml');
 const transitions=read('pdp-1-domain-data/transitions.yaml');
 const operations=read('pdp-1-domain-data/operations.yaml');
 const events=read('pdp-1-domain-data/events.yaml');
 const migration=read('pdp-0-product-truth/migration-semantics-review.yaml');
 const currentClaimDispositions=JSON.parse(fs.readFileSync(path.join(repositoryRoot,'docs/migration/current-master-plan-claim-dispositions.json'),'utf8'));
 const components=read('pdp-2-design-interface-system/component-contracts.yaml');
 const componentTypes=read('pdp-2-design-interface-system/component-value-types.yaml');
 const composition=read('pdp-2-design-interface-system/gui/composition-validation-grammar.yaml');
 const taxonomy=read('pdp-3-product-experience/public-effect-finality-taxonomy.yaml');
 const ownerRecords=operations.ownerDefinedOperationContracts?.records ?? [];
 const shapes=ownerRecords.filter(r=>r.requestSchema?.additionalProperties===false && r.resultSchema);
 const capabilityContracts=operations.capabilityOperationContracts ?? {};
 const contractCollections=Object.fromEntries(['records','families','bounds','inputPayloadSchemas','outputPayloadSchemas']
   .map(collection=>[collection,capabilityContracts[collection] ?? []]));
 const duplicateIds=records=>records.map(r=>r.id).filter((id,i,ids)=>ids.indexOf(id)!==i);
 const enumeration=enumerateExpectedMediaObligations({root:repositoryRoot,parseYaml});
 return {
   boundary:'Structural source census only; an exact ID or schema presence does not establish semantic completeness, interface equivalence, qualified behavior or acceptance.',
   domainObjectRecords:domain.objects?.length ?? 0,
   historicStateMachineRecords:states.stateMachines?.length ?? 0,
   historicTransitionRecords:transitions.transitionRecords?.length ?? 0,
   additiveOwnerTransitionRecords:transitions.ownerDefinedTransitionRecords?.length ?? 0,
   ownerDefinedOperationRecords:ownerRecords.length,
   ownerOperationRecordsWithClosedRequestAndResultShape:shapes.length,
   ownerOperationRecordsMissingClosedRequestOrResultShape:ownerRecords.filter(r=>!shapes.includes(r)).map(r=>r.id),
   capabilityDefinitionCollections:Object.fromEntries(Object.entries(contractCollections).map(([collection,records])=>[collection,{
     count:records.length,missingIds:records.filter(r=>typeof r.id!=='string'||!r.id).length,duplicateIds:duplicateIds(records),
   }])),
   eventContractRecords:events.ownerEventContracts?.records?.length ?? 0,
   localNotificationContractRecords:events.ownerEventContracts?.notificationRecords?.length ?? 0,
   designDefinitionCollections:{
     componentFamilies:components.components?.length ?? 0,
     typedComponentDefinitions:components.components?.filter(r=>r.typedDefinition)?.length ?? 0,
     normativeValueTypes:componentTypes.normativeTypeRecords?.length ?? 0,
     normativeCompositionRules:composition.normativeRuleRecords?.length ?? 0,
     semanticAcceptance:'NOT_ESTABLISHED_BY_THIS_CENSUS',
   },
   effectFinalityDefinitionRecords:taxonomy.records?.length ?? 0,
   lifecycleSourceEnumeration:{count:enumeration.records.length,issues:enumeration.issues,
     boundary:'Current normative source enumeration; persisted Lifecycle inputs must be regenerated and checked after source review. This is not accepted evidence or a phase receipt.'},
   migrationClaimReconciliation: migration.pdp38ClaimReconciliation ? {status:'HISTORICAL_SOURCE_ONLY',boundary:'These counts describe the legacy migration review cut. Current P0-03 uses the claim-scoped current-source overlay below.',...Object.fromEntries([
     'currentClaimRecordCount','currentClaimUnitCount','sourceOwnerRoutingCount',
     'semanticParityVerifiedClaimUnitCount','candidateTargetPendingSemanticParityCount',
     'nonNormativeSourceMetadataClaimUnitCount','sourcePinDisposition','acceptanceEffect',
   ].map(field=>[field,migration.pdp38ClaimReconciliation[field] ?? null]))} : null,
   currentMasterPlanClaimDispositions:{status:'CURRENT_P0_03_DENOMINATOR',claimCount:currentClaimDispositions.claimCount,
     classificationCounts:currentClaimDispositions.classificationCounts,externalHandoffCount:currentClaimDispositions.externalHandoffs?.length ?? 0,
     p0MeaningOnlyInOldPlanCount:currentClaimDispositions.p0MeaningOnlyInOldPlan?.length ?? null,
     acceptanceEffect:currentClaimDispositions.acceptanceEffect},
   operationSemanticCompleteness:'NOT_ESTABLISHED_BY_THIS_CENSUS',
   scientificQualification:'NOT_EVALUATED',
 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const phaseStatusArg=args.find(a=>a.startsWith('--phase-dev-status='));
  const phaseStatus=phaseStatusArg?.slice('--phase-dev-status='.length);
  if(args.some(a=>!['--verify','--write'].includes(a) && !a.startsWith('--verify-tasks=') && !a.startsWith('--phase-dev-status='))) throw new Error('Usage: report-media-pdp-readiness.mjs [--verify] [--verify-tasks=P0-01,P0-02,...] [--phase-dev-status=PDP-0] [--write]');
  if(phaseStatus && (phaseStatus !== 'PDP-0' || !args.includes('--verify'))) throw new Error('--phase-dev-status currently supports PDP-0 and requires --verify');
  const selectedTasksArg=args.find(a=>a.startsWith('--verify-tasks='));
  const selectedTasks=selectedTasksArg ? selectedTasksArg.slice('--verify-tasks='.length).split(',') : phaseStatus ? p0Criteria : Object.keys(suites);
  if(selectedTasks.some(id=>!Object.hasOwn(suites,id)) || new Set(selectedTasks).size!==selectedTasks.length) throw new Error('Verification tasks must name distinct configured PDP suites');
  if(selectedTasksArg && !args.includes('--verify')) throw new Error('--verify-tasks requires --verify');
  const auditPath='docs/implementation/media-task-completion-blocker-report-2026-10-08.json';
  const audit=JSON.parse(fs.readFileSync(path.join(root,auditPath),'utf8'));
  const p0PinnedSources = ['.product-experience/pdp-0-product-truth', '.product-experience/authority-map.yaml', '.product-experience/gaps.yaml', '.product-experience/decision-log.md', '.product-experience/source-manifest.yaml', '.product-experience/artifact-identities.yaml', 'docs/migration/current-master-plan-claim-dispositions.json', 'docs/migration/master-plan-source-change-claims.yaml', 'docs/PRODUCT-DEFINITION-COVERAGE.md', 'docs/implementation/PDP-0-3-SEQUENTIAL-DEVELOPMENT-COMPLETION-PLAN.md', 'docs/implementation/verification/pdp-38/direct-definition-criteria-review.json', 'docs/implementation/verification/pdp-38/migration-current-material-review.json', 'docs/implementation/verification/pdp-38/migration-p0-current-material-review.json', 'docs/implementation/verification/pdp-38/migration-current-owner-target-observations.json', 'docs/implementation/verification/pdp-38/migration-p0-current-source-observations.json', 'docs/implementation/verification/pdp-38/p0-leaf-trust-current-type-drift-inventory.json', 'docs/implementation/verification/pdp-38/policy-input-threats-current-source-observation.json', 'docs/implementation/verification/pdp-38/pending-locator-current-source-observations.json', 'docs/implementation/verification/pdp-38/p0-capability-intent-owner-binding-current-source-observation.json', 'docs/implementation/verification/pdp-38/p0-capability-semantic-current-source-review.json', 'docs/implementation/verification/pdp-38/p0-quality-current-source-review.json', 'docs/implementation/verification/pdp-38/feature-review-animation-property-owner-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-audio-defects-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-audio-naturalness-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-cli-channel-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-policy-authority-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-quality-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-qualification-policy-current-source-observation.json', 'apps/media-experience-explorer/specification-artifacts.json'];
  const p0DirectScripts = ['scripts/report-media-pdp-readiness.mjs', 'scripts/lib/media-product-definition-residuals.mjs', 'scripts/lib/pdp0-feature-review-applicability.mjs', 'scripts/lib/product-definition-domain-rule-mapping.mjs', 'scripts/generate-media-phase-projections.mjs', 'scripts/generate-media-product-manifest.mjs', 'scripts/check-product-definition-authority.mjs'];
  const sourceCut = (testFiles) => Object.fromEntries([...new Set([...execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...(phaseStatus ? p0PinnedSources : ['.product-experience']), ...(phaseStatus ? p0DirectScripts : ['scripts', 'config/closure', 'libs/media-experience-simulation'])], {cwd:root,encoding:'utf8'})
    .trim().split('\n'), ...testFiles])].filter(file => file && fs.existsSync(path.join(root,file)) && fs.statSync(path.join(root,file)).isFile()).map(file => [file,digest(file)]));
  const phaseSourceFiles=phaseStatus ? [...new Set([...p0Criteria.flatMap(id=>suites[id]),...p0PinnedSources,...p0DirectScripts])] : [];
  const phaseSourceCutBefore=phaseStatus ? sourceCut(phaseSourceFiles) : null;
  const criterionReviewPath='docs/implementation/verification/pdp-38/direct-definition-criteria-review.json';
  const definitionCriterionReviews={};
  if(fs.existsSync(path.join(root,criterionReviewPath))) {
    const artifact=JSON.parse(fs.readFileSync(path.join(root,criterionReviewPath),'utf8'));
    if(artifact.schemaVersion!=='media.pdp38-direct-definition-criteria-review.v1') throw new Error('Unsupported direct criterion review');
    for(const record of artifact.records) {
      if(!taskIds.includes(record.taskId) || definitionCriterionReviews[record.taskId]) throw new Error('Invalid or duplicate criterion review identity');
      definitionCriterionReviews[record.taskId]={...resolveCriterionReviewSourceCut(record, file => fs.existsSync(path.join(root,file)) ? digest(file) : null),artifactRef:criterionReviewPath};
    }
  }
  const verification = {};
  if(args.includes('--verify')) for(const [id, files] of Object.entries(suites).filter(([id])=>selectedTasks.includes(id))) {
    // Never let an empty or directory-like suite turn `node --test` into its
    // recursive repository-wide discovery mode. Every configured verification
    // input must be one explicit test file under this repository's tests dir.
    if(!Array.isArray(files) || files.length===0 || files.some(file=>
      typeof file!=='string' || !file.startsWith('tests/') || !file.endsWith('.test.mjs')
      || !fs.existsSync(path.join(root,file)) || !fs.statSync(path.join(root,file)).isFile())) {
      throw new Error(`${id} verification requires an explicit non-empty list of existing tests/*.test.mjs files`);
    }
    const missing=files.filter(f=>!fs.existsSync(path.join(root,f)));
    if(missing.length) {verification[id]={status:'NOT_RUN',reason:`Missing test sources: ${missing.join(', ')}`};continue;}
    const testArgs=['--test', ...(directTestNames[id] ? [`--test-name-pattern=${directTestNames[id]}`] : []), ...files.map(file=>path.resolve(root,file))];
    const before = sourceCut(files);
    const testEnv={...process.env};
    if(id==='P0-03'||id==='P0-08') testEnv.PDP_MIGRATION_CANDIDATE_PHASE='PDP-0';
    if(id==='P0-08') testEnv.PDP_DEV_PHASE='PDP-0';
    // A bounded assertion can print a large diagnostic when it fails. Keep
    // enough room for the complete TAP footer; spawnSync's 1 MiB default
    // otherwise truncates it and makes a real run look like zero tests.
    const result=spawnSync(process.execPath,testArgs,{cwd:root,encoding:'utf8',env:testEnv,maxBuffer:64*1024*1024});
    const changedSources = verificationCutChanged(before, sourceCut(files));
    const output=(result.stdout??'')+(result.stderr??'');
    const testCount=Number((result.stdout??'').match(/# tests\s+(\d+)/)?.[1] ?? 0);
    const passedTestCount=Number((result.stdout??'').match(/# pass\s+(\d+)/)?.[1] ?? 0);
    const skippedTestCount=Number((result.stdout??'').match(/# skipped\s+(\d+)/)?.[1] ?? 0);
    const expectedSkippedTestCount=id==='P0-03'?10:0;
    const status=result.status===0 && !result.error && testCount>0 && passedTestCount>0
      && skippedTestCount===expectedSkippedTestCount
      && passedTestCount+skippedTestCount===testCount?'PASS':'FAIL';
    verification[id]={status,command:`${testEnv.PDP_MIGRATION_CANDIDATE_PHASE?`PDP_MIGRATION_CANDIDATE_PHASE=${testEnv.PDP_MIGRATION_CANDIDATE_PHASE} `:''}${testEnv.PDP_DEV_PHASE?`PDP_DEV_PHASE=${testEnv.PDP_DEV_PHASE} `:''}node ${testArgs.map(arg=>arg.includes(' ')?JSON.stringify(arg):arg).join(' ')}`,exitCode:result.status,
      ...(result.error ? {executionError:result.error.message} : {}),
      testScope:directTestNames[id] ? 'Exact bounded task-specific source criteria; broader phase diagnostics are separate' : 'Bounded implementation assertions; no whole-task completion inferred',
      testCount,passedTestCount,skippedTestCount,
      outputSha256:crypto.createHash('sha256').update(output).digest('hex'),testSourceFingerprints:Object.fromEntries(files.map(f=>[f,digest(f)]))};
    verification[id].sourceCut = {fingerprints:before, changedDuringVerification:changedSources};
    if (result.status===0 && changedSources.length) verification[id].status='PASS_ON_CHANGED_SOURCE_CUT_REVALIDATION_REQUIRED';
    fs.mkdirSync(path.join(root,'docs/implementation/verification/pdp-38'),{recursive:true});
    fs.writeFileSync(path.join(root,`docs/implementation/verification/pdp-38/${id}.log`),output);
  }
  let report;
  if(!phaseStatus) {
  const currentSourceFiles=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--','.product-experience','scripts','tests','config/closure','libs/media-experience-simulation'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
  const evidenceFiles=[...new Set([auditPath,...currentSourceFiles,...audit.tasks.filter(t=>taskIds.includes(t.id)).flatMap(t=>t.evidenceSources??[]).map(f=>f.split('#')[0])])].filter(f=>fs.existsSync(path.join(root,f))&&fs.statSync(path.join(root,f)).isFile());
  for (const check of Object.values(verification)) if(check.sourceCut) {
    check.sourceCut.changedBeforeReport=verificationCutChanged(check.sourceCut.fingerprints, sourceCut(Object.keys(check.testSourceFingerprints)));
    if(check.status==='PASS' && check.sourceCut.changedBeforeReport.length) check.status='PASS_ON_CHANGED_SOURCE_CUT_REVALIDATION_REQUIRED';
  }
  const residual=buildMediaProductDefinitionResidualReport(root);
  report=buildReadiness({audit,residual,verification,
    definitionCriterionReviews,
    mainSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),fingerprints:Object.fromEntries(evidenceFiles.sort().map(f=>[f,digest(f)])),definitionCensus:buildCurrentDefinitionCensus(root),
    sourceWorkingTree:{
      boundary:'Fingerprints describe the working sources. HEAD identifies the committed base; uncommitted changes are not claimed to exist on published main.',
      porcelain:execFileSync('git',['status','--porcelain','--','.product-experience','scripts','tests','config/closure','libs/media-experience-simulation'],{cwd:root,encoding:'utf8'}).trim(),
    }});
  }
  if(phaseStatus) {
    const currentP0CriterionScopesComplete=hasCompleteCurrentP0CriterionScopes(definitionCriterionReviews);
    const migrationDisposition=JSON.parse(fs.readFileSync(path.join(root,'docs/migration/current-master-plan-claim-dispositions.json'),'utf8'));
    const migrationClaimSource=parseYaml(fs.readFileSync(path.join(root,'docs/migration/master-plan-source-change-claims.yaml'),'utf8'));
    const currentP0LeafReview=parseYaml(fs.readFileSync(path.join(root,'.product-experience/pdp-0-product-truth/capability-leaf-review.yaml'),'utf8'));
    const currentCapabilities=parseYaml(fs.readFileSync(path.join(root,'.product-experience/pdp-0-product-truth/capabilities.yaml'),'utf8'));
    const constitution=parseYaml(fs.readFileSync(path.join(root,'.product-experience/pdp-0-product-truth/constitution.yaml'),'utf8'));
    const requirements=parseYaml(fs.readFileSync(path.join(root,'.product-experience/pdp-0-product-truth/requirements.yaml'),'utf8'));
    const goals=parseYaml(fs.readFileSync(path.join(root,'.product-experience/pdp-0-product-truth/goals-jtbd.yaml'),'utf8'));
    const applications=parseYaml(fs.readFileSync(path.join(root,'.product-experience/pdp-0-product-truth/applications-channels.yaml'),'utf8'));
    const profileSemantics=parseYaml(fs.readFileSync(path.join(root,'.product-experience/pdp-0-product-truth/profile-semantics.yaml'),'utf8'));
    const qualityPolicy=parseYaml(fs.readFileSync(path.join(root,'.product-experience/pdp-0-product-truth/quality-policy.yaml'),'utf8'));
    const journeyCatalog=parseYaml(fs.readFileSync(path.join(root,'.product-experience/pdp-0-product-truth/journey-catalog.yaml'),'utf8'));
    const handoffContracts=parseYaml(fs.readFileSync(path.join(root,'.product-experience/pdp-0-product-truth/handoff-contracts.yaml'),'utf8'));
    const adjudications=currentP0LeafReview.ownerCapabilityLeafAdjudication?.records ?? [];
    const capabilityById=new Map((currentCapabilities.capabilities ?? []).map(row=>[row.id,row]));
    const adjudicationCounts=Object.groupBy(adjudications, row=>row.ownerDisposition ?? 'UNCLASSIFIED');
    const testsPass=id=>verification[id]?.status==='PASS' && (verification[id]?.testCount ?? 0)>0 && (verification[id]?.passedTestCount ?? 0)>0;
    const currentApplicabilityCounts={
      JOURNEY_STEP_CAPABILITY:adjudicationCounts.JOURNEY_STEP_CAPABILITY?.length ?? 0,
      MACHINE_CAPABILITY_WITH_EXPLICIT_CHANNEL_APPLICABILITY:adjudicationCounts.MACHINE_CAPABILITY_WITH_EXPLICIT_CHANNEL_APPLICABILITY?.length ?? 0,
      PLATFORM_DEPENDENCY_CAPABILITY:adjudicationCounts.PLATFORM_DEPENDENCY_CAPABILITY?.length ?? 0,
    };
    const knownCapabilityDispositions=new Set(Object.keys(currentApplicabilityCounts));
    const knownEffectIntentScopes=new Set(['OBSERVATION_ONLY','LOCAL_CANDIDATE_OR_DRAFT','CANONICAL_PRODUCT_STATE_CHANGE','GOVERNED_EXTERNAL_REQUEST']);
    const effectIntentRule=currentCapabilities.ownerDefinedP0EffectIntentRule;
    const capabilityMeaningComplete=adjudications.length===462
      && new Set(adjudications.map(row=>row.capabilityRef)).size===462
      && effectIntentRule?.id==='media.capability-effect-intent.owner-scope.v1'
      && adjudications.every(row=>{
        const leaf=capabilityById.get(row.capabilityRef);
        const channelRefs=row.channelApplicability?.map(item=>item.channelRef) ?? [];
        const successOutputs=leaf?.ownerDefinition?.successOutputs ?? [];
        const declaredInputTypes=[...(leaf?.inputArtifactTypes ?? [])].sort();
        const typedInputTypes=(leaf?.ownerDefinition?.typedInputSlots ?? []).map(slot=>slot.sourceType).sort();
        return Boolean(leaf && knownCapabilityDispositions.has(row.ownerDisposition)
          && row.definitionState==='OWNER_DEFINED_DEFINITION_ONLY'
          && row.channelApplicability?.length===11
          && new Set(channelRefs).size===11
          && row.requirementRefs?.length
          && row.normativeMeaning?.trim()
          && leaf.actorRefs?.length && leaf.intentRefs?.length && leaf.outcome?.trim()
          && leaf.inputArtifactTypes?.length && leaf.outputArtifactTypes?.length
          && JSON.stringify(declaredInputTypes)===JSON.stringify(typedInputTypes)
          && leaf.ownerDefinition?.capabilityIntentId===leaf.id
          && leaf.ownerDefinition?.typedInputSlots?.length
          && leaf.ownerDefinition?.parameterSchema?.additionalProperties===false
          && knownEffectIntentScopes.has(leaf.ownerDefinition?.effect?.effectIntentScope)
          && successOutputs.length
          && successOutputs.every(output=>leaf.outputArtifactTypes.includes(output.artifactType))
          && leaf.ownerDefinition?.semanticOutcomeContract?.result===leaf.outcome
          && !leaf.outcome.startsWith('The P0 result for “')
          && leaf.ownerDefinition?.semanticOutcomeContract?.unknownDisposition?.trim()
          && leaf.ownerDefinition?.semanticOutcomeContract?.outputDistinctions?.length
          && leaf.ownerDefinition?.semanticOutcomeContract?.sourceRefs?.length
          && leaf.ownerDefinition?.effect?.semanticOutcome?.trim()
          && leaf.ownerDefinition?.familyProfileRef && leaf.ownerDefinition?.boundsRef);
      }) && testsPass('P0-01');
    const legacyApplicability=journeyCatalog.capabilityApplicabilityDecision?.historicalOperationEvidenceAudit;
    const legacyCounts=legacyApplicability?.dispositions ?? {};
    const claimRows=migrationDisposition.records ?? [];
    const currentClaimIds=new Set(claimRows.map(row=>row.claimId));
    const sourceClaimIds=(migrationClaimSource.claimDecompositions ?? []).map(row=>row.claimId);
    const allowedClaimClasses=new Set(['adopted','clarified','superseded','execution-only','external-owner','out-of-current-product-scope']);
    const currentClaimsComplete=claimRows.length===129&&migrationDisposition.claimCount===129
      && sourceClaimIds.length===129&&new Set(sourceClaimIds).size===129
      && currentClaimIds.size===claimRows.length
      && sourceClaimIds.every(id=>currentClaimIds.has(id))
      && claimRows.every(row=>allowedClaimClasses.has(row.classification)&&row.reason?.trim()&&row.ownerRef?.trim())
      && (migrationDisposition.p0MeaningOnlyInOldPlan?.length ?? 0)===0 && testsPass('P0-03');
    const constitutionalRows=constitution.requirements ?? [];
    const requiredConstitutionFields=constitution.normativeRecordContract?.requiredFields ?? [];
    const constitutionalMeaningComplete=constitutionalRows.length===32
      && new Set(constitutionalRows.map(row=>row.id)).size===32
      && requiredConstitutionFields.length>0
      && constitutionalRows.every(row=>requiredConstitutionFields.every(field=>row.normativeFieldRefs?.[field]?.length>0)) && testsPass('P0-05');
    const requirementCount=requirements.requirements?.length ?? 0;
    const intentCount=goals.intents?.length ?? 0;
    const journeyCount=journeyCatalog.journeys?.length ?? 0;
    const measureApplicability=qualityPolicy.ownerQualityApplicabilityCrosswalk;
    const measureApplicabilityCount=measureApplicability?.records?.length ?? 0;
    const featureReview=applications.ownerFeatureReviewApplicability;
    const featureReviewLeafCount=featureReview?.leafCount ?? 0;
    const featureReviewDimensionCount=featureReview?.coverageDimensions ?? featureReview?.dimensions?.length ?? 0;
    const currentRequirementAndJourneyMeaningComplete=requirementCount===38 && intentCount===19 && journeyCount===30 && testsPass('P0-04');
    const boundedProfileMeaningComplete=adjudications.length===462 && new Set(adjudications.map(row=>row.capabilityRef)).size===462 && adjudications.every(row=>row.profileRef && row.boundsRef) && testsPass('P0-02');
    const qualityDimensions=qualityPolicy.qualityDimensions ?? [];
    const qualityMetrics=qualityPolicy.metricDefinitions ?? [];
    const qualityDimensionIds=new Set(qualityDimensions.map(row=>row.id));
    const qualityMetricIds=new Set(qualityMetrics.map(row=>row.id));
    const qualityRecords=measureApplicability?.records ?? [];
    const qualityApplicabilityComplete=qualityDimensions.length===6 && qualityDimensionIds.size===6
      && qualityMetrics.length===16 && qualityMetricIds.size===16 && measureApplicabilityCount===462
      && new Set(qualityRecords.map(row=>row.capabilityRef)).size===462
      && qualityRecords.every(row=>Object.keys(row.dimensionApplicability ?? {}).length===6
        && [...qualityDimensionIds].every(id=>['APPLICABLE','NOT_APPLICABLE'].includes(row.dimensionApplicability[id]))
        && Object.keys(row.metricApplicability ?? {}).length===16
        && [...qualityMetricIds].every(id=>['APPLICABLE','NOT_APPLICABLE','CONDITIONAL'].includes(row.metricApplicability[id]?.status)));
    const measureApplicabilityComplete=qualityApplicabilityComplete && testsPass('P0-06');
    const featureDimensions=featureReview?.dimensions ?? [];
    const featureDimensionIds=new Set(featureDimensions.map(row=>row.id));
    const channelAndFeatureReviewComplete=featureReviewLeafCount===462 && featureReviewDimensionCount===15
      && featureDimensions.length===15 && featureDimensionIds.size===15
      && featureDimensions.every(row=>row.id && (row.applicableRequirementBindings?.length??0)+(row.notApplicableRequirementDecisions?.length??0)>0)
      && testsPass('P0-07');
    const uniqueProfileBounds=adjudications.length===462 && new Set(adjudications.map(row=>row.capabilityRef)).size===462
      && adjudications.every(row=>typeof row.profileRef==='string'&&row.profileRef.length>0&&typeof row.boundsRef==='string'&&row.boundsRef.length>0);
    const handoff=handoffContracts.pdpPhaseHandoffContracts?.pdp0ToPdp1CapabilityIntent;
    const externalHandoffs=migrationDisposition.externalHandoffs ?? [];
    const currentClaimRowsById=new Map(claimRows.map(row=>[row.claimId,row]));
    const externalOwnerClaimIds=new Set(claimRows.filter(row=>row.classification==='external-owner').map(row=>row.claimId));
    const requiredHandoffMeaning=handoff?.requiredMeaning ?? {};
    const handoffReferenceFields=['actorRefs','intentRefs','outcome','semanticOutcomeContract','requirementIds','preconditions','constraints','executionResourceAdmission','rightsPrivacy','fidelity','provenance','supportedChannels','channelApplicability','exclusions','qualificationAndAvailability'];
    const outputSemanticShapes=requiredHandoffMeaning.outputSemanticShapes ?? {};
    const outputShapeReferenceFields=['artifactTypes','successOutputs','successOutputVariants','trustReconstructionBranches','variantBindingRule'];
    const handoffInputShapeRefs=requiredHandoffMeaning.inputSemanticShapes ?? [];
    const handoffObligations=handoff?.consumerObligations ?? [];
    const handoffNegativeCases=handoff?.negativeCases ?? [];
    const handoffShapeComplete=handoff?.id==='media.pdp0-pdp1.capability-intent-handoff.v1'
      && handoff.sourcePhase==='PDP-0'&&handoff.consumerPhase==='PDP-1'
      && handoff.sourceRecordPopulation?.count===462
      && handoff.sourceRecordPopulation.identity==='.product-experience/pdp-0-product-truth/capabilities.yaml#/capabilities/@id=<capabilityIntentId>'
      && handoff.sourceRecordPopulation.fullDenominatorSource==='.product-experience/pdp-0-product-truth/capabilities.yaml#/capabilities'
      && /stable capabilityIntentId/u.test(handoff.sourceRecordPopulation.identityRule ?? '')
      && /verbatim/u.test(handoff.sourceRecordPopulation.identityRule ?? '')
      && handoffReferenceFields.every(field=>typeof requiredHandoffMeaning[field]==='string'&&requiredHandoffMeaning[field].trim())
      && outputShapeReferenceFields.every(field=>typeof outputSemanticShapes[field]==='string'&&outputSemanticShapes[field].trim())
      && handoffInputShapeRefs.length===4&&handoffInputShapeRefs.every(ref=>typeof ref==='string'&&ref.trim())
      && handoffObligations.length>=6&&handoffObligations.every(item=>typeof item==='string'&&item.trim())
      && handoffNegativeCases.length>=4&&handoffNegativeCases.every(item=>typeof item==='string'&&item.trim())
      && sourceClaimIds.length===129&&new Set(sourceClaimIds).size===129
      && migrationDisposition.claimCount===129&&claimRows.length===129
      && sourceClaimIds.every(id=>currentClaimRowsById.has(id))
      && externalHandoffs.every(row=>externalOwnerClaimIds.has(row.claimId)
        && currentClaimRowsById.get(row.claimId)?.ownerRef===row.sourceOwnerRef
        && currentClaimRowsById.get(row.claimId)?.ownerValueSha256===row.sourceOwnerValueSha256)
      && externalHandoffs.every(row=>typeof row.claimId==='string'&&row.claimId.trim()
        && typeof row.ownerRef==='string'&&row.ownerRef.trim()
        && typeof row.sourceOwnerRef==='string'&&row.sourceOwnerRef.trim()
        && typeof row.ownerValueSha256==='string'&&row.ownerValueSha256.length===64
        && typeof row.sourceOwnerValueSha256==='string'&&row.sourceOwnerValueSha256.length===64)
      && new Set(externalHandoffs.map(row=>row.claimId)).size===externalHandoffs.length;
    const sourceReconciliations=[{id:'P0-H-JOURNEY-APPLICABILITY-LEGACY-COUNTS',status:'HISTORICAL_SOURCE_ONLY',legacyRef:'.product-experience/pdp-0-product-truth/journey-catalog.yaml#/capabilityApplicabilityDecision/historicalOperationEvidenceAudit',currentOwnerRef:'.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#/ownerCapabilityLeafAdjudication',legacyStatus:legacyApplicability.status,legacyDispositions:legacyCounts,currentCounts:currentApplicabilityCounts,interpretation:'The legacy applicability counts describe a historical source cut that awaited exact operation evidence. Current P0 owner records define capability intent and channel applicability independently; future operation, request/result, and transition bindings are downstream PDP-1 handoff obligations.'}];
    const sourceReconciliationsComplete=sourceReconciliations.every(row=>['RECONCILED','HISTORICAL_SOURCE_ONLY'].includes(row.status)&&row.id&&row.currentOwnerRef);
    const outstandingMeaningIds=[];
    if(!capabilityMeaningComplete) outstandingMeaningIds.push('P0-01:capability-intent-meaning-or-applicability');
    if(!currentClaimsComplete) outstandingMeaningIds.push('P0-03:current-master-plan-claim-ownership');
    if(!currentRequirementAndJourneyMeaningComplete) outstandingMeaningIds.push('P0-04:intent-requirement-journey-actor-trace');
    if(!constitutionalMeaningComplete) outstandingMeaningIds.push('P0-05:constitutional-normative-field-closure');
    if(!boundedProfileMeaningComplete) outstandingMeaningIds.push('P0-02:capability-bounds-and-profile-applicability');
    if(!measureApplicabilityComplete) outstandingMeaningIds.push('P0-06:measure-to-capability-applicability');
    if(!channelAndFeatureReviewComplete) outstandingMeaningIds.push('P0-07:channel-and-feature-review-applicability');
    if(!uniqueProfileBounds) outstandingMeaningIds.push('P0-02:unique-profile-and-bounds-refs');
    if(!qualityApplicabilityComplete) outstandingMeaningIds.push('P0-06:quality-dimension-and-metric-denominators');
    if(!handoffShapeComplete) outstandingMeaningIds.push('P0-H:stable-handoff-contract');
    if(!sourceReconciliationsComplete) outstandingMeaningIds.push('P0-H:source-reconciliation-disposition');
    const phaseSourceCutAfter=sourceCut(phaseSourceFiles);
    const phaseSourceChanged=verificationCutChanged(phaseSourceCutBefore,phaseSourceCutAfter);
    if(phaseSourceChanged.length) outstandingMeaningIds.push('P0-H:source-cut-changed-during-verification');
    const status=buildPdp0DevStatus({mainSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
      sourceShaSet:phaseSourceCutBefore,
      verification,definitionCriterionReviews,
      sourceInventory:{sourceCutStable:phaseSourceChanged.length===0,
        integrityChecks:{capabilityMeaningComplete,boundedProfileMeaningComplete:boundedProfileMeaningComplete&&uniqueProfileBounds,qualityApplicabilityComplete,channelAndFeatureReviewComplete,currentClaimsComplete,currentRequirementAndJourneyMeaningComplete,constitutionalMeaningComplete,handoffShapeComplete,sourceReconciliationsComplete,currentP0CriterionScopesComplete},
        sourceRecordCount:{capabilityLeafAdjudications:adjudications.length,requirementGroups:requirementCount,intents:intentCount,journeys:journeyCount,profileBoundCapabilityLeaves:adjudications.filter(row=>row.profileRef&&row.boundsRef).length,qualityDimensions:qualityDimensions.length,qualityMetricDefinitions:qualityMetrics.length,qualityApplicabilityLeaves:measureApplicabilityCount,channelApplicabilityLeaves:currentP0LeafReview.ownerCapabilityLeafAdjudication?.records?.filter(row=>row.channelApplicability?.length===11).length ?? 0,featureReviewDimensions:featureReviewDimensionCount,featureReviewCapabilityLeaves:featureReviewLeafCount,masterPlanClaims:migrationDisposition.claimCount,constitutionalRequirements:constitutionalRows.length},
        semanticallyResolvedCount:{capabilityLeafAdjudications:capabilityMeaningComplete?adjudications.length:0,requirementGroups:currentRequirementAndJourneyMeaningComplete?requirementCount:0,intents:currentRequirementAndJourneyMeaningComplete?intentCount:0,journeys:currentRequirementAndJourneyMeaningComplete?journeyCount:0,profileBoundCapabilityLeaves:boundedProfileMeaningComplete&&uniqueProfileBounds?462:0,qualityDimensions:qualityApplicabilityComplete?qualityDimensions.length:0,qualityMetricDefinitions:qualityApplicabilityComplete?qualityMetrics.length:0,qualityApplicabilityLeaves:measureApplicabilityComplete?measureApplicabilityCount:0,channelApplicabilityLeaves:channelAndFeatureReviewComplete?462:0,featureReviewDimensions:channelAndFeatureReviewComplete?featureReviewDimensionCount:0,featureReviewCapabilityLeaves:channelAndFeatureReviewComplete?featureReviewLeafCount:0,masterPlanClaims:currentClaimsComplete?claimRows.length:0,constitutionalRequirements:constitutionalMeaningComplete&&testsPass('P0-05')?constitutionalRows.length:0},
        currentApplicabilityCounts,sourceReconciliations},
      exportedHandoffIds:[handoffContracts.pdpPhaseHandoffContracts?.pdp0ToPdp1CapabilityIntent?.id,
        ...migrationDisposition.externalHandoffs.map(row=>row.claimId)].filter(id=>typeof id==='string'&&id.length>0),
      approvedMediaDecisions:selectApprovedMediaDecisions(definitionCriterionReviews,
        JSON.parse(fs.readFileSync(path.join(root,'docs/implementation/verification/pdp-38/migration-p0-current-material-review.json'),'utf8'))),
      outstandingMeaningIds});
    process.stdout.write(JSON.stringify(status,null,2)+'\n');
    if(args.includes('--write')) writePdp0DevStatus(status,root);
    if(status.status!=='DEV_COMPLETE'||Object.values(verification).some(result=>result.status!=='PASS')) process.exitCode=1;
  } else {
  const json=JSON.stringify(report,null,2)+'\n';
  if(args.includes('--write')) {
    fs.writeFileSync(path.join(root,'docs/implementation/media-pdp-38-readiness.json'),json);
    const rows=report.tasks.map(t=>`| ${t.id} | ${t.originalLedgerStatus} | ${t.taskSpecificSourceDone} | ${t.currentDependencyAssessment.status} | ${t.independentOrPublisherAccepted} | ${t.nativePhaseProofCurrent} |`);
    fs.writeFileSync(path.join(root,'docs/implementation/media-pdp-38-readiness.md'),`# PDP-0 through PDP-3 readiness\n\nSource HEAD: \`${report.mainSha}\`. Exactly 38 tasks. Source criteria, dependencies, independent acceptance and Lifecycle currentness are separate. Historical ledger criteria/status are preserved. See JSON for current source fingerprints, test outputs and historical residual provenance.\n\n| Task | Original status | Direct source criterion | Dependencies | Independent/publisher | Native phase proof |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\nCurrent source counters:\n\n\`\`\`json\n${JSON.stringify(report.currentCounters,null,2)}\n\`\`\`\n`);
    console.log(JSON.stringify({tasks:report.taskCount,counters:report.currentCounters,verification},null,2));
  } else process.stdout.write(json);
  if(report.diagnostics.length || Object.values(verification).some(v=>v.status==='FAIL')) process.exitCode=1;
  }
}
