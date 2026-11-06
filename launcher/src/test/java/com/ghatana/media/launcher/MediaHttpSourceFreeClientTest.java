package com.ghatana.media.launcher;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
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

/** Exercises reconciliation query schema and identity behavior through the actual HTTP server. */
class MediaHttpSourceFreeClientTest {
    private static final String TENANT = "http-contract-tenant";
    private static final String PRINCIPAL = "http-contract-principal";
    private static final String JWT_SECRET = "media-http-contract-secret-0123456789";
    private static final String ISSUER = "https://media-http-contract.example";
    private static final String AUDIENCE = "media-http-contract";
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-05T20:00:00Z"), ZoneOffset.UTC);
    private static final JsonMapper JSON = JsonMapper.builder()
            .addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();

    @Test
    void jobReconciliationQueryEnforcesOpenApiLengthAndHidesMismatchedIdentity() throws Exception {
        var root = Files.createTempDirectory("media-http-source-free-client-");
        var jobs = new LocalMediaRuntimeSupport.JobStore(false);
        String jobId = "job-http-contract";
        String requestId = "request-http-contract";
        jobs.create(new ProcessingJob(jobId, requestId, TENANT, PRINCIPAL, "artifact-http-contract",
                JobType.TRANSCODE, "unavailable-provider", JobStatus.ACCEPTED, Instant.now(),
                null, null, Map.of(), "", 1, "", ""));
        String maximumRequestId = "r".repeat(255);
        jobs.create(new ProcessingJob("job-http-contract-max-request-id", maximumRequestId,
                TENANT, PRINCIPAL, "artifact-http-contract", JobType.TRANSCODE,
                "unavailable-provider", JobStatus.ACCEPTED, Instant.now(), null, null,
                Map.of(), "", 1, "", ""));
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "test", 8093, 1_024, 128, 1_024,
                        Duration.ofSeconds(2), 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root), jobs,
                new LocalMediaRuntimeSupport.StreamStore(), null,
                java.util.List.of(new NoEffectProvider()),
                java.util.List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        HttpServer server = null;
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", new MediaSecurityFilter(
                    new MediaHttpHandler(runtime), "test", jwtEnvironment(), CLOCK));
            server.start();
            HttpClient client = HttpClient.newHttpClient();
            String base = "http://127.0.0.1:" + server.getAddress().getPort();

            HttpResponse<String> exact = get(client, base, "/api/v1/jobs/" + jobId + "?requestId=" + requestId);
            assertThat(exact.statusCode()).as(exact.body()).isEqualTo(200);
            assertThat(JSON.readTree(exact.body()).path("requestId").asString()).isEqualTo(requestId);
            HttpResponse<String> maximumLength = get(client, base,
                    "/api/v1/jobs/job-http-contract-max-request-id?requestId=" + maximumRequestId);
            assertThat(maximumLength.statusCode()).as(maximumLength.body()).isEqualTo(200);
            assertThat(JSON.readTree(maximumLength.body()).path("requestId").asString())
                    .isEqualTo(maximumRequestId);

            HttpResponse<String> wrongIdentity = get(
                    client, base, "/api/v1/jobs/" + jobId + "?requestId=other-request");
            HttpResponse<String> absentJob = get(client, base, "/api/v1/jobs/absent-job");
            assertThat(wrongIdentity.statusCode()).isEqualTo(404);
            assertThat(JSON.readTree(wrongIdentity.body()).path("error").path("code").asString())
                    .isEqualTo(JSON.readTree(absentJob.body()).path("error").path("code").asString());
            assertThat(wrongIdentity.body()).doesNotContain(jobId, requestId);

            HttpResponse<String> oversizedIdentity = get(
                    client, base, "/api/v1/jobs/" + jobId + "?requestId=" + "x".repeat(256));
            HttpResponse<String> duplicateIdentity = get(
                    client, base, "/api/v1/jobs/" + jobId + "?requestId=" + requestId + "&requestId=" + requestId);
            for (HttpResponse<String> invalid : java.util.List.of(oversizedIdentity, duplicateIdentity)) {
                assertThat(invalid.statusCode()).isEqualTo(400);
                JsonNode envelope = JSON.readTree(invalid.body());
                assertThat(envelope.path("error").path("code").asString()).isEqualTo("INVALID_REQUEST");
                assertThat(invalid.body()).doesNotContain(jobId, requestId);
            }
        } finally {
            if (server != null) server.stop(0);
            runtime.close();
            try (var paths = Files.walk(root)) {
                for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) {
                    Files.deleteIfExists(path);
                }
            }
        }
    }

    private static HttpResponse<String> get(HttpClient client, String base, String path) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(base + path))
                .header("Authorization", "Bearer " + signedJwt())
                .header("X-Tenant-Id", TENANT)
                .GET()
                .build();
        return client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static String signedJwt() throws Exception {
        String header = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissions = Set.of("media:job:read").stream().sorted()
                .map(permission -> "\"" + permission + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = encode("{\"sub\":\"" + PRINCIPAL + "\",\"tenant_id\":\"" + TENANT
                + "\",\"iss\":\"" + ISSUER + "\",\"aud\":\"" + AUDIENCE + "\",\"exp\":"
                + CLOCK.instant().plusSeconds(300).getEpochSecond() + ",\"permissions\":[" + permissions + "]}");
        String signingInput = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(JWT_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String signature = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
        return signingInput + "." + signature;
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

    private static final class NoEffectProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "http-contract-no-effect"; }
        @Override public String providerVersion() { return "test-only"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public java.util.concurrent.CompletableFuture<Map<String, Object>> process(
                ProcessingContext context) {
            throw new AssertionError("reconciliation read must not invoke a processing provider");
        }
    }
}
