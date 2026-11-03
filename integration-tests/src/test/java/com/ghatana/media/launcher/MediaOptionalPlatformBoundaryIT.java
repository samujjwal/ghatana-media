/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.media.launcher;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.DisclosureReadbackAuthority;
import com.ghatana.audio.video.multimodal.datacloud.MediaObservationPublicationCoordinator.Outcome;
import com.ghatana.audio.video.multimodal.datacloud.MediaSemanticObservationProjector;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder;
import com.ghatana.tools.testing.EventloopTestBase;
import io.activej.promise.Promise;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** IT-04 source-free checks for missing optional platform contracts. */
@Tag("integration")
class MediaOptionalPlatformBoundaryIT extends EventloopTestBase {

    @Test
    void absentDataCloudDurablePublicationContractIsNotAdmittedAndDoesNotDispatch() {
        AtomicInteger destinationCalls = new AtomicInteger();
        var coordinator = new MediaObservationPublicationCoordinator(
                new MediaSemanticObservationProjector(),
                (tenant, artifact, version) -> MediaObservationPublicationCoordinator
                        .SourceReadbackAuthority.Decision.ADMITTED,
                observation -> DisclosureReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    destinationCalls.incrementAndGet();
                    throw new AssertionError("destination cannot run without an admitted durable claim");
                },
                new MediaObservationPublicationCoordinator.PublicationOutbox() {
                    @Override
                    public Optional<MediaObservationPublicationCoordinator.Recorded> find(String dedupKey) {
                        return Optional.empty();
                    }

                    // Deliberately inherit the public contract's default UNAVAILABLE claim.
                    @Override
                    public void record(MediaObservationPublicationCoordinator.Recorded recorded) {
                        throw new AssertionError("cannot record without an acquired durable claim");
                    }
                });

        var result = coordinator.publish(observation());

        assertThat(result.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(result.receipt()).isEmpty();
        assertThat(result.detail()).isEqualTo("durable publication claim is unavailable");
        assertThat(destinationCalls).hasValue(0);
    }

    @Test
    void ambiguousDataCloudReceiptStaysUnknownAndReplayDoesNotClaimCompletion() {
        Map<String, MediaObservationPublicationCoordinator.Recorded> records = new HashMap<>();
        AtomicInteger destinationCalls = new AtomicInteger();
        var coordinator = new MediaObservationPublicationCoordinator(
                new MediaSemanticObservationProjector(),
                (tenant, artifact, version) -> MediaObservationPublicationCoordinator
                        .SourceReadbackAuthority.Decision.ADMITTED,
                observation -> DisclosureReadbackAuthority.Decision.ADMITTED,
                (tenant, projection) -> {
                    destinationCalls.incrementAndGet();
                    throw new MediaObservationPublicationCoordinator.PublicationAmbiguousException(
                            "no destination receipt", null);
                },
                new MediaObservationPublicationCoordinator.PublicationOutbox() {
                    private String claimedBinding;

                    @Override
                    public Optional<MediaObservationPublicationCoordinator.Recorded> find(String dedupKey) {
                        return Optional.ofNullable(records.get(dedupKey));
                    }

                    @Override
                    public MediaObservationPublicationCoordinator.ClaimResult claim(
                            String dedupKey, String legacyDedupKey, String bindingFingerprint) {
                        var recorded = records.get(dedupKey);
                        if (recorded != null) {
                            return new MediaObservationPublicationCoordinator.ClaimResult(
                                    MediaObservationPublicationCoordinator.ClaimStatus.RECORDED,
                                    Optional.of(recorded), recorded.bindingFingerprint());
                        }
                        if (claimedBinding != null) {
                            return new MediaObservationPublicationCoordinator.ClaimResult(
                                    MediaObservationPublicationCoordinator.ClaimStatus.IN_PROGRESS,
                                    Optional.empty(), claimedBinding);
                        }
                        claimedBinding = bindingFingerprint;
                        return new MediaObservationPublicationCoordinator.ClaimResult(
                                MediaObservationPublicationCoordinator.ClaimStatus.ACQUIRED,
                                Optional.empty(), bindingFingerprint);
                    }

                    @Override
                    public void record(MediaObservationPublicationCoordinator.Recorded recorded) {
                        records.put(recorded.dedupKey(), recorded);
                    }
                });

        var first = coordinator.publish(observation());
        var replay = coordinator.publish(observation());

        assertThat(first.outcome()).isEqualTo(Outcome.OUTCOME_UNKNOWN);
        assertThat(first.receipt()).isEmpty();
        assertThat(first.detail()).isEqualTo("publication outcome is unconfirmed; reconciliation is required");
        assertThat(replay.outcome()).isEqualTo(Outcome.OUTCOME_UNKNOWN);
        assertThat(replay.receipt()).isEmpty();
        assertThat(destinationCalls).hasValue(1);
    }

    @Test
    void absentActionPlaneInvocationLedgerReturnsExactUnavailableBeforeToolDispatch() {
        AtomicInteger handlerCalls = new AtomicInteger();
        MediaToolExecutionBinder.InvocationLedger absentOwnerLedger = new MediaToolExecutionBinder.InvocationLedger() {
            @Override public Optional<MediaToolExecutionBinder.LogicalAction> find(String invocationId) {
                return Optional.empty();
            }

            @Override public void record(MediaToolExecutionBinder.LogicalAction action) {
                throw new AssertionError("no local ledger may fabricate an Action Plane completion");
            }
        };
        var binder = new MediaToolExecutionBinder(absentOwnerLedger, (tenant, invocation) -> Optional.empty());
        var envelope = ToolExecutionEnvelope.of("av.speech-to-text", "1.0.0", "caller-agent", null,
                "tenant-it04", ToolActionClass.CALL_EXTERNAL, "1.0", Map.of(
                        "audioSource", Map.of("mediaArtifactId", "synthetic-artifact"),
                        "languageCode", "en-US"));
        var contract = new ToolContract(envelope.toolId(), envelope.toolVersion(), "STT", "test",
                envelope.actionClass(), false, true, Map.of("type", "object"), Map.of("type", "object"),
                Set.of(), ToolTransport.IN_PROCESS, null, Map.of());

        assertThatThrownBy(() -> runPromise(() -> binder.execute((request, toolContract) -> {
            handlerCalls.incrementAndGet();
            return Promise.ofException(new IllegalStateException("tool must not run without the owner ledger"));
        }, envelope, contract)))
                .isInstanceOf(MediaToolExecutionBinder.InvocationClaimUnavailableException.class)
                .hasMessage("durable invocation claim is unavailable");
        assertThat(handlerCalls).hasValue(0);
    }

    @Test
    void absentEventPlaneIsExplicitlyNotReadyAndNeverClaimsProductionEligibility() {
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.disabled()) {
            assertThat(publisher.publisherId()).isEqualTo("disabled");
            assertThat(publisher.ready()).isFalse();
            assertThat(publisher.productionEligible()).isFalse();
        }
    }

    private static MediaSemanticObservationProjector.MediaDerivedObservation observation() {
        Instant observedAt = Instant.parse("2026-11-03T12:00:00Z");
        return new MediaSemanticObservationProjector.MediaDerivedObservation(
                "tenant-it04", "tenant-it04", "artifact-it04", "version-1", "version-1",
                "observation-it04", "scene-label", "redacted-value", observedAt, observedAt,
                "media", "event-it04", "vision-runtime", "model-v1", "redaction-v1",
                "consent-service", "consent-v1", "owner-1", "steward-1", "CONFIDENTIAL",
                "CONFIDENTIAL", java.util.List.of("incident-investigation"), "local",
                Optional.of("retention-v1"), 90, "verified");
    }
}
