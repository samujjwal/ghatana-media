package com.ghatana.media.launcher;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import org.mockito.ArgumentCaptor;
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
    private static final String DEV_JWT_SECRET = "dev-only-secret-value-at-least-32-bytes";
    private static final String DEV_ISSUER = "urn:ghatana:media:dev-only";
    private static final String DEV_AUDIENCE = "ghatana-media-dev";
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

    private static String signedDevJwt(String tenantId, String subject) throws Exception {
        return signedDevJwt(tenantId, subject, true);
    }

    private static String signedDevJwt(String tenantId, String subject, boolean devOnly) throws Exception {
        String headerJson = "{\"alg\":\"HS256\",\"typ\":\"JWT\"}";
        String payloadJson = "{\"sub\":\"" + subject + "\",\"tenant_id\":\"" + tenantId
                + "\",\"iss\":\"" + DEV_ISSUER + "\",\"aud\":\"" + DEV_AUDIENCE
                + "\",\"dev_only\":" + devOnly + ",\"exp\":"
                + CLOCK.instant().plusSeconds(120).getEpochSecond()
                + ",\"permissions\":[\"media:job:read\"]}";
        String header = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(headerJson.getBytes(StandardCharsets.UTF_8));
        String payload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(payloadJson.getBytes(StandardCharsets.UTF_8));
        String signingInput = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(DEV_JWT_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static Map<String, String> devIdentityEnvironment() {
        Map<String, String> configured = new HashMap<>(environment());
        configured.put("MEDIA_DEV_IDENTITY_ENABLED", "true");
        configured.put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_JWT_SECRET);
        return configured;
    }

    private HttpExchange mockExchange(String path, Map<String, String> headers) throws IOException {
        HttpExchange exchange = mock(HttpExchange.class);
        when(exchange.getRequestURI()).thenReturn(URI.create(path));
        when(exchange.getRequestMethod()).thenReturn("GET");
        Map<String, Object> attributes = new HashMap<>();
        doAnswer(invocation -> {
            attributes.put(invocation.getArgument(0), invocation.getArgument(1));
            return null;
        }).when(exchange).setAttribute(anyString(), any());
        when(exchange.getAttribute(anyString())).thenAnswer(invocation -> attributes.get(invocation.getArgument(0)));

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

            verify(delegate).handle(any(HttpExchange.class));
        }

        @Test
        void healthLivePathBypassesAuth() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "production");
            HttpExchange exchange = mockExchange("/health/live", noHeaders());

            filter.handle(exchange);

            verify(delegate).handle(any(HttpExchange.class));
        }

        @Test
        void metricsPathBypassesAuth() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "production");
            HttpExchange exchange = mockExchange("/metrics", noHeaders());

            filter.handle(exchange);

            verify(delegate).handle(any(HttpExchange.class));
        }

        @Test
        void infoPathBypassesAuth() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "production");
            HttpExchange exchange = mockExchange("/info", noHeaders());

            filter.handle(exchange);

            verify(delegate).handle(any(HttpExchange.class));
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

            var seen = ArgumentCaptor.forClass(HttpExchange.class);
            verify(delegate).handle(seen.capture());
            assertThat(seen.getValue().getRequestHeaders().getFirst("X-Principal-Id"))
                    .isEqualTo("media-api-key-service");
            assertThat(MediaSecurityFilter.authenticatedPrincipal(seen.getValue()))
                    .satisfies(identity -> {
                        assertThat(identity.tenantId()).isEqualTo("tenant-a");
                        assertThat(identity.principalId()).isEqualTo("media-api-key-service");
                    });
        }

        @Test
        void apiKeyCannotSelectCallerPrincipal() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "local", environment(), CLOCK);
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Tenant-Id", "tenant-a");
            headers.put("X-API-Key", "test-key");
            headers.put("X-Principal-Id", "victim-user");
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            var seen = ArgumentCaptor.forClass(HttpExchange.class);
            verify(delegate).handle(seen.capture());
            assertThat(seen.getValue().getRequestHeaders().getFirst("X-Principal-Id"))
                    .isEqualTo("media-api-key-service");
            assertThat(MediaSecurityFilter.authenticatedPrincipal(seen.getValue()).principalId())
                    .isEqualTo("media-api-key-service");
        }

        @Test
        void rejectsAmbiguousApiKeyAndBearerCredentials() throws Exception {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "local", environment(), CLOCK);
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Tenant-Id", "tenant-a");
            headers.put("X-API-Key", "test-key");
            headers.put("Authorization", "Bearer " + signedJwt("tenant-a"));
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            verify(delegate, never()).handle(any());
            verify(exchange).sendResponseHeaders(eq(401), anyLong());
        }

        @Test
        void acceptsJwtWithTenant() throws Exception {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "local", environment(), CLOCK);
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Tenant-Id", "tenant-a");
            headers.put("X-Principal-Id", "forged-admin");
            headers.put("Authorization", "Bearer " + signedJwt("tenant-a"));
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            var seen = ArgumentCaptor.forClass(HttpExchange.class);
            verify(delegate).handle(seen.capture());
            assertThat(seen.getValue().getRequestHeaders().getFirst("X-Principal-Id")).isEqualTo("user-1");
            var authenticated = (com.ghatana.launcher.security.SecurityFilterSupport.AuthenticatedPrincipal)
                    exchange.getAttribute(
                            com.ghatana.launcher.security.SecurityFilterSupport.ATTRIBUTE_AUTHENTICATED_PRINCIPAL);
            assertThat(authenticated).isNotNull();
            assertThat(authenticated.subject()).isEqualTo("user-1");
            assertThat(authenticated.tenantId()).isEqualTo("tenant-a");
            assertThat(MediaSecurityFilter.authenticatedPrincipal(seen.getValue()))
                    .satisfies(identity -> {
                        assertThat(identity.tenantId()).isEqualTo("tenant-a");
                        assertThat(identity.principalId()).isEqualTo("user-1");
                        assertThat(identity.authenticatedAt()).isEqualTo(CLOCK.instant());
                    });
        }

        @Test
        void rejectsForgedPrincipalHintWithoutAuthenticatedHostContext() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "production");
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Tenant-Id", "tenant-a");
            headers.put("X-Principal-Id", "forged-admin");
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            verify(delegate, never()).handle(any());
            verify(exchange).sendResponseHeaders(eq(401), anyLong());

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

            var seen = ArgumentCaptor.forClass(HttpExchange.class);
            verify(delegate).handle(seen.capture());
            assertThat(seen.getValue().getRequestHeaders().getFirst("X-Principal-Id"))
                    .isEqualTo("media-local-development");
            assertThat(MediaSecurityFilter.authenticatedPrincipal(seen.getValue())).isNull();
        }

        @Test
        void unauthenticatedFixtureCannotSelectCallerPrincipal() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "local");
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Tenant-Id", "fixture-tenant");
            headers.put("X-Principal-Id", "victim-user");
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            var seen = ArgumentCaptor.forClass(HttpExchange.class);
            verify(delegate).handle(seen.capture());
            assertThat(seen.getValue().getRequestHeaders().getFirst("X-Principal-Id"))
                    .isEqualTo("media-local-development");
            assertThat(MediaSecurityFilter.authenticatedPrincipal(seen.getValue()))
                    .satisfies(identity -> {
                        assertThat(identity.tenantId()).isEqualTo("fixture-tenant");
                        assertThat(identity.principalId()).isEqualTo("media-local-development");
                    });
        }
    }

    @Nested
    @DisplayName("opt-in DEV_ONLY identity")
    class DevOnlyIdentity {

        @Test
        void acceptsSignedDevBearerAndReplacesForgedIdentityHeaders() throws Exception {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "dev", devIdentityEnvironment(), CLOCK);
            Map<String, String> headers = new HashMap<>();
            headers.put("Authorization", "Bearer " + signedDevJwt("signed-tenant", "signed-subject"));
            headers.put("X-Tenant-Id", "forged-tenant");
            headers.put("X-Principal-Id", "forged-subject");
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            var seen = ArgumentCaptor.forClass(HttpExchange.class);
            verify(delegate).handle(seen.capture());
            assertThat(seen.getValue().getRequestHeaders().getFirst("X-Tenant-Id")).isEqualTo("signed-tenant");
            assertThat(seen.getValue().getRequestHeaders().getFirst("X-Principal-Id")).isEqualTo("signed-subject");
            assertThat(MediaSecurityFilter.authenticatedPrincipal(seen.getValue()))
                    .satisfies(identity -> {
                        assertThat(identity.tenantId()).isEqualTo("signed-tenant");
                        assertThat(identity.principalId()).isEqualTo("signed-subject");
                    });
        }

        @Test
        void requiresBearerAndRejectsHeaderOnlyOrApiKeyIdentity() throws IOException {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "dev", devIdentityEnvironment(), CLOCK);
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Tenant-Id", "caller-tenant");
            headers.put("X-Principal-Id", "caller-subject");
            headers.put("X-API-Key", "test-key");
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            verify(delegate, never()).handle(any());
            verify(exchange).sendResponseHeaders(eq(401), anyLong());
        }

        @Test
        void requiresExplicitDevOnlyClaimEvenOnCorrectlySignedToken() throws Exception {
            HttpHandler delegate = mock(HttpHandler.class);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "dev", devIdentityEnvironment(), CLOCK);
            Map<String, String> headers = new HashMap<>();
            headers.put("Authorization", "Bearer " + signedDevJwt("tenant-a", "user-a", false));
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            verify(delegate, never()).handle(any());
            verify(exchange).sendResponseHeaders(eq(401), anyLong());
        }

        @Test
        void rejectsDevOnlyModeOutsideExactDevProfile() {
            assertThat(org.assertj.core.api.Assertions.catchThrowable(
                    () -> new MediaSecurityFilter(mock(HttpHandler.class), "production", devIdentityEnvironment(), CLOCK)))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("only for the dev profile");
            assertThat(org.assertj.core.api.Assertions.catchThrowable(
                    () -> new MediaSecurityFilter(mock(HttpHandler.class), "local", devIdentityEnvironment(), CLOCK)))
                    .isInstanceOf(IllegalArgumentException.class);
        }

        @Test
        void rejectsDevTokenEvenWhenProductionVerifierWouldOtherwiseAcceptIt() throws Exception {
            HttpHandler delegate = mock(HttpHandler.class);
            Map<String, String> configured = new HashMap<>(devIdentityEnvironment());
            configured.put("MEDIA_DEV_IDENTITY_ENABLED", "false");
            configured.remove("MEDIA_DEV_JWT_HMAC_SECRET");
            configured.put("JWT_SECRET", DEV_JWT_SECRET);
            configured.put("MEDIA_JWT_HMAC_SECRET_REFERENCE", "secret:env:JWT_SECRET");
            configured.put("MEDIA_JWT_ISSUER", DEV_ISSUER);
            configured.put("MEDIA_JWT_AUDIENCE", DEV_AUDIENCE);
            MediaSecurityFilter filter = new MediaSecurityFilter(delegate, "production", configured, CLOCK);
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Tenant-Id", "signed-tenant");
            headers.put("Authorization", "Bearer " + signedDevJwt("signed-tenant", "signed-subject"));
            HttpExchange exchange = mockExchange("/api/v1/jobs", headers);

            filter.handle(exchange);

            verify(delegate, never()).handle(any());
            verify(exchange).sendResponseHeaders(eq(401), anyLong());
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
