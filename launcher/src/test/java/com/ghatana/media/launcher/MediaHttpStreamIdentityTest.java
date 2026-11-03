package com.ghatana.media.launcher;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamAck;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

class MediaHttpStreamIdentityTest {
    private static final String TENANT = "tenant-stream-identity";
    private static final String JWT_SECRET = "stream-identity-test-secret-0123456789";
    private static final String ISSUER = "https://media-test-issuer.example";
    private static final String AUDIENCE = "media-stream-identity-test";
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-03T12:00:00Z"), ZoneOffset.UTC);
    private static final Set<String> STREAM_PERMISSIONS = Set.of(
            "media:stream:create", "media:stream:read", "media:stream:write", "media:stream:close");
    private static final JsonMapper JSON = JsonMapper.builder()
            .addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();

    @Test
    void jwtIdentityScopesStreamSessionAndForgedPrincipalCannotReadOrAdvanceIt() throws Exception {
        var root = Files.createTempDirectory("media-http-stream-identity-");
        var provider = new LocalAudioProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "test", 8093, 1_024, 128, 1_024,
                        Duration.ofSeconds(2), 1, "", "", true, true, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(provider));
        HttpServer server = null;
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", new MediaSecurityFilter(
                    new MediaHttpHandler(runtime), "test", jwtEnvironment(), CLOCK));
            server.start();
            HttpClient client = HttpClient.newHttpClient();
            String base = "http://127.0.0.1:" + server.getAddress().getPort();
            String openBody = "{\"tenantId\":\"" + TENANT + "\",\"principalId\":\"subject-A\","
                    + "\"correlationId\":\"stream-identity-frame\",\"streamKind\":\"AUDIO\","
                    + "\"providerHint\":\"" + provider.providerId() + "\",\"maximumBufferedBytes\":128,"
                    + "\"leaseDuration\":\"PT30S\",\"metadata\":{}}";
            Response opened = send(client, base, "POST", "/api/v1/streams", "application/json",
                    "subject-A", false, null, openBody.getBytes(StandardCharsets.UTF_8));
            assertThat(opened.status()).as(opened.body()).isEqualTo(201);
            JsonNode registration = JSON.readTree(opened.body());
            String sessionId = registration.path("session").path("sessionId").asString();
            String streamToken = registration.path("connectionToken").asString();
            assertThat(sessionId).isNotBlank();
            assertThat(streamToken).isNotBlank();

            Response connected = send(client, base, "POST", "/api/v1/streams/" + sessionId + "/connect",
                    "application/json", "subject-A", false, streamToken, new byte[0]);
            assertThat(connected.status()).as(connected.body()).isEqualTo(200);

            byte[] audioFrame = new byte[] {0x00, 0x10, 0x20, 0x30, (byte) 0x80, (byte) 0xff};
            Response accepted = send(client, base, "POST", "/api/v1/streams/" + sessionId + "/frames/0",
                    "application/octet-stream", "subject-A", false, streamToken, audioFrame);
            assertThat(accepted.status()).as(accepted.body()).isEqualTo(202);
            assertThat(JSON.readTree(accepted.body()).path("acceptedSequence").asLong()).isZero();
            assertThat(provider.calls()).isEqualTo(1);

            String forgedReadPath = "/api/v1/streams/" + sessionId;
            Response bRead = send(client, base, "GET", forgedReadPath, null, "subject-B", true, null, new byte[0]);
            Response absentRead = send(client, base, "GET", "/api/v1/streams/absent-session",
                    null, "subject-B", true, null, new byte[0]);
            assertThat(bRead.status()).isEqualTo(404);
            assertSameNotFoundEnvelope(bRead, absentRead);
            assertThat(bRead.body()).doesNotContain(sessionId);

            String forgedFramePath = "/api/v1/streams/" + sessionId + "/frames/1";
            Response bFrame = send(client, base, "POST", forgedFramePath, "application/octet-stream",
                    "subject-B", true, streamToken, new byte[] {0x55, 0x66});
            Response absentFrame = send(client, base, "POST", "/api/v1/streams/absent-session/frames/1",
                    "application/octet-stream", "subject-B", true, streamToken, new byte[] {0x55, 0x66});
            assertThat(bFrame.status()).isEqualTo(404);
            assertSameNotFoundEnvelope(bFrame, absentFrame);
            assertThat(bFrame.body()).doesNotContain(sessionId);

            Response readback = send(client, base, "GET", forgedReadPath, null,
                    "subject-A", false, null, new byte[0]);
            assertThat(readback.status()).as(readback.body()).isEqualTo(200);
            assertThat(JSON.readTree(readback.body()).path("lastSequence").asLong()).isZero();
            assertThat(provider.calls()).isEqualTo(1);
        } finally {
            try {
                if (server != null) server.stop(0);
                runtime.close();
            } finally {
                try (var paths = Files.walk(root)) {
                    for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) {
                        Files.deleteIfExists(path);
                    }
                }
            }
        }
    }

    private static Response send(HttpClient client, String base, String method, String path,
            String contentType, String subject, boolean forgePrincipal, String streamToken, byte[] body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path))
                .header("Authorization", "Bearer " + signedJwt(subject))
                .header("X-Tenant-Id", TENANT);
        if (contentType != null) request.header("Content-Type", contentType);
        if (forgePrincipal) request.header("X-Principal-Id", "subject-A");
        if (streamToken != null) request.header("X-Stream-Token", streamToken);
        if ("GET".equals(method)) request.GET();
        else request.method(method, HttpRequest.BodyPublishers.ofByteArray(body));
        HttpResponse<String> response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
        return new Response(response.statusCode(), response.body());
    }

    private static void assertSameNotFoundEnvelope(Response actual, Response absent) throws Exception {
        assertThat(actual.status()).isEqualTo(404);
        assertThat(absent.status()).isEqualTo(404);
        JsonNode actualEnvelope = JSON.readTree(actual.body());
        JsonNode absentEnvelope = JSON.readTree(absent.body());
        assertThat(actualEnvelope.path("error")).isEqualTo(absentEnvelope.path("error"));
        assertThat(actualEnvelope.path("meta").path("apiVersion"))
                .isEqualTo(absentEnvelope.path("meta").path("apiVersion"));
    }

    private static String signedJwt(String subject) throws Exception {
        String header = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissions = STREAM_PERMISSIONS.stream().sorted()
                .map(permission -> "\"" + permission + "\"").collect(java.util.stream.Collectors.joining(","));
        String payload = encode("{\"sub\":\"" + subject + "\",\"tenant_id\":\"" + TENANT
                + "\",\"iss\":\"" + ISSUER + "\",\"aud\":\"" + AUDIENCE + "\",\"exp\":"
                + CLOCK.instant().plusSeconds(300).getEpochSecond() + ",\"permissions\":[" + permissions + "]}");
        String signingInput = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(JWT_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static Map<String, String> jwtEnvironment() {
        return Map.of(
                "MEDIA_JWT_HMAC_SECRET_REFERENCE", "secret:env:JWT_SECRET",
                "MEDIA_JWT_ISSUER", ISSUER,
                "MEDIA_JWT_AUDIENCE", AUDIENCE,
                "JWT_SECRET", JWT_SECRET);
    }

    private record Response(int status, String body) { }

    private static final class LocalAudioProvider implements MediaStreamingProvider {
        private final AtomicInteger calls = new AtomicInteger();

        @Override public String providerId() { return "local-stream-identity-provider"; }
        @Override public Set<StreamKind> capabilities() { return Set.of(StreamKind.AUDIO); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }

        @Override
        public CompletableFuture<StreamAck> accept(StreamContext context,
                com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame frame) {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(
                    new StreamAck(frame.sequence(), frame.payload().length, false));
        }

        int calls() { return calls.get(); }
    }
}
