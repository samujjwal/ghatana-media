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

    /** Canonical JSON form used by durable Media operation specs for exact digest comparison. */
    public static String canonicalJson(Object value) {
        return canonical(value);
    }

    /**
     * Returns the canonical JSON character count without materializing the JSON string.
     * The traversal limits match the bounded media-result shape used by modality jobs.
     */
    static int boundedCanonicalJsonLength(Object value, int maximumCharacters) {
        if (maximumCharacters < 1) {
            throw new IllegalArgumentException("maximum canonical JSON characters must be positive");
        }
        BoundedJsonOutput output = BoundedJsonOutput.countingCharacters(maximumCharacters);
        appendBoundedCanonical(value, output, new BoundedTraversal(), 0);
        return output.count();
    }

    static boolean fitsBoundedCanonicalJson(Object value, int maximumCharacters) {
        try {
            boundedCanonicalJsonLength(value, maximumCharacters);
            return true;
        } catch (CanonicalJsonLimitExceededException exceeded) {
            return false;
        }
    }

    /**
     * Digests the complete canonical JSON value without retaining its serialized form.
     * This keeps durable result hashing bounded even when a malformed collection is large.
     */
    static String boundedCanonicalJsonDigest(Object value, int maximumBytes) {
        if (maximumBytes < 1) {
            throw new IllegalArgumentException("maximum canonical JSON bytes must be positive");
        }
        final MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
        BoundedJsonOutput output = BoundedJsonOutput.digest(digest, maximumBytes);
        appendBoundedCanonical(value, output, new BoundedTraversal(), 0);
        return java.util.HexFormat.of().formatHex(digest.digest());
    }

    private static final class BoundedTraversal {
        private static final int MAX_DEPTH = 8;
        private static final int MAX_OBJECT_ENTRIES = 256;
        private static final int MAX_COLLECTION_ITEMS = 256;
        private int objectEntries;
    }

    private static final class BoundedJsonOutput {
        private enum Mode { CHARACTERS, DIGEST }

        private final Mode mode;
        private final int maximum;
        private final MessageDigest digest;
        private int count;

        private BoundedJsonOutput(Mode mode, int maximum, MessageDigest digest) {
            this.mode = mode;
            this.maximum = maximum;
            this.digest = digest;
        }

        private static BoundedJsonOutput countingCharacters(int maximum) {
            return new BoundedJsonOutput(Mode.CHARACTERS, maximum, null);
        }

        private static BoundedJsonOutput digest(MessageDigest digest, int maximum) {
            return new BoundedJsonOutput(Mode.DIGEST, maximum, digest);
        }

        private int remaining() { return maximum - count; }
        private int count() { return count; }

        private void append(String value) {
            if (mode == Mode.CHARACTERS) {
                if (value.length() > remaining()) {
                    throw new CanonicalJsonLimitExceededException(
                            "canonical JSON exceeds " + maximum + " characters");
                }
                count += value.length();
                return;
            }
            // UTF-8 uses at least one byte per UTF-16 code unit. This early guard prevents
            // allocating a byte array for a string that cannot fit the remaining byte
            // budget. Escaped JSON strings contain only ASCII here.
            if (value.length() > remaining()) {
                throw new CanonicalJsonLimitExceededException(
                        "canonical JSON exceeds " + maximum + " bytes");
            }
            byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
            if (bytes.length > remaining()) {
                throw new CanonicalJsonLimitExceededException(
                        "canonical JSON exceeds " + maximum + " bytes");
            }
            digest.update(bytes);
            count += bytes.length;
        }
    }

    private static final class CanonicalJsonLimitExceededException extends IllegalArgumentException {
        private CanonicalJsonLimitExceededException(String message) {
            super(message);
        }
    }

    private static void appendBoundedCanonical(
            Object value, BoundedJsonOutput output, BoundedTraversal traversal, int depth) {
        if (depth > BoundedTraversal.MAX_DEPTH) {
            throw new IllegalArgumentException("canonical JSON nesting exceeds "
                    + BoundedTraversal.MAX_DEPTH + " levels");
        }
        if (value == null) {
            output.append("null");
        } else if (value instanceof String string) {
            appendBoundedQuoted(string, output);
        } else if (value instanceof Boolean bool) {
            output.append(bool.toString());
        } else if (value instanceof MediaModalityContracts.ContextReference reference) {
            appendBoundedCanonical(Map.of(
                    "type", "media.ContextReference",
                    "reference", reference.reference(),
                    "purpose", reference.purpose(),
                    "classification", reference.classification().name(),
                    "expiresAt", reference.expiresAt().toString()), output, traversal, depth);
        } else if (value instanceof Number number) {
            if (!(number instanceof Byte || number instanceof Short || number instanceof Integer
                    || number instanceof Long || number instanceof java.math.BigInteger
                    || number instanceof java.math.BigDecimal || number instanceof Double || number instanceof Float)) {
                throw new IllegalArgumentException("Media request number type is not a supported JSON number");
            }
            if (number instanceof Double d && !Double.isFinite(d)
                    || number instanceof Float f && !Float.isFinite(f)) {
                throw new IllegalArgumentException("Media request parameters cannot contain non-finite numbers");
            }
            output.append(number.toString());
        } else if (value instanceof Map<?, ?> map) {
            TreeMap<String, Object> sorted = new TreeMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String key)) {
                    throw new IllegalArgumentException("Media request parameter object keys must be strings");
                }
                if (++traversal.objectEntries > BoundedTraversal.MAX_OBJECT_ENTRIES) {
                    throw new IllegalArgumentException("canonical JSON object entries exceed "
                            + BoundedTraversal.MAX_OBJECT_ENTRIES);
                }
                sorted.put(key, entry.getValue());
            }
            output.append("{");
            boolean first = true;
            for (Map.Entry<String, Object> entry : sorted.entrySet()) {
                if (!first) output.append(",");
                first = false;
                appendBoundedQuoted(entry.getKey(), output);
                output.append(":");
                appendBoundedCanonical(entry.getValue(), output, traversal, depth + 1);
            }
            output.append("}");
        } else if (value instanceof List<?> list) {
            output.append("[");
            int count = 0;
            java.util.Iterator<?> iterator = list.iterator();
            while (iterator.hasNext()) {
                if (++count > BoundedTraversal.MAX_COLLECTION_ITEMS) {
                    throw new IllegalArgumentException("canonical JSON collection exceeds "
                            + BoundedTraversal.MAX_COLLECTION_ITEMS + " items");
                }
                if (count > 1) output.append(",");
                Object item = iterator.next();
                appendBoundedCanonical(item, output, traversal, depth + 1);
            }
            output.append("]");
        } else if (value.getClass().isArray()) {
            int length = Array.getLength(value);
            if (length > BoundedTraversal.MAX_COLLECTION_ITEMS) {
                throw new IllegalArgumentException("canonical JSON collection exceeds "
                        + BoundedTraversal.MAX_COLLECTION_ITEMS + " items");
            }
            output.append("[");
            for (int i = 0; i < length; i++) {
                if (i > 0) output.append(",");
                appendBoundedCanonical(Array.get(value, i), output, traversal, depth + 1);
            }
            output.append("]");
        } else {
            throw new IllegalArgumentException(
                    "Unsupported Media request parameter value type: " + value.getClass().getName());
        }
    }

    private static void appendBoundedQuoted(String value, BoundedJsonOutput output) {
        if (value.length() > output.remaining()) {
            throw new CanonicalJsonLimitExceededException(
                    "canonical JSON string exceeds its remaining bound");
        }
        // Individual media result strings are source-bounded; constructing this escaped
        // representation is therefore at most six times the remaining capped budget.
        output.append(quote(value));
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
