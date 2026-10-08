package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;

import java.lang.reflect.Array;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Stable semantic digest used to bind a tenant request id to its complete immutable submission. */
public final class MediaJobRequestFingerprint {
    private MediaJobRequestFingerprint() { }

    public record ProviderDescriptor(String providerId, String providerVersion, String modelVersion) {
        public ProviderDescriptor {
            providerId = java.util.Objects.requireNonNull(providerId, "providerId");
            providerVersion = java.util.Objects.requireNonNull(providerVersion, "providerVersion");
            modelVersion = java.util.Objects.requireNonNull(modelVersion, "modelVersion");
        }
    }

    /** Provider descriptors must be in dispatch order and include the selected provider versions. */
    public static String compute(ProcessingJobRequest request, List<ProviderDescriptor> providerDescriptors) {
        java.util.Objects.requireNonNull(request, "request");
        Map<String, Object> governance = governance(request.governanceContext());
        Map<String, Object> envelope = new TreeMap<>();
        envelope.put("digestVersion", 1);
        envelope.put("schema", "media.job-request-fingerprint.v1");
        envelope.put("requestId", request.requestId());
        envelope.put("tenantId", request.tenantId());
        envelope.put("principalId", request.principalId());
        envelope.put("correlationId", request.correlationId());
        envelope.put("artifactId", request.artifactId());
        envelope.put("jobType", request.jobType().name());
        envelope.put("providerHint", request.providerHint());
        envelope.put("parameters", request.parameters());
        envelope.put("governance", governance);
        envelope.put("providers", (providerDescriptors == null ? List.<ProviderDescriptor>of() : providerDescriptors)
                .stream().map(provider -> Map.of(
                        "providerId", provider.providerId(),
                        "providerVersion", provider.providerVersion(),
                        "modelVersion", provider.modelVersion()))
                .toList());
        byte[] bytes = canonical(envelope).getBytes(StandardCharsets.UTF_8);
        try {
            return "sha256:" + java.util.HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private static Map<String, Object> governance(MediaGovernanceContext value) {
        Map<String, Object> map = new TreeMap<>();
        map.put("consentId", value.consentId());
        map.put("purpose", value.purpose());
        map.put("classification", value.classification().name());
        map.put("residency", value.residency());
        map.put("allowedRegions", value.allowedRegions().stream().sorted().toList());
        map.put("externalProcessingAllowed", value.externalProcessingAllowed());
        map.put("retentionPolicy", value.retentionPolicy());
        map.put("providerRetentionAllowed", value.providerRetentionAllowed());
        map.put("biometricProcessingAllowed", value.biometricProcessingAllowed());
        map.put("biometricProcessingBasis", value.biometricProcessingBasis());
        map.put("biometricSensitivity", value.biometricSensitivity().name());
        map.put("automationRisk", value.automationRisk().name());
        return map;
    }

    private static String canonical(Object value) {
        if (value == null) return "null";
        if (value instanceof String string) return quote(string);
        if (value instanceof Boolean bool) return bool.toString();
        if (value instanceof MediaModalityContracts.ContextReference reference) {
            return canonical(Map.of(
                    "type", "media.ContextReference",
                    "reference", reference.reference(),
                    "purpose", reference.purpose(),
                    "classification", reference.classification().name(),
                    "expiresAt", reference.expiresAt().toString()));
        }
        if (value instanceof Number number) {
            if (!(number instanceof Byte || number instanceof Short || number instanceof Integer
                    || number instanceof Long || number instanceof java.math.BigInteger
                    || number instanceof java.math.BigDecimal || number instanceof Double || number instanceof Float)) {
                throw new IllegalArgumentException("Media request number type is not a supported JSON number");
            }
            if (number instanceof Double d && !Double.isFinite(d)
                    || number instanceof Float f && !Float.isFinite(f)) {
                throw new IllegalArgumentException("Media request parameters cannot contain non-finite numbers");
            }
            return number.toString();
        }
        if (value instanceof Map<?, ?> map) {
            TreeMap<String, Object> sorted = new TreeMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String key)) {
                    throw new IllegalArgumentException("Media request parameter object keys must be strings");
                }
                sorted.put(key, entry.getValue());
            }
            List<String> entries = new ArrayList<>(sorted.size());
            sorted.forEach((key, item) -> entries.add(quote(key) + ":" + canonical(item)));
            return "{" + String.join(",", entries) + "}";
        }
        if (value instanceof List<?> list) {
            List<String> items = new ArrayList<>(list.size());
            list.forEach(item -> items.add(canonical(item)));
            return "[" + String.join(",", items) + "]";
        }
        if (value.getClass().isArray()) {
            List<String> items = new ArrayList<>();
            for (int i = 0; i < Array.getLength(value); i++) items.add(canonical(Array.get(value, i)));
            return "[" + String.join(",", items) + "]";
        }
        throw new IllegalArgumentException(
                "Unsupported Media request parameter value type: " + value.getClass().getName());
    }

    private static String quote(String value) {
        StringBuilder encoded = new StringBuilder(value.length() + 2).append('"');
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            switch (ch) {
                case '"' -> encoded.append("\\\"");
                case '\\' -> encoded.append("\\\\");
                case '\b' -> encoded.append("\\b");
                case '\f' -> encoded.append("\\f");
                case '\n' -> encoded.append("\\n");
                case '\r' -> encoded.append("\\r");
                case '\t' -> encoded.append("\\t");
                default -> {
                    if (ch < 0x20 || Character.isLowSurrogate(ch)
                            || Character.isHighSurrogate(ch)
                            && (i + 1 == value.length() || !Character.isLowSurrogate(value.charAt(i + 1)))) {
                        appendUnicodeEscape(encoded, ch);
                    } else {
                        encoded.append(ch);
                        if (Character.isHighSurrogate(ch)) encoded.append(value.charAt(++i));
                    }
                }
            }
        }
        return encoded.append('"').toString();
    }

    private static void appendUnicodeEscape(StringBuilder encoded, char value) {
        final char[] hex = "0123456789abcdef".toCharArray();
        encoded.append("\\u")
                .append(hex[(value >>> 12) & 0xf])
                .append(hex[(value >>> 8) & 0xf])
                .append(hex[(value >>> 4) & 0xf])
                .append(hex[value & 0xf]);
    }
}
