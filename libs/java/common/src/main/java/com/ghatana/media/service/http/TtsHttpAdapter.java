package com.ghatana.media.service.http;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.*;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.tts.api.*;
import tools.jackson.databind.ObjectMapper;
import io.activej.http.HttpRequest;
import io.activej.http.HttpResponse;
import io.activej.promise.Promise;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * HTTP REST adapter for TTS Engine.
 *
 * <p>Provides REST endpoints:
 * <ul>
 *   <li>POST /api/v1/tts/synthesize - Synchronous synthesis</li>
 *   <li>POST /api/v1/tts/synthesize/streaming - Streaming synthesis</li>
 *   <li>GET /api/v1/tts/voices - List available voices</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose HTTP REST adapter for TTS Engine service endpoints
 * @doc.layer platform
 * @doc.pattern Adapter
 */
public class TtsHttpAdapter {

    private final AudioVideoLibrary library;
    private final ObjectMapper mapper;

    public TtsHttpAdapter(TtsConfig config) {
        this.library = AudioVideoLibrary.builder()
            .withTtsConfig(config)
            .build();
        this.mapper = new ObjectMapper();
    }

    /**
     * Handle POST /api/v1/tts/synthesize
     */
    public Promise<HttpResponse> synthesize(HttpRequest request) {
        return Promise.ofBlocking(Runnable::run, () -> {
            var body = request.getBody();
            try {
                SynthesizeRequest req = mapper.readValue(body.getString(StandardCharsets.UTF_8), SynthesizeRequest.class);

                try (TtsEngine tts = library.getTtsEngine()) {
                    SynthesisOptions options = SynthesisOptions.builder()
                        .voiceId(req.voiceId)
                        .speed(req.speed)
                        .pitch(req.pitch)
                        .volume(req.volume)
                        .build();

                    AudioData audio = tts.synthesize(req.text, options);

                    SynthesizeResponse response = new SynthesizeResponse(
                        audio.data(),
                        audio.sampleRate(),
                        audio.channels(),
                        options.voiceId()
                    );

                    return HttpResponse.ok200()
                        .withJson(mapper.writeValueAsString(response))
                        .build();
                }
            } catch (ValidationError e) {
                return PlatformHttpErrorResponse.of(mapper, request, 400,
                    "INVALID_REQUEST", "Synthesis request is invalid", false);
            } catch (Exception e) {
                return PlatformHttpErrorResponse.of(mapper, request, 500,
                    "SYNTHESIS_FAILED", "Synthesis failed", false);
            }
        });
    }

    /**
     * Handle GET /api/v1/tts/voices
     */
    public Promise<HttpResponse> getVoices(HttpRequest request) {
        return Promise.ofBlocking(Runnable::run, () -> {
            try (TtsEngine tts = library.getTtsEngine()) {
                List<VoiceInfo> voices = tts.getAvailableVoices();

                List<VoiceJson> response = voices.stream()
                    .map(v -> new VoiceJson(
                        v.voiceId(),
                        v.name(),
                        v.language().toLanguageTag(),
                        v.sampleRate(),
                        v.isCloned()
                    ))
                    .toList();

                return HttpResponse.ok200()
                    .withJson(mapper.writeValueAsString(Map.of("voices", response)))
                    .build();
            }
        });
    }

    /**
     * Handle GET /api/v1/tts/health
     */
    public Promise<HttpResponse> health(HttpRequest request) {
        return Promise.ofBlocking(Runnable::run, () -> {
            try (TtsEngine tts = library.getTtsEngine()) {
                EngineStatus status = tts.getStatus();

                return HttpResponse.ok200()
                    .withJson("{\"state\":\"" + status.state().name() + "\",\"voice\":\"" + status.modelId() + "\"}")
                    .build();
            }
        });
    }

    public record SynthesizeRequest(
        String text,
        String voiceId,
        double speed,
        double pitch,
        double volume
    ) {}

    public record SynthesizeResponse(
        byte[] audioData,
        int sampleRate,
        int channels,
        String voiceId
    ) {}

    public record VoiceJson(
        String voiceId,
        String name,
        String language,
        int sampleRate,
        boolean isCloned
    ) {}
}
