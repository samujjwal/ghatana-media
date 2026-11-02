package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
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

    @Test
    void forcibleProcessDeathBeforeCommitRollsBackAttemptJobAndOutboxTogether(@TempDir Path tempDir)
            throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = createBucket("media-ip06-before-" + runId);
        Map<String, String> environment = environment(bucket, "parent-before-" + runId);
        JobIdentity identity = prepareDispatchedJob(environment, runId);
        String applicationName = "media-ip06-worker-before-" + runId;
        Map<String, String> childEnvironment = withWorkerApplicationName(environment, applicationName);
        Path marker = tempDir.resolve("before-commit.marker");
        Path log = tempDir.resolve("before-commit.log");

        try (Connection rowLock = databaseConnection()) {
            rowLock.setAutoCommit(false);
            try (var lock = rowLock.prepareStatement(
                    "SELECT job_id FROM media_processing_jobs WHERE tenant_id=? AND job_id=? FOR UPDATE")) {
                lock.setString(1, identity.tenantId());
                lock.setString(2, identity.jobId());
                try (var result = lock.executeQuery()) { assertThat(result.next()).isTrue(); }
            }

            Process worker = startWorker(childEnvironment, marker, identity, log);
            try {
                awaitMarker(worker, marker, "READY", log);
                awaitLockWait(applicationName);
                worker.destroyForcibly();
                assertThat(worker.waitFor(15, TimeUnit.SECONDS)).isTrue();
            } finally {
                if (worker.isAlive()) worker.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
                rowLock.rollback();
            }
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

        Process worker = startWorker(
                withWorkerApplicationName(environment, "media-ip06-worker-after-" + runId), marker, identity, log);
        try {
            awaitMarker(worker, marker, "COMMITTED", log);
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

    private static Process startWorker(
            Map<String, String> environment, Path marker, JobIdentity identity, Path log) throws Exception {
        String classpath = System.getProperty("media.child.classpath", "");
        if (classpath.isBlank()) throw new IllegalStateException("Gradle did not provide media.child.classpath");
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        ProcessBuilder builder = new ProcessBuilder(java.toString(), "-cp", classpath,
                MediaPostgresqlProcessCrashWorker.class.getName(), marker.toString(),
                identity.tenantId(), identity.jobId());
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
        try (Connection connection = databaseConnection();
             var query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_processing_lifecycle_outbox "
                             + "WHERE tenant_id=? AND aggregate_id=? AND aggregate_version=? AND event_type=?")) {
            query.setString(1, identity.tenantId());
            query.setString(2, identity.jobId());
            query.setLong(3, version);
            query.setString(4, eventType);
            try (var rows = query.executeQuery()) { rows.next(); return rows.getLong(1); }
        }
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
