package com.ghatana.media.runtime;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Deterministic metadata minimizer for Media ingestion and streaming boundaries.
 *
 * <p>Location/device/container metadata and credential-like fields are removed before durable
 * storage or external provider dispatch. The sanitizer is deliberately structural and does not
 * pretend to perform semantic transcript/face/voice PII redaction.
 *
 * @doc.type class
 * @doc.purpose Strip privacy-sensitive and credential metadata at Media request boundaries
 * @doc.layer product
 * @doc.pattern Sanitizer, Policy
 */
public final class MediaMetadataSanitizer {
    private static final int MAX_DEPTH = 8;
    private static final int MAX_ENTRIES = 512;
    private static final Set<String> EXACT_BLOCKED = Set.of(
            "authorization", "cookie", "set-cookie", "password", "secret", "token", "apikey",
            "api-key", "api_key", "accesskey", "access-key", "access_key", "refresh_token",
            "gps", "latitude", "longitude", "geolocation", "location", "deviceid", "device-id",
            "device_id", "imei", "id3", "exif");

    private MediaMetadataSanitizer() { }

    public static Map<String, Object> sanitize(Map<String, Object> source) {
        if (source == null || source.isEmpty()) return Map.of();
        Counter counter = new Counter();
        return sanitizeMap(source, 0, counter);
    }

    private static Map<String, Object> sanitizeMap(
            Map<?, ?> source,
            int depth,
            Counter counter) {
        requireDepth(depth);
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : source.entrySet()) {
            if (++counter.entries > MAX_ENTRIES) {
                throw new IllegalArgumentException("Media metadata exceeds " + MAX_ENTRIES + " entries");
            }
            String key = entry.getKey() == null ? "" : String.valueOf(entry.getKey()).trim();
            if (key.isBlank() || key.length() > 128) {
                throw new IllegalArgumentException("Media metadata keys must contain 1-128 characters");
            }
            if (blocked(key)) continue;
            Object sanitized = sanitizeValue(entry.getValue(), depth + 1, counter);
            if (sanitized != null) result.put(key, sanitized);
        }
        return Map.copyOf(result);
    }

    private static Object sanitizeValue(Object value, int depth, Counter counter) {
        if (value == null) return null;
        requireDepth(depth);
        if (value instanceof Map<?, ?> map) return sanitizeMap(map, depth, counter);
        if (value instanceof Iterable<?> iterable) {
            List<Object> result = new ArrayList<>();
            for (Object item : iterable) {
                Object sanitized = sanitizeValue(item, depth + 1, counter);
                if (sanitized != null) result.add(sanitized);
            }
            return List.copyOf(result);
        }
        if (value instanceof String || value instanceof Number || value instanceof Boolean) return value;
        return String.valueOf(value);
    }

    private static boolean blocked(String key) {
        String normalized = key.toLowerCase(Locale.ROOT).replace(" ", "");
        if (EXACT_BLOCKED.contains(normalized)) return true;
        return normalized.contains("authorization")
                || normalized.contains("password")
                || normalized.contains("secret")
                || normalized.endsWith("token")
                || normalized.contains("gps")
                || normalized.contains("geolocation")
                || normalized.contains("deviceidentifier")
                || normalized.contains("device_id")
                || normalized.contains("exif")
                || normalized.contains("id3");
    }

    private static void requireDepth(int depth) {
        if (depth > MAX_DEPTH) {
            throw new IllegalArgumentException("Media metadata nesting exceeds " + MAX_DEPTH);
        }
    }

    private static final class Counter { int entries; }
}
