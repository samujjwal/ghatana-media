package com.ghatana.media.provider.aws;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaLifecycleEventPublisher;
import com.ghatana.media.runtime.MediaLifecyclePublicationReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import java.sql.Connection;
import java.sql.DriverManager;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
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

import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** PostgreSQL-backed durable status and lease counts across job-store recreation. */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaJobStoreMetricsTest {
    private static final String REQUEST_FINGERPRINT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void countsAggregateStatusesAndExpiredRunningLeasesAfterStoreRecreation() throws Exception {
        String bucket = "media-metrics-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client client = s3Client()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        Map<String, String> environment = integrationEnvironment(bucket);

        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore initial = new PostgresqlMediaJobStore()) {
            String runId = UUID.randomUUID().toString().replace("-", "");
            ProcessingJob accepted = job("job-accepted-" + runId, JobStatus.ACCEPTED, 1);
            initial.create(accepted);

            ProcessingJob runningAccepted = job("job-running-" + runId, JobStatus.ACCEPTED, 1);
            initial.create(runningAccepted);
            var lease = initial.claim(runningAccepted, "worker-a", Instant.now().plusSeconds(30));
            ProcessingJob running = new ProcessingJob(
                    runningAccepted.jobId(), runningAccepted.requestId(), runningAccepted.tenantId(),
                    runningAccepted.principalId(), runningAccepted.artifactId(), runningAccepted.jobType(),
                    runningAccepted.providerId(), JobStatus.RUNNING, runningAccepted.createdAt(), Instant.now(),
                    null, Map.of(), "", runningAccepted.version() + 1,
                    runningAccepted.expectedArtifactVersion(), runningAccepted.requestFingerprint());
            var started = initial.startAttempt(runningAccepted, running, lease, 1, REQUEST_FINGERPRINT);
            expireLease(started.running());

            ProcessingJob unknown = job("job-unknown-" + runId, JobStatus.OUTCOME_UNKNOWN, 1);
            initial.create(unknown);
            seedExpiredOutboxClaim(runId);

            // A second store instance represents the post-restart reader. Keep it open before
            // closing the first instance so the test-only environment remains installed.
            try (PostgresqlMediaJobStore restarted = new PostgresqlMediaJobStore();
                 PostgresqlMediaLifecycleOutboxSource restartedOutbox =
                         new PostgresqlMediaLifecycleOutboxSource()) {
                initial.close();

                assertThat(restarted.countByStatus(JobStatus.ACCEPTED)).isEqualTo(1);
                assertThat(restarted.countByStatus(JobStatus.RUNNING)).isEqualTo(1);
                assertThat(restarted.countByStatus(JobStatus.OUTCOME_UNKNOWN)).isEqualTo(1);
                assertThat(restarted.countOverdueLeases(Instant.now())).isEqualTo(1);
                assertThat(restartedOutbox.countOverdueClaims(Instant.now())).isEqualTo(1);
            }
        }
    }

    @Test
    void listSnapshotScopesBeforeLimitAndPinsMetadataToTheDatabaseSnapshot() throws Exception {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-job-list-" + suffix;
        try (S3Client client = s3Client()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(integrationEnvironment(bucket));
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            String tenant = "tenant-list-" + suffix;
            store.create(job("foreign-latest-" + suffix, "foreign-request-" + suffix, tenant, "principal-b",
                    Instant.ofEpochMilli(3_000)));
            store.create(job("owned-latest-" + suffix, "owned-request-latest-" + suffix, tenant, "principal-a",
                    Instant.ofEpochMilli(2_000)));
            store.create(job("owned-older-" + suffix, "owned-request-older-" + suffix, tenant, "principal-a",
                    Instant.ofEpochMilli(1_000)));

            var first = store.listSnapshot(tenant, "principal-a", 1);
            assertThat(first.observed()).isTrue();
            assertThat(first.readVersion()).matches("[0-9a-f]{64}");
            assertThat(first.observedAt()).isNotNull();
            assertThat(first.jobs()).extracting(ProcessingJob::jobId)
                    .containsExactly("owned-latest-" + suffix);

            var sameSnapshot = store.listSnapshot(tenant, "principal-a", 1);
            assertThat(sameSnapshot.readVersion()).isEqualTo(first.readVersion());
            store.create(job("owned-newest-" + suffix, "owned-request-newest-" + suffix, tenant, "principal-a",
                    Instant.ofEpochMilli(4_000)));
            var afterMutation = store.listSnapshot(tenant, "principal-a", 1);
            assertThat(afterMutation.readVersion()).isNotEqualTo(first.readVersion());
            assertThat(afterMutation.jobs()).extracting(ProcessingJob::jobId)
                    .containsExactly("owned-newest-" + suffix);
        }
    }

    @Test
    void postgresRelayAcknowledgesCanonicalAcceptedIntentAndReplaysWithoutRepublish() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-outbox-ack-" + runId;
        try (S3Client client = s3Client()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        Map<String, String> environment = integrationEnvironment(bucket);
        ProcessingJob accepted = job("job-outbox-ack-" + runId, JobStatus.ACCEPTED, 1);
        MediaLifecycleEvent acceptedEvent = new MediaLifecycleEvent(
                "media:media.job.accepted:" + accepted.jobId() + ":" + accepted.version(),
                "media.job.accepted", accepted.tenantId(), accepted.principalId(), accepted.requestId(),
                accepted.requestId(), "processing-job", accepted.jobId(), accepted.version(), "INTERNAL",
                accepted.createdAt(), Map.of(
                        "jobId", accepted.jobId(),
                        "operationRef", "media.operation-slice.submit-job",
                        "admissionState", "ACCEPTED"));
        String unsupportedEventId = "media:media.job.attempt.dispatch_intended:" + runId;

        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore store = new PostgresqlMediaJobStore();
             PostgresqlMediaLifecycleOutboxSource outbox = new PostgresqlMediaLifecycleOutboxSource()) {
            seedArtifact(accepted.tenantId(), accepted.artifactId(), "INTERNAL");
            store.create(accepted, REQUEST_FINGERPRINT, null, null, acceptedEvent);
            seedUnsupportedLifecycleEvent(unsupportedEventId, runId);

            AtomicInteger publishCalls = new AtomicInteger();
            AtomicReference<MediaLifecycleEvent> publishedEvent = new AtomicReference<>();
            MediaLifecycleEventPublisher localReceiptFixture = new MediaLifecycleEventPublisher() {
                @Override public String publisherId() { return "test-local-receipt-fixture"; }
                @Override public boolean ready() { return true; }
                @Override public boolean productionEligible() { return false; }
                @Override public void publish(MediaLifecycleEvent event) {
                    publishCalls.incrementAndGet();
                    publishedEvent.set(event);
                }
                @Override public MediaLifecyclePublicationReceipt publishWithReceipt(MediaLifecycleEvent event) {
                    publish(event);
                    return new MediaLifecyclePublicationReceipt(event.eventId(),
                            MediaLifecyclePublicationReceipt.stableStoredEventId(event.eventId()),
                            "media-lifecycle", "19");
                }
            };

            assertThat(outbox.publishPending(localReceiptFixture, 10))
                    .isEqualTo(new PostgresqlMediaLifecycleOutboxSource.BatchResult(1, 1, 0));
            assertThat(publishCalls).hasValue(1);
            assertThat(publishedEvent.get()).isEqualTo(acceptedEvent);
            assertAcknowledgedOutboxEvent(acceptedEvent);
            assertUnclaimedUnsupportedEvent(unsupportedEventId);

            try (PostgresqlMediaLifecycleOutboxSource restartedOutbox =
                         new PostgresqlMediaLifecycleOutboxSource()) {
                assertThat(restartedOutbox.publishPending(localReceiptFixture, 10))
                        .isEqualTo(new PostgresqlMediaLifecycleOutboxSource.BatchResult(0, 0, 0));
            }
            assertThat(publishCalls).hasValue(1);
        }
    }

    private static S3Client s3Client() {
        return S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build();
    }

    private static Map<String, String> integrationEnvironment(String bucket) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_METRICS_DB_PASSWORD");
        environment.put("MEDIA_METRICS_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_METRICS_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_METRICS_SECRET");
        environment.put("MEDIA_METRICS_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_METRICS_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static void seedArtifact(String tenantId, String artifactId, String classification) throws Exception {
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
        try (Connection connection = state.connection(); var insert = connection.prepareStatement(
                "INSERT INTO media_artifacts (tenant_id,artifact_id,principal_id,file_name,content_type,size_bytes,"
                        + "sha256,object_reference,classification,created_at,expires_at,metadata_json) "
                        + "VALUES (?,?,?,'source.bin','application/octet-stream',1,?,?,?,1,2,'{}')")) {
            insert.setString(1, tenantId);
            insert.setString(2, artifactId);
            insert.setString(3, "principal-a");
            insert.setString(4, "b".repeat(64));
            insert.setString(5, "object:" + artifactId);
            insert.setString(6, classification);
            insert.executeUpdate();
        } finally {
            state.release();
        }
    }

    private static void expireLease(ProcessingJob job) throws Exception {
        try (var connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "UPDATE media_processing_jobs SET lease_expires_at=? WHERE tenant_id=? AND job_id=?")) {
            statement.setLong(1, Instant.now().minusSeconds(5).toEpochMilli());
            statement.setString(2, job.tenantId());
            statement.setString(3, job.jobId());
            assertThat(statement.executeUpdate()).isEqualTo(1);
        }
    }

    private static void seedExpiredOutboxClaim(String runId) throws Exception {
        String eventId = "metrics-outbox-" + runId;
        try (var connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var insert = connection.prepareStatement(
                     "INSERT INTO media_processing_lifecycle_outbox "
                             + "(event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,"
                             + "payload_json,classification,created_at,published_at,attempts,last_error) "
                             + "VALUES (?,?,?,?,?,?,?,?,?,NULL,0,NULL)")) {
            insert.setString(1, eventId);
            insert.setString(2, "tenant-" + runId);
            insert.setString(3, "job");
            insert.setString(4, "job-outbox-" + runId);
            insert.setLong(5, 1L);
            insert.setString(6, "MEDIA_JOB_TEST");
            insert.setString(7, "{}");
            insert.setString(8, "INTERNAL");
            insert.setLong(9, Instant.now().toEpochMilli());
            assertThat(insert.executeUpdate()).isEqualTo(1);
        }
        try (var connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var update = connection.prepareStatement(
                     "UPDATE media_processing_lifecycle_outbox SET claim_owner=?,claim_expires_at=? WHERE event_id=?")) {
            update.setString(1, "worker-after-crash");
            update.setLong(2, Instant.now().minusSeconds(5).toEpochMilli());
            update.setString(3, eventId);
            assertThat(update.executeUpdate()).isEqualTo(1);
        }
    }

    private static void seedUnsupportedLifecycleEvent(String eventId, String runId) throws Exception {
        try (var connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var insert = connection.prepareStatement(
                     "INSERT INTO media_processing_lifecycle_outbox "
                             + "(event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,"
                             + "payload_json,classification,created_at,published_at,attempts,last_error) "
                             + "VALUES (?,?,?,?,?,?,?,?,?,NULL,0,NULL)")) {
            insert.setString(1, eventId);
            insert.setString(2, "tenant-unsupported-" + runId);
            insert.setString(3, "processing-job");
            insert.setString(4, "job-unsupported-" + runId);
            insert.setLong(5, 1L);
            insert.setString(6, "media.job.attempt.dispatch_intended");
            insert.setString(7, "{}");
            insert.setString(8, "INTERNAL");
            insert.setLong(9, Instant.now().toEpochMilli());
            assertThat(insert.executeUpdate()).isEqualTo(1);
        }
    }

    private static void assertAcknowledgedOutboxEvent(MediaLifecycleEvent event) throws Exception {
        try (Connection connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT published_at,event_plane_stored_event_id,event_plane_stream_id,event_plane_offset,"
                             + "attempts,claim_owner,claim_expires_at FROM media_processing_lifecycle_outbox "
                             + "WHERE event_id=?")) {
            query.setString(1, event.eventId());
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getObject("published_at")).isNotNull();
                assertThat(row.getString("event_plane_stored_event_id"))
                        .isEqualTo(MediaLifecyclePublicationReceipt.stableStoredEventId(event.eventId()));
                assertThat(row.getString("event_plane_stream_id")).isEqualTo("media-lifecycle");
                assertThat(row.getString("event_plane_offset")).isEqualTo("19");
                assertThat(row.getInt("attempts")).isEqualTo(1);
                assertThat(row.getString("claim_owner")).isNull();
                assertThat(row.getObject("claim_expires_at")).isNull();
            }
        }
        try (Connection connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT last_offset,last_stream_id,last_event_id,last_stored_event_id "
                             + "FROM media_processing_lifecycle_event_plane_cursor WHERE tenant_id=?")) {
            query.setString(1, event.tenantId());
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getString("last_offset")).isEqualTo("19");
                assertThat(row.getString("last_stream_id")).isEqualTo("media-lifecycle");
                assertThat(row.getString("last_event_id")).isEqualTo(event.eventId());
                assertThat(row.getString("last_stored_event_id"))
                        .isEqualTo(MediaLifecyclePublicationReceipt.stableStoredEventId(event.eventId()));
            }
        }
    }

    private static void assertUnclaimedUnsupportedEvent(String eventId) throws Exception {
        try (Connection connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT published_at,attempts,claim_owner,claim_token FROM media_processing_lifecycle_outbox "
                             + "WHERE event_id=?")) {
            query.setString(1, eventId);
            try (var row = query.executeQuery()) {
                assertThat(row.next()).isTrue();
                assertThat(row.getObject("published_at")).isNull();
                assertThat(row.getInt("attempts")).isZero();
                assertThat(row.getString("claim_owner")).isNull();
                assertThat(row.getLong("claim_token")).isZero();
            }
        }
    }

    private static ProcessingJob job(String jobId, JobStatus status, long version) {
        String runId = UUID.randomUUID().toString().replace("-", "");
        return new ProcessingJob(
                jobId, "request-" + runId, "tenant-" + runId, "principal-a", "artifact-a", JobType.VISION,
                "provider-a", status, Instant.now(), null,
                status == JobStatus.OUTCOME_UNKNOWN ? Instant.now() : null,
                status == JobStatus.OUTCOME_UNKNOWN ? Map.of("providerOutcome", "UNKNOWN") : Map.of(),
                status == JobStatus.OUTCOME_UNKNOWN ? "PROCESSING_OUTCOME_UNKNOWN" : "", version, "",
                REQUEST_FINGERPRINT);
    }

    private static ProcessingJob job(
            String jobId, String requestId, String tenantId, String principalId, Instant createdAt) {
        return new ProcessingJob(jobId, requestId, tenantId, principalId, "artifact-a", JobType.VISION,
                "provider-a", JobStatus.ACCEPTED, createdAt, null, null, Map.of(), "", 1, "",
                REQUEST_FINGERPRINT);
    }
}
