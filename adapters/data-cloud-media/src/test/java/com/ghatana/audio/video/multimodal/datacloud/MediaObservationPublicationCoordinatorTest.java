package com.ghatana.audio.video.multimodal.datacloud;

import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.Outcome;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.PublicationAmbiguousException;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.PublicationReceipt;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.PublishResult;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.Recorded;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.ClaimResult;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.ClaimStatus;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.DisclosureReadbackAuthority;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.SourceReadbackAuthority;
import com.ghatana.audio.video.multimodal.datacloud.MediaSemanticObservationProjector.MediaDerivedObservation;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Objects;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
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
        private final Map<String, String> claims = new HashMap<>();
        private int failingRecords;
        private int failAfterWrites;

        @Override public synchronized Optional<Recorded> find(String dedupKey) {
            return Optional.ofNullable(records.get(dedupKey));
        }

        @Override public synchronized ClaimResult claim(
                String dedupKey, String legacyDedupKey, String bindingFingerprint) {
            Recorded recorded = records.get(dedupKey);
            if (recorded == null) recorded = records.get(legacyDedupKey);
            if (recorded != null) {
                return new ClaimResult(ClaimStatus.RECORDED, Optional.of(recorded), recorded.bindingFingerprint());
            }
            String current = claims.get(dedupKey);
            if (current != null) {
                return new ClaimResult(ClaimStatus.IN_PROGRESS, Optional.empty(), current);
            }
            claims.put(dedupKey, bindingFingerprint);
            return new ClaimResult(ClaimStatus.ACQUIRED, Optional.empty(), bindingFingerprint);
        }

        @Override public synchronized void record(Recorded recorded) {
            if (failingRecords > 0) {
                failingRecords--;
                throw new IllegalStateException("fixture outbox write failed");
            }
            String claimBinding = claims.get(recorded.dedupKey());
            if (claimBinding != null && !claimBinding.equals(recorded.bindingFingerprint())) {
                throw new IllegalStateException("completion does not match the exclusive claim");
            }
            Recorded prior = records.get(recorded.dedupKey());
            if (prior != null && (!Objects.equals(prior.bindingFingerprint(), recorded.bindingFingerprint())
                    || prior.outcome() != recorded.outcome()
                    || !Objects.equals(prior.receiptId(), recorded.receiptId()))) {
                throw new IllegalStateException("terminal record is immutable");
            }
            records.putIfAbsent(recorded.dedupKey(), recorded);
            claims.remove(recorded.dedupKey());
            if (failAfterWrites > 0) {
                failAfterWrites--;
                throw new IllegalStateException("fixture lost outbox write acknowledgment");
            }
        }

        synchronized void failNextRecords(int count) {
            failingRecords = count;
        }

        synchronized void failAfterNextWrites(int count) {
            failAfterWrites = count;
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
                observation -> DisclosureReadbackAuthority.Decision.ADMITTED,
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
        assertThat(result.dedupKey()).isEqualTo("8:tenant-a7:event-711:artifact-v3");
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
        assertThat(replay.receipt()).isEmpty(); // no synthetic destination version on replay
        assertThat(replay.detail()).contains("replay");
        assertThat(publishes.get()).isEqualTo(1); // never a second downstream write

        // A different event or version is a distinct logical projection.
        coordinator.publish(observation("tenant-a", "event-8", "artifact-v3"));
        coordinator.publish(observation("tenant-a", "event-7", "artifact-v4"));
        assertThat(publishes.get()).isEqualTo(3);
    }

    @Test
    void refusesCrossTenantDedupCollisionsAndAmbiguousDelimiterKeys() {
        InMemoryOutbox outbox = new InMemoryOutbox();
        AtomicInteger publishes = new AtomicInteger();
        var coordinator = coordinator(SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("receipt-" + tenant, "pub-v1");
                }, outbox);
        PublishResult tenantA = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        PublishResult tenantB = coordinator.publish(observation("tenant-b", "event-7", "artifact-v3"));
        assertThat(tenantA.dedupKey()).isNotEqualTo(tenantB.dedupKey());
        assertThat(tenantB.outcome()).isEqualTo(Outcome.PUBLISHED);
        assertThat(publishes.get()).isEqualTo(2);
        assertThat(MediaObservationPublicationCoordinator.dedupKeyOf(observation("a|b", "c", "d")))
                .isNotEqualTo(MediaObservationPublicationCoordinator.dedupKeyOf(observation("a", "b|c", "d")));
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
    void deniedAndUnavailableSourceReadbackNeverPublishesOrMutatesOutbox() {
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
            assertThat(result.outcome()).as(denied.name()).isEqualTo(
                    denied == SourceReadbackAuthority.Decision.DENIED ? Outcome.DENIED : Outcome.NOT_ADMITTED);
            assertThat(publishes.get()).as(denied.name()).isZero();
            assertThat(outbox.find(result.dedupKey())).isEmpty();
        }
    }

    @Test
    void nonEmptyConsentAndRedactionReferencesDoNotReplaceLiveDisclosureReadback() {
        InMemoryOutbox outbox = new InMemoryOutbox();
        AtomicInteger publishes = new AtomicInteger();
        var legacyCoordinator = new MediaObservationPublicationCoordinator(
                new MediaSemanticObservationProjector(),
                (tenant, artifact, version) -> SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("receipt-1", "pub-v1");
                }, outbox);

        PublishResult result = legacyCoordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));

        assertThat(result.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(result.detail()).contains("disclosure policy");
        assertThat(publishes.get()).isZero();
        assertThat(outbox.find(result.dedupKey())).isEmpty();
    }

    @Test
    void deniedOrUnavailableLiveDisclosureNeverPublishesOrMutatesOutbox() {
        for (DisclosureReadbackAuthority.Decision decision : DisclosureReadbackAuthority.Decision.values()) {
            if (decision == DisclosureReadbackAuthority.Decision.ADMITTED) continue;
            InMemoryOutbox outbox = new InMemoryOutbox();
            AtomicInteger publishes = new AtomicInteger();
            AtomicReference<MediaDerivedObservation> checked = new AtomicReference<>();
            var coordinator = new MediaObservationPublicationCoordinator(
                    new MediaSemanticObservationProjector(),
                    (tenant, artifact, version) -> SourceReadbackAuthority.Decision.ADMITTED,
                    candidate -> {
                        checked.set(candidate);
                        return decision;
                    },
                    (tenant, projection) -> {
                        publishes.incrementAndGet();
                        return new PublicationReceipt("unexpected", "pub-v1");
                    }, outbox);

            PublishResult result = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));

            assertThat(result.outcome()).as(decision.name()).isEqualTo(
                    decision == DisclosureReadbackAuthority.Decision.DENIED ? Outcome.DENIED : Outcome.NOT_ADMITTED);
            assertThat(checked.get().consentRef()).isEqualTo("consent-4");
            assertThat(checked.get().redactionDecisionRef()).isEqualTo("policy-redaction-2");
            assertThat(publishes.get()).as(decision.name()).isZero();
            assertThat(outbox.find(result.dedupKey())).isEmpty();
        }
    }

    @Test
    void disclosureAuthorityExceptionsAreNotMisreportedAsPolicyDenials() {
        AtomicInteger publishes = new AtomicInteger();
        InMemoryOutbox outbox = new InMemoryOutbox();
        var coordinator = new MediaObservationPublicationCoordinator(
                new MediaSemanticObservationProjector(),
                (tenant, artifact, version) -> SourceReadbackAuthority.Decision.ADMITTED,
                candidate -> { throw new IllegalStateException("consent owner unavailable"); },
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("unexpected", "pub-v1");
                }, outbox);

        PublishResult result = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));

        assertThat(result.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(publishes.get()).isZero();
        assertThat(outbox.find(result.dedupKey())).isEmpty();
    }

    @Test
    void authorityExceptionsAreNotMisreportedAsPolicyDenials() {
        InMemoryOutbox outbox = new InMemoryOutbox();
        AtomicInteger publishes = new AtomicInteger();
        var coordinator = new MediaObservationPublicationCoordinator(new MediaSemanticObservationProjector(),
                (tenant, artifact, version) -> { throw new IllegalStateException("source owner unavailable"); },
                observation -> DisclosureReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("receipt-1", "pub-v1");
                }, outbox);
        PublishResult result = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        assertThat(result.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(publishes.get()).isZero();
        assertThat(outbox.find(result.dedupKey())).isEmpty();
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
                observation -> DisclosureReadbackAuthority.Decision.ADMITTED,
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
    void revokedAuthorityCannotReadARecordedPublicationOrOverwriteIt() {
        InMemoryOutbox outbox = new InMemoryOutbox();
        AtomicReference<SourceReadbackAuthority.Decision> live =
                new AtomicReference<>(SourceReadbackAuthority.Decision.ADMITTED);
        var coordinator = new MediaObservationPublicationCoordinator(
                new MediaSemanticObservationProjector(), (tenant, artifact, version) -> live.get(),
                observation -> DisclosureReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> new PublicationReceipt("receipt-1", "pub-v1"), outbox);
        PublishResult published = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        live.set(SourceReadbackAuthority.Decision.DENIED);
        PublishResult revokedReplay = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        assertThat(revokedReplay.outcome()).isEqualTo(Outcome.DENIED);
        assertThat(revokedReplay.receipt()).isEmpty();
        assertThat(outbox.find(published.dedupKey())).get().extracting(Recorded::outcome)
                .isEqualTo(Outcome.PUBLISHED);
    }

    @Test
    void revokedDisclosureCannotReadARecordedPublicationOrOverwriteIt() {
        InMemoryOutbox outbox = new InMemoryOutbox();
        AtomicReference<DisclosureReadbackAuthority.Decision> live =
                new AtomicReference<>(DisclosureReadbackAuthority.Decision.ADMITTED);
        AtomicInteger publishes = new AtomicInteger();
        var coordinator = new MediaObservationPublicationCoordinator(
                new MediaSemanticObservationProjector(),
                (tenant, artifact, version) -> SourceReadbackAuthority.Decision.ADMITTED,
                observation -> live.get(),
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("receipt-1", "pub-v1");
                }, outbox);
        PublishResult published = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        live.set(DisclosureReadbackAuthority.Decision.DENIED);

        PublishResult revokedReplay = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));

        assertThat(revokedReplay.outcome()).isEqualTo(Outcome.DENIED);
        assertThat(revokedReplay.receipt()).isEmpty();
        assertThat(publishes.get()).isEqualTo(1);
        assertThat(outbox.find(published.dedupKey())).get().extracting(Recorded::outcome)
                .isEqualTo(Outcome.PUBLISHED);
    }

    @Test
    void unavailableDefaultClaimFailsClosedWithoutDispatch() {
        AtomicInteger publishes = new AtomicInteger();
        MediaObservationPublicationCoordinator.PublicationOutbox noClaimOutbox =
                new MediaObservationPublicationCoordinator.PublicationOutbox() {
                    private final Map<String, Recorded> records = new HashMap<>();
                    @Override public Optional<Recorded> find(String key) { return Optional.ofNullable(records.get(key)); }
                    @Override public void record(Recorded recorded) { records.put(recorded.dedupKey(), recorded); }
                };
        var coordinator = new MediaObservationPublicationCoordinator(new MediaSemanticObservationProjector(),
                (tenant, artifact, version) -> SourceReadbackAuthority.Decision.ADMITTED,
                observation -> DisclosureReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("receipt-1", "pub-v1");
                }, noClaimOutbox);
        PublishResult result = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        assertThat(result.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(result.receipt()).isEmpty();
        assertThat(publishes.get()).isZero();
    }

    @Test
    void unboundLegacyAndChangedPayloadRecordsFailClosed() {
        MediaDerivedObservation original = observation("tenant-a", "event-7", "artifact-v3");
        String key = MediaObservationPublicationCoordinator.dedupKeyOf(original);
        for (Recorded prior : new Recorded[]{
                new Recorded(key, Outcome.PUBLISHED, "receipt-legacy"),
                new Recorded(key, Outcome.PUBLISHED, "receipt-other", "sha256:" + "0".repeat(64)),
        }) {
            InMemoryOutbox outbox = new InMemoryOutbox();
            outbox.record(prior);
            AtomicInteger publishes = new AtomicInteger();
            var coordinator = coordinator(SourceReadbackAuthority.Decision.ADMITTED,
                    (tenant, projection) -> {
                        publishes.incrementAndGet();
                        return new PublicationReceipt("unexpected", "pub-v1");
                    }, outbox);
            PublishResult result = coordinator.publish(original);
            assertThat(result.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
            assertThat(result.receipt()).isEmpty();
            assertThat(publishes.get()).isZero();
        }

        AtomicInteger mismatchedKeyPublishes = new AtomicInteger();
        MediaObservationPublicationCoordinator.PublicationOutbox mismatchedKeyOutbox =
                new MediaObservationPublicationCoordinator.PublicationOutbox() {
                    @Override public Optional<Recorded> find(String requestedKey) {
                        return Optional.of(new Recorded("different-key", Outcome.PUBLISHED,
                                "receipt-misbound", "sha256:" + "0".repeat(64)));
                    }
                    @Override public void record(Recorded recorded) { }
                };
        var mismatchedKeyCoordinator = new MediaObservationPublicationCoordinator(
                new MediaSemanticObservationProjector(),
                (tenant, artifact, version) -> SourceReadbackAuthority.Decision.ADMITTED,
                observation -> DisclosureReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    mismatchedKeyPublishes.incrementAndGet();
                    return new PublicationReceipt("unexpected", "pub-v1");
                }, mismatchedKeyOutbox);
        assertThat(mismatchedKeyCoordinator.publish(original).outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(mismatchedKeyPublishes.get()).isZero();

        InMemoryOutbox outbox = new InMemoryOutbox();
        AtomicInteger publishes = new AtomicInteger();
        var coordinator = coordinator(SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("receipt-1", "pub-v1");
                }, outbox);
        coordinator.publish(original);
        MediaDerivedObservation changedPayload = new MediaDerivedObservation(
                "tenant-a", "tenant-a", "artifact-9", "artifact-v3", "artifact-v3",
                "observation-3", "scene-label", "different-redacted-value",
                OBSERVED_AT, OBSERVED_AT.plusSeconds(1), "vision-runtime", "event-7",
                "clip-model", "clip-model-v7", "policy-redaction-2",
                "privacy-service", "consent-4", "owner-1", "steward-1",
                "CONFIDENTIAL", "CONFIDENTIAL", List.of("incident-investigation"),
                "eu", Optional.of("retention-media-30d"), 91, "verified");
        PublishResult changedReplay = coordinator.publish(changedPayload);
        assertThat(changedReplay.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(changedReplay.receipt()).isEmpty();
        MediaDerivedObservation changedArtifact = new MediaDerivedObservation(
                "tenant-a", "tenant-a", "artifact-other", "artifact-v3", "artifact-v3",
                "observation-3", "scene-label", "loading-dock",
                OBSERVED_AT, OBSERVED_AT.plusSeconds(1), "vision-runtime", "event-7",
                "clip-model", "clip-model-v7", "policy-redaction-2",
                "privacy-service", "consent-4", "owner-1", "steward-1",
                "CONFIDENTIAL", "CONFIDENTIAL", List.of("incident-investigation"),
                "eu", Optional.of("retention-media-30d"), 91, "verified");
        assertThat(coordinator.publish(changedArtifact).outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(publishes.get()).isEqualTo(1);
    }

    @Test
    void legacyKeyFoundDuringAtomicClaimFailsClosed() {
        MediaDerivedObservation source = observation("tenant-a", "event-7", "artifact-v3");
        String legacyKey = MediaObservationPublicationCoordinator.legacyDedupKeyOf(source);
        InMemoryOutbox outbox = new InMemoryOutbox();
        outbox.record(new Recorded(legacyKey, Outcome.PUBLISHED, "legacy-receipt"));
        AtomicInteger publishes = new AtomicInteger();
        var coordinator = coordinator(SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("new-receipt", "pub-v1");
                }, outbox);
        PublishResult result = coordinator.publish(source);
        assertThat(result.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(result.receipt()).isEmpty();
        assertThat(publishes.get()).isZero();
    }

    @Test
    void publishedReplayRequiresARecordedReceiptId() {
        MediaDerivedObservation source = observation("tenant-a", "event-7", "artifact-v3");
        InMemoryOutbox seed = new InMemoryOutbox();
        var writer = coordinator(SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> new PublicationReceipt("receipt-1", "pub-v1"), seed);
        PublishResult published = writer.publish(source);
        Recorded bound = seed.find(published.dedupKey()).orElseThrow();
        InMemoryOutbox malformed = new InMemoryOutbox();
        malformed.record(new Recorded(bound.dedupKey(), Outcome.PUBLISHED, " ", bound.bindingFingerprint()));
        AtomicInteger publishes = new AtomicInteger();
        var reader = coordinator(SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("unexpected", "pub-v1");
                }, malformed);
        PublishResult result = reader.publish(source);
        assertThat(result.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(result.receipt()).isEmpty();
        assertThat(publishes.get()).isZero();
    }

    @Test
    void distinctMalformedUnicodeCodeUnitsCannotCollideInTheBindingFingerprint() {
        MediaDerivedObservation first = new MediaDerivedObservation(
                "tenant-a", "tenant-a", "artifact-9", "artifact-v3", "artifact-v3",
                "\uD800", "scene-label", "loading-dock", OBSERVED_AT, OBSERVED_AT.plusSeconds(1),
                "vision-runtime", "event-7", "clip-model", "clip-model-v7", "policy-redaction-2",
                "privacy-service", "consent-4", "owner-1", "steward-1", "CONFIDENTIAL", "CONFIDENTIAL",
                List.of("incident-investigation"), "eu", Optional.of("retention-media-30d"), 91, "verified");
        MediaDerivedObservation second = new MediaDerivedObservation(
                "tenant-a", "tenant-a", "artifact-9", "artifact-v3", "artifact-v3",
                "\uD801", "scene-label", "loading-dock", OBSERVED_AT, OBSERVED_AT.plusSeconds(1),
                "vision-runtime", "event-7", "clip-model", "clip-model-v7", "policy-redaction-2",
                "privacy-service", "consent-4", "owner-1", "steward-1", "CONFIDENTIAL", "CONFIDENTIAL",
                List.of("incident-investigation"), "eu", Optional.of("retention-media-30d"), 91, "verified");
        InMemoryOutbox outbox = new InMemoryOutbox();
        AtomicInteger publishes = new AtomicInteger();
        var coordinator = coordinator(SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("receipt-1", "pub-v1");
                }, outbox);
        assertThat(coordinator.publish(first).outcome()).isEqualTo(Outcome.PUBLISHED);
        assertThat(coordinator.publish(second).outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(publishes.get()).isEqualTo(1);
    }

    @Test
    void rejectsMismatchedAtomicClaimBindingBeforeDispatch() {
        MediaObservationPublicationCoordinator.PublicationOutbox mismatchedClaim =
                new MediaObservationPublicationCoordinator.PublicationOutbox() {
                    @Override public Optional<Recorded> find(String key) { return Optional.empty(); }
                    @Override public ClaimResult claim(String key, String legacyKey, String fingerprint) {
                        return new ClaimResult(ClaimStatus.ACQUIRED, Optional.empty(), "sha256:" + "0".repeat(64));
                    }
                    @Override public void record(Recorded recorded) { }
                };
        AtomicInteger publishes = new AtomicInteger();
        var coordinator = new MediaObservationPublicationCoordinator(new MediaSemanticObservationProjector(),
                (tenant, artifact, version) -> SourceReadbackAuthority.Decision.ADMITTED,
                observation -> DisclosureReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    publishes.incrementAndGet();
                    return new PublicationReceipt("receipt-1", "pub-v1");
                }, mismatchedClaim);
        PublishResult result = coordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        assertThat(result.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(publishes.get()).isZero();
    }

    @Test
    void simultaneousCoordinatorsSharingTheOutboxAcquireOnlyOneDispatchClaim() throws Exception {
        InMemoryOutbox outbox = new InMemoryOutbox();
        CountDownLatch destinationEntries = new CountDownLatch(2);
        AtomicInteger publishes = new AtomicInteger();
        CountDownLatch authorities = new CountDownLatch(2);
        SourceReadbackAuthority authority = (tenant, artifact, version) -> {
            authorities.countDown();
            try {
                if (!authorities.await(2, TimeUnit.SECONDS)) return SourceReadbackAuthority.Decision.UNAVAILABLE;
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return SourceReadbackAuthority.Decision.UNAVAILABLE;
            }
            return SourceReadbackAuthority.Decision.ADMITTED;
        };
        var destination = (MediaObservationPublicationCoordinator.PublicationClient) (tenant, projection) -> {
            publishes.incrementAndGet();
            destinationEntries.countDown();
            try {
                destinationEntries.await(300, TimeUnit.MILLISECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new PublicationAmbiguousException("interrupted", interrupted);
            }
            return new PublicationReceipt("receipt-1", "pub-v1");
        };
        var first = new MediaObservationPublicationCoordinator(new MediaSemanticObservationProjector(), authority,
                observation -> DisclosureReadbackAuthority.Decision.ADMITTED, destination, outbox);
        var second = new MediaObservationPublicationCoordinator(new MediaSemanticObservationProjector(), authority,
                observation -> DisclosureReadbackAuthority.Decision.ADMITTED, destination, outbox);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<PublishResult> a = workers.submit(() -> first.publish(observation("tenant-a", "event-7", "artifact-v3")));
            Future<PublishResult> b = workers.submit(() -> second.publish(observation("tenant-a", "event-7", "artifact-v3")));
            assertThat(a.get(3, TimeUnit.SECONDS).outcome()).isIn(Outcome.PUBLISHED, Outcome.OUTCOME_UNKNOWN);
            assertThat(b.get(3, TimeUnit.SECONDS).outcome()).isIn(Outcome.PUBLISHED, Outcome.OUTCOME_UNKNOWN);
        } finally {
            workers.shutdownNow();
        }
        assertThat(publishes.get()).isEqualTo(1);
    }

    @Test
    void missingReceiptAndLostFinalizationNeverTriggerAnotherDispatch() {
        InMemoryOutbox missingReceiptOutbox = new InMemoryOutbox();
        AtomicInteger missingReceiptPublishes = new AtomicInteger();
        var missingReceiptCoordinator = coordinator(SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> { missingReceiptPublishes.incrementAndGet(); return null; },
                missingReceiptOutbox);
        PublishResult noReceipt = missingReceiptCoordinator.publish(observation("tenant-a", "event-7", "artifact-v3"));
        assertThat(noReceipt.outcome()).isEqualTo(Outcome.OUTCOME_UNKNOWN);
        assertThat(missingReceiptCoordinator.publish(observation("tenant-a", "event-7", "artifact-v3")).outcome())
                .isEqualTo(Outcome.OUTCOME_UNKNOWN);
        assertThat(missingReceiptPublishes.get()).isEqualTo(1);

        InMemoryOutbox failedWriteOutbox = new InMemoryOutbox();
        failedWriteOutbox.failNextRecords(1);
        AtomicInteger successfulDispatches = new AtomicInteger();
        var lostFinalityCoordinator = coordinator(SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    successfulDispatches.incrementAndGet();
                    return new PublicationReceipt("receipt-2", "pub-v2");
                }, failedWriteOutbox);
        PublishResult lostFinality = lostFinalityCoordinator.publish(observation("tenant-a", "event-8", "artifact-v3"));
        assertThat(lostFinality.outcome()).isEqualTo(Outcome.OUTCOME_UNKNOWN);
        assertThat(lostFinalityCoordinator.publish(observation("tenant-a", "event-8", "artifact-v3")).outcome())
                .isEqualTo(Outcome.OUTCOME_UNKNOWN);
        assertThat(successfulDispatches.get()).isEqualTo(1);

        InMemoryOutbox unresolvedOutbox = new InMemoryOutbox();
        unresolvedOutbox.failNextRecords(2); // PUBLISHED and fallback UNKNOWN both fail; durable claim remains held.
        AtomicInteger unresolvedDispatches = new AtomicInteger();
        var unresolvedCoordinator = coordinator(SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    unresolvedDispatches.incrementAndGet();
                    return new PublicationReceipt("receipt-3", "pub-v3");
                }, unresolvedOutbox);
        PublishResult firstAttempt = unresolvedCoordinator.publish(observation("tenant-a", "event-9", "artifact-v3"));
        PublishResult blockedReplay = unresolvedCoordinator.publish(observation("tenant-a", "event-9", "artifact-v3"));
        assertThat(firstAttempt.outcome()).isEqualTo(Outcome.OUTCOME_UNKNOWN);
        assertThat(blockedReplay.outcome()).isEqualTo(Outcome.OUTCOME_UNKNOWN);
        assertThat(unresolvedDispatches.get()).isEqualTo(1);

        InMemoryOutbox lostAckOutbox = new InMemoryOutbox();
        lostAckOutbox.failAfterNextWrites(1);
        AtomicInteger lostAckDispatches = new AtomicInteger();
        var lostAckCoordinator = coordinator(SourceReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    lostAckDispatches.incrementAndGet();
                    return new PublicationReceipt("receipt-4", "pub-v4");
                }, lostAckOutbox);
        PublishResult writeAckLost = lostAckCoordinator.publish(observation("tenant-a", "event-10", "artifact-v3"));
        assertThat(writeAckLost.outcome()).isEqualTo(Outcome.PUBLISHED);
        assertThat(writeAckLost.receipt()).contains(new PublicationReceipt("receipt-4", "pub-v4"));
        assertThat(lostAckDispatches.get()).isEqualTo(1);
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
