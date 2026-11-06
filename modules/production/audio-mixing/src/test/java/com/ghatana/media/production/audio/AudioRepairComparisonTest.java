package com.ghatana.media.production.audio;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class AudioRepairComparisonTest {
    @Test
    void keepsSourceAndRepairedRevisionsIndependentAndReportsReferenceSnr() {
        AudioData source = pcm(0, 1000, 2000, 3000);
        AudioData repaired = pcm(0, 900, 1800, 2700);
        AudioData reference = pcm(0, 950, 1900, 2850);
        byte[] sourceBefore = source.data();

        AudioRepairComparison comparison = AudioRepairComparison.compare(source, repaired, reference);
        byte[] returnedSource = comparison.source().data();
        returnedSource[0] = 99;
        byte[] undone = comparison.undo().data();
        undone[1] = 99;

        assertThat(comparison.source().data()).containsExactly(sourceBefore);
        assertThat(comparison.undo().data()).containsExactly(sourceBefore);
        assertThat(comparison.repaired().data()).containsExactly(repaired.data());
        assertThat(comparison.sourceSha256()).isEqualTo("4fb6e962586de84574b87b29ee9eee37aef624c1d1f9a28b7793ef784bfc604a");
        assertThat(comparison.repairedSha256()).hasSize(64).isNotEqualTo(comparison.sourceSha256());
        assertThat(comparison.metrics().changedSampleCount()).isEqualTo(3);
        assertThat(comparison.metrics().sourceNearClipSampleCount()).isZero();
        assertThat(comparison.metrics().repairedNearClipSampleCount()).isZero();
        assertThat(comparison.metrics().hasIndependentReference()).isTrue();
        assertThat(comparison.metrics().snrDbVsReference()).isFinite();
    }

    @Test
    void reportsSaturatedSamplesAndStereoPhaseRelationshipWithoutClaimingQuality() {
        AudioData clipped = stereo(32767, 32767, -32768, -32768, 12000, 12000);
        AudioData phaseInvertedCandidate = stereo(30000, -30000, -28000, 28000, 10000, -10000);

        AudioRepairComparison comparison = AudioRepairComparison.compare(clipped, phaseInvertedCandidate);

        assertThat(comparison.metrics().sourceNearClipSampleCount()).isEqualTo(4);
        assertThat(comparison.metrics().repairedNearClipSampleCount()).isZero();
        assertThat(comparison.metrics().sourceStereoCorrelation()).isEqualTo(1.0);
        assertThat(comparison.metrics().repairedStereoCorrelation()).isEqualTo(-1.0);
        assertThat(comparison.metrics().stereoCorrelationDelta()).isEqualTo(2.0);
        assertThat(comparison.metrics().rmsChangeDb()).isFinite();
    }

    @Test
    void omitsSnrWithoutIndependentReferenceAndRejectsCorruptOrDriftingComparisons() {
        AudioRepairComparison comparison = AudioRepairComparison.compare(pcm(1, 2), pcm(1, 3));
        assertThat(comparison.metrics().hasIndependentReference()).isFalse();
        assertThat(comparison.metrics().snrDbVsReference()).isNaN();
        assertThatIllegalArgumentException().isThrownBy(() ->
                AudioRepairComparison.compare(pcm(1, 2), pcm(1, 2, 3)));
        AudioData compressed = new AudioData(new byte[] {1, 2}, 8_000, 1, 16,
                Duration.ofMillis(1), AudioFormat.MP3);
        assertThatIllegalArgumentException().isThrownBy(() ->
                AudioRepairComparison.compare(compressed, compressed));
        assertThatIllegalArgumentException().isThrownBy(() ->
                AudioRepairComparison.compare(pcm(1, 2), pcm(1, 2), pcm(1)));
        AudioData empty = new AudioData(new byte[0], 8_000, 1, 16,
                Duration.ZERO, AudioFormat.PCM);
        assertThatIllegalArgumentException().isThrownBy(() ->
                AudioRepairComparison.compare(empty, empty));
        AudioData wrongDuration = new AudioData(new byte[] {1, 0}, 8_000, 1, 16,
                Duration.ofSeconds(1), AudioFormat.PCM);
        assertThatIllegalArgumentException().isThrownBy(() ->
                AudioRepairComparison.compare(wrongDuration, wrongDuration));
    }

    @Test
    void rejectsReferenceAliasedToEitherComparedRevision() {
        AudioData source = pcm(10, 20);
        AudioData repaired = pcm(9, 19);

        assertThatIllegalArgumentException().isThrownBy(() ->
                AudioRepairComparison.compare(source, repaired, source));
        assertThatIllegalArgumentException().isThrownBy(() ->
                AudioRepairComparison.compare(source, repaired, repaired));
    }

    @Test
    void silenceHasTransparentMetricsAndNoInventedStereoPhaseMeasurement() {
        AudioData silence = pcm(0, 0, 0, 0);

        AudioRepairComparison comparison = AudioRepairComparison.compare(silence, silence, pcm(0, 0, 0, 0));

        assertThat(comparison.sourceSha256()).isEqualTo(comparison.repairedSha256());
        assertThat(comparison.metrics().sourceRms()).isZero();
        assertThat(comparison.metrics().repairedRms()).isZero();
        assertThat(comparison.metrics().rmsChangeDb()).isZero();
        assertThat(comparison.metrics().sourceNearClipSampleCount()).isZero();
        assertThat(comparison.metrics().repairedNearClipSampleCount()).isZero();
        assertThat(Double.isInfinite(comparison.metrics().snrDbVsReference())
                && comparison.metrics().snrDbVsReference() > 0.0).isTrue();
        assertThat(comparison.metrics().sourceStereoCorrelation()).isNull();
        assertThat(comparison.metrics().stereoCorrelationDelta()).isNull();
    }

    @Test
    void multichannelPcmDoesNotExposeFirstTwoChannelsAsStereoCorrelation() {
        AudioData source = multichannelPcm(1_000, 1_000, -1_000, 2_000, -2_000, 2_000);
        AudioData repaired = multichannelPcm(1_000, -1_000, 1_000, 2_000, -2_000, 2_000);

        AudioRepairComparison comparison = AudioRepairComparison.compare(source, repaired);

        assertThat(comparison.metrics().sourceStereoCorrelation()).isNull();
        assertThat(comparison.metrics().repairedStereoCorrelation()).isNull();
        assertThat(comparison.metrics().stereoCorrelationDelta()).isNull();
    }

    @Test
    void decodesSignedTwentyFourAndThirtyTwoBitPcmAtFullScaleBoundaries() {
        AudioRepairComparison pcm24 = AudioRepairComparison.compare(
                signedPcm(24, 0x800000, 0x7fffff), signedPcm(24, 0x800000, 0x7fffff));
        assertThat(pcm24.metrics().sourcePeak()).isEqualTo(8_388_608L);
        assertThat(pcm24.metrics().sourceNearClipSampleCount()).isEqualTo(2);

        AudioRepairComparison pcm32 = AudioRepairComparison.compare(
                signedPcm(32, 0x80000000, 0x7fffffff), signedPcm(32, 0x80000000, 0x7fffffff));
        assertThat(pcm32.metrics().sourcePeak()).isEqualTo(2_147_483_648L);
        assertThat(pcm32.metrics().sourceNearClipSampleCount()).isEqualTo(2);
    }

    @Test
    void acceptsExactPcmByteBudgetAndRejectsFirstCompleteFrameAboveIt() {
        int maxBytes = 16 * 1024 * 1024;
        long maxFrames = maxBytes / 2L;
        AudioData exactLimit = new AudioData(new byte[maxBytes], 8_000, 1, 16,
                Duration.ofNanos(maxFrames * 1_000_000_000L / 8_000), AudioFormat.PCM);
        AudioRepairComparison comparison = AudioRepairComparison.compare(exactLimit, exactLimit);
        assertThat(comparison.source().dataLength()).isEqualTo(maxBytes);
        assertThat(comparison.metrics().changedSampleCount()).isZero();

        int bytes = maxBytes + 2;
        long frames = bytes / 2L;
        AudioData oversized = new AudioData(new byte[bytes], 8_000, 1, 16,
                Duration.ofNanos(frames * 1_000_000_000L / 8_000), AudioFormat.PCM);
        assertThatIllegalArgumentException().isThrownBy(() -> AudioRepairComparison.compare(oversized, oversized));
    }

    @Test
    void computesReferenceMetricsForLargeBoundedPcmWithoutPerSamplePayloadCopies() {
        byte[] bytes = new byte[1024 * 1024];
        long frames = bytes.length / 2L;
        Duration duration = Duration.ofNanos(frames * 1_000_000_000L / 8_000);
        AudioData source = new AudioData(bytes, 8_000, 1, 16, duration, AudioFormat.PCM);
        AudioData repaired = new AudioData(bytes.clone(), 8_000, 1, 16, duration, AudioFormat.PCM);
        AudioData reference = new AudioData(bytes.clone(), 8_000, 1, 16, duration, AudioFormat.PCM);

        AudioRepairComparison comparison = AudioRepairComparison.compare(source, repaired, reference);

        assertThat(comparison.metrics().hasIndependentReference()).isTrue();
        assertThat(comparison.metrics().snrDbVsReference()).isEqualTo(Double.POSITIVE_INFINITY);
        assertThat(comparison.metrics().changedSampleCount()).isZero();
    }

    private static AudioData pcm(int... samples) {
        byte[] bytes = new byte[samples.length * 2];
        for (int index = 0; index < samples.length; index++) {
            bytes[index * 2] = (byte) samples[index];
            bytes[index * 2 + 1] = (byte) (samples[index] >>> 8);
        }
        return new AudioData(bytes, 8_000, 1, 16,
                Duration.ofNanos((long) samples.length * 1_000_000_000L / 8_000), AudioFormat.PCM);
    }

    private static AudioData stereo(int... samples) {
        byte[] bytes = new byte[samples.length * 2];
        for (int index = 0; index < samples.length; index++) {
            bytes[index * 2] = (byte) samples[index];
            bytes[index * 2 + 1] = (byte) (samples[index] >>> 8);
        }
        int frames = samples.length / 2;
        return new AudioData(bytes, 8_000, 2, 16,
                Duration.ofNanos((long) frames * 1_000_000_000L / 8_000), AudioFormat.PCM);
    }

    private static AudioData multichannelPcm(int... samples) {
        byte[] bytes = new byte[samples.length * 2];
        for (int index = 0; index < samples.length; index++) {
            bytes[index * 2] = (byte) samples[index];
            bytes[index * 2 + 1] = (byte) (samples[index] >>> 8);
        }
        int frames = samples.length / 3;
        return new AudioData(bytes, 8_000, 3, 16,
                Duration.ofNanos((long) frames * 1_000_000_000L / 8_000), AudioFormat.PCM);
    }

    private static AudioData signedPcm(int bits, int... samples) {
        int sampleBytes = bits / 8;
        byte[] bytes = new byte[samples.length * sampleBytes];
        for (int index = 0; index < samples.length; index++) {
            int value = samples[index];
            for (int byteIndex = 0; byteIndex < sampleBytes; byteIndex++) {
                bytes[index * sampleBytes + byteIndex] = (byte) (value >>> (8 * byteIndex));
            }
        }
        return new AudioData(bytes, 8_000, 1, bits,
                Duration.ofNanos((long) samples.length * 1_000_000_000L / 8_000), AudioFormat.PCM);
    }
}
