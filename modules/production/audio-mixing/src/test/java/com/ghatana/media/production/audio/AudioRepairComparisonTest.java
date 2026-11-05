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

        assertThat(comparison.source().data()).containsExactly(sourceBefore);
        assertThat(comparison.repaired().data()).containsExactly(repaired.data());
        assertThat(comparison.sourceSha256()).hasSize(64).isNotEqualTo(comparison.repairedSha256());
        assertThat(comparison.metrics().changedSampleCount()).isEqualTo(3);
        assertThat(comparison.metrics().hasIndependentReference()).isTrue();
        assertThat(comparison.metrics().snrDbVsReference()).isFinite();
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

    private static AudioData pcm(int... samples) {
        byte[] bytes = new byte[samples.length * 2];
        for (int index = 0; index < samples.length; index++) {
            bytes[index * 2] = (byte) samples[index];
            bytes[index * 2 + 1] = (byte) (samples[index] >>> 8);
        }
        return new AudioData(bytes, 8_000, 1, 16,
                Duration.ofNanos((long) samples.length * 1_000_000_000L / 8_000), AudioFormat.PCM);
    }
}
