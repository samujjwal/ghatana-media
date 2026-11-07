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
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.DoubleSupplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** H2-only regression coverage for durable lifecycle outbox claims and retries. */
class PostgresqlMediaLifecycleOutboxSourceTest {

    @Test
    void claimLeaseMustRemainPositiveAfterMillisecondPersistenceConversion() {
        assertThatThrownBy(() -> source(3, Duration.ofNanos(999_999), Duration.ofMillis(50), Duration.ofMillis(200)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("claimLease must be at least one millisecond");
    }

    @Test
    void retryDelayUsesCappedFullJitterWithinPositiveBounds() {
        assertThat(PostgresqlMediaLifecycleOutboxSource.cappedJitteredRetryDelayMillis(
                0, 250, 500, 0.0)).isEqualTo(1);
        assertThat(PostgresqlMediaLifecycleOutboxSource.cappedJitteredRetryDelayMillis(
                0, 250, 500, 0.5)).isEqualTo(126);
        assertThat(PostgresqlMediaLifecycleOutboxSource.cappedJitteredRetryDelayMillis(
                1, 250, 500, 0.5)).isEqualTo(251);
        assertThat(PostgresqlMediaLifecycleOutboxSource.cappedJitteredRetryDelayMillis(
                2, 250, 350, Math.nextDown(1.0))).isEqualTo(350);
        assertThat(PostgresqlMediaLifecycleOutboxSource.cappedJitteredRetryDelayMillis(
                Integer.MAX_VALUE, 250, 350, 0.75)).isBetween(1L, 350L);
        assertThatThrownBy(() -> PostgresqlMediaLifecycleOutboxSource.cappedJitteredRetryDelayMillis(
                0, 250, 500, 1.0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> PostgresqlMediaLifecycleOutboxSource.cappedJitteredRetryDelayMillis(
                0, 0, 500, 0.5)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void retryDeadlineRejectsEpochMillisOverflow() {
        assertThat(PostgresqlMediaLifecycleOutboxSource.retryAtMillis(1_000L, 50L))
                .isEqualTo(1_050L);
        assertThatThrownBy(() -> PostgresqlMediaLifecycleOutboxSource.retryAtMillis(Long.MAX_VALUE - 10, 11))
                .isInstanceOf(ArithmeticException.class);
        assertThatThrownBy(() -> PostgresqlMediaLifecycleOutboxSource.retryAtMillis(1_000L, 0L))
                .isInstanceOf(IllegalArgumentException.class);
    }

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
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
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
                verifyExpiredOwnerCannotAcknowledgeWithoutReplacement();
                verifyClaimTokenOverflowFailsClosed();
                verifyClaimLeaseOverflowFailsClosed();
                verifyAttemptCounterOverflowFailsBeforePublish();
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
        var brokerAccepted = new CopyOnWriteArrayList<String>();
        var expiredOwner = source(3, Duration.ofMillis(100), Duration.ofMillis(50), Duration.ofMillis(200));
        var recoveryOwner = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<PostgresqlMediaLifecycleOutboxSource.BatchResult> oldBatch = worker.submit(
                    () -> expiredOwner.publishPending(publisher(event -> {
                        brokerAccepted.add(event.eventId());
                        publishing.countDown();
                        if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("publisher timed out");
                    }), 10));
            assertThat(publishing.await(5, TimeUnit.SECONDS)).isTrue();
            expireClaim("media:test:outbox-expired-claim");
            assertThat(recoveryOwner.publishPending(publisher(event -> brokerAccepted.add(event.eventId())), 10)
                    .published()).isEqualTo(1);
            release.countDown();
            assertThat(oldBatch.get(5, TimeUnit.SECONDS).published()).isZero();
            assertThat(brokerAccepted).containsExactly("media:test:outbox-expired-claim",
                    "media:test:outbox-expired-claim");
        } finally {
            release.countDown();
            worker.shutdownNow();
            expiredOwner.close();
            recoveryOwner.close();
        }
    }

    private static void expireClaim(String eventId) throws Exception {
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var update = connection.prepareStatement(
                "UPDATE media_processing_lifecycle_outbox SET claim_expires_at=? WHERE event_id=? "
                        + "AND published_at IS NULL AND claim_owner IS NOT NULL")) {
            update.setLong(1, System.currentTimeMillis() - 1);
            update.setString(2, eventId);
            assertThat(update.executeUpdate()).isEqualTo(1);
        } finally {
            state.release();
        }

    }

    private static void verifyExpiredOwnerCannotAcknowledgeWithoutReplacement() throws Exception {
        String eventId = "media:test:outbox-expired-owner-ack";
        insertEvent(eventId);
        CountDownLatch publishing = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        var owner = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<PostgresqlMediaLifecycleOutboxSource.BatchResult> batch = worker.submit(
                    () -> owner.publishPending(publisher(event -> {
                        publishing.countDown();
                        if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("publisher timed out");
                    }), 1));
            assertThat(publishing.await(5, TimeUnit.SECONDS)).isTrue();
            expireClaim(eventId);
            release.countDown();
            assertThat(batch.get(5, TimeUnit.SECONDS).published()).isZero();
        } finally {
            release.countDown();
            worker.shutdownNow();
            owner.close();
        }

        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT attempts,claim_owner,claim_expires_at,published_at FROM media_processing_lifecycle_outbox "
                        + "WHERE event_id=?")) {
            query.setString(1, eventId);
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getInt("attempts")).isZero();
                assertThat(row.getString("claim_owner")).isNotNull();
                assertThat(row.getLong("claim_expires_at")).isLessThan(System.currentTimeMillis());
                assertThat(row.getObject("published_at")).isNull();
            }
        } finally {
            state.release();
        }

        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var delete = connection.prepareStatement(
                "DELETE FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            delete.setString(1, eventId);
            assertThat(delete.executeUpdate()).isEqualTo(1);
        } finally {
            state.release();
        }
    }

    private static void verifyRetryDelayAndDeadLetter() throws Exception {
        String eventId = "media:test:outbox-poison";
        insertEvent(eventId);
        var source = source(3, Duration.ofSeconds(2), Duration.ofMillis(250), Duration.ofMillis(500),
                () -> Math.nextDown(1.0));
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

    private static void verifyClaimTokenOverflowFailsClosed() throws Exception {
        String eventId = "media:test:outbox-claim-token-overflow";
        insertEvent(eventId);
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var update = connection.prepareStatement(
                "UPDATE media_processing_lifecycle_outbox SET claim_token=? WHERE event_id=?")) {
            update.setLong(1, Long.MAX_VALUE);
            update.setString(2, eventId);
            assertThat(update.executeUpdate()).isEqualTo(1);
        } finally {
            state.release();
        }

        var source = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        AtomicInteger providerEffects = new AtomicInteger();
        try {
            assertThatThrownBy(() -> source.publishPending(publisher(event -> providerEffects.incrementAndGet()), 1))
                    .isInstanceOf(ArithmeticException.class);
            assertThat(providerEffects).hasValue(0);
        } finally {
            source.close();
        }

        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT claim_token,claim_owner,published_at FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            query.setString(1, eventId);
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getLong("claim_token")).isEqualTo(Long.MAX_VALUE);
                assertThat(row.getString("claim_owner")).isNull();
                assertThat(row.getObject("published_at")).isNull();
            }
        } finally {
            state.release();
        }

        // Keep the deliberately unclaimable fixture from poisoning later batch tests
        // in the same isolated schema.
        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var delete = connection.prepareStatement(
                "DELETE FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            delete.setString(1, eventId);
            assertThat(delete.executeUpdate()).isEqualTo(1);
        } finally {
            state.release();
        }
    }

    private static void verifyClaimLeaseOverflowFailsClosed() throws Exception {
        String eventId = "media:test:outbox-claim-lease-overflow";
        insertEvent(eventId);
        var source = source(3, Duration.ofMillis(Long.MAX_VALUE), Duration.ofMillis(50), Duration.ofMillis(200));
        AtomicInteger providerEffects = new AtomicInteger();
        try {
            assertThatThrownBy(() -> source.publishPending(
                    publisher(event -> providerEffects.incrementAndGet()), 1))
                    .isInstanceOf(ArithmeticException.class);
            assertThat(providerEffects).hasValue(0);
        } finally {
            source.close();
        }

        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT claim_token,claim_owner,claim_expires_at,published_at "
                        + "FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            query.setString(1, eventId);
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getLong("claim_token")).isZero();
                assertThat(row.getString("claim_owner")).isNull();
                assertThat(row.getObject("claim_expires_at")).isNull();
                assertThat(row.getObject("published_at")).isNull();
            }
        } finally {
            state.release();
        }

        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var delete = connection.prepareStatement(
                "DELETE FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            delete.setString(1, eventId);
            assertThat(delete.executeUpdate()).isEqualTo(1);
        } finally {
            state.release();
        }
    }

    private static void verifyAttemptCounterOverflowFailsBeforePublish() throws Exception {
        String eventId = "media:test:outbox-attempt-counter-overflow";
        insertEvent(eventId);
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var update = connection.prepareStatement(
                "UPDATE media_processing_lifecycle_outbox SET attempts=? WHERE event_id=?")) {
            update.setInt(1, Integer.MAX_VALUE);
            update.setString(2, eventId);
            assertThat(update.executeUpdate()).isEqualTo(1);
        } finally {
            state.release();
        }

        var source = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        AtomicInteger providerEffects = new AtomicInteger();
        try {
            assertThatThrownBy(() -> source.publishPending(
                    publisher(event -> providerEffects.incrementAndGet()), 1))
                    .isInstanceOf(ArithmeticException.class);
            assertThat(providerEffects).hasValue(0);
        } finally {
            source.close();
        }

        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT attempts,claim_token,claim_owner,claim_expires_at,published_at "
                        + "FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            query.setString(1, eventId);
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getInt("attempts")).isEqualTo(Integer.MAX_VALUE);
                assertThat(row.getLong("claim_token")).isZero();
                assertThat(row.getString("claim_owner")).isNull();
                assertThat(row.getObject("claim_expires_at")).isNull();
                assertThat(row.getObject("published_at")).isNull();
            }
        } finally {
            state.release();
        }

        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var delete = connection.prepareStatement(
                "DELETE FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            delete.setString(1, eventId);
            assertThat(delete.executeUpdate()).isEqualTo(1);
        } finally {
            state.release();
        }
    }

    private static PostgresqlMediaLifecycleOutboxSource source(
            int maxAttempts, Duration claimLease, Duration retryBase, Duration retryMax) {
        return new PostgresqlMediaLifecycleOutboxSource(maxAttempts, claimLease, retryBase, retryMax);
    }

    private static PostgresqlMediaLifecycleOutboxSource source(
            int maxAttempts, Duration claimLease, Duration retryBase, Duration retryMax,
            DoubleSupplier jitterSample) {
        return new PostgresqlMediaLifecycleOutboxSource(
                maxAttempts, claimLease, retryBase, retryMax, jitterSample);
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
