package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobLease;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSnapshot;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.SttSubmissionSnapshot;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptSegment;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptSegmentTiming;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** IP-06 real PostgreSQL process-kill boundary around the canonical job/attempt/outbox commit. */
@Testcontainers(disabledWithoutDocker = true)
class MediaPostgresqlProcessCrashRecoveryTest {
    private static final String FINGERPRINT =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private record JobIdentity(String tenantId, String jobId) {}
    private record MultimodalIdentity(
            JobIdentity parent, JobIdentity child, ProcessingJob replayParent, ProcessingJob replayChild,
            MultimodalOperationSpec operationSpec) {}

    @Test
    void forcibleProcessDeathBeforeCommitRollsBackAttemptJobAndOutboxTogether(@TempDir Path tempDir)
            throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = createBucket("media-ip06-before-" + runId);
        Map<String, String> environment = environment(bucket, "parent-before-" + runId);
        JobIdentity identity = prepareDispatchedJob(environment, runId);
        Map<String, String> childEnvironment = commitGatedEnvironment(
                environment, "BEFORE_COMMIT", tempDir.resolve("before-commit.jdbc.marker"));
        Path marker = tempDir.resolve("before-commit.marker");
        Path log = tempDir.resolve("before-commit.log");

        Process worker = startWorker(childEnvironment, marker, identity, log);
        try {
            awaitMarker(worker, tempDir.resolve("before-commit.jdbc.marker"), "PRE_COMMIT", log);
            // The finality, job update and outbox INSERT have all executed in the child
            // transaction, but an independent PostgreSQL reader still sees the prior state.
            assertThat(outboxCount(identity, "media.job.completed", 3)).isZero();
            assertThat(jobStatus(identity)).isEqualTo("RUNNING");
            worker.destroyForcibly();
            assertThat(worker.waitFor(15, TimeUnit.SECONDS)).isTrue();
        } finally {
            if (worker.isAlive()) worker.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore()) {
            ProcessingJob recovered = restarted.find(identity.tenantId(), identity.jobId()).orElseThrow();
            assertThat(recovered.status()).isEqualTo(JobStatus.RUNNING);
            assertThat(recovered.version()).isEqualTo(2);
            var attempt = restarted.findProcessingAttempt(identity.tenantId(), identity.jobId(), 1).orElseThrow();
            assertThat(attempt.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(attempt.providerOperationId()).isEqualTo("operation-" + runId);
            assertThat(attempt.providerReceiptId()).isEqualTo("receipt-" + runId);
            assertThat(outboxCount(identity, "media.job.completed", 3)).isZero();
        }
    }

    @Test
    void forcibleProcessDeathAfterCommitReadsOneExactOutcomeAndTerminalEvent(@TempDir Path tempDir)
            throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = createBucket("media-ip06-after-" + runId);
        Map<String, String> environment = environment(bucket, "parent-after-" + runId);
        JobIdentity identity = prepareDispatchedJob(environment, runId);
        Path marker = tempDir.resolve("after-commit.marker");
        Path log = tempDir.resolve("after-commit.log");

        Path jdbcMarker = tempDir.resolve("after-commit.jdbc.marker");
        Process worker = startWorker(
                commitGatedEnvironment(environment, "AFTER_COMMIT", jdbcMarker), marker, identity, log);
        try {
            awaitMarker(worker, jdbcMarker, "POSTGRES_COMMITTED_RETURNED", log);
            // The database commit returned, while the child remains inside the JDBC proxy and
            // has not yet received that return. Check exact state and one event before killing it.
            assertThat(jobStatus(identity)).isEqualTo("COMPLETED");
            assertThat(outboxCount(identity, "media.job.completed", 3)).isEqualTo(1);
            worker.destroyForcibly();
            assertThat(worker.waitFor(15, TimeUnit.SECONDS)).isTrue();
        } finally {
            if (worker.isAlive()) worker.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        // Recreate the provider lifecycle after the child JVM has died: all truth below is read
        // from PostgreSQL, not inherited child memory or a graceful store close.
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore()) {
            ProcessingJob recovered = restarted.find(identity.tenantId(), identity.jobId()).orElseThrow();
            assertThat(recovered.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(recovered.version()).isEqualTo(3);
            assertThat(recovered.result()).containsEntry("storedResult", "process-recovery-fixture");
            var attempt = restarted.findProcessingAttempt(identity.tenantId(), identity.jobId(), 1).orElseThrow();
            assertThat(attempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
            assertThat(attempt.providerOperationId()).isEqualTo("operation-" + runId);
            assertThat(attempt.providerReceiptId()).isEqualTo("receipt-" + runId);
            assertThat(outboxCount(identity, "media.job.completed", 3)).isEqualTo(1);
        }
    }

    @Test
    void forcibleProcessDeathKeepsTranscriptAttemptJobAndBothOutboxEventsAtomic(@TempDir Path tempDir)
            throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = createBucket("media-ip06-stt-crash-" + runId);
        Map<String, String> environment = environment(bucket, "parent-stt-crash-" + runId);
        JobIdentity identity = prepareDispatchedSttJob(environment, runId);
        String transcriptId = identity.jobId().replace("job-", "transcript-");
        String principalId = "principal-stt-" + runId;
        String transcriptVersion = "transcript-version-" + runId;
        TranscriptSegment sourceTicks = new TranscriptSegment(
                "decoded-span", "crash-safe transcript fixture", "PROVIDER",
                TranscriptSegmentTiming.sourceTicks(
                        0, 48_000, "source-clock-ip06-" + runId, 48_000, 96_000));

        Path beforeJdbcMarker = tempDir.resolve("stt-before-commit.jdbc.marker");
        Path beforeLog = tempDir.resolve("stt-before-commit.log");
        Process before = startWorker(commitGatedEnvironment(environment, "BEFORE_COMMIT", beforeJdbcMarker),
                tempDir.resolve("stt-before-commit.marker"), identity, beforeLog, "commit-transcript");
        try {
            awaitMarker(before, beforeJdbcMarker, "PRE_COMMIT", beforeLog);
            assertThat(jobStatus(identity)).isEqualTo("RUNNING");
            assertThat(outboxCount(identity, "media.job.completed", 3)).isZero();
            assertThat(outboxCount(identity.tenantId(), transcriptId,
                    "media.transcript.revision.created", 1)).isZero();
            before.destroyForcibly();
            assertThat(before.waitFor(15, TimeUnit.SECONDS)).isTrue();
        } finally {
            if (before.isAlive()) before.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore();
             PostgresqlMediaTranscriptStore transcripts = new PostgresqlMediaTranscriptStore()) {
            ProcessingJob recovered = restarted.find(identity.tenantId(), identity.jobId()).orElseThrow();
            assertThat(recovered.status()).isEqualTo(JobStatus.RUNNING);
            assertThat(recovered.version()).isEqualTo(2);
            assertThat(restarted.findProcessingAttempt(identity.tenantId(), identity.jobId(), 1).orElseThrow()
                    .finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(transcripts.revisions(identity.tenantId(), principalId, transcriptId)).isEmpty();
            assertThat(transcripts.revisionByVersionRef(identity.tenantId(), principalId, transcriptVersion))
                    .isEmpty();
            assertThat(outboxCount(identity, "media.job.completed", 3)).isZero();
            assertThat(outboxCount(identity.tenantId(), transcriptId,
                    "media.transcript.revision.created", 1)).isZero();
        }

        Path afterJdbcMarker = tempDir.resolve("stt-after-commit.jdbc.marker");
        Path afterLog = tempDir.resolve("stt-after-commit.log");
        Process after = startWorker(commitGatedEnvironment(environment, "AFTER_COMMIT", afterJdbcMarker),
                tempDir.resolve("stt-after-commit.marker"), identity, afterLog, "commit-transcript");
        try {
            awaitMarker(after, afterJdbcMarker, "POSTGRES_COMMITTED_RETURNED", afterLog);
            assertThat(jobStatus(identity)).isEqualTo("COMPLETED");
            assertThat(outboxCount(identity, "media.job.completed", 3)).isEqualTo(1);
            assertThat(outboxCount(identity.tenantId(), transcriptId,
                    "media.transcript.revision.created", 1)).isEqualTo(1);
            after.destroyForcibly();
            assertThat(after.waitFor(15, TimeUnit.SECONDS)).isTrue();
        } finally {
            if (after.isAlive()) after.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore();
             PostgresqlMediaTranscriptStore transcripts = new PostgresqlMediaTranscriptStore()) {
            ProcessingJob recovered = restarted.find(identity.tenantId(), identity.jobId()).orElseThrow();
            assertThat(recovered.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(recovered.version()).isEqualTo(3);
            assertThat(restarted.findProcessingAttempt(identity.tenantId(), identity.jobId(), 1).orElseThrow()
                    .finality()).isEqualTo(AttemptFinality.SUCCEEDED);
            var revision = transcripts.revisionByVersionRef(identity.tenantId(), principalId, transcriptVersion)
                    .orElseThrow();
            assertThat(revision.revision()).isEqualTo(1);
            assertThat(revision.draft().text()).isEqualTo("crash-safe transcript fixture");
            assertThat(revision.draft().segments()).containsExactly(sourceTicks);
            assertThat(revision.draft().timingAvailability())
                    .isEqualTo(com.ghatana.media.runtime.MediaTranscriptContracts.TimingAvailability.SOURCE_CLOCK_BOUND);
            var attempt = restarted.findProcessingAttempt(identity.tenantId(), identity.jobId(), 1).orElseThrow();
            var binding = transcripts.readAttemptBinding(identity.tenantId(), principalId, transcriptId,
                    revision.revision());
            assertThat(binding.jobId()).isEqualTo(identity.jobId());
            assertThat(binding.attemptNumber()).isEqualTo(1);
            assertThat(binding.fencingToken()).isEqualTo(attempt.fencingToken());
            assertThat(binding.providerId()).isEqualTo("provider-ip06-stt");
            assertThat(binding.providerOperationId()).isEqualTo("operation-ip06-stt-" + runId);
            assertThat(binding.providerReceiptId()).isEqualTo("receipt-ip06-stt-" + runId);
            assertThat(binding.requestFingerprint()).isEqualTo(FINGERPRINT);
            assertThat(binding.sourceArtifactVersionRef()).isEqualTo("sha256:" + "c".repeat(64));
            assertThat(binding.transcriptVersionRef()).isEqualTo(transcriptVersion);
            assertThat(binding.resultDigest()).isEqualTo(attempt.resultDigest());
            TranscriptDraft replayDraft = new TranscriptDraft(
                    identity.tenantId(), principalId, transcriptId, "artifact-stt-" + runId,
                    "sha256:" + "c".repeat(64), "c".repeat(64), identity.jobId(),
                    "profile-ip06-v1", "provider-ip06-stt", "model-ip06-v1", "en-US", "milliseconds",
                    "crash-safe transcript fixture", "consent-stt-" + runId,
                    "rights-ip06-" + runId, "policy-v1", "urn:media:purpose:transcription", "transcription",
                    List.of(sourceTicks));
            assertThat(transcripts.appendFromSuccessfulAttempt(replayDraft, 0, attempt.attemptNumber(),
                    attempt.fencingToken(), FINGERPRINT, transcriptVersion)).isEqualTo(revision);
            assertThat(outboxCount(identity, "media.job.completed", 3)).isEqualTo(1);
            assertThat(outboxCount(identity.tenantId(), transcriptId,
                    "media.transcript.revision.created", 1)).isEqualTo(1);
            assertThat(transcripts.revisions(identity.tenantId(), principalId, transcriptId)).hasSize(1);
        }
    }

    @Test
    void forcibleProcessDeathAfterMultimodalChildUnknownCommitReadsExactChildWithoutRetry(@TempDir Path tempDir)
            throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = createBucket("media-mm-child-crash-" + runId);
        Map<String, String> environment = environment(bucket, "parent-mm-child-crash-" + runId);
        MultimodalIdentity identity = prepareMultimodalChild(environment, runId);
        String applicationName = "media-mm-child-worker-" + runId;
        Path marker = tempDir.resolve("mm-child-committed.marker");
        Path log = tempDir.resolve("mm-child-committed.log");

        Process worker = startWorker(
                withWorkerApplicationName(environment, applicationName), marker, identity.child(), log,
                "record-unknown");
        try {
            awaitMarker(worker, marker, "COMMITTED", log);
            worker.destroyForcibly();
            assertThat(worker.waitFor(15, TimeUnit.SECONDS)).isTrue();
        } finally {
            if (worker.isAlive()) worker.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        // The worker was killed after the child state transaction returned. The restarted
        // assertion reads PostgreSQL only; no provider execution or parent-process memory is
        // used to reconstruct the child receipt/finality.
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore()) {
            ProcessingJob parent = restarted.find(identity.parent().tenantId(), identity.parent().jobId())
                    .orElseThrow();
            ProcessingJob child = restarted.find(identity.child().tenantId(), identity.child().jobId())
                    .orElseThrow();
            assertThat(parent.status()).isEqualTo(JobStatus.RUNNING);
            assertThat(parent.artifactId()).isEqualTo(identity.replayParent().artifactId());
            assertThat(parent.expectedArtifactVersion()).isEqualTo(identity.replayParent().expectedArtifactVersion());
            assertThat(parent.requestFingerprint()).isEqualTo(identity.replayParent().requestFingerprint());
            assertThat(restarted.findMultimodalOperationSnapshot(
                    identity.parent().tenantId(), identity.parent().jobId()).orElseThrow().operationSpec())
                    .isEqualTo(identity.operationSpec());
            assertThat(child.requestId()).isEqualTo(identity.replayChild().requestId());
            assertThat(child.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(child.version()).isEqualTo(3);
            assertThat(child.artifactId()).isEqualTo(identity.replayChild().artifactId());
            assertThat(child.expectedArtifactVersion()).isEqualTo(
                    identity.replayChild().expectedArtifactVersion());
            assertThat(child.requestFingerprint()).isEqualTo(identity.replayChild().requestFingerprint());
            var attempt = restarted.findProcessingAttempt(child.tenantId(), child.jobId(), 1).orElseThrow();
            assertThat(attempt.requestId()).isEqualTo(child.requestId());
            assertThat(attempt.providerId()).isEqualTo("provider-mm-child-fixture");
            assertThat(attempt.requestFingerprint()).isEqualTo(child.requestFingerprint());
            assertThat(attempt.finality()).isEqualTo(AttemptFinality.UNKNOWN);
            assertThat(attempt.providerOperationId()).isEqualTo("fixture-operation-" + child.jobId());
            assertThat(attempt.providerReceiptId()).isEqualTo("fixture-receipt-" + child.jobId());
            assertThat(attempt.observedAt()).isNotNull();
            assertThat(restarted.findProcessingAttempt(child.tenantId(), child.jobId(), 2)).isEmpty();

            ProcessingJob exactReplay = restarted.create(
                    identity.replayChild(), identity.replayChild().requestFingerprint(), null, null);
            assertThat(exactReplay.jobId()).isEqualTo(child.jobId());
            assertThat(restarted.findByRequest(child.tenantId(), child.requestId())).contains(child);
            assertThat(restarted.findProcessingAttempt(child.tenantId(), child.jobId(), 2)).isEmpty();
            assertThat(outboxCount(identity.child(), "media.job.outcome_unknown", child.version())).isEqualTo(1);
        }
    }

    private static MultimodalIdentity prepareMultimodalChild(Map<String, String> environment, String runId)
            throws Exception {
        String tenantId = "tenant-mm-crash-" + runId;
        String principalId = "principal-mm-crash-" + runId;
        String requestId = "request-mm-crash-" + runId;
        String parentJobId = "job-mm-crash-" + runId;
        String childJobId = "job-mm-vision-" + runId;
        String sourceSha = "a".repeat(64);
        String childSha = "b".repeat(64);
        MultimodalOperationSpec spec = new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-observe-source-grounded",
                1, "artifact-mm-source", "sha256:" + sourceSha, sourceSha,
                List.of(new MultimodalOperationSpec.ChildOperationSpec(
                        "vision", JobType.VISION, "artifact-mm-vision", "sha256:" + childSha,
                        childSha, "provider-mm-child-fixture", Map.of())),
                new MultimodalOperationSpec.SourceClockBinding(
                        "clock-evidence-fixture", 48_000, 0, "source-clock-fixture", 48_000),
                Map.of("purpose", "mm-crash-fixture"));
        MultimodalOperationSnapshot snapshot = new MultimodalOperationSnapshot(
                MultimodalOperationSnapshot.AUTHORIZED_VERSION, spec.toParametersValue(),
                "rights-fixture", "policy-fixture", "policy-v1", "consent-fixture",
                "clock-evidence-fixture", 0L);
        String childRequestId = MultimodalOperationSpec.childRequestId(requestId, "vision");
        Instant now = Instant.ofEpochMilli(System.currentTimeMillis());
        ProcessingJob parent = new ProcessingJob(parentJobId, requestId, tenantId, principalId,
                "artifact-mm-source", JobType.MULTIMODAL, "provider-mm-fixture", JobStatus.ACCEPTED,
                now, null, null, Map.of(), "", 1, "sha256:" + sourceSha, FINGERPRINT);
        ProcessingJob child = new ProcessingJob(childJobId, childRequestId, tenantId, principalId,
                "artifact-mm-vision", JobType.VISION, "provider-mm-child-fixture", JobStatus.ACCEPTED,
                now, null, null, Map.of(), "", 1, "sha256:" + childSha,
                "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            store.create(parent, FINGERPRINT, null, snapshot);
            JobLease parentLease = store.claim(parent, "mm-parent-fixture", Instant.now().plusSeconds(120));
            ProcessingJob runningParent = running(parent);
            store.startAttempt(parent, runningParent, parentLease, 1, FINGERPRINT);

            store.create(child, child.requestFingerprint());
            JobLease childLease = store.claim(child, "mm-child-fixture", Instant.now().plusSeconds(120));
            store.startAttempt(child, running(child), childLease, 1, child.requestFingerprint());
        }
        return new MultimodalIdentity(new JobIdentity(tenantId, parentJobId),
                new JobIdentity(tenantId, childJobId), parent, child, spec);
    }

    private static ProcessingJob running(ProcessingJob accepted) {
        return new ProcessingJob(accepted.jobId(), accepted.requestId(), accepted.tenantId(),
                accepted.principalId(), accepted.artifactId(), accepted.jobType(), accepted.providerId(),
                JobStatus.RUNNING, accepted.createdAt(), Instant.now(), null, Map.of(), "",
                accepted.version() + 1, accepted.expectedArtifactVersion(), accepted.requestFingerprint());
    }

    private static JobIdentity prepareDispatchedJob(Map<String, String> environment, String runId)
            throws Exception {
        String tenantId = "tenant-ip06-" + runId;
        String jobId = "job-ip06-" + runId;
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            Instant createdAt = Instant.ofEpochMilli(System.currentTimeMillis());
            ProcessingJob accepted = new ProcessingJob(jobId, "request-ip06-" + runId, tenantId,
                    "principal-ip06-" + runId, "artifact-ip06-" + runId, JobType.TRANSCODE,
                    "provider-ip06", JobStatus.ACCEPTED, createdAt, null, null, Map.of(), "", 1,
                    "", FINGERPRINT);
            store.create(accepted);
            var lease = store.claim(accepted, "worker-ip06", Instant.now().plusSeconds(120));
            ProcessingJob running = new ProcessingJob(jobId, accepted.requestId(), tenantId,
                    accepted.principalId(), accepted.artifactId(), accepted.jobType(), accepted.providerId(),
                    JobStatus.RUNNING, createdAt, Instant.now(), null, Map.of(), "", 2, "", FINGERPRINT);
            var started = store.startAttempt(accepted, running, lease, 1, FINGERPRINT);
            store.recordProviderReceipt(started.attempt(), lease,
                    "operation-" + runId, "receipt-" + runId);
        }
        return new JobIdentity(tenantId, jobId);
    }

    private static JobIdentity prepareDispatchedSttJob(Map<String, String> environment, String runId)
            throws Exception {
        String tenantId = "tenant-ip06-stt-" + runId;
        String jobId = "job-ip06-stt-" + runId;
        String principalId = "principal-stt-" + runId;
        String artifactId = "artifact-stt-" + runId;
        String digest = "c".repeat(64);
        String sourceVersion = "sha256:" + digest;
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            try (Connection connection = databaseConnection();
                 var insert = connection.prepareStatement("""
                         INSERT INTO media_artifacts (tenant_id,artifact_id,principal_id,file_name,content_type,
                           size_bytes,sha256,object_reference,classification,created_at,expires_at,metadata_json,scan_status)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                         """)) {
                long now = System.currentTimeMillis();
                insert.setString(1, tenantId); insert.setString(2, artifactId); insert.setString(3, principalId);
                insert.setString(4, "source.wav"); insert.setString(5, "audio/wav"); insert.setLong(6, 12);
                insert.setString(7, digest); insert.setString(8, "test-only://ip06/" + artifactId);
                insert.setString(9, "CONFIDENTIAL"); insert.setLong(10, now);
                insert.setLong(11, now + TimeUnit.HOURS.toMillis(1)); insert.setString(12, "{}");
                insert.setString(13, "CLEAN"); insert.executeUpdate();
            }
            try (Connection connection = databaseConnection();
                 var insert = connection.prepareStatement("""
                         INSERT INTO media_consents (tenant_id,consent_id,principal_id,purposes_csv,
                           allowed_regions_csv,external_processing_allowed,biometric_processing_allowed,
                           granted_at,revoked_at,version)
                         VALUES (?,?,?,'transcription','local',false,false,?,NULL,1)
                         """)) {
                insert.setString(1, tenantId); insert.setString(2, "consent-stt-" + runId);
                insert.setString(3, principalId); insert.setLong(4, System.currentTimeMillis());
                insert.executeUpdate();
            }
            Instant createdAt = Instant.ofEpochMilli(System.currentTimeMillis());
            ProcessingJob accepted = new ProcessingJob(jobId, "request-ip06-stt-" + runId, tenantId,
                    principalId, artifactId, JobType.SPEECH_TO_TEXT, "provider-ip06-stt", JobStatus.ACCEPTED,
                    createdAt, null, null, Map.of(), "", 1, sourceVersion, FINGERPRINT);
            store.create(accepted, FINGERPRINT, new SttSubmissionSnapshot(
                    SttSubmissionSnapshot.AUTHORIZED_VERSION, null, null, "rights-ip06-" + runId,
                    "policy-decision-ip06-" + runId, "policy-v1", "consent-stt-" + runId,
                    "source-clock-ip06-" + runId, 0L));
            JobLease lease = store.claim(accepted, "worker-ip06-stt", Instant.now().plusSeconds(120));
            ProcessingJob running = new ProcessingJob(jobId, accepted.requestId(), tenantId, principalId,
                    artifactId, JobType.SPEECH_TO_TEXT, accepted.providerId(), JobStatus.RUNNING, createdAt,
                    Instant.now(), null, Map.of(), "", 2, sourceVersion, FINGERPRINT);
            var started = store.startAttempt(accepted, running, lease, 1, FINGERPRINT);
            store.recordProviderReceipt(started.attempt(), lease,
                    "operation-ip06-stt-" + runId, "receipt-ip06-stt-" + runId);
        }
        return new JobIdentity(tenantId, jobId);
    }

    private static Process startWorker(
            Map<String, String> environment, Path marker, JobIdentity identity, Path log,
            String... workerOptions) throws Exception {
        String classpath = System.getProperty("media.child.classpath", "");
        if (classpath.isBlank()) throw new IllegalStateException("Gradle did not provide media.child.classpath");
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        java.util.ArrayList<String> command = new java.util.ArrayList<>(List.of(
                java.toString(), "-cp", classpath,
                MediaPostgresqlProcessCrashWorker.class.getName(), marker.toString(),
                identity.tenantId(), identity.jobId()));
        command.addAll(List.of(workerOptions));
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.environment().putAll(environment);
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitMarker(Process process, Path marker, String expected, Path log) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) {
            if (Files.exists(marker) && Files.readString(marker, StandardCharsets.UTF_8).contains(expected)) return;
            if (!process.isAlive()) throw new AssertionError("crash worker exited before " + expected + ": " + logText(log));
            Thread.sleep(25);
        }
        throw new AssertionError("timed out waiting for " + expected + ": " + logText(log));
    }

    private static void awaitLockWait(String applicationName) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        try (Connection connection = databaseConnection();
             var query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM pg_stat_activity WHERE application_name=? AND wait_event_type='Lock'")) {
            query.setString(1, applicationName);
            while (System.nanoTime() < deadline) {
                try (var rows = query.executeQuery()) {
                    rows.next();
                    if (rows.getLong(1) > 0) return;
                }
                Thread.sleep(25);
            }
        }
        throw new AssertionError("child JVM never reached the PostgreSQL commit fence: " + applicationName);
    }

    private static long outboxCount(JobIdentity identity, String eventType, long version) throws Exception {
        return outboxCount(identity.tenantId(), identity.jobId(), eventType, version);
    }

    private static long outboxCount(String tenantId, String aggregateId, String eventType, long version)
            throws Exception {
        try (Connection connection = databaseConnection();
             var query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_processing_lifecycle_outbox "
                             + "WHERE tenant_id=? AND aggregate_id=? AND aggregate_version=? AND event_type=?")) {
            query.setString(1, tenantId);
            query.setString(2, aggregateId);
            query.setLong(3, version);
            query.setString(4, eventType);
            try (var rows = query.executeQuery()) { rows.next(); return rows.getLong(1); }
        }
    }

    private static String jobStatus(JobIdentity identity) throws Exception {
        try (Connection connection = databaseConnection();
             var query = connection.prepareStatement(
                     "SELECT status FROM media_processing_jobs WHERE tenant_id=? AND job_id=?")) {
            query.setString(1, identity.tenantId());
            query.setString(2, identity.jobId());
            try (var rows = query.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getString(1);
            }
        }
    }

    private static Map<String, String> commitGatedEnvironment(
            Map<String, String> base, String mode, Path marker) {
        Map<String, String> gated = new HashMap<>(base);
        gated.put("MEDIA_POSTGRES_DRIVER", MediaIp06CommitGateDriver.class.getName());
        gated.put("MEDIA_IP06_COMMIT_GATE_MODE", mode);
        gated.put("MEDIA_IP06_COMMIT_GATE_MARKER", marker.toString());
        return gated;
    }

    private static Connection databaseConnection() throws Exception {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static String createBucket(String bucket) {
        try (S3Client client = s3Client()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        return bucket;
    }

    private static S3Client s3Client() {
        return S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build();
    }

    private static Map<String, String> environment(String bucket, String applicationName) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", withApplicationName(POSTGRES.getJdbcUrl(), applicationName));
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_IP06_DB_PASSWORD");
        environment.put("MEDIA_IP06_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_IP06_S3_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_IP06_S3_SECRET");
        environment.put("MEDIA_IP06_S3_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_IP06_S3_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static Map<String, String> withWorkerApplicationName(Map<String, String> base, String name) {
        Map<String, String> worker = new HashMap<>(base);
        worker.put("MEDIA_POSTGRES_JDBC_URL", withApplicationName(POSTGRES.getJdbcUrl(), name));
        return worker;
    }

    private static String withApplicationName(String jdbcUrl, String name) {
        return jdbcUrl + (jdbcUrl.contains("?") ? "&" : "?") + "ApplicationName=" + name;
    }

    private static String logText(Path log) throws Exception {
        return Files.exists(log) ? Files.readString(log, StandardCharsets.UTF_8) : "<no child output>";
    }
}
