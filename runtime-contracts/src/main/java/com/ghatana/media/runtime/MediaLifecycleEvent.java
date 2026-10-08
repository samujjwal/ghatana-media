package com.ghatana.media.runtime;

import java.time.Instant;
import java.util.Map;

/**
 * Neutral, content-free Media lifecycle event published through Event Plane.
 *
 * @doc.type record
 * @doc.purpose Represent Media Lifecycle Event values
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public record MediaLifecycleEvent(
        String eventId,
        String eventType,
        String tenantId,
        String principalId,
        String correlationId,
        String causationId,
        String aggregateType,
        String aggregateId,
        long aggregateVersion,
        String classification,
        Instant occurredAt,
        Map<String, Object> attributes) {
    private static final int EVENT_PLANE_MAX_TEXT_LENGTH = 255;

    public MediaLifecycleEvent {
        eventId = required(eventId, "eventId", EVENT_PLANE_MAX_TEXT_LENGTH);
        eventType = required(eventType, "eventType", EVENT_PLANE_MAX_TEXT_LENGTH);
        tenantId = required(tenantId, "tenantId", EVENT_PLANE_MAX_TEXT_LENGTH);
        principalId = required(principalId, "principalId", EVENT_PLANE_MAX_TEXT_LENGTH);
        correlationId = required(correlationId, "correlationId", EVENT_PLANE_MAX_TEXT_LENGTH);
        causationId = optional(causationId, "causationId", EVENT_PLANE_MAX_TEXT_LENGTH);
        aggregateType = required(aggregateType, "aggregateType", 512);
        aggregateId = required(aggregateId, "aggregateId", 512);
        if (aggregateVersion < 1L) throw new IllegalArgumentException("aggregateVersion must be positive");
        classification = required(classification, "classification", 512);
        occurredAt = occurredAt == null ? Instant.now() : occurredAt;
        attributes = MediaMetadataSanitizer.sanitize(attributes == null ? Map.of() : attributes);
    }

    private static String required(String value, String field, int maximumLength) {
        if (value == null || value.isBlank() || value.length() > maximumLength) {
            throw new IllegalArgumentException(field + " must be bounded and non-blank");
        }
        return value.trim();
    }

    private static String optional(String value, String field, int maximumLength) {
        if (value == null) return "";
        String normalized = value.trim();
        if (normalized.length() > maximumLength) {
            throw new IllegalArgumentException(field + " must be bounded");
        }
        return normalized;
    }
}
