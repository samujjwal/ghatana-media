package com.ghatana.audio.video.infrastructure.messaging;

import com.ghatana.messaging.EventBusPort;
import com.ghatana.messaging.outbox.ClaimedOutboxPublisher;
import com.ghatana.messaging.outbox.OutboxPublicationSource;
import com.ghatana.messaging.outbox.OutboxPublisherDiagnostics;
import com.ghatana.core.async.AsyncOperation;

import java.time.Clock;
import java.time.Duration;
import java.util.Objects;

/**
 * Media's lifecycle-event binding to the shared claim-aware outbox publisher.
 *
 * <p>The source owns atomic append, durable claims, retry eligibility and
 * publication acknowledgement. This relay only binds Media's event identity
 * and broker route; a successful batch means broker acceptance was recorded,
 * not that a consumer effected the event or that a Media job is terminal.</p>
 */
public final class MediaLifecycleOutboxRelay implements AutoCloseable {
    public static final String TOPIC = "media-lifecycle";
    public static final String SOURCE_SERVICE = "media-runtime";
    public static final String SCHEMA_URI = "urn:ghatana:media-lifecycle-event:v1";

    private final ClaimedOutboxPublisher publisher;

    public MediaLifecycleOutboxRelay(
            OutboxPublicationSource source,
            EventBusPort eventBus,
            String ownerId,
            int maximumBatchSize,
            Duration claimDuration,
            OutboxPublisherDiagnostics diagnostics,
            Clock clock) {
        this.publisher = new ClaimedOutboxPublisher(
                Objects.requireNonNull(source, "source"),
                Objects.requireNonNull(eventBus, "eventBus"),
                new ClaimedOutboxPublisher.Config(
                        ownerId, TOPIC, SOURCE_SERVICE, SCHEMA_URI,
                        maximumBatchSize, claimDuration),
                Objects.requireNonNull(diagnostics, "diagnostics"),
                Objects.requireNonNull(clock, "clock"));
    }

    /** Publishes at most one leased batch; this does not report consumer or job finality. */
    public AsyncOperation<ClaimedOutboxPublisher.BatchResult> runOnce() {
        return publisher.runOnce();
    }

    /** Broker readiness only; it does not establish source-store or consumer readiness. */
    public AsyncOperation<Boolean> isReady() {
        return publisher.isReady();
    }

    @Override
    public void close() {
        publisher.close();
    }
}
