package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision;
import org.junit.jupiter.api.Test;

import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * MED-07 / PHR rule: an STT transcript is a machine-generated draft with source/model/rights provenance;
 * Media has no representation of clinical sign-off, so STT can never auto-sign one.
 */
class MediaTranscriptNoAutoSignTest {
    private static final List<String> SIGNING_WORDS = List.of("sign", "attest", "approv", "certif", "verifiedby", "authoredby");

    @Test
    void transcriptRecordsCarryNoSigningOrApprovalComponents() {
        for (Class<?> type : new Class<?>[] {TranscriptDraft.class, TranscriptRevision.class,
                MediaTranscriptContracts.TranscriptAttemptBinding.class}) {
            for (RecordComponent component : type.getRecordComponents()) {
                String name = component.getName().toLowerCase(Locale.ROOT);
                assertThat(SIGNING_WORDS.stream().noneMatch(name::contains))
                        .as("%s.%s must not model signing", type.getSimpleName(), component.getName()).isTrue();
            }
        }
    }

    @Test
    void transcriptDraftBindsProvenanceRequiredForAuditAndNothingElse() {
        List<String> names = Arrays.stream(TranscriptDraft.class.getRecordComponents())
                .map(RecordComponent::getName).toList();
        assertThat(names).contains("sourceArtifactId", "sourceVersion", "sourceSha256", "jobId", "profileId",
                "providerId", "modelId", "language", "consentDecisionId", "rightsDecisionId", "policyVersion",
                "purposeRef", "processingPurpose");
    }
}
