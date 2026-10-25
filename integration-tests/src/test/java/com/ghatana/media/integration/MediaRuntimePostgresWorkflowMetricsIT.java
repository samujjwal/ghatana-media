package com.ghatana.media.integration;

import com.ghatana.media.launcher.MediaRuntime;
import com.ghatana.media.provider.aws.TestAwsStateInstall;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Tag;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** Runtime scrape proof for durable workflow metrics after PostgreSQL-backed restart. */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
public class MediaRuntimePostgresWorkflowMetricsIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    /** Entry point used by the Gradle JavaExec task to keep a resolved classpath for child JVMs. */
    public static void main(String[] args) throws Exception {
        boolean postgresStarted = false;
        boolean localstackStarted = false;
        try {
            POSTGRES.start();
            postgresStarted = true;
            LOCALSTACK.start();
            localstackStarted = true;
            new MediaRuntimePostgresWorkflowMetricsIT().separateLauncherProcessesScrapeDurableMetrics();
        } finally {
            try {
                if (localstackStarted) LOCALSTACK.stop();
            } finally {
                if (postgresStarted) POSTGRES.stop();
            }
        }
    }

    @Test
    void restartedRuntimeScrapesDurableBacklogAndExpiredLeaseMetrics() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-wf-metrics-" + runId;
        try (S3Client s3 = s3()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        Map<String, String> environment = environment(bucket);
        AutoCloseable installed = TestAwsStateInstall.install(environment);
        try {
            // Compose once so the ServiceLoader stores initialize the isolated schema.
            MediaRuntime firstRuntime = MediaRuntime.compose(environment);
            // Keep one shared provider-state reference alive across runtime recreation.
            try (var seed = new com.ghatana.media.provider.aws.PostgresqlMediaJobStore()) {
                firstRuntime.close();
                seed.create(job("unknown-" + runId, "tenant-u-" + runId, JobStatus.OUTCOME_UNKNOWN));
                ProcessingJob running = job("running-" + runId, "tenant-r-" + runId, JobStatus.ACCEPTED);
                seed.create(running);
                ProcessingJob leased = seed.startAttempt(
                        running, "worker-crashed", Instant.now().plusSeconds(30), "provider-local").job();
                expireJobLease(leased);
                seedExpiredOutboxClaim(runId);
                try (MediaRuntime restarted = MediaRuntime.compose(environment)) {
                    // Insert after composition so the runtime cannot dispatch this observation fixture
                    // before the immediate aggregate scrape.
                    seed.create(job("scrape-accepted-" + runId, "tenant-s-" + runId, JobStatus.ACCEPTED));
                    ProcessingJob liveLease = job(
                            "live-lease-" + runId, "tenant-l-" + runId, JobStatus.ACCEPTED);
                    seed.create(liveLease);
                    ProcessingJob liveRunning = seed.startAttempt(
                            liveLease, "worker-live-lease", Instant.now().plusSeconds(5), "provider-local").job();
                    expireJobLease(liveRunning);

                    String scrape = restarted.prometheusMetrics();
                    assertThat(metric(scrape, "media_workflow_queue_depth")).as(scrape).isEqualTo(1.0);
                    // Restart reconciliation converts the expired RUNNING job to OUTCOME_UNKNOWN,
                    // so it leaves the overdue-lease gauge and joins the pre-seeded unknown backlog.
                    assertThat(metric(scrape, "media_workflow_unknown_backlog")).isEqualTo(2.0);
                    // The second expired lease is created after startup reconciliation; the runtime's
                    // recovery poll has a 30-second initial delay, and this immediate scrape observes it.
                    assertThat(metric(scrape, "media_workflow_lease_overdue")).isEqualTo(1.0);
                    assertThat(jobStatus(liveRunning)).isEqualTo("RUNNING");
                    assertThat(metric(scrape, "media_workflow_outbox_lease_overdue")).isEqualTo(1.0);
                    assertThat(metric(scrape, "media_workflow_aggregate_store_queries_supported")).isEqualTo(1.0);
                    assertThat(metric(scrape, "media_workflow_outbox_aggregate_store_queries_supported")).isEqualTo(1.0);
                }
            }
        } finally {
            installed.close();
        }

        String rules = Files.readString(Path.of("..", "infra", "monitoring", "alerts", "audio-video.yml"));
        assertThat(rules).contains("MediaJobLeaseStuck", "media_workflow_lease_overdue{contract_version=\"v1\"}")
                .contains("(media_workflow_aggregate_store_queries_supported{contract_version=\"v1\"} == 1)");
        assertThat(rules).contains("MediaOutboxClaimLeaseStuck",
                        "media_workflow_outbox_lease_overdue{contract_version=\"v1\"}")
                .contains("(media_workflow_outbox_aggregate_store_queries_supported{contract_version=\"v1\"} == 1)");
        assertThat(rules).contains("MediaUnknownFinalityBacklog",
                        "media_workflow_unknown_backlog{contract_version=\"v1\"}")
                .contains(") > 25");
        assertThat(rules).contains("MediaQueueCapacityHigh",
                        "media_workflow_queue_depth{contract_version=\"v1\"}").contains(") > 500");
    }

    private void separateLauncherProcessesScrapeDurableMetrics() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-wf-process-" + runId;
        try (S3Client s3 = s3()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        int port;
        try (var socket = new java.net.ServerSocket(0)) {
            port = socket.getLocalPort();
        }
        Map<String, String> environment = environment(bucket);
        environment.put("MEDIA_HTTP_PORT", Integer.toString(port));
        String classpath = System.getProperty("media.child.classpath", "");
        assertThat(classpath).as("Gradle-resolved child application classpath").isNotBlank();

        long firstPid;
        LauncherChild first = startLauncherProcess(classpath, environment);
        try {
            awaitReady(first.process(), port);
            firstPid = first.process().pid();
        } finally {
            stopLauncherProcess(first);
        }

        AutoCloseable installed = TestAwsStateInstall.install(environment);
        try {
            try (var seed = new com.ghatana.media.provider.aws.PostgresqlMediaJobStore()) {
                seed.create(job("unknown-" + runId, "tenant-u-" + runId, JobStatus.OUTCOME_UNKNOWN));
                ProcessingJob running = job("running-" + runId, "tenant-r-" + runId, JobStatus.ACCEPTED);
                seed.create(running);
                ProcessingJob leased = seed.startAttempt(
                        running, "worker-crashed", Instant.now().plusSeconds(30), "provider-local").job();
                expireJobLease(leased);
                seedExpiredOutboxClaim(runId);

                LauncherChild restarted = startLauncherProcess(classpath, environment);
                try {
                    awaitReady(restarted.process(), port);
                    long restartedPid = restarted.process().pid();
                    assertThat(restartedPid).isNotEqualTo(firstPid);

                    // Seed after startup so the queue row and second expired lease are not
                    // consumed by startup reconciliation before the metrics scrape.
                    seed.create(job("scrape-accepted-" + runId, "tenant-s-" + runId, JobStatus.ACCEPTED));
                    ProcessingJob liveLease = job(
                            "live-lease-" + runId, "tenant-l-" + runId, JobStatus.ACCEPTED);
                    seed.create(liveLease);
                    ProcessingJob liveRunning = seed.startAttempt(
                            liveLease, "worker-live-lease", Instant.now().plusSeconds(5), "provider-local").job();
                    expireJobLease(liveRunning);

                    String scrape = httpGet("http://127.0.0.1:" + port + "/metrics");
                    double queue = metric(scrape, "media_workflow_queue_depth");
                    double unknown = metric(scrape, "media_workflow_unknown_backlog");
                    double leases = metric(scrape, "media_workflow_lease_overdue");
                    double outbox = metric(scrape, "media_workflow_outbox_lease_overdue");
                    double storeSupported = metric(scrape, "media_workflow_aggregate_store_queries_supported");
                    double outboxSupported = metric(scrape, "media_workflow_outbox_aggregate_store_queries_supported");
                    assertThat(queue).as(scrape).isEqualTo(1.0);
                    assertThat(unknown).isEqualTo(2.0);
                    assertThat(leases).isEqualTo(1.0);
                    assertThat(outbox).isEqualTo(1.0);
                    assertThat(storeSupported).isEqualTo(1.0);
                    assertThat(outboxSupported).isEqualTo(1.0);
                    assertThat(jobStatus(liveRunning)).isEqualTo("RUNNING");
                    assertThat(scrape).doesNotContain(runId, "tenant-", "job_id", "request_id");
                    System.out.printf("OS process restart verified: first_pid=%d restarted_pid=%d "
                                    + "queue=%.0f unknown_backlog=%.0f overdue_job_lease=%.0f "
                                    + "overdue_outbox_claim=%.0f store_queries_supported=%.0f "
                                    + "outbox_queries_supported=%.0f%n",
                            firstPid, restartedPid, queue, unknown, leases, outbox,
                            storeSupported, outboxSupported);
                } finally {
                    stopLauncherProcess(restarted);
                }
            }
        } finally {
            installed.close();
        }
    }

    private static LauncherChild startLauncherProcess(String classpath, Map<String, String> environment)
            throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        ProcessBuilder builder = new ProcessBuilder(java, "-cp", classpath,
                "com.ghatana.media.launcher.MediaLauncher");
        builder.environment().putAll(environment);
        builder.redirectErrorStream(true);
        Path log = Files.createTempFile("media-runtime-process-", ".log");
        try {
            builder.redirectOutput(log.toFile());
            return new LauncherChild(builder.start(), log);
        } catch (Exception failure) {
            Files.deleteIfExists(log);
            throw failure;
        }
    }

    private static void awaitReady(Process process, int port) throws Exception {
        long deadline = System.nanoTime() + java.time.Duration.ofMinutes(2).toNanos();
        java.net.URI uri = java.net.URI.create("http://127.0.0.1:" + port + "/health/ready");
        java.net.http.HttpClient client = java.net.http.HttpClient.newBuilder()
                .connectTimeout(java.time.Duration.ofSeconds(2))
                .build();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) {
                throw new AssertionError("MediaLauncher child exited before readiness (exit="
                        + process.exitValue() + ")");
            }
            try {
                var response = client.send(java.net.http.HttpRequest.newBuilder(uri)
                                .timeout(java.time.Duration.ofSeconds(3)).GET().build(),
                        java.net.http.HttpResponse.BodyHandlers.discarding());
                if (response.statusCode() == 200) return;
            } catch (java.io.IOException ignored) {
                // Startup is still binding its local listener.
            }
            Thread.sleep(250);
        }
        throw new AssertionError("MediaLauncher child did not become ready within two minutes");
    }

    private static String httpGet(String url) throws Exception {
        var client = java.net.http.HttpClient.newBuilder()
                .connectTimeout(java.time.Duration.ofSeconds(2))
                .build();
        var request = java.net.http.HttpRequest.newBuilder(java.net.URI.create(url))
                .timeout(java.time.Duration.ofSeconds(5))
                .header("Accept", "text/plain; version=0.0.4")
                .GET()
                .build();
        var response = client.send(request,
                java.net.http.HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(200);
        return response.body();
    }

    private static void stopLauncherProcess(LauncherChild child) throws Exception {
        try {
            Process process = child.process();
            if (!process.isAlive()) return;
            process.destroy();
            if (!process.waitFor(20, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly();
                assertThat(process.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            }
        } finally {
            Files.deleteIfExists(child.log());
        }
    }

    private record LauncherChild(Process process, Path log) {}

    private static double metric(String scrape, String name) {
        return scrape.lines().filter(line -> line.startsWith(name + "{") || line.startsWith(name + " "))
                .map(line -> line.substring(line.lastIndexOf(' ') + 1))
                .mapToDouble(Double::parseDouble).findFirst()
                .orElseThrow(() -> new AssertionError("Missing metric " + name + " in scrape:\n" + scrape));
    }

    private static Map<String, String> environment(String bucket) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENABLED", "true");
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        env.put("MEDIA_PROFILE", "local");
        env.put("MEDIA_LOCAL_PROVIDER_ENABLED", "true");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_WF_DB_PASSWORD");
        env.put("MEDIA_WF_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_WF_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_WF_SECRET");
        env.put("MEDIA_WF_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_WF_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }

    private static S3Client s3() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    private static ProcessingJob job(String id, String tenant, JobStatus status) {
        return new ProcessingJob(id, "request-" + id, tenant, "principal", "artifact", JobType.VISION,
                "provider-local", status, Instant.now(), null,
                status == JobStatus.OUTCOME_UNKNOWN ? Instant.now() : null,
                status == JobStatus.OUTCOME_UNKNOWN ? Map.of("providerOutcome", "UNKNOWN") : Map.of(),
                status == JobStatus.OUTCOME_UNKNOWN ? "PROCESSING_OUTCOME_UNKNOWN" : "", 1L);
    }

    private static void expireJobLease(ProcessingJob job) throws Exception {
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

    private static String jobStatus(ProcessingJob job) throws Exception {
        try (var connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var query = connection.prepareStatement(
                     "SELECT status FROM media_processing_jobs WHERE tenant_id=? AND job_id=?")) {
            query.setString(1, job.tenantId());
            query.setString(2, job.jobId());
            try (var result = query.executeQuery()) {
                assertThat(result.next()).isTrue();
                return result.getString(1);
            }
        }
    }

    private static void seedExpiredOutboxClaim(String runId) throws Exception {
        try (var connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var insert = connection.prepareStatement("INSERT INTO media_processing_lifecycle_outbox "
                     + "(event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,payload_json,"
                     + "classification,created_at,published_at,attempts,last_error) VALUES (?,?,?,?,?,?,?,?,?,NULL,0,NULL)")) {
            insert.setString(1, "wf-metrics-" + runId);
            insert.setString(2, "tenant-outbox-" + runId);
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
             var update = connection.prepareStatement("UPDATE media_processing_lifecycle_outbox "
                     + "SET claim_owner=?,claim_expires_at=? WHERE event_id=?")) {
            update.setString(1, "worker-crashed");
            update.setLong(2, Instant.now().minusSeconds(5).toEpochMilli());
            update.setString(3, "wf-metrics-" + runId);
            assertThat(update.executeUpdate()).isEqualTo(1);
        }
    }
}
