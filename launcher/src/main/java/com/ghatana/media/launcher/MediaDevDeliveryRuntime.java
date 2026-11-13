package com.ghatana.media.launcher;

import com.ghatana.media.production.delivery.DeliveryOperationStore;
import com.ghatana.media.production.delivery.MediaDeliveryEngine;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.Artifact;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.DeliveryResult;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.ExportRequest;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.TransferAuthorization;
import com.ghatana.media.production.delivery.MediaDevDeliveryStoreFactory;
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

    /** Request to export one exact artifact version. */
    record Export(String requestId, String artifactId, String artifactVersionId, String destinationId) { }

    /** Engine result plus whether an operation already existed for this request before this call. */
    record Outcome(DeliveryResult result, boolean replayed) { }

    private final MediaRuntime runtime;
    private final DeliveryOperationStore store;
    private final MediaDeliveryEngine engine;
    private final MediaDevLocalDirectoryDestination destination;
    private final AtomicBoolean closed = new AtomicBoolean();

    /** Unavailable runtime: enabled but the destination directory is not configured. */
    private MediaDevDeliveryRuntime() {
        this.runtime = null; this.store = null; this.engine = null; this.destination = null;
    }

    MediaDevDeliveryRuntime(MediaRuntime runtime, DeliveryOperationStore store, Path destinationRoot,
                            Supplier<Instant> clock) {
        this(runtime, store, destinationRoot, clock, null);
    }

    /** {@code destinationWrapper} exists for failure injection (lost ACK); null means the real adapter. */
    MediaDevDeliveryRuntime(MediaRuntime runtime, DeliveryOperationStore store, Path destinationRoot,
                            Supplier<Instant> clock,
                            java.util.function.UnaryOperator<MediaDeliveryEngine.FencedDestinationPort> destinationWrapper) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.store = Objects.requireNonNull(store, "store");
        this.destination = new MediaDevLocalDirectoryDestination(destinationRoot, store);
        MediaDeliveryEngine.FencedDestinationPort port = destinationWrapper == null ? destination
                : destinationWrapper.apply(destination);
        this.engine = new MediaDeliveryEngine(new OwnerReadAuthorization(runtime, clock), port, clock, store);
    }

    /** Null when the explicit DEV_ONLY flag is absent; an unavailable runtime when the directory is absent. */
    static MediaDevDeliveryRuntime compose(Map<String, String> environment, MediaRuntime runtime) {
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
        if (configured == null || configured.isEmpty()) return new MediaDevDeliveryRuntime();
        Path root = MediaDevLocalDirectoryDestination.confineRoot(configured);
        List<MediaDevDeliveryStoreFactory> factories = ServiceLoader.load(MediaDevDeliveryStoreFactory.class).stream()
                .map(ServiceLoader.Provider::get)
                .filter(factory -> "postgresql-dev-delivery".equals(factory.factoryId()))
                .toList();
        if (factories.size() != 1) {
            throw new IllegalStateException("exactly one PostgreSQL DEV_ONLY delivery store factory is required");
        }
        DeliveryOperationStore store = factories.get(0).createDevOnly(Map.copyOf(environment));
        return new MediaDevDeliveryRuntime(runtime, store, root, Instant::now);
    }

    boolean available() { return engine != null; }

    /**
     * Exports the exact version. First call enqueues, dispatches, writes, then reads back and (only then)
     * confirms. A repeated call replays the stored operation; an unresolved one is reconciled by readback.
     */
    Outcome export(String tenantId, String principalId, Export request) {
        ensureAvailable();
        Objects.requireNonNull(request, "request");
        if (!DESTINATION_ID.equals(request.destinationId())) {
            throw new UnknownDestinationException();
        }
        ExportRequest exportRequest = exportRequest(tenantId, principalId, request);
        boolean replayed = engine.find(tenantId, request.requestId()).isPresent();
        DeliveryResult result = engine.export(exportRequest);
        // Only a retry reconciles: a first call that ended unconfirmed reports that honestly (202).
        if (replayed && (result.status() == MediaDeliveryEngine.Status.OUTCOME_UNKNOWN
                || result.status() == MediaDeliveryEngine.Status.SENT)) {
            result = engine.reconcileAndResume(exportRequest);
        }
        return new Outcome(result, replayed);
    }

    /** Owner-scoped durable readback of one operation; another principal's operation is absent. */
    Optional<DeliveryResult> find(String tenantId, String principalId, String requestId) {
        ensureAvailable();
        return engine.find(tenantId, requestId).filter(result -> result.principalId().equals(principalId));
    }

    static final class UnknownDestinationException extends RuntimeException {
        UnknownDestinationException() { super("destination is not configured"); }
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
    private record OwnerReadAuthorization(MediaRuntime runtime, Supplier<Instant> clock)
            implements MediaDeliveryEngine.AuthorizationPort {
        @Override public TransferAuthorization authorize(ExportRequest request) {
            if (!readable(request)) return null;
            return new TransferAuthorization("dev-owner-read:" + request.requestId(), request.tenantId(),
                    request.principalId(), request.requestId(), request.artifact().artifactId(),
                    request.artifact().versionRef(), request.artifact().digest(), request.destinationRef(),
                    clock.get().plus(GRANT_VALIDITY));
        }

        @Override public Boolean isCurrent(TransferAuthorization grant, Instant now) {
            return runtime.artifact(grant.tenantId(), grant.principalId(), grant.artifactId())
                    .map(found -> found.version().value().equals(grant.versionRef())).orElse(false);
        }

        private boolean readable(ExportRequest request) {
            return runtime.artifact(request.tenantId(), request.principalId(), request.artifact().artifactId())
                    .map(found -> found.version().value().equals(request.artifact().versionRef())).orElse(false);
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
