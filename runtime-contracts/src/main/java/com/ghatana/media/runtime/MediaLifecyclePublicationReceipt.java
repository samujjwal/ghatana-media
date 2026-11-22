package com.ghatana.media.runtime;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Exact durable append identity returned by the configured Event Plane stream. */
public record MediaLifecyclePublicationReceipt(
        String eventId,
        String storedEventId,
        String streamId,
        String offset) {
    public MediaLifecyclePublicationReceipt {
        eventId = required(eventId, "eventId");
        storedEventId = required(storedEventId, "storedEventId");
        UUID.fromString(storedEventId);
        streamId = required(streamId, "streamId");
        offset = required(offset, "offset");
        if (!offset.chars().allMatch(value -> value >= '0' && value <= '9')) {
            throw new IllegalArgumentException("offset must be a nonnegative decimal position");
        }
    }

    public static String stableStoredEventId(String callerEventId) {
        try {
            return UUID.fromString(callerEventId).toString();
        } catch (IllegalArgumentException notUuid) {
            return UUID.nameUUIDFromBytes(callerEventId.getBytes(StandardCharsets.UTF_8)).toString();
        }
    }

    private static String required(String value, String field) {
        if (value == null || value.isBlank() || value.length() > 255) {
            throw new IllegalArgumentException(field + " must be bounded and nonblank");
        }
        return value;
    }
}
