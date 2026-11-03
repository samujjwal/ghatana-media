import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { validateCandidateProfile } from '../scripts/qualification/check-common-voice-v27-profile.mjs';

const profileUrl = new URL('../config/qualification/common-voice-v27-asr-alternative.v1.json', import.meta.url);
const profile = JSON.parse(await readFile(profileUrl, 'utf8'));

test('pins the three Common Voice v27 ASR datasets and keeps the candidate separate from FLEURS', () => {
  const result = validateCandidateProfile(profile);
  assert.deepEqual(result, {
    profileId: 'media.stt.common-voice-scripted-speech-27-alternative',
    metadataValid: true,
    realInferenceAdmitted: false,
    datasetAccessProven: false,
  });
  assert.equal(profile.dataset.locales.en.datasetId, 'cmu5jplf300nwmh07iqvk9leo');
  assert.equal(profile.dataset.locales.hi.datasetId, 'cmu5vlext009to107ev1s9lk8');
  assert.equal(profile.dataset.locales.ne.datasetId, 'cmu61478v00j9o107alzuue1z');
  assert.equal(profile.doesNotSupersede.includes('config/qualification/fleurs-asr-evaluation.v1.json'), true);
});

test('does not turn local access booleans into an admission record', () => {
  const mutated = structuredClone(profile);
  mutated.access.consumerTermsAccepted = true;
  mutated.access.acceptedAt = '2026-11-03T00:00:00.000Z';
  assert.throws(() => validateCandidateProfile(mutated), /locally asserted MDC access acceptance/);
});

test('blocks selected clips until the authorized-access and clip-manifest path exists', () => {
  const mutated = structuredClone(profile);
  mutated.selection.clipManifest = [{
    locale: 'en',
    sourceDatasetId: 'cmu5jplf300nwmh07iqvk9leo',
    sourceRevision: 'cv-corpus-27.0-2026-09-11',
    sourceSplit: 'test',
    clipId: 'clip-1',
    audioSha256: 'a'.repeat(64),
  }];
  assert.throws(() => validateCandidateProfile(mutated), /cannot include selected clips/);
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
  assert.throws(() => validateCandidateProfile(populated), /cannot include selected clips/);

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

test('keeps the English publisher-sample status unresolved and full download unauthorized', () => {
  validateCandidateProfile(profile);
  assert.equal(profile.englishSubset.sampleAvailability, 'NOT_VERIFIED');
  assert.equal(profile.englishSubset.fullArchiveDownloadAuthorized, false);
});

test('keeps any future clip IDs and hashes local and treats them as linkable data', () => {
  validateCandidateProfile(profile);
  assert.equal(profile.selection.persistedManifestPolicy.storage, 'ACCESS_CONTROLLED_LOCAL_ONLY');
  assert.equal(profile.selection.persistedManifestPolicy.publishClipIdsOrAudioHashes, false);
  assert.equal(profile.selection.persistedManifestPolicy.clipIdsAndAudioHashesAreDeidentification, false);
});
