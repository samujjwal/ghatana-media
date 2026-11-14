package com.ghatana.media.runtime;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Objects;
import java.util.Optional;

/**
 * Trusted-identity contract consumed by Media features.
 *
 * <p>A {@link VerifiedIdentity} states who the caller is and how that was established. It is evidence
 * of authentication only: it never grants permissions, rights, consent or approval by itself, and an
 * {@link AssuranceSource#OIDC_VERIFIED} identity merely records that a configured OpenID Connect
 * identity provider vouched for the {@code (issuer, subject)} pair.
 *
 * @doc.type class
 * @doc.purpose Assurance-tagged verified identity contract and verification port
 * @doc.layer product
 * @doc.pattern Port
 */
public final class MediaVerifiedIdentityContracts {
    private MediaVerifiedIdentityContracts() { }

    /** How an identity was established. Only {@link #OIDC_VERIFIED} is backed by an external identity provider. */
    public enum AssuranceSource {
        /** Access token signature, issuer, audience and lifetime verified against a configured OIDC provider's JWKS. */
        OIDC_VERIFIED,
        /** Operator-signed DEV_ONLY token; not an identity-provider assertion. */
        DEV_ISSUED,
        /** Legacy shared-secret (HMAC) JWT; the signer is the deployment, not an identity provider. */
        SHARED_SECRET_JWT,
        /** Configured bootstrap service credential bound to one tenant. */
        BOOTSTRAP_SERVICE_KEY,
        /** Local development fixture identity; the caller chose the tenant. */
        LOCAL_UNVERIFIED,
        /** The constructing boundary did not state an assurance. Never treated as identity-provider backed. */
        UNSPECIFIED;

        public boolean idpVerified() { return this == OIDC_VERIFIED; }
    }

    /**
     * Verified identity. {@code principalId} is derived from the issuer and subject only; an email address
     * or display name is never an identity.
     */
    public record VerifiedIdentity(
            String issuer,
            String subject,
            String tenantId,
            Instant authenticatedAt,
            AssuranceSource assurance) {
        public VerifiedIdentity {
            issuer = bounded(issuer, "issuer");
            subject = bounded(subject, "subject");
            tenantId = bounded(tenantId, "tenantId");
            authenticatedAt = Objects.requireNonNull(authenticatedAt, "authenticatedAt");
            assurance = Objects.requireNonNull(assurance, "assurance");
        }

        public boolean idpVerified() { return assurance.idpVerified(); }

        /** Stable Media principal id for this identity. */
        public String principalId() {
            return assurance == AssuranceSource.OIDC_VERIFIED ? oidcPrincipalId(issuer, subject) : subject;
        }

        public MediaSourceAuthorizationContracts.AuthenticatedPrincipal toAuthenticatedPrincipal() {
            return new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                    tenantId, principalId(), authenticatedAt, assurance);
        }
    }

    /** Prefix reserved for identity-provider principals; no other mechanism may mint a principal in this space. */
    public static final String OIDC_PRINCIPAL_PREFIX = "oidc:";

    /** {@code oidc:<first 12 bytes of SHA-256(issuer) in hex>:<subject>}; bounded by the 512 character principal limit. */
    public static String oidcPrincipalId(String issuer, String subject) {
        bounded(issuer, "issuer");
        bounded(subject, "subject");
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(issuer.getBytes(StandardCharsets.UTF_8));
            return OIDC_PRINCIPAL_PREFIX + HexFormat.of().formatHex(digest, 0, 12) + ":" + subject;
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    /** Verifies a bearer credential. Empty means "not a valid identity", never a partial identity. */
    @FunctionalInterface
    public interface VerifiedIdentityPort {
        Optional<VerifiedIdentity> verify(String bearerToken);
    }

    private static String bounded(String value, String field) {
        Objects.requireNonNull(value, field);
        if (value.isBlank() || !value.equals(value.strip()) || value.length() > 255
                || value.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException(field + " must be bounded and nonblank");
        }
        return value;
    }
}
