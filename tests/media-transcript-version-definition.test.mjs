import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { validateMediaTranscriptVersionDefinition } from '../scripts/lib/media-transcript-version-definition-validation.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const yaml = (file) => parse(readFileSync(resolve(root, file), 'utf8'));
const domainObjects = yaml('.product-experience/pdp-1-domain-data/domain-objects.yaml');
const operations = yaml('.product-experience/pdp-1-domain-data/operations.yaml');
const actionContracts = yaml('.product-experience/pdp-1-domain-data/action-contracts.yaml');
const base = { domainObjects, operations, actionContracts };
const transcript = () => domainObjects.objects.find(({ id }) => id === 'media.domain.transcript-version');
const operation = () => operations.operations.find(({ id }) => id === 'media.operation.transcript-version-read');

test('transcript version object definition', () => {
  assert.deepEqual(validateMediaTranscriptVersionDefinition(base), []);
  assert.equal(transcript().name, 'TranscriptVersion');
  assert.deepEqual(transcript().timing.availabilityValues, ['NOT_SUPPLIED', 'PROVIDER_TIME_UNQUALIFIED', 'SOURCE_CLOCK_BOUND']);
  assert.match(transcript().materialization, /no-qualified-producer-is-claimed/u);
  assert.equal(Object.hasOwn(transcript(), 'runtimeAdmission'), false);

  const legacyUuidPromoted = structuredClone(base);
  legacyUuidPromoted.domainObjects.objects.find(({ id }) => id === 'media.domain.transcription').canonicalBoundary =
    'legacy-transcription-UUID-establishes-media.domain.transcript-version';
  assert.match(validateMediaTranscriptVersionDefinition(legacyUuidPromoted).join('\n'), /legacy transcription identifiers must not establish/u);

  const providerMillisecondsQualified = structuredClone(base);
  providerMillisecondsQualified.domainObjects.objects.find(({ id }) => id === 'media.domain.transcript-version').timing.providerTime =
    'provider-milliseconds-are-source-ticks-without-mapping';
  assert.match(validateMediaTranscriptVersionDefinition(providerMillisecondsQualified).join('\n'), /preserve provider timing without inventing/u);

  const timingRequiredForInspection = structuredClone(base);
  timingRequiredForInspection.domainObjects.objects.find(({ id }) => id === 'media.domain.transcript-version').timing.rule =
    'missing timing blocks read and clock is inferred';
  assert.match(validateMediaTranscriptVersionDefinition(timingRequiredForInspection).join('\n'), /missing timing without inference/u);

  const sourceClockAloneMakesParentEligible = structuredClone(base);
  sourceClockAloneMakesParentEligible.domainObjects.objects.find(({ id }) => id === 'media.domain.transcript-version').captionParentUse =
    'sourceClockId alone establishes caption parent eligibility and authority';
  assert.match(validateMediaTranscriptVersionDefinition(sourceClockAloneMakesParentEligible).join('\n'), /caption-parent use must require complete authoritative source metadata/u);

  const metadataGrantsWriteAuthority = structuredClone(base);
  metadataGrantsWriteAuthority.domainObjects.objects.find(({ id }) => id === 'media.domain.transcript-version').captionParentUse =
    'metadata-completeness-grants-current-write-authority';
  assert.match(validateMediaTranscriptVersionDefinition(metadataGrantsWriteAuthority).join('\n'), /caption-parent use must require complete authoritative source metadata/u);

  const laterMappingRetimesVersion = structuredClone(base);
  laterMappingRetimesVersion.domainObjects.objects.find(({ id }) => id === 'media.domain.transcript-version').timing.snapshotBoundary =
    'later mapping retimes the immutable version in place';
  assert.match(validateMediaTranscriptVersionDefinition(laterMappingRetimesVersion).join('\n'), /keep later clock qualification separate/u);

  const autoMaterializerClaimed = structuredClone(base);
  autoMaterializerClaimed.domainObjects.objects.find(({ id }) => id === 'media.domain.transcript-version').materialization =
    'STT response automatically creates the canonical transcriptVersionId';
  assert.match(validateMediaTranscriptVersionDefinition(autoMaterializerClaimed).join('\n'), /must not equate recognition output/u);

  const inspectionClaimsApproval = structuredClone(base);
  inspectionClaimsApproval.domainObjects.objects.find(({ id }) => id === 'media.domain.transcript-version').reviewBoundary =
    'inspection approves and publishes the transcript';
  assert.match(validateMediaTranscriptVersionDefinition(inspectionClaimsApproval).join('\n'), /must not imply correction, registration, approval/u);

  const lifecycleAdmissionForged = structuredClone(base);
  lifecycleAdmissionForged.domainObjects.objects.find(({ id }) => id === 'media.domain.transcript-version').runtimeAdmission = 'ADMITTED';
  assert.match(validateMediaTranscriptVersionDefinition(lifecycleAdmissionForged).join('\n'), /must not contain a native Lifecycle/u);
});

test('transcript version read definition', () => {
  const read = operation();
  assert.deepEqual(validateMediaTranscriptVersionDefinition(base), []);
  assert.deepEqual(read.inputSemantics.requiredFields, ['transcriptVersionId']);
  assert.deepEqual(read.inputSemantics.trustedHostFields, ['tenantId', 'principalId']);
  assert.deepEqual(read.outputSemantics.requiredFields, [
    'transcriptVersionId', 'sourceArtifactId', 'sourceArtifactVersionId', 'textAvailability', 'segmentsAvailability',
    'languageAvailability', 'uncertaintyAvailability', 'timingAvailability', 'sourceClockAvailability', 'evidenceAvailability', 'observedAt',
  ]);
  assert.equal(read.scopeStatus.includes('runtime-NOT_ADMITTED'), true);
  assert.equal(Object.hasOwn(read, 'executionAdmission'), false);

  const jobAliasAccepted = structuredClone(base);
  jobAliasAccepted.operations.operations.find(({ id }) => id === read.id).inputSemantics.selector = 'transcriptVersionId-or-jobId';
  assert.match(validateMediaTranscriptVersionDefinition(jobAliasAccepted).join('\n'), /must not add job, artifact, latest, or list aliases/u);

  const clientTenantTrusted = structuredClone(base);
  clientTenantTrusted.operations.operations.find(({ id }) => id === read.id).inputSemantics.authorization =
    'caller-supplied-tenantId-grants-access';
  assert.match(validateMediaTranscriptVersionDefinition(clientTenantTrusted).join('\n'), /must not accept client identity or actor labels/u);

  const readRequiresTiming = structuredClone(base);
  readRequiresTiming.operations.operations.find(({ id }) => id === read.id).preconditions.push('sourceClockId-is-required-for-read');
  assert.match(validateMediaTranscriptVersionDefinition(readRequiresTiming).join('\n'), /permit inspection when timing is not supplied/u);

  const providerMillisecondsPromoted = structuredClone(base);
  providerMillisecondsPromoted.operations.operations.find(({ id }) => id === read.id).outputSemantics.providerTiming =
    'provider milliseconds are source ticks without qualified mapping';
  assert.match(validateMediaTranscriptVersionDefinition(providerMillisecondsPromoted).join('\n'), /retain unqualified provider time distinctly/u);

  const sourceClockMappingMutatesSnapshot = structuredClone(base);
  sourceClockMappingMutatesSnapshot.operations.operations.find(({ id }) => id === read.id).outputSemantics.clockMappingContext =
    'new mapping rewrites stored provider milliseconds in place';
  assert.match(validateMediaTranscriptVersionDefinition(sourceClockMappingMutatesSnapshot).join('\n'), /distinguish immutable timing from separately resolved mapping/u);

  const sourceMismatchHidden = structuredClone(base);
  sourceMismatchHidden.operations.operations.find(({ id }) => id === read.id).error = ['INVALID_REQUEST', 'ACCESS_DENIED', 'UNAVAILABLE'];
  assert.match(validateMediaTranscriptVersionDefinition(sourceMismatchHidden).join('\n'), /distinguish scope-safe absence, source-integrity mismatch/u);

  const unavailableFieldsSynthesized = structuredClone(base);
  unavailableFieldsSynthesized.operations.operations.find(({ id }) => id === read.id).outputSemantics.incompleteFields =
    'fill missing text, timing, and language from provider defaults';
  assert.match(validateMediaTranscriptVersionDefinition(unavailableFieldsSynthesized).join('\n'), /expose partial data and prohibit inferred fields/u);

  const readApprovalClaimed = structuredClone(base);
  readApprovalClaimed.operations.operations.find(({ id }) => id === read.id).finality = 'read-only inspection approves transcript';
  assert.match(validateMediaTranscriptVersionDefinition(readApprovalClaimed).join('\n'), /must remain read-only and not imply approval/u);

  const runtimeAdmissionForged = structuredClone(base);
  runtimeAdmissionForged.operations.operations.find(({ id }) => id === read.id).executionAdmission = 'ADMITTED';
  assert.match(validateMediaTranscriptVersionDefinition(runtimeAdmissionForged).join('\n'), /must not contain a native Lifecycle/u);
});

