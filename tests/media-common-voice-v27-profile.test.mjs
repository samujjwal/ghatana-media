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
  assert.deepEqual(profile.dataset.deferredLocales.hi, {
    locale: 'hi',
    datasetId: 'cmu5vlext009to107ev1s9lk8',
    datasetUrl: 'https://mozilladatacollective.com/datasets/cmu5vlext009to107ev1s9lk8',
    sourceRevision: 'cv-corpus-27.0-2026-09-11',
    license: 'CC0-1.0',
    officialTestSplit: 'test',
    officialTestClipCountAtReview: 3402,
    status: 'DEFERRED_FROM_THIS_PHASE',
    evaluationStatus: 'METADATA_ONLY_NO_DOWNLOAD_NO_EVALUATION',
    reason: 'Hindi is excluded from current evaluation, implementation, and acceptance work.',
  });
  assert.deepEqual(profile.selection.activeLocales, ['en', 'ne-NP']);
  assert.deepEqual(profile.selection.deferredLocales, ['hi']);
  assert.deepEqual(profile.selection.clipManifest, []);
  assert.equal(profile.execution.realInferenceAdmitted, false);
  assert.equal(profile.doesNotSupersede.includes('config/qualification/fleurs-asr-evaluation.v1.json'), true);
  assert.equal(profile.selection.clipManifestStatus,
    'PRIVATE_LOCAL_24_PER_LOCALE_MANIFEST_PREPARED_NOT_IN_SOURCE_CONTROL');
  assert.deepEqual(profile.selection.clipManifest, []);
});

test('Hindi metadata cannot enter active pilot, scoring, or inference scope', () => {
  const mutated = structuredClone(profile);
  mutated.dataset.activeLocaleScope.push('hi');
  assert.throws(() => validateCandidateProfile(mutated), /active Common Voice phase must contain English and Nepali only/u);

  const deferredAsActive = structuredClone(profile);
  deferredAsActive.selection.activeLocales = ['en', 'ne-NP', 'hi'];
  assert.throws(() => validateCandidateProfile(deferredAsActive), /selection must include English and Nepali only with Hindi deferred/u);

  const admitted = structuredClone(profile);
  admitted.execution.realInferenceAdmitted = true;
  assert.throws(() => validateCandidateProfile(admitted), /real inference must remain disabled/u);
});

test('does not turn owner confirmation into independently verified source authority', () => {
  const mutated = structuredClone(profile);
  mutated.access.authorityAndAcceptanceEvidenceStatus = 'VERIFIED';
  assert.throws(() => validateCandidateProfile(mutated), /distinct from independently verified source evidence/);
});

test('rejects an archive integrity claim that differs from the local streamed observation', () => {
  const mutated = structuredClone(profile);
  mutated.access.archivePresence.en.integrity = 'VERIFIED';
  assert.throws(() => validateCandidateProfile(mutated), /must match the locally streamed pilot/);
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
  assert.throws(() => validateCandidateProfile(mutated), /without copying clip IDs or hashes/);
});

test('pins a deterministic 24-clip transcript-independent pilot without asserting speaker disjointness', () => {
  validateCandidateProfile(profile);
  assert.equal(profile.selection.pilotProfile.clipsPerLocale, 24);
  assert.equal(profile.selection.pilotProfile.purpose, 'PILOT_ONLY_NOT_GENERAL_QUALITY_OR_ACCEPTANCE');
  assert.equal(profile.selection.pilotProfile.speakerDisjointEvidence, 'NOT_ESTABLISHED');

  const changedCount = structuredClone(profile);
  changedCount.selection.pilotProfile.clipsPerLocale = 100;
  assert.throws(() => validateCandidateProfile(changedCount), /deterministic, transcript-independent/u);

  const changedRanking = structuredClone(profile);
  changedRanking.selection.pilotProfile.ranking = 'sort by transcript text';
  assert.throws(() => validateCandidateProfile(changedRanking), /deterministic, transcript-independent/u);

  const claimedDisjoint = structuredClone(profile);
  claimedDisjoint.selection.pilotProfile.speakerDisjointEvidence = 'VERIFIED';
  assert.throws(() => validateCandidateProfile(claimedDisjoint), /deterministic, transcript-independent/u);
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
  assert.throws(() => validateCandidateProfile(populated), /without copying clip IDs or hashes/);

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

test('records local archive and private pilot completion without exposing IDs or hashes', () => {
  validateCandidateProfile(profile);
  assert.equal(profile.access.archivePresence.en.testRowsObservedLocally, 16403);
  assert.equal(profile.access.archivePresence['ne-NP'].testRowsObservedLocally, 302);
  assert.match(profile.access.archivePresence.en.integrity, /24_PILOT_MP3_HASHES_RETAINED_PRIVATELY/u);
  assert.equal(profile.selection.clipManifest.length, 0);
  assert.equal(profile.execution.realInferenceAdmitted, false);
  assert.equal(profile.execution.independentReferenceReviewStatus, 'NOT_COMPLETED');
  assert.equal(profile.execution.executionHostQualificationStatus, 'NOT_QUALIFIED');
  assert.equal(profile.execution.pilotEvaluationScope, '24_CLIPS_PER_ACTIVE_LOCALE_REFERENCE_ONLY');
  assert.equal(profile.execution.pilotCanQualifyModel, false);
  assert.equal(profile.selection.trustedManifestDigestSource,
    'ACCESS_CONTROLLED_LOCAL_PILOT_MANIFEST_PER_LOCALE; REQUIRED_BY_QUALITY_READER; NEVER_CHECKED_IN_OR_PRINTED');
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
