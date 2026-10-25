package com.ghatana.audio.video.multimodal.datacloud;

import com.ghatana.audio.video.multimodal.datacloud.MediaSemanticObservationProjector.MediaDerivedObservation;
import com.ghatana.datacloud.semantic.OperationalSemanticContext;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaSemanticObservationProjectorTest {
    private static final Instant OBSERVED_AT = Instant.parse("2026-08-01T12:00:00Z");

    @Test
    void bindsSourceProviderVersionConsentClassificationAndRedactionProvenance() {
        OperationalSemanticContext.SemanticObject projected =
                new MediaSemanticObservationProjector().project(observation(
                        "tenant-a", "tenant-a", "artifact-v3", "artifact-v3",
                        "CONFIDENTIAL", "CONFIDENTIAL", "policy-redaction-2"));

        assertThat(projected.tenantId()).isEqualTo("tenant-a");
        assertThat(projected.governance().classification()).isEqualTo("CONFIDENTIAL");
        assertThat(projected.governance().consentRefs()).containsExactly("consent-4");
        assertThat(projected.references()).extracting(OperationalSemanticContext.Reference::id)
                .contains("artifact-9", "artifact-v3", "clip-model-v7", "policy-redaction-2", "consent-4", "event-7");
        assertThat(projected.references()).extracting(OperationalSemanticContext.Reference::kind)
                .contains(OperationalSemanticContext.ReferenceKind.LINEAGE,
                        OperationalSemanticContext.ReferenceKind.POLICY);
        assertThat(projected.facts()).singleElement().satisfies(fact -> {
            assertThat(fact.value()).isEqualTo(new OperationalSemanticContext.TextValue("loading-dock"));
            assertThat(fact.provenance().sourceSystem()).isEqualTo("vision-runtime");
            assertThat(fact.provenance().evidence())
                    .extracting(OperationalSemanticContext.Reference::id)
                    .contains("artifact-v3", "clip-model-v7", "policy-redaction-2", "consent-4", "event-7");
        });
        assertThat(projected.references()).allSatisfy(reference ->
                assertThat(reference.id()).doesNotContain("raw-audio", "raw-video", "private transcript"));
    }

    @Test
    void rejectsCrossTenantAndStaleSourceVersions() {
        assertThatThrownBy(() -> new MediaSemanticObservationProjector().project(observation(
                "tenant-a", "tenant-b", "artifact-v3", "artifact-v3",
                "CONFIDENTIAL", "CONFIDENTIAL", "policy-redaction-2")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Source and projection tenant must match");
        assertThatThrownBy(() -> new MediaSemanticObservationProjector().project(observation(
                "tenant-a", "tenant-a", "artifact-v2", "artifact-v3",
                "CONFIDENTIAL", "CONFIDENTIAL", "policy-redaction-2")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Observation source version is missing or stale");
    }

    @Test
    void rejectsRestrictedUnknownOrDowngradedClassificationAndMissingRedactionEvidence() {
        assertThatThrownBy(() -> new MediaSemanticObservationProjector().project(observation(
                "tenant-a", "tenant-a", "artifact-v3", "artifact-v3",
                "RESTRICTED", "RESTRICTED", "policy-redaction-2")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Restricted observations cannot be projected without an admitted disclosure path");
        assertThatThrownBy(() -> new MediaSemanticObservationProjector().project(observation(
                "tenant-a", "tenant-a", "artifact-v3", "artifact-v3",
                "SENSITIVE", "SENSITIVE", "policy-redaction-2")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Observation classification is not in the Data Cloud media vocabulary");
        assertThatThrownBy(() -> new MediaSemanticObservationProjector().project(observation(
                "tenant-a", "tenant-a", "artifact-v3", "artifact-v3",
                "CONFIDENTIAL", "INTERNAL", "policy-redaction-2")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Derived classification must preserve the source classification floor");
        assertThatThrownBy(() -> new MediaSemanticObservationProjector().project(observation(
                "tenant-a", "tenant-a", "artifact-v3", "artifact-v3",
                "CONFIDENTIAL", "CONFIDENTIAL", " ")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("A redaction decision reference is required");
    }

    private static MediaDerivedObservation observation(String tenantId, String sourceTenantId,
            String requestedVersion, String sourceVersion, String sourceClassification,
            String classification, String redactionDecisionRef) {
        return new MediaDerivedObservation(
                tenantId,
                sourceTenantId,
                "artifact-9",
                requestedVersion,
                sourceVersion,
                "observation-3",
                "scene-label",
                "loading-dock",
                OBSERVED_AT,
                OBSERVED_AT.plusSeconds(1),
                "vision-runtime",
                "event-7",
                "clip-model",
                "clip-model-v7",
                redactionDecisionRef,
                "privacy-service",
                "consent-4",
                "owner-1",
                "steward-1",
                sourceClassification,
                classification,
                List.of("incident-investigation"),
                "eu",
                Optional.of("retention-media-30d"),
                91,
                "verified");
    }
}
