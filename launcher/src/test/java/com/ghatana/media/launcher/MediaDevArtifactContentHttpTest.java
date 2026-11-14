package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** DEV_ONLY exact-byte artifact content read (full, ranged, version-pinned, bounded) through the real HTTP host. */
class MediaDevArtifactContentHttpTest {
    private static final String TENANT = "tenant-local";
    private static final String PRINCIPAL = "principal-local";
    private static final String OTHER = "principal-other";
    private static final String SECRET = "test-only-dev-project-secret-at-least-32-bytes";
    private static final java.time.Clock CLOCK =
            java.time.Clock.fixed(Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC);
    private static final Set<String> ALL = Set.of("media:project:dev:read", "media:artifact:read");
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    @Test
    void servesExactBytesFullAndRangedWithSafeHeaders() throws Exception {
        Path root = Files.createTempDirectory("media-dev-content-");
        MediaRuntime runtime = runtime(root);
        HttpServer server = server(runtime, 1024);
        try {
            byte[] bytes = new byte[300];
            for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) (i * 7);
            MediaArtifact png = upload(runtime, "pic.png", "image/png", bytes);
            String path = "/dev/v1/artifacts/" + png.artifactId() + "/content?version=" + png.version().value();

            HttpResponse<byte[]> full = get(server, path, PRINCIPAL, ALL, Map.of());
            assertThat(full.statusCode()).isEqualTo(200);
            assertThat(full.body()).isEqualTo(bytes);
            assertThat(full.headers().firstValue("Content-Type")).contains("image/png");
            assertThat(full.headers().firstValue("Content-Length")).contains("300");
            assertThat(full.headers().firstValue("ETag")).contains("\"" + png.version().value() + "\"");
            assertThat(full.headers().firstValue("Cache-Control")).contains("private, no-store");
            assertThat(full.headers().firstValue("X-Content-Type-Options")).contains("nosniff");
            assertThat(full.headers().firstValue("Accept-Ranges")).contains("bytes");
            assertThat(full.headers().firstValue("Content-Disposition")).contains("inline");

            HttpResponse<byte[]> mid = get(server, path, PRINCIPAL, ALL, Map.of("Range", "bytes=10-19"));
            assertThat(mid.statusCode()).isEqualTo(206);
            assertThat(mid.body()).isEqualTo(Arrays.copyOfRange(bytes, 10, 20));
            assertThat(mid.headers().firstValue("Content-Range")).contains("bytes 10-19/300");
            assertThat(mid.headers().firstValue("Content-Length")).contains("10");

            HttpResponse<byte[]> open = get(server, path, PRINCIPAL, ALL, Map.of("Range", "bytes=290-"));
            assertThat(open.statusCode()).isEqualTo(206);
            assertThat(open.body()).isEqualTo(Arrays.copyOfRange(bytes, 290, 300));
            assertThat(open.headers().firstValue("Content-Range")).contains("bytes 290-299/300");

            HttpResponse<byte[]> last = get(server, path, PRINCIPAL, ALL, Map.of("Range", "bytes=299-299"));
            assertThat(last.statusCode()).isEqualTo(206);
            assertThat(last.body()).containsExactly(bytes[299]);

            HttpResponse<byte[]> clipped = get(server, path, PRINCIPAL, ALL, Map.of("Range", "bytes=295-9999"));
            assertThat(clipped.statusCode()).isEqualTo(206);
            assertThat(clipped.headers().firstValue("Content-Range")).contains("bytes 295-299/300");

            HttpResponse<byte[]> suffix = get(server, path, PRINCIPAL, ALL, Map.of("Range", "bytes=-5"));
            assertThat(suffix.statusCode()).isEqualTo(206);
            assertThat(suffix.body()).isEqualTo(Arrays.copyOfRange(bytes, 295, 300));

            for (String bad : List.of("bytes=300-", "bytes=500-600", "bytes=20-10", "bytes=0-1,5-6", "items=0-1")) {
                HttpResponse<byte[]> unsatisfiable = get(server, path, PRINCIPAL, ALL, Map.of("Range", bad));
                assertThat(unsatisfiable.statusCode()).as(bad).isEqualTo(416);
                assertThat(unsatisfiable.headers().firstValue("Content-Range")).contains("bytes */300");
                assertThat(code(unsatisfiable)).isEqualTo("RANGE_NOT_SATISFIABLE");
            }

            // If-Match alone (quoted ETag) is an explicit version; agreement with the query is allowed.
            String bare = "/dev/v1/artifacts/" + png.artifactId() + "/content";
            assertThat(get(server, bare, PRINCIPAL, ALL, Map.of("If-Match", "\"" + png.version().value() + "\""))
                    .body()).isEqualTo(bytes);
            assertThat(get(server, path, PRINCIPAL, ALL, Map.of("If-Match", png.version().value())).statusCode())
                    .isEqualTo(200);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void refusesMissingStaleOrForeignVersionAndHidesForeignOwners() throws Exception {
        Path root = Files.createTempDirectory("media-dev-content-deny-");
        MediaRuntime runtime = runtime(root);
        HttpServer server = server(runtime, 1024);
        try {
            MediaArtifact art = upload(runtime, "a.bin", "application/octet-stream", "hello world".getBytes(StandardCharsets.UTF_8));
            String bare = "/dev/v1/artifacts/" + art.artifactId() + "/content";
            String version = "?version=" + art.version().value();

            HttpResponse<byte[]> missing = get(server, bare, PRINCIPAL, ALL, Map.of());
            assertThat(missing.statusCode()).isEqualTo(400);
            assertThat(code(missing)).isEqualTo("ARTIFACT_VERSION_REQUIRED");

            HttpResponse<byte[]> malformed = get(server, bare + "?version=nope", PRINCIPAL, ALL, Map.of());
            assertThat(malformed.statusCode()).isEqualTo(400);
            assertThat(code(malformed)).isEqualTo("ARTIFACT_VERSION_INVALID");

            HttpResponse<byte[]> stale = get(server, bare + "?version=sha256:" + "0".repeat(64), PRINCIPAL, ALL, Map.of());
            assertThat(stale.statusCode()).isEqualTo(412);
            assertThat(code(stale)).isEqualTo("ARTIFACT_VERSION_MISMATCH");

            HttpResponse<byte[]> disagree = get(server, bare + version, PRINCIPAL, ALL,
                    Map.of("If-Match", "sha256:" + "1".repeat(64)));
            assertThat(disagree.statusCode()).isEqualTo(412);

            HttpResponse<byte[]> foreign = get(server, bare + version, OTHER, ALL, Map.of());
            assertThat(foreign.statusCode()).isEqualTo(404);
            HttpResponse<byte[]> unknown = get(server, "/dev/v1/artifacts/does-not-exist/content" + version,
                    PRINCIPAL, ALL, Map.of());
            assertThat(unknown.statusCode()).isEqualTo(404);
            assertThat(new String(foreign.body(), StandardCharsets.UTF_8))
                    .doesNotContain("hello").doesNotContain(art.sha256());

            // Filter permission missing -> 403; handler artifact permission missing -> 403.
            assertThat(get(server, bare + version, PRINCIPAL, Set.of("media:artifact:read"), Map.of()).statusCode())
                    .isEqualTo(403);
            HttpResponse<byte[]> noArtifact = get(server, bare + version, PRINCIPAL,
                    Set.of("media:project:dev:read"), Map.of());
            assertThat(noArtifact.statusCode()).isEqualTo(403);
            assertThat(code(noArtifact)).isEqualTo("ARTIFACT_PERMISSION_REQUIRED");
        } finally {
            server.stop(0);
        }
    }

    @Test
    void enforcesCeilingAndAttachmentDispositionForUnsafeTypes() throws Exception {
        Path root = Files.createTempDirectory("media-dev-content-ceiling-");
        MediaRuntime runtime = runtime(root);
        HttpServer server = server(runtime, 64);
        try {
            byte[] big = new byte[200];
            Arrays.fill(big, (byte) 'x');
            MediaArtifact html = upload(runtime, "evil\"name.html", "text/html", big);
            String path = "/dev/v1/artifacts/" + html.artifactId() + "/content?version=" + html.version().value();

            HttpResponse<byte[]> over = get(server, path, PRINCIPAL, ALL, Map.of());
            assertThat(over.statusCode()).isEqualTo(413);
            assertThat(code(over)).isEqualTo("ARTIFACT_CONTENT_TOO_LARGE");
            assertThat(new String(over.body(), StandardCharsets.UTF_8)).doesNotContain("xxxxxxxx");

            HttpResponse<byte[]> bigRange = get(server, path, PRINCIPAL, ALL, Map.of("Range", "bytes=0-99"));
            assertThat(bigRange.statusCode()).isEqualTo(413);

            HttpResponse<byte[]> ok = get(server, path, PRINCIPAL, ALL, Map.of("Range", "bytes=0-63"));
            assertThat(ok.statusCode()).isEqualTo(206);
            assertThat(ok.body()).hasSize(64);
            assertThat(ok.headers().firstValue("Content-Type")).contains("text/html");
            assertThat(ok.headers().firstValue("Content-Disposition").orElseThrow())
                    .startsWith("attachment; filename=\"").doesNotContain("evil\"name");
            assertThat(ok.headers().firstValue("X-Content-Type-Options")).contains("nosniff");

            assertThat(MediaDevArtifactContentRoutes.inlineSafe("video/mp4")).isTrue();
            assertThat(MediaDevArtifactContentRoutes.inlineSafe("audio/wav; charset=x")).isTrue();
            assertThat(MediaDevArtifactContentRoutes.inlineSafe("image/svg+xml")).isFalse();
            assertThat(MediaDevArtifactContentRoutes.inlineSafe("model/gltf-binary")).isFalse();
            assertThat(MediaDevArtifactContentRoutes.inlineSafe("application/pdf")).isFalse();

            HttpResponse<byte[]> post = send(server, "POST", path, PRINCIPAL, ALL, Map.of());
            assertThat(post.statusCode()).isIn(403, 405);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void releasesNoBytesWhenStoredContentFailsVerification() throws Exception {
        Path root = Files.createTempDirectory("media-dev-content-corrupt-");
        var fileStore = new LocalMediaRuntimeSupport.FileArtifactStore(root);
        // Readiness probes would otherwise mask the content-verification path under test.
        com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore alwaysReady =
                (com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore) java.lang.reflect.Proxy
                        .newProxyInstance(getClass().getClassLoader(),
                                new Class<?>[] {com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore.class},
                                (proxy, method, args) -> {
                                    if ("ready".equals(method.getName())) return true;
                                    try { return method.invoke(fileStore, args); }
                                    catch (java.lang.reflect.InvocationTargetException e) { throw e.getCause(); }
                                });
        MediaRuntime runtime = runtime(root, alwaysReady);
        HttpServer server = server(runtime, 1024);
        try {
            byte[] bytes = "0123456789".repeat(10).getBytes(StandardCharsets.UTF_8);
            MediaArtifact art = upload(runtime, "c.bin", "application/octet-stream", bytes);
            String path = "/dev/v1/artifacts/" + art.artifactId() + "/content?version=" + art.version().value();
            assertThat(get(server, path, PRINCIPAL, ALL, Map.of()).statusCode()).isEqualTo(200);
            // Corrupt every stored object file in place (same length, different bytes).
            try (var files = Files.walk(root.resolve("artifacts"))) {
                for (Path file : files.filter(Files::isRegularFile)
                        .filter(f -> {
                            try { return Files.size(f) == bytes.length; } catch (Exception e) { return false; }
                        }).toList()) {
                    byte[] flipped = Files.readAllBytes(file);
                    flipped[0] ^= 0x55;
                    Files.write(file, flipped);
                }
            }
            for (Map<String, String> headers : List.of(Map.<String, String>of(), Map.of("Range", "bytes=0-9"))) {
                HttpResponse<byte[]> corrupt = get(server, path, PRINCIPAL, ALL, headers);
                assertThat(corrupt.statusCode()).isIn(409, 500);
                assertThat(code(corrupt)).isEqualTo("ARTIFACT_CONTENT_INTEGRITY_FAILED");
                assertThat(new String(corrupt.body(), StandardCharsets.UTF_8)).doesNotContain("0123456789");
                assertThat(corrupt.headers().firstValue("Content-Range")).isEmpty();
            }
        } finally {
            server.stop(0);
        }
    }

    // ---------- helpers ----------

    private static String code(HttpResponse<byte[]> response) throws Exception {
        Map<String, Object> body = JSON.readValue(response.body(), new TypeReference<Map<String, Object>>() { });
        @SuppressWarnings("unchecked") Map<String, Object> error = (Map<String, Object>) body.get("error");
        return (String) error.get("code");
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes)
            throws Exception {
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, name, contentType, bytes.length,
                digest, "INTERNAL", Duration.ofMinutes(30), Map.of()), "key-" + name + bytes.length);
        int chunk = runtime.config().maximumChunkBytes();
        for (int offset = 0, index = 0; offset < bytes.length; offset += chunk, index++) {
            runtime.appendChunk(TENANT, PRINCIPAL, session.uploadId(), index,
                    Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + chunk)));
        }
        return runtime.completeUpload(TENANT, PRINCIPAL, session.uploadId());
    }

    private static MediaRuntime runtime(Path root) {
        return runtime(root, new LocalMediaRuntimeSupport.FileArtifactStore(root));
    }

    private static MediaRuntime runtime(Path root,
            com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore store) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 1_048_576, 131_072, 1_048_576,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                store,
                new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new NoEffectProvider()), List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static HttpServer server(MediaRuntime runtime, long ceiling) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, null, (MediaDevReviewRuntime) null)
                .withDevArtifactContentCeiling(ceiling);
        server.createContext("/", new MediaSecurityFilter(handler, "dev",
                Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true", "MEDIA_DEV_JWT_HMAC_SECRET", SECRET), CLOCK));
        server.start();
        return server;
    }

    private static HttpResponse<byte[]> get(HttpServer server, String path, String principal, Set<String> permissions,
                                            Map<String, String> headers) throws Exception {
        return send(server, "GET", path, principal, permissions, headers);
    }

    private static HttpResponse<byte[]> send(HttpServer server, String method, String path, String principal,
                                             Set<String> permissions, Map<String, String> headers) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + server.getAddress().getPort() + path))
                .header("Authorization", "Bearer " + token(principal, permissions))
                .header("X-Tenant-Id", TENANT);
        headers.forEach(request::header);
        request.method(method, HttpRequest.BodyPublishers.noBody());
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    private static String token(String principal, Set<String> permissions) throws Exception {
        String permissionJson = permissions.stream().sorted().map(p -> "\"" + p + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = "{\"sub\":\"" + principal + "\",\"tenant_id\":\"" + TENANT
                + "\",\"iss\":\"urn:ghatana:media:dev-only\",\"aud\":\"ghatana-media-dev\",\"dev_only\":true,"
                + "\"iat\":" + CLOCK.instant().getEpochSecond() + ",\"exp\":"
                + CLOCK.instant().plusSeconds(120).getEpochSecond() + ",\"permissions\":[" + permissionJson + "]}";
        String signingInput = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}") + "." + encode(payload);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static final class NoEffectProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "dev-content-http-no-effect"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public java.util.concurrent.CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return java.util.concurrent.CompletableFuture.failedFuture(new AssertionError("content reads must not process"));
        }
    }
}
