package com.ghatana.media.runtime;

import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Compatibility contract of {@code media.lifecycle-event.v1}: a frozen golden payload written by an earlier consumer
 * must keep parsing and validating, and anything outside the published schema must keep being refused. A change that
 * breaks this test is a breaking ABI change and needs a new schema version, not an edit of the golden file.
 */
class MediaPublicLifecycleEventCompatibilityTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    private static String resource(String name) throws Exception {
        try (InputStream input = MediaPublicLifecycleEventCompatibilityTest.class.getResourceAsStream(name)) {
            assertThat(input).as(name).isNotNull();
            return new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    private static Schema schema() throws Exception {
        return SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
                .getSchema(resource("/contracts/media-public-lifecycle-event-v1.schema.json"), InputFormat.JSON);
    }

    @Test
    void frozenGoldenPayloadValidatesAgainstThePublishedSchemaParsesAndRoundTripsExactly() throws Exception {
        String golden = resource("/contracts/media-public-lifecycle-event-v1.golden.json");
        assertThat(schema().validate(golden, InputFormat.JSON)).isEmpty();
        Map<String, Object> payload = JSON.readValue(golden, new tools.jackson.core.type.TypeReference<>() { });
        MediaPublicLifecycleEvent event = MediaPublicLifecycleEvent.fromPayload(payload);
        assertThat(event.eventType()).isEqualTo(MediaLifecycleEventType.JOB_COMPLETED);
        assertThat(event.appendFinality()).isEqualTo(MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND);
        assertThat(event.terminalReadbackRequired()).isTrue();
        assertThat((Object) JSON.readTree(JSON.writeValueAsString(event.toPayload()))).isEqualTo(JSON.readTree(golden));
    }

    @Test
    void everyPublicEventTypeProducesAPayloadThatValidatesAgainstTheSchema() throws Exception {
        JsonNode golden = JSON.readTree(resource("/contracts/media-public-lifecycle-event-v1.golden.json"));
        for (MediaLifecycleEventType type : MediaLifecycleEventType.values()) {
            ObjectNode payload = (ObjectNode) golden.deepCopy();
            payload.put("eventType", type.wireName());
            payload.put("aggregateType", type.aggregateType());
            payload.put("terminalReadbackRequired", type.terminalReadbackRequired());
            assertThat(schema().validate(payload.toString(), InputFormat.JSON)).as(type.wireName()).isEmpty();
            assertThat(MediaPublicLifecycleEvent.fromPayload(JSON.convertValue(payload,
                    new tools.jackson.core.type.TypeReference<Map<String, Object>>() { })).eventType()).isEqualTo(type);
        }
    }

    @Test
    void unknownFieldsFutureVersionsAndFinalityClaimsAreRefusedBySchemaAndParserAlike() throws Exception {
        JsonNode golden = JSON.readTree(resource("/contracts/media-public-lifecycle-event-v1.golden.json"));
        for (var mutation : java.util.List.<java.util.function.Consumer<ObjectNode>>of(
                node -> node.put("extra", "field"),
                node -> node.put("schemaVersion", "2.0.0"),
                node -> node.put("appendFinality", "FINAL"),
                node -> node.put("tenantRef", "tenant-raw"),
                node -> node.put("aggregateVersion", 0),
                node -> node.remove("correlationRef"))) {
            ObjectNode mutated = (ObjectNode) golden.deepCopy();
            mutation.accept(mutated);
            assertThat(schema().validate(mutated.toString(), InputFormat.JSON)).as(mutated.toString()).isNotEmpty();
            Map<String, Object> asMap = new LinkedHashMap<>(JSON.convertValue(mutated,
                    new tools.jackson.core.type.TypeReference<Map<String, Object>>() { }));
            assertThatThrownBy(() -> MediaPublicLifecycleEvent.fromPayload(asMap))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }
}
