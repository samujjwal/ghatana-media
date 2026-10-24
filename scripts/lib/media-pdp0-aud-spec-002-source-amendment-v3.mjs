import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildAudSpec002RebindCandidate} from './media-pdp0-aud-spec-002-rebind-candidate.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);
const yaml = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../ghatana-tools/package.json'))('yaml');
const OLD_FROZEN_V2 = Object.freeze({
  candidateSha256: 'ab9c5455c50df60c33066b0253f996f67885f78429047a6afa995e845b65d867',
  sourceAmendmentPostimageSha256: '7aa677ad4907818d0ca2ea140ab285de39298ba116de9704ce51f91e1781b2f0',
  crosswalkPostimageSha256: 'cbdf13712ea57f11b1efa98c9932141a89e7f26cdc4a121ec124e464ddd2cc35',
  candidatePostimageSha256: '19a51122a52b27f10e0b2f429d73b028ea8cc4e6636745dc4a132a1abf01ed81',
});
const PATHS = Object.freeze({
  capability: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  requirement: '.product-experience/pdp-0-product-truth/requirements.yaml',
  crosswalk: 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
  trust: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
});
const MIGRATION_OUTPUT = 'reviewable-version-bound-schema-migration-candidate-and-semantic-diff';
const MIGRATION_SELECTOR = 'migrationIntent=SCHEMA_MIGRATION;sourceSpecification=EXACT_VERSIONED;sourceSchema=EXACT_VERSIONED;targetSchema=EXACT_VERSIONED;transformation=EXACT_DECLARED;transformationSupport=SUPPORTED';

function ensure(condition, message) { if (!condition) throw new Error(message); }
function findUnique(rows, key, value, label) {
  const found = rows.filter(row => row?.[key] === value);
  ensure(found.length === 1, `expected exactly one ${label} ${value}`);
  return found[0];
}
function replaceYamlListRecord(sourceText, id, proposedRecord, indent) {
  const lines = sourceText.split(/(?<=\n)/u);
  const offsets = [];
  let cursor = 0;
  const prefix = `${indent}- id: `;
  for (const line of lines) { offsets.push(cursor); cursor += line.length; }
  const starts = offsets.filter((offset, index) => lines[index].startsWith(prefix) && lines[index].slice(prefix.length).trim() === id);
  ensure(starts.length === 1, `expected one exact YAML record ${id}`);
  const start = starts[0];
  const startIndex = offsets.indexOf(start);
  let endIndex = lines.findIndex((line, index) => index > startIndex && line.startsWith(prefix));
  if (endIndex < 0) endIndex = lines.length;
  const end = offsets[endIndex] ?? sourceText.length;
  const serialized = yaml.stringify(proposedRecord, {lineWidth: 0}).trimEnd().split('\n');
  const replacement = `${indent}- ${serialized[0]}\n${serialized.slice(1).map(line => `${indent}  ${line}`).join('\n')}\n`;
  return Buffer.from(`${sourceText.slice(0, start)}${replacement}${sourceText.slice(end)}`);
}

export function buildAudSpec002SourceAmendmentV3({crosswalkBytes, auditBytes, capabilitiesBytes, requirementsBytes, capabilityLeafReviewBytes, observedV2CandidateBytes, observedV2SourceAmendmentBytes, observedV2CrosswalkBytes}) {
  const v2 = buildAudSpec002RebindCandidate({crosswalkBytes, auditBytes, capabilitiesBytes, requirementsBytes});
  const capability = structuredClone(v2.candidate.sourceAmendment.capability);
  const requirement = structuredClone(v2.candidate.sourceAmendment.requirement);
  const crosswalk = JSON.parse(v2.postimageBytes.toString('utf8'));
  const capabilityFile = yaml.parse(capabilitiesBytes.toString('utf8'));
  const requirementFile = yaml.parse(requirementsBytes.toString('utf8'));
  const trustFile = yaml.parse(capabilityLeafReviewBytes.toString('utf8'));
  const sourceAudit = JSON.parse(auditBytes.toString('utf8'));
  const sourceRow = findUnique(sourceAudit.originalAudit.inventory, 'audit_id', 'AUD-SPEC-002', 'source audit row');

  const migrationOut = findUnique(capability.ownerDefinition.successOutputs, 'artifactType', MIGRATION_OUTPUT, 'migration success output');
  migrationOut.requiredOnSuccess = false;
  migrationOut.requiredWhenSelector = MIGRATION_SELECTOR;
  migrationOut.resultVariants = [{
    resultKind: 'SUPPORTED_VERSION_BOUND_SCHEMA_MIGRATION_CANDIDATE_AND_SEMANTIC_DIFF',
    disposition: 'NO_MIGRATION_APPLIED',
    selector: MIGRATION_SELECTOR,
    meaning: 'Selected only for a complete exact versioned source specification/schema, requested target schema, and explicitly declared supported transformation. The candidate and semantic diff bind all exact identities and versions; the original remains unchanged.',
  }];
  const variantConstraint = `The ${MIGRATION_OUTPUT} result is required only when ${MIGRATION_SELECTOR}; it is absent for ordinary compilation without migration inputs and for AC-14 UNKNOWN/UNSUPPORTED outcomes.`;
  if (!capability.constraints.includes(variantConstraint)) capability.constraints.push(variantConstraint);
  capability.ownerDefinition.semanticOutcomeContract.outputDistinctions = [...new Set([
    ...capability.ownerDefinition.semanticOutcomeContract.outputDistinctions,
    variantConstraint,
  ])];
  capability.ownerDefinition.semanticOutcomeContract.sourceRefs = [...new Set([
    ...capability.ownerDefinition.semanticOutcomeContract.sourceRefs,
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-15',
  ])];
  const ordinaryCase = {
    id: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-15',
    given: 'An authorized creator supplies an exact supported production specification and schema with no schema-migration target or transformation input.',
    when: 'Media performs ordinary specification compilation under the named compiler-contract version.',
    then: 'Return the existing normalized semantic graph and reviewable project-plan candidate; do not require or emit a migration candidate or semantic diff.',
    rejection: 'Do not infer migration intent from absent or partial migration inputs, change ordinary compilation output, apply a migration, or cause a project, job, publication, or external effect.',
  };
  ensure(!requirement.acceptanceCases.some(row => row.id === ordinaryCase.id), 'AC-15 already exists; candidate needs a new source cut');
  requirement.acceptanceCases.push(ordinaryCase);
  const sourceAmendment = {
    schemaVersion: 'media.pdp0.aud-spec-002-source-amendment-postimage.v3',
    predecessorFrozenV2: {...OLD_FROZEN_V2, bytesRecovered: false, reviewRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-independent-peer.v2.json'},
    supersedesObservedButUnapprovedV2Bytes: {
      candidateSha256: sha(observedV2CandidateBytes),
      sourceAmendmentPostimageSha256: sha(observedV2SourceAmendmentBytes),
      crosswalkPostimageSha256: sha(observedV2CrosswalkBytes),
      classification: 'LOCAL_REGENERATION_OBSERVATION_ONLY_NOT_FROZEN_PREDECESSOR',
    },
    sourceBindings: {
      crosswalkSha256: sha(crosswalkBytes), auditSha256: sha(auditBytes), capabilitiesSha256: sha(capabilitiesBytes),
      requirementsSha256: sha(requirementsBytes), capabilityLeafReviewSha256: sha(capabilityLeafReviewBytes),
    },
    capability,
    requirement,
    proposedCrosswalkRow: findUnique(crosswalk.rows, 'auditId', 'AUD-SPEC-002', 'proposed crosswalk row'),
    exactTargets: [
      {targetRef: PATHS.capability, preimageSha256: sha(capabilitiesBytes), recordId: capability.id},
      {targetRef: PATHS.requirement, preimageSha256: sha(requirementsBytes), recordId: requirement.id},
      {targetRef: PATHS.crosswalk, preimageSha256: sha(crosswalkBytes), recordId: 'AUD-SPEC-002'},
    ],
    matchingOwnerTrustBranch: {
      status: 'UNRESOLVED_OWNER_CAPABILITY_ADJUDICATION_REQUIRED',
      outputArtifactType: MIGRATION_OUTPUT,
      selector: MIGRATION_SELECTOR,
      capabilityRef: capability.id,
      exactOwnerCapabilityAdjudicationSelector: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@capabilityRef=media.recipe.specification.compile',
      observedOwnerCapabilityAdjudicationRecordCount: trustFile.ownerCapabilityLeafAdjudication.records.filter(row => row.capabilityRef === capability.id).length,
      currentTrustReconstructionRecordCount: trustFile.ownerTrustReconstructionDispositions.records.filter(row => row.capabilityRef === capability.id).length,
      noRecordInvented: true,
    },
    predecessorSemanticFinding: 'AUD-SPEC-002-MIGRATION-OUTPUT-CONDITIONALITY-001',
    ordinaryCompileContract: {existingOutputArtifactType: 'normalized-semantic-graph-and-reviewable-project-plan-candidate', migrationCandidateRequired: false, migrationCandidateEmitted: false},
    supportedMigrationContract: {selector: MIGRATION_SELECTOR, migrationCandidateRequiredWhenSelected: true, originalPreserved: true, application: 'NOT_PERFORMED'},
    unsupportedOrUnknownContract: {ac: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-14', outcome: 'UNKNOWN_OR_UNSUPPORTED', migrationCandidate: 'NONE', sourceMutation: 'NONE'},
    authorityBoundary: {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED', canonicalApply: 'NOT_PERFORMED'},
  };

  const capabilityPostimage = replaceYamlListRecord(capabilitiesBytes.toString('utf8'), capability.id, capability, '  ');
  const requirementPostimage = replaceYamlListRecord(requirementsBytes.toString('utf8'), requirement.id, requirement, '');
  const proposedRow = findUnique(crosswalk.rows, 'auditId', 'AUD-SPEC-002', 'crosswalk row');
  proposedRow.pdp0EvidenceRefs = [...new Set([...proposedRow.pdp0EvidenceRefs,
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-15'])];
  proposedRow.phaseLocalRationale += ' AC-15 preserves ordinary compilation output when no migration is requested; the migration result is conditionally required only for the exact supported selector. Matching trust reconstruction remains unresolved because no exact owner capability adjudication record exists; no owner mapping is invented.';
  const crosswalkPostimage = Buffer.from(`${JSON.stringify(crosswalk, null, 2)}\n`);
  const sourceAmendmentBytes = Buffer.from(`${JSON.stringify(sourceAmendment, null, 2)}\n`);
  const postimages = {
    [PATHS.capability]: capabilityPostimage,
    [PATHS.requirement]: requirementPostimage,
    [PATHS.crosswalk]: crosswalkPostimage,
  };
  const componentPostimageSha256 = {
    capabilityYaml: sha(capabilityPostimage),
    requirementsYaml: sha(requirementPostimage),
    crosswalkJson: sha(crosswalkPostimage),
    sourceAmendmentJson: sha(sourceAmendmentBytes),
  };
  const candidatePostimageSha256 = sha(Buffer.from(canonical(componentPostimageSha256)));
  const sourceBindings = sourceAmendment.sourceBindings;
  const candidate = {
    schemaVersion: 'media.pdp0.aud-spec-002-source-amendment-candidate.v3',
    artifactKind: 'NON_CANONICAL_EXACT_SOURCE_AMENDMENT_CANDIDATE',
    auditId: 'AUD-SPEC-002',
    previousReviewedCandidateRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-candidate.v2.json',
    previousReviewedCandidateSha256: OLD_FROZEN_V2.candidateSha256,
    previousReviewedPostimageSha256: OLD_FROZEN_V2.candidatePostimageSha256,
    sourceBindings,
    componentPostimageSha256,
    candidatePostimageSha256,
    conditionalOutputCorrection: 'SUPPORTED_MIGRATION_ONLY; ordinary compilation retains its existing required graph/project-plan output; AC-14 emits no migration candidate.',
    unresolvedOwnerTrustBranch: sourceAmendment.matchingOwnerTrustBranch,
    exactSourceAmendmentRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-postimage.v3.json',
    exactTargetPostimages: Object.fromEntries(Object.entries(componentPostimageSha256).filter(([key]) => key !== 'sourceAmendmentJson')),
    exactFileTargets: sourceAmendment.exactTargets,
    blockers: [
      'EXACT_ROOT_TECHNICAL_SOURCE_OWNER_DECISION_REQUIRED',
      'DISTINCT_TECHNICAL_PEER_REVIEW_OF_EXACT_V3_POSTIMAGE_REQUIRED',
      'MATCHING_OWNER_TRUST_BRANCH_REQUIRES_EXISTING_OWNER_CAPABILITY_ADJUDICATION',
      'OLD_FROZEN_V2_ARTIFACT_BYTES_NOT_RECOVERED; V2_REVIEW_HASHES_PRESERVED_AS_REFERENCES_ONLY',
    ],
    canonicalApply: 'NOT_PERFORMED',
    effects: {canonicalSourceWrite: 'NOT_PERFORMED', sourceStatus: 'UNCHANGED', applicability: 'UNCHANGED', independentAcceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_CLAIMED', runtimeAdmission: 'NOT_ADMITTED'},
  };
  return {candidate, sourceAmendment, sourceAmendmentBytes, capabilityPostimage, requirementPostimage, crosswalkPostimage, postimages};
}
