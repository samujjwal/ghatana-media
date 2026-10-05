package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaSemanticRedactionProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ResultClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.SemanticRedactionRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.SemanticRedactionResult;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaSemanticRedactionRuntimeTest {

    @Test
    void sensitiveTierDoesNotRequireSemanticProvider() {
        try (var runtime = MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(1))) {
            Map<String, Object> result = runtime.promoteIfRequested(
                    request(Map.of()),
                    Map.of("transcript", "Sam lives at 1 Main St", "token", "secret"));

            assertThat(result).containsEntry("transcript", "Sam lives at 1 Main St");
            assertThat(result).doesNotContainKey("token");
        }
    }

    @Test
    void deidentifiedPromotionFailsClosedWithoutProvider() {
        try (var runtime = MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(1))) {
            assertThatThrownBy(() -> runtime.promoteIfRequested(
                    request(Map.of("promotionTier", "DEIDENTIFIED")),
                    Map.of("transcript", "Sam lives at 1 Main St")))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("requires a ready Media semantic redaction provider");
        }
    }

    @Test
    void promotionRequiresProviderOwnedSafeDeidentifiedDecisionAndPersistsProvenance() {
        AtomicReference<SemanticRedactionRequest> observed = new AtomicReference<>();
        MediaSemanticRedactionProvider provider = provider(observed, new SemanticRedactionResult(
                "[REDACTED_NAME] lives at [REDACTED_ADDRESS]",
                ResultClassification.DEIDENTIFIED,
                true,
                "redactor-v1",
                "pii-policy-2026-08",
                Set.of("name", "address"),
                Instant.parse("2026-08-07T22:00:00Z"),
                Map.of("modelRevision", "ner-17", "apiKey", "must-not-persist")));

        try (var runtime = MediaSemanticRedactionRuntime.forTesting(provider, Duration.ofSeconds(1))) {
            Map<String, Object> result = runtime.promoteIfRequested(
                    request(Map.of("promotionTier", "DEIDENTIFIED", "language", "en")),
                    Map.of("transcript", "Sam lives at 1 Main St"));

            assertThat(observed.get().sourceText()).isEqualTo("Sam lives at 1 Main St");
            assertThat(result).containsEntry("transcript", "[REDACTED_NAME] lives at [REDACTED_ADDRESS]");
            assertThat(result).containsEntry("resultClassification", "DEIDENTIFIED");
            @SuppressWarnings("unchecked")
            Map<String, Object> redaction = (Map<String, Object>) result.get("redaction");
            assertThat(redaction).containsEntry("providerId", "redactor-v1")
                    .containsEntry("policyVersion", "pii-policy-2026-08");
            @SuppressWarnings("unchecked")
            Map<String, Object> provenance = (Map<String, Object>) redaction.get("provenance");
            assertThat(provenance).containsEntry("modelRevision", "ner-17").doesNotContainKey("apiKey");
        }
    }

    @Test
    void providerCannotSelfDeclareSensitiveOutputSafeForPromotion() {
        assertThatThrownBy(() -> new SemanticRedactionResult(
                "unchanged",
                ResultClassification.SENSITIVE,
                true,
                "redactor-v1",
                "policy-v1",
                Set.of(),
                Instant.now(),
                Map.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("safeForPromotion requires DEIDENTIFIED");
    }

    @Test
    void externalRedactorCannotOverrideRequestEgressPolicy() {
        MediaSemanticRedactionProvider external = new MediaSemanticRedactionProvider() {
            @Override public String providerId() { return "external-redactor"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return true; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
            @Override public CompletableFuture<SemanticRedactionResult> redact(SemanticRedactionRequest request) {
                return CompletableFuture.completedFuture(new SemanticRedactionResult(
                        "redacted", ResultClassification.DEIDENTIFIED, true, providerId(), "v1",
                        Set.of("name"), Instant.now(), Map.of()));
            }
        };
        try (var runtime = MediaSemanticRedactionRuntime.forTesting(external, Duration.ofSeconds(1))) {
            assertThatThrownBy(() -> runtime.promoteIfRequested(
                    request(Map.of("promotionTier", "DEIDENTIFIED")),
                    Map.of("transcript", "Sam")))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("cannot use an external provider");
        }
    }

    private static MediaSemanticRedactionProvider provider(
            AtomicReference<SemanticRedactionRequest> observed,
            SemanticRedactionResult result) {
        return new MediaSemanticRedactionProvider() {
            @Override public String providerId() { return "redactor-v1"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return true; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<SemanticRedactionResult> redact(SemanticRedactionRequest request) {
                observed.set(request);
                return CompletableFuture.completedFuture(result);
            }
        };
    }

    private static ProcessingJobRequest request(Map<String, Object> parameters) {
        return new ProcessingJobRequest(
                "request-a", "tenant-a", "principal-a", "correlation-a", "artifact-a",
                JobType.SPEECH_TO_TEXT, "", parameters,
                new MediaGovernanceContext(
                        "consent-a", "transcription", "us", Set.of("us"), false, false));
    }
}
