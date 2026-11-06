package com.ghatana.audio.video.infrastructure.messaging;

import com.ghatana.media.runtime.MediaLifecycleIdentifierRedactor;
import com.ghatana.media.runtime.MediaLifecycleProjection.LogicalJobStatus;
import com.ghatana.media.runtime.MediaPublicLifecycleEvent;
import com.ghatana.messaging.EventEnvelope;

import java.util.Objects;
import java.util.Optional;

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
        String principal = required(consumerPrincipal, "consumerPrincipal");
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
        if (!envelope.id().equals(event.eventRef()) || !event.eventRef().equals(envelope.idempotencyKey())
                || !envelope.eventType().equals(event.eventType().wireName())
                || !redactor.redact("tenant", envelope.tenantId()).equals(event.tenantRef())) {
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
                    event.aggregateVersion(), event.eventRef()), "projection disposition");
        } catch (RuntimeException uncertainApply) {
            // The store may have committed before its response was lost. It must deduplicate eventRef
            // atomically so a caller can safely redeliver and learn APPLIED or DUPLICATE.
            throw new LifecycleEventException(Failure.CONSUMPTION_UNKNOWN,
                    "Lifecycle projection outcome requires idempotent replay/readback");
        }
        return new Observation(disposition, MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND,
                event.terminalReadbackRequired(), event.aggregateVersion());
    }

    /** Separate authorized readback; a terminal-shaped event alone never returns terminal truth. */
    public TerminalReadbackResult readTerminalJob(
            String consumerPrincipal, String tenantId, String jobRef) {
        String principal = required(consumerPrincipal, "consumerPrincipal");
        String tenant = required(tenantId, "tenantId");
        String reference = required(jobRef, "jobRef");
        final boolean allowed;
        try {
            allowed = authorization.mayReadTerminalJob(principal, tenant, reference);
        } catch (RuntimeException unavailable) {
            throw new LifecycleEventException(Failure.UNAVAILABLE, "Terminal job authorization is unavailable");
        }
        if (!allowed) throw new LifecycleEventException(Failure.FORBIDDEN, "Terminal job readback is not authorized");
        final Optional<TerminalJobSnapshot> snapshot;
        try {
            snapshot = terminalJobReadback.read(principal, tenant, reference);
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
        if (value == null || value.isBlank() || value.length() > 512) {
            throw new IllegalArgumentException(name + " is required and bounded");
        }
        return value.trim();
    }

    public interface Authorization {
        boolean mayObserve(String consumerPrincipal, String tenantId, String redactedEventPrincipal);
        boolean mayReadTerminalJob(String consumerPrincipal, String tenantId, String redactedJobRef);
    }

    /** Must atomically deduplicate eventRef and reject lower aggregate versions across restarts. */
    @FunctionalInterface
    public interface ProjectionStore {
        ProjectionDisposition apply(String tenantId, String aggregateType, String aggregateRef,
                long aggregateVersion, String eventRef);
    }

    @FunctionalInterface
    public interface TerminalJobReadback {
        Optional<TerminalJobSnapshot> read(String consumerPrincipal, String tenantId, String redactedJobRef);
    }

    public enum ProjectionDisposition { APPLIED, DUPLICATE, OUT_OF_ORDER }
    public enum TerminalReadbackDisposition { TERMINAL_READBACK_CONFIRMED, NOT_TERMINAL, UNAVAILABLE }
    public enum Failure { INVALID_ABI, FORBIDDEN, UNAVAILABLE, CONSUMPTION_UNKNOWN }
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
