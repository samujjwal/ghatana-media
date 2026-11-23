package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaLifecycleEventPublisher;
import com.ghatana.media.runtime.MediaLifecyclePublicationReceipt;
import com.ghatana.media.runtime.MediaLifecyclePublicationOutcomeUnknownException;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
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
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.DoubleSupplier;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** H2-only regression coverage for durable lifecycle outbox claims and retries. */
class PostgresqlMediaLifecycleOutboxSourceTest {

    @Test
    void acceptedJobAndCanonicalOutboxCommitAtomicallyAndReplayWithoutDuplicatePublication() throws Exception {
        HttpServer readinessEndpoint = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        readinessEndpoint.createContext("/", exchange -> {
            exchange.getResponseHeaders().add("Content-Length", "0");
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        readinessEndpoint.start();
        Map<String, String> environment = new LinkedHashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", "jdbc:h2:mem:media_accepted_"
                + UUID.randomUUID().toString().replace("-", "")
                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        environment.put("MEDIA_POSTGRES_DRIVER", "org.h2.Driver");
        environment.put("MEDIA_S3_BUCKET", "media-accepted-test");
        environment.put("MEDIA_S3_ENDPOINT", "http://127.0.0.1:" + readinessEndpoint.getAddress().getPort());
        environment.put("MEDIA_S3_REGION", "us-east-1");
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:ACCEPTED_TEST_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:ACCEPTED_TEST_SECRET");
        environment.put("ACCEPTED_TEST_ACCESS", "test-access");
        environment.put("ACCEPTED_TEST_SECRET", "test-secret");

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment)) {
            MediaAwsPostgresqlRuntimeState anchor = MediaAwsPostgresqlRuntimeState.acquire();
            try {
                ProcessingJob job = acceptedJob("tenant-accepted", "request-accepted", "job-accepted");
                MediaLifecycleEvent event = acceptedEvent(job, "INTERNAL");
                String digest = "a".repeat(64);
                try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
                    assertThat(store.supportsAtomicAcceptedLifecycleEvent()).isTrue();
                    assertThatThrownBy(() -> store.create(job, digest, null, null,
                            acceptedEvent(job, "PUBLIC")))
                            .isInstanceOf(IllegalArgumentException.class)
                            .hasMessageContaining("exactly match");
                    assertThatThrownBy(() -> store.create(job, digest, null, null,
                            new MediaLifecycleEvent(event.eventId(), event.eventType(), "tenant-other",
                                    event.principalId(), event.correlationId(), event.causationId(),
                                    event.aggregateType(), event.aggregateId(), event.aggregateVersion(),
                                    event.classification(), event.occurredAt(), event.attributes())))
                            .isInstanceOf(IllegalArgumentException.class)
                            .hasMessageContaining("exactly match");
                    assertThat(store.find("tenant-accepted", "job-accepted")).isEmpty();
                    assertThat(countV011Accepted("tenant-accepted")).isZero();
                    assertThat(countCanonicalEvents(event.eventId())).isZero();
                    assertThat(store.create(job, digest, null, null, event)).isEqualTo(job);
                    assertThat(store.create(job, digest, null, null, event)).isEqualTo(job);
                    assertThat(countV011Accepted("tenant-accepted")).isEqualTo(1);
                    assertThat(readCanonicalEvent(event.eventId())).isEqualTo(event);
                    assertThat(countCanonicalEvents(event.eventId())).isEqualTo(1);
                }

                try (PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore()) {
                    assertThat(restarted.find("tenant-accepted", "job-accepted")).contains(job);
                    assertThat(readCanonicalEvent(event.eventId())).isEqualTo(event);
                }
                AtomicInteger publications = new AtomicInteger();
                try (PostgresqlMediaLifecycleOutboxSource source = source(
                        3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200))) {
                    MediaLifecycleEventPublisher publisher = publisherWithOffset(
                            published -> {
                                assertThat(published).isEqualTo(event);
                                publications.incrementAndGet();
                            }, ignored -> "7");
                    assertThat(source.publishPending(publisher, 10).published()).isEqualTo(1);
                    assertThat(source.publishPending(publisher, 10).attempted()).isZero();
                }
                assertThat(publications).hasValue(1);
                try (var connection = anchor.connection(); var query = connection.prepareStatement(
                        "SELECT published_at,event_plane_offset FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
                    query.setString(1, event.eventId());
                    try (var row = query.executeQuery()) {
                        assertThat(row.next()).isTrue();
                        assertThat(row.getLong("published_at")).isPositive();
                        assertThat(row.getString("event_plane_offset")).isEqualTo("7");
                    }
                }

                ProcessingJob legacyJob = acceptedJob("tenant-legacy", "request-legacy", "job-legacy");
                MediaLifecycleEvent legacyEvent = acceptedEvent(legacyJob, "INTERNAL");
                try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
                    assertThat(store.create(legacyJob, digest, null, null)).isEqualTo(legacyJob);
                    assertThat(store.create(legacyJob, digest, null, null, legacyEvent)).isEqualTo(legacyJob);
                    assertThat(countV011Accepted("tenant-legacy")).isEqualTo(1);
                    assertThat(countCanonicalEvents(legacyEvent.eventId())).isZero();
                }

                ProcessingJob rollbackJob = acceptedJob("tenant-rollback", "request-rollback", "job-rollback");
                MediaLifecycleEvent rollbackEvent = acceptedEvent(rollbackJob, "INTERNAL");
                seedConflictingCanonicalEvent(rollbackEvent.eventId());
                try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
                    assertThatThrownBy(() -> store.create(rollbackJob, digest, null, null, rollbackEvent))
                            .isInstanceOf(IllegalStateException.class);
                    assertThat(store.find("tenant-rollback", "job-rollback")).isEmpty();
                }
                assertThat(countV011Accepted("tenant-rollback")).isZero();
                assertThat(countCanonicalEvents(rollbackEvent.eventId())).isEqualTo(1);
            } finally {
                anchor.release();
            }
        } finally {
            readinessEndpoint.stop(0);
        }
    }

    private static ProcessingJob acceptedJob(String tenantId, String requestId, String jobId) {
        return new ProcessingJob(jobId, requestId, tenantId, "principal-a", "artifact-a", JobType.TRANSCODE,
                "local", JobStatus.ACCEPTED, Instant.parse("2026-11-22T12:00:00Z"), null, null,
                Map.of(), "", 1, "sha256:" + "b".repeat(64), "c".repeat(64));
    }

    private static MediaLifecycleEvent acceptedEvent(ProcessingJob job, String classification) {
        return new MediaLifecycleEvent("media:media.job.accepted:" + job.jobId() + ":" + job.version(),
                "media.job.accepted", job.tenantId(), job.principalId(), "correlation-accepted", job.requestId(),
                "processing-job", job.jobId(), job.version(), classification, job.createdAt(), Map.of(
                        "jobId", job.jobId(), "operationRef", "media.operation-slice.submit-job",
                        "admissionState", "ACCEPTED"));
    }

    private static MediaLifecycleEvent readCanonicalEvent(String eventId) throws Exception {
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT payload_json FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            query.setString(1, eventId);
            try (var row = query.executeQuery()) {
                if (!row.next()) throw new AssertionError("canonical accepted event is missing");
                return state.mapper().readValue(row.getString("payload_json"), MediaLifecycleEvent.class);
            }
        } finally {
            state.release();
        }
    }

    private static long countCanonicalEvents(String eventId) throws Exception {
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT COUNT(*) FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            query.setString(1, eventId);
            try (var row = query.executeQuery()) { row.next(); return row.getLong(1); }
        } finally {
            state.release();
        }
    }

    private static long countV011Accepted(String tenantId) throws Exception {
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT COUNT(*) FROM media_lifecycle_outbox WHERE tenant_id=? AND event_type='MEDIA_JOB_ACCEPTED'")) {
            query.setString(1, tenantId);
            try (var row = query.executeQuery()) { row.next(); return row.getLong(1); }
        } finally {
            state.release();
        }
    }

    private static void seedConflictingCanonicalEvent(String eventId) throws Exception {
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var insert = connection.prepareStatement(
                "INSERT INTO media_processing_lifecycle_outbox(event_id,tenant_id,aggregate_type,aggregate_id,"
                        + "aggregate_version,event_type,payload_json,classification,created_at,published_at,attempts,last_error) "
                        + "VALUES(?,?,?,?,?,?,?,?,?,NULL,0,NULL)")) {
            insert.setString(1, eventId);
            insert.setString(2, "tenant-rollback");
            insert.setString(3, "processing-job");
            insert.setString(4, "other-job");
            insert.setLong(5, 1L);
            insert.setString(6, "media.test");
            insert.setString(7, "{}");
            insert.setString(8, "INTERNAL");
            insert.setLong(9, Instant.parse("2026-11-22T12:00:00Z").toEpochMilli());
            insert.executeUpdate();
        } finally {
            state.release();
        }
    }

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
                verifyRowPayloadIdentityMismatchFailsBeforePublish();
                verifyRowPayloadTenantMismatchFailsBeforePublish();
                verifyRowPayloadOccurrenceMismatchFailsBeforePublish();
                verifyConcurrentClaimFencing();
                verifyTenantCursorNeverMovesBackward();
                verifyCursorUpdateFailureLeavesAckPendingAndRecoversByReadback();
                verifyExpiredClaimRecovery();
                verifyExpiredClaimBeforePostReadsBackThenPublishes();
                verifyPriorAttemptReadsBackBeforePublish();
                verifyAmbiguousAppendIsNotRetried();
                verifyExpiredOwnerCannotAcknowledgeWithoutReplacement();
                verifyInvalidLimitRejectedBeforePublisherReadinessCheck();
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

    private static void verifyInvalidLimitRejectedBeforePublisherReadinessCheck() {
        var source = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        AtomicInteger readinessChecks = new AtomicInteger();
        AtomicInteger publishCalls = new AtomicInteger();
        MediaLifecycleEventPublisher unavailable = new MediaLifecycleEventPublisher() {
            @Override public String publisherId() { return "unavailable-test-publisher"; }
            @Override public boolean ready() {
                readinessChecks.incrementAndGet();
                return false;
            }
            @Override public boolean productionEligible() { return false; }
            @Override public void publish(MediaLifecycleEvent event) { publishCalls.incrementAndGet(); }
        };

        try {
            assertThatThrownBy(() -> source.publishPending(unavailable, 0))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessage("limit must be between 1 and 1000");
            assertThatThrownBy(() -> source.publishPending(unavailable, 1_001))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessage("limit must be between 1 and 1000");
            assertThat(readinessChecks).hasValue(0);
            assertThat(publishCalls).hasValue(0);
        } finally {
            source.close();
        }
    }

    private static void verifyRowPayloadIdentityMismatchFailsBeforePublish() throws Exception {
        String rowEventId = "media:test:outbox-row-identity";
        insertEvent(rowEventId, "media:test:outbox-payload-identity");
        var source = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        AtomicInteger providerEffects = new AtomicInteger();
        try {
            assertThat(source.publishPending(publisher(event -> providerEffects.incrementAndGet()), 1).failed())
                    .isEqualTo(1);
            assertThat(providerEffects).hasValue(0);
        } finally {
            source.close();
        }

        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT event_id,attempts,published_at FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            query.setString(1, rowEventId);
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getString("event_id")).isEqualTo(rowEventId);
                assertThat(row.getInt("attempts")).isEqualTo(1);
                assertThat(row.getObject("published_at")).isNull();
            }
        } finally {
            state.release();
        }

        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var delete = connection.prepareStatement(
                "DELETE FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            delete.setString(1, rowEventId);
            assertThat(delete.executeUpdate()).isEqualTo(1);
        } finally {
            state.release();
        }
    }

    private static void verifyRowPayloadTenantMismatchFailsBeforePublish() throws Exception {
        String eventId = "media:test:outbox-row-tenant-mismatch";
        insertEvent(eventId);
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var update = connection.prepareStatement(
                "UPDATE media_processing_lifecycle_outbox SET tenant_id=? WHERE event_id=?")) {
            update.setString(1, "tenant-b");
            update.setString(2, eventId);
            assertThat(update.executeUpdate()).isEqualTo(1);
        } finally {
            state.release();
        }

        var source = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        AtomicInteger providerEffects = new AtomicInteger();
        try {
            assertThat(source.publishPending(publisher(event -> providerEffects.incrementAndGet()), 1).failed())
                    .isEqualTo(1);
            assertThat(providerEffects).hasValue(0);
        } finally {
            source.close();
        }

        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT tenant_id,attempts,published_at FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            query.setString(1, eventId);
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getString("tenant_id")).isEqualTo("tenant-b");
                assertThat(row.getInt("attempts")).isEqualTo(1);
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

    private static void verifyRowPayloadOccurrenceMismatchFailsBeforePublish() throws Exception {
        String eventId = "media:test:outbox-occurrence-mismatch";
        insertEvent(eventId);
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection();
             var select = connection.prepareStatement(
                     "SELECT payload_json FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            select.setString(1, eventId);
            try (var row = select.executeQuery()) {
                assertThat(row.next()).isTrue();
                MediaLifecycleEvent original = state.mapper().readValue(row.getString("payload_json"),
                        MediaLifecycleEvent.class);
                MediaLifecycleEvent altered = new MediaLifecycleEvent(original.eventId(), original.eventType(),
                        original.tenantId(), original.principalId(), original.correlationId(),
                        original.causationId(), original.aggregateType(), original.aggregateId(),
                        original.aggregateVersion(), original.classification(), original.occurredAt().plusSeconds(1),
                        original.attributes());
                try (var update = connection.prepareStatement(
                        "UPDATE media_processing_lifecycle_outbox SET payload_json=? WHERE event_id=?")) {
                    update.setString(1, state.mapper().writeValueAsString(altered));
                    update.setString(2, eventId);
                    assertThat(update.executeUpdate()).isEqualTo(1);
                }
            }
        } finally {
            state.release();
        }

        var source = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        AtomicInteger publisherCalls = new AtomicInteger();
        try {
            assertThat(source.publishPending(publisher(event -> publisherCalls.incrementAndGet()), 1).failed())
                    .isEqualTo(1);
            assertThat(publisherCalls).hasValue(0);
        } finally {
            source.close();
        }

        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT payload_json,created_at,attempts,published_at FROM media_processing_lifecycle_outbox "
                        + "WHERE event_id=?")) {
            query.setString(1, eventId);
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                MediaLifecycleEvent altered = state.mapper().readValue(row.getString("payload_json"),
                        MediaLifecycleEvent.class);
                assertThat(altered.occurredAt().toEpochMilli()).isNotEqualTo(row.getLong("created_at"));
                assertThat(row.getInt("attempts")).isEqualTo(1);
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
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT published_at,event_plane_stored_event_id,event_plane_stream_id,event_plane_offset "
                        + "FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            query.setString(1, "media:test:outbox-concurrent");
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getLong("published_at")).isPositive();
                assertThat(row.getString("event_plane_stored_event_id")).isEqualTo(
                        MediaLifecyclePublicationReceipt.stableStoredEventId("media:test:outbox-concurrent"));
                assertThat(row.getString("event_plane_stream_id")).isEqualTo("media-lifecycle");
                assertThat(row.getString("event_plane_offset")).isEqualTo("1");
            }
        } finally {
            state.release();
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
            AtomicInteger readbacks = new AtomicInteger();
            assertThat(recoveryOwner.publishPending(reconcilingPublisher(event -> {
                brokerAccepted.add(event.eventId()); // Would expose an unsafe duplicate POST.
            }, true, readbacks), 10).published()).isEqualTo(1);
            release.countDown();
            assertThat(oldBatch.get(5, TimeUnit.SECONDS).published()).isZero();
            assertThat(brokerAccepted).containsExactly("media:test:outbox-expired-claim");
            assertThat(readbacks).hasValue(1);
        } finally {
            release.countDown();
            worker.shutdownNow();
            expiredOwner.close();
            recoveryOwner.close();
        }
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT attempts,published_at,dead_lettered_at,dead_letter_reason,claim_owner "
                        + "FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            query.setString(1, "media:test:outbox-expired-claim");
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getInt("attempts")).isEqualTo(1);
                assertThat(row.getLong("published_at")).isPositive();
                assertThat(row.getObject("dead_lettered_at")).isNull();
                assertThat(row.getString("dead_letter_reason")).isNull();
                assertThat(row.getString("claim_owner")).isNull();
            }
        } finally {
            state.release();
        }
        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var delete = connection.prepareStatement(
                "DELETE FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            delete.setString(1, "media:test:outbox-expired-claim");
            assertThat(delete.executeUpdate()).isEqualTo(1);
        } finally {
            state.release();
        }
    }

    private static void verifyExpiredClaimBeforePostReadsBackThenPublishes() throws Exception {
        String eventId = "media:test:outbox-crash-before-post";
        insertEvent(eventId);
        simulateExpiredClaim(eventId);
        AtomicInteger readbacks = new AtomicInteger();
        AtomicInteger providerEffects = new AtomicInteger();
        var recovery = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        try {
            assertThat(recovery.publishPending(reconcilingPublisher(event -> providerEffects.incrementAndGet(),
                    false, readbacks), 1).published()).isEqualTo(1);
        } finally {
            recovery.close();
        }
        assertThat(readbacks).hasValue(1);
        assertThat(providerEffects).hasValue(1);
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT published_at,event_plane_offset FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            query.setString(1, eventId);
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getLong("published_at")).isPositive();
                assertThat(row.getString("event_plane_offset")).isEqualTo("1");
            }
        } finally {
            state.release();
        }
    }

    private static void verifyPriorAttemptReadsBackBeforePublish() throws Exception {
        String eventId = "media:test:outbox-prior-attempt";
        insertEvent(eventId);
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var update = connection.prepareStatement(
                "UPDATE media_processing_lifecycle_outbox SET attempts=1 WHERE event_id=?")) {
            update.setString(1, eventId);
            assertThat(update.executeUpdate()).isEqualTo(1);
        } finally {
            state.release();
        }

        AtomicInteger readbacks = new AtomicInteger();
        AtomicInteger providerEffects = new AtomicInteger();
        var source = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        try {
            assertThat(source.publishPending(reconcilingPublisher(
                    event -> providerEffects.incrementAndGet(), false, readbacks), 1).published()).isEqualTo(1);
        } finally {
            source.close();
        }
        assertThat(readbacks).hasValue(1);
        assertThat(providerEffects).hasValue(1);
        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var delete = connection.prepareStatement(
                "DELETE FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            delete.setString(1, eventId);
            assertThat(delete.executeUpdate()).isEqualTo(1);
        } finally {
            state.release();
        }
    }

    private static void verifyTenantCursorNeverMovesBackward() throws Exception {
        String firstEventId = "media:test:cursor-a";
        String secondEventId = "media:test:cursor-b";
        String tenantBFirstEventId = "media:test:cursor-tenant-b-a";
        String tenantBSecondEventId = "media:test:cursor-tenant-b-b";
        insertEvent(firstEventId);
        insertEvent(secondEventId);
        CountDownLatch firstPublished = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        var firstSource = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        var secondSource = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<PostgresqlMediaLifecycleOutboxSource.BatchResult> firstBatch = worker.submit(
                    () -> firstSource.publishPending(publisherWithOffset(event -> {
                        if (event.eventId().equals(firstEventId)) {
                            firstPublished.countDown();
                            if (!releaseFirst.await(5, TimeUnit.SECONDS)) {
                                throw new IllegalStateException("publisher timed out");
                            }
                        }
                    }, event -> event.eventId().equals(firstEventId) ? "6" : "9"), 1));
            assertThat(firstPublished.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(secondSource.publishPending(publisherWithOffset(event -> { },
                    event -> event.eventId().equals(secondEventId) ? "8" : "7"), 10).published()).isEqualTo(1);
            releaseFirst.countDown();
            assertThat(firstBatch.get(5, TimeUnit.SECONDS).published()).isEqualTo(1);
        } finally {
            releaseFirst.countDown();
            worker.shutdownNow();
            firstSource.close();
            secondSource.close();
        }

        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT last_offset,last_stream_id,last_event_id FROM "
                        + "media_processing_lifecycle_event_plane_cursor WHERE tenant_id=?")) {
            query.setString(1, "tenant-a");
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getString("last_offset")).isEqualTo("8");
                assertThat(row.getString("last_stream_id")).isEqualTo("media-lifecycle");
                assertThat(row.getString("last_event_id")).isEqualTo(secondEventId);
            }
        } finally {
            state.release();
        }

        insertEvent(tenantBFirstEventId, tenantBFirstEventId, "tenant-b");
        insertEvent(tenantBSecondEventId, tenantBSecondEventId, "tenant-b");
        var tenantBSource = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        AtomicReference<String> tenantBFirstPublishedId = new AtomicReference<>();
        AtomicReference<String> tenantBSecondPublishedId = new AtomicReference<>();
        try {
            assertThat(tenantBSource.publishPending(publisherWithOffset(
                    event -> tenantBFirstPublishedId.set(event.eventId()), event -> "2"), 1).published())
                    .isEqualTo(1);
            assertThat(tenantBSource.publishPending(publisherWithOffset(
                    event -> tenantBSecondPublishedId.set(event.eventId()), event -> "1"), 1).published())
                    .isEqualTo(1);
        } finally {
            tenantBSource.close();
        }
        assertThat(tenantBFirstPublishedId.get()).isIn(tenantBFirstEventId, tenantBSecondEventId);
        assertThat(tenantBSecondPublishedId.get()).isIn(tenantBFirstEventId, tenantBSecondEventId)
                .isNotEqualTo(tenantBFirstPublishedId.get());

        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT tenant_id,last_offset,last_stream_id,last_event_id FROM "
                        + "media_processing_lifecycle_event_plane_cursor WHERE tenant_id IN (?,?) ORDER BY tenant_id")) {
            query.setString(1, "tenant-a");
            query.setString(2, "tenant-b");
            try (var rows = query.executeQuery()) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getString("tenant_id")).isEqualTo("tenant-a");
                assertThat(rows.getString("last_offset")).isEqualTo("8");
                assertThat(rows.getString("last_stream_id")).isEqualTo("media-lifecycle");
                assertThat(rows.getString("last_event_id")).isEqualTo(secondEventId);
                assertThat(rows.next()).isTrue();
                assertThat(rows.getString("tenant_id")).isEqualTo("tenant-b");
                assertThat(rows.getString("last_offset")).isEqualTo("2");
                assertThat(rows.getString("last_stream_id")).isEqualTo("media-lifecycle");
                assertThat(rows.getString("last_event_id")).isEqualTo(tenantBFirstPublishedId.get());
                assertThat(rows.next()).isFalse();
            }
        } finally {
            state.release();
        }

        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var delete = connection.prepareStatement(
                "DELETE FROM media_processing_lifecycle_outbox WHERE event_id IN (?,?,?,?)")) {
            delete.setString(1, firstEventId);
            delete.setString(2, secondEventId);
            delete.setString(3, tenantBFirstEventId);
            delete.setString(4, tenantBSecondEventId);
            assertThat(delete.executeUpdate()).isEqualTo(4);
        } finally {
            state.release();
        }
        state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var delete = connection.prepareStatement(
                "DELETE FROM media_processing_lifecycle_event_plane_cursor WHERE tenant_id IN (?,?)")) {
            delete.setString(1, "tenant-a");
            delete.setString(2, "tenant-b");
            assertThat(delete.executeUpdate()).isEqualTo(2);
        } finally {
            state.release();
        }
    }

    private static void verifyCursorUpdateFailureLeavesAckPendingAndRecoversByReadback() throws Exception {
        String eventId = "media:test:cursor-ack-rollback";
        insertEvent(eventId);
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var insert = connection.prepareStatement(
                "INSERT INTO media_processing_lifecycle_event_plane_cursor "
                        + "(tenant_id,last_offset,last_stream_id,last_event_id,last_stored_event_id,updated_at) "
                        + "VALUES(?,?,?,?,?,?)")) {
            insert.setString(1, "tenant-a");
            insert.setString(2, "1");
            insert.setString(3, "media-lifecycle");
            insert.setString(4, "media:test:prior-cursor-event");
            insert.setString(5, "media:test:prior-stored-event");
            insert.setLong(6, System.currentTimeMillis());
            insert.executeUpdate();
        } finally {
            state.release();
        }

        AtomicInteger appendEffects = new AtomicInteger();
        AtomicInteger exactReadbacks = new AtomicInteger();
        MediaLifecycleEventPublisher publisher = new MediaLifecycleEventPublisher() {
            @Override public String publisherId() { return "test-reconciling-publisher"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public void publish(MediaLifecycleEvent event) { appendEffects.incrementAndGet(); }
            @Override public MediaLifecyclePublicationReceipt publishWithReceipt(
                    MediaLifecycleEvent event, boolean exactReadbackRequired) {
                if (exactReadbackRequired) exactReadbacks.incrementAndGet();
                else appendEffects.incrementAndGet();
                return new MediaLifecyclePublicationReceipt(event.eventId(),
                        MediaLifecyclePublicationReceipt.stableStoredEventId(event.eventId()),
                        "media-lifecycle", "7");
            }
        };
        var source = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        try {
            state = MediaAwsPostgresqlRuntimeState.acquire();
            try (var connection = state.connection(); var statement = connection.createStatement()) {
                statement.execute("ALTER TABLE media_processing_lifecycle_event_plane_cursor "
                        + "ADD CONSTRAINT media_test_reject_cursor_7 CHECK (last_offset <> '7')");
            } finally {
                state.release();
            }

            assertThat(source.publishPending(publisher, 1).failed()).isEqualTo(1);
            state = MediaAwsPostgresqlRuntimeState.acquire();
            try (var connection = state.connection(); var query = connection.prepareStatement(
                    "SELECT attempts,published_at,event_plane_offset,claim_owner "
                            + "FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
                query.setString(1, eventId);
                try (var row = query.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getInt("attempts")).isZero();
                    assertThat(row.getObject("published_at")).isNull();
                    assertThat(row.getString("event_plane_offset")).isNull();
                    assertThat(row.getString("claim_owner")).isNotNull();
                }
            } finally {
                state.release();
            }
            state = MediaAwsPostgresqlRuntimeState.acquire();
            try (var connection = state.connection(); var query = connection.prepareStatement(
                    "SELECT last_offset FROM media_processing_lifecycle_event_plane_cursor WHERE tenant_id=?")) {
                query.setString(1, "tenant-a");
                try (var row = query.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getString("last_offset")).isEqualTo("1");
                }
            } finally {
                state.release();
            }
            assertThat(appendEffects).hasValue(1);

            state = MediaAwsPostgresqlRuntimeState.acquire();
            try (var connection = state.connection(); var statement = connection.createStatement()) {
                statement.execute("ALTER TABLE media_processing_lifecycle_event_plane_cursor "
                        + "DROP CONSTRAINT media_test_reject_cursor_7");
            } finally {
                state.release();
            }
            expireClaim(eventId);
            assertThat(source.publishPending(publisher, 1).published()).isEqualTo(1);
            assertThat(appendEffects).hasValue(1);
            assertThat(exactReadbacks).hasValue(1);

            state = MediaAwsPostgresqlRuntimeState.acquire();
            try (var connection = state.connection();
                 var outbox = connection.prepareStatement(
                         "SELECT attempts,published_at,event_plane_offset FROM "
                                 + "media_processing_lifecycle_outbox WHERE event_id=?");
                 var cursor = connection.prepareStatement(
                         "SELECT last_offset,last_event_id FROM "
                                 + "media_processing_lifecycle_event_plane_cursor WHERE tenant_id=?")) {
                outbox.setString(1, eventId);
                try (var row = outbox.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getInt("attempts")).isEqualTo(1);
                    assertThat(row.getLong("published_at")).isPositive();
                    assertThat(row.getString("event_plane_offset")).isEqualTo("7");
                }
                cursor.setString(1, "tenant-a");
                try (var row = cursor.executeQuery()) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getString("last_offset")).isEqualTo("7");
                    assertThat(row.getString("last_event_id")).isEqualTo(eventId);
                }
            } finally {
                state.release();
            }
        } finally {
            source.close();
            state = MediaAwsPostgresqlRuntimeState.acquire();
            try (var connection = state.connection(); var statement = connection.createStatement()) {
                statement.execute("ALTER TABLE media_processing_lifecycle_event_plane_cursor "
                        + "DROP CONSTRAINT IF EXISTS media_test_reject_cursor_7");
                try (var deleteCursor = connection.prepareStatement(
                        "DELETE FROM media_processing_lifecycle_event_plane_cursor WHERE tenant_id=?");
                     var deleteOutbox = connection.prepareStatement(
                             "DELETE FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
                    deleteCursor.setString(1, "tenant-a");
                    deleteCursor.executeUpdate();
                    deleteOutbox.setString(1, eventId);
                    deleteOutbox.executeUpdate();
                }
            } finally {
                state.release();
            }
        }
    }

    private static void verifyAmbiguousAppendIsNotRetried() throws Exception {
        String eventId = "media:test:outbox-append-unknown";
        insertEvent(eventId);
        AtomicInteger publisherCalls = new AtomicInteger();
        MediaLifecycleEventPublisher publisher = publisher(event -> {
            publisherCalls.incrementAndGet();
            throw new MediaLifecyclePublicationOutcomeUnknownException("response lost after append");
        });
        var source = source(3, Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200));
        try {
            assertThat(source.publishPending(publisher, 1).failed()).isEqualTo(1);
            assertThat(source.publishPending(publisher, 1).attempted()).isZero();
            assertThat(publisherCalls).hasValue(1);
        } finally {
            source.close();
        }

        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var query = connection.prepareStatement(
                "SELECT attempts,published_at,dead_lettered_at,dead_letter_reason,last_error,claim_owner "
                        + "FROM media_processing_lifecycle_outbox WHERE event_id=?")) {
            query.setString(1, eventId);
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getInt("attempts")).isEqualTo(1);
                assertThat(row.getObject("published_at")).isNull();
                assertThat(row.getLong("dead_lettered_at")).isPositive();
                assertThat(row.getString("dead_letter_reason")).isEqualTo("OUTCOME_UNKNOWN");
                assertThat(row.getString("last_error")).contains("MediaLifecyclePublicationOutcomeUnknownException");
                assertThat(row.getString("claim_owner")).isNull();
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

    private static void simulateExpiredClaim(String eventId) throws Exception {
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (var connection = state.connection(); var update = connection.prepareStatement(
                "UPDATE media_processing_lifecycle_outbox SET claim_owner=?,claim_token=1,claim_expires_at=? "
                        + "WHERE event_id=? AND published_at IS NULL")) {
            update.setString(1, "crashed-worker");
            update.setLong(2, System.currentTimeMillis() - 1);
            update.setString(3, eventId);
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
        AtomicInteger readbacks = new AtomicInteger();
        MediaLifecycleEventPublisher poison = reconcilingPublisher(
                event -> { throw new IllegalStateException("poison"); }, false, readbacks);
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
        assertThat(readbacks).hasValue(2);
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
        insertEvent(eventId, eventId);
    }

    private static void insertEvent(String rowEventId, String payloadEventId) throws Exception {
        insertEvent(rowEventId, payloadEventId, "tenant-a");
    }

    private static void insertEvent(String rowEventId, String payloadEventId, String tenantId) throws Exception {
        MediaLifecycleEvent event = new MediaLifecycleEvent(payloadEventId, "media.test", tenantId,
                "principal-a", rowEventId, "", "job", rowEventId, 1, "INTERNAL", Instant.now(), Map.of());
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try {
            String payload = state.mapper().writeValueAsString(event);
            try (var connection = state.connection(); var insert = connection.prepareStatement(
                    "INSERT INTO media_processing_lifecycle_outbox(event_id,tenant_id,aggregate_type,aggregate_id,"
                            + "aggregate_version,event_type,payload_json,classification,created_at,published_at,attempts,last_error) "
                            + "VALUES(?,?,?,?,?,?,?,?,?,NULL,0,NULL)")) {
                insert.setString(1, rowEventId);
                insert.setString(2, event.tenantId());
                insert.setString(3, event.aggregateType());
                insert.setString(4, event.aggregateId());
                insert.setLong(5, event.aggregateVersion());
                insert.setString(6, event.eventType());
                insert.setString(7, payload);
                insert.setString(8, event.classification());
                insert.setLong(9, event.occurredAt().toEpochMilli());
                insert.executeUpdate();
            }
        } finally {
            state.release();
        }
    }

    @FunctionalInterface
    private interface PublishAction { void publish(MediaLifecycleEvent event) throws Exception; }

    private static MediaLifecycleEventPublisher publisher(PublishAction action) {
        return publisherWithOffset(action, event -> "1");
    }

    private static MediaLifecycleEventPublisher publisherWithOffset(
            PublishAction action, Function<MediaLifecycleEvent, String> offsetForEvent) {
        return new MediaLifecycleEventPublisher() {
            @Override public String publisherId() { return "test-publisher"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public void publish(MediaLifecycleEvent event) {
                try { action.publish(event); }
                catch (RuntimeException failure) { throw failure; }
                catch (Exception failure) { throw new IllegalStateException("test publisher failed", failure); }
            }
            @Override public MediaLifecyclePublicationReceipt publishWithReceipt(MediaLifecycleEvent event) {
                publish(event);
                return new MediaLifecyclePublicationReceipt(event.eventId(),
                        MediaLifecyclePublicationReceipt.stableStoredEventId(event.eventId()),
                        "media-lifecycle", offsetForEvent.apply(event));
            }
        };
    }

    private static MediaLifecycleEventPublisher reconcilingPublisher(
            PublishAction action, boolean priorEventFound, AtomicInteger readbacks) {
        return new MediaLifecycleEventPublisher() {
            @Override public String publisherId() { return "test-reconciling-publisher"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public void publish(MediaLifecycleEvent event) {
                try { action.publish(event); }
                catch (RuntimeException failure) { throw failure; }
                catch (Exception failure) { throw new IllegalStateException("test publisher failed", failure); }
            }
            @Override public MediaLifecyclePublicationReceipt publishWithReceipt(MediaLifecycleEvent event) {
                return publishWithReceipt(event, false);
            }
            @Override public MediaLifecyclePublicationReceipt publishWithReceipt(
                    MediaLifecycleEvent event, boolean exactReadbackRequired) {
                if (exactReadbackRequired) {
                    readbacks.incrementAndGet();
                    if (priorEventFound) return receipt(event);
                }
                publish(event);
                return receipt(event);
            }
            private MediaLifecyclePublicationReceipt receipt(MediaLifecycleEvent event) {
                return new MediaLifecyclePublicationReceipt(event.eventId(),
                        MediaLifecyclePublicationReceipt.stableStoredEventId(event.eventId()),
                        "media-lifecycle", "1");
            }
        };
    }
}
