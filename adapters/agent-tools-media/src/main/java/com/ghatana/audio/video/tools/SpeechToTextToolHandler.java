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
 * {@link ToolHandler} adapter for the Audio-Video Speech-to-Text service.
 *
 * <p>Wraps the AV STT gRPC endpoint as a platform tool. A configured delegate is
 * not sufficient admission evidence: until a source-version, rights/consent,
 * operation, and qualified-model binding is available, the handler returns a
 * typed unavailable result without dispatching.
 *
 * @doc.type class
 * @doc.purpose ToolHandler adapter for the STT gRPC capability
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class SpeechToTextToolHandler implements ToolHandler {

    private static final Logger log = LoggerFactory.getLogger(SpeechToTextToolHandler.class);
    public static final String TOOL_ID = "av.speech-to-text";
    private static final Set<String> VALIDATION_CODES = Set.of(
            "TOOL_ID_MISMATCH", "TOOL_VERSION_MISMATCH", "TOOL_ACTION_CLASS_MISMATCH",
            "UNKNOWN_INPUT_FIELD", "MISSING_TENANT_CONTEXT", "TOOL_INPUT_SCHEMA_VIOLATION",
            "INVALID_AUDIOSOURCE", "INVALID_MEDIAARTIFACTID", "INVALID_AUDIOBYTES",
            "INVALID_MIME_TYPE", "INVALID_LANGUAGE_CODE", "INVALID_ENABLE_DIARIZATION", "INVALID_MODEL");

    public SpeechToTextToolHandler() {
        this(null);
    }

    /**
     * Compatibility constructor. The delegate is intentionally not invoked
     * until Media supplies an admitted operation, source, and consent binding.
     */
    public SpeechToTextToolHandler(ToolHandler ignoredDelegate) {
    }

    @Override
    public Promise<ToolExecutionResult> handle(ToolExecutionEnvelope envelope, ToolContract contract) {
        Objects.requireNonNull(envelope, "envelope must not be null");
        Objects.requireNonNull(contract, "contract must not be null");

        Instant start = Instant.now();
        Map<String, Object> input;

        try {
            input = AgentToolInput.checked(envelope, contract, TOOL_ID, Set.of("audioSource", "languageCode", "enableDiarization", "model"));
            resolveAudioSource(input);
            AgentToolInput.languageTag(input.get("languageCode"), "en-US");
            if (!(input.getOrDefault("enableDiarization", Boolean.FALSE) instanceof Boolean))
                throw new IllegalArgumentException("INVALID_ENABLE_DIARIZATION");
            if (!Set.of("default", "enhanced", "telephony").contains(input.getOrDefault("model", "default")))
                throw new IllegalArgumentException("INVALID_MODEL");

        } catch (Exception e) {
            String errorCode = validationErrorCode(e);
            log.warn("STT input rejected: {}", errorCode);
            Instant end = Instant.now();
            return Promise.of(ToolExecutionResult.failed(
                    envelope.invocationId(),
                    "STT processing error: " + errorCode,
                    envelope.invocationId(),
                    end,
                    Duration.between(start, end)));
        }
        // The current Media source disposition has no accepted STT operation
        // mapping, qualified model binding, source-version receipt, or trusted
        // authorization/consent context. A configured ToolHandler is not proof
        // of any of those conditions, so never cross the provider boundary here.
        return notAdmitted(envelope, start);
    }

    private Promise<ToolExecutionResult> notAdmitted(ToolExecutionEnvelope envelope, Instant start) {
        Instant end = Instant.now();
        return Promise.of(ToolExecutionResult.failed(
                envelope.invocationId(),
                new ToolExecutionFailure(ToolExecutionFailure.Kind.UNAVAILABLE,
                        ToolExecutionFailure.Stage.ADMISSION, "STT_NOT_ADMITTED", false, end),
                envelope.invocationId(), end, Duration.between(start, end)));
    }

    private String resolveAudioSource(Map<String, Object> input) {
        return AgentToolInput.source(input, "audioSource", "audioBytes", 20 * 1024 * 1024, false);
    }

    private static String validationErrorCode(Exception error) {
        String message = error.getMessage();
        return message != null && VALIDATION_CODES.contains(message) ? message : "STT_INPUT_INVALID";
    }

}
