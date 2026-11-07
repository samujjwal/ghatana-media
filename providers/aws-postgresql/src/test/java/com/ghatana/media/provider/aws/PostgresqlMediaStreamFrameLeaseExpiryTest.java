package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import org.junit.jupiter.api.Test;
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

import java.sql.DriverManager;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** A delayed frame reservation must not cross the durable stream lease expiry. */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaStreamFrameLeaseExpiryTest {
    private static final String TOKEN_HASH = "a".repeat(64);

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void frameReservationBlockedOnRowLockUntilLeaseExpiryIsRejected() throws Exception {
        delayedFrameMutationIsRejectedAfterLeaseExpiry(false);
    }

    @Test
    void frameAcknowledgementBlockedOnRowLockUntilLeaseExpiryIsRejected() throws Exception {
        delayedFrameMutationIsRejectedAfterLeaseExpiry(true);
    }

    @Test
    void leaseRenewalBlockedOnRowLockUntilExpiryIsRejected() throws Exception {
        String bucket = "media-stream-renewal-expiry-" + UUID.randomUUID().toString().replace("-", "");
        createBucket(bucket);
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
             PostgresqlMediaStreamSessionStore streams = new PostgresqlMediaStreamSessionStore()) {
            Instant createdAt = Instant.now();
            Instant leaseExpiry = createdAt.plusSeconds(3);
            String sessionId = "stream-renewal-expiry-" + UUID.randomUUID();
            StreamSession opened = streams.create(new StreamSession(
                    "tenant-renewal-expiry", sessionId, "principal-renewal-expiry", StreamKind.AUDIO,
                    "provider-renewal-expiry", StreamState.OPEN, -1, 0, 1024, 0,
                    leaseExpiry, createdAt, createdAt, null, Map.of(), 1), TOKEN_HASH);
            StreamSession connected = streams.connect(opened, TOKEN_HASH, leaseExpiry);

            try (var blocker = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                    POSTGRES.getUsername(), POSTGRES.getPassword())) {
                blocker.setAutoCommit(false);
                lockSessionRow(blocker, connected);
                var executor = Executors.newSingleThreadExecutor();
                boolean blockerReleased = false;
                try {
                    var renewal = executor.submit(() -> streams.renewLease(
                            connected, TOKEN_HASH, 0, leaseExpiry.plusSeconds(30)));
                    awaitRenewalBlockedOnRowLock();
                    long remainingMillis = leaseExpiry.toEpochMilli() - Instant.now().toEpochMilli();
                    if (remainingMillis > 0) Thread.sleep(remainingMillis + 150);
                    blocker.commit();
                    blockerReleased = true;

                    assertThatThrownBy(() -> renewal.get(10, TimeUnit.SECONDS))
                            .isInstanceOf(ExecutionException.class)
                            .hasCauseInstanceOf(IllegalStateException.class)
                            .hasRootCauseMessage("Expired Media stream lease cannot be renewed");
                    assertThat(streams.find(connected.tenantId(), connected.sessionId())).contains(connected);
                } finally {
                    if (!blockerReleased) blocker.rollback();
                    executor.shutdownNow();
                    assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
                }
            }
        }
    }

    private static void delayedFrameMutationIsRejectedAfterLeaseExpiry(boolean acknowledge) throws Exception {
        String bucket = "media-stream-frame-expiry-" + UUID.randomUUID().toString().replace("-", "");
        createBucket(bucket);
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
             PostgresqlMediaStreamSessionStore streams = new PostgresqlMediaStreamSessionStore()) {
            Instant createdAt = Instant.now();
            Instant leaseExpiry = createdAt.plusSeconds(3);
            String sessionId = "stream-frame-expiry-" + UUID.randomUUID();
            StreamSession opened = streams.create(new StreamSession(
                    "tenant-frame-expiry", sessionId, "principal-frame-expiry", StreamKind.AUDIO,
                    "provider-frame-expiry", StreamState.OPEN, -1, 0, 1024, 0,
                    leaseExpiry, createdAt, createdAt, null, Map.of(), 1), TOKEN_HASH);
            StreamSession connected = streams.connect(opened, TOKEN_HASH, leaseExpiry);
            StreamSession mutationBase = acknowledge
                    ? streams.beginFrame(connected, 0, "attempt-frame-expiry")
                    : connected;

            try (var blocker = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                    POSTGRES.getUsername(), POSTGRES.getPassword())) {
                blocker.setAutoCommit(false);
                lockSessionRow(blocker, connected);
                var executor = Executors.newSingleThreadExecutor();
                boolean blockerReleased = false;
                try {
                    var reservation = executor.submit(() -> acknowledge
                            ? streams.recordFrame(mutationBase, 0, 0, false)
                            : streams.beginFrame(mutationBase, 0, "attempt-frame-expiry"));
                    awaitUpdateBlockedOnRowLock();
                    long remainingMillis = leaseExpiry.toEpochMilli() - Instant.now().toEpochMilli();
                    if (remainingMillis > 0) Thread.sleep(remainingMillis + 150);
                    blocker.commit();
                    blockerReleased = true;

                    assertThatThrownBy(() -> reservation.get(10, TimeUnit.SECONDS))
                            .isInstanceOf(ExecutionException.class)
                            .hasCauseInstanceOf(IllegalStateException.class);
                    assertThat(streams.find(connected.tenantId(), connected.sessionId()))
                            .contains(mutationBase);
                } finally {
                    if (!blockerReleased) blocker.rollback();
                    executor.shutdownNow();
                    assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
                }
            }
        }
    }

    private static void lockSessionRow(java.sql.Connection connection, StreamSession session) throws Exception {
        try (var query = connection.prepareStatement(
                "SELECT session_id FROM media_stream_sessions WHERE tenant_id=? AND session_id=? FOR UPDATE")) {
            query.setString(1, session.tenantId());
            query.setString(2, session.sessionId());
            try (var rows = query.executeQuery()) { assertThat(rows.next()).isTrue(); }
        }
    }

    private static void awaitUpdateBlockedOnRowLock() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            try (var observer = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                    POSTGRES.getUsername(), POSTGRES.getPassword());
                 var query = observer.prepareStatement("""
                         SELECT count(*) FROM pg_stat_activity
                         WHERE datname=current_database() AND state='active' AND wait_event_type='Lock'
                           AND query LIKE 'SELECT principal_id,stream_kind,provider_id,state,connection_token_hash,lease_expires_at,%'
                         """);
                 var rows = query.executeQuery()) {
                rows.next();
                if (rows.getLong(1) > 0) return;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("Frame reservation did not block on the held session row lock");
    }

    private static void awaitRenewalBlockedOnRowLock() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            try (var observer = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                    POSTGRES.getUsername(), POSTGRES.getPassword());
                 var query = observer.prepareStatement("""
                         SELECT count(*) FROM pg_stat_activity
                         WHERE datname=current_database() AND state='active' AND wait_event_type='Lock'
                           AND (query LIKE 'SELECT principal_id,stream_kind,provider_id,state,connection_token_hash,lease_expires_at,%'
                             OR query LIKE 'UPDATE media_stream_sessions SET lease_expires_at,%'
                             OR query LIKE 'UPDATE media_stream_sessions SET state=?,lease_expires_at,%')
                         """);
                 var rows = query.executeQuery()) {
                rows.next();
                if (rows.getLong(1) > 0) return;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("Lease renewal did not block on the held session row lock");
    }

    private static void createBucket(String bucket) {
        try (S3Client client = S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
    }

    private static Map<String, String> environment(String bucket) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_STREAM_FRAME_EXPIRY_DB_PASSWORD");
        env.put("MEDIA_STREAM_FRAME_EXPIRY_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_STREAM_FRAME_EXPIRY_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_STREAM_FRAME_EXPIRY_SECRET");
        env.put("MEDIA_STREAM_FRAME_EXPIRY_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_STREAM_FRAME_EXPIRY_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }
}
