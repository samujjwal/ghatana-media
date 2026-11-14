package com.ghatana.media.launcher;

import com.ghatana.media.launcher.oidc.OidcAccessTokenVerifier;
import com.ghatana.media.launcher.oidc.OidcConfig;
import com.ghatana.media.launcher.oidc.OidcJwksCache;
import com.ghatana.media.launcher.oidc.OidcTestSupport;
import com.ghatana.media.launcher.oidc.OidcTestSupport.FakeIdp;
import com.ghatana.media.launcher.oidc.OidcTestSupport.TestClock;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static com.ghatana.media.launcher.oidc.OidcTestSupport.AUDIENCE;
import static com.ghatana.media.launcher.oidc.OidcTestSupport.ISSUER;
import static com.ghatana.media.launcher.oidc.OidcTestSupport.NOW;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@DisplayName("Media security filter with an OIDC identity provider")
class MediaSecurityFilterOidcTest {
    private static final String DEV_SECRET = "dev-only-secret-value-at-least-32-bytes";
    private static final String DEV_ISSUER = "urn:ghatana:media:dev-only";
    private static final String DEV_AUDIENCE = "ghatana-media-dev";

    private RSAKey key;
    private FakeIdp idp;
    private TestClock clock;
    private OidcAccessTokenVerifier verifier;

    @BeforeEach
    void setUp() {
        key = OidcTestSupport.rsa("rsa-1");
        idp = new FakeIdp(OidcTestSupport.jwks(key.toPublicJWK()));
        clock = new TestClock();
        OidcConfig config = OidcConfig.of(ISSUER, AUDIENCE, null);
        verifier = new OidcAccessTokenVerifier(config, new OidcJwksCache(config, idp, clock), clock);
    }

    private MediaSecurityFilter production(HttpHandler delegate) {
        return new MediaSecurityFilter(delegate, "production", Map.of("MEDIA_API_KEY", "k"), clock, verifier);
    }

    private MediaSecurityFilter dev(HttpHandler delegate) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_DEV_IDENTITY_ENABLED", "true");
        environment.put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_SECRET);
        return new MediaSecurityFilter(delegate, "dev", environment, clock, verifier);
    }

    private JWTClaimsSet.Builder claims() { return OidcTestSupport.claims(NOW); }

    private String token(JWTClaimsSet claims) { return OidcTestSupport.signRs256(key, claims); }

    private static String devToken(String subject) throws Exception {
        String header = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String payload = Base64.getUrlEncoder().withoutPadding().encodeToString(("{\"sub\":\"" + subject
                + "\",\"tenant_id\":\"tenant-dev\",\"iss\":\"" + DEV_ISSUER + "\",\"aud\":\"" + DEV_AUDIENCE
                + "\",\"dev_only\":true,\"exp\":" + NOW.plusSeconds(120).getEpochSecond()
                + ",\"permissions\":[\"media:job:read\",\"media:project:dev:read\"]}").getBytes(StandardCharsets.UTF_8));
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(DEV_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String input = header + "." + payload;
        return input + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(input.getBytes(StandardCharsets.US_ASCII)));
    }

    private static HttpExchange exchange(String method, String path, Map<String, String> headers) throws IOException {
        HttpExchange exchange = mock(HttpExchange.class);
        when(exchange.getRequestURI()).thenReturn(URI.create(path));
        when(exchange.getRequestMethod()).thenReturn(method);
        Map<String, Object> attributes = new HashMap<>();
        doAnswer(invocation -> {
            attributes.put(invocation.getArgument(0), invocation.getArgument(1));
            return null;
        }).when(exchange).setAttribute(anyString(), any());
        when(exchange.getAttribute(anyString())).thenAnswer(invocation -> attributes.get(invocation.getArgument(0)));
        Headers requestHeaders = new Headers();
        headers.forEach(requestHeaders::add);
        when(exchange.getRequestHeaders()).thenReturn(requestHeaders);
        when(exchange.getResponseBody()).thenReturn(new ByteArrayOutputStream());
        doNothing().when(exchange).sendResponseHeaders(anyInt(), anyLong());
        when(exchange.getResponseHeaders()).thenReturn(new Headers());
        return exchange;
    }

    private static Map<String, String> bearer(String token) {
        return Map.of("Authorization", "Bearer " + token, "X-Tenant-Id", "caller-chosen-tenant");
    }

    @Test
    void productionAdmitsAValidOidcTokenAndBindsTenantAndPrincipalFromClaimsNotHeaders() throws Exception {
        HttpHandler delegate = mock(HttpHandler.class);
        HttpExchange exchange = exchange("GET", "/api/v1/jobs", bearer(token(claims().build())));

        production(delegate).handle(exchange);

        ArgumentCaptor<HttpExchange> seen = ArgumentCaptor.forClass(HttpExchange.class);
        verify(delegate).handle(seen.capture());
        AuthenticatedPrincipal principal = MediaSecurityFilter.authenticatedPrincipal(seen.getValue());
        assertThat(principal.tenantId()).isEqualTo("tenant-a");
        assertThat(principal.principalId()).isEqualTo(
                MediaVerifiedIdentityContracts.oidcPrincipalId(ISSUER, "5b6c1c1e-0000-4000-8000-000000000001"));
        assertThat(principal.assurance()).isEqualTo(AssuranceSource.OIDC_VERIFIED);
        assertThat(principal.idpVerified()).isTrue();
        var identity = MediaSecurityFilter.verifiedIdentity(seen.getValue());
        assertThat(identity.assurance()).isEqualTo(AssuranceSource.OIDC_VERIFIED);
        assertThat(identity.issuer()).isEqualTo(ISSUER);
        assertThat(seen.getValue().getRequestHeaders().getFirst("X-Tenant-Id")).isEqualTo("tenant-a");
        assertThat(seen.getValue().getRequestHeaders().getFirst("X-Principal-Id")).isEqualTo(principal.principalId());
        assertThat(MediaSecurityFilter.isDevOnlyIdentity(seen.getValue())).isFalse();
    }

    @Test
    void productionRefusesForeignWrongAudienceExpiredAndHmacTokensWithoutCallingTheDelegate() throws Exception {
        RSAKey foreign = OidcTestSupport.rsa("rsa-1");
        List<String> refused = List.of(
                OidcTestSupport.signRs256(foreign, claims().build()),
                token(claims().audience("someone-else").build()),
                token(claims().issuer("https://evil.example.test").build()),
                token(claims().expirationTime(java.util.Date.from(NOW.minusSeconds(3600))).build()),
                OidcTestSupport.hmac(claims().build(), "rsa-1"),
                OidcTestSupport.algNone(claims().build()),
                devToken("attacker"));
        for (String candidate : refused) {
            HttpHandler delegate = mock(HttpHandler.class);
            HttpExchange exchange = exchange("GET", "/api/v1/jobs", bearer(candidate));

            production(delegate).handle(exchange);

            verify(delegate, never()).handle(any());
            verify(exchange).sendResponseHeaders(eq(401), anyLong());
        }
    }

    @Test
    void productionRefusesApiKeysAndMissingCredentialsWhenAnIdentityProviderIsConfigured() throws Exception {
        HttpHandler delegate = mock(HttpHandler.class);
        HttpExchange apiKey = exchange("GET", "/api/v1/jobs", Map.of("X-API-Key", "k", "X-Tenant-Id", "t"));
        production(delegate).handle(apiKey);
        verify(apiKey).sendResponseHeaders(eq(401), anyLong());

        HttpExchange none = exchange("GET", "/api/v1/jobs", Map.of("X-Tenant-Id", "t"));
        production(delegate).handle(none);
        verify(none).sendResponseHeaders(eq(401), anyLong());
        verify(delegate, never()).handle(any());
    }

    @Test
    void permissionsComeFromMappedRolesAndAnUnmappedRouteOrMissingRoleIsForbidden() throws Exception {
        HttpHandler delegate = mock(HttpHandler.class);
        HttpExchange noRole = exchange("POST", "/api/v1/jobs", bearer(token(claims().build())));
        production(delegate).handle(noRole);
        verify(noRole).sendResponseHeaders(eq(403), anyLong());

        HttpExchange unknownRoute = exchange("GET", "/api/v1/not-a-route", bearer(token(claims().build())));
        production(delegate).handle(unknownRoute);
        verify(unknownRoute).sendResponseHeaders(eq(403), anyLong());

        // Dev routes are never served to production-like profiles, whatever the token claims.
        HttpExchange devRoute = exchange("GET", "/dev/v1/context", bearer(token(claims()
                .claim("realm_access", Map.of("roles", List.of("media:project:dev:read"))).build())));
        production(delegate).handle(devRoute);
        verify(devRoute).sendResponseHeaders(eq(403), anyLong());
        verify(delegate, never()).handle(any());
    }

    @Test
    void missingTenantClaimIsRefused() throws Exception {
        HttpHandler delegate = mock(HttpHandler.class);
        HttpExchange exchange = exchange("GET", "/api/v1/jobs", bearer(token(claims().claim("tenant_id", null).build())));
        production(delegate).handle(exchange);
        verify(exchange).sendResponseHeaders(eq(401), anyLong());
        verify(delegate, never()).handle(any());
    }

    @Test
    void unreachableIdentityProviderFailsClosedWith503() throws Exception {
        idp.unreachable = true;
        HttpHandler delegate = mock(HttpHandler.class);
        HttpExchange exchange = exchange("GET", "/api/v1/jobs", bearer(token(claims().build())));

        production(delegate).handle(exchange);

        verify(exchange).sendResponseHeaders(eq(503), anyLong());
        verify(delegate, never()).handle(any());
    }

    @Test
    void publicProbesStayOpenWithoutCredentials() throws Exception {
        HttpHandler delegate = mock(HttpHandler.class);
        production(delegate).handle(exchange("GET", "/health/ready", Map.of()));
        verify(delegate).handle(any());
    }

    @Test
    void devModeAcceptsBothAndTheIdentityRecordSaysWhichOneItWas() throws Exception {
        HttpHandler delegate = mock(HttpHandler.class);
        HttpExchange viaDev = exchange("GET", "/dev/v1/context", Map.of(
                "Authorization", "Bearer " + devToken("dev-user")));
        dev(delegate).handle(viaDev);
        HttpExchange viaOidc = exchange("GET", "/dev/v1/context", Map.of(
                "Authorization", "Bearer " + token(claims()
                        .claim("realm_access", Map.of("roles", List.of("media:project:dev:read"))).build())));
        dev(delegate).handle(viaOidc);

        ArgumentCaptor<HttpExchange> seen = ArgumentCaptor.forClass(HttpExchange.class);
        verify(delegate, org.mockito.Mockito.times(2)).handle(seen.capture());
        var first = MediaSecurityFilter.verifiedIdentity(seen.getAllValues().get(0));
        var second = MediaSecurityFilter.verifiedIdentity(seen.getAllValues().get(1));
        assertThat(first.assurance()).isEqualTo(AssuranceSource.DEV_ISSUED);
        assertThat(first.idpVerified()).isFalse();
        assertThat(MediaSecurityFilter.authenticatedPrincipal(seen.getAllValues().get(0)).assurance())
                .isEqualTo(AssuranceSource.DEV_ISSUED);
        assertThat(second.assurance()).isEqualTo(AssuranceSource.OIDC_VERIFIED);
        assertThat(second.idpVerified()).isTrue();
        assertThat(MediaSecurityFilter.isDevOnlyIdentity(seen.getAllValues().get(1))).isTrue();
    }

    @Test
    void aDevTokenCannotMintAPrincipalInTheReservedOidcSpace() throws Exception {
        HttpHandler delegate = mock(HttpHandler.class);
        String forged = devToken(MediaVerifiedIdentityContracts.oidcPrincipalId(ISSUER, "victim"));
        HttpExchange exchange = exchange("GET", "/dev/v1/context", Map.of("Authorization", "Bearer " + forged));

        dev(delegate).handle(exchange);

        verify(exchange).sendResponseHeaders(eq(401), anyLong());
        verify(delegate, never()).handle(any());
    }

    @Test
    void devModeStillRefusesAForgedOidcTokenAndGarbage() throws Exception {
        HttpHandler delegate = mock(HttpHandler.class);
        for (String candidate : List.of(OidcTestSupport.signRs256(OidcTestSupport.rsa("rsa-1"), claims().build()), "garbage")) {
            HttpExchange exchange = exchange("GET", "/dev/v1/context", Map.of("Authorization", "Bearer " + candidate));
            dev(delegate).handle(exchange);
            verify(exchange).sendResponseHeaders(eq(401), anyLong());
        }
        verify(delegate, never()).handle(any());
    }

    @Test
    void requiredOidcMakesAProductionLikeProfileRefuseToStartWithoutAnIdentityProvider() {
        Map<String, String> environment = Map.of(OidcConfig.REQUIRED, "true");
        assertThatThrownBy(() -> new MediaSecurityFilter(mock(HttpHandler.class), "production", environment, clock))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining(OidcConfig.ISSUER);
        assertThatThrownBy(() -> new MediaSecurityFilter(mock(HttpHandler.class), "production",
                Map.of(OidcConfig.ISSUER, ISSUER), clock))
                .as("an issuer without an audience is a startup failure, not silently disabled verification")
                .isInstanceOf(IllegalArgumentException.class);
    }
}
