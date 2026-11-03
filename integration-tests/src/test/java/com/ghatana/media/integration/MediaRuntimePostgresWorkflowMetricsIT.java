package com.ghatana.media.integration;

import com.ghatana.media.launcher.MediaRuntime;
import com.ghatana.media.provider.aws.TestAwsStateInstall;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaLifecycleEvent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.HexFormat;
import java.util.Base64;
import java.net.http.HttpResponse;
import java.net.URI;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
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
    private static final String SUBJECT_JWT_SECRET = "0123456789abcdef0123456789abcdef";
    private static final String SUBJECT_TENANT = "tenant-process-recovery";
    private static final ObjectMapper JSON = new ObjectMapper();
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    /** Entry point used by the Gradle JavaExec task to keep a resolved classpath for child JVMs. */
    public static void main(String[] args) throws Exception {
        String childClasspath = System.getProperty("media.child.classpath", "");
        boolean postgresStarted = false;
        boolean localstackStarted = false;
        try {
            POSTGRES.start();
            postgresStarted = true;
            LOCALSTACK.start();
            localstackStarted = true;
            MediaRuntimePostgresWorkflowMetricsIT fixture = new MediaRuntimePostgresWorkflowMetricsIT();
            fixture.separateLauncherProcessesScrapeDurableMetrics();
            System.setProperty("media.child.classpath", childClasspath);
            fixture.hardProcessLossRetainsSubjectArtifactAndUnknownJobWithoutReplayingEffects();
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

    @Test
    void hardProcessLossRetainsSubjectArtifactAndUnknownJobWithoutReplayingEffects() throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-hard-recovery-" + runId;
        byte[] payload = new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 4, 5, 6};
        String sha = sha256(payload);
        try (S3Client client = s3()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        Map<String, String> environment = environment(bucket);
        environment.put("MEDIA_HTTP_PORT", Integer.toString(port));
        environment.put("MEDIA_JWT_HMAC_SECRET_REFERENCE", "secret:env:MEDIA_PROCESS_JWT_SECRET");
        environment.put("MEDIA_JWT_ISSUER", "https://issuer.example");
        environment.put("MEDIA_JWT_AUDIENCE", "ghatana-runtime");
        environment.put("MEDIA_PROCESS_JWT_SECRET", SUBJECT_JWT_SECRET);
        String classpath = System.getProperty("media.child.classpath", "");
        assertThat(classpath).as("Gradle-resolved child application classpath").isNotBlank();
        String ownerToken = subjectJwt("subject-owner");
        String otherToken = subjectJwt("subject-other");
        String foreignTenantToken = subjectJwt("subject-foreign-tenant", "tenant-foreign-recovery");
        String jobId = "unknown-recovery-" + runId;
        String requestId = "request-unknown-recovery-" + runId;

        LauncherChild first = startLauncherProcess(classpath, environment);
        String artifactId;
        String objectReference;
        try {
            try { awaitReady(first.process(), port); }
            catch (Throwable failure) { throw new AssertionError("launcher startup log: " + Files.readString(first.log()), failure); }
            String uploadBody = """
                    {"tenantId":"%s","principalId":"subject-owner","fileName":"recovery.png",
                     "contentType":"image/png","expectedSizeBytes":%d,"expectedSha256":"%s",
                     "classification":"INTERNAL","retention":"P30D","metadata":{}}
                    """.formatted(SUBJECT_TENANT, payload.length, sha);
            JsonNode begun = JSON.readTree(http("POST", port, "/api/v1/artifacts/uploads", ownerToken,
                    "owner-recovery-upload", uploadBody, "application/json", null).body());
            String uploadId = begun.path("uploadId").asText();
            assertThat(uploadId).isNotBlank();
            assertThat(http("PUT", port, "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0", ownerToken,
                    null, null, "application/octet-stream", payload).statusCode()).isEqualTo(200);
            HttpResponse<String> completed = http("POST", port,
                    "/api/v1/artifacts/uploads/" + uploadId + "/complete", ownerToken,
                    null, "", "application/json", null);
            assertThat(completed.statusCode()).as(completed.body()).isEqualTo(201);
            JsonNode artifact = JSON.readTree(completed.body());
            artifactId = artifact.path("artifactId").asText();
            objectReference = artifact.path("objectReference").asText();
            assertThat(artifactId).isNotBlank();
        } finally {
            killLauncherProcess(first);
        }

        // The fixture records an accepted job and a synthetic dispatch-unknown attempt. No provider is invoked;
        // UNKNOWN remains non-replayable and is used only to exercise durable recovery/readback.
        AutoCloseable installed = TestAwsStateInstall.install(environment);
        try (var store = new com.ghatana.media.provider.aws.PostgresqlMediaJobStore()) {
            ProcessingJob accepted = new ProcessingJob(jobId, requestId, SUBJECT_TENANT, "subject-owner",
                    artifactId, JobType.VISION, "provider-local", JobStatus.ACCEPTED,
                    Instant.now(), null, null, Map.of(), "", 1L, "", sha256(("request:" + requestId).getBytes(StandardCharsets.UTF_8)));
            store.create(accepted, "");
            var lease = store.claim(accepted, "fixture-worker", Instant.now().plusSeconds(120));
            ProcessingJob running = new ProcessingJob(jobId, requestId, SUBJECT_TENANT, "subject-owner",
                    artifactId, JobType.VISION, "provider-local", JobStatus.RUNNING, accepted.createdAt(),
                    Instant.now(), null, Map.of(), "", accepted.version() + 1, "", accepted.requestFingerprint());
            var started = store.startAttempt(accepted, running, lease, 1, accepted.requestFingerprint());
            ProcessingJob unknown = new ProcessingJob(jobId, requestId, SUBJECT_TENANT, "subject-owner", artifactId,
                    JobType.VISION, "provider-local", JobStatus.OUTCOME_UNKNOWN, accepted.createdAt(),
                    started.running().startedAt(), Instant.now(), Map.of(), "PROCESSING_OUTCOME_UNKNOWN",
                    started.running().version() + 1, "", accepted.requestFingerprint());
            MediaLifecycleEvent outcomeUnknown = new MediaLifecycleEvent(
                    "fixture-unknown-" + jobId, "MEDIA_JOB_OUTCOME_UNKNOWN", SUBJECT_TENANT, "subject-owner",
                    requestId, requestId, "job", jobId, unknown.version(), "INTERNAL", unknown.completedAt(), Map.of());
            store.markOutcomeUnknown(started.running(), started.attempt(), unknown,
                    Map.of("fixture", "synthetic-dispatch-unknown"), outcomeUnknown);
        } finally {
            installed.close();
        }
        assertSingleRecoveryRows(jobId, requestId, artifactId, sha);

        try (S3Client client = s3()) {
            byte[] persisted = client.getObjectAsBytes(software.amazon.awssdk.services.s3.model.GetObjectRequest.builder()
                    .bucket(bucket).key(URI.create(objectReference).getPath().substring(1)).build()).asByteArray();
            assertThat(persisted).containsExactly(payload);
            assertThat(sha256(persisted)).isEqualTo(sha);
        }
        assertSingleRecoveryRows(jobId, requestId, artifactId, sha);

        LauncherChild recovered = startLauncherProcess(classpath, environment);
        try {
            awaitReady(recovered.process(), port);
            assertSubjectRecoveryReadback(port, artifactId, jobId, sha, objectReference, ownerToken, otherToken,
                    foreignTenantToken, requestId);
        } finally {
            killLauncherProcess(recovered);
        }
        LauncherChild recoveredAgain = startLauncherProcess(classpath, environment);
        try {
            awaitReady(recoveredAgain.process(), port);
            assertSubjectRecoveryReadback(port, artifactId, jobId, sha, objectReference, ownerToken, otherToken,
                    foreignTenantToken, requestId);
        } finally {
            stopLauncherProcess(recoveredAgain);
        }
    }

    private static void assertSubjectRecoveryReadback(int port, String artifactId, String jobId, String sha,
            String objectReference, String ownerToken, String otherToken, String foreignTenantToken,
            String requestId) throws Exception {
        HttpResponse<String> ownerArtifact = http("GET", port, "/api/v1/artifacts/" + artifactId,
                ownerToken, null, "", "application/json", null);
        HttpResponse<String> ownerJob = http("GET", port, "/api/v1/jobs/" + jobId,
                ownerToken, null, "", "application/json", null);
        HttpResponse<String> otherArtifact = http("GET", port, "/api/v1/artifacts/" + artifactId,
                otherToken, null, "", "application/json", null);
        HttpResponse<String> absentArtifact = http("GET", port, "/api/v1/artifacts/absent-recovery-artifact",
                otherToken, null, "", "application/json", null);
        HttpResponse<String> otherJob = http("GET", port, "/api/v1/jobs/" + jobId,
                otherToken, null, "", "application/json", null);
        HttpResponse<String> absentJob = http("GET", port, "/api/v1/jobs/absent-recovery-job",
                otherToken, null, "", "application/json", null);
        HttpResponse<String> foreignTenantArtifact = http("tenant-foreign-recovery", "GET", port,
                "/api/v1/artifacts/" + artifactId, foreignTenantToken, null, "", "application/json", null);
        HttpResponse<String> absentForeignTenantArtifact = http("tenant-foreign-recovery", "GET", port,
                "/api/v1/artifacts/absent-recovery-artifact", foreignTenantToken, null, "", "application/json", null);
        HttpResponse<String> foreignTenantJob = http("tenant-foreign-recovery", "GET", port,
                "/api/v1/jobs/" + jobId, foreignTenantToken, null, "", "application/json", null);
        HttpResponse<String> absentForeignTenantJob = http("tenant-foreign-recovery", "GET", port,
                "/api/v1/jobs/absent-recovery-job", foreignTenantToken, null, "", "application/json", null);
        assertThat(ownerArtifact.statusCode()).as(ownerArtifact.body()).isEqualTo(200);
        assertThat(ownerJob.statusCode()).as(ownerJob.body()).isEqualTo(200);
        JsonNode recoveredArtifact = JSON.readTree(ownerArtifact.body());
        assertThat(recoveredArtifact.path("artifactId").asText()).isEqualTo(artifactId);
        assertThat(recoveredArtifact.path("sha256").asText()).isEqualTo(sha);
        assertThat(recoveredArtifact.path("objectReference").asText()).isEqualTo(objectReference);
        assertThat(JSON.readTree(ownerJob.body()).path("status").asText()).isEqualTo("OUTCOME_UNKNOWN");
        assertEquivalentNotFound(otherArtifact, absentArtifact, artifactId);
        assertEquivalentNotFound(otherJob, absentJob, jobId);
        assertEquivalentNotFound(foreignTenantArtifact, absentForeignTenantArtifact, artifactId);
        assertEquivalentNotFound(foreignTenantJob, absentForeignTenantJob, jobId);
        assertSingleRecoveryRows(jobId, requestId, artifactId, sha);
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

    private static void killLauncherProcess(LauncherChild child) throws Exception {
        try {
            Process process = child.process();
            assertThat(process.isAlive()).as("launcher process alive at forced-kill boundary").isTrue();
            process.descendants().forEach(ProcessHandle::destroyForcibly);
            process.destroyForcibly();
            assertThat(process.waitFor(15, java.util.concurrent.TimeUnit.SECONDS))
                    .as("launcher process terminated forcibly").isTrue();
        } finally {
            Files.deleteIfExists(child.log());
        }
    }

    private static HttpResponse<String> http(String method, int port, String path, String token,
            String idempotencyKey, String body, String contentType, byte[] bytes) throws Exception {
        return http(SUBJECT_TENANT, method, port, path, token, idempotencyKey, body, contentType, bytes);
    }

    private static HttpResponse<String> http(String tenantId, String method, int port, String path, String token,
            String idempotencyKey, String body, String contentType, byte[] bytes) throws Exception {
        var builder = java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:" + port + path))
                .header("X-Tenant-Id", tenantId).header("Authorization", "Bearer " + token)
                .header("Content-Type", contentType);
        if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey);
        if ("GET".equals(method)) builder.GET();
        else if (bytes != null) builder.PUT(java.net.http.HttpRequest.BodyPublishers.ofByteArray(bytes));
        else if ("POST".equals(method)) builder.POST(java.net.http.HttpRequest.BodyPublishers.ofString(body));
        else throw new IllegalArgumentException("Unsupported HTTP method: " + method);
        return java.net.http.HttpClient.newHttpClient().send(builder.build(),
                java.net.http.HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static void assertEquivalentNotFound(HttpResponse<String> denied, HttpResponse<String> absent,
            String protectedId) throws Exception {
        assertThat(denied.statusCode()).isEqualTo(404);
        assertThat(absent.statusCode()).isEqualTo(denied.statusCode());
        JsonNode deniedError = JSON.readTree(denied.body()).path("error");
        JsonNode absentError = JSON.readTree(absent.body()).path("error");
        assertThat(deniedError).isEqualTo(absentError);
        assertThat(denied.body()).doesNotContain(protectedId);
    }

    private static void assertSingleRecoveryRows(String jobId, String requestId, String artifactId, String sha)
            throws Exception {
        try (var connection = DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())) {
            assertThat(count(connection, "SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=? AND job_id=?",
                    SUBJECT_TENANT, jobId)).isEqualTo(1);
            assertThat(count(connection, "SELECT COUNT(*) FROM media_processing_jobs WHERE tenant_id=? AND request_id=?",
                    SUBJECT_TENANT, requestId)).isEqualTo(1);
            assertThat(count(connection, "SELECT COUNT(*) FROM media_lifecycle_outbox WHERE tenant_id=? "
                    + "AND correlation_id=? AND event_type='MEDIA_JOB_ACCEPTED'", SUBJECT_TENANT, requestId))
                    .as("single accepted lifecycle outbox event").isEqualTo(1);
            assertThat(count(connection, "SELECT COUNT(*) FROM media_processing_lifecycle_outbox WHERE tenant_id=? "
                    + "AND aggregate_id=? AND event_type='MEDIA_JOB_OUTCOME_UNKNOWN'", SUBJECT_TENANT, jobId))
                    .as("single terminal UNKNOWN lifecycle event").isEqualTo(1);
            assertThat(count(connection, "SELECT COUNT(*) FROM media_artifacts WHERE tenant_id=? AND artifact_id=? "
                    + "AND principal_id=? AND sha256=?", SUBJECT_TENANT, artifactId, "subject-owner", sha)).isEqualTo(1);
            assertThat(count(connection, "SELECT COUNT(*) FROM media_processing_attempts WHERE tenant_id=? "
                    + "AND job_id=? AND state='OUTCOME_UNKNOWN'", SUBJECT_TENANT, jobId))
                    .as("single terminal unknown attempt").isEqualTo(1);
            assertThat(count(connection, "SELECT COUNT(*) FROM media_processing_attempts WHERE tenant_id=? "
                    + "AND job_id=?", SUBJECT_TENANT, jobId))
                    .as("no duplicate attempt in any state").isEqualTo(1);
        }
    }

    private static long count(java.sql.Connection connection, String sql, String... values) throws Exception {
        try (var statement = connection.prepareStatement(sql)) {
            for (int i = 0; i < values.length; i++) statement.setString(i + 1, values[i]);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getLong(1);
            }
        }
    }

    private static String subjectJwt(String subject) throws Exception {
        return subjectJwt(subject, SUBJECT_TENANT);
    }

    private static String subjectJwt(String subject, String tenantId) throws Exception {
        String header = base64Url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissions = "\"media:artifact:create\",\"media:artifact:write\",\"media:artifact:read\","
                + "\"media:job:create\",\"media:job:read\"";
        String payload = base64Url("{\"sub\":\"" + subject + "\",\"tenant_id\":\"" + tenantId
                + "\",\"iss\":\"https://issuer.example\",\"aud\":\"ghatana-runtime\",\"exp\":"
                + Instant.now().plusSeconds(600).getEpochSecond() + ",\"permissions\":[" + permissions + "]}");
        String signed = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SUBJECT_JWT_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signed + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signed.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String base64Url(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
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
