package com.ghatana.audio.video.multimodal.datacloud;

import com.ghatana.datacloud.entity.media.Classification;
import com.ghatana.datacloud.semantic.OperationalSemanticContext;

import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

import static com.ghatana.datacloud.semantic.OperationalSemanticContext.*;

/**
 * Projects a Media-owned derived observation into the Data Cloud semantic contract.
 *
 * <p>The projection retains immutable source and provider versions, privacy classification,
 * consent and redaction decision provenance. It does not make Media the semantic authority and
 * does not project raw media payloads.
 */
public final class MediaSemanticObservationProjector {
    /**
     * Format a local projection candidate. This method validates field consistency but does not
     * authenticate source, consent, provider, or redaction references and does not authorize publication.
     */
    public OperationalSemanticContext.SemanticObject project(MediaDerivedObservation observation) {
        Objects.requireNonNull(observation, "observation");
        requireSameTenant(observation.tenantId(), observation.sourceTenantId());
        requireExactVersion(observation.requestedArtifactVersionId(), observation.sourceArtifactVersionId());
        requireClassificationFloor(observation.sourceClassification(), observation.classification());
        requireRedactionEvidence(observation.redactionDecisionRef());

        Reference source = new Reference(
                ReferenceKind.EVENT,
                "media",
                observation.sourceEventId(),
                Optional.empty());
        Reference consent = new Reference(
                ReferenceKind.CONSENT,
                observation.consentOwnerService(),
                observation.consentRef(),
                Optional.empty());
        Reference sourceArtifact = new Reference(
                ReferenceKind.EVIDENCE,
                "media",
                observation.artifactId(),
                Optional.empty());
        Reference sourceVersion = new Reference(
                ReferenceKind.LINEAGE,
                "media",
                observation.sourceArtifactVersionId(),
                Optional.empty());
        Reference providerVersion = new Reference(
                ReferenceKind.LINEAGE,
                observation.providerId(),
                observation.providerVersion(),
                Optional.empty());
        Reference redactionPolicy = new Reference(
                ReferenceKind.POLICY,
                "media",
                observation.redactionDecisionRef(),
                Optional.empty());

        List<Reference> evidence = List.of(source, consent, sourceArtifact, sourceVersion,
                providerVersion, redactionPolicy);
        Provenance provenance = new Provenance(
                "media",
                observation.sourceSystem(),
                observation.observedAt(),
                evidence);
        EffectivePeriod effective = new EffectivePeriod(
                observation.observedAt(),
                Optional.empty(),
                observation.recordedAt());
        ResourceId id = new ResourceId("media", "derived-observation", observation.observationId());
        Fact fact = new Fact(
                observation.observationType(),
                new TextValue(observation.redactedValue()),
                effective,
                provenance);
        Governance governance = new Governance(
                List.of(observation.ownerId()),
                List.of(observation.stewardId()),
                observation.classification(),
                observation.permittedPurposes(),
                List.of(observation.residency()),
                List.of(observation.consentRef()),
                observation.retentionPolicyRef(),
                List.of());
        Trust trust = new Trust(
                observation.qualityScore(),
                observation.observedAt(),
                evidence,
                observation.trustGrade());
        return new SemanticObject(
                observation.tenantId(),
                id,
                new SemanticType("media", "derived-observation", "1.0.0"),
                1,
                effective,
                List.of(fact),
                governance,
                trust,
                List.of(new DerivedSignal(
                        observation.observationId(),
                        observation.observationType(),
                        new TextValue(observation.redactedValue()),
                        observation.observedAt(),
                        provenance)),
                evidence,
                List.of());
    }

    private static void requireSameTenant(String projectionTenant, String sourceTenant) {
        if (projectionTenant == null || projectionTenant.isBlank()
                || sourceTenant == null || sourceTenant.isBlank()
                || !projectionTenant.equals(sourceTenant)) {
            throw new IllegalArgumentException("Source and projection tenant must match");
        }
    }

    private static void requireExactVersion(String requestedVersion, String sourceVersion) {
        if (requestedVersion == null || requestedVersion.isBlank()
                || sourceVersion == null || sourceVersion.isBlank()
                || !requestedVersion.equals(sourceVersion)) {
            throw new IllegalArgumentException("Observation source version is missing or stale");
        }
    }

    private static void requireClassificationFloor(String sourceClassification, String classification) {
        if (sourceClassification == null || classification == null
                || !sourceClassification.equals(classification)) {
            throw new IllegalArgumentException("Derived classification must preserve the source classification floor");
        }
        final Classification parsed;
        try {
            parsed = Classification.valueOf(classification.toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException invalidClassification) {
            throw new IllegalArgumentException("Observation classification is not in the Data Cloud media vocabulary",
                    invalidClassification);
        }
        if (parsed == Classification.RESTRICTED) {
            throw new IllegalArgumentException("Restricted observations cannot be projected without an admitted disclosure path");
        }
    }

    private static void requireRedactionEvidence(String redactionDecisionRef) {
        if (redactionDecisionRef == null || redactionDecisionRef.isBlank()) {
            throw new IllegalArgumentException("A redaction decision reference is required");
        }
    }

    public record MediaDerivedObservation(
            String tenantId,
            String sourceTenantId,
            String artifactId,
            String requestedArtifactVersionId,
            String sourceArtifactVersionId,
            String observationId,
            String observationType,
            String redactedValue,
            Instant observedAt,
            Instant recordedAt,
            String sourceSystem,
            String sourceEventId,
            String providerId,
            String providerVersion,
            String redactionDecisionRef,
            String consentOwnerService,
            String consentRef,
            String ownerId,
            String stewardId,
            String sourceClassification,
            String classification,
            List<String> permittedPurposes,
            String residency,
            Optional<String> retentionPolicyRef,
            int qualityScore,
            String trustGrade) {
        public MediaDerivedObservation {
            observedAt = Objects.requireNonNull(observedAt, "observedAt");
            recordedAt = Objects.requireNonNull(recordedAt, "recordedAt");
            permittedPurposes = List.copyOf(permittedPurposes);
            retentionPolicyRef = retentionPolicyRef == null ? Optional.empty() : retentionPolicyRef;
        }
    }
}
