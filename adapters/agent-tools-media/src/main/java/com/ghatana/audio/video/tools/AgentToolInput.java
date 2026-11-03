/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SchemaRegistryConfig;
import com.networknt.schema.SpecificationVersion;
import io.activej.promise.Promise;
import com.ghatana.toolruntime.ToolHandler;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayDeque;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.Set;
import java.util.Base64;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;

/** Shared fail-closed validation for the four Media Agent Tool adapters. */
final class AgentToolInput {
    private static final int MAX_SCHEMA_JSON_CHARS = 262_144;
    // Inline audio is bounded by the handlers at 20 MiB after base64 decode.
    // A 20 MiB payload expands to about 27 MiB of base64, so the aggregate
    // serialized input byte ceiling leaves limited room for the rest of the
    // request while still allowing the supported inline-media maximum.
    private static final int MAX_INPUT_JSON_BYTES = 32 * 1024 * 1024;
    private static final int MAX_INPUT_ESTIMATED_CHARS = 180_000_000;
    private static final int MAX_OUTPUT_JSON_CHARS = 1_048_576;
    private static final int MAX_SCHEMA_OR_OUTPUT_NODES = 20_000;
    private static final int MAX_SCHEMA_OR_OUTPUT_DEPTH = 64;
    private static final Set<String> DRAFT_2020_12_KEYWORDS = Set.of(
            "$anchor", "$comment", "$defs", "$dynamicAnchor", "$dynamicRef", "$id", "$ref", "$schema", "$vocabulary",
            "additionalProperties", "allOf", "anyOf", "const", "contains", "contentEncoding", "contentMediaType",
            "contentSchema", "default", "definitions", "deprecated", "dependentRequired", "dependentSchemas", "description",
            "else", "enum", "examples", "exclusiveMaximum", "exclusiveMinimum", "format", "if", "items", "maxContains",
            "maximum", "maxItems", "maxLength", "maxProperties", "minContains", "minimum", "minItems", "minLength",
            "minProperties", "multipleOf", "not", "oneOf", "pattern", "patternProperties", "prefixItems", "properties",
            "propertyNames", "readOnly", "required", "then", "title", "type", "unevaluatedItems", "unevaluatedProperties",
            "uniqueItems", "writeOnly");
    private static final Set<String> SCHEMA_MAP_KEYWORDS = Set.of(
            "$defs", "definitions", "properties", "patternProperties", "dependentSchemas");
    private static final Set<String> SCHEMA_SINGLE_KEYWORDS = Set.of(
            "items", "contains", "additionalProperties", "unevaluatedItems", "unevaluatedProperties",
            "propertyNames", "contentSchema", "if", "then", "else", "not");
    private static final Set<String> SCHEMA_ARRAY_KEYWORDS = Set.of("allOf", "anyOf", "oneOf", "prefixItems");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final SchemaRegistry LOCAL_SCHEMA_REGISTRY = SchemaRegistry.withDefaultDialect(
            SpecificationVersion.DRAFT_2020_12,
            builder -> builder.schemaLoader(loader -> loader.fetchRemoteResources(false))
                    .schemaRegistryConfig(SchemaRegistryConfig.builder()
                            .strict(SpecificationVersion.DRAFT_2020_12.getDialectId(), true)
                            .build()));

    private AgentToolInput() { }

    static Map<String, Object> checked(ToolExecutionEnvelope envelope, ToolContract contract,
            String toolId, Set<String> fields) {
        if (!toolId.equals(envelope.toolId()) || !toolId.equals(contract.toolId()))
            throw new IllegalArgumentException("TOOL_ID_MISMATCH");
        if (!envelope.toolVersion().equals(contract.toolVersion()))
            throw new IllegalArgumentException("TOOL_VERSION_MISMATCH");
        if (envelope.actionClass() != contract.actionClass())
            throw new IllegalArgumentException("TOOL_ACTION_CLASS_MISMATCH");
        // Apply generic allocation/shape limits before walking the input key set
        // for the tool-specific whitelist. Inputs without a registered schema
        // still need the same bounds, and an oversized map must not force an
        // unbounded preliminary scan before those limits take effect.
        validateInputBounds(envelope.input());
        if (!fields.containsAll(envelope.input().keySet()))
            throw new IllegalArgumentException("UNKNOWN_INPUT_FIELD");
        // A Media tool effect is tenant-scoped: without a non-blank tenant
        // context no authorization decision is possible, so the envelope must
        // fail closed before any provider call rather than run unattributed.
        if (envelope.tenantId() == null || envelope.tenantId().isBlank())
            throw new IllegalArgumentException("MISSING_TENANT_CONTEXT");
        validateInputSchema(contract.inputSchema(), envelope.input());
        return envelope.input();
    }

    /**
     * Validate the registered input contract before the handler interprets a
     * field or delegates an effect. Empty schemas remain explicitly unresolved
     * for compatibility with source contracts that have not been installed.
     */
    private static void validateInputSchema(Map<String, Object> schema, Object input) {
        if (schema.isEmpty()) return;
        try {
            if (!withinTreeBounds(schema, MAX_SCHEMA_OR_OUTPUT_NODES, MAX_SCHEMA_OR_OUTPUT_DEPTH,
                            MAX_SCHEMA_JSON_CHARS)
                    || !usesSupportedSchemaKeywords(schema)) {
                throw inputSchemaViolation();
            }
            Object declaredDialect = schema.get("$schema");
            if (declaredDialect != null
                    && !SpecificationVersion.DRAFT_2020_12.getDialectId().equals(declaredDialect)) {
                throw inputSchemaViolation();
            }
            String schemaJson = JSON.writeValueAsString(schema);
            String inputJson = JSON.writeValueAsString(input);
            if (schemaJson.length() > MAX_SCHEMA_JSON_CHARS
                    || inputJson.length() > MAX_INPUT_ESTIMATED_CHARS) {
                throw inputSchemaViolation();
            }
            Schema compiled = LOCAL_SCHEMA_REGISTRY.getSchema(schemaJson, InputFormat.JSON);
            if (!compiled.validate(inputJson, InputFormat.JSON).isEmpty()) throw inputSchemaViolation();
        } catch (InputSchemaViolation invalidInput) {
            throw invalidInput;
        } catch (StackOverflowError recursiveSchema) {
            // A local $ref cycle can recurse without consuming input depth.
            // Do not let a malformed registered schema exhaust the caller's
            // stack before an effect boundary.
            throw inputSchemaViolation();
        } catch (RuntimeException invalidSchemaOrInput) {
            // Remote/unresolved references, unsupported dialects, malformed
            // schemas and non-JSON values fail before any delegate effect.
            throw inputSchemaViolation();
        }
    }

    /** Bounds apply even when the registry has not installed an input schema. */
    private static void validateInputBounds(Object input) {
        if (!withinTreeBounds(input, MAX_SCHEMA_OR_OUTPUT_NODES, MAX_SCHEMA_OR_OUTPUT_DEPTH,
                MAX_INPUT_ESTIMATED_CHARS)
                || !withinUtf8ByteBounds(input, MAX_INPUT_JSON_BYTES)) {
            throw inputSchemaViolation();
        }
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
            if (result.status() == ToolExecutionStatus.SUCCESS) {
                validateOutput(contract.outputSchema(), result.output());
            }
            return result;
        });
    }

    /**
     * Checks successful delegate payloads against the output schema supplied by
     * the registered ToolContract. This is structural validation only: it does
     * not infer finality, authorization, evidence, or provider semantics.
     */
    private static void validateOutput(Map<String, Object> schema, Object output) {
        try {
            if (!withinTreeBounds(output, MAX_SCHEMA_OR_OUTPUT_NODES, MAX_SCHEMA_OR_OUTPUT_DEPTH, MAX_OUTPUT_JSON_CHARS)) {
                throw outputSchemaViolation();
            }
            if (!withinUtf8ByteBounds(output, MAX_OUTPUT_JSON_CHARS)) throw outputSchemaViolation();
            if (schema.isEmpty()) return; // An absent registered schema remains unresolved.
            Object declaredDialect = schema.get("$schema");
            if (declaredDialect != null && !SpecificationVersion.DRAFT_2020_12.getDialectId().equals(declaredDialect)) {
                throw outputSchemaViolation();
            }
            if (!withinTreeBounds(schema, MAX_SCHEMA_OR_OUTPUT_NODES, MAX_SCHEMA_OR_OUTPUT_DEPTH, MAX_SCHEMA_JSON_CHARS)) {
                throw outputSchemaViolation();
            }
            if (!usesSupportedSchemaKeywords(schema)) throw outputSchemaViolation();
            String schemaJson = JSON.writeValueAsString(schema);
            String outputJson = JSON.writeValueAsString(output);
            if (schemaJson.length() > MAX_SCHEMA_JSON_CHARS || outputJson.length() > MAX_OUTPUT_JSON_CHARS) {
                throw outputSchemaViolation();
            }
            Schema compiled = LOCAL_SCHEMA_REGISTRY.getSchema(schemaJson, InputFormat.JSON);
            if (!compiled.validate(outputJson, InputFormat.JSON).isEmpty()) throw outputSchemaViolation();
        } catch (OutputSchemaViolation invalidResult) {
            throw invalidResult;
        } catch (StackOverflowError recursiveSchema) {
            // Match input handling for recursive output refs. The delegate
            // outcome remains a failed validation, never an unbounded stack
            // error or a successful unvalidated result.
            throw outputSchemaViolation();
        } catch (RuntimeException invalidSchemaOrOutput) {
            // Malformed schemas, unresolved external references, unsupported
            // dialects and serialization errors fail closed without leaking data.
            throw outputSchemaViolation();
        }
    }

    private static boolean usesSupportedSchemaKeywords(Map<String, Object> root) {
        ArrayDeque<Object> pending = new ArrayDeque<>();
        pending.push(root);
        while (!pending.isEmpty()) {
            Object next = pending.pop();
            if (next instanceof Boolean) continue;
            if (!(next instanceof Map<?, ?> schema)) return false;
            for (Map.Entry<?, ?> entry : schema.entrySet()) {
                if (!(entry.getKey() instanceof String keyword) || !DRAFT_2020_12_KEYWORDS.contains(keyword)) return false;
                Object value = entry.getValue();
                if ("$schema".equals(keyword)
                        && !SpecificationVersion.DRAFT_2020_12.getDialectId().equals(value)) return false;
                if (SCHEMA_MAP_KEYWORDS.contains(keyword)) {
                    if (!(value instanceof Map<?, ?> childSchemas)) return false;
                    for (Object child : childSchemas.values()) {
                        if (!enqueueSchema(pending, child)) return false;
                    }
                } else if (SCHEMA_SINGLE_KEYWORDS.contains(keyword)) {
                    if (!enqueueSchema(pending, value)) return false;
                } else if (SCHEMA_ARRAY_KEYWORDS.contains(keyword)) {
                    if (!(value instanceof java.util.List<?> childSchemas)) return false;
                    for (Object child : childSchemas) {
                        if (!enqueueSchema(pending, child)) return false;
                    }
                }
            }
        }
        return true;
    }

    private static boolean enqueueSchema(ArrayDeque<Object> pending, Object schema) {
        if (schema instanceof Map<?, ?> || schema instanceof Boolean) {
            pending.push(schema);
            return true;
        }
        return false;
    }

    private static boolean withinTreeBounds(Object root, int maxNodes, int maxDepth, int maxSerializedChars) {
        record Item(Object value, int depth) { }
        ArrayDeque<Item> pending = new ArrayDeque<>();
        IdentityHashMap<Object, Boolean> containers = new IdentityHashMap<>();
        pending.push(new Item(root, 0));
        int nodes = 0;
        long estimatedChars = 2;
        while (!pending.isEmpty()) {
            Item item = pending.pop();
            if (++nodes > maxNodes || item.depth() > maxDepth) return false;
            Object value = item.value();
            if (value instanceof Map<?, ?> map) {
                if (containers.put(map, Boolean.TRUE) != null
                        || map.size() > maxNodes - nodes - pending.size()) return false;
                estimatedChars += 2L + map.size();
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!(entry.getKey() instanceof String key) || key.length() > maxSerializedChars) return false;
                    estimatedChars += 3L + (6L * key.length());
                    pending.push(new Item(entry.getValue(), item.depth() + 1));
                }
            } else if (value instanceof java.util.List<?> values) {
                if (containers.put(values, Boolean.TRUE) != null
                        || values.size() > maxNodes - nodes - pending.size()) return false;
                estimatedChars += 2L + values.size();
                for (Object child : values) pending.push(new Item(child, item.depth() + 1));
            } else if (value instanceof String text) {
                estimatedChars += 2L + (6L * text.length());
            } else if (value instanceof Number number) {
                if (!isSupportedJsonNumber(number)) return false;
                estimatedChars += number.toString().length();
                if (!Double.isFinite(number.doubleValue())
                        && !(number instanceof java.math.BigInteger || number instanceof java.math.BigDecimal)) return false;
            } else if (value == null) {
                estimatedChars += 4;
            } else if (value instanceof Boolean bool) {
                estimatedChars += bool ? 4 : 5;
            } else {
                return false;
            }
            if (estimatedChars > maxSerializedChars) return false;
        }
        return true;
    }

    /** Counts UTF-8 JSON payload bytes without first allocating a serialized copy. */
    private static boolean withinUtf8ByteBounds(Object root, int maxBytes) {
        ArrayDeque<Object> pending = new ArrayDeque<>();
        IdentityHashMap<Object, Boolean> containers = new IdentityHashMap<>();
        pending.push(root);
        long bytes = 2; // Root delimiters, conservatively covering object or array inputs.
        while (!pending.isEmpty()) {
            Object value = pending.pop();
            if (value instanceof Map<?, ?> map) {
                if (containers.put(map, Boolean.TRUE) != null) return false;
                bytes += 2L + (2L * map.size()); // braces, commas, and colons, conservatively
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!(entry.getKey() instanceof String key)) return false;
                    bytes += utf8JsonStringBytes(key);
                    pending.push(entry.getValue());
                }
            } else if (value instanceof java.util.List<?> values) {
                if (containers.put(values, Boolean.TRUE) != null) return false;
                bytes += 2L + values.size(); // brackets and commas
                for (Object child : values) pending.push(child);
            } else if (value instanceof String text) {
                bytes += utf8JsonStringBytes(text);
            } else if (value instanceof Number number) {
                if (!isSupportedJsonNumber(number)) return false;
                bytes += number.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
            } else if (value == null) {
                bytes += 4;
            } else if (value instanceof Boolean bool) {
                bytes += bool ? 4 : 5;
            } else {
                return false;
            }
            if (bytes > maxBytes) return false;
        }
        return true;
    }

    private static long utf8JsonStringBytes(String value) {
        long bytes = 2; // JSON string quotes.
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (current == '"' || current == '\\' || current < 0x20) {
                bytes += current < 0x20 ? 6 : 2; // conservative JSON escaping
            } else if (Character.isHighSurrogate(current) && index + 1 < value.length()
                    && Character.isLowSurrogate(value.charAt(index + 1))) {
                bytes += 4;
                index++;
            } else if (Character.isSurrogate(current)) {
                bytes += 6; // malformed surrogate is escaped by the JSON serializer
            } else if (current <= 0x7f) {
                bytes++;
            } else if (current <= 0x7ff) {
                bytes += 2;
            } else {
                bytes += 3;
            }
        }
        return bytes;
    }

    static boolean isSupportedJsonNumber(Number number) {
        return number instanceof Byte || number instanceof Short || number instanceof Integer || number instanceof Long
                || number instanceof Float || number instanceof Double || number instanceof java.math.BigInteger
                || number instanceof java.math.BigDecimal;
    }

    private static OutputSchemaViolation outputSchemaViolation() {
        return new OutputSchemaViolation();
    }

    private static InputSchemaViolation inputSchemaViolation() {
        return new InputSchemaViolation();
    }

    private static final class InputSchemaViolation extends IllegalArgumentException {
        private InputSchemaViolation() {
            super("TOOL_INPUT_SCHEMA_VIOLATION");
        }
    }

    private static final class OutputSchemaViolation extends IllegalStateException {
        private OutputSchemaViolation() {
            super("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        }
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
