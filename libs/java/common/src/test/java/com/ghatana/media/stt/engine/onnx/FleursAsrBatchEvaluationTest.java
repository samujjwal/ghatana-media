package com.ghatana.media.stt.engine.onnx;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.stt.api.TranscriptionOptions;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Opt-in FLEURS ASR batch evaluation: transcribes every clip in the frozen
 * CC BY 4.0 FLEURS manifest with the pinned Whisper profile and writes a
 * predictions file consumed by {@code scripts/qualification/evaluate-fleurs-asr.mjs}.
 * Writes incrementally so a long run preserves progress.
 */
class FleursAsrBatchEvaluationTest {

    private static final String MANIFEST_ENV = "GHATANA_MEDIA_FLEURS_MANIFEST";
    private static final String OUT_ENV = "GHATANA_MEDIA_FLEURS_PREDICTIONS";
    private static final String CLIP_DIR_ENV = "GHATANA_MEDIA_FLEURS_CLIP_DIR";
    private static final Map<String, Locale> LOCALES = Map.of(
            "eng", Locale.ENGLISH, "hin", Locale.forLanguageTag("hi"), "npi", Locale.forLanguageTag("ne"));

    @Test
    void transcribesFrozenManifestClipsWithPinnedProfile() throws Exception {
        String profileValue = System.getenv("GHATANA_MEDIA_WHISPER_PROFILE");
        String manifestValue = System.getenv(MANIFEST_ENV);
        assumeTrue(profileValue != null && manifestValue != null && System.getenv(OUT_ENV) != null,
                "Set GHATANA_MEDIA_WHISPER_PROFILE, " + MANIFEST_ENV + " and " + OUT_ENV);
        Path clipDir = Path.of(System.getenv(CLIP_DIR_ENV)).toAbsolutePath();
        JsonNode manifest = new ObjectMapper().readTree(Files.newInputStream(Path.of(manifestValue)));
        assertThat(manifest.get("status").asText()).isEqualTo("FROZEN");
        JsonNode clips = manifest.path("selection").path("clips");
        Path out = Path.of(System.getenv(OUT_ENV)).toAbsolutePath();

        Path profile = Path.of(profileValue).toAbsolutePath();
        SttConfig config = SttConfig.builder()
                .modelPath(profile.resolve("encoder_model_quantized.onnx"))
                .modelId("whisper-tiny-multilingual-onnx-reference")
                .maxConcurrentRequests(1)
                .maxAudioLengthSeconds(30)
                .timeout(Duration.ofMinutes(3))
                .build();

        List<String> lines = new ArrayList<>();
        int failures = 0;
        try (WhisperOnnxEngine engine = new WhisperOnnxEngine(config, new AudioVideoLibrary.LibraryState())) {
            int done = 0;
            for (JsonNode clip : clips) {
                String clipId = clip.get("clipId").asText();
                Locale locale = LOCALES.get(clip.get("locale").asText());
                assertThat(locale).as("unsupported locale %s", clip.get("locale").asText()).isNotNull();
                Path wav = clipDir.resolve(clipId.replace('-', '_') + ".wav");
                if (!Files.isRegularFile(wav)) {
                    wav = clipDir.resolve(clip.get("locale").asText() + "-"
                            + clip.get("partition").asText() + "-"
                            + clip.get("speakerId").asText() + "-" + clip.get("sourceFile").asText());
                }
                AudioData audio = readPcm16MonoWav(wav);
                String text;
                try {
                    var result = engine.transcribe(audio, TranscriptionOptions.builder()
                            .language(locale).enableTimestamps(false).build());
                    text = result.text();
                } catch (RuntimeException failure) {
                    // A failed clip is a truthful evaluation outcome: record an empty
                    // prediction (scored as full WER) rather than abort the batch.
                    text = "";
                    failures++;
                    System.out.printf("FLEURS_CLIP_FAILED clip=%s error=%s%n",
                            clipId, failure.getClass().getSimpleName());
                }
                lines.add("{\"clipId\":\"" + clipId + "\",\"text\":" + json(text) + "}");
                done++;
                if (done % 20 == 0) {
                    Files.writeString(out, "[" + String.join(",", lines) + "]");
                    System.out.printf("FLEURS_PROGRESS %d/%d%n", done, clips.size());
                }
            }
        }
        Files.writeString(out, "[" + String.join(",", lines) + "]");
        System.out.printf("FLEURS_PREDICTIONS_DONE clips=%d failures=%d out=%s%n",
                lines.size(), failures, out);
    }

    private static String json(String value) {
        String v = value == null ? "" : value;
        return "\"" + v.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ") + "\"";
    }

    private static AudioData readPcm16MonoWav(Path path) throws IOException, Exception {
        try (AudioInputStream input = AudioSystem.getAudioInputStream(path.toFile())) {
            byte[] pcm = input.readAllBytes();
            return new AudioData(pcm, 16_000, 1, 16,
                    Duration.ofMillis(Math.round(pcm.length * 1_000d / (16_000 * 2))), AudioFormat.PCM);
        }
    }
}
