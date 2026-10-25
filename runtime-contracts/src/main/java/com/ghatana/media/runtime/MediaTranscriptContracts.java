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

    public interface MediaTranscriptStore extends AutoCloseable {
        TranscriptRevision append(TranscriptDraft draft);
        List<TranscriptRevision> revisions(String tenantId, String transcriptId);
        boolean productionEligible();
        @Override void close();
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value.trim();
    }
}
