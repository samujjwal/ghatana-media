package com.ghatana.media.production.audio;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.audio.PcmStemMixer.AssetProvenance;
import com.ghatana.media.production.audio.PcmStemMixer.ErrorCode;
import com.ghatana.media.production.audio.PcmStemMixer.MixException;
import com.ghatana.media.production.audio.PcmStemMixer.MixResult;
import com.ghatana.media.production.audio.PcmStemMixer.MixSpec;
import com.ghatana.media.production.audio.PcmStemMixer.RightsDisposition;
import com.ghatana.media.production.audio.PcmStemMixer.RightsEvidence;
import com.ghatana.media.production.audio.PcmStemMixer.RightsPurpose;
import com.ghatana.media.production.audio.PcmStemMixer.Stem;
import com.ghatana.media.production.audio.PcmStemMixer.SyntheticProvenance;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.AbstractList;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import org.junit.jupiter.api.Test;

class PcmStemMixerTest {
    private static final int RATE = 48_000;
    private static final Instant NOW = Instant.parse("2026-11-05T20:00:00Z");
    private static final Clock CLOCK = Clock.fixed(NOW, ZoneOffset.UTC);
    private static final PcmStemMixer MIXER = new PcmStemMixer();

    @Test
    void preserves_stereo_channels_phase_and_source_buffers() {
        byte[] input = pcm(new short[] {10_000, 0, 0, -10_000, 10_000, 0, 0, -10_000});
        byte[] before = input.clone();
        Stem stem = synthetic("sine-left-right-v1", input, 4, 1.0f, 0.0f);
        input[0] = 0;
        byte[] accessorCopy = stem.pcmS16Le();
        accessorCopy[0] = 1;

        MixResult result = mix(List.of(stem), 4, 0.98f);
        assertThat(stem.pcmS16Le()).containsExactly(before);
        assertThat(samples(result.pcmS16Le())).containsExactly(10_000, 0, 0, -10_000, 10_000, 0, 0, -10_000);
    }

    @Test
    void applies_true_peak_ceiling_without_clipping_and_is_deterministic() {
        short[] loud = new short[400];
        for (int index = 0; index < loud.length; index++) loud[index] = (short) (index % 2 == 0 ? 30_000 : -30_000);
        Stem left = synthetic("program-a-v1", pcm(loud), loud.length / 2, 1.0f, 0.0f);
        Stem right = synthetic("program-b-v1", pcm(loud), loud.length / 2, 1.0f, 0.0f);

        MixResult first = mix(List.of(left, right), loud.length / 2, 0.7f);
        MixResult second = mix(List.of(left, right), loud.length / 2, 0.7f);

        assertThat(first.appliedMasterGain()).isLessThan(1.0f);
        assertThat(first.estimatedTruePeakAfterCeiling()).isLessThanOrEqualTo(0.7001);
        assertThat(first.samplePeakAfterCeiling()).isLessThanOrEqualTo(0.7);
        assertThat(first.wavSha256()).isEqualTo(second.wavSha256());
        assertThat(first.pcmSha256()).isEqualTo(second.pcmSha256());
        assertThat(first.sampleRate()).isEqualTo(RATE);
        assertThat(first.frameCount()).isEqualTo(loud.length / 2);
        assertThat(first.rmsDbfsAfterCeiling()).isEqualTo(second.rmsDbfsAfterCeiling());
        assertThat(first.wavSha256()).hasSize(64);
    }

    @Test
    void sub_lsb_peak_ceiling_does_not_round_output_above_the_requested_cap() {
        float ceiling = 0.00002f;
        Stem stem = synthetic("sub-lsb-ceiling-v1", pcm(new short[] {30_000, -30_000}), 1, 1.0f, 0.0f);

        MixResult result = mix(List.of(stem), 1, ceiling);

        assertThat(result.samplePeakAfterCeiling()).isLessThanOrEqualTo(ceiling);
        assertThat(result.estimatedTruePeakAfterCeiling()).isLessThanOrEqualTo(ceiling);
        assertThat(result.pcmS16Le()).containsOnly((byte) 0);

        short[] phaseShifted = new short[32];
        short[] cycle = {17_000, 17_000, -17_000, -17_000};
        for (int index = 0; index < phaseShifted.length; index++) phaseShifted[index] = cycle[index % cycle.length];
        float quantizedCeiling = 0.000035f;
        MixResult interSample = mix(List.of(synthetic("sub-lsb-phase-v1", pcm(phaseShifted),
                phaseShifted.length / 2, 1.0f, 0.0f)), phaseShifted.length / 2, quantizedCeiling);
        assertThat(interSample.samplePeakAfterCeiling()).isLessThanOrEqualTo(quantizedCeiling);
        assertThat(interSample.estimatedTruePeakAfterCeiling()).isLessThanOrEqualTo(quantizedCeiling);
        assertThat(interSample.pcmS16Le()).containsOnly((byte) 0);
    }

    @Test
    void limits_phase_shifted_inter_sample_overshoot_without_claiming_certified_true_peak() {
        // A phase-shifted quarter-cycle tone has sample values below its reconstructed
        // inter-sample crest. This exercises the bounded 4x estimate, not a standards
        // certified true-peak measurement.
        short[] tone = new short[128];
        short[] cycle = {17_000, 17_000, -17_000, -17_000};
        for (int index = 0; index < tone.length; index++) tone[index] = cycle[index % cycle.length];
        double inputSamplePeak = 17_000 / 32768.0;
        MixResult result = mix(List.of(synthetic("inter-sample-fixture-v1", pcm(tone),
                tone.length / 2, 1.0f, 0.0f)), tone.length / 2, 0.55f);

        assertThat(result.estimatedTruePeakBeforeCeiling()).isGreaterThan(inputSamplePeak);
        assertThat(result.estimatedTruePeakAfterCeiling()).isLessThanOrEqualTo(0.5501);
        assertThat(result.samplePeakAfterCeiling()).isLessThanOrEqualTo(0.55);
        assertThat(samples(result.pcmS16Le())).doesNotContain((short) Short.MIN_VALUE);
    }

    @Test
    void reports_stereo_rms_dbfs_and_exact_sample_clock() {
        // Both channels carry half-scale constant samples: RMS is 0.5, or approximately -6.02 dBFS.
        Stem stem = synthetic("half-scale-v1", pcm(new short[] {16_384, 16_384, 16_384, 16_384}),
                2, 1.0f, 0.0f);

        MixResult result = mix(List.of(stem), 2, 0.98f);

        assertThat(result.sampleRate()).isEqualTo(RATE);
        assertThat(result.frameCount()).isEqualTo(2);
        assertThat(result.rmsDbfsAfterCeiling()).isCloseTo(-6.0206, org.assertj.core.data.Offset.offset(0.001));
    }

    @Test
    void zero_gain_stem_has_no_pcm_effect_but_still_requires_rights_validation() {
        Stem audible = synthetic("audible-v1", pcm(new short[] {12_000, -9_000, 4_000, 6_000}),
                2, 0.75f, 0.0f);
        Stem muted = synthetic("muted-v1", pcm(new short[] {30_000, 30_000, -30_000, -30_000}),
                2, 0.0f, -1.0f);

        MixResult withoutMutedStem = mix(List.of(audible), 2, 0.98f);
        MixResult withMutedStem = mix(List.of(audible, muted), 2, 0.98f);

        assertThat(withMutedStem.pcmS16Le()).containsExactly(withoutMutedStem.pcmS16Le());
        assertThat(withMutedStem.wavSha256()).isEqualTo(withoutMutedStem.wavSha256());
        assertThat(withMutedStem.appliedMasterGain()).isEqualTo(withoutMutedStem.appliedMasterGain());

        Stem unlicensedMuted = new Stem("unlicensed-muted-v1", RATE, 2, 16,
                pcm(new short[] {30_000, 30_000, -30_000, -30_000}), 0.0f, 0.0f,
                new AssetProvenance("unlicensed-muted-v1", null));
        expect(ErrorCode.RIGHTS_MISSING, () -> mix(List.of(audible, unlicensedMuted), 2, 0.98f));
    }

    @Test
    void renders_decodable_wav_with_matching_pcm_checksum() throws Exception {
        short[] source = new short[] {1200, -1700, 4000, 3200, -500, 900};
        MixResult result = mix(List.of(synthetic("generated-foley-tone-v1", pcm(source), 3, 0.5f, 0)), 3, 0.95f);

        try (AudioInputStream decoded = AudioSystem.getAudioInputStream(new ByteArrayInputStream(result.wav()))) {
            assertThat(decoded.getFormat().getEncoding()).isEqualTo(javax.sound.sampled.AudioFormat.Encoding.PCM_SIGNED);
            assertThat(decoded.getFormat().getSampleRate()).isEqualTo((float) RATE);
            assertThat(decoded.getFormat().getFrameRate()).isEqualTo((float) RATE);
            assertThat(decoded.getFormat().getChannels()).isEqualTo(2);
            assertThat(decoded.getFormat().getSampleSizeInBits()).isEqualTo(16);
            assertThat(decoded.getFormat().getFrameSize()).isEqualTo(4);
            assertThat(decoded.getFormat().isBigEndian()).isFalse();
            assertThat(decoded.getFrameLength()).isEqualTo(result.frameCount());
            ByteArrayOutputStream decodedBytes = new ByteArrayOutputStream();
            decoded.transferTo(decodedBytes);
            assertThat(decodedBytes.toByteArray()).containsExactly(result.pcmS16Le());
            assertThat(decodedBytes.size()).isEqualTo(result.frameCount() * decoded.getFormat().getFrameSize());
        }
        assertThat(result.wavSha256()).hasSize(64);
    }

    @Test
    void silence_stays_silent_and_empty_or_malformed_requests_reject() {
        Stem silence = synthetic("silent-generator-v1", pcm(new short[8]), 4, 1.0f, 0.0f);
        MixResult result = mix(List.of(silence), 4, 0.98f);
        assertThat(result.appliedMasterGain()).isEqualTo(1.0f);
        assertThat(result.estimatedTruePeakAfterCeiling()).isZero();
        assertThat(result.rmsDbfsAfterCeiling()).isEqualTo(Double.NEGATIVE_INFINITY);
        assertThat(result.pcmS16Le()).containsOnly((byte) 0);

        expect(ErrorCode.RESOURCE_LIMIT, () -> mix(List.of(), 4, 0.98f));
        expect(ErrorCode.INVALID_INPUT, () -> mix(List.of(silence), 0, 0.98f));
        expect(ErrorCode.INVALID_INPUT, () -> mix(List.of(silence), 4, 0.99f + 0.001f));
        Stem badPan = synthetic("bad-pan-v1", pcm(new short[8]), 4, 1.0f, 1.01f);
        expect(ErrorCode.INVALID_INPUT, () -> mix(List.of(badPan), 4, 0.98f));
    }

    @Test
    void rejectsNonFiniteOrOutOfRangeStemGainBeforeMixing() {
        byte[] source = pcm(new short[] {12_000, -9_000, 4_000, 6_000});

        Stem notANumber = synthetic("gain-nan-v1", source, 2, Float.NaN, 0.0f);
        Stem infinite = synthetic("gain-infinite-v1", source, 2, Float.POSITIVE_INFINITY, 0.0f);
        Stem negativeInfinite = synthetic("gain-negative-infinite-v1", source, 2, Float.NEGATIVE_INFINITY, 0.0f);
        Stem negative = synthetic("gain-negative-v1", source, 2, -0.01f, 0.0f);
        Stem aboveMaximum = synthetic("gain-above-maximum-v1", source, 2, 4.01f, 0.0f);

        expect(ErrorCode.INVALID_INPUT, () -> mix(List.of(notANumber), 2, 0.98f));
        expect(ErrorCode.INVALID_INPUT, () -> mix(List.of(infinite), 2, 0.98f));
        expect(ErrorCode.INVALID_INPUT, () -> mix(List.of(negativeInfinite), 2, 0.98f));
        expect(ErrorCode.INVALID_INPUT, () -> mix(List.of(negative), 2, 0.98f));
        expect(ErrorCode.INVALID_INPUT, () -> mix(List.of(aboveMaximum), 2, 0.98f));
    }

    @Test
    void rejects_rate_layout_length_and_large_input_without_implicit_repair() {
        byte[] monoBytes = pcm(new short[] {1, 2, 3, 4});
        Stem wrongRate = new Stem("rate-v1", RATE / 2, 2, 16, monoBytes, 1, 0,
                syntheticProvenance("test-gen"));
        Stem wrongChannels = new Stem("mono-v1", RATE, 1, 16, monoBytes, 1, 0,
                syntheticProvenance("test-gen"));
        Stem wrongLength = synthetic("short-v1", pcm(new short[] {1, 2}), 1, 1, 0);
        expect(ErrorCode.FORMAT_MISMATCH, () -> mix(List.of(wrongRate), 2, 0.98f));
        expect(ErrorCode.FORMAT_MISMATCH, () -> mix(List.of(wrongChannels), 2, 0.98f));
        expect(ErrorCode.FORMAT_MISMATCH, () -> mix(List.of(wrongLength), 2, 0.98f));

        Stem maximumSingleStem = new Stem("maximum-single-stem-v1", RATE, 2, 16,
                new byte[PcmStemMixer.MAX_STEM_PCM_BYTES], 1, 0, syntheticProvenance("maximum-single-stem"));
        assertThat(maximumSingleStem.pcmS16Le()).hasSize(PcmStemMixer.MAX_STEM_PCM_BYTES);
        assertThatThrownBy(() -> new Stem("oversized-v1", RATE, 2, 16,
                new byte[PcmStemMixer.MAX_STEM_PCM_BYTES + 1], 1, 0,
                syntheticProvenance("test-gen")))
                .isInstanceOf(MixException.class)
                .extracting(error -> ((MixException) error).code()).isEqualTo(ErrorCode.RESOURCE_LIMIT);
        expect(ErrorCode.RESOURCE_LIMIT, () -> mix(List.of(synthetic("too-many-v1",
                pcm(new short[4]), PcmStemMixer.MAX_FRAMES + 1, 1, 0)), PcmStemMixer.MAX_FRAMES + 1, 0.98f));
    }

    @Test
    void asset_inputs_require_current_exact_purpose_bound_rights_evidence() {
        byte[] pcm = pcm(new short[] {4, 5, 6, 7});
        Stem paddedVersion = synthetic(" asset:v7", pcm, 2, 1, 0);
        expect(ErrorCode.INVALID_INPUT, () -> mix(List.of(paddedVersion), 2, 0.98f));

        Stem missing = new Stem("asset:v7", RATE, 2, 16, pcm, 1, 0,
                new AssetProvenance("asset:v7", null));
        expect(ErrorCode.RIGHTS_MISSING, () -> mix(List.of(missing), 2, 0.98f));

        Stem paddedSourceVersion = new Stem("asset:v7", RATE, 2, 16, pcm, 1, 0,
                new AssetProvenance(" asset:v7", evidence("asset:v7", NOW.minusSeconds(60), NOW.plusSeconds(60))));
        expect(ErrorCode.RIGHTS_MISSING, () -> mix(List.of(paddedSourceVersion), 2, 0.98f));
        Stem paddedDecisionRef = asset("asset:v7", new RightsEvidence("asset:v7", " rights:v9",
                RightsPurpose.PCM_STEM_MIX, RightsDisposition.CLEARED,
                NOW.minusSeconds(60), NOW.plusSeconds(60)));
        expect(ErrorCode.RIGHTS_MISSING, () -> mix(List.of(paddedDecisionRef), 2, 0.98f));

        Stem stale = asset("asset:v7", evidence("asset:v7", NOW.minusSeconds(60), NOW));
        expect(ErrorCode.RIGHTS_STALE, () -> mix(List.of(stale), 2, 0.98f));
        Stem wrongVersion = asset("asset:v7", evidence("asset:v6", NOW.minusSeconds(60), NOW.plusSeconds(60)));
        expect(ErrorCode.RIGHTS_MISSING, () -> mix(List.of(wrongVersion), 2, 0.98f));
        Stem evidenceForOtherStemVersion = new Stem("asset:v8", RATE, 2, 16, pcm,
                1, 0, new AssetProvenance("asset:v7",
                evidence("asset:v7", NOW.minusSeconds(60), NOW.plusSeconds(60))));
        expect(ErrorCode.RIGHTS_MISSING, () -> mix(List.of(evidenceForOtherStemVersion), 2, 0.98f));
        Stem denied = asset("asset:v7", new RightsEvidence("asset:v7", "rights:v9",
                RightsPurpose.PCM_STEM_MIX, RightsDisposition.DENIED,
                NOW.minusSeconds(60), NOW.plusSeconds(60)));
        expect(ErrorCode.RIGHTS_DENIED, () -> mix(List.of(denied), 2, 0.98f));

        Stem pending = asset("asset:v7", new RightsEvidence("asset:v7", "rights:v10",
                RightsPurpose.PCM_STEM_MIX, RightsDisposition.PENDING,
                NOW.minusSeconds(60), NOW.plusSeconds(60)));
        expect(ErrorCode.RIGHTS_DENIED, () -> mix(List.of(pending), 2, 0.98f));
        Stem wrongPurpose = asset("asset:v7", new RightsEvidence("asset:v7", "rights:v11",
                null, RightsDisposition.CLEARED, NOW.minusSeconds(60), NOW.plusSeconds(60)));
        expect(ErrorCode.RIGHTS_MISSING, () -> mix(List.of(wrongPurpose), 2, 0.98f));
        Stem notYetValid = asset("asset:v7", evidence("asset:v7", NOW.plusSeconds(1), NOW.plusSeconds(60)));
        expect(ErrorCode.RIGHTS_STALE, () -> mix(List.of(notYetValid), 2, 0.98f));
    }

    @Test
    void aggregate_stem_count_and_bytes_are_bounded() {
        List<Stem> stems = new ArrayList<>();
        byte[] oneFrame = pcm(new short[] {1, 1});
        for (int index = 0; index <= PcmStemMixer.MAX_STEMS; index++) {
            stems.add(synthetic("generated-" + index, oneFrame, 1, 1, 0));
        }
        expect(ErrorCode.RESOURCE_LIMIT, () -> mix(stems, 1, 0.98f));

        byte[] fourMegabytes = new byte[4_000_000];
        List<Stem> tooManyBytes = new ArrayList<>();
        for (int index = 0; index < 5; index++) {
            tooManyBytes.add(synthetic("large-generated-" + index, fourMegabytes, 1_000_000, 0, 0));
        }
        // Format length is valid; total bytes exceed the 16 MiB aggregate cap before mixing.
        expect(ErrorCode.RESOURCE_LIMIT, () -> mix(tooManyBytes, 1_000_000, 0.98f));
    }

    @Test
    void enforces_stem_count_while_consuming_a_list_with_inaccurate_size() {
        Stem stem = synthetic("bounded-list-v1", pcm(new short[] {1, 1}), 1, 1, 0);
        List<Stem> dishonestSize = new AbstractList<>() {
            private final List<Stem> actual = java.util.Collections.nCopies(
                    PcmStemMixer.MAX_STEMS + 1, stem);

            @Override
            public Stem get(int index) {
                return stem;
            }

            @Override
            public int size() {
                return 1;
            }

            @Override
            public Iterator<Stem> iterator() {
                return actual.iterator();
            }
        };

        expect(ErrorCode.RESOURCE_LIMIT, () -> mix(dishonestSize, 1, 0.98f));
    }

    @Test
    void mixes_every_accepted_stem_from_the_bounded_iterator_snapshot() {
        Stem first = synthetic("snapshot-first-v1", pcm(new short[] {1_000, 1_000}), 1, 1.0f, 0.0f);
        Stem second = synthetic("snapshot-second-v1", pcm(new short[] {2_000, 2_000}), 1, 1.0f, 0.0f);
        List<Stem> inaccurateSize = new AbstractList<>() {
            private final List<Stem> actual = List.of(first, second);
            @Override public Stem get(int index) { return actual.get(index); }
            @Override public int size() { return 1; }
            @Override public Iterator<Stem> iterator() { return actual.iterator(); }
        };

        assertThat(samples(mix(inaccurateSize, 1, 0.98f).pcmS16Le()))
                .containsExactly((short) 3_000, (short) 3_000);
    }

    private static MixResult mix(List<Stem> stems, int frames, float ceiling) {
        return MIXER.mix(stems, new MixSpec(RATE, frames, ceiling), CLOCK);
    }

    private static Stem synthetic(String id, byte[] pcm, int frames, float gain, float pan) {
        return new Stem(id, RATE, 2, 16, pcm, gain, pan, syntheticProvenance(id));
    }

    private static SyntheticProvenance syntheticProvenance(String id) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(id.getBytes(StandardCharsets.UTF_8));
            return new SyntheticProvenance("test-tone", "1", "sha256:" + HexFormat.of().formatHex(digest));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("JDK SHA-256 is unavailable", impossible);
        }
    }

    private static Stem asset(String version, RightsEvidence evidence) {
        return new Stem(version, RATE, 2, 16, pcm(new short[] {4, 5, 6, 7}), 1, 0,
                new AssetProvenance(version, evidence));
    }

    private static RightsEvidence evidence(String version, Instant from, Instant until) {
        return new RightsEvidence(version, "rights:v9", RightsPurpose.PCM_STEM_MIX,
                RightsDisposition.CLEARED, from, until);
    }

    private static byte[] pcm(short[] samples) {
        byte[] output = new byte[samples.length * 2];
        for (int index = 0; index < samples.length; index++) {
            output[index * 2] = (byte) samples[index];
            output[index * 2 + 1] = (byte) (samples[index] >>> 8);
        }
        return output;
    }

    private static short[] samples(byte[] pcm) {
        short[] output = new short[pcm.length / 2];
        for (int index = 0; index < output.length; index++) {
            output[index] = (short) ((pcm[index * 2] & 0xff) | (pcm[index * 2 + 1] << 8));
        }
        return output;
    }

    private static void expect(ErrorCode code, Runnable operation) {
        assertThatThrownBy(operation::run).isInstanceOf(MixException.class)
                .extracting(error -> ((MixException) error).code()).isEqualTo(code);
    }
}
