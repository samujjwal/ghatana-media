package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;

import java.lang.reflect.Array;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Map;
import java.util.TreeMap;

/** Canonical immutable payload binding for tenant/principal scoped upload creation replay. */
public final class MediaUploadRequestFingerprint {
    private MediaUploadRequestFingerprint() { }

    public static String compute(UploadRequest request) {
        java.util.Objects.requireNonNull(request, "request");
        Map<String, Object> envelope = new TreeMap<>();
        envelope.put("schema", "media.upload-request-fingerprint.v1");
        envelope.put("digestVersion", 1);
        envelope.put("tenantId", request.tenantId());
        envelope.put("principalId", request.principalId());
        envelope.put("fileName", request.fileName());
        envelope.put("contentType", request.contentType());
        envelope.put("expectedSizeBytes", request.expectedSizeBytes());
        envelope.put("expectedSha256", request.expectedSha256());
        envelope.put("classification", request.classification());
        envelope.put("retention", Map.of(
                "seconds", request.retention().getSeconds(),
                "nanos", request.retention().getNano()));
        envelope.put("metadata", request.metadata());
        try {
            byte[] bytes = canonical(envelope).getBytes(StandardCharsets.UTF_8);
            return "sha256:" + java.util.HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private static String canonical(Object value) {
        if (value == null) return "null";
        if (value instanceof String string) return quote(string);
        if (value instanceof Boolean bool) return bool.toString();
        if (value instanceof Number number) {
            if (!(number instanceof Byte || number instanceof Short || number instanceof Integer
                    || number instanceof Long || number instanceof java.math.BigInteger
                    || number instanceof BigDecimal || number instanceof Double || number instanceof Float)) {
                throw new IllegalArgumentException("Upload metadata contains an unsupported JSON number");
            }
            if (number instanceof Double d && !Double.isFinite(d)
                    || number instanceof Float f && !Float.isFinite(f)) {
                throw new IllegalArgumentException("Upload metadata cannot contain non-finite numbers");
            }
            return new BigDecimal(number.toString()).stripTrailingZeros().toPlainString();
        }
        if (value instanceof Map<?, ?> map) {
            TreeMap<String, Object> sorted = new TreeMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String key)) {
                    throw new IllegalArgumentException("Upload metadata object keys must be strings");
                }
                sorted.put(key, entry.getValue());
            }
            ArrayList<String> items = new ArrayList<>(sorted.size());
            sorted.forEach((key, item) -> items.add(quote(key) + ":" + canonical(item)));
            return "{" + String.join(",", items) + "}";
        }
        if (value instanceof java.util.List<?> list) {
            return "[" + String.join(",", list.stream().map(MediaUploadRequestFingerprint::canonical).toList()) + "]";
        }
        if (value.getClass().isArray()) {
            ArrayList<String> items = new ArrayList<>();
            for (int i = 0; i < Array.getLength(value); i++) items.add(canonical(Array.get(value, i)));
            return "[" + String.join(",", items) + "]";
        }
        throw new IllegalArgumentException("Upload metadata contains unsupported type " + value.getClass().getName());
    }

    private static String quote(String value) {
        StringBuilder out = new StringBuilder(value.length() + 2).append('"');
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            switch (ch) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (ch < 0x20 || Character.isSurrogate(ch)) {
                        out.append(String.format("\\u%04x", (int) ch));
                    } else out.append(ch);
                }
            }
        }
        return out.append('"').toString();
    }
}
