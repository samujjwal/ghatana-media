package com.ghatana.audio.video.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.production.audio.AudioRepairComparison;
import java.time.Duration;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/**
 * Source-free comparison-boundary coverage for J-07. AudioRepairComparison is
 * a comparison and source-recovery utility, not a runtime admission or restoration provider.
 */
@Tag("integration")
@DisplayName("Audio restoration comparison boundary — J-07")
class AudioRestorationSourceBoundaryIntegrationTest {

    @Test
    @DisplayName("without an independent reference, preserve source and leave quality unevaluated")
    void sourceOnlyComparisonCannotClaimImprovementWithoutReferenceAndPreservesUndo() {
        AudioData source = pcm(1_200, -800, 0, 2_400);
        byte[] exactSource = source.data();
        String sourceDigest = AudioRepairComparison.compare(source, source).sourceSha256();

        // No restoration execution API is wired into this boundary. The
        // comparison utility can describe an unchanged source, but cannot
        // establish quality or improvement without an independent reference.
        AudioRepairComparison comparison = AudioRepairComparison.compare(source, source);

        assertThat(comparison.source().data()).containsExactly(exactSource);
        assertThat(comparison.undo().data()).containsExactly(exactSource);
        assertThat(comparison.sourceSha256()).isEqualTo(sourceDigest);
        assertThat(comparison.repairedSha256()).isEqualTo(sourceDigest);
        assertThat(comparison.metrics().changedSampleCount()).isZero();
        assertThat(comparison.metrics().hasIndependentReference()).isFalse();
        assertThat(comparison.metrics().snrDbVsReference()).isNaN();
        assertThat(source.data()).containsExactly(exactSource);
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
