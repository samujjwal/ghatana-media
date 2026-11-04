package com.ghatana.media.stt.engine.onnx;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.ValidationError;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.stt.api.TranscriptionOptions;
import org.junit.jupiter.api.Test;

import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Locale;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** Opt-in integration against the exact private, hash-pinned multilingual reference profile. */
class WhisperReferenceModelIntegrationTest {
    @Test
    void pinnedFrontendMatchesIndependentNumpyReferenceForToneAndSilence() throws Exception {
        String profileValue = System.getenv("GHATANA_MEDIA_WHISPER_PROFILE");
        assumeTrue(profileValue != null,
                "Set the private Whisper profile to run the pinned frontend numeric comparison");
        float[][] filters = WhisperMelFilterBank.load(Path.of(profileValue).resolve("mel_filters.npz"));
        float[] tone = new float[8_000];
        for (int sample = 0; sample < tone.length; sample++) {
            tone[sample] = (float) (0.2d * Math.sin(2.0d * Math.PI * 440.0d * sample / 16_000.0d));
        }
        float[][] actual = WhisperOnnxEngine.computeReferenceMelSpectrogram(tone, filters);
        assertThat(actual).hasDimensions(3_000, 80);
        assertFeatureClose(actual, 0, 0, 0.78430879f);
        assertFeatureClose(actual, 0, 10, 1.13727105f);
        assertFeatureClose(actual, 1, 20, 0.13077152f);
        assertFeatureClose(actual, 10, 20, -0.76076627f);
        assertFeatureClose(actual, 49, 40, -0.43996298f);
        assertFeatureClose(actual, 50, 20, 0.46841460f);

        float[][] silence = WhisperOnnxEngine.computeReferenceMelSpectrogram(new float[1_600], filters);
        assertThat(silence).hasDimensions(3_000, 80);
        assertThat(silence[0][0]).isEqualTo(-1.5f);
        assertThat(silence[1_000][79]).isEqualTo(-1.5f);
    }

    @Test
    void pinnedMultilingualProfileTranscribesSourceAndHandlesSilenceAndInvalidInput() throws Exception {
        String profileValue = System.getenv("GHATANA_MEDIA_WHISPER_PROFILE");
        String audioValue = System.getenv("GHATANA_MEDIA_WHISPER_AUDIO");
        assumeTrue(profileValue != null && audioValue != null,
                "Set the private Whisper profile and rights-safe local WAV to run model integration");

        QualificationInputs qualification = requireQualificationInputs(profileValue, audioValue,
                System.getenv("GHATANA_MEDIA_WHISPER_GOLD_TRANSCRIPT"));
        Path profile = qualification.profile();
        Path wav = qualification.audio();
        AudioData speech = readPcm16MonoWav(wav);
        SttConfig config = SttConfig.builder()
                .modelPath(profile.resolve("encoder_model_quantized.onnx"))
                .modelId("whisper-tiny-multilingual-onnx-reference")
                .maxConcurrentRequests(1)
                .maxAudioLengthSeconds(30)
                .timeout(Duration.ofMinutes(3))
                .build();

        try (WhisperOnnxEngine engine = new WhisperOnnxEngine(config, new AudioVideoLibrary.LibraryState())) {
            TranscriptionOptions english = TranscriptionOptions.builder()
                    .language(Locale.ENGLISH)
                    .enableTimestamps(false)
                    .build();
            var result = engine.transcribe(speech, english);
            String transcript = result.getText();
            assertThat(transcript).isNotBlank();
            String normalizedTranscript = normalizeSpokenText(transcript);
            String normalizedGold = normalizeSpokenText(qualification.goldTranscript());
            assertThat(normalizedTranscript.equals(normalizedGold))
                    .as("Whisper must reproduce all normalized ground-truth words, not just a keyword")
                    .isTrue();
            assertThat(result.words().isEmpty())
                    .as("the pinned profile is explicitly configured without timestamps")
                    .isTrue();

            byte[] silenceBytes = new byte[16_000 * 2];
            AudioData silence = new AudioData(silenceBytes, 16_000, 1, 16,
                    Duration.ofSeconds(1), AudioFormat.PCM);
            assertThat(engine.transcribe(silence, english).getText().isBlank())
                    .as("silence must not produce a transcript")
                    .isTrue();

            AudioData wrongRate = new AudioData(new byte[320], 8_000, 1, 16,
                    Duration.ofMillis(20), AudioFormat.PCM);
            assertThatThrownBy(() -> engine.transcribe(wrongRate, english))
                    .isInstanceOf(ValidationError.class)
                    .hasMessageContaining("16kHz");
            TranscriptionOptions withTimestamps = TranscriptionOptions.builder()
                    .language(Locale.ENGLISH)
                    .enableTimestamps(true)
                    .build();
            assertThatThrownBy(() -> engine.transcribe(speech, withTimestamps))
                    .isInstanceOf(ValidationError.class)
                    .hasMessageContaining("word timestamps");
        }
    }

    @Test
    void pinnedProfileAndAudioRequireIndependentGoldBeforeModelLoading() {
        String invalidPath = String.valueOf((char) 0);
        assertThatThrownBy(() -> requireQualificationInputs(invalidPath, invalidPath, null))
                .isInstanceOf(AssertionError.class)
                .hasMessageContaining("GHATANA_MEDIA_WHISPER_GOLD_TRANSCRIPT");
    }

    private static QualificationInputs requireQualificationInputs(String profileValue, String audioValue,
                                                                   String goldTranscript) {
        assertThat(profileValue).as("GHATANA_MEDIA_WHISPER_PROFILE").isNotBlank();
        assertThat(audioValue).as("GHATANA_MEDIA_WHISPER_AUDIO").isNotBlank();
        // Require independently reviewed complete ground truth before any path is
        // opened or model inference is started. Do not replace this with fixture text.
        assertThat(goldTranscript).as("Set independently reviewed audio ground truth in "
                + "GHATANA_MEDIA_WHISPER_GOLD_TRANSCRIPT before real-model verification")
                .isNotBlank();
        return new QualificationInputs(Path.of(profileValue).toAbsolutePath(),
                Path.of(audioValue).toAbsolutePath(), goldTranscript);
    }

    private record QualificationInputs(Path profile, Path audio, String goldTranscript) { }

    private static String normalizeSpokenText(String value) {
        return java.text.Normalizer.normalize(value, java.text.Normalizer.Form.NFC)
                .toLowerCase(Locale.ROOT)
                .replaceAll("[^\\p{L}\\p{N}\\s]", " ")
                .trim()
                .replaceAll("\\s+", " ");
    }

    private static AudioData readPcm16MonoWav(Path path) throws Exception {
        try (AudioInputStream input = AudioSystem.getAudioInputStream(path.toFile())) {
            var format = input.getFormat();
            assertThat(format.getEncoding().toString()).isEqualTo("PCM_SIGNED");
            assertThat(format.getSampleRate()).isEqualTo(16_000.0f);
            assertThat(format.getChannels()).isEqualTo(1);
            assertThat(format.getSampleSizeInBits()).isEqualTo(16);
            assertThat(format.isBigEndian()).isFalse();
            byte[] pcm = input.readAllBytes();
            assertThat(pcm).isNotEmpty();
            return new AudioData(pcm, 16_000, 1, 16,
                    Duration.ofMillis(Math.round(pcm.length * 1_000d / (16_000 * 2))), AudioFormat.PCM);
        }
    }

    private static void assertFeatureClose(float[][] actual, int frame, int mel, float expected) {
        assertThat(actual[frame][mel]).as("frame %s mel %s", frame, mel)
                .isCloseTo(expected, org.assertj.core.data.Offset.offset(0.001f));
    }
}
