package com.ghatana.media.provider.aws;

import static com.ghatana.media.production.review.ReviewContracts.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.DriverManager;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.parallel.ResourceLock;
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

@Testcontainers(disabledWithoutDocker = true)
@ResourceLock("MediaAwsPostgresqlRuntimeState")
class PostgresqlReviewStoreTest {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    private static final ReviewCaseRef CASE = new ReviewCaseRef("tenant-review", "owner-issued-case",
            "artifact_version:artifact-1@v1",
            new ExactVersionRef(SubjectKind.ARTIFACT_VERSION, "artifact-1", "v1"), "review-scope");
    private static final Actor ACTOR = new Actor("tenant-review", "reviewer-1");

    @Test
    void revisionOverflowRejectsAppendWithoutChangingCaseOrRecords() throws Exception {
        try (Fixture fixture = openFixture()) {
            try (PostgresqlReviewStore registered = new PostgresqlReviewStore(List.of(CASE))) {
                assertThat(registered.read(ACTOR, CASE)).isEmpty();
            }
            try (var connection = DriverManager.getConnection(scopedJdbcUrl(fixture.schema()), POSTGRES.getUsername(),
                    POSTGRES.getPassword());
                 var update = connection.prepareStatement("""
                         UPDATE media_review_cases SET case_revision=?
                         WHERE tenant_id=? AND review_case_id=?
                         """)) {
                update.setLong(1, Long.MAX_VALUE);
                update.setString(2, CASE.tenantId());
                update.setString(3, CASE.reviewCaseId());
                assertThat(update.executeUpdate()).isEqualTo(1);
            }

            try (PostgresqlReviewStore store = new PostgresqlReviewStore(List.of(CASE))) {
                assertThatThrownBy(() -> store.append(ACTOR, CASE, Long.MAX_VALUE, "overflow-request",
                        "e".repeat(64), "overflow-record", "authority-v1",
                        new DecisionRecord(Decision.ACCEPT, "reviewed"), Instant.parse("2026-11-06T10:02:00Z")))
                        .isInstanceOf(ReviewRevisionOverflowException.class);
            }

            try (var connection = DriverManager.getConnection(scopedJdbcUrl(fixture.schema()), POSTGRES.getUsername(),
                    POSTGRES.getPassword());
                 var query = connection.createStatement()) {
                try (var row = query.executeQuery("SELECT case_revision FROM media_review_cases WHERE tenant_id='tenant-review' AND review_case_id='owner-issued-case'")) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getLong(1)).isEqualTo(Long.MAX_VALUE);
                }
                try (var row = query.executeQuery("SELECT COUNT(*) FROM media_review_records WHERE tenant_id='tenant-review' AND review_case_id='owner-issued-case'")) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getLong(1)).isZero();
                }
                try (var row = query.executeQuery("SELECT COUNT(*) FROM media_review_idempotency WHERE tenant_id='tenant-review' AND review_case_id='owner-issued-case'")) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getLong(1)).isZero();
                }
            }
        }
    }

    @Test
    void durableStoreEnforcesExactTenantIdempotencyCasAndRestartReadback() throws Exception {
        try (Fixture fixture = openFixture()) {
            String fingerprint = "a".repeat(64);
            DecisionRecord accept = new DecisionRecord(Decision.ACCEPT, "reviewed");
            PostgresqlReviewStore store = new PostgresqlReviewStore(List.of(CASE));
            ReviewCaseRef conflictingCase = new ReviewCaseRef(CASE.tenantId(), CASE.reviewCaseId(),
                    "artifact_version:artifact-1@v2",
                    new ExactVersionRef(SubjectKind.ARTIFACT_VERSION, "artifact-1", "v2"), CASE.scopeRef());
            assertThatThrownBy(() -> new PostgresqlReviewStore(List.of(conflictingCase)))
                    .isInstanceOf(ReviewCaseMismatchException.class);
            try (PostgresqlReviewStore afterRejectedRegistration = new PostgresqlReviewStore(List.of(CASE))) {
                assertThat(afterRejectedRegistration.read(ACTOR, CASE)).isEmpty();
            }
            var initialAppend = store.appendWithReplay(ACTOR, CASE, 0, "review-request-1", fingerprint,
                    "review-record-1", "authority-v1", accept, Instant.parse("2026-11-06T10:00:00Z"));
            assertThat(initialAppend.idempotentReplay()).isFalse();
            var first = initialAppend.record();
            assertThat(first.payload()).isEqualTo(accept);
            // The persisted ACCEPT is only a statement; it creates no approval capability or receipt.
            assertThat(first.payload()).isInstanceOf(DecisionRecord.class);
            assertThatThrownBy(() -> store.append(new Actor("other-tenant", ACTOR.principalId()), CASE,
                    1, "review-request-2", "b".repeat(64), "review-record-2", "authority-v1", accept,
                    Instant.parse("2026-11-06T10:00:01Z"))).isInstanceOf(ReviewCaseMismatchException.class);
            assertThatThrownBy(() -> store.append(ACTOR, CASE, 1, "review-request-1", "c".repeat(64),
                    "review-record-3", "authority-v1", accept, Instant.parse("2026-11-06T10:00:02Z")))
                    .isInstanceOf(ReviewIdempotencyConflictException.class);
            var replay = store.appendWithReplay(ACTOR, CASE, 0, "review-request-1", fingerprint,
                    "ignored-record-id", "authority-v1", accept, Instant.parse("2026-11-06T10:00:03Z"));
            assertThat(replay.idempotentReplay()).isTrue();
            assertThat(replay.record()).isEqualTo(first);
            store.close();

            MediaAwsPostgresqlRuntimeState held = MediaAwsPostgresqlRuntimeState.acquire();
            try (PostgresqlReviewStore restarted = new PostgresqlReviewStore(List.of(CASE))) {
                assertThat(restarted.read(ACTOR, CASE)).containsExactly(first);
                var restartedReplay = restarted.appendWithReplay(ACTOR, CASE, 0, "review-request-1", fingerprint,
                        "ignored", "authority-v1", accept, Instant.parse("2026-11-06T10:00:04Z"));
                assertThat(restartedReplay.idempotentReplay()).isTrue();
                assertThat(restartedReplay.record()).isEqualTo(first);
            } finally { held.release(); }

            try (PostgresqlReviewStore concurrent = new PostgresqlReviewStore(List.of(CASE))) {
                var ready = new CountDownLatch(2); var start = new CountDownLatch(1);
                try (var pool = Executors.newFixedThreadPool(2)) {
                    var a = pool.submit(() -> race(concurrent, "race-a", ready, start));
                    var b = pool.submit(() -> race(concurrent, "race-b", ready, start));
                    assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue(); start.countDown();
                    assertThat(List.of(a.get(20, TimeUnit.SECONDS), b.get(20, TimeUnit.SECONDS)))
                            .containsExactlyInAnyOrder(true, false);
                }
                assertThat(concurrent.read(ACTOR, CASE)).hasSize(2);
            }
        }
    }

    @Test
    void exactDurableReplayDoesNotInvokeAppendRecordIdSupplier() throws Exception {
        try (Fixture fixture = openFixture(); PostgresqlReviewStore store = new PostgresqlReviewStore(List.of(CASE))) {
            Comment payload = new Comment("same payload", CommentDisposition.OPEN, null);
            Instant createdAt = Instant.parse("2026-11-06T10:04:00Z");
            StoreAppendResult original = store.appendWithReplayAndLazyId(ACTOR, CASE, 0,
                    "lazy-id-replay", "a".repeat(64), () -> "persisted-record", "authority-v1", payload, createdAt);
            assertThat(original.idempotentReplay()).isFalse();

            StoreAppendResult replay = store.appendWithReplayAndLazyId(ACTOR, CASE, 0,
                    "lazy-id-replay", "a".repeat(64),
                    () -> { throw new IllegalStateException("append ID source unavailable"); },
                    "authority-v1", payload, createdAt.plusSeconds(30));

            assertThat(replay.idempotentReplay()).isTrue();
            assertThat(replay.record()).isEqualTo(original.record());
            assertThat(store.read(ACTOR, CASE)).containsExactly(original.record());
        }
    }

    @Test
    void concurrentExactReplayReturnsStoredIdentityAndMarksOnlyReplay() throws Exception {
        try (Fixture fixture = openFixture(); PostgresqlReviewStore store = new PostgresqlReviewStore(List.of(CASE))) {
            var ready = new CountDownLatch(2);
            var start = new CountDownLatch(1);
            try (var pool = Executors.newFixedThreadPool(2)) {
                var a = pool.submit(() -> exactReplayRace(store, "candidate-a", ready, start));
                var b = pool.submit(() -> exactReplayRace(store, "candidate-b", ready, start));
                assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
                start.countDown();
                var first = a.get(20, TimeUnit.SECONDS);
                var second = b.get(20, TimeUnit.SECONDS);
                assertThat(List.of(first.idempotentReplay(), second.idempotentReplay()))
                        .containsExactlyInAnyOrder(false, true);
                assertThat(first.record()).isEqualTo(second.record());
                assertThat(store.read(ACTOR, CASE)).containsExactly(first.record());
            }
        }
    }

    private static StoreAppendResult exactReplayRace(PostgresqlReviewStore store, String candidateId,
                                                       CountDownLatch ready, CountDownLatch start) throws Exception {
        ready.countDown();
        if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("start latch timed out");
        return store.appendWithReplay(ACTOR, CASE, 0, "same-request", "f".repeat(64), candidateId,
                "authority-v1", new Comment("same payload", CommentDisposition.OPEN, null),
                Instant.parse("2026-11-06T10:03:00Z"));
    }

    private static boolean race(PostgresqlReviewStore store, String request, CountDownLatch ready,
                                CountDownLatch start) throws Exception {
        ready.countDown(); if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("start latch timed out");
        try {
            store.append(ACTOR, CASE, 1, request, "d".repeat(64), "record-" + request, "authority-v1",
                    new DecisionRecord(Decision.ACCEPT, "reviewed"), Instant.parse("2026-11-06T10:01:00Z"));
            return true;
        } catch (ReviewConflictException expected) { return false; }
    }

    private static Fixture openFixture() throws Exception {
        String bucket = "media-review-" + UUID.randomUUID().toString().replace("-", "");
        String schema = "media_review_" + UUID.randomUUID().toString().replace("-", "");
        try (var c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var create = c.createStatement()) { create.execute("CREATE SCHEMA " + schema); }
        try (S3Client client = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket, schema));
        try {
            Flyway.configure().dataSource(scopedJdbcUrl(schema), POSTGRES.getUsername(), POSTGRES.getPassword())
                    .locations("classpath:db/media-runtime").load().migrate();
            return new Fixture(installed, MediaAwsPostgresqlRuntimeState.acquire(), schema);
        } catch (RuntimeException failure) { installed.close(); dropSchema(schema); throw failure; }
    }

    private record Fixture(AutoCloseable installed, MediaAwsPostgresqlRuntimeState runtime,
                           String schema) implements AutoCloseable {
        @Override public void close() throws Exception {
            try { runtime.release(); } finally { try { installed.close(); } finally { dropSchema(schema); } }
        }
    }
    private static Map<String, String> environment(String bucket, String schema) {
        Map<String, String> env = new HashMap<>(); env.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        env.put("MEDIA_POSTGRES_JDBC_URL", scopedJdbcUrl(schema)); env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_REVIEW_DB_PASSWORD");
        env.put("MEDIA_REVIEW_DB_PASSWORD", POSTGRES.getPassword()); env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", bucket); env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString()); env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_REVIEW_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_REVIEW_SECRET");
        env.put("MEDIA_REVIEW_ACCESS", LOCALSTACK.getAccessKey()); env.put("MEDIA_REVIEW_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }
    private static String scopedJdbcUrl(String schema) {
        String base = POSTGRES.getJdbcUrl(); return base + (base.contains("?") ? "&" : "?") + "currentSchema=" + schema;
    }
    private static void dropSchema(String schema) throws Exception {
        try (var c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var drop = c.createStatement()) { drop.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE"); }
    }
}
