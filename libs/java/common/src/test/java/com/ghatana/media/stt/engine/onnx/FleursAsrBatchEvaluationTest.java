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
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sound.sampled.AudioFormat.Encoding;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Opt-in FLEURS ASR batch evaluation. A separate exact-subset source
 * authorization record is required before engine creation. This local test
 * has no trusted source-authority verifier, so it deliberately fails closed
 * before inference even when a caller supplies a structurally matching record.
 * The predictions contract is consumed by {@code scripts/qualification/evaluate-fleurs-asr.mjs}.
 */
class FleursAsrBatchEvaluationTest {

    @TempDir Path temp;

    private static final long MAX_WAV_BYTES = 1_048_576;
    private static final int MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
    private static final int SAMPLE_RATE = 16_000;
    private static final int MAX_AUDIO_SECONDS = 30;
    private static final int MAX_PCM_BYTES = SAMPLE_RATE * MAX_AUDIO_SECONDS * 2;
    private static final String SAFE_TOKEN = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";

    private static final String MANIFEST_ENV = "GHATANA_MEDIA_FLEURS_MANIFEST";
    private static final String AUTHORIZATION_ENV = "GHATANA_MEDIA_FLEURS_AUTHORIZATION_RECORD";
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
                        + ", " + CLIP_DIR_ENV + " and " + AUTHORIZATION_ENV);
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
        JsonNode authorization = readOptionalBoundedJson(System.getenv(AUTHORIZATION_ENV), mapper);
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

        evaluateAfterFleursAuthorization(manifest, authorization, () -> {
            List<String> lines = new ArrayList<>();
            int[] failures = {0};
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
                        failures[0]++;
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
                    lines.size(), failures[0], out);
        });
    }

    private static boolean isHoldout(JsonNode clip) {
        return "holdout".equals(clip.path("partition").asText());
    }

    /**
     * Reads a caller-supplied authorization record without treating its contents as
     * proof of source authority. This test has no trusted authority verifier, so the
     * final fail-closed result deliberately prevents real inference even when the
     * record is structurally complete and exactly matches the manifest.
     */
    private static JsonNode readOptionalBoundedJson(String value, ObjectMapper mapper) throws IOException {
        if (value == null || value.isBlank()) return null;
        Path path = Path.of(value).toAbsolutePath();
        long size = Files.size(path);
        if (size <= 0 || size > MAX_MANIFEST_BYTES) {
            throw new IOException("FLEURS authorization record exceeds the bounded input size");
        }
        try (var input = Files.newInputStream(path)) {
            byte[] bytes = input.readNBytes(MAX_MANIFEST_BYTES + 1);
            if (bytes.length != size || bytes.length > MAX_MANIFEST_BYTES) {
                throw new IOException("FLEURS authorization record changed or exceeded the bounded read size");
            }
            return mapper.readTree(bytes);
        }
    }

    private static void requireSourceAuthorizedFleursScope(JsonNode manifest, JsonNode authorization)
            throws IOException {
        if (authorization == null || !authorization.isObject()) {
            throw new IOException("FLEURS source-authorized exact subset record is absent or unverifiable");
        }
        JsonNode dataset = manifest.path("dataset");
        if (!"google/fleurs".equals(dataset.path("name").asText())
                || dataset.path("sourceRevision").asText().isBlank()) {
            throw new IOException("FLEURS manifest dataset identity or revision is incomplete");
        }
        if (!dataset.path("sourceRevision").asText().equals(authorization.path("datasetRevision").asText())) {
            throw new IOException("FLEURS authorization dataset revision does not match the manifest");
        }
        String split = manifest.path("selection").path("holdoutSplit").asText();
        if (split.isBlank() || !split.equals(authorization.path("split").asText())) {
            throw new IOException("FLEURS authorization split does not match the manifest");
        }
        if (!"ASR_EVALUATION_ONLY".equals(authorization.path("purpose").asText())
                || authorization.path("privacy").isMissingNode()
                || !authorization.path("privacy").isObject()
                || authorization.path("privacy").isEmpty()
                || authorization.path("retention").isMissingNode()
                || !authorization.path("retention").isObject()
                || authorization.path("retention").isEmpty()) {
            throw new IOException("FLEURS authorization purpose, privacy, or retention scope is incomplete");
        }
        JsonNode manifestClips = manifest.path("selection").path("clips");
        JsonNode authorizedClips = authorization.path("clips");
        if (!manifestClips.isArray() || manifestClips.isEmpty() || !authorizedClips.isArray()) {
            throw new IOException("FLEURS authorization clip scope is absent or incomplete");
        }
        Map<String, String> manifestScope = clipScope(manifestClips, true);
        Map<String, String> authorizedScope = clipScope(authorizedClips, false);
        if (manifestScope.isEmpty() || !manifestScope.equals(authorizedScope)) {
            throw new IOException("FLEURS authorization clip IDs or audio hashes do not match the manifest");
        }
        if (!manifestScope.keySet().stream().map(key -> key.substring(0, key.indexOf(':'))).collect(
                java.util.stream.Collectors.toSet()).equals(Set.of("eng", "hin", "npi"))) {
            throw new IOException("FLEURS authorization must cover the exact en/hi/ne locale set");
        }
        // A caller-provided JSON record can assert source authorization, but this
        // local test has no trusted source-authority verifier to establish it.
        throw new IOException("FLEURS source authority is unverifiable in this local batch test; inference denied");
    }

    @FunctionalInterface
    private interface FleursEvaluation {
        void run() throws Exception;
    }

    private static void evaluateAfterFleursAuthorization(
            JsonNode manifest, JsonNode authorization, FleursEvaluation evaluation) throws Exception {
        requireSourceAuthorizedFleursScope(manifest, authorization);
        evaluation.run();
    }

    private static Map<String, String> clipScope(JsonNode clips, boolean holdoutOnly) throws IOException {
        Map<String, String> scope = new java.util.TreeMap<>();
        for (JsonNode clip : clips) {
            if (holdoutOnly && !isHoldout(clip)) continue;
            if (!holdoutOnly && !isHoldout(clip)) {
                throw new IOException("FLEURS authorization clip partition must be holdout");
            }
            String locale = requiredToken(clip, "locale");
            String clipId = requiredToken(clip, "clipId");
            JsonNode digestNode = clip.get("audioSha256");
            String digest = digestNode != null && digestNode.isTextual() ? digestNode.asText() : "";
            if (!digest.matches("(?i)[0-9a-f]{64}")) {
                throw new IOException("FLEURS authorization clip audioSha256 is absent or malformed");
            }
            String key = locale + ":" + clipId;
            if (scope.putIfAbsent(key, digest.toLowerCase(Locale.ROOT)) != null) {
                throw new IOException("FLEURS authorization contains duplicate clip IDs");
            }
        }
        return scope;
    }

    @Test
    void absentIncompleteOrAlteredAuthorizationCannotCreateEngine() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        JsonNode manifest = fleursManifest(mapper);
        JsonNode completeRecord = fleursAuthorization(mapper);
        Path predictionOutput = temp.resolve("predictions.json");
        List<JsonNode> invalidRecords = new ArrayList<>();
        invalidRecords.add(null);
        invalidRecords.add(mapper.readTree("{}"));
        invalidRecords.add(mapper.readTree(completeRecord.toString().replace(
                "\"privacy\":{\"scope\":\"local evaluation; no identity or biometric use\"},", "")));
        invalidRecords.add(mapper.readTree(completeRecord.toString().replace(
                "," + fleursClip("npi", "clip-nep-1", "a".repeat(64)), "")));
        invalidRecords.add(mapper.readTree(completeRecord.toString().replace(
                "\"partition\":\"holdout\"", "\"partition\":\"training\"")));
        invalidRecords.add(mapper.readTree(completeRecord.toString().replace("\"split\":\"dev\"", "\"split\":\"train\"")));
        invalidRecords.add(mapper.readTree(completeRecord.toString().replace(
                "\"privacy\":{\"scope\":\"local evaluation; no identity or biometric use\"}", "\"privacy\":{}")));
        invalidRecords.add(mapper.readTree(completeRecord.toString().replace(
                "\"retention\":{\"scope\":\"delete selected audio after evaluation\"}", "\"retention\":{}")));
        invalidRecords.add(mapper.readTree(completeRecord.toString().replace(
                "70bb2e84b976b7e960aa89f1c648e09c59f894dd", "altered-revision")));
        invalidRecords.add(mapper.readTree(completeRecord.toString().replace(
                "clip-eng-1", "clip-eng-other")));
        invalidRecords.add(mapper.readTree(completeRecord.toString().replace(
                "a".repeat(64), "b".repeat(64))));
        invalidRecords.add(mapper.readTree(completeRecord.toString().replace(
                ",\"audioSha256\":\"" + "a".repeat(64) + "\"", "")));
        invalidRecords.add(mapper.readTree(completeRecord.toString().replace(
                "\"audioSha256\":\"" + "a".repeat(64) + "\"", "\"audioSha256\":\"malformed\"")));
        invalidRecords.add(mapper.readTree(completeRecord.toString().replace(
                "]}", "," + fleursClip("eng", "clip-eng-1", "a".repeat(64)) + "]}")));
        invalidRecords.add(mapper.readTree(completeRecord.toString().replace(
                "ASR_EVALUATION_ONLY", "OTHER_PURPOSE")));
        for (JsonNode invalid : invalidRecords) {
            assertEvaluationNotStarted(manifest, invalid, predictionOutput);
        }

        assertEvaluationNotStarted(manifest, completeRecord, predictionOutput);

        JsonNode wrongLocaleManifest = mapper.readTree(manifest.toString()
                .replace("\"locale\":\"npi\"", "\"locale\":\"spa\""));
        JsonNode wrongLocaleAuthorization = mapper.readTree(completeRecord.toString()
                .replace("\"locale\":\"npi\"", "\"locale\":\"spa\""));
        assertEvaluationNotStarted(wrongLocaleManifest, wrongLocaleAuthorization, predictionOutput);

        JsonNode wrongDataset = mapper.readTree(manifest.toString()
                .replace("\"name\":\"google/fleurs\"", "\"name\":\"google/other\""));
        assertEvaluationNotStarted(wrongDataset, completeRecord, predictionOutput);

        JsonNode missingDatasetRevision = mapper.readTree(manifest.toString()
                .replace("\"sourceRevision\":\"70bb2e84b976b7e960aa89f1c648e09c59f894dd\"",
                        "\"sourceRevision\":\"\""));
        assertEvaluationNotStarted(missingDatasetRevision, completeRecord, predictionOutput);

        JsonNode mismatchedDatasetRevision = mapper.readTree(manifest.toString()
                .replace("70bb2e84b976b7e960aa89f1c648e09c59f894dd", "altered-revision"));
        assertEvaluationNotStarted(mismatchedDatasetRevision, completeRecord, predictionOutput);
    }

    private void assertEvaluationNotStarted(JsonNode manifest, JsonNode authorization, Path predictionOutput)
            throws Exception {
        AtomicInteger engineCreations = new AtomicInteger();
        AtomicInteger audioReads = new AtomicInteger();
        AtomicInteger artifactWrites = new AtomicInteger();
        assertThatThrownBy(() -> evaluateAfterFleursAuthorization(manifest, authorization, () -> {
            engineCreations.incrementAndGet();
            audioReads.incrementAndGet();
            artifactWrites.incrementAndGet();
            Files.writeString(predictionOutput, "synthetic prediction artifact");
        })).isInstanceOf(IOException.class);
        assertThat(engineCreations).as("engine must not be created for invalid or unverifiable scope")
                .hasValue(0);
        assertThat(audioReads).as("audio must not be read for invalid or unverifiable scope")
                .hasValue(0);
        assertThat(artifactWrites).as("predictions must not be written for invalid or unverifiable scope")
                .hasValue(0);
        assertThat(Files.exists(predictionOutput)).isFalse();
    }

    private static JsonNode fleursManifest(ObjectMapper mapper) throws IOException {
        String sha = "a".repeat(64);
        return mapper.readTree("{\"dataset\":{\"name\":\"google/fleurs\","
                + "\"sourceRevision\":\"70bb2e84b976b7e960aa89f1c648e09c59f894dd\"},"
                + "\"selection\":{\"holdoutSplit\":\"dev\",\"clips\":["
                + fleursClip("eng", "clip-eng-1", sha) + ","
                + fleursClip("hin", "clip-hin-1", sha) + ","
                + fleursClip("npi", "clip-nep-1", sha) + "]}}");
    }

    private static JsonNode fleursAuthorization(ObjectMapper mapper) throws IOException {
        String sha = "a".repeat(64);
        return mapper.readTree("{\"datasetRevision\":\"70bb2e84b976b7e960aa89f1c648e09c59f894dd\","
                + "\"split\":\"dev\",\"purpose\":\"ASR_EVALUATION_ONLY\","
                + "\"privacy\":{\"scope\":\"local evaluation; no identity or biometric use\"},"
                + "\"retention\":{\"scope\":\"delete selected audio after evaluation\"},\"clips\":["
                + fleursClip("eng", "clip-eng-1", sha) + ","
                + fleursClip("hin", "clip-hin-1", sha) + ","
                + fleursClip("npi", "clip-nep-1", sha) + "]}");
    }

    private static String fleursClip(String locale, String clipId, String sha) {
        return "{\"locale\":\"" + locale + "\",\"clipId\":\"" + clipId
                + "\",\"partition\":\"holdout\",\"audioSha256\":\"" + sha + "\"}";
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
