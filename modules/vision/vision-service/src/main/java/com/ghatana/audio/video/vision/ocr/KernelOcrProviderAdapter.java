package com.ghatana.audio.video.vision.ocr;

import com.ghatana.kernel.product.api.ProductExecutionContext;
import com.ghatana.kernel.product.api.capability.CapabilitySupportDescriptor;
import com.ghatana.kernel.product.api.capability.CapabilityVersion;
import com.ghatana.kernel.product.api.capability.ProductRuntimeCapabilityOperations;
import com.ghatana.kernel.product.api.capability.ProductRuntimeFacets;
import com.ghatana.kernel.product.api.runtime.ProductRuntimeHealth;
import com.ghatana.kernel.product.api.runtime.ProductRuntimeProvider;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executor;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Legacy Kernel Product API adapter retained for OCR compatibility only.
 *
 * <p>Generic OCR execution, model selection and qualification belong to
 * Document Intelligence. This compatibility adapter is unavailable until an
 * admitted public client is wired; it is not canonical Media OCR ownership.
 * Every request fails closed before payload or object-reference handling, so
 * this adapter never reads storage or emits OCR text.</p>
 *
 * @doc.type class
 * @doc.purpose Legacy compatibility mapping; not an admitted Media-owned OCR execution service
 * @doc.layer adapter
 * @doc.pattern Adapter
 */
public final class KernelOcrProviderAdapter
        implements ProductRuntimeFacets.OcrProvider, ProductRuntimeProvider {

    private static final String CAPABILITY = "media.ocr";
    private static final String PROVIDER_RECEIPT_PREFIX = "media.ocr.provider";

    private final String providerId;
    private final Clock clock;
    private final AtomicBoolean started = new AtomicBoolean();
    private final AtomicBoolean closed = new AtomicBoolean();

    /** Preserves the legacy constructor shape while OCR remains unavailable. */
    public KernelOcrProviderAdapter(
            OcrService service,
            String providerId,
            String modelRef,
            String modelVersion) {
        this(service, providerId, modelRef, modelVersion, Clock.systemUTC(), ForkJoinPool.commonPool());
    }

    /** Constructor with injectable clock/executor for deterministic compatibility tests. */
    public KernelOcrProviderAdapter(
            OcrService service,
            String providerId,
            String modelRef,
            String modelVersion,
            Clock clock,
            Executor executor) {
        // Keep the legacy constructor shape for source compatibility, but do
        // not retain or invoke the generic model while Document Intelligence
        // admission is absent.
        Objects.requireNonNull(service, "service must not be null");
        this.providerId = ProductRuntimeProvider.requireProviderId(providerId);
        required(modelRef, "modelRef");
        required(modelVersion, "modelVersion");
        this.clock = Objects.requireNonNull(clock, "clock must not be null");
        Objects.requireNonNull(executor, "executor must not be null");
    }

    @Override
    public CompletionStage<ProductRuntimeFacets.OcrResult> extract(
            ProductExecutionContext context,
            ProductRuntimeFacets.OcrRequest request) {
        Objects.requireNonNull(context, "context must not be null");
        Objects.requireNonNull(request, "request must not be null");
        if (closed.get()) {
            return completed(failure(request.operationId(), "PROVIDER_CLOSED", context));
        }
        if (!started.get()) {
            return completed(failure(request.operationId(), "PROVIDER_NOT_STARTED", context));
        }
        // No admitted public Document Intelligence adapter is wired in this
        // module. Fail before operation registration, executor dispatch, or
        // payload handling; a legacy Media model must never emit OCR text.
        return completed(failure(request.operationId(), "NOT_ADMITTED", context));
    }

    @Override
    public String providerId() {
        return providerId;
    }

    @Override
    public java.util.Set<String> capabilities() {
        return java.util.Set.of(CAPABILITY);
    }

    @Override
    public List<CapabilitySupportDescriptor> capabilitySupport() {
        return List.of(new CapabilitySupportDescriptor(
                CAPABILITY,
                providerId,
                java.util.Set.of(),
                false,
                CapabilityVersion.of("1.0.0")));
    }

    @Override
    public void start() {
        if (closed.get()) throw new IllegalStateException("OCR provider is already closed");
        started.set(true);
    }

    @Override
    public ProductRuntimeHealth health() {
        return new ProductRuntimeHealth(
                closed.get()
                        ? ProductRuntimeHealth.Status.STOPPED
                        : ProductRuntimeHealth.Status.DEGRADED,
                closed.get()
                        ? "provider-closed"
                        : "NOT_ADMITTED",
                java.util.Set.of(CAPABILITY));
    }

    @Override
    public CompletionStage<ProductRuntimeFacets.OcrResult> cancel(
            ProductExecutionContext context,
            String operationId,
            String idempotencyKey) {
        Objects.requireNonNull(context, "context must not be null");
        required(operationId, "operationId");
        required(idempotencyKey, "idempotencyKey");
        return completed(failure(operationId, "NOT_ADMITTED", context));
    }

    @Override
    public CompletionStage<ProductRuntimeFacets.OcrResult> status(
            ProductExecutionContext context,
            String operationId) {
        Objects.requireNonNull(context, "context must not be null");
        required(operationId, "operationId");
        return completed(failure(operationId, "NOT_ADMITTED", context));
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) {
            started.set(false);
        }
    }

    private ProductRuntimeFacets.OcrResult failure(
            String operationId,
            String failureCode,
            ProductExecutionContext context) {
        String normalized = required(failureCode, "failureCode");
        Instant observedAt = clock.instant();
        return new ProductRuntimeFacets.OcrResult(
                operationId,
                normalized.equals("CANCELLED")
                        ? ProductRuntimeFacets.TerminalStatus.CANCELLED
                        : ProductRuntimeFacets.TerminalStatus.FAILED,
                List.of(),
                // Kernel's current OcrResult contract requires non-empty fullText
                // even on failure; failureCode/status remain the authoritative outcome.
                normalized,
                Optional.empty(),
                Optional.empty(),
                digest(normalized),
                receiptRef(operationId),
                Optional.of(normalized),
                observedAt);
    }

    private String receiptRef(String operationId) {
        return PROVIDER_RECEIPT_PREFIX + ":" + providerId + ":" + operationId;
    }

    private static <T> CompletionStage<T> completed(T value) {
        return CompletableFuture.completedFuture(value);
    }

    private static String digest(String... values) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String value : values) {
                digest.update(value.getBytes(StandardCharsets.UTF_8));
                digest.update((byte) 0);
            }
            return "sha256:" + HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new AssertionError("JVM must provide SHA-256", impossible);
        }
    }

    private static String required(String value, String name) {
        Objects.requireNonNull(value, name + " must not be null");
        String normalized = value.trim();
        if (normalized.isBlank()) throw new IllegalArgumentException(name + " must not be blank");
        return normalized;
    }

}
