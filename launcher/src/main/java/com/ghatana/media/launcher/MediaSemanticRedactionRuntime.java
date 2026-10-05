package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaJobResultSanitizer;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaSemanticRedactionProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ConsentDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ResultClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.SemanticRedactionRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.SemanticRedactionResult;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Fail-closed semantic transcript promotion authority.
 *
 * <p>Sensitive transcript-bearing provider output remains in the sensitive tier by default. A
 * caller may request {@code promotionTier=DEIDENTIFIED}; that request is only honored when one
 * ready semantic-redaction provider returns an identity-matching, provenance-bearing,
 * DEIDENTIFIED result explicitly marked safe for promotion. Structural sanitizers are not treated
 * as semantic de-identification evidence.
 */
final class MediaSemanticRedactionRuntime implements AutoCloseable {
    private static final String PROMOTION_TIER = "promotionTier";
    private static final String DEIDENTIFIED = "DEIDENTIFIED";

    private final MediaSemanticRedactionProvider provider;
    private final Duration timeout;

    private MediaSemanticRedactionRuntime(MediaSemanticRedactionProvider provider, Duration timeout) {
        this.provider = provider;
        this.timeout = java.util.Objects.requireNonNull(timeout, "timeout");
        if (timeout.isZero() || timeout.isNegative()) {
            throw new IllegalArgumentException("semantic redaction timeout must be positive");
        }
    }

    static MediaSemanticRedactionRuntime disabled(Duration timeout) {
        return new MediaSemanticRedactionRuntime(null, timeout);
    }

    static MediaSemanticRedactionRuntime forTesting(
            MediaSemanticRedactionProvider provider,
            Duration timeout) {
        return new MediaSemanticRedactionRuntime(
                java.util.Objects.requireNonNull(provider, "provider"), timeout);
    }

    static MediaSemanticRedactionRuntime compose(
            Map<String, String> environment,
            boolean productionLike,
            Duration timeout) {
        java.util.Objects.requireNonNull(environment, "environment");
        List<MediaSemanticRedactionProvider> discovered = new ArrayList<>();
        for (MediaSemanticRedactionProvider candidate : ServiceLoader.load(MediaSemanticRedactionProvider.class)) {
            discovered.add(candidate);
        }
        discovered.sort(Comparator.comparing(MediaSemanticRedactionProvider::providerId));
        String configured = environment.getOrDefault("MEDIA_SEMANTIC_REDACTION_PROVIDER_ID", "").trim();
        List<MediaSemanticRedactionProvider> ready = discovered.stream()
                .filter(MediaSemanticRedactionProvider::ready)
                .filter(candidate -> configured.isBlank()
                        || candidate.providerId().equalsIgnoreCase(configured))
                .toList();
        if (ready.size() > 1) {
            closeAll(discovered);
            throw new IllegalStateException(
                    "Expected at most one ready Media semantic redaction provider, found " + ready.size());
        }
        MediaSemanticRedactionProvider selected = ready.isEmpty() ? null : ready.getFirst();
        for (MediaSemanticRedactionProvider candidate : discovered) {
            if (candidate != selected) safeClose(candidate);
        }
        if (productionLike && selected != null && !selected.productionEligible()) {
            safeClose(selected);
            throw new IllegalStateException("Configured Media semantic redaction provider is not production eligible");
        }
        return new MediaSemanticRedactionRuntime(selected, timeout);
    }

    boolean available() {
        return provider != null && provider.ready();
    }

    String providerId() {
        return provider == null ? "not-configured" : provider.providerId();
    }

    Map<String, Object> promoteIfRequested(ProcessingJobRequest request, Map<String, Object> providerResult) {
        return promoteIfRequested(request, providerResult, ConsentDecision.unverified());
    }

    Map<String, Object> promoteIfRequested(
            ProcessingJobRequest request,
            Map<String, Object> providerResult,
            ConsentDecision consent) {
        Map<String, Object> sensitive = MediaJobResultSanitizer.sanitize(providerResult);
        if (!promotionRequested(request)) return sensitive;
        if (provider == null || !provider.ready()) {
            throw new IllegalStateException(
                    "DEIDENTIFIED promotion requires a ready Media semantic redaction provider");
        }
        String transcriptKey = transcriptKey(sensitive);
        if (transcriptKey == null) {
            throw new IllegalStateException("DEIDENTIFIED promotion requires transcript-bearing provider output");
        }
        String transcript = String.valueOf(sensitive.get(transcriptKey));
        requireExternalGovernance(request, consent);
        SemanticRedactionRequest redactionRequest = new SemanticRedactionRequest(
                request.tenantId(), request.principalId(), request.correlationId(), transcript,
                String.valueOf(request.parameters().getOrDefault("language", "")),
                request.governanceContext());
        CompletableFuture<SemanticRedactionResult> invocation = provider.redact(redactionRequest);
        if (invocation == null) throw new IllegalStateException("Semantic redaction provider returned null future");
        SemanticRedactionResult redacted;
        try {
            redacted = invocation.copy().orTimeout(timeout.toMillis(), TimeUnit.MILLISECONDS).join();
        } catch (RuntimeException failure) {
            invocation.cancel(true);
            Throwable cause = failure instanceof java.util.concurrent.CompletionException
                    && failure.getCause() != null ? failure.getCause() : failure;
            throw new IllegalStateException("Semantic transcript redaction failed", cause);
        }
        if (redacted == null) throw new IllegalStateException("Semantic redaction provider returned null result");
        if (!provider.providerId().equals(redacted.providerId())) {
            throw new IllegalStateException("Semantic redaction provider returned mismatched provider identity");
        }
        if (!redacted.safeForPromotion() || redacted.classification() != ResultClassification.DEIDENTIFIED) {
            throw new SecurityException("Semantic redaction did not authorize DEIDENTIFIED promotion");
        }
        Map<String, Object> result = new LinkedHashMap<>(sensitive);
        result.put(transcriptKey, redacted.redactedText());
        result.put("resultClassification", ResultClassification.DEIDENTIFIED.name());
        result.put("redaction", Map.of(
                "providerId", redacted.providerId(),
                "policyVersion", redacted.policyVersion(),
                "categories", redacted.redactionCategories(),
                "evaluatedAt", redacted.evaluatedAt().toString(),
                "sourceClassification", request.governanceContext().classification().name(),
                "provenance", MediaJobResultSanitizer.sanitize(redacted.provenance())));
        return Map.copyOf(result);
    }

    private void requireExternalGovernance(
            ProcessingJobRequest request, ConsentDecision consent) {
        if (provider.processingBoundary() != ProcessingBoundary.EXTERNAL) return;
        var governance = request.governanceContext();
        if (!governance.externalProcessingAllowed()) {
            throw new SecurityException(
                    "Semantic transcript redaction cannot use an external provider for this request");
        }
        if (consent == null || !consent.activeAt(java.time.Instant.now())
                || !consent.externalProcessingAllowed()) {
            throw new SecurityException(
                    "Active verified consent is required for external semantic redaction");
        }
        if (!consent.consentId().equals(governance.consentId())
                || !consent.permitsPurpose(governance.purpose())) {
            throw new SecurityException(
                    "Verified consent does not authorize external semantic redaction purpose");
        }
        if (!governance.permitsRegion(provider.processingRegion())
                || !consent.permitsRegion(provider.processingRegion())) {
            throw new SecurityException(
                    "External semantic redaction region is not permitted");
        }
        if (!governance.providerRetentionAllowed()
                && provider.providerDataRetention() != ProviderDataRetention.NONE) {
            throw new SecurityException(
                    "External semantic redaction provider retention posture is not permitted");
        }
    }

    static boolean promotionRequested(ProcessingJobRequest request) {
        Object value = request.parameters().get(PROMOTION_TIER);
        return value != null && DEIDENTIFIED.equalsIgnoreCase(String.valueOf(value).trim());
    }

    private static String transcriptKey(Map<String, Object> result) {
        for (String key : List.of("transcript", "text", "transcription")) {
            Object value = result.get(key);
            if (value instanceof String text && !text.isBlank()) return key;
        }
        return null;
    }

    @Override
    public void close() {
        if (provider != null) provider.close();
    }

    private static void closeAll(List<MediaSemanticRedactionProvider> providers) {
        providers.forEach(MediaSemanticRedactionRuntime::safeClose);
    }

    private static void safeClose(MediaSemanticRedactionProvider provider) {
        try { provider.close(); }
        catch (RuntimeException ignored) { }
    }
}
