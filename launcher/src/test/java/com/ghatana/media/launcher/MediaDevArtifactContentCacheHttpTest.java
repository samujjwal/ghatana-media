package com.ghatana.media.launcher;

import com.ghatana.audio.video.infrastructure.cache.RightsAwareContentCache;
import com.ghatana.media.runtime.InMemoryMediaRightsAttestationStore;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationStore;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.StatementKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore;
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
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
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
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The rights-aware content cache behind the DEV_ONLY content route (in-process HTTP host, real file artifact store
 * and attestation store): hit and miss, ranges from a cached full read, revocation and erasure invalidation, a new
 * version, and fail-closed behavior when the artifact or rights authority cannot be read.
 */
class MediaDevArtifactContentCacheHttpTest {
    private static final String TENANT = "tenant-local";
    private static final String PRINCIPAL = "principal-local";
    private static final String OTHER = "principal-other";
    private static final String SECRET = "test-only-dev-project-secret-at-least-32-bytes";
    private static final java.time.Clock CLOCK =
            java.time.Clock.fixed(Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC);
    private static final Set<String> ALL = Set.of("media:project:dev:read", "media:artifact:read");
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    /** Wraps a real store: counts content reads and can simulate an unreachable artifact authority. */
    private static final class Probe {
        final AtomicInteger contentReads = new AtomicInteger();
        final AtomicBoolean artifactDown = new AtomicBoolean();
        final AtomicBoolean rightsDown = new AtomicBoolean();
    }

    private static MediaArtifactStore probed(MediaArtifactStore real, Probe probe) {
        return (MediaArtifactStore) Proxy.newProxyInstance(MediaArtifactStore.class.getClassLoader(),
                new Class<?>[] {MediaArtifactStore.class}, (proxy, method, args) -> {
                    if (method.getName().equals("copyContent")) probe.contentReads.incrementAndGet();
                    if (method.getName().equals("artifact") && probe.artifactDown.get()) {
                        throw new IllegalStateException("artifact authority unreachable");
                    }
                    try { return method.invoke(real, args); }
                    catch (InvocationTargetException failure) { throw failure.getCause(); }
                });
    }

    private static AttestationStore probed(AttestationStore real, Probe probe) {
        return (AttestationStore) Proxy.newProxyInstance(AttestationStore.class.getClassLoader(),
                new Class<?>[] {AttestationStore.class}, (proxy, method, args) -> {
                    if (method.getName().equals("listForArtifact") && probe.rightsDown.get()) {
                        throw new IllegalStateException("rights authority unreachable");
                    }
                    try { return method.invoke(real, args); }
                    catch (InvocationTargetException failure) { throw failure.getCause(); }
                });
    }

    private record Fixture(MediaRuntime runtime, MediaDevRightsRuntime rights, MediaDevArtifactContentCache cache,
                           HttpServer server, Probe probe) { }

    private static Fixture fixture(Path root) throws Exception {
        Probe probe = new Probe();
        MediaRuntime runtime = runtime(root, probed(new LocalMediaRuntimeSupport.FileArtifactStore(root), probe));
        MediaDevRightsRuntime rights = new MediaDevRightsRuntime(runtime,
                probed(new InMemoryMediaRightsAttestationStore(), probe), CLOCK);
        MediaDevArtifactContentCache cache = MediaDevArtifactContentCache.compose(
                Map.of(MediaDevArtifactContentCache.ENABLED, "true"), runtime, rights);
        return new Fixture(runtime, rights, cache, server(runtime, 4096, cache), probe);
    }

    private static String contentPath(MediaArtifact artifact) {
        return "/dev/v1/artifacts/" + artifact.artifactId() + "/content?version=" + artifact.version().value();
    }

    @Test
    void secondReadIsServedFromTheCacheWithoutReadingTheSourceAndRangesSliceTheCachedVerifiedBytes() throws Exception {
        Fixture f = fixture(Files.createTempDirectory("media-dev-content-cache-"));
        try {
            byte[] bytes = new byte[600];
            for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) (i * 11);
            MediaArtifact art = upload(f.runtime(), "pic.png", "image/png", bytes);
            String path = contentPath(art);

            HttpResponse<byte[]> first = get(f.server(), path, PRINCIPAL, ALL, Map.of());
            assertThat(first.statusCode()).isEqualTo(200);
            assertThat(first.body()).isEqualTo(bytes);
            assertThat(first.headers().firstValue("X-Media-Content-Cache")).contains("MISS");
            assertThat(f.probe().contentReads).hasValue(1);

            HttpResponse<byte[]> second = get(f.server(), path, PRINCIPAL, ALL, Map.of());
            assertThat(second.body()).isEqualTo(bytes);
            assertThat(second.headers().firstValue("X-Media-Content-Cache")).contains("HIT");
            HttpResponse<byte[]> ranged = get(f.server(), path, PRINCIPAL, ALL, Map.of("Range", "bytes=100-199"));
            assertThat(ranged.statusCode()).isEqualTo(206);
            assertThat(ranged.body()).isEqualTo(Arrays.copyOfRange(bytes, 100, 200));
            assertThat(ranged.headers().firstValue("Content-Range")).contains("bytes 100-199/600");
            assertThat(ranged.headers().firstValue("X-Media-Content-Cache")).contains("HIT");
            assertThat(f.probe().contentReads).as("the source was verified exactly once").hasValue(1);
            assertThat(f.cache().stats().hits()).isEqualTo(2);
            // Existing contract still holds on a hit: version pin, ownership, ceiling.
            assertThat(get(f.server(), "/dev/v1/artifacts/" + art.artifactId() + "/content?version=sha256:" + "0".repeat(64),
                    PRINCIPAL, ALL, Map.of()).statusCode()).isEqualTo(412);
            assertThat(get(f.server(), path, OTHER, ALL, Map.of()).statusCode()).isEqualTo(404);
            assertThat(get(f.server(), path, PRINCIPAL, ALL, Map.of("Range", "bytes=600-")).statusCode()).isEqualTo(416);
        } finally { f.server().stop(0); f.cache().close(); }
    }

    @Test
    void revokingAStatementDropsTheEntryBeforeTheRevokeReturnsAndTheNextReadReverifiesTheSource() throws Exception {
        Fixture f = fixture(Files.createTempDirectory("media-dev-content-cache-revoke-"));
        try {
            byte[] bytes = "rights bound bytes".getBytes(StandardCharsets.UTF_8);
            MediaArtifact art = upload(f.runtime(), "doc.bin", "application/octet-stream", bytes);
            var attested = f.rights().attest(TENANT, PRINCIPAL, new MediaDevRightsRuntime.Statement(art.artifactId(),
                    art.version().value(), StatementKind.MEDIA_RIGHTS, Set.of(Scope.PROCESSING),
                    "TEST: synthetic bytes", "", "", null));
            String path = contentPath(art);
            assertThat(get(f.server(), path, PRINCIPAL, ALL, Map.of()).headers().firstValue("X-Media-Content-Cache"))
                    .contains("MISS");
            assertThat(get(f.server(), path, PRINCIPAL, ALL, Map.of()).headers().firstValue("X-Media-Content-Cache"))
                    .contains("HIT");
            assertThat(f.cache().stats().entries()).isEqualTo(1);

            f.rights().revoke(TENANT, PRINCIPAL, attested.attestation().attestationId(), "TEST: withdrawn");
            assertThat(f.cache().stats().entries()).as("dropped synchronously by the revoke").isZero();
            HttpResponse<byte[]> after = get(f.server(), path, PRINCIPAL, ALL, Map.of());
            assertThat(after.headers().firstValue("X-Media-Content-Cache")).contains("MISS");
            assertThat(after.body()).isEqualTo(bytes);
            assertThat(f.probe().contentReads).hasValue(2);
        } finally { f.server().stop(0); f.cache().close(); }
    }

    @Test
    void failsClosedWhenTheRightsOrArtifactAuthorityIsDownAndNeverServesTheCacheAsFallback() throws Exception {
        Fixture f = fixture(Files.createTempDirectory("media-dev-content-cache-outage-"));
        try {
            MediaArtifact art = upload(f.runtime(), "doc.bin", "application/octet-stream",
                    "outage bytes".getBytes(StandardCharsets.UTF_8));
            String path = contentPath(art);
            assertThat(get(f.server(), path, PRINCIPAL, ALL, Map.of()).statusCode()).isEqualTo(200);
            assertThat(get(f.server(), path, PRINCIPAL, ALL, Map.of()).headers().firstValue("X-Media-Content-Cache"))
                    .contains("HIT");

            f.probe().rightsDown.set(true);
            HttpResponse<byte[]> rightsOut = get(f.server(), path, PRINCIPAL, ALL, Map.of());
            assertThat(rightsOut.statusCode()).isEqualTo(503);
            assertThat(code(rightsOut)).isEqualTo("ARTIFACT_AUTHORITY_UNAVAILABLE");
            assertThat(new String(rightsOut.body(), StandardCharsets.UTF_8)).doesNotContain("outage bytes");
            f.probe().rightsDown.set(false);
            assertThat(get(f.server(), path, PRINCIPAL, ALL, Map.of()).headers().firstValue("X-Media-Content-Cache"))
                    .contains("HIT");

            f.probe().artifactDown.set(true);
            HttpResponse<byte[]> artifactOut = get(f.server(), path, PRINCIPAL, ALL, Map.of());
            assertThat(artifactOut.statusCode()).as("released nothing").isNotEqualTo(200);
            assertThat(new String(artifactOut.body(), StandardCharsets.UTF_8)).doesNotContain("outage bytes");
            f.probe().artifactDown.set(false);
            assertThat(get(f.server(), path, PRINCIPAL, ALL, Map.of()).statusCode()).isEqualTo(200);
        } finally { f.server().stop(0); f.cache().close(); }
    }

    @Test
    void tenantInvalidationAsUsedByErasureLeavesNothingAndAnOtherVersionIsAnotherEntry() throws Exception {
        Fixture f = fixture(Files.createTempDirectory("media-dev-content-cache-erase-"));
        try {
            MediaArtifact v1 = upload(f.runtime(), "a.bin", "application/octet-stream", "version one".getBytes(StandardCharsets.UTF_8));
            MediaArtifact v2 = upload(f.runtime(), "a2.bin", "application/octet-stream", "version two!".getBytes(StandardCharsets.UTF_8));
            assertThat(get(f.server(), contentPath(v1), PRINCIPAL, ALL, Map.of()).body())
                    .isEqualTo("version one".getBytes(StandardCharsets.UTF_8));
            assertThat(get(f.server(), contentPath(v2), PRINCIPAL, ALL, Map.of()).body())
                    .isEqualTo("version two!".getBytes(StandardCharsets.UTF_8));
            assertThat(f.cache().stats().entries()).isEqualTo(2);
            // Reading v2's id with v1's version is a mismatch, never v1's cached bytes.
            assertThat(get(f.server(), "/dev/v1/artifacts/" + v2.artifactId() + "/content?version=" + v1.version().value(),
                    PRINCIPAL, ALL, Map.of()).statusCode()).isEqualTo(412);

            f.cache().invalidateTenant(TENANT);
            assertThat(f.cache().stats().entries()).isZero();
            assertThat(get(f.server(), contentPath(v1), PRINCIPAL, ALL, Map.of()).headers()
                    .firstValue("X-Media-Content-Cache")).contains("MISS");
        } finally { f.server().stop(0); f.cache().close(); }
    }

    @Test
    void cacheIsOffByDefaultAndConfigurationIsValidated() {
        assertThat(MediaDevArtifactContentCache.compose(Map.of(), null, null)).isNull();
        org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
                () -> MediaDevArtifactContentCache.compose(Map.of(MediaDevArtifactContentCache.ENABLED, "maybe"), null, null));
        org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
                () -> MediaDevArtifactContentCache.compose(Map.of(MediaDevArtifactContentCache.ENABLED, "true",
                        MediaDevArtifactContentCache.MAX_BYTES_ENV, "0"), null, null));
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

    private static HttpServer server(MediaRuntime runtime, long ceiling, MediaDevArtifactContentCache cache) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, null, (MediaDevReviewRuntime) null)
                .withDevArtifactContentCeiling(ceiling).withDevArtifactContentCache(cache);
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
