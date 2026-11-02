package com.ghatana.media.provider.aws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
import com.ghatana.media.runtime.MediaRuntimeContracts.SttSubmissionSnapshot;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext.MonotonicDeadline;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobFinalizationDeadlineExceededException;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import java.nio.charset.StandardCharsets;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.localstack.LocalStackContainer;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

/** Exact tenant/job/attempt readback from the durable provider-attempt table. */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaProcessingAttemptReadTest {
    private static final String FINGERPRINT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String PROVENANCE = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    @Test
    void readsExactPersistedAttemptAfterStoreRestartAndScopesByFullIdentity() throws Exception {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-attempt-read-" + suffix;
        try (S3Client client = s3Client()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        Map<String, String> environment = integrationEnvironment(bucket);
        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore initial = new PostgresqlMediaJobStore()) {
            String tenant = "tenant-" + suffix;
            String jobId = "job-" + suffix;
            ProcessingJob accepted = new ProcessingJob(jobId, "request-" + suffix, tenant, "principal-a",
                    "artifact-a", JobType.TRANSCODE, "provider-a", JobStatus.ACCEPTED, Instant.now(),
                    null, null, Map.of(), "", 1, "", FINGERPRINT);
            initial.create(accepted);
            var lease = initial.claim(accepted, "worker-a", Instant.now().plusSeconds(60));
            ProcessingJob running = new ProcessingJob(jobId, accepted.requestId(), tenant, "principal-a",
                    "artifact-a", JobType.TRANSCODE, "provider-a", JobStatus.RUNNING, accepted.createdAt(),
                    Instant.now(), null, Map.of(), "", accepted.version() + 1, "", FINGERPRINT);
            var started = initial.startAttempt(accepted, running, lease, 1, FINGERPRINT);
            var withReceipt = initial.recordProviderReceipt(
                    started.attempt(), lease, "operation-exact", "receipt-exact");
            Instant observedAt = Instant.ofEpochMilli(Instant.now().toEpochMilli());
            Map<String, Object> providerResult = Map.of("label", "cat");
            ProviderAttemptObservation observation = new ProviderAttemptObservation(
                    withReceipt.query(), AttemptFinality.SUCCEEDED, "receipt-exact", providerResult,
                    PROVENANCE, observedAt);
            ProcessingJob completed = new ProcessingJob(jobId, accepted.requestId(), tenant, "principal-a",
                    "artifact-a", JobType.TRANSCODE, "provider-a", JobStatus.COMPLETED, accepted.createdAt(),
                    started.running().startedAt(), observedAt, providerResult, "", started.running().version() + 1,
                    "", FINGERPRINT);
            initial.commitFinalOutcome(started.running(), withReceipt, completed, observation,
                    event(completed, "MEDIA_JOB_COMPLETED"));

            try (PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore()) {
                initial.close();
                var attempt = restarted.findProcessingAttempt(tenant, jobId, 1).orElseThrow();
                assertThat(attempt.tenantId()).isEqualTo(tenant);
                assertThat(attempt.jobId()).isEqualTo(jobId);
                assertThat(attempt.requestId()).isEqualTo(accepted.requestId());
                assertThat(attempt.attemptNumber()).isEqualTo(1);
                assertThat(attempt.fencingToken()).isEqualTo(lease.fencingToken());
                assertThat(attempt.requestFingerprint()).isEqualTo(FINGERPRINT);
                assertThat(attempt.providerId()).isEqualTo("provider-a");
                assertThat(attempt.providerOperationId()).isEqualTo("operation-exact");
                assertThat(attempt.providerReceiptId()).isEqualTo("receipt-exact");
                assertThat(attempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
                assertThat(attempt.resultDigest()).isEqualTo(sha256("{\"label\":\"cat\"}"));
                assertThat(attempt.provenanceDigest()).isEqualTo(PROVENANCE);
                assertThat(attempt.observedAt()).isEqualTo(observedAt);

                assertThat(restarted.findProcessingAttempt("wrong-" + tenant, jobId, 1)).isEmpty();
                assertThat(restarted.findProcessingAttempt(tenant, "wrong-" + jobId, 1)).isEmpty();
                assertThat(restarted.findProcessingAttempt(tenant, jobId, 2)).isEmpty();
                assertThat(restarted.findProcessingAttempt(tenant, "absent-job", 1)).isEmpty();
            }
        }
    }

    @Test
    void mapsDispatchUnknownFailedAndNoEffectFinalityFromPersistedState() throws Exception {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-attempt-states-" + suffix;
        try (S3Client client = s3Client()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(integrationEnvironment(bucket));
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            var dispatch = startAttempt(store, "tenant-" + suffix, "dispatch-" + suffix);
            var dispatchRead = store.findProcessingAttempt(dispatch.tenantId(), dispatch.running().jobId(), 1)
                    .orElseThrow();
            assertIdentity(dispatchRead, dispatch);
            assertThat(dispatchRead.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(dispatchRead.providerOperationId()).isBlank();
            assertThat(dispatchRead.providerReceiptId()).isBlank();
            assertThat(dispatchRead.resultDigest()).isBlank();
            assertThat(dispatchRead.provenanceDigest()).isBlank();
            assertThat(dispatchRead.observedAt()).isNull();

            var unknown = startAttempt(store, "tenant-" + suffix, "unknown-" + suffix);
            ProcessingJob unknownJob = terminal(unknown.running(), JobStatus.OUTCOME_UNKNOWN, Map.of());
            store.markOutcomeUnknown(unknown.running(), unknown.attempt(), unknownJob, Map.of(),
                    event(unknownJob, "MEDIA_JOB_OUTCOME_UNKNOWN"));
            var unknownRead = store.findProcessingAttempt(unknown.tenantId(), unknown.running().jobId(), 1)
                    .orElseThrow();
            assertIdentity(unknownRead, unknown);
            assertThat(unknownRead.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(unknownRead.providerOperationId()).isBlank();
            assertThat(unknownRead.providerReceiptId()).isBlank();
            assertThat(unknownRead.resultDigest()).isBlank();
            assertThat(unknownRead.provenanceDigest()).isBlank();
            assertThat(unknownRead.observedAt()).isNotNull();

            var failed = startAttempt(store, "tenant-" + suffix, "failed-" + suffix);
            var failedWithReceipt = store.recordProviderReceipt(
                    failed.attempt(), failed.lease(), "failed-operation", "failed-receipt");
            Instant failedObservedAt = Instant.ofEpochMilli(Instant.now().toEpochMilli());
            ProviderAttemptObservation failedObservation = new ProviderAttemptObservation(
                    failedWithReceipt.query(), AttemptFinality.FAILED, "failed-receipt", Map.of(),
                    PROVENANCE, failedObservedAt);
            ProcessingJob failedJob = terminal(failed.running(), JobStatus.FAILED, Map.of());
            store.commitFinalOutcome(failed.running(), failedWithReceipt, failedJob, failedObservation,
                    event(failedJob, "MEDIA_JOB_FAILED"));
            var failedRead = store.findProcessingAttempt(failed.tenantId(), failed.running().jobId(), 1)
                    .orElseThrow();
            assertIdentity(failedRead, failed);
            assertThat(failedRead.finality()).isEqualTo(AttemptFinality.FAILED);
            assertThat(failedRead.providerOperationId()).isEqualTo("failed-operation");
            assertThat(failedRead.providerReceiptId()).isEqualTo("failed-receipt");
            assertThat(failedRead.resultDigest()).isBlank();
            assertThat(failedRead.provenanceDigest()).isEqualTo(PROVENANCE);
            assertThat(failedRead.observedAt()).isEqualTo(failedObservedAt);

            var noEffect = startAttempt(store, "tenant-" + suffix, "no-effect-" + suffix);
            ProcessingJob refused = terminal(noEffect.running(), JobStatus.FAILED, Map.of(),
                    "PROCESSING_DEADLINE_EXCEEDED_BEFORE_PROVIDER");
            store.markPreDispatchNoEffect(noEffect.running(), noEffect.attempt(), refused,
                    event(refused, "MEDIA_JOB_FAILED"));
            var noEffectRead = store.findProcessingAttempt(noEffect.tenantId(), noEffect.running().jobId(), 1)
                    .orElseThrow();
            assertIdentity(noEffectRead, noEffect);
            assertThat(noEffectRead.finality()).isEqualTo(AttemptFinality.NO_EFFECT_PROVEN);
            assertThat(noEffectRead.providerOperationId()).isBlank();
            assertThat(noEffectRead.providerReceiptId()).isBlank();
            assertThat(noEffectRead.resultDigest()).isBlank();
            assertThat(noEffectRead.provenanceDigest()).isBlank();
            assertThat(noEffectRead.observedAt()).isNotNull();
            String noEffectObservation = persistedObservation(noEffect.tenantId(), noEffect.running().jobId(), 1);
            assertThat(noEffectObservation)
                    .contains("\"finality\":\"NO_EFFECT_PROVEN\"")
                    .contains("\"reason\":\"PRE_DISPATCH_NO_EFFECT\"")
                    .contains("\"failureCode\":\"PROCESSING_DEADLINE_EXCEEDED_BEFORE_PROVIDER\"")
                    .doesNotContain("POLICY_DENIED");

            assertThat(store.findProcessingAttempt("wrong-tenant", dispatch.running().jobId(), 1)).isEmpty();
            assertThat(store.findProcessingAttempt(dispatch.tenantId(), "wrong-job", 1)).isEmpty();
            assertThat(store.findProcessingAttempt(dispatch.tenantId(), dispatch.running().jobId(), 2)).isEmpty();
        }
    }

    @Test
    void expiredDeadlineWhileBlockedOnJobRowRollsBackAttemptJobTranscriptAndOutbox() throws Exception {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-attempt-deadline-" + suffix;
        try (S3Client client = s3Client()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(integrationEnvironment(bucket));
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore();
             com.ghatana.media.provider.aws.PostgresqlMediaTranscriptStore transcripts =
                     new com.ghatana.media.provider.aws.PostgresqlMediaTranscriptStore()) {
            String tenant = "tenant-" + suffix;
            String jobId = "job-" + suffix;
            String digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            String sourceVersion = "sha256:" + digest;
            ProcessingJob accepted = new ProcessingJob(jobId, "request-" + suffix, tenant, "principal-a",
                    "artifact-a", JobType.SPEECH_TO_TEXT, "provider-a", JobStatus.ACCEPTED, Instant.now(),
                    null, null, Map.of(), "", 1, sourceVersion, FINGERPRINT);
            store.create(accepted, FINGERPRINT, new SttSubmissionSnapshot(
                    SttSubmissionSnapshot.VERSION, null, null));
            var lease = store.claim(accepted, "worker-a", Instant.now().plusSeconds(30));
            ProcessingJob running = new ProcessingJob(jobId, accepted.requestId(), tenant, "principal-a",
                    "artifact-a", JobType.SPEECH_TO_TEXT, "provider-a", JobStatus.RUNNING, accepted.createdAt(),
                    Instant.now(), null, Map.of(), "", accepted.version() + 1, sourceVersion, FINGERPRINT);
            var started = store.startAttempt(accepted, running, lease, 1, FINGERPRINT);
            var attempt = store.recordProviderReceipt(started.attempt(), lease, "operation", "receipt");
            Instant observedAt = Instant.now();
            ProviderAttemptObservation observation = new ProviderAttemptObservation(attempt.query(),
                    AttemptFinality.SUCCEEDED, "receipt", Map.of("text", "hello"), PROVENANCE, observedAt);
            ProcessingJob completed = terminal(started.running(), JobStatus.COMPLETED, Map.of("text", "hello"));
            MediaLifecycleEvent completion = event(completed, "MEDIA_JOB_COMPLETED");
            TranscriptDraft draft = new TranscriptDraft(tenant, "principal-a", "transcript-" + suffix,
                    "artifact-a", sourceVersion, digest, jobId, "profile-a", "provider-a", "model-a",
                    "en-US", "milliseconds", "hello", "consent-a", "rights-a", "policy-a",
                    "urn:media:purpose:transcription", "transcription");
            MonotonicDeadline deadline = MonotonicDeadline.after(Duration.ofSeconds(2));
            ExecutorService executor = Executors.newSingleThreadExecutor();
            try (Connection blocker = DriverManager.getConnection(
                    POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())) {
                blocker.setAutoCommit(false);
                try (PreparedStatement lock = blocker.prepareStatement(
                        "SELECT 1 FROM media_processing_jobs WHERE tenant_id=? AND job_id=? FOR UPDATE")) {
                    lock.setString(1, tenant);
                    lock.setString(2, jobId);
                    try (ResultSet row = lock.executeQuery()) { assertThat(row.next()).isTrue(); }
                }
                Future<ProcessingJob> finalization = executor.submit(() -> store.commitFinalOutcomeWithTranscript(
                        started.running(), attempt, completed, observation, completion,
                        transcripts, draft, "transcript-version-1", deadline));
                try {
                    awaitFinalizationLockWait();
                    while (!deadline.expired()) Thread.sleep(10);
                } finally {
                    blocker.rollback();
                }
                assertThatThrownBy(() -> finalization.get(10, TimeUnit.SECONDS))
                        .hasCauseInstanceOf(MediaJobFinalizationDeadlineExceededException.class);
            } finally {
                executor.shutdownNow();
            }
            assertThat(store.find(tenant, jobId).orElseThrow().status()).isEqualTo(JobStatus.RUNNING);
            assertThat(store.findProcessingAttempt(tenant, jobId, 1).orElseThrow().finality())
                    .isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(count("SELECT count(*) FROM media_processing_lifecycle_outbox WHERE event_id=?",
                    completion.eventId())).isZero();
            assertThat(count("SELECT count(*) FROM media_transcript_revisions WHERE tenant_id=? AND transcript_id=?",
                    tenant, draft.transcriptId())).isZero();

            ProcessingJob unknown = terminal(started.running(), JobStatus.OUTCOME_UNKNOWN, Map.of(),
                    "TRANSCRIPT_FINALIZATION_OUTCOME_UNKNOWN");
            MediaLifecycleEvent unknownEvent = event(unknown, "MEDIA_JOB_OUTCOME_UNKNOWN");
            store.recordProviderSuccessWithUnknownJob(
                    started.running(), attempt, unknown, observation, unknownEvent);

            ProcessingJob reconciledJob = store.find(tenant, jobId).orElseThrow();
            assertThat(reconciledJob.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(reconciledJob.result()).isEmpty();
            var reconciledAttempt = store.findProcessingAttempt(tenant, jobId, 1).orElseThrow();
            assertThat(reconciledAttempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
            assertThat(reconciledAttempt.providerOperationId()).isEqualTo("operation");
            assertThat(reconciledAttempt.providerReceiptId()).isEqualTo("receipt");
            assertThat(reconciledAttempt.resultDigest()).isEqualTo(sha256("{\"text\":\"hello\"}"));
            assertThat(reconciledAttempt.provenanceDigest()).isEqualTo(PROVENANCE);
            assertThat(reconciledAttempt.observedAt()).isEqualTo(Instant.ofEpochMilli(observedAt.toEpochMilli()));
            assertThat(count("SELECT count(*) FROM media_processing_lifecycle_outbox WHERE event_id=?",
                    completion.eventId())).isZero();
            assertThat(count("SELECT count(*) FROM media_processing_lifecycle_outbox WHERE event_id=?",
                    unknownEvent.eventId())).isEqualTo(1);
            assertThat(count("SELECT count(*) FROM media_transcript_revisions WHERE tenant_id=? AND transcript_id=?",
                    tenant, draft.transcriptId())).isZero();
        }
    }

    @Test
    void idleTimeoutTerminatesStalledPreCommitClientAndPreservesProviderSuccessAsUnknown() throws Exception {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-attempt-commit-deadline-" + suffix;
        try (S3Client client = s3Client()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        AtomicBoolean pauseNextCommit = new AtomicBoolean(false);
        AtomicReference<Long> configuredIdleTimeoutMillis = new AtomicReference<>();
        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(
                     integrationEnvironment(bucket), null,
                     connection -> delayNextCommit(connection, pauseNextCommit, configuredIdleTimeoutMillis));
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            String tenant = "tenant-" + suffix;
            String jobId = "job-" + suffix;
            AttemptFixture started = startAttempt(store, tenant, jobId);
            var attempt = store.recordProviderReceipt(started.attempt(), started.lease(),
                    "operation-deadline", "receipt-deadline");
            Instant observedAt = Instant.now();
            ProviderAttemptObservation observation = new ProviderAttemptObservation(attempt.query(),
                    AttemptFinality.SUCCEEDED, "receipt-deadline", Map.of("text", "hello"), PROVENANCE, observedAt);
            ProcessingJob completed = terminal(started.running(), JobStatus.COMPLETED, Map.of("text", "hello"));
            MediaLifecycleEvent completion = event(completed, "MEDIA_JOB_COMPLETED");

            pauseNextCommit.set(true);
            assertThatThrownBy(() -> store.commitFinalOutcome(
                    started.running(), attempt, completed, observation, completion,
                    MonotonicDeadline.after(Duration.ofSeconds(3))))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(pauseNextCommit).as("the finalization COMMIT reached the delay seam").isFalse();
            assertThat(configuredIdleTimeoutMillis.get())
                    .as("the transaction-local idle timeout is armed below the deadline")
                    .isBetween(1L, 3_000L);

            assertThat(store.find(tenant, jobId).orElseThrow().status()).isEqualTo(JobStatus.RUNNING);
            assertThat(store.findProcessingAttempt(tenant, jobId, 1).orElseThrow().finality())
                    .isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(count("SELECT count(*) FROM media_processing_lifecycle_outbox WHERE event_id=?",
                    completion.eventId())).isZero();

            ProcessingJob unknown = terminal(started.running(), JobStatus.OUTCOME_UNKNOWN, Map.of(),
                    "TRANSCRIPT_FINALIZATION_OUTCOME_UNKNOWN");
            MediaLifecycleEvent unknownEvent = event(unknown, "MEDIA_JOB_OUTCOME_UNKNOWN");
            store.recordProviderSuccessWithUnknownJob(started.running(), attempt, unknown, observation, unknownEvent);

            assertThat(store.find(tenant, jobId).orElseThrow().status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(store.find(tenant, jobId).orElseThrow().result()).isEmpty();
            assertThat(store.findProcessingAttempt(tenant, jobId, 1).orElseThrow().finality())
                    .isEqualTo(AttemptFinality.SUCCEEDED);
            assertThat(count("SELECT count(*) FROM media_processing_lifecycle_outbox WHERE event_id=?",
                    completion.eventId())).isZero();
            assertThat(count("SELECT count(*) FROM media_processing_lifecycle_outbox WHERE event_id=?",
                    unknownEvent.eventId())).isEqualTo(1);
            assertThat(count("SELECT count(*) FROM media_transcript_revisions WHERE tenant_id=? AND job_id=?",
                    tenant, jobId)).isZero();
        }
    }

    @Test
    void simulatedLateFailedCommitAcknowledgementPreservesDurableSuccessWithoutRetryOrUnknownEvent() throws Exception {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-attempt-late-commit-ack-" + suffix;
        try (S3Client client = s3Client()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        AtomicBoolean failNextCommitAcknowledgement = new AtomicBoolean(false);
        AtomicBoolean delegateCommitCompleted = new AtomicBoolean(false);
        AtomicInteger targetedCommitCalls = new AtomicInteger();
        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(
                     integrationEnvironment(bucket), null,
                     connection -> failAcknowledgementAfterCommit(
                             connection, failNextCommitAcknowledgement, delegateCommitCompleted,
                             targetedCommitCalls));
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            String tenant = "tenant-" + suffix;
            String jobId = "job-" + suffix;
            AttemptFixture started = startAttempt(store, tenant, jobId);
            var attempt = store.recordProviderReceipt(started.attempt(), started.lease(),
                    "operation-late-ack", "receipt-late-ack");
            Map<String, Object> providerResult = Map.of("label", "synthetic");
            Instant observedAt = Instant.now();
            ProviderAttemptObservation observation = new ProviderAttemptObservation(attempt.query(),
                    AttemptFinality.SUCCEEDED, "receipt-late-ack", providerResult, PROVENANCE, observedAt);
            ProcessingJob completed = terminal(started.running(), JobStatus.COMPLETED, providerResult);
            MediaLifecycleEvent successEvent = event(completed, "MEDIA_JOB_COMPLETED");

            failNextCommitAcknowledgement.set(true);
            assertThatThrownBy(() -> store.commitFinalOutcome(
                    started.running(), attempt, completed, observation, successEvent,
                    MonotonicDeadline.after(Duration.ofSeconds(5))))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(failNextCommitAcknowledgement).isFalse();
            assertThat(targetedCommitCalls).hasValue(1);
            assertThat(delegateCommitCompleted).isTrue();

            ProcessingJob durableJob = store.find(tenant, jobId).orElseThrow();
            assertThat(durableJob.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(durableJob.result()).containsEntry("label", "synthetic");
            var durableAttempt = store.findProcessingAttempt(tenant, jobId, 1).orElseThrow();
            assertThat(durableAttempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
            assertThat(durableAttempt.providerOperationId()).isEqualTo("operation-late-ack");
            assertThat(durableAttempt.providerReceiptId()).isEqualTo("receipt-late-ack");
            assertThat(count("SELECT count(*) FROM media_processing_lifecycle_outbox "
                    + "WHERE tenant_id=? AND aggregate_id=? AND event_type='MEDIA_JOB_COMPLETED'",
                    tenant, jobId)).isEqualTo(1);
            assertThat(count("SELECT count(*) FROM media_processing_lifecycle_outbox "
                    + "WHERE tenant_id=? AND aggregate_id=? AND event_type='MEDIA_JOB_OUTCOME_UNKNOWN'",
                    tenant, jobId)).isZero();
        }
    }

    @Test
    void preservesProviderSuccessEvidenceWhenMediaJobMustRemainUnknown() throws Exception {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-attempt-success-unknown-" + suffix;
        try (S3Client client = s3Client()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(integrationEnvironment(bucket));
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            String tenant = "tenant-" + suffix;
            String jobId = "job-" + suffix;
            String digest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            String sourceVersion = "sha256:" + digest;
            ProcessingJob accepted = new ProcessingJob(jobId, "request-" + suffix, tenant, "principal-a",
                    "artifact-a", JobType.SPEECH_TO_TEXT, "provider-a", JobStatus.ACCEPTED, Instant.now(),
                    null, null, Map.of(), "", 1, sourceVersion, FINGERPRINT);
            store.create(accepted, FINGERPRINT, new SttSubmissionSnapshot(
                    SttSubmissionSnapshot.VERSION, null, null));
            var lease = store.claim(accepted, "worker-a", Instant.now().plusSeconds(60));
            ProcessingJob running = new ProcessingJob(jobId, accepted.requestId(), tenant, "principal-a",
                    "artifact-a", JobType.SPEECH_TO_TEXT, "provider-a", JobStatus.RUNNING, accepted.createdAt(),
                    Instant.now(), null, Map.of(), "", accepted.version() + 1, sourceVersion, FINGERPRINT);
            var started = store.startAttempt(accepted, running, lease, 1, FINGERPRINT);
            var attempt = store.recordProviderReceipt(started.attempt(), lease, "operation-exact", "receipt-exact");
            Instant observedAt = Instant.now();
            Map<String, Object> providerResult = Map.of("text", "provider transcript remains internal");
            ProviderAttemptObservation observation = new ProviderAttemptObservation(attempt.query(),
                    AttemptFinality.SUCCEEDED, "receipt-exact", providerResult, PROVENANCE, observedAt);
            ProcessingJob unknown = terminal(started.running(), JobStatus.OUTCOME_UNKNOWN, Map.of(),
                    "TRANSCRIPT_FINALIZATION_OUTCOME_UNKNOWN");
            MediaLifecycleEvent unknownEvent = event(unknown, "MEDIA_JOB_OUTCOME_UNKNOWN");

            store.recordProviderSuccessWithUnknownJob(
                    started.running(), attempt, unknown, observation, unknownEvent);

            ProcessingJob readJob = store.find(tenant, jobId).orElseThrow();
            assertThat(readJob.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(readJob.result()).isEmpty();
            var readAttempt = store.findProcessingAttempt(tenant, jobId, 1).orElseThrow();
            assertThat(readAttempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
            assertThat(readAttempt.providerOperationId()).isEqualTo("operation-exact");
            assertThat(readAttempt.providerReceiptId()).isEqualTo("receipt-exact");
            assertThat(readAttempt.resultDigest()).isEqualTo(sha256("{\"text\":\"provider transcript remains internal\"}"));
            assertThat(readAttempt.provenanceDigest()).isEqualTo(PROVENANCE);
            assertThat(readAttempt.observedAt()).isEqualTo(Instant.ofEpochMilli(observedAt.toEpochMilli()));
            assertThat(count("SELECT count(*) FROM media_processing_lifecycle_outbox WHERE event_id=?",
                    unknownEvent.eventId())).isEqualTo(1);
            assertThat(count("SELECT count(*) FROM media_transcript_revisions WHERE tenant_id=? AND job_id=?",
                    tenant, jobId)).isZero();
        }
    }

    private static void awaitFinalizationLockWait() throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
        while (System.nanoTime() < until) {
            try (Connection connection = DriverManager.getConnection(
                    POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 PreparedStatement query = connection.prepareStatement(
                         "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' "
                                 + "AND query LIKE 'UPDATE media_processing_jobs SET provider_id=%'")) {
                try (ResultSet rows = query.executeQuery()) {
                    if (rows.next() && rows.getLong(1) > 0) return;
                }
            }
            Thread.sleep(20);
        }
        throw new AssertionError("finalization did not reach the locked job row");
    }

    private static Connection delayNextCommit(
            Connection delegate, AtomicBoolean pauseNextCommit, AtomicReference<Long> idleTimeoutMillis) {
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class}, (proxy, method, arguments) -> {
                    if ("commit".equals(method.getName()) && pauseNextCommit.compareAndSet(true, false)) {
                        try (var statement = delegate.createStatement();
                             ResultSet result = statement.executeQuery("SELECT ceil(EXTRACT(EPOCH FROM "
                                     + "current_setting('idle_in_transaction_session_timeout')::interval) * 1000)::bigint")) {
                            if (result.next()) idleTimeoutMillis.set(result.getLong(1));
                        }
                        try {
                            Thread.sleep(4_000);
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            throw new SQLException("injected pre-commit delay was interrupted", interrupted);
                        }
                    }
                    try {
                        return method.invoke(delegate, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static Connection failAcknowledgementAfterCommit(
            Connection delegate, AtomicBoolean failNextAcknowledgement,
            AtomicBoolean delegateCommitCompleted, AtomicInteger targetedCommitCalls) {
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class}, (proxy, method, arguments) -> {
                    if ("commit".equals(method.getName()) && failNextAcknowledgement.compareAndSet(true, false)) {
                        targetedCommitCalls.incrementAndGet();
                        try {
                            method.invoke(delegate, arguments);
                        } catch (InvocationTargetException failure) {
                            throw failure.getCause();
                        }
                        delegateCommitCompleted.set(true);
                        // Simulate a late failed acknowledgement after the real delegate commit returned.
                        try {
                            Thread.sleep(5_200);
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            throw new SQLException("injected post-commit acknowledgement delay was interrupted",
                                    interrupted);
                        }
                        throw new SQLException("injected lost acknowledgement after successful commit", "08006");
                    }
                    try {
                        return method.invoke(delegate, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static long count(String sql, String... args) throws SQLException {
        try (Connection connection = DriverManager.getConnection(
                    POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             PreparedStatement query = connection.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) query.setString(i + 1, args[i]);
            try (ResultSet rows = query.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getLong(1);
            }
        }
    }

    private static AttemptFixture startAttempt(PostgresqlMediaJobStore store, String tenant, String jobId) {
        ProcessingJob accepted = new ProcessingJob(jobId, "request-" + jobId, tenant, "principal-a",
                "artifact-a", JobType.TRANSCODE, "provider-a", JobStatus.ACCEPTED, Instant.now(),
                null, null, Map.of(), "", 1, "", FINGERPRINT);
        store.create(accepted);
        var lease = store.claim(accepted, "worker-a", Instant.now().plusSeconds(60));
        ProcessingJob running = new ProcessingJob(jobId, accepted.requestId(), tenant, "principal-a",
                "artifact-a", JobType.TRANSCODE, "provider-a", JobStatus.RUNNING, accepted.createdAt(),
                Instant.now(), null, Map.of(), "", accepted.version() + 1, "", FINGERPRINT);
        var started = store.startAttempt(accepted, running, lease, 1, FINGERPRINT);
        return new AttemptFixture(tenant, started.running(), started.attempt(), lease);
    }

    private static ProcessingJob terminal(ProcessingJob running, JobStatus status, Map<String, Object> result) {
        return terminal(running, status, result, "");
    }

    private static ProcessingJob terminal(
            ProcessingJob running, JobStatus status, Map<String, Object> result, String failureCode) {
        return new ProcessingJob(running.jobId(), running.requestId(), running.tenantId(), running.principalId(),
                running.artifactId(), running.jobType(), running.providerId(), status, running.createdAt(),
                running.startedAt(), Instant.now(), result, failureCode, running.version() + 1,
                running.expectedArtifactVersion(), running.requestFingerprint());
    }

    private static String persistedObservation(String tenantId, String jobId, int attemptNumber) throws SQLException {
        try (Connection connection = DriverManager.getConnection(
                    POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             PreparedStatement query = connection.prepareStatement(
                     "SELECT observation_json FROM media_processing_attempts "
                             + "WHERE tenant_id=? AND job_id=? AND attempt_number=?")) {
            query.setString(1, tenantId);
            query.setString(2, jobId);
            query.setInt(3, attemptNumber);
            try (ResultSet result = query.executeQuery()) {
                assertThat(result.next()).isTrue();
                return result.getString(1);
            }
        }
    }

    private static void assertIdentity(
            com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt actual,
            AttemptFixture expected) {
        assertThat(actual.tenantId()).isEqualTo(expected.tenantId());
        assertThat(actual.jobId()).isEqualTo(expected.running().jobId());
        assertThat(actual.attemptNumber()).isEqualTo(expected.attempt().attemptNumber());
    }

    private static MediaLifecycleEvent event(ProcessingJob job, String eventType) {
        return new MediaLifecycleEvent("media:attempt-read:" + eventType + ":" + job.jobId(), eventType,
                job.tenantId(), job.principalId(), job.requestId(), job.requestId(),
                "job", job.jobId(), job.version(), "INTERNAL", job.completedAt(), Map.of());
    }

    private record AttemptFixture(String tenantId, ProcessingJob running,
                                  com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt attempt,
                                  com.ghatana.media.runtime.MediaRuntimeContracts.JobLease lease) { }

    private static S3Client s3Client() {
        return S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build();
    }

    private static Map<String, String> integrationEnvironment(String bucket) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_ATTEMPT_READ_DB_PASSWORD");
        environment.put("MEDIA_ATTEMPT_READ_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_ATTEMPT_READ_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_ATTEMPT_READ_SECRET");
        environment.put("MEDIA_ATTEMPT_READ_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_ATTEMPT_READ_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static String sha256(String value) throws Exception {
        return java.util.HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }
}
