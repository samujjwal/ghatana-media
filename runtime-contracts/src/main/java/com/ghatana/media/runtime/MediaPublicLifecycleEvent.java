package com.ghatana.media.runtime;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Versioned content-free public projection. Every append is a nonfinal notification; terminal
 * job events still require a separate authorized readback before a consumer may claim finality.
 */
public record MediaPublicLifecycleEvent(
        String schemaVersion,
        String eventRef,
        MediaLifecycleEventType eventType,
        String tenantRef,
        String principalRef,
        String correlationRef,
        String causationRef,
        String aggregateType,
        String aggregateRef,
        long aggregateVersion,
        String classification,
        Instant occurredAt,
        AppendFinality appendFinality,
        boolean terminalReadbackRequired) {
    public static final String SCHEMA_VERSION = "1.0.0";
    private static final Set<String> FIELDS = Set.of("schemaVersion", "eventRef", "eventType", "tenantRef",
            "principalRef", "correlationRef", "causationRef", "aggregateType", "aggregateRef",
            "aggregateVersion", "classification", "occurredAt", "appendFinality", "terminalReadbackRequired");
    private static final java.util.regex.Pattern REDACTED_ID =
            java.util.regex.Pattern.compile("^r1_[0-9a-f]{64}$");

    public enum AppendFinality { NON_FINAL_APPEND }

    public MediaPublicLifecycleEvent {
        if (!SCHEMA_VERSION.equals(schemaVersion)) throw new IllegalArgumentException("unsupported lifecycle schema version");
        eventRef = redacted(eventRef, "eventRef");
        eventType = Objects.requireNonNull(eventType, "eventType");
        tenantRef = redacted(tenantRef, "tenantRef");
        principalRef = redacted(principalRef, "principalRef");
        correlationRef = redacted(correlationRef, "correlationRef");
        causationRef = causationRef == null || causationRef.isBlank() ? "" : redacted(causationRef, "causationRef");
        aggregateType = required(aggregateType, "aggregateType");
        aggregateRef = redacted(aggregateRef, "aggregateRef");
        if (aggregateVersion < 1) throw new IllegalArgumentException("aggregateVersion must be positive");
        classification = required(classification, "classification");
        occurredAt = Objects.requireNonNull(occurredAt, "occurredAt");
        appendFinality = Objects.requireNonNull(appendFinality, "appendFinality");
        if (appendFinality != AppendFinality.NON_FINAL_APPEND) throw new IllegalArgumentException("event append cannot establish finality");
        if (terminalReadbackRequired != eventType.terminalReadbackRequired()) {
            throw new IllegalArgumentException("terminal readback requirement does not match the event type");
        }
    }

    public static MediaPublicLifecycleEvent fromInternal(
            MediaLifecycleEvent event, MediaLifecycleIdentifierRedactor redactor) {
        Objects.requireNonNull(event, "event");
        Objects.requireNonNull(redactor, "redactor");
        MediaLifecycleEventType type = MediaLifecycleEventType.fromWireName(event.eventType());
        return new MediaPublicLifecycleEvent(SCHEMA_VERSION,
                redacted(redactor, "event", event.eventId()), type,
                redacted(redactor, "tenant", event.tenantId()),
                redacted(redactor, "principal", event.principalId()),
                redacted(redactor, "correlation", event.correlationId()),
                event.causationId().isBlank() ? "" : redacted(redactor, "causation", event.causationId()),
                event.aggregateType(), redacted(redactor, "aggregate", event.aggregateId()),
                event.aggregateVersion(), event.classification(), event.occurredAt(),
                AppendFinality.NON_FINAL_APPEND, type.terminalReadbackRequired());
    }

    /** JSON-compatible immutable ABI projection for EventEnvelope payloads. */
    public Map<String, Object> toPayload() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("schemaVersion", schemaVersion);
        payload.put("eventRef", eventRef);
        payload.put("eventType", eventType.wireName());
        payload.put("tenantRef", tenantRef);
        payload.put("principalRef", principalRef);
        payload.put("correlationRef", correlationRef);
        payload.put("causationRef", causationRef);
        payload.put("aggregateType", aggregateType);
        payload.put("aggregateRef", aggregateRef);
        payload.put("aggregateVersion", aggregateVersion);
        payload.put("classification", classification);
        payload.put("occurredAt", occurredAt.toString());
        payload.put("appendFinality", appendFinality.name());
        payload.put("terminalReadbackRequired", terminalReadbackRequired);
        return Map.copyOf(payload);
    }

    /** Strict parser used at the broker boundary; unknown or incorrectly typed fields are rejected. */
    public static MediaPublicLifecycleEvent fromPayload(Object input) {
        if (!(input instanceof Map<?, ?> map) || !map.keySet().equals(FIELDS)) {
            throw new IllegalArgumentException("Lifecycle payload fields do not match public v1 ABI");
        }
        try {
            Object version = map.get("aggregateVersion");
            if (!(version instanceof Integer || version instanceof Long)) {
                throw new IllegalArgumentException("aggregateVersion must be an integer");
            }
            Object terminal = map.get("terminalReadbackRequired");
            if (!(terminal instanceof Boolean)) throw new IllegalArgumentException("terminalReadbackRequired must be boolean");
            return new MediaPublicLifecycleEvent(
                    string(map, "schemaVersion"), string(map, "eventRef"),
                    MediaLifecycleEventType.fromWireName(string(map, "eventType")),
                    string(map, "tenantRef"), string(map, "principalRef"),
                    string(map, "correlationRef"), string(map, "causationRef"),
                    string(map, "aggregateType"), string(map, "aggregateRef"),
                    ((Number) version).longValue(), string(map, "classification"),
                    Instant.parse(string(map, "occurredAt")),
                    AppendFinality.valueOf(string(map, "appendFinality")), (Boolean) terminal);
        } catch (RuntimeException failure) {
            if (failure instanceof IllegalArgumentException argument) throw argument;
            throw new IllegalArgumentException("Lifecycle payload does not match public v1 ABI", failure);
        }
    }

    private static String string(Map<?, ?> map, String field) {
        Object value = map.get(field);
        if (!(value instanceof String text)) throw new IllegalArgumentException(field + " must be a string");
        return text;
    }

    private static String redacted(MediaLifecycleIdentifierRedactor redactor, String kind, String raw) {
        String result = redacted(redactor.redact(kind, raw), kind + "Ref");
        if (result.equals(raw)) throw new IllegalArgumentException("redactor returned an unredacted identifier");
        return result;
    }

    private static String redacted(String value, String name) {
        String checked = required(value, name);
        if (!REDACTED_ID.matcher(checked).matches()) {
            throw new IllegalArgumentException(name + " must use the public r1 redacted-ID format");
        }
        return checked;
    }

    private static String required(String value, String name) {
        String checked = bounded(value, name);
        if (checked.isBlank()) throw new IllegalArgumentException(name + " is required");
        return checked;
    }

    private static String bounded(String value, String name) {
        if (value == null || value.length() > 512) throw new IllegalArgumentException(name + " is invalid");
        return value.trim();
    }
}
