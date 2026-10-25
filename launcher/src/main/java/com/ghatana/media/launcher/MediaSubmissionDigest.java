package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/** Stable digest of normalized submission intent and its ordered provider plan. */
final class MediaSubmissionDigest {
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    private MediaSubmissionDigest() { }

    static String compute(
            ProcessingJobRequest request,
            String pinnedArtifactVersion,
            List<MediaProcessingProvider> providers) {
        Map<String, Object> submission = new TreeMap<>();
        submission.put("requestId", request.requestId());
        submission.put("tenantId", request.tenantId());
        submission.put("principalId", request.principalId());
        submission.put("correlationId", request.correlationId());
        submission.put("artifactId", request.artifactId());
        submission.put("artifactVersion", pinnedArtifactVersion);
        submission.put("jobType", request.jobType().name());
        submission.put("providerHint", request.providerHint().toLowerCase(java.util.Locale.ROOT));
        submission.put("parameters", request.parameters());

        var governance = request.governanceContext();
        Map<String, Object> governanceFields = new TreeMap<>();
        governanceFields.put("consentId", governance.consentId());
        governanceFields.put("purpose", governance.purpose());
        governanceFields.put("classification", governance.classification().name());
        governanceFields.put("residency", governance.residency());
        governanceFields.put("allowedRegions", governance.allowedRegions());
        governanceFields.put("externalProcessingAllowed", governance.externalProcessingAllowed());
        governanceFields.put("retentionPolicy", governance.retentionPolicy());
        governanceFields.put("providerRetentionAllowed", governance.providerRetentionAllowed());
        governanceFields.put("biometricProcessingAllowed", governance.biometricProcessingAllowed());
        governanceFields.put("biometricProcessingBasis", governance.biometricProcessingBasis());
        governanceFields.put("biometricSensitivity", governance.biometricSensitivity().name());
        governanceFields.put("automationRisk", governance.automationRisk().name());
        submission.put("governance", governanceFields);

        List<Map<String, Object>> providerPlan = new ArrayList<>();
        for (MediaProcessingProvider provider : providers) {
            Map<String, Object> item = new TreeMap<>();
            item.put("providerId", provider.providerId());
            item.put("providerVersion", provider.providerVersion());
            item.put("modelVersion", provider.modelVersion(request.jobType()));
            item.put("capabilities", provider.capabilities());
            item.put("priority", provider.priority());
            item.put("processingBoundary", provider.processingBoundary().name());
            item.put("processingRegion", provider.processingRegion());
            item.put("providerDataRetention", provider.providerDataRetention().name());
            providerPlan.add(item);
        }
        Map<String, Object> complete = new TreeMap<>();
        complete.put("submission", submission);
        complete.put("providerPlan", providerPlan);
        try {
            byte[] normalized = JSON.writeValueAsBytes(canonicalize(complete));
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(normalized));
        } catch (Exception failure) {
            throw new IllegalArgumentException("Media submission cannot be normalized for idempotency", failure);
        }
    }

    private static Object canonicalize(Object value) {
        if (value == null || value instanceof String || value instanceof Boolean || value instanceof Number) {
            return value;
        }
        if (value instanceof Enum<?> item) return item.name();
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> sorted = new TreeMap<>();
            map.forEach((key, item) -> {
                if (!(key instanceof String text)) {
                    throw new IllegalArgumentException("Media request parameter keys must be strings");
                }
                sorted.put(text, canonicalize(item));
            });
            return sorted;
        }
        if (value instanceof Set<?> set) {
            return set.stream().map(MediaSubmissionDigest::canonicalize)
                    .sorted(java.util.Comparator.comparing(MediaSubmissionDigest::canonicalJson)).toList();
        }
        if (value instanceof Collection<?> values) {
            return values.stream().map(MediaSubmissionDigest::canonicalize).toList();
        }
        if (value.getClass().isArray()) {
            int length = java.lang.reflect.Array.getLength(value);
            List<Object> items = new ArrayList<>(length);
            for (int index = 0; index < length; index++) {
                items.add(canonicalize(java.lang.reflect.Array.get(value, index)));
            }
            return items;
        }
        if (value instanceof java.time.temporal.TemporalAccessor) return value.toString();
        throw new IllegalArgumentException("Unsupported Media request parameter type: " + value.getClass().getName());
    }

    private static String canonicalJson(Object value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (Exception failure) {
            throw new IllegalArgumentException("Media request value cannot be normalized", failure);
        }
    }
}
