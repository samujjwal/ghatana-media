package com.ghatana.media.provider.aws;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import java.sql.DriverManager;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
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
            var running = initial.startAttempt(
                    runningAccepted, "worker-a", Instant.now().plusSeconds(30), "provider-a").job();
            expireLease(running);

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
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
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

    private static ProcessingJob job(String jobId, JobStatus status, long version) {
        String runId = UUID.randomUUID().toString().replace("-", "");
        return new ProcessingJob(
                jobId, "request-" + runId, "tenant-" + runId, "principal-a", "artifact-a", JobType.VISION,
                "provider-a", status, Instant.now(), null,
                status == JobStatus.OUTCOME_UNKNOWN ? Instant.now() : null,
                status == JobStatus.OUTCOME_UNKNOWN ? Map.of("providerOutcome", "UNKNOWN") : Map.of(),
                status == JobStatus.OUTCOME_UNKNOWN ? "PROCESSING_OUTCOME_UNKNOWN" : "", version);
    }
}
