package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Deterministic allowlist for data disclosed to an external Media provider.
 *
 * <p>Free-form request parameters and artifact metadata are runtime-internal extension surfaces;
 * serializing them wholesale would allow credentials, device/location metadata, raw biometric
 * material, or unrelated subject data to cross the provider boundary. This class exposes only the
 * fields required to perform the selected operation and validates bounded JSON-compatible values.
 * Allowlisted leaves are scalar-only, so nested caller-controlled fields cannot ride through an
 * approved key. This is a structural disclosure boundary, not DLP: approved scalar strings still
 * require their owning request contract to validate their meaning and contents.
 *
 * @doc.type class
 * @doc.purpose Minimize Media request and artifact data before external provider disclosure
 * @doc.layer product
 * @doc.pattern PolicyBoundary, Allowlist
 */
public final class MediaExternalDisclosureSanitizer {
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
            if (source.containsKey(key)) result.put(key, boundedValue(source.get(key), key));
        }
        return Map.copyOf(result);
    }

    private static Object boundedValue(Object value, String path) {
        // An allowlisted parameter name does not make arbitrary nested content safe.
        // These leaves are the only values disclosed to an external provider; accepting
        // maps/lists here would let a caller smuggle secrets under e.g. "language" or
        // "width" and bypass the top-level field allowlist.
        if (value == null || value instanceof Boolean || value instanceof Number) return value;
        if (value instanceof String text) {
            if (text.length() > MAX_STRING_LENGTH) {
                throw new IllegalArgumentException("External Media field exceeds string bound: " + path);
            }
            return text;
        }
        throw new IllegalArgumentException(
                "External Media field must be a scalar value at " + path);
    }
}
