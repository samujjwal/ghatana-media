package com.ghatana.audio.video.multimodal.datacloud;

import com.ghatana.audio.video.multimodal.datacloud.MediaSemanticObservationProjector.MediaDerivedObservation;
import com.ghatana.datacloud.semantic.OperationalSemanticContext;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.function.Consumer;

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
                .hasMessage("redactionDecisionRef is required and bounded");
    }

    @Test
    void rejectsMalformedRequiredCandidateFieldsBeforeCreatingSemanticObjects() {
        assertCandidateRejected(builder -> builder.artifactId = " ", "artifactId is required and bounded");
        assertCandidateRejected(builder -> builder.observationId = "x".repeat(513),
                "observationId is required and bounded");
        assertCandidateRejected(builder -> builder.observationType = "scene label",
                "observationType must be a token");
        assertCandidateRejected(builder -> builder.sourceSystem = " ",
                "sourceSystem is required and bounded");
        assertCandidateRejected(builder -> builder.providerId = "provider/id",
                "providerId must be a token");
        assertCandidateRejected(builder -> builder.ownerId = null,
                "ownerId is required and bounded");
        assertCandidateRejected(builder -> builder.stewardId = "steward id",
                "stewardId must be a token");
        assertCandidateRejected(builder -> builder.residency = " ",
                "residency is required and bounded");
    }

    @Test
    void rejectsPaddedOpaqueVersionReferencesInsteadOfNormalizingThem() {
        assertCandidateRejected(builder -> builder.requestedArtifactVersionId = " artifact-v3",
                "requestedArtifactVersionId must not have surrounding whitespace");
        assertCandidateRejected(builder -> builder.sourceArtifactVersionId = "artifact-v3 ",
                "sourceArtifactVersionId must not have surrounding whitespace");
    }

    @Test
    void requiresBoundedNonEmptyPurposesAndContractRangeQualityScore() {
        assertCandidateRejected(builder -> builder.permittedPurposes = null,
                "permittedPurposes must contain 1..256 bounded tokens");
        assertCandidateRejected(builder -> builder.permittedPurposes = List.of(),
                "permittedPurposes must contain 1..256 bounded tokens");
        assertCandidateRejected(builder -> builder.permittedPurposes = List.of(" "),
                "permittedPurposes is required and bounded");
        assertCandidateRejected(builder -> builder.permittedPurposes = java.util.stream.IntStream.range(0, 257)
                        .mapToObj(index -> "purpose-" + index).toList(),
                "permittedPurposes must contain 1..256 bounded tokens");
        assertCandidateRejected(builder -> builder.qualityScore = -1, "qualityScore must be 0..100");
        assertCandidateRejected(builder -> builder.qualityScore = 101, "qualityScore must be 0..100");

        ObservationBuilder minimum = new ObservationBuilder();
        minimum.qualityScore = 0;
        ObservationBuilder maximum = new ObservationBuilder();
        maximum.qualityScore = 100;
        maximum.recordedAt = OBSERVED_AT;
        assertThat(new MediaSemanticObservationProjector().project(minimum.build()).trust().qualityScore()).isZero();
        assertThat(new MediaSemanticObservationProjector().project(maximum.build()).trust().qualityScore())
                .isEqualTo(100);
    }

    @Test
    void recordedTimeCannotPrecedeObservationButEqualInstantsAreValid() {
        ObservationBuilder before = new ObservationBuilder();
        before.recordedAt = OBSERVED_AT.minusNanos(1);
        assertThatThrownBy(before::build)
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("recordedAt must not be before observedAt");

        ObservationBuilder equal = new ObservationBuilder();
        equal.recordedAt = OBSERVED_AT;
        assertThat(new MediaSemanticObservationProjector().project(equal.build()).effectivePeriod().recordedAt())
                .isEqualTo(OBSERVED_AT);
    }

    private static void assertCandidateRejected(Consumer<ObservationBuilder> mutation, String message) {
        ObservationBuilder builder = new ObservationBuilder();
        mutation.accept(builder);
        assertThatThrownBy(builder::build)
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage(message);
    }

    private static MediaDerivedObservation observation(String tenantId, String sourceTenantId,
            String requestedVersion, String sourceVersion, String sourceClassification,
            String classification, String redactionDecisionRef) {
        ObservationBuilder builder = new ObservationBuilder();
        builder.tenantId = tenantId;
        builder.sourceTenantId = sourceTenantId;
        builder.requestedArtifactVersionId = requestedVersion;
        builder.sourceArtifactVersionId = sourceVersion;
        builder.sourceClassification = sourceClassification;
        builder.classification = classification;
        builder.redactionDecisionRef = redactionDecisionRef;
        return builder.build();
    }

    private static final class ObservationBuilder {
        private String tenantId = "tenant-a";
        private String sourceTenantId = "tenant-a";
        private String artifactId = "artifact-9";
        private String requestedArtifactVersionId = "artifact-v3";
        private String sourceArtifactVersionId = "artifact-v3";
        private String observationId = "observation-3";
        private String observationType = "scene-label";
        private String redactedValue = "loading-dock";
        private Instant observedAt = OBSERVED_AT;
        private Instant recordedAt = OBSERVED_AT.plusSeconds(1);
        private String sourceSystem = "vision-runtime";
        private String sourceEventId = "event-7";
        private String providerId = "clip-model";
        private String providerVersion = "clip-model-v7";
        private String redactionDecisionRef = "policy-redaction-2";
        private String consentOwnerService = "privacy-service";
        private String consentRef = "consent-4";
        private String ownerId = "owner-1";
        private String stewardId = "steward-1";
        private String sourceClassification = "CONFIDENTIAL";
        private String classification = "CONFIDENTIAL";
        private List<String> permittedPurposes = List.of("incident-investigation");
        private String residency = "eu";
        private Optional<String> retentionPolicyRef = Optional.of("retention-media-30d");
        private int qualityScore = 91;
        private String trustGrade = "verified";

        private MediaDerivedObservation build() {
            return new MediaDerivedObservation(tenantId, sourceTenantId, artifactId, requestedArtifactVersionId,
                    sourceArtifactVersionId, observationId, observationType, redactedValue, observedAt, recordedAt,
                    sourceSystem, sourceEventId, providerId, providerVersion, redactionDecisionRef,
                    consentOwnerService, consentRef, ownerId, stewardId, sourceClassification, classification,
                    permittedPurposes, residency, retentionPolicyRef, qualityScore, trustGrade);
        }
    }
}
