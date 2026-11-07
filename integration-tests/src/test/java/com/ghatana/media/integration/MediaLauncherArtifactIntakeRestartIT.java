package com.ghatana.media.integration;

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
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import static com.ghatana.media.integration.MediaLauncherProcessFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** Synthetic-only authenticated upload durability across actual MediaLauncher process restarts. */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaLauncherArtifactIntakeRestartIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String JWT_SECRET = "media-launcher-upload-restart-secret-0123456789";
    private static final Set<String> UPLOAD_PERMISSIONS = Set.of(
            "media:artifact:create", "media:artifact:write", "media:artifact:read");

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void authenticatedUploadResumesAcknowledgedPrefixAfterLauncherProcessRestart() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-upload-restart-" + run;
        Process launcher = null;
        Path services = null;
        Path log = null;
        String objectReference = "";
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            int port;
            try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
            Map<String, String> environment = environment(bucket, port);
            services = Files.createTempDirectory("media-launcher-upload-services-");
            installChildServiceDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            log = Files.createTempFile("media-launcher-upload-process-", ".log");
            String token = authenticatedJwt(PRINCIPAL, TENANT, JWT_SECRET);

            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            byte[] completeBytes = syntheticWav();
            byte[] first = java.util.Arrays.copyOfRange(completeBytes, 0, 128);
            byte[] second = java.util.Arrays.copyOfRange(completeBytes, 128, 256);
            byte[] finalChunk = java.util.Arrays.copyOfRange(completeBytes, 256, completeBytes.length);
            String expectedDigest = sha256(completeBytes);
            String request = """
                    {"tenantId":"%s","principalId":"%s","fileName":"synthetic.wav",
                     "contentType":"audio/wav","expectedSizeBytes":%d,
                     "expectedSha256":"%s","classification":"CONFIDENTIAL",
                     "retention":"P30D","metadata":{"sourceClockId":"fixture-clock",
                       "sourceClockMappingEvidenceRef":"fixture-clock-evidence",
                       "sourceClockTicksPerSecond":16000,"sourceDurationTicks":16000}}
                    """.formatted(TENANT, PRINCIPAL, completeBytes.length, expectedDigest);
            HttpResponse<String> begun = send(port, TENANT, token, "POST", "/api/v1/artifacts/uploads",
                    request, "application/json", "artifact-intake-restart-" + run);
            assertThat(begun.statusCode()).as(begun.body()).isEqualTo(201);
            String uploadId = JSON.readTree(begun.body()).path("uploadId").asString();
            assertThat(uploadId).isNotBlank();

            JsonNode firstAck = JSON.readTree(sendBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0", first).body());
            assertThat(firstAck.path("bytesReceived").asLong()).isEqualTo(first.length);
            JsonNode secondAck = JSON.readTree(sendBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/1", second).body());
            assertThat(secondAck.path("bytesReceived").asLong()).isEqualTo(first.length + second.length);
            assertThat(secondAck.path("nextChunkIndex").asInt()).isEqualTo(2);

            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            HttpResponse<String> resumed = send(port, TENANT, token, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "", "application/json", null);
            assertThat(resumed.statusCode()).as(resumed.body()).isEqualTo(200);
            JsonNode progress = JSON.readTree(resumed.body());
            assertThat(progress.path("uploadId").asString()).isEqualTo(uploadId);
            assertThat(progress.path("bytesReceived").asLong()).isEqualTo(first.length + second.length);
            assertThat(progress.path("nextChunkIndex").asInt()).isEqualTo(2);

            // J-02 upload identity is scoped by the authenticated tenant/principal pair.
            // Reusing the same client key from another principal must not disclose or
            // resume the original session after the launcher has recreated its runtime.
            String otherPrincipal = "media-upload-other-principal";
            String otherToken = authenticatedJwt(otherPrincipal, TENANT, JWT_SECRET);
            HttpResponse<String> foreignReadback = send(port, TENANT, otherToken, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "", "application/json", null);
            assertThat(foreignReadback.statusCode()).as(foreignReadback.body()).isEqualTo(404);
            String otherRequest = request.replace(PRINCIPAL, otherPrincipal);
            HttpResponse<String> otherBegin = send(port, TENANT, otherToken, "POST", "/api/v1/artifacts/uploads",
                    otherRequest, "application/json", "artifact-intake-restart-" + run);
            assertThat(otherBegin.statusCode()).as(otherBegin.body()).isEqualTo(201);
            String otherUploadId = JSON.readTree(otherBegin.body()).path("uploadId").asString();
            assertThat(otherUploadId).isNotBlank().isNotEqualTo(uploadId);
            HttpResponse<String> otherReadback = send(port, TENANT, otherToken, "GET",
                    "/api/v1/artifacts/uploads/" + otherUploadId, "", "application/json", null);
            assertThat(otherReadback.statusCode()).as(otherReadback.body()).isEqualTo(200);
            assertThat(JSON.readTree(otherReadback.body()).path("principalId").asString())
                    .isEqualTo(otherPrincipal);

            String otherTenant = "tenant-upload-other-scope";
            String otherTenantToken = authenticatedJwt(PRINCIPAL, otherTenant, JWT_SECRET);
            HttpResponse<String> foreignTenantReadback = send(port, otherTenant, otherTenantToken, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "", "application/json", null);
            assertThat(foreignTenantReadback.statusCode()).as(foreignTenantReadback.body()).isEqualTo(404);
            String otherTenantRequest = request.replace(TENANT, otherTenant);
            HttpResponse<String> otherTenantBegin = send(port, otherTenant, otherTenantToken, "POST",
                    "/api/v1/artifacts/uploads", otherTenantRequest, "application/json",
                    "artifact-intake-restart-" + run);
            assertThat(otherTenantBegin.statusCode()).as(otherTenantBegin.body()).isEqualTo(201);
            String otherTenantUploadId = JSON.readTree(otherTenantBegin.body()).path("uploadId").asString();
            assertThat(otherTenantUploadId).isNotBlank().isNotEqualTo(uploadId);

            HttpResponse<String> exactReplay = sendBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0", first);
            assertThat(exactReplay.statusCode()).as(exactReplay.body()).isEqualTo(200);
            HttpResponse<String> conflictingReplay = sendBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0",
                    "conflicting-prefix".getBytes(StandardCharsets.UTF_8));
            assertThat(conflictingReplay.statusCode()).as(conflictingReplay.body()).isEqualTo(409);
            JsonNode unchanged = JSON.readTree(send(port, TENANT, token, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "", "application/json", null).body());
            assertThat(unchanged.path("bytesReceived").asLong()).isEqualTo(first.length + second.length);
            assertThat(unchanged.path("nextChunkIndex").asInt()).isEqualTo(2);

            HttpResponse<String> finalAck = sendBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/2", finalChunk);
            assertThat(finalAck.statusCode()).as(finalAck.body()).isEqualTo(200);
            HttpResponse<String> completed = send(port, TENANT, token, "POST",
                    "/api/v1/artifacts/uploads/" + uploadId + "/complete", "", "application/json", null);
            assertThat(completed.statusCode()).as(completed.body()).isEqualTo(201);
            JsonNode artifact = JSON.readTree(completed.body());
            String artifactId = artifact.path("artifactId").asString();
            objectReference = artifact.path("objectReference").asString();
            assertThat(artifactId).isNotBlank();
            assertThat(artifact.path("sha256").asString()).isEqualTo(expectedDigest);
            assertThat(artifact.path("sizeBytes").asLong()).isEqualTo(completeBytes.length);

            HttpResponse<String> artifactReadback = send(port, TENANT, token, "GET",
                    "/api/v1/artifacts/" + artifactId, "", "application/json", null);
            assertThat(artifactReadback.statusCode()).as(artifactReadback.body()).isEqualTo(200);
            JsonNode durableArtifact = JSON.readTree(artifactReadback.body());
            assertThat(durableArtifact.path("sha256").asString()).isEqualTo(expectedDigest);
            assertThat(durableArtifact.path("sizeBytes").asLong()).isEqualTo(completeBytes.length);
            objectReference = durableArtifact.path("objectReference").asString();

            // This upload uses deterministic synthetic bytes only; it is not source-rights acceptance evidence.
            String objectKey = URI.create(objectReference).getPath().substring(1);
            try (S3Client s3 = s3()) {
                byte[] stored = s3.getObjectAsBytes(GetObjectRequest.builder()
                        .bucket(bucket).key(objectKey).build()).asByteArray();
                assertThat(stored).containsExactly(completeBytes);
                assertThat(sha256(stored)).isEqualTo(expectedDigest);
            }

            // Completion has no caller request key. Recovery is bound to this same upload ID
            // and must return its original artifact identity after a process restart.
            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            HttpResponse<String> completionReplay = send(port, TENANT, token, "POST",
                    "/api/v1/artifacts/uploads/" + uploadId + "/complete", "", "application/json", null);
            assertThat(completionReplay.statusCode()).as(completionReplay.body()).isEqualTo(201);
            JsonNode replayedArtifact = JSON.readTree(completionReplay.body());
            assertThat(replayedArtifact.path("artifactId").asString()).isEqualTo(artifactId);
            assertThat(replayedArtifact.path("objectReference").asString()).isEqualTo(objectReference);
            assertThat(replayedArtifact.path("sha256").asString()).isEqualTo(expectedDigest);

            HttpResponse<String> replayReadback = send(port, TENANT, token, "GET",
                    "/api/v1/artifacts/" + artifactId, "", "application/json", null);
            assertThat(replayReadback.statusCode()).as(replayReadback.body()).isEqualTo(200);
            assertThat(JSON.readTree(replayReadback.body()).path("artifactId").asString()).isEqualTo(artifactId);

            // A syntactically valid WAV with a deliberately false expected digest must never
            // produce an artifact receipt. The upload ID remains the reconciliation identity;
            // this test does not retry completion under a new identity after the terminal reject.
            byte[] corruptBytes = syntheticWav();
            corruptBytes[corruptBytes.length - 1] ^= 0x01;
            String rejectedRequest = """
                    {"tenantId":"%s","principalId":"%s","fileName":"corrupt.wav",
                     "contentType":"audio/wav","expectedSizeBytes":%d,
                     "expectedSha256":"%s","classification":"CONFIDENTIAL",
                     "retention":"P30D","metadata":{}}
                    """.formatted(TENANT, PRINCIPAL, corruptBytes.length, sha256(syntheticWav()));
            HttpResponse<String> rejectedBegin = send(port, TENANT, token, "POST", "/api/v1/artifacts/uploads",
                    rejectedRequest, "application/json", "artifact-intake-corrupt-" + run);
            assertThat(rejectedBegin.statusCode()).as(rejectedBegin.body()).isEqualTo(201);
            String rejectedUploadId = JSON.readTree(rejectedBegin.body()).path("uploadId").asString();
            HttpResponse<String> corruptChunk = sendBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + rejectedUploadId + "/chunks/0", corruptBytes);
            assertThat(corruptChunk.statusCode()).as(corruptChunk.body()).isEqualTo(200);
            HttpResponse<String> rejectedCompletion = send(port, TENANT, token, "POST",
                    "/api/v1/artifacts/uploads/" + rejectedUploadId + "/complete", "", "application/json", null);
            assertThat(rejectedCompletion.statusCode()).as(rejectedCompletion.body()).isEqualTo(409);
            assertThat(rejectedCompletion.body()).contains("MEDIA_STATE_CONFLICT");

            // A checksum-rejected upload remains terminal across process recreation:
            // the same identity cannot accept more parts or be finalized into a receipt.
            stopLauncher(launcher);
            launcher = null;
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);
            HttpResponse<String> rejectedAppend = sendBytes(port, TENANT, token, "PUT",
                    "/api/v1/artifacts/uploads/" + rejectedUploadId + "/chunks/1",
                    new byte[] { 1, 2, 3 });
            assertThat(rejectedAppend.statusCode()).as(rejectedAppend.body()).isEqualTo(409);
            HttpResponse<String> rejectedCompletionReplay = send(port, TENANT, token, "POST",
                    "/api/v1/artifacts/uploads/" + rejectedUploadId + "/complete", "", "application/json", null);
            assertThat(rejectedCompletionReplay.statusCode()).as(rejectedCompletionReplay.body()).isEqualTo(409);
            assertThat(rejectedCompletionReplay.body()).contains("MEDIA_STATE_CONFLICT");

            String absentArtifactId = UUID.randomUUID().toString();
            HttpResponse<String> absentArtifact = send(port, TENANT, token, "GET",
                    "/api/v1/artifacts/" + absentArtifactId, "", "application/json", null);
            assertThat(absentArtifact.statusCode()).as(absentArtifact.body()).isEqualTo(404);
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
                        if (services != null && Files.exists(services)) {
                            try (var paths = Files.walk(services)) {
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
        env.put("MEDIA_JWT_HMAC_SECRET_REFERENCE", "secret:env:MEDIA_LAUNCHER_TEST_JWT_SECRET");
        env.put("MEDIA_JWT_ISSUER", "https://issuer.example");
        env.put("MEDIA_JWT_AUDIENCE", "ghatana-runtime");
        env.put("MEDIA_LAUNCHER_TEST_JWT_SECRET", JWT_SECRET);
        return env;
    }

    private static void installChildServiceDescriptors(Path root) throws Exception {
        Path services = root.resolve("META-INF/services");
        Files.createDirectories(services);
        Files.writeString(services.resolve("com.ghatana.governance.PolicyEngine"),
                MediaLauncherProcessFixtures.Policy.class.getName() + "\n");
        Files.writeString(services.resolve(
                "com.ghatana.media.runtime.MediaRuntimeContracts$MediaProcessingProvider"),
                MediaLauncherProcessFixtures.Stt.class.getName() + "\n");
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

    private static HttpResponse<String> send(int port, String tenant, String token, String method,
            String path, String body, String contentType, String idempotencyKey) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("X-Tenant-Id", tenant).header("Authorization", "Bearer " + token);
        if (contentType != null) request.header("Content-Type", contentType);
        if (idempotencyKey != null) request.header("Idempotency-Key", idempotencyKey);
        if ("POST".equals(method)) request.POST(HttpRequest.BodyPublishers.ofString(body));
        else if ("GET".equals(method)) request.GET();
        else throw new IllegalArgumentException("Unsupported bodyless method: " + method);
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static HttpResponse<String> sendBytes(int port, String tenant, String token, String method,
            String path, byte[] bytes) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("X-Tenant-Id", tenant).header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/octet-stream")
                .method(method, HttpRequest.BodyPublishers.ofByteArray(bytes)).build();
        return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static String authenticatedJwt(String subject, String tenant, String secret) throws Exception {
        String header = base64Url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissions = UPLOAD_PERMISSIONS.stream().sorted()
                .map(permission -> "\"" + permission + "\"")
                .collect(java.util.stream.Collectors.joining(","));
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
            // Bucket is unique to this Testcontainers run; container teardown remains the final cleanup.
        }
    }

    private static byte[] syntheticWav() {
        int samples = 16_000;
        byte[] wav = new byte[44 + samples * 2];
        java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(wav).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        buffer.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(wav.length - 8)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1)
                .putShort((short) 1).putInt(16_000).putInt(32_000).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples * 2);
        return wav;
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
