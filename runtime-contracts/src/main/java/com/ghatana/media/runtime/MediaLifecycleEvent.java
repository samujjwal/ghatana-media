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
    public MediaLifecycleEvent {
        eventId = required(eventId, "eventId");
        eventType = required(eventType, "eventType");
        tenantId = required(tenantId, "tenantId");
        principalId = required(principalId, "principalId");
        correlationId = required(correlationId, "correlationId");
        causationId = optional(causationId);
        aggregateType = required(aggregateType, "aggregateType");
        aggregateId = required(aggregateId, "aggregateId");
        if (aggregateVersion < 1L) throw new IllegalArgumentException("aggregateVersion must be positive");
        classification = required(classification, "classification");
        occurredAt = occurredAt == null ? Instant.now() : occurredAt;
        attributes = MediaMetadataSanitizer.sanitize(attributes == null ? Map.of() : attributes);
    }

    private static String required(String value, String field) {
        if (value == null || value.isBlank() || value.length() > 512) {
            throw new IllegalArgumentException(field + " must be bounded and non-blank");
        }
        return value.trim();
    }

    private static String optional(String value) {
        return value == null ? "" : value.trim();
    }
}
