package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobLease;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptStart;
import org.junit.jupiter.api.Test;
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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J13 deterministic crash matrix for the durable worker path. Two {@link PostgresqlMediaJobStore}
 * instances over one database model two worker processes; a "crash" is an abandoned in-memory
 * lease (the process is gone but the row is not), and a "restart" is a new store instance running
 * the bounded {@code recoverableAfter} scan. Each kill point is exercised against the committed
 * store state only — no wall-clock sleeps and no mocked durable state.
 */
@Testcontainers(disabledWithoutDocker = true)
class MediaDurableWorkerCrashIT {
    private static org.h2.jdbcx.JdbcDataSource h2(String url) {
        var ds = new org.h2.jdbcx.JdbcDataSource();
        ds.setURL(url);
        ds.setUser("sa");
        return ds;
    }


    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final String FINGERPRINT =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String PROVENANCE =
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    private record Harness(String jdbcUrl, AutoCloseable installed,
                           PostgresqlMediaJobStore workerA, PostgresqlMediaJobStore workerB)
            implements AutoCloseable {
        @Override public void close() throws Exception {
            workerA.close();
            workerB.close();
            installed.close();
        }
    }

    private static Harness harness() throws Exception {
        String jdbcUrl = "jdbc:h2:mem:media_crash_" + UUID.randomUUID().toString().replace("-", "")
                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
        String bucket = "media-crash-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client client = S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", jdbcUrl);
        environment.put("MEDIA_POSTGRES_USER", "sa");
        environment.put("MEDIA_POSTGRES_DRIVER", "org.h2.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "8");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_CRASH_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_CRASH_SECRET");
        environment.put("MEDIA_CRASH_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_CRASH_SECRET", LOCALSTACK.getSecretKey());
        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
        return new Harness(jdbcUrl, installed, new PostgresqlMediaJobStore(), new PostgresqlMediaJobStore());
    }

    private static ProcessingJob acceptedJob(String jobId) {
        return new ProcessingJob(
                jobId, "request-" + jobId, "tenant-a", "principal-a", "artifact-a", JobType.VISION,
                "provider-a", JobStatus.ACCEPTED, Instant.now(), null, null, Map.of(), "", 1,
                "", FINGERPRINT);
    }

    private static ProcessingJob runningOf(ProcessingJob accepted) {
        return new ProcessingJob(
                accepted.jobId(), accepted.requestId(), accepted.tenantId(), accepted.principalId(),
                accepted.artifactId(), accepted.jobType(), accepted.providerId(), JobStatus.RUNNING,
                accepted.createdAt(), Instant.now(), null, Map.of(), "", accepted.version() + 1,
                accepted.expectedArtifactVersion(), accepted.requestFingerprint());
    }

    private static ProcessingJob terminalOf(
            ProcessingJob current, JobStatus status, String failureCode, Map<String, Object> result) {
        return new ProcessingJob(
                current.jobId(), current.requestId(), current.tenantId(), current.principalId(),
                current.artifactId(), current.jobType(), current.providerId(), status,
                current.createdAt(), current.startedAt(), Instant.now(), result, failureCode,
                current.version() + 1, current.expectedArtifactVersion(), current.requestFingerprint());
    }

    private static MediaLifecycleEvent event(ProcessingJob terminal, String type) {
        return new MediaLifecycleEvent(
                "media:" + type + ":" + terminal.jobId() + ":" + terminal.version(), type,
                terminal.tenantId(), terminal.principalId(), terminal.requestId(), terminal.requestId(),
                "job", terminal.jobId(), terminal.version(), "INTERNAL", Instant.now(),
                Map.of("status", terminal.status().name()));
    }

    private static void expireLease(String jdbcUrl, ProcessingJob job) throws Exception {
        try (var connection = h2(jdbcUrl).getConnection();
             var statement = connection.prepareStatement(
                     "UPDATE media_processing_jobs SET lease_expires_at=? WHERE tenant_id=? AND job_id=?")) {
            statement.setLong(1, Instant.now().minusSeconds(5).toEpochMilli());
            statement.setString(2, job.tenantId());
            statement.setString(3, job.jobId());
            statement.executeUpdate();
        }
    }

    private static String attemptColumn(String jdbcUrl, ProcessingJob job, String column) throws Exception {
        try (var connection = h2(jdbcUrl).getConnection();
             var statement = connection.createStatement();
             var result = statement.executeQuery(
                     "SELECT " + column + " FROM media_processing_attempts"
                             + " WHERE tenant_id='" + job.tenantId() + "' AND job_id='" + job.jobId() + "'"
                             + " ORDER BY attempt_number DESC LIMIT 1")) {
            assertThat(result.next()).isTrue();
            Object value = result.getObject(1);
            return value == null ? null : value.toString();
        }
    }

    @Test
    void killBeforeClaimKeepsJobRecoverableAndClaimable() throws Exception {
        try (Harness h = harness()) {
            ProcessingJob accepted = h.workerA().create(acceptedJob("job-kill-before-claim"));
            // Worker A crashes before claiming: the row must remain visible to a recovery pass.
            assertThat(h.workerB().recoverableAfter(10, null))
                    .extracting(ProcessingJob::jobId).contains(accepted.jobId());

            JobLease lease = h.workerB().claim(accepted, "worker-b", Instant.now().plusSeconds(60));
            assertThat(h.workerB().leaseValid(lease)).isTrue();
            // Byte-identical replay returns the same logical job without a second dispatch.
            ProcessingJob replayed = h.workerB().create(acceptedJob("job-kill-before-claim"));
            assertThat(replayed.jobId()).isEqualTo(accepted.jobId());
            assertThat(h.workerB().countByStatus(JobStatus.ACCEPTED)).isEqualTo(1);
            // The same request identity under a different submission is rejected outright.
            ProcessingJob divergent = new ProcessingJob(
                    accepted.jobId(), accepted.requestId(), accepted.tenantId(), accepted.principalId(),
                    accepted.artifactId(), accepted.jobType(), accepted.providerId(), JobStatus.ACCEPTED,
                    accepted.createdAt(), null, null, Map.of(), "", 1, "",
                    PROVENANCE);
            assertThatThrownBy(() -> h.workerB().create(divergent))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("different submission");
        }
    }

    @Test
    void killAfterClaimTransfersOwnershipOnlyAfterLeaseExpiry() throws Exception {
        try (Harness h = harness()) {
            ProcessingJob accepted = h.workerA().create(acceptedJob("job-kill-after-claim"));
            JobLease leaseA = h.workerA().claim(accepted, "worker-a", Instant.now().plusSeconds(600));

            // While the lease is live a second worker cannot own it and recovery skips it.
            assertThatThrownBy(() -> h.workerB().claim(
                    accepted, "worker-b", Instant.now().plusSeconds(60)))
                    .hasMessageContaining("leased by another worker");
            assertThat(h.workerB().recoverableAfter(10, null)).isEmpty();

            // After the crashed worker's lease lapses, worker B owns it under a newer fence and
            // worker A's fenced write is rejected.
            expireLease(h.jdbcUrl(), accepted);
            JobLease leaseB = h.workerB().claim(accepted, "worker-b", Instant.now().plusSeconds(60));
            assertThat(leaseB.fencingToken()).isGreaterThan(leaseA.fencingToken());
            assertThatThrownBy(() -> h.workerA().update(
                    leaseA, accepted, runningOf(accepted)))
                    .hasMessageContaining("fence");
        }
    }

    @Test
    void killAfterDispatchIntentPreservesEvidenceAndReconcilesUnknown() throws Exception {
        try (Harness h = harness()) {
            ProcessingJob accepted = h.workerA().create(acceptedJob("job-kill-after-dispatch"));
            JobLease leaseA = h.workerA().claim(accepted, "worker-a", Instant.now().plusSeconds(600));
            AttemptStart started = h.workerA().startAttempt(
                    accepted, runningOf(accepted), leaseA, 1, FINGERPRINT);
            // Worker A crashes after the dispatch-intent commit but before any provider call.
            assertThat(started.attempt().finality()).isEqualTo(AttemptFinality.UNKNOWN);

            expireLease(h.jdbcUrl(), accepted);
            var recoverable = h.workerB().recoverableAfter(10, null);
            assertThat(recoverable).extracting(ProcessingJob::jobId).containsExactly(accepted.jobId());
            ProcessingJob running = recoverable.getFirst();

            // Reconciliation marks the job honestly unknown; it never silently retries.
            ProcessingJob unknown = terminalOf(
                    running, JobStatus.OUTCOME_UNKNOWN, "PROCESSING_OUTCOME_UNKNOWN",
                    Map.of("providerOutcome", "UNKNOWN"));
            h.workerB().reconcileExpired(running, unknown, event(unknown, "media.job.reconciled"));

            ProcessingJob stored = h.workerB().find(accepted.tenantId(), accepted.jobId()).orElseThrow();
            assertThat(stored.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(attemptColumn(h.jdbcUrl(), accepted, "state")).isEqualTo("OUTCOME_UNKNOWN");
            // UNKNOWN is terminal for the bounded scan: it is never silently re-dispatched.
            assertThat(h.workerB().recoverableAfter(10, null)).isEmpty();
        }
    }

    @Test
    void killAfterProviderReceiptKeepsReceiptIdentityUnderUnknown() throws Exception {
        try (Harness h = harness()) {
            ProcessingJob accepted = h.workerA().create(acceptedJob("job-kill-after-receipt"));
            JobLease leaseA = h.workerA().claim(accepted, "worker-a", Instant.now().plusSeconds(600));
            AttemptStart started = h.workerA().startAttempt(
                    accepted, runningOf(accepted), leaseA, 1, FINGERPRINT);
            var receiptAttempt = h.workerA().recordProviderReceipt(
                    started.attempt(), leaseA, "op-42", "receipt-42");
            // Crash after the provider receipt was persisted but before the final outcome commit.
            assertThat(receiptAttempt.providerOperationId()).isEqualTo("op-42");

            expireLease(h.jdbcUrl(), accepted);
            ProcessingJob running = h.workerB().recoverableAfter(10, null).getFirst();
            ProcessingJob unknown = terminalOf(
                    running, JobStatus.OUTCOME_UNKNOWN, "PROCESSING_OUTCOME_UNKNOWN",
                    Map.of("providerOutcome", "UNKNOWN"));
            h.workerB().reconcileExpired(running, unknown, event(unknown, "media.job.reconciled"));

            // The exact receipt identity survives reconciliation for later provider-side proof.
            assertThat(attemptColumn(h.jdbcUrl(), accepted, "provider_operation_id")).isEqualTo("op-42");
            assertThat(attemptColumn(h.jdbcUrl(), accepted, "provider_receipt_id")).isEqualTo("receipt-42");
            assertThat(attemptColumn(h.jdbcUrl(), accepted, "state")).isEqualTo("OUTCOME_UNKNOWN");
        }
    }

    @Test
    void killAfterFinalOutcomeCommitReadsBackTerminalTruth() throws Exception {
        try (Harness h = harness()) {
            ProcessingJob accepted = h.workerA().create(acceptedJob("job-kill-after-commit"));
            JobLease leaseA = h.workerA().claim(accepted, "worker-a", Instant.now().plusSeconds(600));
            AttemptStart started = h.workerA().startAttempt(
                    accepted, runningOf(accepted), leaseA, 1, FINGERPRINT);
            var receiptAttempt = h.workerA().recordProviderReceipt(
                    started.attempt(), leaseA, "op-7", "receipt-7");
            ProcessingJob completed = terminalOf(
                    started.running(), JobStatus.COMPLETED, "", Map.of("label", "cat"));
            ProviderAttemptObservation observation = new ProviderAttemptObservation(
                    receiptAttempt.query(), AttemptFinality.SUCCEEDED, "receipt-7",
                    Map.of("label", "cat"), PROVENANCE, Instant.now());
            h.workerA().commitFinalOutcome(
                    started.running(), receiptAttempt, completed, observation,
                    event(completed, "media.job.completed"));
            // Worker A crashes immediately after commit; a restarted store reads durable truth.
            try (PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore()) {
                ProcessingJob stored = restarted.find(accepted.tenantId(), accepted.jobId()).orElseThrow();
                assertThat(stored.status()).isEqualTo(JobStatus.COMPLETED);
                assertThat(stored.result()).containsEntry("label", "cat");
                assertThat(attemptColumn(h.jdbcUrl(), accepted, "state")).isEqualTo("SUCCEEDED");
                assertThat(restarted.recoverableAfter(10, null)).isEmpty();
            }
        }
    }

    @Test
    void staleWorkerCannotCommitFinalOutcomeAfterNewFence() throws Exception {
        try (Harness h = harness()) {
            ProcessingJob accepted = h.workerA().create(acceptedJob("job-stale-fence"));
            JobLease leaseA = h.workerA().claim(accepted, "worker-a", Instant.now().plusSeconds(600));
            AttemptStart started = h.workerA().startAttempt(
                    accepted, runningOf(accepted), leaseA, 1, FINGERPRINT);
            var receiptAttempt = h.workerA().recordProviderReceipt(
                    started.attempt(), leaseA, "op-9", "receipt-9");

            // Worker A stalls; its lease lapses and worker B takes ownership under a new fence.
            expireLease(h.jdbcUrl(), accepted);
            ProcessingJob running = h.workerB().find(accepted.tenantId(), accepted.jobId()).orElseThrow();
            h.workerB().claim(running, "worker-b", Instant.now().plusSeconds(60));

            // The stale worker's final commit is fenced out; the job remains B's running work.
            ProcessingJob fakeComplete = terminalOf(
                    started.running(), JobStatus.COMPLETED, "", Map.of("label", "fake"));
            ProviderAttemptObservation observation = new ProviderAttemptObservation(
                    receiptAttempt.query(), AttemptFinality.SUCCEEDED, "receipt-9",
                    Map.of("label", "fake"), PROVENANCE, Instant.now());
            assertThatThrownBy(() -> h.workerA().commitFinalOutcome(
                    started.running(), receiptAttempt, fakeComplete, observation,
                    event(fakeComplete, "media.job.completed")))
                    .isInstanceOf(IllegalStateException.class);
            ProcessingJob stored = h.workerB().find(accepted.tenantId(), accepted.jobId()).orElseThrow();
            assertThat(stored.status()).isEqualTo(JobStatus.RUNNING);
        }
    }

    @Test
    void terminalJobCannotBeRewrittenThroughUnconditionalUpdate() throws Exception {
        try (Harness h = harness()) {
            ProcessingJob accepted = h.workerA().create(acceptedJob("job-terminal-rewrite"));
            ProcessingJob completed = terminalOf(
                    accepted, JobStatus.COMPLETED, "", Map.of("done", true));
            h.workerA().update(accepted, completed);

            // An unconditional update cannot regress or relabel a recorded terminal truth;
            // leaving OUTCOME_UNKNOWN belongs to the evidence-bound reconcile/commit paths.
            assertThatThrownBy(() -> h.workerA().update(
                    completed, terminalOf(completed, JobStatus.RUNNING, "", Map.of())))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("cannot be rewritten");
            assertThatThrownBy(() -> h.workerA().update(
                    completed, terminalOf(completed, JobStatus.FAILED, "LATE_FAILURE", Map.of())))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("cannot be rewritten");
            assertThat(h.workerB().find(accepted.tenantId(), accepted.jobId()).orElseThrow().status())
                    .isEqualTo(JobStatus.COMPLETED);
        }
    }

    @Test
    void concurrentWorkersClaimExactlyOnce() throws Exception {
        try (Harness h = harness()) {
            ProcessingJob accepted = h.workerA().create(acceptedJob("job-claim-race"));
            var pool = Executors.newFixedThreadPool(2);
            var ready = new CountDownLatch(2);
            var start = new CountDownLatch(1);
            var successes = new AtomicInteger();
            try {
                Future<?> a = pool.submit(() -> {
                    ready.countDown();
                    start.await();
                    try {
                        h.workerA().claim(accepted, "worker-a", Instant.now().plusSeconds(60));
                        successes.incrementAndGet();
                    } catch (IllegalStateException expected) { /* fenced out */ }
                    return null;
                });
                Future<?> b = pool.submit(() -> {
                    ready.countDown();
                    start.await();
                    try {
                        h.workerB().claim(accepted, "worker-b", Instant.now().plusSeconds(60));
                        successes.incrementAndGet();
                    } catch (IllegalStateException expected) { /* fenced out */ }
                    return null;
                });
                assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
                start.countDown();
                a.get(10, TimeUnit.SECONDS);
                b.get(10, TimeUnit.SECONDS);
                assertThat(successes.get()).isEqualTo(1);
            } finally {
                start.countDown();
                pool.shutdownNow();
            }
        }
    }
}
