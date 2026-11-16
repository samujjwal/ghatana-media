package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentAuthority;
import com.ghatana.media.runtime.MediaRightsConsentAuthority.AttestRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationRecord;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationStore;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationStoreFactory;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.StatementKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;

import java.time.Clock;
import java.time.Instant;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * DEV_ONLY host composition of the rights and consent authority (owner decision, 2026-11-14): the uploader states
 * rights and consent for each source version, a second person confirms before any voice or likeness use or
 * external delivery, and every statement records who gave it, when and for which exact file, and can be revoked.
 *
 * <p>Honesty boundary: the DEV_ONLY signed identity is a development identity, not a verified human. These records
 * are real statements by authenticated DEV_ONLY principals; they are not a legal determination and
 * {@code establishesApproval} stays false. The acting principal is the authenticated caller only. The attester must
 * be able to read the exact artifact version (owner scope); the content digest is read from that artifact record,
 * never from the request.
 */
final class MediaDevRightsRuntime implements AutoCloseable {
    static final String ENABLED = "MEDIA_RIGHTS_DEV_ENABLED";

    /** The attester cannot read the exact artifact version (or the version does not exist). */
    static final class ArtifactVersionUnavailableException extends RuntimeException {
        ArtifactVersionUnavailableException() { super("the exact artifact version is not available to this principal"); }
    }

    /** Statement fields from the request. The principal is not part of it. */
    record Statement(String artifactId, String artifactVersionId, StatementKind kind, Set<Scope> scopes, String basis,
                     String supportingDocumentArtifactRef, String requestedConfirmerPrincipalId, Instant expiresAt) { }

    /** The attestations of one exact version plus the live resolver verdict for every scope. */
    record VersionView(List<AttestationRecord> attestations, Map<Scope, Resolution> admission) { }

    private final MediaRuntime runtime;
    private final AttestationStore store;
    private final MediaRightsConsentAuthority authority;
    private final Clock clock;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final java.util.List<java.util.function.BiConsumer<String, String>> changeListeners =
            new java.util.concurrent.CopyOnWriteArrayList<>();

    /** The rights state of one exact artifact version: a monotone event count and a fingerprint of what is live now. */
    record RightsState(long epoch, String fingerprint) { }

    MediaDevRightsRuntime(MediaRuntime runtime, AttestationStore store, Clock clock) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.store = Objects.requireNonNull(store, "store");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.authority = new MediaRightsConsentAuthority(store, clock);
    }

    /** Null unless the explicit DEV_ONLY flag is set; requires profile=dev and the DEV identity. */
    static MediaDevRightsRuntime compose(Map<String, String> environment, MediaRuntime runtime) {
        String flag = environment.getOrDefault(ENABLED, "false");
        if (!"true".equalsIgnoreCase(flag) && !"false".equalsIgnoreCase(flag)) {
            throw new IllegalArgumentException(ENABLED + " must be true or false");
        }
        if (!"true".equalsIgnoreCase(flag)) return null;
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "")).trim().toLowerCase(Locale.ROOT);
        if (!"dev".equals(profile) || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false"))) {
            throw new IllegalArgumentException(
                    "DEV_ONLY rights runtime requires profile=dev and MEDIA_DEV_IDENTITY_ENABLED=true");
        }
        List<AttestationStoreFactory> factories = ServiceLoader.load(AttestationStoreFactory.class).stream()
                .map(ServiceLoader.Provider::get)
                .filter(factory -> "postgresql-dev-rights".equals(factory.factoryId()))
                .toList();
        if (factories.size() != 1) {
            throw new IllegalStateException("exactly one PostgreSQL DEV_ONLY rights store factory is required");
        }
        return new MediaDevRightsRuntime(runtime, factories.get(0).createDevOnly(Map.copyOf(environment)),
                Clock.systemUTC());
    }

    /**
     * Registers a listener called with {@code (tenantId, artifactId)} after every committed statement change
     * (attest, confirm, revoke), before the call returns to its caller, so derived caches drop entries immediately.
     */
    void onRightsChange(java.util.function.BiConsumer<String, String> listener) {
        changeListeners.add(Objects.requireNonNull(listener, "listener"));
    }

    private void changed(String tenantId, String artifactId) {
        for (var listener : changeListeners) listener.accept(tenantId, artifactId);
    }

    /**
     * Live rights state of the exact version, read from the durable store on every call (never cached here). The
     * epoch counts every recorded statement event (attest, confirm, revoke), so it only increases; the fingerprint
     * digests each statement's status at this instant, so a time-based expiry also changes it. Store failure throws.
     */
    RightsState rightsState(String tenantId, String artifactId, String versionId) {
        ensureOpen();
        long epoch = 0;
        java.util.List<String> lines = new java.util.ArrayList<>();
        Instant now = clock.instant();
        for (AttestationRecord record : authority.listForVersion(tenantId, artifactId, versionId)) {
            epoch += 1 + (record.confirmation() == null ? 0 : 1) + (record.revocation() == null ? 0 : 1);
            lines.add(record.attestation().attestationId() + "=" + record.statusAt(now));
        }
        java.util.Collections.sort(lines);
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(String.join("\n", lines).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return new RightsState(epoch, java.util.HexFormat.of().formatHex(digest, 0, 16));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** The injectable resolver port backed by the durable attestation records. */
    RightsConsentResolver resolver() { return authority; }

    /** The attesting principal states rights for the exact version it owns; the digest is read from the artifact. */
    AttestationRecord attest(String tenantId, String principalId, Statement statement) {
        ensureOpen();
        MediaArtifact artifact = exactArtifact(tenantId, principalId, statement.artifactId(), statement.artifactVersionId());
        String supporting = statement.supportingDocumentArtifactRef() == null ? "" : statement.supportingDocumentArtifactRef();
        if (!supporting.isEmpty()) {
            int at = supporting.indexOf('@');
            if (at < 1 || at == supporting.length() - 1) {
                throw new IllegalArgumentException("supportingDocumentArtifactRef must be <artifactId>@<versionId>");
            }
            exactArtifact(tenantId, principalId, supporting.substring(0, at), supporting.substring(at + 1));
        }
        AttestationRecord created = authority.attest(new AuthenticatedPrincipal(tenantId, principalId, Instant.now()),
                new AttestRequest(artifact.artifactId(), artifact.version().value(), artifact.sha256(), statement.kind(),
                        statement.scopes(), statement.basis(), supporting, statement.requestedConfirmerPrincipalId(),
                        statement.expiresAt()));
        changed(tenantId, artifact.artifactId());
        return created;
    }

    AttestationRecord confirm(String tenantId, String principalId, String attestationId, String note) {
        ensureOpen();
        AttestationRecord confirmed = authority.confirm(
                new AuthenticatedPrincipal(tenantId, principalId, Instant.now()), attestationId, note);
        changed(tenantId, confirmed.attestation().artifactId());
        return confirmed;
    }

    AttestationRecord revoke(String tenantId, String principalId, String attestationId, String reason) {
        ensureOpen();
        AttestationRecord revoked = authority.revoke(
                new AuthenticatedPrincipal(tenantId, principalId, Instant.now()), attestationId, reason);
        changed(tenantId, revoked.attestation().artifactId());
        return revoked;
    }

    /**
     * One attestation by id. The attester, the confirmer and the requested confirmer may always read it; when no
     * confirmer was requested any principal of the tenant that knows the (unguessable) id may read it so a second
     * person can review the statement before confirming.
     */
    Optional<AttestationRecord> find(String tenantId, String principalId, String attestationId) {
        ensureOpen();
        return authority.find(tenantId, attestationId).filter(record -> {
            String requested = record.attestation().requestedConfirmerPrincipalId();
            return requested.isEmpty() || requested.equals(principalId)
                    || record.attestation().attestingPrincipalId().equals(principalId)
                    || record.confirmation() != null && record.confirmation().confirmingPrincipalId().equals(principalId);
        });
    }

    /** Owner-scoped list of the exact version's attestations with the current verdict per scope. */
    VersionView listForVersion(String tenantId, String principalId, String artifactId, String versionId) {
        ensureOpen();
        MediaArtifact artifact = exactArtifact(tenantId, principalId, artifactId, versionId);
        Map<Scope, Resolution> admission = new EnumMap<>(Scope.class);
        for (Scope scope : Scope.values()) {
            admission.put(scope, authority.resolve(new ResolutionRequest(
                    tenantId, artifact.artifactId(), artifact.version().value(), artifact.sha256(), scope)));
        }
        return new VersionView(authority.listForVersion(tenantId, artifact.artifactId(), artifact.version().value()), admission);
    }

    Clock clock() { return clock; }

    private MediaArtifact exactArtifact(String tenantId, String principalId, String artifactId, String versionId) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(found -> found.version().value().equals(versionId))
                .orElseThrow(ArtifactVersionUnavailableException::new);
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("DEV_ONLY rights runtime is closed");
    }

    @Override public void close() {
        if (closed.compareAndSet(false, true)) {
            try { store.close(); }
            catch (Exception failure) { throw new IllegalStateException("rights store close failed", failure); }
        }
    }
}
