/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionFailure;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.toolruntime.ToolHandler;
import io.activej.promise.Promise;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * {@link ToolHandler} adapter for the Audio-Video Multimodal Inference service.
 *
 * <p>The tool is source-bound by PXD-238 to the canonical cross-modal analysis
 * operation. A configured delegate does not establish source authorization,
 * version, temporal provenance, modality eligibility, consent, or cancellation
 * finality. A structural canonical request mapper exists, but until
 * owner-authoritative reference/profile/rights resolution and the canonical
 * runtime submit/result path are wired and admitted, inference fails closed
 * before dispatch.
 *
 * @doc.type class
 * @doc.purpose ToolHandler adapter for the Multimodal Inference capability
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class MultimodalInferenceToolHandler implements ToolHandler {

    private static final Logger log = LoggerFactory.getLogger(MultimodalInferenceToolHandler.class);
    public static final String TOOL_ID = "av.multimodal-inference";
    static final String NOT_ADMITTED_CODE = "MULTIMODAL_NOT_ADMITTED";
    private static final Set<String> INPUT_FIELDS = Set.of("input1", "input2");
    private static final Pattern ARTIFACT_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]*");
    private static final Pattern VERSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:+-]*");
    private static final Pattern MEDIA_TYPE = Pattern.compile("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+");
    private static final Pattern SHA256 = Pattern.compile("sha256:[a-f0-9]{64}");
    static final Set<String> VALIDATION_CODES = Set.of(
            "TOOL_ID_MISMATCH", "TOOL_VERSION_MISMATCH", "TOOL_ACTION_CLASS_MISMATCH",
            "UNKNOWN_INPUT_FIELD", "MISSING_TENANT_CONTEXT", "TOOL_INPUT_SCHEMA_VIOLATION");

    public MultimodalInferenceToolHandler() {
        this(null);
    }

    /** Compatibility constructor; a generic delegate cannot supply the canonical operation binding. */
    public MultimodalInferenceToolHandler(ToolHandler ignoredDelegate) { }

    /** Compatibility constructor; a bridge cannot supply owner resolution or canonical runtime submit/result readback. */
    public MultimodalInferenceToolHandler(MediaToolJobBridge ignoredBridge,
            AuthenticatedPrincipal ignoredPrincipal) { }

    /** Compatibility constructor; the vision-track launcher operation is not the canonical cross-modal operation. */
    public MultimodalInferenceToolHandler(MediaLauncherDelegate ignoredLauncher,
            AuthenticatedPrincipal ignoredPrincipal) { }

    @Override
    public Promise<ToolExecutionResult> handle(ToolExecutionEnvelope envelope, ToolContract contract) {
        Objects.requireNonNull(envelope, "envelope must not be null");
        Objects.requireNonNull(contract, "contract must not be null");

        Instant start = Instant.now();
        Map<String, Object> input;

        try {
            input = AgentToolInput.checked(envelope, contract, TOOL_ID, INPUT_FIELDS);
            validateCanonicalInput(input);
        } catch (Exception e) {
            String errorCode = validationErrorCode(e);
            if ("UNKNOWN_INPUT_FIELD".equals(errorCode) || "TOOL_INPUT_SCHEMA_VIOLATION".equals(errorCode)) {
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
        // Owner-backed resolution and the admitted canonical runtime submit/result path are absent. Neither a generic
        // job bridge, compatibility ToolHandler, nor the vision-track delegate can stand in for those authorities.
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

    /** Structural validation for the exact PDP-1 input1/input2 tool contract. */
    static void validateCanonicalInput(Map<String, Object> input) {
        requireKeys(input, Set.of("input1", "input2"), Set.of("input1", "input2"));

        Map<?, ?> input1 = object(input.get("input1"));
        requireKeys(input1, Set.of("artifactType", "payload"), Set.of("artifactType", "payload"));
        requireConst(input1.get("artifactType"), "authorized-media-artifacts");
        Map<?, ?> artifact = object(input1.get("payload"));
        requireKeys(artifact, Set.of("artifactId", "versionId"),
                Set.of("artifactId", "versionId", "sourceRef", "declaredMediaType", "declaredByteLength"));
        requirePattern(artifact.get("artifactId"), 1, 128, ARTIFACT_ID);
        requirePattern(artifact.get("versionId"), 1, 128, VERSION_ID);
        if (artifact.containsKey("sourceRef")) requireString(artifact.get("sourceRef"), 1, 384);
        if (artifact.containsKey("declaredMediaType")) requirePattern(artifact.get("declaredMediaType"), 3, 127, MEDIA_TYPE);
        if (artifact.containsKey("declaredByteLength")) requireInteger(artifact.get("declaredByteLength"), 0, 2_147_483_648L);

        Map<?, ?> input2 = object(input.get("input2"));
        requireKeys(input2, Set.of("artifactType", "payload"), Set.of("artifactType", "payload"));
        requireConst(input2.get("artifactType"), "analysis-request");
        Map<?, ?> analysis = object(input2.get("payload"));
        requireKeys(analysis, Set.of("dimensions", "criteria"),
                Set.of("dimensions", "criteria", "timeRange", "pageSize", "pageToken"));
        requireStringArray(analysis.get("dimensions"), 1, 32, 128, ARTIFACT_ID, false);
        if (analysis.containsKey("timeRange")) requireString(analysis.get("timeRange"), 1, 256);
        if (analysis.containsKey("pageSize")) requireInteger(analysis.get("pageSize"), 1, 100);
        if (analysis.containsKey("pageToken")) requireString(analysis.get("pageToken"), 1, 512);

        Map<?, ?> criteria = object(analysis.get("criteria"));
        requireKeys(criteria,
                Set.of("subjectRefs", "analysisMethodRef", "profileRef", "configurationDigest", "purposeRef"),
                Set.of("subjectRefs", "analysisMethodRef", "profileRef", "configurationDigest", "purposeRef",
                        "sourceTimeRangeRef", "regionOrChannelRefs", "uncertaintyPolicyRef"));
        requireStringArray(criteria.get("subjectRefs"), 1, 16, 384, null, true);
        requireString(criteria.get("analysisMethodRef"), 1, 256);
        requireString(criteria.get("profileRef"), 1, 384);
        requirePattern(criteria.get("configurationDigest"), 71, 71, SHA256);
        requireString(criteria.get("purposeRef"), 1, 256);
        if (criteria.containsKey("sourceTimeRangeRef")) requireString(criteria.get("sourceTimeRangeRef"), 1, 384);
        if (criteria.containsKey("regionOrChannelRefs"))
            requireStringArray(criteria.get("regionOrChannelRefs"), 0, 64, 384, null, true);
        if (criteria.containsKey("uncertaintyPolicyRef")) requireString(criteria.get("uncertaintyPolicyRef"), 1, 384);
    }

    private static Map<?, ?> object(Object value) {
        if (value instanceof Map<?, ?> object) return object;
        throw inputSchemaViolation();
    }

    private static void requireKeys(Map<?, ?> object, Set<String> required, Set<String> allowed) {
        if (!object.keySet().containsAll(required)
                || object.keySet().stream().anyMatch(key -> !(key instanceof String text) || !allowed.contains(text))) {
            throw inputSchemaViolation();
        }
    }

    private static void requireConst(Object value, String expected) {
        if (!expected.equals(value)) throw inputSchemaViolation();
    }

    private static void requireString(Object value, int minLength, int maxLength) {
        if (!(value instanceof String text) || text.length() < minLength || text.length() > maxLength)
            throw inputSchemaViolation();
    }

    private static void requirePattern(Object value, int minLength, int maxLength, Pattern pattern) {
        if (!(value instanceof String text) || text.length() < minLength || text.length() > maxLength
                || !pattern.matcher(text).matches()) throw inputSchemaViolation();
    }

    private static void requireStringArray(Object value, int minItems, int maxItems, int maxLength,
            Pattern pattern, boolean unique) {
        if (!(value instanceof java.util.List<?> items) || items.size() < minItems || items.size() > maxItems)
            throw inputSchemaViolation();
        Set<String> seen = unique ? new java.util.HashSet<>() : null;
        for (Object item : items) {
            requireString(item, 1, maxLength);
            String text = (String) item;
            if (pattern != null && !pattern.matcher(text).matches()) throw inputSchemaViolation();
            if (unique && !seen.add(text)) throw inputSchemaViolation();
        }
    }

    private static void requireInteger(Object value, long min, long max) {
        if (!(value instanceof Number number) || !AgentToolInput.isSupportedJsonNumber(number)
                || !Double.isFinite(number.doubleValue()) || number.doubleValue() != Math.rint(number.doubleValue())
                || number.doubleValue() < min || number.doubleValue() > max) throw inputSchemaViolation();
    }

    private static IllegalArgumentException inputSchemaViolation() {
        return new IllegalArgumentException("TOOL_INPUT_SCHEMA_VIOLATION");
    }

    private static String validationErrorCode(Exception error) {
        String message = error.getMessage();
        return message != null && VALIDATION_CODES.contains(message) ? message : "MULTIMODAL_INPUT_INVALID";
    }

}
