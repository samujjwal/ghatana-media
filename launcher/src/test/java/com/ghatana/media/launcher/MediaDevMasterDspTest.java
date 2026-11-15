package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Pure-Java checks of the J-17 stem synthesis, mix, loudness meter, true-peak meter and master solver. */
class MediaDevMasterDspTest {
    private static final int RATE = MediaDevMasterSpec.RATE;

    private static MediaDevMasterSpec.Stem stem(Map<String, Object> spec) {
        return MediaDevMasterSpec.parseStem(spec, "$.spec");
    }

    private static Map<String, Object> tone(double hz, int ms) {
        return new java.util.LinkedHashMap<>(Map.of("kind", "TONE", "durationMs", ms, "frequencyHz", hz));
    }

    private static double[][] sineBus(double hz, double amplitude, int frames) {
        double[] l = new double[frames];
        double[] r = new double[frames];
        for (int n = 0; n < frames; n++) l[n] = r[n] = amplitude * Math.sin(2 * Math.PI * hz * n / RATE);
        return new double[][] { l, r };
    }

    @Test
    void sineLoudnessMatchesTheBs1770ReferenceValue() {
        // BS.1770 / EBU Tech 3341: a 997 Hz stereo sine at -23 dBFS peak per channel measures -23.0 LUFS.
        double[][] bus = sineBus(997, Math.pow(10, -23.0 / 20), RATE * 5);
        assertThat(MediaDevMasterDsp.integratedLufs(bus[0], bus[1])).isBetween(-23.1, -22.9);
    }

    @Test
    void silenceHasNoDefinedLoudnessAndTheMasterAbstainsInsteadOfApplyingInfiniteGain() {
        double[] zero = new double[RATE * 2];
        assertThat(MediaDevMasterDsp.integratedLufs(zero, zero)).isNaN();
        assertThatThrownBy(() -> MediaDevMasterDsp.master(zero, zero.clone(), -16, -1))
                .isInstanceOfSatisfying(MediaDevMasterRuntime.MasterRefusedException.class, refused -> {
                    assertThat(refused.status()).isEqualTo(422);
                    assertThat(refused.code()).isEqualTo("MASTER_LOUDNESS_TARGET_UNREACHABLE");
                    assertThat(refused.details()).containsEntry("reason", "SILENT_INPUT").containsEntry("outcome", "ABSTAINED");
                });
        // a barely audible floor (-90 dBFS) is below the -70 LUFS absolute gate: also silent
        double[][] floor = sineBus(440, Math.pow(10, -90.0 / 20), RATE * 2);
        assertThatThrownBy(() -> MediaDevMasterDsp.master(floor[0], floor[1], -16, -1))
                .isInstanceOfSatisfying(MediaDevMasterRuntime.MasterRefusedException.class,
                        refused -> assertThat(refused.details()).containsEntry("reason", "SILENT_INPUT"));
    }

    @Test
    void aVeryQuietButMeasurableMixIsRefusedAtTheGainCapInsteadOfBoostedWithoutBound() {
        double[][] quiet = sineBus(440, Math.pow(10, -68.0 / 20), RATE * 2); // about -71 LUFS+: needs far more than +48 dB
        assertThatThrownBy(() -> MediaDevMasterDsp.master(quiet[0], quiet[1], -16, -1))
                .isInstanceOfSatisfying(MediaDevMasterRuntime.MasterRefusedException.class,
                        refused -> assertThat(refused.code()).isEqualTo("MASTER_LOUDNESS_TARGET_UNREACHABLE"));
    }

    @Test
    void masterLandsOnTargetUnderTheCeilingWithNoClippingAndTheTruePeakOfIntersamplePeaksIsHonoured() {
        // A loud sine at fs/4 + phase offset has inter-sample peaks above its sample peak: the classic true-peak trap.
        int frames = RATE * 3;
        double[] l = new double[frames];
        double[] r = new double[frames];
        for (int n = 0; n < frames; n++) {
            l[n] = 0.9 * Math.sin(2 * Math.PI * (RATE / 4.0) * n / RATE + Math.PI / 4);
            r[n] = 0.3 * Math.sin(2 * Math.PI * 330.0 * n / RATE);
        }
        var mastered = MediaDevMasterDsp.master(l, r, -16.0, -1.0);
        assertThat(mastered.integratedLufs()).isBetween(-16.25, -15.75);
        assertThat(mastered.truePeakDbtp()).isLessThanOrEqualTo(-1.0);
        assertThat(mastered.clippedSamples()).isZero();
        assertThat(mastered.pcm()).hasSize(frames * 2);
        // independent re-measurement of the quantized output through the public meters
        assertThat(MediaDevMasterDsp.integratedLufs(mastered.pcm())).isEqualTo(mastered.integratedLufs());
        assertThat(MediaDevMasterDsp.truePeakDbtp(mastered.pcm())).isEqualTo(mastered.truePeakDbtp());
    }

    @Test
    void trueFrequencySineAtQuarterSampleRateShowsTheIntersamplePeakThatSamplePeakMisses() {
        int frames = 4800;
        short[] pcm = new short[frames * 2];
        for (int n = 0; n < frames; n++) {
            short v = (short) Math.round(32767 * 0.7 * Math.sin(2 * Math.PI * (RATE / 4.0) * n / RATE + Math.PI / 4));
            pcm[2 * n] = v;
            pcm[2 * n + 1] = v;
        }
        double samplePeak = 20 * Math.log10(0.7 * Math.sqrt(0.5));
        double truePeak = MediaDevMasterDsp.truePeakDbtp(pcm);
        assertThat(truePeak).isGreaterThan(samplePeak + 2.5).isCloseTo(20 * Math.log10(0.7), org.assertj.core.data.Offset.offset(0.15));
    }

    @Test
    void mixPlacesAStemAtTheExactSampleWithExactMonoUpmixAndPan() {
        short[] pcm = new short[1000];
        for (int i = 0; i < pcm.length; i++) pcm[i] = (short) (1000 + i);
        var placed = new MediaDevMasterDsp.Placed(pcm, 1, 0.0, 0.0, 4321, 0, 0);
        double[][] bus = MediaDevMasterDsp.mix(List.of(placed), 10_000);
        for (int n = 0; n < 4321; n++) assertThat(bus[0][n]).isZero();
        assertThat(bus[0][4321]).isEqualTo(1000 / 32768.0);
        assertThat(bus[1][4321]).isEqualTo(1000 / 32768.0);
        assertThat(bus[0][4321 + 999]).isEqualTo(1999 / 32768.0);
        assertThat(bus[0][4321 + 1000]).isZero();
        double[][] hardLeft = MediaDevMasterDsp.mix(List.of(new MediaDevMasterDsp.Placed(pcm, 1, 0, -1.0, 0, 0, 0)), 1000);
        assertThat(hardLeft[0][5]).isEqualTo(1005 / 32768.0);
        assertThat(hardLeft[1][5]).isZero();
        double[][] gain = MediaDevMasterDsp.mix(List.of(new MediaDevMasterDsp.Placed(pcm, 1, -6.0, 0, 0, 0, 0)), 1000);
        assertThat(gain[0][5]).isCloseTo(1005 / 32768.0 * Math.pow(10, -6.0 / 20), org.assertj.core.data.Offset.offset(1e-12));
    }

    @Test
    void fadesAreLinearAndEndAtExactlyZero() {
        short[] pcm = new short[200];
        java.util.Arrays.fill(pcm, (short) 10_000);
        double[][] bus = MediaDevMasterDsp.mix(List.of(new MediaDevMasterDsp.Placed(pcm, 1, 0, 0, 0, 50, 40)), 200);
        assertThat(bus[0][0]).isZero();
        assertThat(bus[0][25]).isCloseTo(0.5 * 10_000 / 32768.0, org.assertj.core.data.Offset.offset(1e-12));
        assertThat(bus[0][100]).isEqualTo(10_000 / 32768.0);
        assertThat(bus[0][199]).isZero();
    }

    @Test
    void synthesisIsDeterministicAndStayedWithinThePeakItWasAskedFor() {
        for (String kind : List.of("KICK", "SNARE", "HAT")) {
            var drum = stem(Map.of("kind", "DRUM", "drum", kind, "durationMs", 400, "seed", 7, "amplitudeDb", -6.0));
            short[] a = MediaDevMasterDsp.synthesize(drum);
            assertThat(MediaDevMasterDsp.synthesize(drum)).isEqualTo(a);
            int expectedPeak = (int) Math.round(32767 * Math.pow(10, -6.0 / 20));
            assertThat(peak(a)).isBetween(expectedPeak - 2, expectedPeak + 2);
        }
        for (String kind : List.of("FOOTSTEP", "WHOOSH", "IMPACT")) {
            var foley = stem(Map.of("kind", "FOLEY", "foley", kind, "durationMs", 600, "seed", 9, "channels", 2, "amplitudeDb", -12.0));
            short[] a = MediaDevMasterDsp.synthesize(foley);
            assertThat(a).hasSize(600 * 48 * 2);
            assertThat(MediaDevMasterDsp.synthesize(foley)).isEqualTo(a);
            assertThat(peak(a)).isBetween((int) (32767 * Math.pow(10, -12.0 / 20)) - 2, (int) (32767 * Math.pow(10, -12.0 / 20)) + 2);
            var other = stem(Map.of("kind", "FOLEY", "foley", kind, "durationMs", 600, "seed", 10, "channels", 2, "amplitudeDb", -12.0));
            assertThat(MediaDevMasterDsp.synthesize(other)).as("a different seed is a different sound").isNotEqualTo(a);
        }
        // golden digest: bytes are pinned across JVMs and releases (StrictMath, SplitMix64)
        var kick = stem(Map.of("kind", "DRUM", "drum", "KICK", "durationMs", 300, "seed", 1));
        byte[] wav = MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(RATE, 1, MediaDevMasterDsp.synthesize(kick)));
        assertThat(MediaDevProjectRenderRuntime.sha256Hex(wav)).isEqualTo(GOLDEN_KICK_SHA256);
    }

    private static final String GOLDEN_KICK_SHA256 = "6ab6b49c6f7913100324b9d392650776466a4e44365de91a86747b9f4a22a792";

    @Test
    void toneMatchesItsClosedForm() {
        var tone = stem(tone(440.0, 100));
        short[] pcm = MediaDevMasterDsp.synthesize(tone);
        double amp = Math.pow(10, -6.0 / 20);
        for (int n : new int[] {0, 1, 100, 2399, 4799}) {
            double env = MediaDevMasterDsp.envelope(n, 4800, 5, 20);
            double expected = 32767 * amp * Math.sin(2 * Math.PI * 440.0 * n / RATE) * env;
            assertThat((double) pcm[n]).isCloseTo(expected, org.assertj.core.data.Offset.offset(1.0));
        }
        assertThat(pcm[0]).isZero();
        assertThat(pcm[4799]).isZero();
    }

    @Test
    void specParsingNamesThePathOfEveryViolation() {
        assertThatThrownBy(() -> MediaDevMasterSpec.parseStem(Map.of("kind", "TONE", "durationMs", 500, "frequencyHz", 5.0), "$.spec"))
                .isInstanceOfSatisfying(MediaDevMasterRuntime.MasterRefusedException.class, e -> {
                    assertThat(e.status()).isEqualTo(422);
                    assertThat(e.details()).containsEntry("path", "$.spec.frequencyHz");
                });
        assertThatThrownBy(() -> MediaDevMasterSpec.parseStem(Map.of("kind", "TONE", "durationMs", 500, "frequencyHz", 440, "drum", "KICK"), "$.spec"))
                .isInstanceOfSatisfying(MediaDevMasterRuntime.MasterRefusedException.class,
                        e -> assertThat(e.details()).containsEntry("path", "$.spec.drum"));
        assertThatThrownBy(() -> MediaDevMasterSpec.parseStem(Map.of("kind", "TONE", "durationMs", 31_000, "frequencyHz", 440), "$.spec"))
                .isInstanceOfSatisfying(MediaDevMasterRuntime.MasterRefusedException.class, e -> {
                    assertThat(e.code()).isEqualTo("MASTER_BUDGET_EXCEEDED");
                    assertThat(e.details()).containsEntry("path", "$.spec.durationMs");
                });
        assertThatThrownBy(() -> MediaDevMasterSpec.parseStem(Map.of("kind", "TONE", "durationMs", 500, "frequencyHz", 440, "channels", 6), "$.spec"))
                .isInstanceOfSatisfying(MediaDevMasterRuntime.MasterRefusedException.class, e -> {
                    assertThat(e.code()).isEqualTo("STEM_FORMAT_NOT_SUPPORTED");
                    assertThat(e.details()).containsEntry("path", "$.spec.channels");
                });
        Map<String, Object> body = Map.of("requestId", "r1", "stems", List.of(
                Map.of("artifactId", "a", "artifactVersionId", "v", "pan", 2.0)));
        assertThatThrownBy(() -> MediaDevMasterSpec.parseMaster(body))
                .isInstanceOfSatisfying(MediaDevMasterRuntime.MasterRefusedException.class,
                        e -> assertThat(e.details()).containsEntry("path", "$.stems[0].pan"));
        Map<String, Object> target = Map.of("requestId", "r1", "stems", List.of(Map.of("artifactId", "a", "artifactVersionId", "v")),
                "target", Map.of("truePeakDbtp", 1.5));
        assertThatThrownBy(() -> MediaDevMasterSpec.parseMaster(target))
                .isInstanceOfSatisfying(MediaDevMasterRuntime.MasterRefusedException.class,
                        e -> assertThat(e.details()).containsEntry("path", "$.target.truePeakDbtp"));
        Map<String, Object> huge = Map.of("requestId", "r1", "stems", List.of(Map.of("artifactId", "a", "artifactVersionId", "v",
                "startFrame", 99_000_000)));
        assertThatThrownBy(() -> MediaDevMasterSpec.parseMaster(huge))
                .isInstanceOfSatisfying(MediaDevMasterRuntime.MasterRefusedException.class, e -> {
                    assertThat(e.code()).isEqualTo("MASTER_BUDGET_EXCEEDED");
                    assertThat(e.details()).containsEntry("path", "$.stems[0].startFrame");
                });
        var ok = MediaDevMasterSpec.parseMaster(Map.of("requestId", "r1", "stems",
                List.of(Map.of("artifactId", "a", "artifactVersionId", "v"))));
        assertThat(ok.targetLufs()).isEqualTo(-16.0);
        assertThat(ok.truePeakDbtp()).isEqualTo(-1.0);
    }

    @Test
    void strictWavParsingRejectsPartialFrames() {
        byte[] good = MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(RATE, 2, new short[200]));
        byte[] partial = java.util.Arrays.copyOf(good, good.length - 1);
        assertThat(MediaDevAudioWav.parse(partial, false).frames()).isEqualTo(99);
        assertThatThrownBy(() -> MediaDevAudioWav.parse(partial, true))
                .isInstanceOfSatisfying(MediaDevAudioWav.WavException.class, e -> assertThat(e.code()).isEqualTo("AUDIO_PARTIAL_FRAMES"));
        assertThat(MediaDevAudioWav.parse(good, true).frames()).isEqualTo(100);
    }

    private static int peak(short[] pcm) {
        int peak = 0;
        for (short s : pcm) peak = Math.max(peak, Math.abs((int) s));
        return peak;
    }


    // ------------------------------------------------------------------ composite peak guard (J-18 audio peak policy)

    @Test
    void peakGuardCapsAHotSumAtTheCeilingOnTheSamplesItHands() {
        int frames = 48_000;
        double[] l = sineBus(1000, 1.6, frames)[0];
        double[] r = sineBus(1000, 1.6, frames)[1];
        double before = MediaDevMasterDsp.truePeakDbtp(l, r);
        assertThat(before).isGreaterThan(-1.0);
        MediaDevMasterDsp.PeakGuarded guarded = MediaDevMasterDsp.truePeakGuard(l, r, -1.0);
        assertThat(guarded.honoured()).isTrue();
        assertThat(guarded.preTruePeakDbtp()).isCloseTo(before, org.assertj.core.data.Offset.offset(1e-9));
        // the verified peak is measured on the very samples handed back (float-representable), under the ceiling
        assertThat(MediaDevMasterDsp.truePeakDbtp(guarded.left(), guarded.right())).isLessThanOrEqualTo(-1.0);
        assertThat(guarded.postTruePeakDbtp()).isLessThanOrEqualTo(-1.0);
        assertThat(guarded.maxGainReductionDb()).isGreaterThan(4.0);
        assertThat(guarded.limitedFrames()).isPositive();
        assertThat(guarded.internalCeilingDbtp()).isLessThanOrEqualTo(-1.0);
    }

    @Test
    void peakGuardCapsTheIntersamplePeakThatTheSamplePeakMisses() {
        int frames = 4800;
        double[] l = new double[frames];
        double[] r = new double[frames];
        for (int n = 0; n < frames; n++) {
            l[n] = r[n] = 1.2 * Math.sin(2 * Math.PI * (RATE / 4.0) * n / RATE + Math.PI / 4);
        }
        double samplePeak = 20 * Math.log10(1.2 * Math.sqrt(0.5));
        MediaDevMasterDsp.PeakGuarded guarded = MediaDevMasterDsp.truePeakGuard(l, r, -1.0);
        assertThat(guarded.preTruePeakDbtp()).isGreaterThan(samplePeak + 2.5);
        assertThat(guarded.honoured()).isTrue();
        assertThat(MediaDevMasterDsp.truePeakDbtp(guarded.left(), guarded.right())).isLessThanOrEqualTo(-1.0);
    }

    @Test
    void peakGuardLeavesAQuietSumUntouchedSampleForSample() {
        int frames = 48_000;
        double[][] bus = sineBus(440, 0.3, frames);
        MediaDevMasterDsp.PeakGuarded guarded = MediaDevMasterDsp.truePeakGuard(bus[0], bus[1], -1.0);
        assertThat(guarded.honoured()).isTrue();
        assertThat(guarded.left()).isSameAs(bus[0]);
        assertThat(guarded.right()).isSameAs(bus[1]);
        assertThat(guarded.maxGainReductionDb()).isZero();
        assertThat(guarded.limitedFrames()).isZero();
        assertThat(guarded.postTruePeakDbtp()).isEqualTo(guarded.preTruePeakDbtp());
    }
}
