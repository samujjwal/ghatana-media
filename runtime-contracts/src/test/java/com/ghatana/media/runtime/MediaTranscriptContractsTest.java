package com.ghatana.media.runtime;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaTranscriptContractsTest {
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
}
