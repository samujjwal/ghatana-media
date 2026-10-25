package com.ghatana.media.launcher;

import com.ghatana.launcher.security.JwtAuthenticationVerifier;
import com.ghatana.launcher.security.SecurityFilterSupport;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.time.Clock;
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
    private static final Set<String> PUBLIC_PATHS = Set.of(
            "/health", "/health/live", "/health/ready", "/health/startup",
            "/ready", "/metrics", "/info", "/api/v1/health");

    private final SecurityFilterSupport support;
    private final HttpHandler delegate;
    private final JwtAuthenticationVerifier jwtVerifier;
    private final boolean productionLike;
    private final boolean bootstrapApiKeyEnabled;
    private final String bootstrapApiKeyTenant;
    private final String bootstrapServiceId;

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
        this.support = new SecurityFilterSupport(
                "MEDIA-SEC", "MEDIA_API_KEY", delegate, deploymentProfile, immutable, clock);
        this.jwtVerifier = JwtAuthenticationVerifier.fromEnvironment("MEDIA", immutable, clock);
        this.productionLike = productionLike(deploymentProfile);
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
            if (hasApiKey && authorization != null) {
                SecurityFilterSupport.sendError(exchange, 401, "AMBIGUOUS_CREDENTIALS", "Use one authentication mechanism");
                return;
            }
            if (authorization != null && !authorization.startsWith("Bearer ")) {
                SecurityFilterSupport.sendError(exchange, 401, "UNAUTHENTICATED", "Unsupported authorization scheme");
                return;
            }
            if (hasApiKey && !authorizeBootstrapApiKey(exchange)) return;
            if (authorization != null && authorization.startsWith("Bearer ")) {
                String tenantHint = exchange.getRequestHeaders().getFirst(SecurityFilterSupport.HEADER_TENANT_ID);
                Optional<JwtAuthenticationVerifier.VerifiedJwt> verified = jwtVerifier.verify(
                        authorization.substring(7).trim(), tenantHint);
                if (verified.isEmpty()) {
                    SecurityFilterSupport.sendError(exchange, 401, "UNAUTHENTICATED", "Invalid JWT bearer token");
                    return;
                }
                var identity = verified.orElseThrow();
                String required = MediaRouteManifest.requiredPermission(exchange.getRequestMethod(), exchange.getRequestURI().getPath());
                if (required == null || !identity.hasPermission(required)) {
                    SecurityFilterSupport.sendError(exchange, 403, "FORBIDDEN", "Access denied");
                    return;
                }
                replaceHint(exchange, SecurityFilterSupport.HEADER_TENANT_ID, identity.tenantId());
                replaceHint(exchange, "X-Principal-Id", identity.subject());
            } else if (!productionLike) {
                // Local identities are intentionally synthetic and cannot be selected by clients.
                // Tenant remains a fixture input in local profiles; production uses verified JWT
                // tenant claims or the explicitly configured bootstrap service tenant.
                String localPrincipal = exchange.getRequestHeaders().getFirst(SecurityFilterSupport.HEADER_API_KEY) == null
                        ? "media-local-development" : "media-api-key-service";
                replaceHint(exchange, "X-Principal-Id", localPrincipal);
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

    private static boolean productionLike(String profile) {
        String value = profile == null ? "local" : profile.toLowerCase(java.util.Locale.ROOT);
        return Set.of("production", "staging", "sovereign").contains(value);
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
