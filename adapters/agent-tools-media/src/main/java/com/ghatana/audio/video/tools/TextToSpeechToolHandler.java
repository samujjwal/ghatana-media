/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionFailure;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.toolruntime.ToolHandler;
import io.activej.promise.Promise;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * {@link ToolHandler} adapter for the Audio-Video Text-to-Speech service.
 *
 * <p>Wraps the AV TTS gRPC endpoint as a platform tool. A configured delegate
 * does not establish an admitted operation, qualified voice, consent or output
 * receipt; until those bindings are available, synthesis fails closed before dispatch.
 *
 * @doc.type class
 * @doc.purpose ToolHandler adapter for the TTS gRPC capability
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class TextToSpeechToolHandler implements ToolHandler {

    private static final Logger log = LoggerFactory.getLogger(TextToSpeechToolHandler.class);
    static final String TOOL_ID = "av.text-to-speech";

    public TextToSpeechToolHandler() {
        this(null);
    }

    /**
     * Compatibility constructor. The delegate is intentionally not invoked
     * until Media supplies an admitted operation, voice, and consent binding.
     */
    public TextToSpeechToolHandler(ToolHandler ignoredDelegate) {
    }

    @Override
    public Promise<ToolExecutionResult> handle(ToolExecutionEnvelope envelope, ToolContract contract) {
        Objects.requireNonNull(envelope, "envelope must not be null");
        Objects.requireNonNull(contract, "contract must not be null");

        Instant start = Instant.now();
        Map<String, Object> input;

        log.debug("TTS invocation [{}] tenant={}", envelope.invocationId(), envelope.tenantId());

        try {
            input = AgentToolInput.checked(envelope, contract, TOOL_ID, Set.of("text", "voiceId", "speakingRate", "pitch", "audioEncoding", "storeAsArtifact"));
            String text = AgentToolInput.requiredString(input, "text", 10_000);
            String voiceId = optionalString(input, "voiceId", "en-US-default", 128);
            double speakingRate = AgentToolInput.boundedRate(input.getOrDefault("speakingRate", 1.0));
            String encoding = optionalString(input, "audioEncoding", "MP3", 16);
            if (!Set.of("MP3", "WAV", "OGG_OPUS", "LINEAR16").contains(encoding)) throw new IllegalArgumentException("INVALID_AUDIO_ENCODING");
            Object pitch = input.getOrDefault("pitch", 0.0);
            if (!(pitch instanceof Number pitchNumber) || !Double.isFinite(pitchNumber.doubleValue())
                    || pitchNumber.doubleValue() < -20.0 || pitchNumber.doubleValue() > 20.0)
                throw new IllegalArgumentException("INVALID_PITCH");
            Object store = input.getOrDefault("storeAsArtifact", Boolean.FALSE);
            if (!(store instanceof Boolean)) throw new IllegalArgumentException("INVALID_STORE_AS_ARTIFACT");
            boolean storeAsArtifact = (Boolean) store;

            log.debug("TTS: voice={} rate={} encoding={} storeAsArtifact={}", voiceId, speakingRate, encoding, storeAsArtifact);

        } catch (Exception e) {
            log.error("TTS handler failed for invocation {}: {}", envelope.invocationId(), e.getMessage(), e);
            Instant end = Instant.now();
            return Promise.of(ToolExecutionResult.failed(
                    envelope.invocationId(),
                    "TTS processing error: " + e.getMessage(),
                    envelope.invocationId(),
                    end,
                    Duration.between(start, end)));
        }
        // A configured delegate alone does not establish an admitted synthesis
        // operation, qualified voice/model, consent or immutable output receipt.
        // Until those Media-owned bindings exist, reject before any provider or
        // artifact-storage side effect.
        return notAdmitted(envelope, start);
    }

    private Promise<ToolExecutionResult> notAdmitted(ToolExecutionEnvelope envelope, Instant start) {
        Instant end = Instant.now();
        return Promise.of(ToolExecutionResult.failed(
                envelope.invocationId(),
                new ToolExecutionFailure(ToolExecutionFailure.Kind.UNAVAILABLE,
                        ToolExecutionFailure.Stage.ADMISSION, "TTS_NOT_ADMITTED", false, end),
                envelope.invocationId(), end, Duration.between(start, end)));
    }

    private String optionalString(Map<String, Object> input, String key, String fallback, int max) {
        return input.containsKey(key) ? AgentToolInput.requiredString(input, key, max) : fallback;
    }

}
