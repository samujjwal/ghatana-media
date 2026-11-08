package com.ghatana.media.integration;

import com.ghatana.media.launcher.MediaHttpHandler;
import com.ghatana.media.launcher.MediaRuntime;
import com.ghatana.media.launcher.MediaSecurityFilter;
import com.ghatana.media.provider.aws.TestAwsStateInstall;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Tag;
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
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * M07 launcher-level end-to-end verification. The service under test is a real
 * {@link MediaRuntime} composed through its production {@code compose(env)} path
 * with the ServiceLoader-discovered durable PostgreSQL job/stream stores and
 * S3+PostgreSQL artifact store, behind the real {@link MediaSecurityFilter} and
 * {@link MediaHttpHandler} on a bound HTTP port. Requests go over
 * {@link HttpClient}; nothing is mocked.
 *
 * <p>LocalStack supplies the S3-compatible object store and a fresh PostgreSQL
 * database is created for each test. This exercises the real PostgreSQL engine
 * for the composed durable stores and direct outbox readback. The V06 terminal
 * result comes from the synthetic {@code local-diagnostic} fixture and provides
 * no rights, consent, model-quality, or hard-kill process-restart evidence.
 *
 * <p>V-scenario coverage notes:
 * <ul>
 *   <li>V01 upload → chunks → finalize → GET metadata → exact bytes: covered.</li>
 *   <li>V02 parallel same-request-key matching/mismatch: covered at HTTP level.</li>
 *   <li>V03 upload crash/restart matrix: covered by
 *       {@code MediaUploadCrashRecoveryIT} (provider suite).</li>
 *   <li>V05 durable worker fencing/crash matrix: covered by
 *       {@code MediaDurableWorkerCrashIT} (provider suite).</li>
 *   <li>V06 local diagnostic fixture → COMPLETED job → logicalStatus and exact outbox
 *       read survive an in-process runtime/HTTP restart against PostgreSQL. This does not
 *       prove an external provider effect or hard-kill process recovery.</li>
 *   <li>V08 outbox commit/ACK kill points: covered by provider outbox tests;
 *       asserted here at DB level that terminal state committed with outbox rows.</li>
 *   <li>V09 cross-tenant artifact isolation + forged principal header scrub: covered.
 *       Cross-principal isolation is not exercisable at HTTP level in the local
 *       profile — all unauthenticated callers resolve to the same synthetic
 *       principal by design; principal scoping is covered by launcher/provider
 *       unit tests. V02 additionally checks that a job created for one tenant
 *       reads as the same not-found response from another tenant.</li>
 *   <li>V10 historical lineage migration: covered by
 *       {@code MediaMigrationLineageFixtureTest}.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaLauncherEndToEndIT {

    private static final String LOCAL_PRINCIPAL = "media-local-development";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private HttpServer server;
    private MediaRuntime runtime;
    private AutoCloseable installed;
    private String bucket;
    private String jdbcUrl;
    private String databaseName;
    private Map<String, String> environment;
    private final HttpClient client = HttpClient.newHttpClient();

    private void startStack() throws Exception {
        databaseName = "media_launcher_e2e_" + UUID.randomUUID().toString().replace("-", "");
        try (var admin = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = admin.createStatement()) {
            statement.execute("CREATE DATABASE " + databaseName);
        }
        jdbcUrl = "jdbc:postgresql://" + POSTGRES.getHost() + ":"
                + POSTGRES.getMappedPort(PostgreSQLContainer.POSTGRESQL_PORT) + "/" + databaseName;
        bucket = "media-launcher-e2e-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client s3 = s3()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENABLED", "true");
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_PROFILE", "local");
        environment.put("MEDIA_LOCAL_PROVIDER_ENABLED", "true");
        environment.put("MEDIA_JOB_TIMEOUT_MS", "60000");
        environment.put("MEDIA_POSTGRES_JDBC_URL", jdbcUrl);
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_LAUNCHER_E2E_DB_PASSWORD");
        environment.put("MEDIA_LAUNCHER_E2E_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "8");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_E2E_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_E2E_SECRET");
        environment.put("MEDIA_E2E_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_E2E_SECRET", LOCALSTACK.getSecretKey());
        startRuntimeAndServer();
    }

    private void startRuntimeAndServer() throws Exception {
        // Install shared provider state BEFORE compose so the ServiceLoader-discovered
        // durable stores bind to it.
        installed = TestAwsStateInstall.install(environment);
        runtime = MediaRuntime.compose(environment);

        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", new MediaSecurityFilter(
                new MediaHttpHandler(runtime, null), "local"));
        server.start();
    }

    private void restartRuntimeAndHttp() throws Exception {
        if (server != null) {
            server.stop(0);
            server = null;
        }
        if (runtime != null) {
            runtime.close();
            runtime = null;
        }
        if (installed != null) {
            installed.close();
            installed = null;
        }
        startRuntimeAndServer();
    }

    @AfterEach
    void tearDown() throws Exception {
        Throwable failure = null;
        if (server != null) {
            try {
                server.stop(0);
            } catch (Exception | Error stopFailure) {
                failure = stopFailure;
            }
        }
        if (runtime != null) {
            try {
                runtime.close();
            } catch (Exception | Error closeFailure) {
                failure = recordCleanupFailure(failure, closeFailure);
            }
        }
        if (installed != null) {
            try {
                installed.close();
            } catch (Exception | Error uninstallFailure) {
                failure = recordCleanupFailure(failure, uninstallFailure);
            }
        }
        if (databaseName != null) {
            try {
                try (var admin = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                        POSTGRES.getUsername(), POSTGRES.getPassword());
                     var statement = admin.createStatement()) {
                    statement.execute("DROP DATABASE IF EXISTS " + databaseName + " WITH (FORCE)");
                }
            } catch (Exception | Error dropFailure) {
                failure = recordCleanupFailure(failure, dropFailure);
            }
        }
        if (failure instanceof Error error) {
            throw error;
        }
        if (failure instanceof Exception exception) {
            throw exception;
        }
        if (failure != null) {
            throw new RuntimeException("Media launcher integration cleanup failed", failure);
        }
    }

    private static Throwable recordCleanupFailure(Throwable existing, Throwable next) {
        if (existing == null) {
            return next;
        }
        existing.addSuppressed(next);
        return existing;
    }

    private String base() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static S3Client s3() {
        return S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build();
    }

    private HttpRequest.Builder request(String method, String tenant, String path) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(base() + path))
                .header("X-Tenant-Id", tenant)
                .header("Content-Type", "application/json");
        return switch (method) {
            case "POST" -> builder.POST(HttpRequest.BodyPublishers.noBody());
            case "PUT" -> builder.PUT(HttpRequest.BodyPublishers.noBody());
            default -> builder.GET();
        };
    }

    private HttpResponse<String> send(HttpRequest.Builder request) throws Exception {
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static byte[] wav(byte[] payload) {
        byte[] out = new byte[payload.length + 12];
        out[0] = 'R'; out[1] = 'I'; out[2] = 'F'; out[3] = 'F';
        int size = payload.length + 4;
        out[4] = (byte) size; out[5] = (byte) (size >> 8); out[6] = (byte) (size >> 16); out[7] = (byte) (size >> 24);
        out[8] = 'W'; out[9] = 'A'; out[10] = 'V'; out[11] = 'E';
        System.arraycopy(payload, 0, out, 12, payload.length);
        return out;
    }

    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }

    private JsonNode uploadArtifact(String tenant, byte[] payload, String idempotencyKey) throws Exception {
        String body = """
                {"tenantId":"%s","principalId":"%s","fileName":"clip.wav","contentType":"audio/wav",
                 "expectedSizeBytes":%d,"expectedSha256":"%s","classification":"INTERNAL",
                 "retention":"P30D","metadata":{}}
                """.formatted(tenant, LOCAL_PRINCIPAL, payload.length, sha256(payload));
        HttpResponse<String> begin = send(request("POST", tenant, "/api/v1/artifacts/uploads")
                .header("Idempotency-Key", idempotencyKey)
                .POST(HttpRequest.BodyPublishers.ofString(body)));
        assertThat(begin.statusCode()).as("begin upload body: %s", begin.body()).isEqualTo(201);
        JsonNode session = MAPPER.readTree(begin.body());
        // The HTTP boundary exposes the canonical runtime enum. Do not translate
        // this to the non-equivalent legacy client upload-state vocabulary.
        assertThat(session.path("status").asText()).isEqualTo("OPEN");
        String uploadId = session.get("uploadId").asText();

        HttpRequest.Builder chunk = HttpRequest.newBuilder(URI.create(
                        base() + "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0"))
                .header("X-Tenant-Id", tenant)
                .header("Content-Type", "application/octet-stream")
                .PUT(HttpRequest.BodyPublishers.ofByteArray(payload));
        assertThat(send(chunk).statusCode()).isEqualTo(200);

        HttpResponse<String> complete = send(request(
                "POST", tenant, "/api/v1/artifacts/uploads/" + uploadId + "/complete"));
        assertThat(complete.statusCode()).isEqualTo(201);
        return MAPPER.readTree(complete.body());
    }

    @Test
    void v01_uploadChunksFinalizeThenReadArtifactWithExactBytes() throws Exception {
        startStack();
        byte[] payload = wav("v01-e2e-payload".getBytes(StandardCharsets.UTF_8));
        JsonNode artifact = uploadArtifact("tenant-v01", payload, "v01-key");

        String artifactId = artifact.get("artifactId").asText();
        assertThat(artifact.get("sha256").asText()).isEqualTo(sha256(payload));
        assertThat(artifact.get("sizeBytes").asLong()).isEqualTo(payload.length);

        HttpResponse<String> read = send(request(
                "GET", "tenant-v01", "/api/v1/artifacts/" + artifactId));
        assertThat(read.statusCode()).isEqualTo(200);
        JsonNode metadata = MAPPER.readTree(read.body());
        assertThat(metadata.get("artifactId").asText()).isEqualTo(artifactId);
        assertThat(metadata.get("sha256").asText()).isEqualTo(sha256(payload));

        // Exact version bytes verified against the object store, not just metadata.
        String reference = artifact.get("objectReference").asText();
        String key = reference.substring(("s3://" + bucket + "/").length());
        try (S3Client s3 = s3()) {
            byte[] stored = s3.getObject(GetObjectRequest.builder()
                    .bucket(bucket).key(key).build()).readAllBytes();
            assertThat(stored).isEqualTo(payload);
        }
    }

    @Test
    void v02_sameRequestIdReplaysOneJobAndMismatchConflicts() throws Exception {
        startStack();
        byte[] payload = wav("v02-payload".getBytes(StandardCharsets.UTF_8));
        JsonNode artifact = uploadArtifact("tenant-v02", payload, "v02-upload-key");
        String artifactId = artifact.get("artifactId").asText();

        String body = """
                {"requestId":"req-v02","tenantId":"tenant-v02","principalId":"%s",
                 "correlationId":"corr-v02","artifactId":"%s","jobType":"TRANSCODE",
                 "providerHint":"local-diagnostic","parameters":{}}
                """.formatted(LOCAL_PRINCIPAL, artifactId);
        HttpResponse<String> first = send(request("POST", "tenant-v02", "/api/v1/jobs")
                .POST(HttpRequest.BodyPublishers.ofString(body)));
        assertThat(first.statusCode()).isEqualTo(202);
        String jobId = MAPPER.readTree(first.body()).get("jobId").asText();

        // The persisted job identifier must not disclose a job across tenants.
        // Compare against a genuinely absent identifier so the denial stays
        // customer-neutral at the HTTP boundary.
        HttpResponse<String> crossTenant = send(request(
                "GET", "tenant-other", "/api/v1/jobs/" + jobId));
        HttpResponse<String> absent = send(request(
                "GET", "tenant-other", "/api/v1/jobs/absent-v02-job"));
        assertThat(crossTenant.statusCode()).isEqualTo(404);
        assertThat(MAPPER.readTree(crossTenant.body()).path("error"))
                .isEqualTo(MAPPER.readTree(absent.body()).path("error"));
        assertThat(crossTenant.body()).doesNotContain(jobId);

        // Identical replay — one logical command, same jobId, zero additional effect.
        HttpResponse<String> replay = send(request("POST", "tenant-v02", "/api/v1/jobs")
                .POST(HttpRequest.BodyPublishers.ofString(body)));
        assertThat(replay.statusCode()).isEqualTo(202);
        assertThat(MAPPER.readTree(replay.body()).get("jobId").asText()).isEqualTo(jobId);

        // Same requestId with a different submission must conflict.
        String mismatched = body.replace("TRANSCODE", "VISION");
        HttpResponse<String> conflict = send(request("POST", "tenant-v02", "/api/v1/jobs")
                .POST(HttpRequest.BodyPublishers.ofString(mismatched)));
        assertThat(conflict.statusCode()).isEqualTo(409);
    }

    @Test
    void v06LocalDiagnosticCompletionAndOutboxSurviveRuntimeRestart() throws Exception {
        startStack();
        byte[] payload = wav("v06-payload".getBytes(StandardCharsets.UTF_8));
        JsonNode artifact = uploadArtifact("tenant-v06", payload, "v06-upload-key");

        String body = """
                {"requestId":"req-v06","tenantId":"tenant-v06","principalId":"%s",
                 "correlationId":"corr-v06","artifactId":"%s","jobType":"TRANSCODE",
                 "providerHint":"local-diagnostic","parameters":{}}
                """.formatted(LOCAL_PRINCIPAL, artifact.get("artifactId").asText());
        HttpResponse<String> submitted = send(request("POST", "tenant-v06", "/api/v1/jobs")
                .POST(HttpRequest.BodyPublishers.ofString(body)));
        assertThat(submitted.statusCode()).isEqualTo(202);
        JsonNode accepted = MAPPER.readTree(submitted.body());
        String jobId = accepted.get("jobId").asText();
        assertThat(accepted.get("status").asText()).isEqualTo("ACCEPTED");
        assertThat(accepted.get("logicalStatus").asText()).isEqualTo("QUEUED");

        // Poll the read surface until the durable worker commits the terminal outcome.
        JsonNode job = null;
        for (int i = 0; i < 120; i++) {
            HttpResponse<String> read = send(request(
                    "GET", "tenant-v06", "/api/v1/jobs/" + jobId));
            assertThat(read.statusCode()).isEqualTo(200);
            job = MAPPER.readTree(read.body());
            String status = job.get("status").asText();
            if ("COMPLETED".equals(status) || "FAILED".equals(status)
                    || "OUTCOME_UNKNOWN".equals(status)) {
                break;
            }
            Thread.sleep(250);
        }
        assertThat(job).isNotNull();
        assertThat(job.get("providerId").asText()).isEqualTo("local-diagnostic");
        assertThat(job.get("status").asText()).as("final job: %s", job).isEqualTo("COMPLETED");
        assertThat(job.get("failureCode").asText()).isEmpty();
        assertThat(job.get("logicalStatus").asText()).isEqualTo("COMPLETED");
        long version = job.get("version").asLong();
        int attemptCountBeforeRestart = processingAttemptCount("tenant-v06", jobId);
        assertThat(attemptCountBeforeRestart).isEqualTo(1);
        LifecycleOutboxEvent outbox = lifecycleOutboxEvent(
                "tenant-v06", jobId, version, "media.job.completed");
        assertThat(outbox.eventId()).isEqualTo("media:media.job.completed:" + jobId + ":" + version);

        JsonNode eventPayload = MAPPER.readTree(outbox.payloadJson());
        assertThat(eventPayload.size()).isEqualTo(12);
        assertThat(eventPayload.path("eventId").asString()).isEqualTo(outbox.eventId());
        assertThat(eventPayload.path("eventType").asString()).isEqualTo("media.job.completed");
        assertThat(eventPayload.path("tenantId").asString()).isEqualTo("tenant-v06");
        assertThat(eventPayload.path("principalId").asString()).isEqualTo(LOCAL_PRINCIPAL);
        assertThat(eventPayload.path("correlationId").asString()).isEqualTo("corr-v06");
        assertThat(eventPayload.path("causationId").asString()).isEqualTo("req-v06");
        assertThat(eventPayload.path("aggregateType").asString()).isEqualTo("job");
        assertThat(eventPayload.path("aggregateId").asString()).isEqualTo(jobId);
        assertThat(eventPayload.path("aggregateVersion").asLong()).isEqualTo(version);
        assertThat(eventPayload.path("classification").asString()).isEqualTo("INTERNAL");
        assertThat(java.time.Instant.parse(eventPayload.path("occurredAt").asString())).isNotNull();
        JsonNode attributes = eventPayload.path("attributes");
        assertThat(attributes.size()).isEqualTo(6);
        assertThat(attributes.path("artifactId").asString()).isEqualTo(artifact.get("artifactId").asString());
        assertThat(attributes.path("jobType").asString()).isEqualTo("TRANSCODE");
        assertThat(attributes.path("providerId").asString()).isEqualTo("local-diagnostic");
        assertThat(attributes.path("status").asString()).isEqualTo("COMPLETED");
        assertThat(attributes.path("failureCode").asString()).isEmpty();
        assertThat(attributes.path("priorVersion").asLong()).isEqualTo(version - 1);

        // Recompose the real runtime and HTTP boundary over the same database and
        // bucket. This orderly restart is not a hard-kill or process-recovery proof.
        String databaseUrl = jdbcUrl;
        String objectBucket = bucket;
        String completedJobJson = job.toString();
        restartRuntimeAndHttp();
        assertThat(jdbcUrl).isEqualTo(databaseUrl);
        assertThat(bucket).isEqualTo(objectBucket);

        HttpResponse<String> restartedRead = send(request("GET", "tenant-v06", "/api/v1/jobs/" + jobId));
        assertThat(restartedRead.statusCode()).as("restarted job read: %s", restartedRead.body()).isEqualTo(200);
        JsonNode restartedJob = MAPPER.readTree(restartedRead.body());
        assertThat(restartedJob.toString()).isEqualTo(completedJobJson);
        assertThat(processingAttemptCount("tenant-v06", jobId)).isEqualTo(attemptCountBeforeRestart);

        LifecycleOutboxEvent restartedOutbox = lifecycleOutboxEvent(
                "tenant-v06", jobId, version, "media.job.completed");
        assertThat(restartedOutbox).isEqualTo(outbox);

        // Replay the exact original command after restart. The durable job and outbox
        // remain unchanged, and no second processing-attempt row is created.
        HttpResponse<String> replay = send(request("POST", "tenant-v06", "/api/v1/jobs")
                .POST(HttpRequest.BodyPublishers.ofString(body)));
        assertThat(replay.statusCode()).as("completed replay: %s", replay.body()).isEqualTo(202);
        assertThat(MAPPER.readTree(replay.body()).path("jobId").asString()).isEqualTo(jobId);

        HttpResponse<String> replayedRead = send(request("GET", "tenant-v06", "/api/v1/jobs/" + jobId));
        assertThat(replayedRead.statusCode()).as("replayed job read: %s", replayedRead.body()).isEqualTo(200);
        JsonNode replayedJob = MAPPER.readTree(replayedRead.body());
        assertThat(replayedJob.toString()).isEqualTo(completedJobJson);
        assertThat(replayedJob.path("status").asString()).isEqualTo("COMPLETED");
        assertThat(processingAttemptCount("tenant-v06", jobId)).isEqualTo(attemptCountBeforeRestart);
        assertThat(lifecycleOutboxEvent("tenant-v06", jobId, version, "media.job.completed"))
                .isEqualTo(outbox);
    }

    private int processingAttemptCount(String tenantId, String jobId) throws SQLException {
        try (var connection = DriverManager.getConnection(jdbcUrl,
                POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("""
                     SELECT COUNT(*) FROM media_processing_attempts WHERE tenant_id=? AND job_id=?
                     """)) {
            statement.setString(1, tenantId);
            statement.setString(2, jobId);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) {
                    throw new SQLException("Processing attempt count query returned no row");
                }
                return rows.getInt(1);
            }
        }
    }

    private LifecycleOutboxEvent lifecycleOutboxEvent(
            String tenantId, String jobId, long version, String eventType) throws Exception {
        try (var connection = DriverManager.getConnection(jdbcUrl,
                POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement("""
                     SELECT event_id, payload_json FROM media_processing_lifecycle_outbox
                      WHERE tenant_id=? AND aggregate_type='job' AND aggregate_id=?
                        AND aggregate_version=? AND event_type=?
                     """)) {
            statement.setString(1, tenantId);
            statement.setString(2, jobId);
            statement.setLong(3, version);
            statement.setString(4, eventType);
            try (var rows = statement.executeQuery()) {
                if (!rows.next()) {
                    throw new SQLException("Lifecycle outbox query returned no row");
                }
                LifecycleOutboxEvent event = new LifecycleOutboxEvent(
                        rows.getString("event_id"), rows.getString("payload_json"));
                if (rows.next()) {
                    throw new SQLException("Lifecycle outbox query returned duplicate rows");
                }
                return event;
            }
        }
    }

    private record LifecycleOutboxEvent(String eventId, String payloadJson) { }

    @Test
    void v09_crossTenantReadsNotFoundAndForgedPrincipalScrubbed() throws Exception {
        startStack();
        byte[] payload = wav("v09-payload".getBytes(StandardCharsets.UTF_8));
        JsonNode artifact = uploadArtifact("tenant-a", payload, "v09-upload-key");
        String artifactId = artifact.get("artifactId").asText();

        // Cross-tenant read must not disclose existence.
        HttpResponse<String> cross = send(request(
                "GET", "tenant-b", "/api/v1/artifacts/" + artifactId));
        assertThat(cross.statusCode()).isEqualTo(404);

        // A forged X-Principal-Id is stripped by the security filter; the caller is
        // resolved to the synthetic local principal. A body claiming another
        // principal is therefore rejected instead of impersonating them.
        String forged = """
                {"tenantId":"tenant-a","principalId":"other-principal","fileName":"clip.wav",
                 "contentType":"audio/wav","expectedSizeBytes":%d,"expectedSha256":"%s",
                 "classification":"INTERNAL","retention":"P30D","metadata":{}}
                """.formatted(payload.length, sha256(payload));
        HttpResponse<String> rejected = send(request("POST", "tenant-a", "/api/v1/artifacts/uploads")
                .header("Idempotency-Key", "v09-forged-key")
                .header("X-Principal-Id", "other-principal")
                .POST(HttpRequest.BodyPublishers.ofString(forged)));
        assertThat(rejected.statusCode()).isEqualTo(403);
    }
}
