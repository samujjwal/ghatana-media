package com.ghatana.audio.video.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.production.audio.AudioRepairComparison;
import java.lang.reflect.Modifier;
import java.time.Duration;
import java.util.Arrays;
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

    @Test
    @DisplayName("without restoration admission, the selected boundary exposes comparison only")
    void missingRestorationAdmissionCannotDispatchOrCreateARepairedRevision() {
        AudioData source = pcm(1_200, -800, 0, 2_400);
        byte[] exactSource = source.data();
        String sourceDigest = AudioRepairComparison.compare(source, source).sourceSha256();

        // The selected production boundary has no admission/dispatch operation.
        // Keep this negative case on that actual boundary: source-only comparison
        // can return a comparison value, but cannot claim a denoise/declip effect.
        var publicMethods = Arrays.stream(AudioRepairComparison.class.getDeclaredMethods())
                .filter(method -> Modifier.isPublic(method.getModifiers()))
                .map(java.lang.reflect.Method::getName)
                .toList();
        assertThat(publicMethods).contains("compare", "source", "repaired", "undo", "metrics")
                .doesNotContain("denoise", "declip", "restore", "dispatch");

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

    @Test
    @DisplayName("mutating returned snapshots cannot alter the preserved source revision")
    void returnedComparisonSnapshotsCannotMutateSourceOrUndoRevision() {
        AudioData source = pcm(1_200, -800, 0, 2_400);
        byte[] exactSource = source.data();
        AudioRepairComparison comparison = AudioRepairComparison.compare(source, pcm(1_000, -700, 0, 2_300));

        byte[] returnedSourceBytes = comparison.source().data();
        byte[] returnedUndoBytes = comparison.undo().data();
        returnedSourceBytes[0] ^= (byte) 0xff;
        returnedUndoBytes[1] ^= (byte) 0xff;

        assertThat(source.data()).containsExactly(exactSource);
        assertThat(comparison.source().data()).containsExactly(exactSource);
        assertThat(comparison.undo().data()).containsExactly(exactSource);
        assertThat(comparison.sourceSha256()).isEqualTo(AudioRepairComparison.compare(source, source).sourceSha256());
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
