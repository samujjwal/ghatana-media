package com.ghatana.media.provider.aws;

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

/** IP-06: child-process create crashes before commit, after commit before return, and after return. */
@Testcontainers(disabledWithoutDocker = true)
class MediaPostgresqlCreateLostAckProcessCrashTest {
    private static final String FINGERPRINT =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void childDiesAfterCreateCommitReplayReturnsSameJobAndOneAcceptedEvent(@TempDir Path tempDir) throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String tenantId = "tenant-ip06-create-" + runId;
        String jobId = "job-ip06-create-" + runId;
        String requestId = "request-ip06-create-" + runId;
        String bucket = "media-ip06-create-" + runId;
        createBucket(bucket);

        long createdAtMillis = System.currentTimeMillis();
        ProcessingJob submission = acceptedJob(tenantId, jobId, requestId,
                "principal-ip06-create-" + runId, "artifact-ip06-create-" + runId, createdAtMillis);
        Map<String, String> environment = environment(bucket, "parent-ip06-create-" + runId);
        Path marker = tempDir.resolve("create-committed.marker");
        Path log = tempDir.resolve("create-child.log");
        Process child = startChild(environment, marker, log, tenantId, jobId, requestId,
                submission.principalId(), submission.artifactId(), Long.toString(createdAtMillis));
        try {
            awaitMarker(child, marker, log);
            child.destroyForcibly();
            assertThat(child.waitFor(15, TimeUnit.SECONDS)).isTrue();
        } finally {
            if (child.isAlive()) child.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        // No state is taken from the dead child: read PostgreSQL, then replay the exact request.
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore()) {
            ProcessingJob durable = restarted.find(tenantId, jobId).orElseThrow();
            assertThat(durable).isEqualTo(submission);
            assertThat(jobCount(tenantId, jobId)).isEqualTo(1);
            assertThat(acceptedEventCount(tenantId, submission.principalId(), requestId)).isEqualTo(1);

            ProcessingJob replay = restarted.create(submission);
            assertThat(replay).isEqualTo(durable);
            assertThat(restarted.find(tenantId, jobId).orElseThrow()).isEqualTo(durable);
            assertThat(jobCount(tenantId, jobId)).isEqualTo(1);
            assertThat(acceptedEventCount(tenantId, submission.principalId(), requestId)).isEqualTo(1);
        }
    }

    @Test
    void childDiesAfterDatabaseCommitButBeforeCreateReturns(@TempDir Path tempDir) throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String tenantId = "tenant-ip06-commit-gap-" + runId;
        String jobId = "job-ip06-commit-gap-" + runId;
        String requestId = "request-ip06-commit-gap-" + runId;
        String bucket = "media-ip06-gap-" + runId;
        createBucket(bucket);

        long createdAtMillis = System.currentTimeMillis();
        ProcessingJob submission = acceptedJob(tenantId, jobId, requestId,
                "principal-ip06-gap-" + runId, "artifact-ip06-gap-" + runId, createdAtMillis);
        Map<String, String> environment = environment(bucket, "parent-ip06-gap-" + runId);
        environment.put("MEDIA_POSTGRES_DRIVER", MediaIp06CommitGateDriver.class.getName());
        Path marker = tempDir.resolve("jdbc-commit-return.marker");
        Path log = tempDir.resolve("jdbc-commit-return-child.log");
        environment.put("MEDIA_IP06_COMMIT_GATE_MARKER", marker.toString());
        Process child = startChild(environment, marker, log, tenantId, jobId, requestId,
                submission.principalId(), submission.artifactId(), Long.toString(createdAtMillis));
        try {
            awaitMarker(child, marker, log);

            // The test Driver writes this marker only after the delegate's PostgreSQL commit has
            // returned. The child is now blocked inside Connection.commit(), before create() can
            // receive that return or emit its own acknowledgement.
            assertThat(jobCount(tenantId, jobId)).isEqualTo(1);
            assertThat(acceptedEventCount(tenantId, submission.principalId(), requestId)).isEqualTo(1);
            child.destroyForcibly();
            assertThat(child.waitFor(15, TimeUnit.SECONDS)).isTrue();
        } finally {
            if (child.isAlive()) child.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(
                     environmentWithPostgresDriver(environment));
             PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore()) {
            ProcessingJob durable = restarted.find(tenantId, jobId).orElseThrow();
            assertThat(durable).isEqualTo(submission);
            assertThat(restarted.create(submission)).isEqualTo(durable);
            assertThat(jobCount(tenantId, jobId)).isEqualTo(1);
            assertThat(acceptedEventCount(tenantId, submission.principalId(), requestId)).isEqualTo(1);
        }
    }

    @Test
    void childDiesBeforeDatabaseCommitLeavesNoJobOrAcceptedEvent(@TempDir Path tempDir) throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String tenantId = "tenant-ip06-pre-commit-" + runId;
        String jobId = "job-ip06-pre-commit-" + runId;
        String requestId = "request-ip06-pre-commit-" + runId;
        String bucket = "media-ip06-pre-commit-" + runId;
        createBucket(bucket);

        long createdAtMillis = System.currentTimeMillis();
        ProcessingJob submission = acceptedJob(tenantId, jobId, requestId,
                "principal-ip06-pre-commit-" + runId, "artifact-ip06-pre-commit-" + runId, createdAtMillis);
        Map<String, String> gatedEnvironment = environment(bucket, "parent-ip06-pre-commit-" + runId);
        gatedEnvironment.put("MEDIA_POSTGRES_DRIVER", MediaIp06CommitGateDriver.class.getName());
        gatedEnvironment.put("MEDIA_IP06_COMMIT_GATE_MODE", "BEFORE_COMMIT");
        Path marker = tempDir.resolve("create-pre-commit.marker");
        Path log = tempDir.resolve("create-pre-commit-child.log");
        gatedEnvironment.put("MEDIA_IP06_COMMIT_GATE_MARKER", marker.toString());
        Process child = startChild(gatedEnvironment, marker, log, tenantId, jobId, requestId,
                submission.principalId(), submission.artifactId(), Long.toString(createdAtMillis));
        try {
            awaitMarker(child, marker, log, "PRE_COMMIT");
            // The database transaction is open but uncommitted; independent readers cannot see
            // either half of the atomic job/outbox acceptance.
            assertThat(jobCount(tenantId, jobId)).isZero();
            assertThat(acceptedEventCount(tenantId, submission.principalId(), requestId)).isZero();
            child.destroyForcibly();
            assertThat(child.waitFor(15, TimeUnit.SECONDS)).isTrue();
        } finally {
            if (child.isAlive()) child.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        Map<String, String> ordinaryEnvironment = environmentWithPostgresDriver(gatedEnvironment);
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(ordinaryEnvironment);
             PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore()) {
            assertThat(restarted.find(tenantId, jobId)).isEmpty();
            assertThat(jobCount(tenantId, jobId)).isZero();
            assertThat(acceptedEventCount(tenantId, submission.principalId(), requestId)).isZero();

            ProcessingJob accepted = restarted.create(submission);
            assertThat(accepted).isEqualTo(submission);
            assertThat(jobCount(tenantId, jobId)).isEqualTo(1);
            assertThat(acceptedEventCount(tenantId, submission.principalId(), requestId)).isEqualTo(1);
            assertThat(restarted.create(submission)).isEqualTo(accepted);
            assertThat(jobCount(tenantId, jobId)).isEqualTo(1);
            assertThat(acceptedEventCount(tenantId, submission.principalId(), requestId)).isEqualTo(1);
        }
    }

    private static ProcessingJob acceptedJob(
            String tenantId, String jobId, String requestId, String principalId, String artifactId, long createdAtMillis) {
        return new ProcessingJob(jobId, requestId, tenantId, principalId, artifactId, JobType.TRANSCODE,
                "provider-ip06", JobStatus.ACCEPTED, Instant.ofEpochMilli(createdAtMillis), null, null,
                Map.of(), "", 1, "", FINGERPRINT);
    }

    private static Process startChild(
            Map<String, String> environment, Path marker, Path log, String... identity) throws Exception {
        String classpath = System.getProperty("media.child.classpath", "");
        if (classpath.isBlank()) throw new IllegalStateException("Gradle did not provide media.child.classpath");
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        ProcessBuilder builder = new ProcessBuilder(java.toString(), "-cp", classpath,
                MediaPostgresqlCreateLostAckWorker.class.getName(), marker.toString(),
                FINGERPRINT, String.join("\n", identity));
        builder.environment().putAll(environment);
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitMarker(Process child, Path marker, Path log) throws Exception {
        awaitMarker(child, marker, log, "COMMITTED");
    }

    private static void awaitMarker(Process child, Path marker, Path log, String expectedState) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) {
            if (Files.exists(marker)
                    && Files.readString(marker, StandardCharsets.UTF_8).contains(expectedState)) return;
            if (!child.isAlive()) throw new AssertionError("worker exited before lost-ACK boundary: " + Files.readString(log));
            Thread.sleep(25);
        }
        throw new AssertionError("timed out at lost-ACK boundary: " + Files.readString(log));
    }

    private static Map<String, String> environment(String bucket, String applicationName) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", withApplicationName(POSTGRES.getJdbcUrl(), applicationName));
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_IP06_CREATE_DB_PASSWORD");
        environment.put("MEDIA_IP06_CREATE_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_IP06_CREATE_S3_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_IP06_CREATE_S3_SECRET");
        environment.put("MEDIA_IP06_CREATE_S3_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_IP06_CREATE_S3_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static Map<String, String> environmentWithPostgresDriver(Map<String, String> environment) {
        Map<String, String> result = new HashMap<>(environment);
        result.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        result.remove("MEDIA_IP06_COMMIT_GATE_MARKER");
        return result;
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

    private static long jobCount(String tenantId, String jobId) throws Exception {
        return queryCount("SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=? AND job_id=?",
                tenantId, jobId);
    }

    private static long acceptedEventCount(String tenantId, String principalId, String requestId) throws Exception {
        return queryCount("SELECT COUNT(*) FROM media_lifecycle_outbox"
                + " WHERE tenant_id=? AND subject_id=? AND correlation_id=? AND event_type='MEDIA_JOB_ACCEPTED'",
                tenantId, principalId, requestId);
    }

    private static long queryCount(String sql, String tenantId, String firstKey, String... remainingKeys)
            throws Exception {
        try (Connection connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(sql)) {
            query.setString(1, tenantId);
            query.setString(2, firstKey);
            for (int i = 0; i < remainingKeys.length; i++) query.setString(i + 3, remainingKeys[i]);
            try (var rows = query.executeQuery()) { rows.next(); return rows.getLong(1); }
        }
    }
}
