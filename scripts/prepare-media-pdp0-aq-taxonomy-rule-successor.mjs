#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24';
const INPUT = Object.freeze({
  status: 'docs/implementation/pdp-0-phase-dev-status.json',
  crosswalk: 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
  recommendation: 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-capability-review-001-154.json',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  blueprint: 'docs/implementation/references/MEDIA-UNIFIED-DATA-DRIVEN-PRODUCTION-BLUEPRINT-V3-2026-10-17.md',
  aqV5: `${DIR}/pdp0-aq-capability-current-source-review-001-154.successor.candidate.v5.json`,
  pxd216V5: `${DIR}/p0-capability-meaning-20-leaf-current-source-review-pxd216.successor.candidate.v5.json`,
});
const OUTPUT = Object.freeze({
  postimage: `${DIR}/aq-taxonomy-rule-source-postimage.v2.json`,
  casInput: `${DIR}/aq-taxonomy-rule-minimal-cas-successor-input.v2.json`,
});
const EXPECTED_STATUS_SHA = '6e92932ba4173c6dea7e3dcee0c1d44a44ae90245804d363c0d22c2f28028b7c';
const EXPECTED_CROSSWALK_SHA = '02c61f7b0193ccd1900ffcae84f7a4c95fb00e800d9d86a9ce1ea65cae79b5b4';
const PREFERRED = Object.freeze([
  ['media.profile.discover', 'The outcome is a bounded catalog observation of declared profiles; it neither renders/publishes nor issues review or admission decisions.'],
  ['media.profile.validate', 'The outcome reports per-dimension profile compatibility and blockers without executing delivery; validation is an operational/API observation.'],
  ['media.capability.discover', 'The outcome returns source-declared capability metadata for the requested catalog scope; catalog lookup is an operational/API observation.'],
  ['media.capability.check-declared-options', 'The outcome reports declared options and evidence while runtime readiness remains separate; it does not decide quality or compliance.'],
  ['media.capability.execution.compatibility', 'The outcome compares declared capability, requested operation, and profile as an observation; it does not admit execution.'],
  ['media.health.readiness.inspect', 'The outcome reports capability-scoped readiness observations and preserves check boundaries; it does not decide admission or quality/compliance.'],
]);
const sha = value => createHash('sha256').update(value).digest('hex');
const hashJson = value => sha(Buffer.from(JSON.stringify(canonical(value))));
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const readBytes = (ref, root) => fs.readFileSync(path.join(root, ref));
const readJson = (ref, root) => JSON.parse(readBytes(ref, root));
const fileSha = (ref, root) => sha(readBytes(ref, root));
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const prettySha = value => sha(Buffer.from(`${JSON.stringify(value, null, 2)}\n`));

function build({repositoryRoot = ROOT} = {}) {
  const root = repositoryRoot;
  const status = readJson(INPUT.status, root);
  const crosswalk = readJson(INPUT.crosswalk, root);
  const recommendation = readJson(INPUT.recommendation, root);
  const caps = YAML.parse(readBytes(INPUT.capabilities, root).toString('utf8'));
  const reqs = YAML.parse(readBytes(INPUT.requirements, root).toString('utf8'));
  const blueprintText = readBytes(INPUT.blueprint, root).toString('utf8');
  const aqV5 = readJson(INPUT.aqV5, root);
  const pxd216V5 = readJson(INPUT.pxd216V5, root);
  const protectedHashes = Object.fromEntries(Object.values(INPUT).map(ref => [ref, fileSha(ref, root)]));
  ensure(protectedHashes[INPUT.status] === EXPECTED_STATUS_SHA, 'PDP-0 status preimage changed; no candidate generated');
  ensure(protectedHashes[INPUT.crosswalk] === EXPECTED_CROSSWALK_SHA, '501-row crosswalk preimage changed; no candidate generated');
  ensure(status.phase === 'PDP-0' && status.status === 'IN_PROGRESS', 'PDP-0 phase/status changed');
  ensure(status.campaignDenominator?.denominator === 54 && status.campaignDenominator.denominator * 4 === 216,
    '54-identity / 216 phase-cell denominator changed');
  ensure(caps.capabilities?.length === 469, 'Capability denominator changed from 469');
  ensure(crosswalk.rows?.length === 501 && crosswalk.denominator?.expectedUniqueIds === 501
    && crosswalk.denominator?.actualRows === 501,
    '501-row crosswalk denominator changed');
  ensure(aqV5.candidateState === 'SOURCE_BOUND_CURRENTNESS_ONLY_CANDIDATE; OWNER_DECISION_NOT_RECORDED'
    && aqV5.aqSuccessor?.sourceDeltaProof?.classification === 'NO_MEANING_CHANGE_IN_AQ_ROWS_1_TO_154',
  'AQ v5 currentness candidate is not the expected no-meaning-change source cut');
  ensure(pxd216V5.reviewedCapabilityIds?.length === 20 && pxd216V5.changedReviewedCapabilityIds?.length === 0,
    'PXD-216 v5 is not the exact unchanged 20-row source cut');
  ensure(blueprintText.includes('O — Review/quality/compliance')
    && blueprintText.includes('P — Render, publish, distribute')
    && blueprintText.includes('Q — Operations / API / agents'), 'A-Q taxonomy source differs from expected current definitions');
  ensure(recommendation.mappings?.length === 154, 'AQ recommendation is not the exact 154-row predecessor');

  const capsById = new Map(caps.capabilities.map(row => [row.id, row]));
  const reqsById = new Map((reqs.requirements ?? []).map(row => [row.id, row]));
  const proposedRows = PREFERRED.map(([id, rationale]) => {
    const prior = recommendation.mappings.find(row => row.capabilityId === id);
    const capability = capsById.get(id);
    const parent = reqsById.get(prior?.parentRequirementId);
    ensure(prior?.mappingUncertainty === true && prior.status === 'COORDINATOR_MAPPING_RECOMMENDATION',
      `Expected unresolved coordinator recommendation missing: ${id}`);
    ensure(capability && parent && capability.requirementIds?.includes(prior.parentRequirementId),
      `Capability or parent requirement is not source-bound for ${id}`);
    return {
      sourceOrderIndex: prior.sourceOrderIndex,
      capabilityId: id,
      parentRequirementId: prior.parentRequirementId,
      sourceRefs: [prior.capabilitySourceRef, `${INPUT.requirements}#/requirements/@id=${prior.parentRequirementId}`],
      priorRecommendation: {
        primaryClusterId: prior.primaryClusterId,
        relatedClusterIds: prior.relatedClusterIds,
        semanticRationale: prior.semanticRationale,
        mappingUncertainty: prior.mappingUncertainty,
      },
      preferredTechnicalRecommendation: {
        primaryClusterId: 'Q',
        relatedClusterIds: [],
        semanticRationale: rationale,
        mappingUncertainty: false,
        classificationBasis: 'EXACT_CAPABILITY_OUTCOME_AND_EXISTING_CLUSTER_DEFINITIONS',
      },
      capabilityOutcome: capability.outcome,
      parentRequirementSummary: parent.summary ?? parent.description ?? null,
      decisionStatus: 'ROOT_PROSPECTIVE_TECHNICAL_RECOMMENDATION; NOT_CANONICALLY_APPLIED',
      ownerAcceptance: 'NOT_CLAIMED',
    };
  });
  ensure(JSON.stringify(proposedRows.map(row => row.sourceOrderIndex)) === JSON.stringify([59, 60, 61, 62, 63, 64]),
    'AQ ambiguity rows are no longer exactly indexes 59–64');

  const postimage = {
    schemaVersion: 'media.pdp0.aq-taxonomy-rule-source-postimage.v2',
    recordId: 'MEDIA-PDP0-AQ-TAXONOMY-RULE-SOURCE-POSTIMAGE-2026-10-24-V2',
    artifactKind: 'NON_CANONICAL_VERSIONED_TAXONOMY_RULE_AND_ROW_DISPOSITION_POSTIMAGE',
    state: 'PROSPECTIVE_ROOT_TECHNICAL_RECOMMENDATION; NOT_CANONICALLY_APPLIED',
    campaign: {macroStage: 'DISCOVERY', phase: 'PDP-0', identityDenominator: 54, phaseCellDenominator: 216, capabilityDenominator: 469, auditRowDenominator: 501},
    predecessor: {ref: INPUT.recommendation, sha256: protectedHashes[INPUT.recommendation]},
    sourceCut: {
      sourcePins: protectedHashes,
      currentnessSuccessors: [
        {ref: INPUT.aqV5, sha256: protectedHashes[INPUT.aqV5]},
        {ref: INPUT.pxd216V5, sha256: protectedHashes[INPUT.pxd216V5]},
      ],
      readSetSha256: hashJson(protectedHashes),
    },
    ruleId: 'AQ-INDEX-Q-OBSERVATIONAL-CAPABILITIES-V1',
    taxonomyRule: 'For the six named AQ rows 59–64 only, select Q as primary when the defined capability outcome is an observation of declared profiles, declared capabilities or options, compatibility, or capability-scoped readiness. Add P only when the exact outcome includes rendering, publishing, or distribution; add O only when it includes an explicit review, quality, or compliance decision. References to a profile, evidence, or readiness input alone do not create a P/O outcome. Do not automatically reclassify any of the other 148 AQ rows under this rule.',
    ruleApplicability: {sourceOrderIndexes: [59, 60, 61, 62, 63, 64], capabilityIds: PREFERRED.map(([id]) => id), automaticPropagationOutsideListedRows: false},
    sourceRuleRefs: [
      `${INPUT.blueprint}#§2`,
      `${INPUT.capabilities}#capabilities`,
      `${INPUT.requirements}#requirements`,
    ],
    affectedRows: proposedRows,
    preservedDenominators: {aqRows: 154, capabilityRecords: 469, pxd216ReviewedRows: 20, phaseCells: 216, surfaceIdentities: 54, auditRows: 501},
    invariantChecks: {
      capabilityDefinitionsChanged: 0,
      requirementDefinitionsChanged: 0,
      acceptanceCasesAddedOrChanged: 0,
      crosswalkRowsChanged: 0,
      phaseStatusChanged: false,
      pxd216ReviewedRowsChanged: 0,
      otherAQRecommendationRowsChanged: 0,
    },
    authorityBoundary: {sourceOwnerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', rootDecision: 'PROSPECTIVE_CANDIDATE_ONLY', canonicalApply: 'NONE'},
  };
  const postimageSha256 = prettySha(postimage);
  const casInput = {
    schemaVersion: 'media.pdp0.aq-taxonomy-rule-minimal-cas-successor-input.v2',
    recordId: 'MEDIA-PDP0-AQ-TAXONOMY-RULE-MINIMAL-CAS-SUCCESSOR-INPUT-2026-10-24-V2',
    inputKind: 'NON_MUTATING_MINIMAL_CREATE_ONLY_CAS_INPUT',
    state: 'CANDIDATE_ONLY; NO_APPLY_AUTHORIZATION',
    target: {
      ref: `${DIR}/aq-capability-review-001-154.taxonomy-rule-successor.candidate.v2.json`,
      expectedTargetState: 'ABSENT; CREATE_ONLY',
      expectedTargetSha256: null,
      postimageRef: OUTPUT.postimage,
      postimageSha256,
    },
    predecessor: {ref: INPUT.recommendation, expectedSha256: protectedHashes[INPUT.recommendation]},
    exactChangeSet: proposedRows.map(row => ({capabilityId: row.capabilityId, operation: 'REPLACE_AQ_MAPPING_RECOMMENDATION_FIELDS_ONLY', fields: ['primaryClusterId', 'relatedClusterIds', 'semanticRationale', 'mappingUncertainty']})),
    compareAndSwapGuards: {
      statusSha256: {ref: INPUT.status, expected: EXPECTED_STATUS_SHA},
      crosswalkSha256: {ref: INPUT.crosswalk, expected: EXPECTED_CROSSWALK_SHA},
      predecessorRecommendationSha256: {ref: INPUT.recommendation, expected: protectedHashes[INPUT.recommendation]},
      aqCurrentnessSuccessorSha256: {ref: INPUT.aqV5, expected: protectedHashes[INPUT.aqV5]},
      pxd216SuccessorSha256: {ref: INPUT.pxd216V5, expected: protectedHashes[INPUT.pxd216V5]},
      candidateTargetAbsent: true,
      allInputsRecheckedBeforeCreate: true,
    },
    protectedNoWriteTargets: [INPUT.capabilities, INPUT.requirements, INPUT.status, INPUT.crosswalk],
    authorityPrerequisites: ['ROOT_TECHNICAL_REVIEW_OF_EXACT_POSTIMAGE', 'SEPARATE_SOURCE_OWNER_DECISION_IF_CANONICAL_ADOPTION_IS_REQUESTED', 'DISTINCT_APPLY_AUTHORIZATION_FOR_ANY_CANONICAL_WRITE'],
    applyAuthorization: 'NOT_PROVIDED',
    canonicalApply: 'NONE',
    effects: {canonicalWrite: 'NOT_PERFORMED', status: 'UNCHANGED', crosswalk: 'UNCHANGED', acceptance: 'NOT_CLAIMED'},
  };
  const after = Object.fromEntries(Object.keys(protectedHashes).map(ref => [ref, fileSha(ref, root)]));
  ensure(hashJson(after) === hashJson(protectedHashes), 'A pinned source changed during candidate construction');
  return {outputFiles: {[OUTPUT.postimage]: postimage, [OUTPUT.casInput]: casInput}, outputHashes: {[OUTPUT.postimage]: postimageSha256, [OUTPUT.casInput]: prettySha(casInput)}};
}

export function buildMediaPdp0AqTaxonomyRuleSuccessor(args = {}) { return build(args); }

export function prepareMediaPdp0AqTaxonomyRuleSuccessor({repositoryRoot = ROOT} = {}) {
  const result = build({repositoryRoot});
  for (const [ref, value] of Object.entries(result.outputFiles)) {
    const target = path.join(repositoryRoot, ref);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    let fd;
    try {
      fd = fs.openSync(target, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fs.fsyncSync(fd);
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error(`Append-only candidate target already exists: ${ref}`);
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return {outputs: result.outputHashes};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv.includes('--prepare')) throw new Error('no effect is performed without explicit --prepare');
    process.stdout.write(`${JSON.stringify(prepareMediaPdp0AqTaxonomyRuleSuccessor(), null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
