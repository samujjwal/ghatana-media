import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATE_DIR = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const CAP_PATH = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const REQ_PATH = '.product-experience/pdp-0-product-truth/requirements.yaml';
const LEAF_REVIEW_PATH = '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml';
const R3_PATH = `${CANDIDATE_DIR}/cohort-02.r3.json`;
const R2_PATH = `${CANDIDATE_DIR}/cohort-02.r2.json`;
const SELF_CHECK_PATH = `${CANDIDATE_DIR}/cohort-02-supported-self-check.json`;

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (ref) => fs.readFileSync(path.join(ROOT, ref));
const parseDoc = (bytes, ref) => YAML.parseDocument(bytes.toString('utf8'), { uniqueKeys: true, prettyErrors: true });
const items = (doc, key) => doc.get(key, true)?.items ?? [];
const field = (node, key) => node.get(key, true);
const nodeValue = (node) => node?.toJSON() ?? null;
const reqRef = (id) => `${REQ_PATH}#requirements/@id=${id}`;
const capRef = (id) => `${CAP_PATH}#capabilities/@id=${id}`;

const MISSING_MEANING = {
  'AUD-DELIV-019': {
    proposalKind: 'NEW_CAPABILITY_VARIANT', proposedId: 'media.deliver.live-stream-output', operation: 'deliver.live-stream-output',
    inputSlots: [
      {slotId: 'source', sourceType: 'accepted-media-artifact-or-composition@version', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'stream-destination', sourceType: 'versioned-live-stream-destination', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'transport', sourceType: 'declared-stream-transport', cardinality: 'EXACTLY_ONE', required: true, allowedValues: ['WebRTC', 'RTMP']},
      {slotId: 'provider-binding', sourceType: 'explicit-admitted-provider-binding', cardinality: 'ZERO_OR_ONE', required: false},
    ],
    output: {artifactType: 'live-stream-delivery-outcome', resultVariants: ['PREPARED_NOT_STARTED', 'STARTED_WITH_BOUND_SESSION', 'REJECTED', 'UNKNOWN_OUTCOME'], mustDistinguishExternalStreamEffect: true},
    failures: ['Unsupported or unadmitted transport/provider is unavailable and cannot silently fall back.', 'Unknown stream finality remains UNKNOWN_OUTCOME; do not claim a live stream started.'],
    authorityAdditions: ['governed-egress-or-publishing-authority-when-applicable', 'operation-specific-policy-and-rights'],
    choiceRationale: 'New variant: live stream session start/finality is semantically distinct from preparing a stream delivery package.'
  },
  'AUD-DUB-015': {
    proposalKind: 'NEW_CAPABILITY_VARIANT', proposedId: 'media.speech.conversation.translated-speech-to-speech', operation: 'speech.conversation.translated-speech-to-speech',
    inputSlots: [
      {slotId: 'source-speech', sourceType: 'source-speech-artifact-or-live-speech-stream', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'language-pair', sourceType: 'declared-source-and-target-language-pair', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'conversation-mode', sourceType: 'simultaneous-conversation-mode', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'voice-policy', sourceType: 'authorized-target-voice-and-consent-policy', cardinality: 'EXACTLY_ONE', required: true},
    ],
    output: {artifactType: 'translated-speech-conversation-result', resultVariants: ['TRANSLATED_SPEECH_SEGMENTS_WITH_LANGUAGE_AND_TIMING', 'REJECTED', 'UNKNOWN_OUTCOME'], mustDistinguishFromTranslatedTextPreparedForLaterSynthesis: true},
    failures: ['Unsupported source/target language pair, voice authority, or simultaneous mode is explicit and blocks output.', 'Unknown segment or conversation finality remains unknown; no translated speech success is inferred.'],
    authorityAdditions: ['operation-specific-policy-and-rights', 'voice-identity-and-consent-authority'],
    choiceRationale: 'New variant: simultaneous speech-to-speech conversation is distinct from translation text prepared for synthesis.'
  },
  'AUD-EDIT-016': {
    proposalKind: 'NEW_CAPABILITY_VARIANT', proposedId: 'media.edit.matte-composite', operation: 'edit.matte-composite',
    inputSlots: [
      {slotId: 'source', sourceType: 'versioned-source-media-artifact', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'matte', sourceType: 'versioned-matte-representation', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'composite-intent', sourceType: 'typed-compositing-intent-and-layer-order', cardinality: 'EXACTLY_ONE', required: true},
    ],
    output: {artifactType: 'local-composite-candidate-or-draft', resultVariants: ['COMPOSITE_CANDIDATE', 'REJECTED', 'UNKNOWN_OUTCOME'], mustRemainNonCanonicalUntilExplicitCommit: true},
    failures: ['Incompatible source/matte geometry or unsupported compositing intent blocks the candidate.', 'Unknown processing finality does not imply a composite candidate or project change.'],
    authorityAdditions: ['artifact-read-or-write-permission-as-applicable', 'project-edit-authority-for-any-later-commit'],
    choiceRationale: 'New variant: matte generation candidate does not define compositing or project mutation.'
  },
  'AUD-EDIT-024': {
    proposalKind: 'NEW_CAPABILITY_VARIANT', proposedId: 'media.accessibility.control-equivalent-action', operation: 'accessibility.control-equivalent-action',
    inputSlots: [
      {slotId: 'control', sourceType: 'stable-semantic-control-reference', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'action', sourceType: 'keyboard-or-text-equivalent-action', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'context', sourceType: 'active-view-and-focus-context', cardinality: 'EXACTLY_ONE', required: true},
    ],
    output: {artifactType: 'semantic-control-action-outcome', resultVariants: ['SAME_DECLARED_ACTION_AS_GRAPHICAL_CONTROL', 'UNAVAILABLE_EQUIVALENT', 'REJECTED', 'UNKNOWN_OUTCOME'], mustPreserveMeaningAndAuthorization: true},
    failures: ['Missing or ambiguous equivalent mapping is reported unavailable; do not substitute a different action.', 'Focus, disabled state, or authority failures prevent the action.'],
    authorityAdditions: ['actor-and-workspace-authority', 'accessible-control-action-policy'],
    choiceRationale: 'New variant: selecting an animation object does not define non-graphical control equivalence.'
  },
  'AUD-GEN-010': {
    proposalKind: 'NEW_CAPABILITY_VARIANT', proposedId: 'media.generate.video.continue', operation: 'generate.video.continue',
    inputSlots: [
      {slotId: 'source-video', sourceType: 'versioned-source-video-artifact', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'continuation-intent', sourceType: 'declared-duration-and-scene-continuation-intent', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'profile', sourceType: 'admitted-video-generation-profile', cardinality: 'EXACTLY_ONE', required: true},
    ],
    output: {artifactType: 'continued-candidate-video-with-lineage', resultVariants: ['VIDEO_CONTINUATION_CANDIDATE', 'REJECTED', 'UNKNOWN_OUTCOME'], mustKeepSourceAsLineageBasis: true},
    failures: ['Unsupported duration/profile or missing source version blocks continuation.', 'Do not infer temporal continuity or scene fidelity from source lineage alone.'],
    authorityAdditions: ['operation-specific-policy-and-rights', 'artifact-read-or-write-permission-as-applicable'],
    choiceRationale: 'New variant: continuation appends/extends temporal content and differs from source-video transformation.'
  },
  'AUD-GEN-020': {
    proposalKind: 'NEW_CAPABILITY_VARIANT', proposedId: 'media.generate.motion.text-and-style-reference', operation: 'generate.motion.text-and-style-reference',
    inputSlots: [
      {slotId: 'motion-intent', sourceType: 'text-motion-intent', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'style-reference', sourceType: 'authorized-versioned-motion-or-style-reference', cardinality: 'ZERO_OR_ONE', required: false},
      {slotId: 'target-rig', sourceType: 'declared-target-rig-profile', cardinality: 'EXACTLY_ONE', required: true},
    ],
    output: {artifactType: 'candidate-motion-sequence-with-source-provenance', resultVariants: ['MOTION_CANDIDATE', 'REJECTED', 'UNKNOWN_OUTCOME'], mustIdentifyTextAndReferenceContributionSeparately: true},
    failures: ['Unsupported text intent, reference rights, or target rig is explicit and blocks that branch.', 'Do not claim reference style recreation or rig retarget fidelity without a declared measure.'],
    authorityAdditions: ['operation-specific-policy-and-rights', 'reference-artifact-read-permission'],
    choiceRationale: 'New variant: source-motion retargeting does not define source-free text-to-motion generation or style-reference conditioning.'
  },
  'AUD-GEN-021': {
    proposalKind: 'EXTEND_EXISTING_CAPABILITY_VARIANT', proposedId: 'media.generate.video.text-to-video#render-style-preset', operation: 'generate.video.text-to-video',
    inputSlots: [
      {slotId: 'prompt', sourceType: 'text-or-video-intent', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'render-style', sourceType: 'declared-render-style-preset', cardinality: 'EXACTLY_ONE', required: true, allowedValues: ['photorealistic', 'stylized']},
      {slotId: 'profile', sourceType: 'admitted-video-generation-profile', cardinality: 'EXACTLY_ONE', required: true},
    ],
    output: {artifactType: 'candidate-video-artifact-with-execution-provenance', resultVariants: ['VIDEO_CANDIDATE_WITH_RECORDED_STYLE_PRESET', 'REJECTED', 'UNKNOWN_OUTCOME'], mustRecordRequestedAndEffectiveStyleSeparately: true},
    failures: ['Unavailable style preset is explicit; never silently substitute another style.', 'Preset selection does not itself establish visual fidelity or model qualification.'],
    authorityAdditions: ['operation-specific-policy-and-rights', 'artifact-read-or-write-permission-as-applicable'],
    choiceRationale: 'Extend existing capability: generation intent is already mapped, while explicit preset selection and effective-style disclosure are missing.'
  },
  'AUD-GEN-023': {
    proposalKind: 'NEW_CAPABILITY_VARIANT', proposedId: 'media.capability.execution.local-model-readiness', operation: 'capability.execution.local-model-readiness',
    inputSlots: [
      {slotId: 'operation-profile', sourceType: 'requested-operation-and-profile', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'model-declaration', sourceType: 'versioned-local-model-declaration', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'host-snapshot', sourceType: 'timestamped-local-host-resource-snapshot', cardinality: 'EXACTLY_ONE', required: true},
    ],
    output: {artifactType: 'local-model-compatibility-observation', resultVariants: ['DECLARED_LOCAL_COMPATIBILITY_WITH_MEMORY_BOUND', 'INCOMPATIBLE', 'UNKNOWN'], mustBeObservationOnly: true},
    failures: ['Missing/stale model or host data returns UNKNOWN compatibility.', 'Memory estimate is a declared bound/warning, not a guarantee, reservation, or execution result.'],
    authorityAdditions: ['local-host-resource-observation-authority', 'operation-specific-policy-and-rights'],
    choiceRationale: 'New variant: generic declared compatibility does not define offline local execution or host memory warning semantics.'
  },
  'AUD-GEN-024': {
    proposalKind: 'NEW_CAPABILITY_VARIANT', proposedId: 'media.capability.provider-class-separation', operation: 'capability.provider-class-separation',
    inputSlots: [
      {slotId: 'operation-profile', sourceType: 'requested-operation-and-profile', cardinality: 'EXACTLY_ONE', required: true},
      {slotId: 'provider-class', sourceType: 'declared-provider-class', cardinality: 'EXACTLY_ONE', required: true, allowedValues: ['permissive', 'hosted']},
      {slotId: 'policy-evidence', sourceType: 'versioned-provider-rights-and-policy-evidence', cardinality: 'EXACTLY_ONE', required: true},
    ],
    output: {artifactType: 'provider-class-capability-observation', resultVariants: ['CLASS_SEPARATED_WITH_DECLARED_EVIDENCE', 'UNAVAILABLE', 'UNKNOWN'], mustKeepPermissiveAndHostedClaimsSeparate: true},
    failures: ['Missing, stale, or ambiguous provider-class evidence returns UNKNOWN.', 'No provider class is inferred from generic capability declarations; no silent cross-class fallback.'],
    authorityAdditions: ['operation-specific-policy-and-rights', 'provider-class-governance-authority'],
    choiceRationale: 'New variant: declared processing-option checks do not define permissive-versus-hosted provider separation.'
  }
};

function locate(doc, collection, id, label) {
  const matches = items(doc, collection).filter((item) => nodeValue(field(item, 'id')) === id);
  if (matches.length !== 1) throw new Error(`expected exactly one ${label} ${id}; found ${matches.length}`);
  return matches[0];
}

function makeFeatureCase(review, capability) {
  const proposal = review.r3Resolution;
  const caseId = `MEDIA-P0-COHORT02-${review.existingAuditId}`;
  const slots = capability.ownerDefinition?.typedInputSlots ?? [];
  const authority = capability.requiredAuthority ?? [];
  const featureRef = review.r3Resolution.selfCheckRowRef;
  return {
    id: caseId,
    given: `The caller requests source feature ${review.existingAuditId} (${proposal.featureStatement}); current typed inputs are ${slots.map((slot) => `${slot.slotId}:${slot.sourceType}`).join(', ') || 'not source-established'}. Required authority remains ${authority.join(', ') || 'unresolved from current source'}.`,
    when: `The caller invokes ${capability.id} (${capability.operation}) for that feature request under its declared profile and admitted binding.`,
    then: `Return the current owner-defined outcome: ${capability.ownerDefinition?.semanticOutcomeContract?.result ?? capability.ownerDefinition?.result ?? 'source-defined capability outcome'}. Disclose the source acceptance criterion exactly: ${proposal.sourceAcceptanceCriterion} Feature-specific gap to resolve: ${proposal.gap}`,
    sourceRefs: [featureRef, `${CAP_PATH}#capabilities/@id=${capability.id}/ownerDefinition/typedInputSlots`, `${CAP_PATH}#capabilities/@id=${capability.id}/ownerDefinition/semanticOutcomeContract`, `${REQ_PATH}#requirements/@id=${review.requirementId}`],
    unknownOrUnsupported: `If any required feature-specific input, profile, authority, or outcome dimension is absent, unsupported, denied, or unknown, return explicit non-success/UNKNOWN without claiming the feature result: ${proposal.proposedCase.negativeCases[0]}`
  };
}

function caseForRequirement(review, capability, proposedNewMeaning = false) {
  const p = review.r3Resolution;
  const caseId = `MEDIA-REQ-P0-COHORT02-${review.existingAuditId}`;
  const typedInputs = proposedNewMeaning ? MISSING_MEANING[review.existingAuditId].inputSlots.map((slot) => `${slot.slotId}:${slot.sourceType}`).join(', ') : (capability.ownerDefinition?.typedInputSlots ?? []).map((slot) => `${slot.slotId}:${slot.sourceType}`).join(', ');
  const semanticOutput = proposedNewMeaning ? JSON.stringify(MISSING_MEANING[review.existingAuditId].output) : (capability.ownerDefinition?.semanticOutcomeContract?.result ?? capability.operation);
  return {
    id: caseId,
    given: `Feature ${review.existingAuditId} (${p.featureStatement}) is requested with typed inputs ${typedInputs}; the exact mapped operation is ${proposedNewMeaning ? MISSING_MEANING[review.existingAuditId].proposedId : capability.id}.`,
    when: `Admission evaluates the feature-specific request against source rights, declared profile, applicable capability evidence, and required authority before an effect or candidate result is claimed.`,
    then: `For ${review.existingAuditId}, the feature returns ${semanticOutput}; it preserves the source criterion without expanding it: ${p.sourceAcceptanceCriterion} Unsupported, denied, stale, or unknown feature requirements produce explicit unavailable/rejected/UNKNOWN and never imply success, fallback, runtime readiness, qualification, or external effect. Gap: ${p.gap}`
  };
}

function buildSourceAmendmentBatch() {
  const r3 = JSON.parse(read(R3_PATH).toString('utf8'));
  const r2 = JSON.parse(read(R2_PATH).toString('utf8'));
  const selfCheck = JSON.parse(read(SELF_CHECK_PATH).toString('utf8'));
  const capBytes = read(CAP_PATH);
  const reqBytes = read(REQ_PATH);
  const leafBytes = read(LEAF_REVIEW_PATH);
  const assignmentBytes = read('../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-pdp0-resolution-cohort-assignments.json');
  const assignment = JSON.parse(assignmentBytes.toString('utf8'));
  const capDoc = parseDoc(capBytes, CAP_PATH);
  const reqDoc = parseDoc(reqBytes, REQ_PATH);
  const reviews = new Map(selfCheck.supportedRowReviews.map((row) => [row.auditId, row]));
  const r3Rows = new Map(r3.rows.map((row) => [row.existingAuditId, row]));
  const capabilityAmendments = [];
  const requirementAdditions = [];
  const missingMeaningPostimages = [];
  const updatedCapabilityIds = new Set();
  const updatedRequirementIds = new Set();

  for (const auditId of Object.keys(MISSING_MEANING)) {
    const review = reviews.get(auditId);
    const sourceRow = r3Rows.get(auditId);
    if (!review || !sourceRow) throw new Error(`missing R3/self-check row ${auditId}`);
    const source = sourceRow.r3Resolution;
    const spec = MISSING_MEANING[auditId];
    const existingCap = locate(capDoc, 'capabilities', review.actualCapability.capabilityId, 'existing capability');
    const authorityBase = nodeValue(field(existingCap, 'requiredAuthority')) ?? [];
    const row = {
      auditId,
      targetCapabilitySelector: `${CAP_PATH}#capabilities/@id=${review.actualCapability.capabilityId}`,
      currentCapabilityRef: review.actualCapability.capabilityRef,
      currentOperation: review.actualCapability.operation,
      mappingChoice: spec.proposalKind,
      proposedFeatureDefinitionId: spec.proposedId,
      proposedOperation: spec.operation,
      proposedInputSlots: spec.inputSlots,
      proposedSuccessAndNonSuccessOutput: spec.output,
      proposedFailureContract: spec.failures,
      currentAuthorityBaseline: authorityBase,
      additionalAuthorityRequiringOwnerDecision: spec.authorityAdditions,
      accountableSourceOwner: 'UNRESOLVED_IN_CURRENT_AUTHORITY_MAP; root must identify the authorized semantic owner before canonical adoption',
      sourceAcceptanceCriterion: source.sourceAcceptanceCriterion,
      sourceGap: source.gap,
      exactSourceRefs: source.sourceRefs,
      preimageHashes: [source.sourceFingerprints.find((pin) => pin.sourcePath === CAP_PATH), source.sourceFingerprints.find((pin) => pin.sourcePath === REQ_PATH)].filter(Boolean),
      adoptionState: 'PROPOSAL_ONLY_PENDING_ROOT_PRODUCT_DECISION_AND_DISTINCT_PEER_REVIEW'
    };
    missingMeaningPostimages.push(row);
  }

  for (const auditId of assignment.cohorts[1].expectedAuditIds) {
    const sourceRow = r3Rows.get(auditId);
    if (!sourceRow) throw new Error(`cohort assignment row missing from R3: ${auditId}`);
    if (sourceRow.r3Resolution.status === 'NOT_REVISED_IN_R3_SCOPE') continue;
    const review = reviews.get(auditId);
    const cap = locate(capDoc, 'capabilities', review.actualCapability.capabilityId, 'current capability');
    const req = locate(reqDoc, 'requirements', review.parentRequirement.requirementId, 'parent requirement');
    const isMissing = sourceRow.r3Resolution.status === 'PROPOSED_OWNER_DEFINITION_REQUIRED';
    if (!isMissing) {
      const featureCase = makeFeatureCase(sourceRow, nodeValue(cap));
      field(cap, 'acceptanceCases')?.add(capDoc.createNode({given: featureCase.given, when: featureCase.when, then: featureCase.then}));
      updatedCapabilityIds.add(review.actualCapability.capabilityId);
      capabilityAmendments.push({auditId, targetSelector: `${CAP_PATH}#capabilities/@id=${review.actualCapability.capabilityId}/acceptanceCases`, case: featureCase, mutation: 'APPEND_FEATURE_SPECIFIC_ACCEPTANCE_CASE'});
    }
    const reqCase = caseForRequirement(sourceRow, nodeValue(cap), isMissing);
    field(req, 'acceptanceCases')?.add(reqDoc.createNode(reqCase));
    updatedRequirementIds.add(review.parentRequirement.requirementId);
    requirementAdditions.push({auditId, targetSelector: `${REQ_PATH}#requirements/@id=${review.parentRequirement.requirementId}/acceptanceCases`, case: reqCase, meaningDisposition: isMissing ? 'NEW_MEANING_CASE_LINKED_TO_NONCANONICAL_DEFINITION_PROPOSAL' : 'SUPPORTED_CORE_FEATURE_CASE'});
  }

  if (capDoc.errors.length || reqDoc.errors.length) throw new Error(`YAML parse errors: ${JSON.stringify([...capDoc.errors, ...reqDoc.errors])}`);
  const capPostimage = Buffer.from(capDoc.toString());
  const reqPostimage = Buffer.from(reqDoc.toString());
  const capPathPreimage = {targetRef: CAP_PATH, preimageSha256: sha(capBytes), postimageSha256: sha(capPostimage)};
  const reqPathPreimage = {targetRef: REQ_PATH, preimageSha256: sha(reqBytes), postimageSha256: sha(reqPostimage)};
  const nonSourceRecord = {
    schemaVersion: 'ghatana.media.pdp0.cohort02.source-amendment-record-postimages.v1',
    artifactKind: 'NON_CANONICAL_SEMANTIC_RECORD_POSTIMAGES',
    sourceAmendmentBoundary: 'Proposal records only; root decision required before converting any proposed capability/requirement rows into canonical source.',
    capabilityAcceptanceCaseAdditions: capabilityAmendments,
    requirementAcceptanceCaseAdditions: requirementAdditions,
    missingMeaningDefinitionProposals: missingMeaningPostimages,
    exactOrderedAssignedAuditIds: assignment.cohorts[1].expectedAuditIds,
    unmodifiedAssignedRows: assignment.cohorts[1].expectedAuditIds.filter((id) => r3Rows.get(id).r3Resolution.status === 'NOT_REVISED_IN_R3_SCOPE').map((auditId) => ({auditId, disposition: 'PRESERVE_FROZEN_R2_ROW_AND_PEER_REVIEW', canonicalMutation: 'NONE'})),
    historicalLeafAdjudications: {targetRef: LEAF_REVIEW_PATH, preimageSha256: sha(leafBytes), historicalRecordCount: 462, mutation: 'NONE; preserve the historical 462 rows as a separate population.'}
  };
  const sourcePins = {
    r3Sha256: sha(read(R3_PATH)), r2Sha256: sha(read(R2_PATH)), selfCheckSha256: sha(read(SELF_CHECK_PATH)),
    assignmentSha256: sha(assignmentBytes), capabilitiesPreimageSha256: sha(capBytes), requirementsPreimageSha256: sha(reqBytes),
    capabilityLeafReviewSha256: sha(leafBytes), authorityMapSha256: sha(read('.product-experience/authority-map.yaml')),
    phaseStatusSha256: sha(read('docs/implementation/pdp-0-phase-dev-status.json')),
    originalAuditSha256: sha(read('docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json'))
  };
  const targets = [
    {...capPathPreimage, semanticMutationCount: capabilityAmendments.length, postimageRef: `${CANDIDATE_DIR}/cohort-02.source-amendment-capabilities.postimage.yaml`},
    {...reqPathPreimage, semanticMutationCount: requirementAdditions.length, postimageRef: `${CANDIDATE_DIR}/cohort-02.source-amendment-requirements.postimage.yaml`}
  ];
  const recordPostimageBytes = Buffer.from(`${JSON.stringify(nonSourceRecord, null, 2)}\n`);
  const candidatePostimageSha256 = sha(Buffer.from(JSON.stringify({
    targetPostimages: targets.map(({targetRef, preimageSha256, postimageSha256}) => ({targetRef, preimageSha256, postimageSha256})),
    recordPostimageSha256: sha(recordPostimageBytes)
  })));
  const postimageArtifact = {
    schemaVersion: 'ghatana.media.pdp0.cohort02.source-amendment-postimages.v1',
    artifactId: 'media-pdp0-cohort02-source-amendment-postimages',
    status: 'EXACT_DETERMINISTIC_NONCANONICAL_POSTIMAGES_PENDING_ROOT_DECISION_AND_DISTINCT_PEER_REVIEW',
    sourcePins,
    exactTargets: targets,
    candidatePostimageSha256,
    capabilityAdditions: capabilityAmendments,
    requirementAdditions,
    missingMeaningDefinitionProposals: missingMeaningPostimages,
    exactOrderedAssignedAuditIds: assignment.cohorts[1].expectedAuditIds,
    unmodifiedAssignedRows: nonSourceRecord.unmodifiedAssignedRows,
    historicalLeafAdjudications: nonSourceRecord.historicalLeafAdjudications,
    effects: {canonicalSourceWrite: 'NOT_PERFORMED', rootDecision: 'PENDING', distinctPeerReview: 'PENDING', historical462Population: 'PRESERVED_SEPARATELY', nativeAcceptance: 'NOT_CLAIMED'}
  };
  const candidate = {
    schemaVersion: 'ghatana.media.pdp0.cohort02.source-amendment-candidate.v1',
    artifactId: 'media-pdp0-cohort02-source-amendment-candidate',
    status: 'SOURCE_GROUNDED_CANDIDATE_PENDING_ROOT_DECISION_AND_DISTINCT_PEER_REVIEW',
    scope: {macroStage: 'DISCOVERY', phase: 'PDP-0 Product Truth', criterionId: 'P0-07', cohortOrdinal: 2, exactAssignmentCount: 77, exactOrderedAssignedAuditIds: assignment.cohorts[1].expectedAuditIds, supportedFeatureCaseAdditions: capabilityAmendments.length, requirementCaseAdditions: requirementAdditions.length, missingMeaningProposals: missingMeaningPostimages.length, preservedRows: nonSourceRecord.unmodifiedAssignedRows.length, fullCampaignAuditIdDenominator: 231, campaignIdentityDenominator: 54, campaignPathDenominator: 207},
    sourcePins,
    exactTargetPostimages: targets,
    candidatePostimageSha256,
    candidatePostimageHashAlgorithm: 'SHA256(UTF8(JSON.stringify({targetPostimages:[{targetRef,preimageSha256,postimageSha256} in order],recordPostimageSha256})))',
    sourceBindings: {
      capabilitiesSha256: sourcePins.capabilitiesPreimageSha256,
      requirementsSha256: sourcePins.requirementsPreimageSha256,
      capabilityLeafReviewSha256: sourcePins.capabilityLeafReviewSha256,
      authorityMapSha256: sourcePins.authorityMapSha256,
      phaseStatusSha256: sourcePins.phaseStatusSha256,
      originalAuditSha256: sourcePins.originalAuditSha256,
      assignmentSha256: sourcePins.assignmentSha256
    },
    exactRecordPostimageRef: `${CANDIDATE_DIR}/cohort-02.source-amendment-record-postimages.json`,
    exactRecordPostimageSha256: sha(recordPostimageBytes),
    sourceOwnerDecisionRequirement: {
      schemaVersion: 'media.pdp0.source-amendment-owner-decision.v1',
      decisionKind: 'EXACT_PDP0_SOURCE_AMENDMENT',
      candidateRef: `${CANDIDATE_DIR}/cohort-02.source-amendment-candidate.json`,
      requiredBindings: ['candidateSha256', 'candidatePostimageSha256', 'sourceBindings', 'targetPostimages'],
      requiredSourceOwner: {identity: 'ROOT_TO_RESOLVE_FROM_AUTHORITY_MAP', role: 'PDP0_SOURCE_OWNER'},
      requiredDisposition: 'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_APPLY',
      authorityBoundary: {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED'}
    },
    distinctTechnicalPeerRequirement: {
      schemaVersion: 'media.pdp0.source-amendment-peer-review.v1',
      candidateRef: `${CANDIDATE_DIR}/cohort-02.source-amendment-candidate.json`,
      requiredBindings: ['candidateSha256', 'candidatePostimageSha256', 'targetPostimages', 'reviewedSourceBindings'],
      reviewer: {identity: 'DISTINCT_FROM_SOURCE_OWNER', role: 'DISTINCT_TECHNICAL_PEER'},
      requiredDisposition: 'TECHNICALLY_REVIEWED_EXACT_POSTIMAGE',
      authorityBoundary: {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED'}
    },
    historicalLeafAdjudications: nonSourceRecord.historicalLeafAdjudications,
    blockers: ['Root must decide the nine exact new-meaning capability or capability-variant definitions and resolve their accountable semantic owner.', 'A distinct technical peer must bind review to the exact candidate and both target postimage byte hashes.', 'Historical 462 leaf adjudications remain unchanged and must not be merged into this cohort batch.'],
    canonicalApply: 'NOT_PERFORMED',
    nonClaims: ['No source owner approval or authority identity is invented.', 'No peer acceptance, canonical write, implementation, independent acceptance, qualification, closure, or release is claimed.']
  };
  return {candidate, postimageArtifact, nonSourceRecord, capabilityPostimage: capPostimage, requirementPostimage: reqPostimage};
}

export { buildSourceAmendmentBatch };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {candidate, postimageArtifact, nonSourceRecord, capabilityPostimage, requirementPostimage} = buildSourceAmendmentBatch();
  const outputs = [
    [`${CANDIDATE_DIR}/cohort-02.source-amendment-candidate.json`, Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`)],
    [`${CANDIDATE_DIR}/cohort-02.source-amendment-postimages.json`, Buffer.from(`${JSON.stringify(postimageArtifact, null, 2)}\n`)],
    [`${CANDIDATE_DIR}/cohort-02.source-amendment-record-postimages.json`, Buffer.from(`${JSON.stringify(nonSourceRecord, null, 2)}\n`)],
    [`${CANDIDATE_DIR}/cohort-02.source-amendment-capabilities.postimage.yaml`, capabilityPostimage],
    [`${CANDIDATE_DIR}/cohort-02.source-amendment-requirements.postimage.yaml`, requirementPostimage]
  ];
  for (const [ref, bytes] of outputs) fs.writeFileSync(path.join(ROOT, ref), bytes);
  console.log(JSON.stringify({written: outputs.map(([ref, bytes]) => ({ref, sha256: sha(bytes)})), capabilityCaseAdds: candidate.scope.supportedFeatureCaseAdditions, requirementCaseAdds: candidate.scope.requirementCaseAdditions, missingMeaningProposals: candidate.scope.missingMeaningProposals}));
}
