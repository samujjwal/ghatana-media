package com.ghatana.media.launcher;

import com.ghatana.media.production.delivery.DeliveryOperationStore;
import com.ghatana.media.production.delivery.MediaDeliveryEngine;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.Artifact;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.DeliveryResult;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.ExportRequest;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.TransferAuthorization;
import com.ghatana.media.production.delivery.MediaDevDeliveryStoreFactory;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

/**
 * DEV_ONLY hosted export of one exact registered artifact version to one configured local directory.
 * Composes the existing {@link MediaDeliveryEngine} with a durable {@link DeliveryOperationStore} and a
 * read-back local-directory destination; it re-implements none of the engine's state machine. A result is
 * {@code DESTINATION_CONFIRMED} only when the engine accepted a destination receipt produced by re-reading
 * the stored bytes; no write, 2xx or local completion is ever treated as confirmation.
 */
final class MediaDevDeliveryRuntime implements AutoCloseable {
    static final String ENABLED = "MEDIA_DELIVERY_DEV_ENABLED";
    static final String DESTINATION_DIR = "MEDIA_DELIVERY_DEV_DESTINATION_DIR";
    /** The only destination this DEV_ONLY host exposes. */
    static final String DESTINATION_ID = "dev-local-directory";
    /** Test and DEV control of how long a dead dispatcher blocks takeover (default and maximum: five minutes). */
    static final String DISPATCH_LEASE_MS = "MEDIA_DELIVERY_DEV_DISPATCH_LEASE_MS";
    private static final Duration GRANT_VALIDITY = Duration.ofMinutes(2);

    /** The destination is not configured (or the runtime is unavailable); typed, never a silent success. */
    static final class UnavailableException extends RuntimeException {
        UnavailableException(String message) { super(message); }
    }

    static final class ArtifactVersionUnavailableException extends RuntimeException {
        ArtifactVersionUnavailableException() { super("the exact artifact version is not available to this principal"); }
    }

    static final class ExportLimitException extends RuntimeException {
        ExportLimitException(String message) { super(message); }
    }

    /**
     * The exact source version has no current, second-person-confirmed EXTERNAL_DELIVERY attestation (or the rights
     * authority is unavailable). Nothing was exported. Never carries statement content.
     */
    static final class RightsNotAdmittedException extends RuntimeException {
        private final Resolution resolution;

        RightsNotAdmittedException(Resolution resolution) {
            super("external delivery is not admitted for the exact source version: " + resolution.verdict());
            this.resolution = resolution;
        }

        Resolution resolution() { return resolution; }
    }

    /** Review authority is absent or has not admitted delivery of the exact version. */
    static final class ReviewNotAdmittedException extends RuntimeException {
        private final MediaDevReviewRuntime.DeliveryAdmission admission;

        ReviewNotAdmittedException(MediaDevReviewRuntime.DeliveryAdmission admission) {
            super(admission.message());
            this.admission = admission;
        }

        MediaDevReviewRuntime.DeliveryAdmission admission() { return admission; }
    }

    /** Exact-version review gate required before a new or unresolved delivery may proceed. */
    @FunctionalInterface
    interface ReviewGate {
        MediaDevReviewRuntime.DeliveryAdmission check(String tenantId, String principalId, String artifactId,
                                                      String versionId);
    }

    private final java.util.concurrent.atomic.AtomicReference<ReviewGate> reviewGate =
            new java.util.concurrent.atomic.AtomicReference<>();

    /** Requires a current accepted review for every export (and every retry/reconcile) of an exact version. */
    void requireReview(ReviewGate gate) { reviewGate.set(gate); }

    /** Request to export one exact artifact version. */
    record Export(String requestId, String artifactId, String artifactVersionId, String destinationId) { }

    /** Engine result plus whether an operation already existed for this request before this call. */
    record Outcome(DeliveryResult result, boolean replayed) { }

    private final MediaRuntime runtime;
    private final DeliveryOperationStore store;
    private final MediaDeliveryEngine engine;
    private final MediaDevLocalDirectoryDestination destination;
    private final MediaDevHttpReceiverDestination receiver;
    private final MediaDevDestinationRouter router;
    private final RightsConsentResolver rights;
    private final AtomicBoolean closed = new AtomicBoolean();

    /** Unavailable runtime: enabled but no destination is configured. */
    private MediaDevDeliveryRuntime() {
        this.runtime = null; this.store = null; this.engine = null; this.destination = null; this.receiver = null;
        this.router = null;
        this.rights = RightsConsentResolver.unavailable();
    }

    MediaDevDeliveryRuntime(MediaRuntime runtime, DeliveryOperationStore store, Path destinationRoot,
                            Supplier<Instant> clock, RightsConsentResolver rights) {
        this(runtime, store, destinationRoot, clock, rights, null);
    }

    /** {@code destinationWrapper} exists for failure injection (lost ACK); null means the real adapter. */
    MediaDevDeliveryRuntime(MediaRuntime runtime, DeliveryOperationStore store, Path destinationRoot,
                            Supplier<Instant> clock, RightsConsentResolver rights,
                            java.util.function.UnaryOperator<MediaDeliveryEngine.FencedDestinationPort> destinationWrapper) {
        this(runtime, store, destinationRoot, null, clock, rights, destinationWrapper,
                MediaDeliveryEngine.DEFAULT_DISPATCH_CLAIM_LEASE);
    }

    /** Either destination may be absent, never both. */
    MediaDevDeliveryRuntime(MediaRuntime runtime, DeliveryOperationStore store, Path destinationRoot,
                            MediaDevHttpReceiverDestination receiver, Supplier<Instant> clock,
                            RightsConsentResolver rights,
                            java.util.function.UnaryOperator<MediaDeliveryEngine.FencedDestinationPort> destinationWrapper,
                            Duration dispatchClaimLease) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        // Fail closed: without a configured rights authority no external delivery is ever admitted.
        this.rights = rights == null ? RightsConsentResolver.unavailable() : rights;
        this.store = Objects.requireNonNull(store, "store");
        if (destinationRoot == null && receiver == null) throw new IllegalArgumentException("a destination is required");
        this.destination = destinationRoot == null ? null : new MediaDevLocalDirectoryDestination(destinationRoot, store);
        this.receiver = receiver;
        Map<String, MediaDeliveryEngine.FencedDestinationPort> registered = new java.util.HashMap<>();
        if (destination != null) registered.put(DESTINATION_ID, destination);
        if (receiver != null) registered.put(MediaDevHttpReceiverDestination.DESTINATION_ID, receiver);
        this.router = new MediaDevDestinationRouter(registered);
        MediaDeliveryEngine.FencedDestinationPort port = destinationWrapper == null ? router
                : destinationWrapper.apply(router);
        this.engine = new MediaDeliveryEngine(new OwnerReadAuthorization(runtime, clock, this.rights, reviewGate), port, clock, store,
                dispatchClaimLease);
    }

    /** Null when the explicit DEV_ONLY flag is absent; an unavailable runtime when the directory is absent. */
    static MediaDevDeliveryRuntime compose(Map<String, String> environment, MediaRuntime runtime,
                                           RightsConsentResolver rights) {
        if (!parseBoolean(environment.getOrDefault(ENABLED, "false"), ENABLED)) return null;
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "")).trim().toLowerCase(Locale.ROOT);
        if (!"dev".equals(profile)
                || !parseBoolean(environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false"),
                        "MEDIA_DEV_IDENTITY_ENABLED")) {
            throw new IllegalArgumentException(
                    "DEV_ONLY delivery runtime requires profile=dev and MEDIA_DEV_IDENTITY_ENABLED=true");
        }
        String configured = environment.get(DESTINATION_DIR);
        boolean receiverConfigured = !environment.getOrDefault(MediaDevHttpReceiverDestination.URL_ENV, "").isBlank();
        if ((configured == null || configured.isEmpty()) && !receiverConfigured) return new MediaDevDeliveryRuntime();
        Path root = null;
        if (configured != null && !configured.isEmpty()) {
            root = MediaDevLocalDirectoryDestination.confineRoot(configured);
            if (!MediaDevLocalDirectoryDestination.supportsPrivateFilePermissions(root)) root = null;
            if (root == null && !receiverConfigured) return new MediaDevDeliveryRuntime();
        }
        List<MediaDevDeliveryStoreFactory> factories = ServiceLoader.load(MediaDevDeliveryStoreFactory.class).stream()
                .map(ServiceLoader.Provider::get)
                .filter(factory -> "postgresql-dev-delivery".equals(factory.factoryId()))
                .toList();
        if (factories.size() != 1) {
            throw new IllegalStateException("exactly one PostgreSQL DEV_ONLY delivery store factory is required");
        }
        DeliveryOperationStore store = factories.get(0).createDevOnly(Map.copyOf(environment));
        MediaDevHttpReceiverDestination receiver = MediaDevHttpReceiverDestination.compose(environment, store);
        long leaseMs = Long.parseLong(environment.getOrDefault(DISPATCH_LEASE_MS, "300000").trim());
        if (leaseMs < 1_000 || leaseMs > 300_000) throw new IllegalArgumentException(DISPATCH_LEASE_MS + " is out of range");
        return new MediaDevDeliveryRuntime(runtime, store, root, receiver, Instant::now, rights, null,
                Duration.ofMillis(leaseMs));
    }

    boolean available() { return engine != null; }

    /**
     * Exports the exact version. First call enqueues, dispatches, writes, then reads back and (only then)
     * confirms. A repeated call replays the stored operation; an unresolved one is reconciled by readback.
     */
    Outcome export(String tenantId, String principalId, Export request) {
        ensureAvailable();
        Objects.requireNonNull(request, "request");
        requireRegistered(tenantId, request.destinationId());
        Optional<DeliveryResult> existing = engine.find(tenantId, request.requestId());
        ExportRequest exportRequest = exportRequest(tenantId, principalId, request);
        // A new effect, or an unconfirmed operation about to be resumed, needs a current confirmed EXTERNAL_DELIVERY
        // attestation for these exact source bytes. Replaying an already destination-confirmed operation is a read.
        boolean alreadyConfirmed = existing.map(found -> found.status() == MediaDeliveryEngine.Status.DESTINATION_CONFIRMED)
                .orElse(false);
        if (!alreadyConfirmed) {
            ReviewGate gate = reviewGate.get();
            if (gate == null) throw reviewAuthorityUnavailable();
            MediaDevReviewRuntime.DeliveryAdmission admission;
            try {
                admission = gate.check(tenantId, principalId, exportRequest.artifact().artifactId(),
                        exportRequest.artifact().versionRef());
            } catch (RuntimeException unavailable) {
                throw reviewAuthorityUnavailable();
            }
            if (admission == null) throw reviewAuthorityUnavailable();
            if (!admission.admitted()) throw new ReviewNotAdmittedException(admission);
            Resolution resolution = externalDelivery(rights, tenantId, exportRequest.artifact().artifactId(),
                    exportRequest.artifact().versionRef(), exportRequest.artifact().digest());
            if (!resolution.admitted()) throw new RightsNotAdmittedException(resolution);
        }
        boolean replayed = existing.isPresent();
        DeliveryResult result = engine.export(exportRequest);
        // Only a retry reconciles: a first call that ended unconfirmed reports that honestly (202).
        if (replayed && (result.status() == MediaDeliveryEngine.Status.OUTCOME_UNKNOWN
                || result.status() == MediaDeliveryEngine.Status.SENT)) {
            result = engine.reconcileAndResume(exportRequest);
        }
        return new Outcome(result, replayed);
    }

    private static ReviewNotAdmittedException reviewAuthorityUnavailable() {
        return new ReviewNotAdmittedException(new MediaDevReviewRuntime.DeliveryAdmission(false,
                "REVIEW_AUTHORITY_UNAVAILABLE",
                "A configured exact-version review authority is required before delivery; nothing was exported",
                null));
    }

    /** Owner-scoped durable readback of one operation; another principal's operation is absent. */
    Optional<DeliveryResult> find(String tenantId, String principalId, String requestId) {
        ensureAvailable();
        return engine.find(tenantId, requestId).filter(result -> result.principalId().equals(principalId));
    }

    /** Drops this process's retained copy of an export's artifact bytes and cached state (artifact erasure). */
    boolean evict(String tenantId, String requestId) {
        return engine != null && engine.evict(tenantId, requestId);
    }

    static final class UnknownDestinationException extends RuntimeException {
        UnknownDestinationException() { super("destination is not configured"); }
    }

    /** The destination is registered but not for this tenant; nothing was read or sent. */
    static final class DestinationNotPermittedException extends RuntimeException {
        DestinationNotPermittedException() { super("destination is not permitted for this tenant"); }
    }

    private void requireRegistered(String tenantId, String destinationId) {
        if (!router.isRegistered(destinationId)) throw new UnknownDestinationException();
        if (MediaDevHttpReceiverDestination.DESTINATION_ID.equals(destinationId) && !receiver.permits(tenantId)) {
            throw new DestinationNotPermittedException();
        }
    }

    /** Latest verified or failed observation of the signed-ACK receiver for one request; empty for other destinations. */
    Optional<MediaDevHttpReceiverDestination.Observation> observation(String tenantId, String requestId) {
        return receiver == null ? Optional.empty() : receiver.observation(tenantId, requestId);
    }

    /**
     * Resolves an unresolved export against the destination's own state. With {@code resume} the engine reconciles and
     * continues from the destination-verified offset (exactly what a retry of the export does). Without it nothing is
     * sent: the receiver is only read, so an object that is verifiably absent is reported as not delivered, and an
     * object that is complete and matches is confirmed by the engine without any second write.
     */
    Optional<Outcome> reconcile(String tenantId, String principalId, String requestId, boolean resume) {
        ensureAvailable();
        Optional<DeliveryResult> found = find(tenantId, principalId, requestId);
        if (found.isEmpty()) return Optional.empty();
        DeliveryResult existing = found.get();
        Export export = new Export(requestId, existing.artifactId(), existing.versionRef(), existing.destinationRef());
        if (resume || existing.status() == MediaDeliveryEngine.Status.DESTINATION_CONFIRMED) {
            return Optional.of(export(tenantId, principalId, export));
        }
        requireRegistered(tenantId, existing.destinationRef());
        if (receiver == null || !MediaDevHttpReceiverDestination.DESTINATION_ID.equals(existing.destinationRef())) {
            throw new IllegalArgumentException("read-only reconciliation is only defined for the signed-ACK receiver");
        }
        Resolution resolution = externalDelivery(rights, tenantId, existing.artifactId(), existing.versionRef(),
                existing.artifactDigest());
        if (!resolution.admitted()) throw new RightsNotAdmittedException(resolution);
        var observed = receiver.inspect(exportRequest(tenantId, principalId, export));
        if (observed.finding() == MediaDevHttpReceiverDestination.Finding.ACK_VERIFIED) {
            // The destination already holds exactly these bytes: the engine records its signed receipt; nothing is sent.
            return Optional.of(export(tenantId, principalId, export));
        }
        return Optional.of(new Outcome(existing, true));
    }

    private ExportRequest exportRequest(String tenantId, String principalId, Export request) {
        MediaArtifact artifact = runtime.artifact(tenantId, principalId, request.artifactId())
                .filter(found -> found.version().value().equals(request.artifactVersionId()))
                .orElseThrow(ArtifactVersionUnavailableException::new);
        if (artifact.sizeBytes() < 1 || artifact.sizeBytes() > MediaDeliveryEngine.MAX_ARTIFACT_BYTES) {
            throw new ExportLimitException("artifact size is outside the delivery bounds");
        }
        ByteArrayOutputStream staged = new ByteArrayOutputStream((int) artifact.sizeBytes());
        try {
            runtime.copyArtifactContent(tenantId, principalId, artifact.artifactId(), artifact.version(), staged,
                    MediaDeliveryEngine.MAX_ARTIFACT_BYTES).orElseThrow(ArtifactVersionUnavailableException::new);
        } catch (IOException failure) {
            throw new IllegalStateException("artifact content could not be read", failure);
        }
        // The artifact's registered digest is bare hex; the engine uses the prefixed form. The engine
        // additionally recomputes the digest from the bytes and rejects any mismatch.
        Artifact snapshot = new Artifact(tenantId, artifact.artifactId(), artifact.version().value(),
                "sha256:" + artifact.sha256(), staged.toByteArray());
        return new ExportRequest(tenantId, principalId, request.requestId(), snapshot, request.destinationId());
    }

    private void ensureAvailable() {
        if (closed.get()) throw new UnavailableException("DEV_ONLY delivery runtime is closed");
        if (engine == null) {
            throw new UnavailableException("DEV_ONLY delivery destination directory is not configured");
        }
    }

    /**
     * DEV_ONLY host grant: the principal passed the permission check and can read exactly this artifact
     * version. It is short-lived and re-validated per chunk; it is not a production transfer authority.
     */
    private record OwnerReadAuthorization(MediaRuntime runtime, Supplier<Instant> clock, RightsConsentResolver rights,
                                          java.util.concurrent.atomic.AtomicReference<ReviewGate> reviewGate)
            implements MediaDeliveryEngine.AuthorizationPort {
        private boolean reviewAdmits(String tenantId, String principalId, String artifactId, String versionId) {
            ReviewGate gate = reviewGate.get();
            if (gate == null) return false;
            try {
                MediaDevReviewRuntime.DeliveryAdmission admission = gate.check(tenantId, principalId, artifactId, versionId);
                return admission != null && admission.admitted();
            }
            catch (RuntimeException unavailable) { return false; }
        }

        @Override public TransferAuthorization authorize(ExportRequest request) {
            if (!readable(request)) return null;
            if (!reviewAdmits(request.tenantId(), request.principalId(), request.artifact().artifactId(),
                    request.artifact().versionRef())) return null;
            // Re-resolved for every operation (including retries and reconciliation): a revocation stops the transfer.
            if (!externalDelivery(rights, request.tenantId(), request.artifact().artifactId(),
                    request.artifact().versionRef(), request.artifact().digest()).admitted()) {
                return null;
            }
            return new TransferAuthorization("dev-owner-read:" + request.requestId(), request.tenantId(),
                    request.principalId(), request.requestId(), request.artifact().artifactId(),
                    request.artifact().versionRef(), request.artifact().digest(), request.destinationRef(),
                    clock.get().plus(GRANT_VALIDITY));
        }

        @Override public Boolean isCurrent(TransferAuthorization grant, Instant now) {
            if (!reviewAdmits(grant.tenantId(), grant.principalId(), grant.artifactId(), grant.versionRef())) return false;
            return runtime.artifact(grant.tenantId(), grant.principalId(), grant.artifactId())
                    .map(found -> found.version().value().equals(grant.versionRef())).orElse(false)
                    && externalDelivery(rights, grant.tenantId(), grant.artifactId(), grant.versionRef(),
                            grant.artifactDigest()).admitted();
        }

        private boolean readable(ExportRequest request) {
            return runtime.artifact(request.tenantId(), request.principalId(), request.artifact().artifactId())
                    .map(found -> found.version().value().equals(request.artifact().versionRef())).orElse(false);
        }
    }

    /** Resolves EXTERNAL_DELIVERY for the exact bytes; the digest is the engine's prefixed {@code sha256:} form. */
    private static Resolution externalDelivery(RightsConsentResolver rights, String tenantId, String artifactId,
                                               String versionRef, String prefixedDigest) {
        try {
            String digest = prefixedDigest.startsWith("sha256:") ? prefixedDigest.substring("sha256:".length()) : prefixedDigest;
            return rights.resolve(new ResolutionRequest(tenantId, artifactId, versionRef, digest, Scope.EXTERNAL_DELIVERY));
        } catch (RuntimeException failure) {
            return Resolution.unavailable(rights.resolverId());
        }
    }

    @Override public void close() {
        if (closed.compareAndSet(false, true) && store instanceof AutoCloseable closeable) {
            try { closeable.close(); }
            catch (Exception failure) { throw new IllegalStateException("delivery store close failed", failure); }
        }
    }

    private static boolean parseBoolean(String value, String key) {
        if ("true".equalsIgnoreCase(value)) return true;
        if ("false".equalsIgnoreCase(value)) return false;
        throw new IllegalArgumentException(key + " must be true or false");
    }
}
