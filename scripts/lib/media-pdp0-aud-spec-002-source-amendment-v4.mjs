import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildAudSpec002SourceAmendmentV3} from './media-pdp0-aud-spec-002-source-amendment-v3.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const yaml = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../ghatana-tools/package.json'))('yaml');
const FOLDER = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const CAP_PATH = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const REQ_PATH = '.product-experience/pdp-0-product-truth/requirements.yaml';
const CROSSWALK_PATH = `${FOLDER}/pdp0-501-disposition-crosswalk.json`;
const REVIEW_PATH = '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml';
const CAPABILITY_ID = 'media.recipe.specification.compile';
const MIGRATION_OUTPUT = 'reviewable-version-bound-schema-migration-candidate-and-semantic-diff';
const GRAPH_OUTPUT = 'normalized-semantic-graph-and-reviewable-project-plan-candidate';
const MIGRATION_INPUT_SELECTOR = 'migrationIntent=SCHEMA_MIGRATION;sourceSpecification=EXACT_VERSIONED;sourceSchema=EXACT_VERSIONED;targetSchema=EXACT_VERSIONED;transformation=EXACT_DECLARED;transformationSupport=SUPPORTED';
const MIGRATION_RESULT_KIND = 'SUPPORTED_VERSION_BOUND_SCHEMA_MIGRATION_CANDIDATE_AND_SEMANTIC_DIFF';
const MIGRATION_VARIANT_SELECTOR = `resultKind=${MIGRATION_RESULT_KIND};originRelation=SOURCE_DERIVED;epistemicDisposition=SOURCE_DERIVED_TRANSFORMATION;${MIGRATION_INPUT_SELECTOR}`;
const OWNER_ADJUDICATION_ID = 'media.capability-adjudication.recipe-specification-compile';
const TRUST_RECORD_ID = 'media.capability-trust-reconstruction.media-capability-adjudication-recipe-specification-compile.v1';

function ensure(condition, message) { if (!condition) throw new Error(message); }
function one(rows, predicate, label) { const found = rows.filter(predicate); ensure(found.length === 1, `expected one ${label}, found ${found.length}`); return found[0]; }
function sectionReplace(source, startMarker, endMarker, transform) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  ensure(start >= 0 && end > start, `missing or reordered source section ${startMarker}`);
  return `${source.slice(0, start)}${transform(source.slice(start, end))}${source.slice(end)}`;
}
function insertYAMLListRow(section, row, beforeMarker, listIndent = '    ') {
  ensure(section.includes('  records:\n'), 'missing records list for source extension');
  const serialized = yaml.stringify(row, {lineWidth: 0}).trimEnd().split('\n');
  const rowText = `${listIndent}- ${serialized[0]}\n${serialized.slice(1).map(line => `${listIndent}  ${line}`).join('\n')}`;
  // Match the marker as a complete line. A plain substring search for
  // "  joinRule:" also matches the last two spaces of the nested population
  // joinRule and inserts a sequence item into that mapping.
  const markerWithLineStart = `\n${beforeMarker}`;
  const markerIndex = section.indexOf(markerWithLineStart);
  const index = markerIndex < 0 ? (section.startsWith(beforeMarker) ? 0 : -1) : markerIndex + 1;
  ensure(index >= 0, `missing insertion boundary ${beforeMarker.trim()}`);
  return `${section.slice(0, index).trimEnd()}\n${rowText}\n${section.slice(index)}`;
}
function replaceScalar(section, key, before, after, indent = '  ') {
  const pattern = new RegExp(`^${indent}${key}: ${before.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu');
  ensure(pattern.test(section), `expected exact scalar ${key}: ${before}`);
  return section.replace(pattern, `${indent}${key}: ${after}`);
}
function sourceRowFromPxd207(applications) {
  const extension = one(applications.coordinatorDefinitionExtensionApplicability.records, row => row.capabilityRef === CAPABILITY_ID, 'PXD-207 compile extension applicability');
  ensure(extension.decision.decisionRef === '.product-experience/decision-log.md#PXD-207', 'extension applicability must be PXD-207 bound');
  ensure(extension.decision.includedChannelRef === 'media.channel.cli', 'PXD-207 must name CLI as the included channel');
  ensure(extension.decision.includedSurfaceRefs.includes('media.surface.recorder-orchestrator'), 'PXD-207 must name the feature owner surface');
  return extension;
}

function buildAdjudication(capability, requirement, pxd207) {
  const allChannels = [
    'media.channel.web', 'media.channel.api', 'media.channel.embedded', 'media.channel.http-api', 'media.channel.grpc-api',
    'media.channel.sdk', 'media.channel.cli', 'media.channel.product-integration', 'media.channel.legacy-desktop',
    'media.channel.agent', 'media.channel.event',
  ];
  const excluded = new Map(pxd207.decision.excludedChannelRefs.map(item => [item.channelRef, item.rationale]));
  ensure(allChannels.length === 11 && excluded.size === 10 && !excluded.has('media.channel.cli'), 'PXD-207 channel partition is incomplete or contradictory');
  const channelApplicability = allChannels.map(channelRef => channelRef === 'media.channel.cli' ? {
    channelRef, disposition: 'SOURCE_DECLARED_DEFINITION_APPLICABLE', sourceLabel: 'cli', ruleRef: 'PXD-207_EXACT_EXTENSION_CHANNEL',
    phase0Admission: 'pending', executionAdmission: 'NOT_ADMITTED',
  } : {
    channelRef, disposition: 'OWNER_SELECTED_NOT_APPLICABLE_TO_THIS_LEAF', sourceLabel: null,
    ruleRef: 'PXD-207_EXACT_EXTENSION_CHANNEL_EXCLUSION', phase0Admission: 'pending', executionAdmission: 'NOT_ADMITTED',
  });
  const ownerDefinition = capability.ownerDefinition;
  return {
    capabilityRef: capability.id,
    ownerDisposition: 'MACHINE_CAPABILITY_WITH_EXPLICIT_CHANNEL_APPLICABILITY',
    capabilitySourceRef: `${CAP_PATH}#capabilities/@id=${capability.id}`,
    requirementRefs: [requirement.id],
    journeyRefs: [],
    platformDependencyRefs: [],
    profileRef: ownerDefinition.familyProfileRef,
    boundsRef: ownerDefinition.boundsRef,
    authorityRefs: [...capability.requiredAuthority],
    channelApplicability,
    definitionState: 'OWNER_DEFINED_DEFINITION_ONLY',
    implementationState: 'UNKNOWN',
    qualificationState: 'NOT_EVALUATED',
    runtimeAvailability: 'UNKNOWN',
    independentAcceptance: 'P0-010-independent-review-open',
    id: OWNER_ADJUDICATION_ID,
    recordKind: 'ADDITIVE_PDP0_SOURCE_DEFINITION_EXTENSION',
    decisionAuthority: 'User-delegated PDP-0 technical source-owner proposal; adoption is pending distinct peer review and root disposition.',
    decisionRefs: ['.product-experience/decision-log.md#PXD-207'],
    sourceRefs: [
      `${CAP_PATH}#capabilities/@id=${capability.id}`,
      `${REQ_PATH}#requirements/@id=${requirement.id}`,
      '.product-experience/pdp-0-product-truth/applications-channels.yaml#coordinatorDefinitionExtensionApplicability/records/@capabilityRef=media.recipe.specification.compile',
      'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json#originalAudit.inventory/@audit_id=AUD-SPEC-002',
    ],
    normativeMeaning: 'This separate current extension row proposes exact PDP-0 capability intent and source-backed CLI applicability for schema migration candidate preparation. It does not alter the historical 462-row cohort, imply independent acceptance, or admit execution.',
    inputArtifactTypes: ownerDefinition.typedInputSlots.map(slot => slot.sourceType),
    outputArtifactTypes: ownerDefinition.successOutputs.map(output => output.artifactType),
  };
}

function buildTrustRecord(capability, adjudication) {
  const output = capability.ownerDefinition.successOutputs;
  const inputArtifactTypes = capability.ownerDefinition.typedInputSlots.map(slot => slot.sourceType);
  const graphOutcome = {
    when: `outputArtifactType=${GRAPH_OUTPUT}`,
    disposition: 'SOURCE_DERIVED_TRANSFORMATION',
    epistemicRole: 'SOURCE_DERIVED_SPECIFICATION_CANDIDATE',
    meaning: 'The normalized semantic graph and project-plan candidate derive from the exact versioned specification, schema, and compiler-contract inputs, with the optional exact project revision only when consumed. The candidate is a reviewable specification interpretation, not a media artifact, execution, project mutation, job, publication, or claim that a transformation was applied. Bind exact input identities/versions and method; unknown or unsupported inputs remain UNKNOWN/UNSUPPORTED.',
  };
  const migrationOutcome = {
    when: MIGRATION_VARIANT_SELECTOR,
    disposition: 'SOURCE_DERIVED_TRANSFORMATION',
    epistemicRole: 'SOURCE_DERIVED_SPECIFICATION_CANDIDATE',
    meaning: 'The reviewable semantic candidate and diff derive only from the exact source specification/schema, requested target schema, explicitly declared supported transformation, and compiler-contract version. They are not a migrated media artifact and do not assert that a migration was applied, any project mutated, or any execution or external effect occurred. Preserve the original; bind exact source/target/transformation identities and versions, method, provenance, and limits. Unsupported, lossy, ambiguous, stale, or unknown inputs remain UNKNOWN/UNSUPPORTED and produce no migration candidate.',
  };
  return {
    id: TRUST_RECORD_ID,
    capabilityRef: capability.id,
    sourceRefs: [
      `${CAP_PATH}#capabilities/@id=${capability.id}`,
      `.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@id=${adjudication.id}`,
      `${REQ_PATH}#ownerDefinedLeafTrustReconstructionPolicy`,
      `${REQ_PATH}#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-16`,
    ],
    outputBranches: [
      {
        outputArtifactType: output[0].artifactType,
        outcomes: [graphOutcome],
        missingOrUnknown: 'UNKNOWN; preserve exact source identities and block an unsupported candidate',
        sourceArtifactTypeRef: `${CAP_PATH}#capabilities/@id=${capability.id}/outputArtifactTypes/0`,
        when: `outputArtifactType=${output[0].artifactType}`,
      },
      {
        outputArtifactType: output[1].artifactType,
        outcomes: [migrationOutcome],
        missingOrUnknown: 'UNKNOWN; preserve exact source/request identities and block unsupported migration candidate output',
        sourceArtifactTypeRef: `${CAP_PATH}#capabilities/@id=${capability.id}/outputArtifactTypes/1`,
        when: `outputArtifactType=${output[1].artifactType};${MIGRATION_VARIANT_SELECTOR}`,
      },
    ],
    unknownPolicy: 'UNKNOWN_OR_ABSTAINED; reject foreign/stale source, missing typed provenance, unsupported/unbound schema or transformation versions, or missing capability identity or current authority before claiming candidate output truth',
    definitionStatus: 'OWNER_DEFINED_DEFINITION_ONLY',
    runtimeAdmission: 'NOT_ADMITTED',
    qualification: 'NOT_EVALUATED',
    acceptanceEffect: 'none',
    inputArtifactTypes,
    outputArtifactTypes: output.map(item => item.artifactType),
  };
}

function makeCandidateSchema() {
  const hash = {type: 'string', pattern: '^[a-f0-9]{64}$'};
  const target = targetRef => ({type: 'object', additionalProperties: false, required: ['targetRef', 'preimageSha256', 'postimageSha256'], properties: {targetRef: {const: targetRef}, preimageSha256: hash, postimageSha256: hash}});
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'media.pdp0.aud-spec-002-source-amendment-candidate.v4',
    type: 'object', additionalProperties: false,
    required: ['schemaVersion','artifactKind','auditId','predecessorCandidateRef','predecessorCandidateSha256','sourceBindings','postimageSha256','candidatePostimageSha256','conditionalOutputRule','resultVariantSelector','extensionRegistration','exactFileTargets','rootDecisionTemplateRef','blockers','canonicalApply','effects'],
    properties: {
      schemaVersion: {const: 'media.pdp0.aud-spec-002-source-amendment-candidate.v4'},
      artifactKind: {const: 'NON_CANONICAL_EXACT_SOURCE_AMENDMENT_CANDIDATE'},
      auditId: {const: 'AUD-SPEC-002'},
      predecessorCandidateRef: {const: `${FOLDER}/AUD-SPEC-002-source-amendment-candidate.v3.json`},
      predecessorCandidateSha256: hash,
      sourceBindings: {type: 'object', additionalProperties: false, required: ['crosswalkSha256','auditSha256','capabilitiesSha256','requirementsSha256','capabilityLeafReviewSha256','applicationsChannelsSha256','decisionLogSha256'], properties: Object.fromEntries(['crosswalkSha256','auditSha256','capabilitiesSha256','requirementsSha256','capabilityLeafReviewSha256','applicationsChannelsSha256','decisionLogSha256'].map(key => [key, hash]))},
      postimageSha256: {type: 'object', additionalProperties: false, required: ['capabilityYaml','requirementsYaml','crosswalkJson','capabilityLeafReviewYaml'], properties: Object.fromEntries(['capabilityYaml','requirementsYaml','crosswalkJson','capabilityLeafReviewYaml'].map(key => [key, hash]))},
      candidatePostimageSha256: hash,
      conditionalOutputRule: {const: 'ordinary compile requires only the existing graph/plan; migration candidate is additionally required only for the exact supported migration input selector; incomplete or unsupported migration inputs produce no candidate'},
      resultVariantSelector: {const: MIGRATION_VARIANT_SELECTOR},
      extensionRegistration: {type: 'object', additionalProperties: false, required: ['capabilityRef','ownerAdjudicationId','trustRecordId','historicalOwnerRowsPreserved','historicalTrustRowsPreserved','currentTotalAfterProposal'], properties: {capabilityRef: {const: CAPABILITY_ID}, ownerAdjudicationId: {const: OWNER_ADJUDICATION_ID}, trustRecordId: {const: TRUST_RECORD_ID}, historicalOwnerRowsPreserved: {const: 462}, historicalTrustRowsPreserved: {const: 462}, currentTotalAfterProposal: {const: 463}}},
      exactFileTargets: {
        type: 'array', minItems: 4, maxItems: 4,
        prefixItems: [target(CAP_PATH), target(REQ_PATH), target(CROSSWALK_PATH), target(REVIEW_PATH)],
        items: false,
      },
      rootDecisionTemplateRef: {const: `${FOLDER}/AUD-SPEC-002-source-amendment-root-decision.v4.json`},
      blockers: {type: 'array', minItems: 2, items: {type: 'string'}}, canonicalApply: {const: 'NOT_PERFORMED'},
      effects: {type: 'object', additionalProperties: false, required: ['canonicalSourceWrite','historical462Population','independentAcceptance','runtimeAdmission','nativeProof'], properties: {canonicalSourceWrite: {const: 'NOT_PERFORMED'}, historical462Population: {const: 'PRESERVED_SEPARATELY'}, independentAcceptance: {const: 'NOT_CLAIMED'}, runtimeAdmission: {const: 'NOT_ADMITTED'}, nativeProof: {const: 'NOT_CLAIMED'}}},
    },
  };
}

function makeSourceAmendmentSchema() {
  const hash = {type: 'string', pattern: '^[a-f0-9]{64}$'};
  const required = [
    'schemaVersion', 'artifactKind', 'predecessorV3', 'sourceBindings', 'proposedTechnicalAuthor',
    'exactConditionalOutput', 'ordinaryCompile', 'supportedMigration', 'unsupportedOrUnknownMigration',
    'sourceOwnerExtension', 'exactTargets', 'postimageSha256', 'historicalBoundary', 'authorityBoundary',
  ];
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'media.pdp0.aud-spec-002-source-amendment-postimage.v4',
    type: 'object', additionalProperties: false, required,
    properties: {
      schemaVersion: {const: 'media.pdp0.aud-spec-002-source-amendment-postimage.v4'},
      artifactKind: {const: 'NON_CANONICAL_FOUR_SOURCE_POSTIMAGE_PROPOSAL'},
      predecessorV3: {type: 'object', additionalProperties: false, required: ['ref', 'sha256', 'immutable'], properties: {ref: {const: `${FOLDER}/AUD-SPEC-002-source-amendment-candidate.v3.json`}, sha256: hash, immutable: {const: true}}},
      sourceBindings: {type: 'object', additionalProperties: false, required: ['crosswalkSha256','auditSha256','capabilitiesSha256','requirementsSha256','capabilityLeafReviewSha256','applicationsChannelsSha256','decisionLogSha256'], properties: Object.fromEntries(['crosswalkSha256','auditSha256','capabilitiesSha256','requirementsSha256','capabilityLeafReviewSha256','applicationsChannelsSha256','decisionLogSha256'].map(key => [key, hash]))},
      proposedTechnicalAuthor: {const: 'agent:/root/phase_io'},
      exactConditionalOutput: {type: 'object', additionalProperties: false, required: ['artifactType','requiredWhenSelector','resultVariantSelector','resultKind','originRelation','epistemicDisposition','appliedEffect'], properties: {artifactType: {const: MIGRATION_OUTPUT}, requiredWhenSelector: {const: MIGRATION_INPUT_SELECTOR}, resultVariantSelector: {const: MIGRATION_VARIANT_SELECTOR}, resultKind: {const: MIGRATION_RESULT_KIND}, originRelation: {const: 'SOURCE_DERIVED'}, epistemicDisposition: {const: 'SOURCE_DERIVED_TRANSFORMATION'}, appliedEffect: {const: 'NO_MIGRATION_APPLIED'}}},
      ordinaryCompile: {type: 'object', additionalProperties: false, required: ['existingOutput','requiredOnSuccess','migrationCandidateRequired','migrationCandidateEmitted','acceptanceCase'], properties: {existingOutput: {const: GRAPH_OUTPUT}, requiredOnSuccess: {const: true}, migrationCandidateRequired: {const: false}, migrationCandidateEmitted: {const: false}, acceptanceCase: {const: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-15'}}},
      supportedMigration: {type: 'object', additionalProperties: false, required: ['existingGraphOutputRemainsRequired','additionalMigrationOutputRequiredForExactInputSelector','acceptanceCase','originalPreserved','projectMutation','jobSubmission','externalEffect'], properties: {existingGraphOutputRemainsRequired: {const: true}, additionalMigrationOutputRequiredForExactInputSelector: {const: true}, acceptanceCase: {const: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-16'}, originalPreserved: {const: true}, projectMutation: {const: false}, jobSubmission: {const: false}, externalEffect: {const: false}}},
      unsupportedOrUnknownMigration: {type: 'object', additionalProperties: false, required: ['acceptanceCase','result','migrationCandidate','originalPreserved','projectMutation','externalEffect'], properties: {acceptanceCase: {const: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-17'}, result: {const: 'UNKNOWN_OR_UNSUPPORTED_OR_REJECTED'}, migrationCandidate: {const: 'NONE'}, originalPreserved: {const: true}, projectMutation: {const: false}, externalEffect: {const: false}}},
      sourceOwnerExtension: {type: 'object', additionalProperties: false, required: ['capabilityRef','exactPxd207ScopeRef','channel','ownerAdjudicationRecordId','trustRecordId','priorOwnerRows','priorTrustRows','currentProposedRows','sourceSelectorRule'], properties: {capabilityRef: {const: CAPABILITY_ID}, exactPxd207ScopeRef: {type: 'string', minLength: 1}, channel: {const: 'media.channel.cli'}, ownerAdjudicationRecordId: {const: OWNER_ADJUDICATION_ID}, trustRecordId: {const: TRUST_RECORD_ID}, priorOwnerRows: {const: 462}, priorTrustRows: {const: 462}, currentProposedRows: {const: 463}, sourceSelectorRule: {type: 'string', minLength: 1}}},
      exactTargets: {type: 'array', minItems: 4, maxItems: 4, prefixItems: [CAP_PATH, REQ_PATH, CROSSWALK_PATH, REVIEW_PATH].map(targetRef => ({type: 'object', additionalProperties: false, required: ['targetRef','preimageSha256','postimageSha256'], properties: {targetRef: {const: targetRef}, preimageSha256: hash, postimageSha256: hash}})), items: false},
      postimageSha256: {type: 'object', additionalProperties: false, required: ['capabilityYaml','requirementsYaml','crosswalkJson','capabilityLeafReviewYaml'], properties: Object.fromEntries(['capabilityYaml','requirementsYaml','crosswalkJson','capabilityLeafReviewYaml'].map(key => [key, hash]))},
      historicalBoundary: {type: 'object', additionalProperties: false, required: ['historic462OwnerRows','historic462TrustRows','newExtension'], properties: {historic462OwnerRows: {const: 'PRESERVED_BYTE_FOR_BYTE_AND_IN_ORDER'}, historic462TrustRows: {const: 'PRESERVED_BYTE_FOR_BYTE_AND_IN_ORDER'}, newExtension: {const: 'ADDITIVE_ROW_463; not represented as one of the historic 462'}}},
      authorityBoundary: {type: 'object', additionalProperties: false, required: ['rootTechnicalSourceOwnerDecision','distinctTechnicalPeerReview','independentAcceptance','nativeProof','trustedIssuerOrCredentialRegistration','runtimeAdmission','canonicalApply'], properties: {rootTechnicalSourceOwnerDecision: {const: 'PENDING'}, distinctTechnicalPeerReview: {const: 'PENDING'}, independentAcceptance: {const: 'NOT_CLAIMED'}, nativeProof: {const: 'NOT_CLAIMED'}, trustedIssuerOrCredentialRegistration: {const: 'NOT_REQUESTED'}, runtimeAdmission: {const: 'NOT_ADMITTED'}, canonicalApply: {const: 'NOT_PERFORMED'}}},
    },
  };
}

export function buildAudSpec002SourceAmendmentV4(inputs) {
  const v3 = buildAudSpec002SourceAmendmentV3(inputs);
  const capabilityFile = yaml.parse(inputs.capabilitiesBytes.toString('utf8'));
  const requirementFile = yaml.parse(inputs.requirementsBytes.toString('utf8'));
  const applications = yaml.parse(inputs.applicationsChannelsBytes.toString('utf8'));
  const reviewFile = yaml.parse(inputs.capabilityLeafReviewBytes.toString('utf8'));
  const logText = inputs.decisionLogBytes.toString('utf8');
  const pxd207 = sourceRowFromPxd207(applications);
  ensure(logText.includes('### PXD-207 — Resolve current PDP-0 owner meaning and exact extension scope'), 'exact PXD-207 decision section missing');
  ensure(logText.includes('### PXD-128 — Define audited result variants for trust reconstruction'), 'exact PXD-128 decision section missing');

  const cap = yaml.parse(v3.capabilityPostimage.toString('utf8'));
  const capability = one(cap.capabilities, row => row.id === CAPABILITY_ID, 'compile capability in v3 postimage');
  const migrationOutput = one(capability.ownerDefinition.successOutputs, row => row.artifactType === MIGRATION_OUTPUT, 'conditional migration output');
  migrationOutput.resultVariants = [{
    resultKind: MIGRATION_RESULT_KIND,
    originRelation: 'SOURCE_DERIVED',
    epistemicDisposition: 'SOURCE_DERIVED_TRANSFORMATION',
    disposition: 'NO_MIGRATION_APPLIED',
    selector: MIGRATION_VARIANT_SELECTOR,
    meaning: 'Selected only for a complete exact versioned source specification/schema, requested target schema, explicitly declared supported transformation, and exact compiler-contract version. The candidate and semantic diff bind every exact identity/version and are source-derived specification artifacts; they preserve the original and do not mean a migration was applied, a project changed, or an external effect occurred. Unsupported, lossy, ambiguous, stale, or unknown cases remain UNKNOWN/UNSUPPORTED with no migration candidate.',
  }];
  migrationOutput.requiredOnSuccess = false;
  migrationOutput.requiredWhenSelector = MIGRATION_INPUT_SELECTOR;
  ensure(migrationOutput.requiredWhenSelector !== migrationOutput.resultVariants[0].selector, 'input conditional selector must not be conflated with output result-variant selector');
  const v4SelectorConstraint = `The ${MIGRATION_OUTPUT} result variant is selected only by ${MIGRATION_VARIANT_SELECTOR}; it is required only when ${MIGRATION_INPUT_SELECTOR} and is absent for ordinary compilation or UNKNOWN/UNSUPPORTED migration outcomes.`;
  const oldV3Constraint = capability.constraints.findIndex(text => text.includes(`The ${MIGRATION_OUTPUT} result is required only when ${MIGRATION_INPUT_SELECTOR}`));
  ensure(oldV3Constraint >= 0, 'v3 conditional-output constraint missing');
  capability.constraints[oldV3Constraint] = v4SelectorConstraint;
  const distinctionIndex = capability.ownerDefinition.semanticOutcomeContract.outputDistinctions.findIndex(text => text.includes(`The ${MIGRATION_OUTPUT} result is required only when ${MIGRATION_INPUT_SELECTOR}`));
  ensure(distinctionIndex >= 0, 'v3 conditional-output distinction missing');
  capability.ownerDefinition.semanticOutcomeContract.outputDistinctions[distinctionIndex] = v4SelectorConstraint;
  const oldRef = capability.ownerDefinition.semanticOutcomeContract.sourceRefs.includes('.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-15');
  ensure(oldRef, 'ordinary compile AC-15 source ref is missing');

  const requirement = v3.sourceAmendment.requirement;
  const ac16 = {
    id: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-16',
    given: 'An authorized creator supplies the exact versioned source production specification and schema, requested target schema, explicitly declared supported transformation identity/version, and exact compiler-contract version.',
    when: 'Media prepares a schema-migration candidate under the exact migration intent.',
    then: 'Return the existing normalized graph/project-plan candidate plus the required reviewable version-bound migration candidate and semantic diff; bind source, target, transformation, and compiler-contract identities/versions and preserve the original.',
    rejection: 'Do not apply the migration, mutate a project, submit a job, publish content, cause an external effect, or claim that the candidate is migrated media or lossless preservation.',
  };
  const ac17 = {
    id: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-17',
    given: 'A migration intent omits or has a stale, unsupported, lossy, ambiguous, or unknown source schema, target schema, transformation, or compiler-contract version.',
    when: 'Media evaluates the migration request.',
    then: 'Return an explicit UNKNOWN/UNSUPPORTED or rejected result and no migration candidate; preserve source identities and do not change ordinary compile output.',
    rejection: 'Do not infer a target, substitute a transformation, emit a success-shaped migration candidate, apply any migration, or cause a project, job, publication, or external effect.',
  };
  ensure(!requirement.acceptanceCases.some(row => row.id === ac16.id || row.id === ac17.id), 'v4 acceptance cases already present; source cut has changed');
  requirement.acceptanceCases.push(ac16, ac17);
  const currentRequirement = one(requirementFile.requirements, row => row.id === requirement.id, 'current requirement target');
  requirementFile.requirements[requirementFile.requirements.indexOf(currentRequirement)] = requirement;
  const capabilityPostimage = Buffer.from(`${yaml.stringify(cap, {lineWidth: 0}).trimEnd()}\n`);
  const requirementPostimage = Buffer.from(`${yaml.stringify(requirementFile, {lineWidth: 0}).trimEnd()}\n`);

  const crosswalk = JSON.parse(v3.crosswalkPostimage.toString('utf8'));
  const crosswalkRow = one(crosswalk.rows, row => row.auditId === 'AUD-SPEC-002', 'AUD-SPEC-002 crosswalk row');
  const evidenceRefs = [
    `${REQ_PATH}#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-16`,
    `${REQ_PATH}#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-17`,
  ];
  crosswalkRow.pdp0EvidenceRefs = [...new Set([...crosswalkRow.pdp0EvidenceRefs, ...evidenceRefs])];
  crosswalkRow.phaseLocalRationale += ' AC-16 specifies the source-bound supported migration candidate; AC-17 specifies unsupported/unknown fail-closed behavior. Exact result-kind, source-derived origin, and epistemic selectors are bound to PXD-128; the separate extension adjudication and trust rows preserve all 462 historic records.';
  const crosswalkPostimage = Buffer.from(`${JSON.stringify(crosswalk, null, 2)}\n`);

  const capabilityInputs = yaml.parse(inputs.capabilitiesBytes.toString('utf8'));
  const canonicalCapability = one(capabilityInputs.capabilities, row => row.id === CAPABILITY_ID, 'current capability source');
  const canonicalRequirement = one(requirementFile.requirements, row => row.id === 'MEDIA-REQ-CAP-RECIPE-TEMPLATE', 'current requirement source');
  const proposedAdjudication = buildAdjudication(capability, canonicalRequirement, pxd207);
  const proposedTrust = buildTrustRecord(capability, proposedAdjudication);
  const extOwnerBase = reviewFile.ownerCapabilityLeafAdjudication;
  const extTrustBase = reviewFile.ownerTrustReconstructionDispositions;
  ensure(extOwnerBase.records.length === 462 && extTrustBase.records.length === 462, 'historical source populations are not exactly 462');
  ensure(!extOwnerBase.records.some(row => row.capabilityRef === CAPABILITY_ID), 'unexpected owner-adjudication row already exists');
  ensure(!extTrustBase.records.some(row => row.capabilityRef === CAPABILITY_ID), 'unexpected trust row already exists');
  ensure(JSON.stringify(proposedAdjudication.outputArtifactTypes) === JSON.stringify(capability.ownerDefinition.successOutputs.map(item => item.artifactType)), 'proposed adjudication outputs do not exactly match capability');
  ensure(JSON.stringify(proposedTrust.outputArtifactTypes) === JSON.stringify(proposedAdjudication.outputArtifactTypes), 'trust output types do not match exact capability/adjudication outputs');
  ensure(canonicalCapability.id === capability.id, 'capability identity drift');

  let reviewText = inputs.capabilityLeafReviewBytes.toString('utf8');
  reviewText = sectionReplace(reviewText, 'ownerCapabilityLeafAdjudication:\n', 'currentOwnerDefinitionCensus:\n', section => {
    let updated = replaceScalar(section, 'exactLeafCount', '462', '463');
    updated = replaceScalar(updated, 'uniqueLeafCount', '462', '463');
    updated = replaceScalar(updated, 'perLeafChannelApplicabilityRows', '5082', '5093');
    updated = updated.replace(/^    MACHINE_CAPABILITY_WITH_EXPLICIT_CHANNEL_APPLICABILITY: 383$/mu, '    MACHINE_CAPABILITY_WITH_EXPLICIT_CHANNEL_APPLICABILITY: 384');
    ensure(updated.includes('MACHINE_CAPABILITY_WITH_EXPLICIT_CHANNEL_APPLICABILITY: 384'), 'owner disposition tally not updated');
    return insertYAMLListRow(updated, proposedAdjudication, '  recordAuthority:');
  });
  reviewText = sectionReplace(reviewText, 'ownerTrustReconstructionDispositions:\n', 'pdp0ToPdp1ConsumerHandoff:\n', section => {
    let updated = replaceScalar(section, 'capabilityCount', '462', '463', '    ');
    updated = replaceScalar(updated, 'recordCount', '462', '463', '    ');
    return insertYAMLListRow(updated, proposedTrust, '  joinRule:');
  });
  const reviewPostimage = Buffer.from(reviewText);
  const validationReview = yaml.parse(reviewPostimage.toString('utf8'));
  ensure(validationReview.ownerCapabilityLeafAdjudication.records.length === 463, `postimage owner adjudication total must be 463, got ${validationReview.ownerCapabilityLeafAdjudication.records.length}; row=${reviewText.slice(reviewText.indexOf(OWNER_ADJUDICATION_ID) - 1000, reviewText.indexOf(OWNER_ADJUDICATION_ID) + 100)}`);
  ensure(validationReview.ownerTrustReconstructionDispositions.records.length === 463, `postimage trust total must be 463, got ${validationReview.ownerTrustReconstructionDispositions.records.length}`);
  ensure(validationReview.ownerCapabilityLeafAdjudication.records.slice(0, 462).every((row, index) => JSON.stringify(row) === JSON.stringify(reviewFile.ownerCapabilityLeafAdjudication.records[index])), 'historic 462 owner rows changed');
  ensure(validationReview.ownerTrustReconstructionDispositions.records.slice(0, 462).every((row, index) => JSON.stringify(row) === JSON.stringify(reviewFile.ownerTrustReconstructionDispositions.records[index])), 'historic 462 trust rows changed');

  const postimages = {
    [CAP_PATH]: capabilityPostimage,
    [REQ_PATH]: requirementPostimage,
    [CROSSWALK_PATH]: crosswalkPostimage,
    [REVIEW_PATH]: reviewPostimage,
  };
  const postimageSha256 = {
    capabilityYaml: sha(capabilityPostimage), requirementsYaml: sha(requirementPostimage),
    crosswalkJson: sha(crosswalkPostimage), capabilityLeafReviewYaml: sha(reviewPostimage),
  };
  const sourceAmendment = {
    schemaVersion: 'media.pdp0.aud-spec-002-source-amendment-postimage.v4',
    artifactKind: 'NON_CANONICAL_FOUR_SOURCE_POSTIMAGE_PROPOSAL',
    predecessorV3: {ref: `${FOLDER}/AUD-SPEC-002-source-amendment-candidate.v3.json`, sha256: 'f7ed4fbf6ca136eab71e58abfab8e30413c1ccb44b13c049a26e6674c464e280', immutable: true},
    sourceBindings: {
      crosswalkSha256: sha(inputs.crosswalkBytes), auditSha256: sha(inputs.auditBytes), capabilitiesSha256: sha(inputs.capabilitiesBytes),
      requirementsSha256: sha(inputs.requirementsBytes), capabilityLeafReviewSha256: sha(inputs.capabilityLeafReviewBytes),
      applicationsChannelsSha256: sha(inputs.applicationsChannelsBytes), decisionLogSha256: sha(inputs.decisionLogBytes),
    },
    proposedTechnicalAuthor: 'agent:/root/phase_io',
    exactConditionalOutput: {artifactType: MIGRATION_OUTPUT, requiredWhenSelector: MIGRATION_INPUT_SELECTOR, resultVariantSelector: MIGRATION_VARIANT_SELECTOR, resultKind: MIGRATION_RESULT_KIND, originRelation: 'SOURCE_DERIVED', epistemicDisposition: 'SOURCE_DERIVED_TRANSFORMATION', appliedEffect: 'NO_MIGRATION_APPLIED'},
    ordinaryCompile: {existingOutput: GRAPH_OUTPUT, requiredOnSuccess: true, migrationCandidateRequired: false, migrationCandidateEmitted: false, acceptanceCase: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-15'},
    supportedMigration: {existingGraphOutputRemainsRequired: true, additionalMigrationOutputRequiredForExactInputSelector: true, acceptanceCase: ac16.id, originalPreserved: true, projectMutation: false, jobSubmission: false, externalEffect: false},
    unsupportedOrUnknownMigration: {acceptanceCase: ac17.id, result: 'UNKNOWN_OR_UNSUPPORTED_OR_REJECTED', migrationCandidate: 'NONE', originalPreserved: true, projectMutation: false, externalEffect: false},
    sourceOwnerExtension: {
      capabilityRef: CAPABILITY_ID,
      exactPxd207ScopeRef: '.product-experience/pdp-0-product-truth/applications-channels.yaml#coordinatorDefinitionExtensionApplicability/records/@capabilityRef=media.recipe.specification.compile',
      channel: 'media.channel.cli',
      ownerAdjudicationRecordId: OWNER_ADJUDICATION_ID,
      trustRecordId: TRUST_RECORD_ID,
      priorOwnerRows: 462,
      priorTrustRows: 462,
      currentProposedRows: 463,
      sourceSelectorRule: 'PXD-128 requires resultKind plus applicable provenance and epistemic fields in the exact result-variant selector; ordinary broad output is separately trust-bound.',
    },
    exactTargets: Object.entries(postimages).map(([targetRef, bytes]) => ({targetRef, preimageSha256: sha(targetRef === CAP_PATH ? inputs.capabilitiesBytes : targetRef === REQ_PATH ? inputs.requirementsBytes : targetRef === CROSSWALK_PATH ? inputs.crosswalkBytes : inputs.capabilityLeafReviewBytes), postimageSha256: sha(bytes)})),
    postimageSha256,
    historicalBoundary: {historic462OwnerRows: 'PRESERVED_BYTE_FOR_BYTE_AND_IN_ORDER', historic462TrustRows: 'PRESERVED_BYTE_FOR_BYTE_AND_IN_ORDER', newExtension: 'ADDITIVE_ROW_463; not represented as one of the historic 462'},
    authorityBoundary: {rootTechnicalSourceOwnerDecision: 'PENDING', distinctTechnicalPeerReview: 'PENDING', independentAcceptance: 'NOT_CLAIMED', nativeProof: 'NOT_CLAIMED', trustedIssuerOrCredentialRegistration: 'NOT_REQUESTED', runtimeAdmission: 'NOT_ADMITTED', canonicalApply: 'NOT_PERFORMED'},
  };
  const sourceAmendmentBytes = Buffer.from(`${JSON.stringify(sourceAmendment, null, 2)}\n`);
  const components = {...postimageSha256, sourceAmendmentJson: sha(sourceAmendmentBytes)};
  const candidatePostimageSha256 = sha(Buffer.from(JSON.stringify(components)));
  const rootDecisionTemplateRef = `${FOLDER}/AUD-SPEC-002-source-amendment-root-decision.v4.json`;
  const candidate = {
    schemaVersion: 'media.pdp0.aud-spec-002-source-amendment-candidate.v4',
    artifactKind: 'NON_CANONICAL_EXACT_SOURCE_AMENDMENT_CANDIDATE', auditId: 'AUD-SPEC-002',
    predecessorCandidateRef: `${FOLDER}/AUD-SPEC-002-source-amendment-candidate.v3.json`, predecessorCandidateSha256: 'f7ed4fbf6ca136eab71e58abfab8e30413c1ccb44b13c049a26e6674c464e280',
    sourceBindings: sourceAmendment.sourceBindings, postimageSha256, candidatePostimageSha256,
    conditionalOutputRule: 'ordinary compile requires only the existing graph/plan; migration candidate is additionally required only for the exact supported migration input selector; incomplete or unsupported migration inputs produce no candidate',
    resultVariantSelector: MIGRATION_VARIANT_SELECTOR,
    extensionRegistration: {capabilityRef: CAPABILITY_ID, ownerAdjudicationId: OWNER_ADJUDICATION_ID, trustRecordId: TRUST_RECORD_ID, historicalOwnerRowsPreserved: 462, historicalTrustRowsPreserved: 462, currentTotalAfterProposal: 463},
    exactFileTargets: sourceAmendment.exactTargets,
    rootDecisionTemplateRef,
    blockers: ['DISTINCT_TECHNICAL_PEER_REVIEW_OF_THE_EXACT_V4_FOUR_SOURCE_POSTIMAGE_REQUIRED','ROOT_TECHNICAL_SOURCE_OWNER_DECISION_AND_DECISION_LOG_ENTRY_REQUIRED_BEFORE_CANONICAL_APPLY'],
    canonicalApply: 'NOT_PERFORMED', effects: {canonicalSourceWrite: 'NOT_PERFORMED', historical462Population: 'PRESERVED_SEPARATELY', independentAcceptance: 'NOT_CLAIMED', runtimeAdmission: 'NOT_ADMITTED', nativeProof: 'NOT_CLAIMED'},
  };
  return {candidate, sourceAmendment, sourceAmendmentBytes, postimages, postimageSha256, components, schema: makeCandidateSchema(), sourceAmendmentSchema: makeSourceAmendmentSchema(), proposedAdjudication, proposedTrust, v3, pxd207};
}

