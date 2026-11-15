package com.ghatana.media.provider.aws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.MediaRequestLedgerContracts.Acquired;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Claim;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Entry;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.InProgress;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Key;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Mismatch;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Replay;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.RequestLedger;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.State;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.localstack.LocalStackContainer;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

/**
 * PostgreSQL persistence of the DEV_ONLY request ledger (V038): concurrent same-key claims, a crash mid-run with a
 * stale-lease takeover, replay after a full restart of the shared runtime state, and fingerprint mismatch.
 */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaRequestLedgerTest {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    private static final String FP_A = "a".repeat(64);
    private static final String FP_B = "b".repeat(64);
    private static final Duration LEASE = Duration.ofMinutes(5);
    private static final List<OutputRef> OUT = List.of(
            new OutputRef("transcript", "artifact-t", "sha256:" + "1".repeat(64)),
            new OutputRef("captions", "artifact-c", "sha256:" + "2".repeat(64)));

    private static final class MutableClock extends Clock {
        private volatile Instant now = Instant.now();
        @Override public ZoneId getZone() { return ZoneId.of("UTC"); }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
        void advance(Duration by) { now = now.plus(by); }
    }

    private static Key key() {
        return new Key("tenant-" + UUID.randomUUID(), "principal-1", "speech.transcribe", "req-" + UUID.randomUUID());
    }

    @Test
    void concurrentClaimsOfOneKeyFromSeveralStoresGiveTheRunToExactlyOneCaller() throws Exception {
        try (Fixture fixture = openFixture();
             PostgresqlMediaRequestLedger left = new PostgresqlMediaRequestLedger();
             PostgresqlMediaRequestLedger right = new PostgresqlMediaRequestLedger();
             ExecutorService workers = Executors.newFixedThreadPool(16)) {
            Key key = key();
            CountDownLatch start = new CountDownLatch(1);
            List<Future<Claim>> results = new ArrayList<>();
            for (int i = 0; i < 16; i++) {
                RequestLedger ledger = i % 2 == 0 ? left : right;
                String owner = "worker-" + i;
                results.add(workers.submit(() -> {
                    start.await();
                    return ledger.claim(key, FP_A, owner, LEASE);
                }));
            }
            start.countDown();
            int acquired = 0;
            int inProgress = 0;
            for (Future<Claim> result : results) {
                Claim claim = result.get();
                if (claim instanceof Acquired) acquired++;
                else if (claim instanceof InProgress) inProgress++;
            }
            assertThat(acquired).as("exactly one claimant runs the model").isEqualTo(1);
            assertThat(inProgress).isEqualTo(15);
            assertThat(left.find(key).orElseThrow().attempts()).isEqualTo(1);
        }
    }

    @Test
    void aCrashMidRunLeavesAnUnknownOutcomeUntilTheLeaseExpiresThenOneTakeoverCompletesAndTheStaleOwnerIsFenced() throws Exception {
        try (Fixture fixture = openFixture()) {
            MutableClock clock = new MutableClock();
            Key key = key();
            try (PostgresqlMediaRequestLedger crashed = new PostgresqlMediaRequestLedger(
                    MediaAwsPostgresqlRuntimeState.acquire(), clock);
                 PostgresqlMediaRequestLedger survivor = new PostgresqlMediaRequestLedger(
                         MediaAwsPostgresqlRuntimeState.acquire(), clock)) {
                assertThat(crashed.claim(key, FP_A, "launcher-that-dies", LEASE)).isEqualTo(new Acquired(1, 1, false));
                // The owner dies here: no completion, no release. Inside the lease the outcome is simply unknown.
                clock.advance(Duration.ofMinutes(2));
                assertThat(survivor.claim(key, FP_A, "launcher-2", LEASE)).isInstanceOf(InProgress.class);
                assertThat(survivor.find(key).orElseThrow().state()).isEqualTo(State.IN_PROGRESS);

                clock.advance(Duration.ofMinutes(4));
                // Two survivors race for the stale lease: exactly one takes it over.
                try (ExecutorService workers = Executors.newFixedThreadPool(2)) {
                    Future<Claim> a = workers.submit(() -> survivor.claim(key, FP_A, "launcher-2", LEASE));
                    Future<Claim> b = workers.submit(() -> crashed.claim(key, FP_A, "launcher-3", LEASE));
                    List<Claim> claims = List.of(a.get(), b.get());
                    assertThat(claims.stream().filter(Acquired.class::isInstance).count()).isEqualTo(1);
                    Acquired takeover = (Acquired) claims.stream().filter(Acquired.class::isInstance).findFirst().orElseThrow();
                    assertThat(takeover).isEqualTo(new Acquired(2, 2, true));
                    assertThat(claims.stream().filter(InProgress.class::isInstance).count()).isEqualTo(1);

                    // The zombie from the crashed launcher wakes up late: it can neither complete nor release.
                    assertThat(crashed.complete(key, 1, OUT)).isFalse();
                    assertThat(crashed.release(key, 1, "late")).isFalse();
                    assertThat(survivor.find(key).orElseThrow().state()).isEqualTo(State.IN_PROGRESS);

                    assertThat(survivor.complete(key, 2, OUT)).isTrue();
                }
                Entry done = survivor.find(key).orElseThrow();
                assertThat(done.state()).isEqualTo(State.COMPLETED);
                assertThat(done.attempts()).isEqualTo(2);
                assertThat(done.outputs()).isEqualTo(OUT);
                assertThat(crashed.claim(key, FP_A, "anyone", LEASE)).isEqualTo(new Replay(OUT));
            }
        }
    }

    @Test
    void aRunWhoseOwnerIsProvablyGoneIsReclaimedByCompareAndSetBeforeItsLeaseExpires() throws Exception {
        try (Fixture fixture = openFixture(); PostgresqlMediaRequestLedger ledger = new PostgresqlMediaRequestLedger()) {
            Key key = key();
            assertThat(ledger.claim(key, FP_A, "killed-launcher", LEASE)).isEqualTo(new Acquired(1, 1, false));
            InProgress busy = (InProgress) ledger.claim(key, FP_A, "restarted-launcher", LEASE);
            assertThat(busy.leaseOwner()).isEqualTo("killed-launcher");
            assertThat(busy.fence()).isEqualTo(1);
            // A stale view (wrong fence or owner, or another request) never takes the run.
            assertThat(ledger.reclaim(key, FP_A, "killed-launcher", 9, "restarted-launcher", LEASE)).isInstanceOf(InProgress.class);
            assertThat(ledger.reclaim(key, FP_A, "someone-else", 1, "restarted-launcher", LEASE)).isInstanceOf(InProgress.class);
            assertThat(ledger.reclaim(key, FP_B, "killed-launcher", 1, "restarted-launcher", LEASE)).isInstanceOf(Mismatch.class);
            // Two restarted workers race to reclaim: exactly one wins.
            try (ExecutorService workers = Executors.newFixedThreadPool(2)) {
                Future<Claim> a = workers.submit(() -> ledger.reclaim(key, FP_A, "killed-launcher", 1, "worker-a", LEASE));
                Future<Claim> b = workers.submit(() -> ledger.reclaim(key, FP_A, "killed-launcher", 1, "worker-b", LEASE));
                List<Claim> claims = List.of(a.get(), b.get());
                assertThat(claims.stream().filter(Acquired.class::isInstance).count()).isEqualTo(1);
                assertThat(claims.stream().filter(InProgress.class::isInstance).count()).isEqualTo(1);
            }
            Entry entry = ledger.find(key).orElseThrow();
            assertThat(entry.fence()).isEqualTo(2);
            assertThat(entry.attempts()).isEqualTo(2);
            // The killed launcher's late completion is fenced out.
            assertThat(ledger.complete(key, 1, OUT)).isFalse();
            assertThat(ledger.complete(key, 2, OUT)).isTrue();
        }
    }

    @Test
    void aCompletedRequestReplaysItsRegisteredOutputsAfterAFullRestartOfTheRuntimeState() throws Exception {
        String bucket = "media-ledger-" + UUID.randomUUID().toString().replace("-", "");
        createBucket(bucket);
        Key key = key();
        AutoCloseable firstRun = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
        MediaAwsPostgresqlRuntimeState keepAlive = MediaAwsPostgresqlRuntimeState.acquire();
        try (PostgresqlMediaRequestLedger ledger = new PostgresqlMediaRequestLedger()) {
            assertThat(ledger.claim(key, FP_A, "launcher-1", LEASE)).isInstanceOf(Acquired.class);
            assertThat(ledger.complete(key, 1, OUT)).isTrue();
        } finally {
            keepAlive.release();
            firstRun.close();
        }
        // A brand-new runtime state (new pool, as after a process restart) reads the same durable row.
        AutoCloseable secondRun = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
        MediaAwsPostgresqlRuntimeState keepAlive2 = MediaAwsPostgresqlRuntimeState.acquire();
        try (PostgresqlMediaRequestLedger restarted = new PostgresqlMediaRequestLedger()) {
            assertThat(restarted.ready()).isTrue();
            assertThat(restarted.claim(key, FP_A, "launcher-2", LEASE)).isEqualTo(new Replay(OUT));
            Entry entry = restarted.find(key).orElseThrow();
            assertThat(entry.fingerprint()).isEqualTo(FP_A);
            assertThat(entry.outputs()).isEqualTo(OUT);
            assertThat(entry.completedAt()).isNotNull();
        } finally {
            keepAlive2.release();
            secondRun.close();
        }
    }

    @Test
    void aDifferentFingerprintIsAMismatchInEveryStateAndNeverReplaysOrTakesOver() throws Exception {
        try (Fixture fixture = openFixture()) {
            MutableClock clock = new MutableClock();
            try (PostgresqlMediaRequestLedger ledger = new PostgresqlMediaRequestLedger(
                    MediaAwsPostgresqlRuntimeState.acquire(), clock)) {
                Key key = key();
                ledger.claim(key, FP_A, "w1", LEASE);
                assertThat(ledger.claim(key, FP_B, "w2", LEASE)).isInstanceOf(Mismatch.class);
                clock.advance(Duration.ofMinutes(10));
                assertThat(ledger.claim(key, FP_B, "w2", LEASE)).as("a stale lease is not taken over by another request")
                        .isInstanceOf(Mismatch.class);
                assertThat(ledger.claim(key, FP_A, "w1", LEASE)).isEqualTo(new Acquired(2, 2, true));
                assertThat(ledger.complete(key, 2, OUT)).isTrue();
                assertThat(ledger.claim(key, FP_B, "w2", LEASE)).isInstanceOf(Mismatch.class);
                assertThat(ledger.find(key).orElseThrow().fingerprint()).isEqualTo(FP_A);
            }
        }
    }

    @Test
    void aReleasedRunIsClaimedAgainAndTheKeyIsScopedToTenantPrincipalAndLane() throws Exception {
        try (Fixture fixture = openFixture(); PostgresqlMediaRequestLedger ledger = new PostgresqlMediaRequestLedger()) {
            Key key = key();
            assertThat(ledger.claim(key, FP_A, "w1", LEASE)).isEqualTo(new Acquired(1, 1, false));
            assertThat(ledger.release(key, 1, "SPEECH_OUTCOME_UNKNOWN")).isTrue();
            assertThat(ledger.find(key).orElseThrow().state()).isEqualTo(State.RELEASED);
            assertThat(ledger.find(key).orElseThrow().lastFailureCode()).isEqualTo("SPEECH_OUTCOME_UNKNOWN");
            assertThat(ledger.claim(key, FP_A, "w1", LEASE)).isEqualTo(new Acquired(2, 2, false));
            assertThat(ledger.complete(key, 2, OUT)).isTrue();

            for (Key other : List.of(new Key("other-" + key.tenantId(), key.principalId(), key.lane(), key.requestId()),
                    new Key(key.tenantId(), "principal-2", key.lane(), key.requestId()),
                    new Key(key.tenantId(), key.principalId(), "speech.synthesize", key.requestId()))) {
                assertThat(ledger.claim(other, FP_B, "w", LEASE)).as(other.toString()).isEqualTo(new Acquired(1, 1, false));
            }
        }
    }

    @Test
    void theSchemaItselfRefusesACompletedRowWithoutOutputsAndAnUnknownState() throws Exception {
        try (Fixture fixture = openFixture()) {
            String tenant = "tenant-" + UUID.randomUUID();
            try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                    POSTGRES.getPassword())) {
                assertThatThrownBy(() -> insertRaw(connection, tenant, "req-1", "COMPLETED", "[]", true))
                        .isInstanceOf(SQLException.class).hasMessageContaining("media_dev_request_ledger_completed_check");
                assertThatThrownBy(() -> insertRaw(connection, tenant, "req-2", "BOGUS", "[]", false))
                        .isInstanceOf(SQLException.class).hasMessageContaining("media_dev_request_ledger_state_check");
            }
        }
    }

    @Test
    void pruneDeletesOnlyOldTerminalRowsInBoundedBatchesAndKeepsInProgressErasedAndRecentRows() throws Exception {
        try (Fixture fixture = openFixture()) {
            MutableClock clock = new MutableClock();
            try (PostgresqlMediaRequestLedger timed = new PostgresqlMediaRequestLedger(
                    MediaAwsPostgresqlRuntimeState.acquire(), clock)) {
                // The container is shared by the class: clear terminal rows left by other tests so counts are exact.
                drainTerminalRows(timed);
                String tenant = "tenant-" + UUID.randomUUID();
                Key completedA = new Key(tenant, "p", "speech.transcribe", "old-completed-a");
                Key completedB = new Key(tenant, "p", "speech.transcribe", "old-completed-b");
                Key released = new Key(tenant, "p", "speech.transcribe", "old-released");
                Key inProgress = new Key(tenant, "p", "speech.transcribe", "old-in-progress");
                Key erased = new Key(tenant, "p", "speech.transcribe", "old-erased");
                Key recent = new Key(tenant, "p", "speech.transcribe", "recent-completed");

                // Everything below is last updated 40 days before the prune.
                for (Key key : List.of(completedA, completedB, erased)) {
                    assertThat(timed.claim(key, FP_A, "w", LEASE)).isInstanceOf(Acquired.class);
                    assertThat(timed.complete(key, 1, OUT)).isTrue();
                }
                assertThat(timed.claim(released, FP_A, "w", LEASE)).isEqualTo(new Acquired(1, 1, false));
                assertThat(timed.release(released, 1, "backend-failed")).isTrue();
                assertThat(timed.claim(inProgress, FP_A, "w", LEASE)).isEqualTo(new Acquired(1, 1, false));
                clock.advance(Duration.ofDays(40));
                assertThat(timed.claim(recent, FP_A, "w", LEASE)).isInstanceOf(Acquired.class);
                assertThat(timed.complete(recent, 1, OUT)).isTrue();

                // ERASED is a permanent tombstone: the erasure path writes it, pruning must never remove it.
                try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                        POSTGRES.getPassword());
                     PreparedStatement markErased = connection.prepareStatement(
                             "UPDATE media_dev_request_ledger SET state='ERASED', outputs_json='[]', completed_at=NULL"
                                     + " WHERE tenant_id=? AND request_id=?")) {
                    markErased.setString(1, tenant);
                    markErased.setString(2, erased.requestId());
                    assertThat(markErased.executeUpdate()).isEqualTo(1);
                }

                Instant cutoff = clock.instant().minus(Duration.ofDays(30));
                // Three old terminal rows (two COMPLETED, one RELEASED): a batch bound of 2 removes exactly 2.
                assertThat(timed.pruneTerminal(cutoff, 2)).isEqualTo(2);
                assertThat(timed.pruneTerminal(cutoff, 10)).isEqualTo(1);
                assertThat(timed.pruneTerminal(cutoff, 10)).isZero();

                assertThat(timed.find(completedA)).isEmpty();
                assertThat(timed.find(completedB)).isEmpty();
                assertThat(timed.find(released)).isEmpty();
                assertThat(timed.find(inProgress).orElseThrow().state()).isEqualTo(State.IN_PROGRESS);
                assertThat(timed.find(erased).orElseThrow().state()).isEqualTo(State.ERASED);
                assertThat(timed.find(recent).orElseThrow().state()).isEqualTo(State.COMPLETED);
                assertThatThrownBy(() -> timed.pruneTerminal(cutoff, 0)).isInstanceOf(IllegalArgumentException.class);
            }
        }
    }

    @Test
    void aPrunedRequestIsClaimedAsANewRequestWithAFreshAttemptAndFence() throws Exception {
        try (Fixture fixture = openFixture()) {
            MutableClock clock = new MutableClock();
            try (PostgresqlMediaRequestLedger ledger = new PostgresqlMediaRequestLedger(
                    MediaAwsPostgresqlRuntimeState.acquire(), clock)) {
                drainTerminalRows(ledger);
                Key key = key();
                assertThat(ledger.claim(key, FP_A, "w", LEASE)).isEqualTo(new Acquired(1, 1, false));
                assertThat(ledger.complete(key, 1, OUT)).isTrue();
                clock.advance(Duration.ofDays(31));

                assertThat(ledger.pruneTerminal(clock.instant().minus(Duration.ofDays(30)), 500)).isEqualTo(1);
                // Same key, even a different fingerprint: a new request, not a replay and not a 409 mismatch.
                assertThat(ledger.claim(key, FP_B, "w", LEASE)).isEqualTo(new Acquired(1, 1, false));
                Entry fresh = ledger.find(key).orElseThrow();
                assertThat(fresh.state()).isEqualTo(State.IN_PROGRESS);
                assertThat(fresh.fingerprint()).isEqualTo(FP_B);
                assertThat(fresh.outputs()).isEmpty();
            }
        }
    }

    /** Deletes every terminal row of the shared container that is already in the past; used before exact-count checks. */
    private static void drainTerminalRows(PostgresqlMediaRequestLedger ledger) {
        while (ledger.pruneTerminal(Instant.now().plus(Duration.ofDays(1)), 500) > 0) { /* drain */ }
    }

    private static void insertRaw(Connection connection, String tenant, String requestId, String state, String outputs,
                                  boolean completed) throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement("""
                INSERT INTO media_dev_request_ledger (tenant_id,principal_id,lane,request_id,request_fingerprint,state,
                lease_owner,lease_token,lease_expires_at,attempts,outputs_json,created_at,updated_at,completed_at)
                VALUES (?, 'p', 'lane', ?, ?, ?, 'o', 1, now(), 1, ?, now(), now(), CASE WHEN ? THEN now() END)""")) {
            insert.setString(1, tenant);
            insert.setString(2, requestId);
            insert.setString(3, FP_A);
            insert.setString(4, state);
            insert.setString(5, outputs);
            insert.setBoolean(6, completed);
            insert.executeUpdate();
        }
    }

    private static void createBucket(String bucket) {
        try (S3Client client = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
    }

    private static Fixture openFixture() {
        String bucket = "media-ledger-" + UUID.randomUUID().toString().replace("-", "");
        createBucket(bucket);
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
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_LEDGER_DB_PASSWORD");
        env.put("MEDIA_LEDGER_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_LEDGER_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_LEDGER_SECRET");
        env.put("MEDIA_LEDGER_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_LEDGER_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }
}
