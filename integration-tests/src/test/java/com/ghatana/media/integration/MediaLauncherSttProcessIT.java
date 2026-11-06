package com.ghatana.media.integration;

import com.ghatana.media.provider.aws.PostgresqlMediaConsentAdministration;
import com.ghatana.media.provider.aws.PostgresqlMediaSourceRightsAdministration;
import com.ghatana.media.provider.aws.TestAwsStateInstall;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
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
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import static com.ghatana.media.integration.MediaLauncherProcessFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** MediaLauncher process restart HTTP path with isolated, synthetic-only test providers. */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaLauncherSttProcessIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PRINCIPAL = MediaLauncherProcessFixtures.PRINCIPAL;

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void launcherProcessKeepsSttNotAdmittedThenReadsArtifactAfterRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-launcher-stt-" + run;
        Process launcher = null;
        Path serviceRoot = null;
        Path log = null;
        String environmentClasspath = null;
        String objectReference = "";
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            int port;
            try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
            Map<String, String> env = environment(bucket, port);
            serviceRoot = Files.createTempDirectory("media-launcher-test-services-");
            log = Files.createTempFile("media-launcher-stt-process-", ".log");
            String baseClasspath = System.getProperty("media.child.classpath", "");
            assertThat(baseClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            installChildServiceDescriptors(serviceRoot);
            environmentClasspath = serviceRoot + java.io.File.pathSeparator + baseClasspath;
            launcher = startLauncher(environmentClasspath, env, log);
            awaitReady(launcher, port);

            byte[] audio = syntheticWav();
            String sha = sha256(audio);
            String metadata = "\"sourceClockId\":\"fixture-clock\","
                    + "\"sourceClockMappingEvidenceRef\":\"fixture-clock-evidence\","
                    + "\"sourceClockTicksPerSecond\":16000,\"sourceDurationTicks\":16000";
            String uploadBody = """
                    {"tenantId":"%s","principalId":"%s","fileName":"synthetic.wav",
                     "contentType":"audio/wav","expectedSizeBytes":%d,"expectedSha256":"%s",
                     "classification":"CONFIDENTIAL","retention":"P30D","metadata":{%s}}
                    """.formatted(TENANT, PRINCIPAL, audio.length, sha, metadata);
            JsonNode begun = JSON.readTree(send(port, TENANT, "POST", "/api/v1/artifacts/uploads",
                    uploadBody, "application/json", "launcher-fixture-upload-" + run).body());
            String uploadId = begun.path("uploadId").asText();
            assertThat(uploadId).isNotBlank();
            assertThat(sendBytes(port, TENANT, "PUT", "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0",
                    audio).statusCode()).isEqualTo(200);
            HttpResponse<String> completed = send(port, TENANT, "POST",
                    "/api/v1/artifacts/uploads/" + uploadId + "/complete", "", "application/json", null);
            assertThat(completed.statusCode()).as(completed.body()).isEqualTo(201);
            JsonNode artifact = JSON.readTree(completed.body());
            String artifactId = artifact.path("artifactId").asText();
            objectReference = artifact.path("objectReference").asText();
            assertThat(artifactId).isNotBlank();

            stopLauncher(launcher);
            launcher = null;

            String consentId = registerSyntheticRights(env, artifactId, sha, run);
            env.put("MEDIA_FIXTURE_ARTIFACT_ID", artifactId);
            env.put("MEDIA_FIXTURE_SOURCE_VERSION", "sha256:" + sha);
            launcher = startLauncher(environmentClasspath, env, log);
            awaitReady(launcher, port);
            HttpResponse<String> providers = send(port, TENANT, "GET", "/api/v1/providers",
                    "", "application/json", null);
            assertThat(providers.statusCode()).isEqualTo(200);
            assertThat(providers.body()).contains(PROVIDER_ID);
            EffectCounts before = effectCounts(env);
            String jobBody = """
                    {"requestId":"launcher-stt-%s","tenantId":"%s","principalId":"%s",
                     "correlationId":"launcher-corr-%s","artifactId":"%s","expectedArtifactVersion":"sha256:%s",
                     "jobType":"SPEECH_TO_TEXT","providerHint":"%s",
                     "parameters":{"profileId":"%s","profileVersion":"v1","profileConfigurationDigest":"%s",
                       "languageIntent":{"mode":"EXPLICIT","languageTag":"en-US"}},
                     "governanceContext":{"consentId":"%s","purpose":"transcription",
                       "classification":"CONFIDENTIAL","residency":"local","allowedRegions":["local"],
                       "externalProcessingAllowed":false,"retentionPolicy":"short-lived-media",
                       "providerRetentionAllowed":false,"biometricProcessingAllowed":false,
                       "biometricProcessingBasis":"","biometricSensitivity":"NONE","automationRisk":"ASSISTIVE"}}
                    """.formatted(run, TENANT, PRINCIPAL, run, artifactId, sha, PROVIDER_ID,
                    PROFILE_ID, PROFILE_DIGEST, consentId);
            HttpResponse<String> accepted = send(port, TENANT, "POST", "/api/v1/jobs", jobBody,
                    "application/json", null);
            assertThat(accepted.statusCode()).as(accepted.body()).isEqualTo(422);
            assertThat(JSON.readTree(accepted.body()).path("error").path("code").asText())
                    .isEqualTo("MEDIA_CAPABILITY_NOT_ADMITTED");
            EffectCounts afterDenied = effectCounts(env);
            assertThat(afterDenied.jobs()).isEqualTo(before.jobs());
            assertThat(afterDenied.attempts()).isEqualTo(before.attempts());
            assertThat(afterDenied.transcripts()).isEqualTo(before.transcripts());
            assertThat(afterDenied.lifecycleOutbox()).isEqualTo(before.lifecycleOutbox());
            assertThat(afterDenied.sourceRightsDecisions()).isEqualTo(before.sourceRightsDecisions() + 1);

            stopLauncher(launcher);
            launcher = null;

            launcher = startLauncher(environmentClasspath, env, log);
            awaitReady(launcher, port);
            HttpResponse<String> readback = send(port, TENANT, "GET", "/api/v1/artifacts/" + artifactId,
                    "", "application/json", null);
            assertThat(readback.statusCode()).as(readback.body()).isEqualTo(200);
            assertThat(JSON.readTree(readback.body()).path("sha256").asText()).isEqualTo(sha);
            assertThat(JSON.readTree(readback.body()).path("objectReference").asText())
                    .isEqualTo(objectReference);
            EffectCounts afterRestart = effectCounts(env);
            assertThat(afterRestart).isEqualTo(afterDenied);
            stopLauncher(launcher);
            launcher = null;

            try (S3Client s3 = s3()) {
                String key = URI.create(objectReference).getPath().substring(1);
                assertThat(s3.getObjectAsBytes(GetObjectRequest.builder().bucket(bucket).key(key).build())
                        .asByteArray()).containsExactly(audio);
            }
        } finally {
            try {
                if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            } finally {
                try {
                    if (log != null) Files.deleteIfExists(log);
                } finally {
                    try {
                        deleteBucket(bucket);
                    } finally {
                        if (serviceRoot != null && Files.exists(serviceRoot)) {
                            try (var paths = Files.walk(serviceRoot)) {
                                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                                    try { Files.deleteIfExists(path); } catch (Exception ignored) { }
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    @Test
    void dispatchedJobBecomesUnknownAfterHardProcessRestartWithoutRedispatch() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-launcher-job-recovery-" + run;
        Process launcher = null;
        Path serviceRoot = null;
        Path log = null;
        Path dispatchMarker = null;
        String environmentClasspath = null;
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            int port;
            try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
            Map<String, String> env = environment(bucket, port);
            env.put("MEDIA_JOB_TIMEOUT_MS", "5000");
            env.put("MEDIA_JWT_HMAC_SECRET_REFERENCE", "secret:env:MEDIA_LAUNCHER_TEST_JWT_SECRET");
            env.put("MEDIA_JWT_ISSUER", "https://issuer.example");
            env.put("MEDIA_JWT_AUDIENCE", "ghatana-runtime");
            env.put("MEDIA_LAUNCHER_TEST_JWT_SECRET", "media-launcher-recovery-secret-0123456789");
            serviceRoot = Files.createTempDirectory("media-launcher-job-recovery-services-");
            dispatchMarker = Files.createTempFile("media-launcher-provider-dispatch-", ".log");
            Files.deleteIfExists(dispatchMarker);
            env.put("MEDIA_FIXTURE_PROVIDER_DISPATCH_MARKER", dispatchMarker.toString());
            log = Files.createTempFile("media-launcher-job-recovery-", ".log");
            String baseClasspath = System.getProperty("media.child.classpath", "");
            assertThat(baseClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            installChildServiceDescriptors(serviceRoot, MediaLauncherProcessFixtures.BlockingTranscode.class);
            environmentClasspath = serviceRoot + java.io.File.pathSeparator + baseClasspath;
            String token = authenticatedJwt(PRINCIPAL, TENANT, env.get("MEDIA_LAUNCHER_TEST_JWT_SECRET"));

            launcher = startLauncher(environmentClasspath, env, log);
            awaitReady(launcher, port);

            byte[] audio = syntheticWav();
            String sha = sha256(audio);
            String metadata = "\"sourceClockId\":\"fixture-clock\","
                    + "\"sourceClockMappingEvidenceRef\":\"fixture-clock-evidence\","
                    + "\"sourceClockTicksPerSecond\":16000,\"sourceDurationTicks\":16000";
            String uploadBody = """
                    {"tenantId":"%s","principalId":"%s","fileName":"synthetic.wav",
                     "contentType":"audio/wav","expectedSizeBytes":%d,"expectedSha256":"%s",
                     "classification":"CONFIDENTIAL","retention":"P30D","metadata":{%s}}
                    """.formatted(TENANT, PRINCIPAL, audio.length, sha, metadata);
            JsonNode begun = JSON.readTree(sendAuthenticated(port, TENANT, token, "POST",
                    "/api/v1/artifacts/uploads", uploadBody, "application/json",
                    "launcher-recovery-upload-" + run).body());
            String uploadId = begun.path("uploadId").asText();
            assertThat(uploadId).isNotBlank();
            assertThat(sendAuthenticatedBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0", audio).statusCode()).isEqualTo(200);
            HttpResponse<String> completed = sendAuthenticated(port, TENANT, token, "POST",
                    "/api/v1/artifacts/uploads/" + uploadId + "/complete", "", "application/json", null);
            assertThat(completed.statusCode()).as(completed.body()).isEqualTo(201);
            JsonNode artifact = JSON.readTree(completed.body());
            String artifactId = artifact.path("artifactId").asText();
            assertThat(artifactId).isNotBlank();

            stopLauncher(launcher);
            launcher = null;

            launcher = startLauncher(environmentClasspath, env, log);
            awaitReady(launcher, port);
            String requestId = "launcher-recovery-" + run;
            String jobBody = """
                    {"requestId":"%s","tenantId":"%s","principalId":"%s",
                     "correlationId":"launcher-recovery-corr-%s","artifactId":"%s",
                     "expectedArtifactVersion":"sha256:%s","jobType":"TRANSCODE",
                     "providerHint":"%s","parameters":{}}
                    """.formatted(requestId, TENANT, PRINCIPAL, run, artifactId, sha,
                    MediaLauncherProcessFixtures.BLOCKING_PROVIDER_ID);
            HttpResponse<String> accepted = sendAuthenticated(port, TENANT, token, "POST",
                    "/api/v1/jobs", jobBody, "application/json", null);
            assertThat(accepted.statusCode()).as(accepted.body()).isEqualTo(202);
            JsonNode acceptedJob = JSON.readTree(accepted.body());
            String jobId = acceptedJob.path("jobId").asText();
            assertThat(jobId).isNotBlank();
            assertThat(acceptedJob.path("requestId").asText()).isEqualTo(requestId);

            awaitDispatchMarker(launcher, dispatchMarker);
            JsonNode running = JSON.readTree(sendAuthenticated(port, TENANT, token, "GET",
                    "/api/v1/jobs/" + jobId, "", "application/json", null).body());
            assertThat(running.path("status").asText()).isEqualTo("RUNNING");
            assertThat(attemptCount(TENANT, jobId)).isEqualTo(1);
            assertThat(attemptState(TENANT, jobId)).isEqualTo("DISPATCH_INTENDED");

            // This intentionally hard-kills the process while the test-only provider has no
            // final result. Its marker proves dispatch entry only and is not an effect receipt.
            launcher.destroyForcibly();
            assertThat(launcher.waitFor(15, TimeUnit.SECONDS)).isTrue();
            launcher = null;

            // A replacement process must not steal the crashed worker's still-current lease.
            // It reads the same durable RUNNING job and dispatch attempt without replaying it.
            launcher = startLauncher(environmentClasspath, env, log);
            awaitReady(launcher, port);
            HttpResponse<String> leaseProtectedRead = sendAuthenticated(port, TENANT, token, "GET",
                    "/api/v1/jobs/" + jobId, "", "application/json", null);
            assertThat(leaseProtectedRead.statusCode()).as(leaseProtectedRead.body()).isEqualTo(200);
            JsonNode leaseProtected = JSON.readTree(leaseProtectedRead.body());
            assertThat(leaseProtected.path("jobId").asText()).isEqualTo(jobId);
            assertThat(leaseProtected.path("requestId").asText()).isEqualTo(requestId);
            assertThat(leaseProtected.path("status").asText()).isEqualTo("RUNNING");
            assertThat(attemptCount(TENANT, jobId)).isEqualTo(1);
            assertThat(attemptState(TENANT, jobId)).isEqualTo("DISPATCH_INTENDED");
            launcher.destroyForcibly();
            assertThat(launcher.waitFor(15, TimeUnit.SECONDS)).isTrue();
            launcher = null;

            // The test uses a short but valid job budget so the durable lease reaches its
            // natural expiry quickly. A fresh process then performs the normal recovery pass.
            awaitLeaseExpiry(TENANT, jobId);
            launcher = startLauncher(environmentClasspath, env, log);
            awaitReady(launcher, port);
            HttpResponse<String> recoveredRead = sendAuthenticated(port, TENANT, token, "GET",
                    "/api/v1/jobs/" + jobId, "", "application/json", null);
            assertThat(recoveredRead.statusCode()).as(recoveredRead.body()).isEqualTo(200);
            JsonNode recovered = JSON.readTree(recoveredRead.body());
            assertThat(recovered.path("jobId").asText()).isEqualTo(jobId);
            assertThat(recovered.path("requestId").asText()).isEqualTo(requestId);
            assertThat(recovered.path("artifactId").asText()).isEqualTo(artifactId);
            assertThat(recovered.path("status").asText()).isEqualTo("OUTCOME_UNKNOWN");
            assertThat(recovered.path("logicalStatus").asText()).isEqualTo("OUTCOME_UNKNOWN");
            assertThat(recovered.path("failureCode").asText()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
            assertThat(attemptCount(TENANT, jobId)).isEqualTo(1);
            assertThat(attemptState(TENANT, jobId)).isEqualTo("OUTCOME_UNKNOWN");

            // Exact command replay after restart remains the same unknown job and cannot
            // manufacture a second attempt or convert the fixture marker into provider truth.
            HttpResponse<String> replay = sendAuthenticated(port, TENANT, token, "POST",
                    "/api/v1/jobs", jobBody, "application/json", null);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(202);
            JsonNode replayed = JSON.readTree(replay.body());
            assertThat(replayed.path("jobId").asText()).isEqualTo(jobId);
            assertThat(replayed.path("status").asText()).isEqualTo("OUTCOME_UNKNOWN");
            assertThat(attemptCount(TENANT, jobId)).isEqualTo(1);
            assertThat(Files.readAllLines(dispatchMarker)).containsExactly(requestId + ",1");
        } finally {
            try {
                if (launcher != null && launcher.isAlive()) launcher.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
            } finally {
                try {
                    if (log != null) Files.deleteIfExists(log);
                    if (dispatchMarker != null) Files.deleteIfExists(dispatchMarker);
                } finally {
                    try {
                        deleteBucket(bucket);
                    } finally {
                        if (serviceRoot != null && Files.exists(serviceRoot)) {
                            try (var paths = Files.walk(serviceRoot)) {
                                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                                    try { Files.deleteIfExists(path); } catch (Exception ignored) { }
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    private static String registerSyntheticRights(Map<String, String> env, String artifactId,
            String sha, String run) throws Exception {
        try (AutoCloseable installed = TestAwsStateInstall.install(env);
             var consentAdmin = new PostgresqlMediaConsentAdministration();
             var rightsAdmin = new PostgresqlMediaSourceRightsAdministration()) {
            var consent = consentAdmin.grant(new com.ghatana.media.runtime.MediaConsentAdministration.GrantRequest(
                    TENANT, PRINCIPAL, "launcher-process-fixture-" + run,
                    Set.of("transcription"), Set.of("local"), false, false,
                    Instant.now().plusSeconds(3600)));
            var source = rightsAdmin.register(new MediaSourceRightsAdministration.RegisterRequest(
                    TENANT, PRINCIPAL, artifactId, "sha256:" + sha, sha, PRINCIPAL,
                    MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                    MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                    "", Set.of("speech_to_text"), Set.of("transcription"), Set.of("local"),
                    Set.of(ProviderDataRetention.NONE), "fixture-clock-evidence",
                    "fixture:launcher-synthetic-nonhuman", Instant.now().plusSeconds(3600),
                    "launcher-process-fixture-" + run),
                    new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                            TENANT, PRINCIPAL, Instant.now()));
            assertThat(source.sourceKind()).isEqualTo(MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN);
            assertThat(source.provenanceRef()).isEqualTo("fixture:launcher-synthetic-nonhuman");
            return consent.consentId();
        }
    }

    private static EffectCounts effectCounts(Map<String, String> env) throws Exception {
        try (AutoCloseable installed = TestAwsStateInstall.install(env);
             var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())) {
            return new EffectCounts(count(connection, "media_processing_jobs"),
                    count(connection, "media_processing_job_attempts"),
                    count(connection, "media_transcript_revisions"),
                    count(connection, "media_processing_lifecycle_outbox"),
                    count(connection, "media_source_rights_decisions"));
        }
    }

    private static long count(java.sql.Connection connection, String table) throws Exception {
        try (var statement = connection.prepareStatement("SELECT COUNT(*) FROM " + table);
             var result = statement.executeQuery()) {
            assertThat(result.next()).isTrue();
            return result.getLong(1);
        }
    }

    private static long attemptCount(String tenantId, String jobId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_processing_attempts WHERE tenant_id=? AND job_id=?")) {
            statement.setString(1, tenantId);
            statement.setString(2, jobId);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getLong(1);
            }
        }
    }

    private static String attemptState(String tenantId, String jobId) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                     POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT state FROM media_processing_attempts WHERE tenant_id=? AND job_id=?")) {
            statement.setString(1, tenantId);
            statement.setString(2, jobId);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).as("canonical attempt exists for recovered job").isTrue();
                return rows.getString("state");
            }
        }
    }

    private static void awaitLeaseExpiry(String tenantId, String jobId) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (System.nanoTime() < deadline) {
            try (var connection = java.sql.DriverManager.getConnection(
                         POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.prepareStatement(
                         "SELECT lease_expires_at FROM media_processing_jobs WHERE tenant_id=? AND job_id=?")) {
                statement.setString(1, tenantId);
                statement.setString(2, jobId);
                try (var rows = statement.executeQuery()) {
                    assertThat(rows.next()).as("durable job lease exists after worker crash").isTrue();
                    if (rows.getLong("lease_expires_at") <= System.currentTimeMillis()) return;
                }
            }
            Thread.sleep(50);
        }
        throw new AssertionError("crashed worker lease did not expire within the bounded recovery window");
    }

    private record EffectCounts(long jobs, long attempts, long transcripts,
            long lifecycleOutbox, long sourceRightsDecisions) { }

    private static Map<String, String> environment(String bucket, int port) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENABLED", "true");
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        env.put("MEDIA_PROFILE", "local");
        env.put("MEDIA_HTTP_PORT", Integer.toString(port));
        env.put("MEDIA_LOCAL_PROVIDER_ENABLED", "true");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_LAUNCHER_DB_PASSWORD");
        env.put("MEDIA_LAUNCHER_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_LAUNCHER_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_LAUNCHER_SECRET");
        env.put("MEDIA_LAUNCHER_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_LAUNCHER_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }

    private static void installChildServiceDescriptors(Path root) throws Exception {
        installChildServiceDescriptors(root, MediaLauncherProcessFixtures.Stt.class);
    }

    private static void installChildServiceDescriptors(Path root, Class<?> providerClass) throws Exception {
        Path services = root.resolve("META-INF/services");
        Files.createDirectories(services);
        Files.writeString(services.resolve("com.ghatana.governance.PolicyEngine"),
                MediaLauncherProcessFixtures.Policy.class.getName() + "\n");
        Files.writeString(services.resolve("com.ghatana.media.runtime.MediaRuntimeContracts$MediaProcessingProvider"),
                providerClass.getName() + "\n");
    }

    private static Process startLauncher(String classpath, Map<String, String> env, Path log) throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        ProcessBuilder builder = new ProcessBuilder(java, "-cp", classpath,
                "com.ghatana.media.launcher.MediaLauncher");
        builder.environment().putAll(env);
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitReady(Process process, int port) throws Exception {
        long deadline = System.nanoTime() + java.time.Duration.ofMinutes(2).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("MediaLauncher exited: " + process.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/health/ready"))
                                .GET().build(), HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (java.io.IOException ignored) { }
            Thread.sleep(200);
        }
        throw new AssertionError("MediaLauncher did not become ready");
    }

    private static HttpResponse<String> send(int port, String tenant, String method, String path,
            String body, String contentType, String idempotencyKey) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(
                        "http://127.0.0.1:" + port + path))
                .header("X-Tenant-Id", tenant).header("Content-Type", contentType);
        if (idempotencyKey != null) request.header("Idempotency-Key", idempotencyKey);
        if ("POST".equals(method)) request.POST(HttpRequest.BodyPublishers.ofString(body));
        else request.GET();
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static HttpResponse<String> sendAuthenticated(int port, String tenant, String token,
            String method, String path, String body, String contentType, String idempotencyKey)
            throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(
                        "http://127.0.0.1:" + port + path))
                .header("X-Tenant-Id", tenant)
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", contentType);
        if (idempotencyKey != null) request.header("Idempotency-Key", idempotencyKey);
        if ("POST".equals(method)) request.POST(HttpRequest.BodyPublishers.ofString(body));
        else if ("GET".equals(method)) request.GET();
        else request.method(method, HttpRequest.BodyPublishers.ofString(body));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static HttpResponse<String> sendBytes(int port, String tenant, String method,
            String path, byte[] body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("X-Tenant-Id", tenant).header("Content-Type", "application/octet-stream")
                .PUT(HttpRequest.BodyPublishers.ofByteArray(body)).build();
        return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
    }

    private static HttpResponse<String> sendAuthenticatedBytes(int port, String tenant, String token,
            String method, String path, byte[] body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("X-Tenant-Id", tenant)
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/octet-stream")
                .method(method, HttpRequest.BodyPublishers.ofByteArray(body)).build();
        return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
    }

    private static String authenticatedJwt(String subject, String tenant, String secret) throws Exception {
        String header = base64Url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissions = String.join(",", Set.of(
                "media:artifact:create", "media:artifact:write", "media:artifact:read",
                "media:job:create", "media:job:read").stream()
                .sorted().map(permission -> "\"" + permission + "\"").toList());
        String payload = base64Url("{\"sub\":\"" + subject + "\",\"tenant_id\":\"" + tenant
                + "\",\"iss\":\"https://issuer.example\",\"aud\":\"ghatana-runtime\",\"exp\":"
                + Instant.now().plusSeconds(300).getEpochSecond() + ",\"permissions\":[" + permissions + "]}");
        String signingInput = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String base64Url(String value) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static void awaitDispatchMarker(Process process, Path marker) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("MediaLauncher exited before provider dispatch");
            if (Files.exists(marker) && !Files.readAllLines(marker).isEmpty()) return;
            Thread.sleep(50);
        }
        throw new AssertionError("test provider did not enter its dispatch boundary");
    }

    private static void stopLauncher(Process process) throws Exception {
        process.destroy();
        if (!process.waitFor(15, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            assertThat(process.waitFor(10, TimeUnit.SECONDS)).isTrue();
        }
        assertThat(process.isAlive()).isFalse();
    }

    private static S3Client s3() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    private static void deleteBucket(String bucket) {
        try (S3Client s3 = s3()) {
            var objects = s3.listObjectsV2Paginator(
                    software.amazon.awssdk.services.s3.model.ListObjectsV2Request.builder()
                            .bucket(bucket).build());
            for (var page : objects) {
                if (!page.contents().isEmpty()) {
                    s3.deleteObjects(software.amazon.awssdk.services.s3.model.DeleteObjectsRequest.builder()
                            .bucket(bucket).delete(software.amazon.awssdk.services.s3.model.Delete.builder()
                                    .objects(page.contents().stream().map(object ->
                                            software.amazon.awssdk.services.s3.model.ObjectIdentifier.builder()
                                                    .key(object.key()).build()).toList()).build()).build());
                }
            }
            s3.deleteBucket(software.amazon.awssdk.services.s3.model.DeleteBucketRequest.builder()
                    .bucket(bucket).build());
        } catch (RuntimeException cleanupFailure) {
            // The bucket is unique to this Testcontainers class run and the container is stopped by JUnit.
        }
    }

    private static byte[] syntheticWav() {
        int samples = 16000;
        byte[] wav = new byte[44 + samples * 2];
        java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(wav).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        buffer.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(wav.length - 8)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1)
                .putShort((short) 1).putInt(16000).putInt(32000).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples * 2);
        return wav;
    }

    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }
}
