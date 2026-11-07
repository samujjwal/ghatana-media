package com.ghatana.media.runtime;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.io.InputStream;
import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaPublicLifecycleEventTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final HmacMediaLifecycleIdentifierRedactor REDACTOR =
            new HmacMediaLifecycleIdentifierRedactor(new byte[32]);

    @Test
    void mapsObservedLifecycleNamesToVersionedTypedPayloadWithPurposeSeparatedRedactedIds() {
        MediaPublicLifecycleEvent publicEvent = MediaPublicLifecycleEvent.fromInternal(internal("media.job.completed"), REDACTOR);
        assertThat(publicEvent.schemaVersion()).isEqualTo("1.0.0");
        assertThat(publicEvent.eventType()).isEqualTo(MediaLifecycleEventType.JOB_COMPLETED);
        assertThat(publicEvent.eventRef()).matches("r1_[0-9a-f]{64}").isNotEqualTo("event-raw");
        assertThat(publicEvent.tenantRef()).isNotEqualTo("tenant-private");
        assertThat(publicEvent.principalRef()).isNotEqualTo("principal-private");
        assertThat(publicEvent.aggregateRef()).isNotEqualTo("job-private");
        assertThat(publicEvent.eventRef()).isNotEqualTo(publicEvent.aggregateRef());
        assertThat(publicEvent.appendFinality()).isEqualTo(MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND);
        assertThat(publicEvent.terminalReadbackRequired()).isTrue();
        assertThat(publicEvent.toPayload()).doesNotContainKey("attributes");
        assertThat(MediaPublicLifecycleEvent.fromPayload(publicEvent.toPayload())).isEqualTo(publicEvent);
        var malformed = new java.util.LinkedHashMap<>(publicEvent.toPayload());
        malformed.put("providerToken", "must-not-pass");
        assertThatThrownBy(() -> MediaPublicLifecycleEvent.fromPayload(malformed))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("fields");
    }

    @Test
    void hmacAliasesAreStableAndCannotBeReusedAcrossIdentifierKinds() {
        assertThat(REDACTOR.redact("tenant", "tenant-private"))
                .isEqualTo(REDACTOR.redact("tenant", "tenant-private"));
        assertThat(REDACTOR.redact("tenant", "tenant-private"))
                .isNotEqualTo(REDACTOR.redact("principal", "tenant-private"));
        assertThatThrownBy(() -> new HmacMediaLifecycleIdentifierRedactor(new byte[8]))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void terminalTypeDoesNotChangeAppendFinalityAndUnknownTypesFailClosed() {
        var event = MediaPublicLifecycleEvent.fromInternal(internal("media.job.accepted"), REDACTOR);
        assertThat(event.appendFinality()).isEqualTo(MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND);
        assertThat(event.terminalReadbackRequired()).isFalse();
        assertThatThrownBy(() -> MediaPublicLifecycleEvent.fromInternal(internal("media.job.custom"), REDACTOR))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("Unsupported");
        assertThatThrownBy(() -> new MediaPublicLifecycleEvent("2.0.0", "r1_x",
                MediaLifecycleEventType.JOB_COMPLETED, "r1_x", "r1_x", "r1_x", "", "job", "r1_x",
                1, "CONFIDENTIAL", Instant.EPOCH,
                MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND, true))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("schema version");
    }

    @Test
    void publicProjectionRejectsFreeTextThatCouldLeakInClassificationOrAggregateType() {
        var payload = new java.util.LinkedHashMap<>(MediaPublicLifecycleEvent.fromInternal(
                internal("media.job.accepted"), REDACTOR).toPayload());
        payload.put("classification", "RESTRICTED principal@example.test");
        assertThatThrownBy(() -> MediaPublicLifecycleEvent.fromPayload(payload))
                .isInstanceOf(IllegalArgumentException.class);

        assertThatThrownBy(() -> new MediaPublicLifecycleEvent("1.0.0", "r1_" + "a".repeat(64),
                MediaLifecycleEventType.JOB_ACCEPTED, "r1_" + "b".repeat(64), "r1_" + "c".repeat(64),
                "r1_" + "d".repeat(64), "", "job-private-123", "r1_" + "e".repeat(64),
                1, "RESTRICTED user@example.test", Instant.EPOCH,
                MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND, false))
                .isInstanceOf(IllegalArgumentException.class);

        assertThatThrownBy(() -> new MediaPublicLifecycleEvent("1.0.0", "r1_" + "a".repeat(64),
                MediaLifecycleEventType.JOB_ACCEPTED, "r1_" + "b".repeat(64), "r1_" + "c".repeat(64),
                "r1_" + "d".repeat(64), "", "job", "r1_" + "e".repeat(64),
                1, "raw-tenant-123", Instant.EPOCH,
                MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND, false))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void payloadParserRejectsValuesThatThePinnedSchemaDoesNotAcceptExactly() {
        Map<String, Object> valid = MediaPublicLifecycleEvent.fromInternal(
                internal("media.job.accepted"), REDACTOR).toPayload();

        var spacedIdentifier = new java.util.LinkedHashMap<>(valid);
        spacedIdentifier.put("eventRef", " " + valid.get("eventRef") + " ");
        assertThatThrownBy(() -> MediaPublicLifecycleEvent.fromPayload(spacedIdentifier))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("eventRef");

        var spacedCausation = new java.util.LinkedHashMap<>(valid);
        spacedCausation.put("causationRef", " ");
        assertThatThrownBy(() -> MediaPublicLifecycleEvent.fromPayload(spacedCausation))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("causationRef");

        var normalizedAggregate = new java.util.LinkedHashMap<>(valid);
        normalizedAggregate.put("aggregateType", " JOB ");
        assertThatThrownBy(() -> MediaPublicLifecycleEvent.fromPayload(normalizedAggregate))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("aggregateType");

        var normalizedClassification = new java.util.LinkedHashMap<>(valid);
        normalizedClassification.put("classification", " confidential ");
        assertThatThrownBy(() -> MediaPublicLifecycleEvent.fromPayload(normalizedClassification))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("classification");
    }

    @Test
    void publicSchemaPinsVersionEventNamesRedactedIdentifiersAndNonfinalAppendAbi() throws Exception {
        try (InputStream input = getClass().getResourceAsStream("/contracts/media-public-lifecycle-event-v1.schema.json")) {
            assertThat(input).isNotNull();
            var schema = JSON.readTree(input);
            assertThat(schema.path("$id").textValue()).isEqualTo(MediaPublicLifecycleEvent.SCHEMA_URI);
            assertThat(schema.path("additionalProperties").booleanValue()).isFalse();
            assertThat(schema.path("properties").path("schemaVersion").path("const").textValue()).isEqualTo("1.0.0");
            assertThat(schema.path("properties").path("appendFinality").path("const").textValue()).isEqualTo("NON_FINAL_APPEND");
            assertThat(schema.path("properties").path("aggregateType").path("enum").toString())
                    .isEqualTo("[\"upload\",\"artifact\",\"job\",\"stream\"]");
            assertThat(schema.path("properties").path("classification").path("enum").toString())
                    .isEqualTo("[\"PUBLIC\",\"INTERNAL\",\"CONFIDENTIAL\",\"RESTRICTED\"]");
            assertThat(schema.path("$defs").path("redactedId").path("pattern").textValue())
                    .isEqualTo("^r1_[0-9a-f]{64}$");
            assertThat(schema.path("$defs").path("eventType").path("enum").size())
                    .isEqualTo(MediaLifecycleEventType.values().length);
        }
    }

    private static MediaLifecycleEvent internal(String type) {
        return new MediaLifecycleEvent("event-raw", type, "tenant-private", "principal-private",
                "correlation-private", "", "job", "job-private", 3, "CONFIDENTIAL",
                Instant.parse("2026-11-05T12:00:00Z"), Map.of("status", "COMPLETED", "private", "drop"));
    }
}
