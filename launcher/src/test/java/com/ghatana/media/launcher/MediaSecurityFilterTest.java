package com.ghatana.media.launcher;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

/**
 * Unit tests for MediaSecurityFilter.
 *
 * <p>Verifies fail-closed behavior, public path bypass, tenant header enforcement,
 * API key validation, JWT validation, and production profile strictness.
 *
 * @doc.type class
 * @doc.purpose Verify security filter behavior for Media runtime
 * @doc.layer test
 * @doc.pattern SecurityTest
 */
@DisplayName("Media Security Filter Tests")
class MediaSecurityFilterTest {

    private static final String JWT_SECRET = "0123456789abcdef0123456789abcdef";
    private static final Clock CLOCK = Clock.fixed(
            Instant.parse("2026-08-03T00:00:00Z"),
            ZoneOffset.UTC);

    private static Map<String, String> environment() {
        return Map.of(
                "MEDIA_API_KEY", "test-key",
                "MEDIA_JWT_HMAC_SECRET_REFERENCE", "secret:env:JWT_SECRET",
                "MEDIA_JWT_ISSUER", "https://issuer.example",
                "MEDIA_JWT_AUDIENCE", "ghatana-runtime",
                "JWT_SECRET", JWT_SECRET);
    }

    private static String signedJwt(String tenantId) throws Exception {
        String headerJson = "{\"alg\":\"HS256\",\"typ\":\"JWT\"}";
        String payloadJson = "{\"sub\":\"user-1\",\"tenant_id\":\"" + tenantId
                + "\",\"iss\":\"https://issuer.example\",\"aud\":\"ghatana-runtime\",\"exp\":"
                + CLOCK.instant().plusSeconds(300).getEpochSecond()
                + ",\"permissions\":[\"media:job:read\"]}";
        String header = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(headerJson.getBytes(StandardCharsets.UTF_8));
        String payload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(payloadJson.getBytes(StandardCharsets.UTF_8));
        String signingInput = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(JWT_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private HttpExchange mockExchange(String path, Map<String, String> headers) throws IOException {
        HttpExchange exchange = mock(HttpExchange.class);
        when(exchange.getRequestURI()).thenReturn(URI.create(path));
        when(exchange.getRequestMethod()).thenReturn("GET");

        com.sun.net.httpserver.Headers httpHeaders = new com.sun.net.httpserver.Headers();
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            httpHeaders.add(entry.getKey(), entry.getValue());
        }
        when(exchange.getRequestHeaders()).thenReturn(httpHeaders);

        ByteArrayOutputStream responseBody = new ByteArrayOutputStream();
        when(exchange.getResponseBody()).thenReturn(responseBody);
        doNothing().when(exchange).sendResponseHeaders(anyInt(), anyLong());
        when(exchange.getResponseHeaders()).thenReturn(new com.sun.net.httpserver.Headers());

        return exchange;
    }

    private Map<String, String> noHeaders() {
        return new HashMap<>();
    }

    @Nested
    @DisplayName("public paths")
    class PublicPaths {

        @Test
        void healthPathBypassesAuth() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "production");
            HttpExchange exchange = mockExchange("/health", noHeaders());

            filter.handle(exchange);

            verify(delegate).handle(exchange);
        }

        @Test
        void healthLivePathBypassesAuth() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "production");
            HttpExchange exchange = mockExchange("/health/live", noHeaders());

            filter.handle(exchange);

            verify(delegate).handle(exchange);
        }

        @Test
        void metricsPathBypassesAuth() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "production");
            HttpExchange exchange = mockExchange("/metrics", noHeaders());

            filter.handle(exchange);

            verify(delegate).handle(exchange);
        }

        @Test
        void infoPathBypassesAuth() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "production");
            HttpExchange exchange = mockExchange("/info", noHeaders());

            filter.handle(exchange);

            verify(delegate).handle(exchange);
        }
    }

    @Nested
    @DisplayName("production profile")
    class ProductionProfile {

        @Test
        void rejectsMissingTenantId() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "production");
            HttpExchange exchange = mockExchange("/api/v1/jobs", noHeaders());

            filter.handle(exchange);

            verify(delegate, never()).handle(any());
            verify(exchange).sendResponseHeaders(eq(400), anyLong());
        }

        @Test
        void rejectsMissingAuthCredentials() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "production");
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Tenant-Id", "tenant-a");
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            verify(delegate, never()).handle(any());
            verify(exchange).sendResponseHeaders(eq(401), anyLong());
        }

        @Test
        void acceptsApiKeyWithTenant() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "local", environment(), CLOCK);
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Tenant-Id", "tenant-a");
            headers.put("X-API-Key", "test-key");
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            verify(delegate).handle(exchange);
        }

        @Test
        void acceptsJwtWithTenant() throws Exception {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "local", environment(), CLOCK);
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Tenant-Id", "tenant-a");
            headers.put("Authorization", "Bearer " + signedJwt("tenant-a"));
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            verify(delegate).handle(exchange);
        }

        @Test
        void rejectsJwtWithTenantMismatch() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "local");
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Tenant-Id", "tenant-a");
            String fakeJwt = "header." + java.util.Base64.getUrlEncoder()
                    .encodeToString("{\"sub\":\"user-1\",\"tenant_id\":\"tenant-b\"}".getBytes()) + ".sig";
            headers.put("Authorization", "Bearer " + fakeJwt);
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            verify(delegate, never()).handle(any());
            verify(exchange).sendResponseHeaders(eq(401), anyLong());
        }

        @Test
        void rejectsJwtWithTenantIdInWrongClaim() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "local");
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Tenant-Id", "tenant-a");
            String fakeJwt = "header." + java.util.Base64.getUrlEncoder()
                    .encodeToString("{\"sub\":\"user-1\",\"metadata\":\"tenant-a\"}".getBytes()) + ".sig";
            headers.put("Authorization", "Bearer " + fakeJwt);
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            verify(delegate, never()).handle(any());
            verify(exchange).sendResponseHeaders(eq(401), anyLong());
        }

        @Test
        void rejectsInvalidJwt() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "local");
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Tenant-Id", "tenant-a");
            headers.put("Authorization", "Bearer invalid-token");
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            verify(delegate, never()).handle(any());
            verify(exchange).sendResponseHeaders(eq(401), anyLong());
        }
    }

    @Nested
    @DisplayName("local profile")
    class LocalProfile {

        @Test
        void allowsRequestsWithoutAuth() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "local");
            HttpExchange exchange = mockExchange("/api/v1/jobs", noHeaders());

            filter.handle(exchange);

            verify(delegate).handle(exchange);
        }
    }

    @Nested
    @DisplayName("fail-closed behavior")
    class FailClosed {

        @Test
        void returns403OnUnexpectedError() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "production");
            HttpExchange exchange = mock(HttpExchange.class);
            when(exchange.getRequestURI()).thenThrow(new RuntimeException("unexpected"));
            when(exchange.getResponseHeaders()).thenReturn(new com.sun.net.httpserver.Headers());
            doNothing().when(exchange).sendResponseHeaders(anyInt(), anyLong());
            when(exchange.getResponseBody()).thenReturn(new ByteArrayOutputStream());

            filter.handle(exchange);

            verify(exchange).sendResponseHeaders(eq(403), anyLong());
            verify(delegate, never()).handle(any());
        }
    }
}
