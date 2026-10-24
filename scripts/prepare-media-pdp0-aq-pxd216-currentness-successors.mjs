#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';
import {fingerprintPxdDecisionSection} from './lib/pdp0-phase-scoped-source-fingerprints.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24';
const REFS = Object.freeze({
  status: 'docs/implementation/pdp-0-phase-dev-status.json',
  crosswalk: 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
  aqRecommendation: 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-capability-review-001-154.json',
  aqCurrentReview: 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-capability-current-source-review-001-154.json',
  pxd216Review: 'docs/implementation/verification/pdp-38/p0-capability-meaning-20-leaf-current-source-review-pxd216.json',
  pxd223Currentness: 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223.json',
  pxd225Currentness: 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json',
  pxd225Candidate: 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-23-r3/pdp0-current-source-reconciliation-pxd225.candidate.json',
  blueprint: 'docs/implementation/references/MEDIA-UNIFIED-DATA-DRIVEN-PRODUCTION-BLUEPRINT-V3-2026-10-17.md',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  leafReview: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  qualityPolicy: '.product-experience/pdp-0-product-truth/quality-policy.yaml',
  goals: '.product-experience/pdp-0-product-truth/goals-jtbd.yaml',
  channels: '.product-experience/pdp-0-product-truth/applications-channels.yaml',
  profileSemantics: '.product-experience/pdp-0-product-truth/profile-semantics.yaml',
  decisionLog: '.product-experience/decision-log.md',
  r8Freeze: 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.freeze.v1.json',
  r8RootInput: 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.root-adoption-decision.input.r10.candidate.v1.json',
  r8DecisionMaterial: 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.decision-section-material.r5.candidate.v1.json',
});
const OUT_REFS = Object.freeze({
  aq: `${OUT}/pdp0-aq-capability-current-source-review-001-154.successor.candidate.v5.json`,
  pxd216: `${OUT}/p0-capability-meaning-20-leaf-current-source-review-pxd216.successor.candidate.v5.json`,
  ownerDecision: `${OUT}/source-owner-decision-input.candidate.v5.json`,
  rootInput: `${OUT}/root-application-input.candidate.v5.json`,
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const serializedSha256 = value => sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
const hashFile = (ref, root = ROOT) => sha256(fs.readFileSync(path.join(root, ref)));
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const hashJson = value => sha256(Buffer.from(JSON.stringify(canonical(value))));
const readText = (ref, root = ROOT) => fs.readFileSync(path.join(root, ref), 'utf8');
const readJson = (ref, root = ROOT) => JSON.parse(readText(ref, root));
const readYaml = (ref, root = ROOT) => YAML.parse(readText(ref, root));

function gitText(revision, ref, root = ROOT) {
  return execFileSync('git', ['show', `${revision}:${ref}`], {
    cwd: root, encoding: 'utf8', maxBuffer: 24 * 1024 * 1024,
  });
}

function byId(rows, key = 'id') { return new Map((rows ?? []).map(row => [row[key], row])); }
function deepEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function changedFields(before, after) {
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter(key => !deepEqual(before?.[key], after?.[key])).sort();
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function sourcePins(root) {
  return Object.fromEntries(Object.values(REFS)
    .filter(ref => fs.existsSync(path.join(root, ref)) && fs.statSync(path.join(root, ref)).isFile())
    .map(ref => [ref, hashFile(ref, root)]));
}

function buildProof(root = ROOT) {
  const beforePins = sourcePins(root);
  const status = readJson(REFS.status, root);
  const crosswalk = readJson(REFS.crosswalk, root);
  const aqRecommendation = readJson(REFS.aqRecommendation, root);
  const aqPredecessor = readJson(REFS.aqCurrentReview, root);
  const pxd216 = readJson(REFS.pxd216Review, root);
  const pxd223 = readJson(REFS.pxd223Currentness, root);
  const pxd225 = readJson(REFS.pxd225Currentness, root);
  const pxd225Candidate = readJson(REFS.pxd225Candidate, root);
  const r8Freeze = readJson(REFS.r8Freeze, root);
  const r8RootInput = readJson(REFS.r8RootInput, root);
  const r8DecisionMaterial = readJson(REFS.r8DecisionMaterial, root);

  const current = {
    capabilities: readYaml(REFS.capabilities, root),
    requirements: readYaml(REFS.requirements, root),
    leafReview: readYaml(REFS.leafReview, root),
    qualityPolicy: readYaml(REFS.qualityPolicy, root),
    goals: readYaml(REFS.goals, root),
    channels: readYaml(REFS.channels, root),
    profileSemantics: readYaml(REFS.profileSemantics, root),
  };
  const aqBase = {
    capabilities: YAML.parse(gitText('HEAD', REFS.capabilities, root)),
    requirements: YAML.parse(gitText('HEAD', REFS.requirements, root)),
  };
  const pxd216BaseCommit = pxd223.sourceCut?.repositoryHead;
  ensure(typeof pxd216BaseCommit === 'string' && /^[0-9a-f]{40}$/u.test(pxd216BaseCommit),
    'PXD-223 historical source commit is unavailable');
  const pxd216Base = {
    capabilities: YAML.parse(gitText(pxd216BaseCommit, REFS.capabilities, root)),
    requirements: YAML.parse(gitText('HEAD', REFS.requirements, root)),
    leafReview: YAML.parse(gitText('HEAD', REFS.leafReview, root)),
    qualityPolicy: YAML.parse(gitText('HEAD', REFS.qualityPolicy, root)),
    goals: YAML.parse(gitText('HEAD', REFS.goals, root)),
    channels: YAML.parse(gitText('HEAD', REFS.channels, root)),
    profileSemantics: YAML.parse(gitText('HEAD', REFS.profileSemantics, root)),
  };
  const pxd223HistoricalChannelsSha256 = sha256(Buffer.from(gitText(pxd216BaseCommit, REFS.channels, root)));

  const aqRows = aqRecommendation.rows ?? aqRecommendation.mappings;
  ensure(Array.isArray(aqRows) && aqRows.length === 154, 'AQ predecessor must contain exact source-order rows 1-154');
  const aqIds = aqRows.map(row => row.capabilityId);
  const capNow = current.capabilities.capabilities ?? [];
  const capBefore = aqBase.capabilities.capabilities ?? [];
  const capsNowById = byId(capNow);
  const capsBeforeById = byId(capBefore);
  ensure(capNow.length === 469 && capBefore.length === 469, 'AQ source delta proof requires the 469-row preimage and current population');
  ensure(deepEqual(capBefore.slice(0, 462), capNow.slice(0, 462)), 'Historical capability rows 1-462 changed; currentness-only AQ successor is unsafe');
  ensure(deepEqual(aqIds, capNow.slice(0, 154).map(row => row.id)), 'AQ row order differs from current capability source order');
  const aqChangedIds = aqIds.filter(id => !deepEqual(capsBeforeById.get(id), capsNowById.get(id)));
  ensure(aqChangedIds.length === 0, 'AQ rows 1-154 contain semantic capability changes');

  const reqBeforeById = byId(aqBase.requirements.requirements ?? []);
  const reqNowById = byId(current.requirements.requirements ?? []);
  const changedRequirementIds = [...new Set([...reqBeforeById.keys(), ...reqNowById.keys()])]
    .filter(id => !deepEqual(reqBeforeById.get(id), reqNowById.get(id))).sort();
  ensure(JSON.stringify(changedRequirementIds) === JSON.stringify(['MEDIA-REQ-CAP-RECIPE-TEMPLATE']),
    'Requirements source delta exceeds the exact recipe-template extension');
  const aqParentIds = [...new Set(aqRows.map(row => row.parentRequirementId))].sort();
  ensure(!aqParentIds.includes('MEDIA-REQ-CAP-RECIPE-TEMPLATE'), 'AQ rows 1-154 bind the changed recipe-template requirement');
  const aqParentsUnchanged = aqParentIds.every(id => deepEqual(reqBeforeById.get(id), reqNowById.get(id)));
  ensure(aqParentsUnchanged, 'An AQ parent requirement changed');
  const recipeOld = reqBeforeById.get('MEDIA-REQ-CAP-RECIPE-TEMPLATE');
  const recipeNow = reqNowById.get('MEDIA-REQ-CAP-RECIPE-TEMPLATE');
  const recipeCaseIdsBefore = new Set((recipeOld?.acceptanceCases ?? []).map(row => row.id));
  const recipeCaseIdsNow = (recipeNow?.acceptanceCases ?? []).map(row => row.id);
  const recipeCasesAdded = recipeCaseIdsNow.filter(id => !recipeCaseIdsBefore.has(id));
  ensure(recipeCasesAdded.length === 5
    && recipeCasesAdded.every(id => /^MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-1[3-7]$/u.test(id)),
  'Recipe requirement delta is not the exact appended acceptance-case set');
  const aqBlueprintSha = hashFile(REFS.blueprint, root);
  const recommendationSha = hashFile(REFS.aqRecommendation, root);
  const aqPins = {
    [REFS.capabilities]: hashFile(REFS.capabilities, root),
    [REFS.requirements]: hashFile(REFS.requirements, root),
    [REFS.blueprint]: aqBlueprintSha,
    [REFS.aqRecommendation]: recommendationSha,
  };
  const aqSuccessor = structuredClone(aqPredecessor);
  aqSuccessor.review.currentnessRefresh = {
    ...aqPredecessor.review.currentnessRefresh,
    refreshDate: '2026-10-24',
    predecessorCurrentSourceReviewSha256: hashFile(REFS.aqCurrentReview, root),
    priorCapabilitySourceSha256: aqPredecessor.materialInputs[REFS.capabilities].sha256,
    currentCapabilitySourceSha256: aqPins[REFS.capabilities],
    currentRequirementsSourceSha256: aqPins[REFS.requirements],
    currentBlueprintV3Sha256: aqPins[REFS.blueprint],
    recommendationFileSha256: recommendationSha,
    sliceEvidence: {
      sourceOrderRange: {startIndex: 1, endIndex: 154, count: 154, indexing: '1-based YAML list order'},
      liveCapabilityCount: capNow.length,
      historicalCanonicalRowsComparedToPriorSource: 462,
      historicalCanonicalRowsUnchanged: true,
      sliceCapabilityIdsAndOrderMatch: true,
      sliceParentRequirementIdsResolveAndMatch: true,
      semanticFindingsPreserved: {supported: 148, ambiguous: 6, mismatched: 0},
      changedCapabilityIdsWithinSlice: [],
      changedParentRequirementIdsWithinSlice: [],
    },
    decisionBoundary: 'Only extension rows 463-469 and the MEDIA-REQ-CAP-RECIPE-TEMPLATE acceptance cases changed after the predecessor current-source review. AQ rows 1-154, their source order, IDs, and parent requirement records are identical. This successor updates current-source pins and provenance only; it does not change recommendation rows, findings, meaning, taxonomy assignments, acceptance, or closure claims.',
  };
  aqSuccessor.materialInputs[REFS.capabilities] = {
    ...aqSuccessor.materialInputs[REFS.capabilities],
    sha256: aqPins[REFS.capabilities],
    liveCapabilityCount: capNow.length,
    previouslyReviewedSha256: aqPredecessor.materialInputs[REFS.capabilities].previouslyReviewedSha256,
  };
  aqSuccessor.materialInputs[REFS.requirements] = {sha256: aqPins[REFS.requirements]};
  aqSuccessor.materialInputs[REFS.blueprint] = {
    ...aqSuccessor.materialInputs[REFS.blueprint], sha256: aqPins[REFS.blueprint],
  };
  aqSuccessor.materialInputs[REFS.aqRecommendation] = {
    ...aqSuccessor.materialInputs[REFS.aqRecommendation], sha256: recommendationSha,
  };
  aqSuccessor.successorState = 'APPEND_ONLY_CURRENT_SOURCE_SUCCESSOR; OWNER_ACCEPTANCE_NOT_CLAIMED';
  aqSuccessor.predecessorRef = REFS.aqCurrentReview;
  aqSuccessor.predecessorSha256 = hashFile(REFS.aqCurrentReview, root);
  ensure(aqPredecessor.review?.currentnessRefresh?.currentCapabilitySourceSha256
    === aqPredecessor.materialInputs?.[REFS.capabilities]?.sha256,
  'AQ predecessor current-source history is internally inconsistent');

  const pxdIds = pxd216.reviewedCapabilityIds;
  ensure(Array.isArray(pxdIds) && pxdIds.length === 20 && new Set(pxdIds).size === 20,
    'PXD-216 must preserve exactly 20 unique reviewed capability identities');
  ensure(sha256(Buffer.from(gitText(pxd216BaseCommit, REFS.capabilities, root)))
    === pxd223.preservedSemanticReview?.historicalCapabilitiesSha256,
  'PXD-223 historical capability source does not match its recorded fingerprint');
  ensure(pxd216.sourceFingerprints?.[REFS.capabilities]
    === pxd223.preservedSemanticReview?.historicalCapabilitiesSha256,
  'PXD-216 and PXD-223 historical capability baselines differ');
  const historicalCapsById = byId(pxd216Base.capabilities.capabilities ?? []);
  const currentPxdCapsById = byId(capNow);
  const reviewedBefore = pxdIds.map(id => historicalCapsById.get(id));
  const reviewedNow = pxdIds.map(id => currentPxdCapsById.get(id));
  ensure(reviewedBefore.every(Boolean) && reviewedNow.every(Boolean), 'PXD-216 reviewed capability is missing from a source cut');
  const reviewedRowsSha = sha256(Buffer.from(JSON.stringify(reviewedNow)));
  ensure(deepEqual(reviewedBefore, reviewedNow), 'PXD-216 reviewed capability row changed semantically');
  ensure(reviewedRowsSha === pxd223.preservedSemanticReview?.historicalReviewedRowsSha256
    && reviewedRowsSha === pxd223.preservedSemanticReview?.currentReviewedRowsSha256,
  'PXD-216 exact reviewed-row digest does not match its PXD-223 predecessor');
  const historicalCapabilityRows = pxd216Base.capabilities.capabilities ?? [];
  const capabilityDeltaOutsideSlice = capNow.flatMap(row => {
    const prior = historicalCapsById.get(row.id);
    if (!prior || deepEqual(prior, row)) return [];
    const fields = changedFields(prior, row);
    if (pxdIds.includes(row.id)) throw new Error(`PXD-216 reviewed capability ${row.id} changed`);
    return [{
      capabilityId: row.id,
      changedFields: fields,
      priorScopeStatus: prior.scopeStatus,
      currentScopeStatus: row.scopeStatus,
      classification: row.id === 'media.recipe.specification.compile'
        ? 'PXD-226_CURRENT_VERSION_EXTENSION_MEANING_CHANGE_OUTSIDE_PXD216_SLICE'
        : fields.length === 1 && fields[0] === 'scopeStatus'
          ? 'PXD-221_FUTURE_VERSION_SCOPE_CHANGE_OUTSIDE_PXD216_SLICE'
          : 'UNCLASSIFIED_SOURCE_CHANGE',
    }];
  });
  const addedCapabilityIdsSinceHistorical = capNow.map(row => row.id)
    .filter(id => !historicalCapsById.has(id));
  const removedCapabilityIdsSinceHistorical = historicalCapabilityRows.map(row => row.id)
    .filter(id => !currentPxdCapsById.has(id));
  ensure(capabilityDeltaOutsideSlice.length === 7
    && capabilityDeltaOutsideSlice.every(row => row.classification !== 'UNCLASSIFIED_SOURCE_CHANGE')
    && addedCapabilityIdsSinceHistorical.length === 0
    && removedCapabilityIdsSinceHistorical.length === 0,
  'PXD-216 capability source delta contains an unclassified change or population change');

  const leafBeforeRows = pxd216Base.leafReview.ownerCapabilityLeafAdjudication?.records ?? [];
  const leafNowRows = current.leafReview.ownerCapabilityLeafAdjudication?.records ?? [];
  const leafBeforeById = byId(leafBeforeRows, 'capabilityRef');
  const leafNowById = byId(leafNowRows, 'capabilityRef');
  ensure(leafBeforeRows.length === 462 && leafNowRows.length === 462,
    'PXD-216 owner-adjudication denominator changed');
  ensure(pxdIds.every(id => deepEqual(leafBeforeById.get(id), leafNowById.get(id))),
    'PXD-216 owner-adjudication rows changed');
  ensure(deepEqual(leafBeforeRows, leafNowRows), 'Historical owner-adjudication rows changed');
  const trustBeforeById = byId(pxd216Base.leafReview.ownerTrustReconstructionDispositions?.records ?? [], 'capabilityRef');
  const trustNowById = byId(current.leafReview.ownerTrustReconstructionDispositions?.records ?? [], 'capabilityRef');
  ensure(pxdIds.every(id => deepEqual(trustBeforeById.get(id), trustNowById.get(id))),
    'PXD-216 owner-trust rows changed');
  const leafExtension = current.leafReview.currentVersionExtensionOwnerAndTrust;
  ensure(leafExtension?.population?.currentVersionExtensionCount === 1
    && leafExtension?.ownerAdjudications?.length === 1
    && leafExtension.ownerAdjudications[0].capabilityRef === 'media.recipe.specification.compile',
  'Leaf-review delta is not restricted to the recipe current-version extension');

  const qualityBefore = pxd216Base.qualityPolicy;
  const qualityNow = current.qualityPolicy;
  const qualityChangedTopLevel = changedFields(qualityBefore, qualityNow);
  ensure(JSON.stringify(qualityChangedTopLevel) === JSON.stringify(['ownerQualityApplicabilityCrosswalkExtensions']),
    'Quality-policy source delta exceeds the extension-only record');
  const qualityExtension = qualityNow.ownerQualityApplicabilityCrosswalkExtensions;
  ensure(qualityExtension?.records?.length === 1
    && qualityExtension.records[0].capabilityRef === 'media.recipe.specification.compile',
  'Quality applicability delta is not restricted to the recipe extension');
  const pxdRequirementIds = [...new Set(pxdIds.flatMap(id => currentPxdCapsById.get(id)?.requirementIds ?? []))].sort();
  ensure(!pxdRequirementIds.includes('MEDIA-REQ-CAP-RECIPE-TEMPLATE'), 'PXD-216 reviewed rows bind the changed recipe requirement');
  ensure(pxdRequirementIds.every(id => deepEqual(reqBeforeById.get(id), reqNowById.get(id))),
    'A PXD-216 parent requirement changed');
  for (const key of ['goals', 'channels', 'profileSemantics']) {
    ensure(deepEqual(pxd216Base[key], current[key]), `PXD-216 ${key} source changed beyond its currentness successor proof`);
  }

  const currentPxdPins = Object.fromEntries([
    REFS.capabilities, REFS.leafReview, REFS.qualityPolicy, REFS.goals,
    REFS.requirements, REFS.channels, REFS.profileSemantics,
  ].map(ref => [ref, hashFile(ref, root)]));
  const selectorNow = fingerprintPxdDecisionSection(readText(REFS.decisionLog, root), 'PXD-225').sha256;
  ensure(selectorNow === pxd225Candidate.decisionSectionSha256,
    'PXD-225 candidate selector does not match the live decision section');
  ensure(pxd225Candidate.currentSource?.channelsSha256 === hashFile(REFS.channels, root),
    'PXD-225 candidate channel pin is stale');
  const priorPxd225 = structuredClone(pxd225);
  const nextPxd225 = structuredClone(pxd225Candidate);
  delete priorPxd225.decisionSectionSha256;
  delete nextPxd225.decisionSectionSha256;
  ensure(deepEqual(priorPxd225, nextPxd225),
    'PXD-225 currentness successor candidate changes more than the decision-section selector');
  ensure(pxd225Candidate.preservedSemanticReview?.currentReviewedRowsSha256 === reviewedRowsSha
    && pxd225Candidate.preservedSemanticReview?.changedReviewedCapabilityIds?.length === 0,
  'PXD-225 candidate does not preserve the exact PXD-216 reviewed slice');

  const currentPinsAfter = sourcePins(root);
  ensure(deepEqual(beforePins, currentPinsAfter), 'A material input changed while the source cut was being collected');
  ensure(status.status === 'IN_PROGRESS' && hashFile(REFS.status, root) === beforePins[REFS.status],
    'PDP-0 status changed while preparing currentness successors');
  ensure(hashFile(REFS.crosswalk, root) === beforePins[REFS.crosswalk],
    'Frozen crosswalk changed while preparing currentness successors');
  ensure(r8Freeze.sourceOwnerDecision === 'NOT_SET' && r8Freeze.canonicalApply === 'NONE',
    'R9-R08 governance state changed or is not fail-closed');
  ensure(r8RootInput.sourceOwnerDecision?.status === 'NOT_RECORDED' && r8RootInput.canonicalApply === 'NONE',
    'R9-R08 root input is not pending the real source-owner decision');
  ensure(r8RootInput.candidate?.sha256 && r8DecisionMaterial.schemaVersion,
    'Exact R9-R08 root input material is incomplete');

  const sourceDelta = {
    aq1To154: {
      capabilityIdsAndOrderMatch: true,
      capabilityRowsChanged: aqChangedIds,
      historicalRows1To462Unchanged: true,
      requirementSourceChangedIds: changedRequirementIds,
      changedRequirementIdsUsedBySlice: aqParentIds.filter(id => changedRequirementIds.includes(id)),
      appendedRecipeAcceptanceCaseIds: recipeCasesAdded,
      classification: 'NO_MEANING_CHANGE_IN_AQ_ROWS_1_TO_154',
    },
    pxd216: {
      reviewedCapabilityCount: pxdIds.length,
      reviewedCapabilityIds: pxdIds,
      historicalReviewedRowsSha256: reviewedRowsSha,
      currentReviewedRowsSha256: reviewedRowsSha,
      changedReviewedCapabilityIds: [],
      historicalCapabilityDeltaOutsideReviewedSlice: {
        changedRows: capabilityDeltaOutsideSlice,
        addedCapabilityIds: addedCapabilityIdsSinceHistorical,
        removedCapabilityIds: removedCapabilityIdsSinceHistorical,
      },
      historicalOwnerAdjudicationCount: leafNowRows.length,
      historicalOwnerAdjudicationRowsUnchanged: true,
      reviewedOwnerTrustRowsUnchanged: true,
      changedSourceRecordsOutsideSlice: [
        {sourceRef: REFS.capabilities, scope: 'extension rows 463-469; recipe row has PXD-226 current-version meaning changes; six extension rows remain outside PXD-216', classification: 'MEANING_CHANGE_OUTSIDE_REVIEWED_SLICE'},
        {sourceRef: REFS.requirements, scope: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE only; AC-13 through AC-17 appended', classification: 'MEANING_CHANGE_OUTSIDE_REVIEWED_SLICE'},
        {sourceRef: REFS.leafReview, scope: 'currentVersionExtensionOwnerAndTrust adds only media.recipe.specification.compile; 462 owner rows unchanged', classification: 'ADDITIVE_OWNER_RECORD_OUTSIDE_REVIEWED_SLICE'},
        {sourceRef: REFS.qualityPolicy, scope: 'ownerQualityApplicabilityCrosswalkExtensions adds only media.recipe.specification.compile', classification: 'ADDITIVE_QUALITY_RECORD_OUTSIDE_REVIEWED_SLICE'},
        {sourceRef: REFS.channels, historicalPxd216PinSha256: pxd216.sourceFingerprints?.[REFS.channels], pxd223SourceCutRepositoryHead: pxd216BaseCommit, pxd223SourceCutSha256: pxd223HistoricalChannelsSha256, currentSha256: currentPxdPins[REFS.channels], scope: 'The PXD-223 pinned repository source cut carries the historical PXD-216 channel bytes; PXD-225 changes only the archived evidence locator and refreshes its channel-source pin while the reviewed 20-row digest stays unchanged', classification: 'PXD225_CHANNEL_SOURCE_CURRENTNESS_CHANGE_FROM_PXD223_SOURCE_CUT; PXD216_REVIEWED_MEANING_UNCHANGED'},
      ],
      classification: 'NO_MEANING_CHANGE_TO_THE_20_PXD216_REVIEWED_ROWS; SOURCE_EXTENSIONS_OUTSIDE_SLICE_REMAIN_SEPARATELY_GOVERNED',
    },
  };
  aqSuccessor.sourceDeltaProof = sourceDelta.aq1To154;

  const currentnessSuccessors = {
    schemaVersion: 'media.pdp0.aq-pxd216-currentness-successors.candidate.v5',
    recordId: 'MEDIA-PDP0-AQ-PXD216-CURRENTNESS-SUCCESSORS-2026-10-24-V5',
    candidateState: 'SOURCE_BOUND_CURRENTNESS_ONLY_CANDIDATE; OWNER_DECISION_NOT_RECORDED',
    campaign: {phase: 'PDP-0', macroStage: 'DISCOVERY', identityDenominator: 54, phaseCells: 216, auditRows: 501, historicalOwnerRows: 462},
    stableSourceCut: {
      repositoryHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
      currentSourcePins: beforePins,
      inputReadSetSha256: hashJson(beforePins),
      repeatedReadMatched: true,
    },
    predecessors: {
      aqCurrentSourceReview: {ref: REFS.aqCurrentReview, sha256: hashFile(REFS.aqCurrentReview, root)},
      aqRecommendation: {ref: REFS.aqRecommendation, sha256: recommendationSha},
      pxd216SemanticReview: {ref: REFS.pxd216Review, sha256: hashFile(REFS.pxd216Review, root)},
      pxd223Currentness: {ref: REFS.pxd223Currentness, sha256: hashFile(REFS.pxd223Currentness, root)},
      pxd225Currentness: {ref: REFS.pxd225Currentness, sha256: hashFile(REFS.pxd225Currentness, root)},
    },
    sourceDelta,
    aqSuccessor,
    pxd216Successor: {
      schemaVersion: 'media.pdp0.capability-meaning-current-source-review.successor.v1',
      semanticReviewRef: REFS.pxd216Review,
      semanticReviewSha256: hashFile(REFS.pxd216Review, root),
      historicalSourceFingerprints: pxd216.sourceFingerprints,
      predecessorCurrentnessRef: REFS.pxd223Currentness,
      currentSources: currentPxdPins,
      reviewedRowsSha256: reviewedRowsSha,
      reviewedCapabilityIds: pxdIds,
      changedReviewedCapabilityIds: [],
      pxd225Selector: {
        predecessorRef: REFS.pxd225Currentness,
        predecessorSha256: hashFile(REFS.pxd225Currentness, root),
        candidateRef: REFS.pxd225Candidate,
        candidateSha256: hashFile(REFS.pxd225Candidate, root),
        oldDecisionSectionSha256: pxd225.decisionSectionSha256,
        currentDecisionSectionSha256: selectorNow,
        changedFields: ['decisionSectionSha256'],
      },
      semanticReviewStatus: 'PXD-216_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW',
      ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', acceptanceEffect: 'none',
    },
    authorityBoundary: {
      canonicalPdp0StatusWrite: 'NONE',
      crosswalkWrite: 'NONE',
      sourceDefinitionWrite: 'NONE',
      sourceOwnerDecision: 'NOT_RECORDED',
      rootDisposition: 'NOT_RECORDED',
      phaseAcceptance: 'NOT_CLAIMED',
    },
  };

  const successorsSha256 = serializedSha256(currentnessSuccessors);
  const pxd216SuccessorSha256 = serializedSha256(currentnessSuccessors.pxd216Successor);
  const r8FreezeRef = REFS.r8Freeze;
  const r8RootInputRef = REFS.r8RootInput;
  const r8DecisionMaterialRef = REFS.r8DecisionMaterial;
  const ownerDecisionInput = {
    schemaVersion: 'media.pdp0.source-owner-currentness-decision-input.v1',
    recordId: 'MEDIA-PDP0-AQ-PXD216-SOURCE-OWNER-DECISION-INPUT-2026-10-24',
    state: 'DECISION_NOT_RECORDED; CANDIDATE_FOR_AUTHENTIC_SOURCE_OWNER',
    candidate: {ref: OUT_REFS.aq, sha256: successorsSha256},
    requiredRole: 'AUTHENTIC_MEDIA_PDP0_SOURCE_OWNER',
    choices: ['APPROVE_CURRENTNESS_ONLY_NO_REVIEWED_SLICE_MEANING_CHANGE', 'REJECT_AND_REQUEST_SEMANTIC_REVIEW'],
    decisionMustBindCandidateSha256: successorsSha256,
    evidenceRefs: [
      {label: 'R9-R08 freeze', ref: r8FreezeRef, sha256: hashFile(r8FreezeRef, root), decisionState: r8Freeze.sourceOwnerDecision},
      {label: 'R9-R08 root application input', ref: r8RootInputRef, sha256: hashFile(r8RootInputRef, root), decisionState: r8RootInput.sourceOwnerDecision.status},
      {label: 'R9-R08 decision-section material', ref: r8DecisionMaterialRef, sha256: hashFile(r8DecisionMaterialRef, root)},
      {label: 'PXD-225 currentness candidate', ref: REFS.pxd225Candidate, sha256: hashFile(REFS.pxd225Candidate, root)},
    ],
    semanticBoundary: 'This input requests only source-currentness disposition for AQ rows 1-154 and the preserved PXD-216 20-row review. It cannot adopt R9-R08, change product meaning, claim independent acceptance, or authorize canonical source/status/crosswalk writes.',
  };
  const ownerInputSha256 = serializedSha256(ownerDecisionInput);
  const rootApplicationInput = {
    schemaVersion: 'media.pdp0.currentness-successor-root-application-input.v1',
    recordId: 'MEDIA-PDP0-AQ-PXD216-CURRENTNESS-ROOT-APPLICATION-INPUT-2026-10-24',
    state: 'PREPARED_INPUT_ONLY; OWNER_AND_ROOT_DECISION_NOT_RECORDED',
    target: {ref: OUT_REFS.aq, sha256: successorsSha256},
    requiredSourceOwnerInput: {ref: OUT_REFS.ownerDecision, sha256: ownerInputSha256, state: 'DECISION_NOT_RECORDED'},
    protectedInputs: {
      pdp0Status: {ref: REFS.status, sha256: beforePins[REFS.status], status: status.status},
      crosswalk: {ref: REFS.crosswalk, sha256: beforePins[REFS.crosswalk]},
      capabilities: {ref: REFS.capabilities, sha256: beforePins[REFS.capabilities]},
    },
    r9R08Input: {
      freezeRef: r8FreezeRef,
      freezeSha256: hashFile(r8FreezeRef, root),
      sourceOwnerDecision: r8Freeze.sourceOwnerDecision,
      rootInputRef: r8RootInputRef,
      rootInputSha256: hashFile(r8RootInputRef, root),
      decisionSectionMaterialRef: r8DecisionMaterialRef,
      decisionSectionMaterialSha256: hashFile(r8DecisionMaterialRef, root),
      canonicalApply: 'NONE',
    },
    exactCandidateTargets: [OUT_REFS.aq, OUT_REFS.pxd216, OUT_REFS.ownerDecision, OUT_REFS.rootInput],
    targetPostimages: [
      {ref: OUT_REFS.aq, sha256: successorsSha256},
      {ref: OUT_REFS.pxd216, sha256: pxd216SuccessorSha256},
      {ref: OUT_REFS.ownerDecision, sha256: ownerInputSha256},
    ],
    canonicalApply: 'NONE',
    requiredChecksBeforeAnyCandidatePromotion: [
      'recompute all source pins and require one stable source cut',
      'obtain authentic source-owner decision bound to the exact successor candidate SHA-256',
      'obtain the separate root disposition required by the R9-R08 source-governance lane',
      'preserve historical PXD-216 and AQ predecessor records byte-for-byte',
      'keep PDP-0 status and the frozen crosswalk at their current exact hashes',
    ],
  };
  const rootInputSha256 = serializedSha256(rootApplicationInput);
  const outputFiles = {
    [OUT_REFS.aq]: currentnessSuccessors,
    [OUT_REFS.pxd216]: currentnessSuccessors.pxd216Successor,
    [OUT_REFS.ownerDecision]: ownerDecisionInput,
    [OUT_REFS.rootInput]: rootApplicationInput,
  };
  const outputHashes = Object.fromEntries(Object.entries(outputFiles)
    .map(([ref, value]) => [ref, serializedSha256(value)]));
  ensure(outputHashes[OUT_REFS.aq] === successorsSha256
    && outputHashes[OUT_REFS.ownerDecision] === ownerInputSha256
    && outputHashes[OUT_REFS.rootInput] === rootInputSha256,
  'Candidate postimage hashes are inconsistent');

  return {outputFiles, outputHashes, sourceCutSha256: hashJson(beforePins)};
}

export function buildMediaPdp0AqPxd216CurrentnessSuccessors({repositoryRoot = ROOT} = {}) {
  return buildProof(repositoryRoot);
}

export function prepareMediaPdp0AqPxd216CurrentnessSuccessors({repositoryRoot = ROOT} = {}) {
  const result = buildMediaPdp0AqPxd216CurrentnessSuccessors({repositoryRoot});
  for (const [ref, value] of Object.entries(result.outputFiles)) {
    const target = path.join(repositoryRoot, ref);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    if (fs.existsSync(target)) throw new Error(`Append-only successor target already exists: ${ref}`);
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'});
  }
  return {sourceCutSha256: result.sourceCutSha256, outputs: result.outputHashes};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv.includes('--prepare')) throw new Error('no effect is performed without explicit --prepare');
    process.stdout.write(`${JSON.stringify(prepareMediaPdp0AqPxd216CurrentnessSuccessors(), null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
