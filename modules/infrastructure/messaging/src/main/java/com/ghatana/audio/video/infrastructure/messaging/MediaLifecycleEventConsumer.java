package com.ghatana.audio.video.infrastructure.messaging;

import com.ghatana.media.runtime.MediaLifecycleIdentifierRedactor;
import com.ghatana.media.runtime.MediaLifecycleProjection.LogicalJobStatus;
import com.ghatana.media.runtime.MediaPublicLifecycleEvent;
import com.ghatana.messaging.EventEnvelope;

import java.util.Objects;
import java.util.Optional;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.TreeMap;

/**
 * Validates the public lifecycle ABI and applies authorized, version-aware observations.
 * Appending/consuming an event is never a provider-effect or terminal-job acknowledgement.
 */
public final class MediaLifecycleEventConsumer {
    public static final String TOPIC = "media-lifecycle";
    public static final String SCHEMA_URI = MediaPublicLifecycleEvent.SCHEMA_URI;

    private final MediaLifecycleIdentifierRedactor redactor;
    private final Authorization authorization;
    private final ProjectionStore projectionStore;
    private final TerminalJobReadback terminalJobReadback;

    public MediaLifecycleEventConsumer(
            MediaLifecycleIdentifierRedactor redactor,
            Authorization authorization,
            ProjectionStore projectionStore,
            TerminalJobReadback terminalJobReadback) {
        this.redactor = Objects.requireNonNull(redactor, "redactor");
        this.authorization = Objects.requireNonNull(authorization, "authorization");
        this.projectionStore = Objects.requireNonNull(projectionStore, "projectionStore");
        this.terminalJobReadback = Objects.requireNonNull(terminalJobReadback, "terminalJobReadback");
    }

    public Observation consume(String consumerPrincipal, EventEnvelope<?> envelope) {
        String principal = requiredPrincipal(consumerPrincipal);
        Objects.requireNonNull(envelope, "envelope");
        if (!TOPIC.equals(envelope.topic()) || !SCHEMA_URI.equals(envelope.schemaUri())
                || !MediaPublicLifecycleEvent.SCHEMA_VERSION.equals(envelope.eventTypeVersion())
                || !"application/json".equals(envelope.getContentType())) {
            throw new LifecycleEventException(Failure.INVALID_ABI, "Lifecycle event envelope does not match public v1 ABI");
        }
        final MediaPublicLifecycleEvent event;
        try {
            event = MediaPublicLifecycleEvent.fromPayload(envelope.payload());
        } catch (RuntimeException invalidPayload) {
            throw new LifecycleEventException(Failure.INVALID_ABI, "Lifecycle payload does not match public v1 contract");
        }
        final String envelopeTenantRef;
        try {
            envelopeTenantRef = redactor.redact("tenant", envelope.tenantId());
        } catch (IllegalArgumentException malformedTenant) {
            throw new LifecycleEventException(Failure.INVALID_ABI,
                    "Lifecycle envelope tenant identity is invalid");
        } catch (RuntimeException redactionUnavailable) {
            throw new LifecycleEventException(Failure.UNAVAILABLE,
                    "Lifecycle identifier redaction is unavailable");
        }
        if (!envelope.id().equals(event.eventRef()) || !event.eventRef().equals(envelope.idempotencyKey())
                || !envelope.eventType().equals(event.eventType().wireName())
                || !Objects.equals(envelope.correlationId(), event.correlationRef())
                || !Objects.equals(envelope.partitionKey(), event.aggregateRef())
                || !envelopeTenantRef.equals(event.tenantRef())) {
            throw new LifecycleEventException(Failure.INVALID_ABI, "Lifecycle envelope and payload identities do not match");
        }
        final boolean allowed;
        try {
            allowed = authorization.mayObserve(principal, envelope.tenantId(), event.principalRef());
        } catch (RuntimeException unavailable) {
            throw new LifecycleEventException(Failure.UNAVAILABLE, "Lifecycle authorization is unavailable");
        }
        if (!allowed) throw new LifecycleEventException(Failure.FORBIDDEN, "Lifecycle observation is not authorized");
        final ProjectionDisposition disposition;
        try {
            disposition = Objects.requireNonNull(projectionStore.apply(
                    envelope.tenantId(), event.aggregateType(), event.aggregateRef(),
                    event.aggregateVersion(), event.eventRef(), payloadFingerprint(event)), "projection disposition");
        } catch (FingerprintAwareReplayUnsupportedException unsupported) {
            throw new LifecycleEventException(Failure.UNAVAILABLE,
                    "Lifecycle projection store does not support fingerprint-aware replay");
        } catch (RuntimeException uncertainApply) {
            // The store may have committed before its response was lost. It must deduplicate eventRef
            // atomically so a caller can safely redeliver and learn APPLIED or DUPLICATE.
            throw new LifecycleEventException(Failure.CONSUMPTION_UNKNOWN,
                    "Lifecycle projection outcome requires idempotent replay/readback");
        }
        if (disposition == ProjectionDisposition.CONFLICTING_REPLAY) {
            throw new LifecycleEventException(Failure.CONFLICTING_REPLAY,
                    "Lifecycle event identity was replayed with different content");
        }
        return new Observation(disposition, MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND,
                event.terminalReadbackRequired(), event.aggregateVersion());
    }

    /** Separate authorized readback; a terminal-shaped event alone never returns terminal truth. */
    public TerminalReadbackResult readTerminalJob(
            String consumerPrincipal, String tenantId, String jobRef) {
        String principal = requiredPrincipal(consumerPrincipal);
        String tenant = required(tenantId, "tenantId");
        String reference = required(jobRef, "jobRef");
        String redactedReference = redactor.redact("aggregate", reference);
        final boolean allowed;
        try {
            allowed = authorization.mayReadTerminalJob(principal, tenant, redactedReference);
        } catch (RuntimeException unavailable) {
            throw new LifecycleEventException(Failure.UNAVAILABLE, "Terminal job authorization is unavailable");
        }
        if (!allowed) throw new LifecycleEventException(Failure.FORBIDDEN, "Terminal job readback is not authorized");
        final Optional<TerminalJobSnapshot> snapshot;
        try {
            snapshot = terminalJobReadback.read(principal, tenant, redactedReference);
        } catch (RuntimeException unavailable) {
            return new TerminalReadbackResult(TerminalReadbackDisposition.UNAVAILABLE, null, 0);
        }
        if (snapshot == null || snapshot.isEmpty()) {
            return new TerminalReadbackResult(TerminalReadbackDisposition.UNAVAILABLE, null, 0);
        }
        TerminalJobSnapshot value = snapshot.orElseThrow();
        if (value.status() != LogicalJobStatus.COMPLETED
                && value.status() != LogicalJobStatus.PARTIALLY_SUCCEEDED
                && value.status() != LogicalJobStatus.FAILED
                && value.status() != LogicalJobStatus.CANCELLED) {
            return new TerminalReadbackResult(TerminalReadbackDisposition.NOT_TERMINAL, null, value.version());
        }
        return new TerminalReadbackResult(TerminalReadbackDisposition.TERMINAL_READBACK_CONFIRMED,
                value.status(), value.version());
    }

    private static String required(String value, String name) {
        if (value == null || value.length() > 512 || hasBoundaryWhitespace(value)) {
            throw new LifecycleEventException(Failure.FORBIDDEN, name + " identity is invalid");
        }
        return value;
    }

    /** Missing caller identity is a typed authorization failure and must fail before any port call. */
    private static String requiredPrincipal(String value) {
        if (value == null || value.length() > 512 || hasBoundaryWhitespace(value)) {
            throw new LifecycleEventException(Failure.FORBIDDEN, "Lifecycle consumer identity is invalid");
        }
        return value;
    }

    /** Identity values are exact references; normalization here could authorize a different principal. */
    private static boolean hasBoundaryWhitespace(String value) {
        if (value.isEmpty()) return true;
        int first = value.codePointAt(0);
        int last = value.codePointBefore(value.length());
        return isWhitespace(first) || isWhitespace(last);
    }

    private static boolean isWhitespace(int codePoint) {
        return Character.isWhitespace(codePoint) || Character.isSpaceChar(codePoint);
    }

    /** Stable digest of every admitted ABI field, independent of input map iteration order. */
    private static String payloadFingerprint(MediaPublicLifecycleEvent event) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            new TreeMap<>(event.toPayload()).forEach((key, value) -> {
                updateLengthPrefixed(digest, key);
                updateLengthPrefixed(digest, value.getClass().getName());
                updateLengthPrefixed(digest, value.toString());
            });
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private static void updateLengthPrefixed(MessageDigest digest, String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        digest.update((byte) (bytes.length >>> 24));
        digest.update((byte) (bytes.length >>> 16));
        digest.update((byte) (bytes.length >>> 8));
        digest.update((byte) bytes.length);
        digest.update(bytes);
    }

    public interface Authorization {
        boolean mayObserve(String consumerPrincipal, String tenantId, String redactedEventPrincipal);
        boolean mayReadTerminalJob(String consumerPrincipal, String tenantId, String redactedJobRef);
    }

    /**
     * Must atomically deduplicate eventRef plus payloadFingerprint and reject lower aggregate
     * versions across restarts. Reuse of an eventRef with a different fingerprint returns
     * CONFLICTING_REPLAY without changing the projection.
     */
    @FunctionalInterface
    public interface ProjectionStore {
        /** Legacy source-compatible operation. New consumer calls require the fingerprint-aware overload. */
        ProjectionDisposition apply(String tenantId, String aggregateType, String aggregateRef,
                long aggregateVersion, String eventRef);

        /**
         * Fingerprint-aware replay operation. Legacy stores remain source compatible but fail closed
         * until they persist and compare the fingerprint atomically with the event identity.
         */
        default ProjectionDisposition apply(String tenantId, String aggregateType, String aggregateRef,
                long aggregateVersion, String eventRef, String payloadFingerprint) {
            throw new FingerprintAwareReplayUnsupportedException();
        }
    }

    public static final class FingerprintAwareReplayUnsupportedException extends RuntimeException {
        public FingerprintAwareReplayUnsupportedException() {
            super("Fingerprint-aware lifecycle replay is unsupported");
        }
    }

    @FunctionalInterface
    public interface TerminalJobReadback {
        Optional<TerminalJobSnapshot> read(String consumerPrincipal, String tenantId, String redactedJobRef);
    }

    public enum ProjectionDisposition { APPLIED, DUPLICATE, OUT_OF_ORDER, CONFLICTING_REPLAY }
    public enum TerminalReadbackDisposition { TERMINAL_READBACK_CONFIRMED, NOT_TERMINAL, UNAVAILABLE }
    public enum Failure { INVALID_ABI, FORBIDDEN, UNAVAILABLE, CONSUMPTION_UNKNOWN, CONFLICTING_REPLAY }
    public record Observation(ProjectionDisposition disposition,
            MediaPublicLifecycleEvent.AppendFinality appendFinality,
            boolean terminalReadbackRequired, long aggregateVersion) { }
    public record TerminalJobSnapshot(LogicalJobStatus status, long version) {
        public TerminalJobSnapshot {
            Objects.requireNonNull(status, "status");
            if (version < 1) throw new IllegalArgumentException("version must be positive");
        }
    }
    public record TerminalReadbackResult(TerminalReadbackDisposition disposition,
            LogicalJobStatus terminalStatus, long version) { }

    public static final class LifecycleEventException extends RuntimeException {
        private final Failure failure;
        public LifecycleEventException(Failure failure, String message) {
            super(message);
            this.failure = Objects.requireNonNull(failure, "failure");
        }
        public Failure failure() { return failure; }
    }
}
