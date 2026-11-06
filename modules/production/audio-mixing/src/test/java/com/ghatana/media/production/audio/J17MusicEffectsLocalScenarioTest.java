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
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.List;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import org.junit.jupiter.api.Test;

/**
 * Bounded, source-free J-17 DSP scenario using the existing local mixer API.
 * The generated samples are test fixtures, not licensed music/Foley or a
 * production master. This exercises a transient in-memory render only: the
 * PDP-3 step remains eligibility-only, dispatch NEVER, and runtime NOT_ADMITTED.
 * PcmStemMixer has no actor-authority API, so this test exercises its typed
 * rights denial and does not claim to prove actor/capability authorization.
 */
class J17MusicEffectsLocalScenarioTest {
    private static final int SAMPLE_RATE = 48_000;
    private static final int FRAMES = 128;
    private static final float CEILING = 0.70f;
    private static final Instant NOW = Instant.parse("2026-11-05T20:00:00Z");
    private static final Clock CLOCK = Clock.fixed(NOW, ZoneOffset.UTC);
    private static final PcmStemMixer MIXER = new PcmStemMixer();

    @Test
    void synthetic_mix_is_bounded_playable_and_denied_asset_produces_no_result() throws Exception {
        short[] loudSamples = new short[FRAMES * 2];
        for (int frame = 0; frame < FRAMES; frame++) {
            short value = (short) (frame % 2 == 0 ? 30_000 : -30_000);
            loudSamples[frame * 2] = value;
            loudSamples[frame * 2 + 1] = value;
        }
        Stem musicFixture = synthetic("fixture-music", pcm(loudSamples), 0.8f, -0.25f);
        Stem foleyFixture = synthetic("fixture-foley", pcm(loudSamples), 0.8f, 0.25f);

        MixResult result = MIXER.mix(List.of(musicFixture, foleyFixture),
                new MixSpec(SAMPLE_RATE, FRAMES, CEILING), CLOCK);

        assertThat(result.sampleRate()).isEqualTo(SAMPLE_RATE);
        assertThat(result.frameCount()).isEqualTo(FRAMES);
        assertThat(result.estimatedTruePeakAfterCeiling()).isLessThanOrEqualTo(CEILING + 0.0001);
        assertThat(result.samplePeakAfterCeiling()).isLessThanOrEqualTo(CEILING);
        assertThat(result.wavSha256()).hasSize(64);
        try (AudioInputStream decoded = AudioSystem.getAudioInputStream(new ByteArrayInputStream(result.wav()))) {
            assertThat(decoded.getFormat().getSampleRate()).isEqualTo((float) SAMPLE_RATE);
            assertThat(decoded.getFormat().getChannels()).isEqualTo(2);
            assertThat(decoded.getFormat().getSampleSizeInBits()).isEqualTo(16);
            ByteArrayOutputStream decodedPcm = new ByteArrayOutputStream();
            decoded.transferTo(decodedPcm);
            assertThat(decodedPcm.toByteArray()).containsExactly(result.pcmS16Le());
        }

        // Denied source rights fail before the mixer can return bytes.
        MixResult deniedResult = null;
        Stem deniedAsset = deniedAsset();
        try {
            deniedResult = MIXER.mix(List.of(deniedAsset),
                    new MixSpec(SAMPLE_RATE, 2, CEILING), CLOCK);
        } catch (MixException denied) {
            assertThat(denied.code()).isEqualTo(ErrorCode.RIGHTS_DENIED);
        }
        assertThat(deniedResult).isNull();

        assertThatThrownBy(() -> MIXER.mix(List.of(musicFixture),
                new MixSpec(SAMPLE_RATE, FRAMES, 0.981f), CLOCK))
                .isInstanceOf(MixException.class)
                .extracting(error -> ((MixException) error).code())
                .isEqualTo(ErrorCode.INVALID_INPUT);
    }

    @Test
    void unknown_or_malformed_later_asset_rights_return_no_partial_mix_result() throws Exception {
        Stem validFixture = synthetic("fixture-before-rights-check", pcm(new short[] {1_000, 1_000}), 1.0f, 0.0f);
        String sourceVersion = "fixture-source:v7";
        RightsEvidence unknown = new RightsEvidence(sourceVersion, "fixture-rights-unknown:v1",
                RightsPurpose.PCM_STEM_MIX, RightsDisposition.UNKNOWN,
                NOW.minusSeconds(60), NOW.plusSeconds(60));
        Stem unknownRightsAsset = new Stem(sourceVersion, SAMPLE_RATE, 2, 16,
                pcm(new short[] {2_000, 2_000}), 1.0f, 0.0f,
                new AssetProvenance(sourceVersion, unknown));

        assertNoResultOnFailure(List.of(validFixture, unknownRightsAsset), ErrorCode.RIGHTS_DENIED);

        // The evidence object is present and nominally cleared, but its source-version
        // binding is malformed. A valid preceding stem must not produce a partial mix.
        RightsEvidence wrongVersion = new RightsEvidence("fixture-source:v6", "fixture-rights:v1",
                RightsPurpose.PCM_STEM_MIX, RightsDisposition.CLEARED,
                NOW.minusSeconds(60), NOW.plusSeconds(60));
        Stem malformedRightsAsset = new Stem(sourceVersion, SAMPLE_RATE, 2, 16,
                pcm(new short[] {2_000, 2_000}), 1.0f, 0.0f,
                new AssetProvenance(sourceVersion, wrongVersion));

        assertNoResultOnFailure(List.of(validFixture, malformedRightsAsset), ErrorCode.RIGHTS_MISSING);
    }

    private static void assertNoResultOnFailure(List<Stem> stems, ErrorCode expectedCode) {
        MixResult result = null;
        MixException observedFailure = null;
        try {
            result = MIXER.mix(stems, new MixSpec(SAMPLE_RATE, 1, CEILING), CLOCK);
        } catch (MixException failure) {
            observedFailure = failure;
        }
        assertThat(observedFailure).as("invalid or unknown rights must fail closed").isNotNull();
        assertThat(observedFailure.code()).isEqualTo(expectedCode);
        assertThat(result).as("a failed mix must not expose partial PCM or WAV bytes").isNull();
    }

    private static Stem synthetic(String id, byte[] pcm, float gain, float pan) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(id.getBytes(StandardCharsets.UTF_8));
        SyntheticProvenance provenance = new SyntheticProvenance(
                "j17-test-waveform", "1", "sha256:" + HexFormat.of().formatHex(digest));
        return new Stem(id, SAMPLE_RATE, 2, 16, pcm, gain, pan, provenance);
    }

    private static Stem deniedAsset() {
        String version = "fixture-source:v1";
        RightsEvidence denial = new RightsEvidence(version, "fixture-denial:v1",
                RightsPurpose.PCM_STEM_MIX, RightsDisposition.DENIED,
                NOW.minusSeconds(60), NOW.plusSeconds(60));
        return new Stem(version, SAMPLE_RATE, 2, 16, pcm(new short[] {1, 1, 2, 2}), 1.0f, 0.0f,
                new AssetProvenance(version, denial));
    }

    private static byte[] pcm(short[] samples) {
        byte[] output = new byte[samples.length * 2];
        for (int index = 0; index < samples.length; index++) {
            output[index * 2] = (byte) samples[index];
            output[index * 2 + 1] = (byte) (samples[index] >>> 8);
        }
        return output;
    }
}
