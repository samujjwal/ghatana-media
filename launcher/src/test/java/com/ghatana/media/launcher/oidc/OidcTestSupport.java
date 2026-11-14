package com.ghatana.media.launcher.oidc;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.JWSSigner;
import com.nimbusds.jose.crypto.ECDSASigner;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.Curve;
import com.nimbusds.jose.jwk.ECKey;
import com.nimbusds.jose.jwk.JWK;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.ECKeyGenerator;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/** Test-only key material and token minting. Keys are generated per run; nothing here is a credential. */
public final class OidcTestSupport {
    public static final String ISSUER = "https://idp.example.test/realms/media";
    public static final String AUDIENCE = "ghatana-media";
    public static final Instant NOW = Instant.parse("2026-11-14T10:00:00Z");

    private OidcTestSupport() { }

    /** Mutable clock so tests can move time without sleeping. */
    public static final class TestClock extends Clock {
        private final AtomicReference<Instant> now = new AtomicReference<>(NOW);
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now.get(); }
        public void advance(java.time.Duration by) { now.updateAndGet(value -> value.plus(by)); }
    }

    public static RSAKey rsa(String kid) {
        try {
            return new RSAKeyGenerator(2048).keyID(kid).generate();
        } catch (JOSEException failure) {
            throw new IllegalStateException(failure);
        }
    }

    public static ECKey ec(String kid) {
        try {
            return new ECKeyGenerator(Curve.P_256).keyID(kid).generate();
        } catch (JOSEException failure) {
            throw new IllegalStateException(failure);
        }
    }

    public static String jwks(JWK... keys) {
        return new JWKSet(List.of(keys)).toString();
    }

    /** Claims for a valid access token; individual tests override fields. */
    public static JWTClaimsSet.Builder claims(Instant now) {
        return new JWTClaimsSet.Builder()
                .issuer(ISSUER)
                .audience(AUDIENCE)
                .subject("5b6c1c1e-0000-4000-8000-000000000001")
                .issueTime(Date.from(now))
                .expirationTime(Date.from(now.plusSeconds(300)))
                .claim("typ", "Bearer")
                .claim("tenant_id", "tenant-a")
                .claim("realm_access", Map.of("roles", List.of("media:job:read", "media:artifact:read")))
                .claim("resource_access", Map.of(AUDIENCE, Map.of("roles", List.of("media:job:cancel"))));
    }

    public static String sign(JWK key, JWSAlgorithm algorithm, JWTClaimsSet claims) {
        try {
            JWSSigner signer = key instanceof RSAKey rsa ? new RSASSASigner(rsa) : new ECDSASigner((ECKey) key);
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(algorithm).keyID(key.getKeyID()).build(), claims);
            jwt.sign(signer);
            return jwt.serialize();
        } catch (JOSEException failure) {
            throw new IllegalStateException(failure);
        }
    }

    public static String signRs256(RSAKey key, JWTClaimsSet claims) {
        return sign(key, JWSAlgorithm.RS256, claims);
    }

    public static String signEs256(ECKey key, JWTClaimsSet claims) {
        return sign(key, JWSAlgorithm.ES256, claims);
    }

    /** HS256 token whose key is some other secret, with an arbitrary kid. */
    public static String hmac(JWTClaimsSet claims, String kid) {
        try {
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.HS256).keyID(kid).build(), claims);
            jwt.sign(new MACSigner(new byte[32]));
            return jwt.serialize();
        } catch (JOSEException failure) {
            throw new IllegalStateException(failure);
        }
    }

    /** A syntactically valid unsecured (alg none) JWT. */
    public static String algNone(JWTClaimsSet claims) {
        java.util.Base64.Encoder encoder = java.util.Base64.getUrlEncoder().withoutPadding();
        String header = encoder.encodeToString("{\"alg\":\"none\",\"kid\":\"k1\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String payload = encoder.encodeToString(claims.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return header + "." + payload + ".";
    }

    /** Scriptable fetcher counting JWKS retrievals; discovery serves the matching issuer and jwks_uri. */
    public static final class FakeIdp implements OidcJwksCache.Fetcher {
        public volatile String jwks;
        public volatile boolean unreachable;
        public volatile int jwksRequests;
        public volatile int discoveryRequests;
        public volatile String discoveredIssuer = ISSUER;

        public FakeIdp(String jwks) { this.jwks = jwks; }

        @Override public String get(java.net.URI uri) throws java.io.IOException {
            if (unreachable) throw new java.io.IOException("connection refused");
            String path = uri.getPath();
            if (path.endsWith("/.well-known/openid-configuration")) {
                discoveryRequests++;
                return "{\"issuer\":\"" + discoveredIssuer + "\",\"jwks_uri\":\"https://idp.example.test/realms/media/certs\"}";
            }
            jwksRequests++;
            return jwks;
        }
    }
}
