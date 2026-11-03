package com.ghatana.media.runtime;

import tools.jackson.databind.JsonNode;

import java.math.BigInteger;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.HashSet;
import java.util.Set;

/**
 * Lossless assertions for formats declared by the PDP-1 declarative production schemas.
 * JSON Schema treats format as annotation by default, so the schema validator alone is
 * insufficient for the custom integer/reference formats used by these contracts.
 */
final class MediaProductionSchemaFormatAssertions {
    private static final int MAX_SCHEMA_DEPTH = 64;
    private static final BigInteger INT64_MIN = BigInteger.valueOf(Long.MIN_VALUE);
    private static final BigInteger INT64_MAX = BigInteger.valueOf(Long.MAX_VALUE);
    private static final Set<String> SUPPORTED_FORMATS = Set.of(
            "opaque-id", "opaque-versioned-reference", "signed-int64-decimal",
            "positive-int64-decimal", "date-time");

    private MediaProductionSchemaFormatAssertions() { }

    static void validate(JsonNode schema, JsonNode instance) {
        visit(schema, schema, instance, 0, new HashSet<>());
    }

    private static void visit(JsonNode rootSchema, JsonNode schema, JsonNode instance, int depth,
            Set<String> activeRefs) {
        if (depth > MAX_SCHEMA_DEPTH || schema == null || !schema.isObject()) {
            throw invalid("schema nesting exceeds the supported bound");
        }
        JsonNode ref = schema.get("$ref");
        if (ref != null) {
            if (!ref.isString() || !ref.asString().startsWith("#/$defs/")) {
                throw invalid("only local PDP-1 schema references are supported");
            }
            String name = ref.asString().substring("#/$defs/".length());
            if (!name.matches("[A-Za-z0-9._-]+") || !activeRefs.add(name)) {
                throw invalid("recursive or malformed schema reference is unsupported");
            }
            JsonNode target = rootSchema.path("$defs").get(name);
            if (target == null) throw invalid("schema reference is unresolved");
            visit(rootSchema, target, instance, depth + 1, activeRefs);
            activeRefs.remove(name);
        }

        JsonNode format = schema.get("format");
        if (format != null) {
            if (!format.isString()) throw invalid("schema format must be a string");
            assertFormat(format.asString(), instance);
        }

        JsonNode definitions = schema.get("$defs");
        if (definitions != null) {
            if (!definitions.isObject()) throw invalid("schema definitions must be an object");
            for (String name : definitions.propertyNames()) {
                visit(rootSchema, definitions.get(name), null, depth + 1, new HashSet<>(activeRefs));
            }
        }
        JsonNode properties = schema.get("properties");
        if (properties != null) {
            if (!properties.isObject()) throw invalid("schema properties must be an object");
            // Validate every declared property schema even when that optional
            // property is absent, so unknown formats and recursive references
            // cannot hide behind an omitted input field.
            for (String name : properties.propertyNames()) {
                JsonNode value = instance != null && instance.isObject() ? instance.get(name) : null;
                visit(rootSchema, properties.get(name), value, depth + 1, new HashSet<>(activeRefs));
            }
        }
        JsonNode items = schema.get("items");
        if (items != null) {
            if (instance != null && instance.isArray()) {
                for (JsonNode value : instance) {
                    visit(rootSchema, items, value, depth + 1, new HashSet<>(activeRefs));
                }
            } else {
                visit(rootSchema, items, null, depth + 1, new HashSet<>(activeRefs));
            }
        }
        for (String keyword : Set.of("allOf", "anyOf", "oneOf")) {
            JsonNode branches = schema.get(keyword);
            if (branches != null) {
                if (!branches.isArray()) throw invalid("schema branches must be an array");
                for (JsonNode branch : branches) {
                    visit(rootSchema, branch, instance, depth + 1, new HashSet<>(activeRefs));
                }
            }
        }
    }

    static void assertFormat(String format, JsonNode value) {
        if (!SUPPORTED_FORMATS.contains(format)) {
            throw invalid("unsupported schema format: " + format);
        }
        if (value == null || value.isNull()) return;
        if (!value.isString()) throw invalid("formatted value must be a string");
        String text = value.asString();
        switch (format) {
            case "opaque-id" -> {
                if (text.length() > 128 || !text.matches("[A-Za-z0-9][A-Za-z0-9._:-]*")) {
                    throw invalid("opaque-id format is invalid");
                }
            }
            case "opaque-versioned-reference" -> {
                if (!MediaVersionRefRules.isValid(text)) {
                    throw invalid("opaque-versioned-reference format is invalid");
                }
            }
            case "signed-int64-decimal" -> assertInt64Decimal(text, false);
            case "positive-int64-decimal" -> assertInt64Decimal(text, true);
            case "date-time" -> {
                try {
                    OffsetDateTime.parse(text);
                } catch (DateTimeParseException invalidDateTime) {
                    throw invalid("date-time format is invalid");
                }
            }
            default -> throw invalid("unsupported schema format: " + format);
        }
    }

    private static void assertInt64Decimal(String text, boolean positive) {
        String pattern = positive ? "[1-9][0-9]*" : "(?:0|-[1-9][0-9]*|[1-9][0-9]*)";
        if (!text.matches(pattern)) throw invalid("decimal integer is not canonical");
        BigInteger value = new BigInteger(text);
        if (value.compareTo(INT64_MIN) < 0 || value.compareTo(INT64_MAX) > 0
                || (positive && value.signum() <= 0)) {
            throw invalid("decimal integer is outside the declared signed-64-bit range");
        }
    }

    private static IllegalArgumentException invalid(String reason) {
        return new IllegalArgumentException("PDP-1 production schema format validation failed: " + reason);
    }
}
