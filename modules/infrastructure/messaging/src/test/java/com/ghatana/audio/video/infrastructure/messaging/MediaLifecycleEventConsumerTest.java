package com.ghatana.audio.video.infrastructure.messaging;

import com.ghatana.media.runtime.HmacMediaLifecycleIdentifierRedactor;
import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaLifecycleIdentifierRedactor;
import com.ghatana.media.runtime.MediaLifecycleProjection.LogicalJobStatus;
import com.ghatana.media.runtime.MediaPublicLifecycleEvent;
import com.ghatana.messaging.EventEnvelope;
import com.ghatana.messaging.SimpleEventId;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.HashSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaLifecycleEventConsumerTest {
    private static final MediaLifecycleIdentifierRedactor REDACTOR =
            new HmacMediaLifecycleIdentifierRedactor(new byte[32]);

    @Test
    void consumerAppliesOnlyAuthorizedNewerEventsAndTreatsReplayAndOutOfOrderAsNoEffect() {
        var store = new MemoryProjection();
        var consumer = consumer(true, store, LogicalJobStatus.RUNNING);
        var accepted = envelope(event("media.job.accepted", 2));
        var applied = consumer.consume("consumer-a", accepted);
        assertThat(applied.disposition()).isEqualTo(MediaLifecycleEventConsumer.ProjectionDisposition.APPLIED);
        assertThat(applied.appendFinality()).isEqualTo(MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND);
        assertThat(applied.terminalReadbackRequired()).isFalse();
        assertThat(consumer.consume("consumer-a", accepted).disposition())
                .isEqualTo(MediaLifecycleEventConsumer.ProjectionDisposition.DUPLICATE);
        assertThat(consumer.consume("consumer-a", envelope(event("media.job.cancel_requested", 1))).disposition())
                .isEqualTo(MediaLifecycleEventConsumer.ProjectionDisposition.OUT_OF_ORDER);
        assertThat(store.applied).hasSize(1);
    }

    @Test
    void authorizationFailureDoesNotAdvanceProjectionAndMalformedAbiIsRejected() {
        var store = new MemoryProjection();
        var denied = consumer(false, store, LogicalJobStatus.COMPLETED);
        assertThatThrownBy(() -> denied.consume("consumer-a", envelope(event("media.job.accepted", 1))))
                .isInstanceOf(MediaLifecycleEventConsumer.LifecycleEventException.class)
                .extracting(error -> ((MediaLifecycleEventConsumer.LifecycleEventException) error).failure())
                .isEqualTo(MediaLifecycleEventConsumer.Failure.FORBIDDEN);
        assertThat(store.applied).isEmpty();

        var wrongSchema = envelope(event("media.job.accepted", 1), "2.0.0");
        assertThatThrownBy(() -> consumer(true, store, LogicalJobStatus.COMPLETED).consume("consumer-a", wrongSchema))
                .isInstanceOf(MediaLifecycleEventConsumer.LifecycleEventException.class)
                .extracting(error -> ((MediaLifecycleEventConsumer.LifecycleEventException) error).failure())
                .isEqualTo(MediaLifecycleEventConsumer.Failure.INVALID_ABI);

        var validEvent = event("media.job.accepted", 1);
        var wrongTenant = new EventEnvelope<>(SimpleEventId.of(validEvent.eventRef()), validEvent.toPayload(),
                validEvent.occurredAt().toEpochMilli(), MediaLifecycleEventConsumer.TOPIC,
                validEvent.eventType().wireName(), MediaPublicLifecycleEvent.SCHEMA_VERSION,
                "media-runtime", "tenant-other", validEvent.correlationRef(),
                MediaLifecycleEventConsumer.SCHEMA_URI, validEvent.aggregateRef(), validEvent.eventRef(),
                Map.of(), "application/json");
        assertThatThrownBy(() -> consumer(true, store, LogicalJobStatus.COMPLETED).consume("consumer-a", wrongTenant))
                .isInstanceOf(MediaLifecycleEventConsumer.LifecycleEventException.class)
                .extracting(error -> ((MediaLifecycleEventConsumer.LifecycleEventException) error).failure())
                .isEqualTo(MediaLifecycleEventConsumer.Failure.INVALID_ABI);

        var wrongContentType = new EventEnvelope<>(SimpleEventId.of(validEvent.eventRef()), validEvent.toPayload(),
                validEvent.occurredAt().toEpochMilli(), MediaLifecycleEventConsumer.TOPIC,
                validEvent.eventType().wireName(), MediaPublicLifecycleEvent.SCHEMA_VERSION,
                "media-runtime", "tenant-private", validEvent.correlationRef(),
                MediaLifecycleEventConsumer.SCHEMA_URI, validEvent.aggregateRef(), validEvent.eventRef(),
                Map.of(), "text/plain");
        assertThatThrownBy(() -> consumer(true, store, LogicalJobStatus.COMPLETED).consume("consumer-a", wrongContentType))
                .isInstanceOf(MediaLifecycleEventConsumer.LifecycleEventException.class)
                .extracting(error -> ((MediaLifecycleEventConsumer.LifecycleEventException) error).failure())
                .isEqualTo(MediaLifecycleEventConsumer.Failure.INVALID_ABI);
        assertThat(store.applied).isEmpty();
    }

    @Test
    void terminalEventAppendRemainsNonfinalUntilSeparateAuthorizedReadback() {
        var consumer = consumer(true, new MemoryProjection(), LogicalJobStatus.RUNNING);
        var observation = consumer.consume("consumer-a", envelope(event("media.job.completed", 4)));
        assertThat(observation.appendFinality()).isEqualTo(MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND);
        assertThat(observation.terminalReadbackRequired()).isTrue();

        var notTerminal = consumer.readTerminalJob("consumer-a", "tenant-private", "job-ref");
        assertThat(notTerminal.disposition()).isEqualTo(MediaLifecycleEventConsumer.TerminalReadbackDisposition.NOT_TERMINAL);
        assertThat(notTerminal.terminalStatus()).isNull();

        var confirmedConsumer = consumer(true, new MemoryProjection(), LogicalJobStatus.COMPLETED);
        var terminal = confirmedConsumer.readTerminalJob("consumer-a", "tenant-private", "job-ref");
        assertThat(terminal.disposition()).isEqualTo(MediaLifecycleEventConsumer.TerminalReadbackDisposition.TERMINAL_READBACK_CONFIRMED);
        assertThat(terminal.terminalStatus()).isEqualTo(LogicalJobStatus.COMPLETED);
    }

    @Test
    void terminalReadbackAuthorizationIsIndependentFromEventObservationAuthorization() {
        var consumer = new MediaLifecycleEventConsumer(REDACTOR, new MediaLifecycleEventConsumer.Authorization() {
            @Override public boolean mayObserve(String principal, String tenant, String eventPrincipal) { return true; }
            @Override public boolean mayReadTerminalJob(String principal, String tenant, String jobRef) { return false; }
        }, new MemoryProjection(), (principal, tenant, jobRef) -> Optional.of(
                new MediaLifecycleEventConsumer.TerminalJobSnapshot(LogicalJobStatus.COMPLETED, 2)));
        assertThatThrownBy(() -> consumer.readTerminalJob("consumer-a", "tenant-private", "job-ref"))
                .isInstanceOf(MediaLifecycleEventConsumer.LifecycleEventException.class)
                .extracting(error -> ((MediaLifecycleEventConsumer.LifecycleEventException) error).failure())
                .isEqualTo(MediaLifecycleEventConsumer.Failure.FORBIDDEN);
    }

    private static MediaLifecycleEventConsumer consumer(boolean allowed, MemoryProjection store, LogicalJobStatus status) {
        return new MediaLifecycleEventConsumer(REDACTOR, new MediaLifecycleEventConsumer.Authorization() {
            @Override public boolean mayObserve(String principal, String tenant, String eventPrincipal) { return allowed; }
            @Override public boolean mayReadTerminalJob(String principal, String tenant, String jobRef) { return allowed; }
        }, store, (principal, tenant, jobRef) -> Optional.of(
                new MediaLifecycleEventConsumer.TerminalJobSnapshot(status, 5)));
    }

    private static MediaPublicLifecycleEvent event(String type, long version) {
        return MediaPublicLifecycleEvent.fromInternal(new MediaLifecycleEvent("event-" + type + "-" + version,
                type, "tenant-private", "principal-private", "corr-private", "", "job", "job-private",
                version, "CONFIDENTIAL", Instant.parse("2026-11-05T12:00:00Z"), Map.of()), REDACTOR);
    }

    private static EventEnvelope<Map<String, Object>> envelope(MediaPublicLifecycleEvent event) {
        return envelope(event, MediaPublicLifecycleEvent.SCHEMA_VERSION);
    }

    private static EventEnvelope<Map<String, Object>> envelope(MediaPublicLifecycleEvent event, String version) {
        return new EventEnvelope<>(SimpleEventId.of(event.eventRef()), event.toPayload(),
                event.occurredAt().toEpochMilli(), MediaLifecycleEventConsumer.TOPIC,
                event.eventType().wireName(), version, "media-runtime", "tenant-private",
                event.correlationRef(), MediaLifecycleEventConsumer.SCHEMA_URI, event.aggregateRef(),
                event.eventRef(), Map.of(), "application/json");
    }

    private static final class MemoryProjection implements MediaLifecycleEventConsumer.ProjectionStore {
        private final Set<String> applied = new HashSet<>();
        private final Map<String, Long> versions = new java.util.HashMap<>();

        @Override
        public MediaLifecycleEventConsumer.ProjectionDisposition apply(String tenant, String aggregateType,
                String aggregateRef, long aggregateVersion, String eventRef) {
            String key = tenant + "/" + aggregateType + "/" + aggregateRef;
            if (applied.contains(eventRef)) return MediaLifecycleEventConsumer.ProjectionDisposition.DUPLICATE;
            long previous = versions.getOrDefault(key, 0L);
            if (aggregateVersion <= previous) return MediaLifecycleEventConsumer.ProjectionDisposition.OUT_OF_ORDER;
            applied.add(eventRef);
            versions.put(key, aggregateVersion);
            return MediaLifecycleEventConsumer.ProjectionDisposition.APPLIED;
        }
    }
}
