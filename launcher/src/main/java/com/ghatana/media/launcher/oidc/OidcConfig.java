package com.ghatana.media.launcher.oidc;

import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Environment-driven configuration for the provider-neutral OIDC access-token verifier.
 *
 * <p>Nothing here is provider specific: the default claim paths ({@code realm_access.roles},
 * {@code resource_access.<audience>.roles}) merely match the claim layout several providers emit, and every
 * path is overridable. A configuration that names an issuer but is otherwise invalid is rejected at startup
 * rather than silently disabling verification.
 *
 * @doc.type record
 * @doc.purpose OIDC verifier configuration
 * @doc.layer product
 * @doc.pattern Configuration
 */
public record OidcConfig(
        String issuer,
        String audience,
        URI jwksUriOverride,
        String tenantClaim,
        List<String> permissionClaims,
        Duration clockSkew,
        Duration jwksTtl,
        Duration jwksMinRefreshInterval,
        Duration jwksStaleGrace,
        Duration httpTimeout) {

    public static final String ISSUER = "MEDIA_OIDC_ISSUER";
    public static final String AUDIENCE = "MEDIA_OIDC_AUDIENCE";
    public static final String JWKS_URI = "MEDIA_OIDC_JWKS_URI";
    public static final String TENANT_CLAIM = "MEDIA_OIDC_TENANT_CLAIM";
    public static final String PERMISSION_CLAIMS = "MEDIA_OIDC_PERMISSION_CLAIMS";
    public static final String CLOCK_SKEW_SECONDS = "MEDIA_OIDC_CLOCK_SKEW_SECONDS";
    public static final String JWKS_TTL_SECONDS = "MEDIA_OIDC_JWKS_TTL_SECONDS";
    public static final String JWKS_MIN_REFRESH_SECONDS = "MEDIA_OIDC_JWKS_MIN_REFRESH_SECONDS";
    public static final String REQUIRED = "MEDIA_OIDC_REQUIRED";

    public static final String DEFAULT_TENANT_CLAIM = "tenant_id";
    static final int MAX_PATHS = 8;

    public OidcConfig {
        issuer = requireIssuer(issuer);
        audience = requireText(audience, AUDIENCE);
        if (jwksUriOverride != null) requireEndpoint(jwksUriOverride, JWKS_URI);
        tenantClaim = requireText(tenantClaim, TENANT_CLAIM);
        permissionClaims = List.copyOf(Objects.requireNonNull(permissionClaims, "permissionClaims"));
        if (permissionClaims.isEmpty() || permissionClaims.size() > MAX_PATHS) {
            throw new IllegalArgumentException(PERMISSION_CLAIMS + " must name 1-" + MAX_PATHS + " claim paths");
        }
        clockSkew = bounded(clockSkew, Duration.ZERO, Duration.ofMinutes(2), CLOCK_SKEW_SECONDS);
        jwksTtl = bounded(jwksTtl, Duration.ofSeconds(10), Duration.ofHours(24), JWKS_TTL_SECONDS);
        jwksMinRefreshInterval = bounded(jwksMinRefreshInterval, Duration.ofSeconds(1), Duration.ofHours(1),
                JWKS_MIN_REFRESH_SECONDS);
        jwksStaleGrace = bounded(jwksStaleGrace, Duration.ZERO, Duration.ofHours(1), "jwksStaleGrace");
        httpTimeout = bounded(httpTimeout, Duration.ofMillis(200), Duration.ofSeconds(30), "httpTimeout");
    }

    /** Returns empty when {@code MEDIA_OIDC_ISSUER} is absent; throws when it is present but misconfigured. */
    public static Optional<OidcConfig> fromEnvironment(Map<String, String> environment) {
        String issuer = environment.get(ISSUER);
        if (issuer == null || issuer.isBlank()) {
            return Optional.empty();
        }
        String audience = environment.get(AUDIENCE);
        String jwks = environment.get(JWKS_URI);
        List<String> permissionClaims = new ArrayList<>();
        String configured = environment.get(PERMISSION_CLAIMS);
        if (configured == null || configured.isBlank()) {
            permissionClaims.add("realm_access.roles");
            if (audience != null && !audience.isBlank()) {
                permissionClaims.add("resource_access." + audience.strip() + ".roles");
            }
        } else {
            for (String path : configured.split(",")) {
                if (!path.isBlank()) permissionClaims.add(path.strip());
            }
        }
        return Optional.of(new OidcConfig(
                issuer.strip(),
                audience,
                jwks == null || jwks.isBlank() ? null : URI.create(jwks.strip()),
                environment.getOrDefault(TENANT_CLAIM, DEFAULT_TENANT_CLAIM).strip(),
                permissionClaims,
                seconds(environment, CLOCK_SKEW_SECONDS, 30),
                seconds(environment, JWKS_TTL_SECONDS, 300),
                seconds(environment, JWKS_MIN_REFRESH_SECONDS, 30),
                Duration.ofMinutes(2),
                Duration.ofSeconds(5)));
    }

    public static boolean required(Map<String, String> environment) {
        String value = environment.getOrDefault(REQUIRED, "false");
        if ("true".equalsIgnoreCase(value)) return true;
        if ("false".equalsIgnoreCase(value)) return false;
        throw new IllegalArgumentException(REQUIRED + " must be true or false");
    }

    /** Test-friendly factory with provider-neutral defaults. */
    public static OidcConfig of(String issuer, String audience, URI jwksUriOverride) {
        return new OidcConfig(issuer, audience, jwksUriOverride, DEFAULT_TENANT_CLAIM,
                List.of("realm_access.roles", "resource_access." + audience + ".roles"),
                Duration.ofSeconds(30), Duration.ofMinutes(5), Duration.ofSeconds(30), Duration.ofMinutes(2),
                Duration.ofSeconds(5));
    }

    public OidcConfig withClockSkew(Duration skew) {
        return new OidcConfig(issuer, audience, jwksUriOverride, tenantClaim, permissionClaims, skew, jwksTtl,
                jwksMinRefreshInterval, jwksStaleGrace, httpTimeout);
    }

    public OidcConfig withJwksTiming(Duration ttl, Duration minRefresh, Duration staleGrace) {
        return new OidcConfig(issuer, audience, jwksUriOverride, tenantClaim, permissionClaims, clockSkew, ttl,
                minRefresh, staleGrace, httpTimeout);
    }

    private static Duration seconds(Map<String, String> environment, String name, long fallback) {
        String value = environment.get(name);
        if (value == null || value.isBlank()) return Duration.ofSeconds(fallback);
        try {
            return Duration.ofSeconds(Long.parseLong(value.strip()));
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException(name + " must be a whole number of seconds");
        }
    }

    private static Duration bounded(Duration value, Duration min, Duration max, String name) {
        Objects.requireNonNull(value, name);
        if (value.compareTo(min) < 0 || value.compareTo(max) > 0) {
            throw new IllegalArgumentException(name + " must be between " + min + " and " + max);
        }
        return value;
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank() || value.length() > 512 || value.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException(name + " must be configured (nonblank, at most 512 characters)");
        }
        return value.strip();
    }

    private static String requireIssuer(String issuer) {
        String value = requireText(issuer, ISSUER);
        URI uri = URI.create(value);
        requireEndpoint(uri, ISSUER);
        if (uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalArgumentException(ISSUER + " must not carry a query or fragment");
        }
        return value;
    }

    /** HTTPS is required except for loopback hosts, which exist only for local development and tests. */
    static void requireEndpoint(URI uri, String name) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost();
        if (host == null || uri.getUserInfo() != null) {
            throw new IllegalArgumentException(name + " must be an absolute URL without credentials");
        }
        boolean loopback = host.equals("localhost") || host.equals("127.0.0.1") || host.equals("[::1]")
                || host.endsWith(".localhost");
        if (!scheme.equals("https") && !(scheme.equals("http") && loopback)) {
            throw new IllegalArgumentException(name + " must use https (http is allowed only for loopback hosts)");
        }
    }
}
