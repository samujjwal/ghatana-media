package com.ghatana.audio.video.multimodal.datacloud;

import com.ghatana.datacloud.semantic.OperationalSemanticContext;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

class MediaSemanticObservationProjectorTest {
    @Test
    void preservesSourceAndConsentProvenanceWithoutProjectingRawMedia() {
        Instant observedAt = Instant.parse("2026-08-01T12:00:00Z");
        var observation = new MediaSemanticObservationProjector.MediaDerivedObservation(
                "tenant-a",
                "artifact-9",
                "observation-3",
                "scene-label",
                "loading-dock",
                observedAt,
                observedAt.plusSeconds(1),
                "vision-runtime",
                "event-7",
                "privacy-service",
                "consent-4",
                "owner-1",
                "steward-1",
                "confidential",
                List.of("incident-investigation"),
                "eu",
                Optional.of("retention-media-30d"),
                91,
                "verified");

        OperationalSemanticContext.SemanticObject projected =
                new MediaSemanticObservationProjector().project(observation);

        assertThat(projected.tenantId()).isEqualTo("tenant-a");
        assertThat(projected.governance().consentRefs()).containsExactly("consent-4");
        assertThat(projected.references()).extracting(OperationalSemanticContext.Reference::kind)
                .containsExactly(
                        OperationalSemanticContext.ReferenceKind.EVIDENCE,
                        OperationalSemanticContext.ReferenceKind.CONSENT,
                        OperationalSemanticContext.ReferenceKind.EVENT);
        assertThat(projected.facts()).singleElement().satisfies(fact -> {
            assertThat(fact.provenance().sourceSystem()).isEqualTo("vision-runtime");
            assertThat(fact.provenance().evidence())
                    .extracting(OperationalSemanticContext.Reference::id)
                    .containsExactly("consent-4", "event-7");
        });
        assertThat(projected.references()).allSatisfy(reference ->
                assertThat(reference.id()).doesNotContain("raw-audio", "raw-video"));
    }
}
