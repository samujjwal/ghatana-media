import {createHash} from 'node:crypto';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

export const AUD_SPEC_002_ROW_ID = 'AUD-SPEC-002';
export const AUD_SPEC_002_TARGET_CAPABILITY = 'media.recipe.specification.compile';
export const AUD_SPEC_002_TARGET_REQUIREMENT = 'MEDIA-REQ-CAP-RECIPE-TEMPLATE';
export const AUD_SPEC_002_TARGET_CASE = 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-07';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const yaml = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../ghatana-tools/package.json'))('yaml');
const parseYaml = yaml.parse;
const EVIDENCE = [
  '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.recipe.specification.compile',
  '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-07',
  '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-13',
  '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-14',
];
const RATIONALE = 'The existing recipe specification compiler and AC-07 cover typed semantic compilation. The additive AC-13/AC-14 proposal defines only a reviewable, version-bound migration candidate and semantic diff for an explicitly declared transformation between exact source and target schemas. Unsupported, lossy, ambiguous, or otherwise unknown transformations remain UNKNOWN/UNSUPPORTED; the source is preserved and no migration is applied, project/job is created, or content is published. The proposed candidate meaning is not yet canonical or owner-approved; PDP-1 retains migration implementation mechanics.';
const MIGRATION_OUTCOME = 'For a schema-migration request, prepare a reviewable, version-bound migration candidate and semantic diff only when the exact source production specification and schema, requested target schema, and explicitly declared supported transformation are supplied. Bind the candidate to every source, target, and transformation identity/version. Preserve the original specification. If the transformation is unsupported, lossy, ambiguous, or unknown, return an explicit UNKNOWN/UNSUPPORTED result and no migration candidate; never infer or silently substitute a transformation. Repeating the same exact inputs and transformation version yields an equivalent candidate and stable semantic fingerprint. Candidate preparation does not apply the migration, mutate a project, submit a job, publish content, or cause an external effect.';
const MIGRATION_POSITIVE = {
  id: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-13',
  given: 'An authorized creator supplies an exact versioned production specification and source schema, an exact requested target schema, and an explicitly declared supported versioned transformation as a complete migration input set.',
  when: 'Media prepares a schema-migration candidate under the named compiler-contract and transformation versions.',
  then: 'Return a reviewable candidate and semantic diff bound to the exact source specification, source schema, target schema, and transformation identities and versions; preserve the original source; repeating the same exact inputs and versions yields an equivalent candidate and stable semantic fingerprint.',
  rejection: 'Reject or return UNKNOWN/UNSUPPORTED for missing, stale, or ambiguous source/target versions; do not apply a migration or create a project, job, publication, or external effect.',
};
const MIGRATION_NEGATIVE = {
  id: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-14',
  given: 'A requested schema transformation is unsupported, lossy, ambiguous, absent from the declared supported transformations, or has unknown compatibility.',
  when: 'Media is asked to prepare a migration candidate.',
  then: 'Return an explicit UNKNOWN/UNSUPPORTED outcome with the unresolved transformation or compatibility fact; preserve the source and return no migration candidate.',
  rejection: 'Reject inferring a conversion, silently substituting a transformation, mutating the source/project, submitting a job, publishing content, or claiming a completed migration.',
};

function addUnique(values, additions) { return [...values, ...additions.filter(value => !values.includes(value))]; }
function migrationCapabilityPostimage(capability) {
  const result = structuredClone(capability);
  result.outcome = `${capability.outcome} ${MIGRATION_OUTCOME}`;
  result.inputArtifactTypes = addUnique(result.inputArtifactTypes, ['versioned-target-production-specification-schema', 'versioned-schema-migration-transformation']);
  result.outputArtifactTypes = addUnique(result.outputArtifactTypes, ['reviewable-version-bound-schema-migration-candidate-and-semantic-diff']);
  result.preconditions = addUnique(result.preconditions, [
    'For schema migration, the exact source specification and source schema, requested target schema, and declared transformation identity/version are all readable and current.',
    'A migration request supplies both the target schema and transformation together; a partial pair is UNKNOWN and cannot produce a migration candidate.',
    'The transformation is explicitly supported; unsupported, lossy, ambiguous, or unknown compatibility remains UNKNOWN/UNSUPPORTED.',
  ]);
  result.constraints = addUnique(result.constraints, [
    'A migration candidate binds exact source specification/schema, target schema, transformation identity/version, and compiler-contract version; changed inputs or versions produce a distinct candidate.',
    'Candidate preparation preserves the original source and returns a semantic diff; it never applies a migration, mutates a project, submits a job, publishes content, or causes an external effect.',
    'Unsupported, lossy, ambiguous, or unknown transformations produce UNKNOWN/UNSUPPORTED and no migration candidate; no conversion or fallback is inferred.',
    'The target schema and declared transformation are a required pair for migration intent; either one without the other is unresolved and produces no candidate.',
    'The same exact migration inputs and transformation/compiler versions produce an equivalent candidate and stable semantic fingerprint; no availability or execution is promised.',
  ]);
  result.explicitUnsupportedCases = addUnique(result.explicitUnsupportedCases, [
    'No migration is applied or source/project state changed by candidate preparation.',
    'Unsupported, lossy, ambiguous, or unknown schema transformations are UNKNOWN/UNSUPPORTED; no conversion is inferred or substituted.',
  ]);
  const slots = result.ownerDefinition.typedInputSlots;
  result.ownerDefinition.typedInputSlots = addUnique(slots.map(slot => JSON.stringify(slot)), [
    JSON.stringify({slotId: 'input5', sourceType: 'versioned-target-production-specification-schema', cardinality: 'ZERO_OR_ONE', required: false}),
    JSON.stringify({slotId: 'input6', sourceType: 'versioned-schema-migration-transformation', cardinality: 'ZERO_OR_ONE', required: false}),
  ]).map(value => JSON.parse(value));
  result.ownerDefinition.successOutputs = addUnique(result.ownerDefinition.successOutputs.map(output => JSON.stringify(output)), [
    JSON.stringify({artifactType: 'reviewable-version-bound-schema-migration-candidate-and-semantic-diff', requiredOnSuccess: true}),
  ]).map(value => JSON.parse(value));
  result.ownerDefinition.semanticOutcomeContract.result = result.outcome;
  result.ownerDefinition.semanticOutcomeContract.outputDistinctions = addUnique(result.ownerDefinition.semanticOutcomeContract.outputDistinctions, result.constraints.slice(-4));
  result.ownerDefinition.semanticOutcomeContract.unknownDisposition = `${result.ownerDefinition.semanticOutcomeContract.unknownDisposition} For schema migration, unsupported, lossy, ambiguous, or unknown transformations remain explicitly UNKNOWN/UNSUPPORTED with no candidate or effect.`;
  result.ownerDefinition.semanticOutcomeContract.sourceRefs = addUnique(result.ownerDefinition.semanticOutcomeContract.sourceRefs, [
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-13',
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-14',
  ]);
  result.ownerDefinition.effect.semanticOutcome = result.outcome;
  result.idempotency = `${result.idempotency} Schema-migration candidates bind source, target, transformation, and compiler versions; identical exact inputs and versions yield an equivalent candidate and stable semantic fingerprint.`;
  return result;
}

function migrationRequirementPostimage(requirement) {
  const result = structuredClone(requirement);
  result.acceptanceCases = [...result.acceptanceCases, MIGRATION_POSITIVE, MIGRATION_NEGATIVE];
  return result;
}

function requireValue(ok, message) { if (!ok) throw new Error(message); }
function mustFind(array, id, key, label) {
  const matches = array.filter(item => item?.[key] === id);
  requireValue(matches.length === 1, `expected exactly one ${label} ${id}`);
  return matches[0];
}

function replaceYamlListRecord(sourceText, id, proposedRecord, label, indent = '  ') {
  const lines = sourceText.split(/(?<=\n)/u);
  const starts = [];
  const offsets = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    const prefix = `${indent}- id: `;
    if (line.startsWith(prefix) && line.slice(prefix.length).trim() === id) starts.push(cursor);
    cursor += line.length;
  }
  requireValue(starts.length === 1, `expected one exact YAML ${label} record ${id}`);
  const start = starts[0];
  const next = lines.findIndex((line, index) => offsets[index] > start && line.startsWith(`${indent}- id: `));
  const end = next < 0 ? sourceText.length : offsets[next];
  const prior = sourceText.slice(0, start);
  const following = sourceText.slice(end);
  const serialized = yaml.stringify(proposedRecord, {lineWidth: 0}).trimEnd().split('\n');
  const replacement = `${indent}- ${serialized[0]}\n${serialized.slice(1).map(line => `${indent}  ${line}`).join('\n')}\n`;
  return {bytes: Buffer.from(`${prior}${replacement}${following}`), prior, following};
}

export function buildAudSpec002RebindCandidate({crosswalkBytes, auditBytes, capabilitiesBytes, requirementsBytes}) {
  const crosswalk = JSON.parse(crosswalkBytes.toString('utf8'));
  const audit = JSON.parse(auditBytes.toString('utf8'));
  const capabilities = parseYaml(capabilitiesBytes.toString('utf8'));
  const requirements = parseYaml(requirementsBytes.toString('utf8'));
  const row = mustFind(crosswalk.rows, AUD_SPEC_002_ROW_ID, 'auditId', 'crosswalk row');
  const original = mustFind(audit.originalAudit.inventory, AUD_SPEC_002_ROW_ID, 'audit_id', 'source audit row');
  requireValue(original.capability === 'Production-specific schema validation and migrations'
    && original.acceptance_family === 'Compiling the same specification twice produces equivalent normalized semantic graphs and stable fingerprints; invalid or unauthorized inputs create no effects.',
  'AUD-SPEC-002 source meaning changed from the reviewed exact source text');
  requireValue(row.sourcePartition === 'originalAudit' && row.sourceText === original.capability
    && row.sourceAcceptanceText === original.acceptance_family && row.ownerSurfaceProposal === 'media.surface.recorder-orchestrator',
  'AUD-SPEC-002 crosswalk row does not bind the exact original source and owner proposal');
  requireValue(row.disposition === 'BOUND_EXISTING' && row.pdp0EvidenceRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.profile.validate'),
    'AUD-SPEC-002 is not the expected profile-validation misbinding predecessor');
  const capability = mustFind(capabilities.capabilities, AUD_SPEC_002_TARGET_CAPABILITY, 'id', 'PDP-0 capability');
  const requirement = mustFind(requirements.requirements, AUD_SPEC_002_TARGET_REQUIREMENT, 'id', 'PDP-0 requirement');
  const acceptance = mustFind(requirement.acceptanceCases, AUD_SPEC_002_TARGET_CASE, 'id', 'PDP-0 acceptance case');
  requireValue(!requirement.acceptanceCases.some(item => item.id === MIGRATION_POSITIVE.id || item.id === MIGRATION_NEGATIVE.id),
    'proposed migration acceptance IDs already exist; candidate must be revised against current source');
  requireValue(capability.operation === 'specification.compile' && capability.sourceScope?.sourcePhrase?.includes('typed semantic compilation')
    && capability.scopeStatus === 'DEFERRED', 'target compiler is not the existing deferred typed-compilation definition');
  requireValue(acceptance.given.includes('exact versioned YAML or JSON production specification')
    && acceptance.when.includes('named compiler-contract version')
    && acceptance.then.includes('stable semantic fingerprint')
    && acceptance.rejection.includes('without project, asset, job, or external effects'),
  'existing AC-07 no longer covers the exact typed compilation and negative boundary');
  requireValue(row.laterPhaseHandoffs?.ownerPhase === 'PDP-1'
    && row.laterPhaseHandoffs.gap === 'production-schema-migration-semantics-unbound',
  'AUD-SPEC-002 PDP-1 migration handoff changed unexpectedly');

  const proposedCapability = migrationCapabilityPostimage(capability);
  const proposedRequirement = migrationRequirementPostimage(requirement);
  const capabilityFilePostimage = replaceYamlListRecord(capabilitiesBytes.toString('utf8'), AUD_SPEC_002_TARGET_CAPABILITY, proposedCapability, 'capability');
  const requirementFilePostimage = replaceYamlListRecord(requirementsBytes.toString('utf8'), AUD_SPEC_002_TARGET_REQUIREMENT, proposedRequirement, 'requirement', '');
  const reparsedCapability = mustFind(parseYaml(capabilityFilePostimage.bytes.toString('utf8')).capabilities, AUD_SPEC_002_TARGET_CAPABILITY, 'id', 'postimage PDP-0 capability');
  const reparsedRequirement = mustFind(parseYaml(requirementFilePostimage.bytes.toString('utf8')).requirements, AUD_SPEC_002_TARGET_REQUIREMENT, 'id', 'postimage PDP-0 requirement');
  requireValue(JSON.stringify(reparsedCapability) === JSON.stringify(proposedCapability)
    && JSON.stringify(reparsedRequirement) === JSON.stringify(proposedRequirement),
  'serialized exact-source PDP-0 postimages do not round-trip to their proposed records');
  const predecessorRow = structuredClone(row);
  const proposedRow = structuredClone(row);
  proposedRow.pdp0EvidenceRefs = [...EVIDENCE];
  proposedRow.phaseLocalRationale = RATIONALE;
  proposedRow.disposition = 'BOUND_EXISTING';
  proposedRow.proposedPdp0SourceChange = null;
  proposedRow.laterPhaseHandoffs.gap = 'production-schema-migration-mechanics-unbound';
  proposedRow.laterPhaseHandoffs.status = 'PDP1_MECHANICS_HANDOFF_AFTER_PDP0_PRODUCT_INTENT';
  requireValue(proposedRow.ownerApproval === 'NOT_CLAIMED'
    && proposedRow.definitionScopeBinding?.ownerApproval === 'NOT_CLAIMED'
    && proposedRow.definitionScopeBinding?.runtimeAdmission === 'NOT_CLAIMED',
  'candidate cannot claim owner approval or runtime admission');
  const postimage = structuredClone(crosswalk);
  postimage.rows[postimage.rows.findIndex(item => item.auditId === AUD_SPEC_002_ROW_ID)] = proposedRow;
  const postimageBytes = Buffer.from(`${JSON.stringify(postimage, null, 2)}\n`);
  const sourceAmendment = {
    schemaVersion: 'media.pdp0.aud-spec-002-source-amendment-postimage.v2',
    baselineRecordSha256: {
      capability: sha(Buffer.from(JSON.stringify(capability))),
      requirement: sha(Buffer.from(JSON.stringify(requirement))),
    },
    baselineRecords: {capability, requirement},
    exactTargetFilePostimageSha256: {
      capabilitiesYaml: sha(capabilityFilePostimage.bytes),
      requirementsYaml: sha(requirementFilePostimage.bytes),
    },
    targetRefs: {
      capability: '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.recipe.specification.compile',
      requirement: '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE',
    },
    capability: proposedCapability,
    requirement: proposedRequirement,
    acceptanceCases: [MIGRATION_POSITIVE, MIGRATION_NEGATIVE],
    affectedScope: {
      leaf: AUD_SPEC_002_TARGET_CAPABILITY,
      logicalOwner: 'media.surface.recorder-orchestrator',
      directlySelectedPhysicalSource: 'media.physical.libs-audio-video-client',
      declaredCompositions: ['media.composition.repository-root', 'media.composition.creation-composition-and-delivery', 'media.composition.client-and-machine-interfaces'],
      channel: 'media.channel.cli',
      sourceRefs: [
        '.product-experience/pdp-0-product-truth/applications-channels.yaml#logicalConsumerPdp0Scope/records/@capabilityRef=media.recipe.specification.compile',
        '.product-experience/pdp-0-product-truth/applications-channels.yaml#records/@capabilityRef=media.recipe.specification.compile/decision/includedSurfaceRefs',
        '.product-experience/surface-registry.yaml#surfaces/@surfaceId=media.surface.recorder-orchestrator',
      ],
      downstreamFeedback: [
        {phase: 'PDP-1', sourceRef: '.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml', action: 'Define typed source/target schema, transformation, migration-candidate and semantic-diff data contracts; do not infer execution.'},
        {phase: 'PDP-2', sourceRef: '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml', action: 'Review CLI-only interaction for exact migration inputs, reviewable diff, and UNKNOWN/UNSUPPORTED result presentation.'},
        {phase: 'PDP-3', sourceRef: '.product-experience/pdp-3-product-experience/recorder-studio-experience.yaml', action: 'Review complete CLI user journey for candidate inspection, source preservation, and blocked unsupported transformations.'},
      ],
      noStatusOrApplicabilityMutation: true,
    },
  };
  const sourceAmendmentBytes = Buffer.from(`${JSON.stringify(sourceAmendment, null, 2)}\n`);
  const combinedPostimageBytes = Buffer.from(JSON.stringify({
    crosswalkPostimageSha256: sha(postimageBytes),
    capabilitiesYamlPostimageSha256: sha(capabilityFilePostimage.bytes),
    requirementsYamlPostimageSha256: sha(requirementFilePostimage.bytes),
    sourceAmendmentRecordPostimageSha256: sha(sourceAmendmentBytes),
  }));
  const sourcePins = {
    crosswalkSha256: sha(crosswalkBytes),
    auditSha256: sha(auditBytes),
    capabilitiesSha256: sha(capabilitiesBytes),
    requirementsSha256: sha(requirementsBytes),
  };
  const candidate = {
    schemaVersion: 'media.pdp0.aud-spec-002-source-amendment-candidate.v2',
    auditId: AUD_SPEC_002_ROW_ID,
    status: 'CANDIDATE_PENDING_SOURCE_OWNER_AND_DISTINCT_PEER_REVIEW',
    sourceBindings: sourcePins,
    exactTarget: {capabilityId: AUD_SPEC_002_TARGET_CAPABILITY, requirementId: AUD_SPEC_002_TARGET_REQUIREMENT, acceptanceCaseId: AUD_SPEC_002_TARGET_CASE},
    coverageAssessment: {status: 'PROPOSED_SOURCE_POSTIMAGE_COVERS_COMPILATION_AND_BOUNDED_MIGRATION_CANDIDATE_MEANING', coveredSubmeaning: 'Existing typed compilation from exact specification/schema/compiler inputs.', addedMeaning: 'Reviewable version-bound migration candidate and semantic diff; no source mutation, execution, project/job/publication effect.'},
    predecessorRowSha256: sha(Buffer.from(JSON.stringify(predecessorRow))),
    proposedRowSha256: sha(Buffer.from(JSON.stringify(proposedRow))),
    proposedCapabilitySha256: sha(Buffer.from(JSON.stringify(proposedCapability))),
    proposedRequirementSha256: sha(Buffer.from(JSON.stringify(proposedRequirement))),
    candidatePostimageSha256: sha(combinedPostimageBytes),
    crosswalkPostimageSha256: sha(postimageBytes),
    sourceAmendmentPostimageSha256: sha(sourceAmendmentBytes),
    exactTargetFilePostimageSha256: sourceAmendment.exactTargetFilePostimageSha256,
    proposedRow,
    sourceAmendment,
    preservedBoundaries: {ownerApproval: 'NOT_CLAIMED', runtimeAdmission: 'NOT_CLAIMED', implementation: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', delivery: 'NOT_CLAIMED', migrationMechanics: 'PDP-1_HANDOFF_UNCHANGED'},
    requiredReviewEvidence: {sourceOwnerDecision: 'REQUIRED; must bind candidate file hash, all three source preimage hashes, and all three exact postimage hashes.', distinctTechnicalPeer: 'REQUIRED; reviewer must differ from source owner and bind the same candidate and postimage hashes.'},
    blockers: ['EXACT_ROOT_TECHNICAL_SOURCE_OWNER_DECISION_REQUIRED', 'DISTINCT_TECHNICAL_PEER_REVIEW_OF_EXACT_POSTIMAGE_REQUIRED'],
    canonicalApply: 'NOT_PERFORMED',
  };
  return {
    candidate, postimageBytes, sourceAmendmentBytes, combinedPostimageBytes,
    capabilitiesPostimageBytes: capabilityFilePostimage.bytes,
    requirementsPostimageBytes: requirementFilePostimage.bytes,
    predecessorBytes: crosswalkBytes,
  };
}
