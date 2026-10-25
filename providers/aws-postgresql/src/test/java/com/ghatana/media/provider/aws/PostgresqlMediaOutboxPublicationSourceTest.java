package com.ghatana.media.provider.aws;

import com.ghatana.core.async.AsyncOperation;
import com.ghatana.messaging.DeliveryOutcome;
import com.ghatana.messaging.EventBusPort;
import com.ghatana.messaging.EventEnvelope;
import com.ghatana.messaging.EventSubscription;
import com.ghatana.messaging.outbox.ClaimedOutboxPublisher;
import com.ghatana.messaging.outbox.OutboxPublisherDiagnostics;
import com.ghatana.messaging.util.AsyncOperations;
import org.junit.jupiter.api.Test;
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

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

/** Local provider proof for durable Media outbox claim, delivery and restart semantics. */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaOutboxPublicationSourceTest {
    private static org.h2.jdbcx.JdbcDataSource h2(String url) {
        var ds = new org.h2.jdbcx.JdbcDataSource();
        ds.setURL(url);
        ds.setUser("sa");
        return ds;
    }

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    @Test
    void concurrentPublishersShareOneOrderedLeaseAndPersistBrokerAcknowledgements() throws Exception {
        Fixture fixture = new Fixture("media_outbox_race");
        try (fixture) {
            UUID first = fixture.append("tenant-a", "subject-a", "FIRST", "{\"value\":1}", 1_000L);
            UUID second = fixture.append("tenant-b", "subject-b", "SECOND", "{\"value\":2}", 2_000L);
            try (PostgresqlMediaOutboxPublicationSource sourceA = new PostgresqlMediaOutboxPublicationSource();
                 PostgresqlMediaOutboxPublicationSource sourceB = new PostgresqlMediaOutboxPublicationSource();
                 ExecutorService pool = Executors.newFixedThreadPool(2)) {
                CountDownLatch start = new CountDownLatch(1);
                var claimA = pool.submit(() -> {
                    start.await();
                    return AsyncOperations.toFuture(sourceA.claimBatch(
                            "publisher-a", 10, fixture.now, Duration.ofSeconds(30))).join();
                });
                var claimB = pool.submit(() -> {
                    start.await();
                    return AsyncOperations.toFuture(sourceB.claimBatch(
                            "publisher-b", 10, fixture.now, Duration.ofSeconds(30))).join();
                });
                start.countDown();
                var a = claimA.get(10, TimeUnit.SECONDS);
                var b = claimB.get(10, TimeUnit.SECONDS);

                assertThat(a.events().size() + b.events().size()).isEqualTo(2);
                assertThat(List.of(a, b).stream().filter(claim -> !claim.events().isEmpty())).hasSize(1);
                var winner = a.events().isEmpty() ? b : a;
                assertThat(winner.events()).extracting("eventId").containsExactly(first, second);
                assertThat(winner.events()).extracting("publicationAttempts").containsExactly(0, 0);
                assertThat(fixture.attempts(first)).singleElement().satisfies(attempt -> {
                    assertThat(attempt.status).isEqualTo("CLAIMED");
                    assertThat(attempt.fingerprint).matches("[0-9a-f]{64}");
                });
                assertThat(AsyncOperations.toFuture(
                        (a.events().isEmpty() ? sourceB : sourceA).releaseClaim(winner.claimToken(), fixture.now)).join())
                        .isEqualTo(2);
            }

            // Reclaim after release through the actual Shared sequential publisher and a fake broker.
            try (PostgresqlMediaOutboxPublicationSource source = new PostgresqlMediaOutboxPublicationSource()) {
                FakeEventBus broker = new FakeEventBus();
                ClaimedOutboxPublisher publisher = fixture.publisher(source, broker, "publisher-restarted");
                try (publisher) {
                    var result = AsyncOperations.toFuture(publisher.runOnce()).join();
                    assertThat(result.claimedEvents()).isEqualTo(2);
                    assertThat(result.publishedEvents()).isEqualTo(2);
                    assertThat(broker.envelopes).extracting(EventEnvelope::id).containsExactly(first.toString(), second.toString());
                    assertThat(broker.envelopes).extracting(EventEnvelope::tenantId).containsExactly("tenant-a", "tenant-b");
                }
            }
            assertThat(fixture.attempts(first)).extracting(attempt -> attempt.status).containsExactly("CLAIM_RELEASED", "PUBLISHED");
            assertThat(fixture.attempts(first)).extracting(attempt -> attempt.fingerprint)
                    .containsExactly(fixture.attempts(first).getFirst().fingerprint,
                            fixture.attempts(first).getFirst().fingerprint);
            assertThat(fixture.publishedAt(first)).isNotNull();
            assertThat(fixture.publishedAt(second)).isNotNull();
            assertThat(fixture.hasConsumerReceiptApi()).isFalse();
        }
    }

    @Test
    void brokerAcceptedThenProcessLostBeforeDatabaseAckRedeliversSameFingerprintAfterRestart() throws Exception {
        Fixture fixture = new Fixture("media_outbox_crash");
        try (fixture) {
            UUID eventId = fixture.append("tenant-private", "job-private", "MEDIA_JOB_ACCEPTED", "{\"state\":\"ACCEPTED\"}", 1_000L);
            FakeEventBus broker = new FakeEventBus();
            Instant firstClaimAt = fixture.now;
            String firstFingerprint;

            // A process dies after broker acceptance. The source is closed without ack or release.
            try (PostgresqlMediaOutboxPublicationSource crashedSource = new PostgresqlMediaOutboxPublicationSource()) {
                var crashClaim = AsyncOperations.toFuture(crashedSource.claimBatch(
                        "publisher-before-crash", 1, firstClaimAt, Duration.ofSeconds(5))).join();
                assertThat(crashClaim.events()).hasSize(1);
                broker.publish("media-lifecycle", envelope(crashClaim.events().get(0)));
                firstFingerprint = fixture.attempts(eventId).getFirst().fingerprint;
            }

            Instant restartedAt = firstClaimAt.plusSeconds(6);
            try (PostgresqlMediaOutboxPublicationSource restartedSource = new PostgresqlMediaOutboxPublicationSource()) {
                var claim = AsyncOperations.toFuture(restartedSource.claimBatch(
                        "publisher-after-restart", 1, restartedAt, Duration.ofSeconds(30))).join();
                assertThat(claim.events()).extracting("eventId").containsExactly(eventId);
                assertThat(fixture.attempts(eventId)).extracting(attempt -> attempt.status)
                        .containsExactly("OUTCOME_UNKNOWN", "CLAIMED");
                assertThat(fixture.attempts(eventId)).extracting(attempt -> attempt.fingerprint)
                        .containsExactly(firstFingerprint, firstFingerprint);

                // Fake broker accepts the replay. Shared publisher persists the corresponding Media ack.
                FakeEventBus replayBroker = new FakeEventBus();
                ClaimedOutboxPublisher publisher = fixture.publisher(restartedSource, replayBroker, "publisher-after-restart");
                try (publisher) {
                    var result = AsyncOperations.toFuture(publisher.runOnce()).join();
                    assertThat(result.publishedEvents()).isZero(); // the restart claim is still leased by this test's direct claim
                }
                replayBroker.publish("media-lifecycle", envelope(claim.events().get(0)));
                AsyncOperations.toFuture(restartedSource.markPublished(
                        claim.claimToken(), eventId, restartedAt.plusSeconds(1))).join();
                AsyncOperations.toFuture(restartedSource.releaseClaim(claim.claimToken(), restartedAt.plusSeconds(2))).join();
            }
            assertThat(broker.envelopes).extracting(EventEnvelope::id).containsExactly(eventId.toString());
            assertThat(fixture.publishedAt(eventId)).isEqualTo(restartedAt.plusSeconds(1).toEpochMilli());
            assertThat(fixture.attempts(eventId)).extracting(attempt -> attempt.status)
                    .containsExactly("OUTCOME_UNKNOWN", "PUBLISHED");
            assertThat(fixture.hasConsumerReceiptApi()).isFalse();
        }
    }

    @Test
    void successfulRetryClearsLatestFailureSummaryAndRetainsAttemptHistory() throws Exception {
        Fixture fixture = new Fixture("media_outbox_retry");
        try (fixture; PostgresqlMediaOutboxPublicationSource source = new PostgresqlMediaOutboxPublicationSource()) {
            UUID eventId = fixture.append("tenant-a", "job-retry", "MEDIA_JOB_ACCEPTED", "{\"state\":\"ACCEPTED\"}", 1_000L);
            var first = AsyncOperations.toFuture(source.claimBatch(
                    "publisher-first", 1, fixture.now, Duration.ofSeconds(30))).join();
            AsyncOperations.toFuture(source.markFailed(first.claimToken(), eventId,
                    "OUTBOX_BROKER_PUBLICATION_FAILED", fixture.now.plusSeconds(1))).join();
            AsyncOperations.toFuture(source.releaseClaim(first.claimToken(), fixture.now.plusSeconds(2))).join();

            var retry = AsyncOperations.toFuture(source.claimBatch(
                    "publisher-retry", 1, fixture.now.plusSeconds(3), Duration.ofSeconds(30))).join();
            AsyncOperations.toFuture(source.markPublished(retry.claimToken(), eventId,
                    fixture.now.plusSeconds(4))).join();
            AsyncOperations.toFuture(source.releaseClaim(retry.claimToken(), fixture.now.plusSeconds(5))).join();

            assertThat(fixture.failureSummary(eventId)).containsExactly(null, null);
            assertThat(fixture.attempts(eventId)).extracting(attempt -> attempt.status)
                    .containsExactly("FAILED", "PUBLISHED");
        }
    }

    private static EventEnvelope<Map<String, Object>> envelope(
            com.ghatana.messaging.outbox.OutboxPublicationSource.OutboundEvent event) {
        return new EventEnvelope<>(com.ghatana.messaging.SimpleEventId.of(event.eventId().toString()), event.payload(),
                event.occurredAt().toEpochMilli(), "media-lifecycle", event.eventType(),
                EventEnvelope.DEFAULT_EVENT_VERSION, "media-runtime", event.tenantId(), event.correlationId(),
                "urn:ghatana:media-lifecycle-event:v1", event.subjectId(), event.eventId().toString(),
                Map.of("publicationAttempt", Integer.toString(event.publicationAttempts() + 1)), "application/json");
    }

    private static final class FakeEventBus implements EventBusPort {
        private final List<EventEnvelope<?>> envelopes = new ArrayList<>();

        @Override public <T> AsyncOperation<Void> publish(String topic, EventEnvelope<T> envelope) {
            envelopes.add(envelope);
            return AsyncOperation.success(null);
        }
        @Override public <T> AsyncOperation<EventSubscription> subscribeAsync(
                String topic, String consumerGroup, Function<EventEnvelope<T>, AsyncOperation<DeliveryOutcome>> handler) {
            return AsyncOperation.failure(new UnsupportedOperationException("consumer receipt is not implemented by this fake"));
        }
        @Override public AsyncOperation<Void> unsubscribe(String topic, String consumerGroup) {
            return AsyncOperation.success(null);
        }
        @Override public AsyncOperation<Boolean> isHealthy() { return AsyncOperation.success(true); }
    }

    private static final class Fixture implements AutoCloseable {
        private final String jdbcUrl = "jdbc:h2:mem:" + UUID.randomUUID().toString().replace("-", "")
                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
        private final String bucket = "media-outbox-" + UUID.randomUUID().toString().replace("-", "");
        private final Instant now = Instant.parse("2026-10-12T12:00:00Z");
        private final AutoCloseable installed;
        private final PostgresqlMediaOutboxPublicationSource keeper;

        private Fixture(String ignored) throws Exception {
            try (S3Client client = S3Client.builder()
                    .endpointOverride(LOCALSTACK.getEndpoint())
                    .region(Region.of(LOCALSTACK.getRegion()))
                    .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                            LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                    .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                    .build()) {
                client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installed = MediaAwsPostgresqlRuntimeState.installForTesting(Map.ofEntries(
                    Map.entry("MEDIA_RUNTIME_ENVIRONMENT", "test"),
                    Map.entry("MEDIA_POSTGRES_JDBC_URL", jdbcUrl),
                    Map.entry("MEDIA_POSTGRES_USER", "sa"),
                    Map.entry("MEDIA_POSTGRES_DRIVER", "org.h2.Driver"),
                    Map.entry("MEDIA_S3_BUCKET", bucket),
                    Map.entry("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString()),
                    Map.entry("MEDIA_S3_REGION", LOCALSTACK.getRegion()),
                    Map.entry("MEDIA_S3_PATH_STYLE", "true"),
                    Map.entry("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_OUTBOX_ACCESS"),
                    Map.entry("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_OUTBOX_SECRET"),
                    Map.entry("MEDIA_OUTBOX_ACCESS", LOCALSTACK.getAccessKey()),
                    Map.entry("MEDIA_OUTBOX_SECRET", LOCALSTACK.getSecretKey())));
            // Keep the shared test runtime alive across publisher restarts.
            keeper = new PostgresqlMediaOutboxPublicationSource();
        }

        private UUID append(String tenant, String subject, String type, String payload, long occurredAt) throws Exception {
            UUID eventId = UUID.randomUUID();
            try (Connection connection = h2(jdbcUrl).getConnection();
                 PreparedStatement insert = connection.prepareStatement(
                         "INSERT INTO media_lifecycle_outbox (event_id,tenant_id,subject_id,event_type,payload_json,occurred_at,correlation_id,created_at) "
                                 + "VALUES (?,?,?,?,?,?,?,?)")) {
                insert.setString(1, eventId.toString());
                insert.setString(2, tenant);
                insert.setString(3, subject);
                insert.setString(4, type);
                insert.setString(5, payload);
                insert.setLong(6, occurredAt);
                insert.setString(7, "correlation-" + subject);
                insert.setLong(8, occurredAt);
                insert.executeUpdate();
            }
            return eventId;
        }

        private List<Attempt> attempts(UUID eventId) throws Exception {
            List<Attempt> attempts = new ArrayList<>();
            try (Connection connection = h2(jdbcUrl).getConnection();
                 PreparedStatement query = connection.prepareStatement(
                         "SELECT payload_fingerprint,status FROM media_lifecycle_outbox_delivery_attempts WHERE event_id=? ORDER BY attempt_number")) {
                query.setString(1, eventId.toString());
                try (ResultSet rows = query.executeQuery()) {
                    while (rows.next()) attempts.add(new Attempt(rows.getString(1), rows.getString(2)));
                }
            }
            return attempts;
        }

        private Long publishedAt(UUID eventId) throws Exception {
            try (Connection connection = h2(jdbcUrl).getConnection();
                 PreparedStatement query = connection.prepareStatement("SELECT published_at FROM media_lifecycle_outbox WHERE event_id=?")) {
                query.setString(1, eventId.toString());
                try (ResultSet row = query.executeQuery()) {
                    if (!row.next()) return null;
                    long value = row.getLong(1);
                    return row.wasNull() ? null : value;
                }
            }
        }

        private List<String> failureSummary(UUID eventId) throws Exception {
            try (Connection connection = h2(jdbcUrl).getConnection();
                 PreparedStatement query = connection.prepareStatement(
                         "SELECT failed_at,failure_code FROM media_lifecycle_outbox WHERE event_id=?")) {
                query.setString(1, eventId.toString());
                try (ResultSet row = query.executeQuery()) {
                    if (!row.next()) throw new IllegalStateException("Media outbox event is missing");
                    return java.util.Arrays.asList(row.getString("failed_at"), row.getString("failure_code"));
                }
            }
        }

        private boolean hasConsumerReceiptApi() {
            return java.util.Arrays.stream(com.ghatana.messaging.outbox.OutboxPublicationSource.class.getMethods())
                    .anyMatch(method -> method.getName().toLowerCase(java.util.Locale.ROOT).contains("consumer"));
        }

        private ClaimedOutboxPublisher publisher(PostgresqlMediaOutboxPublicationSource source, FakeEventBus broker, String owner) {
            return new ClaimedOutboxPublisher(source, broker,
                    new ClaimedOutboxPublisher.Config(owner, "media-lifecycle", "media-runtime",
                            "urn:ghatana:media-lifecycle-event:v1", 10, Duration.ofSeconds(30)),
                    OutboxPublisherDiagnostics.NOOP, Clock.fixed(now, ZoneOffset.UTC));
        }

        @Override public void close() throws Exception {
            keeper.close();
            installed.close();
        }
    }

    private record Attempt(String fingerprint, String status) { }
}
