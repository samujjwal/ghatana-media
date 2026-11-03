import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { validateCandidateProfile } from '../scripts/qualification/check-common-voice-v27-profile.mjs';

const profileUrl = new URL('../config/qualification/common-voice-v27-asr-alternative.v1.json', import.meta.url);
const profile = JSON.parse(await readFile(profileUrl, 'utf8'));

test('pins English and Nepali Common Voice v27 and keeps Hindi deferred and the candidate separate from FLEURS', () => {
  const result = validateCandidateProfile(profile);
  assert.deepEqual(result, {
    profileId: 'media.stt.common-voice-scripted-speech-27-alternative',
    metadataValid: true,
    realInferenceAdmitted: false,
    datasetAccessUserConfirmed: true,
    datasetAccessProven: false,
    activeLocales: ['en', 'ne-NP'],
    deferredLocales: ['hi'],
    ownerConfirmedTermsAndAccess: true,
  });
  assert.deepEqual(Object.keys(profile.dataset.locales).sort(), ['en', 'ne']);
  assert.equal(profile.dataset.locales.en.datasetId, 'cmu5jplf300nwmh07iqvk9leo');
  assert.equal(profile.dataset.locales.ne.datasetId, 'cmu61478v00j9o107alzuue1z');
  assert.equal(profile.dataset.deferredLocales.hi.datasetId, 'cmu5vlext009to107ev1s9lk8');
  assert.equal(profile.doesNotSupersede.includes('config/qualification/fleurs-asr-evaluation.v1.json'), true);
});

test('does not turn owner confirmation into independently verified source authority', () => {
  const mutated = structuredClone(profile);
  mutated.access.authorityAndAcceptanceEvidenceStatus = 'VERIFIED';
  assert.throws(() => validateCandidateProfile(mutated), /distinct from independently verified source evidence/);
});

test('does not let partial archive metadata assert full archive integrity', () => {
  const mutated = structuredClone(profile);
  mutated.access.archivePresence.en.integrity = 'VERIFIED';
  assert.throws(() => validateCandidateProfile(mutated), /archive metadata must not imply full integrity/);
});

test('requires a restricted local clip manifest before claiming selected clips', () => {
  const mutated = structuredClone(profile);
  mutated.selection.clipManifest = [{
    locale: 'en',
    sourceDatasetId: 'cmu5jplf300nwmh07iqvk9leo',
    sourceRevision: 'cv-corpus-27.0-2026-09-11',
    sourceSplit: 'test',
    clipId: 'clip-1',
    audioSha256: 'a'.repeat(64),
  }];
  assert.throws(() => validateCandidateProfile(mutated), /must not claim selected clips/);
});

test('rejects transcript, speaker, demographic, and prediction fields from persisted clip manifests', () => {
  const mutated = structuredClone(profile);
  mutated.selection.clipManifest = [{ speakerID: 'opaque-speaker-id', nested: { referenceTranscript: 'private' } }];
  mutated.selection.clipManifestStatus = 'FROZEN';
  assert.throws(() => validateCandidateProfile(mutated), /clip manifest contains forbidden fields/);
});

test('does not allow unsafe fields to be added to the persisted-manifest schema', () => {
  const mutated = structuredClone(profile);
  mutated.selection.requiredManifestFields.push('clientId');
  assert.throws(() => validateCandidateProfile(mutated), /exactly the approved fields/);
});

test('keeps transient source fields limited to the approved in-memory clip inputs', () => {
  const mutations = [
    (fields) => fields.push('speaker_id'),
    (fields) => fields.push('client_id'),
    (fields) => fields.push('provider'),
    (fields) => fields.push('externalProvider'),
    (fields) => fields.push('trainingRunId'),
    (fields) => fields.push('sentence'),
    (fields) => fields.splice(fields.indexOf('sentence_id'), 1),
    (fields) => fields.splice(fields.indexOf('sentence_id'), 1, 'speaker_id'),
  ];
  for (const mutate of mutations) {
    const mutated = structuredClone(profile);
    mutate(mutated.selection.transientSourceFieldsAllowed);
    assert.throws(() => validateCandidateProfile(mutated), /exactly the approved in-memory fields/u);
  }
});

test('requires the complete exact persisted-manifest field set and validates any record', () => {
  const missing = structuredClone(profile);
  missing.selection.requiredManifestFields = ['clipId', 'audioSha256'];
  assert.throws(() => validateCandidateProfile(missing), /exactly the approved fields/);

  const extra = structuredClone(profile);
  extra.selection.requiredManifestFields.push('purpose');
  assert.throws(() => validateCandidateProfile(extra), /exactly the approved fields/);

  const populated = structuredClone(profile);
  populated.selection.clipManifest = [{
    locale: 'en',
    sourceDatasetId: 'cmu5jplf300nwmh07iqvk9leo',
    sourceRevision: 'cv-corpus-27.0-2026-09-11',
    sourceSplit: 'test',
    clipId: 'clip-1',
    audioSha256: 'a'.repeat(64),
  }];
  assert.throws(() => validateCandidateProfile(populated), /must not claim selected clips/);

  const malformedRecord = structuredClone(profile);
  malformedRecord.selection.clipManifest = [{ clipId: 'clip-1', audioSha256: 'a'.repeat(64) }];
  assert.throws(() => validateCandidateProfile(malformedRecord), /exactly the approved fields/);
});

test('keeps the offline, no-training, deletion, and 90-day aggregate policy', () => {
  validateCandidateProfile(profile);
  assert.equal(profile.execution.modelNetworkAccess, 'DISABLED');
  assert.equal(profile.execution.externalProviderDispatch, false);
  assert.equal(profile.execution.trainingAllowed, false);
  assert.equal(profile.execution.speakerIdentificationAllowed, false);
  assert.equal(profile.execution.voiceCloningAllowed, false);
  assert.equal(profile.execution.datasetRehostingOrResharingAllowed, false);
  assert.equal(profile.execution.audioRetention, 'DELETE_AFTER_EACH_RUN');
  assert.equal(profile.execution.interruptedRunAudioMaximumHours, 24);
  assert.equal(profile.execution.runManifestRetentionDays, 90);
  assert.equal(profile.execution.aggregateWerCerRetentionDays, 90);
  assert.equal(profile.execution.perClipReferenceRetention, 'MEMORY_ONLY');
  assert.equal(profile.execution.perClipPredictionRetention, 'MEMORY_ONLY');
});

test('records English archive presence without implying integrity or source authority', () => {
  validateCandidateProfile(profile);
  assert.equal(profile.englishSubset.sampleAvailability, 'NOT_REQUIRED_ARCHIVE_REPORTED_PRESENT');
  assert.equal(profile.englishSubset.publisherSampleLinkVisibleOnPublicCard, false);
  assert.equal(profile.englishSubset.publicTextSampleSentenceCount, 5);
  assert.equal(profile.englishSubset.sampleApiDocumentationUrl, 'https://mozilladatacollective.com/api-reference/docs');
  assert.match(profile.englishSubset.sampleVerificationNote, /No audio was extracted or decoded/);
  assert.equal(profile.englishSubset.fullArchiveDownloadAuthorization,
    'OWNER_CONFIRMED_ALREADY_ACQUIRED; NO_NEW_DOWNLOAD');
});

test('keeps any future clip IDs and hashes local and treats them as linkable data', () => {
  validateCandidateProfile(profile);
  assert.equal(profile.selection.persistedManifestPolicy.storage, 'ACCESS_CONTROLLED_LOCAL_ONLY');
  assert.equal(profile.selection.persistedManifestPolicy.publishClipIdsOrAudioHashes, false);
  assert.equal(profile.selection.persistedManifestPolicy.clipIdsAndAudioHashesAreDeidentification, false);
});
