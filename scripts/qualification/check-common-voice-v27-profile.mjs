#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROFILE_URL = new URL('../../config/qualification/common-voice-v27-asr-alternative.v1.json', import.meta.url);
const EXPECTED = Object.freeze({
  schemaVersion: '1.0.0',
  profileId: 'media.stt.common-voice-scripted-speech-27-alternative',
  status: 'METADATA_ONLY_WAITING_FOR_AUTHORIZED_ACCESS_AND_CLIP_MANIFEST',
  sourceRevision: 'cv-corpus-27.0-2026-09-11',
  license: 'CC0-1.0',
  task: 'ASR',
  locales: Object.freeze({
    en: Object.freeze({ id: 'cmu5jplf300nwmh07iqvk9leo', locale: 'en', clips: 16403, size: '88.43 GB' }),
    hi: Object.freeze({ id: 'cmu5vlext009to107ev1s9lk8', locale: 'hi', clips: 3402, size: '546.57 MB' }),
    ne: Object.freeze({ id: 'cmu61478v00j9o107alzuue1z', locale: 'ne-NP', clips: 302, size: '40.55 MB' }),
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

  // The public metadata candidate intentionally cannot become admitted by
  // changing booleans or filling local reference fields. Access evidence must be
  // reviewed and a new frozen run manifest handled outside this candidate file.
  assert(profile.access?.consumerTermsAccepted === false
    && profile.access.downloadOrSampleRequested === false
    && profile.access.status === 'WAITING_FOR_AUTHORIZED_ORGANIZATIONAL_ACCEPTANCE'
    && profile.access.acceptedAt === null
    && profile.access.organizationRef === null
    && profile.access.authorizedRepresentativeRef === null
    && profile.access.datasetAccessRecordRef === null
    && profile.access.evidenceRef === null,
  'candidate must not contain locally asserted MDC access acceptance or a dataset/sample request');
  assert(profile.englishSubset?.sampleAvailability === 'NOT_VERIFIED', 'English sample status must stay unverified');
  assert(profile.englishSubset.publisherSampleLinkVisibleOnPublicCard === false,
    'English public card must not claim a publisher audio-sample link');
  assert(profile.englishSubset.fullArchiveDownloadAuthorized === false, 'English full archive is not authorized');

  const selection = profile.selection;
  assert(selection?.sourceSplit === 'test', 'selection must use the official test split');
  assert(Array.isArray(selection.clipManifest), 'clip manifest must be an array');
  assert(!hasForbiddenField(selection.clipManifest), 'clip manifest contains forbidden fields');
  for (const record of selection.clipManifest) validatePersistedClipRecord(record);
  assert(selection.clipManifestStatus === 'NOT_CREATED_NO_DATA_ACQUIRED'
    && selection.clipManifest.length === 0,
  'candidate cannot include selected clips before authorized access and a reviewed manifest');
  assert(Array.isArray(selection.requiredManifestFields)
    && selection.requiredManifestFields.length === REQUIRED_MANIFEST_FIELDS.length
    && [...selection.requiredManifestFields].sort().join(',') === [...REQUIRED_MANIFEST_FIELDS].sort().join(','),
  'persisted clip manifest must use exactly the approved fields');
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
  assert(execution?.realInferenceAdmitted === false && execution.modelNetworkAccess === 'DISABLED',
    'real inference must remain disabled in this profile');
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
    datasetAccessProven: false,
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
