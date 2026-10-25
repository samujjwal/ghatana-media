package com.ghatana.media.provider.aws;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import java.sql.DriverManager;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
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

@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaJobStoreMetricsTest {
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
    void countsAggregateStatusesAndExpiredRunningLeasesWithoutIdentityLabels() throws Exception {
        String jdbcUrl = "jdbc:h2:mem:media_metrics_" + UUID.randomUUID().toString().replace("-", "")
                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
        String bucket = "media-metrics-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client client = S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        Map<String, String> environment = Map.ofEntries(
                Map.entry("MEDIA_RUNTIME_ENVIRONMENT", "test"),
                Map.entry("MEDIA_POSTGRES_JDBC_URL", jdbcUrl),
                Map.entry("MEDIA_POSTGRES_USER", "sa"),
                Map.entry("MEDIA_POSTGRES_DRIVER", "org.h2.Driver"),
                Map.entry("MEDIA_S3_BUCKET", bucket),
                Map.entry("MEDIA_S3_REGION", LOCALSTACK.getRegion()),
                Map.entry("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString()),
                Map.entry("MEDIA_S3_PATH_STYLE", "true"),
                Map.entry("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_METRICS_ACCESS"),
                Map.entry("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_METRICS_SECRET"),
                Map.entry("MEDIA_METRICS_ACCESS", LOCALSTACK.getAccessKey()),
                Map.entry("MEDIA_METRICS_SECRET", LOCALSTACK.getSecretKey()));

        try (AutoCloseable ignored = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             PostgresqlMediaJobStore jobs = new PostgresqlMediaJobStore()) {
            ProcessingJob accepted = job("job-accepted", JobStatus.ACCEPTED, 1);
            jobs.create(accepted);
            assertThat(jobs.countByStatus(JobStatus.ACCEPTED)).isEqualTo(1);

            ProcessingJob running = new ProcessingJob(
                    accepted.jobId(), accepted.requestId(), accepted.tenantId(), accepted.principalId(),
                    accepted.artifactId(), accepted.jobType(), accepted.providerId(), JobStatus.RUNNING,
                    accepted.createdAt(), Instant.now(), null, Map.of(), "", 2);
            jobs.update(accepted, running);
            jobs.claim(running, "worker-a", Instant.now().plusSeconds(30));
            try (var connection = h2(jdbcUrl).getConnection();
                 var statement = connection.prepareStatement(
                         "UPDATE media_processing_jobs SET lease_expires_at=? WHERE tenant_id=? AND job_id=?")) {
                statement.setLong(1, Instant.now().minusSeconds(5).toEpochMilli());
                statement.setString(2, "tenant-a");
                statement.setString(3, accepted.jobId());
                statement.executeUpdate();
            }

            jobs.create(job("job-unknown", JobStatus.OUTCOME_UNKNOWN, 1));
            assertThat(jobs.countByStatus(JobStatus.ACCEPTED)).isZero();
            assertThat(jobs.countByStatus(JobStatus.RUNNING)).isEqualTo(1);
            assertThat(jobs.countByStatus(JobStatus.OUTCOME_UNKNOWN)).isEqualTo(1);
            assertThat(jobs.countOverdueLeases(Instant.now())).isEqualTo(1);
        }
    }

    private static ProcessingJob job(String jobId, JobStatus status, long version) {
        return new ProcessingJob(
                jobId, "request-" + jobId, "tenant-a", "principal-a", "artifact-a", JobType.VISION,
                "provider-a", status, Instant.now(), null,
                status == JobStatus.OUTCOME_UNKNOWN ? Instant.now() : null,
                status == JobStatus.OUTCOME_UNKNOWN ? Map.of("providerOutcome", "UNKNOWN") : Map.of(),
                status == JobStatus.OUTCOME_UNKNOWN ? "PROCESSING_OUTCOME_UNKNOWN" : "", version);
    }
}
