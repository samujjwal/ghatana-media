package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.ConsentDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;

import java.time.Instant;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Typed provider capability and governed result contracts for Media modalities.
 *
 * @doc.type class
 * @doc.purpose Provide Media Modality Contracts behavior
 * @doc.layer product
 * @doc.pattern Component
 */
public final class MediaModalityContracts {
    private static final int MAX_CONTEXT_SEGMENTS = 32;
    private static final int MAX_RESULT_DEPTH = 8;
    private static final int MAX_RESULT_ENTRIES = 256;
    private static final int MAX_RESULT_COLLECTION_ITEMS = 256;
    private static final int MAX_RESULT_STRING_CHARS = 16_384;
    private static final int MAX_RESULT_BYTES = 4 * 1024 * 1024;

    private MediaModalityContracts() { }

    public enum ProviderHealthStatus { HEALTHY, DEGRADED, UNAVAILABLE }

    /** Explicit provider degradation behavior; modality results are never fabricated on outage. */
    public enum DegradationPolicy { FAIL_CLOSED, RETRY_BOUNDED, LOCAL_DIAGNOSTIC_ONLY }

    /** Resource limits that apply to one modality execution. */
    public record ExecutionBounds(
            Duration timeout,
            int maximumInputBytes,
            int maximumOutputBytes,
            int maximumResultEntries,
            int maximumResultDepth) {
        public ExecutionBounds {
            timeout = Objects.requireNonNull(timeout, "timeout");
            if (timeout.isZero() || timeout.isNegative() || timeout.compareTo(Duration.ofMinutes(10)) > 0) {
                throw new IllegalArgumentException("modality timeout must be between 1ms and 10 minutes");
            }
            if (maximumInputBytes < 1 || maximumInputBytes > 256 * 1024 * 1024
                    || maximumOutputBytes < 1 || maximumOutputBytes > 64 * 1024 * 1024
                    || maximumResultEntries < 1 || maximumResultEntries > MAX_RESULT_ENTRIES
                    || maximumResultDepth < 1 || maximumResultDepth > MAX_RESULT_DEPTH) {
                throw new IllegalArgumentException("modality execution bounds are outside the supported range");
            }
        }

        public static ExecutionBounds defaults() {
            return new ExecutionBounds(Duration.ofSeconds(30), 64 * 1024 * 1024,
                    MAX_RESULT_BYTES, MAX_RESULT_ENTRIES, MAX_RESULT_DEPTH);
        }
    }

    /** Non-secret health projection used by readiness and capability discovery. */
    public record ProviderHealth(
            String providerId,
            String providerVersion,
            ProviderHealthStatus status,
            DegradationPolicy degradationPolicy,
            String reason,
            Instant checkedAt) {
        public ProviderHealth {
            providerId = required(providerId, "providerId");
            providerVersion = required(providerVersion, "providerVersion");
            status = Objects.requireNonNull(status, "status");
            degradationPolicy = Objects.requireNonNull(degradationPolicy, "degradationPolicy");
            reason = reason == null ? "" : reason.trim();
            if (reason.length() > 512) throw new IllegalArgumentException("provider health reason is too long");
            checkedAt = checkedAt == null ? Instant.now() : checkedAt;
        }
    }

    /** Safe capability discovery projection for one provider modality. */
    public record CapabilityProfile(
            String providerId,
            String providerVersion,
            JobType modality,
            Set<String> codecs,
            Set<String> containers,
            Set<Integer> sampleRatesHz,
            int maximumWidth,
            int maximumHeight,
            Set<String> modelVersions,
            Set<String> regions,
            ProcessingBoundary processingBoundary,
            boolean timingAvailable,
            boolean confidenceAvailable,
            boolean biometricDerivativesAvailable,
            ProviderHealth health,
            DegradationPolicy degradationPolicy,
            ExecutionBounds executionBounds) {
        public CapabilityProfile {
            providerId = required(providerId, "providerId");
            providerVersion = required(providerVersion, "providerVersion");
            modality = Objects.requireNonNull(modality, "modality");
            codecs = normalized(codecs);
            containers = normalized(containers);
            sampleRatesHz = Set.copyOf(sampleRatesHz == null ? Set.of() : sampleRatesHz);
            if (sampleRatesHz.stream().anyMatch(rate -> rate == null || rate < 1 || rate > 768_000)) {
                throw new IllegalArgumentException("sampleRatesHz contains an invalid rate");
            }
            if (maximumWidth < 0 || maximumHeight < 0 || maximumWidth > 65_536 || maximumHeight > 65_536) {
                throw new IllegalArgumentException("resolution bounds are invalid");
            }
            modelVersions = normalized(modelVersions);
            regions = normalized(regions);
            processingBoundary = Objects.requireNonNull(processingBoundary, "processingBoundary");
            health = Objects.requireNonNull(health, "health");
            if (!health.providerId().equals(providerId) || !health.providerVersion().equals(providerVersion)) {
                throw new IllegalArgumentException("provider health identity must match capability identity");
            }
            degradationPolicy = Objects.requireNonNull(degradationPolicy, "degradationPolicy");
            executionBounds = Objects.requireNonNull(executionBounds, "executionBounds");
            if (modelVersions.isEmpty()) {
                throw new IllegalArgumentException("modelVersions must declare at least one version");
            }
            if (Set.of(JobType.SPEECH_TO_TEXT, JobType.TEXT_TO_SPEECH).contains(modality)
                    && (codecs.isEmpty() || containers.isEmpty() || sampleRatesHz.isEmpty())) {
                throw new IllegalArgumentException(
                        "speech capability requires codec, container, and sample-rate declarations");
            }
            if (modality == JobType.VISION && (maximumWidth < 1 || maximumHeight < 1)) {
                throw new IllegalArgumentException("vision capability requires resolution bounds");
            }
        }

        /** Compatibility constructor for providers that have not supplied the optional projections. */
        public CapabilityProfile(
                String providerId,
                String providerVersion,
                JobType modality,
                Set<String> codecs,
                Set<String> containers,
                Set<Integer> sampleRatesHz,
                int maximumWidth,
                int maximumHeight,
                Set<String> modelVersions,
                Set<String> regions,
                ProcessingBoundary processingBoundary,
                boolean timingAvailable,
                boolean confidenceAvailable,
                boolean biometricDerivativesAvailable) {
            this(providerId, providerVersion, modality, codecs, containers, sampleRatesHz,
                    maximumWidth, maximumHeight, modelVersions, regions, processingBoundary,
                    timingAvailable, confidenceAvailable, biometricDerivativesAvailable,
                    new ProviderHealth(providerId, providerVersion,
                            ProviderHealthStatus.HEALTHY,
                            processingBoundary == ProcessingBoundary.LOCAL
                                    ? DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY : DegradationPolicy.FAIL_CLOSED,
                            "", Instant.now()),
                    processingBoundary == ProcessingBoundary.LOCAL
                            ? DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY : DegradationPolicy.FAIL_CLOSED,
                    ExecutionBounds.defaults());
        }
    }

    /** Purpose-bound reference to multimodal context; raw context is not embedded in the job. */
    public record ContextReference(
            String reference,
            String purpose,
            DataClassification classification,
            Instant expiresAt) {
        public ContextReference {
            reference = required(reference, "reference");
            purpose = required(purpose, "purpose").toLowerCase(Locale.ROOT);
            classification = Objects.requireNonNull(classification, "classification");
            expiresAt = Objects.requireNonNull(expiresAt, "expiresAt");
            if (!(reference.startsWith("urn:") || reference.startsWith("sha256:"))) {
                throw new IllegalArgumentException("context reference must be an opaque URN or SHA-256 reference");
            }
            if (!expiresAt.isAfter(Instant.now())) {
                throw new IllegalArgumentException("context reference is expired");
            }
        }
    }

    /** Validates and enriches provider output before the durable job terminal transition. */
    public static Map<String, Object> governedResult(
            ProcessingJobRequest request,
            MediaArtifact artifact,
            String providerId,
            String providerVersion,
            String modelVersion,
            Map<String, Object> rawResult,
            ConsentDecision consent) {
        ProcessingBoundary boundary = request.governanceContext().externalProcessingAllowed()
                ? ProcessingBoundary.EXTERNAL : ProcessingBoundary.LOCAL;
        return governedResult(request, artifact, providerId, providerVersion, modelVersion,
                rawResult, consent, boundary, ProviderDataRetention.UNKNOWN);
    }

    /**
     * Canonicalizes one provider result. The provider boundary is explicit so external results
     * cannot bypass consent/privacy checks by calling the compatibility overload.
     */
    public static Map<String, Object> governedResult(
            ProcessingJobRequest request,
            MediaArtifact artifact,
            String providerId,
            String providerVersion,
            String modelVersion,
            Map<String, Object> rawResult,
            ConsentDecision consent,
            ProcessingBoundary boundary,
            ProviderDataRetention providerRetention) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(artifact, "artifact");
        Objects.requireNonNull(boundary, "boundary");
        Objects.requireNonNull(providerRetention, "providerRetention");
        Map<String, Object> source = rawResult == null ? Map.of() : rawResult;
        validateContextReferences(request);
        validateTypedResult(request.jobType(), source);
        validateBiometricResult(request.governanceContext(), consent, source);
        validateExternalGovernance(request, consent, boundary, providerRetention);

        Map<String, Object> result = new LinkedHashMap<>(source);
        result.put("modality", request.jobType().name());
        if (request.jobType() == JobType.SPEECH_TO_TEXT) {
            result.putIfAbsent("language", "undetermined");
            result.putIfAbsent("timingAvailable", false);
            result.putIfAbsent("confidenceAvailable", false);
        } else if (request.jobType() == JobType.TEXT_TO_SPEECH) {
            result.putIfAbsent("voice", stringParameter(request, "voice", "provider-default"));
            result.put("consentId", consent == null ? "" : consent.consentId());
            result.put("consentVerified", consent != null && consent.verified());
        }

        DataClassification floor = classification(artifact.classification());
        result.put("providerId", required(providerId, "providerId"));
        result.put("providerVersion", required(providerVersion, "providerVersion"));
        result.put("modelVersion", required(modelVersion, "modelVersion"));
        result.put("sourceArtifactRef", "urn:ghatana:media-artifact:" + artifact.artifactId());
        result.put("sourceSha256", artifact.sha256());
        result.put("classification", floor.name());
        result.put("purpose", request.governanceContext().purpose());
        result.put("retentionPolicy", request.governanceContext().retentionPolicy());
        result.put("derivedMetadataExpiresAt", artifact.expiresAt().toString());
        result.put("provenanceRefs", List.of(
                "urn:ghatana:media-artifact:" + artifact.artifactId(),
                "sha256:" + artifact.sha256(),
                "urn:ghatana:media-provider:" + providerId + ":" + providerVersion));
        return Map.copyOf(result);
    }

    private static void validateExternalGovernance(
            ProcessingJobRequest request,
            ConsentDecision consent,
            ProcessingBoundary boundary,
            ProviderDataRetention providerRetention) {
        if (boundary == ProcessingBoundary.LOCAL) return;
        MediaGovernanceContext governance = request.governanceContext();
        if (consent == null || !consent.activeAt(Instant.now()) || !consent.externalProcessingAllowed()) {
            throw new SecurityException("active verified consent is required for external modality results");
        }
        if (!governance.externalProcessingAllowed()
                || governance.consentId().isBlank()
                || !governance.consentId().equals(consent.consentId())) {
            throw new SecurityException("external modality result does not match governed consent");
        }
        if (!consent.permitsPurpose(governance.purpose())
                || !consent.permitsRegion(governance.residency())
                || !governance.permitsRegion(governance.residency())) {
            throw new SecurityException("external modality result is outside the consent/privacy envelope");
        }
        if (!governance.providerRetentionAllowed() && providerRetention != ProviderDataRetention.NONE) {
            throw new SecurityException("provider retention posture is not permitted by governance");
        }
    }

    private static void validateTypedResult(JobType modality, Map<String, Object> result) {
        validateValue(result, 0, new Counter());
        if (Boolean.TRUE.equals(result.get("diagnostic"))) return;
        switch (modality) {
            case SPEECH_TO_TEXT -> {
                requireString(result, "text", "STT result requires grounded transcription text");
                rejectKeys(result, Set.of("detections", "objects", "labels"), "STT result contains vision fields");
                optionalNumber(result, "confidence", 0, 1);
            }
            case TEXT_TO_SPEECH -> {
                if (!hasAny(result, "audioArtifactRef", "audioRef", "audioBytes", "audioContent")) {
                    throw new IllegalArgumentException("TTS result requires grounded audio output");
                }
                requireOptionalString(result, "voice");
            }
            case VISION -> {
                rejectKeys(result, Set.of("text", "transcription", "transcript"),
                        "Vision result cannot masquerade as text completion");
                if (!hasAny(result, "detections", "objects", "labels", "caption", "description", "faceCount")) {
                    throw new IllegalArgumentException("Vision result requires grounded detections or caption");
                }
            }
            case MULTIMODAL -> {
                if (!hasAny(result, "observations", "answer", "caption", "detections", "objects",
                        "labels", "transcript", "embedding")) {
                    throw new IllegalArgumentException("Multimodal result requires grounded modality observations");
                }
            }
            case TRANSCODE -> { /* The transcode artifact contract is validated by the artifact store. */ }
        }
    }

    private static void validateValue(Object value, int depth, Counter counter) {
        if (depth > MAX_RESULT_DEPTH) throw new IllegalArgumentException("Media modality result nesting exceeds " + MAX_RESULT_DEPTH);
        if (value == null) return;
        if (value instanceof Map<?, ?> map) {
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (++counter.entries > MAX_RESULT_ENTRIES) throw new IllegalArgumentException("Media modality result exceeds " + MAX_RESULT_ENTRIES + " fields");
                if (!(entry.getKey() instanceof String key) || key.isBlank() || key.length() > 256) {
                    throw new IllegalArgumentException("Media modality result keys must be bounded strings");
                }
                validateValue(entry.getValue(), depth + 1, counter);
            }
        } else if (value instanceof Iterable<?> values) {
            int count = 0;
            for (Object item : values) {
                if (++count > MAX_RESULT_COLLECTION_ITEMS) throw new IllegalArgumentException("Media modality result collection is too large");
                validateValue(item, depth + 1, counter);
            }
        } else if (value instanceof byte[] bytes) {
            if (bytes.length > MAX_RESULT_BYTES) throw new IllegalArgumentException("Media modality result bytes exceed " + MAX_RESULT_BYTES);
        } else if (value instanceof String text) {
            if (text.length() > MAX_RESULT_STRING_CHARS) throw new IllegalArgumentException("Media modality result string is too long");
        } else if (!(value instanceof Number || value instanceof Boolean)) {
            throw new IllegalArgumentException("Media modality result contains an unsupported value type");
        }
    }

    private static boolean hasAny(Map<String, Object> result, String... keys) {
        for (String key : keys) if (result.containsKey(key) && result.get(key) != null) return true;
        return false;
    }

    private static void requireString(Map<String, Object> result, String key, String message) {
        if (!(result.get(key) instanceof String text) || text.isBlank()) throw new IllegalArgumentException(message);
    }

    private static void requireOptionalString(Map<String, Object> result, String key) {
        if (result.containsKey(key) && (!(result.get(key) instanceof String text) || text.isBlank())) {
            throw new IllegalArgumentException(key + " must be a non-blank string");
        }
    }

    private static void optionalNumber(Map<String, Object> result, String key, double min, double max) {
        Object value = result.get(key);
        if (value instanceof Number number && (number.doubleValue() < min || number.doubleValue() > max)) {
            throw new IllegalArgumentException(key + " is outside the supported range");
        } else if (value != null && !(value instanceof Number)) {
            throw new IllegalArgumentException(key + " must be numeric");
        }
    }

    private static void rejectKeys(Map<String, Object> result, Set<String> keys, String message) {
        for (String key : keys) if (result.containsKey(key)) throw new IllegalArgumentException(message);
    }

    private static final class Counter { int entries; }

    private static void validateContextReferences(ProcessingJobRequest request) {
        Object raw = request.parameters().get("contextReferences");
        if (raw == null) return;
        if (!(raw instanceof Iterable<?> iterable)) {
            throw new IllegalArgumentException("contextReferences must be a bounded list");
        }
        List<ContextReference> references = new ArrayList<>();
        for (Object value : iterable) {
            if (!(value instanceof ContextReference reference)) {
                throw new IllegalArgumentException("contextReferences must contain typed ContextReference values");
            }
            if (!reference.purpose().equalsIgnoreCase(request.governanceContext().purpose())) {
                throw new SecurityException("multimodal context purpose does not match the governed request");
            }
            if (!reference.classification().isAtLeast(request.governanceContext().classification())) {
                throw new SecurityException("multimodal context would lower the classification floor");
            }
            references.add(reference);
            if (references.size() > MAX_CONTEXT_SEGMENTS) {
                throw new IllegalArgumentException("contextReferences exceeds " + MAX_CONTEXT_SEGMENTS);
            }
        }
    }

    private static void validateBiometricResult(
            MediaGovernanceContext governance,
            ConsentDecision consent,
            Map<String, Object> result) {
        boolean containsBiometric = containsBiometricField(result);
        if (!containsBiometric) return;
        if (!governance.biometricProcessingAllowed()
                || governance.biometricProcessingBasis().isBlank()
                || consent == null
                || !consent.activeAt(Instant.now())
                || !consent.biometricProcessingAllowed()) {
            throw new SecurityException(
                    "face or biometric result requires active authority-owned biometric eligibility");
        }
    }

    private static boolean containsBiometricField(Map<?, ?> values) {
        for (Map.Entry<?, ?> entry : values.entrySet()) {
            String key = String.valueOf(entry.getKey()).toLowerCase(Locale.ROOT)
                    .replace("_", "").replace("-", "");
            if (key.contains("face") || key.contains("biometric") || key.contains("voiceprint")) return true;
            if (entry.getValue() instanceof Map<?, ?> nested && containsBiometricField(nested)) return true;
        }
        return false;
    }

    private static DataClassification classification(String value) {
        try {
            return DataClassification.valueOf(required(value, "artifact classification").toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException failure) {
            throw new SecurityException("artifact classification is not canonical", failure);
        }
    }

    private static String stringParameter(
            ProcessingJobRequest request, String name, String fallback) {
        Object value = request.parameters().get(name);
        return value instanceof String text && !text.isBlank() ? text.trim() : fallback;
    }

    private static Set<String> normalized(Set<String> values) {
        return Set.copyOf(values == null ? Set.of() : values.stream()
                .filter(Objects::nonNull)
                .map(value -> value.trim().toLowerCase(Locale.ROOT))
                .filter(value -> !value.isBlank())
                .toList());
    }

    private static String required(String value, String field) {
        if (value == null || value.isBlank() || value.length() > 512) {
            throw new IllegalArgumentException(field + " must be bounded and non-blank");
        }
        return value.trim();
    }
}
