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
    void publicSchemaPinsVersionEventNamesRedactedIdentifiersAndNonfinalAppendAbi() throws Exception {
        try (InputStream input = getClass().getResourceAsStream("/contracts/media-public-lifecycle-event-v1.schema.json")) {
            assertThat(input).isNotNull();
            var schema = JSON.readTree(input);
            assertThat(schema.path("additionalProperties").booleanValue()).isFalse();
            assertThat(schema.path("properties").path("schemaVersion").path("const").textValue()).isEqualTo("1.0.0");
            assertThat(schema.path("properties").path("appendFinality").path("const").textValue()).isEqualTo("NON_FINAL_APPEND");
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
