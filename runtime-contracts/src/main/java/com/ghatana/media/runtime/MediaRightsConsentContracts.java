package com.ghatana.media.runtime;

import java.time.Instant;
import java.util.EnumSet;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.List;

/**
 * Rights and consent authority contracts (owner decision, 2026-11-14): "Uploader + reviewer (Recommended):
 * The uploader states rights and consent for each source version. A second person must confirm before any
 * voice or likeness use, or before any external delivery. Every statement records who gave it, when and for
 * which exact file, and can be revoked."
 *
 * <p>Software never manufactures this evidence. An {@link Attestation} is a statement by an authenticated
 * principal about one exact artifact version and content digest; a {@link Confirmation} is a statement by a
 * different authenticated principal; a {@link Revocation} ends the statement. Records are append-only, a
 * new artifact version never inherits an earlier version's statements, and the principal is only ever the
 * transport-authenticated caller. Nothing here is a legal determination.</p>
 *
 * @doc.type class
 * @doc.purpose Typed rights/consent attestation, confirmation, revocation and resolver port
 * @doc.layer product
 * @doc.pattern SPI, AppendOnlyLedger, PrivacyControl
 */
public final class MediaRightsConsentContracts {
    /** The owner decision, quoted verbatim wherever the rule is documented or enforced. */
    public static final String OWNER_DECISION =
            "Uploader + reviewer (Recommended): The uploader states rights and consent for each source version. "
                    + "A second person must confirm before any voice or likeness use, or before any external "
                    + "delivery. Every statement records who gave it, when and for which exact file, and can be revoked.";
    public static final int MAX_BASIS_LENGTH = 2000;

    private MediaRightsConsentContracts() { }

    /** What is being stated. */
    public enum StatementKind {
        /** The attester states ownership of, or a licence over, the media. */
        MEDIA_RIGHTS,
        /** The attester states that identifiable people in the media consented to the listed scopes. */
        IDENTIFIABLE_PERSON_CONSENT
    }

    /** What the statement covers. */
    public enum Scope {
        PROCESSING(false),
        VOICE_OR_LIKENESS_USE(true),
        EXTERNAL_DELIVERY(true);

        private final boolean secondPersonConfirmation;

        Scope(boolean secondPersonConfirmation) { this.secondPersonConfirmation = secondPersonConfirmation; }

        /** True when a different principal must confirm before the scope may be admitted. */
        public boolean requiresSecondPersonConfirmation() { return secondPersonConfirmation; }

        /** Statement kinds that can carry this scope. */
        public Set<StatementKind> acceptedKinds() {
            return switch (this) {
                case PROCESSING -> EnumSet.allOf(StatementKind.class);
                case VOICE_OR_LIKENESS_USE -> EnumSet.of(StatementKind.IDENTIFIABLE_PERSON_CONSENT);
                case EXTERNAL_DELIVERY -> EnumSet.of(StatementKind.MEDIA_RIGHTS);
            };
        }
    }

    public enum Verdict { ADMITTED, DENIED, REVOKED, STALE, MISMATCH, UNAVAILABLE }

    public enum Reason {
        NO_ATTESTATION,
        OTHER_VERSION_ONLY,
        DIGEST_MISMATCH,
        SCOPE_NOT_COVERED,
        NOT_CONFIRMED,
        REVOKED,
        EXPIRED,
        AUTHORITY_UNAVAILABLE
    }

    /** Derived lifecycle of one attestation as of a given instant. */
    public enum Status { PENDING_CONFIRMATION, CONFIRMED, NOT_REQUIRED_TO_CONFIRM, REVOKED, EXPIRED }

    /** A statement by {@code attestingPrincipalId} about one exact artifact version. Immutable once appended. */
    public record Attestation(
            String tenantId,
            String attestationId,
            String artifactId,
            String artifactVersion,
            String contentSha256,
            String attestingPrincipalId,
            Instant attestedAt,
            StatementKind statementKind,
            Set<Scope> scopes,
            String basis,
            String supportingDocumentArtifactRef,
            String requestedConfirmerPrincipalId,
            Instant expiresAt) {
        public Attestation {
            tenantId = required(tenantId, "tenantId");
            attestationId = required(attestationId, "attestationId");
            artifactId = required(artifactId, "artifactId");
            artifactVersion = required(artifactVersion, "artifactVersion");
            contentSha256 = digest(contentSha256, "contentSha256");
            if (!artifactVersion.equals("sha256:" + contentSha256)) {
                throw new IllegalArgumentException("artifact version and content digest must identify the same bytes");
            }
            attestingPrincipalId = required(attestingPrincipalId, "attestingPrincipalId");
            Objects.requireNonNull(attestedAt, "attestedAt");
            Objects.requireNonNull(statementKind, "statementKind");
            scopes = scopes == null || scopes.isEmpty() ? Set.of() : Set.copyOf(EnumSet.copyOf(scopes));
            if (scopes.isEmpty()) throw new IllegalArgumentException("at least one scope is required");
            basis = required(basis, "basis", MAX_BASIS_LENGTH);
            supportingDocumentArtifactRef = optional(supportingDocumentArtifactRef, "supportingDocumentArtifactRef");
            requestedConfirmerPrincipalId = optional(requestedConfirmerPrincipalId, "requestedConfirmerPrincipalId");
            if (requestedConfirmerPrincipalId.equals(attestingPrincipalId)) {
                throw new IllegalArgumentException("the requested confirmer must be a different principal");
            }
            if (expiresAt != null && !expiresAt.isAfter(attestedAt)) {
                throw new IllegalArgumentException("expiresAt must be after attestedAt");
            }
        }

        public boolean needsSecondPersonConfirmation() {
            return scopes.stream().anyMatch(Scope::requiresSecondPersonConfirmation);
        }

        public boolean expiredAt(Instant now) { return expiresAt != null && !expiresAt.isAfter(now); }
    }

    /** A different principal's confirmation of one attestation. */
    public record Confirmation(String confirmingPrincipalId, Instant confirmedAt, String note) {
        public Confirmation {
            confirmingPrincipalId = required(confirmingPrincipalId, "confirmingPrincipalId");
            Objects.requireNonNull(confirmedAt, "confirmedAt");
            note = optional(note, "note", MAX_BASIS_LENGTH);
        }
    }

    /** Who ended the statement, when and why. */
    public record Revocation(String revokedByPrincipalId, Instant revokedAt, String reason) {
        public Revocation {
            revokedByPrincipalId = required(revokedByPrincipalId, "revokedByPrincipalId");
            Objects.requireNonNull(revokedAt, "revokedAt");
            reason = required(reason, "reason", MAX_BASIS_LENGTH);
        }
    }

    /** One attestation with its (at most one) confirmation and (at most one) revocation. */
    public record AttestationRecord(Attestation attestation, Confirmation confirmation, Revocation revocation) {
        public AttestationRecord {
            Objects.requireNonNull(attestation, "attestation");
        }

        public Status statusAt(Instant now) {
            if (revocation != null) return Status.REVOKED;
            if (attestation.expiredAt(now)) return Status.EXPIRED;
            if (confirmation != null) return Status.CONFIRMED;
            return attestation.needsSecondPersonConfirmation()
                    ? Status.PENDING_CONFIRMATION : Status.NOT_REQUIRED_TO_CONFIRM;
        }

        /** True when this record is currently sufficient for {@code scope} (kind, scope, revocation, expiry, confirmation). */
        public boolean admits(Scope scope, Instant now) {
            if (revocation != null || attestation.expiredAt(now)) return false;
            if (!attestation.scopes().contains(scope) || !scope.acceptedKinds().contains(attestation.statementKind())) {
                return false;
            }
            if (!scope.requiresSecondPersonConfirmation()) return true;
            return confirmation != null
                    && !confirmation.confirmingPrincipalId().equals(attestation.attestingPrincipalId());
        }
    }

    /** Exact lookup identity. The caller supplies the digest read from the real artifact record. */
    public record ResolutionRequest(
            String tenantId, String artifactId, String artifactVersion, String contentSha256, Scope scope) {
        public ResolutionRequest {
            tenantId = required(tenantId, "tenantId");
            artifactId = required(artifactId, "artifactId");
            artifactVersion = required(artifactVersion, "artifactVersion");
            contentSha256 = required(contentSha256, "contentSha256").toLowerCase(Locale.ROOT);
            Objects.requireNonNull(scope, "scope");
        }
    }

    /**
     * Resolver output. {@code attestationIds} lists the records that admitted the request (ADMITTED only) so
     * downstream evidence can cite them; reasons are explanatory and never evidence by themselves.
     */
    public record Resolution(Verdict verdict, Set<Reason> reasons, List<String> attestationIds, String resolverId) {
        public Resolution {
            Objects.requireNonNull(verdict, "verdict");
            reasons = reasons == null ? Set.of() : Set.copyOf(new LinkedHashSet<>(reasons));
            attestationIds = attestationIds == null ? List.of() : List.copyOf(attestationIds);
            resolverId = required(resolverId, "resolverId");
            if ((verdict == Verdict.ADMITTED) == attestationIds.isEmpty()) {
                throw new IllegalArgumentException("ADMITTED requires, and only ADMITTED carries, attestation ids");
            }
        }

        public boolean admitted() { return verdict == Verdict.ADMITTED; }

        public static Resolution unavailable(String resolverId) {
            return new Resolution(Verdict.UNAVAILABLE, Set.of(Reason.AUTHORITY_UNAVAILABLE), List.of(), resolverId);
        }
    }

    /**
     * Injectable resolver port. Admission paths (speech-to-text, text-to-speech, vision, multimodal, delivery,
     * render) call {@link #resolve} with the exact artifact id, version and content digest and a {@link Scope};
     * anything other than {@link Verdict#ADMITTED} must be treated as not admitted (fail closed). Implementations
     * must never throw for an absent record: they return DENIED. An unconfigured authority returns UNAVAILABLE.
     */
    public interface RightsConsentResolver {
        String resolverId();

        boolean ready();

        Resolution resolve(ResolutionRequest request);

        /** A resolver that admits nothing; the fail-closed default when no authority is configured. */
        static RightsConsentResolver unavailable() {
            return new RightsConsentResolver() {
                @Override public String resolverId() { return "media-rights-consent-unconfigured"; }
                @Override public boolean ready() { return false; }
                @Override public Resolution resolve(ResolutionRequest request) {
                    return Resolution.unavailable(resolverId());
                }
            };
        }
    }

    public enum ConfirmResult { CONFIRMED, NOT_FOUND, SELF_CONFIRMATION, ALREADY_CONFIRMED, REVOKED }

    public enum RevokeResult { REVOKED, NOT_FOUND, ALREADY_REVOKED }

    /** Append-only durable store. Implementations enforce one confirmation and one revocation per attestation. */
    public interface AttestationStore extends AutoCloseable {
        String storeId();

        boolean ready();

        /** Appends a new attestation; an existing id is {@link IllegalStateException} (never overwritten). */
        void append(Attestation attestation);

        Optional<AttestationRecord> find(String tenantId, String attestationId);

        /** Every record for the artifact across all versions (oldest first), including revoked and expired. */
        List<AttestationRecord> listForArtifact(String tenantId, String artifactId);

        /** Atomic: refuses self-confirmation, a revoked attestation and a second confirmation. */
        ConfirmResult confirm(String tenantId, String attestationId, Confirmation confirmation);

        RevokeResult revoke(String tenantId, String attestationId, Revocation revocation);

        @Override default void close() { }
    }

    /** ServiceLoader SPI for an explicitly enabled DEV_ONLY durable attestation store. */
    public interface AttestationStoreFactory {
        String factoryId();

        AttestationStore createDevOnly(Map<String, String> environment);
    }

    static String required(String value, String field) { return required(value, field, 512); }

    static String required(String value, String field, int max) {
        Objects.requireNonNull(value, field);
        if (value.isBlank() || !value.equals(value.strip()) || value.length() > max
                || value.chars().anyMatch(c -> Character.isISOControl(c) && c != '\n')) {
            throw new IllegalArgumentException(field + " must be bounded, nonblank and without outer whitespace");
        }
        return value;
    }

    static String optional(String value, String field) { return optional(value, field, 512); }

    static String optional(String value, String field, int max) {
        if (value == null || value.isEmpty()) return "";
        return required(value, field, max);
    }

    static String digest(String value, String field) {
        String normalized = required(value, field).toLowerCase(Locale.ROOT);
        if (!normalized.matches("[0-9a-f]{64}")) throw new IllegalArgumentException(field + " must be a SHA-256 digest");
        return normalized;
    }
}
