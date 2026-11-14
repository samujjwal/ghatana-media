/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionFailure;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.toolruntime.ToolHandler;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import io.activej.promise.Promise;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * {@link ToolHandler} adapter for the Audio-Video Multimodal Inference service.
 *
 * <p>A configured delegate does not establish source authorization, version,
 * temporal provenance, modality eligibility, consent, or cancellation
 * finality. Until an admitted public Media operation binds those inputs,
 * inference fails closed before dispatch.
 *
 * @doc.type class
 * @doc.purpose ToolHandler adapter for the Multimodal Inference capability
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class MultimodalInferenceToolHandler implements ToolHandler {

    private static final Logger log = LoggerFactory.getLogger(MultimodalInferenceToolHandler.class);
    public static final String TOOL_ID = "av.multimodal-inference";
    private static final Set<String> VALIDATION_CODES = Set.of(
            "TOOL_ID_MISMATCH", "TOOL_VERSION_MISMATCH", "TOOL_ACTION_CLASS_MISMATCH",
            "UNKNOWN_INPUT_FIELD", "MISSING_TENANT_CONTEXT", "TOOL_INPUT_SCHEMA_VIOLATION",
            "SOURCE_ARTIFACT_REQUIRED", "SOURCE_VERSION_REQUIRED", "SOURCE_VERSION_INVALID", "INVALID_MEDIAARTIFACTID", "INVALID_INFERENCE_MODE", "INVALID_SAMPLING_RATE",
            "INVALID_LANGUAGE_CODE", "INVALID_ENABLETRANSCRIPTION", "INVALID_ENABLEVISIONANALYSIS",
            "NO_MODALITY_SELECTED");

    public MultimodalInferenceToolHandler() {
        this(null);
    }

    /** Compatibility constructor; a delegate cannot provide admission authority. */
    public MultimodalInferenceToolHandler(ToolHandler ignoredDelegate) {
        this.bridge = null;
        this.principal = null;
    }

    private final MediaToolJobBridge bridge;
    private final AuthenticatedPrincipal principal;

    /**
     * Canonical-job constructor: after validation the call is submitted as exactly one Media
     * {@link JobType#MULTIMODAL} job through the bridge. Without a bridge the handler stays
     * typed NOT_ADMITTED. The principal is the host-authenticated Media identity.
     */
    public MultimodalInferenceToolHandler(MediaToolJobBridge bridge, AuthenticatedPrincipal principal) {
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
            input = AgentToolInput.checked(envelope, contract, TOOL_ID, Set.of("mediaArtifactId", "inferenceMode", "samplingRateMs", "enableTranscription", "enableVisionAnalysis", "languageCode", "sourceArtifactVersion"));
            AgentToolInput.requiredString(input, "mediaArtifactId", 512);
            Object mode = input.getOrDefault("inferenceMode", "SUMMARY");
            if (!(mode instanceof String inferenceMode) || !Set.of("SUMMARY", "SEGMENT", "FRAME_BY_FRAME", "FULL").contains(inferenceMode)) throw new IllegalArgumentException("INVALID_INFERENCE_MODE");
            Object sampling = input.getOrDefault("samplingRateMs", 1000);
            if (!(sampling instanceof Number rate) || rate.intValue() != rate.doubleValue() || rate.intValue() < 100 || rate.intValue() > 60_000)
                throw new IllegalArgumentException("INVALID_SAMPLING_RATE");
            AgentToolInput.languageTag(input.get("languageCode"), "en-US");
            boolean enableTranscription = optionalBoolean(input, "enableTranscription", true);
            boolean enableVision = optionalBoolean(input, "enableVisionAnalysis", true);
            if (!enableTranscription && !enableVision) throw new IllegalArgumentException("NO_MODALITY_SELECTED");

            if (bridge != null) {
                sourceId = AgentToolInput.requiredString(input, "mediaArtifactId", 512);
                sourceVersion = AgentToolInput.sourceVersion(input);
                jobParameters = new LinkedHashMap<>();
                jobParameters.put("inferenceMode", (String) mode);
                jobParameters.put("samplingRateMs", ((Number) sampling).intValue());
                jobParameters.put("language", AgentToolInput.languageTag(input.get("languageCode"), "en-US"));
                jobParameters.put("enableTranscription", enableTranscription);
                jobParameters.put("enableVisionAnalysis", enableVision);
                if (!enableTranscription && enableVision) {
                    // A vision-only observation can be fully specified from the call itself: one canonical
                    // VISION child on the exact source version. A transcription child needs an STT profile
                    // the tool contract does not carry, so that combination keeps the runtime's refusal.
                    jobParameters.put(MultimodalOperationSpec.PARAMETERS_KEY,
                            visionOnlySpec(sourceId, sourceVersion).toParametersValue());
                }
            }
        } catch (Exception e) {
            String errorCode = validationErrorCode(e);
            if (errorCode.startsWith("SOURCE_")) {
                return Promise.of(MediaToolJobBridge.validationFailure(envelope, errorCode, start));
            }
            log.warn("Multimodal input rejected: {}", errorCode);
            Instant end = Instant.now();
            return Promise.of(ToolExecutionResult.failed(
                    envelope.invocationId(),
                    "Multimodal inference error: " + errorCode,
                    envelope.invocationId(),
                    end,
                    Duration.between(start, end)));
        }
        if (bridge != null) {
            return bridge.submit(envelope, principal, JobType.MULTIMODAL, sourceId, sourceVersion,
                    jobParameters, start);
        }
        // A generic ToolHandler is not an admission or provenance authority.
        // The current public operation contract does not bind source version,
        // temporal region, rights/consent, or durable cancellation/finality.
        return notAdmitted(envelope, start);
    }

    private Promise<ToolExecutionResult> notAdmitted(ToolExecutionEnvelope envelope, Instant start) {
        Instant end = Instant.now();
        return Promise.of(ToolExecutionResult.failed(
                envelope.invocationId(),
                new ToolExecutionFailure(ToolExecutionFailure.Kind.UNAVAILABLE,
                        ToolExecutionFailure.Stage.ADMISSION, "MULTIMODAL_NOT_ADMITTED", false, end),
                envelope.invocationId(), end, Duration.between(start, end)));
    }

    /** Durable, source-bound multimodal operation with a single VISION child over the exact source version. */
    static MultimodalOperationSpec visionOnlySpec(String sourceId, String sourceVersion) {
        String sha256 = sourceVersion.substring("sha256:".length());
        return new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-observe-source-grounded",
                1, sourceId, sourceVersion, sha256,
                List.of(new MultimodalOperationSpec.ChildOperationSpec("vision", JobType.VISION, sourceId,
                        sourceVersion, sha256, "",
                        Map.of("analysisTypes", List.of("SCENE_CLASSIFICATION", "OCR", "OBJECT_DETECTION")))),
                null, Map.of());
    }

    private boolean optionalBoolean(Map<String, Object> input, String key, boolean fallback) {
        Object value = input.get(key);
        if (value == null) return fallback;
        if (!(value instanceof Boolean flag)) throw new IllegalArgumentException("INVALID_" + key.toUpperCase());
        return flag;
    }

    private static String validationErrorCode(Exception error) {
        String message = error.getMessage();
        return message != null && VALIDATION_CODES.contains(message) ? message : "MULTIMODAL_INPUT_INVALID";
    }

}
