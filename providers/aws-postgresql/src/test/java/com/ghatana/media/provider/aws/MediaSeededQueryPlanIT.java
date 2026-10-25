package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.RecoveryCursor;
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

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * A10 seeded-scale evidence: a 100k-row dataset proves the job read surface stays bounded,
 * strictly tenant-scoped, index-served and cursor-stable. Assertions cover correctness and
 * plan shape rather than wall-clock thresholds so the evidence is reproducible on any host.
 */
@Testcontainers(disabledWithoutDocker = true)
class MediaSeededQueryPlanIT {
    private static org.h2.jdbcx.JdbcDataSource h2(String url) {
        var ds = new org.h2.jdbcx.JdbcDataSource();
        ds.setURL(url);
        ds.setUser("sa");
        return ds;
    }


    private static final int SEED_TENANT_A = 90_000;
    private static final int SEED_TENANT_B = 9_000;
    private static final int SEED_TENANT_C = 1_000;

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static String jdbcUrl() {
        return "jdbc:h2:mem:media_seeded_" + UUID.randomUUID().toString().replace("-", "")
                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
    }

    private static Map<String, String> environment(String jdbcUrl, String bucket) {
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
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_SEED_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_SEED_SECRET");
        environment.put("MEDIA_SEED_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_SEED_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    @Test
    void seededTenantScansStayBoundedIndexServedAndCursorStable() throws Exception {
        String jdbcUrl = jdbcUrl();
        String bucket = "media-seeded-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client client = S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(
                environment(jdbcUrl, bucket));
             PostgresqlMediaJobStore jobs = new PostgresqlMediaJobStore();
             Connection seed = h2(jdbcUrl).getConnection()) {

            seedJobs(seed, "tenant-a", SEED_TENANT_A, 1_000);
            seedJobs(seed, "tenant-b", SEED_TENANT_B, 2_000);
            seedJobs(seed, "tenant-c", SEED_TENANT_C, 3_000);
            seedArtifacts(seed, "tenant-a", 20_000, 5_000);
            seedArtifacts(seed, "tenant-b", 20_000, 6_000);

            // 1. Bounded read: a 100k-job tenant returns at most the requested page.
            var page = jobs.list("tenant-a", 50);
            assertThat(page).hasSize(50);
            // 2. Tenant scope: no row from another tenant leaks into the read.
            assertThat(page).allMatch(job -> job.tenantId().equals("tenant-a"));
            // 3. Stable snapshot sort: created_at DESC with job_id as deterministic tiebreak.
            for (int i = 1; i < page.size(); i++) {
                var previous = page.get(i - 1);
                var current = page.get(i);
                assertThat(previous.createdAt().compareTo(current.createdAt()) >= 0).isTrue();
                if (previous.createdAt().equals(current.createdAt())) {
                    assertThat(previous.jobId()).isLessThan(current.jobId());
                }
            }

            // 4. Index plan: the bounded list query resolves through the tenant/created index,
            //    not an unbounded table scan.
            assertThat(explain(seed,
                    "SELECT tenant_id,job_id FROM media_processing_jobs "
                            + "WHERE tenant_id='tenant-b' ORDER BY created_at DESC,job_id LIMIT 50"))
                    .as("job list plan")
                    .doesNotContain("tableScan");
            assertThat(explain(seed,
                    "SELECT artifact_id FROM media_artifacts "
                            + "WHERE tenant_id='tenant-b' ORDER BY created_at DESC LIMIT 50"))
                    .as("artifact list plan")
                    .doesNotContain("tableScan");

            // 5. Cursor stability: paging the recovery scan yields a disjoint complete union —
            //    no row is skipped or duplicated across pages.
            Set<String> seen = new HashSet<>();
            RecoveryCursor cursor = null;
            int pages = 0;
            while (true) {
                var batch = jobs.recoverableAfter(500, cursor);
                if (batch.isEmpty()) break;
                for (ProcessingJob job : batch) {
                    assertThat(seen.add(job.jobId())).as("duplicate across pages %s", job.jobId()).isTrue();
                }
                cursor = RecoveryCursor.after(batch.getLast());
                pages++;
                if (pages > 1_000) throw new AssertionError("cursor pagination did not terminate");
            }
            assertThat(seen).hasSize(SEED_TENANT_A + SEED_TENANT_B + SEED_TENANT_C);
        }
    }

    private static void seedJobs(Connection connection, String tenant, int count, int createdBase)
            throws Exception {
        connection.setAutoCommit(false);
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO media_processing_jobs (tenant_id, job_id, request_id, artifact_id,"
                        + " job_type, provider_id, status, created_at, result_json, failure_code,"
                        + " version, principal_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")) {
            for (int i = 0; i < count; i++) {
                insert.setString(1, tenant);
                insert.setString(2, "job-" + tenant + "-" + i);
                insert.setString(3, "request-" + tenant + "-" + i);
                insert.setString(4, "artifact-" + tenant + "-" + (i % 500));
                insert.setString(5, JobType.VISION.name());
                insert.setString(6, "provider-a");
                insert.setString(7, JobStatus.ACCEPTED.name());
                // Many rows share created_at to exercise the job_id tiebreak ordering.
                insert.setLong(8, 1_700_000_000_000L + createdBase + (i % 10));
                insert.setString(9, "{}");
                insert.setString(10, "");
                insert.setLong(11, 1);
                insert.setString(12, "principal-a");
                insert.addBatch();
                if (i % 10_000 == 9_999) insert.executeBatch();
            }
            insert.executeBatch();
            connection.commit();
        }
    }

    private static void seedArtifacts(Connection connection, String tenant, int count, int createdBase)
            throws Exception {
        connection.setAutoCommit(false);
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO media_artifacts (tenant_id, artifact_id, file_name, content_type,"
                        + " size_bytes, sha256, object_reference, classification, created_at,"
                        + " expires_at, metadata_json, principal_id)"
                        + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")) {
            for (int i = 0; i < count; i++) {
                insert.setString(1, tenant);
                insert.setString(2, "artifact-" + tenant + "-" + i);
                insert.setString(3, "clip-" + i + ".wav");
                insert.setString(4, "audio/wav");
                insert.setLong(5, 128L + i);
                insert.setString(6, String.format("%064x", i + 1));
                insert.setString(7, "s3://seeded/" + tenant + "/" + i);
                insert.setString(8, "RESTRICTED");
                insert.setLong(9, 1_700_000_000_000L + createdBase + i);
                insert.setLong(10, 1_800_000_000_000L);
                insert.setString(11, "{}");
                insert.setString(12, "principal-a");
                insert.addBatch();
                if (i % 10_000 == 9_999) insert.executeBatch();
            }
            insert.executeBatch();
            connection.commit();
        }
    }

    private static String explain(Connection connection, String sql) throws Exception {
        StringBuilder plan = new StringBuilder();
        try (var statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("EXPLAIN " + sql)) {
            while (rows.next()) plan.append(rows.getString(1)).append('\n');
        }
        return plan.toString();
    }
}
