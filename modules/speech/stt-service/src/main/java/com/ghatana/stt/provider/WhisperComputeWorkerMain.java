package com.ghatana.stt.provider;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.runtime.WhisperComputeContracts;
import com.ghatana.media.runtime.WhisperComputeContracts.Request;
import com.ghatana.media.runtime.WhisperComputeContracts.Result;
import com.ghatana.media.runtime.WhisperComputeContracts.Status;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.engine.onnx.WhisperOnnxEngine;
import com.ghatana.stt.service.SttAudioInputDecoder;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/** Fixed, single-request stdin/stdout adapter for a server-composed Whisper OCI worker. */
public final class WhisperComputeWorkerMain {
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build());
    private static final Set<String> FIELDS = Set.of("invocationId", "profileId", "locale",
            "sourceSha256", "wavBase64", "remainingBudgetMillis");

    @FunctionalInterface
    interface Inference {
        Result execute(Request request, WorkerProfile profile) throws Exception;
    }

    record WorkerProfile(Path modelPath, String modelRevision, String modelSha256,
            String profileId, long maxBudgetMillis) { }

    private WhisperComputeWorkerMain() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 0) throw new IllegalArgumentException("worker accepts no command-line arguments");
        Result result;
        try {
            byte[] request = readBounded(System.in, WhisperComputeContracts.MAX_WAV_BYTES * 2);
            result = handle(request, System.getenv(), WhisperComputeWorkerMain::runPinnedEngine);
        } catch (IOException malformedFrame) {
            result = invalidResponse();
        }
        byte[] response = JSON.writeValueAsBytes(result);
        if (response.length > 1_048_576) throw new IOException("worker response exceeds its byte limit");
        System.out.write(response);
        System.out.flush();
    }

    static Result handle(byte[] input, java.util.Map<String, String> environment, Inference inference) {
        Request request;
        try {
            request = parseRequest(input);
        } catch (Exception malformed) {
            return invalidResponse();
        }
        WorkerProfile profile = profile(environment, request.remainingBudgetMillis());
        if (profile == null || !profile.profileId().equals(request.profileId())) {
            return response(request, "", Status.NOT_ADMITTED, false, false, false);
        }
        try {
            Result result = inference.execute(request, profile);
            if (result == null || !request.invocationId().equals(result.invocationId())
                    || !request.profileId().equals(result.profileId())
                    || !request.sourceSha256().equals(result.inputSha256())
                    || !profile.modelSha256().equals(result.modelSha256())) {
                return response(request, "", Status.UNKNOWN_OUTCOME, false, false, false);
            }
            return result;
        } catch (ModelAssetsUnavailable unavailable) {
            return response(request, "", Status.NOT_ADMITTED, false, false, false);
        } catch (Exception uncertain) {
            return response(request, "", Status.UNKNOWN_OUTCOME, false, false, false);
        }
    }

    static Result runPinnedEngine(Request request, WorkerProfile profile) throws Exception {
        if (!Files.isRegularFile(profile.modelPath(), LinkOption.NOFOLLOW_LINKS)) {
            throw new ModelAssetsUnavailable();
        }
        String actualModelDigest = sha256(profile.modelPath());
        if (!actualModelDigest.equals(profile.modelSha256())) throw new ModelAssetsUnavailable();
        // WhisperOnnxEngine enforces the exact encoder/decoder/mel/tokenizer pins for
        // its split reference profile during construction. This worker adds no loader.
        SttConfig config = SttConfig.builder().modelPath(profile.modelPath())
                .modelId(profile.modelRevision()).maxConcurrentRequests(1)
                .timeout(Duration.ofMillis(Math.max(1, request.remainingBudgetMillis())))
                .allowSyntheticFallback(false).build();
        AudioData audio = SttAudioInputDecoder.decode(request.wavPayload(), AudioFormat.WAV, 16_000);
        if (audio.sampleRate() != 16_000 || audio.channels() != 1 || audio.bitsPerSample() != 16
                || audio.format() != AudioFormat.PCM) throw new IllegalArgumentException("unsupported WAV profile");
        WhisperOnnxEngine engine;
        try {
            engine = new WhisperOnnxEngine(config, new AudioVideoLibrary.LibraryState());
        } catch (RuntimeException missingAssets) {
            throw new ModelAssetsUnavailable();
        }
        try (engine) {
            var options = TranscriptionOptions.builder().language(Locale.forLanguageTag(request.locale()))
                    .enableTimestamps(false).timeout(Duration.ofMillis(request.remainingBudgetMillis())).build();
            String transcript = engine.transcribe(audio, options).getText();
            return response(request, transcript, Status.SUCCESS, true, true, false,
                    profile.modelSha256());
        }
    }

    private static WorkerProfile profile(java.util.Map<String, String> environment, long budget) {
        String profile = environment.getOrDefault("MEDIA_WHISPER_WORKER_PROFILE_ID", "").trim();
        String revision = environment.getOrDefault("MEDIA_WHISPER_WORKER_MODEL_REVISION", "").trim();
        String expectedDigest = environment.getOrDefault("MEDIA_WHISPER_WORKER_MODEL_SHA256", "").trim();
        String configuredPath = environment.getOrDefault("MEDIA_WHISPER_WORKER_MODEL_PATH", "").trim();
        if (profile.isBlank() || revision.isBlank() || !expectedDigest.matches("[0-9a-f]{64}")
                || configuredPath.isBlank() || budget < 1
                || budget > WhisperComputeContracts.MAX_REMAINING_BUDGET_MILLIS) return null;
        try {
            Path model = Path.of(configuredPath).toAbsolutePath().normalize();
            if (!"encoder_model_quantized.onnx".equals(model.getFileName().toString())) return null;
            return new WorkerProfile(model, revision, expectedDigest, profile, budget);
        } catch (RuntimeException invalid) {
            return null;
        }
    }

    private static Request parseRequest(byte[] bytes) throws Exception {
        if (bytes == null || bytes.length == 0
                || bytes.length > WhisperComputeContracts.MAX_WAV_BYTES * 2) {
            throw new IOException("worker request is out of bounds");
        }
        JsonNode root = JSON.readTree(new String(bytes, StandardCharsets.UTF_8));
        if (root == null || !root.isObject() || root.size() != FIELDS.size()) {
            throw new IOException("worker request fields are invalid");
        }
        for (String field : FIELDS) if (!root.has(field)) throw new IOException("missing worker request field");
        if (!root.get("invocationId").isTextual() || !root.get("profileId").isTextual()
                || !root.get("locale").isTextual() || !root.get("sourceSha256").isTextual()
                || !root.get("wavBase64").isTextual() || !root.get("remainingBudgetMillis").canConvertToLong()) {
            throw new IOException("worker request types are invalid");
        }
        UUID invocation = UUID.fromString(root.get("invocationId").textValue());
        byte[] wav = Base64.getDecoder().decode(root.get("wavBase64").textValue());
        return new Request(invocation, root.get("profileId").textValue(), root.get("locale").textValue(),
                root.get("sourceSha256").textValue(), wav, root.get("remainingBudgetMillis").longValue());
    }

    private static byte[] readBounded(InputStream input, int maxBytes) throws IOException {
        byte[] bytes = input.readNBytes(maxBytes + 1);
        if (bytes.length == 0 || bytes.length > maxBytes) throw new IOException("worker input is out of bounds");
        if (input.read() != -1) throw new IOException("worker accepts exactly one bounded request");
        return bytes;
    }

    private static Result invalidResponse() {
        UUID id = new UUID(0, 0);
        return new Result(id, "invalid", "0".repeat(64), null, "", Status.INVALID_REQUEST,
                false, false, false);
    }

    private static Result response(Request request, String transcript, Status status,
            boolean complete, boolean endOfTask, boolean tokenLimitReached) {
        return response(request, transcript, status, complete, endOfTask, tokenLimitReached, null);
    }

    private static Result response(Request request, String transcript, Status status,
            boolean complete, boolean endOfTask, boolean tokenLimitReached, String modelDigest) {
        return new Result(request.invocationId(), request.profileId(), request.sourceSha256(),
                modelDigest, transcript, status, complete, endOfTask, tokenLimitReached);
    }

    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private static String sha256(Path path) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = Files.newInputStream(path)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) if (read > 0) digest.update(buffer, 0, read);
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static final class ModelAssetsUnavailable extends Exception { }

}
