package com.ghatana.media.runtime;

import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaProductionSchemaFormatAssertionsTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    private static tools.jackson.databind.JsonNode stringNode(String value) throws Exception {
        return JSON.readTree(JSON.writeValueAsString(value));
    }

    @Test
    void validatesSignedAndPositiveInt64DecimalFormatsWithoutFloatingPointConversion() throws Exception {
        assertThatCode(() -> MediaProductionSchemaFormatAssertions.assertFormat("signed-int64-decimal",
                JSON.readTree("\"-9223372036854775808\""))).doesNotThrowAnyException();
        assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.assertFormat("signed-int64-decimal",
                JSON.readTree("\"9223372036854775808\"")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("signed-64-bit range");
        assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.assertFormat("signed-int64-decimal",
                JSON.readTree("\"-0\"")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("not canonical");

        assertThatCode(() -> MediaProductionSchemaFormatAssertions.assertFormat("positive-int64-decimal",
                JSON.readTree("\"9223372036854775807\""))).doesNotThrowAnyException();
        assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.assertFormat("positive-int64-decimal",
                JSON.readTree("\"0\"")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("not canonical");
    }

    @Test
    void rejectsUnknownCustomFormatsAndRecursiveSchemaReferencesFailClosed() throws Exception {
        assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.assertFormat("custom-code",
                JSON.readTree("\"value\"")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("unsupported schema format");
        assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.assertFormat("custom-code",
                JSON.readTree("null")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("unsupported schema format");

        var recursive = JSON.readTree("""
                {"$defs":{"node":{"$ref":"#/$defs/node"}},"$ref":"#/$defs/node"}
                """);
        assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.validate(recursive, JSON.readTree("null")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("recursive");
    }

    @Test
    void rejectsUnknownFormatsAndRecursiveReferencesInOmittedOptionalProperties() throws Exception {
        var unknownOptionalFormat = JSON.readTree("""
                {"type":"object","properties":{"optional":{"type":"string","format":"custom-code"}}}
                """);
        assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.validate(
                unknownOptionalFormat, JSON.readTree("{}")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("unsupported schema format");

        var recursiveOptionalRef = JSON.readTree("""
                {"$defs":{"node":{"type":"object","properties":{"next":{"$ref":"#/$defs/node"}}}},
                 "type":"object","properties":{"optional":{"$ref":"#/$defs/node"}}}
                """);
        assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.validate(
                recursiveOptionalRef, JSON.readTree("{}")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("recursive");
    }

    @Test
    void appliesFormatAssertionsThroughObjectPropertiesAndLocalDefinitions() throws Exception {
        var schema = JSON.readTree("""
                {"type":"object","properties":{"n":{"type":"string","format":"signed-int64-decimal"}}}
                """);
        assertThatCode(() -> MediaProductionSchemaFormatAssertions.validate(schema,
                JSON.readTree("{\"n\":\"-9223372036854775808\"}"))).doesNotThrowAnyException();
        assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.validate(schema,
                JSON.readTree("{\"n\":\"9223372036854775808\"}")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("signed-64-bit range");
    }

    @Test
    void validatesOpaqueIdentifiersAndVersionReferencesIncludingMalformedText() throws Exception {
        assertThatCode(() -> MediaProductionSchemaFormatAssertions.assertFormat("opaque-id",
                stringNode("media.scene_1:rev-2"))).doesNotThrowAnyException();
        assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.assertFormat("opaque-id",
                stringNode("_invalid")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("opaque-id");
        assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.assertFormat("opaque-id",
                stringNode("a".repeat(129))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("opaque-id");

        assertThatCode(() -> MediaProductionSchemaFormatAssertions.assertFormat("opaque-versioned-reference",
                stringNode("artifact/source@rev-1"))).doesNotThrowAnyException();
        for (String invalid : new String[] {"", "artifact/has space", "x".repeat(385), "bad\uD800"}) {
            assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.assertFormat(
                    "opaque-versioned-reference", stringNode(invalid)))
                    .as("reject malformed version reference")
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("opaque-versioned-reference");
        }
    }

    @Test
    void validatesDateTimeAndCurrentNullableVersionReferenceOneOfPath() throws Exception {
        assertThatCode(() -> MediaProductionSchemaFormatAssertions.assertFormat("date-time",
                stringNode("2026-11-02T12:34:56Z"))).doesNotThrowAnyException();
        assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.assertFormat("date-time",
                stringNode("2026-11-02 12:34:56")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("date-time");

        var nullableVersionRefSchema = JSON.readTree("""
                {"$defs":{"versionRef":{"type":"string","format":"opaque-versioned-reference"}},
                 "oneOf":[{"$ref":"#/$defs/versionRef"},{"type":"null"}]}
                """);
        assertThatCode(() -> MediaProductionSchemaFormatAssertions.validate(nullableVersionRefSchema,
                JSON.readTree("\"artifact/source@rev-1\""))).doesNotThrowAnyException();
        assertThatCode(() -> MediaProductionSchemaFormatAssertions.validate(nullableVersionRefSchema,
                JSON.readTree("null"))).doesNotThrowAnyException();
        assertThatThrownBy(() -> MediaProductionSchemaFormatAssertions.validate(nullableVersionRefSchema,
                stringNode("artifact/has space")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("opaque-versioned-reference");
    }
}
