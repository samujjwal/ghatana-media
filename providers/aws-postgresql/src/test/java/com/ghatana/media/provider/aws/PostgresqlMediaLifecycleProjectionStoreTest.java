package com.ghatana.media.provider.aws;

import com.ghatana.audio.video.infrastructure.messaging.MediaLifecycleEventConsumer;
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
import java.sql.DriverManager;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** PostgreSQL proof for atomic lifecycle projection dedupe, version fencing and lost-ack replay. */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaLifecycleProjectionStoreTest {
    private static final String REDACTED_AGGREGATE = "r1_" + "a".repeat(64);
    private static final String EVENT_REF = "r1_" + "b".repeat(64);
    private static final String FINGERPRINT = "c".repeat(64);

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void concurrentDuplicateAndColdRestartReplayAreAtomicAndVersionFenced(@TempDir Path tempDir) throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String tenantId = "tenant-lifecycle-projection-" + runId;
        String bucket = "media-projection-" + runId;
        createBucket(bucket);
        Map<String, String> environment = environment(bucket);
        String childAggregate = "r1_" + "d".repeat(64);
        String childEvent = "r1_" + "e".repeat(64);
        String childFingerprint = "f".repeat(64);

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaLifecycleProjectionStore store = new PostgresqlMediaLifecycleProjectionStore()) {
            var ready = new CountDownLatch(2);
            var start = new CountDownLatch(1);
            try (var workers = Executors.newFixedThreadPool(2)) {
                var first = workers.submit(() -> applyAfterStart(
                        store, tenantId, REDACTED_AGGREGATE, EVENT_REF, FINGERPRINT, ready, start));
                var second = workers.submit(() -> applyAfterStart(
                        store, tenantId, REDACTED_AGGREGATE, EVENT_REF, FINGERPRINT, ready, start));
                assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
                start.countDown();
                assertThat(java.util.List.of(first.get(10, TimeUnit.SECONDS), second.get(10, TimeUnit.SECONDS)))
                        .containsExactlyInAnyOrder(
                                MediaLifecycleEventConsumer.ProjectionDisposition.APPLIED,
                                MediaLifecycleEventConsumer.ProjectionDisposition.DUPLICATE);
            }

            String conflictingAggregate = "r1_" + "7".repeat(64);
            assertThat(store.apply(tenantId, "job", conflictingAggregate, 2, EVENT_REF, "1".repeat(64)))
                    .isEqualTo(MediaLifecycleEventConsumer.ProjectionDisposition.CONFLICTING_REPLAY);
            assertThat(headCount(tenantId, conflictingAggregate)).isZero();
            assertThat(store.apply(tenantId, "job", REDACTED_AGGREGATE, 1,
                    "r1_" + "c".repeat(64), "2".repeat(64)))
                    .isEqualTo(MediaLifecycleEventConsumer.ProjectionDisposition.OUT_OF_ORDER);
            assertThat(receiptCount(tenantId)).isEqualTo(1);
            assertThat(headVersion(tenantId, REDACTED_AGGREGATE)).isEqualTo(2L);

            Path marker = tempDir.resolve("projection-committed.marker");
            Path log = tempDir.resolve("projection-worker.log");
            Process child = startChild(environment, marker, tenantId, childAggregate,
                    childEvent, childFingerprint, log);
            try {
                awaitCommitMarker(child, marker, log);
                child.destroyForcibly();
                assertThat(child.waitFor(15, TimeUnit.SECONDS)).isTrue();
            } finally {
                if (child.isAlive()) child.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
            }

            // A new adapter instance recovers the committed receipt after the writer process died
            // before its caller could observe the result.
            try (PostgresqlMediaLifecycleProjectionStore restarted = new PostgresqlMediaLifecycleProjectionStore()) {
                assertThat(restarted.apply(tenantId, "job", childAggregate, 7, childEvent, childFingerprint))
                        .isEqualTo(MediaLifecycleEventConsumer.ProjectionDisposition.DUPLICATE);
                assertThat(restarted.apply(tenantId, "job", childAggregate, 7, childEvent, "0".repeat(64)))
                        .isEqualTo(MediaLifecycleEventConsumer.ProjectionDisposition.CONFLICTING_REPLAY);
                assertThat(restarted.apply(tenantId, "job", childAggregate, 6,
                        "r1_" + "9".repeat(64), "8".repeat(64)))
                        .isEqualTo(MediaLifecycleEventConsumer.ProjectionDisposition.OUT_OF_ORDER);
            }
            assertThat(receiptCount(tenantId)).isEqualTo(2);
            assertThat(headVersion(tenantId, childAggregate)).isEqualTo(7L);
        }
    }

    private static MediaLifecycleEventConsumer.ProjectionDisposition applyAfterStart(
            PostgresqlMediaLifecycleProjectionStore store, String tenantId, String aggregateRef,
            String eventRef, String fingerprint, CountDownLatch ready, CountDownLatch start) throws Exception {
        ready.countDown();
        if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("concurrent start timed out");
        return store.apply(tenantId, "job", aggregateRef, 2, eventRef, fingerprint);
    }

    private static Process startChild(Map<String, String> environment, Path marker, String tenantId,
            String aggregateRef, String eventRef, String fingerprint, Path log) throws Exception {
        String classpath = System.getProperty("media.child.classpath", "");
        if (classpath.isBlank()) throw new IllegalStateException("Gradle did not provide media.child.classpath");
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        ProcessBuilder builder = new ProcessBuilder(java.toString(), "-cp", classpath,
                MediaLifecycleProjectionCrashWorker.class.getName(), marker.toString(), tenantId,
                aggregateRef, eventRef, fingerprint);
        builder.environment().putAll(environment);
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitCommitMarker(Process child, Path marker, Path log) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            if (Files.exists(marker) && Files.readString(marker, StandardCharsets.UTF_8).contains("COMMITTED")) return;
            if (!child.isAlive()) {
                throw new AssertionError("projection worker exited before lost-ack boundary: "
                        + Files.readString(log, StandardCharsets.UTF_8));
            }
            Thread.sleep(25);
        }
        throw new AssertionError("timed out waiting for committed projection: "
                + Files.readString(log, StandardCharsets.UTF_8));
    }

    private static Map<String, String> environment(String bucket) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_PROJECTION_DB_PASSWORD");
        environment.put("MEDIA_PROJECTION_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_PROJECTION_S3_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_PROJECTION_S3_SECRET");
        environment.put("MEDIA_PROJECTION_S3_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_PROJECTION_S3_SECRET", LOCALSTACK.getSecretKey());
        return environment;
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

    private static long receiptCount(String tenantId) throws Exception {
        try (var connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_lifecycle_projection_receipts WHERE tenant_id=?")) {
            query.setString(1, tenantId);
            try (var rows = query.executeQuery()) { rows.next(); return rows.getLong(1); }
        }
    }

    private static long headVersion(String tenantId, String aggregateRef) throws Exception {
        try (var connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement("""
                     SELECT aggregate_version FROM media_lifecycle_projection_heads
                     WHERE tenant_id=? AND aggregate_type='job' AND aggregate_ref=?
                     """)) {
            query.setString(1, tenantId);
            query.setString(2, aggregateRef);
            try (var rows = query.executeQuery()) { rows.next(); return rows.getLong(1); }
        }
    }

    private static long headCount(String tenantId, String aggregateRef) throws Exception {
        try (var connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement("""
                     SELECT COUNT(*) FROM media_lifecycle_projection_heads
                     WHERE tenant_id=? AND aggregate_type='job' AND aggregate_ref=?
                     """)) {
            query.setString(1, tenantId);
            query.setString(2, aggregateRef);
            try (var rows = query.executeQuery()) { rows.next(); return rows.getLong(1); }
        }
    }
}
