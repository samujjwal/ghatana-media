package com.ghatana.media.launcher;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.Map;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Exercises authenticated resumable artifact intake through the declared HTTP routes. */
class MediaHttpUploadJourneyTest {
    private static final String TENANT = "http-upload-tenant";
    private static final String PRINCIPAL = "http-upload-owner";
    private static final String SECRET = "media-http-upload-test-secret-0123456789";
    private static final String ISSUER = "https://media-http-upload.example";
    private static final String AUDIENCE = "media-http-upload";
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-05T20:00:00Z"), ZoneOffset.UTC);
    private static final Set<String> PERMISSIONS = Set.of(
            "media:artifact:create", "media:artifact:read", "media:artifact:write");
    private static final JsonMapper JSON = JsonMapper.builder()
            .addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();

    @Test
    void authenticatedUploadResumesExactChunkAndPublishesOnlyMatchingArtifactVersion() throws Exception {
        Path root = Files.createTempDirectory("media-http-upload-journey-");
        byte[] first = "first-source-range/".getBytes(StandardCharsets.UTF_8);
        byte[] second = "second-source-range".getBytes(StandardCharsets.UTF_8);
        byte[] complete = new byte[first.length + second.length];
        System.arraycopy(first, 0, complete, 0, first.length);
        System.arraycopy(second, 0, complete, first.length, second.length);
        HttpServer firstServer = null;
        HttpServer restartedServer = null;
        MediaRuntime firstRuntime = null;
        MediaRuntime restartedRuntime = null;
        try {
            firstRuntime = runtime(root);
            firstServer = server(firstRuntime);
            String firstBase = base(firstServer);
            UploadRequest request = new UploadRequest(TENANT, PRINCIPAL, "source.wav", "audio/wav",
                    complete.length, sha256(complete), "INTERNAL", Duration.ofMinutes(10), Map.of());
            HttpResponse<String> created = send(firstBase, "POST", "/api/v1/artifacts/uploads",
                    JSON.writeValueAsBytes(request), PRINCIPAL, PERMISSIONS, "application/json", "upload-key-1");
            assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
            String uploadId = JSON.readTree(created.body()).path("uploadId").asString();
            assertThat(uploadId).isNotBlank();

            HttpResponse<String> firstAccepted = send(firstBase, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0", first,
                    PRINCIPAL, PERMISSIONS, "application/octet-stream", null);
            assertThat(firstAccepted.statusCode()).as(firstAccepted.body()).isEqualTo(200);
            assertThat(JSON.readTree(firstAccepted.body()).path("bytesReceived").asLong()).isEqualTo(first.length);

            HttpResponse<String> foreignAppend = send(firstBase, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/1", second,
                    "different-principal", Set.of("media:artifact:write"), "application/octet-stream", null);
            assertThat(foreignAppend.statusCode()).isEqualTo(404);
            assertThat(foreignAppend.body()).doesNotContain(uploadId);
            HttpResponse<String> afterForeignAppend = send(firstBase, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, new byte[0], PRINCIPAL,
                    Set.of("media:artifact:read"), null, null);
            assertThat(JSON.readTree(afterForeignAppend.body()).path("bytesReceived").asLong()).isEqualTo(first.length);
            assertThat(JSON.readTree(afterForeignAppend.body()).path("nextChunkIndex").asInt()).isEqualTo(1);

            HttpResponse<String> foreignRead = send(firstBase, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, "".getBytes(StandardCharsets.UTF_8),
                    "different-principal", Set.of("media:artifact:read"), null, null);
            assertThat(foreignRead.statusCode()).isEqualTo(404);
            assertThat(foreignRead.body()).doesNotContain(uploadId);

            firstServer.stop(0);
            firstServer = null;
            firstRuntime.close();
            firstRuntime = null;

            restartedRuntime = runtime(root);
            restartedServer = server(restartedRuntime);
            String restartedBase = base(restartedServer);
            HttpResponse<String> resumed = send(restartedBase, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, new byte[0], PRINCIPAL,
                    Set.of("media:artifact:read"), null, null);
            assertThat(resumed.statusCode()).as(resumed.body()).isEqualTo(200);
            assertThat(JSON.readTree(resumed.body()).path("bytesReceived").asLong()).isEqualTo(first.length);
            assertThat(JSON.readTree(resumed.body()).path("nextChunkIndex").asInt()).isEqualTo(1);

            // J-02 permission-revoked path: the same principal can still inspect the
            // stable session, but a token without write authority cannot add a part.
            HttpResponse<String> revokedAppend = send(restartedBase, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/1", second,
                    PRINCIPAL, Set.of("media:artifact:read"), "application/octet-stream", null);
            assertThat(revokedAppend.statusCode()).as(revokedAppend.body()).isEqualTo(403);
            HttpResponse<String> afterRevokedAppend = send(restartedBase, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, new byte[0], PRINCIPAL,
                    Set.of("media:artifact:read"), null, null);
            assertThat(afterRevokedAppend.statusCode()).isEqualTo(200);
            assertThat(JSON.readTree(afterRevokedAppend.body()).path("bytesReceived").asLong())
                    .isEqualTo(first.length);
            assertThat(JSON.readTree(afterRevokedAppend.body()).path("nextChunkIndex").asInt())
                    .isEqualTo(1);

            HttpResponse<String> exactReplay = send(restartedBase, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0", first,
                    PRINCIPAL, Set.of("media:artifact:write"), "application/octet-stream", null);
            assertThat(exactReplay.statusCode()).as(exactReplay.body()).isEqualTo(200);
            assertThat(JSON.readTree(exactReplay.body()).path("bytesReceived").asLong()).isEqualTo(first.length);
            assertThat(JSON.readTree(exactReplay.body()).path("nextChunkIndex").asInt()).isEqualTo(1);

            HttpResponse<String> conflictingReplay = send(restartedBase, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0", "corrupt-range".getBytes(StandardCharsets.UTF_8),
                    PRINCIPAL, Set.of("media:artifact:write"), "application/octet-stream", null);
            assertThat(conflictingReplay.statusCode()).isEqualTo(409);
            HttpResponse<String> afterConflict = send(restartedBase, "GET",
                    "/api/v1/artifacts/uploads/" + uploadId, new byte[0], PRINCIPAL,
                    Set.of("media:artifact:read"), null, null);
            assertThat(JSON.readTree(afterConflict.body()).path("bytesReceived").asLong()).isEqualTo(first.length);
            assertThat(JSON.readTree(afterConflict.body()).path("nextChunkIndex").asInt()).isEqualTo(1);

            HttpResponse<String> secondAccepted = send(restartedBase, "PUT",
                    "/api/v1/artifacts/uploads/" + uploadId + "/chunks/1", second,
                    PRINCIPAL, Set.of("media:artifact:write"), "application/octet-stream", null);
            assertThat(secondAccepted.statusCode()).as(secondAccepted.body()).isEqualTo(200);
            HttpResponse<String> completed = send(restartedBase, "POST",
                    "/api/v1/artifacts/uploads/" + uploadId + "/complete", new byte[0],
                    PRINCIPAL, Set.of("media:artifact:write"), null, null);
            assertThat(completed.statusCode()).as(completed.body()).isEqualTo(201);
            JsonNode artifact = JSON.readTree(completed.body());
            assertThat(artifact.path("tenantId").asString()).isEqualTo(TENANT);
            assertThat(artifact.path("principalId").asString()).isEqualTo(PRINCIPAL);
            assertThat(artifact.path("sizeBytes").asLong()).isEqualTo(complete.length);
            assertThat(artifact.path("sha256").asString()).isEqualTo(sha256(complete));

            HttpResponse<String> readback = send(restartedBase, "GET",
                    "/api/v1/artifacts/" + artifact.path("artifactId").asString(), new byte[0],
                    PRINCIPAL, Set.of("media:artifact:read"), null, null);
            assertThat(readback.statusCode()).as(readback.body()).isEqualTo(200);
            assertThat(JSON.readTree(readback.body()).path("sha256").asString()).isEqualTo(sha256(complete));
        } finally {
            if (firstServer != null) firstServer.stop(0);
            if (restartedServer != null) restartedServer.stop(0);
            if (firstRuntime != null) firstRuntime.close();
            if (restartedRuntime != null) restartedRuntime.close();
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }

    @Test
    void duplicateIdempotencyKeyHeadersAreRejectedBeforeUploadCreation() throws Exception {
        Path root = Files.createTempDirectory("media-http-upload-duplicate-key-");
        MediaRuntime runtime = runtime(root);
        HttpServer server = null;
        try {
            server = server(runtime);
            byte[] content = "valid-upload".getBytes(StandardCharsets.UTF_8);
            UploadRequest request = new UploadRequest(TENANT, PRINCIPAL, "source.wav", "audio/wav",
                    content.length, sha256(content), "INTERNAL", Duration.ofMinutes(10), Map.of());
            HttpRequest duplicateKeyRequest = HttpRequest.newBuilder(
                            URI.create(base(server) + "/api/v1/artifacts/uploads"))
                    .header("Authorization", "Bearer " + signedJwt(PRINCIPAL, PERMISSIONS))
                    .header("X-Tenant-Id", TENANT)
                    .header("Content-Type", "application/json")
                    .header("Idempotency-Key", "upload-key-first")
                    .header("Idempotency-Key", "upload-key-second")
                    .POST(HttpRequest.BodyPublishers.ofByteArray(JSON.writeValueAsBytes(request)))
                    .build();

            HttpResponse<String> response = HttpClient.newHttpClient().send(
                    duplicateKeyRequest, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));

            assertThat(response.statusCode()).as(response.body()).isEqualTo(400);
            try (var uploadFiles = Files.list(root.resolve("uploads"))) {
                assertThat(uploadFiles.count()).isZero();
            }

            HttpResponse<String> singleKey = send(base(server), "POST", "/api/v1/artifacts/uploads",
                    JSON.writeValueAsBytes(request), PRINCIPAL, PERMISSIONS, "application/json", "upload-key-first");
            assertThat(singleKey.statusCode()).as(singleKey.body()).isEqualTo(201);
        } finally {
            if (server != null) server.stop(0);
            runtime.close();
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }

    private static MediaRuntime runtime(Path root) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "test", 8093, 1_024, 128, 1_024,
                        Duration.ofSeconds(2), 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                java.util.List.of(new NoEffectProvider()),
                java.util.List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static HttpServer server(MediaRuntime runtime) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", new MediaSecurityFilter(
                new MediaHttpHandler(runtime), "test", jwtEnvironment(), CLOCK));
        server.start();
        return server;
    }

    private static String base(HttpServer server) {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static HttpResponse<String> send(String base, String method, String path, byte[] body,
            String principal, Set<String> permissions, String contentType, String idempotencyKey) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(base + path))
                .header("Authorization", "Bearer " + signedJwt(principal, permissions))
                .header("X-Tenant-Id", TENANT);
        if (contentType != null) builder.header("Content-Type", contentType);
        if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey);
        HttpRequest.BodyPublisher publisher = body.length == 0
                ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body);
        builder.method(method, publisher);
        return HttpClient.newHttpClient().send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static String signedJwt(String principal, Set<String> permissions) throws Exception {
        String header = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String claims = permissions.stream().sorted().map(permission -> "\"" + permission + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = encode("{\"sub\":\"" + principal + "\",\"tenant_id\":\"" + TENANT
                + "\",\"iss\":\"" + ISSUER + "\",\"aud\":\"" + AUDIENCE + "\",\"exp\":"
                + CLOCK.instant().plusSeconds(300).getEpochSecond() + ",\"permissions\":[" + claims + "]}");
        String signingInput = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static Map<String, String> jwtEnvironment() {
        return Map.of("MEDIA_JWT_HMAC_SECRET_REFERENCE", "secret:env:JWT_SECRET",
                "MEDIA_JWT_ISSUER", ISSUER, "MEDIA_JWT_AUDIENCE", AUDIENCE, "JWT_SECRET", SECRET);
    }

    private static String sha256(byte[] content) throws Exception {
        return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content));
    }

    private static final class NoEffectProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "http-upload-no-effect"; }
        @Override public String providerVersion() { return "test-only"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public java.util.concurrent.CompletableFuture<Map<String, Object>> process(
                ProcessingContext context) {
            throw new AssertionError("artifact upload must not invoke a processing provider");
        }
    }
}
