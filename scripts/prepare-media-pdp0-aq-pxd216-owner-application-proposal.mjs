#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24';
const REF = Object.freeze({
  status: 'docs/implementation/pdp-0-phase-dev-status.json',
  crosswalk: 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  blueprint: 'docs/implementation/references/MEDIA-UNIFIED-DATA-DRIVEN-PRODUCTION-BLUEPRINT-V3-2026-10-17.md',
  recommendation: 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-capability-review-001-154.json',
  currentReview: `${DIR}/pdp0-aq-capability-current-source-review-001-154.successor.candidate.v5.json`,
  pxd216Successor: `${DIR}/p0-capability-meaning-20-leaf-current-source-review-pxd216.successor.candidate.v5.json`,
  rootInput: `${DIR}/root-application-input.candidate.v5.json`,
  decisionLog: '.product-experience/decision-log.md',
});
const OUT = Object.freeze({
  ownerInput: `${DIR}/source-owner-decision-input.aq-pxd216.v1.json`,
  clarification: `${DIR}/aq-59-64-taxonomy-clarification-candidate.v1.json`,
  applicationProposal: `${DIR}/bounded-source-application-proposal.aq-pxd216.v1.json`,
});
const AMBIGUOUS_QUESTIONS = Object.freeze({
  'media.profile.discover': 'For profile-catalog discovery, should Q remain primary with P and O as related indexes, given the outcome is a bounded observation of declared profiles and does not admit execution?',
  'media.profile.validate': 'For non-executing profile compatibility validation, should Q remain primary and P related, given the outcome reports per-dimension compatibility without delivering or publishing?',
  'media.capability.discover': 'For declared capability-catalog discovery, should Q remain primary with O related, and what exact review/evidence outcome, if any, justifies the O cross-link?',
  'media.capability.check-declared-options': 'For declared processing-option and evidence inspection, should Q remain primary with O related, and is the evidence merely observed or reviewed as a quality/compliance decision?',
  'media.capability.execution.compatibility': 'For observational execution-compatibility preflight, should Q remain primary with O related, and does the intended result include a distinct review decision beyond comparison of declared inputs?',
  'media.health.readiness.inspect': 'For capability-scoped readiness observation, should Q remain primary with O related, or should O be primary; which exact readiness evidence is intended as review/quality/compliance disposition?',
});

const sha = value => createHash('sha256').update(value).digest('hex');
const readBytes = (ref, root = ROOT) => fs.readFileSync(path.join(root, ref));
const readJson = (ref, root = ROOT) => JSON.parse(readBytes(ref, root));
const readYaml = (ref, root = ROOT) => YAML.parse(readBytes(ref, root).toString('utf8'));
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const hashJson = value => sha(Buffer.from(JSON.stringify(canonical(value))));
const fileSha = (ref, root = ROOT) => sha(readBytes(ref, root));
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const h = value => sha(Buffer.from(`${JSON.stringify(value, null, 2)}\n`));

function build({repositoryRoot = ROOT} = {}) {
  const read = (ref, parse = value => value) => parse(readBytes(ref, repositoryRoot));
  const status = read(REF.status, bytes => JSON.parse(bytes));
  const crosswalk = read(REF.crosswalk, bytes => JSON.parse(bytes));
  const caps = read(REF.capabilities, bytes => YAML.parse(bytes.toString('utf8')));
  const reqs = read(REF.requirements, bytes => YAML.parse(bytes.toString('utf8')));
  const recommendation = read(REF.recommendation, bytes => JSON.parse(bytes));
  const current = readJson(REF.currentReview, repositoryRoot);
  const currentSuccessor = current.aqSuccessor;
  const pxd216 = readJson(REF.pxd216Successor, repositoryRoot);
  const rootInput = readJson(REF.rootInput, repositoryRoot);
  const blueprintText = read(REF.blueprint, bytes => bytes.toString('utf8'));
  const blueprintSha = fileSha(REF.blueprint, repositoryRoot);
  const sourcePins = Object.fromEntries([
    REF.status, REF.crosswalk, REF.capabilities, REF.requirements, REF.blueprint,
    REF.recommendation, REF.currentReview, REF.pxd216Successor, REF.rootInput, REF.decisionLog,
  ].map(ref => [ref, fileSha(ref, repositoryRoot)]));

  ensure(status.phase === 'PDP-0' && status.status === 'IN_PROGRESS', 'PDP-0 source status changed; rebuild against the new source cut');
  ensure(status.campaignDenominator?.denominator === 54
    && status.campaignDenominator.physicalManifestCandidates === 26
    && status.campaignDenominator.compositions === 7
    && status.campaignDenominator.logicalConsumers === 21,
  'PDP-0 status does not confirm the 54-identity denominator');
  ensure(crosswalk.rows?.length === 501 || crosswalk.auditRows?.length === 501,
    'Frozen crosswalk does not retain its 501-row denominator');
  ensure(caps.capabilities?.length === 469, 'Current capability population is not exactly 469 rows');
  ensure(status.campaignDenominator.denominator * 4 === 216,
    'PDP-0 status does not retain the 216 identity-by-PDP phase-cell denominator');
  ensure(current.candidateState === 'SOURCE_BOUND_CURRENTNESS_ONLY_CANDIDATE; OWNER_DECISION_NOT_RECORDED',
    'AQ v5 is not a pending currentness-only candidate');
  ensure(currentSuccessor?.sourceDeltaProof?.classification === 'NO_MEANING_CHANGE_IN_AQ_ROWS_1_TO_154',
    'AQ v5 slice proof is missing or not currentness-only');
  ensure(currentSuccessor.sourceDeltaProof.capabilityRowsChanged.length === 0
    && currentSuccessor.sourceDeltaProof.changedRequirementIdsUsedBySlice.length === 0,
  'AQ v5 has a semantic delta inside the reviewed slice');
  ensure(pxd216.reviewedCapabilityIds?.length === 20 && pxd216.changedReviewedCapabilityIds?.length === 0,
    'PXD-216 v5 does not preserve the exact 20-row reviewed slice');
  ensure(rootInput.canonicalApply === 'NONE'
    && rootInput.state === 'PREPARED_INPUT_ONLY; OWNER_AND_ROOT_DECISION_NOT_RECORDED',
  'Root input is not pending or claims a canonical apply');
  ensure(rootInput.target?.ref === REF.currentReview && rootInput.target?.sha256 === fileSha(REF.currentReview, repositoryRoot),
    'v5 root input does not bind the exact AQ source-review successor');
  ensure(blueprintText.includes('O — Review/quality/compliance')
    && blueprintText.includes('P — Render, publish, distribute')
    && blueprintText.includes('Q — Operations / API / agents'),
  'Blueprint A-Q cluster definitions changed or are not found at the expected authority');

  const mappings = recommendation.mappings ?? [];
  ensure(mappings.length === 154, 'AQ recommendation denominator is not exactly 154');
  const ambiguous = mappings.filter(row => row.mappingUncertainty === true);
  ensure(ambiguous.length === 6, 'AQ recommendation no longer contains exactly six ambiguous mappings');
  const expectedIds = Object.keys(AMBIGUOUS_QUESTIONS);
  ensure(JSON.stringify(ambiguous.map(row => row.capabilityId)) === JSON.stringify(expectedIds),
    'The six ambiguity rows differ from the source-bound AQ slice');
  const capById = new Map(caps.capabilities.map(row => [row.id, row]));
  const reqById = new Map((reqs.requirements ?? []).map(row => [row.id, row]));
  const ambiguityRows = ambiguous.map(row => {
    const capability = capById.get(row.capabilityId);
    const parent = reqById.get(row.parentRequirementId);
    ensure(capability && parent, `Ambiguous AQ row has unresolved capability or parent: ${row.capabilityId}`);
    ensure(capability.requirementIds?.includes(row.parentRequirementId),
      `AQ row parent does not match live capability source: ${row.capabilityId}`);
    return {
      sourceOrderIndex: row.sourceOrderIndex,
      capabilityId: row.capabilityId,
      capabilitySourceRef: row.capabilitySourceRef,
      parentRequirementId: row.parentRequirementId,
      parentRequirementSourceRef: `${REF.requirements}#/requirements/@id=${row.parentRequirementId}`,
      currentRecommendedMapping: {
        primaryClusterId: row.primaryClusterId,
        relatedClusterIds: row.relatedClusterIds,
        semanticRationale: row.semanticRationale,
        status: row.status,
        mappingUncertainty: true,
        ownerAcceptance: row.ownerAcceptance,
      },
      currentOutcome: capability.outcome,
      ownerQuestion: AMBIGUOUS_QUESTIONS[row.capabilityId],
      permittedOwnerChoices: [
        'CONFIRM_CURRENT_MAPPING',
        'CONFIRM_Q_PRIMARY_AND_ADJUDICATE_RELATED_CLUSTERS',
        'RECLASSIFY_USING_EXISTING_A_Q_CLUSTERS',
        'REQUEST_SEPARATE_SOURCE_AMENDMENT_FOR_NEW_TAXONOMY_MEANING',
        'KEEP_UNRESOLVED_PENDING_EVIDENCE',
      ],
      noDefaultDecision: true,
    };
  });

  const clarification = {
    schemaVersion: 'media.pdp0.aq-taxonomy-clarification-candidate.v1',
    recordId: 'MEDIA-PDP0-AQ-59-64-TAXONOMY-CLARIFICATION-CANDIDATE-2026-10-24',
    state: 'CONDITIONAL_OWNER_REVIEW_CANDIDATE; NOT_ADOPTED',
    scope: {phase: 'PDP-0', macroStage: 'DISCOVERY', aqRows: {start: 1, end: 154, count: 154}, affectedRows: [59, 60, 61, 62, 63, 64]},
    denominators: {surfaceIdentities: 54, phaseCells: 216, capabilities: 469, auditRows: 501},
    sourcePins: {
      aqRecommendation: {ref: REF.recommendation, sha256: sourcePins[REF.recommendation]},
      blueprint: {ref: REF.blueprint, sha256: blueprintSha, section: '§2 Capability completeness ledger'},
      capabilities: {ref: REF.capabilities, sha256: sourcePins[REF.capabilities]},
      requirements: {ref: REF.requirements, sha256: sourcePins[REF.requirements]},
    },
    candidateRule: 'For AQ taxonomy indexing only, use Q as primary when the defined PDP-0 outcome is a bounded observation of declared profiles, capabilities, processing options, compatibility, or capability-scoped readiness and does not execute, render, publish, or distribute. Add P or O as related only when the capability or parent requirement explicitly includes that delivery or review/quality/compliance outcome. Resolve each related-cluster link separately against the exact output contract.',
    candidateRuleRationale: 'This applies existing blueprint meanings for P (render/publish/distribute), Q (operations/API/agents), and O (review/quality/compliance) to current observation-only outcomes. It adds no capability, requirement, acceptance case, taxonomy cluster, or execution/admission claim.',
    affectedRows: ambiguityRows,
    sourceDeltaIfAdopted: 'None until the authentic owner selects an option. If adopted, create a separate append-only AQ recommendation successor recording the rule and row-level disposition; do not edit capabilities.yaml, requirements.yaml, the 501-row crosswalk, or phase status from this candidate.',
    ownerAcceptance: 'NOT_CLAIMED',
    independentAcceptance: 'NOT_CLAIMED',
  };
  const clarificationSha = h(clarification);

  const ownerInput = {
    schemaVersion: 'media.pdp0.aq-pxd216.source-owner-decision-input.v1',
    recordId: 'MEDIA-PDP0-AQ-PXD216-SOURCE-OWNER-DECISION-INPUT-2026-10-24',
    state: 'DECISION_NOT_RECORDED; CANDIDATE_FOR_AUTHENTIC_SOURCE_OWNER',
    requiredRole: 'AUTHENTIC_MEDIA_PDP0_SOURCE_OWNER',
    candidate: {ref: REF.currentReview, sha256: sourcePins[REF.currentReview]},
    pxd216CurrentnessSuccessor: {ref: REF.pxd216Successor, sha256: sourcePins[REF.pxd216Successor]},
    protectedInputs: {
      status: {ref: REF.status, sha256: sourcePins[REF.status], status: status.status, phase: status.phase},
      crosswalk: {ref: REF.crosswalk, sha256: sourcePins[REF.crosswalk], rowCount: crosswalk.rows?.length ?? crosswalk.auditRows?.length},
      denominators: {surfaceIdentities: 54, phaseCells: 216, capabilities: 469, auditRows: 501},
    },
    currentnessChoices: [
      'APPROVE_CURRENTNESS_ONLY_NO_REVIEWED_SLICE_MEANING_CHANGE',
      'REJECT_AND_REQUEST_SEMANTIC_REVIEW',
      'DEFER_PENDING_ADDITIONAL_SOURCE_EVIDENCE',
    ],
    independentMappingAdjudications: {
      ref: OUT.clarification,
      sha256: clarificationSha,
      requiredForRows: [59, 60, 61, 62, 63, 64],
      choicesMustBeRecordedPerRow: true,
      approvalOfCurrentnessDoesNotApproveRecommendations: true,
    },
    decisionRecordRequirements: {
      ownerIdentity: null,
      ownerRole: 'AUTHENTIC_MEDIA_PDP0_SOURCE_OWNER',
      decision: null,
      rationale: null,
      decidedAt: null,
      candidateSha256: sourcePins[REF.currentReview],
      rowLevelMappingDecisions: null,
      noAgentMayPopulateOwnerFields: true,
    },
    evidenceRefs: [
      {ref: REF.recommendation, sha256: sourcePins[REF.recommendation]},
      {ref: REF.blueprint, sha256: blueprintSha},
      {ref: REF.pxd216Successor, sha256: sourcePins[REF.pxd216Successor]},
      {ref: REF.rootInput, sha256: sourcePins[REF.rootInput], state: rootInput.state},
    ],
    semanticBoundary: 'Currentness disposition is separate from all six AQ taxonomy choices. Neither decision adopts R9-R08, authorizes canonical PDP-0 meaning changes, changes status/crosswalk, claims acceptance/closure, or supplies root approval.',
  };

  const applicationProposal = {
    schemaVersion: 'media.pdp0.aq-pxd216.bounded-source-application-proposal.v1',
    recordId: 'MEDIA-PDP0-AQ-PXD216-BOUNDED-SOURCE-APPLICATION-PROPOSAL-2026-10-24',
    state: 'PROPOSAL_ONLY; OWNER_DECISION_AND_ROOT_TECHNICAL_REVIEW_PENDING',
    ownerDecisionInput: {ref: OUT.ownerInput, sha256: h(ownerInput)},
    candidateInputs: [
      {ref: REF.currentReview, sha256: sourcePins[REF.currentReview], purpose: 'AQ rows 1–154 append-only current-source successor'},
      {ref: REF.pxd216Successor, sha256: sourcePins[REF.pxd216Successor], purpose: 'PXD-216 exact 20-row source-currentness successor'},
      {ref: OUT.clarification, sha256: clarificationSha, purpose: 'six-row owner taxonomy clarification candidate'},
    ],
    denominators: {surfaceIdentities: 54, phaseCells: 216, capabilities: 469, auditRows: 501},
    sourceCut: {pins: sourcePins, sha256: hashJson(sourcePins), repeatedReadStable: true},
    proposedActions: [
      {id: 'CURRENTNESS-ONLY-01', condition: 'Authentic source owner approves exact AQ v5 candidate SHA-256', action: 'Retain AQ v5 and PXD-216 v5 as append-only source-currentness successors; keep AQ findings and PXD-216 reviewed meanings unchanged.', targets: [REF.currentReview, REF.pxd216Successor]},
      {id: 'TAXONOMY-CLARIFICATION-01', condition: 'Authentic source owner records a row-level decision for AQ indexes 59–64', action: 'Only then create a separate append-only AQ recommendation successor with the accepted indexing rule and six row dispositions; regenerate affected downstream recommendation projections from their owning producers.' , targets: [OUT.clarification]},
    ],
    writesInThisProposal: [],
    forbiddenWrites: [REF.capabilities, REF.requirements, REF.status, REF.crosswalk],
    authorityBoundary: {
      sourceOwnerDecision: 'NOT_RECORDED',
      rootTechnicalReview: 'NOT_RECORDED_BY_THIS_PRODUCER; ROOT_AUTHORITY_MUST_REVIEW_INDEPENDENTLY',
      rootDecision: 'NOT_AUTHORED',
      canonicalApply: 'NONE',
      ownerAcceptance: 'NOT_CLAIMED',
      independentAcceptance: 'NOT_CLAIMED',
      closure: 'NOT_CLAIMED',
    },
    blockers: [
      'Authentic source-owner currentness disposition bound to exact AQ v5 SHA-256.',
      'Separate authentic owner decision for each of AQ indexes 59–64; currentness approval alone is insufficient.',
      'Independent root technical review and any root decision through the existing R9-R08 lane; this proposal does not supply either.',
    ],
    acceptanceCriteria: [
      'All v5 candidate and protected-input hashes still match at decision time.',
      '54 surface identities, 216 phase cells, 469 capability rows, and 501 crosswalk rows remain unchanged.',
      'AQ 1–154 retains 148 supported, 6 ambiguous, and 0 mismatched until authentic row-level decisions exist.',
      'No canonical source, crosswalk, or status write occurs under this proposal.',
    ],
  };

  const afterPins = Object.fromEntries(Object.keys(sourcePins).map(ref => [ref, fileSha(ref, repositoryRoot)]));
  ensure(hashJson(sourcePins) === hashJson(afterPins), 'A source input changed while building owner/application candidates');
  ensure(fileSha(REF.status, repositoryRoot) === sourcePins[REF.status]
    && fileSha(REF.crosswalk, repositoryRoot) === sourcePins[REF.crosswalk],
  'Frozen PDP-0 status or crosswalk changed during candidate preparation');
  const outputFiles = {
    [OUT.ownerInput]: ownerInput,
    [OUT.clarification]: clarification,
    [OUT.applicationProposal]: applicationProposal,
  };
  return {outputFiles, outputHashes: Object.fromEntries(Object.entries(outputFiles).map(([ref, value]) => [ref, h(value)])), sourceCutSha256: hashJson(sourcePins)};
}

export function buildMediaPdp0AqPxd216OwnerApplicationProposal(args = {}) { return build(args); }

export function prepareMediaPdp0AqPxd216OwnerApplicationProposal({repositoryRoot = ROOT} = {}) {
  const result = build({repositoryRoot});
  for (const [ref, value] of Object.entries(result.outputFiles)) {
    const target = path.join(repositoryRoot, ref);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    if (fs.existsSync(target)) throw new Error(`Append-only candidate target already exists: ${ref}`);
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'});
  }
  return {sourceCutSha256: result.sourceCutSha256, outputs: result.outputHashes};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv.includes('--prepare')) throw new Error('no effect is performed without explicit --prepare');
    process.stdout.write(`${JSON.stringify(prepareMediaPdp0AqPxd216OwnerApplicationProposal(), null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
