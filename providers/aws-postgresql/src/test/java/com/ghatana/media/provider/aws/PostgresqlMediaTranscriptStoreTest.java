package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptPrincipalConflictException;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevisionConflictException;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDerivedCapability;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptCapabilityDisposition;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaTranscriptStoreTest {

    @Test
    void unsupportedDerivedOperationsAreTypedNoEffectAndPersistNoCaptionVersion() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            for (TranscriptDerivedCapability capability : TranscriptDerivedCapability.values()) {
                var result = store.capability(capability);
                assertThat(result.disposition()).isEqualTo(TranscriptCapabilityDisposition.UNMET_CAPABILITY);
                assertThat(result.effectOccurred()).isFalse();
                assertThat(result.blockers()).isNotEmpty();
            }
            assertThat(store.revisions("tenant-capability", "principal-a", "transcript-capability")).isEmpty();
        }
    }
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    @Test
    void persistsImmutableCandidateRevisionsAndRejectsUnboundOrRevokedInputs() throws Exception {
        try (Fixture fixture = openFixture()) {
            PostgresqlMediaTranscriptStore store = fixture.store();
            MediaAwsPostgresqlRuntimeState testState = fixture.state();
            String digest = "a".repeat(64);
            seed(testState, "tenant-a", "principal-a", "source-a", "job-a", "consent-a", digest, false);
            TranscriptDraft first = draft("tenant-a", "principal-a", "transcript-a", "source-a", "job-a", "consent-a", digest, "hello");
            var revision1 = store.append(first);
            assertThat(revision1.revision()).isEqualTo(1);
            assertThat(revision1.admissionStatus()).isEqualTo("CANDIDATE");
            assertThat(revision1.draft().purposeRef()).isEqualTo("urn:media:purpose:transcription");
            assertThat(revision1.draft().processingPurpose()).isEqualTo("transcription");
            assertThat(store.append(first)).isEqualTo(revision1); // retry is idempotent

            var revision2 = store.append(draft("tenant-a", "principal-a", "transcript-a", "source-a", "job-a", "consent-a", digest, "hello again"), 1);
            assertThat(revision2.revision()).isEqualTo(2);
            assertThat(store.revisions("tenant-a", "principal-a", "transcript-a")).extracting(r -> r.draft().text())
                    .containsExactly("hello", "hello again");
            assertThat(store.revisions("tenant-a", "principal-a", "transcript-a"))
                    .allSatisfy(revision -> {
                        assertThat(revision.draft().purposeRef()).isEqualTo("urn:media:purpose:transcription");
                        assertThat(revision.draft().processingPurpose()).isEqualTo("transcription");
                    });

            TranscriptDraft stalePin = draft("tenant-a", "principal-a", "transcript-stale", "source-a", "job-a", "consent-a", "b".repeat(64), "not stored");
            assertThatThrownBy(() -> store.append(stalePin)).isInstanceOf(IllegalStateException.class);
            assertThat(store.revisions("tenant-a", "principal-a", "transcript-stale")).isEmpty();
            assertThat(store.revisions("tenant-b", "principal-a", "transcript-a")).isEmpty();

            String revokedDigest = "c".repeat(64);
            seed(testState, "tenant-a", "principal-a", "source-revoked", "job-revoked", "consent-revoked", revokedDigest, true);
            TranscriptDraft revoked = draft("tenant-a", "principal-a", "transcript-revoked", "source-revoked", "job-revoked", "consent-revoked", revokedDigest, "denied");
            assertThatThrownBy(() -> store.append(revoked)).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("revoked");
            assertThat(store.revisions("tenant-a", "principal-a", "transcript-revoked")).isEmpty();

            TranscriptDraft foreign = draft("tenant-b", "principal-b", "transcript-foreign", "source-a", "job-a", "consent-a", digest, "denied");
            assertThatThrownBy(() -> store.append(foreign)).isInstanceOf(IllegalStateException.class);
            assertThat(store.revisions("tenant-b", "principal-b", "transcript-foreign")).isEmpty();
        }
    }

    @Test
    void rejectsUnboundAndConsentMismatchedPurposesWithoutPersisting() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digest = "b".repeat(64);
            seed(state, "tenant-purpose", "principal-a", "source-purpose", "job-purpose", "consent-purpose", digest, false);

            TranscriptDraft wrongPurpose = draft("tenant-purpose", "principal-a", "transcript-wrong-purpose",
                    "source-purpose", "job-purpose", "consent-purpose", digest, "denied", "summarization");
            assertThatThrownBy(() -> store.append(wrongPurpose))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("purpose");
            assertThat(store.revisions("tenant-purpose", "principal-a", "transcript-wrong-purpose")).isEmpty();

            TranscriptDraft bound = draft("tenant-purpose", "principal-a", "transcript-unbound-purpose",
                    "source-purpose", "job-purpose", "consent-purpose", digest, "denied");
            TranscriptDraft unbound = new TranscriptDraft(bound.tenantId(), bound.principalId(), bound.transcriptId(),
                    bound.sourceArtifactId(), bound.sourceVersion(), bound.sourceSha256(), bound.jobId(),
                    bound.profileId(), bound.providerId(), bound.modelId(), bound.language(), bound.timebase(),
                    bound.text(), bound.consentDecisionId(), bound.rightsDecisionId(), bound.policyVersion());
            assertThat(unbound.purposeRef()).isEqualTo(
                    com.ghatana.media.runtime.MediaTranscriptContracts.UNBOUND_PURPOSE_REF);
            assertThat(unbound.processingPurpose()).isEqualTo(
                    com.ghatana.media.runtime.MediaTranscriptContracts.UNRESOLVED_PROCESSING_PURPOSE);
            assertThatThrownBy(() -> store.append(unbound))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("purpose");
            assertThat(store.revisions("tenant-purpose", "principal-a", "transcript-unbound-purpose")).isEmpty();
        }
    }

    @Test
    void consentPurposeMatchingUsesCanonicalCaseAndWildcardSemantics() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digest = "c".repeat(64);
            seed(state, "tenant-purpose-wildcard", "principal-a", "source-purpose-wildcard",
                    "job-purpose-wildcard", "consent-purpose-wildcard", digest, false, "*");

            TranscriptDraft candidate = draft("tenant-purpose-wildcard", "principal-a", "transcript-purpose-wildcard",
                    "source-purpose-wildcard", "job-purpose-wildcard", "consent-purpose-wildcard",
                    digest, "candidate", "Transcription");
            assertThat(store.append(candidate).draft().processingPurpose()).isEqualTo("Transcription");
        }
    }

    @Test
    void consentRowLockSerializesAppendAgainstConcurrentRevocation() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digest = "9".repeat(64);
            seed(state, "tenant-revoke-race", "principal-a", "source-revoke-race", "job-revoke-race",
                    "consent-revoke-race", digest, false);
            TranscriptDraft candidate = draft("tenant-revoke-race", "principal-a", "transcript-revoke-race",
                    "source-revoke-race", "job-revoke-race", "consent-revoke-race", digest, "must not persist");

            ExecutorService executor = Executors.newSingleThreadExecutor();
            try (Connection revoker = state.connection()) {
                revoker.setAutoCommit(false);
                try (PreparedStatement lock = revoker.prepareStatement(
                        "SELECT consent_id FROM media_consents WHERE tenant_id=? AND consent_id=? FOR UPDATE")) {
                    lock.setString(1, "tenant-revoke-race");
                    lock.setString(2, "consent-revoke-race");
                    try (var rows = lock.executeQuery()) { assertThat(rows.next()).isTrue(); }
                }

                Future<?> append = executor.submit(() -> store.append(candidate));
                Thread.sleep(250);
                assertThat(append.isDone()).as("append must wait for the consent row lock").isFalse();
                try (PreparedStatement revoke = revoker.prepareStatement(
                        "UPDATE media_consents SET revoked_at=?,version=version+1 WHERE tenant_id=? AND consent_id=?")) {
                    revoke.setLong(1, System.currentTimeMillis());
                    revoke.setString(2, "tenant-revoke-race");
                    revoke.setString(3, "consent-revoke-race");
                    assertThat(revoke.executeUpdate()).isEqualTo(1);
                }
                revoker.commit();
                assertThatThrownBy(() -> append.get(10, TimeUnit.SECONDS))
                        .isInstanceOf(ExecutionException.class)
                        .hasRootCauseInstanceOf(IllegalStateException.class)
                        .hasRootCauseMessage("Transcript consent is missing, revoked, or expired");
                assertThat(store.revisions("tenant-revoke-race", "principal-a", "transcript-revoke-race")).isEmpty();
            } finally {
                executor.shutdownNow();
            }
        }
    }

    @Test
    void changedDraftRequiresCurrentExpectedRevisionAndLegacyAppendCannotBypassCas() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digest = "d".repeat(64);
            seed(state, "tenant-cas", "principal-a", "source-cas", "job-cas", "consent-cas", digest, false);
            TranscriptDraft initial = draft("tenant-cas", "principal-a", "transcript-cas", "source-cas",
                    "job-cas", "consent-cas", digest, "initial");
            var first = store.append(initial, 0);
            assertThat(store.append(initial, 0)).isEqualTo(first); // exact retry is a no-op

            TranscriptDraft correction = draft("tenant-cas", "principal-a", "transcript-cas", "source-cas",
                    "job-cas", "consent-cas", digest, "corrected");
            assertThatThrownBy(() -> store.append(correction))
                    .isInstanceOf(TranscriptRevisionConflictException.class)
                    .satisfies(failure -> {
                        var conflict = (TranscriptRevisionConflictException) failure;
                        assertThat(conflict.expectedLatestRevision()).isZero();
                        assertThat(conflict.actualLatestRevision()).isEqualTo(1);
                    });
            var second = store.append(correction, 1);
            assertThat(second.revision()).isEqualTo(2);

            TranscriptDraft staleCorrection = draft("tenant-cas", "principal-a", "transcript-cas", "source-cas",
                    "job-cas", "consent-cas", digest, "stale correction");
            assertThatThrownBy(() -> store.append(staleCorrection, 1))
                    .isInstanceOf(TranscriptRevisionConflictException.class)
                    .satisfies(failure -> assertThat(
                            ((TranscriptRevisionConflictException) failure).actualLatestRevision()).isEqualTo(2));
            assertThat(store.revisions("tenant-cas", "principal-a", "transcript-cas"))
                    .extracting(value -> value.draft().text())
                    .containsExactly("initial", "corrected");
        }
    }

    @Test
    void candidateRevisionReadsBackAfterRuntimeStateRecreationAndExactRetryIsIdempotent() throws Exception {
        try (Fixture fixture = openFixture()) {
            var originalState = fixture.state();
            String bucket = originalState.bucket();
            String digest = "7".repeat(64);
            seed(originalState, "tenant-reopen", "principal-a", "source-reopen", "job-reopen",
                    "consent-reopen", digest, false);
            TranscriptDraft original = draft("tenant-reopen", "principal-a", "transcript-reopen",
                    "source-reopen", "job-reopen", "consent-reopen", digest, "candidate result");

            var first = fixture.store().append(original, 0);
            fixture.store().close();
            originalState.release();
            fixture.installed().close();

            AutoCloseable restartedInstallation =
                    MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
            try (restartedInstallation;
                 PostgresqlMediaTranscriptStore reopened = new PostgresqlMediaTranscriptStore()) {
                assertThat(reopened.productionEligible()).isFalse();
                assertThat(reopened.revisions("tenant-reopen", "principal-a", "transcript-reopen"))
                        .containsExactly(first);
                assertThat(reopened.append(original, 0)).isEqualTo(first);
                assertThat(reopened.revisions("tenant-reopen", "principal-a", "transcript-reopen"))
                        .containsExactly(first);

                TranscriptDraft changed = draft("tenant-reopen", "principal-a", "transcript-reopen",
                        "source-reopen", "job-reopen", "consent-reopen", digest, "changed candidate result");
                assertThatThrownBy(() -> reopened.append(changed, 0))
                        .isInstanceOf(TranscriptRevisionConflictException.class);
                assertThat(reopened.revisions("tenant-reopen", "principal-a", "transcript-reopen"))
                        .containsExactly(first);
            }
        }
    }

    @Test
    void candidateFinalizationRequiresExactSuccessfulAttemptResultAndBindsItAtomically() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digest = "8".repeat(64);
            String fingerprint = "a".repeat(64);
            String versionRef = "urn:media:transcript-version:attempt-v1";
            seed(state, "tenant-attempt", "principal-a", "source-attempt", "job-attempt", "consent-attempt", digest, false);
            seedSuccessfulAttempt(state, "tenant-attempt", "principal-a", "source-attempt", "job-attempt",
                    digest, fingerprint, 1, 17, versionRef, "candidate words", "provider-op-1", "provider-receipt-1");
            try (Connection connection = state.connection(); PreparedStatement query = connection.prepareStatement(
                    "SELECT request_fingerprint FROM media_processing_jobs WHERE tenant_id=? AND job_id=?")) {
                query.setString(1, "tenant-attempt"); query.setString(2, "job-attempt");
                try (var row = query.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getString(1)).isEqualTo("sha256:" + fingerprint).isNotEqualTo(fingerprint);
                }
            }
            TranscriptDraft candidate = draft("tenant-attempt", "principal-a", "transcript-attempt", "source-attempt",
                    "job-attempt", "consent-attempt", digest, "candidate words");

            var first = store.appendFromSuccessfulAttempt(candidate, 0, 1, 17, fingerprint, versionRef);
            assertThat(first.admissionStatus()).isEqualTo("CANDIDATE");
            assertThat(store.productionEligible()).isFalse();
            assertThat(store.attemptBinding("tenant-attempt", "transcript-attempt", 1))
                    .satisfies(binding -> {
                        assertThat(binding.attemptNumber()).isEqualTo(1);
                        assertThat(binding.fencingToken()).isEqualTo(17);
                        assertThat(binding.providerId()).isEqualTo("provider-a");
                        assertThat(binding.providerOperationId()).isEqualTo("provider-op-1");
                        assertThat(binding.providerReceiptId()).isEqualTo("provider-receipt-1");
                        assertThat(binding.requestFingerprint()).isEqualTo(fingerprint);
                        assertThat(binding.sourceArtifactVersionRef()).isEqualTo("sha256:" + digest);
                        assertThat(binding.transcriptVersionRef()).isEqualTo(versionRef);
                    });
            assertThat(store.appendFromSuccessfulAttempt(candidate, 0, 1, 17, fingerprint, versionRef))
                    .isEqualTo(first);

            assertNoBoundRevision(store, candidate, 0, 1, 17, "b".repeat(64), versionRef);
            assertNoBoundRevision(store, candidate, 0, 1, 17, fingerprint, "urn:media:transcript-version:other");
            assertNoBoundRevision(store, draft("tenant-attempt", "principal-a", "wrong-ref", "source-attempt",
                    "job-attempt", "consent-attempt", digest, "candidate words"), 0, 1, 17, fingerprint, "wrong-ref");
            assertNoBoundRevision(store, draft("tenant-attempt", "principal-a", "wrong-text", "source-attempt",
                    "job-attempt", "consent-attempt", digest, "caller invented text"), 0, 1, 17, fingerprint, "wrong-text");
            TranscriptDraft foreignTenant = draft("tenant-other", "principal-a", "transcript-other", "source-attempt",
                    "job-attempt", "consent-attempt", digest, "candidate words");
            assertNoBoundRevision(store, foreignTenant, 0, 1, 17, fingerprint, "transcript-other");
            assertNoBoundRevision(store, candidate, 0, 1, 18, fingerprint, versionRef);
            assertNoBoundRevision(store, candidate, 0, 2, 17, fingerprint, versionRef);
            TranscriptDraft wrongProvider = new TranscriptDraft(candidate.tenantId(), candidate.principalId(),
                    candidate.transcriptId(), candidate.sourceArtifactId(), candidate.sourceVersion(),
                    candidate.sourceSha256(), candidate.jobId(), candidate.profileId(), "provider-b", candidate.modelId(),
                    candidate.language(), candidate.timebase(), candidate.text(), candidate.consentDecisionId(),
                    candidate.rightsDecisionId(), candidate.policyVersion(), candidate.purposeRef(), candidate.processingPurpose());
            assertNoBoundRevision(store, wrongProvider, 0, 1, 17, fingerprint, versionRef);
            assertThat(store.revisions("tenant-attempt", "principal-a", "transcript-attempt")).containsExactly(first);
        }
    }

    @Test
    void requestSnapshotMustMatchGlossaryObservationAndLegacyUnknownFailsClosed() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store(); var state = fixture.state();
            String digest = "d".repeat(64), fingerprint = "e".repeat(64), ref = "glossary:en:v4";
            seed(state, "tenant-snapshot", "principal-a", "source-snapshot", "job-snapshot",
                    "consent-snapshot", digest, false);
            setSttSnapshot(state, "tenant-snapshot", "job-snapshot", ref, false);
            seedSuccessfulAttempt(state, "tenant-snapshot", "principal-a", "source-snapshot", "job-snapshot",
                    digest, fingerprint, 1, 41, "transcript-snapshot", "exact words", "op-snapshot", "receipt-snapshot");
            String applied = semanticResult(state, digest, fingerprint, "transcript-snapshot", "exact words",
                    "APPLIED", ref, null, false, false, false);
            replaceAttemptResult(state, "tenant-snapshot", "job-snapshot", applied);
            var candidate = draft("tenant-snapshot", "principal-a", "transcript-snapshot", "source-snapshot",
                    "job-snapshot", "consent-snapshot", digest, "exact words");
            assertThat(store.appendFromSuccessfulAttempt(candidate, 0, 1, 41, fingerprint, "transcript-snapshot").revision())
                    .isEqualTo(1);

            String mismatch = semanticResult(state, digest, fingerprint, "transcript-snapshot-2", "exact words",
                    "APPLIED", "glossary:en:other", null, false, false, false);
            seed(state, "tenant-snapshot-mismatch", "principal-a", "source-snapshot-mismatch", "job-snapshot-mismatch",
                    "consent-snapshot-mismatch", digest, false);
            setSttSnapshot(state, "tenant-snapshot-mismatch", "job-snapshot-mismatch", ref, false);
            seedSuccessfulAttempt(state, "tenant-snapshot-mismatch", "principal-a", "source-snapshot-mismatch", "job-snapshot-mismatch",
                    digest, fingerprint, 1, 42, "transcript-snapshot-2", "exact words", "op-mismatch", "receipt-mismatch");
            replaceAttemptResult(state, "tenant-snapshot-mismatch", "job-snapshot-mismatch", mismatch);
            assertNoBoundRevision(store, draft("tenant-snapshot-mismatch", "principal-a", "transcript-snapshot-2",
                    "source-snapshot-mismatch", "job-snapshot-mismatch", "consent-snapshot-mismatch", digest, "exact words"),
                    0, 1, 42, fingerprint, "transcript-snapshot-2");

            seed(state, "tenant-snapshot-legacy", "principal-a", "source-snapshot-legacy", "job-snapshot-legacy",
                    "consent-snapshot-legacy", digest, false);
            clearSttSnapshot(state, "tenant-snapshot-legacy", "job-snapshot-legacy");
            seedSuccessfulAttempt(state, "tenant-snapshot-legacy", "principal-a", "source-snapshot-legacy", "job-snapshot-legacy",
                    digest, fingerprint, 1, 43, "transcript-snapshot-legacy", "exact words", "op-legacy", "receipt-legacy");
            assertNoBoundRevision(store, draft("tenant-snapshot-legacy", "principal-a", "transcript-snapshot-legacy",
                    "source-snapshot-legacy", "job-snapshot-legacy", "consent-snapshot-legacy", digest, "exact words"),
                    0, 1, 43, fingerprint, "transcript-snapshot-legacy");

            seed(state, "tenant-snapshot-corrupt", "principal-a", "source-snapshot-corrupt", "job-snapshot-corrupt",
                    "consent-snapshot-corrupt", digest, false);
            setRawSttSnapshot(state, "tenant-snapshot-corrupt", "job-snapshot-corrupt",
                    "{\"version\":\"media.stt-request-snapshot.v1\",\"customGlossaryRef\":\""
                            + "x".repeat(385) + "\",\"fillerRetakeCandidates\":\"false\",\"unexpected\":true}");
            seedSuccessfulAttempt(state, "tenant-snapshot-corrupt", "principal-a", "source-snapshot-corrupt", "job-snapshot-corrupt",
                    digest, fingerprint, 1, 44, "transcript-snapshot-corrupt", "exact words", "op-corrupt", "receipt-corrupt");
            assertNoBoundRevision(store, draft("tenant-snapshot-corrupt", "principal-a", "transcript-snapshot-corrupt",
                    "source-snapshot-corrupt", "job-snapshot-corrupt", "consent-snapshot-corrupt", digest, "exact words"),
                    0, 1, 44, fingerprint, "transcript-snapshot-corrupt");

            seed(state, "tenant-snapshot-contradictory", "principal-a", "source-snapshot-contradictory", "job-snapshot-contradictory",
                    "consent-snapshot-contradictory", digest, false);
            seedSuccessfulAttempt(state, "tenant-snapshot-contradictory", "principal-a", "source-snapshot-contradictory", "job-snapshot-contradictory",
                    digest, fingerprint, 1, 45, "transcript-snapshot-contradictory", "exact words", "op-contradictory", "receipt-contradictory");
            String contradictory = semanticResult(state, digest, fingerprint, "transcript-snapshot-contradictory", "exact words",
                    "NOT_REQUESTED", "glossary:unexpected", null, false, false, false);
            replaceAttemptResult(state, "tenant-snapshot-contradictory", "job-snapshot-contradictory", contradictory);
            assertNoBoundRevision(store, draft("tenant-snapshot-contradictory", "principal-a", "transcript-snapshot-contradictory",
                    "source-snapshot-contradictory", "job-snapshot-contradictory", "consent-snapshot-contradictory", digest, "exact words"),
                    0, 1, 45, fingerprint, "transcript-snapshot-contradictory");

            seed(state, "tenant-snapshot-oversized", "principal-a", "source-snapshot-oversized", "job-snapshot-oversized",
                    "consent-snapshot-oversized", digest, false);
            setRawSttSnapshot(state, "tenant-snapshot-oversized", "job-snapshot-oversized", " ".repeat(4_097));
            seedSuccessfulAttempt(state, "tenant-snapshot-oversized", "principal-a", "source-snapshot-oversized", "job-snapshot-oversized",
                    digest, fingerprint, 1, 46, "transcript-snapshot-oversized", "exact words", "op-oversized", "receipt-oversized");
            assertNoBoundRevision(store, draft("tenant-snapshot-oversized", "principal-a", "transcript-snapshot-oversized",
                    "source-snapshot-oversized", "job-snapshot-oversized", "consent-snapshot-oversized", digest, "exact words"),
                    0, 1, 46, fingerprint, "transcript-snapshot-oversized");
        }
    }

    @Test
    void rejectsUnknownAndDigestCorruptAttemptsWithoutTranscriptWrites() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digest = "9".repeat(64);
            String fingerprint = "c".repeat(64);
            seed(state, "tenant-attempt-bad", "principal-a", "source-attempt-bad", "job-attempt-bad", "consent-attempt-bad", digest, false);
            TranscriptDraft candidate = draft("tenant-attempt-bad", "principal-a", "transcript-bad", "source-attempt-bad",
                    "job-attempt-bad", "consent-attempt-bad", digest, "stored words");
            assertNoBoundRevision(store, candidate, 0, 1, 27, fingerprint, "transcript-bad");
            seedSuccessfulAttempt(state, "tenant-attempt-bad", "principal-a", "source-attempt-bad", "job-attempt-bad",
                    digest, fingerprint, 1, 27, "transcript-bad", "stored words", "provider-op-2", "provider-receipt-2");

            String matchingResult = semanticResult(state, digest, fingerprint, "transcript-bad", "stored words",
                    "NOT_REQUESTED", null, null, false, false, false);
            String matchingResultDigest = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest(matchingResult.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            try (Connection connection = state.connection(); PreparedStatement corrupt = connection.prepareStatement(
                    "UPDATE media_processing_attempts SET result_digest=? WHERE tenant_id=? AND job_id=? AND attempt_number=1")) {
                corrupt.setString(1, "0".repeat(64)); corrupt.setString(2, "tenant-attempt-bad");
                corrupt.setString(3, "job-attempt-bad"); corrupt.executeUpdate();
            }
            assertNoBoundRevision(store, candidate, 0, 1, 27, fingerprint, "transcript-bad");
            try (Connection connection = state.connection(); PreparedStatement unknown = connection.prepareStatement(
                    "UPDATE media_processing_attempts SET state='OUTCOME_UNKNOWN',result_digest=? WHERE tenant_id=? AND job_id=? AND attempt_number=1")) {
                unknown.setString(1, matchingResultDigest); unknown.setString(2, "tenant-attempt-bad");
                unknown.setString(3, "job-attempt-bad"); unknown.executeUpdate();
            }
            assertNoBoundRevision(store, candidate, 0, 1, 27, fingerprint, "transcript-bad");
            assertThat(store.revisions("tenant-attempt-bad", "principal-a", "transcript-bad")).isEmpty();
        }
    }

    @Test
    void rejectsMalformedPdpTranscriptResponseWithoutWritingCandidates() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digest = "f".repeat(64);
            String fingerprint = "1".repeat(64);
            String versionRef = "urn:media:transcript-version:shape-v1";
            seed(state, "tenant-response-shape", "principal-a", "source-response-shape", "job-response-shape",
                    "consent-response-shape", digest, false);
            seedSuccessfulAttempt(state, "tenant-response-shape", "principal-a", "source-response-shape",
                    "job-response-shape", digest, fingerprint, 1, 47, versionRef, "exact words",
                    "provider-op-shape", "provider-receipt-shape");
            TranscriptDraft candidate = draft("tenant-response-shape", "principal-a", "transcript-response-shape",
                    "source-response-shape", "job-response-shape", "consent-response-shape", digest, "exact words");

            String missingDisposition = semanticResult(state, digest, fingerprint, versionRef, "exact words",
                    "NOT_REQUESTED", null, null, true, false, false);
            replaceAttemptResult(state, "tenant-response-shape", "job-response-shape", missingDisposition);
            assertNoBoundRevision(store, candidate, 0, 1, 47, fingerprint, versionRef);

            String invalidDisposition = semanticResult(state, digest, fingerprint, versionRef, "exact words",
                    "NOT_REQUESTED", null, "UNKNOWN", false, false, false);
            replaceAttemptResult(state, "tenant-response-shape", "job-response-shape", invalidDisposition);
            assertNoBoundRevision(store, candidate, 0, 1, 47, fingerprint, versionRef);

            String extraProperty = semanticResult(state, digest, fingerprint, versionRef, "exact words",
                    "NOT_REQUESTED", null, null, false, true, false);
            replaceAttemptResult(state, "tenant-response-shape", "job-response-shape", extraProperty);
            assertNoBoundRevision(store, candidate, 0, 1, 47, fingerprint, versionRef);

            String overlongText = semanticResult(state, digest, fingerprint, versionRef, "exact words",
                    "NOT_REQUESTED", null, null, false, false, true);
            replaceAttemptResult(state, "tenant-response-shape", "job-response-shape", overlongText);
            assertNoBoundRevision(store, candidate, 0, 1, 47, fingerprint, versionRef);
            assertThat(store.revisions("tenant-response-shape", "principal-a", "transcript-response-shape")).isEmpty();
        }
    }

    @Test
    void concurrentExactBoundAppendsResolveAsOneIdempotentRevision() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digest = "2".repeat(64);
            String fingerprint = "3".repeat(64);
            String versionRef = "urn:media:transcript-version:concurrent-v1";
            seed(state, "tenant-attempt-race", "principal-a", "source-attempt-race", "job-attempt-race",
                    "consent-attempt-race", digest, false);
            seedSuccessfulAttempt(state, "tenant-attempt-race", "principal-a", "source-attempt-race",
                    "job-attempt-race", digest, fingerprint, 1, 57, versionRef, "same exact text",
                    "provider-op-race", "provider-receipt-race");
            TranscriptDraft candidate = draft("tenant-attempt-race", "principal-a", "transcript-attempt-race",
                    "source-attempt-race", "job-attempt-race", "consent-attempt-race", digest, "same exact text");
            int writers = 4;
            ExecutorService executor = Executors.newFixedThreadPool(writers);
            CountDownLatch ready = new CountDownLatch(writers);
            CountDownLatch start = new CountDownLatch(1);
            List<Future<com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision>> futures = new ArrayList<>();
            try {
                for (int i = 0; i < writers; i++) {
                    futures.add(executor.submit(() -> {
                        ready.countDown();
                        if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("writers did not start");
                        return store.appendFromSuccessfulAttempt(candidate, 0, 1, 57, fingerprint, versionRef);
                    }));
                }
                assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
                start.countDown();
                var revisions = new ArrayList<com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision>();
                for (Future<com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision> future : futures) {
                    revisions.add(future.get(20, TimeUnit.SECONDS));
                }
                assertThat(revisions).hasSize(writers).containsOnly(revisions.get(0));
                assertThat(store.revisions("tenant-attempt-race", "principal-a", "transcript-attempt-race"))
                        .containsExactly(revisions.get(0));

                seedSuccessfulAttempt(state, "tenant-attempt-race", "principal-a", "source-attempt-race",
                        "job-attempt-race", digest, fingerprint, 2, 58, versionRef, "same exact text",
                        "provider-op-race-2", "provider-receipt-race-2");
                assertThatThrownBy(() -> store.appendFromSuccessfulAttempt(candidate, 1, 2, 58, fingerprint, versionRef))
                        .isInstanceOf(TranscriptRevisionConflictException.class);
                assertThat(store.revisions("tenant-attempt-race", "principal-a", "transcript-attempt-race"))
                        .containsExactly(revisions.get(0));
            } finally {
                start.countDown(); executor.shutdownNow();
            }
        }
    }

    @Test
    void concurrentDifferentBoundDraftsProduceTypedCasConflict() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digest = "4".repeat(64);
            String fingerprint = "5".repeat(64);
            seed(state, "tenant-attempt-different-race", "principal-a", "source-attempt-different-race",
                    "job-attempt-different-race", "consent-attempt-different-race", digest, false);
            seedSuccessfulAttempt(state, "tenant-attempt-different-race", "principal-a", "source-attempt-different-race",
                    "job-attempt-different-race", digest, fingerprint, 1, 67,
                    "urn:media:transcript-version:different-a", "candidate alpha", "provider-op-different-a",
                    "provider-receipt-different-a");
            seedSuccessfulAttempt(state, "tenant-attempt-different-race", "principal-a", "source-attempt-different-race",
                    "job-attempt-different-race", digest, fingerprint, 2, 68,
                    "urn:media:transcript-version:different-b", "candidate beta", "provider-op-different-b",
                    "provider-receipt-different-b");
            TranscriptDraft first = draft("tenant-attempt-different-race", "principal-a", "transcript-different-race",
                    "source-attempt-different-race", "job-attempt-different-race", "consent-attempt-different-race",
                    digest, "candidate alpha");
            TranscriptDraft second = draft("tenant-attempt-different-race", "principal-a", "transcript-different-race",
                    "source-attempt-different-race", "job-attempt-different-race", "consent-attempt-different-race",
                    digest, "candidate beta");
            ExecutorService executor = Executors.newFixedThreadPool(2);
            CountDownLatch ready = new CountDownLatch(2);
            CountDownLatch start = new CountDownLatch(1);
            List<Future<TranscriptRevisionOutcome>> futures = new ArrayList<>();
            try {
                futures.add(executor.submit(() -> appendOutcome(store, first, 1, 67, fingerprint,
                        "urn:media:transcript-version:different-a", ready, start)));
                futures.add(executor.submit(() -> appendOutcome(store, second, 2, 68, fingerprint,
                        "urn:media:transcript-version:different-b", ready, start)));
                assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue(); start.countDown();
                var outcomes = List.of(futures.get(0).get(20, TimeUnit.SECONDS), futures.get(1).get(20, TimeUnit.SECONDS));
                assertThat(outcomes).filteredOn(TranscriptRevisionOutcome::committed).hasSize(1);
                assertThat(outcomes).filteredOn(outcome -> !outcome.committed()).hasSize(1);
                assertThat(outcomes.stream().filter(outcome -> !outcome.committed())
                        .map(TranscriptRevisionOutcome::conflict)).allSatisfy(conflict -> {
                            assertThat(conflict.expectedLatestRevision()).isZero();
                            assertThat(conflict.actualLatestRevision()).isEqualTo(1);
                        });
                assertThat(store.revisions("tenant-attempt-different-race", "principal-a", "transcript-different-race"))
                        .hasSize(1);
            } finally {
                start.countDown(); executor.shutdownNow();
            }
        }
    }

    private static TranscriptRevisionOutcome appendOutcome(PostgresqlMediaTranscriptStore store, TranscriptDraft draft,
            int attempt, long fence, String fingerprint, String versionRef, CountDownLatch ready, CountDownLatch start)
            throws Exception {
        ready.countDown();
        if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("writers did not start");
        try {
            return TranscriptRevisionOutcome.committed(store.appendFromSuccessfulAttempt(draft, 0, attempt, fence,
                    fingerprint, versionRef));
        } catch (TranscriptRevisionConflictException conflict) {
            return TranscriptRevisionOutcome.conflict(conflict);
        }
    }

    @Test
    void attemptBindingReadsBackAfterRuntimeStateRecreation() throws Exception {
        try (Fixture fixture = openFixture()) {
            var state = fixture.state();
            String bucket = state.bucket();
            String digest = "d".repeat(64);
            String fingerprint = "e".repeat(64);
            String versionRef = "urn:media:transcript-version:reopen-v1";
            seed(state, "tenant-binding-reopen", "principal-a", "source-binding-reopen", "job-binding-reopen",
                    "consent-binding-reopen", digest, false);
            seedSuccessfulAttempt(state, "tenant-binding-reopen", "principal-a", "source-binding-reopen",
                    "job-binding-reopen", digest, fingerprint, 1, 37, versionRef, "durable words",
                    "provider-op-reopen", "provider-receipt-reopen");
            TranscriptDraft draft = draft("tenant-binding-reopen", "principal-a", "transcript-binding-reopen",
                    "source-binding-reopen", "job-binding-reopen", "consent-binding-reopen", digest, "durable words");
            var revision = fixture.store().appendFromSuccessfulAttempt(draft, 0, 1, 37, fingerprint, versionRef);
            var expected = fixture.store().attemptBinding("tenant-binding-reopen", "transcript-binding-reopen", 1);
            fixture.store().close(); state.release(); fixture.installed().close();

            AutoCloseable installation = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
            try (installation; PostgresqlMediaTranscriptStore reopened = new PostgresqlMediaTranscriptStore()) {
                assertThat(reopened.revisions("tenant-binding-reopen", "principal-a", "transcript-binding-reopen"))
                        .containsExactly(revision);
                assertThat(reopened.attemptBinding("tenant-binding-reopen", "transcript-binding-reopen", 1))
                        .isEqualTo(expected);
            }
        }
    }

    private static void assertNoBoundRevision(PostgresqlMediaTranscriptStore store, TranscriptDraft draft,
            int expectedRevision, int attempt, long fence, String fingerprint, String transcriptVersionRef) {
        int before = store.revisions(draft.tenantId(), draft.principalId(), draft.transcriptId()).size();
        assertThatThrownBy(() -> store.appendFromSuccessfulAttempt(draft, expectedRevision, attempt, fence,
                fingerprint, transcriptVersionRef)).isInstanceOf(RuntimeException.class);
        assertThat(store.revisions(draft.tenantId(), draft.principalId(), draft.transcriptId())).hasSize(before);
    }

    @Test
    void concurrentInitialWritersCommitOneRevisionAndReportTypedConflicts() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digest = "e".repeat(64);
            seed(state, "tenant-race", "principal-a", "source-race", "job-race-0", "consent-race", digest, false);
            int writers = 4;
            for (int i = 1; i < writers; i++) {
                seedCompletedJob(state, "tenant-race", "principal-a", "source-race",
                        "job-race-" + i, digest);
            }

            ExecutorService executor = Executors.newFixedThreadPool(writers);
            CountDownLatch ready = new CountDownLatch(writers);
            CountDownLatch start = new CountDownLatch(1);
            List<Future<TranscriptRevisionOutcome>> futures = new ArrayList<>();
            try {
                for (int i = 0; i < writers; i++) {
                    final int writer = i;
                    futures.add(executor.submit(() -> {
                        TranscriptDraft draft = draft("tenant-race", "principal-a", "transcript-race",
                                "source-race", "job-race-" + writer, "consent-race", digest, "candidate-" + writer);
                        ready.countDown();
                        if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("writers did not start");
                        try {
                            return TranscriptRevisionOutcome.committed(store.append(draft, 0));
                        } catch (TranscriptRevisionConflictException conflict) {
                            return TranscriptRevisionOutcome.conflict(conflict);
                        }
                    }));
                }
                assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
                start.countDown();
                List<TranscriptRevisionOutcome> outcomes = new ArrayList<>();
                for (Future<TranscriptRevisionOutcome> future : futures) outcomes.add(future.get(20, TimeUnit.SECONDS));
                assertThat(outcomes).filteredOn(TranscriptRevisionOutcome::committed).hasSize(1);
                assertThat(outcomes).filteredOn(outcome -> !outcome.committed()).hasSize(writers - 1);
                assertThat(outcomes.stream().filter(outcome -> !outcome.committed())
                        .map(TranscriptRevisionOutcome::conflict)
                        .map(TranscriptRevisionConflictException::actualLatestRevision))
                        .containsOnly(1);
                assertThat(store.revisions("tenant-race", "principal-a", "transcript-race"))
                        .hasSize(1).allSatisfy(revision -> assertThat(revision.revision()).isEqualTo(1));
            } finally {
                start.countDown();
                executor.shutdownNow();
            }
        }
    }

    @Test
    void transcriptIdentifierCannotBeReadOrReboundAcrossPrincipals() throws Exception {
        try (Fixture fixture = openFixture()) {
            var store = fixture.store();
            var state = fixture.state();
            String digestA = "f".repeat(64);
            String digestB = "1".repeat(64);
            seed(state, "tenant-scope", "principal-a", "source-a", "job-a", "consent-a", digestA, false);
            seed(state, "tenant-scope", "principal-b", "source-b", "job-b", "consent-b", digestB, false);
            TranscriptDraft owner = draft("tenant-scope", "principal-a", "shared-transcript-id", "source-a",
                    "job-a", "consent-a", digestA, "owner content");
            store.append(owner, 0);

            TranscriptDraft foreign = draft("tenant-scope", "principal-b", "shared-transcript-id", "source-b",
                    "job-b", "consent-b", digestB, "foreign content");
            assertThatThrownBy(() -> store.append(foreign, 1))
                    .isInstanceOf(TranscriptPrincipalConflictException.class);
            assertThat(store.revisions("tenant-scope", "principal-a", "shared-transcript-id"))
                    .extracting(value -> value.draft().text()).containsExactly("owner content");
            assertThat(store.revisions("tenant-scope", "principal-b", "shared-transcript-id")).isEmpty();
            assertThatThrownBy(() -> store.revisions("tenant-scope", "shared-transcript-id"))
                    .isInstanceOf(UnsupportedOperationException.class);
        }
    }

    private static Fixture openFixture() throws Exception {
        String bucket = "media-transcript-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client client = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }

        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
        PostgresqlMediaTranscriptStore store = null;
        MediaAwsPostgresqlRuntimeState state = null;
        try {
            store = new PostgresqlMediaTranscriptStore();
            state = MediaAwsPostgresqlRuntimeState.acquire();
            return new Fixture(installed, store, state);
        } catch (RuntimeException failure) {
            if (state != null) state.release();
            if (store != null) store.close();
            installed.close();
            throw failure;
        }
    }

    private record Fixture(AutoCloseable installed, PostgresqlMediaTranscriptStore store,
                           MediaAwsPostgresqlRuntimeState state) implements AutoCloseable {
        @Override public void close() throws Exception {
            try {
                state.release();
            } finally {
                try {
                    store.close();
                } finally {
                    installed.close();
                }
            }
        }
    }

    private record TranscriptRevisionOutcome(
            com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision revision,
            TranscriptRevisionConflictException conflict) {
        static TranscriptRevisionOutcome committed(
                com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision revision) {
            return new TranscriptRevisionOutcome(revision, null);
        }
        static TranscriptRevisionOutcome conflict(TranscriptRevisionConflictException conflict) {
            return new TranscriptRevisionOutcome(null, conflict);
        }
        boolean committed() { return revision != null; }
    }

    private static void seed(MediaAwsPostgresqlRuntimeState state, String tenant, String principal,
                             String artifact, String job, String consent, String digest, boolean revoked) throws Exception {
        seed(state, tenant, principal, artifact, job, consent, digest, revoked, "transcription");
    }

    private static void seed(MediaAwsPostgresqlRuntimeState state, String tenant, String principal,
                             String artifact, String job, String consent, String digest, boolean revoked,
                             String allowedPurposes) throws Exception {
        try (Connection c = state.connection()) {
            String artifactSql = "INSERT INTO media_artifacts (tenant_id,artifact_id,principal_id,file_name,content_type,size_bytes,sha256,object_reference,classification,created_at,expires_at,metadata_json,scan_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";
            try (PreparedStatement s = c.prepareStatement(artifactSql)) {
                s.setString(1,tenant); s.setString(2,artifact); s.setString(3,principal); s.setString(4,"source.wav");
                s.setString(5,"audio/wav"); s.setLong(6,10); s.setString(7,digest); s.setString(8,"fixture");
                s.setString(9,"CONFIDENTIAL"); s.setLong(10,System.currentTimeMillis()); s.setLong(11,System.currentTimeMillis()+60000);
                s.setString(12,"{}"); s.setString(13,"CLEAN"); s.executeUpdate();
            }
            String jobSql = "INSERT INTO media_processing_jobs (tenant_id,job_id,request_id,principal_id,artifact_id,job_type,provider_id,status,created_at,result_json,failure_code,version,expected_artifact_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";
            try (PreparedStatement s = c.prepareStatement(jobSql)) {
                s.setString(1,tenant); s.setString(2,job); s.setString(3,"request-"+job); s.setString(4,principal);
                s.setString(5,artifact); s.setString(6,"SPEECH_TO_TEXT"); s.setString(7,"provider-a"); s.setString(8,"COMPLETED");
                s.setLong(9,System.currentTimeMillis()); s.setString(10,"{}"); s.setString(11,""); s.setLong(12,3);
                s.setString(13,"sha256:"+digest); s.executeUpdate();
            }
            setSttSnapshot(state, tenant, job, null, null);
            try (PreparedStatement s = c.prepareStatement("INSERT INTO media_consents (tenant_id,consent_id,principal_id,purposes_csv,allowed_regions_csv,external_processing_allowed,biometric_processing_allowed,granted_at,revoked_at,version) VALUES (?,?,?,?,?,?,?,?,?,?)")) {
                s.setString(1,tenant); s.setString(2,consent); s.setString(3,principal); s.setString(4,allowedPurposes);
                s.setString(5,"local"); s.setBoolean(6,false); s.setBoolean(7,false); s.setLong(8,System.currentTimeMillis());
                if (revoked) s.setLong(9,System.currentTimeMillis()); else s.setNull(9, java.sql.Types.BIGINT);
                s.setLong(10,1); s.executeUpdate();
            }
        }
    }

    private static void setSttSnapshot(MediaAwsPostgresqlRuntimeState state, String tenant, String job,
            String glossaryRef, Boolean filler) throws Exception {
        Map<String, Object> snapshot = new HashMap<>();
        snapshot.put("version", "media.stt-request-snapshot.v1");
        snapshot.put("customGlossaryRef", glossaryRef);
        snapshot.put("fillerRetakeCandidates", filler);
        try (Connection c = state.connection(); PreparedStatement s = c.prepareStatement(
                "UPDATE media_processing_jobs SET stt_request_snapshot=? WHERE tenant_id=? AND job_id=?")) {
            s.setString(1, state.mapper().writeValueAsString(snapshot)); s.setString(2, tenant); s.setString(3, job);
            assertThat(s.executeUpdate()).isEqualTo(1);
        }
    }

    private static void clearSttSnapshot(MediaAwsPostgresqlRuntimeState state, String tenant, String job)
            throws Exception {
        try (Connection c = state.connection(); PreparedStatement s = c.prepareStatement(
                "UPDATE media_processing_jobs SET stt_request_snapshot=NULL WHERE tenant_id=? AND job_id=?")) {
            s.setString(1, tenant); s.setString(2, job); assertThat(s.executeUpdate()).isEqualTo(1);
        }
    }

    private static void setRawSttSnapshot(MediaAwsPostgresqlRuntimeState state, String tenant, String job, String value)
            throws Exception {
        try (Connection c = state.connection(); PreparedStatement s = c.prepareStatement(
                "UPDATE media_processing_jobs SET stt_request_snapshot=? WHERE tenant_id=? AND job_id=?")) {
            s.setString(1, value); s.setString(2, tenant); s.setString(3, job);
            assertThat(s.executeUpdate()).isEqualTo(1);
        }
    }

    private static void seedCompletedJob(MediaAwsPostgresqlRuntimeState state, String tenant, String principal,
                                         String artifact, String job, String digest) throws Exception {
        try (Connection c = state.connection(); PreparedStatement s = c.prepareStatement(
                "INSERT INTO media_processing_jobs (tenant_id,job_id,request_id,principal_id,artifact_id,job_type,provider_id,status,created_at,result_json,failure_code,version,expected_artifact_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")) {
            s.setString(1, tenant); s.setString(2, job); s.setString(3, "request-" + job);
            s.setString(4, principal); s.setString(5, artifact); s.setString(6, "SPEECH_TO_TEXT");
            s.setString(7, "provider-a"); s.setString(8, "COMPLETED"); s.setLong(9, System.currentTimeMillis());
            s.setString(10, "{}"); s.setString(11, ""); s.setLong(12, 3); s.setString(13, "sha256:" + digest);
            s.executeUpdate();
        }
        setSttSnapshot(state, tenant, job, null, null);
    }

    private static void seedSuccessfulAttempt(MediaAwsPostgresqlRuntimeState state, String tenant, String principal,
            String artifact, String job, String digest, String fingerprint, int attempt, long fence,
            String transcriptVersionRef, String transcriptText, String operation, String receipt) throws Exception {
        String result = semanticResult(state, digest, fingerprint, transcriptVersionRef, transcriptText,
                "NOT_REQUESTED", null, null, false, false, false);
        String resultDigest = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                .digest(result.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        try (Connection connection = state.connection()) {
            try (PreparedStatement updateJob = connection.prepareStatement(
                    "UPDATE media_processing_jobs SET request_fingerprint=? WHERE tenant_id=? AND job_id=?")) {
                updateJob.setString(1, "sha256:" + fingerprint); updateJob.setString(2, tenant); updateJob.setString(3, job);
                assertThat(updateJob.executeUpdate()).isEqualTo(1);
            }
            try (PreparedStatement insert = connection.prepareStatement("""
                    INSERT INTO media_processing_attempts
                      (tenant_id,job_id,attempt_number,request_id,provider_id,request_fingerprint,lease_owner,
                       fencing_token,state,provider_operation_id,provider_receipt_id,result_json,result_digest,
                       provenance_json,observation_json,created_at,updated_at,observed_at)
                    VALUES (?,?,?,?,?,?,?,?,'SUCCEEDED',?,?,?,?,?,?,?, ?,?)
                    """)) {
                long now = System.currentTimeMillis();
                insert.setString(1, tenant); insert.setString(2, job); insert.setInt(3, attempt);
                insert.setString(4, "request-" + job); insert.setString(5, "provider-a");
                insert.setString(6, fingerprint); insert.setString(7, "fixture-worker"); insert.setLong(8, fence);
                insert.setString(9, operation); insert.setString(10, receipt); insert.setString(11, result);
                insert.setString(12, resultDigest); insert.setString(13, "{}"); insert.setString(14, "{}");
                insert.setLong(15, now); insert.setLong(16, now); insert.setLong(17, now);
                insert.executeUpdate();
            }
        }
    }

    private static void replaceAttemptResult(MediaAwsPostgresqlRuntimeState state, String tenant, String job,
            String result) throws Exception {
        String resultDigest = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                .digest(result.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        try (Connection connection = state.connection(); PreparedStatement update = connection.prepareStatement(
                "UPDATE media_processing_attempts SET result_json=?,result_digest=? WHERE tenant_id=? AND job_id=? AND attempt_number=1")) {
            update.setString(1, result); update.setString(2, resultDigest); update.setString(3, tenant);
            update.setString(4, job); assertThat(update.executeUpdate()).isEqualTo(1);
        }
    }

    private static String semanticResult(MediaAwsPostgresqlRuntimeState state, String digest, String fingerprint, String versionRef, String transcriptText,
            String glossaryDisposition, String glossaryRef, String responseDispositionOverride,
            boolean omitGlossaryDisposition, boolean extraResponseProperty, boolean overlongText) throws Exception {
        Map<String, Object> response = new HashMap<>();
        response.put("sourceArtifactVersionRef", "sha256:" + digest);
        response.put("requestFingerprint", fingerprint);
        response.put("transcriptVersionRef", versionRef);
        if (!omitGlossaryDisposition) response.put("glossaryDisposition",
                responseDispositionOverride == null ? glossaryDisposition : responseDispositionOverride);
        response.put("transcriptText", overlongText ? "x".repeat(1_000_001) : transcriptText);
        if (extraResponseProperty) response.put("unregistered", "extra");
        Map<String, Object> glossary = new HashMap<>();
        glossary.put("disposition", glossaryDisposition);
        if (glossaryRef != null) glossary.put("exactGlossaryRef", glossaryRef);
        Map<String, Object> observations = new HashMap<>();
        observations.put("requestFingerprint", fingerprint);
        observations.put("glossaryApplication", glossary);
        observations.put("transcriptResponse", response);
        return state.mapper().writeValueAsString(Map.of("semanticObservations", observations));
    }

    private static TranscriptDraft draft(String tenant, String principal, String transcript, String artifact,
                                         String job, String consent, String digest, String text) {
        return draft(tenant, principal, transcript, artifact, job, consent, digest, text, "transcription");
    }

    private static TranscriptDraft draft(String tenant, String principal, String transcript, String artifact,
                                         String job, String consent, String digest, String text, String purpose) {
        return new TranscriptDraft(tenant,principal,transcript,artifact,"sha256:"+digest,digest,job,
                "profile-candidate","provider-a","model-a","en-US","milliseconds",text,
                consent,"rights-candidate","policy-candidate","urn:media:purpose:" + purpose,purpose);
    }

    private static Map<String,String> environment(String bucket) {
        Map<String,String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENVIRONMENT","integration");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_TRANSCRIPT_DB_PASSWORD");
        env.put("MEDIA_TRANSCRIPT_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET",bucket); env.put("MEDIA_S3_REGION",LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT",LOCALSTACK.getEndpoint().toString()); env.put("MEDIA_S3_PATH_STYLE","true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE","secret:env:MEDIA_ACCESS"); env.put("MEDIA_S3_SECRET_KEY_REFERENCE","secret:env:MEDIA_SECRET");
        env.put("MEDIA_ACCESS",LOCALSTACK.getAccessKey()); env.put("MEDIA_SECRET",LOCALSTACK.getSecretKey());
        return env;
    }
}
