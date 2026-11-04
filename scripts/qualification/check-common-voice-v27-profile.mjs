#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROFILE_URL = new URL('../../config/qualification/common-voice-v27-asr-alternative.v1.json', import.meta.url);
const EXPECTED = Object.freeze({
  schemaVersion: '1.0.0',
  profileId: 'media.stt.common-voice-scripted-speech-27-alternative',
  status: 'OWNER_CONFIRMED_ACCESS_QUALITY_GATES_PENDING',
  sourceRevision: 'cv-corpus-27.0-2026-09-11',
  license: 'CC0-1.0',
  task: 'ASR',
  locales: Object.freeze({
    en: Object.freeze({ id: 'cmu5jplf300nwmh07iqvk9leo', locale: 'en', clips: 16403, size: '88.43 GB' }),
    ne: Object.freeze({ id: 'cmu61478v00j9o107alzuue1z', locale: 'ne-NP', clips: 302, size: '40.55 MB' }),
  }),
  deferredLocales: Object.freeze({
    hi: Object.freeze({
      id: 'cmu5vlext009to107ev1s9lk8',
      locale: 'hi',
      datasetUrl: 'https://mozilladatacollective.com/datasets/cmu5vlext009to107ev1s9lk8',
      sourceRevision: 'cv-corpus-27.0-2026-09-11',
      license: 'CC0-1.0',
      officialTestSplit: 'test',
      officialTestClipCountAtReview: 3402,
      evaluationStatus: 'METADATA_ONLY_NO_DOWNLOAD_NO_EVALUATION',
    }),
  }),
});
const FORBIDDEN_FIELD_NAMES = new Set([
  'clientid', 'speakerid', 'age', 'gender', 'accent', 'accents', 'variant',
  'transcript', 'referencetext', 'referencetranscript', 'sentence', 'sentencetext',
  'prediction', 'hypothesis', 'audiopath', 'sourcefile',
]);
const REQUIRED_DECLARED_FORBIDDEN_FIELDS = Object.freeze([
  'client_id', 'speakerId', 'age', 'gender', 'accents', 'variant', 'transcript', 'prediction',
]);
const REQUIRED_MANIFEST_FIELDS = Object.freeze([
  'locale', 'sourceDatasetId', 'sourceRevision', 'sourceSplit', 'clipId', 'audioSha256',
]);
const ALLOWED_TRANSIENT_SOURCE_FIELDS = Object.freeze([
  'locale', 'path', 'sentence_id', 'sentence',
]);
const PILOT_PROFILE_FIELDS = Object.freeze([
  'clipsPerLocale', 'purpose', 'ranking', 'speakerDisjointEvidence',
]);

function canonicalFieldName(field) {
  return field.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasForbiddenField(value, path = '$') {
  if (Array.isArray(value)) {
    return value.some((item, index) => hasForbiddenField(item, `${path}[${index}]`));
  }
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN_FIELD_NAMES.has(canonicalFieldName(key))
    || hasForbiddenField(child, `${path}.${key}`));
}

function validatePersistedClipRecord(record) {
  assert(record !== null && typeof record === 'object' && !Array.isArray(record),
    'persisted clip record must be an object');
  const keys = Object.keys(record).sort();
  assert(keys.join(',') === [...REQUIRED_MANIFEST_FIELDS].sort().join(','),
    'persisted clip record must contain exactly the approved fields');
  assert(!hasForbiddenField(record), 'clip manifest contains forbidden fields');
  const locale = Object.entries(EXPECTED.locales).find(([, expected]) => expected.locale === record.locale);
  assert(locale, 'persisted clip record has an unsupported locale');
  const [localeKey, expected] = locale;
  assert(record.sourceDatasetId === expected.id, `persisted clip record dataset mismatch for ${localeKey}`);
  assert(record.sourceRevision === EXPECTED.sourceRevision, 'persisted clip record release mismatch');
  assert(record.sourceSplit === 'test', 'persisted clip record must use the official test split');
  assert(typeof record.clipId === 'string' && record.clipId.trim().length > 0
    && !/[\u0000-\u001f\u007f]/u.test(record.clipId), 'persisted clip ID is invalid');
  assert(typeof record.audioSha256 === 'string' && /^[0-9a-f]{64}$/u.test(record.audioSha256),
    'persisted audioSha256 must be a lowercase SHA-256 hex digest');
}

/**
 * Validates only the checked-in metadata candidate. It never authorizes access,
 * downloads data, loads a model, or proves that an external party accepted terms.
 */
export function validateCandidateProfile(profile) {
  assert(profile?.schemaVersion === EXPECTED.schemaVersion, 'unsupported profile schemaVersion');
  assert(profile.profileId === EXPECTED.profileId, 'unexpected profile identity');
  assert(profile.status === EXPECTED.status, 'candidate must remain metadata-only and not admitted');
  assert(profile.decisionScope === 'ALTERNATIVE_ASR_EVALUATION_REPORT_ONLY', 'candidate scope changed');
  assert(Array.isArray(profile.doesNotSupersede)
    && profile.doesNotSupersede.includes('config/qualification/fleurs-asr-evaluation.v1.json')
    && profile.doesNotSupersede.some((item) => item.includes('FLEURS-specific')),
  'Common Voice profile must remain separate from FLEURS acceptance');

  const dataset = profile.dataset;
  assert(dataset?.name === 'Mozilla Common Voice Scripted Speech 27.0', 'unexpected dataset');
  assert(dataset.sourceRevision === EXPECTED.sourceRevision, 'unexpected Common Voice release');
  assert(dataset.license === EXPECTED.license && dataset.task === EXPECTED.task, 'unexpected license or task');
  assert([...dataset.activeLocaleScope].sort().join(',') === ['en', 'ne-NP'].sort().join(','),
    'active Common Voice phase must contain English and Nepali only');
  assert(Object.keys(dataset.locales ?? {}).sort().join(',') === Object.keys(EXPECTED.locales).sort().join(','),
    'active dataset locales must contain exactly English and Nepali');
  for (const [key, expected] of Object.entries(EXPECTED.locales)) {
    const locale = dataset.locales?.[key];
    assert(locale?.datasetId === expected.id && locale.locale === expected.locale,
      `dataset ID or locale mismatch for ${key}`);
    assert(locale.license === EXPECTED.license, `license mismatch for ${key}`);
    assert(locale.officialTestSplit === 'test', `official test split missing for ${key}`);
    assert(locale.officialTestClipCountAtReview === expected.clips
      && locale.fullArchiveDisplaySizeAtReview === expected.size,
    `reviewed test-split count or archive size mismatch for ${key}`);
  }
  assert(Object.keys(dataset.deferredLocales ?? {}).sort().join(',') === 'hi'
    && dataset.deferredLocales.hi?.datasetId === EXPECTED.deferredLocales.hi.id
    && dataset.deferredLocales.hi?.locale === EXPECTED.deferredLocales.hi.locale
    && dataset.deferredLocales.hi?.datasetUrl === EXPECTED.deferredLocales.hi.datasetUrl
    && dataset.deferredLocales.hi?.sourceRevision === EXPECTED.sourceRevision
    && dataset.deferredLocales.hi?.license === EXPECTED.license
    && dataset.deferredLocales.hi?.officialTestSplit === 'test'
    && dataset.deferredLocales.hi?.officialTestClipCountAtReview === 3402
    && dataset.deferredLocales.hi?.status === 'DEFERRED_FROM_THIS_PHASE',
  'Hindi must remain explicitly deferred from the active locale scope');
  assert(dataset.deferredLocales.hi?.evaluationStatus === 'METADATA_ONLY_NO_DOWNLOAD_NO_EVALUATION',
    'Hindi metadata must not authorize download or evaluation');

  // User-reported terms acceptance is preserved as a report, not promoted to
  // verified authority/access evidence. The candidate remains non-admitted.
  assert(profile.access?.consumerTermsAcceptanceStatus
    === 'OWNER_CONFIRMED_MDC_ACCESS_AND_TERMS_COMPLETE_FOR_EN_AND_NP'
    && profile.access.status === 'OWNER_CONFIRMED_MDC_ACCESS_AND_TERMS_COMPLETE; LOCAL_ARCHIVES_PRESENT'
    && profile.access.acceptedAt === 'NOT_PROVIDED'
    && profile.access.organizationRef === null
    && profile.access.authorizedRepresentativeRef === null
    && profile.access.datasetAccessRecordRef === null
    && profile.access.evidenceRef === null
    && profile.access.authorityAndAcceptanceEvidenceStatus
      === 'OWNER_CONFIRMED; NOT_INDEPENDENTLY_VERIFIED',
  'owner-confirmed MDC access must remain distinct from independently verified source evidence');
  assert(profile.access.archivePresence?.en?.status === 'PRESENT_FULL_ARCHIVE_STREAMED_AND_PILOT_PREPARED'
    && profile.access.archivePresence.en.basename === '1789502799671-cv-corpus-27.0-2026-09-11-en.tar.gz'
    && profile.access.archivePresence.en.sizeBytes === 94956262763
    && profile.access.archivePresence.en.integrity
      === 'FULL_LOCAL_COMPRESSED_ARCHIVE_SHA256_RECORDED_PRIVATELY; TEST_ROWS_VERIFIED; 24_PILOT_MP3_HASHES_RETAINED_PRIVATELY; AUDIO_NOT_EXTRACTED_OR_DECODED'
    && profile.access.archivePresence.en.testTsvMember === 'OBSERVED_AND_PARSED_WITHOUT_EMITTING_ROW_VALUES'
    && profile.access.archivePresence.en.testRowsObservedLocally === 16403
    && profile.access.archivePresence?.['ne-NP']?.status === 'PRESENT_FULL_ARCHIVE_STREAMED_AND_PILOT_PREPARED'
    && profile.access.archivePresence['ne-NP'].basename === '1789491018738-cv-corpus-27.0-2026-09-11-ne-NP.tar.gz'
    && profile.access.archivePresence['ne-NP'].sizeBytes === 42519359
    && profile.access.archivePresence['ne-NP'].integrity
      === 'FULL_LOCAL_COMPRESSED_ARCHIVE_SHA256_RECORDED_PRIVATELY; TEST_ROWS_VERIFIED; 24_PILOT_MP3_HASHES_RETAINED_PRIVATELY; AUDIO_NOT_EXTRACTED_OR_DECODED'
    && profile.access.archivePresence['ne-NP'].testTsvMember
      === 'OBSERVED_AND_PARSED_WITHOUT_EMITTING_ROW_VALUES'
    && profile.access.archivePresence['ne-NP'].testRowsObservedLocally === 302,
  'archive metadata must match the locally streamed pilot and must not imply audio extraction or decoding');
  assert(profile.englishSubset?.sampleAvailability === 'NOT_REQUIRED_ARCHIVE_REPORTED_PRESENT',
    'English sample status must reflect the reported archive');
  assert(profile.englishSubset.publisherSampleLinkVisibleOnPublicCard === false,
    'English public card must not claim a publisher audio-sample link');
  assert(profile.englishSubset.publicTextSampleSentenceCount === 5,
    'English public card text-sample count must match its current pinned record');
  assert(profile.englishSubset.sampleApiDocumentationUrl === 'https://mozilladatacollective.com/api-reference/docs',
    'publisher audio-sample status must cite the MDC API documentation');
  assert(profile.englishSubset.fullArchiveDownloadAuthorization
    === 'OWNER_CONFIRMED_ALREADY_ACQUIRED; NO_NEW_DOWNLOAD',
  'English archive presence must remain scoped to the owner-confirmed existing download');

  const selection = profile.selection;
  assert(selection?.sourceSplit === 'test', 'selection must use the official test split');
  assert([...selection.activeLocales].sort().join(',') === ['en', 'ne-NP'].sort().join(',')
    && [...selection.deferredLocales].join(',') === 'hi',
  'selection must include English and Nepali only with Hindi deferred');
  assert(selection.pilotProfile !== null && typeof selection.pilotProfile === 'object'
    && !Array.isArray(selection.pilotProfile)
    && Object.keys(selection.pilotProfile).sort().join(',') === [...PILOT_PROFILE_FIELDS].sort().join(',')
    && selection.pilotProfile.clipsPerLocale === 24
    && selection.pilotProfile.purpose === 'PILOT_ONLY_NOT_GENERAL_QUALITY_OR_ACCEPTANCE'
    && selection.pilotProfile.ranking
      === 'Select 24 lowest SHA-256 ranks of UTF-8(sourceRevision + NUL + locale + NUL + clipId), breaking ties by clipId; transcript-independent.'
    && selection.pilotProfile.speakerDisjointEvidence === 'NOT_ESTABLISHED',
  'pilot selection must remain deterministic, transcript-independent, and explicitly non-qualifying');
  assert(Array.isArray(selection.clipManifest), 'clip manifest must be an array');
  assert(!hasForbiddenField(selection.clipManifest), 'clip manifest contains forbidden fields');
  for (const record of selection.clipManifest) validatePersistedClipRecord(record);
  assert(selection.clipManifestStatus === 'PRIVATE_LOCAL_24_PER_LOCALE_MANIFEST_PREPARED_NOT_IN_SOURCE_CONTROL'
    && selection.clipManifest.length === 0,
  'profile must report private manifest preparation without copying clip IDs or hashes into source control');
  assert(selection.trustedManifestDigestSource
    === 'ACCESS_CONTROLLED_LOCAL_PILOT_MANIFEST_PER_LOCALE; REQUIRED_BY_QUALITY_READER; NEVER_CHECKED_IN_OR_PRINTED',
  'quality evidence reader must receive the exact private per-locale manifest digest pins');
  assert(Array.isArray(selection.requiredManifestFields)
    && selection.requiredManifestFields.length === REQUIRED_MANIFEST_FIELDS.length
    && [...selection.requiredManifestFields].sort().join(',') === [...REQUIRED_MANIFEST_FIELDS].sort().join(','),
  'persisted clip manifest must use exactly the approved fields');
  assert(Array.isArray(selection.transientSourceFieldsAllowed)
    && selection.transientSourceFieldsAllowed.length === ALLOWED_TRANSIENT_SOURCE_FIELDS.length
    && [...selection.transientSourceFieldsAllowed].sort().join(',')
      === [...ALLOWED_TRANSIENT_SOURCE_FIELDS].sort().join(','),
  'transient source fields must use exactly the approved in-memory fields');
  assert(selection.requiredManifestFields.every((field) => !FORBIDDEN_FIELD_NAMES.has(canonicalFieldName(field))),
    'persisted manifest required fields include a forbidden field');
  assert(Array.isArray(selection.forbiddenManifestFields)
    && REQUIRED_DECLARED_FORBIDDEN_FIELDS.every((field) => selection.forbiddenManifestFields.includes(field)),
  'speaker, demographic, transcript, and prediction fields must remain excluded from persisted manifests');
  assert(selection.persistedManifestPolicy?.storage === 'ACCESS_CONTROLLED_LOCAL_ONLY'
    && selection.persistedManifestPolicy.publishClipIdsOrAudioHashes === false
    && selection.persistedManifestPolicy.clipIdsAndAudioHashesAreDeidentification === false,
  'clip IDs and hashes must remain local, restricted, and explicitly non-deidentifying');

  const execution = profile.execution;
  assert(execution?.realInferenceAdmitted === false && execution.modelNetworkAccess === 'DISABLED'
    && execution.notAdmittedReason
      === 'Pinned model artifact/export rights, independent reference review, and execution-host qualification remain unresolved.'
    && execution.modelCandidateId === 'stt-whisper-tiny-multilingual'
    && execution.modelCandidateDisposition === 'REVIEW_ONLY'
    && execution.modelArtifactAvailability === 'NOT_FOUND_IN_REPOSITORY_OR_CHECKED_LOCAL_CACHES'
    && execution.modelRightsAndExportStatus === 'NOT_REVIEWED'
    && execution.independentReferenceReviewStatus === 'NOT_COMPLETED'
    && execution.executionHostQualificationStatus === 'NOT_QUALIFIED'
    && execution.pilotEvaluationScope === '24_CLIPS_PER_ACTIVE_LOCALE_REFERENCE_ONLY'
    && execution.pilotCanQualifyModel === false,
  'real inference must remain disabled until model rights, independent references, and host qualification pass');
  for (const field of [
    'externalProviderDispatch', 'trainingAllowed', 'speakerIdentificationAllowed',
    'voiceCloningAllowed', 'datasetRehostingOrResharingAllowed',
  ]) {
    assert(execution[field] === false, `${field} must remain false`);
  }
  assert(execution.audioRetention === 'DELETE_AFTER_EACH_RUN'
    && execution.interruptedRunAudioMaximumHours === 24,
  'audio cleanup policy changed');
  assert(execution.runManifestRetentionDays === 90 && execution.aggregateWerCerRetentionDays === 90,
    'aggregate and run manifest retention must remain 90 days');
  assert(execution.perClipReferenceRetention === 'MEMORY_ONLY'
    && execution.perClipPredictionRetention === 'MEMORY_ONLY'
    && execution.perClipOutputRetention === 'NONE', 'per-clip results must not be retained');

  assert(profile.reporting?.thresholds === 'NOT_SET_FOR_THIS_ALTERNATIVE_PROFILE',
    'alternative profile cannot silently inherit FLEURS thresholds');
  return Object.freeze({
    profileId: profile.profileId,
    metadataValid: true,
    realInferenceAdmitted: false,
    datasetAccessUserConfirmed: true,
    datasetAccessProven: false,
    activeLocales: Object.freeze(['en', 'ne-NP']),
    deferredLocales: Object.freeze(['hi']),
    ownerConfirmedTermsAndAccess: true,
  });
}

export function loadAndValidateCandidateProfile() {
  const profile = JSON.parse(readFileSync(PROFILE_URL, 'utf8'));
  return validateCandidateProfile(profile);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = loadAndValidateCandidateProfile();
  console.log(`${result.profileId}: metadata valid; real inference NOT_ADMITTED`);
}
