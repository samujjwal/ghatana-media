package com.ghatana.audio.video.infrastructure.messaging;

import com.ghatana.core.async.AsyncOperation;
import com.ghatana.messaging.DeliveryOutcome;
import com.ghatana.messaging.EventBusPort;
import com.ghatana.messaging.EventEnvelope;
import com.ghatana.messaging.EventSubscription;
import com.ghatana.messaging.outbox.ClaimedOutboxPublisher;
import com.ghatana.messaging.outbox.OutboxPublicationException;
import com.ghatana.messaging.outbox.OutboxPublicationSource;
import com.ghatana.messaging.outbox.OutboxPublisherDiagnostics;
import com.ghatana.messaging.util.AsyncOperations;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletionException;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaLifecycleOutboxRelayTest {
    private static final Instant NOW = Instant.parse("2026-11-05T12:00:00Z");

    @Test
    void lostDatabaseAckRedeliversStableEventIdentityWithoutClaimingConsumerOrJobFinality() {
        UUID eventId = UUID.randomUUID();
        FakeSource source = new FakeSource(event(eventId), NOW.plusSeconds(30));
        source.failNextPublicationAck = true;
        FakeEventBus broker = new FakeEventBus();
        try (MediaLifecycleOutboxRelay relay = relay(source, broker, NOW)) {
            assertThatThrownBy(() -> run(relay.runOnce()))
                    .isInstanceOf(CompletionException.class)
                    .hasCauseInstanceOf(OutboxPublicationException.class);

            assertThat(source.publicationAcknowledged).isFalse();
            assertThat(source.failureAcknowledged).isFalse();
            assertThat(source.claimReleased).isTrue();

            ClaimedOutboxPublisher.BatchResult replay = run(relay.runOnce());
            assertThat(replay.claimedEvents()).isEqualTo(1);
            assertThat(replay.publishedEvents()).isEqualTo(1);
            assertThat(broker.eventIds).containsExactly(eventId.toString(), eventId.toString());
            assertThat(source.publicationAcknowledged).isTrue();
            assertThat(source.consumerEffectRecorded).isFalse();
            assertThat(source.jobTerminalStateRecorded).isFalse();
        }
    }

    @Test
    void expiredLeaseFailsClosedBeforeBrokerPublication() {
        UUID eventId = UUID.randomUUID();
        FakeSource source = new FakeSource(event(eventId), NOW.minusSeconds(1));
        FakeEventBus broker = new FakeEventBus();
        try (MediaLifecycleOutboxRelay relay = relay(source, broker, NOW)) {
            assertThatThrownBy(() -> run(relay.runOnce()))
                    .isInstanceOf(CompletionException.class)
                    .hasRootCauseInstanceOf(OutboxPublicationException.class)
                    .rootCause()
                    .extracting(error -> ((OutboxPublicationException) error).failureCode())
                    .isEqualTo("OUTBOX_CLAIM_EXPIRED");
            assertThat(broker.eventIds).isEmpty();
            assertThat(source.claimReleased).isTrue();
            assertThat(source.publicationAcknowledged).isFalse();
        }
    }

    private static MediaLifecycleOutboxRelay relay(FakeSource source, FakeEventBus broker, Instant now) {
        return new MediaLifecycleOutboxRelay(source, broker, "media-test-publisher", 8,
                Duration.ofSeconds(30), OutboxPublisherDiagnostics.NOOP,
                Clock.fixed(now, ZoneOffset.UTC));
    }

    private static OutboxPublicationSource.OutboundEvent event(UUID eventId) {
        return new OutboxPublicationSource.OutboundEvent(eventId, "tenant-a", "job-a",
                "MEDIA_JOB_ACCEPTED", Map.of("state", "ACCEPTED"), NOW, 0, "correlation-a");
    }

    private static <T> T run(AsyncOperation<T> operation) {
        return AsyncOperations.toFuture(operation).join();
    }

    private static final class FakeSource implements OutboxPublicationSource {
        private final OutboundEvent event;
        private final Instant expiresAt;
        private final UUID token = UUID.randomUUID();
        private boolean failNextPublicationAck;
        private boolean publicationAcknowledged;
        private boolean failureAcknowledged;
        private boolean claimReleased;
        private boolean consumerEffectRecorded;
        private boolean jobTerminalStateRecorded;

        private FakeSource(OutboundEvent event, Instant expiresAt) {
            this.event = event;
            this.expiresAt = expiresAt;
        }

        @Override
        public AsyncOperation<Claim> claimBatch(String ownerId, int maximumEvents,
                Instant observedAt, Duration claimDuration) {
            return AsyncOperation.success(new Claim(ownerId, token, expiresAt,
                    publicationAcknowledged ? List.of() : List.of(event)));
        }

        @Override
        public AsyncOperation<Void> markPublished(UUID claimToken, UUID eventId, Instant publishedAt) {
            if (failNextPublicationAck) {
                failNextPublicationAck = false;
                return AsyncOperation.failure(new IllegalStateException("simulated lost durable ack"));
            }
            publicationAcknowledged = true;
            return AsyncOperation.success(null);
        }

        @Override
        public AsyncOperation<Void> markFailed(UUID claimToken, UUID eventId,
                String failureCode, Instant observedAt) {
            failureAcknowledged = true;
            return AsyncOperation.success(null);
        }

        @Override
        public AsyncOperation<Integer> releaseClaim(UUID claimToken, Instant observedAt) {
            claimReleased = true;
            return AsyncOperation.success(1);
        }
    }

    private static final class FakeEventBus implements EventBusPort {
        private final List<String> eventIds = new ArrayList<>();

        @Override
        public <T> AsyncOperation<Void> publish(String topic, EventEnvelope<T> envelope) {
            assertThat(topic).isEqualTo(MediaLifecycleOutboxRelay.TOPIC);
            eventIds.add(envelope.id());
            assertThat(envelope.schemaUri()).isEqualTo(MediaLifecycleOutboxRelay.SCHEMA_URI);
            return AsyncOperation.success(null);
        }

        @Override
        public <T> AsyncOperation<EventSubscription> subscribeAsync(String topic, String consumerGroup,
                Function<EventEnvelope<T>, AsyncOperation<DeliveryOutcome>> handler) {
            return AsyncOperation.failure(new UnsupportedOperationException("consumer receipt is outside this relay"));
        }

        @Override
        public AsyncOperation<Void> unsubscribe(String topic, String consumerGroup) {
            return AsyncOperation.success(null);
        }

        @Override
        public AsyncOperation<Boolean> isHealthy() {
            return AsyncOperation.success(true);
        }
    }
}
