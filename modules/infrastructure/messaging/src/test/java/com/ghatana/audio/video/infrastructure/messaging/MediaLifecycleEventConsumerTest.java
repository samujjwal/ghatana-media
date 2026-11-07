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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

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

        var wrongSchemaUri = envelope(event("media.job.accepted", 1), MediaPublicLifecycleEvent.SCHEMA_VERSION,
                "urn:ghatana:media-lifecycle-public:v1");
        assertThatThrownBy(() -> consumer(true, store, LogicalJobStatus.COMPLETED)
                .consume("consumer-a", wrongSchemaUri))
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
    void invalidConsumerIdentityIsTypedAndHasNoAuthorizationProjectionOrReadbackEffect() {
        int[] calls = {0};
        var consumer = new MediaLifecycleEventConsumer(REDACTOR, new MediaLifecycleEventConsumer.Authorization() {
            @Override public boolean mayObserve(String principal, String tenant, String eventPrincipal) {
                calls[0]++;
                return true;
            }
            @Override public boolean mayReadTerminalJob(String principal, String tenant, String jobRef) {
                calls[0]++;
                return true;
            }
        }, new MemoryProjection(), (principal, tenant, jobRef) -> {
            calls[0]++;
            return Optional.empty();
        });

        for (String invalidPrincipal : java.util.List.of("", "consumer-a".repeat(100))) {
            assertThatThrownBy(() -> consumer.consume(invalidPrincipal, envelope(event("media.job.accepted", 1))))
                    .isInstanceOf(MediaLifecycleEventConsumer.LifecycleEventException.class)
                    .extracting(error -> ((MediaLifecycleEventConsumer.LifecycleEventException) error).failure())
                    .isEqualTo(MediaLifecycleEventConsumer.Failure.FORBIDDEN);
            assertThatThrownBy(() -> consumer.readTerminalJob(invalidPrincipal, "tenant-private", "job-private"))
                    .isInstanceOf(MediaLifecycleEventConsumer.LifecycleEventException.class)
                    .extracting(error -> ((MediaLifecycleEventConsumer.LifecycleEventException) error).failure())
                    .isEqualTo(MediaLifecycleEventConsumer.Failure.FORBIDDEN);
        }
        assertThat(calls[0]).isZero();
    }

    @Test
    void identicalEventAliasIsDeduplicatedWithinTenantButDoesNotCrossTenantBoundary() {
        var store = new MemoryProjection();
        var consumer = consumer(true, store, LogicalJobStatus.RUNNING);
        var original = event("media.job.accepted", 1);
        assertThat(consumer.consume("consumer-a", envelope(original)).disposition())
                .isEqualTo(MediaLifecycleEventConsumer.ProjectionDisposition.APPLIED);

        var secondTenant = new MediaPublicLifecycleEvent(original.schemaVersion(), original.eventRef(),
                original.eventType(), REDACTOR.redact("tenant", "tenant-other"), original.principalRef(),
                original.correlationRef(), original.causationRef(), original.aggregateType(),
                original.aggregateRef(), original.aggregateVersion(), original.classification(),
                original.occurredAt(), original.appendFinality(), original.terminalReadbackRequired());
        assertThat(consumer.consume("consumer-a", envelopeForTenant(secondTenant, "tenant-other")).disposition())
                .isEqualTo(MediaLifecycleEventConsumer.ProjectionDisposition.APPLIED);
        assertThat(store.applied).hasSize(2);
    }

    @Test
    void eventIdentityReusedWithDifferentPayloadIsRejectedBeforeProjection() {
        var store = new MemoryProjection();
        var consumer = consumer(true, store, LogicalJobStatus.RUNNING);
        var original = event("media.job.accepted", 1);
        var alteredPayload = new MediaPublicLifecycleEvent(original.schemaVersion(), original.eventRef(),
                original.eventType(), original.tenantRef(), original.principalRef(), original.correlationRef(),
                original.causationRef(), original.aggregateType(), original.aggregateRef(),
                original.aggregateVersion(), "INTERNAL", original.occurredAt(), original.appendFinality(),
                original.terminalReadbackRequired());

        assertThat(consumer.consume("consumer-a", envelope(original)).disposition())
                .isEqualTo(MediaLifecycleEventConsumer.ProjectionDisposition.APPLIED);
        assertThatThrownBy(() -> consumer.consume("consumer-a", envelope(alteredPayload)))
                .isInstanceOf(MediaLifecycleEventConsumer.LifecycleEventException.class)
                .extracting(error -> ((MediaLifecycleEventConsumer.LifecycleEventException) error).failure())
                .isEqualTo(MediaLifecycleEventConsumer.Failure.CONFLICTING_REPLAY);
        assertThat(store.applied).hasSize(1);
    }

    @Test
    void legacyProjectionStoreRemainsSourceCompatibleButFailsClosedWithoutFingerprintSupport() {
        int[] legacyEffects = {0};
        MediaLifecycleEventConsumer.ProjectionStore legacyStore = (tenant, type, ref, version, eventRef) -> {
            legacyEffects[0]++;
            return MediaLifecycleEventConsumer.ProjectionDisposition.APPLIED;
        };
        var consumer = new MediaLifecycleEventConsumer(REDACTOR, allowAll(), legacyStore,
                (principal, tenant, jobRef) -> Optional.empty());

        assertThatThrownBy(() -> consumer.consume("consumer-a", envelope(event("media.job.accepted", 1))))
                .isInstanceOf(MediaLifecycleEventConsumer.LifecycleEventException.class)
                .extracting(error -> ((MediaLifecycleEventConsumer.LifecycleEventException) error).failure())
                .isEqualTo(MediaLifecycleEventConsumer.Failure.UNAVAILABLE);
        assertThat(legacyEffects[0]).isZero();
    }

    @Test
    void envelopeCorrelationAndAggregateReferencesMustMatchPayloadBeforeProjection() {
        var store = new MemoryProjection();
        var consumer = consumer(true, store, LogicalJobStatus.RUNNING);
        var event = event("media.job.accepted", 1);

        var wrongCorrelation = new EventEnvelope<>(SimpleEventId.of(event.eventRef()), event.toPayload(),
                event.occurredAt().toEpochMilli(), MediaLifecycleEventConsumer.TOPIC,
                event.eventType().wireName(), MediaPublicLifecycleEvent.SCHEMA_VERSION,
                "media-runtime", "tenant-private", "correlation-other", MediaPublicLifecycleEvent.SCHEMA_URI,
                event.aggregateRef(), event.eventRef(), Map.of(), "application/json");
        var wrongAggregate = new EventEnvelope<>(SimpleEventId.of(event.eventRef()), event.toPayload(),
                event.occurredAt().toEpochMilli(), MediaLifecycleEventConsumer.TOPIC,
                event.eventType().wireName(), MediaPublicLifecycleEvent.SCHEMA_VERSION,
                "media-runtime", "tenant-private", event.correlationRef(), MediaPublicLifecycleEvent.SCHEMA_URI,
                "aggregate-other", event.eventRef(), Map.of(), "application/json");
        var missingCorrelation = new EventEnvelope<>(SimpleEventId.of(event.eventRef()), event.toPayload(),
                event.occurredAt().toEpochMilli(), MediaLifecycleEventConsumer.TOPIC,
                event.eventType().wireName(), MediaPublicLifecycleEvent.SCHEMA_VERSION,
                "media-runtime", "tenant-private", null, MediaPublicLifecycleEvent.SCHEMA_URI,
                event.aggregateRef(), event.eventRef(), Map.of(), "application/json");
        var missingAggregate = new EventEnvelope<>(SimpleEventId.of(event.eventRef()), event.toPayload(),
                event.occurredAt().toEpochMilli(), MediaLifecycleEventConsumer.TOPIC,
                event.eventType().wireName(), MediaPublicLifecycleEvent.SCHEMA_VERSION,
                "media-runtime", "tenant-private", event.correlationRef(), MediaPublicLifecycleEvent.SCHEMA_URI,
                null, event.eventRef(), Map.of(), "application/json");

        for (var invalidEnvelope : java.util.List.of(
                wrongCorrelation, wrongAggregate, missingCorrelation, missingAggregate)) {
            assertThatThrownBy(() -> consumer.consume("consumer-a", invalidEnvelope))
                    .isInstanceOf(MediaLifecycleEventConsumer.LifecycleEventException.class)
                    .extracting(error -> ((MediaLifecycleEventConsumer.LifecycleEventException) error).failure())
                    .isEqualTo(MediaLifecycleEventConsumer.Failure.INVALID_ABI);
        }
        assertThat(store.applied).isEmpty();
    }

    @Test
    void concurrentConsumersMaterializeOneEventWhenProjectionStoreDeduplicatesAtomically() throws Exception {
        var store = new MemoryProjection();
        var consumer = consumer(true, store, LogicalJobStatus.RUNNING);
        var message = envelope(event("media.job.accepted", 1));
        var ready = new CountDownLatch(2);
        var start = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(2)) {
            var first = workers.submit(() -> {
                ready.countDown();
                start.await();
                return consumer.consume("consumer-a", message).disposition();
            });
            var second = workers.submit(() -> {
                ready.countDown();
                start.await();
                return consumer.consume("consumer-b", message).disposition();
            });
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(java.util.List.of(first.get(5, TimeUnit.SECONDS), second.get(5, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder(MediaLifecycleEventConsumer.ProjectionDisposition.APPLIED,
                            MediaLifecycleEventConsumer.ProjectionDisposition.DUPLICATE);
        }
        assertThat(store.applied).hasSize(1);
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

    @Test
    void terminalReadbackPassesOnlyTheStableRedactedAggregateReferenceToPorts() {
        String rawJobRef = "job-private";
        String expectedRedactedRef = REDACTOR.redact("aggregate", rawJobRef);
        var authorizationReference = new java.util.concurrent.atomic.AtomicReference<String>();
        var readbackReference = new java.util.concurrent.atomic.AtomicReference<String>();
        var consumer = new MediaLifecycleEventConsumer(REDACTOR, new MediaLifecycleEventConsumer.Authorization() {
            @Override public boolean mayObserve(String principal, String tenant, String eventPrincipal) { return true; }
            @Override public boolean mayReadTerminalJob(String principal, String tenant, String redactedJobRef) {
                authorizationReference.set(redactedJobRef);
                return true;
            }
        }, new MemoryProjection(), (principal, tenant, redactedJobRef) -> {
            readbackReference.set(redactedJobRef);
            return Optional.of(new MediaLifecycleEventConsumer.TerminalJobSnapshot(LogicalJobStatus.COMPLETED, 3));
        });

        var result = consumer.readTerminalJob("consumer-a", "tenant-private", rawJobRef);

        assertThat(result.disposition())
                .isEqualTo(MediaLifecycleEventConsumer.TerminalReadbackDisposition.TERMINAL_READBACK_CONFIRMED);
        assertThat(authorizationReference.get()).isEqualTo(expectedRedactedRef).isNotEqualTo(rawJobRef);
        assertThat(readbackReference.get()).isEqualTo(expectedRedactedRef).isNotEqualTo(rawJobRef);
    }

    @Test
    void authorizationUnavailableFailsBeforeProjectionAndProjectionFailureIsExplicitlyUnknown() {
        var store = new MemoryProjection();
        var unavailableAuth = new MediaLifecycleEventConsumer(REDACTOR, new MediaLifecycleEventConsumer.Authorization() {
            @Override public boolean mayObserve(String principal, String tenant, String eventPrincipal) {
                throw new IllegalStateException("authority down");
            }
            @Override public boolean mayReadTerminalJob(String principal, String tenant, String jobRef) { return true; }
        }, store, (principal, tenant, jobRef) -> Optional.empty());
        assertThatThrownBy(() -> unavailableAuth.consume("consumer-a", envelope(event("media.job.accepted", 1))))
                .isInstanceOf(MediaLifecycleEventConsumer.LifecycleEventException.class)
                .extracting(error -> ((MediaLifecycleEventConsumer.LifecycleEventException) error).failure())
                .isEqualTo(MediaLifecycleEventConsumer.Failure.UNAVAILABLE);
        assertThat(store.applied).isEmpty();

        MediaLifecycleEventConsumer.ProjectionStore failingFingerprintAwareStore =
                new MediaLifecycleEventConsumer.ProjectionStore() {
                    @Override
                    public MediaLifecycleEventConsumer.ProjectionDisposition apply(String tenant, String type,
                            String ref, long version, String eventRef) {
                        throw new AssertionError("consumer must use fingerprint-aware overload");
                    }

                    @Override
                    public MediaLifecycleEventConsumer.ProjectionDisposition apply(String tenant, String type,
                            String ref, long version, String eventRef, String payloadFingerprint) {
                        throw new IllegalStateException("commit response lost");
                    }
                };
        var uncertainStore = new MediaLifecycleEventConsumer(REDACTOR, allowAll(), failingFingerprintAwareStore,
                (principal, tenant, jobRef) -> Optional.empty());
        assertThatThrownBy(() -> uncertainStore.consume("consumer-a", envelope(event("media.job.accepted", 1))))
                .isInstanceOf(MediaLifecycleEventConsumer.LifecycleEventException.class)
                .extracting(error -> ((MediaLifecycleEventConsumer.LifecycleEventException) error).failure())
                .isEqualTo(MediaLifecycleEventConsumer.Failure.CONSUMPTION_UNKNOWN);
    }

    @Test
    void projectionCommitWithLostResponseReplaysAsDuplicateWithoutClaimingFinality() {
        var committed = new MemoryProjection();
        boolean[] loseFirstResponse = {true};
        MediaLifecycleEventConsumer.ProjectionStore commitThenLoseResponse =
                new MediaLifecycleEventConsumer.ProjectionStore() {
                    @Override
                    public MediaLifecycleEventConsumer.ProjectionDisposition apply(String tenant, String type,
                            String ref, long version, String eventRef) {
                        throw new AssertionError("consumer must use fingerprint-aware overload");
                    }

                    @Override
                    public MediaLifecycleEventConsumer.ProjectionDisposition apply(String tenant, String aggregateType,
                            String aggregateRef, long aggregateVersion, String eventRef, String payloadFingerprint) {
                        var disposition = committed.apply(
                                tenant, aggregateType, aggregateRef, aggregateVersion, eventRef, payloadFingerprint);
                        if (loseFirstResponse[0]) {
                            loseFirstResponse[0] = false;
                            throw new IllegalStateException("projection commit response lost");
                        }
                        return disposition;
                    }
                };
        var consumer = new MediaLifecycleEventConsumer(REDACTOR, allowAll(), commitThenLoseResponse,
                (principal, tenant, jobRef) -> Optional.empty());
        var message = envelope(event("media.job.completed", 1));

        assertThatThrownBy(() -> consumer.consume("consumer-a", message))
                .isInstanceOf(MediaLifecycleEventConsumer.LifecycleEventException.class)
                .extracting(error -> ((MediaLifecycleEventConsumer.LifecycleEventException) error).failure())
                .isEqualTo(MediaLifecycleEventConsumer.Failure.CONSUMPTION_UNKNOWN);
        assertThat(committed.applied).hasSize(1);

        var replay = consumer.consume("consumer-a", message);
        assertThat(replay.disposition()).isEqualTo(MediaLifecycleEventConsumer.ProjectionDisposition.DUPLICATE);
        assertThat(replay.appendFinality()).isEqualTo(MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND);
        assertThat(replay.terminalReadbackRequired()).isTrue();
        assertThat(committed.applied).hasSize(1);
    }

    @Test
    void terminalReadbackUnavailableNeverLooksLikeConfirmedFinality() {
        var consumer = new MediaLifecycleEventConsumer(REDACTOR, allowAll(), new MemoryProjection(),
                (principal, tenant, jobRef) -> { throw new IllegalStateException("readback unavailable"); });
        var result = consumer.readTerminalJob("consumer-a", "tenant-private", "job-ref");
        assertThat(result.disposition()).isEqualTo(MediaLifecycleEventConsumer.TerminalReadbackDisposition.UNAVAILABLE);
        assertThat(result.terminalStatus()).isNull();
    }

    private static MediaLifecycleEventConsumer consumer(boolean allowed, MemoryProjection store, LogicalJobStatus status) {
        return new MediaLifecycleEventConsumer(REDACTOR, new MediaLifecycleEventConsumer.Authorization() {
            @Override public boolean mayObserve(String principal, String tenant, String eventPrincipal) { return allowed; }
            @Override public boolean mayReadTerminalJob(String principal, String tenant, String jobRef) { return allowed; }
        }, store, (principal, tenant, jobRef) -> Optional.of(
                new MediaLifecycleEventConsumer.TerminalJobSnapshot(status, 5)));
    }

    private static MediaLifecycleEventConsumer.Authorization allowAll() {
        return new MediaLifecycleEventConsumer.Authorization() {
            @Override public boolean mayObserve(String principal, String tenant, String eventPrincipal) { return true; }
            @Override public boolean mayReadTerminalJob(String principal, String tenant, String jobRef) { return true; }
        };
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
        return envelope(event, version, MediaPublicLifecycleEvent.SCHEMA_URI);
    }

    private static EventEnvelope<Map<String, Object>> envelope(
            MediaPublicLifecycleEvent event, String version, String schemaUri) {
        return envelopeForTenant(event, "tenant-private", version, schemaUri);
    }

    private static EventEnvelope<Map<String, Object>> envelopeForTenant(MediaPublicLifecycleEvent event, String tenant) {
        return envelopeForTenant(event, tenant, MediaPublicLifecycleEvent.SCHEMA_VERSION);
    }

    private static EventEnvelope<Map<String, Object>> envelopeForTenant(
            MediaPublicLifecycleEvent event, String tenant, String version) {
        return envelopeForTenant(event, tenant, version, MediaPublicLifecycleEvent.SCHEMA_URI);
    }

    private static EventEnvelope<Map<String, Object>> envelopeForTenant(
            MediaPublicLifecycleEvent event, String tenant, String version, String schemaUri) {
        return new EventEnvelope<>(SimpleEventId.of(event.eventRef()), event.toPayload(),
                event.occurredAt().toEpochMilli(), MediaLifecycleEventConsumer.TOPIC,
                event.eventType().wireName(), version, "media-runtime", tenant,
                event.correlationRef(), schemaUri, event.aggregateRef(),
                event.eventRef(), Map.of(), "application/json");
    }

    private static final class MemoryProjection implements MediaLifecycleEventConsumer.ProjectionStore {
        private final Set<String> applied = new HashSet<>();
        private final Map<String, Long> versions = new java.util.HashMap<>();
        private final Map<String, String> payloadFingerprints = new java.util.HashMap<>();

        @Override
        public synchronized MediaLifecycleEventConsumer.ProjectionDisposition apply(String tenant, String aggregateType,
                String aggregateRef, long aggregateVersion, String eventRef) {
            throw new MediaLifecycleEventConsumer.FingerprintAwareReplayUnsupportedException();
        }

        @Override
        public synchronized MediaLifecycleEventConsumer.ProjectionDisposition apply(String tenant, String aggregateType,
                String aggregateRef, long aggregateVersion, String eventRef, String payloadFingerprint) {
            String key = tenant + "/" + aggregateType + "/" + aggregateRef;
            String eventKey = tenant + "/" + eventRef;
            if (applied.contains(eventKey)) {
                return payloadFingerprints.get(eventKey).equals(payloadFingerprint)
                        ? MediaLifecycleEventConsumer.ProjectionDisposition.DUPLICATE
                        : MediaLifecycleEventConsumer.ProjectionDisposition.CONFLICTING_REPLAY;
            }
            long previous = versions.getOrDefault(key, 0L);
            if (aggregateVersion <= previous) return MediaLifecycleEventConsumer.ProjectionDisposition.OUT_OF_ORDER;
            applied.add(eventKey);
            payloadFingerprints.put(eventKey, payloadFingerprint);
            versions.put(key, aggregateVersion);
            return MediaLifecycleEventConsumer.ProjectionDisposition.APPLIED;
        }
    }
}
