package com.ghatana.media.launcher;

import com.ghatana.launcher.security.JwtAuthenticationVerifier;
import com.ghatana.launcher.security.SecurityFilterSupport;
import com.ghatana.media.launcher.oidc.OidcAccessTokenVerifier;
import com.ghatana.media.launcher.oidc.OidcConfig;
import com.ghatana.media.runtime.MediaDeploymentProfiles;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.VerifiedIdentity;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Shared fail-closed authentication filter with public operational probes.
 *
 * @doc.type class
 * @doc.purpose Provide Media Security Filter behavior
 * @doc.layer product
 * @doc.pattern Controller
 */
public final class MediaSecurityFilter implements HttpHandler {
    private static final String DEV_ONLY_ISSUER = "urn:ghatana:media:dev-only";
    private static final String DEV_ONLY_AUDIENCE = "ghatana-media-dev";
    private static final String DEV_ONLY_SECRET = "MEDIA_DEV_JWT_HMAC_SECRET";
    static final String AUTHENTICATED_PRINCIPAL_ATTRIBUTE =
            MediaSecurityFilter.class.getName() + ".authenticatedPrincipal";
    private static final String DEV_ONLY_AUTHENTICATED_ATTRIBUTE =
            MediaSecurityFilter.class.getName() + ".devOnlyAuthenticated";
    private static final String DEV_ONLY_PERMISSIONS_ATTRIBUTE =
            MediaSecurityFilter.class.getName() + ".devOnlyPermissions";
    static final String VERIFIED_IDENTITY_ATTRIBUTE =
            MediaSecurityFilter.class.getName() + ".verifiedIdentity";
    private static final Set<String> PUBLIC_PATHS = Set.of(
            "/health", "/health/live", "/health/ready", "/health/startup",
            "/ready", "/metrics", "/info", "/api/v1/health");

    private final SecurityFilterSupport support;
    private final HttpHandler delegate;
    private final JwtAuthenticationVerifier jwtVerifier;
    private final JwtAuthenticationVerifier devJwtVerifier;
    private final OidcAccessTokenVerifier oidc;
    private final boolean devIdentityEnabled;
    private final boolean productionLike;
    private final boolean bootstrapApiKeyEnabled;
    private final String bootstrapApiKeyTenant;
    private final String bootstrapServiceId;
    private final Clock clock;

    public MediaSecurityFilter(HttpHandler delegate, String deploymentProfile) {
        this(delegate, deploymentProfile, System.getenv(), Clock.systemUTC());
    }

    MediaSecurityFilter(
            HttpHandler delegate,
            String deploymentProfile,
            Map<String, String> environment,
            Clock clock) {
        this(delegate, deploymentProfile, environment, clock,
                OidcAccessTokenVerifier.fromEnvironment(environment, clock).orElse(null));
    }

    /** Test seam: an explicit OIDC verifier (or null for none) instead of one built from the environment. */
    MediaSecurityFilter(
            HttpHandler delegate,
            String deploymentProfile,
            Map<String, String> environment,
            Clock clock,
            OidcAccessTokenVerifier oidcVerifier) {
        this.oidc = oidcVerifier;
        this.delegate = java.util.Objects.requireNonNull(delegate, "delegate");
        Map<String, String> immutable = Map.copyOf(environment);
        this.clock = java.util.Objects.requireNonNull(clock, "clock");
        this.productionLike = MediaDeploymentProfiles.productionLike(deploymentProfile);
        if (productionLike && oidc == null && OidcConfig.required(immutable)) {
            throw new IllegalArgumentException(OidcConfig.REQUIRED + "=true requires " + OidcConfig.ISSUER
                    + " and " + OidcConfig.AUDIENCE + " in a production-like profile");
        }
        this.devIdentityEnabled = parseDevIdentityEnabled(immutable);
        if (devIdentityEnabled && !"dev".equals(MediaDeploymentProfiles.canonical(deploymentProfile))) {
            throw new IllegalArgumentException("MEDIA_DEV_IDENTITY_ENABLED is supported only for the dev profile");
        }
        Map<String, String> devVerifierEnvironment = devVerifierEnvironment(immutable, devIdentityEnabled);
        this.devJwtVerifier = devVerifierEnvironment == null
                ? null : JwtAuthenticationVerifier.fromEnvironment("MEDIA_DEV", devVerifierEnvironment, clock);
        Map<String, String> supportEnvironment = devIdentityEnabled
                ? mediaVerifierEnvironment(immutable) : immutable;
        this.support = new SecurityFilterSupport(
                "MEDIA-SEC", "MEDIA_API_KEY", delegate, deploymentProfile, supportEnvironment, clock);
        this.jwtVerifier = JwtAuthenticationVerifier.fromEnvironment("MEDIA", supportEnvironment, clock);
        this.bootstrapApiKeyEnabled = Boolean.parseBoolean(immutable.getOrDefault("MEDIA_BOOTSTRAP_API_KEYS_ENABLED", "false"));
        this.bootstrapApiKeyTenant = immutable.get("MEDIA_BOOTSTRAP_API_KEY_TENANT");
        this.bootstrapServiceId = immutable.get("MEDIA_BOOTSTRAP_API_KEY_SERVICE_ID");
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        try {
            // The JDK HttpServer exposes request headers as UnmodifiableHeaders, so identity
            // hints can only be scrubbed on a mutable copy — the delegate sees the wrapper.
            exchange = new MutableRequestHeadersExchange(exchange);
            if (PUBLIC_PATHS.contains(exchange.getRequestURI().getPath())) {
                delegate.handle(exchange);
                return;
            }
            // Principal headers are never credentials. Clear caller input before evaluating any
            // authentication mechanism so a local fixture or API key cannot impersonate a user.
            exchange.getRequestHeaders().remove("X-Principal-Id");
            String authorization = exchange.getRequestHeaders().getFirst(SecurityFilterSupport.HEADER_AUTHORIZATION);
            boolean hasApiKey = exchange.getRequestHeaders().getFirst(SecurityFilterSupport.HEADER_API_KEY) != null;
            MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated = null;
            if (hasApiKey && authorization != null) {
                SecurityFilterSupport.sendError(exchange, 401, "AMBIGUOUS_CREDENTIALS", "Use one authentication mechanism");
                return;
            }
            if (authorization != null && !authorization.startsWith("Bearer ")) {
                SecurityFilterSupport.sendError(exchange, 401, "UNAUTHENTICATED", "Unsupported authorization scheme");
                return;
            }
            if (!devIdentityEnabled && oidc != null) {
                // With an identity provider configured, production-like profiles accept only its tokens: no
                // shared-secret JWT and no API key. Non-production profiles use it whenever a bearer is sent.
                if (productionLike && (hasApiKey || authorization == null)) {
                    SecurityFilterSupport.sendError(exchange, 401, "UNAUTHENTICATED", "An OIDC bearer token is required");
                    return;
                }
                if (authorization != null) {
                    admitOidc(exchange, authorization.substring(7).trim(), false);
                    return;
                }
            }
            if (devIdentityEnabled) {
                // This opt-in mode admits only an operator-signed, short-lived dev token. Caller
                // identity headers and API keys do not provide an alternate path.
                if (hasApiKey || authorization == null || !authorization.startsWith("Bearer ")) {
                    SecurityFilterSupport.sendError(exchange, 401, "UNAUTHENTICATED", "A DEV_ONLY bearer token is required");
                    return;
                }
                Optional<JwtAuthenticationVerifier.VerifiedJwt> devVerified = devJwtVerifier.verify(
                        authorization.substring(7).trim(), null);
                if (devVerified.isEmpty()) {
                    if (oidc != null) {
                        // DEV mode accepts both: a token that is not an operator-signed DEV token may be an
                        // identity-provider token. The identity record carries which one it was.
                        admitOidc(exchange, authorization.substring(7).trim(), true);
                        return;
                    }
                    SecurityFilterSupport.sendError(exchange, 401, "UNAUTHENTICATED", "Invalid DEV_ONLY bearer token");
                    return;
                }
                var identity = devVerified.orElseThrow();
                if (identity.subject().startsWith(MediaVerifiedIdentityContracts.OIDC_PRINCIPAL_PREFIX)) {
                    // The oidc: principal space is reserved for identity-provider identities.
                    SecurityFilterSupport.sendError(exchange, 401, "UNAUTHENTICATED", "Invalid DEV_ONLY bearer token");
                    return;
                }
                if (!Boolean.TRUE.equals(identity.claims().get("dev_only"))) {
                    SecurityFilterSupport.sendError(exchange, 401, "UNAUTHENTICATED", "Bearer token is not marked DEV_ONLY");
                    return;
                }
                String required = requiredPermission(exchange.getRequestMethod(), exchange.getRequestURI().getPath(), true);
                if (required == null || !identity.hasPermission(required)) {
                    SecurityFilterSupport.sendError(exchange, 403, "FORBIDDEN", "Access denied");
                    return;
                }
                exchange.setAttribute(DEV_ONLY_AUTHENTICATED_ATTRIBUTE, Boolean.TRUE);
                Set<String> verifiedPermissions = Set.of(
                        "media:artifact:create", "media:artifact:write", "media:artifact:read",
                        "media:job:read", "media:job:cancel").stream()
                        .filter(identity::hasPermission)
                        .collect(java.util.stream.Collectors.toUnmodifiableSet());
                exchange.setAttribute(DEV_ONLY_PERMISSIONS_ATTRIBUTE, verifiedPermissions);
                replaceHint(exchange, SecurityFilterSupport.HEADER_TENANT_ID, identity.tenantId());
                replaceHint(exchange, "X-Principal-Id", identity.subject());
                authenticated = new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                        identity.tenantId(), identity.subject(), clock.instant(), AssuranceSource.DEV_ISSUED);
            } else if (productionLike && devJwtVerifier != null && authorization != null
                    && authorization.startsWith("Bearer ")
                    && devJwtVerifier.verify(authorization.substring(7).trim(), null).isPresent()) {
                // Even if production is misconfigured to accept a development key/claim set via
                // the general verifier, explicitly reject any token verifiable as DEV_ONLY.
                SecurityFilterSupport.sendError(exchange, 401, "DEV_ONLY_TOKEN_FORBIDDEN", "DEV_ONLY identity is not valid in production");
                return;
            }
            if (hasApiKey && !authorizeBootstrapApiKey(exchange)) return;
            if (!devIdentityEnabled && authorization != null && authorization.startsWith("Bearer ")) {
                String tenantHint = exchange.getRequestHeaders().getFirst(SecurityFilterSupport.HEADER_TENANT_ID);
                Optional<JwtAuthenticationVerifier.VerifiedJwt> verified = jwtVerifier.verify(
                        authorization.substring(7).trim(), tenantHint);
                if (verified.isEmpty()) {
                    SecurityFilterSupport.sendError(exchange, 401, "UNAUTHENTICATED", "Invalid JWT bearer token");
                    return;
                }
                var identity = verified.orElseThrow();
                if (identity.claims().containsKey("dev_only")) {
                    SecurityFilterSupport.sendError(exchange, 401, "DEV_ONLY_TOKEN_FORBIDDEN", "DEV_ONLY identity requires the enabled dev profile");
                    return;
                }
                String required = requiredPermission(exchange.getRequestMethod(), exchange.getRequestURI().getPath(), false);
                if (required == null || !identity.hasPermission(required)) {
                    SecurityFilterSupport.sendError(exchange, 403, "FORBIDDEN", "Access denied");
                    return;
                }
                replaceHint(exchange, SecurityFilterSupport.HEADER_TENANT_ID, identity.tenantId());
                replaceHint(exchange, "X-Principal-Id", identity.subject());
                authenticated = new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                        identity.tenantId(), identity.subject(), clock.instant(), AssuranceSource.SHARED_SECRET_JWT);
            } else if (!devIdentityEnabled && !productionLike) {
                // Local identities are intentionally synthetic and cannot be selected by clients.
                // Tenant remains a fixture input in local profiles; production uses verified JWT
                // tenant claims or the explicitly configured bootstrap service tenant.
                String localPrincipal = exchange.getRequestHeaders().getFirst(SecurityFilterSupport.HEADER_API_KEY) == null
                        ? "media-local-development" : "media-api-key-service";
                replaceHint(exchange, "X-Principal-Id", localPrincipal);
                String tenant = exchange.getRequestHeaders().getFirst(SecurityFilterSupport.HEADER_TENANT_ID);
                if (tenant != null && !tenant.isBlank()) {
                    authenticated = new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                            tenant, localPrincipal, clock.instant(), AssuranceSource.LOCAL_UNVERIFIED);
                }
            } else if (!devIdentityEnabled && hasApiKey) {
                // authorizeBootstrapApiKey has already matched the configured service tenant and
                // replaced the caller's principal hint with the configured service identity.
                authenticated = new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                        bootstrapApiKeyTenant, bootstrapServiceId, clock.instant(), AssuranceSource.BOOTSTRAP_SERVICE_KEY);
            }
            if (authenticated != null) {
                // The controller consumes this server-side context. Request headers remain useful
                // for compatibility, but are never the controller's source of identity.
                exchange.setAttribute(AUTHENTICATED_PRINCIPAL_ATTRIBUTE, authenticated);
                exchange.setAttribute(VERIFIED_IDENTITY_ATTRIBUTE, new VerifiedIdentity(
                        nonIdpIssuer(authenticated.assurance()), authenticated.principalId(),
                        authenticated.tenantId(), authenticated.authenticatedAt(), authenticated.assurance()));
            }
            support.handle(exchange);
        } catch (Exception e) {
            try {
                com.ghatana.launcher.security.SecurityFilterSupport.sendError(
                        exchange, 403, "SECURITY_ERROR", "Request blocked due to security check failure");
            } catch (IOException ignored) {
                // Exchange may already be closed
            }
        }
    }

    static MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticatedPrincipal(
            HttpExchange exchange) {
        Object value = exchange.getAttribute(AUTHENTICATED_PRINCIPAL_ATTRIBUTE);
        return value instanceof MediaSourceAuthorizationContracts.AuthenticatedPrincipal principal
                ? principal : null;
    }

    /** The trusted-identity record for this request: who, for which tenant, and how that was established. */
    static VerifiedIdentity verifiedIdentity(HttpExchange exchange) {
        return exchange.getAttribute(VERIFIED_IDENTITY_ATTRIBUTE) instanceof VerifiedIdentity identity ? identity : null;
    }

    private static String nonIdpIssuer(AssuranceSource assurance) {
        return switch (assurance) {
            case DEV_ISSUED -> DEV_ONLY_ISSUER;
            case SHARED_SECRET_JWT -> "urn:ghatana:media:shared-secret-jwt";
            case BOOTSTRAP_SERVICE_KEY -> "urn:ghatana:media:bootstrap-service-key";
            case LOCAL_UNVERIFIED, UNSPECIFIED, OIDC_VERIFIED -> "urn:ghatana:media:local-development";
        };
    }

    /**
     * Admits a request carrying an OIDC access token. The provider's signature, issuer, audience and lifetime
     * checks, the tenant claim and the mapped permissions decide admission; nothing about the caller is taken from
     * request headers. An unreachable identity provider yields 503, never acceptance.
     */
    private void admitOidc(HttpExchange exchange, String token, boolean devRoutes) throws IOException {
        OidcAccessTokenVerifier.Result result = oidc.verifyToken(token);
        if (result.status() == OidcAccessTokenVerifier.Status.UNAVAILABLE) {
            SecurityFilterSupport.sendError(exchange, 503, "IDENTITY_PROVIDER_UNAVAILABLE",
                    "The identity provider's signing keys are unavailable");
            return;
        }
        if (!result.verified()) {
            SecurityFilterSupport.sendError(exchange, 401, "UNAUTHENTICATED", "Invalid OIDC bearer token");
            return;
        }
        VerifiedIdentity identity = result.identity();
        String required = requiredPermission(exchange.getRequestMethod(), exchange.getRequestURI().getPath(), devRoutes);
        if (required == null || !result.permissions().contains(required)) {
            SecurityFilterSupport.sendError(exchange, 403, "FORBIDDEN", "Access denied");
            return;
        }
        if (devRoutes) {
            exchange.setAttribute(DEV_ONLY_AUTHENTICATED_ATTRIBUTE, Boolean.TRUE);
            exchange.setAttribute(DEV_ONLY_PERMISSIONS_ATTRIBUTE, Set.of(
                    "media:artifact:create", "media:artifact:write", "media:artifact:read",
                    "media:job:read", "media:job:cancel").stream()
                    .filter(result.permissions()::contains)
                    .collect(java.util.stream.Collectors.toUnmodifiableSet()));
        }
        replaceHint(exchange, SecurityFilterSupport.HEADER_TENANT_ID, identity.tenantId());
        replaceHint(exchange, "X-Principal-Id", identity.principalId());
        exchange.setAttribute(AUTHENTICATED_PRINCIPAL_ATTRIBUTE, identity.toAuthenticatedPrincipal());
        exchange.setAttribute(VERIFIED_IDENTITY_ATTRIBUTE, identity);
        // Admission is complete; the shared-secret support filter must not re-verify an identity-provider token.
        delegate.handle(exchange);
    }

    static boolean isDevOnlyIdentity(HttpExchange exchange) {
        return Boolean.TRUE.equals(exchange.getAttribute(DEV_ONLY_AUTHENTICATED_ATTRIBUTE));
    }

    static boolean hasDevOnlyPermission(HttpExchange exchange, String permission) {
        Object value = exchange.getAttribute(DEV_ONLY_PERMISSIONS_ATTRIBUTE);
        return value instanceof Set<?> permissions && permissions.contains(permission);
    }

    private static String requiredPermission(String method, String path, boolean devOnlyIdentity) {
        String canonical = MediaRouteManifest.requiredPermission(method, path);
        if (canonical != null || !devOnlyIdentity) return canonical;
        return MediaDevOnlyRoutePermissions.requiredPermission(method, path);
    }

    private static void replaceHint(HttpExchange exchange, String name, String value) {
        exchange.getRequestHeaders().remove(name);
        exchange.getRequestHeaders().set(name, value);
    }

    private boolean authorizeBootstrapApiKey(HttpExchange exchange) throws IOException {
        if (!productionLike) return true;
        String tenant = exchange.getRequestHeaders().getFirst(SecurityFilterSupport.HEADER_TENANT_ID);
        if (!bootstrapApiKeyEnabled || bootstrapApiKeyTenant == null || bootstrapServiceId == null || !bootstrapApiKeyTenant.equals(tenant)) {
            SecurityFilterSupport.sendError(exchange, 403, "BOOTSTRAP_CREDENTIAL_FORBIDDEN", "Bootstrap credential is not authorized for this tenant"); return false;
        }
        replaceHint(exchange, "X-Principal-Id", bootstrapServiceId); return true;
    }

    private static boolean parseDevIdentityEnabled(Map<String, String> environment) {
        String value = environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false");
        if ("true".equalsIgnoreCase(value)) return true;
        if ("false".equalsIgnoreCase(value)) return false;
        throw new IllegalArgumentException("MEDIA_DEV_IDENTITY_ENABLED must be true or false");
    }

    private static Map<String, String> devVerifierEnvironment(
            Map<String, String> environment, boolean required) {
        String secret = environment.get(DEV_ONLY_SECRET);
        if (secret == null || secret.getBytes(StandardCharsets.UTF_8).length < 32) {
            if (required) {
                throw new IllegalArgumentException("MEDIA_DEV_JWT_HMAC_SECRET must contain at least 32 UTF-8 bytes");
            }
            return null;
        }
        Map<String, String> verifierEnvironment = new HashMap<>(environment);
        verifierEnvironment.put("MEDIA_DEV_JWT_HMAC_SECRET_REFERENCE", "secret:env:" + DEV_ONLY_SECRET);
        verifierEnvironment.put("MEDIA_DEV_JWT_ISSUER", DEV_ONLY_ISSUER);
        verifierEnvironment.put("MEDIA_DEV_JWT_AUDIENCE", DEV_ONLY_AUDIENCE);
        return Map.copyOf(verifierEnvironment);
    }

    private static Map<String, String> mediaVerifierEnvironment(Map<String, String> environment) {
        Map<String, String> verifierEnvironment = new HashMap<>(environment);
        verifierEnvironment.put("MEDIA_JWT_HMAC_SECRET_REFERENCE", "secret:env:" + DEV_ONLY_SECRET);
        verifierEnvironment.put("MEDIA_JWT_ISSUER", DEV_ONLY_ISSUER);
        verifierEnvironment.put("MEDIA_JWT_AUDIENCE", DEV_ONLY_AUDIENCE);
        return Map.copyOf(verifierEnvironment);
    }

    /**
     * The JDK HttpServer exposes inbound request headers as UnmodifiableHeaders. Identity
     * hints must be scrubbed on a mutable copy before the delegate observes them.
     */
    private static final class MutableRequestHeadersExchange extends HttpExchange {
        private final HttpExchange delegate;
        private final com.sun.net.httpserver.Headers requestHeaders;

        MutableRequestHeadersExchange(HttpExchange delegate) {
            this.delegate = delegate;
            this.requestHeaders = new com.sun.net.httpserver.Headers();
            this.requestHeaders.putAll(delegate.getRequestHeaders());
        }

        @Override public com.sun.net.httpserver.Headers getRequestHeaders() { return requestHeaders; }
        @Override public com.sun.net.httpserver.Headers getResponseHeaders() { return delegate.getResponseHeaders(); }
        @Override public java.net.URI getRequestURI() { return delegate.getRequestURI(); }
        @Override public String getRequestMethod() { return delegate.getRequestMethod(); }
        @Override public com.sun.net.httpserver.HttpContext getHttpContext() { return delegate.getHttpContext(); }
        @Override public void close() { delegate.close(); }
        @Override public java.io.InputStream getRequestBody() { return delegate.getRequestBody(); }
        @Override public java.io.OutputStream getResponseBody() { return delegate.getResponseBody(); }
        @Override public void sendResponseHeaders(int code, long length) throws IOException { delegate.sendResponseHeaders(code, length); }
        @Override public java.net.InetSocketAddress getRemoteAddress() { return delegate.getRemoteAddress(); }
        @Override public int getResponseCode() { return delegate.getResponseCode(); }
        @Override public java.net.InetSocketAddress getLocalAddress() { return delegate.getLocalAddress(); }
        @Override public String getProtocol() { return delegate.getProtocol(); }
        @Override public Object getAttribute(String name) { return delegate.getAttribute(name); }
        @Override public void setAttribute(String name, Object value) { delegate.setAttribute(name, value); }
        @Override public void setStreams(java.io.InputStream in, java.io.OutputStream out) { delegate.setStreams(in, out); }
        @Override public com.sun.net.httpserver.HttpPrincipal getPrincipal() { return delegate.getPrincipal(); }
    }
}
