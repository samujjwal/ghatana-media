package com.ghatana.media.launcher.oidc;

import com.nimbusds.jose.jwk.ECKey;
import com.nimbusds.jose.jwk.JWK;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.KeyUse;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.Curve;
import com.nimbusds.jose.util.JSONObjectUtils;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Bounded, fail-closed JWKS cache with {@code kid}-driven key rotation.
 *
 * <p>Behaviour: keys are fetched lazily and cached for the configured TTL. A token naming an unknown
 * {@code kid} triggers at most one refetch, and refetches (including failed ones) are rate-limited by the minimum
 * refresh interval so unauthenticated callers cannot turn this cache into a request amplifier. If a refresh fails
 * the previous snapshot is served only inside the stale-if-error grace window; beyond it every lookup fails closed
 * with {@link KeysUnavailableException}. Response bodies, key counts and key sizes are bounded; redirects are never
 * followed; only RSA (2048 bits or more) and EC P-256 public signature keys are admitted.
 *
 * @doc.type class
 * @doc.purpose JWKS retrieval and caching for OIDC token verification
 * @doc.layer product
 * @doc.pattern Cache
 */
public final class OidcJwksCache {
    static final int MAX_BODY_BYTES = 1_048_576;
    static final int MAX_KEYS = 64;

    /** Minimal HTTP seam so tests can drive discovery and JWKS retrieval deterministically. */
    @FunctionalInterface
    public interface Fetcher {
        String get(URI uri) throws IOException;
    }

    /** No usable key material could be obtained. The caller must refuse the request (fail closed). */
    public static final class KeysUnavailableException extends RuntimeException {
        KeysUnavailableException(String message, Throwable cause) { super(message, cause); }
    }

    private record Snapshot(Map<String, JWK> keys, Instant fetchedAt) { }

    private final OidcConfig config;
    private final Fetcher fetcher;
    private final Clock clock;
    private URI jwksUri;
    private Snapshot snapshot;
    private Instant lastAttempt;
    private int fetchCount;

    public OidcJwksCache(OidcConfig config, Fetcher fetcher, Clock clock) {
        this.config = Objects.requireNonNull(config, "config");
        this.fetcher = Objects.requireNonNull(fetcher, "fetcher");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.jwksUri = config.jwksUriOverride();
    }

    /** Default HTTP fetcher: bounded timeouts and body size, GET only, no redirects, 200 only. */
    public static Fetcher httpFetcher(Duration timeout) {
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(timeout)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
        return uri -> {
            HttpRequest request = HttpRequest.newBuilder(uri).timeout(timeout)
                    .header("Accept", "application/json").GET().build();
            try {
                HttpResponse<InputStream> response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
                try (InputStream body = response.body()) {
                    if (response.statusCode() != 200) {
                        throw new IOException("unexpected HTTP status " + response.statusCode());
                    }
                    byte[] bytes = body.readNBytes(MAX_BODY_BYTES + 1);
                    if (bytes.length > MAX_BODY_BYTES) throw new IOException("response exceeds the size ceiling");
                    return new String(bytes, StandardCharsets.UTF_8);
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted", interrupted);
            }
        };
    }

    /** Number of network fetch attempts for the JWKS document (discovery excluded); for tests and metrics. */
    public synchronized int jwksFetchCount() { return fetchCount; }

    /**
     * Returns the public key for {@code kid}, or {@code null} when the provider does not publish it (after at most
     * one allowed refetch).
     *
     * @throws KeysUnavailableException when no key material is usable
     */
    public synchronized JWK find(String kid) {
        Instant now = clock.instant();
        if (snapshot == null || age(now).compareTo(config.jwksTtl()) >= 0) {
            refreshIfAllowed(now);
        }
        JWK key = lookup(kid, now);
        if (key != null) return key;
        // Unknown kid: possible key rotation. One bounded refetch, rate-limited by the minimum interval.
        refreshIfAllowed(now);
        return lookup(kid, now);
    }

    private JWK lookup(String kid, Instant now) {
        if (snapshot == null || age(now).compareTo(config.jwksTtl().plus(config.jwksStaleGrace())) > 0) {
            throw new KeysUnavailableException("OIDC signing keys are unavailable", null);
        }
        return snapshot.keys().get(kid);
    }

    private Duration age(Instant now) {
        return Duration.between(snapshot.fetchedAt(), now);
    }

    private void refreshIfAllowed(Instant now) {
        if (lastAttempt != null && Duration.between(lastAttempt, now).compareTo(config.jwksMinRefreshInterval()) < 0) {
            return;
        }
        lastAttempt = now;
        try {
            URI uri = jwksUri != null ? jwksUri : discoverJwksUri();
            fetchCount++;
            Map<String, JWK> keys = parseKeys(fetcher.get(uri));
            jwksUri = uri;
            snapshot = new Snapshot(keys, now);
        } catch (IOException | RuntimeException failure) {
            // Keep any previous snapshot for the stale-if-error window; never log response bodies.
            if (snapshot == null) {
                throw new KeysUnavailableException("OIDC signing keys could not be retrieved", failure);
            }
        }
    }

    private URI discoverJwksUri() throws IOException {
        String base = config.issuer().endsWith("/") ? config.issuer().substring(0, config.issuer().length() - 1)
                : config.issuer();
        Map<String, Object> document;
        try {
            document = JSONObjectUtils.parse(fetcher.get(URI.create(base + "/.well-known/openid-configuration")));
        } catch (java.text.ParseException invalid) {
            throw new IOException("malformed discovery document", invalid);
        }
        if (!config.issuer().equals(document.get("issuer"))) {
            throw new IOException("discovery document issuer does not match the configured issuer");
        }
        if (!(document.get("jwks_uri") instanceof String value)) throw new IOException("discovery document has no jwks_uri");
        URI uri = URI.create(value);
        OidcConfig.requireEndpoint(uri, "jwks_uri");
        return uri;
    }

    static Map<String, JWK> parseKeys(String body) throws IOException {
        JWKSet set;
        try {
            set = JWKSet.parse(body);
        } catch (java.text.ParseException invalid) {
            throw new IOException("malformed JWKS document", invalid);
        }
        Map<String, JWK> keys = new HashMap<>();
        for (JWK jwk : set.getKeys()) {
            if (keys.size() >= MAX_KEYS) break;
            String kid = jwk.getKeyID();
            if (kid == null || kid.isBlank() || kid.length() > 256) continue;
            if (jwk.getKeyUse() != null && !KeyUse.SIGNATURE.equals(jwk.getKeyUse())) continue;
            if (jwk instanceof RSAKey rsa && rsa.size() >= 2048) {
                keys.put(kid, rsa.toPublicJWK());
            } else if (jwk instanceof ECKey ec && Curve.P_256.equals(ec.getCurve())) {
                keys.put(kid, ec.toPublicJWK());
            }
        }
        if (keys.isEmpty()) throw new IOException("JWKS contains no admissible signature keys");
        return Map.copyOf(keys);
    }
}
