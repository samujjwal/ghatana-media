package com.ghatana.media.launcher;

import com.ghatana.launcher.security.JwtAuthenticationVerifier;
import com.ghatana.media.runtime.MediaDeploymentProfiles;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.launcher.security.SecurityFilterSupport;
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
    private static final Set<String> PUBLIC_PATHS = Set.of(
            "/health", "/health/live", "/health/ready", "/health/startup",
            "/ready", "/metrics", "/info", "/api/v1/health");

    private final SecurityFilterSupport support;
    private final HttpHandler delegate;
    private final JwtAuthenticationVerifier jwtVerifier;
    private final JwtAuthenticationVerifier devJwtVerifier;
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
        this.delegate = java.util.Objects.requireNonNull(delegate, "delegate");
        Map<String, String> immutable = Map.copyOf(environment);
        this.clock = java.util.Objects.requireNonNull(clock, "clock");
        this.productionLike = MediaDeploymentProfiles.productionLike(deploymentProfile);
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
                    SecurityFilterSupport.sendError(exchange, 401, "UNAUTHENTICATED", "Invalid DEV_ONLY bearer token");
                    return;
                }
                var identity = devVerified.orElseThrow();
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
                        identity.tenantId(), identity.subject(), clock.instant());
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
                        identity.tenantId(), identity.subject(), clock.instant());
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
                            tenant, localPrincipal, clock.instant());
                }
            } else if (!devIdentityEnabled && hasApiKey) {
                // authorizeBootstrapApiKey has already matched the configured service tenant and
                // replaced the caller's principal hint with the configured service identity.
                authenticated = new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                        bootstrapApiKeyTenant, bootstrapServiceId, clock.instant());
            }
            if (authenticated != null) {
                // The controller consumes this server-side context. Request headers remain useful
                // for compatibility, but are never the controller's source of identity.
                exchange.setAttribute(AUTHENTICATED_PRINCIPAL_ATTRIBUTE, authenticated);
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
