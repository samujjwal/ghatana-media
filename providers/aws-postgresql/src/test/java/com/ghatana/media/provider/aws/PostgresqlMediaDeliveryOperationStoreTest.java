package com.ghatana.media.provider.aws;

import com.ghatana.media.production.delivery.DeliveryOperationStore;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.Status;
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

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaDeliveryOperationStoreTest {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    @Test
    void operationStateSurvivesStoreRecreationAndEnforcesScopedIdempotencyAndUniqueInsert() throws Exception {
        try (Fixture fixture = openFixture()) {
            DeliveryOperationStore.Operation unknown = operation("request-restart", "a".repeat(64), Status.OUTCOME_UNKNOWN, 1024, null);
            try (PostgresqlMediaDeliveryOperationStore first = new PostgresqlMediaDeliveryOperationStore()) {
                assertThat(first.insertIfAbsent(unknown)).isTrue();
                assertThat(first.insertIfAbsent(unknown)).isFalse();
                DeliveryOperationStore.Operation changed = operation("request-restart", "c".repeat(64), Status.QUEUED, 0, null);
                assertThat(first.insertIfAbsent(changed)).isFalse();
                assertThat(first.update(changed)).isFalse();
            }

            try (PostgresqlMediaDeliveryOperationStore restarted = new PostgresqlMediaDeliveryOperationStore()) {
                assertThat(restarted.find("tenant-1", "request-restart")).contains(unknown);
                DeliveryOperationStore.Operation sent = new DeliveryOperationStore.Operation(
                        unknown.tenantId(), unknown.principalId(), unknown.requestId(), unknown.artifactId(),
                        unknown.versionRef(), unknown.artifactDigest(), unknown.destinationRef(),
                        unknown.requestFingerprint(), Status.SENT, 2048, null);
                assertThat(restarted.update(sent)).isTrue();
            }
            try (PostgresqlMediaDeliveryOperationStore readback = new PostgresqlMediaDeliveryOperationStore()) {
                assertThat(readback.find("tenant-1", "request-restart")).get()
                        .extracting(DeliveryOperationStore.Operation::artifactId,
                                DeliveryOperationStore.Operation::versionRef,
                                DeliveryOperationStore.Operation::status,
                                DeliveryOperationStore.Operation::destinationReceiptRef)
                        .containsExactly("artifact-1", "version:7", Status.SENT, null);
            }

            DeliveryOperationStore.Operation concurrent = operation("request-concurrent", "d".repeat(64), Status.QUEUED, 0, null);
            try (PostgresqlMediaDeliveryOperationStore left = new PostgresqlMediaDeliveryOperationStore();
                 PostgresqlMediaDeliveryOperationStore right = new PostgresqlMediaDeliveryOperationStore();
                 ExecutorService workers = Executors.newFixedThreadPool(2)) {
                CountDownLatch ready = new CountDownLatch(2);
                CountDownLatch start = new CountDownLatch(1);
                AtomicInteger inserted = new AtomicInteger();
                Future<?> leftResult = workers.submit(() -> insertWhenReleased(left, concurrent, ready, start, inserted));
                Future<?> rightResult = workers.submit(() -> insertWhenReleased(right, concurrent, ready, start, inserted));
                ready.await();
                start.countDown();
                leftResult.get();
                rightResult.get();
                assertThat(inserted.get()).isEqualTo(1);
            }
        }
    }

    private static void insertWhenReleased(PostgresqlMediaDeliveryOperationStore store,
                                           DeliveryOperationStore.Operation operation,
                                           CountDownLatch ready, CountDownLatch start, AtomicInteger inserted) {
        ready.countDown();
        try {
            start.await();
            if (store.insertIfAbsent(operation)) inserted.incrementAndGet();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while testing concurrent operation insert", interrupted);
        }
    }

    private static DeliveryOperationStore.Operation operation(String requestId, String fingerprint,
                                                               Status status, int acknowledged, String receipt) {
        return new DeliveryOperationStore.Operation("tenant-1", "principal-1", requestId, "artifact-1",
                "version:7", "a".repeat(64), "destination:exact", fingerprint, status, acknowledged, receipt);
    }

    private static Fixture openFixture() throws Exception {
        String bucket = "media-delivery-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client client = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
        MediaAwsPostgresqlRuntimeState keepAlive = MediaAwsPostgresqlRuntimeState.acquire();
        return new Fixture(installed, keepAlive);
    }

    private record Fixture(AutoCloseable installed, MediaAwsPostgresqlRuntimeState keepAlive) implements AutoCloseable {
        @Override public void close() throws Exception {
            try { keepAlive.release(); } finally { installed.close(); }
        }
    }

    private static Map<String, String> environment(String bucket) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_DELIVERY_DB_PASSWORD");
        env.put("MEDIA_DELIVERY_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_DELIVERY_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_DELIVERY_SECRET");
        env.put("MEDIA_DELIVERY_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_DELIVERY_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }
}
