package com.ghatana.media.tts.engine.onnx;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.tts.api.SynthesisOptions;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import com.ghatana.media.tts.phoneme.PiperPhonemizeProcessConverter;
import com.ghatana.media.tts.phoneme.TextToPhonemeConverter;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Opt-in real Piper synthesis: pinned CC BY 4.0 LibriTTS-R voice model, exact
 * sidecar, and canonical espeak-ng phonemization via the pinned
 * piper_phonemize binary. Proves real decodable 22,050 Hz PCM, exact phoneme
 * symbol coverage against the sidecar map, and engine honesty — not voice
 * likeness consent or production voice admission.
 */
class PiperOnnxEngineRealSynthesisTest {

    private static final String MODEL_ENV = "GHATANA_MEDIA_PIPER_VOICE_MODEL";
    private static final String MODEL_SHA256 =
            "10bb85e071d616fcf4071f369f1799d0491492ab3c5d552ec19fb548fac13195";
    private static final String SIDECAR_SHA256 =
            "b471dc60d2d8335e819c393d196d6fbf792817f40051257b269878505bc9afb3";
    private static final String PHONEMIZE_SHA256 =
            "9c38ce2ccd2329d049ee54550c12d43153883df4902ff685290b066e0380a2ad";
    private static final int VOICE_SAMPLE_RATE = 22_050;

    @Test
    void canonicalPhonemizationUsesOnlySidecarMappedSymbols() throws Exception {
        Optional<TextToPhonemeConverter> created = phonemizeConverter();
        assertThat(created).isPresent();
        TextToPhonemeConverter converter = created.get();
        assertThat(converter.qualityTier()).isEqualTo(10);
        String phonemes = converter.convert("Hello world.", Locale.ENGLISH);
        assertThat(phonemes).isNotBlank();
        var sidecar = sidecarMap();
        for (String symbol : phonemes.split("")) {
            if (symbol.isBlank()) continue;
            assertThat(sidecar.containsKey(symbol))
                    .as("phoneme symbol %s must exist in the voice sidecar map", symbol)
                    .isTrue();
        }
    }

    @Test
    void pinnedVoiceSynthesizesRealDecodablePcm() throws Exception {
        Path model = pinnedModel();
        Path sidecar = model.resolveSibling(model.getFileName() + ".json");
        assertThat(sha256(sidecar)).isEqualTo(SIDECAR_SHA256);

        TtsConfig config = TtsConfig.builder()
                .voiceModelPath(model)
                .defaultVoiceId("en_US-libritts_r-medium")
                .availableVoices(List.of("en_US-libritts_r-medium"))
                .sampleRate(VOICE_SAMPLE_RATE)
                .maxConcurrentRequests(2)
                .enableProsody(false)
                .enableVoiceCloning(false)
                .enableStreaming(true)
                .build();

        try (PiperOnnxEngine engine = new PiperOnnxEngine(config, new AudioVideoLibrary.LibraryState())) {
            AudioData audio = engine.synthesize("Hello world.", SynthesisOptions.defaults());
            assertThat(audio).isNotNull();
            assertThat(audio.sampleRate()).isEqualTo(VOICE_SAMPLE_RATE);
            assertThat(audio.channels()).isEqualTo(1);
            assertThat(audio.bitsPerSample()).isEqualTo(16);
            assertThat(audio.data().length).isGreaterThan(VOICE_SAMPLE_RATE / 4);
            ByteBuffer pcm = ByteBuffer.wrap(audio.data()).order(ByteOrder.LITTLE_ENDIAN);
            int nonZero = 0;
            int peak = 0;
            while (pcm.remaining() >= 2) {
                int sample = pcm.getShort();
                peak = Math.max(peak, Math.abs(sample));
                if (sample != 0) nonZero++;
            }
            assertThat(nonZero).as("synthesized PCM must contain real samples")
                    .isGreaterThan(VOICE_SAMPLE_RATE / 10);
            assertThat(peak).as("synthesized PCM must be non-silent").isGreaterThan(100);
            double seconds = audio.data().length / 2.0 / VOICE_SAMPLE_RATE;
            System.out.printf("PIPER_REAL_SYNTH voice=en_US-libritts_r-medium license=CC-BY-4.0 "
                            + "modelSha256=%s sidecarSha256=%s phonemizerSha256=%s "
                            + "sampleRate=%d pcmSeconds=%.3f peak=%d nonZeroSamples=%d%n",
                    MODEL_SHA256, SIDECAR_SHA256, PHONEMIZE_SHA256,
                    VOICE_SAMPLE_RATE, seconds, peak, nonZero);
        }
    }

    private static Optional<TextToPhonemeConverter> phonemizeConverter() throws Exception {
        String configured = System.getenv(PiperPhonemizeProcessConverter.PHONEMIZE_ENV);
        Assumptions.assumeTrue(configured != null && !configured.isBlank(),
                "set " + PiperPhonemizeProcessConverter.PHONEMIZE_ENV
                        + " to the pinned piper_phonemize binary");
        Path binary = Path.of(configured).toRealPath();
        assertThat(sha256(binary)).isEqualTo(PHONEMIZE_SHA256);
        return PiperPhonemizeProcessConverter.tryCreate(binary);
    }

    private static Path pinnedModel() throws Exception {
        String configured = System.getenv(MODEL_ENV);
        Assumptions.assumeTrue(configured != null && !configured.isBlank(),
                "set " + MODEL_ENV + " to the pinned CC BY 4.0 Piper voice model");
        Path model = Path.of(configured).toRealPath();
        assertThat(sha256(model)).isEqualTo(MODEL_SHA256);
        // The phonemizer must be present for a real synthesis; fail loudly otherwise.
        phonemizeConverter().orElseThrow(() -> new IllegalStateException("phonemizer missing"));
        return model;
    }

    private static java.util.Map<String, ?> sidecarMap() throws Exception {
        String configured = System.getenv(MODEL_ENV);
        Path sidecar = Path.of(configured).toRealPath()
                .resolveSibling(Path.of(configured).getFileName() + ".json");
        try (var reader = Files.newBufferedReader(sidecar)) {
            var tree = new tools.jackson.databind.ObjectMapper().readTree(reader);
            java.util.Map<String, ?> map = new java.util.HashMap<>();
            tree.get("phoneme_id_map").properties().forEach(e -> map.put(e.getKey(), null));
            return map;
        }
    }

    private static String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (var in = Files.newInputStream(path)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = in.read(buffer)) >= 0) digest.update(buffer, 0, count);
        }
        return HexFormat.of().formatHex(digest.digest());
    }
}
