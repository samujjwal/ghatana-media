package com.ghatana.audio.video.multimodal.datacloud;

import com.ghatana.datacloud.semantic.OperationalSemanticContext;

import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

import static com.ghatana.datacloud.semantic.OperationalSemanticContext.*;

/**
 * Projects a Media-owned derived observation into the Data Cloud semantic contract.
 *
 * <p>The projection retains the source artifact/event and consent references. It does not make
 * Media the semantic authority and does not project raw audio, video, or transcript payloads.
 *
 * @doc.type class
 * @doc.purpose Project governed media observations with source and consent provenance
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class MediaSemanticObservationProjector {
    public OperationalSemanticContext.SemanticObject project(MediaDerivedObservation observation) {
        Objects.requireNonNull(observation, "observation");
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
        Provenance provenance = new Provenance(
                "media",
                observation.sourceSystem(),
                observation.observedAt(),
                List.of(source, consent));
        EffectivePeriod effective = new EffectivePeriod(
                observation.observedAt(),
                Optional.empty(),
                observation.recordedAt());
        ResourceId id = new ResourceId("media", "derived-observation", observation.observationId());
        Fact fact = new Fact(
                observation.observationType(),
                new TextValue(observation.value()),
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
                List.of(source, consent),
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
                        new TextValue(observation.value()),
                        observation.observedAt(),
                        provenance)),
                List.of(
                        source,
                        consent,
                        new Reference(
                                ReferenceKind.EVIDENCE,
                                "media",
                                observation.artifactId(),
                                Optional.empty())),
                List.of());
    }

    public record MediaDerivedObservation(
            String tenantId,
            String artifactId,
            String observationId,
            String observationType,
            String value,
            Instant observedAt,
            Instant recordedAt,
            String sourceSystem,
            String sourceEventId,
            String consentOwnerService,
            String consentRef,
            String ownerId,
            String stewardId,
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
