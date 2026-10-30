package com.ghatana.audio.video.multimodal.datacloud;

import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.Outcome;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.PublicationAmbiguousException;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.PublicationReceipt;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.PublishResult;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.Recorded;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.SourceReadbackAuthority;
import com.ghatana.audio.video.multimodal.datacloud.MediaSemanticObservationProjector.MediaDerivedObservation;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * DC-05: idempotent publication through admitted seams — replay produces one
 * logical downstream projection, ambiguous receipts stay OUTCOME_UNKNOWN,
 * denied/unavailable source readback and destinations never double-write.
 */
class MediaObservationPublicationCoordinatorTest {

    private static final Instant OBSERVED_AT = Instant.parse("2026-10-30T12:00:00Z");

    private static final class InMemoryOutbox
            implements MediaObservationPublicationCoordinator.PublicationOutbox {
        private final Map<String, Recorded> records = new HashMap<>();
        @Override public Optional<Recorded> find(String dedupKey) {
            return Optional.ofNullable(records.get(dedupKey));
        }
        @Override public void record(Recorded recorded) {
            records.put(recorded.dedupKey(), recorded);
        }
    }

    private static MediaDerivedObservation observation(String tenant, String eventId, String version) {
        return new MediaDerivedObservation(
                tenant, tenant, "artifact-9", version, version,
                "observation-3", "scene-label", "loading-dock",
                OBSERVED_AT, OBSERVED_AT.plusSeconds(1), "vision-runtime", eventId,
                "clip-model", "clip-model-v7", "policy-redaction-2",
                "privacy-service", "consent-4", "owner-1", "steward-1",
                "CONFIDENTIAL", "CONFIDENTIAL", List.of("incident-investigation"),
                "eu", Optional.of("retention-media-30d"), 91, "verified");
    }

    private static MediaObservationPublicationCoordinator coordinator(
            SourceReadbackAuthority.Decision authority,
            MediaObservationPublicationCoordinator.PublicationClient destination,
            InMemoryOutbox outbox) {
        return new MediaObservationPublicationCoordinator(
                new MediaSemanticObservationProjector(),
                (tenant, artifact, version) -> authority,
                destination, outbox);
    }

    @Test
    void publishesOnceAndBindsReceiptToTheDedupKey() {
        InMemoryOutbox outbox = new InMemoryOutbox();
        AtomicInteger publishes = new AtomicInteger();
        var coordinator = coordinator(
                SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    assertThat(tenant).isEqualTo("tenant-a");
                    return new PublicationReceipt("receipt-1", "pub-v1");
                },
                outbox);

        PublishResult result = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        assertThat(result.outcome()).isEqualTo(Outcome.PUBLISHED);
        assertThat(result.receipt()).contains(new PublicationReceipt("receipt-1", "pub-v1"));
        assertThat(result.dedupKey()).isEqualTo("event-7|artifact-v3");
        assertThat(publishes.get()).isEqualTo(1);
    }

    @Test
    void replayOfSameEventVersionYieldsOneLogicalProjection() {
        InMemoryOutbox outbox = new InMemoryOutbox();
        AtomicInteger publishes = new AtomicInteger();
        var coordinator = coordinator(
                SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("receipt-1", "pub-v1");
                },
                outbox);

        coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        PublishResult replay = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        assertThat(replay.outcome()).isEqualTo(Outcome.PUBLISHED);
        assertThat(replay.detail()).contains("replay");
        assertThat(publishes.get()).isEqualTo(1); // never a second downstream write

        // A different event or version is a distinct logical projection.
        coordinator.publish(observation("tenant-a", "event-8", "artifact-v3"));
        coordinator.publish(observation("tenant-a", "event-7", "artifact-v4"));
        assertThat(publishes.get()).isEqualTo(3);
    }

    @Test
    void ambiguousReceiptStaysOutcomeUnknownAndIsNeverRepublished() {
        InMemoryOutbox outbox = new InMemoryOutbox();
        AtomicInteger publishes = new AtomicInteger();
        var coordinator = coordinator(
                SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    throw new PublicationAmbiguousException("no receipt", null);
                },
                outbox);

        PublishResult result = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        assertThat(result.outcome()).isEqualTo(Outcome.OUTCOME_UNKNOWN);
        assertThat(result.receipt()).isEmpty();

        // Replay of an ambiguous dispatch does not blindly republish.
        PublishResult replay = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        assertThat(replay.outcome()).isEqualTo(Outcome.OUTCOME_UNKNOWN);
        assertThat(publishes.get()).isEqualTo(1);
    }

    @Test
    void deniedOrUnavailableSourceReadbackNeverPublishes() {
        for (SourceReadbackAuthority.Decision denied : new SourceReadbackAuthority.Decision[]{
                SourceReadbackAuthority.Decision.DENIED,
                SourceReadbackAuthority.Decision.NOT_ADMITTED,
                SourceReadbackAuthority.Decision.UNAVAILABLE}) {
            InMemoryOutbox outbox = new InMemoryOutbox();
            AtomicInteger publishes = new AtomicInteger();
            var coordinator = coordinator(denied,
                    (tenant, projection) -> {
                        publishes.incrementAndGet();
                        return new PublicationReceipt("r", "v");
                    },
                    outbox);
            PublishResult result = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
            assertThat(result.outcome()).as(denied.name()).isEqualTo(Outcome.DENIED);
            assertThat(publishes.get()).as(denied.name()).isZero();
        }
    }

    @Test
    void liveReverificationAfterRevocationDeniesANewProjection() {
        InMemoryOutbox outbox = new InMemoryOutbox();
        AtomicReference<SourceReadbackAuthority.Decision> live =
                new AtomicReference<>(SourceReadbackAuthority.Decision.ADMITTED);
        AtomicInteger publishes = new AtomicInteger();
        var coordinator = new MediaObservationPublicationCoordinator(
                new MediaSemanticObservationProjector(),
                (tenant, artifact, version) -> live.get(),
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("receipt-1", "pub-v1");
                },
                outbox);

        coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        live.set(SourceReadbackAuthority.Decision.DENIED);
        PublishResult afterRevocation =
                coordinator.publish(observation("tenant-a", "event-8", "artifact-v4"));
        assertThat(afterRevocation.outcome()).isEqualTo(Outcome.DENIED);
        assertThat(publishes.get()).isEqualTo(1);
    }

    @Test
    void malformedObservationFailsBeforeAnyPublicationAttempt() {
        InMemoryOutbox outbox = new InMemoryOutbox();
        AtomicInteger publishes = new AtomicInteger();
        var coordinator = coordinator(
                SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("r", "v");
                },
                outbox);
        // Cross-tenant observation is rejected inside the projector — no publish.
        MediaDerivedObservation crossTenant = new MediaDerivedObservation(
                "tenant-a", "tenant-b", "artifact-9", "artifact-v3", "artifact-v3",
                "observation-3", "scene-label", "loading-dock",
                OBSERVED_AT, OBSERVED_AT.plusSeconds(1), "vision-runtime", "event-7",
                "clip-model", "clip-model-v7", "policy-redaction-2",
                "privacy-service", "consent-4", "owner-1", "steward-1",
                "CONFIDENTIAL", "CONFIDENTIAL", List.of("incident-investigation"),
                "eu", Optional.of("retention-media-30d"), 91, "verified");
        assertThatThrownBy(() -> coordinator.publish(crossTenant))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(publishes.get()).isZero();
    }

    @Test
    void publicationSeesOnlyTheBoundedProjectedContract() {
        InMemoryOutbox outbox = new InMemoryOutbox();
        AtomicInteger publishes = new AtomicInteger();
        var coordinator = coordinator(
                SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    // The projected contract carries references and redacted
                    // values only — never raw artifact payloads.
                    assertThat(projection.facts()).singleElement().satisfies(fact ->
                            assertThat(fact.value()).isEqualTo(
                                    new com.ghatana.datacloud.semantic.OperationalSemanticContext
                                            .TextValue("loading-dock")));
                    return new PublicationReceipt("receipt-1", "pub-v1");
                },
                outbox);
        coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        assertThat(publishes.get()).isEqualTo(1);
    }
}
