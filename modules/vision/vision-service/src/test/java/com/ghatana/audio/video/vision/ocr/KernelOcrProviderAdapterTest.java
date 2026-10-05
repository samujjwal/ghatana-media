package com.ghatana.audio.video.vision.ocr;

import com.ghatana.kernel.product.api.ProductAuthenticationAssurance;
import com.ghatana.kernel.product.api.ProductCorrelationId;
import com.ghatana.kernel.product.api.ProductExecutionContext;
import com.ghatana.kernel.product.api.ProductPrincipal;
import com.ghatana.kernel.product.api.ProductTenantScope;
import com.ghatana.kernel.product.api.capability.CapabilityBinding;
import com.ghatana.kernel.product.api.capability.CapabilityRegistry;
import com.ghatana.kernel.product.api.capability.CapabilityRequirement;
import com.ghatana.kernel.product.api.capability.CapabilityVersion;
import com.ghatana.kernel.product.api.capability.ProductRuntimeCapabilityOperations;
import com.ghatana.kernel.product.api.capability.ProductRuntimeFacets;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class KernelOcrProviderAdapterTest {

    private static final Instant NOW = Instant.parse("2026-09-11T00:00:00Z");
    private static final Clock CLOCK = Clock.fixed(NOW, ZoneOffset.UTC);
    private static final Executor DIRECT = Runnable::run;
    private static final OcrService.BoundingBox BOX = new OcrService.BoundingBox(0.1, 0.2, 0.5, 0.25);
    private static final ProductExecutionContext CONTEXT = new ProductExecutionContext(
            "media",
            ProductTenantScope.tenant("tenant-a"),
            new ProductPrincipal(
                    "principal-a", "session-a", java.util.Set.of("operator"),
                    java.util.Set.of("media.ocr"), ProductAuthenticationAssurance.STANDARD,
                    "test", NOW),
            ProductCorrelationId.of("corr-a"),
            null,
            "test");

    @Test
    void mapsModelOutputToKernelContractWithProvenanceAndDigest() {
        KernelOcrProviderAdapter adapter = adapter(image -> List.of(
                new OcrService.TextRegion("patient", BOX, 0.96, 0)));
        ProductRuntimeFacets.OcrRequest request = request("ocr-1", "sha256:payload-1", new byte[]{1, 2, 3});

        ProductRuntimeFacets.OcrResult result = adapter.extract(CONTEXT, request).toCompletableFuture().join();

        assertThat(result.status()).isEqualTo(ProductRuntimeFacets.TerminalStatus.SUCCEEDED);
        assertThat(result.fullText()).isEqualTo("patient");
        assertThat(result.regions()).hasSize(1);
        assertThat(result.modelRef()).contains("media-test-model");
        assertThat(result.modelVersion()).contains("2026.09");
        assertThat(result.resultDigest()).startsWith("sha256:");
        assertThat(result.providerReceiptRef()).isEqualTo("media.ocr.provider:media-test:ocr-1");
        assertThat(adapter.providerId()).isEqualTo("media-test");
        assertThat(adapter.capabilities()).containsExactly("media.ocr");
        assertThat(adapter.capabilitySupport()).singleElement()
                .satisfies(descriptor -> assertThat(descriptor.healthy()).isTrue());
        assertThat(adapter.health().ready()).isTrue();
    }

    @Test
    void providerLifecycleIsFailClosedBeforeStartAndStoppedAfterClose() {
        KernelOcrProviderAdapter adapter = new KernelOcrProviderAdapter(
                OcrService.of(image -> List.of(), 0.70),
                "media-test",
                "media-test-model",
                "2026.09",
                CLOCK,
                DIRECT);

        assertThat(adapter.health().status())
                .isEqualTo(com.ghatana.kernel.product.api.runtime.ProductRuntimeHealth.Status.STARTING);
        assertThat(adapter.capabilitySupport()).singleElement()
                .satisfies(descriptor -> assertThat(descriptor.healthy()).isFalse());
        assertThat(adapter.extract(CONTEXT, request("ocr-before-start", "sha256:payload-0", new byte[]{0}))
                .toCompletableFuture().join().failureCode()).contains("PROVIDER_NOT_STARTED");

        adapter.start();
        assertThat(adapter.health().ready()).isTrue();
        adapter.close();
        assertThat(adapter.health().status())
                .isEqualTo(com.ghatana.kernel.product.api.runtime.ProductRuntimeHealth.Status.STOPPED);
    }

    @Test
    void rejectsNonCanonicalProviderIdentity() {
        assertThatThrownBy(() -> new KernelOcrProviderAdapter(
                OcrService.of(image -> List.of(), 0.70),
                "Media Test",
                "media-test-model",
                "2026.09",
                CLOCK,
                DIRECT))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void startedAdapterIsAdmittedThroughKernelPublicCapabilityRegistry() {
        KernelOcrProviderAdapter adapter = adapter(image -> List.of());
        CapabilityRequirement requirement = new CapabilityRequirement(
                "media.ocr", ProductRuntimeCapabilityOperations.MEDIA_OCR, "1.0.0");

        CapabilityBinding providerBinding = new CapabilityBinding(
                "media.ocr",
                adapter.providerId(),
                CapabilityVersion.of("1.0.0"),
                adapter,
                java.util.Set.of(ProductRuntimeCapabilityOperations.MEDIA_OCR));
        CapabilityRegistry capabilities = CapabilityRegistry.of(java.util.Set.of(providerBinding));

        assertThat(capabilities.resolve(requirement))
                .get()
                .extracting(resolvedBinding -> resolvedBinding.provider())
                .isSameAs(adapter);
    }

    @Test
    void enforcesRequestTimeoutWhenModelExecutionDoesNotStart() throws Exception {
        List<Runnable> queued = new ArrayList<>();
        KernelOcrProviderAdapter adapter = adapter(image -> List.of(), queued::add);
        ProductRuntimeFacets.OcrRequest request = request(
                "ocr-timeout", "sha256:payload-timeout", new byte[]{9}, Optional.empty(),
                java.time.Duration.ofMillis(25));

        ProductRuntimeFacets.OcrResult result = adapter.extract(CONTEXT, request)
                .toCompletableFuture().get(1, TimeUnit.SECONDS);

        assertThat(result.failureCode()).contains("OCR_TIMEOUT");
        assertThat(result.status()).isEqualTo(ProductRuntimeFacets.TerminalStatus.FAILED);
        assertThat(queued).hasSize(1);
    }

    @Test
    void rejectsPayloadReferenceWithoutResolvedBytesAndKeepsOperationStatus() {
        KernelOcrProviderAdapter adapter = adapter(image -> List.of());
        ProductRuntimeFacets.OcrRequest request = request(
                "ocr-2", "sha256:payload-2", new byte[0], Optional.of("object://image-2"));

        ProductRuntimeFacets.OcrResult result = adapter.extract(CONTEXT, request).toCompletableFuture().join();
        ProductRuntimeFacets.OcrResult status = adapter.status(CONTEXT, "ocr-2").toCompletableFuture().join();

        assertThat(result.status()).isEqualTo(ProductRuntimeFacets.TerminalStatus.FAILED);
        assertThat(result.failureCode()).contains("IMAGE_PAYLOAD_UNAVAILABLE");
        assertThat(status).isEqualTo(result);
    }

    @Test
    void rejectsCrossTenantStatusAndIdempotencyPayloadReuse() {
        KernelOcrProviderAdapter adapter = adapter(image -> List.of());
        ProductRuntimeFacets.OcrRequest first = request("ocr-3", "sha256:payload-3", new byte[]{3});
        adapter.extract(CONTEXT, first).toCompletableFuture().join();

        ProductRuntimeFacets.OcrResult mismatch = adapter.extract(
                CONTEXT,
                request("ocr-3", "sha256:payload-other", new byte[]{4}))
                .toCompletableFuture().join();
        ProductRuntimeFacets.OcrResult crossTenant = adapter.status(
                context("tenant-b"), "ocr-3").toCompletableFuture().join();

        assertThat(mismatch.failureCode()).contains("IDEMPOTENCY_PAYLOAD_MISMATCH");
        assertThat(crossTenant.failureCode()).contains("TENANT_SCOPE_MISMATCH");
    }

    @Test
    void cancellationProducesTerminalCancelledResult() {
        List<Runnable> queued = new ArrayList<>();
        KernelOcrProviderAdapter adapter = adapter(image -> List.of(), queued::add);
        ProductRuntimeFacets.OcrRequest request = request("ocr-4", "sha256:payload-4", new byte[]{4});
        adapter.extract(CONTEXT, request);

        ProductRuntimeFacets.OcrResult cancelled = adapter.cancel(CONTEXT, "ocr-4", "idem-ocr-4")
                .toCompletableFuture().join();

        assertThat(cancelled.status()).isEqualTo(ProductRuntimeFacets.TerminalStatus.CANCELLED);
        assertThat(cancelled.failureCode()).contains("CANCELLED");
        queued.forEach(Runnable::run);
    }

    private static KernelOcrProviderAdapter adapter(OcrService.OcrModel model) {
        return adapter(model, DIRECT);
    }

    private static KernelOcrProviderAdapter adapter(OcrService.OcrModel model, Executor executor) {
        KernelOcrProviderAdapter adapter = new KernelOcrProviderAdapter(
                OcrService.of(model, 0.70),
                "media-test",
                "media-test-model",
                "2026.09",
                CLOCK,
                executor);
        adapter.start();
        return adapter;
    }

    private static ProductRuntimeFacets.OcrRequest request(String id, String digest, byte[] image) {
        return request(id, digest, image, Optional.empty());
    }

    private static ProductRuntimeFacets.OcrRequest request(
            String id, String digest, byte[] image, Optional<String> payloadRef) {
        return request(id, digest, image, payloadRef, java.time.Duration.ofSeconds(5));
    }

    private static ProductRuntimeFacets.OcrRequest request(
            String id,
            String digest,
            byte[] image,
            Optional<String> payloadRef,
            java.time.Duration timeout) {
        return new ProductRuntimeFacets.OcrRequest(
                id,
                "idem-" + id,
                new ProductRuntimeFacets.SchemaPayload(
                        "media.image", "image/png", digest, image, payloadRef),
                Optional.of("en"), 1, 100, timeout, "media.governed-ocr");
    }

    private static ProductExecutionContext context(String tenant) {
        return new ProductExecutionContext(
                "media",
                ProductTenantScope.tenant(tenant),
                CONTEXT.principal(),
                ProductCorrelationId.of("corr-" + tenant),
                null,
                "test");
    }
}
