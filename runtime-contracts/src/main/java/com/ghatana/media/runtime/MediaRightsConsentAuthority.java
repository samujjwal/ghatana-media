package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRightsConsentContracts.Attestation;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationRecord;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationStore;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Confirmation;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Reason;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RevokeResult;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Revocation;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.StatementKind;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;

/**
 * Rights and consent authority: records attestations, confirmations and revocations over an
 * {@link AttestationStore} and resolves them for admission paths through {@link RightsConsentResolver}.
 *
 * <p>The acting principal is always an {@link AuthenticatedPrincipal} established by the transport; no method
 * accepts a principal id from request content. Binding the attestation to a real artifact version (existence and
 * digest) is the caller's responsibility because artifacts are owner-scoped; this class refuses anything whose
 * version and digest do not identify the same bytes.</p>
 *
 * @doc.type class
 * @doc.purpose Record and resolve uploader-plus-reviewer rights and consent statements
 * @doc.layer product
 * @doc.pattern Service, AppendOnlyLedger
 */
public final class MediaRightsConsentAuthority implements RightsConsentResolver {
    public static final String RESOLVER_ID = "media-rights-consent-attestation-authority";

    /** Typed refusal; the code is stable and the message never echoes statement content. */
    public enum Code {
        INVALID, NOT_FOUND, SELF_CONFIRMATION_REFUSED, NOT_DESIGNATED_CONFIRMER, ALREADY_CONFIRMED, REVOKED,
        EXPIRED, CONFIRMATION_NOT_REQUIRED, NOT_PERMITTED_TO_REVOKE, ALREADY_REVOKED
    }

    public static final class RightsConsentException extends RuntimeException {
        private final Code code;

        public RightsConsentException(Code code, String message) {
            super(message);
            this.code = Objects.requireNonNull(code, "code");
        }

        public Code code() { return code; }
    }

    /** Statement content supplied by the uploader. The attesting principal is never part of it. */
    public record AttestRequest(
            String artifactId,
            String artifactVersion,
            String contentSha256,
            StatementKind statementKind,
            Set<Scope> scopes,
            String basis,
            String supportingDocumentArtifactRef,
            String requestedConfirmerPrincipalId,
            Instant expiresAt) { }

    private final AttestationStore store;
    private final Clock clock;
    private final Function<String, String> idSupplier;

    public MediaRightsConsentAuthority(AttestationStore store, Clock clock) {
        this(store, clock, ignored -> "att-" + UUID.randomUUID());
    }

    MediaRightsConsentAuthority(AttestationStore store, Clock clock, Function<String, String> idSupplier) {
        this.store = Objects.requireNonNull(store, "store");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.idSupplier = Objects.requireNonNull(idSupplier, "idSupplier");
    }

    @Override public String resolverId() { return RESOLVER_ID; }

    @Override public boolean ready() { return store.ready(); }

    /** Appends a new attestation by the authenticated caller. A new version never inherits an old attestation. */
    public AttestationRecord attest(AuthenticatedPrincipal caller, AttestRequest request) {
        Objects.requireNonNull(caller, "caller");
        Objects.requireNonNull(request, "request");
        Instant now = clock.instant();
        if (request.expiresAt() != null && !request.expiresAt().isAfter(now)) {
            throw new RightsConsentException(Code.INVALID, "expiresAt must be in the future");
        }
        Attestation attestation;
        try {
            attestation = new Attestation(caller.tenantId(), idSupplier.apply(caller.tenantId()),
                    request.artifactId(), request.artifactVersion(), request.contentSha256(), caller.principalId(), now,
                    request.statementKind(), request.scopes(), request.basis(), request.supportingDocumentArtifactRef(),
                    request.requestedConfirmerPrincipalId(), request.expiresAt());
        } catch (IllegalArgumentException | NullPointerException invalid) {
            throw new RightsConsentException(Code.INVALID, "the attestation is not well formed");
        }
        store.append(attestation);
        return new AttestationRecord(attestation, null, null);
    }

    /** A different principal confirms. Self-confirmation, a revoked or expired attestation and repeats are refused. */
    public AttestationRecord confirm(AuthenticatedPrincipal caller, String attestationId, String note) {
        Objects.requireNonNull(caller, "caller");
        AttestationRecord current = store.find(caller.tenantId(), attestationId)
                .orElseThrow(() -> new RightsConsentException(Code.NOT_FOUND, "attestation not found"));
        Attestation attestation = current.attestation();
        Instant now = clock.instant();
        if (attestation.attestingPrincipalId().equals(caller.principalId())) {
            throw new RightsConsentException(Code.SELF_CONFIRMATION_REFUSED,
                    "the principal who gave a statement cannot confirm it");
        }
        if (current.revocation() != null) throw new RightsConsentException(Code.REVOKED, "attestation is revoked");
        if (attestation.expiredAt(now)) throw new RightsConsentException(Code.EXPIRED, "attestation has expired");
        if (!attestation.needsSecondPersonConfirmation()) {
            throw new RightsConsentException(Code.CONFIRMATION_NOT_REQUIRED,
                    "no scope of this attestation requires a second-person confirmation");
        }
        if (!attestation.requestedConfirmerPrincipalId().isEmpty()
                && !attestation.requestedConfirmerPrincipalId().equals(caller.principalId())) {
            throw new RightsConsentException(Code.NOT_DESIGNATED_CONFIRMER,
                    "only the requested confirmer may confirm this attestation");
        }
        Confirmation confirmation;
        try {
            confirmation = new Confirmation(caller.principalId(), now, note);
        } catch (IllegalArgumentException invalid) {
            throw new RightsConsentException(Code.INVALID, "the confirmation note is not well formed");
        }
        switch (store.confirm(caller.tenantId(), attestationId, confirmation)) {
            case CONFIRMED -> { }
            case NOT_FOUND -> throw new RightsConsentException(Code.NOT_FOUND, "attestation not found");
            case SELF_CONFIRMATION -> throw new RightsConsentException(Code.SELF_CONFIRMATION_REFUSED,
                    "the principal who gave a statement cannot confirm it");
            case ALREADY_CONFIRMED -> throw new RightsConsentException(Code.ALREADY_CONFIRMED,
                    "attestation is already confirmed");
            case REVOKED -> throw new RightsConsentException(Code.REVOKED, "attestation is revoked");
        }
        return store.find(caller.tenantId(), attestationId)
                .orElseThrow(() -> new RightsConsentException(Code.NOT_FOUND, "attestation not found"));
    }

    /** The attesting principal or the confirming principal may revoke, with a reason. */
    public AttestationRecord revoke(AuthenticatedPrincipal caller, String attestationId, String reason) {
        Objects.requireNonNull(caller, "caller");
        AttestationRecord current = store.find(caller.tenantId(), attestationId)
                .orElseThrow(() -> new RightsConsentException(Code.NOT_FOUND, "attestation not found"));
        boolean party = current.attestation().attestingPrincipalId().equals(caller.principalId())
                || current.confirmation() != null
                        && current.confirmation().confirmingPrincipalId().equals(caller.principalId());
        if (!party) {
            throw new RightsConsentException(Code.NOT_PERMITTED_TO_REVOKE,
                    "only the attesting or the confirming principal may revoke");
        }
        Revocation revocation;
        try {
            revocation = new Revocation(caller.principalId(), clock.instant(), reason);
        } catch (IllegalArgumentException | NullPointerException invalid) {
            throw new RightsConsentException(Code.INVALID, "a bounded revocation reason is required");
        }
        RevokeResult result = store.revoke(caller.tenantId(), attestationId, revocation);
        if (result == RevokeResult.NOT_FOUND) throw new RightsConsentException(Code.NOT_FOUND, "attestation not found");
        if (result == RevokeResult.ALREADY_REVOKED) {
            throw new RightsConsentException(Code.ALREADY_REVOKED, "attestation is already revoked");
        }
        return store.find(caller.tenantId(), attestationId)
                .orElseThrow(() -> new RightsConsentException(Code.NOT_FOUND, "attestation not found"));
    }

    public Optional<AttestationRecord> find(String tenantId, String attestationId) {
        return store.find(tenantId, attestationId);
    }

    /** Records for exactly one artifact version (never another version's), oldest first. */
    public List<AttestationRecord> listForVersion(String tenantId, String artifactId, String artifactVersion) {
        List<AttestationRecord> out = new ArrayList<>();
        for (AttestationRecord record : store.listForArtifact(tenantId, artifactId)) {
            if (record.attestation().artifactVersion().equals(artifactVersion)) out.add(record);
        }
        return out;
    }

    @Override
    public Resolution resolve(ResolutionRequest request) {
        Objects.requireNonNull(request, "request");
        List<AttestationRecord> all;
        try {
            if (!store.ready()) return Resolution.unavailable(RESOLVER_ID);
            all = store.listForArtifact(request.tenantId(), request.artifactId());
        } catch (RuntimeException failure) {
            return Resolution.unavailable(RESOLVER_ID);
        }
        Instant now = clock.instant();
        if (!request.artifactVersion().equals("sha256:" + request.contentSha256())) {
            return deny(Verdict.MISMATCH, Reason.DIGEST_MISMATCH);
        }
        if (all.isEmpty()) return deny(Verdict.DENIED, Reason.NO_ATTESTATION);
        List<AttestationRecord> sameVersion = new ArrayList<>();
        for (AttestationRecord record : all) {
            if (record.attestation().artifactVersion().equals(request.artifactVersion())) sameVersion.add(record);
        }
        // A new version never inherits: statements for other versions are stale for this exact one.
        if (sameVersion.isEmpty()) return deny(Verdict.STALE, Reason.OTHER_VERSION_ONLY);
        List<AttestationRecord> exact = new ArrayList<>();
        for (AttestationRecord record : sameVersion) {
            if (record.attestation().contentSha256().equals(request.contentSha256())) exact.add(record);
        }
        if (exact.isEmpty()) return deny(Verdict.MISMATCH, Reason.DIGEST_MISMATCH);

        List<String> admitting = new ArrayList<>();
        boolean covering = false;
        boolean pending = false;
        boolean expired = false;
        boolean revoked = false;
        for (AttestationRecord record : exact) {
            Attestation attestation = record.attestation();
            if (!attestation.scopes().contains(request.scope())
                    || !request.scope().acceptedKinds().contains(attestation.statementKind())) {
                continue;
            }
            covering = true;
            if (record.revocation() != null) { revoked = true; continue; }
            if (attestation.expiredAt(now)) { expired = true; continue; }
            if (record.admits(request.scope(), now)) admitting.add(attestation.attestationId());
            else pending = true;
        }
        if (!admitting.isEmpty()) {
            return new Resolution(Verdict.ADMITTED, Set.of(), admitting, RESOLVER_ID);
        }
        if (!covering) return deny(Verdict.DENIED, Reason.SCOPE_NOT_COVERED);
        if (pending) return deny(Verdict.DENIED, Reason.NOT_CONFIRMED);
        if (expired) return deny(Verdict.STALE, Reason.EXPIRED);
        if (revoked) return deny(Verdict.REVOKED, Reason.REVOKED);
        return deny(Verdict.DENIED, Reason.SCOPE_NOT_COVERED);
    }

    private static Resolution deny(Verdict verdict, Reason reason) {
        return new Resolution(verdict, Set.of(reason), List.of(), RESOLVER_ID);
    }

    /** Operation-to-scope mapping used when this resolver gates a source-authorization request. */
    public static Scope defaultScopeFor(MediaSourceAuthorizationContracts.Request request) {
        String operation = request.operation().toLowerCase(Locale.ROOT);
        if (operation.matches(".*(deliver|export|publish).*")) return Scope.EXTERNAL_DELIVERY;
        if (operation.matches(".*(voice|tts|clone|likeness|dub|synthes).*")) return Scope.VOICE_OR_LIKENESS_USE;
        return Scope.PROCESSING;
    }

    /**
     * Gates an existing source-authorization {@link MediaSourceAuthorizationContracts.Authority} (rights records
     * plus Shared policy) with real attestation evidence. The delegate's evidence is returned unchanged only when
     * the attestation resolver also ADMITS the exact artifact version and digest for the request's scope; policy
     * evidence is never synthesised here. MISMATCH has no legacy status and maps to DENIED.
     */
    public static MediaSourceAuthorizationContracts.Authority gate(
            MediaSourceAuthorizationContracts.Authority delegate, RightsConsentResolver resolver) {
        return gate(delegate, resolver, MediaRightsConsentAuthority::defaultScopeFor);
    }

    public static MediaSourceAuthorizationContracts.Authority gate(
            MediaSourceAuthorizationContracts.Authority delegate, RightsConsentResolver resolver,
            Function<MediaSourceAuthorizationContracts.Request, Scope> scopeFor) {
        Objects.requireNonNull(delegate, "delegate");
        Objects.requireNonNull(resolver, "resolver");
        Objects.requireNonNull(scopeFor, "scopeFor");
        return new MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return delegate.authorityId() + "+attestation-gate"; }
            @Override public boolean ready() { return delegate.ready() && resolver.ready(); }
            @Override public boolean productionEligible() { return delegate.productionEligible() && resolver.ready(); }

            @Override public MediaSourceAuthorizationContracts.Decision resolve(
                    MediaSourceAuthorizationContracts.Request request, AuthenticatedPrincipal authenticated) {
                return gated(delegate.resolve(request, authenticated), request);
            }

            @Override public MediaSourceAuthorizationContracts.Decision revalidate(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.Evidence expected, AuthenticatedPrincipal authenticated) {
                return gated(delegate.revalidate(request, expected, authenticated), request);
            }

            @Override public void close() { delegate.close(); }

            private MediaSourceAuthorizationContracts.Decision gated(
                    MediaSourceAuthorizationContracts.Decision decision,
                    MediaSourceAuthorizationContracts.Request request) {
                if (decision.status() != MediaSourceAuthorizationContracts.Status.ALLOWED) return decision;
                Resolution resolution;
                try {
                    resolution = resolver.resolve(new ResolutionRequest(request.tenantId(), request.artifactId(),
                            request.sourceVersion().value(), request.sourceSha256(), scopeFor.apply(request)));
                } catch (RuntimeException failure) {
                    return new MediaSourceAuthorizationContracts.Decision(
                            MediaSourceAuthorizationContracts.Status.UNAVAILABLE, null);
                }
                return switch (resolution.verdict()) {
                    case ADMITTED -> decision;
                    case REVOKED -> new MediaSourceAuthorizationContracts.Decision(
                            MediaSourceAuthorizationContracts.Status.REVOKED, null);
                    case STALE -> new MediaSourceAuthorizationContracts.Decision(
                            MediaSourceAuthorizationContracts.Status.STALE, null);
                    case UNAVAILABLE -> new MediaSourceAuthorizationContracts.Decision(
                            MediaSourceAuthorizationContracts.Status.UNAVAILABLE, null);
                    case DENIED, MISMATCH -> new MediaSourceAuthorizationContracts.Decision(
                            MediaSourceAuthorizationContracts.Status.DENIED, null);
                };
            }
        };
    }

    static Set<Scope> scopes(Scope first, Scope... rest) {
        Set<Scope> out = EnumSet.of(first, rest);
        return new LinkedHashSet<>(out);
    }
}
