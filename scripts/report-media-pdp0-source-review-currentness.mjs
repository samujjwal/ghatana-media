#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  PDP0_CRITERIA, PDP0_DIRECT_REVIEW_REF, PDP0_MATRIX_REF, PDP0_READINESS_REF, PDP0_STATUS_REF,
  PDP0_REVIEW_INPUT_DIRECTORY, inspectPdp0CurrentSourceReviewCurrentness, resolveReviewRecordFiles,
} from './lib/media-pdp0-current-source-review-assembler.mjs';
import {resolveMediaPdp0Cells} from './media-discovery-currentness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = 'docs/implementation/observations/media-pdp0-source-review-currentness-2026-11-17.json';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const read = ref => fs.readFileSync(path.resolve(root, ref), 'utf8');

const materialSemanticReview = [
  {
    criterionId: 'P0-01',
    disposition: 'MATERIAL_SOURCE_DELTA_REVIEW_REQUIRED',
    deltas: [
      {sourceRef: '.product-experience/pdp-0-product-truth/capabilities.yaml#media.recipe.specification.compile', decisionRef: '.product-experience/decision-log.md#PXD-226', meaning: 'Adds a bounded, reviewable schema-migration candidate to the existing compile capability; ordinary compile and source preservation remain unchanged.'},
      {sourceRef: '.product-experience/pdp-0-product-truth/quality-policy.yaml#ownerQualityApplicabilityCrosswalkExtensions', decisionRef: '.product-experience/decision-log.md#PXD-227', meaning: 'Adds the exact compile quality-applicability extension; measurement and qualification remain not evaluated.'},
      {sourceRef: '.product-experience/pdp-0-product-truth/quality-policy.yaml#ownerQualityApplicabilityCrosswalkExtensions', decisionRef: '.product-experience/decision-log.md#PXD-229', meaning: 'Adopts the source-defined applicability row while preserving the historical 462 quality rows.'},
    ],
  },
  {
    criterionId: 'P0-02',
    disposition: 'MATERIAL_SOURCE_DELTA_REVIEW_REQUIRED',
    deltas: [
      {sourceRef: '.product-experience/pdp-0-product-truth/requirements.yaml#MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases', decisionRef: '.product-experience/decision-log.md#PXD-226', meaning: 'Adds acceptance cases AC-15/16/17 for ordinary compile, version-bound migration candidates, and fail-closed incomplete migration inputs.'},
    ],
  },
  {
    criterionId: 'P0-05',
    disposition: 'SEMANTIC_REUSE; REVIEW_BINDING_REFRESH_REQUIRED',
    semanticSourceComparison: 'PDP-0 constitution, policy authority, actor responsibility, domain model, and the three referenced PDP-1 state/transition/authority files are semantically unchanged from the historical review baseline.',
    currentDecisionRef: '.product-experience/decision-log.md#PXD-208',
  },
  {
    criterionId: 'P0-06',
    disposition: 'SEMANTIC_REUSE; REVIEW_BINDING_REFRESH_REQUIRED',
    semanticSourceComparison: 'goals-jtbd.yaml and generated/product-definition.candidate.json are semantically unchanged from the historical review baseline.',
    currentDecisionRef: '.product-experience/decision-log.md#PXD-196',
  },
  {
    criterionId: 'P0-07',
    disposition: 'MATERIAL_SOURCE_DELTA_REVIEW_REQUIRED',
    deltas: [
      {sourceRef: '.product-experience/pdp-0-product-truth/applications-channels.yaml#coordinatorDefinitionExtensionApplicability', decisionRef: '.product-experience/decision-log.md#PXD-231', meaning: 'Resolves three exact AUD-SPEC-020 surface/channel pairs while preserving the 56-identity denominator.'},
      {sourceRef: '.product-experience/pdp-0-product-truth/capabilities.yaml#media.recipe.specification.compile', decisionRef: '.product-experience/decision-log.md#PXD-226', meaning: 'Adds the selected compile migration extension and retains six future-version proposals.'},
      {sourceRef: '.product-experience/pdp-0-product-truth/requirements.yaml#MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases', decisionRef: '.product-experience/decision-log.md#PXD-226', meaning: 'Adds AC-15/16/17 to the source-bound recipe-template requirement.'},
    ],
    unresolvedFindingIds: ['P0-07-FAMILY-CASE-SEMANTIC-FIT-UNKNOWN-231'],
    unresolvedFindingDisposition: 'The 231 feature-family case semantic-fit rows remain open in the prior criterion review; PXD-231 resolves three surface applicability cells and does not resolve those rows.',
  },
];

export function buildMediaPdp0SourceReviewCurrentnessReport() {
  const status = JSON.parse(read(PDP0_STATUS_REF));
  const readiness = JSON.parse(read(PDP0_READINESS_REF));
  const directReview = JSON.parse(read(PDP0_DIRECT_REVIEW_REF));
  const matrix = JSON.parse(read(PDP0_MATRIX_REF));
  const reviewRecords = resolveReviewRecordFiles({read});
  const currentness = inspectPdp0CurrentSourceReviewCurrentness({status, readiness, directReview, matrix, reviewRecords, read});
  const topology = resolveMediaPdp0Cells(root);
  const uniquePaths = [...new Set(topology.cells.flatMap(cell => cell.paths))].sort();
  const surfaceRows = matrix.surfaces.map(row => ({
    surfaceId: row.surfaceId,
    surfaceType: row.surfaceType,
    phase: row.phase,
    applicability: row.applicability?.disposition ?? 'UNKNOWN',
    sourceCurrent: row.sourceCurrent,
    developmentStatus: row.developmentStatus,
    remainingPhaseLocalTaskIds: row.remainingPhaseLocalTaskIds ?? [],
    blockerOwner: row.blockerOwner ?? null,
    acceptanceCriterion: row.acceptanceCriterion,
    nextLegalAction: row.nextLegalAction,
  }));
  const sourceRefs = [
    PDP0_STATUS_REF, PDP0_READINESS_REF, PDP0_DIRECT_REVIEW_REF, PDP0_MATRIX_REF,
    '.product-experience/surfaces/media-physical-topology.v1.json',
    '.product-experience/source-manifest.yaml',
    '.product-experience/decision-log.md',
    ...PDP0_CRITERIA.map(id => `${PDP0_REVIEW_INPUT_DIRECTORY}/${id}.v4.json`),
    'scripts/lib/media-pdp0-current-source-review-assembler.mjs',
    'scripts/lib/media-pdp0-review-successor-plan.mjs',
    'scripts/lib/media-pdp0-source-development-current-cut.mjs',
    'scripts/record-media-discovery-pdp0-currentness.mjs',
    'scripts/report-media-pdp0-source-review-currentness.mjs',
    `${PDP0_REVIEW_INPUT_DIRECTORY}/revision-decision.v3.schema.json`,
    `${PDP0_REVIEW_INPUT_DIRECTORY}/peer-review-record.v1.schema.json`,
    `${PDP0_REVIEW_INPUT_DIRECTORY}/technical-reviewer-authority.v1.schema.json`,
  ];
  const sourceFingerprintSet = Object.fromEntries([...new Set(sourceRefs)].sort().map(ref => [ref, digest(read(ref))]));
  const sourceBaseline = {
    repository: 'samujjwal/ghatana-media',
    repositoryHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    workingTree: 'DIRTY_PRESERVED',
    phaseStatusHead: status.mainSha,
    sourceFingerprintSet,
  };
  const allSemanticDeltaCriterionIds = materialSemanticReview.filter(item => item.disposition.startsWith('MATERIAL_')).map(item => item.criterionId);
  const selectedReviewInputs = currentness.criteria.filter(item => item.inCurrentnessReviewScope);
  return {
    schemaVersion: 'media.pdp0.source-review-currentness-observation.v1',
    recordId: 'MEDIA-PDP0-SOURCE-REVIEW-CURRENTNESS-2026-11-17',
    campaign: {
      macroStage: 'DISCOVERY',
      exactPhase: 'PDP-0 Product Truth',
      selectedReviewUnit: 'PD-M1 Media direct-definition source review currentness',
      denominator: matrix.summary,
      topologyDerivedMaterialPathCount: uniquePaths.length,
      sourceBaseline,
    },
    prerequisiteState: {
      phaseStatus: status.status,
      statusSourcePins: currentness.phaseStatusPinInventory,
      surfaceMatrixPhaseSourceCurrentness: matrix.phaseSourceCurrentness,
      sourceAuditDispositionValidation: matrix.auditDispositionValidation,
      surfaceDenominatorValidation: matrix.denominatorValidation,
      surfaceCellCount: matrix.surfaces.length,
      remainingPhaseLocalDefinitionTaskCount: matrix.summary.remainingPhaseLocalTaskCount,
      cellsNotAtDevComplete: matrix.summary.inProgressCells,
    },
    permittedWork: 'Bounded PDP-0 source review/currentness observation and validator repair only; no owner acceptance, independent acceptance, phase-status promotion, closure, Build admission, Delivery, or release.',
    materialSemanticReview,
    projectionOnlyChanges: [{
      sourceRef: '.product-experience/surfaces/media-physical-topology.v1.json',
      decisionRef: '.product-experience/decision-log.md#PXD-230',
      predecessorDenominator: {physical: 26, compositions: 7, logicalConsumers: 21, total: 54},
      currentDenominator: {physical: 28, compositions: 7, logicalConsumers: 21, total: 56},
      disposition: 'STATUS_PROJECTION_RECONCILIATION; preserve the old 54-row status as predecessor and do not infer DEV_COMPLETE.',
    }],
    technicalCurrentness: currentness,
    selectedReviewScopeStatus: selectedReviewInputs.every(item => item.technicalReviewCurrentness === 'SOURCE_CURRENT')
      && currentness.phaseStatusPinInventory.currentness === 'CURRENT'
      ? 'PASS' : 'FAIL',
    successorWorkflow: {
      identityOnlyPeerClaimAccepted: false,
      peerReviewRecordSchemaRef: `${PDP0_REVIEW_INPUT_DIRECTORY}/peer-review-record.v1.schema.json`,
      reviewerAuthoritySchemaRef: `${PDP0_REVIEW_INPUT_DIRECTORY}/technical-reviewer-authority.v1.schema.json`,
      sourceOwnerDecisionRef: `${PDP0_REVIEW_INPUT_DIRECTORY}/source-owner-decision.v3.json`,
      sourceOwnerDecisionPresent: fs.existsSync(path.resolve(root, `${PDP0_REVIEW_INPUT_DIRECTORY}/source-owner-decision.v3.json`)),
      peerRecordStatus: 'NO_CURRENT_SOURCE_BOUND_PEER_RECORD_RECORDED',
      canonicalDirectReviewWrite: 'NOT_PERFORMED',
      applyAuthorization: 'NOT_PRESENT',
    },
    physicalCompositeSurfaceMatrix: surfaceRows,
    discoveryStatus: {
      mediaPdp0Unit: matrix.summary.inProgressCells === 0 && matrix.summary.remainingPhaseLocalTaskCount === 0
        ? 'SOURCE_TASKS_ZERO; DEV_COMPLETE_NOT_ESTABLISHED'
        : 'INCOMPLETE',
      campaignDiscoveryRollup: 'FAIL',
      buildLane: 'NOT_ADMITTED; current source review inputs remain stale and Media PDP-0 status is IN_PROGRESS.',
      pdpClosureLane: 'NOT_ENTERED',
      deliveryGate: 'BLOCKED',
      nextAllowedPhase: 'PDP-0 Product Truth current-source review refresh; do not advance to PDP-1 until this unit meets the source-current DEV_COMPLETE gate.',
      staleMaterialReviewCriteria: allSemanticDeltaCriterionIds,
      reviewMetadataRefreshCriteria: ['P0-05', 'P0-06'],
      otherPdp0CriterionBlockers: [
        {criterionId: 'P0-03', classification: 'DEFINITION_REVIEW_NOT_ESTABLISHED', owner: 'Media migration semantic owner and required independent migration reviewer', nextAction: 'Continue the exact migration semantic reconciliation under PDP-0; do not mark the definition criterion complete from direct source tests.'},
        {criterionId: 'P0-07', classification: 'MATERIAL_DEFINITION_ROWS_OPEN', owner: 'Media PDP-0 Product Truth owner', nextAction: 'Keep all 231 feature-specific parent-case semantic-fit rows open until the owning PDP-0 source is updated and revalidated.'},
        {criterionId: 'P0-08', classification: 'INDEPENDENT_ACCEPTANCE_NOT_PERFORMED', owner: 'Appointed independent Product Definition reviewer / acceptance owner', nextAction: 'Keep P0-010 NOT_PERFORMED; do not claim acceptance, closure, Build admission, or Delivery.'},
      ],
    },
    authorityBoundary: {
      ownerApproval: 'NOT_CLAIMED',
      independentAcceptance: 'NOT_CLAIMED',
      pdp010Acceptance: 'NOT_PERFORMED',
      phaseStatusEffect: 'NONE',
      nativeClosure: 'NOT_CLAIMED',
      releaseQualification: 'NOT_PERFORMED',
    },
    claimBoundary: 'This is an AI technical source-currentness observation. Historical review identities and baselines are preserved as provenance; stale direct-review records are not relabeled current. It records no owner decision, independent peer approval, phase completion, closure, qualification, or release.',
  };
}

function main() {
  const check = process.argv.includes('--check');
  const output = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length) ?? outputPath;
  const absolutePath = path.resolve(root, output);
  const report = `${JSON.stringify(buildMediaPdp0SourceReviewCurrentnessReport(), null, 2)}\n`;
  if (check) {
    if (!fs.existsSync(absolutePath) || fs.readFileSync(absolutePath, 'utf8') !== report) throw new Error(`PDP-0 source-review currentness observation is stale: ${path.relative(root, absolutePath)}`);
  } else {
    fs.mkdirSync(path.dirname(absolutePath), {recursive: true});
    fs.writeFileSync(absolutePath, report);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
