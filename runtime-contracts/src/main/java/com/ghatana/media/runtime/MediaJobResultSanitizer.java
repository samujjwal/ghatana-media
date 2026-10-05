package com.ghatana.media.runtime;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Structural privacy sanitizer for durable Media processing-job results.
 *
 * <p>This boundary prevents raw media, biometric vectors/voiceprints, and credential-like material
 * from entering the durable job ledger. It intentionally does not claim semantic transcript PII
 * redaction; transcript/NER redaction remains a separate provider capability and policy concern.
 *
 * @doc.type class
 * @doc.purpose Remove non-persistable sensitive fields from Media job results
 * @doc.layer product
 * @doc.pattern Sanitizer, DataMinimization
 */
public final class MediaJobResultSanitizer {
    private static final int MAX_DEPTH = 10;
    private static final int MAX_ENTRIES = 2_048;

    private MediaJobResultSanitizer() { }

    public static Map<String, Object> sanitize(Map<String, Object> source) {
        if (source == null || source.isEmpty()) return Map.of();
        LinkedHashSet<String> redacted = new LinkedHashSet<>();
        Counter counter = new Counter();
        Map<String, Object> cleaned = sanitizeMap(source, "", 0, counter, redacted);
        if (redacted.isEmpty()) return cleaned;
        Map<String, Object> result = new LinkedHashMap<>(cleaned);
        result.put("privacyRedacted", true);
        result.put("privacyRedactedFields", List.copyOf(redacted));
        return Map.copyOf(result);
    }

    private static Map<String, Object> sanitizeMap(
            Map<?, ?> source,
            String path,
            int depth,
            Counter counter,
            Set<String> redacted) {
        requireDepth(depth);
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : source.entrySet()) {
            if (++counter.entries > MAX_ENTRIES) {
                throw new IllegalArgumentException("Media result exceeds " + MAX_ENTRIES + " fields");
            }
            String key = entry.getKey() == null ? "" : String.valueOf(entry.getKey()).trim();
            if (key.isBlank() || key.length() > 256) {
                throw new IllegalArgumentException("Media result keys must contain 1-256 characters");
            }
            String childPath = path.isBlank() ? key : path + "." + key;
            if (blocked(key)) {
                redacted.add(childPath);
                continue;
            }
            Object value = sanitizeValue(entry.getValue(), childPath, depth + 1, counter, redacted);
            if (value != null) result.put(key, value);
        }
        return Map.copyOf(result);
    }

    private static Object sanitizeValue(
            Object value,
            String path,
            int depth,
            Counter counter,
            Set<String> redacted) {
        if (value == null) return null;
        requireDepth(depth);
        if (value instanceof Map<?, ?> map) return sanitizeMap(map, path, depth, counter, redacted);
        if (value instanceof Iterable<?> iterable) {
            List<Object> result = new ArrayList<>();
            int index = 0;
            for (Object item : iterable) {
                Object cleaned = sanitizeValue(item, path + "[" + index++ + "]", depth + 1, counter, redacted);
                if (cleaned != null) result.add(cleaned);
            }
            return List.copyOf(result);
        }
        if (value instanceof byte[] || value instanceof java.nio.ByteBuffer) {
            redacted.add(path);
            return null;
        }
        if (value instanceof String || value instanceof Number || value instanceof Boolean) return value;
        return String.valueOf(value);
    }

    private static boolean blocked(String key) {
        String normalized = key.toLowerCase(Locale.ROOT)
                .replace("_", "")
                .replace("-", "")
                .replace(" ", "");
        return normalized.contains("authorization")
                || normalized.contains("password")
                || normalized.contains("secret")
                || normalized.equals("token")
                || normalized.contains("bearertoken")
                || normalized.contains("accesstoken")
                || normalized.contains("refreshtoken")
                || normalized.contains("apikey")
                || normalized.equals("cookie")
                || normalized.equals("setcookie")
                || normalized.contains("speakerembedding")
                || normalized.contains("faceembedding")
                || normalized.contains("voiceembedding")
                || normalized.contains("voiceprint")
                || normalized.contains("biometrictemplate")
                || normalized.contains("biometricvector")
                || normalized.contains("facialdescriptor")
                || normalized.equals("audio")
                || normalized.equals("video")
                || normalized.equals("frame")
                || normalized.equals("rawmedia")
                || normalized.equals("rawbytes")
                || normalized.equals("payloadbase64");
    }

    private static void requireDepth(int depth) {
        if (depth > MAX_DEPTH) {
            throw new IllegalArgumentException("Media result nesting exceeds " + MAX_DEPTH);
        }
    }

    private static final class Counter { int entries; }
}
