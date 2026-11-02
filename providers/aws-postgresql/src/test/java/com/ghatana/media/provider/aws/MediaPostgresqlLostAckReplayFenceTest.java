package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
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
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** IP-06: lost final-outcome acknowledgement cannot duplicate a committed event or attempt. */
@Testcontainers(disabledWithoutDocker = true)
class MediaPostgresqlLostAckReplayFenceTest {
    private static final String FINGERPRINT =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String PROVENANCE_DIGEST =
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private record JobIdentity(String tenantId, String jobId) { }
    private record Prepared(JobIdentity identity, ProcessingJob running, ProcessingAttempt attempt) { }

    @Test
    void coldRestartRejectsDuplicateCommitAfterChildDiesWithoutAck(@TempDir Path tempDir) throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String tenantId = "tenant-ip06-replay-" + runId;
        String jobId = "job-ip06-replay-" + runId;
        String bucket = "media-ip06-replay-" + runId;
        createBucket(bucket);
        Map<String, String> environment = environment(bucket, "parent-ip06-replay-" + runId);
        Prepared prepared = prepare(environment, runId, tenantId, jobId);
        String applicationName = "media-ip06-replay-child-" + runId;
        Path marker = tempDir.resolve("lost-ack.marker");
        Path log = tempDir.resolve("lost-ack.log");
        Process child = startChild(withApplicationName(environment, applicationName), marker, prepared, log);
        try {
            awaitMarker(child, marker, log);
            child.destroyForcibly();
            assertThat(child.waitFor(15, TimeUnit.SECONDS)).isTrue();
        } finally {
            if (child.isAlive()) child.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        // A new provider instance and direct PostgreSQL queries reconstruct the committed state.
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore()) {
            ProcessingJob durable = restarted.find(tenantId, jobId).orElseThrow();
            ProcessingAttempt durableAttempt = restarted.findProcessingAttempt(tenantId, jobId, 1).orElseThrow();
            assertThat(durable.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(durable.version()).isEqualTo(3);
            assertThat(durable.result()).containsEntry("storedResult", "process-recovery-fixture");
            assertThat(durableAttempt.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
            assertThat(rowCount(tenantId, jobId, "media_processing_attempts")).isEqualTo(1);
            assertThat(outboxCount(tenantId, jobId)).isEqualTo(1);

            Instant retryObservedAt = Instant.now();
            Map<String, Object> result = Map.of("storedResult", "process-recovery-fixture");
            ProcessingJob duplicateTerminal = new ProcessingJob(
                    prepared.running().jobId(), prepared.running().requestId(), prepared.running().tenantId(),
                    prepared.running().principalId(), prepared.running().artifactId(), prepared.running().jobType(),
                    prepared.running().providerId(), JobStatus.COMPLETED, prepared.running().createdAt(),
                    prepared.running().startedAt(), retryObservedAt, result, "", prepared.running().version() + 1,
                    prepared.running().expectedArtifactVersion(), prepared.running().requestFingerprint());
            ProviderAttemptObservation duplicateObservation = new ProviderAttemptObservation(
                    prepared.attempt().query(), AttemptFinality.SUCCEEDED,
                    prepared.attempt().providerReceiptId(), result, PROVENANCE_DIGEST, retryObservedAt);
            MediaLifecycleEvent duplicateEvent = new MediaLifecycleEvent(
                    "media:ip06:completed:" + jobId, "media.job.completed", tenantId,
                    prepared.running().principalId(), prepared.running().requestId(), prepared.running().requestId(),
                    "job", jobId, duplicateTerminal.version(), "INTERNAL", retryObservedAt,
                    Map.of("status", "COMPLETED"));

            // Exact replay after the process lost its acknowledgement is fenced by the durable
            // attempt/job state. It must not append a second event or increment state a second time.
            assertThatThrownBy(() -> restarted.commitFinalOutcome(
                    prepared.running(), prepared.attempt(), duplicateTerminal,
                    duplicateObservation, duplicateEvent))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(restarted.find(tenantId, jobId).orElseThrow()).isEqualTo(durable);
            assertThat(restarted.findProcessingAttempt(tenantId, jobId, 1).orElseThrow()).isEqualTo(durableAttempt);
            assertThat(rowCount(tenantId, jobId, "media_processing_attempts")).isEqualTo(1);
            assertThat(outboxCount(tenantId, jobId)).isEqualTo(1);
            assertThat(directLong("SELECT version FROM media_processing_jobs WHERE tenant_id=? AND job_id=?",
                    tenantId, jobId)).isEqualTo(3L);

            ProcessingJob foreignExpected = new ProcessingJob(
                    jobId, prepared.running().requestId(), "foreign-tenant",
                    prepared.running().principalId(), prepared.running().artifactId(), prepared.running().jobType(),
                    prepared.running().providerId(), JobStatus.RUNNING, prepared.running().createdAt(),
                    prepared.running().startedAt(), null, Map.of(), "", 2, "",
                    prepared.running().requestFingerprint());
            ProcessingJob foreignTerminal = new ProcessingJob(
                    foreignExpected.jobId(), foreignExpected.requestId(), foreignExpected.tenantId(),
                    foreignExpected.principalId(), foreignExpected.artifactId(), foreignExpected.jobType(),
                    foreignExpected.providerId(), JobStatus.COMPLETED, foreignExpected.createdAt(),
                    foreignExpected.startedAt(), retryObservedAt, result, "", 3, "",
                    foreignExpected.requestFingerprint());
            ProcessingAttempt forgedAttempt = new ProcessingAttempt(
                    "foreign-tenant", jobId, prepared.running().requestId(), 1,
                    prepared.attempt().fencingToken(), prepared.running().requestFingerprint(),
                    prepared.running().providerId(), prepared.attempt().providerOperationId(),
                    prepared.attempt().providerReceiptId(), AttemptFinality.UNKNOWN, "", "", null);
            ProviderAttemptObservation foreignObservation = new ProviderAttemptObservation(
                    forgedAttempt.query(), AttemptFinality.SUCCEEDED, forgedAttempt.providerReceiptId(),
                    result, PROVENANCE_DIGEST, retryObservedAt);
            MediaLifecycleEvent foreignEvent = new MediaLifecycleEvent(
                    "media:ip06:foreign:" + jobId, "media.job.completed", foreignExpected.tenantId(),
                    foreignExpected.principalId(), foreignExpected.requestId(), foreignExpected.requestId(),
                    "job", jobId, foreignTerminal.version(), "INTERNAL", retryObservedAt,
                    Map.of("status", "COMPLETED"));
            assertThatThrownBy(() -> restarted.commitFinalOutcome(foreignExpected, forgedAttempt,
                    foreignTerminal, foreignObservation, foreignEvent)).isInstanceOf(RuntimeException.class);
            assertThat(restarted.find(tenantId, jobId).orElseThrow()).isEqualTo(durable);
            assertThat(restarted.findProcessingAttempt(tenantId, jobId, 1).orElseThrow()).isEqualTo(durableAttempt);
            assertThat(outboxCount(tenantId, jobId)).isEqualTo(1);
        }
    }

    private static Prepared prepare(Map<String, String> environment, String runId, String tenantId, String jobId)
            throws Exception {
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            Instant createdAt = Instant.ofEpochMilli(System.currentTimeMillis());
            ProcessingJob accepted = new ProcessingJob(jobId, "request-ip06-replay-" + runId, tenantId,
                    "principal-ip06-replay-" + runId, "artifact-ip06-replay-" + runId, JobType.TRANSCODE,
                    "provider-ip06", JobStatus.ACCEPTED, createdAt, null, null, Map.of(), "", 1, "", FINGERPRINT);
            store.create(accepted);
            var lease = store.claim(accepted, "worker-ip06", Instant.now().plusSeconds(120));
            ProcessingJob running = new ProcessingJob(jobId, accepted.requestId(), tenantId,
                    accepted.principalId(), accepted.artifactId(), accepted.jobType(), accepted.providerId(),
                    JobStatus.RUNNING, createdAt, Instant.now(), null, Map.of(), "", 2, "", FINGERPRINT);
            store.startAttempt(accepted, running, lease, 1, FINGERPRINT);
            store.recordProviderReceipt(
                    store.findProcessingAttempt(tenantId, jobId, 1).orElseThrow(), lease,
                    "operation-" + runId, "receipt-" + runId);
            return new Prepared(new JobIdentity(tenantId, jobId), running,
                    store.findProcessingAttempt(tenantId, jobId, 1).orElseThrow());
        }
    }

    private static Process startChild(
            Map<String, String> environment, Path marker, Prepared prepared, Path log) throws Exception {
        String classpath = System.getProperty("media.child.classpath", "");
        if (classpath.isBlank()) throw new IllegalStateException("Gradle did not provide media.child.classpath");
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        ProcessBuilder builder = new ProcessBuilder(java.toString(), "-cp", classpath,
                MediaPostgresqlProcessCrashWorker.class.getName(), marker.toString(),
                prepared.identity().tenantId(), prepared.identity().jobId());
        builder.environment().putAll(environment);
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitMarker(Process child, Path marker, Path log) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) {
            if (Files.exists(marker) && Files.readString(marker, StandardCharsets.UTF_8).contains("COMMITTED")) return;
            if (!child.isAlive()) throw new AssertionError("worker exited before lost ACK boundary: " + Files.readString(log));
            Thread.sleep(25);
        }
        throw new AssertionError("timed out at lost ACK boundary: " + Files.readString(log));
    }

    private static Map<String, String> environment(String bucket, String applicationName) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", withApplicationName(POSTGRES.getJdbcUrl(), applicationName));
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_IP06_REPLAY_DB_PASSWORD");
        environment.put("MEDIA_IP06_REPLAY_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_IP06_REPLAY_S3_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_IP06_REPLAY_S3_SECRET");
        environment.put("MEDIA_IP06_REPLAY_S3_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_IP06_REPLAY_S3_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static Map<String, String> withApplicationName(Map<String, String> original, String name) {
        Map<String, String> copy = new HashMap<>(original);
        copy.put("MEDIA_POSTGRES_JDBC_URL", withApplicationName(POSTGRES.getJdbcUrl(), name));
        return copy;
    }

    private static String withApplicationName(String jdbcUrl, String name) {
        return jdbcUrl + (jdbcUrl.contains("?") ? "&" : "?") + "ApplicationName=" + name;
    }

    private static void createBucket(String bucket) {
        try (S3Client client = S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
    }

    private static long rowCount(String tenantId, String jobId, String table) throws Exception {
        String sql = switch (table) {
            case "media_processing_attempts" -> "SELECT COUNT(*) FROM media_processing_attempts WHERE tenant_id=? AND job_id=?";
            default -> throw new IllegalArgumentException("unsupported table");
        };
        return directLong(sql, tenantId, jobId);
    }

    private static long outboxCount(String tenantId, String jobId) throws Exception {
        return directLong("SELECT COUNT(*) FROM media_processing_lifecycle_outbox"
                + " WHERE tenant_id=? AND aggregate_id=? AND event_type='media.job.completed'"
                + " AND aggregate_version=3", tenantId, jobId);
    }

    private static long directLong(String sql, String tenantId, String jobId) throws Exception {
        try (Connection connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(sql)) {
            query.setString(1, tenantId);
            query.setString(2, jobId);
            try (var rows = query.executeQuery()) { rows.next(); return rows.getLong(1); }
        }
    }
}
