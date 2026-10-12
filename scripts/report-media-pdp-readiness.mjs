#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildMediaProductDefinitionResidualReport } from './lib/media-product-definition-residuals.mjs';
import { enumerateExpectedMediaObligations } from './lib/media-obligation-denominator-audit.mjs';
import { analyzeDesignConformance } from './check-media-design-conformance.mjs';

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
    const currentReview=review?.currentCorrectiveReview ?? review?.currentSourceReview;
    return review?.status==='APPROVED_DIRECT_DEFINITION_CRITERION'
      && review.sourceCutCurrent===true
      && ['APPROVED_CURRENT_CORRECTION','APPROVED_CURRENT_SOURCE_REVIEW'].includes(currentReview?.status)
      && currentReview.phaseScope==='PDP-0'
      && typeof currentReview.decisionRef==='string'&&currentReview.decisionRef.trim();
  });
}
const suites = {
  'P0-01': ['tests/pdp-truth-domain-channel-profile-applicability.test.mjs', 'tests/pdp-truth-domain.test.mjs', 'tests/pdp0-development-handoff.test.mjs', 'tests/pdp0-animation-authored-provenance.test.mjs', 'tests/pdp0-capability-leaf-review-authority-boundary.test.mjs', 'tests/pdp0-capability-intent-current-source-observation.test.mjs', 'tests/pdp0-capability-outcome-meaning.test.mjs', 'tests/pdp0-capability-source-backed-outcomes.test.mjs', 'tests/pdp0-pxd117-phase-noise-measurement-regression.test.mjs', 'tests/pdp0-result-variant-trust-bindings.test.mjs', 'tests/pdp0-existing-operation-semantic-corrections.test.mjs', 'tests/pdp-capability-family-definition.test.mjs'],
  'P0-02': ['tests/pdp-truth-domain.test.mjs', 'tests/media-operation-bounds.test.mjs', 'tests/media-measure-applicability-crosswalk.test.mjs', 'tests/pdp-truth-domain-output-producer-applicability.test.mjs', 'tests/pdp-truth-domain-nfr-measurement-methods.test.mjs', 'tests/pdp0-bounded-resource-admission.test.mjs'],
  'P0-03': ['tests/pdp-migration-current-source-claim-dispositions.test.mjs', 'tests/pdp-migration-semantic-reconciliation.test.mjs', 'tests/pdp-migration-capability-material-claims.test.mjs', 'tests/pdp-migration-preservation-identity-wire-claims.test.mjs', 'tests/pdp-migration-pxd120-current-target-observations.test.mjs', 'tests/pdp-migration-constitution-claims.test.mjs', 'tests/pdp-leaf-trust-reconstruction-dispositions.test.mjs', 'tests/pdp-truth-domain-migration-199-owner-candidate.test.mjs', 'tests/pdp-migration-mpsem-0077-c002-persona-parity.test.mjs', 'tests/pdp-migration-p0-current-material-reviews.test.mjs', 'tests/pdp0-result-variant-trust-bindings.test.mjs'],
  'P0-04': ['tests/pdp-0-final.test.mjs', 'tests/media-product-definition-resolved-intents.test.mjs'],
  'P0-05': ['tests/pdp-truth-domain.test.mjs', 'tests/pdp0-constitution-normative-completeness.test.mjs', 'tests/pdp0-requirement-source-boundaries.test.mjs', 'tests/pdp0-policy-authority-boundary.test.mjs'],
  'P0-06': ['tests/pdp-0-06-measures-provenance.test.mjs', 'tests/media-measure-applicability-crosswalk.test.mjs', 'tests/pdp-truth-domain-quality-applicability.test.mjs', 'tests/pdp-truth-domain.test.mjs', 'tests/pdp0-phase-noise-output-semantics.test.mjs', 'tests/pdp0-quality-current-source-review.test.mjs'],
  'P0-07': ['tests/pdp-truth-domain-channel-profile-applicability.test.mjs', 'tests/media-p0-07-feature-channel-review.test.mjs', 'tests/pdp-truth-domain.test.mjs', 'tests/pdp0-feature-review-current-source-observation.test.mjs'],
  'P0-08': ['tests/pdp-0-final.test.mjs', 'tests/media-product-definition-resolved-intents.test.mjs', 'tests/pdp-migration-current-source-claim-dispositions.test.mjs', 'tests/pdp0-development-handoff.test.mjs', 'tests/pdp0-animation-authored-provenance.test.mjs', 'tests/pdp0-phase-noise-output-semantics.test.mjs', 'tests/pdp0-bounded-resource-admission.test.mjs', 'tests/pdp0-requirement-source-boundaries.test.mjs', 'tests/pdp0-capability-leaf-review-authority-boundary.test.mjs', 'tests/pdp0-capability-intent-current-source-observation.test.mjs', 'tests/pdp0-capability-outcome-meaning.test.mjs', 'tests/pdp0-policy-authority-boundary.test.mjs', 'tests/pdp0-existing-operation-semantic-corrections.test.mjs', 'tests/media-pdp-readiness.test.mjs'],
  'P1-06': ['tests/media-typed-contract-bindings.test.mjs'],
  'P1-01': ['tests/media-domain-identity-reconciliation.test.mjs', 'tests/pdp-truth-domain-owner-identity-contracts.test.mjs', 'tests/pdp1-lane-a-current-source-review.test.mjs'],
  'P1-02': ['tests/media-state-machine-extraction.test.mjs', 'tests/pdp1-transition-guard-definition-evaluator.test.mjs', 'tests/pdp-truth-domain-race-semantics.test.mjs', 'tests/pdp-truth-domain-transition-coverage.test.mjs'],
  'P1-03': ['tests/pdp-truth-domain.test.mjs', 'tests/pdp-job-submit-parameter-contract.test.mjs', 'tests/pdp1-capability-intent-operation-mapping.test.mjs',
    'tests/pdp1-artifact-upload-result-schema.test.mjs', 'tests/pdp1-artifact-wire-byte-ceilings.test.mjs',
    'tests/pdp1-job-submit-typed-input-mapping.test.mjs', 'tests/pdp1-output-producer-contract-mappings.test.mjs',
    'tests/pdp1-provenance-execution-reference.test.mjs', 'tests/pdp1-provenance-typed-input-mapping.test.mjs',
    'tests/pdp1-requiredness-regression.test.mjs', 'tests/pdp1-transcription-exact-contract.test.mjs',
    'tests/pdp1-transcription-optional-profile-mapping.test.mjs'],
  'P1-07': ['tests/media-agent-tool-definition-contracts.test.mjs', 'tests/media-agent-tool-contracts.test.mjs'],
  'P1-09': ['tests/media-temporal-spatial-definition-model.test.mjs', 'tests/media-descriptor-definition-oracles.test.mjs'],
  'P1-04': ['tests/media-operation-parity-source-denominators.test.mjs', 'tests/pdp1-interface-current-source-review.test.mjs', 'tests/media-sdk-legacy-interface-dispositions.test.mjs', 'tests/media-contract-parity.test.mjs', 'tests/media-contract-parity-definition-only-cli.test.mjs'],
  'P1-05': ['tests/media-typed-contract-bindings.test.mjs'],
  'P1-06': ['tests/media-typed-contract-bindings.test.mjs'],
  'P1-08': ['tests/pdp-events-owner-definition.test.mjs', 'tests/pdp-truth-domain-event-delivery.test.mjs', 'tests/media-event-source-parity.test.mjs', 'tests/media-event-interface-owner-bindings.test.mjs'],
  'P1-10': ['tests/pdp-truth-domain-erasure-contract.test.mjs', 'tests/pdp-truth-domain-policy-fallback-offline.test.mjs', 'tests/media-privacy-consistency-source.test.mjs'],
  'P1-11': ['tests/media-pdp-p1-dev-status.test.mjs', 'tests/pdp1-phase-handoff-contract.test.mjs', 'tests/pdp-truth-domain.test.mjs', 'tests/pdp1-j29-execution-recovery-read-contract.test.mjs', 'tests/pdp-truth-domain-erasure-contract.test.mjs', 'tests/pdp1-domain-identity-reference-contracts.test.mjs', 'tests/pdp1-operation-current-source-review.test.mjs', 'tests/pdp1-interface-current-source-review.test.mjs', 'tests/pdp1-transition-guard-definition-evaluator.test.mjs', 'tests/pdp1-owner-action-wire-contracts.test.mjs', 'tests/media-event-interface-owner-bindings.test.mjs', 'tests/pdp0-pxd117-phase-noise-measurement-regression.test.mjs', 'tests/pdp-tts-request-origin-binding.test.mjs'],
  'P2-01': ['tests/pdp-2-tools-experience-language-contract.test.mjs', 'tests/pdp-2-experience-language-projection.test.mjs'],
  'P2-02': ['tests/pdp-design-current-public-consumer-bindings.test.mjs', 'tests/pdp-design-presentation-contracts.test.mjs'],
  'P2-03': ['tests/media-design-conformance.test.mjs', 'tests/pdp-design-exact-content-overlay-policy.test.mjs', 'tests/pdp-design-interface-component-contracts.test.mjs'],
  'P2-04': ['tests/media-ui-reuse-inventory.test.mjs', 'tests/pdp-design-reuse-disposition.test.mjs', 'tests/pdp-design-interface-component-contracts.test.mjs'],
  'P2-05': ['tests/pdp-design-composition-catalogs.test.mjs', 'tests/pdp-2-recipe-layout-chains.test.mjs', 'tests/media-presentation-architecture.test.mjs'],
  'P2-06': ['tests/pdp-design-responsive-comprehension.test.mjs', 'tests/pdp-design-responsive-rendered-references.test.mjs'],
  'P2-07': ['tests/pdp-design-interface-parity.test.mjs', 'tests/pdp2-machine-interface-handoff.test.mjs', 'tests/media-agent-tool-contracts.test.mjs', 'tests/media-agent-tool-definition-contracts.test.mjs', 'tests/media-transcription-submission-interface-grammar.test.mjs'],
  'P2-08': ['tests/pdp-design-accessibility-text-spacing-target-size.test.mjs', 'tests/pdp-design-responsive-comprehension.test.mjs', 'tests/pdp2-media-renderer-dom.test.mjs'],
  'P2-09': ['tests/media-design-conformance.test.mjs', 'tests/pdp-design-current-public-consumer-bindings.test.mjs', 'tests/pdp-design-composition-catalogs.test.mjs', 'tests/media-ui-reuse-inventory.test.mjs', 'tests/media-presentation-architecture.test.mjs', 'tests/pdp2-phase-handoff-contract.test.mjs', 'tests/media-pdp-p2-dev-status.test.mjs'],
  'P3-01': ['tests/pdp-experience-definition-mapping.test.mjs', 'tests/pdp-experience-generic-journey-step-projection.test.mjs', 'tests/pdp-experience-transition-projection.test.mjs', 'tests/pdp-experience-component-projection.test.mjs', 'tests/pdp-experience-component-source-dispositions.test.mjs', 'tests/media-j01-definition-semantics.test.mjs', 'tests/media-j02-definition-semantics.test.mjs', 'tests/media-transcript-review-definition.test.mjs', 'tests/media-caption-version-experience-definitions.test.mjs'],
  'P3-02': ['tests/pdp-3-screen-journey-crosslinks.test.mjs', 'tests/pdp-3-screen-source-bindings.test.mjs', 'tests/pdp-experience-view-state-binding.test.mjs', 'tests/pdp-experience-view-observation-state-projection.test.mjs', 'tests/pdp-experience-view-observation-predicates.test.mjs', 'tests/pdp-experience-default-navigation.test.mjs', 'tests/pdp-job-status-screen-definition.test.mjs'],
  'P3-03': ['tests/pdp-experience-step-semantics.test.mjs', 'tests/pdp-experience-step-definition-oracle.test.mjs', 'tests/pdp-experience-journey-purpose-bindings.test.mjs', 'tests/pdp-experience-step-version-binding-contracts.test.mjs', 'tests/pdp-experience-journey-operation-bindings.test.mjs', 'tests/pdp-experience-step-guard-fact-contracts.test.mjs', 'tests/pdp-experience-typed-guard-fact-evaluator.test.mjs', 'tests/pdp-experience-rights-guard-fact-evaluator.test.mjs', 'tests/media-transcription-submission-experience-definition.test.mjs', 'tests/pdp3-j03-decision-crosswalk.test.mjs', 'tests/pdp-experience-immediate-result-sources.test.mjs'],
  'P3-04': ['tests/pdp-experience-action-inventory.test.mjs', 'tests/pdp-experience-action-reconciliation-contract.test.mjs', 'tests/pdp-experience-local-step-effect-definition.test.mjs', 'tests/pdp-experience-transition-edge-bindings.test.mjs', 'tests/pdp-experience-transition-trigger-semantics.test.mjs', 'tests/pdp-experience-identity-handoff.test.mjs'],
  'P3-05': ['tests/pdp-3-scenario-fixture-coverage.test.mjs', 'tests/pdp-3-definition-branch-coverage.test.mjs', 'tests/pdp-3-scenario-start-state-integrity.test.mjs', 'tests/pdp-experience-journey-scenario-bindings.test.mjs', 'tests/pdp-experience-scenario-local-context-bindings.test.mjs', 'tests/pdp-experience-254-guard-step-fixture-corpus.test.mjs', 'libs/media-experience-simulation/tests/pdp-experience-scenario-inventory.test.mjs', 'libs/media-experience-simulation/tests/pdp-experience-step-oracles.test.mjs'],
  'P3-06': ['tests/media-presentation-architecture.test.mjs', 'tests/pdp-experience-component-projection.test.mjs', 'tests/pdp-experience-component-source-dispositions.test.mjs', 'tests/pdp2-media-renderer-dom.test.mjs'],
  'P3-07': ['tests/pdp-api-error-semantics.test.mjs', 'tests/media-agent-tool-contracts.test.mjs', 'tests/media-agent-tool-definition-contracts.test.mjs', 'tests/media-agent-tool-untrusted-media.test.mjs', 'tests/media-event-interface-owner-bindings.test.mjs', 'tests/media-event-source-parity.test.mjs', 'tests/media-search-inspection-contracts.test.mjs', 'tests/media-sdk-legacy-interface-dispositions.test.mjs', 'tests/pdp-events-owner-definition.test.mjs', 'tests/pdp-truth-domain-event-delivery.test.mjs', 'tests/media-contract-parity.test.mjs', 'tests/media-contract-parity-definition-only-cli.test.mjs', 'tests/media-fixture-cli-current-definition-bindings.test.mjs', 'tests/pdp-3-07-machine-contract-fixtures.test.mjs'],
  'P3-08': ['tests/pdp-3-examples.test.mjs'],
  'P3-09': ['tests/pdp-design-responsive-comprehension.test.mjs', 'tests/pdp-design-responsive-rendered-references.test.mjs', 'tests/pdp-design-accessibility-text-spacing-target-size.test.mjs', 'tests/pdp2-media-renderer-dom.test.mjs'],
  'P3-10': ['tests/pdp-3-overview-denominator.test.mjs', 'tests/pdp-experience-definition-mapping.test.mjs', 'tests/pdp-experience-action-reconciliation-contract.test.mjs', 'tests/pdp-experience-transition-edge-bindings.test.mjs', 'tests/pdp-experience-view-state-binding.test.mjs', 'tests/pdp-experience-journey-purpose-bindings.test.mjs', 'tests/pdp-experience-step-version-binding-contracts.test.mjs', 'tests/pdp-experience-journey-scenario-bindings.test.mjs', 'tests/media-pdp-p3-dev-status.test.mjs', 'tests/pdp3-j03-decision-crosswalk.test.mjs'],
};
export const p103VerificationSuites = {
  'bounded-owner-contracts': {files:['tests/pdp-truth-domain.test.mjs', 'tests/pdp-job-submit-parameter-contract.test.mjs'], testNamePattern:null},
  'capability-intent-mapping': {files:[
    'tests/pdp1-capability-intent-operation-mapping.test.mjs',
    'tests/pdp1-artifact-upload-result-schema.test.mjs',
    'tests/pdp1-artifact-wire-byte-ceilings.test.mjs',
    'tests/pdp1-job-submit-typed-input-mapping.test.mjs',
    'tests/pdp1-output-producer-contract-mappings.test.mjs',
    'tests/pdp1-provenance-execution-reference.test.mjs',
    'tests/pdp1-provenance-reference-key-bounds.test.mjs',
    'tests/pdp1-provenance-typed-input-mapping.test.mjs',
    'tests/pdp1-requiredness-regression.test.mjs',
    'tests/pdp1-transcription-exact-contract.test.mjs',
    'tests/pdp1-transcription-optional-profile-mapping.test.mjs',
  ], testNamePattern:null},
  'owner-action-wire-contracts': {files:['tests/pdp1-owner-action-wire-contracts.test.mjs'], testNamePattern:null},
};
suites['P1-03'] = [...new Set([
  ...suites['P1-03'],
  ...Object.values(p103VerificationSuites).flatMap(group => group.files),
])];
const p0Criteria = ['P0-01','P0-02','P0-03','P0-04','P0-05','P0-06','P0-07','P0-08'];
export const p2Criteria = Array.from({length: 9}, (_, i) => `P2-${String(i + 1).padStart(2, '0')}`);
export const p2SuiteFiles = Object.fromEntries(p2Criteria.map(id => [id, [...(suites[id] ?? [])]]));
export const p3Criteria = Array.from({length: 10}, (_, i) => `P3-${String(i + 1).padStart(2, '0')}`);
export const p3SuiteFiles = Object.fromEntries(p3Criteria.map(id => [id, [...(suites[id] ?? [])]]));
export function isExplicitVerificationTestPath(file) {
  if (typeof file !== 'string' || !file.endsWith('.test.mjs') || file.includes('\\')) return false;
  const parts = file.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  return parts[0] === 'tests' && parts.length >= 2
    || parts[0] === 'libs' && parts.length >= 4 && parts.slice(1, -1).includes('tests');
}
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
  'P0-01': 'P0 assigns every capability leaf explicit channel applicability|all 462 leaves have exact profile-channel applicability or a source-backed exclusion|15 review dimensions resolve every requirement type and all 462 exact leaf joins|PDP-0 hands off all 462 stable capability intents|PDP-0 handoff rejects missing, duplicate, or weakened capability meaning|P0 owner intent binding observation|P0 capability outcomes state exact result meaning|P0 outcome validation rejects generic|source-backed capability result contracts|PXD-117 phase/noise-floor capability keeps its exact P0 measurement identity|current P0 owner review and trust records preserve measurement semantics and fail closed|current P0 quality joins use the measurement record as the phase metric subject|project creation requires a title|phase analysis declares a measurement record|scientific demo separates visual plausibility|export creates a delivery package|P0 capability semantic review|source-free animation authoring|PXD-128 result variants cover every audited leaf|source-asset attachment names the exact source and project versions|artifact derivation types source version, profile version, output type, purpose, and rights|output registration types candidate lineage, digest, media metadata, policy, and optional project revision|conditional upload, import, inspection, and transcription outputs are not guaranteed on every success|capability families are exact leaf groupings without inherited operations or readiness',
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
  'PXD-153 is a separate narrow current review and PXD-142 remains historical',
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
  const correction = record.currentCorrectiveReview ?? record.currentSourceReview;
  const corrected = ['APPROVED_CURRENT_CORRECTION','APPROVED_CURRENT_SOURCE_REVIEW'].includes(correction?.status);
  return {...record, historicalSourceCutCurrent,
    sourceCutCurrent: corrected ? matches(correction.sourceFingerprints) : historicalSourceCutCurrent};
}

/** Select decision references that describe current, bounded PDP-0 source reviews. */
export function selectApprovedMediaDecisions(definitionCriterionReviews = {}, migrationP0Review = null) {
  const decisions = [];
  for (const review of Object.values(definitionCriterionReviews)) {
    if (review?.status !== 'APPROVED_DIRECT_DEFINITION_CRITERION' || review.sourceCutCurrent !== true) continue;
    if (typeof review.decisionRef === 'string' && review.decisionRef.trim()) decisions.push(review.decisionRef);
    const correction = review.currentCorrectiveReview ?? review.currentSourceReview;
    if (['APPROVED_CURRENT_CORRECTION','APPROVED_CURRENT_SOURCE_REVIEW'].includes(correction?.status) && correction.phaseScope === 'PDP-0'
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
    const currentReview=ownerReview?.currentCorrectiveReview ?? ownerReview?.currentSourceReview;
    const correctionOpen=Boolean(currentReview && !['APPROVED_CURRENT_CORRECTION','APPROVED_CURRENT_SOURCE_REVIEW'].includes(currentReview.status));
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
export const p1Criteria = Array.from({length: 11}, (_, i) => `P1-${String(i + 1).padStart(2, '0')}`);
export const p1SourceRoots = [
  '.product-experience/decision-log.md',
  '.product-experience/pdp-0-product-truth/time-units-fidelity.yaml',
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-1-domain-data',
  '.product-experience/pdp-2-design-interface-system/agent-tools',
  '.product-experience/pdp-3-product-experience/action-registry.yaml',
  '.product-experience/pdp-3-product-experience/cli', '.product-experience/pdp-3-product-experience/sdk',
  '.product-experience/interface-parity', 'contracts/openapi/media.yaml', 'libs/audio-video-types/src', 'libs/audio-video-client/src',
  'libs/media-experience-simulation/src/cli.ts', 'scripts/check-media-contract-parity.mjs',
  'libs/common/src/main/java/com/ghatana/audio/video/tools/SpeechToTextToolHandler.java',
  'libs/common/src/main/java/com/ghatana/audio/video/tools/TextToSpeechToolHandler.java',
  'libs/common/src/main/java/com/ghatana/audio/video/tools/VisionAnalysisToolHandler.java',
  'libs/common/src/main/java/com/ghatana/audio/video/tools/MultimodalInferenceToolHandler.java',
  'modules/speech/stt-service/src/main/proto/stt_service.proto',
  'modules/speech/tts-service/src/main/proto/tts_service.proto',
  'modules/vision/vision-service/src/main/proto/vision_service.proto',
  'modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto',
  'launcher/src/main/java/com/ghatana/media/launcher/MediaLifecyclePublisher.java',
];
export const p2SourceRoots = [
  '.product-experience/pdp-2-design-interface-system',
  '.product-experience/pdp-1-domain-data/handoff-contracts.yaml',
  '.product-experience/interface-parity',
  '.product-experience/pdp-3-product-experience/action-registry.yaml',
  'docs/implementation/pdp-1-phase-dev-status.json',
  'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json',
  'libs/audio-video-ui/src',
  'modules/intelligence/ai-voice/libs/ai-voice-ui-react/src',
  'apps/media-experience-explorer/src',
  'apps/media-experience-explorer/specification-artifacts.json',
];
export const p2DirectScripts = [
  'scripts/report-media-pdp-readiness.mjs',
  'scripts/generate-media-phase-projections.mjs',
  'scripts/check-media-design-conformance.mjs',
  'scripts/check-media-presentation-architecture.mjs',
  'scripts/lib/pdp-design-composition-validator.mjs',
  'scripts/lib/media-product-definition-residuals.mjs',
];
// The rolling implementation plan is intentionally excluded from phase
// fingerprints; it records the results of these gates rather than defining
// product semantics and must not self-invalidate a completed phase.
export const p3SourceRoots = [
  '.product-experience/pdp-3-product-experience',
  '.product-experience/pdp-0-product-truth/handoff-contracts.yaml',
  '.product-experience/pdp-1-domain-data/handoff-contracts.yaml',
  '.product-experience/pdp-2-design-interface-system/handoff-contracts.yaml',
  '.product-experience/source-manifest.yaml',
  '.product-experience/artifact-identities.yaml',
  'docs/implementation/pdp-0-phase-dev-status.json',
  'docs/implementation/pdp-1-phase-dev-status.json',
  'docs/implementation/pdp-2-phase-dev-status.json',
  'docs/EXAMPLES.md',
  'libs/audio-video-ui/src',
  'libs/media-experience-simulation/src',
  'apps/media-experience-explorer/src',
  'apps/media-experience-explorer/specification-artifacts.json',
];
export const p3DirectScripts = [
  'scripts/report-media-pdp-readiness.mjs',
  'scripts/generate-media-phase-projections.mjs',
  'scripts/generate-media-product-manifest.mjs',
  'scripts/lib/pdp3-step-capability-purpose.mjs',
  'scripts/lib/pdp3-step-definition-oracle.mjs',
  'scripts/lib/pdp3-journey-operation-binding.mjs',
  'scripts/check-media-presentation-architecture.mjs',
];
const p1DeferredEvidenceFiles = ['tests/pdp-experience-capability-invocation-adapters.test.mjs'];
function identityRecords(source, keys) {
  return keys.flatMap(key => Array.isArray(source?.[key]) ? source[key] : [])
    .filter(row => row && typeof (row.id ?? row.machineId ?? row.transitionId) === 'string')
    .map(row => row.id ?? row.machineId ?? row.transitionId);
}
/** A bounded current source denominator, not a semantic-acceptance claim. */
export function buildPdp1SourceCensus(repositoryRoot = root) {
  const read = file => parseYaml(fs.readFileSync(path.join(repositoryRoot, '.product-experience/pdp-1-domain-data', file), 'utf8'));
  const domain = read('domain-objects.yaml');
  const values = read('value-objects.yaml');
  const relationships = read('relationships.yaml');
  const states = read('states.yaml');
  const transitions = read('transitions.yaml');
  const guards = read('transition-guard-contracts.yaml');
  const actionWire = read('owner-action-wire-contracts.yaml');
  const operations = read('operations.yaml');
  const events = read('events.yaml');
  const handoffDocument = read('handoff-contracts.yaml');
  const handoff = handoffDocument.handoffs?.pdp1ToPdp2CanonicalDomain;
  const openapi = parseYaml(fs.readFileSync(path.join(repositoryRoot, 'contracts/openapi/media.yaml'), 'utf8'));
  const sdkRegistry = parseYaml(fs.readFileSync(path.join(repositoryRoot, '.product-experience/pdp-3-product-experience/sdk/operation-registry.yaml'), 'utf8'));
  const parity = parseYaml(fs.readFileSync(path.join(repositoryRoot, '.product-experience/interface-parity/operation-parity.yaml'), 'utf8'));
  const actionRegistry = parseYaml(fs.readFileSync(path.join(repositoryRoot, '.product-experience/pdp-3-product-experience/action-registry.yaml'), 'utf8'));
  const cliRegistry = parseYaml(fs.readFileSync(path.join(repositoryRoot, '.product-experience/pdp-3-product-experience/cli/command-registry.yaml'), 'utf8'));
  const agentRegistry = parseYaml(fs.readFileSync(path.join(repositoryRoot, '.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml'), 'utf8'));
  const agentConventions = parseYaml(fs.readFileSync(path.join(repositoryRoot, '.product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml'), 'utf8'));
  const grpcSourcePaths = [
    'modules/speech/stt-service/src/main/proto/stt_service.proto',
    'modules/speech/tts-service/src/main/proto/tts_service.proto',
    'modules/vision/vision-service/src/main/proto/vision_service.proto',
    'modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto',
  ];
  const grpcOperations = grpcSourcePaths.flatMap(sourcePath => {
    const content = fs.readFileSync(path.join(repositoryRoot, sourcePath), 'utf8');
    const services = [...content.matchAll(/^service\s+(\w+)\s*\{/gmu)];
    return services.flatMap((service, index) => {
      const start = service.index + service[0].length;
      const end = services[index + 1]?.index ?? content.length;
      return [...content.slice(start, end).matchAll(/^\s*rpc\s+(\w+)\s*\(/gmu)].map(([, method]) => `${service[1]}.${method}`);
    });
  });
  const groups = {
    registeredObjectIdentities: identityRecords(domain.ownerTypedIdentityContracts, ['records']),
    values: identityRecords(values, ['values']),
    relationships: identityRecords(relationships, ['relationships']),
    stateMachines: identityRecords(states, ['stateMachines']),
    transitions: identityRecords(transitions, ['transitionRecords', 'ownerDefinedTransitionRecords']),
    guardContracts: identityRecords(guards, ['records']),
    guardFacts: Object.keys(guards.facts ?? {}),
    commonGuardFacts: Object.keys(guards.commonFacts ?? {}),
    guardFactGroups: identityRecords(guards, ['exclusiveFactGroups']),
    actionWireContracts: identityRecords(actionWire, ['records']),
    uiActions: identityRecords(actionRegistry, ['actions', 'ownerDefinedActions']),
    operations: identityRecords(operations.ownerDefinedOperationContracts, ['records']),
    capabilityOperations: identityRecords(operations.capabilityOperationContracts, ['records']),
    capabilityBounds: identityRecords(operations.capabilityOperationContracts, ['bounds']),
    capabilityInputPayloadSchemas: identityRecords(operations.capabilityOperationContracts, ['inputPayloadSchemas']),
    capabilityOutputPayloadSchemas: identityRecords(operations.capabilityOperationContracts, ['outputPayloadSchemas']),
    httpOperations: Object.entries(openapi.paths ?? {}).flatMap(([route, pathItem]) => Object.keys(pathItem)
      .filter(method => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(method.toLowerCase()))
      .map(method => `${method.toUpperCase()} ${route}`)),
    grpcOperations,
    sdkMethodRecords: identityRecords(sdkRegistry, ['methods']),
    cliCommands: identityRecords(cliRegistry, ['commands']),
    agentToolHandlers: identityRecords(agentRegistry, ['tools', 'handlers']),
    agentToolContracts: (agentConventions.observedHandlerInventory?.tools ?? []).map(row => row.canonicalToolId).filter(Boolean),
    events: identityRecords(events.ownerEventContracts, ['records']),
    notifications: identityRecords(events.ownerEventContracts, ['notificationRecords']),
  };
  const qualified = Object.fromEntries(Object.entries(groups).map(([key, ids]) => [key, ids.map(id => `${key}:${id}`)]));
  const allIds = Object.values(qualified).flat();
  const counts = Object.fromEntries(Object.entries(qualified).map(([key, ids]) => [key, ids.length]));
  const sdkPublicMethods = (sdkRegistry.methods ?? []).filter(row => row.visibility === 'public' && row.declaringClass !== 'none; parser-artifact');
  const sdkParserTokens = (sdkRegistry.methods ?? []).filter(row => row.declaringClass === 'none; parser-artifact');
  const grpcDispositionCounts = parity.surfaces?.find(row => row.surface === 'gRPC')?.dispositionCounts ?? {};
  const issues = [];
  for (const [key, ids] of Object.entries(qualified)) {
    if (ids.length === 0 || new Set(ids).size !== ids.length) issues.push(`${key}:missing-or-duplicate-identities`);
  }
  if (!counts.httpOperations) issues.push('http-operation-identity-inventory-empty');
  if (counts.registeredObjectIdentities === 0 || counts.values === 0 || counts.relationships === 0 || counts.actionWireContracts === 0) {
    issues.push('required-canonical-registry-empty');
  }
  const sourceRecordCount = {objectDefinitions: domain.objects?.length ?? 0,
      registeredObjectIdentities: domain.canonicalIdentityAdjudication?.registeredObjectIdentityCount ?? counts.registeredObjectIdentities,
      canonicalProductObjectIdentities: domain.canonicalIdentityAdjudication?.canonicalProductObjectCount ?? null,
      capabilityOperationRecordCount: operations.capabilityOperationContracts?.recordCount ?? null,
      canonicalOperationSchemaCount: operations.capabilityOperationContracts?.canonicalOperationCount ?? null,
      existingOperationBindingCount: operations.capabilityOperationContracts?.bindingCount ?? null,
      ownerDefinedOperationRecordCount: operations.ownerDefinedOperationContracts?.records?.length ?? null,
      sdkRegistryRows: sdkRegistry.sourcePopulation?.methodEntryCount ?? (sdkRegistry.methods ?? []).length,
      sdkLogicalPublicMethods: sdkPublicMethods.length,
      sdkParserTokens: sdkParserTokens.length,
      grpcDispositionCounts,
      ...counts};
  const operationOnlyQueries = (actionWire.records ?? []).filter(row => row.actionRef == null && row.operationKind === 'QUERY');
  const actionLinkedWireContracts = (actionWire.records ?? []).filter(row => row.actionRef != null);
  const expectedHandoff = {
    domainObjects: sourceRecordCount.objectDefinitions,
    registeredObjectIdentities: sourceRecordCount.registeredObjectIdentities,
    canonicalMediaIdentities: sourceRecordCount.canonicalProductObjectIdentities,
    sourceObservationWithoutCanonicalIdentity: sourceRecordCount.registeredObjectIdentities - sourceRecordCount.canonicalProductObjectIdentities,
    valueObjects: sourceRecordCount.values,
    relationships: sourceRecordCount.relationships,
    stateMachines: sourceRecordCount.stateMachines,
    transitions: sourceRecordCount.transitions,
    guardContracts: sourceRecordCount.guardContracts,
    typedGuardFacts: sourceRecordCount.guardFacts,
    commonGuardFacts: sourceRecordCount.commonGuardFacts,
    guardExclusivityGroups: sourceRecordCount.guardFactGroups,
    ownerActionWireContracts: sourceRecordCount.actionWireContracts,
    actionLinkedCount: actionLinkedWireContracts.length,
    operationOnlyQueryCount: operationOnlyQueries.length,
    uiActions: sourceRecordCount.uiActions,
    uiActionRegistryActions: (actionRegistry.actions ?? []).length,
    uiActionOwnerDefinedActions: (actionRegistry.ownerDefinedActions ?? []).length,
    capabilityOperationRecordCount: sourceRecordCount.capabilityOperationRecordCount,
    canonicalOperations: sourceRecordCount.canonicalOperationSchemaCount,
    existingOperationBindingCount: sourceRecordCount.existingOperationBindingCount,
    ownerDefinedOperations: sourceRecordCount.ownerDefinedOperationRecordCount,
    http: sourceRecordCount.httpOperations,
    grpc: sourceRecordCount.grpcOperations,
    sdk: sourceRecordCount.sdkLogicalPublicMethods,
    sdkRawRegistryRows: sourceRecordCount.sdkRegistryRows,
    sdkParserTokensExcluded: sourceRecordCount.sdkParserTokens,
    cli: sourceRecordCount.cliCommands,
    agentTools: sourceRecordCount.agentToolHandlers,
    events: sourceRecordCount.events,
    clientNotifications: sourceRecordCount.notifications,
  };
  const populations = handoff?.sourcePopulations ?? {};
  const scalarPopulationChecks = [
    ['domainObjects', populations.domainObjects?.count],
    ['registeredObjectIdentities', populations.registeredObjectIdentities?.count],
    ['canonicalMediaIdentities', populations.registeredObjectIdentities?.canonicalMediaIdentities],
    ['sourceObservationWithoutCanonicalIdentity', populations.registeredObjectIdentities?.sourceObservationWithoutCanonicalIdentity],
    ['valueObjects', populations.valueObjects?.count], ['relationships', populations.relationships?.count],
    ['stateMachines', populations.stateMachines?.count], ['transitions', populations.transitions?.count],
    ['guardContracts', populations.guardContracts?.count], ['typedGuardFacts', populations.typedGuardFacts?.count],
    ['commonGuardFacts', populations.commonGuardFacts?.count],
    ['guardExclusivityGroups', populations.guardExclusivityGroups?.count],
    ['ownerActionWireContracts', populations.ownerActionWireContracts?.count],
    ['actionLinkedCount', populations.ownerActionWireContracts?.actionLinkedCount],
    ['operationOnlyQueryCount', populations.ownerActionWireContracts?.operationOnlyQueryCount],
    ['uiActions', populations.uiActions?.count],
    ['uiActionRegistryActions', populations.uiActions?.registryActions],
    ['uiActionOwnerDefinedActions', populations.uiActions?.ownerDefinedActions],
    ['capabilityOperationRecordCount', populations.canonicalOperations?.capabilityOperationRecordCount],
    ['canonicalOperations', populations.canonicalOperations?.count],
    ['existingOperationBindingCount', populations.canonicalOperations?.existingOperationBindingCount],
    ['ownerDefinedOperations', populations.ownerDefinedOperations?.count],
    ['http', populations.interfaceIdentities?.http?.count], ['grpc', populations.interfaceIdentities?.grpc?.count],
    ['sdk', populations.interfaceIdentities?.sdk?.count], ['sdkRawRegistryRows', populations.interfaceIdentities?.sdk?.rawRegistryRows],
    ['sdkParserTokensExcluded', populations.interfaceIdentities?.sdk?.parserTokensExcluded],
    ['cli', populations.interfaceIdentities?.cli?.count], ['agentTools', populations.interfaceIdentities?.agentTools?.count],
    ['events', populations.interfaceIdentities?.events?.count],
    ['clientNotifications', populations.interfaceIdentities?.clientNotifications?.count],
  ];
  if (handoffDocument.schemaVersion !== 'media.pdp-1.phase-handoffs.v1'
      || handoff?.id !== 'media.pdp1-pdp2.canonical-domain-handoff.v1'
      || handoff?.sourcePhase !== 'PDP-1' || handoff?.consumerPhase !== 'PDP-2'
      || handoff?.status !== 'DEFINITION_HANDOFF_CONTRACT') {
    issues.push('pdp1-pdp2-handoff-identity-or-scope-invalid');
  }
  for (const [name, actual] of scalarPopulationChecks) {
    if (!Number.isInteger(actual) || actual !== expectedHandoff[name]) issues.push(`handoff-population-mismatch:${name}`);
  }
  const requiredMeaningFields = ['identitiesAndLineage', 'operationsAndWireContracts', 'statesAndGuards', 'rightsAndPrivacy', 'timeSpaceAndProvenance', 'interfaceDisposition'];
  if (requiredMeaningFields.some(key => typeof handoff?.requiredMeaning?.[key] !== 'string' || !handoff.requiredMeaning[key].trim())
      || !Array.isArray(handoff?.consumerObligations) || handoff.consumerObligations.length < 5
      || !Array.isArray(handoff?.negativeCases) || handoff.negativeCases.length < 5
      || !Array.isArray(handoff?.deferredEvidence) || handoff.deferredEvidence.length === 0
      || !Array.isArray(handoff?.deferredDownstreamFindings) || handoff.deferredDownstreamFindings.length === 0
      || handoff.deferredDownstreamFindings.some(finding => typeof finding?.id !== 'string' || !finding.id.trim()
        || finding.ownerPhase !== 'PDP-3' || typeof finding.disposition !== 'string' || !finding.disposition.trim()
        || !Array.isArray(finding.candidates) || finding.candidates.length === 0)
      || !/development-gate-status-is-recorded-separately/u.test(handoff?.scopeStatus ?? '')) {
    issues.push('pdp1-pdp2-handoff-meaning-or-boundary-incomplete');
  }
  const expectedSources = {
    domainObjects: '.product-experience/pdp-1-domain-data/domain-objects.yaml#/objects',
    registeredObjectIdentities: '.product-experience/pdp-1-domain-data/domain-objects.yaml#ownerTypedIdentityContracts/records',
    valueObjects: '.product-experience/pdp-1-domain-data/value-objects.yaml#values',
    relationships: '.product-experience/pdp-1-domain-data/relationships.yaml#relationships',
    stateMachines: '.product-experience/pdp-1-domain-data/states.yaml#stateMachines',
    transitions: '.product-experience/pdp-1-domain-data/transitions.yaml#transitionRecords + #ownerDefinedTransitionRecords',
    guardContracts: '.product-experience/pdp-1-domain-data/transition-guard-contracts.yaml#records',
    typedGuardFacts: '.product-experience/pdp-1-domain-data/transition-guard-contracts.yaml#facts',
    commonGuardFacts: '.product-experience/pdp-1-domain-data/transition-guard-contracts.yaml#commonFacts',
    ownerActionWireContracts: '.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml#records',
    uiActions: '.product-experience/pdp-3-product-experience/action-registry.yaml#actions + #ownerDefinedActions',
    canonicalOperations: '.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts',
    ownerDefinedOperations: '.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records',
    http: 'contracts/openapi/media.yaml#/paths',
    sdk: '.product-experience/pdp-3-product-experience/sdk/operation-registry.yaml#methods',
    cli: '.product-experience/pdp-3-product-experience/cli/command-registry.yaml#commands',
    agentTools: '.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml#tools',
    events: '.product-experience/pdp-1-domain-data/events.yaml#ownerEventContracts/records',
    clientNotifications: '.product-experience/pdp-1-domain-data/events.yaml#ownerEventContracts/notificationRecords',
  };
  for (const [population, reference] of Object.entries(expectedSources)) {
    const row = population === 'http' || population === 'grpc' || population === 'sdk' || population === 'cli' || population === 'agentTools' || population === 'events' || population === 'clientNotifications'
      ? populations.interfaceIdentities?.[population === 'http' ? 'http' : population === 'grpc' ? 'grpc' : population === 'sdk' ? 'sdk' : population === 'cli' ? 'cli' : population === 'agentTools' ? 'agentTools' : population === 'events' ? 'events' : 'clientNotifications']
      : populations[population];
    if (row?.source !== reference) issues.push(`handoff-source-reference-mismatch:${population}`);
  }
  if (!groups.operations.includes('media.operation.stream-session.inspect-execution-recovery.v1')) {
    issues.push('handoff-owner-defined-operation-population-missing-j29-execution-recovery-query');
  }
  const uiActionIdentityIds = [...(actionRegistry.actions ?? []), ...(actionRegistry.ownerDefinedActions ?? [])]
    .map(row => row?.id).filter(Boolean);
  const uiActionOwnerDefined = (actionRegistry.ownerDefinedActions ?? [])
    .find(row => row?.id === populations.uiActions?.ownerDefinedActionId);
  if (uiActionIdentityIds.length !== 147 || new Set(uiActionIdentityIds).size !== 147
      || (actionRegistry.actions ?? []).length !== 146 || (actionRegistry.ownerDefinedActions ?? []).length !== 1
      || populations.uiActions?.count !== 147 || populations.uiActions?.registryActions !== 146
      || populations.uiActions?.ownerDefinedActions !== 1
      || populations.uiActions?.ownerDefinedActionId !== 'media.action.request-live-session-reconnect'
      || populations.uiActions?.ownerDefinedOperationRef !== 'media.operation.capability.media-stream-session-reconnect'
      || uiActionOwnerDefined?.operationRef !== populations.uiActions.ownerDefinedOperationRef
      || !(operations.capabilityOperationContracts?.records ?? []).some(row => row?.id === uiActionOwnerDefined?.operationRef)) {
    issues.push('handoff-ui-action-population-or-owner-binding-invalid');
  }
  if (operationOnlyQueries.length !== 1
      || populations.ownerActionWireContracts?.operationOnlyQueryId !== operationOnlyQueries[0]?.id
      || operationOnlyQueries[0]?.id !== 'media.owner-action-wire.inspect-job-retry-policy.v1') {
    issues.push('handoff-operation-only-query-identity-mismatch');
  }
  const grpcSources = grpcSourcePaths.map(sourcePath => `${sourcePath}#service.rpc`);
  if (!Array.isArray(populations.interfaceIdentities?.grpc?.sources)
      || JSON.stringify(populations.interfaceIdentities.grpc.sources) !== JSON.stringify(grpcSources)) {
    issues.push('handoff-source-reference-mismatch:grpc');
  }
  return { boundary: 'Finite identity denominator from current PDP-1 owner registries. Counts establish inventory only; semantic resolution requires a current full-denominator review.',
    sourceRecordCount, reviewDenominators: counts, identityIds: [...new Set(allIds)].sort(),
    exportedHandoffIds: issues.some(issue => issue.startsWith('pdp1-pdp2-handoff-') || issue.startsWith('handoff-')) ? [] : [handoff.id],
    deferredDownstreamFindings: structuredClone(handoff.deferredDownstreamFindings ?? []),
    integrityIssues: issues };
}
export function buildPdp1DevStatus({mainSha, sourceShaSet = {}, verification = {}, sourceCensus, semanticReview = null, exportedHandoffIds = [], sourceCutStable = false}) {
  const census = sourceCensus ?? {sourceRecordCount: {}, identityIds: [], integrityIssues: ['source-census-not-built']};
  const testsActuallyRun = Object.fromEntries(p1Criteria.map(id => {
    const check = verification[id];
    return [id, check?.command ? {command: check.command, status: check.status, testCount: check.testCount,
      passedTestCount: check.passedTestCount, skippedTestCount: check.skippedTestCount ?? 0,
      outputSha256: check.outputSha256, testSourceFingerprints: check.testSourceFingerprints ?? {}, sourceCut: check.sourceCut ?? null} : {status: 'NOT_RUN'}];
  }));
  const p103RequiredSuites = ['bounded-owner-contracts', 'capability-intent-mapping', 'owner-action-wire-contracts'];
  const p103Suites = verification['P1-03']?.suites ?? {};
  const p103SuitesPass = p103RequiredSuites.every(name => {
    const suite = p103Suites[name];
    const expectedSources = p103VerificationSuites[name].files;
    const fingerprints = suite?.testSourceFingerprints ?? {};
    return suite?.status === 'PASS' && suite.testCount > 0 && suite.passedTestCount === suite.testCount
      && suite.skippedTestCount === 0 && typeof suite.outputSha256 === 'string' && /^[a-f0-9]{64}$/.test(suite.outputSha256)
      && JSON.stringify(Object.keys(fingerprints).sort()) === JSON.stringify([...expectedSources].sort())
      && Object.values(fingerprints).every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));
  });
  const testIssues = p1Criteria.filter(id => verification[id]?.status !== 'PASS' || !(verification[id]?.testCount > 0)
    || verification[id]?.passedTestCount !== verification[id]?.testCount || (verification[id]?.skippedTestCount ?? 0) !== 0
    || (id === 'P1-03' && (!p103SuitesPass || Object.keys(p103Suites).length !== p103RequiredSuites.length)))
    .map(id => `${id}:focused-development-tests-not-green`);
  const sourceIds = census.identityIds ?? [];
  const reviewPins = semanticReview?.sourceFingerprints ?? {};
  const currentReview = semanticReview?.status === 'APPROVED_PDP1_DEVELOPMENT_SEMANTIC_REVIEW'
    && semanticReview.phase === 'PDP-1' && semanticReview.sourceCutStable === true
    && Object.keys(reviewPins).length > 0
    && Object.entries(reviewPins).every(([file, hash]) => sourceShaSet[file] === hash)
    && Array.isArray(semanticReview.reviewedIdentityIds)
    && semanticReview.reviewedIdentityIds.length === sourceIds.length
    && new Set(semanticReview.reviewedIdentityIds).size === sourceIds.length
    && sourceIds.every(id => semanticReview.reviewedIdentityIds.includes(id))
    && Array.isArray(semanticReview.outstandingMeaningIds) && semanticReview.outstandingMeaningIds.length === 0;
  const sourceHandoffIds = census.exportedHandoffIds;
  const handoffValid = Array.isArray(exportedHandoffIds) && exportedHandoffIds.length > 0
    && exportedHandoffIds.every(id => typeof id === 'string' && id.trim())
    && new Set(exportedHandoffIds).size === exportedHandoffIds.length
    && Array.isArray(sourceHandoffIds) && sourceHandoffIds.length > 0
    && sourceHandoffIds.every(id => typeof id === 'string' && id.trim())
    && new Set(sourceHandoffIds).size === sourceHandoffIds.length
    && JSON.stringify([...exportedHandoffIds].sort()) === JSON.stringify([...sourceHandoffIds].sort());
  const outstandingMeaningIds = [...new Set([
    ...(census.integrityIssues ?? []).map(id => `P1-11:${id}`), ...testIssues,
    ...(!sourceCutStable ? ['P1-11:source-cut-changed-during-verification'] : []),
    ...(!currentReview ? ['P1-11:current-full-denominator-semantic-review-not-recorded'] : []),
    ...(!handoffValid ? ['P1-11:frozen-pdp1-to-pdp2-handoff-not-recorded'] : []),
    ...(currentReview ? semanticReview.outstandingMeaningIds : []),
  ])].sort();
  const denominator = census.reviewDenominators ?? census.sourceRecordCount ?? {};
  const resolved = currentReview ? denominator : Object.fromEntries(Object.keys(denominator).map(key => [key, 0]));
  const criteria = Object.fromEntries(p1Criteria.map(id => [id, {
    testStatus: verification[id]?.status ?? 'NOT_RUN',
    testCount: verification[id]?.testCount ?? 0,
    passedTestCount: verification[id]?.passedTestCount ?? 0,
    sourceSemanticReview: currentReview ? 'COVERED_BY_CURRENT_FULL_DENOMINATOR_REVIEW' : 'NOT_ESTABLISHED',
  }]));
  return {schemaVersion: 'media.phase-dev-status.v1', phase: 'PDP-1', mainSha, sourceShaSet,
    sourceRecordCount: census.sourceRecordCount, sourceIdentityIds: [...sourceIds].sort(), semanticallyResolvedCount: resolved, outstandingMeaningIds,
    testsActuallyRun, directDevelopmentCriteria: criteria,
    exportedHandoffIds: [...new Set(exportedHandoffIds)].sort(), approvedMediaDecisions: [],
    deferredDownstreamFindings: structuredClone(census.deferredDownstreamFindings ?? []),
    status: outstandingMeaningIds.length === 0 ? 'DEV_COMPLETE' : 'IN_PROGRESS',
  };
}
export function writePdp1DevStatus(status, repositoryRoot = root) {
  const outputPath = path.join(repositoryRoot, 'docs/implementation/pdp-1-phase-dev-status.json');
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  fs.writeFileSync(outputPath, JSON.stringify(status, null, 2) + '\n');
  return outputPath;
}
export function buildPdp2SourceCensus(repositoryRoot = root) {
  const read = file => parseYaml(fs.readFileSync(path.join(repositoryRoot, file), 'utf8'));
  const base = '.product-experience/pdp-2-design-interface-system/';
  const components = read(`${base}component-contracts.yaml`);
  const valueTypes = read(`${base}component-value-types.yaml`);
  const tokens = read(`${base}media-token-aliases.yaml`);
  const templates = read(`${base}gui/templates/catalog.yaml`);
  const layouts = read(`${base}gui/layout.yaml`);
  const recipes = read(`${base}gui/recipes/catalog.yaml`);
  const composition = read(`${base}gui/composition-validation-grammar.yaml`);
  const patterns = read(`${base}gui/patterns/catalog.yaml`);
  const interfaceGrammar = read(`${base}interface-grammar.yaml`);
  const p1Handoff = read('.product-experience/pdp-1-domain-data/handoff-contracts.yaml').handoffs?.pdp1ToPdp2CanonicalDomain;
  const p1Status = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs/implementation/pdp-1-phase-dev-status.json'), 'utf8'));
  const handoffPath = `${base}handoff-contracts.yaml`;
  const phaseHandoffDoc = fs.existsSync(path.join(repositoryRoot, handoffPath)) ? read(handoffPath) : null;
  const phaseHandoff = phaseHandoffDoc?.handoffs?.pdp2ToPdp3DesignInterface;
  const sharedCssBindings = tokens.cssVariableBindings?.bindings ?? [];
  const populations = {
    componentFamilies: components.components?.length ?? 0,
    typedComponentFamilies: components.components?.filter(record => record.typedDefinition)?.length ?? 0,
    componentValueTypes: valueTypes.normativeTypeRecords?.length ?? 0,
    semanticTokenAliases: tokens.aliases?.length ?? 0,
    sharedPublicCssVariables: sharedCssBindings.filter(record => typeof record.publicCssRef === 'string').length,
    mediaCssProjections: sharedCssBindings.filter(record => typeof record.sharedCssVariableRef === 'string').length,
    templates: templates.templates?.length ?? 0,
    layouts: layouts.layouts?.length ?? 0,
    recipes: recipes.recipes?.length ?? 0,
    compositionRules: composition.normativeRuleRecords?.length ?? 0,
    interactionPatterns: patterns.patterns?.length ?? 0,
    machineInterfaceInvariants: Object.keys(interfaceGrammar.invariants ?? {}).length,
  };
  const expected = {
    componentFamilies: 31, typedComponentFamilies: 28, componentValueTypes: 122,
    semanticTokenAliases: 9, sharedPublicCssVariables: 24, mediaCssProjections: 20,
    templates: 13, layouts: 11, recipes: 13, compositionRules: 42,
    interactionPatterns: 19, machineInterfaceInvariants: 12,
  };
  const integrityIssues = Object.entries(expected)
    .filter(([population, count]) => populations[population] !== count)
    .map(([population, count]) => `pdp2-population-mismatch:${population}:${populations[population]}!=${count}`);
  const expectedInputHandoff = 'media.pdp1-pdp2.canonical-domain-handoff.v1';
  if (p1Handoff?.id !== expectedInputHandoff || p1Handoff?.status !== 'DEFINITION_HANDOFF_CONTRACT'
      || p1Status.phase !== 'PDP-1' || p1Status.status !== 'DEV_COMPLETE'
      || !(p1Status.exportedHandoffIds ?? []).includes(expectedInputHandoff)) {
    integrityIssues.push('pdp2-frozen-pdp1-handoff-not-consumed');
  }
  const expectedOutputHandoff = 'media.pdp2-pdp3.design-interface-handoff.v1';
  const expectedSources = [
    '.product-experience/pdp-1-domain-data/handoff-contracts.yaml#/handoffs/pdp1ToPdp2CanonicalDomain',
    `${base}DESIGN-LANGUAGE.md`,
    `${base}generated/experience-language.candidate.json`,
    `${base}component-contracts.yaml`,
    `${base}component-value-types.yaml`,
    `${base}media-token-aliases.yaml`,
    `${base}gui/templates/catalog.yaml`,
    `${base}gui/layout.yaml`,
    `${base}gui/recipes/catalog.yaml`,
    `${base}gui/composition-validation-grammar.yaml`,
    `${base}gui/semantic-component-bindings.yaml`,
    `${base}interface-grammar.yaml`,
    `${base}api/async-operations.yaml`,
    `${base}api/auth.yaml`,
    `${base}api/cancellation.yaml`,
    `${base}api/compatibility.yaml`,
    `${base}api/concurrency.yaml`,
    `${base}api/conventions.yaml`,
    `${base}api/correlation.yaml`,
    `${base}api/errors.yaml`,
    `${base}api/filtering-sorting.yaml`,
    `${base}api/http-canonical-adapters.yaml`,
    `${base}api/idempotency.yaml`,
    `${base}api/identifiers.yaml`,
    `${base}api/pagination.yaml`,
    `${base}api/read-consumer-adapters.yaml`,
    `${base}api/retry-timeout-unknown-outcome.yaml`,
    `${base}api/versioning.yaml`,
    `${base}cli-language.yaml`,
    `${base}cli/conventions.yaml`,
    `${base}sdk/conventions.yaml`,
    `${base}events/conventions.yaml`,
    `${base}agent-tools/conventions.yaml`,
    `${base}accessibility.yaml`,
    `${base}responsive-adaptive.yaml`,
    `${base}motion.yaml`,
    `${base}localization-content.yaml`,
  ];
  if (phaseHandoff?.id !== expectedOutputHandoff || phaseHandoff?.sourcePhase !== 'PDP-2'
      || phaseHandoff?.consumerPhase !== 'PDP-3' || phaseHandoff?.status !== 'DEFINITION_HANDOFF_CONTRACT'
      || !Array.isArray(phaseHandoff?.sourceRefs)
      || expectedSources.some(source => !phaseHandoff.sourceRefs.includes(source))
      || !Array.isArray(phaseHandoff?.consumerObligations) || phaseHandoff.consumerObligations.length < 6
      || !Array.isArray(phaseHandoff?.negativeCases) || phaseHandoff.negativeCases.length < 6
      || !Array.isArray(phaseHandoff?.deferredEvidence) || phaseHandoff.deferredEvidence.length < 3
      || !/development-gate-status-is-recorded-separately/u.test(phaseHandoff?.scopeStatus ?? '')) {
    integrityIssues.push('pdp2-pdp3-design-interface-handoff-incomplete');
  }
  const sourceRefs = phaseHandoff?.sourceRefs ?? [];
  for (const source of sourceRefs) {
    const file = source.split('#', 1)[0];
    if (!file || !fs.existsSync(path.join(repositoryRoot, file))) integrityIssues.push(`pdp2-handoff-source-missing:${source}`);
  }
  return {
    boundary: 'Finite PDP-2 design/interface source population and exact frozen PDP-1 input. Counts establish source inventory only; development completeness is established by the phase-specific suites and definition-only conformance check.',
    populations,
    componentFamilyIds: (components.components ?? []).map(record => record.id).filter(Boolean).sort(),
    importedHandoffIds: [expectedInputHandoff],
    exportedHandoffIds: integrityIssues.length === 0 ? [expectedOutputHandoff] : [],
    integrityIssues: [...new Set(integrityIssues)].sort(),
  };
}

export function buildPdp2DevStatus({mainSha, sourceShaSet = {}, verification = {}, sourceCensus, sourceCutStable = false, designConformance}) {
  const census = sourceCensus ?? {populations: {}, componentFamilyIds: [], importedHandoffIds: [], exportedHandoffIds: [], integrityIssues: ['source-census-not-built']};
  const testsActuallyRun = Object.fromEntries(p2Criteria.map(id => {
    const check = verification[id];
    return [id, check?.command ? {command: check.command, status: check.status, testCount: check.testCount,
      passedTestCount: check.passedTestCount, skippedTestCount: check.skippedTestCount ?? 0,
      outputSha256: check.outputSha256, testSourceFingerprints: check.testSourceFingerprints ?? {}, sourceCut: check.sourceCut ?? null} : {status: 'NOT_RUN'}];
  }));
  const testIssues = p2Criteria.filter(id => {
    const check = verification[id];
    const expectedFiles = [...(suites[id] ?? [])].sort();
    const fingerprints = check?.testSourceFingerprints ?? {};
    return check?.status !== 'PASS' || !(check?.testCount > 0)
      || check?.passedTestCount !== check?.testCount || (check?.skippedTestCount ?? 0) !== 0
      || typeof check?.outputSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(check.outputSha256)
      || JSON.stringify(Object.keys(fingerprints).sort()) !== JSON.stringify(expectedFiles)
      || Object.values(fingerprints).some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash));
  }).map(id => `${id}:focused-development-tests-not-green-or-source-pinned`);
  const conformanceValid = designConformance?.ok === true && designConformance.mode === 'DEFINITION_ONLY'
    && designConformance.screenInstanceScope === 'DEFERRED_PDP3_INSTANCE_VALIDATION'
    && designConformance.acceptanceClaim === 'NONE' && designConformance.summary?.unexplained === 0
    && JSON.stringify(designConformance.deferredAdmissionGates) === JSON.stringify([
      {id:'shared-artifact-binding', disposition:'EXTERNAL_PENDING'},
      {id:'conformance-and-specialist-review', disposition:'INDEPENDENT_PENDING'},
    ]);
  const outstandingMeaningIds = [...new Set([
    ...(census.integrityIssues ?? []).map(issue => `P2-09:${issue}`), ...testIssues,
    ...(!sourceCutStable ? ['P2-09:source-cut-changed-during-verification'] : []),
    ...(!conformanceValid ? ['P2-09:definition-only-design-conformance-not-green'] : []),
  ])].sort();
  const directDevelopmentCriteria = Object.fromEntries(p2Criteria.map(id => [id, {
    testStatus: verification[id]?.status ?? 'NOT_RUN',
    testCount: verification[id]?.testCount ?? 0,
    passedTestCount: verification[id]?.passedTestCount ?? 0,
  }]));
  return {
    schemaVersion: 'media.phase-dev-status.v1', phase: 'PDP-2', mainSha, sourceShaSet,
    sourcePopulations: census.populations, sourceFamilyIds: census.componentFamilyIds,
    importedHandoffIds: census.importedHandoffIds, exportedHandoffIds: census.exportedHandoffIds,
    outstandingMeaningIds, testsActuallyRun, directDevelopmentCriteria,
    definitionOnlyConformance: designConformance ? {
      status: conformanceValid ? 'PASS' : 'FAIL', mode: designConformance.mode,
      screenInstanceScope: designConformance.screenInstanceScope ?? 'NOT_RECORDED',
      acceptanceClaim: designConformance.acceptanceClaim,
      unexplainedFindingCount: designConformance.summary?.unexplained ?? null,
      deferredAdmissionGates: designConformance.deferredAdmissionGates ?? [],
      deferredP3ScreenCompositionFindings: designConformance.deferredP3ScreenCompositionFindings ?? [],
      scannedCanonicalScreenContracts: designConformance.summary?.screenContracts ?? 0,
    } : {status: 'NOT_RUN'},
    deferredAcceptance: ['Shared package release and owner acceptance', 'Independent design/accessibility certification', 'Runtime or production-host admission'],
    status: outstandingMeaningIds.length === 0 ? 'DEV_COMPLETE' : 'IN_PROGRESS',
  };
}
export function writePdp2DevStatus(status, repositoryRoot = root) {
  const outputPath = path.join(repositoryRoot, 'docs/implementation/pdp-2-phase-dev-status.json');
  fs.mkdirSync(path.dirname(outputPath), {recursive:true});
  fs.writeFileSync(outputPath, JSON.stringify(status, null, 2) + '\n');
  return outputPath;
}

/** Current finite PDP-3 denominator and its three frozen phase inputs. */
export function buildPdp3SourceCensus(repositoryRoot = root) {
  const read = file => parseYaml(fs.readFileSync(path.join(repositoryRoot, file), 'utf8'));
  const p3 = '.product-experience/pdp-3-product-experience/';
  const screenRegistry = read(`${p3}screen-registry.yaml`);
  const journeyRegistry = read(`${p3}journey-registry.yaml`);
  const stepOracles = read(`${p3}step-definition-oracles.yaml`);
  const purposeBindings = read(`${p3}journey-purpose-bindings.yaml`);
  const scenarioRegistry = read(`${p3}scenario-fixture-registry.yaml`);
  const actionRegistry = read(`${p3}action-registry.yaml`);
  const p0Status = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs/implementation/pdp-0-phase-dev-status.json'), 'utf8'));
  const p1Status = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs/implementation/pdp-1-phase-dev-status.json'), 'utf8'));
  const p2Status = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs/implementation/pdp-2-phase-dev-status.json'), 'utf8'));
  const p0Handoff = read('.product-experience/pdp-0-product-truth/handoff-contracts.yaml').pdpPhaseHandoffContracts?.pdp0ToPdp1CapabilityIntent;
  const p1Handoff = read('.product-experience/pdp-1-domain-data/handoff-contracts.yaml').handoffs?.pdp1ToPdp2CanonicalDomain;
  const p2Handoff = read('.product-experience/pdp-2-design-interface-system/handoff-contracts.yaml').handoffs?.pdp2ToPdp3DesignInterface;
  // The canonical screen denominator includes plan-baseline screens and
  // selected lane-specific views. Keep their source populations distinct in
  // the registry, but census and validate their combined canonical identity.
  const screens = [...(screenRegistry.screens ?? []), ...(screenRegistry.laneViews ?? [])];
  const journeys = journeyRegistry.journeys ?? [];
  const oracleJourneys = stepOracles.journeys ?? [];
  const screenIds = screens.map(row => row?.id).filter(Boolean);
  const journeyIds = journeys.map(row => row?.id).filter(Boolean);
  const oracleJourneyIds = oracleJourneys.map(row => row?.journeyId).filter(Boolean);
  const steps = oracleJourneys.flatMap(row => row.steps ?? []);
  const integrityIssues = [];
  const importedHandoffIds = [p0Handoff?.id, p1Handoff?.id, p2Handoff?.id].filter(Boolean);
  const expected = {
    p0: 'media.pdp0-pdp1.capability-intent-handoff.v1',
    p1: 'media.pdp1-pdp2.canonical-domain-handoff.v1',
    p2: 'media.pdp2-pdp3.design-interface-handoff.v1',
  };
  if (p0Status.phase !== 'PDP-0' || p0Status.status !== 'DEV_COMPLETE'
      || !(p0Status.exportedHandoffIds ?? []).includes(expected.p0)
      || p0Handoff?.id !== expected.p0 || p0Handoff?.status !== 'DEFINITION_HANDOFF_CONTRACT') {
    integrityIssues.push('frozen-pdp0-capability-intent-handoff-not-consumed');
  }
  if (p1Status.phase !== 'PDP-1' || p1Status.status !== 'DEV_COMPLETE'
      || !(p1Status.exportedHandoffIds ?? []).includes(expected.p1)
      || p1Handoff?.id !== expected.p1 || p1Handoff?.status !== 'DEFINITION_HANDOFF_CONTRACT') {
    integrityIssues.push('frozen-pdp1-domain-handoff-not-consumed');
  }
  if (p2Status.phase !== 'PDP-2' || p2Status.status !== 'DEV_COMPLETE'
      || !(p2Status.exportedHandoffIds ?? []).includes(expected.p2)
      || p2Handoff?.id !== expected.p2 || p2Handoff?.status !== 'DEFINITION_HANDOFF_CONTRACT'
      || p2Handoff?.sourcePhase !== 'PDP-2' || p2Handoff?.consumerPhase !== 'PDP-3') {
    integrityIssues.push('frozen-pdp2-design-interface-handoff-not-consumed');
  }
  if ((screenRegistry.screens ?? []).length !== 41 || (screenRegistry.laneViews ?? []).length !== 6
      || screens.length !== 47 || new Set(screenIds).size !== 47) integrityIssues.push('pdp3-screen-denominator-not-47-unique');
  if (journeys.length !== 30 || new Set(journeyIds).size !== 30
      || journeyRegistry.requiredMasterPlanJourneyCount !== 28 || journeyRegistry.additionalPdp0JourneyCount !== 2) {
    integrityIssues.push('pdp3-journey-denominator-not-30-unique');
  }
  if (stepOracles.journeyCount !== 30 || stepOracles.stepCount !== 130 || steps.length !== 130
      || new Set(oracleJourneyIds).size !== 30 || JSON.stringify([...journeyIds].sort()) !== JSON.stringify([...oracleJourneyIds].sort())
      || purposeBindings.recordCount !== 130 || purposeBindings.records?.length !== 130
      || new Set((purposeBindings.records ?? []).map(row => row.stepRef)).size !== 130) {
    integrityIssues.push('pdp3-step-or-purpose-denominator-not-130-exact');
  }
  for (const screen of screens) {
    const refs = screen.contractRefs ?? [];
    if (refs.length !== 1) {
      integrityIssues.push(`screen-contract-reference-cardinality:${screen.id ?? 'unknown'}`);
      continue;
    }
    const file = path.join(repositoryRoot, p3, refs[0]);
    if (!fs.existsSync(file)) integrityIssues.push(`screen-contract-source-missing:${screen.id}`);
    else {
      try {
        const contract = parseYaml(fs.readFileSync(file, 'utf8'));
        if (contract.screenId !== screen.id) integrityIssues.push(`screen-contract-identity-mismatch:${screen.id}`);
      } catch {
        integrityIssues.push(`screen-contract-source-invalid:${screen.id}`);
      }
    }
  }
  for (const journey of journeys) {
    if (typeof journey.contract !== 'string' || !journey.contract.endsWith('.yaml')
        || !fs.existsSync(path.join(repositoryRoot, p3, journey.contract))) {
      integrityIssues.push(`journey-contract-source-missing:${journey.id ?? 'unknown'}`);
    }
  }
  const scenarios = scenarioRegistry.scenarioCoverage ?? {};
  const journeyCoverage = scenarioRegistry.journeyCoverage ?? {};
  const seededJourneyIds = journeyCoverage.journeysWithExactSimulationSeeds ?? [];
  const explicitlyUnseededJourneyIds = journeyCoverage.journeysWithoutExactSimulationSeeds ?? [];
  const scenarioJourneyPartition = [...seededJourneyIds, ...explicitlyUnseededJourneyIds];
  if (scenarios.total !== 31 || scenarios.seededSyntheticDefinition !== 31
      || journeyCoverage.journeyContractCount !== 30
      || journeyCoverage.scenarioRecordCount !== 31
      || journeyCoverage.scenariosWithExactSeedAndStateOrContextBinding !== 31
      || journeyCoverage.scenarioReferencesBoundToJourneyContracts !== 31
      || journeyCoverage.journeysWithOneOrMoreExactScenarioSeeds !== seededJourneyIds.length
      || journeyCoverage.journeyContractsWithoutExactScenarioSeeds !== explicitlyUnseededJourneyIds.length
      || new Set(scenarioJourneyPartition).size !== 30
      || JSON.stringify([...scenarioJourneyPartition].sort()) !== JSON.stringify([...journeyIds].sort())
      || (scenarios.unimplementedFixturePayload ?? []).length !== 0) {
    integrityIssues.push('pdp3-scenario-seed-or-journey-coverage-not-current');
  }
  const unseededAudit = scenarioRegistry.unseededJourneyFixtureAudit ?? {};
  const unseededRows = unseededAudit.records ?? [];
  const unseededRowJourneyIds = new Set(unseededRows.map(row => row.journeyRef).filter(Boolean));
  const branchAudit = unseededAudit.branchApplicabilityAudit ?? {};
  const unknownOutcomeOracle = branchAudit.boundedOperationUnknownOutcomeFixtures ?? {};
  const unknownOutcomeRecords = unknownOutcomeOracle.records ?? [];
  const unknownOperationRefs = new Set(unknownOutcomeRecords.map(row => row.operationRef).filter(Boolean));
  const unknownBindings = new Set(unknownOutcomeRecords.map(row => `${row.journeyRef}\u0000${row.stepRef}\u0000${row.operationRef}`));
  const recoveryOracle = branchAudit.boundedRecoveryNoQueryFixtures ?? {};
  const recoveryRecords = recoveryOracle.records ?? [];
  const recoverySourceRefs = new Set(recoveryRecords.map(row => row.recoverySourceRef).filter(Boolean));
  const recoveryQueryOracle = branchAudit.boundedRecoveryObservationQueries ?? {};
  const recoveryQueryRecords = recoveryQueryOracle.records ?? [];
  const recoveryQuerySourceRefs = new Set(recoveryQueryRecords.map(row => row.stepRef).filter(Boolean));
  const j29RecoveryQuery = recoveryQueryRecords.find(row => row.journeyRef === 'J-29'
    && row.stepRef?.endsWith('/steps/1'));
  const expectedJ29RecoveryTupleFields = [
    'canonicalStateRef', 'stateAuthorityRef', 'stateEvidenceRef', 'consentRef', 'consentRevision',
    'consentCurrentness', 'purposeRef', 'purposeRevision', 'purposeCurrentness', 'leaseVersion',
    'leaseCurrentness', 'fencingToken', 'lastAcknowledgedSequence', 'nextSequence',
    'resolvedFrameOutcomeCoverage', 'resolvedFrameOutcomeRange', 'resolvedFrameOutcomeRefs',
    'reconnectBudgetRemaining',
  ];
  const unknownOutcomeCoverageValid = unknownOutcomeOracle.uniqueOperationCount === 44
    && unknownOperationRefs.size === 44 && unknownOutcomeOracle.sourceBindingOccurrenceCount === 59
    && unknownOutcomeOracle.boundStepOperationCount === 48 && unknownOutcomeRecords.length === 48
    && unknownBindings.size === 48
    && unknownOutcomeRecords.every(row => row.expectedOutcome === 'UNKNOWN_OUTCOME'
      && row.sameIdentityDisposition === 'REUSE_EXACT_SYNTHETIC_REQUEST_ONLY; no replacement request identity'
      && row.dispatch === 'NEVER' && row.replay === 'NEVER'
      && row.ownerAcceptedOutcomeOracle === false && row.runtimeAdmission === 'NOT_ADMITTED');
  const recoveryCoverageValid = unseededRows.length === 26
    && unseededRowJourneyIds.size === 26
    && JSON.stringify([...unseededRowJourneyIds].sort()) === JSON.stringify([...explicitlyUnseededJourneyIds].sort())
    && recoveryOracle.recoveryStepCount === 105 && recoveryRecords.length === 105
    && recoverySourceRefs.size === 105
    && recoveryQueryOracle.recordCount === 1 && recoveryQueryRecords.length === 1
    && recoveryQuerySourceRefs.size === 1
    && branchAudit.typedRecoveryObservationBoundary?.unimplementedRecoveryRuleSourceStepCount === 105
    && branchAudit.typedRecoveryObservationBoundary?.boundRecoveryObservationQueryCount === 1
    && branchAudit.typedRecoveryObservationBoundary?.boundRecoveryObservationStepRef === j29RecoveryQuery?.stepRef
    && recoveryRecords.every(row => typeof row.recoveryOracleStepRef === 'string'
      && row.oracleKind === 'SAFE_NO_QUERY_UNKNOWN_WHILE_TYPED_RECOVERY_IS_UNIMPLEMENTED'
      && row.conditionEvaluated === false && row.expectedObservation === 'UNKNOWN'
      && row.expectedDecision === 'HOLD_WITHOUT_EFFECT_OR_REPLAY'
      && row.dispatch === 'NEVER' && row.replay === 'NEVER'
      && row.ownerAcceptedOutcomeOracle === false && row.runtimeAdmission === 'NOT_ADMITTED')
    && recoveryRecords.every(row => !(row.journeyRef === 'J-29' && row.stepRef?.endsWith('/steps/1')))
    && j29RecoveryQuery?.operationRef === 'media.operation.stream-session.inspect-execution-recovery.v1'
    && j29RecoveryQuery.operationKind === 'QUERY'
    && j29RecoveryQuery.contractRef?.endsWith('/records/@id=media.operation.stream-session.inspect-execution-recovery.v1')
    && j29RecoveryQuery.requestSchemaRef?.endsWith('/records/@id=media.operation.stream-session.inspect-execution-recovery.v1/requestSchema')
    && j29RecoveryQuery.resultSchemaRef?.endsWith('/records/@id=media.operation.stream-session.inspect-execution-recovery.v1/resultSchema')
    && JSON.stringify(j29RecoveryQuery.snapshotIdentityFields) === JSON.stringify(['sessionId', 'observedAt', 'readVersion'])
    && JSON.stringify(j29RecoveryQuery.requiredObservationFields) === JSON.stringify(expectedJ29RecoveryTupleFields)
    && j29RecoveryQuery.conditionEvaluated === false && j29RecoveryQuery.dispatch === 'NEVER'
    && j29RecoveryQuery.replay === 'NEVER' && j29RecoveryQuery.ownerAcceptedOutcomeOracle === false
    && j29RecoveryQuery.runtimeAdmission === 'NOT_ADMITTED';
  if (!unknownOutcomeCoverageValid) integrityIssues.push('pdp3-unknown-outcome-definition-oracle-coverage-not-complete');
  if (!recoveryCoverageValid) integrityIssues.push('pdp3-recovery-definition-oracle-coverage-not-complete');
  const developmentOracleCoverage = {
    unseededJourneyContracts: unseededRows.length,
    operationUnknownOutcome: {
      uniqueOperationCount: unknownOperationRefs.size,
      sourceBindingOccurrenceCount: unknownOutcomeOracle.sourceBindingOccurrenceCount ?? 0,
      boundStepOperationCount: unknownBindings.size,
      status: unknownOutcomeCoverageValid ? 'PASS' : 'FAIL',
    },
    recoveryWithoutSameIdentityReadJoin: {
      sourceRecoveryStepCount: recoverySourceRefs.size + recoveryQuerySourceRefs.size,
      oracleCount: recoveryRecords.length,
      unimplementedTypedRecoverySteps: recoveryRecords.length,
      exactSupportingQueryCount: recoveryQueryRecords.length,
      status: recoveryCoverageValid ? 'BOUNDED_UNKNOWN_WITH_EXACT_QUERY_EXCEPTION' : 'FAIL',
    },
  };
  const populations = {
    screens: screens.length,
    baselineScreens: (screenRegistry.screens ?? []).length,
    laneSpecificViews: (screenRegistry.laneViews ?? []).length,
    journeys: journeys.length,
    orderedSteps: steps.length,
    purposeBindings: purposeBindings.records?.length ?? 0,
    uiActions: (actionRegistry.actions ?? []).length + (actionRegistry.ownerDefinedActions ?? []).length,
    scenarios: scenarios.total ?? 0,
    syntheticScenarioDefinitions: scenarios.seededSyntheticDefinition ?? 0,
    journeysWithSeededScenarios: seededJourneyIds.length,
    journeysExplicitlyWithoutSeededScenarios: explicitlyUnseededJourneyIds.length,
    operationUnknownOutcomeOracleBindings: unknownBindings.size,
    operationUnknownOutcomeSourceBindingOccurrences: unknownOutcomeOracle.sourceBindingOccurrenceCount ?? 0,
    boundedRecoveryNoQueryOracles: recoveryRecords.length,
  };
  return {
    boundary: 'Finite PDP-3 source denominator consuming the frozen PDP-0/PDP-1/PDP-2 handoffs. Source counts establish population integrity only; semantic development completeness is established by the phase-specific tests and strict current projection.',
    populations,
    developmentOracleCoverage,
    screenIds: [...screenIds].sort(),
    journeyIds: [...journeyIds].sort(),
    importedHandoffIds,
    exportedHandoffIds: [],
    integrityIssues: [...new Set(integrityIssues)].sort(),
  };
}

export function buildPdp3DevStatus({mainSha, sourceShaSet = {}, verification = {}, sourceCensus, sourceCutStable = false, projectionCheck}) {
  const census = sourceCensus ?? {populations: {}, screenIds: [], journeyIds: [], importedHandoffIds: [], exportedHandoffIds: [], integrityIssues: ['source-census-not-built']};
  const testsActuallyRun = Object.fromEntries(p3Criteria.map(id => {
    const check = verification[id];
    return [id, check?.command ? {command: check.command, status: check.status, testCount: check.testCount,
      passedTestCount: check.passedTestCount, skippedTestCount: check.skippedTestCount ?? 0,
      outputSha256: check.outputSha256, testSourceFingerprints: check.testSourceFingerprints ?? {}, sourceCut: check.sourceCut ?? null} : {status: 'NOT_RUN'}];
  }));
  const testIssues = p3Criteria.filter(id => {
    const check = verification[id];
    const expectedFiles = [...(suites[id] ?? [])].sort();
    const fingerprints = check?.testSourceFingerprints ?? {};
    return check?.status !== 'PASS' || !(check?.testCount > 0)
      || check?.passedTestCount !== check?.testCount || (check?.skippedTestCount ?? 0) !== 0
      || typeof check?.outputSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(check.outputSha256)
      || JSON.stringify(Object.keys(fingerprints).sort()) !== JSON.stringify(expectedFiles)
      || Object.values(fingerprints).some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash));
  }).map(id => `${id}:focused-development-tests-not-green-or-source-pinned`);
  const fieldMappingBlockerAuditPresent = Array.isArray(projectionCheck?.fieldMappingBlockers);
  const fieldMappingBlockerIssues = !fieldMappingBlockerAuditPresent
    ? ['P3-01:semantic-field-mapping-blocker-audit-missing']
    : projectionCheck.fieldMappingBlockers.map(blocker =>
      `P3-01:unresolved-semantic-field:${blocker.field ?? 'unknown'}`);
  const oracleCoverage = census.developmentOracleCoverage ?? {};
  const oracleCoverageIssues = [];
  if (oracleCoverage.operationUnknownOutcome?.status !== 'PASS'
      || oracleCoverage.operationUnknownOutcome.uniqueOperationCount !== 44
      || oracleCoverage.operationUnknownOutcome.sourceBindingOccurrenceCount !== 59
      || oracleCoverage.operationUnknownOutcome.boundStepOperationCount !== 48) {
    oracleCoverageIssues.push('P3-05:bounded-operation-unknown-outcome-oracles-incomplete');
  }
  if (oracleCoverage.recoveryWithoutSameIdentityReadJoin?.status !== 'BOUNDED_UNKNOWN_WITH_EXACT_QUERY_EXCEPTION'
      || oracleCoverage.recoveryWithoutSameIdentityReadJoin.sourceRecoveryStepCount !== 106
      || oracleCoverage.recoveryWithoutSameIdentityReadJoin.oracleCount !== 105
      || oracleCoverage.recoveryWithoutSameIdentityReadJoin.unimplementedTypedRecoverySteps !== 105
      || oracleCoverage.recoveryWithoutSameIdentityReadJoin.exactSupportingQueryCount !== 1) {
    oracleCoverageIssues.push('P3-05:bounded-recovery-no-query-oracles-incomplete');
  }
  const projectionValid = projectionCheck?.status === 'PASS' && projectionCheck.current === true
    && projectionCheck.schemaValid === true && projectionCheck.publicValidatorPassed === true
    && fieldMappingBlockerAuditPresent && projectionCheck.fieldMappingBlockers.length === 0;
  const outstandingMeaningIds = [...new Set([
    ...(census.integrityIssues ?? []).map(issue => `P3-10:${issue}`), ...testIssues,
    ...fieldMappingBlockerIssues, ...oracleCoverageIssues,
    ...(!sourceCutStable ? ['P3-10:source-cut-changed-during-verification'] : []),
    ...(!projectionValid ? ['P3-01:strict-current-public-projection-not-green'] : []),
  ])].sort();
  const directDevelopmentCriteria = Object.fromEntries(p3Criteria.map(id => [id, {
    testStatus: verification[id]?.status ?? 'NOT_RUN',
    testCount: verification[id]?.testCount ?? 0,
    passedTestCount: verification[id]?.passedTestCount ?? 0,
  }]));
  return {
    schemaVersion: 'media.phase-dev-status.v1', phase: 'PDP-3', mainSha, sourceShaSet,
    sourcePopulations: census.populations, screenIds: census.screenIds, journeyIds: census.journeyIds,
    importedHandoffIds: census.importedHandoffIds, exportedHandoffIds: census.exportedHandoffIds,
    developmentOracleCoverage: census.developmentOracleCoverage ?? null,
    outstandingMeaningIds, testsActuallyRun, directDevelopmentCriteria,
    strictCurrentProjection: projectionCheck ? {
      status: projectionValid ? 'PASS' : 'FAIL',
      current: projectionCheck.current ?? false,
      schemaValid: projectionCheck.schemaValid ?? false,
      publicValidatorPassed: projectionCheck.publicValidatorPassed ?? false,
      semanticFieldMappingAudited: fieldMappingBlockerAuditPresent,
      semanticFieldBlockerCount: projectionCheck.fieldMappingBlockers?.length ?? null,
      outputSha256: projectionCheck.outputSha256 ?? null,
    } : {status: 'NOT_RUN'},
    deferredAcceptance: ['Lifecycle receipts and convergence', 'Independent PDP certification', 'External Shared service acceptance', 'Runtime, production-host, and release admission'],
    status: outstandingMeaningIds.length === 0 ? 'DEV_COMPLETE' : 'IN_PROGRESS',
  };
}

export function writePdp3DevStatus(status, repositoryRoot = root) {
  const outputPath = path.join(repositoryRoot, 'docs/implementation/pdp-3-phase-dev-status.json');
  fs.mkdirSync(path.dirname(outputPath), {recursive:true});
  fs.writeFileSync(outputPath, JSON.stringify(status, null, 2) + '\n');
  return outputPath;
}
export function buildP103TestArgs(groupName, repositoryRoot = root) {
  const group = p103VerificationSuites[groupName];
  if (!group) throw new Error(`Unknown P1-03 verification group: ${groupName}`);
  return ['--test', ...(group.testNamePattern ? [`--test-name-pattern=${group.testNamePattern}`] : []),
    ...group.files.map(file => path.resolve(repositoryRoot,file))];
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
  if(args.some(a=>!['--verify','--write'].includes(a) && !a.startsWith('--verify-tasks=') && !a.startsWith('--phase-dev-status='))) throw new Error('Usage: report-media-pdp-readiness.mjs [--verify] [--verify-tasks=P0-01,P0-02,...] [--phase-dev-status=PDP-0|PDP-1|PDP-2|PDP-3] [--write]');
  if(phaseStatus && (!['PDP-0','PDP-1','PDP-2','PDP-3'].includes(phaseStatus) || !args.includes('--verify'))) throw new Error('--phase-dev-status supports PDP-0 through PDP-3 and requires --verify');
  const selectedTasksArg=args.find(a=>a.startsWith('--verify-tasks='));
  const phaseCriteria=phaseStatus==='PDP-1'?p1Criteria:phaseStatus==='PDP-2'?p2Criteria:phaseStatus==='PDP-3'?p3Criteria:p0Criteria;
  const selectedTasks=selectedTasksArg ? selectedTasksArg.slice('--verify-tasks='.length).split(',') : phaseStatus ? phaseCriteria : Object.keys(suites);
  if(selectedTasks.some(id=>!Object.hasOwn(suites,id)) || new Set(selectedTasks).size!==selectedTasks.length) throw new Error('Verification tasks must name distinct configured PDP suites');
  if(selectedTasksArg && !args.includes('--verify')) throw new Error('--verify-tasks requires --verify');
  const auditPath='docs/implementation/media-task-completion-blocker-report-2026-10-08.json';
  const audit=JSON.parse(fs.readFileSync(path.join(root,auditPath),'utf8'));
  // The implementation plan is an execution ledger, not normative phase input;
  // pinning it would make a phase-status update stale when the ledger is corrected.
  const p0PinnedSources = ['.product-experience/pdp-0-product-truth', '.product-experience/authority-map.yaml', '.product-experience/gaps.yaml', '.product-experience/decision-log.md', '.product-experience/source-manifest.yaml', '.product-experience/artifact-identities.yaml', 'docs/migration/current-master-plan-claim-dispositions.json', 'docs/migration/master-plan-source-change-claims.yaml', 'docs/PRODUCT-DEFINITION-COVERAGE.md', 'docs/implementation/verification/pdp-38/direct-definition-criteria-review.json', 'docs/implementation/verification/pdp-38/migration-current-material-review.json', 'docs/implementation/verification/pdp-38/migration-p0-current-material-review.json', 'docs/implementation/verification/pdp-38/migration-current-owner-target-observations.json', 'docs/implementation/verification/pdp-38/migration-p0-current-source-observations.json', 'docs/implementation/verification/pdp-38/p0-leaf-trust-current-type-drift-inventory.json', 'docs/implementation/verification/pdp-38/policy-input-threats-current-source-observation.json', 'docs/implementation/verification/pdp-38/pending-locator-current-source-observations.json', 'docs/implementation/verification/pdp-38/p0-capability-intent-owner-binding-current-source-observation.json', 'docs/implementation/verification/pdp-38/p0-capability-semantic-current-source-review.json', 'docs/implementation/verification/pdp-38/p0-existing-operation-semantic-corrections-current-source-review.json', 'docs/implementation/verification/pdp-38/p0-upload-byte-length-minimum-current-source-review.json', 'docs/implementation/verification/pdp-38/p0-quality-current-source-review.json', 'docs/implementation/verification/pdp-38/feature-review-animation-property-owner-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-audio-defects-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-audio-naturalness-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-cli-channel-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-policy-authority-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-quality-current-source-observation.json', 'docs/implementation/verification/pdp-38/feature-review-qualification-policy-current-source-observation.json', 'apps/media-experience-explorer/specification-artifacts.json'];
  const p0DirectScripts = ['scripts/report-media-pdp-readiness.mjs', 'scripts/lib/media-product-definition-residuals.mjs', 'scripts/lib/pdp0-feature-review-applicability.mjs', 'scripts/lib/product-definition-domain-rule-mapping.mjs', 'scripts/generate-media-phase-projections.mjs', 'scripts/generate-media-product-manifest.mjs', 'scripts/check-product-definition-authority.mjs'];
  const sourceRoots=phaseStatus==='PDP-1'?p1SourceRoots:phaseStatus==='PDP-2'?p2SourceRoots:phaseStatus==='PDP-3'?p3SourceRoots:p0PinnedSources;
  const phaseScripts=phaseStatus==='PDP-1'?['scripts/report-media-pdp-readiness.mjs']:phaseStatus==='PDP-2'?p2DirectScripts:phaseStatus==='PDP-3'?p3DirectScripts:p0DirectScripts;
  const sourceCut = (testFiles) => Object.fromEntries([...new Set([...execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...(phaseStatus ? sourceRoots : ['.product-experience']), ...(phaseStatus ? phaseScripts : ['scripts', 'config/closure', 'libs/media-experience-simulation'])], {cwd:root,encoding:'utf8'})
    .trim().split('\n'), ...testFiles])].filter(file => file && fs.existsSync(path.join(root,file)) && fs.statSync(path.join(root,file)).isFile()).map(file => [file,digest(file)]));
  const phaseSourceFiles=phaseStatus ? [...new Set([...phaseCriteria.flatMap(id=>suites[id]),...(phaseStatus==='PDP-1'?p1DeferredEvidenceFiles:[]),...sourceRoots,...phaseScripts])] : [];
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
    // input must be one explicit test file under tests/ or a package tests/ dir.
    if(!Array.isArray(files) || files.length===0 || files.some(file=>
      !isExplicitVerificationTestPath(file)
      || !fs.existsSync(path.join(root,file)) || !fs.statSync(path.join(root,file)).isFile())) {
      throw new Error(`${id} verification requires explicit existing *.test.mjs files under tests/ or libs/**/tests/`);
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
    const p103Groups = id === 'P1-03' ? p103VerificationSuites : null;
    const runGroup = (groupName, group) => {
      const groupFiles = group.files;
      const args = buildP103TestArgs(groupName);
      const result = spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',env:testEnv,maxBuffer:64*1024*1024});
      const output = (result.stdout??'')+(result.stderr??'');
      const testCount = Number((result.stdout??'').match(/# tests\s+(\d+)/)?.[1] ?? 0);
      const passedTestCount = Number((result.stdout??'').match(/# pass\s+(\d+)/)?.[1] ?? 0);
      const skippedTestCount = Number((result.stdout??'').match(/# skipped\s+(\d+)/)?.[1] ?? 0);
      const status = result.status===0 && !result.error && testCount>0 && passedTestCount===testCount && skippedTestCount===0 ? 'PASS' : 'FAIL';
      return {status,command:`node ${args.join(' ')}`,exitCode:result.status,testCount,passedTestCount,skippedTestCount,
        outputSha256:crypto.createHash('sha256').update(output).digest('hex'),testSourceFingerprints:Object.fromEntries(groupFiles.map(file=>[file,digest(file)])),output};
    };
    const groupResults = p103Groups ? Object.fromEntries(Object.entries(p103Groups).map(([name, group]) => [name,runGroup(name,group)])) : null;
    const result=p103Groups ? null : spawnSync(process.execPath,testArgs,{cwd:root,encoding:'utf8',env:testEnv,maxBuffer:64*1024*1024});
    const changedSources = verificationCutChanged(before, sourceCut(files));
    const output=p103Groups ? Object.values(groupResults).map(group=>group.output).join('\n') : (result.stdout??'')+(result.stderr??'');
    const testCount=p103Groups ? Object.values(groupResults).reduce((sum,group)=>sum+group.testCount,0) : Number((result.stdout??'').match(/# tests\s+(\d+)/)?.[1] ?? 0);
    const passedTestCount=p103Groups ? Object.values(groupResults).reduce((sum,group)=>sum+group.passedTestCount,0) : Number((result.stdout??'').match(/# pass\s+(\d+)/)?.[1] ?? 0);
    const skippedTestCount=p103Groups ? Object.values(groupResults).reduce((sum,group)=>sum+group.skippedTestCount,0) : Number((result.stdout??'').match(/# skipped\s+(\d+)/)?.[1] ?? 0);
    const expectedSkippedTestCount=id==='P0-03'?10:0;
    const status=(p103Groups ? Object.values(groupResults).every(group=>group.status==='PASS') : result.status===0 && !result.error) && testCount>0 && passedTestCount>0
      && skippedTestCount===expectedSkippedTestCount
      && passedTestCount+skippedTestCount===testCount?'PASS':'FAIL';
    verification[id]={status,command:p103Groups ? Object.values(groupResults).map(group=>group.command).join(' && ') : `${testEnv.PDP_MIGRATION_CANDIDATE_PHASE?`PDP_MIGRATION_CANDIDATE_PHASE=${testEnv.PDP_MIGRATION_CANDIDATE_PHASE} `:''}${testEnv.PDP_DEV_PHASE?`PDP_DEV_PHASE=${testEnv.PDP_DEV_PHASE} `:''}node ${testArgs.map(arg=>arg.includes(' ')?JSON.stringify(arg):arg).join(' ')}`,exitCode:p103Groups ? (status==='PASS'?0:1) : result.status,
      ...(p103Groups ? {suites:Object.fromEntries(Object.entries(groupResults).map(([name,group])=>[name,{...group,output:undefined}]))} : result.error ? {executionError:result.error.message} : {}),
      testScope:directTestNames[id] ? 'Exact bounded task-specific source criteria; broader phase diagnostics are separate' : 'Bounded implementation assertions; no whole-task completion inferred',
      testCount,passedTestCount,skippedTestCount,
      outputSha256:crypto.createHash('sha256').update(output).digest('hex'),testSourceFingerprints:Object.fromEntries(files.map(f=>[f,digest(f)]))};
    verification[id].sourceCut = {fingerprints:before, changedDuringVerification:changedSources};
    if (verification[id].status==='PASS' && changedSources.length) verification[id].status='PASS_ON_CHANGED_SOURCE_CUT_REVALIDATION_REQUIRED';
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
    if (phaseStatus === 'PDP-3') {
      const phaseSourceCutAfter = sourceCut(phaseSourceFiles);
      const phaseSourceChanged = verificationCutChanged(phaseSourceCutBefore, phaseSourceCutAfter);
      const sourceCensus = buildPdp3SourceCensus(root);
      const projection = spawnSync(process.execPath, ['scripts/generate-media-phase-projections.mjs', '--check', '--strict'],
        {cwd:root, encoding:'utf8', maxBuffer:64*1024*1024});
      const projectionOutput = (projection.stdout ?? '') + (projection.stderr ?? '');
      const candidatePath = path.join(root, '.product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json');
      const candidate = fs.existsSync(candidatePath) ? JSON.parse(fs.readFileSync(candidatePath, 'utf8')) : {};
      const projectionCheck = {
        status: projection.status === 0 && !projection.error ? 'PASS' : 'FAIL',
        current: projection.status === 0 && !projection.error,
        schemaValid: candidate.validation?.schemaValid === true,
        publicValidatorPassed: candidate.validation?.publicValidatorPassed === true,
        fieldMappingBlockers: candidate.fieldMappingBlockers,
        outputSha256: crypto.createHash('sha256').update(projectionOutput).digest('hex'),
      };
      const status = buildPdp3DevStatus({
        mainSha: execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root, encoding:'utf8'}).trim(),
        sourceShaSet: phaseSourceCutBefore, verification, sourceCensus,
        sourceCutStable: phaseSourceChanged.length === 0, projectionCheck,
      });
      if (phaseSourceChanged.length) status.outstandingMeaningIds.push(...phaseSourceChanged.map(file => `P3-10:changed-source:${file}`));
      status.status = status.outstandingMeaningIds.length === 0 ? 'DEV_COMPLETE' : 'IN_PROGRESS';
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      if (args.includes('--write')) writePdp3DevStatus(status, root);
      if (status.status !== 'DEV_COMPLETE' || Object.values(verification).some(result => result.status !== 'PASS')) process.exitCode = 1;
    } else if (phaseStatus === 'PDP-2') {
      const phaseSourceCutAfter = sourceCut(phaseSourceFiles);
      const phaseSourceChanged = verificationCutChanged(phaseSourceCutBefore, phaseSourceCutAfter);
      const sourceCensus = buildPdp2SourceCensus(root);
      const designConformance = analyzeDesignConformance(root, {definitionOnly:true, includeP3ScreenInstances:false});
      const status = buildPdp2DevStatus({
        mainSha: execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root, encoding:'utf8'}).trim(),
        sourceShaSet: phaseSourceCutBefore, verification, sourceCensus,
        sourceCutStable: phaseSourceChanged.length === 0, designConformance,
      });
      if (phaseSourceChanged.length) status.outstandingMeaningIds.push(...phaseSourceChanged.map(file => `P2-09:changed-source:${file}`));
      status.status = status.outstandingMeaningIds.length === 0 ? 'DEV_COMPLETE' : 'IN_PROGRESS';
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      if (args.includes('--write')) writePdp2DevStatus(status, root);
      if (status.status !== 'DEV_COMPLETE' || Object.values(verification).some(result => result.status !== 'PASS')) process.exitCode = 1;
    } else if (phaseStatus === 'PDP-1') {
      const phaseSourceCutAfter = sourceCut(phaseSourceFiles);
      const phaseSourceChanged = verificationCutChanged(phaseSourceCutBefore, phaseSourceCutAfter);
      const census = buildPdp1SourceCensus(root);
      const reviewPath = 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json';
      const semanticReview = fs.existsSync(path.join(root, reviewPath))
        ? JSON.parse(fs.readFileSync(path.join(root, reviewPath), 'utf8')) : null;
      const status = buildPdp1DevStatus({
        mainSha: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
        sourceShaSet: phaseSourceCutBefore, verification, sourceCensus: census, semanticReview,
        exportedHandoffIds: census.exportedHandoffIds ?? [],
        sourceCutStable: phaseSourceChanged.length === 0,
      });
      if (JSON.stringify([...(semanticReview?.exportedHandoffIds ?? [])].sort()) !== JSON.stringify([...(census.exportedHandoffIds ?? [])].sort())) {
        status.outstandingMeaningIds.push('P1-11:semantic-review-handoff-does-not-match-current-source-contract');
      }
      if (phaseSourceChanged.length) status.outstandingMeaningIds.push(...phaseSourceChanged.map(file => `P1-11:changed-source:${file}`));
      status.status = status.outstandingMeaningIds.length === 0 ? 'DEV_COMPLETE' : 'IN_PROGRESS';
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      if (args.includes('--write')) writePdp1DevStatus(status, root);
      if (status.status !== 'DEV_COMPLETE' || Object.values(verification).some(result => result.status !== 'PASS')) process.exitCode = 1;
    } else {
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
    }
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
