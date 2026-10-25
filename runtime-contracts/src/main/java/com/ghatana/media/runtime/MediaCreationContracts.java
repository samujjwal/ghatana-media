package com.ghatana.media.runtime;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/** Local contracts for Media creation and source-derived composition staging.
 *
 * <p>These records validate intent and immutable references only. They do not run an engine,
 * create media bytes, admit a provider, or deliver an output.</p>
 */
public final class MediaCreationContracts {
    private MediaCreationContracts() { }

    public enum Lane { SOURCE_FREE_CREATION, SOURCE_DERIVED_COMPOSITION }
    public enum Admission { ADMITTED, NOT_ADMITTED }
    public enum ProvenanceMode { CREATIVE, PRESERVE }
    public enum DeliveryOutcome { NOT_REQUESTED, KNOWN, UNKNOWN }

    /** A concrete provider/profile identity qualified for this lane by its owner. */
    public record QualifiedProfile(String providerId, String providerVersion, String profileId) {
        public QualifiedProfile {
            providerId = required(providerId, "providerId");
            providerVersion = required(providerVersion, "providerVersion");
            profileId = required(profileId, "profileId");
        }
    }

    /** Exact immutable source pin; source-free plans must omit it. */
    public record SourceVersion(String artifactId, String version) {
        public SourceVersion {
            artifactId = required(artifactId, "artifactId");
            version = required(version, "version");
            if (!version.matches("sha256:[0-9a-f]{64}")) {
                throw new IllegalArgumentException("source version must be sha256:<64 lowercase hex>");
            }
        }
    }

    /** Immutable plan declaration with distinct lane and provenance semantics. */
    public record Specification(
            String specificationId,
            String planId,
            Lane lane,
            String specificationVersion,
            SourceVersion source,
            ProvenanceMode provenanceMode,
            String purpose,
            String qualityRulesId) {
        public Specification {
            specificationId = required(specificationId, "specificationId");
            planId = required(planId, "planId");
            lane = Objects.requireNonNull(lane, "lane");
            specificationVersion = required(specificationVersion, "specificationVersion");
            provenanceMode = Objects.requireNonNull(provenanceMode, "provenanceMode");
            purpose = required(purpose, "purpose");
            qualityRulesId = required(qualityRulesId, "qualityRulesId");
            if (lane == Lane.SOURCE_FREE_CREATION && source != null) {
                throw new IllegalArgumentException("source-free creation must not reference source media");
            }
            if (lane == Lane.SOURCE_DERIVED_COMPOSITION && source == null) {
                throw new IllegalArgumentException("source-derived composition requires an exact source version");
            }
        }
    }

    /** Run decision. A missing qualified profile is represented as NOT_ADMITTED, never a fake result. */
    public record RunDecision(String runId, Specification specification, Admission admission,
                              Optional<QualifiedProfile> profile, String reason) {
        public RunDecision {
            runId = required(runId, "runId");
            specification = Objects.requireNonNull(specification, "specification");
            admission = Objects.requireNonNull(admission, "admission");
            profile = profile == null ? Optional.empty() : profile;
            reason = reason == null ? "" : reason.trim();
            if (admission == Admission.ADMITTED && profile.isEmpty()) {
                throw new IllegalArgumentException("admitted run requires one qualified provider profile");
            }
            if (admission == Admission.NOT_ADMITTED && (profile.isPresent() || reason.isBlank())) {
                throw new IllegalArgumentException("not-admitted run requires a reason and no provider profile");
            }
        }

        public static RunDecision withoutQualifiedProvider(String runId, Specification specification) {
            return new RunDecision(runId, specification, Admission.NOT_ADMITTED, Optional.empty(),
                    "NO_QUALIFIED_PROVIDER_PROFILE");
        }
    }

    /** Immutable registered output metadata; the verified factory computes its digest from bytes. */
    public record Output(String outputId, String runId, String specificationId, String planId,
                         String digest, String mediaType, List<String> provenanceRefs,
                         Optional<SourceVersion> source, QualifiedProfile profile) {
        public Output {
            outputId = required(outputId, "outputId");
            runId = required(runId, "runId");
            specificationId = required(specificationId, "specificationId");
            planId = required(planId, "planId");
            digest = required(digest, "digest");
            if (!digest.matches("sha256:[0-9a-f]{64}")) {
                throw new IllegalArgumentException("output digest must be sha256:<64 lowercase hex>");
            }
            mediaType = required(mediaType, "mediaType");
            profile = Objects.requireNonNull(profile, "profile");
            provenanceRefs = List.copyOf(provenanceRefs == null ? List.of() : provenanceRefs);
            if (provenanceRefs.isEmpty() || provenanceRefs.stream().anyMatch(String::isBlank)) {
                throw new IllegalArgumentException("output requires non-empty provenance references");
            }
            source = source == null ? Optional.empty() : source;
            if (source.isPresent() && outputId.equals(source.get().artifactId())) {
                throw new IllegalArgumentException("derived output must use a new artifact identity; source is immutable");
            }
            if (source.isPresent() && (!provenanceRefs.contains(source.get().artifactId())
                    || !provenanceRefs.contains(source.get().version()))) {
                throw new IllegalArgumentException("derived output provenance must retain exact source identity and version");
            }
        }

        public static Output verified(String outputId, RunDecision run, byte[] outputBytes, String mediaType,
                                      List<String> provenanceRefs) {
            Objects.requireNonNull(run, "run");
            if (run.admission() != Admission.ADMITTED) {
                throw new IllegalStateException("output cannot be registered for a non-admitted run");
            }
            Objects.requireNonNull(outputBytes, "outputBytes");
            Specification spec = run.specification();
            QualifiedProfile profile = run.profile().orElseThrow();
            List<String> refs = new java.util.ArrayList<>(provenanceRefs == null ? List.of() : provenanceRefs);
            refs.add("urn:ghatana:media-provider:" + profile.providerId() + ":"
                    + profile.providerVersion() + ":profile:" + profile.profileId());
            return new Output(outputId, run.runId(), spec.specificationId(), spec.planId(),
                    sha256(outputBytes), mediaType, refs, Optional.ofNullable(spec.source()), profile);
        }

        public boolean preservesSource() {
            return source.isEmpty() || provenanceRefs.contains(source.get().artifactId())
                    && provenanceRefs.contains(source.get().version());
        }

        public boolean verifiesBytes(byte[] bytes) {
            return digest.equals(sha256(bytes));
        }
    }

    /** Delivery is a distinct destination-side effect and is never implied by output registration. */
    public record DestinationEffect(String effectId, String outputId, String destinationId,
                                    DeliveryOutcome outcome, String receiptRef) {
        public DestinationEffect {
            effectId = required(effectId, "effectId");
            outputId = required(outputId, "outputId");
            destinationId = required(destinationId, "destinationId");
            outcome = Objects.requireNonNull(outcome, "outcome");
            receiptRef = receiptRef == null ? "" : receiptRef.trim();
            if (outcome == DeliveryOutcome.KNOWN && receiptRef.isBlank()) {
                throw new IllegalArgumentException("known delivery requires a destination receipt reference");
            }
            if (outcome != DeliveryOutcome.KNOWN && !receiptRef.isBlank()) {
                throw new IllegalArgumentException("only known delivery may carry a destination receipt");
            }
        }
    }

    public static String sha256(byte[] bytes) {
        Objects.requireNonNull(bytes, "bytes");
        try {
            return "sha256:" + HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private static String required(String value, String name) {
        Objects.requireNonNull(value, name);
        String normalized = value.trim();
        if (normalized.isEmpty()) throw new IllegalArgumentException(name + " must not be blank");
        return normalized;
    }
}
