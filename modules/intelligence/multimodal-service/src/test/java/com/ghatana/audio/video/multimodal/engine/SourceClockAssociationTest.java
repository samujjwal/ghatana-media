package com.ghatana.audio.video.multimodal.engine;

import org.junit.jupiter.api.Test;

import java.math.BigInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SourceClockAssociationTest {

    @Test
    void mapsAudioSamplesAndVfrVideoPtsExactlyWithAnInjectedMappingFixture() {
        // This is arithmetic fixture coverage only; production mapping authority is not wired.
        var association = new SourceClockAssociation(
                "artifact-1", "version-7",
                new SourceClockAssociation.StreamClock("audio-0", "audio-clock-0", "origin-v1",
                        1, 16_000, 0, 1, 2),
                new SourceClockAssociation.StreamClock("video-0", "video-clock-0", "origin-v1",
                        1, 90_000, 62_500_000, 1, 2),
                SourceClockAssociation.MappingProvenance.TRUSTED_CONTAINER_EDIT_METADATA,
                2_000_000L);

        var result = association.associateAudioSampleWithVideoPts(
                "artifact-1", "version-7", 2, 16_000, 90_000);

        assertThat(result.status()).isEqualTo(SourceClockAssociation.AssociationStatus.TIMESTAMP_ALIGNED);
        assertThat(result.audioSourceTime().sharesClock(result.videoSourceTime())).isTrue();
        assertThat(result.audioSourceTime().domain())
                .isEqualTo(MediaClockTimestamp.ClockDomain.SOURCE);
        assertThat(asNanos(result.audioSourceTime())).isEqualTo(new SourceClockAssociation.RationalNanos(
                BigInteger.valueOf(1_000_000_000L), BigInteger.ONE));
        assertThat(asNanos(result.videoSourceTime())).isEqualTo(new SourceClockAssociation.RationalNanos(
                BigInteger.valueOf(1_062_500_000L), BigInteger.ONE));
        assertThat(result.audioMinusVideoNanos()).isEqualTo(new SourceClockAssociation.RationalNanos(
                BigInteger.valueOf(-62_500_000L), BigInteger.ONE));
        assertThat(result.uncertaintyNanos()).isEqualTo(2_000_000L);
    }

    @Test
    void reducesNanosecondRationalBeforeConvertingToTheTimestampTimebase() {
        var association = new SourceClockAssociation(
                "artifact-1", "version-7",
                new SourceClockAssociation.StreamClock("audio-0", "audio-clock-0", "origin-v1",
                        1, 999_999_937L, 1_000_000_000L, 999_999_929L, 2),
                new SourceClockAssociation.StreamClock("video-0", "video-clock-0", "origin-v1",
                        1, 90_000, 0, 1, 2),
                SourceClockAssociation.MappingProvenance.TRUSTED_CONTAINER_EDIT_METADATA,
                0);

        var result = association.associateAudioSampleWithVideoPts(
                "artifact-1", "version-7", 2, 0, 0);

        assertThat(result.status()).isEqualTo(SourceClockAssociation.AssociationStatus.TIMESTAMP_ALIGNED);
        assertThat(result.audioSourceTime().isKnown()).isTrue();
        assertThat(asNanos(result.audioSourceTime())).isEqualTo(new SourceClockAssociation.RationalNanos(
                BigInteger.valueOf(1_000_000_000L), BigInteger.valueOf(999_999_929L)));
    }

    @Test
    void sourceVersionAndDiscontinuityMismatchReturnUnknownWithoutMappedValues() {
        var association = mappedFixture();

        var wrongVersion = association.associateAudioSampleWithVideoPts("artifact-1", "version-8", 2, 1, 1);
        var wrongEpoch = association.associateAudioSampleWithVideoPts("artifact-1", "version-7", 3, 1, 1);

        assertThat(wrongVersion.status()).isEqualTo(SourceClockAssociation.AssociationStatus.SYNC_UNDETERMINED);
        assertThat(wrongVersion.reason()).isEqualTo("SOURCE_ARTIFACT_VERSION_MISMATCH");
        assertThat(wrongVersion.audioMinusVideoNanos()).isNull();
        assertThat(wrongEpoch.status()).isEqualTo(SourceClockAssociation.AssociationStatus.SYNC_UNDETERMINED);
        assertThat(wrongEpoch.reason()).isEqualTo("SOURCE_CLOCK_DISCONTINUITY");
    }

    @Test
    void unavailableMappingCannotFabricateOffsets() {
        var fixture = mappedFixture();
        var association = new SourceClockAssociation(fixture.sourceArtifactId(), fixture.sourceVersionId(),
                fixture.audioClock(), fixture.videoClock(),
                SourceClockAssociation.MappingProvenance.UNAVAILABLE, 0);

        var result = association.associateAudioSampleWithVideoPts("artifact-1", "version-7", 2, 1, 1);

        assertThat(result.status()).isEqualTo(SourceClockAssociation.AssociationStatus.SYNC_UNDETERMINED);
        assertThat(result.reason()).isEqualTo("SOURCE_CLOCK_MAPPING_NOT_ADMITTED");
        assertThat(result.audioSourceTime()).isNull();
        assertThat(result.videoSourceTime()).isNull();
        assertThat(result.audioMinusVideoNanos()).isNull();
    }

    @Test
    void rejectsMalformedRequestsAndReturnsUnknownWhenMappedTimestampOverflows() {
        var association = mappedFixture();

        var invalidSample = association.associateAudioSampleWithVideoPts(
                "artifact-1", "version-7", 2, -1, 0);
        assertThat(invalidSample.status()).isEqualTo(SourceClockAssociation.AssociationStatus.SYNC_UNDETERMINED);
        assertThat(invalidSample.reason()).isEqualTo("AUDIO_SAMPLE_INDEX_INVALID");
        assertThat(invalidSample.audioSourceTime()).isNull();

        var overflowing = new SourceClockAssociation("artifact-1", "version-7",
                new SourceClockAssociation.StreamClock("audio-0", "audio-clock-0", "origin-v1",
                        1_000_000_000L, 1, 0, 1, 2),
                new SourceClockAssociation.StreamClock("video-0", "video-clock-0", "origin-v1",
                        1, 90_000, 0, 1, 2),
                SourceClockAssociation.MappingProvenance.OWNER_VERIFIED_SOURCE_MAPPING, 0)
                .associateAudioSampleWithVideoPts("artifact-1", "version-7", 2,
                        Long.MAX_VALUE, 0);
        assertThat(overflowing.status()).isEqualTo(SourceClockAssociation.AssociationStatus.SYNC_UNDETERMINED);
        assertThat(overflowing.reason()).isEqualTo("MAPPED_TIMESTAMP_OUT_OF_RANGE");
        assertThat(overflowing.audioMinusVideoNanos()).isNull();
    }

    @Test
    void unavailableMappingIsReportedForMissingArtifactOrVersionIdentity() {
        var association = mappedFixture();

        var missingArtifact = association.associateAudioSampleWithVideoPts(null, "version-7", 2, 0, 0);
        var missingVersion = association.associateAudioSampleWithVideoPts("artifact-1", "", 2, 0, 0);

        assertThat(missingArtifact.status()).isEqualTo(SourceClockAssociation.AssociationStatus.SYNC_UNDETERMINED);
        assertThat(missingArtifact.reason()).isEqualTo("SOURCE_ARTIFACT_VERSION_MISMATCH");
        assertThat(missingVersion.status()).isEqualTo(SourceClockAssociation.AssociationStatus.SYNC_UNDETERMINED);
        assertThat(missingVersion.reason()).isEqualTo("SOURCE_ARTIFACT_VERSION_MISMATCH");
    }

    @Test
    void rejectsInvalidRationalClockAndUncertainty() {
        assertThatThrownBy(() -> new SourceClockAssociation.StreamClock(
                "audio-0", "audio-clock-0", "origin-v1", 0, 16_000, 0, 1, 0))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SourceClockAssociation(
                "artifact-1", "version-7",
                new SourceClockAssociation.StreamClock("audio-0", "audio-clock-0", "origin-v1", 1, 16_000, 0, 1, 0),
                new SourceClockAssociation.StreamClock("video-0", "video-clock-0", "origin-v1", 1, 90_000, 0, 1, 1),
                SourceClockAssociation.MappingProvenance.OWNER_VERIFIED_SOURCE_MAPPING, 0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("discontinuity epoch");
        assertThatThrownBy(() -> new SourceClockAssociation(
                "artifact-1", "version-7",
                new SourceClockAssociation.StreamClock("audio-0", "audio-clock-0", "origin-v1", 1, 16_000, 0, 1, 0),
                new SourceClockAssociation.StreamClock("video-0", "video-clock-0", "origin-v1", 1, 90_000, 0, 1, 0),
                SourceClockAssociation.MappingProvenance.OWNER_VERIFIED_SOURCE_MAPPING,
                60_000_000_001L))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("uncertainty");

        assertThatThrownBy(() -> new SourceClockAssociation(
                "artifact-1", "version-7",
                new SourceClockAssociation.StreamClock("audio-0", "audio-clock-0", "audio-origin", 1, 16_000, 0, 1, 0),
                new SourceClockAssociation.StreamClock("video-0", "video-clock-0", "video-origin", 1, 90_000, 0, 1, 0),
                SourceClockAssociation.MappingProvenance.OWNER_VERIFIED_SOURCE_MAPPING, 0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("source origin");
    }

    private static SourceClockAssociation mappedFixture() {
        return new SourceClockAssociation(
                "artifact-1", "version-7",
                new SourceClockAssociation.StreamClock("audio-0", "audio-clock-0", "origin-v1", 1, 16_000, 0, 1, 2),
                new SourceClockAssociation.StreamClock("video-0", "video-clock-0", "origin-v1", 1, 90_000, 0, 1, 2),
                SourceClockAssociation.MappingProvenance.OWNER_VERIFIED_SOURCE_MAPPING, 0);
    }

    private static SourceClockAssociation.RationalNanos asNanos(MediaClockTimestamp timestamp) {
        return new SourceClockAssociation.RationalNanos(
                BigInteger.valueOf(timestamp.ticks())
                        .multiply(BigInteger.valueOf(timestamp.timeBaseNumerator()))
                        .multiply(BigInteger.valueOf(1_000_000_000L)),
                BigInteger.valueOf(timestamp.timeBaseDenominator()));
    }
}
