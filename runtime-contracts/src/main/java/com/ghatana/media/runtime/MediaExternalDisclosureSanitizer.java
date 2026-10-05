package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Deterministic allowlist for data disclosed to an external Media provider.
 *
 * <p>Free-form request parameters and artifact metadata are runtime-internal extension surfaces;
 * serializing them wholesale would allow credentials, device/location metadata, raw biometric
 * material, or unrelated subject data to cross the provider boundary. This class exposes only the
 * fields required to perform the selected operation and validates bounded JSON-compatible values.
 *
 * @doc.type class
 * @doc.purpose Minimize Media request and artifact data before external provider disclosure
 * @doc.layer product
 * @doc.pattern PolicyBoundary, Allowlist
 */
public final class MediaExternalDisclosureSanitizer {
    private static final int MAX_DEPTH = 4;
    private static final int MAX_COLLECTION_SIZE = 128;
    private static final int MAX_STRING_LENGTH = 65_536;

    private static final Set<String> REQUEST_PARAMETER_ALLOWLIST = Set.of(
            "language", "targetLanguage", "diarization", "timestamps", "outputFormat",
            "codec", "targetCodec", "width", "height", "frameRate", "sampleRate", "channels",
            "maxDurationMillis", "faceDetection", "faceRecognition", "speakerIdentification",
            "speakerEmbedding", "voicePrint", "voiceClone", "voiceCloning");
    private static final Set<String> ARTIFACT_METADATA_ALLOWLIST = Set.of(
            "durationMillis", "width", "height", "frameRate", "sampleRate", "channels",
            "codec", "language");

    private MediaExternalDisclosureSanitizer() { }

    public static Map<String, Object> request(ProcessingJobRequest request) {
        java.util.Objects.requireNonNull(request, "request");
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("requestId", request.requestId());
        result.put("artifactId", request.artifactId());
        result.put("jobType", request.jobType().name());
        result.put("parameters", allowlisted(request.parameters(), REQUEST_PARAMETER_ALLOWLIST));
        result.put("governance", Map.of(
                "purpose", request.governanceContext().purpose(),
                "classification", request.governanceContext().classification().name(),
                "retentionPolicy", request.governanceContext().retentionPolicy(),
                "biometricSensitivity", request.governanceContext().biometricSensitivity().name(),
                "automationRisk", request.governanceContext().automationRisk().name()));
        return Map.copyOf(result);
    }

    public static Map<String, Object> artifact(MediaArtifact artifact) {
        java.util.Objects.requireNonNull(artifact, "artifact");
        return Map.of(
                "artifactId", artifact.artifactId(),
                "contentType", artifact.contentType(),
                "sizeBytes", artifact.sizeBytes(),
                "sha256", artifact.sha256(),
                "objectReference", artifact.objectReference(),
                "classification", artifact.classification(),
                "metadata", allowlisted(artifact.metadata(), ARTIFACT_METADATA_ALLOWLIST));
    }

    private static Map<String, Object> allowlisted(Map<String, Object> source, Set<String> allowed) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (source == null) return Map.of();
        for (String key : allowed) {
            if (source.containsKey(key)) result.put(key, boundedValue(source.get(key), key, 0));
        }
        return Map.copyOf(result);
    }

    private static Object boundedValue(Object value, String path, int depth) {
        if (value == null || value instanceof Boolean || value instanceof Number) return value;
        if (value instanceof String text) {
            if (text.length() > MAX_STRING_LENGTH) {
                throw new IllegalArgumentException("External Media field exceeds string bound: " + path);
            }
            return text;
        }
        if (depth >= MAX_DEPTH) {
            throw new IllegalArgumentException("External Media field exceeds nesting bound: " + path);
        }
        if (value instanceof List<?> list) {
            if (list.size() > MAX_COLLECTION_SIZE) {
                throw new IllegalArgumentException("External Media field exceeds collection bound: " + path);
            }
            List<Object> copy = new ArrayList<>(list.size());
            for (int index = 0; index < list.size(); index++) {
                copy.add(boundedValue(list.get(index), path + "[" + index + "]", depth + 1));
            }
            return List.copyOf(copy);
        }
        if (value instanceof Map<?, ?> map) {
            if (map.size() > MAX_COLLECTION_SIZE) {
                throw new IllegalArgumentException("External Media field exceeds object bound: " + path);
            }
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String key) || key.isBlank()) {
                    throw new IllegalArgumentException("External Media object keys must be non-blank strings: " + path);
                }
                copy.put(key, boundedValue(entry.getValue(), path + "." + key, depth + 1));
            }
            return Map.copyOf(copy);
        }
        throw new IllegalArgumentException(
                "External Media field has unsupported value type at " + path);
    }
}
