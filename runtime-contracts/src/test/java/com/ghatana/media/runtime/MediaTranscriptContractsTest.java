package com.ghatana.media.runtime;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaTranscriptContractsTest {
    @Test
    void transcriptPurposeBindingsRespectPersistedCharacterBounds() {
        var valid = transcriptDraft("urn:media:purpose:transcription", "transcription");
        assertThat(valid.purposeRef()).isEqualTo("urn:media:purpose:transcription");
        assertThat(valid.processingPurpose()).isEqualTo("transcription");

        assertThat(transcriptDraft("x".repeat(256), "p".repeat(255)).purposeRef()).hasSize(256);
        assertThat(transcriptDraft("😀".repeat(256), "transcription").purposeRef()).isEqualTo("😀".repeat(256));
        assertThatThrownBy(() -> transcriptDraft("😀".repeat(257), "transcription"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("purposeRef");
        assertThatThrownBy(() -> transcriptDraft("x".repeat(257), "transcription"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("purposeRef");
        assertThatThrownBy(() -> transcriptDraft("urn:media:purpose:transcription", "p".repeat(256)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("processingPurpose");
    }

    @Test
    void alignmentTranslationAndCaptionRegistrationAreTypedNoEffectUntilQualified() {
        for (var capability : MediaTranscriptContracts.TranscriptDerivedCapability.values()) {
            var result = MediaTranscriptContracts.unavailableCapability(capability);
            assertThat(result.capability()).isEqualTo(capability);
            assertThat(result.disposition()).isEqualTo(
                    MediaTranscriptContracts.TranscriptCapabilityDisposition.UNMET_CAPABILITY);
            assertThat(result.blockers()).isNotEmpty();
            assertThat(result.effectOccurred()).isFalse();
        }
    }

    @Test
    void unavailableCapabilityCannotClaimAnEffectOrOmitItsReason() {
        assertThatThrownBy(() -> new MediaTranscriptContracts.TranscriptCapabilityResult(
                MediaTranscriptContracts.TranscriptDerivedCapability.CAPTION_VERSION_REGISTRATION,
                MediaTranscriptContracts.TranscriptCapabilityDisposition.UNMET_CAPABILITY,
                java.util.List.of(), false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaTranscriptContracts.TranscriptCapabilityResult(
                MediaTranscriptContracts.TranscriptDerivedCapability.CAPTION_VERSION_REGISTRATION,
                MediaTranscriptContracts.TranscriptCapabilityDisposition.UNMET_CAPABILITY, java.util.List.of(
                        MediaTranscriptContracts.TranscriptCapabilityBlocker.CANONICAL_TRANSCRIPT_VERSION_UNAVAILABLE),
                true))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static MediaTranscriptContracts.TranscriptDraft transcriptDraft(String purposeRef, String purpose) {
        String digest = "a".repeat(64);
        return new MediaTranscriptContracts.TranscriptDraft(
                "tenant", "principal", "transcript", "artifact", "sha256:" + digest, digest,
                "job", "profile", "provider", "model", "en-US", "milliseconds", "text",
                "consent", "rights", "policy", purposeRef, purpose);
    }
}
