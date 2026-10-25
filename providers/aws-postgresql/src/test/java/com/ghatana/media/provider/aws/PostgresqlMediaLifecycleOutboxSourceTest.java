package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaLifecycleEventPublisher;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/** H2-only regression coverage for durable lifecycle outbox claims and retries. */
class PostgresqlMediaLifecycleOutboxSourceTest {

    @Test
    void fencesConcurrentAndExpiredClaimsAndBoundsRetries() throws Exception {
        HttpServer readinessEndpoint = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        readinessEndpoint.createContext("/", exchange -> {
            exchange.getResponseHeaders().add("Content-Length", "0");
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        readinessEndpoint.start();

        String bucket = "media-outbox-test";
        Map<String, String> environment = new LinkedHashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
        environment.put("MEDIA_POSTGRES_JDBC_URL", "jdbc:h2:mem:media_outbox_"
                + UUID.randomUUID().toString().replace("-", "")
                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        environment.put("MEDIA_POSTGRES_DRIVER", "org.h2.Driver");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", "http://127.0.0.1:" + readinessEndpoint.getAddress().getPort());
        environment.put("MEDIA_S3_REGION", "us-east-1");
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:OUTBOX_TEST_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:OUTBOX_TEST_SECRET");
        environment.put("OUTBOX_TEST_ACCESS", "test-access");
        environment.put("OUTBOX_TEST_SECRET", "test-secret");

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment)) {
            MediaAwsPostgresqlRuntimeState anchor = MediaAwsPostgresqlRuntimeState.acquire();
            try {
                verifyConcurrentClaimFencing();
                verifyExpiredClaimRecovery();
                verifyRetryDelayAndDeadLetter();
            } finally {
                anchor.release();
            }
        } finally {
            readinessEndpoint.stop(0);
        }
    }

    private static void verifyConcurrentClaimFencing() throws Exception {
        MediaLifecycleEventPublisher accepting = publisher(event -> { });
        insertEvent("media:test:outbox-concurrent");
        CountDownLatch publishing = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        MediaLifecycleEventPublisher blocking = publisher(event -> {
            calls.incrementAndGet();
            publishing.countDown();
            if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("publisher timed out");
        });
        var first = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        var second = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<PostgresqlMediaLifecycleOutboxSource.BatchResult> firstBatch = worker.submit(
                    () -> first.publishPending(blocking, 10));
            boolean started = publishing.await(5, TimeUnit.SECONDS);
            if (!started) firstBatch.get(1, TimeUnit.SECONDS);
            assertThat(started).isTrue();
            assertThat(second.publishPending(accepting, 10).attempted()).isZero();
            assertThat(calls).hasValue(1);
            release.countDown();
            assertThat(firstBatch.get(5, TimeUnit.SECONDS).published()).isEqualTo(1);
        } finally {
            release.countDown();
            worker.shutdownNow();
            first.close();
            second.close();
        }
    }

    private static void verifyExpiredClaimRecovery() throws Exception {
        insertEvent("media:test:outbox-expired-claim");
        CountDownLatch publishing = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        var expiredOwner = source(3, Duration.ofMillis(100), Duration.ofMillis(50), Duration.ofMillis(200));
        var recoveryOwner = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<PostgresqlMediaLifecycleOutboxSource.BatchResult> oldBatch = worker.submit(
                    () -> expiredOwner.publishPending(publisher(event -> {
                        publishing.countDown();
                        if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("publisher timed out");
                    }), 10));
            assertThat(publishing.await(5, TimeUnit.SECONDS)).isTrue();
            Thread.sleep(150);
            assertThat(recoveryOwner.publishPending(publisher(event -> { }), 10).published()).isEqualTo(1);
            release.countDown();
            assertThat(oldBatch.get(5, TimeUnit.SECONDS).published()).isZero();
        } finally {
            release.countDown();
            worker.shutdownNow();
            expiredOwner.close();
            recoveryOwner.close();
        }
    }

    private static void verifyRetryDelayAndDeadLetter() throws Exception {
        String eventId = "media:test:outbox-poison";
        insertEvent(eventId);
        var source = source(3, Duration.ofSeconds(2), Duration.ofMillis(250), Duration.ofMillis(500));
        MediaLifecycleEventPublisher poison = publisher(event -> { throw new IllegalStateException("poison"); });
        try {
            assertThat(source.publishPending(poison, 10).failed()).isEqualTo(1);
            assertThat(source.publishPending(poison, 10).attempted()).isZero();
            Thread.sleep(300);
            assertThat(source.publishPending(poison, 10).failed()).isEqualTo(1);
            assertThat(source.publishPending(poison, 10).attempted()).isZero();
            Thread.sleep(550);
            assertThat(source.publishPending(poison, 10).failed()).isEqualTo(1);
            assertThat(source.publishPending(poison, 10).attempted()).isZero();
        } finally {
            source.close();
        }
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT attempts,dead_lettered_at,claim_owner FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            query.setString(1, eventId);
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getInt("attempts")).isEqualTo(3);
                assertThat(row.getLong("dead_lettered_at")).isPositive();
                assertThat(row.getString("claim_owner")).isNull();
            }
        } finally {
            state.release();
        }
    }

    private static PostgresqlMediaLifecycleOutboxSource source(
            int maxAttempts, Duration claimLease, Duration retryBase, Duration retryMax) {
        return new PostgresqlMediaLifecycleOutboxSource(maxAttempts, claimLease, retryBase, retryMax);
    }

    private static void insertEvent(String eventId) throws Exception {
        MediaLifecycleEvent event = new MediaLifecycleEvent(eventId, "media.test", "tenant-a",
                "principal-a", eventId, "", "job", eventId, 1, "INTERNAL", Instant.now(), Map.of());
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try {
            String payload = state.mapper().writeValueAsString(event);
            try (var connection = state.connection(); var insert = connection.prepareStatement(
                    "INSERT INTO media_processing_lifecycle_outbox(event_id,tenant_id,aggregate_type,aggregate_id,"
                            + "aggregate_version,event_type,payload_json,classification,created_at,published_at,attempts,last_error) "
                            + "VALUES(?,?,?,?,?,?,?,?,?,NULL,0,NULL)")) {
                insert.setString(1, eventId);
                insert.setString(2, event.tenantId());
                insert.setString(3, event.aggregateType());
                insert.setString(4, event.aggregateId());
                insert.setLong(5, event.aggregateVersion());
                insert.setString(6, event.eventType());
                insert.setString(7, payload);
                insert.setString(8, event.classification());
                insert.setLong(9, System.currentTimeMillis());
                insert.executeUpdate();
            }
        } finally {
            state.release();
        }
    }

    @FunctionalInterface
    private interface PublishAction { void publish(MediaLifecycleEvent event) throws Exception; }

    private static MediaLifecycleEventPublisher publisher(PublishAction action) {
        return new MediaLifecycleEventPublisher() {
            @Override public String publisherId() { return "test-publisher"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public void publish(MediaLifecycleEvent event) {
                try { action.publish(event); }
                catch (RuntimeException failure) { throw failure; }
                catch (Exception failure) { throw new IllegalStateException("test publisher failed", failure); }
            }
        };
    }
}
