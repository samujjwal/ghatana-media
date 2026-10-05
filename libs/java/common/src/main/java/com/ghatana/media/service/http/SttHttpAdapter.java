package com.ghatana.media.service.http;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.*;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.stt.api.*;
import tools.jackson.databind.ObjectMapper;
import io.activej.http.HttpRequest;
import io.activej.http.HttpResponse;
import io.activej.promise.Promise;

import java.nio.charset.StandardCharsets;
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

                    TranscribeResponse response = new TranscribeResponse(
                        result.getText(),
                        result.confidence(),
                        result.words().stream()
                            .map(w -> new WordTimingJson(
                                w.word(),
                                Math.round(w.startSec() * 1_000),
                                Math.round(w.endSec() * 1_000),
                                w.confidence()))
                            .toList(),
                        result.processingTime().toMillis()
                    );

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
        double confidence,
        List<WordTimingJson> words,
        long latencyMs
    ) {}

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
