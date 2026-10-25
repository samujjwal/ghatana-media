package com.ghatana.media.service.http;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.*;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.stt.api.*;
import tools.jackson.databind.ObjectMapper;
import io.activej.http.HttpRequest;
import io.activej.http.HttpResponse;
import io.activej.promise.Promise;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * HTTP REST adapter for STT Engine.
 *
 * <p>Provides REST endpoints for clients that cannot use gRPC directly:
 * <ul>
 *   <li>POST /api/v1/stt/transcribe - Synchronous transcription</li>
 *   <li>POST /api/v1/stt/transcribe/async - Asynchronous transcription</li>
 *   <li>GET /api/v1/stt/models - List available models</li>
 *   <li>POST /api/v1/stt/profiles - Create user profile</li>
 * </ul>
 *
 * <p>This is a thin wrapper over the {@link SttEngine} interface.
 *
 * @doc.type class
 * @doc.purpose HTTP REST adapter for STT Engine service endpoints
 * @doc.layer platform
 * @doc.pattern Adapter
 */
public class SttHttpAdapter {

    private final AudioVideoLibrary library;
    private final ObjectMapper mapper;

    public SttHttpAdapter(SttConfig config) {
        this.library = AudioVideoLibrary.builder()
            .withSttConfig(config)
            .build();
        this.mapper = new ObjectMapper();
    }

    /**
     * Handle POST /api/v1/stt/transcribe
     */
    public Promise<HttpResponse> transcribe(HttpRequest request) {
        return Promise.ofBlocking(Runnable::run, () -> {
            var body = request.getBody();
            try {
                TranscribeRequest req = mapper.readValue(body.getString(StandardCharsets.UTF_8), TranscribeRequest.class);

                try (SttEngine stt = library.getSttEngine()) {
                    AudioData audio = AudioData.builder()
                        .data(req.audioData)
                        .sampleRate(req.sampleRate)
                        .channels(req.channels)
                        .bitsPerSample(16)
                        .build();

                    TranscriptionOptions options = TranscriptionOptions.builder()
                        .language(new java.util.Locale(req.language))
                        .enableTimestamps(req.enableTimestamps)
                        .enablePunctuation(req.enablePunctuation)
                        .build();

                    TranscriptionResult result = stt.transcribe(audio, options);

                    TranscribeResponse response = toResponse(result, audio.duration());

                    return HttpResponse.ok200()
                        .withJson(mapper.writeValueAsString(response))
                        .build();
                }
            } catch (ValidationError e) {
                return PlatformHttpErrorResponse.of(mapper, request, 400,
                    "INVALID_REQUEST", "Transcription request is invalid", false);
            } catch (InferenceError e) {
                int code = e.isRetryable() ? 503 : 500;
                return PlatformHttpErrorResponse.of(mapper, request, code,
                    "TRANSCRIPTION_PROVIDER_FAILED", "Transcription provider failed", e.isRetryable());
            } catch (Exception e) {
                return PlatformHttpErrorResponse.of(mapper, request, 500,
                    "TRANSCRIPTION_FAILED", "Transcription failed", false);
            }
        });
    }

    static TranscribeResponse toResponse(TranscriptionResult result, Duration audioDuration) {
        if (result == null) throw invalidResult("provider returned no transcription result");
        if (result.getText() == null) throw invalidResult("provider returned null transcript text");
        if (audioDuration == null || audioDuration.isNegative()) {
            throw invalidResult("decoded audio duration is unavailable");
        }
        if (result.hasConfidence() && !confidence(result.confidence())) {
            throw invalidResult("transcript confidence must be finite and in [0, 1]");
        }
        if (result.processingTime() == null || result.processingTime().isNegative()) {
            throw invalidResult("processing time must be available and nonnegative");
        }

        List<WordTiming> timings = result.words() == null ? List.of() : result.words();
        BigDecimal durationSeconds = BigDecimal.valueOf(audioDuration.getSeconds())
                .add(BigDecimal.valueOf(audioDuration.getNano(), 9));
        List<WordTimingJson> words = new java.util.ArrayList<>(timings.size());
        double previousStart = -1.0d;
        double previousEnd = 0.0d;
        long previousEndMs = -1L;
        for (WordTiming timing : timings) {
            if (timing == null || timing.word() == null || timing.word().isBlank()) {
                throw invalidResult("word timing text is required");
            }
            double start = timing.startSec();
            double end = timing.endSec();
            if (!Double.isFinite(start) || !Double.isFinite(end) || start < 0.0d || end <= start) {
                throw invalidResult("word timing interval must be finite, nonnegative, and nonempty");
            }
            if (start <= previousStart || start < previousEnd) {
                throw invalidResult("word timing intervals must be strictly ordered and non-overlapping");
            }
            if (BigDecimal.valueOf(end).compareTo(durationSeconds) > 0) {
                throw invalidResult("word timing interval exceeds decoded audio duration");
            }
            if (!confidence(timing.confidence())) {
                throw invalidResult("word timing confidence must be finite and in [0, 1]");
            }
            long startMs = toMillis(start);
            long endMs = toMillis(end);
            if (endMs <= startMs || startMs < previousEndMs) {
                throw invalidResult("word timing interval cannot be represented as ordered millisecond bounds");
            }
            words.add(new WordTimingJson(timing.word(), startMs, endMs, timing.confidence()));
            previousStart = start;
            previousEnd = end;
            previousEndMs = endMs;
        }
        return new TranscribeResponse(
                result.getText(),
                result.hasConfidence() ? result.confidence() : null,
                List.copyOf(words),
                result.processingTime().toMillis());
    }

    private static boolean confidence(double value) {
        return Double.isFinite(value) && value >= 0.0d && value <= 1.0d;
    }

    private static long toMillis(double seconds) {
        try {
            return BigDecimal.valueOf(seconds).movePointRight(3)
                    .setScale(0, RoundingMode.HALF_UP).longValueExact();
        } catch (ArithmeticException overflow) {
            throw invalidResult("word timing interval exceeds representable millisecond bounds");
        }
    }

    private static IllegalArgumentException invalidResult(String detail) {
        return new IllegalArgumentException("STT_RESULT_INVALID: " + detail);
    }

    /**
     * Handle GET /api/v1/stt/models
     */
    public Promise<HttpResponse> getModels(HttpRequest request) {
        return Promise.ofBlocking(Runnable::run, () -> {
            try (SttEngine stt = library.getSttEngine()) {
                List<ModelInfo> models = stt.getAvailableModels();

                List<ModelJson> response = models.stream()
                    .map(m -> new ModelJson(
                        m.modelId(),
                        m.name(),
                        m.version(),
                        m.sizeBytes(),
                        m.supportsGpu()
                    ))
                    .toList();

                return HttpResponse.ok200()
                    .withJson(mapper.writeValueAsString(Map.of("models", response)))
                    .build();
            }
        });
    }

    /**
     * Handle GET /api/v1/stt/health
     */
    public Promise<HttpResponse> health(HttpRequest request) {
        return Promise.ofBlocking(Runnable::run, () -> {
            try (SttEngine stt = library.getSttEngine()) {
                EngineStatus status = stt.getStatus();

                HealthResponse response = new HealthResponse(
                    status.state().name(),
                    status.modelId(),
                    status.version()
                );

                int code = status.state() == EngineStatus.State.READY ? 200 : 503;
                return HttpResponse.ofCode(code)
                    .withJson(mapper.writeValueAsString(response))
                    .build();
            }
        });
    }

    // Request/Response DTOs
    public record TranscribeRequest(
        byte[] audioData,
        int sampleRate,
        int channels,
        String language,
        boolean enableTimestamps,
        boolean enablePunctuation
    ) {}

    public record TranscribeResponse(
        String text,
        Double confidence,
        List<WordTimingJson> words,
        long latencyMs
    ) {
        public TranscribeResponse(String text, double confidence, List<WordTimingJson> words, long latencyMs) {
            this(text, Double.valueOf(confidence), words, latencyMs);
        }
    }

    public record WordTimingJson(
        String word,
        long startMs,
        long endMs,
        double confidence
    ) {}

    public record ModelJson(
        String modelId,
        String name,
        String version,
        long sizeBytes,
        boolean supportsGpu
    ) {}

    public record HealthResponse(
        String state,
        String modelId,
        String version
    ) {}
}
