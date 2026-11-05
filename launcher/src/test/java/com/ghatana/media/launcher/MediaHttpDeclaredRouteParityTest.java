package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** Exercises the declared route manifest through the actual handler without opening a socket. */
class MediaHttpDeclaredRouteParityTest {
    private static final String TENANT = "route-tenant";
    private static final String PRINCIPAL = "route-principal";
    private static final String JWT_SECRET = "0123456789abcdef0123456789abcdef";
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-05T20:00:00Z"), ZoneOffset.UTC);

    @Test
    void operationalProbesEnforceTheirDeclaredGetMethod() throws Exception {
        var root = Files.createTempDirectory("media-http-health-methods-");
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                java.util.List.of(), java.util.List.of());
        try {
            MediaHttpHandler handler = new MediaHttpHandler(runtime);
            for (var route : MediaRouteManifest.all().stream().filter(route -> route.publicAccess()).toList()) {
                ExchangeResult result = request(handler, "POST", concretePath(route.path()), false);
                assertThat(result.status()).as("method mismatch for %s", route.path()).isEqualTo(405);
                assertThat(result.body()).contains("METHOD_NOT_ALLOWED");
            }
        } finally {
            runtime.close();
        }
    }

    @Test
    void everyProtectedManifestRouteRequiresServerAuthenticatedIdentityAndReachesADeclaredHandler() throws Exception {
        var root = Files.createTempDirectory("media-http-route-matrix-");
        AtomicInteger providerEffects = new AtomicInteger();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                java.util.List.of(new InertProvider(providerEffects)),
                java.util.List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            MediaHttpHandler handler = new MediaHttpHandler(runtime);
            MediaSecurityFilter securityFilter = new MediaSecurityFilter(
                    handler, "production", jwtEnvironment(), CLOCK);
            String authorizedToken = signedJwt(MediaRouteManifest.all().stream()
                    .filter(route -> !route.publicAccess())
                    .map(route -> MediaRouteManifest.requiredPermission(route.method(), concretePath(route.path())))
                    .collect(java.util.stream.Collectors.toUnmodifiableSet()));
            ExchangeResult wrongPermission = request(securityFilter, "POST", "/api/v1/jobs", false,
                    signedJwt(Set.of("media:job:read")));
            assertThat(wrongPermission.status()).isEqualTo(403);
            assertThat(wrongPermission.body()).contains("FORBIDDEN");
            for (var route : MediaRouteManifest.all()) {
                String concretePath = concretePath(route.path());
                if (route.publicAccess()) {
                    ExchangeResult publicResult = request(handler, route.method(), concretePath, false);
                    assertThat(publicResult.status())
                            .as("public route %s %s", route.method(), concretePath)
                            .isEqualTo(200);
                    ExchangeResult filteredPublic = request(securityFilter, route.method(), concretePath, false);
                    assertThat(filteredPublic.status())
                            .as("public route %s %s remains reachable through the security filter", route.method(), concretePath)
                            .isEqualTo(200);
                    continue;
                }

                ExchangeResult filterDenied = request(securityFilter, route.method(), concretePath, false);
                assertThat(filterDenied.status())
                        .as("security filter denies missing credentials for %s %s", route.method(), concretePath)
                        .isEqualTo(401);

                ExchangeResult unauthenticated = request(handler, route.method(), concretePath, false);
                assertThat(unauthenticated.status())
                        .as("authentication gate for %s %s", route.method(), concretePath)
                        .isEqualTo(401);
                assertThat(unauthenticated.body())
                        .contains("UNAUTHENTICATED")
                        .doesNotContain(TENANT, PRINCIPAL);

                ExchangeResult scoped = request(handler, route.method(), concretePath, true);
                assertThat(scoped.status() == 503 || (scoped.status() >= 200 && scoped.status() < 500))
                        .as("declared route %s %s must not become an internal server error", route.method(), concretePath)
                        .isTrue();
                assertThat(scoped.body())
                        .as("declared route %s %s must not fall through to the generic router", route.method(), concretePath)
                        .doesNotContain("\"code\":\"INTERNAL_ERROR\"", "\"message\":\"Route not found\"");
                if (scoped.status() < 200 || scoped.status() >= 300) {
                    assertThat(scoped.body())
                            .as("declared route %s %s must return a typed error envelope", route.method(), concretePath)
                            .contains("\"error\"", "\"code\"");
                }

                ExchangeResult filteredAuthorized = request(securityFilter, route.method(), concretePath, false,
                        authorizedToken);
                assertThat(filteredAuthorized.status() == 503
                        || (filteredAuthorized.status() >= 200 && filteredAuthorized.status() < 500))
                        .as("permission-bearing identity dispatches %s %s without an internal error",
                                route.method(), concretePath)
                        .isTrue();
                assertThat(filteredAuthorized.body())
                        .as("permission-bearing identity dispatches %s %s to its declared handler",
                                route.method(), concretePath)
                        .doesNotContain("\"code\":\"INTERNAL_ERROR\"", "\"message\":\"Route not found\"");
                if (filteredAuthorized.status() < 200 || filteredAuthorized.status() >= 300) {
                    assertThat(filteredAuthorized.body())
                            .as("security filter authorized dispatch returns a typed route error for %s %s",
                                    route.method(), concretePath)
                            .contains("\"error\"", "\"code\"");
                }
            }
            assertThat(providerEffects).hasValue(0);
        } finally {
            runtime.close();
        }
    }

    private static String concretePath(String template) {
        return template
                .replace("{consentId}", "missing-consent")
                .replace("{uploadId}", "missing-upload")
                .replace("{chunkIndex}", "0")
                .replace("{artifactId}", "missing-artifact")
                .replace("{jobId}", "missing-job")
                .replace("{sessionId}", "missing-stream")
                .replace("{sequence}", "0")
                .replace("{captionVersionId}", "missing-caption");
    }

    private static ExchangeResult request(
            HttpHandler handler, String method, String path, boolean authenticated) throws Exception {
        return request(handler, method, path, authenticated, null);
    }

    private static ExchangeResult request(
            HttpHandler handler, String method, String path, boolean authenticated, String bearerToken) throws Exception {
        HttpExchange exchange = mock(HttpExchange.class);
        Headers requestHeaders = new Headers();
        requestHeaders.set("X-Tenant-Id", TENANT);
        requestHeaders.set("X-Principal-Id", PRINCIPAL);
        if (bearerToken != null) requestHeaders.set("Authorization", "Bearer " + bearerToken);
        Headers responseHeaders = new Headers();
        ByteArrayOutputStream responseBody = new ByteArrayOutputStream();
        AtomicReference<Integer> status = new AtomicReference<>();
        Map<String, Object> attributes = new HashMap<>();
        doAnswer(invocation -> {
            attributes.put(invocation.getArgument(0), invocation.getArgument(1));
            return null;
        }).when(exchange).setAttribute(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any());
        when(exchange.getAttribute(org.mockito.ArgumentMatchers.anyString()))
                .thenAnswer(invocation -> attributes.get(invocation.getArgument(0)));
        when(exchange.getRequestURI()).thenReturn(URI.create("http://localhost" + path));
        when(exchange.getRequestMethod()).thenReturn(method);
        when(exchange.getRequestHeaders()).thenReturn(requestHeaders);
        when(exchange.getRequestBody()).thenReturn(new ByteArrayInputStream(new byte[0]));
        when(exchange.getResponseHeaders()).thenReturn(responseHeaders);
        when(exchange.getResponseBody()).thenReturn(responseBody);
        if (authenticated) {
            attributes.put(MediaSecurityFilter.AUTHENTICATED_PRINCIPAL_ATTRIBUTE,
                    new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(TENANT, PRINCIPAL, CLOCK.instant()));
        }
        doAnswer(invocation -> {
            status.set(invocation.getArgument(0));
            return null;
        }).when(exchange).sendResponseHeaders(org.mockito.ArgumentMatchers.anyInt(),
                org.mockito.ArgumentMatchers.anyLong());
        handler.handle(exchange);
        return new ExchangeResult(status.get(), responseBody.toString(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static Map<String, String> jwtEnvironment() {
        return Map.of(
                "MEDIA_JWT_HMAC_SECRET_REFERENCE", "secret:env:JWT_SECRET",
                "MEDIA_JWT_ISSUER", "https://issuer.example",
                "MEDIA_JWT_AUDIENCE", "ghatana-runtime",
                "JWT_SECRET", JWT_SECRET);
    }

    private static String signedJwt(Set<String> permissions) throws Exception {
        String header = Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String permissionJson = permissions.stream().sorted()
                .map(permission -> "\"" + permission + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payloadJson = "{\"sub\":\"" + PRINCIPAL + "\",\"tenant_id\":\"" + TENANT
                + "\",\"iss\":\"https://issuer.example\",\"aud\":\"ghatana-runtime\",\"exp\":"
                + CLOCK.instant().plusSeconds(300).getEpochSecond()
                + ",\"permissions\":[" + permissionJson + "]}";
        String payload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(payloadJson.getBytes(StandardCharsets.UTF_8));
        String signingInput = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(JWT_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String signature = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
        return signingInput + "." + signature;
    }

    private record ExchangeResult(Integer status, String body) { }

    private record InertProvider(AtomicInteger calls) implements MediaProcessingProvider {
        @Override public String providerId() { return "route-matrix-inert"; }
        @Override public String providerVersion() { return "test-v1"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(Map.of("status", "completed"));
        }
    }
}
