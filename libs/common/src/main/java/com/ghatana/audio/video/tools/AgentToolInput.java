/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import io.activej.promise.Promise;
import com.ghatana.toolruntime.ToolHandler;

import java.util.Map;
import java.util.Set;
import java.util.Base64;
import java.util.Locale;
import java.util.Objects;

/** Shared fail-closed validation for the four Media Agent Tool adapters. */
final class AgentToolInput {
    private AgentToolInput() { }

    static Map<String, Object> checked(ToolExecutionEnvelope envelope, ToolContract contract,
            String toolId, Set<String> fields) {
        if (!toolId.equals(envelope.toolId()) || !toolId.equals(contract.toolId()))
            throw new IllegalArgumentException("TOOL_ID_MISMATCH");
        if (!envelope.toolVersion().equals(contract.toolVersion()))
            throw new IllegalArgumentException("TOOL_VERSION_MISMATCH");
        if (envelope.actionClass() != contract.actionClass())
            throw new IllegalArgumentException("TOOL_ACTION_CLASS_MISMATCH");
        if (!fields.containsAll(envelope.input().keySet()))
            throw new IllegalArgumentException("UNKNOWN_INPUT_FIELD");
        return envelope.input();
    }

    /**
     * Dispatch is an effect boundary. A synchronous throw, null promise, rejected
     * promise, or result for another invocation is ambiguous and must stay on the
     * error channel for the runtime to reconcile; it is never a local FAILED result.
     */
    static Promise<ToolExecutionResult> dispatch(ToolHandler delegate,
            ToolExecutionEnvelope envelope, ToolContract contract) {
        final Promise<ToolExecutionResult> delegated;
        try {
            delegated = Objects.requireNonNull(delegate.handle(envelope, contract), "delegate returned null promise");
        } catch (RuntimeException ambiguousDispatch) {
            return Promise.ofException(ambiguousDispatch);
        }
        return delegated.map(result -> {
            if (result == null || !envelope.invocationId().equals(result.invocationId())) {
                throw new IllegalStateException("DELEGATE_INVOCATION_IDENTITY_MISMATCH");
            }
            return result;
        });
    }

    static String requiredString(Map<String, Object> input, String key, int maxLength) {
        Object value = input.get(key);
        if (!(value instanceof String text) || text.isBlank() || text.length() > maxLength)
            throw new IllegalArgumentException("INVALID_" + key.replaceAll("[^A-Za-z0-9]", "_").toUpperCase());
        return text;
    }

    static double boundedRate(Object value) {
        if (!(value instanceof Number number)) throw new IllegalArgumentException("INVALID_SPEAKING_RATE");
        double rate = number.doubleValue();
        if (!Double.isFinite(rate) || rate < 0.25 || rate > 4.0) throw new IllegalArgumentException("INVALID_SPEAKING_RATE");
        return rate;
    }

    static int boundedInt(Object value) {
        if (!(value instanceof Number number)) throw new IllegalArgumentException("INVALID_MAX_RESULTS");
        int count = number.intValue();
        if (number.doubleValue() != count || count < 1 || count > 100) throw new IllegalArgumentException("INVALID_MAX_RESULTS");
        return count;
    }

    static String source(Map<String, Object> input, String container, String byteField, int maxBytes, boolean mimeTypeAllowed) {
        Object raw = input.get(container);
        if (!(raw instanceof Map<?, ?> map)) throw new IllegalArgumentException("INVALID_" + container.toUpperCase());
        if (map.size() > (mimeTypeAllowed ? 2 : 1)
                || map.keySet().stream().anyMatch(key -> !Set.of("mediaArtifactId", byteField, "mimeType").contains(key)))
            throw new IllegalArgumentException("INVALID_" + container.toUpperCase());
        if (map.containsKey("mediaArtifactId") == map.containsKey(byteField))
            throw new IllegalArgumentException("INVALID_" + container.toUpperCase());
        if (map.containsKey("mimeType")) {
            Object mime = map.get("mimeType");
            if (!mimeTypeAllowed || !Set.of("image/jpeg", "image/png", "image/webp").contains(mime))
                throw new IllegalArgumentException("INVALID_MIME_TYPE");
        }
        if (map.containsKey("mediaArtifactId")) return "artifact:" + requiredString(cast(map), "mediaArtifactId", 512);
        Object bytes = map.get(byteField);
        if (!(bytes instanceof String encoded) || encoded.isBlank() || encoded.length() > ((maxBytes + 2L) / 3L) * 4L)
            throw new IllegalArgumentException("INVALID_" + byteField.toUpperCase());
        try {
            byte[] payload = Base64.getDecoder().decode(encoded);
            if (payload.length == 0 || payload.length > maxBytes) throw new IllegalArgumentException("INVALID_" + byteField.toUpperCase());
        } catch (IllegalArgumentException invalidBase64) {
            throw new IllegalArgumentException("INVALID_" + byteField.toUpperCase());
        }
        return "bytes:inline";
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Map<?, ?> map) { return (Map<String, Object>) map; }

    static String languageTag(Object value, String fallback) {
        if (value == null) return fallback;
        if (!(value instanceof String tag) || tag.isBlank() || tag.length() > 64)
            throw new IllegalArgumentException("INVALID_LANGUAGE_CODE");
        try {
            String canonical = new Locale.Builder().setLanguageTag(tag).build().toLanguageTag();
            if ("und".equals(canonical)) throw new IllegalArgumentException("INVALID_LANGUAGE_CODE");
            return canonical;
        } catch (java.util.IllformedLocaleException invalid) {
            throw new IllegalArgumentException("INVALID_LANGUAGE_CODE");
        }
    }
}
