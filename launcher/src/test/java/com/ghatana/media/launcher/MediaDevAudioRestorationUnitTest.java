package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevAudioRestorationRuntime.AudioRefusedException;
import com.ghatana.media.launcher.MediaDevAudioRestorationRuntime.Declip;
import com.ghatana.media.launcher.MediaDevAudioRestorationRuntime.Dehum;
import com.ghatana.media.launcher.MediaDevAudioRestorationRuntime.Denoise;
import com.ghatana.media.launcher.MediaDevAudioRestorationRuntime.Normalize;
import com.ghatana.media.launcher.MediaDevAudioRestorationRuntime.Operations;
import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Pure-Java checks of the J-07 audio lane: typed operations, WAV parsing, metric math and verdict honesty. */
class MediaDevAudioRestorationUnitTest {
    private static final int RATE = 16_000;

    private static MediaDevAudioWav.Pcm tone(double hz, double amplitude, int frames) {
        short[] samples = new short[frames];
        for (int i = 0; i < frames; i++) samples[i] = (short) Math.round(amplitude * Math.sin(2 * Math.PI * hz * i / RATE));
        return new MediaDevAudioWav.Pcm(RATE, 1, samples);
    }

    private static MediaDevAudioWav.Pcm white(double sigma, int frames, long seed) {
        Random random = new Random(seed);
        short[] samples = new short[frames];
        for (int i = 0; i < frames; i++) samples[i] = (short) Math.round(random.nextGaussian() * sigma);
        return new MediaDevAudioWav.Pcm(RATE, 1, samples);
    }

    private static MediaDevAudioWav.Pcm add(MediaDevAudioWav.Pcm a, MediaDevAudioWav.Pcm b) {
        short[] x = a.samples();
        short[] y = b.samples();
        short[] out = new short[x.length];
        for (int i = 0; i < x.length; i++) out[i] = (short) (x[i] + y[i]);
        return new MediaDevAudioWav.Pcm(a.sampleRate(), a.channels(), out);
    }

    // ---- typed operations ----

    @Test
    void operationsAreBoundedAndTypedAndNormalizationIsOffUnlessRequested() {
        Operations denoiseOnly = new Operations(null, null, new Denoise(12, -50, true), null);
        assertThat(denoiseOnly.filterGraph(24_000, 234_000)).doesNotContain("loudnorm")
                .contains("apad=pad_len=600,afftdn=nr=12.0:nf=-50.0:tn=1,atrim=start_sample=600")
                .endsWith("aformat=sample_fmts=s16,apad=whole_len=234000,atrim=end_sample=234000");
        assertThat(denoiseOnly.view().get("normalize")).isEqualTo(java.util.Map.of("enabled", false));
        Operations all = new Operations(new Declip(10), new Dehum(50), new Denoise(20, -40, false), new Normalize(-16));
        String graph = all.filterGraph(48_000, 96_000);
        assertThat(graph).startsWith("adeclip=threshold=10:window=55:overlap=75:method=a,bandreject=f=50:t=q:w=30,"
                + "bandreject=f=100:t=q:w=30,bandreject=f=150:t=q:w=30,apad=pad_len=1200,afftdn=nr=20.0:nf=-40.0:tn=0")
                .contains("loudnorm=I=-16.0:TP=-1.5:LRA=11,aresample=48000");
        assertThat(new Operations(null, new Dehum(60), null, null).filterGraph(RATE, 10)).contains("bandreject=f=180:t=q:w=30");
        assertThat(all.canonical()).isEqualTo(
                "declip(threshold=10);dehum(frequencyHz=50);denoise(reductionDb=20.0,noiseFloorDb=-40.0,trackNoise=false);"
                        + "normalize(targetLufs=-16.0);");
    }

    @Test
    void invalidParametersAreRefusedWithATypedCode() {
        for (Runnable invalid : new Runnable[] {
                () -> new Operations(null, null, null, null),
                () -> new Declip(0), () -> new Declip(101), () -> new Dehum(55), () -> new Dehum(0),
                () -> new Denoise(0.5, -50, true), () -> new Denoise(41, -50, true), () -> new Denoise(12, -10, true),
                () -> new Denoise(12, -90, true), () -> new Denoise(Double.NaN, -50, true),
                () -> new Denoise(12, Double.POSITIVE_INFINITY, true), () -> new Normalize(-9), () -> new Normalize(-31) }) {
            assertThatThrownBy(invalid::run).isInstanceOf(AudioRefusedException.class)
                    .extracting(e -> ((AudioRefusedException) e).code()).isEqualTo("AUDIO_PARAMETERS_INVALID");
        }
        assertThat(new Denoise(1, -80, false)).isNotNull();
        assertThat(new Denoise(40, -20, true)).isNotNull();
        assertThat(new Declip(1)).isNotNull();
        assertThat(new Declip(100)).isNotNull();
    }

    @Test
    void graphNeverCarriesCallerTextBecauseOnlyValidatedNumbersAreFormatted() {
        Operations ops = new Operations(new Declip(7), new Dehum(60), new Denoise(33.3, -41.7, true), new Normalize(-23.5));
        assertThat(ops.filterGraph(44_100, 1)).matches("[a-z0-9=:.,_\\-A-Z]+");
    }

    // ---- WAV ----

    @Test
    void wavRoundTripsAndRefusesUnsupportedFormats() {
        MediaDevAudioWav.Pcm pcm = tone(440, 8000, 1600);
        assertThat(MediaDevAudioWav.parse(MediaDevAudioWav.write(pcm))).isEqualTo(pcm);
        byte[] bad = MediaDevAudioWav.write(pcm);
        bad[20] = 3; // IEEE float
        assertThatThrownBy(() -> MediaDevAudioWav.parse(bad)).isInstanceOf(MediaDevAudioWav.WavException.class)
                .extracting(e -> ((MediaDevAudioWav.WavException) e).code()).isEqualTo("AUDIO_FORMAT_NOT_SUPPORTED");
        assertThatThrownBy(() -> MediaDevAudioWav.parse(new byte[100])).isInstanceOf(MediaDevAudioWav.WavException.class);
        byte[] lowRate = MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(4000, 1, new short[100]));
        assertThatThrownBy(() -> MediaDevAudioWav.parse(lowRate)).isInstanceOf(MediaDevAudioWav.WavException.class);
    }

    @Test
    void rustFloatCandidateIsStrictlyQuantizedToTheExistingPcm16ComparisonFormat() {
        byte[] floatWav = rustFloatWav(16_000, 1, new float[] {-1.0f, -0.5f, 0.0f, 0.5f, 1.0f});
        MediaDevAudioWav.Pcm pcm = MediaDevAudioWav.parseRustFloat32Candidate(floatWav);
        assertThat(pcm.sampleRate()).isEqualTo(16_000);
        assertThat(pcm.channels()).isEqualTo(1);
        assertThat(pcm.samples()).containsExactly(Short.MIN_VALUE, -16_384, 0, 16_384, Short.MAX_VALUE);
        byte[] wrongSubtype = floatWav.clone();
        wrongSubtype[44] ^= 1;
        assertThatThrownBy(() -> MediaDevAudioWav.parseRustFloat32Candidate(wrongSubtype))
                .isInstanceOf(MediaDevAudioWav.WavException.class)
                .extracting(e -> ((MediaDevAudioWav.WavException) e).code()).isEqualTo("AUDIO_FORMAT_NOT_SUPPORTED");
        assertThatThrownBy(() -> MediaDevAudioWav.parseRustFloat32Candidate(
                java.util.Arrays.copyOf(floatWav, floatWav.length - 1))).isInstanceOf(MediaDevAudioWav.WavException.class);
    }

    @Test
    void rmsGateRangeAndProfileAreFixedAndPolicyFingerprintEncodingIsUnambiguous() {
        assertThat(new MediaDevAudioRestorationRuntime.NoiseRange(0, 2_000_000).endFrame()).isEqualTo(2_000_000);
        for (long[] invalid : new long[][] {{0, 0}, {3, 2}, {0, 2_000_001}, {-1, 3}}) {
            assertThatThrownBy(() -> new MediaDevAudioRestorationRuntime.NoiseRange(invalid[0], invalid[1]))
                    .isInstanceOf(MediaDevAudioRestorationRuntime.AudioRefusedException.class)
                    .extracting(e -> ((MediaDevAudioRestorationRuntime.AudioRefusedException) e).code())
                    .isEqualTo("AUDIO_PARAMETERS_INVALID");
        }
        assertThatThrownBy(() -> new MediaDevAudioRestorationRuntime.NoiseParameters(
                new MediaDevAudioRestorationRuntime.NoiseRange(0, 1), "OTHER_PROFILE"))
                .isInstanceOf(MediaDevAudioRestorationRuntime.AudioRefusedException.class);
        var policyA = new MediaDevAudioRestorationRuntime.NoisePolicy(null, java.util.List.of("a,b", "c"), null, null, null);
        var policyB = new MediaDevAudioRestorationRuntime.NoisePolicy(null, java.util.List.of("a", "b,c"), null, null, null);
        assertThat(policyA.canonical()).isNotEqualTo(policyB.canonical());
    }

    private static byte[] rustFloatWav(int sampleRate, int channels, float[] samples) {
        int length = 68 + samples.length * Float.BYTES;
        ByteBuffer out = ByteBuffer.allocate(length).order(ByteOrder.LITTLE_ENDIAN);
        out.putInt(0x46464952).putInt(length - 8).putInt(0x45564157);
        out.putInt(0x20746d66).putInt(40).putShort((short) 0xfffe).putShort((short) channels)
                .putInt(sampleRate).putInt(sampleRate * channels * Float.BYTES)
                .putShort((short) (channels * Float.BYTES)).putShort((short) 32).putShort((short) 22)
                .putShort((short) 32).putInt(channels == 1 ? 1 : 3)
                .put(new byte[] {3, 0, 0, 0, 0, 0, 16, 0, (byte) 128, 0, 0, (byte) 170, 0, 56, (byte) 155, 113});
        out.putInt(0x61746164).putInt(samples.length * Float.BYTES);
        for (float sample : samples) out.putFloat(sample);
        return out.array();
    }

    // ---- metrics ----

    @Test
    void snrMatchesTheDefinitionAndIsNullWithoutReferenceEnergy() {
        MediaDevAudioWav.Pcm clean = tone(300, 10_000, 16_000);
        MediaDevAudioWav.Pcm noise = white(1000, 16_000, 1);
        // tone power = A^2/2 = 5e7; noise power ~ 1e6: about 17 dB.
        Double snr = MediaDevAudioMetrics.snrDb(add(clean, noise), clean);
        assertThat(snr).isBetween(16.0, 18.0);
        assertThat(MediaDevAudioMetrics.snrDb(new MediaDevAudioWav.Pcm(RATE, 1, new short[16_000]), new MediaDevAudioWav.Pcm(RATE, 1, new short[16_000]))).isNull();
        assertThat(MediaDevAudioMetrics.snrDb(clean, clean)).isEqualTo(Double.POSITIVE_INFINITY);
        assertThat(MediaDevAudioMetrics.segmentalSnrDb(add(clean, noise), clean)).isBetween(15.0, 19.0);
        assertThatThrownBy(() -> MediaDevAudioMetrics.snrDb(clean, tone(300, 1, 10)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void clippingIsCountedAsFlatTopPlateauOnly() {
        MediaDevAudioWav.Pcm clean = tone(200, 20_000, 16_000);
        short[] clipped = clean.samples();
        for (int i = 0; i < clipped.length; i++) clipped[i] = (short) Math.max(-12_000, Math.min(12_000, clipped[i]));
        assertThat(MediaDevAudioMetrics.clippedSamples(clean)).isZero();
        assertThat(MediaDevAudioMetrics.clippedSamples(new MediaDevAudioWav.Pcm(RATE, 1, clipped))).isGreaterThan(1000);
        // digital silence is a plateau of zeros but is not clipping
        assertThat(MediaDevAudioMetrics.clippedSamples(new MediaDevAudioWav.Pcm(RATE, 1, new short[16_000]))).isZero();
    }

    @Test
    void noiseFloorFlatnessSeparatesWhiteNoiseFromHumAndTracksLevel() {
        MediaDevAudioWav.Pcm noise = white(300, 64_000, 3);
        MediaDevAudioWav.Pcm hum = tone(50, 400, 64_000);
        var whiteFloor = MediaDevAudioMetrics.noiseFloor(noise);
        var humFloor = MediaDevAudioMetrics.noiseFloor(hum);
        assertThat(whiteFloor.spectralFlatness()).isGreaterThan(0.5);
        assertThat(humFloor.spectralFlatness()).isLessThan(0.05);
        assertThat(MediaDevAudioMetrics.noiseFloor(white(30, 64_000, 3)).rmsDbfs()).isLessThan(whiteFloor.rmsDbfs() - 15);
        assertThat(MediaDevAudioMetrics.noiseFloor(tone(50, 400, 500))).isNull();
    }

    @Test
    void wordErrorRateIsAnEditDistanceOverLowercasedWords() {
        assertThat(MediaDevAudioMetrics.wordErrorRate("The quick brown fox.", "the quick brown fox")).isZero();
        assertThat(MediaDevAudioMetrics.wordErrorRate("the quick brown fox", "the slow brown fox")).isEqualTo(0.25);
        assertThat(MediaDevAudioMetrics.wordErrorRate("a b", "")).isEqualTo(1.0);
        assertThat(MediaDevAudioMetrics.wordErrorRate("", "anything")).isNull();
    }

    // ---- verdict honesty ----

    @Test
    void verdictNeverClaimsImprovementWithoutAReferenceOrAgainstTheNumbers() {
        assertThat(MediaDevAudioRestorationRuntime.verdict(null, null, -5, -10.0, false).get("overall"))
                .isEqualTo("NOT_MEASURED_AGAINST_REFERENCE");
        assertThat(MediaDevAudioRestorationRuntime.verdict(2.0, 1.5, -300, -12.0, true).get("overall")).isEqualTo("IMPROVED");
        assertThat(MediaDevAudioRestorationRuntime.verdict(-2.0, -1.5, 0, 0.0, true).get("overall")).isEqualTo("DEGRADED");
        assertThat(MediaDevAudioRestorationRuntime.verdict(0.1, -0.1, 0, 0.0, true).get("overall")).isEqualTo("NO_MEASURABLE_CHANGE");
        assertThat(MediaDevAudioRestorationRuntime.verdict(3.0, -1.0, 0, 0.0, true).get("overall")).isEqualTo("MIXED");
        var verdict = MediaDevAudioRestorationRuntime.verdict(-3.0, -3.0, 40, 6.0, true);
        assertThat(verdict.get("clipping")).isEqualTo("INCREASED");
        assertThat(verdict.get("noiseFloorLevel")).isEqualTo("HIGHER");
        assertThat(verdict.get("snr")).isEqualTo("DEGRADED");
    }
}
