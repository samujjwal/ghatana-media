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
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** PostgreSQL statement-time lease fence for a reconnect blocked behind another session writer. */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaStreamReconnectExpiryTest {
    private static final String TOKEN_HASH = "a".repeat(64);

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void reconnectBlockedUntilAfterPersistedLeaseExpiryIsRejectedByPostLockRuntimeClock() throws Exception {
        String bucket = "media-stream-expiry-" + UUID.randomUUID().toString().replace("-", "");
        createBucket(bucket);
        Map<String, String> environment = environment(bucket);

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaStreamSessionStore streams = new PostgresqlMediaStreamSessionStore()) {
            Instant createdAt = Instant.now();
            Instant leaseExpiry = Instant.now().plusSeconds(3);
            StreamSession opened = streams.create(new StreamSession(
                    "tenant-expiry", "stream-expiry", "principal-expiry", StreamKind.AUDIO,
                    "provider-expiry", StreamState.OPEN, -1, 0, 1024, 0,
                    leaseExpiry, createdAt, createdAt, null, Map.of(), 1), TOKEN_HASH);
            StreamSession connected = streams.connect(opened, TOKEN_HASH, leaseExpiry);

            try (var blocker = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                    POSTGRES.getUsername(), POSTGRES.getPassword())) {
                blocker.setAutoCommit(false);
                try (var lock = blocker.prepareStatement(
                        "SELECT session_id FROM media_stream_sessions "
                                + "WHERE tenant_id=? AND session_id=? FOR UPDATE")) {
                    lock.setString(1, connected.tenantId());
                    lock.setString(2, connected.sessionId());
                    try (var rows = lock.executeQuery()) {
                        assertThat(rows.next()).isTrue();
                    }
                }

                ExecutorService executor = Executors.newSingleThreadExecutor();
                Future<StreamSession> reconnect = null;
                boolean blockerReleased = false;
                try {
                    reconnect = executor.submit(() -> streams.connect(
                            connected, TOKEN_HASH, Instant.now().plusSeconds(30)));
                    awaitReconnectBlockedOnSessionRowLock(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                            POSTGRES.getPassword());
                    long untilExpiryMs = leaseExpiry.toEpochMilli() - Instant.now().toEpochMilli();
                    if (untilExpiryMs > 0) Thread.sleep(untilExpiryMs + 100);
                    blocker.commit();
                    blockerReleased = true;

                    Future<StreamSession> completedReconnect = reconnect;
                    assertThatThrownBy(() -> completedReconnect.get(10, TimeUnit.SECONDS))
                            .isInstanceOf(ExecutionException.class)
                            .hasCauseInstanceOf(IllegalStateException.class)
                            .hasRootCauseMessage("Media stream connection lease is absent or expired");
                    assertThat(streams.find(connected.tenantId(), connected.sessionId()))
                            .contains(connected);
                } finally {
                    if (!blockerReleased) blocker.rollback();
                    executor.shutdownNow();
                    assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
                }
            }
        }
    }

    @Test
    void frozenRuntimeClockLeavesExpiryRejectionToPostgresqlUpdateClockPredicate() throws Exception {
        String bucket = "media-stream-db-clock-" + UUID.randomUUID().toString().replace("-", "");
        createBucket(bucket);
        Map<String, String> environment = environment(bucket);

        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment)) {
            Instant frozenNow = databaseNow();
            Clock frozenClock = Clock.fixed(frozenNow, ZoneOffset.UTC);
            try (PostgresqlMediaStreamSessionStore streams = new PostgresqlMediaStreamSessionStore(frozenClock)) {
                Instant leaseExpiry = frozenNow.plusSeconds(3);
                StreamSession opened = streams.create(new StreamSession(
                        "tenant-db-clock", "stream-db-clock", "principal-db-clock", StreamKind.AUDIO,
                        "provider-db-clock", StreamState.OPEN, -1, 0, 1024, 0,
                        leaseExpiry, frozenNow, frozenNow, null, Map.of(), 1), TOKEN_HASH);
                StreamSession connected = streams.connect(opened, TOKEN_HASH, leaseExpiry);

                try (var blocker = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                        POSTGRES.getUsername(), POSTGRES.getPassword())) {
                    blocker.setAutoCommit(false);
                    lockSessionRow(blocker, connected);
                    ExecutorService executor = Executors.newSingleThreadExecutor();
                    Future<StreamSession> reconnect = null;
                    boolean blockerReleased = false;
                    try {
                        reconnect = executor.submit(() -> streams.connect(
                                connected, TOKEN_HASH, frozenNow.plusSeconds(30)));
                        awaitReconnectBlockedOnSessionRowLock(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                                POSTGRES.getPassword());
                        awaitDatabaseTimeAfter(leaseExpiry);
                        blocker.commit();
                        blockerReleased = true;

                        Future<StreamSession> completedReconnect = reconnect;
                        assertThatThrownBy(() -> completedReconnect.get(10, TimeUnit.SECONDS))
                                .isInstanceOf(ExecutionException.class)
                                .hasCauseInstanceOf(IllegalStateException.class)
                                .hasRootCauseMessage("Media stream connection lease is absent or expired");
                        assertThat(streams.find(connected.tenantId(), connected.sessionId()))
                                .contains(connected);
                    } finally {
                        if (!blockerReleased) blocker.rollback();
                        executor.shutdownNow();
                        assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
                    }
                }
            }
        }
    }

    private static Instant databaseNow() throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement("SELECT clock_timestamp()");
             var rows = query.executeQuery()) {
            assertThat(rows.next()).isTrue();
            return rows.getTimestamp(1).toInstant();
        }
    }

    private static void awaitDatabaseTimeAfter(Instant instant) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            if (databaseNow().isAfter(instant)) return;
            Thread.sleep(20);
        }
        throw new AssertionError("PostgreSQL clock did not pass the persisted lease expiry");
    }

    private static void lockSessionRow(java.sql.Connection connection, StreamSession session) throws Exception {
        try (var lock = connection.prepareStatement(
                "SELECT session_id FROM media_stream_sessions WHERE tenant_id=? AND session_id=? FOR UPDATE")) {
            lock.setString(1, session.tenantId());
            lock.setString(2, session.sessionId());
            try (var rows = lock.executeQuery()) {
                assertThat(rows.next()).isTrue();
            }
        }
    }

    private static void awaitReconnectBlockedOnSessionRowLock(String jdbcUrl, String username, String password)
            throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            try (var observer = DriverManager.getConnection(jdbcUrl, username, password);
                 var query = observer.prepareStatement("""
                         SELECT count(*) FROM pg_stat_activity
                         WHERE datname=current_database()
                           AND state='active'
                           AND wait_event_type='Lock'
                           AND query LIKE 'SELECT principal_id,stream_kind,provider_id,state,connection_token_hash,lease_expires_at,%'
                         """);
                 var rows = query.executeQuery()) {
                rows.next();
                if (rows.getLong(1) > 0) return;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("Reconnect session read did not block on the held row lock");
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
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_STREAM_EXPIRY_DB_PASSWORD");
        env.put("MEDIA_STREAM_EXPIRY_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_STREAM_EXPIRY_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_STREAM_EXPIRY_SECRET");
        env.put("MEDIA_STREAM_EXPIRY_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_STREAM_EXPIRY_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }
}
