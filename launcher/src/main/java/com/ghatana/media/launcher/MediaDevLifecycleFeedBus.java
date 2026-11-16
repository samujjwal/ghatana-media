package com.ghatana.media.launcher;

import com.ghatana.core.async.AsyncOperation;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Feed;
import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaLifecycleEventPublisher;
import com.ghatana.media.runtime.MediaLifecycleEventType;
import com.ghatana.media.runtime.MediaLifecycleIdentifierRedactor;
import com.ghatana.media.runtime.MediaPublicLifecycleEvent;
import com.ghatana.messaging.DeliveryOutcome;
import com.ghatana.messaging.EventBusPort;
import com.ghatana.messaging.EventEnvelope;
import com.ghatana.messaging.EventSubscription;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;

/**
 * The DEV_ONLY channel behind the transactional outbox relay. {@link #publish} maps one outbox row (the in-transaction
 * {@code MEDIA_JOB_*} family) onto the public {@code media.lifecycle-event.v1} ABI and commits it to the durable
 * {@link Feed}. Returning success means the entry is committed and consumer-visible, which is the only thing the relay
 * may mark the outbox row published on; it says nothing about the consumer having applied it or about job finality.
 *
 * <p>Rows that carry no public event type (for example {@code MEDIA_JOB_OUTCOME_UNKNOWN}, which the v1 ABI does not
 * name, or rows written before {@code aggregateVersion} was recorded) are acknowledged without a feed entry and counted
 * in {@link #skipped()}: the feed never invents an event the ABI cannot express.</p>
 *
 * <p>Fault seam (DEV_ONLY, off unless {@code MEDIA_DEV_LIFECYCLE_FEED_FAULT_MARKER} names a path): after the first
 * committed append the process halts once, before the relay can mark the row, so a restart must redeliver it. The
 * marker file makes the fault fire exactly once across restarts.</p>
 */
final class MediaDevLifecycleFeedBus implements EventBusPort {
    static final String ENV_FAULT_MARKER = "MEDIA_DEV_LIFECYCLE_FEED_FAULT_MARKER";
    private static final Map<String, MediaLifecycleEventType> PUBLIC_TYPES = Map.of(
            "MEDIA_JOB_ACCEPTED", MediaLifecycleEventType.JOB_ACCEPTED,
            "MEDIA_JOB_COMPLETED", MediaLifecycleEventType.JOB_COMPLETED,
            "MEDIA_JOB_FAILED", MediaLifecycleEventType.JOB_FAILED,
            "MEDIA_JOB_CANCELLED", MediaLifecycleEventType.JOB_CANCELLED);

    private final Feed feed;
    private final MediaLifecycleIdentifierRedactor redactor;
    private final Path faultMarker;
    private final Runnable halt;
    private final AtomicLong appended = new AtomicLong();
    private final AtomicLong skipped = new AtomicLong();

    MediaDevLifecycleFeedBus(Feed feed, MediaLifecycleIdentifierRedactor redactor, Path faultMarker, Runnable halt) {
        this.feed = Objects.requireNonNull(feed, "feed");
        this.redactor = Objects.requireNonNull(redactor, "redactor");
        this.faultMarker = faultMarker;
        this.halt = Objects.requireNonNull(halt, "halt");
    }

    long appended() { return appended.get(); }
    long skipped() { return skipped.get(); }

    /**
     * Publisher over the attempt-aware outbox ({@code media_processing_lifecycle_outbox}), which already carries the
     * public wire event names and versions. Same contract as {@link #publish}: returning normally means committed to the
     * feed (or not a public type and skipped); throwing leaves the row unpublished for retry.
     */
    MediaLifecycleEventPublisher internalPublisher() {
        return new MediaLifecycleEventPublisher() {
            @Override public String publisherId() { return "dev-lifecycle-feed"; }
            @Override public boolean ready() { return feed.ready(); }
            @Override public boolean productionEligible() { return false; }
            @Override public void publish(MediaLifecycleEvent event) {
                final MediaPublicLifecycleEvent publicEvent;
                try {
                    publicEvent = MediaPublicLifecycleEvent.fromInternal(event, redactor);
                } catch (IllegalArgumentException notPublic) {
                    skipped.incrementAndGet();
                    return;
                }
                feed.append(event.tenantId(), event.eventId(), event.aggregateId(), publicEvent);
                appended.incrementAndGet();
                maybeFault();
            }
        };
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T> AsyncOperation<Void> publish(String topic, EventEnvelope<T> envelope) {
        try {
            MediaLifecycleEventType type = PUBLIC_TYPES.get(envelope.eventType());
            Object payloadValue = envelope.payload();
            if (type == null || !(payloadValue instanceof Map<?, ?> payload)
                    || !(payload.get("aggregateVersion") instanceof Number version)
                    || !(payload.get("jobId") instanceof String jobId)) {
                skipped.incrementAndGet();
                return AsyncOperation.success(null);
            }
            String outboxEventId = envelope.id();
            String correlation = envelope.correlationId() == null || envelope.correlationId().isBlank()
                    ? outboxEventId : envelope.correlationId();
            String principal = String.valueOf(envelope.metadata().getOrDefault("subjectId", ""));
            MediaPublicLifecycleEvent event = new MediaPublicLifecycleEvent(
                    MediaPublicLifecycleEvent.SCHEMA_VERSION,
                    redactor.redact("event", outboxEventId), type,
                    redactor.redact("tenant", envelope.tenantId()),
                    redactor.redact("principal", principal),
                    redactor.redact("correlation", correlation), "",
                    "job", redactor.redact("aggregate", jobId), version.longValue(), "INTERNAL",
                    Instant.ofEpochMilli(envelope.getTimestamp()),
                    MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND, type.terminalReadbackRequired());
            feed.append(envelope.tenantId(), outboxEventId, jobId, event);
            appended.incrementAndGet();
            maybeFault();
            return AsyncOperation.success(null);
        } catch (RuntimeException failure) {
            return AsyncOperation.failure(failure);
        }
    }

    private void maybeFault() {
        if (faultMarker == null) return;
        try {
            Files.writeString(faultMarker, "fired", java.nio.file.StandardOpenOption.CREATE_NEW);
        } catch (java.nio.file.FileAlreadyExistsException alreadyFired) {
            return;
        } catch (java.io.IOException unavailable) {
            return;
        }
        halt.run();
    }

    @Override
    public <T> AsyncOperation<EventSubscription> subscribeAsync(String topic, String consumerGroup,
            Function<EventEnvelope<T>, AsyncOperation<DeliveryOutcome>> handler) {
        return AsyncOperation.failure(new UnsupportedOperationException(
                "consumers pull from the DEV_ONLY lifecycle feed with their own cursor"));
    }

    @Override public AsyncOperation<Void> unsubscribe(String topic, String consumerGroup) {
        return AsyncOperation.success(null);
    }

    @Override public AsyncOperation<Boolean> isHealthy() { return AsyncOperation.success(feed.ready()); }
}
