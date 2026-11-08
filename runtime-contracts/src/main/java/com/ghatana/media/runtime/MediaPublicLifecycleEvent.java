package com.ghatana.media.runtime;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Locale;
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
    /** Stable identifier shared by the public JSON Schema and Event Plane envelope. */
    public static final String SCHEMA_URI = "urn:ghatana:media-public-lifecycle-event:v1";
    private static final Set<String> FIELDS = Set.of("schemaVersion", "eventRef", "eventType", "tenantRef",
            "principalRef", "correlationRef", "causationRef", "aggregateType", "aggregateRef",
            "aggregateVersion", "classification", "occurredAt", "appendFinality", "terminalReadbackRequired");
    private static final Set<String> AGGREGATE_TYPES = Set.of("upload", "artifact", "job", "stream");
    private static final Set<String> CLASSIFICATIONS = Set.of("PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED");
    private static final java.util.regex.Pattern REDACTED_ID =
            java.util.regex.Pattern.compile("^r1_[0-9a-f]{64}$");
    private static final double MAX_SAFE_JSON_DOUBLE_INTEGER = 9_007_199_254_740_991d;
    private static final float MAX_SAFE_JSON_FLOAT_INTEGER = 16_777_215f;

    public enum AppendFinality { NON_FINAL_APPEND }

    public MediaPublicLifecycleEvent {
        if (!SCHEMA_VERSION.equals(schemaVersion)) throw new IllegalArgumentException("unsupported lifecycle schema version");
        eventRef = redacted(eventRef, "eventRef");
        eventType = Objects.requireNonNull(eventType, "eventType");
        tenantRef = redacted(tenantRef, "tenantRef");
        principalRef = redacted(principalRef, "principalRef");
        correlationRef = redacted(correlationRef, "correlationRef");
        causationRef = causationRef == null || causationRef.isBlank() ? "" : redacted(causationRef, "causationRef");
        aggregateType = required(aggregateType, "aggregateType").toLowerCase(Locale.ROOT);
        if (!AGGREGATE_TYPES.contains(aggregateType)) {
            throw new IllegalArgumentException("aggregateType is not part of the public lifecycle ABI");
        }
        aggregateRef = redacted(aggregateRef, "aggregateRef");
        if (aggregateVersion < 1) throw new IllegalArgumentException("aggregateVersion must be positive");
        classification = required(classification, "classification").toUpperCase(Locale.ROOT);
        if (!CLASSIFICATIONS.contains(classification)) {
            throw new IllegalArgumentException("classification is not part of the public lifecycle ABI");
        }
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
            long aggregateVersion = parseAggregateVersion(version);
            if (aggregateVersion < 1) throw new IllegalArgumentException("aggregateVersion must be positive");
            Object terminal = map.get("terminalReadbackRequired");
            if (!(terminal instanceof Boolean)) throw new IllegalArgumentException("terminalReadbackRequired must be boolean");
            String eventRef = wireRedactedId(map, "eventRef");
            String tenantRef = wireRedactedId(map, "tenantRef");
            String principalRef = wireRedactedId(map, "principalRef");
            String correlationRef = wireRedactedId(map, "correlationRef");
            String causationRef = string(map, "causationRef");
            if (!causationRef.isEmpty() && !REDACTED_ID.matcher(causationRef).matches()) {
                throw new IllegalArgumentException("causationRef must be empty or use the public r1 redacted-ID format");
            }
            String aggregateType = string(map, "aggregateType");
            if (!AGGREGATE_TYPES.contains(aggregateType)) {
                throw new IllegalArgumentException("aggregateType is not part of the public lifecycle ABI");
            }
            String aggregateRef = wireRedactedId(map, "aggregateRef");
            String classification = string(map, "classification");
            if (!CLASSIFICATIONS.contains(classification)) {
                throw new IllegalArgumentException("classification is not part of the public lifecycle ABI");
            }
            return new MediaPublicLifecycleEvent(
                    string(map, "schemaVersion"), eventRef,
                    MediaLifecycleEventType.fromWireName(string(map, "eventType")),
                    tenantRef, principalRef, correlationRef, causationRef,
                    aggregateType, aggregateRef,
                    aggregateVersion, classification,
                    Instant.parse(string(map, "occurredAt")),
                    AppendFinality.valueOf(string(map, "appendFinality")), (Boolean) terminal);
        } catch (RuntimeException failure) {
            if (failure instanceof IllegalArgumentException argument) throw argument;
            throw new IllegalArgumentException("Lifecycle payload does not match public v1 ABI", failure);
        }
    }

    private static long parseAggregateVersion(Object version) {
        if (version instanceof Integer || version instanceof Long) return ((Number) version).longValue();
        if (version instanceof BigInteger integer) {
            try {
                return integer.longValueExact();
            } catch (ArithmeticException overflow) {
                throw new IllegalArgumentException("aggregateVersion exceeds the supported integer range", overflow);
            }
        }
        if (version instanceof BigDecimal decimal) {
            if (decimal.stripTrailingZeros().scale() > 0) {
                throw new IllegalArgumentException("aggregateVersion must be an integer");
            }
            try {
                return decimal.longValueExact();
            } catch (ArithmeticException overflow) {
                throw new IllegalArgumentException("aggregateVersion exceeds the supported integer range", overflow);
            }
        }
        if (version instanceof Double floating) {
            if (!Double.isFinite(floating) || floating != Math.rint(floating)) {
                throw new IllegalArgumentException("aggregateVersion must be an integer");
            }
            if (Math.abs(floating) > MAX_SAFE_JSON_DOUBLE_INTEGER) {
                throw new IllegalArgumentException("aggregateVersion cannot be decoded exactly");
            }
            return floating.longValue();
        }
        if (version instanceof Float floating) {
            if (!Float.isFinite(floating) || floating != Math.rint(floating)) {
                throw new IllegalArgumentException("aggregateVersion must be an integer");
            }
            if (Math.abs(floating) > MAX_SAFE_JSON_FLOAT_INTEGER) {
                throw new IllegalArgumentException("aggregateVersion cannot be decoded exactly");
            }
            return floating.longValue();
        }
        throw new IllegalArgumentException("aggregateVersion must be an integer");
    }

    private static String string(Map<?, ?> map, String field) {
        Object value = map.get(field);
        if (!(value instanceof String text)) throw new IllegalArgumentException(field + " must be a string");
        return text;
    }

    private static String wireRedactedId(Map<?, ?> map, String field) {
        String value = string(map, field);
        if (!REDACTED_ID.matcher(value).matches()) {
            throw new IllegalArgumentException(field + " must use the public r1 redacted-ID format");
        }
        return value;
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
