import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { validateMediaCaptionVersionDefinitions } from '../scripts/lib/media-caption-version-definition-validation.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const yaml = (path) => parse(readFileSync(resolve(root, path), 'utf8'));
const operations = yaml('.product-experience/pdp-1-domain-data/operations.yaml');
const domainObjects = yaml('.product-experience/pdp-1-domain-data/domain-objects.yaml');
const actionContracts = yaml('.product-experience/pdp-1-domain-data/action-contracts.yaml');
const base = { operations, domainObjects, actionContracts };
const operation = (id) => operations.operations.find((item) => item.id === id);

test('caption version registration definition', () => {
  const write = operation('media.operation.caption-version-write');
  assert.deepEqual(validateMediaCaptionVersionDefinitions(base), []);
  assert.deepEqual(write.actionRefs, ['media.action.save-caption-version']);
  assert.deepEqual(write.inputSemantics.requiredFields, [
    'sourceArtifactId', 'sourceArtifactVersionId', 'parentVersionKind', 'parentVersionId',
    'sourceClockId', 'ticksPerSecond', 'sourceDurationTicks', 'languageDisposition', 'captionSegments', 'requestId',
  ]);
  assert.deepEqual(write.outputSemantics.successFields, [
    'captionVersionId', 'registrationReceiptId', 'requestFingerprint', 'sourceArtifactId',
    'sourceArtifactVersionId', 'parentVersionKind', 'parentVersionId', 'languageDisposition', 'sourceClockId', 'registeredAt',
  ]);
  assert.equal(write.executionAdmission, undefined);
  assert.match(write.scopeStatus, /runtime-NOT_ADMITTED/u);

  const missingSourceVersion = structuredClone(base);
  missingSourceVersion.operations.operations.find(({ id }) => id === write.id).inputSemantics.requiredFields =
    write.inputSemantics.requiredFields.filter((field) => field !== 'sourceArtifactVersionId');
  assert.match(validateMediaCaptionVersionDefinitions(missingSourceVersion).join('\n'), /both source artifact and exact source version/u);

  const ambiguousDigest = structuredClone(base);
  ambiguousDigest.operations.operations.find(({ id }) => id === write.id).requestFingerprintDefinition.digestRepresentation = 'case-insensitive opaque text';
  assert.match(validateMediaCaptionVersionDefinitions(ambiguousDigest).join('\n'), /fingerprint must cover exact context/u);

  const parentOmittedFromFingerprint = structuredClone(base);
  parentOmittedFromFingerprint.operations.operations.find(({ id }) => id === write.id).requestFingerprintDefinition.tupleFields =
    write.requestFingerprintDefinition.tupleFields.filter((field) => field !== 'parentVersionId');
  assert.match(validateMediaCaptionVersionDefinitions(parentOmittedFromFingerprint).join('\n'), /fingerprint must cover exact context, typed parent/u);

  const optionalPayloadPresenceLost = structuredClone(base);
  optionalPayloadPresenceLost.operations.operations.find(({ id }) => id === write.id).requestFingerprintDefinition.segmentTupleFields =
    write.requestFingerprintDefinition.segmentTupleFields.filter((field) => field !== 'speakerLabelPresence');
  assert.match(validateMediaCaptionVersionDefinitions(optionalPayloadPresenceLost).join('\n'), /fingerprint must cover exact context, typed parent/u);

  const incompleteStringEncoding = structuredClone(base);
  incompleteStringEncoding.operations.operations.find(({ id }) => id === write.id).requestFingerprintDefinition.stringEncoding =
    'escape quote and backslash; ignore remaining controls and lone surrogates';
  assert.match(validateMediaCaptionVersionDefinitions(incompleteStringEncoding).join('\n'), /fingerprint must cover exact context, typed parent/u);

  const operationAcceptsLegacyParent = structuredClone(base);
  operationAcceptsLegacyParent.operations.operations.find(({ id }) => id === write.id).canonicalParentRequirement =
    'legacy-media.domain.transcription-UUID-is-an-authoritative-canonical-transcript-version-identity';
  assert.match(validateMediaCaptionVersionDefinitions(operationAcceptsLegacyParent).join('\n'), /reject legacy or synthetic IDs/u);

  const approvalPromoted = structuredClone(base);
  approvalPromoted.operations.operations.find(({ id }) => id === write.id).outputSemantics.review = 'APPROVED';
  assert.match(validateMediaCaptionVersionDefinitions(approvalPromoted).join('\n'), /result must not promote registration into approval/u);

  const admissionForged = structuredClone(base);
  admissionForged.operations.operations.find(({ id }) => id === write.id).scopeStatus = 'accepted; runtime-QUALIFIED';
  assert.match(validateMediaCaptionVersionDefinitions(admissionForged).join('\n'), /must remain proposal-only and runtime NOT_ADMITTED/u);

  const executionAdmissionForged = structuredClone(base);
  executionAdmissionForged.operations.operations.find(({ id }) => id === write.id).executionAdmission = 'ADMITTED';
  assert.match(validateMediaCaptionVersionDefinitions(executionAdmissionForged).join('\n'), /cannot forge execution admission/u);

  const legacyParentEquated = structuredClone(base);
  legacyParentEquated.domainObjects.objects.find(({ id }) => id === 'media.domain.caption-version').canonicalParentRequirement =
    'legacy-media.domain.transcription-UUID-is-equivalent-to-TRANSCRIPT_VERSION';
  assert.match(validateMediaCaptionVersionDefinitions(legacyParentEquated).join('\n'), /must not be inferred from the legacy transcription UUID/u);

  const absenceAllowsRetry = structuredClone(base);
  absenceAllowsRetry.operations.operations.find(({ id }) => id === write.id).unknownOutcome =
    'scoped-absence-proves-no-commit; retry with a new key';
  assert.match(validateMediaCaptionVersionDefinitions(absenceAllowsRetry).join('\n'), /must not infer no-commit from scoped absence/u);
});

test('caption version comparison definition', () => {
  const pairPolicyAppliedToReceipt = structuredClone(base);
  pairPolicyAppliedToReceipt.operations.operations.find((record) => record.id === 'media.operation.caption-version-read').context.requiredPolicy = 'currentReadAuthorityForBoth';
  assert.match(validateMediaCaptionVersionDefinitions(pairPolicyAppliedToReceipt).join('\n'), /read authority must follow the exact selector branch/u);

  const read = operation('media.operation.caption-version-read');
  assert.deepEqual(validateMediaCaptionVersionDefinitions(base), []);
  assert.deepEqual(read.actionRefs, ['media.action.compare-caption-versions']);
  assert.deepEqual(read.inputSemantics.selectorKindValues, ['EXACT_PAIR', 'REGISTRATION_REQUEST']);
  assert.deepEqual(read.inputSemantics.selectorBranches.EXACT_PAIR.requiredFields, ['leftCaptionVersionId', 'rightCaptionVersionId']);
  assert.deepEqual(read.inputSemantics.selectorBranches.REGISTRATION_REQUEST.requiredFields, ['requestId', 'requestFingerprint']);
  assert.deepEqual(read.outputSemantics.EXACT_PAIR.requiredFields, [
    'leftCaptionVersionRef', 'rightCaptionVersionRef', 'comparability', 'sourceIdentityComparison',
    'languageComparison', 'segmentDifferences', 'observedAt',
  ]);
  assert.deepEqual(read.outputSemantics.REGISTRATION_REQUEST.requiredFields, ['requestId', 'requestFingerprint', 'registrationOutcome', 'observedAt']);
  assert.ok(read.outputSemantics.REGISTRATION_REQUEST.registeredFields.includes('registrationReceiptId'));
  assert.ok(read.outputSemantics.REGISTRATION_REQUEST.registeredFields.includes('captionVersionId'));
  assert.deepEqual(read.transition.transitionRefs, []);
  assert.equal(read.outputSemantics.EXACT_PAIR.preservesExactPair, true);
  assert.match(read.error.join(' '), /CAPTION_VERSIONS_NOT_COMPARABLE/u);
  assert.match(read.error.join(' '), /UNKNOWN_OUTCOME/u);

  const sourceEquivalenceForged = structuredClone(base);
  sourceEquivalenceForged.operations.operations.find(({ id }) => id === read.id).preconditions =
    ['two versions exist; source identity is not checked'];
  assert.match(validateMediaCaptionVersionDefinitions(sourceEquivalenceForged).join('\n'), /check source identity and clock/u);

  const pairIdentityDropped = structuredClone(base);
  pairIdentityDropped.operations.operations.find(({ id }) => id === read.id).outputSemantics.EXACT_PAIR.requiredFields =
    ['comparability', 'segmentDifferences'];
  assert.match(validateMediaCaptionVersionDefinitions(pairIdentityDropped).join('\n'), /preserve both exact pair identities/u);

  const requestSelectorRemoved = structuredClone(base);
  requestSelectorRemoved.operations.operations.find(({ id }) => id === read.id).inputSemantics.selectorBranches.REGISTRATION_REQUEST.requiredFields = ['requestId'];
  assert.match(validateMediaCaptionVersionDefinitions(requestSelectorRemoved).join('\n'), /reconcile an original request/u);

  const unknownMayReplay = structuredClone(base);
  unknownMayReplay.operations.operations.find(({ id }) => id === read.id).outputSemantics.registrationRequestRules = 'absence permits replay';
  assert.match(validateMediaCaptionVersionDefinitions(unknownMayReplay).join('\n'), /preserve unknown receipt state/u);

  const globalListAdded = structuredClone(base);
  globalListAdded.operations.operations.find(({ id }) => id === read.id).inputSemantics.selectorBranches.EXACT_PAIR.rule =
    'any selector lists all caption versions globally';
  assert.match(validateMediaCaptionVersionDefinitions(globalListAdded).join('\n'), /must not become a global caption-version listing/u);

  const approvalClaimed = structuredClone(base);
  approvalClaimed.operations.operations.find(({ id }) => id === read.id).outputSemantics.EXACT_PAIR.requiredFields.push('approval');
  assert.match(validateMediaCaptionVersionDefinitions(approvalClaimed).join('\n'), /must not return approval/u);
});

test('J-03 steps 7 and 8 bind the existing operations and preserve source observations as synthetic only', () => {
  const journey = yaml('.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml');
  const saveStep = journey.steps[6];
  const compareStep = journey.steps[7];
  assert.equal(saveStep.action, 'media.action.save-caption-version');
  assert.equal(saveStep.canonicalOperationRef, 'media.operation.caption-version-write');
  assert.equal(compareStep.action, 'media.action.compare-caption-versions');
  assert.equal(compareStep.canonicalOperationRef, 'media.operation.caption-version-read');
  const write = operation('media.operation.caption-version-write');
  const read = operation('media.operation.caption-version-read');
  assert.match(write.sourceContractObservations.simulationAuthority, /no-principal-tenant-rights-retention-or-production-authority-binding/u);
  assert.match(write.sourceContractObservations.simulationIdempotency, /no-idempotency-key-or-deduplication/u);
  assert.equal(write.sourceContractObservations.input.UI.shape, 'optional-purpose-string; empty-purpose-is-omitted');
  assert.equal(read.sourceContractObservations.simulationAuthority, 'fixture-state-readSource-flag-only; no-principal-tenant-or-production-resource-authority-binding');
  assert.match(read.scopeStatus, /runtime-NOT_ADMITTED/u);
});
