package com.ghatana.media.stt.engine.onnx;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.stt.api.TranscriptionOptions;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.sound.sampled.AudioFormat.Encoding;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Opt-in FLEURS ASR batch evaluation: transcribes every clip in the frozen
 * CC BY 4.0 FLEURS manifest with the pinned Whisper profile and writes a
 * predictions file consumed by {@code scripts/qualification/evaluate-fleurs-asr.mjs}.
 * Writes incrementally so a long run preserves progress.
 */
class FleursAsrBatchEvaluationTest {

    private static final long MAX_WAV_BYTES = 1_048_576;
    private static final int MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
    private static final int SAMPLE_RATE = 16_000;
    private static final int MAX_AUDIO_SECONDS = 30;
    private static final int MAX_PCM_BYTES = SAMPLE_RATE * MAX_AUDIO_SECONDS * 2;
    private static final String SAFE_TOKEN = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";

    private static final String MANIFEST_ENV = "GHATANA_MEDIA_FLEURS_MANIFEST";
    private static final String OUT_ENV = "GHATANA_MEDIA_FLEURS_PREDICTIONS";
    private static final String CLIP_DIR_ENV = "GHATANA_MEDIA_FLEURS_CLIP_DIR";
    private static final Map<String, Locale> LOCALES = Map.of(
            "eng", Locale.ENGLISH, "hin", Locale.forLanguageTag("hi"), "npi", Locale.forLanguageTag("ne"));

    @Test
    void transcribesFrozenManifestClipsWithPinnedProfile() throws Exception {
        String profileValue = System.getenv("GHATANA_MEDIA_WHISPER_PROFILE");
        String manifestValue = System.getenv(MANIFEST_ENV);
        assumeTrue(profileValue != null && manifestValue != null && System.getenv(OUT_ENV) != null
                        && System.getenv(CLIP_DIR_ENV) != null,
                "Set GHATANA_MEDIA_WHISPER_PROFILE, " + MANIFEST_ENV + ", " + OUT_ENV
                        + " and " + CLIP_DIR_ENV);
        Path clipDir = Path.of(System.getenv(CLIP_DIR_ENV)).toAbsolutePath();
        ObjectMapper mapper = new ObjectMapper();
        JsonNode manifest;
        Path manifestPath = Path.of(manifestValue);
        long manifestSize = Files.size(manifestPath);
        if (manifestSize <= 0 || manifestSize > MAX_MANIFEST_BYTES) {
            throw new IOException("FLEURS manifest exceeds the bounded input size");
        }
        try (var input = Files.newInputStream(manifestPath)) {
            byte[] manifestBytes = input.readNBytes(MAX_MANIFEST_BYTES + 1);
            if (manifestBytes.length != manifestSize || manifestBytes.length > MAX_MANIFEST_BYTES) {
                throw new IOException("FLEURS manifest changed or exceeded the bounded read size");
            }
            manifest = mapper.readTree(manifestBytes);
        }
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
                // The canonical scorer consumes HOLDOUT predictions only. Pilot/training
                // examples are intentionally excluded to avoid leaking tuning data into
                // the reported held-out WER denominator.
                if (!isHoldout(clip)) continue;
                String clipId = requiredToken(clip, "clipId");
                Locale locale = LOCALES.get(clip.get("locale").asText());
                assertThat(locale).as("unsupported locale %s", clip.get("locale").asText()).isNotNull();
                Path wav = resolveClipPath(clipDir, clip);
                AudioData audio = readPcm16MonoWav(wav, clip);
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
                lines.add(predictionJson(mapper, clip.get("locale").asText(), clipId, text));
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

    private static boolean isHoldout(JsonNode clip) {
        return "holdout".equals(clip.path("partition").asText());
    }

    @Test
    void onlyHoldoutPartitionIsScored() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        assertThat(isHoldout(mapper.readTree("{\"partition\":\"holdout\"}"))).isTrue();
        assertThat(isHoldout(mapper.readTree("{\"partition\":\"training\"}"))).isFalse();
        assertThat(isHoldout(mapper.readTree("{\"partition\":\"pilot\"}"))).isFalse();
    }

    /** Emit the exact locale/clipId/text contract consumed by evaluate-fleurs-asr.mjs. */
    private static String predictionJson(ObjectMapper mapper, String locale, String clipId, String text) {
        return mapper.writeValueAsString(Map.of(
                "locale", locale, "clipId", clipId, "text", text == null ? "" : text));
    }

    @Test
    void predictionJsonCarriesLocaleAndEscapesMultilingualControlCharacters() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        String clipId = "clip-\"x";
        String transcript = "नमस्ते\nworld\t\"quoted\"";
        JsonNode record = mapper.readTree(predictionJson(mapper, "npi", clipId, transcript));
        assertThat(record.get("locale").asText()).isEqualTo("npi");
        assertThat(record.get("clipId").asText()).isEqualTo(clipId);
        assertThat(record.get("text").asText()).isEqualTo(transcript);
    }

    private static Path resolveClipPath(Path clipDir, JsonNode clip) throws IOException {
        Path root = clipDir.toRealPath();
        String clipId = requiredToken(clip, "clipId");
        String preferredName = clipId.replace('-', '_') + ".wav";
        String sourceFile = requiredToken(clip, "sourceFile");
        if (sourceFile.contains("/") || sourceFile.contains("\\")
                || !Path.of(sourceFile).getFileName().toString().equals(sourceFile)) {
            throw new IOException("FLEURS sourceFile must be a single safe filename");
        }
        String fallbackName = requiredToken(clip, "locale") + "-"
                + requiredToken(clip, "partition") + "-"
                + requiredToken(clip, "speakerId") + "-" + sourceFile;
        Path preferred = root.resolve(preferredName);
        Path fallback = root.resolve(fallbackName);
        Path selected = Files.exists(preferred, LinkOption.NOFOLLOW_LINKS) ? preferred : fallback;
        Path normalized = selected.normalize();
        if (!normalized.startsWith(root)) {
            throw new IOException("FLEURS clip path escapes the configured clip directory");
        }
        Path real = selected.toRealPath();
        if (!real.startsWith(root) || !Files.isRegularFile(real)) {
            throw new IOException("FLEURS clip must resolve to a regular file within the clip directory");
        }
        return real;
    }

    private static AudioData readPcm16MonoWav(Path path, JsonNode clip) throws Exception {
        long expectedSize = clip.path("sizeBytes").longValue();
        JsonNode digestNode = clip.get("audioSha256");
        String expectedSha256 = digestNode != null && digestNode.isTextual() ? digestNode.asText() : null;
        if (!clip.path("sizeBytes").isIntegralNumber() || expectedSize < 44 || expectedSize > MAX_WAV_BYTES) {
            throw new IOException("FLEURS clip sizeBytes is missing or outside the bounded WAV size");
        }
        if (expectedSha256 == null || !expectedSha256.matches("(?i)[0-9a-f]{64}")) {
            throw new IOException("FLEURS clip audioSha256 is missing or malformed");
        }
        long actualSize = Files.size(path);
        if (actualSize != expectedSize) {
            throw new IOException("FLEURS clip size does not match its frozen manifest");
        }
        byte[] wav;
        try (InputStream input = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
            wav = input.readNBytes((int) MAX_WAV_BYTES + 1);
        }
        if (wav.length != expectedSize || wav.length > MAX_WAV_BYTES) {
            throw new IOException("FLEURS WAV changed or exceeded the bounded read size");
        }
        String actualSha256 = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(wav));
        if (!MessageDigest.isEqual(actualSha256.getBytes(java.nio.charset.StandardCharsets.US_ASCII),
                expectedSha256.toLowerCase(Locale.ROOT).getBytes(java.nio.charset.StandardCharsets.US_ASCII))) {
            throw new IOException("FLEURS clip SHA-256 does not match its frozen manifest");
        }
        try (AudioInputStream input = AudioSystem.getAudioInputStream(new ByteArrayInputStream(wav))) {
            javax.sound.sampled.AudioFormat format = input.getFormat();
            long frames = input.getFrameLength();
            if (!Encoding.PCM_SIGNED.equals(format.getEncoding())
                    || format.getSampleRate() != SAMPLE_RATE || format.getFrameRate() != SAMPLE_RATE
                    || format.getChannels() != 1 || format.getSampleSizeInBits() != 16
                    || format.getFrameSize() != 2 || format.isBigEndian()
                    || frames < 1 || frames > (long) SAMPLE_RATE * MAX_AUDIO_SECONDS) {
                throw new IOException("FLEURS WAV must be 16 kHz mono signed PCM16 little-endian and <= 30 seconds");
            }
            byte[] pcm = input.readNBytes(MAX_PCM_BYTES + 1);
            if (pcm.length == 0 || pcm.length > MAX_PCM_BYTES || pcm.length != frames * 2) {
                throw new IOException("FLEURS WAV decoded frame count is invalid or exceeds the limit");
            }
            return new AudioData(pcm, SAMPLE_RATE, 1, 16,
                    Duration.ofMillis(Math.round(pcm.length * 1_000d / (SAMPLE_RATE * 2))), AudioFormat.PCM);
        }
    }

    private static String requiredToken(JsonNode clip, String field) throws IOException {
        JsonNode fieldNode = clip.get(field);
        String value = fieldNode != null && fieldNode.isTextual() ? fieldNode.asText() : null;
        if (value == null || !value.matches(SAFE_TOKEN)) {
            throw new IOException("FLEURS clip " + field + " is missing or unsafe");
        }
        return value;
    }

    @Test
    void clipPathRejectsTraversalAndSymlinkEscape() throws Exception {
        Path root = Files.createTempDirectory("fleurs-clips");
        Path outside = Files.createTempFile("fleurs-outside", ".wav");
        JsonNode traversal = new ObjectMapper().readTree("{\"clipId\":\"../outside\","
                + "\"locale\":\"eng\",\"partition\":\"holdout\",\"speakerId\":\"s1\","
                + "\"sourceFile\":\"clip.wav\"}");
        assertThatThrownBy(() -> resolveClipPath(root, traversal))
                .isInstanceOf(IOException.class).hasMessageContaining("unsafe");
        try {
            Files.createSymbolicLink(root.resolve("clip_one.wav"), outside);
            JsonNode link = new ObjectMapper().readTree("{\"clipId\":\"clip-one\","
                    + "\"locale\":\"eng\",\"partition\":\"holdout\",\"speakerId\":\"s1\","
                    + "\"sourceFile\":\"clip.wav\"}");
            assertThatThrownBy(() -> resolveClipPath(root, link)).isInstanceOf(IOException.class);
        } catch (UnsupportedOperationException | java.nio.file.FileSystemException unavailable) {
            // Some Windows/locked-down filesystems cannot create symlinks; traversal remains covered.
        }
    }

    @Test
    void readsOnlyManifestPinnedBoundedPcm16MonoWav() throws Exception {
        Path dir = Files.createTempDirectory("fleurs-wav");
        Path wav = dir.resolve("clip.wav");
        byte[] samples = new byte[3200];
        javax.sound.sampled.AudioFormat format = new javax.sound.sampled.AudioFormat(
                Encoding.PCM_SIGNED, SAMPLE_RATE, 16, 1, 2, SAMPLE_RATE, false);
        try (AudioInputStream source = new AudioInputStream(new ByteArrayInputStream(samples), format,
                samples.length / 2L)) {
            AudioSystem.write(source, javax.sound.sampled.AudioFileFormat.Type.WAVE, wav.toFile());
        }
        byte[] bytes = Files.readAllBytes(wav);
        ObjectMapper mapper = new ObjectMapper();
        JsonNode clip = mapper.readTree("{\"sizeBytes\":" + bytes.length + ",\"audioSha256\":\""
                + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)) + "\"}");
        AudioData audio = readPcm16MonoWav(wav, clip);
        assertThat(audio.sampleRate()).isEqualTo(SAMPLE_RATE);
        assertThat(audio.channels()).isEqualTo(1);
        assertThat(audio.bitsPerSample()).isEqualTo(16);
        assertThat(audio.data()).hasSize(samples.length);

        JsonNode wrongDigest = mapper.readTree("{\"sizeBytes\":" + bytes.length
                + ",\"audioSha256\":\"" + "0".repeat(64) + "\"}");
        assertThatThrownBy(() -> readPcm16MonoWav(wav, wrongDigest))
                .isInstanceOf(IOException.class).hasMessageContaining("SHA-256");
        JsonNode oldDigestField = mapper.readTree("{\"sizeBytes\":" + bytes.length
                + ",\"sha256\":\"" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)) + "\"}");
        assertThatThrownBy(() -> readPcm16MonoWav(wav, oldDigestField))
                .isInstanceOf(IOException.class).hasMessageContaining("audioSha256");
        JsonNode wrongSize = mapper.readTree("{\"sizeBytes\":" + (bytes.length + 1)
                + ",\"audioSha256\":\"" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)) + "\"}");
        assertThatThrownBy(() -> readPcm16MonoWav(wav, wrongSize))
                .isInstanceOf(IOException.class).hasMessageContaining("size");
    }

    @Test
    void rejectsWrongWavFormatAndOversizedDeclaredWavSize() throws Exception {
        Path wav = Files.createTempFile("fleurs-invalid-format", ".wav");
        javax.sound.sampled.AudioFormat format = new javax.sound.sampled.AudioFormat(
                Encoding.PCM_SIGNED, 8_000, 16, 1, 2, 8_000, false);
        try (AudioInputStream source = new AudioInputStream(new ByteArrayInputStream(new byte[1600]), format, 800)) {
            AudioSystem.write(source, javax.sound.sampled.AudioFileFormat.Type.WAVE, wav.toFile());
        }
        byte[] bytes = Files.readAllBytes(wav);
        ObjectMapper mapper = new ObjectMapper();
        String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        JsonNode wrongFormat = mapper.readTree("{\"sizeBytes\":" + bytes.length + ",\"audioSha256\":\"" + sha + "\"}");
        assertThatThrownBy(() -> readPcm16MonoWav(wav, wrongFormat))
                .isInstanceOf(IOException.class).hasMessageContaining("16 kHz");
        JsonNode excessive = mapper.readTree("{\"sizeBytes\":" + (MAX_WAV_BYTES + 1)
                + ",\"audioSha256\":\"" + sha + "\"}");
        assertThatThrownBy(() -> readPcm16MonoWav(wav, excessive))
                .isInstanceOf(IOException.class).hasMessageContaining("bounded");
    }

    @Test
    void rejectsAudioLongerThanThirtySeconds() throws Exception {
        Path wav = Files.createTempFile("fleurs-too-long", ".wav");
        javax.sound.sampled.AudioFormat format = new javax.sound.sampled.AudioFormat(
                Encoding.PCM_SIGNED, SAMPLE_RATE, 16, 1, 2, SAMPLE_RATE, false);
        long frames = (long) SAMPLE_RATE * (MAX_AUDIO_SECONDS + 1);
        try (AudioInputStream source = new AudioInputStream(
                new ByteArrayInputStream(new byte[(int) (frames * 2)]), format, frames)) {
            AudioSystem.write(source, javax.sound.sampled.AudioFileFormat.Type.WAVE, wav.toFile());
        }
        byte[] bytes = Files.readAllBytes(wav);
        JsonNode clip = new ObjectMapper().readTree("{\"sizeBytes\":" + bytes.length + ",\"audioSha256\":\""
                + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)) + "\"}");
        assertThatThrownBy(() -> readPcm16MonoWav(wav, clip))
                .isInstanceOf(IOException.class).hasMessageContaining("30 seconds");
    }
}
