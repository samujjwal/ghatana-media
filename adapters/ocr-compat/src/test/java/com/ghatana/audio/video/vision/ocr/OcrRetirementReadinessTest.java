package com.ghatana.audio.video.vision.ocr;

import com.ghatana.kernel.product.api.ProductAuthenticationAssurance;
import com.ghatana.kernel.product.api.ProductCorrelationId;
import com.ghatana.kernel.product.api.ProductExecutionContext;
import com.ghatana.kernel.product.api.ProductPrincipal;
import com.ghatana.kernel.product.api.ProductTenantScope;
import com.ghatana.kernel.product.api.capability.ProductRuntimeCapabilityOperations;
import com.ghatana.kernel.product.api.capability.ProductRuntimeFacets;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.Executor;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * OC-04: retirement is gated on exact Document Intelligence owner adoption
 * plus consumer-migration proof — neither exists. Until then the compat
 * shim must keep the legacy consumer shape alive and never claim OCR.
 */
class OcrRetirementReadinessTest {

    private static final ProductExecutionContext CONTEXT = new ProductExecutionContext(
            "media",
            ProductTenantScope.tenant("tenant-a"),
            new ProductPrincipal(
                    "principal-a", "session-a", java.util.Set.of("operator"),
                    java.util.Set.of("media.ocr"), ProductAuthenticationAssurance.STANDARD,
                    "test", Instant.parse("2026-10-30T00:00:00Z")),
            ProductCorrelationId.of("corr-a"),
            null,
            "test");

    private static KernelOcrProviderAdapter adapter() {
        KernelOcrProviderAdapter adapter = new KernelOcrProviderAdapter(
                OcrService.of(image -> List.of(), 0.70),
                "media-test",
                "media-test-model",
                "2026.09",
                Clock.fixed(Instant.parse("2026-10-30T00:00:00Z"), ZoneOffset.UTC),
                (Executor) Runnable::run);
        adapter.start();
        return adapter;
    }

    private static ProductRuntimeFacets.OcrRequest request(String id) {
        return new ProductRuntimeFacets.OcrRequest(
                id,
                "idem-" + id,
                new ProductRuntimeFacets.SchemaPayload(
                        "media.image", "image/png", "sha256:x", new byte[]{1}, Optional.empty()),
                Optional.of("en"), 1, 100, Duration.ofSeconds(5), "media.governed-ocr");
    }

    @Test
    void legacyConsumerShapeIsPreservedWhileRetirementIsPending() {
        KernelOcrProviderAdapter adapter = adapter();
        // The legacy SPI surface still resolves — no premature consumer break.
        assertThat(adapter).isInstanceOf(ProductRuntimeFacets.OcrProvider.class);
        assertThat(adapter.capabilities()).containsExactly("media.ocr");
        assertThat(adapter.capabilitySupport()).singleElement().satisfies(descriptor -> {
            assertThat(descriptor.healthy()).isFalse(); // declared, never claimed
            assertThat(descriptor.supports(ProductRuntimeCapabilityOperations.MEDIA_OCR))
                    .isFalse();
        });
    }

    @Test
    void noOperationEverReturnsSuccessfulOcrText() {
        KernelOcrProviderAdapter adapter = adapter();
        for (ProductRuntimeFacets.OcrResult result : List.of(
                adapter.extract(CONTEXT, request("op-1")).toCompletableFuture().join(),
                adapter.status(CONTEXT, "op-1").toCompletableFuture().join(),
                adapter.cancel(CONTEXT, "op-1", "idem-1").toCompletableFuture().join())) {
            assertThat(result.status()).isIn(
                    ProductRuntimeFacets.TerminalStatus.FAILED,
                    ProductRuntimeFacets.TerminalStatus.CANCELLED);
            // Even the failure text carries a bounded code, never OCR output.
            assertThat(result.fullText()).isIn(
                    "NOT_ADMITTED", "PROVIDER_CLOSED", "PROVIDER_NOT_STARTED", "CANCELLED");
        }
    }
}
