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
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import io.activej.promise.Promise;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
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
            "SOURCE_ARTIFACT_REQUIRED", "SOURCE_VERSION_REQUIRED", "SOURCE_VERSION_INVALID", "INVALID_AUDIOSOURCE", "INVALID_MEDIAARTIFACTID", "INVALID_AUDIOBYTES",
            "INVALID_MIME_TYPE", "INVALID_LANGUAGE_CODE", "INVALID_ENABLE_DIARIZATION", "INVALID_MODEL");

    public SpeechToTextToolHandler() {
        this(null);
    }

    /**
     * Compatibility constructor. The delegate is intentionally not invoked
     * until Media supplies an admitted operation, source, and consent binding.
     */
    public SpeechToTextToolHandler(ToolHandler ignoredDelegate) {
        this.bridge = null;
        this.principal = null;
    }

    private final MediaToolJobBridge bridge;
    private final AuthenticatedPrincipal principal;

    /**
     * Canonical-job constructor: after validation the call is submitted as exactly one Media
     * {@link JobType#SPEECH_TO_TEXT} job through the bridge. Without a bridge the handler stays
     * typed NOT_ADMITTED. The principal is the host-authenticated Media identity.
     */
    public SpeechToTextToolHandler(MediaToolJobBridge bridge, AuthenticatedPrincipal principal) {
        this.bridge = java.util.Objects.requireNonNull(bridge, "bridge");
        this.principal = principal;
    }

    @Override
    public Promise<ToolExecutionResult> handle(ToolExecutionEnvelope envelope, ToolContract contract) {
        Objects.requireNonNull(envelope, "envelope must not be null");
        Objects.requireNonNull(contract, "contract must not be null");

        Instant start = Instant.now();
        Map<String, Object> input;
        String sourceId = null;
        String sourceVersion = null;
        Map<String, Object> jobParameters = null;

        try {
            input = AgentToolInput.checked(envelope, contract, TOOL_ID, Set.of("audioSource", "languageCode", "enableDiarization", "model", "sourceArtifactVersion"));
            resolveAudioSource(input);
            AgentToolInput.languageTag(input.get("languageCode"), "en-US");
            if (!(input.getOrDefault("enableDiarization", Boolean.FALSE) instanceof Boolean))
                throw new IllegalArgumentException("INVALID_ENABLE_DIARIZATION");
            if (!Set.of("default", "enhanced", "telephony").contains(input.getOrDefault("model", "default")))
                throw new IllegalArgumentException("INVALID_MODEL");

            if (bridge != null) {
                sourceId = AgentToolInput.sourceArtifactId(resolveAudioSource(input));
                sourceVersion = AgentToolInput.sourceVersion(input);
                jobParameters = new LinkedHashMap<>();
                jobParameters.put("language", AgentToolInput.languageTag(input.get("languageCode"), "en-US"));
                jobParameters.put("diarization", input.getOrDefault("enableDiarization", Boolean.FALSE));
                jobParameters.put("model", input.getOrDefault("model", "default"));
            }
        } catch (Exception e) {
            String errorCode = validationErrorCode(e);
            if (errorCode.startsWith("SOURCE_")) {
                return Promise.of(MediaToolJobBridge.validationFailure(envelope, errorCode, start));
            }
            log.warn("STT input rejected: {}", errorCode);
            Instant end = Instant.now();
            if ("TOOL_INPUT_SCHEMA_VIOLATION".equals(errorCode)) {
                return Promise.of(ToolExecutionResult.failed(
                        envelope.invocationId(),
                        new ToolExecutionFailure(ToolExecutionFailure.Kind.VALIDATION,
                                ToolExecutionFailure.Stage.EXECUTION, errorCode, false, end),
                        envelope.invocationId(), end, Duration.between(start, end)));
            }
            return Promise.of(ToolExecutionResult.failed(
                    envelope.invocationId(),
                    "STT processing error: " + errorCode,
                    envelope.invocationId(),
                    end,
                    Duration.between(start, end)));
        }
        if (bridge != null) {
            return bridge.submit(envelope, principal, JobType.SPEECH_TO_TEXT, sourceId, sourceVersion,
                    jobParameters, start);
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
