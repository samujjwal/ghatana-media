package com.ghatana.media.runtime;

import java.util.List;
import java.util.Objects;

/** Immutable, tenant scoped transcript revision persistence contract. */
public final class MediaTranscriptContracts {
    private MediaTranscriptContracts() { }

    /** Draft contains provider supplied transcript data; this contract never creates STT output. */
    public record TranscriptDraft(
            String tenantId, String principalId, String transcriptId,
            String sourceArtifactId, String sourceVersion, String sourceSha256,
            String jobId, String profileId, String providerId, String modelId,
            String language, String timebase, String text,
            String consentDecisionId, String rightsDecisionId, String policyVersion) {
        public TranscriptDraft {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            transcriptId = required(transcriptId, "transcriptId");
            sourceArtifactId = required(sourceArtifactId, "sourceArtifactId");
            sourceVersion = required(sourceVersion, "sourceVersion");
            sourceSha256 = required(sourceSha256, "sourceSha256").toLowerCase(java.util.Locale.ROOT);
            if (!sourceSha256.matches("[0-9a-f]{64}") || !sourceVersion.equals("sha256:" + sourceSha256)) {
                throw new IllegalArgumentException("source version and SHA-256 must identify the same bytes");
            }
            jobId = required(jobId, "jobId");
            profileId = required(profileId, "profileId");
            providerId = required(providerId, "providerId");
            modelId = required(modelId, "modelId");
            language = required(language, "language");
            timebase = required(timebase, "timebase");
            text = Objects.requireNonNull(text, "text");
            consentDecisionId = required(consentDecisionId, "consentDecisionId");
            rightsDecisionId = required(rightsDecisionId, "rightsDecisionId");
            policyVersion = required(policyVersion, "policyVersion");
        }
    }

    /** Returned revisions are immutable; every correction is a subsequent number. */
    public record TranscriptRevision(TranscriptDraft draft, int revision, long createdAt, String admissionStatus) {
        public TranscriptRevision {
            draft = Objects.requireNonNull(draft, "draft");
            if (revision < 1) throw new IllegalArgumentException("revision must be positive");
            admissionStatus = required(admissionStatus, "admissionStatus");
        }
    }

    /** Derived operations that must remain fail-closed until their owning evidence exists. */
    public enum TranscriptDerivedCapability {
        FORCED_ALIGNMENT,
        TRANSLATION,
        CAPTION_VERSION_REGISTRATION
    }

    public enum TranscriptCapabilityBlocker {
        QUALIFIED_ENGINE_UNAVAILABLE,
        CANONICAL_TRANSCRIPT_VERSION_UNAVAILABLE,
        AUTHORITATIVE_SOURCE_CLOCK_UNAVAILABLE,
        DERIVED_CONTENT_AUTHORITY_UNAVAILABLE
    }

    public enum TranscriptCapabilityDisposition {
        UNMET_CAPABILITY
    }

    /** Typed no-effect result; it never represents a transcript or caption version. */
    public record TranscriptCapabilityResult(
            TranscriptDerivedCapability capability,
            TranscriptCapabilityDisposition disposition,
            List<TranscriptCapabilityBlocker> blockers,
            boolean effectOccurred) {
        public TranscriptCapabilityResult {
            capability = Objects.requireNonNull(capability, "capability");
            disposition = Objects.requireNonNull(disposition, "disposition");
            blockers = List.copyOf(Objects.requireNonNull(blockers, "blockers"));
            if (blockers.isEmpty() || effectOccurred) {
                throw new IllegalArgumentException("Unavailable transcript capabilities must report typed no-effect");
            }
        }
    }

    /** A transcript revision changed after the writer's expected latest revision was observed. */
    public static final class TranscriptRevisionConflictException extends IllegalStateException {
        private static final long serialVersionUID = 1L;
        private final int expectedLatestRevision;
        private final int actualLatestRevision;

        public TranscriptRevisionConflictException(int expectedLatestRevision, int actualLatestRevision) {
            super("Transcript revision conflict: expected latest " + expectedLatestRevision
                    + " but found " + actualLatestRevision);
            if (expectedLatestRevision < 0 || actualLatestRevision < 0) {
                throw new IllegalArgumentException("transcript revisions cannot be negative");
            }
            this.expectedLatestRevision = expectedLatestRevision;
            this.actualLatestRevision = actualLatestRevision;
        }

        public int expectedLatestRevision() { return expectedLatestRevision; }
        public int actualLatestRevision() { return actualLatestRevision; }
    }

    /** A transcript identifier is already owned by another principal in the tenant. */
    public static final class TranscriptPrincipalConflictException extends SecurityException {
        private static final long serialVersionUID = 1L;

        public TranscriptPrincipalConflictException() {
            super("Transcript identifier is already bound to another principal");
        }
    }

    public interface MediaTranscriptStore extends AutoCloseable {
        /**
         * Append using the legacy contract. Implementations should permit creation and exact
         * idempotent retry only; a changed existing transcript requires the expected-revision API.
         */
        TranscriptRevision append(TranscriptDraft draft);

        /**
         * Append against the caller's observed latest revision (zero means no revision exists).
         * Repeating the exact latest draft is idempotent; a changed draft requires an exact CAS pin.
         */
        default TranscriptRevision append(TranscriptDraft draft, int expectedLatestRevision) {
            throw new UnsupportedOperationException("Expected-revision append is not supported by this store");
        }

        /** Existing implementations retain their original tenant/transcript read contract. */
        List<TranscriptRevision> revisions(String tenantId, String transcriptId);

        /**
         * Principal-scoped readback is required for safe transcript access. The compatibility
         * default fails closed until an implementation can enforce the extra owner key.
         */
        default List<TranscriptRevision> revisions(String tenantId, String principalId, String transcriptId) {
            throw new UnsupportedOperationException("Principal-scoped transcript readback is not supported by this store");
        }

        /**
         * Reports the current derived-operation boundary. Implementations must not create output
         * versions from these unavailable capabilities. Plain-text transcript CAS remains separate.
         */
        default TranscriptCapabilityResult capability(TranscriptDerivedCapability capability) {
            return unavailableCapability(capability);
        }

        boolean productionEligible();
        @Override void close();
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value.trim();
    }

    public static TranscriptCapabilityResult unavailableCapability(TranscriptDerivedCapability capability) {
        Objects.requireNonNull(capability, "capability");
        List<TranscriptCapabilityBlocker> blockers = switch (capability) {
            case FORCED_ALIGNMENT -> List.of(TranscriptCapabilityBlocker.QUALIFIED_ENGINE_UNAVAILABLE,
                    TranscriptCapabilityBlocker.AUTHORITATIVE_SOURCE_CLOCK_UNAVAILABLE);
            case TRANSLATION -> List.of(TranscriptCapabilityBlocker.QUALIFIED_ENGINE_UNAVAILABLE);
            case CAPTION_VERSION_REGISTRATION -> List.of(
                    TranscriptCapabilityBlocker.CANONICAL_TRANSCRIPT_VERSION_UNAVAILABLE,
                    TranscriptCapabilityBlocker.AUTHORITATIVE_SOURCE_CLOCK_UNAVAILABLE,
                    TranscriptCapabilityBlocker.DERIVED_CONTENT_AUTHORITY_UNAVAILABLE);
        };
        return new TranscriptCapabilityResult(capability, TranscriptCapabilityDisposition.UNMET_CAPABILITY,
                blockers, false);
    }
}
