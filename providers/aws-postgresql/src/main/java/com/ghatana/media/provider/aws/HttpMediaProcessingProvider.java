package com.ghatana.media.provider.aws;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.JsonNode;
import com.ghatana.media.runtime.MediaExternalDisclosureSanitizer;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;

import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.TimeUnit;

/**
 * Remote adapter for consent-, purpose-, residency-, and biometric-governed Media processing.
 *
 * @doc.type class
 * @doc.purpose Provide Http Media Processing Provider behavior
 * @doc.layer product
 * @doc.pattern Provider
 */
public final class HttpMediaProcessingProvider implements MediaProcessingProvider {
    private static final Set<String> BIOMETRIC_PARAMETER_KEYS = Set.of(
            "biometric", "faceDetection", "faceRecognition", "speakerIdentification",
            "speakerEmbedding", "voicePrint", "voiceClone", "voiceCloning");
    private static final Duration CANCELLATION_TOMBSTONE_MARGIN = Duration.ofMinutes(1);

    private final MediaHttpProviderClient client;
    private final Set<JobType> capabilities;
    private final String providerVersion;
    private final String modelVersion;
    private final ConcurrentMap<String, Object> requestLocks = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, Instant> cancellationTombstones = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, CompletableFuture<HttpResponse<byte[]>>> activeRequests =
            new ConcurrentHashMap<>();

    public HttpMediaProcessingProvider() { this(System.getenv()); }

    HttpMediaProcessingProvider(Map<String, String> environment) {
        client = new MediaHttpProviderClient(environment);
        capabilities = jobTypes(environment.getOrDefault(
                "MEDIA_HTTP_PROVIDER_JOB_TYPES",
                "TRANSCODE,SPEECH_TO_TEXT,TEXT_TO_SPEECH,VISION,MULTIMODAL"));
        providerVersion = required(environment.getOrDefault(
                "MEDIA_HTTP_PROVIDER_VERSION", "http-media-v1"), "MEDIA_HTTP_PROVIDER_VERSION");
        modelVersion = required(environment.getOrDefault(
                "MEDIA_HTTP_PROVIDER_MODEL_VERSION", "provider-managed-v1"),
                "MEDIA_HTTP_PROVIDER_MODEL_VERSION");
    }

    @Override public String providerId() { return "http-media-processing"; }
    @Override public String providerVersion() { return providerVersion; }
    @Override public String modelVersion(JobType modality) { return modelVersion; }
    @Override public Set<JobType> capabilities() { return Set.copyOf(capabilities); }
    @Override public boolean ready() { return client.ready() && !capabilities.isEmpty(); }
    @Override public boolean productionEligible() { return client.productionEligible() && !capabilities.isEmpty(); }
    @Override public int priority() { return client.priority(); }
    @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
    @Override public String processingRegion() { return client.processingRegion(); }
    @Override public ProviderDataRetention providerDataRetention() { return client.providerDataRetention(); }

    /**
     * Remote timeout/network ambiguity is not replay-safe by default. A second provider call could
     * duplicate expensive or consequential work after the first provider already accepted it.
     */
    @Override
    public boolean fallbackEligible(Throwable failure) {
        return false;
    }

    @Override
    public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
        client.requireConfigured();
        java.util.Objects.requireNonNull(context, "context");
        context.cancellation().throwIfCancelled();
        requireExternalGovernance(context);
        Map<String, Object> payload = Map.of(
                "request", MediaExternalDisclosureSanitizer.request(context.request()),
                "artifact", MediaExternalDisclosureSanitizer.artifact(context.artifact()),
                "consent", Map.of(
                        "authorityId", context.consentDecision().authorityId(),
                        "consentId", context.consentDecision().consentId(),
                        "verifiedAt", context.consentDecision().verifiedAt().toString()),
                "processingRegion", processingRegion());
        try {
            HttpRequest request = client.request(client.resolve("v1/process"))
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("X-Tenant-Id", context.request().tenantId())
                    .header("X-Correlation-Id", context.request().correlationId())
                    .header("X-Request-Id", context.request().requestId())
                    .header("X-Consent-Id", context.consentDecision().consentId())
                    .header("X-Processing-Region", processingRegion())
                    .timeout(client.timeout())
                    .POST(HttpRequest.BodyPublishers.ofByteArray(
                            client.mapper().writeValueAsBytes(payload)))
                    .build();
            String requestKey = requestKey(context.request().tenantId(), context.request().requestId());
            Object lock = requestLocks.computeIfAbsent(requestKey, ignored -> new Object());
            CompletableFuture<HttpResponse<byte[]>> raw;
            synchronized (lock) {
                clearExpiredCancellation(requestKey, Instant.now());
                if (context.cancellation().cancelled() || cancellationTombstones.containsKey(requestKey)) {
                    return CompletableFuture.failedFuture(
                            new CancellationException("Media processing request was cancelled before dispatch"));
                }
                raw = client.send(request);
                activeRequests.put(requestKey, raw);
            }

            CompletableFuture<Map<String, Object>> result = new CompletableFuture<>();
            raw.whenComplete((response, failure) -> {
                if (result.isDone()) return;
                if (cancellationTombstones.containsKey(requestKey)) {
                    result.completeExceptionally(
                            new CancellationException("Media processing request was cancelled after dispatch"));
                    return;
                }
                if (failure != null) {
                    result.completeExceptionally(unwrap(failure));
                    return;
                }
                try {
                    JsonNode json = client.json(response, "Media processing");
                    if (!json.isObject()) {
                        throw new IllegalStateException("Media processing response must be an object");
                    }
                    result.complete(client.mapper().convertValue(
                            json, new TypeReference<Map<String, Object>>() { }));
                } catch (RuntimeException invalid) {
                    result.completeExceptionally(invalid);
                }
            });
            result.whenComplete((ignored, ignoredFailure) -> {
                if (result.isCancelled()) raw.cancel(true);
                activeRequests.remove(requestKey, raw);
                if (!cancellationTombstones.containsKey(requestKey)) {
                    requestLocks.remove(requestKey, lock);
                }
            });
            return result;
        } catch (Exception failure) {
            return CompletableFuture.failedFuture(failure);
        }
    }

    @Override
    public com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome cancel(
            String tenantId, String principalId, String correlationId, String jobId) {
        client.requireConfigured();
        if (tenantId == null || tenantId.isBlank() || principalId == null || principalId.isBlank()
                || correlationId == null || correlationId.isBlank() || jobId == null || jobId.isBlank()) {
            throw new IllegalArgumentException(
                    "tenantId, principalId, correlationId, and jobId are required for cancellation");
        }
        String requestKey = requestKey(tenantId, correlationId);
        Object lock = requestLocks.computeIfAbsent(requestKey, ignored -> new Object());
        Instant cancellationExpiresAt = Instant.now()
                .plus(client.timeout())
                .plus(CANCELLATION_TOMBSTONE_MARGIN);
        synchronized (lock) {
            cancellationTombstones.put(requestKey, cancellationExpiresAt);
            CompletableFuture<HttpResponse<byte[]>> active = activeRequests.remove(requestKey);
            if (active != null) active.cancel(true);

            String encodedJobId = URLEncoder.encode(jobId, StandardCharsets.UTF_8).replace("+", "%20");
            HttpRequest request = client.request(client.resolve("v1/jobs/" + encodedJobId + "/cancel"))
                    .header("Accept", "application/json")
                    .header("X-Tenant-Id", tenantId)
                    .header("X-Principal-Id", principalId)
                    .header("X-Correlation-Id", correlationId)
                    .header("X-Request-Id", correlationId)
                    .timeout(client.timeout())
                    .POST(HttpRequest.BodyPublishers.noBody())
                    .build();
            scheduleCancellationCleanup(requestKey, lock, cancellationExpiresAt);
            try {
                int status = client.send(request).join().statusCode();
                if (status == 200 || status == 204) {
                    return com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome.CONFIRMED;
                }
                if (status == 202) {
                    return com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome.REQUESTED_UNCONFIRMED;
                }
                throw new IllegalStateException(
                        "Media provider cancellation returned status " + status);
            } catch (java.util.concurrent.CompletionException failure) {
                return com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome.REQUESTED_UNCONFIRMED;
            }
        }
    }

    private void scheduleCancellationCleanup(
            String requestKey,
            Object lock,
            Instant cancellationExpiresAt) {
        long delayMillis = Math.max(1L,
                Duration.between(Instant.now(), cancellationExpiresAt).toMillis());
        CompletableFuture.delayedExecutor(delayMillis, TimeUnit.MILLISECONDS).execute(() -> {
            cancellationTombstones.remove(requestKey, cancellationExpiresAt);
            if (!activeRequests.containsKey(requestKey)) requestLocks.remove(requestKey, lock);
        });
    }

    private void clearExpiredCancellation(String requestKey, Instant now) {
        Instant expiresAt = cancellationTombstones.get(requestKey);
        if (expiresAt != null && !expiresAt.isAfter(now)) {
            cancellationTombstones.remove(requestKey, expiresAt);
        }
    }

    private void requireExternalGovernance(ProcessingContext context) {
        MediaGovernanceContext governance = context.request().governanceContext();
        var consent = context.consentDecision();
        DataClassification artifactClassification;
        try {
            artifactClassification = DataClassification.valueOf(
                    context.artifact().classification().trim().toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException failure) {
            throw new SecurityException("Media artifact classification is not canonical", failure);
        }
        if (!governance.classification().isAtLeast(artifactClassification)) {
            throw new SecurityException(
                    "Media request classification cannot lower the artifact classification floor");
        }
        if (!governance.externalProcessingAllowed()) {
            throw new SecurityException("Media request does not permit external processing");
        }
        if (!consent.externalProcessingAllowed()) {
            throw new SecurityException("Verified media consent does not permit external processing");
        }
        if (!governance.permitsRegion(processingRegion())) {
            throw new SecurityException("Media provider region is not permitted by the governance envelope");
        }
        if (!consent.permitsRegion(processingRegion())) {
            throw new SecurityException("Media provider region is not permitted by verified consent");
        }
        if (!consent.permitsPurpose(governance.purpose())) {
            throw new SecurityException("Media processing purpose is not permitted by verified consent");
        }
        if (!governance.providerRetentionAllowed()
                && providerDataRetention() != ProviderDataRetention.NONE) {
            throw new SecurityException(
                    "Media provider retention posture is not permitted by request governance");
        }
        if (!context.consentDecision().activeAt(Instant.now())) {
            throw new SecurityException("Verified active media consent is required before external processing");
        }
        if (governance.consentId().isBlank()
                || !governance.consentId().equals(consent.consentId())) {
            throw new SecurityException("Verified media consent does not match the requested consent identity");
        }
        if (biometricRequested(context.request().parameters())
                && (!governance.biometricProcessingAllowed() || !consent.biometricProcessingAllowed())) {
            throw new SecurityException("Biometric media processing is not permitted by verified consent");
        }
    }

    private static boolean biometricRequested(Map<String, Object> parameters) {
        for (String key : BIOMETRIC_PARAMETER_KEYS) {
            Object value = parameters.get(key);
            if (Boolean.TRUE.equals(value)) return true;
            if (value instanceof String text && "true".equalsIgnoreCase(text.trim())) return true;
        }
        return false;
    }

    private static Throwable unwrap(Throwable failure) {
        Throwable current = failure;
        while ((current instanceof java.util.concurrent.CompletionException
                || current instanceof java.util.concurrent.ExecutionException)
                && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    private static String requestKey(String tenantId, String requestId) {
        return required(tenantId, "tenantId") + '\u0000' + required(requestId, "requestId");
    }

    private static Set<JobType> jobTypes(String value) {
        Set<JobType> result = new LinkedHashSet<>();
        for (String item : value.split(",")) if (!item.isBlank()) {
            result.add(JobType.valueOf(item.trim().toUpperCase(java.util.Locale.ROOT)));
        }
        return Set.copyOf(result);
    }

    private static String required(String value, String field) {
        if (value == null || value.isBlank() || value.length() > 255) {
            throw new IllegalArgumentException(field + " must be bounded and non-blank");
        }
        return value.trim();
    }
}
