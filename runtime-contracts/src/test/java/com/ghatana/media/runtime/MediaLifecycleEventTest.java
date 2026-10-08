package com.ghatana.media.runtime;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaLifecycleEventTest {

    @Test
    void eventIdMatchesEventPlaneRequestAndIdempotencyKeyLimit() {
        String maximumLengthEventId = "e".repeat(255);

        assertThat(event(maximumLengthEventId).eventId()).hasSize(255);
        assertThatThrownBy(() -> event("e".repeat(256)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("eventId must be bounded and non-blank");
    }

    @Test
    void eventPlaneWireTextFieldsAccept255Characters() {
        String maximumLength = "x".repeat(255);

        MediaLifecycleEvent event = event(
                "event-1", maximumLength, maximumLength, maximumLength,
                maximumLength, maximumLength);

        assertThat(event.eventType()).hasSize(255);
        assertThat(event.tenantId()).hasSize(255);
        assertThat(event.principalId()).hasSize(255);
        assertThat(event.correlationId()).hasSize(255);
        assertThat(event.causationId()).hasSize(255);
    }

    @Test
    void eventPlaneWireTextFieldsReject256Characters() {
        String tooLong = "x".repeat(256);

        assertTooLong(tooLong, "eventType");
        assertTooLong("media.event", tooLong, "principal-a", "correlation-a", "", "tenantId");
        assertTooLong("media.event", "tenant-a", tooLong, "correlation-a", "", "principalId");
        assertTooLong("media.event", "tenant-a", "principal-a", tooLong, "", "correlationId");
        assertTooLong("media.event", "tenant-a", "principal-a", "correlation-a", tooLong, "causationId");
    }

    private static void assertTooLong(String eventType, String field) {
        assertThatThrownBy(() -> event("event-1", eventType, "tenant-a", "principal-a", "correlation-a", ""))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining(field + " must be bounded");
    }

    private static void assertTooLong(
            String eventType,
            String tenantId,
            String principalId,
            String correlationId,
            String causationId,
            String field) {
        assertThatThrownBy(() -> event("event-1", eventType, tenantId, principalId, correlationId, causationId))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining(field + " must be bounded");
    }

    private static MediaLifecycleEvent event(String eventId) {
        return event(eventId, "media.job.completed", "tenant-a", "principal-a", "correlation-a", "");
    }

    private static MediaLifecycleEvent event(
            String eventId,
            String eventType,
            String tenantId,
            String principalId,
            String correlationId,
            String causationId) {
        return new MediaLifecycleEvent(
                eventId, eventType, tenantId, principalId, correlationId, causationId,
                "job", "job-a", 1, "CONFIDENTIAL", Instant.EPOCH, Map.of());
    }
}
