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
import java.util.HexFormat;
import java.util.ArrayList;
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
        assertThat(first.wavSha256()).hasSize(64);
    }

    @Test
    void renders_decodable_wav_with_matching_pcm_checksum() throws Exception {
        short[] source = new short[] {1200, -1700, 4000, 3200, -500, 900};
        MixResult result = mix(List.of(synthetic("generated-foley-tone-v1", pcm(source), 3, 0.5f, 0)), 3, 0.95f);

        try (AudioInputStream decoded = AudioSystem.getAudioInputStream(new ByteArrayInputStream(result.wav()))) {
            assertThat(decoded.getFormat().getSampleRate()).isEqualTo((float) RATE);
            assertThat(decoded.getFormat().getChannels()).isEqualTo(2);
            assertThat(decoded.getFormat().getSampleSizeInBits()).isEqualTo(16);
            ByteArrayOutputStream decodedBytes = new ByteArrayOutputStream();
            decoded.transferTo(decodedBytes);
            assertThat(decodedBytes.toByteArray()).containsExactly(result.pcmS16Le());
        }
        assertThat(result.wavSha256()).hasSize(64);
    }

    @Test
    void silence_stays_silent_and_empty_or_malformed_requests_reject() {
        Stem silence = synthetic("silent-generator-v1", pcm(new short[8]), 4, 1.0f, 0.0f);
        MixResult result = mix(List.of(silence), 4, 0.98f);
        assertThat(result.appliedMasterGain()).isEqualTo(1.0f);
        assertThat(result.estimatedTruePeakAfterCeiling()).isZero();
        assertThat(result.pcmS16Le()).containsOnly((byte) 0);

        expect(ErrorCode.RESOURCE_LIMIT, () -> mix(List.of(), 4, 0.98f));
        expect(ErrorCode.INVALID_INPUT, () -> mix(List.of(silence), 0, 0.98f));
        expect(ErrorCode.INVALID_INPUT, () -> mix(List.of(silence), 4, 0.99f + 0.001f));
        Stem badPan = synthetic("bad-pan-v1", pcm(new short[8]), 4, 1.0f, 1.01f);
        expect(ErrorCode.INVALID_INPUT, () -> mix(List.of(badPan), 4, 0.98f));
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

        assertThatThrownBy(() -> new Stem("oversized-v1", RATE, 2, 16,
                new byte[PcmStemMixer.MAX_AGGREGATE_INPUT_BYTES + 1], 1, 0,
                syntheticProvenance("test-gen")))
                .isInstanceOf(MixException.class)
                .extracting(error -> ((MixException) error).code()).isEqualTo(ErrorCode.RESOURCE_LIMIT);
        expect(ErrorCode.RESOURCE_LIMIT, () -> mix(List.of(synthetic("too-many-v1",
                pcm(new short[4]), PcmStemMixer.MAX_FRAMES + 1, 1, 0)), PcmStemMixer.MAX_FRAMES + 1, 0.98f));
    }

    @Test
    void asset_inputs_require_current_exact_purpose_bound_rights_evidence() {
        byte[] pcm = pcm(new short[] {4, 5, 6, 7});
        Stem missing = new Stem("asset:v7", RATE, 2, 16, pcm, 1, 0,
                new AssetProvenance("asset:v7", null));
        expect(ErrorCode.RIGHTS_MISSING, () -> mix(List.of(missing), 2, 0.98f));

        Stem stale = asset("asset:v7", evidence("asset:v7", NOW.minusSeconds(60), NOW));
        expect(ErrorCode.RIGHTS_STALE, () -> mix(List.of(stale), 2, 0.98f));
        Stem wrongVersion = asset("asset:v7", evidence("asset:v6", NOW.minusSeconds(60), NOW.plusSeconds(60)));
        expect(ErrorCode.RIGHTS_MISSING, () -> mix(List.of(wrongVersion), 2, 0.98f));
        Stem denied = asset("asset:v7", new RightsEvidence("asset:v7", "rights:v9",
                RightsPurpose.PCM_STEM_MIX, RightsDisposition.DENIED,
                NOW.minusSeconds(60), NOW.plusSeconds(60)));
        expect(ErrorCode.RIGHTS_DENIED, () -> mix(List.of(denied), 2, 0.98f));
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
