package com.ghatana.audio.video.vision.ocr;

import com.ghatana.kernel.product.api.ProductExecutionContext;
import com.ghatana.kernel.product.api.capability.CapabilityOperation;
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
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.Executor;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Kernel Product API adapter for the Media-owned OCR service.
 *
 * <p>The adapter owns only the transport-neutral mapping and operation lifecycle. The OCR model,
 * model identity, confidence policy, and image decoding remain Media-owned. A payload reference
 * without inline bytes is rejected because resolving objects belongs to the Kernel object-storage
 * provider; this adapter never guesses or reads a product-local object store.</p>
 *
 * @doc.type class
 * @doc.purpose Map Media OCR execution to the public Kernel OcrProvider contract
 * @doc.layer adapter
 * @doc.pattern Adapter
 */
public final class KernelOcrProviderAdapter
        implements ProductRuntimeFacets.OcrProvider, ProductRuntimeProvider {

    private static final String CAPABILITY = "media.ocr";
    private static final String PROVIDER_RECEIPT_PREFIX = "media.ocr.provider";

    private final OcrService service;
    private final String providerId;
    private final String modelRef;
    private final String modelVersion;
    private final Clock clock;
    private final Executor executor;
    private final ConcurrentMap<String, Operation> operations = new ConcurrentHashMap<>();
    private final AtomicBoolean started = new AtomicBoolean();
    private final AtomicBoolean closed = new AtomicBoolean();

    /** Uses the common work-stealing executor for model execution. */
    public KernelOcrProviderAdapter(
            OcrService service,
            String providerId,
            String modelRef,
            String modelVersion) {
        this(service, providerId, modelRef, modelVersion, Clock.systemUTC(), ForkJoinPool.commonPool());
    }

    /** Constructor with injectable clock and executor for deterministic conformance tests. */
    public KernelOcrProviderAdapter(
            OcrService service,
            String providerId,
            String modelRef,
            String modelVersion,
            Clock clock,
            Executor executor) {
        this.service = Objects.requireNonNull(service, "service must not be null");
        this.providerId = ProductRuntimeProvider.requireProviderId(providerId);
        this.modelRef = required(modelRef, "modelRef");
        this.modelVersion = required(modelVersion, "modelVersion");
        this.clock = Objects.requireNonNull(clock, "clock must not be null");
        this.executor = Objects.requireNonNull(executor, "executor must not be null");
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
        if (request.image().content().length == 0) {
            Operation unavailable = new Operation(
                    context, request.idempotencyKey(), request.image().payloadDigest());
            Operation existing = operations.putIfAbsent(request.operationId(), unavailable);
            if (existing != null) return existing.result;
            unavailable.result.complete(failure(request.operationId(), "IMAGE_PAYLOAD_UNAVAILABLE", context));
            return unavailable.result;
        }

        Operation candidate = new Operation(
                context, request.idempotencyKey(), request.image().payloadDigest());
        Operation existing = operations.putIfAbsent(request.operationId(), candidate);
        if (existing != null) {
            if (!existing.tenantId.equals(context.tenantId())) {
                return completed(failure(request.operationId(), "TENANT_SCOPE_MISMATCH", context));
            }
            if (!existing.idempotencyKey.equals(request.idempotencyKey())) {
                return completed(failure(request.operationId(), "IDEMPOTENCY_KEY_MISMATCH", context));
            }
            if (!existing.payloadDigest.equals(request.image().payloadDigest())) {
                return completed(failure(request.operationId(), "IDEMPOTENCY_PAYLOAD_MISMATCH", context));
            }
            return existing.result;
        }

        byte[] image = request.image().content();
        CompletableFuture.runAsync(() -> execute(context, request, image, candidate), executor)
                .orTimeout(request.timeout().toMillis(), TimeUnit.MILLISECONDS)
                .whenComplete((ignored, failure) -> {
                    if (failure == null || candidate.result.isDone()) return;
                    candidate.cancelled.set(true);
                    candidate.result.complete(failure(
                            request.operationId(),
                            unwrap(failure) instanceof TimeoutException ? "OCR_TIMEOUT" : "OCR_EXECUTION_FAILED",
                            context));
                });
        return candidate.result;
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
        CapabilityOperation operation = ProductRuntimeCapabilityOperations.MEDIA_OCR;
        return List.of(new CapabilitySupportDescriptor(
                CAPABILITY,
                providerId,
                java.util.Set.of(operation),
                started.get() && !closed.get(),
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
                        : started.get() ? ProductRuntimeHealth.Status.READY : ProductRuntimeHealth.Status.STARTING,
                closed.get()
                        ? "provider-closed"
                        : started.get() ? "model-backed-ocr-ready" : "provider-not-started",
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
        Operation operation = operations.get(operationId);
        if (operation == null) {
            return completed(failure(operationId, "OPERATION_NOT_FOUND", context));
        }
        if (!operation.tenantId.equals(context.tenantId())) {
            return completed(failure(operationId, "TENANT_SCOPE_MISMATCH", context));
        }
        if (!operation.idempotencyKey.equals(idempotencyKey)) {
            return completed(failure(operationId, "IDEMPOTENCY_KEY_MISMATCH", context));
        }
        operation.cancelled.set(true);
        operation.result.complete(failure(operationId, "CANCELLED", context));
        return operation.result;
    }

    @Override
    public CompletionStage<ProductRuntimeFacets.OcrResult> status(
            ProductExecutionContext context,
            String operationId) {
        Objects.requireNonNull(context, "context must not be null");
        required(operationId, "operationId");
        Operation operation = operations.get(operationId);
        if (operation == null) {
            return completed(failure(operationId, "OPERATION_NOT_FOUND", context));
        }
        if (!operation.tenantId.equals(context.tenantId())) {
            return completed(failure(operationId, "TENANT_SCOPE_MISMATCH", context));
        }
        return operation.result;
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) {
            started.set(false);
            operations.forEach((operationId, operation) -> {
                operation.cancelled.set(true);
                operation.result.complete(failure(operationId, "PROVIDER_CLOSED", operation.context));
            });
        }
    }

    private void execute(
            ProductExecutionContext context,
            ProductRuntimeFacets.OcrRequest request,
            byte[] image,
            Operation operation) {
        if (operation.cancelled.get() || closed.get()) {
            operation.result.complete(failure(request.operationId(), "CANCELLED", context));
            return;
        }
        try {
            List<OcrService.TextRegion> extracted = service.extract(image);
            if (operation.cancelled.get() || closed.get()) {
                operation.result.complete(failure(request.operationId(), "CANCELLED", context));
                return;
            }
            List<ProductRuntimeFacets.OcrTextRegion> regions = extracted.stream()
                    .sorted(java.util.Comparator.comparingInt(OcrService.TextRegion::readingOrder))
                    .map(region -> new ProductRuntimeFacets.OcrTextRegion(
                            region.text(),
                            1,
                            region.boundingBox().x(),
                            region.boundingBox().y(),
                            region.boundingBox().width(),
                            region.boundingBox().height(),
                            region.confidence(),
                            region.readingOrder()))
                    .toList();
            if (regions.size() > request.maxRegions()) {
                throw new IllegalArgumentException("OCR result exceeds request maxRegions");
            }
            if (regions.isEmpty()) {
                operation.result.complete(failure(request.operationId(), "NO_TEXT_DETECTED", context));
                return;
            }
            String fullText = String.join("\n", regions.stream()
                    .map(ProductRuntimeFacets.OcrTextRegion::text)
                    .toList());
            String resultDigest = digest(fullText, regions);
            operation.result.complete(new ProductRuntimeFacets.OcrResult(
                    request.operationId(),
                    ProductRuntimeFacets.TerminalStatus.SUCCEEDED,
                    regions,
                    fullText,
                    Optional.of(modelRef),
                    Optional.of(modelVersion),
                    resultDigest,
                    receiptRef(request.operationId()),
                    Optional.empty(),
                    clock.instant()));
        } catch (RuntimeException failure) {
            operation.result.complete(failure(request.operationId(), classify(failure), context));
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
                normalized,
                Optional.empty(),
                Optional.empty(),
                digest(normalized),
                receiptRef(operationId),
                Optional.of(normalized),
                observedAt);
    }

    private String classify(RuntimeException failure) {
        if (failure instanceof IllegalArgumentException) return "INVALID_OCR_RESULT";
        return "OCR_EXECUTION_FAILED";
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

    private static String digest(
            String fullText,
            List<ProductRuntimeFacets.OcrTextRegion> regions) {
        StringBuilder canonical = new StringBuilder(fullText);
        for (ProductRuntimeFacets.OcrTextRegion region : regions) {
            canonical.append('|')
                    .append(region.pageNumber()).append('|')
                    .append(region.x()).append('|')
                    .append(region.y()).append('|')
                    .append(region.width()).append('|')
                    .append(region.height()).append('|')
                    .append(region.confidence()).append('|')
                    .append(region.readingOrder()).append('|')
                    .append(region.text());
        }
        return digest(canonical.toString());
    }

    private static String required(String value, String name) {
        Objects.requireNonNull(value, name + " must not be null");
        String normalized = value.trim();
        if (normalized.isBlank()) throw new IllegalArgumentException(name + " must not be blank");
        return normalized;
    }

    private static final class Operation {
        private final String tenantId;
        private final String idempotencyKey;
        private final String payloadDigest;
        private final ProductExecutionContext context;
        private final AtomicBoolean cancelled = new AtomicBoolean();
        private final CompletableFuture<ProductRuntimeFacets.OcrResult> result = new CompletableFuture<>();

        private Operation(ProductExecutionContext context, String idempotencyKey, String payloadDigest) {
            this.context = context;
            this.tenantId = context.tenantId();
            this.idempotencyKey = idempotencyKey;
            this.payloadDigest = payloadDigest;
        }
    }
}
