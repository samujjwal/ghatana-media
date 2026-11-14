package com.ghatana.media.launcher.oidc;

import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.VerifiedIdentity;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.VerifiedIdentityPort;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSVerifier;
import com.nimbusds.jose.crypto.ECDSAVerifier;
import com.nimbusds.jose.crypto.RSASSAVerifier;
import com.nimbusds.jose.jwk.ECKey;
import com.nimbusds.jose.jwk.JWK;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;

import java.text.ParseException;
import java.time.Clock;
import java.time.Instant;
import java.util.Date;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * Provider-neutral verifier for OIDC/OAuth2 JWT access tokens.
 *
 * <p>Verification order: bounded parse, algorithm allow-list (RS256 and ES256 only; {@code none} and every HMAC
 * algorithm are refused, and header-supplied {@code jku}/{@code jwk}/{@code x5u} are never consulted), key lookup by
 * {@code kid} in the issuer's JWKS, signature, then issuer, audience, {@code exp}/{@code nbf}/{@code iat} with a small
 * skew, ID-token refusal, subject and tenant presence. The principal is the {@code (issuer, sub)} pair; email and
 * other display claims are ignored. Permissions are read from configurable claim paths. Any failure to obtain key
 * material is {@link Status#UNAVAILABLE}, never acceptance.
 *
 * @doc.type class
 * @doc.purpose Verify OIDC access tokens and map claims to a Media identity
 * @doc.layer product
 * @doc.pattern Verifier
 */
public final class OidcAccessTokenVerifier implements VerifiedIdentityPort {
    static final int MAX_TOKEN_CHARS = 16_384;
    static final int MAX_PERMISSIONS = 512;
    static final int MAX_PERMISSION_CHARS = 200;
    private static final Set<JWSAlgorithm> ALLOWED = Set.of(JWSAlgorithm.RS256, JWSAlgorithm.ES256);

    public enum Status { VERIFIED, REJECTED, UNAVAILABLE }

    /** Outcome of one verification. {@code reason} is a stable internal code and is never echoed with token content. */
    public record Result(Status status, VerifiedIdentity identity, Set<String> permissions, String reason) {
        static Result rejected(String reason) { return new Result(Status.REJECTED, null, Set.of(), reason); }
        static Result unavailable() { return new Result(Status.UNAVAILABLE, null, Set.of(), "KEYS_UNAVAILABLE"); }
        public boolean verified() { return status == Status.VERIFIED; }
    }

    private final OidcConfig config;
    private final OidcJwksCache keys;
    private final Clock clock;

    public OidcAccessTokenVerifier(OidcConfig config, OidcJwksCache keys, Clock clock) {
        this.config = Objects.requireNonNull(config, "config");
        this.keys = Objects.requireNonNull(keys, "keys");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    public static OidcAccessTokenVerifier create(OidcConfig config, Clock clock) {
        return new OidcAccessTokenVerifier(config,
                new OidcJwksCache(config, OidcJwksCache.httpFetcher(config.httpTimeout()), clock), clock);
    }

    /** Creates the verifier when {@code MEDIA_OIDC_ISSUER} is configured; fails fast on an invalid configuration. */
    public static Optional<OidcAccessTokenVerifier> fromEnvironment(Map<String, String> environment, Clock clock) {
        return OidcConfig.fromEnvironment(environment).map(config -> create(config, clock));
    }

    public OidcConfig config() { return config; }

    @Override
    public Optional<VerifiedIdentity> verify(String bearerToken) {
        Result result = verifyToken(bearerToken);
        return result.verified() ? Optional.of(result.identity()) : Optional.empty();
    }

    public Result verifyToken(String token) {
        if (token == null || token.isBlank() || token.length() > MAX_TOKEN_CHARS) {
            return Result.rejected("TOKEN_MALFORMED");
        }
        final SignedJWT jwt;
        try {
            jwt = SignedJWT.parse(token);
        } catch (ParseException | RuntimeException malformed) {
            return Result.rejected("TOKEN_MALFORMED");
        }
        JWSAlgorithm algorithm = jwt.getHeader().getAlgorithm();
        if (!ALLOWED.contains(algorithm)) return Result.rejected("ALGORITHM_NOT_ALLOWED");
        String kid = jwt.getHeader().getKeyID();
        if (kid == null || kid.isBlank() || kid.length() > 256) return Result.rejected("KEY_ID_REQUIRED");

        final JWK key;
        try {
            key = keys.find(kid);
        } catch (OidcJwksCache.KeysUnavailableException unavailable) {
            return Result.unavailable();
        }
        if (key == null) return Result.rejected("KEY_UNKNOWN");
        try {
            JWSVerifier verifier = verifierFor(algorithm, key);
            if (verifier == null || !jwt.verify(verifier)) return Result.rejected("SIGNATURE_INVALID");
        } catch (JOSEException | RuntimeException invalid) {
            return Result.rejected("SIGNATURE_INVALID");
        }
        final JWTClaimsSet claims;
        try {
            claims = jwt.getJWTClaimsSet();
        } catch (ParseException malformed) {
            return Result.rejected("CLAIMS_MALFORMED");
        }
        return mapClaims(claims);
    }

    private static JWSVerifier verifierFor(JWSAlgorithm algorithm, JWK key) throws JOSEException {
        if (JWSAlgorithm.RS256.equals(algorithm) && key instanceof RSAKey rsa) return new RSASSAVerifier(rsa);
        if (JWSAlgorithm.ES256.equals(algorithm) && key instanceof ECKey ec) return new ECDSAVerifier(ec);
        return null;
    }

    private Result mapClaims(JWTClaimsSet claims) {
        Instant now = clock.instant();
        if (!config.issuer().equals(claims.getIssuer())) return Result.rejected("ISSUER_MISMATCH");
        List<String> audience = claims.getAudience();
        if (audience == null || !audience.contains(config.audience())) return Result.rejected("AUDIENCE_MISMATCH");
        Date exp = claims.getExpirationTime();
        if (exp == null || now.isAfter(exp.toInstant().plus(config.clockSkew()))) return Result.rejected("TOKEN_EXPIRED");
        Date nbf = claims.getNotBeforeTime();
        if (nbf != null && now.plus(config.clockSkew()).isBefore(nbf.toInstant())) return Result.rejected("TOKEN_NOT_YET_VALID");
        Date iat = claims.getIssueTime();
        if (iat != null && now.plus(config.clockSkew()).isBefore(iat.toInstant())) return Result.rejected("TOKEN_NOT_YET_VALID");
        Object type = claims.getClaim("typ");
        if (type instanceof String text && ("ID".equalsIgnoreCase(text) || "Refresh".equalsIgnoreCase(text)
                || "Offline".equalsIgnoreCase(text))) {
            return Result.rejected("NOT_AN_ACCESS_TOKEN");
        }
        String subject = claims.getSubject();
        if (!plain(subject, 255)) return Result.rejected("SUBJECT_INVALID");
        String tenant = tenant(claims.getClaims());
        if (!plain(tenant, 128)) return Result.rejected("TENANT_CLAIM_MISSING");
        Set<String> permissions = permissions(claims.getClaims());
        VerifiedIdentity identity;
        try {
            identity = new VerifiedIdentity(config.issuer(), subject, tenant, now, AssuranceSource.OIDC_VERIFIED);
        } catch (IllegalArgumentException invalid) {
            return Result.rejected("IDENTITY_INVALID");
        }
        return new Result(Status.VERIFIED, identity, permissions, "OK");
    }

    private String tenant(Map<String, Object> claims) {
        Object value = resolve(claims, config.tenantClaim());
        if (value instanceof List<?> list && list.size() == 1) value = list.get(0);
        return value instanceof String text ? text : null;
    }

    private Set<String> permissions(Map<String, Object> claims) {
        Set<String> granted = new LinkedHashSet<>();
        for (String path : config.permissionClaims()) {
            Object value = resolve(claims, path);
            if (value instanceof List<?> list) {
                for (Object element : list) addPermission(granted, element);
            } else if (value instanceof String text) {
                for (String part : text.split("[\\s,]+")) addPermission(granted, part);
            }
        }
        return Set.copyOf(granted);
    }

    private static void addPermission(Set<String> granted, Object element) {
        if (granted.size() >= MAX_PERMISSIONS || !(element instanceof String text)) return;
        if (!text.isEmpty() && text.length() <= MAX_PERMISSION_CHARS && text.chars().noneMatch(Character::isISOControl)) {
            granted.add(text);
        }
    }

    /** Exact top-level key first (claim names may contain dots), then a dotted walk through nested objects. */
    static Object resolve(Map<String, Object> claims, String path) {
        if (claims.containsKey(path)) return claims.get(path);
        Object current = claims;
        for (String segment : path.split("\\.")) {
            if (!(current instanceof Map<?, ?> map)) return null;
            current = map.get(segment);
        }
        return current;
    }

    private static boolean plain(String value, int max) {
        return value != null && !value.isBlank() && value.equals(value.strip()) && value.length() <= max
                && value.chars().noneMatch(Character::isISOControl);
    }
}
