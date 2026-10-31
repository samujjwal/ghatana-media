package com.ghatana.audio.video.vision.scenetext;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Consumer-side view of the frozen {@code document-intelligence.v1} protocol
 * (Ghatana {@code services/document-intelligence/contracts/protocol-v1.md}).
 *
 * <p>Document Intelligence is the only OCR executor (MDI-001/PDP0-003-D4). These
 * types mirror the published wire shape only so a Java consumer can call it; they
 * are not a second OCR contract and must not grow fields DI does not publish.
 *
 * @doc.type interface
 * @doc.purpose DI v1 OCR client seam for Media Vision scene-text (VIS-09)
 * @doc.layer product
 * @doc.pattern Port
 */
public interface DocumentIntelligenceV1 {

    String PROTOCOL_VERSION = "document-intelligence.v1";
    String WORKER_CAPABILITY_VERSION = "document-intelligence-worker.v1";

    /** {@code GET /v1/providers}. */
    ProviderCatalog providers(Cancellation cancellation) throws DocumentIntelligenceException;

    /** {@code POST /v1/parse} with multipart {@code metadata} + opaque {@code file}. */
    ParsedDocument parse(ParseRequest request, Cancellation cancellation) throws DocumentIntelligenceException;

    /** {@code DELETE /v1/operations/{operationId}}; idempotent for the given generation. */
    void cancel(String operationId, String operationGeneration);

    record ProviderCatalog(String protocolVersion, String workerCapabilityVersion, List<ProviderEntry> providers) {
        public ProviderCatalog {
            providers = List.copyOf(providers);
        }
    }

    record ProviderEntry(String providerRef, String providerVersion, Optional<String> modelRef,
                         Optional<String> modelVersion, List<String> mediaTypes, List<String> supportedLanguages,
                         String promotionStatus, boolean loaded, boolean ready) {
        public ProviderEntry {
            mediaTypes = List.copyOf(mediaTypes);
            supportedLanguages = List.copyOf(supportedLanguages);
        }
    }

    record ParseRequest(String operationId, String operationGeneration, String providerRef, String mediaType,
                        Optional<String> languageHint, long timeoutMs, Map<String, Integer> limits, byte[] bytes) {
        public ParseRequest {
            Objects.requireNonNull(operationId, "operationId");
            Objects.requireNonNull(operationGeneration, "operationGeneration");
            Objects.requireNonNull(providerRef, "providerRef");
            Objects.requireNonNull(mediaType, "mediaType");
            limits = Map.copyOf(limits);
            bytes = bytes.clone();
        }

        @Override
        public byte[] bytes() {
            return bytes.clone();
        }
    }

    record Provenance(String providerRef, String providerVersion, Optional<String> modelRef, Optional<String> modelVersion) { }

    /** Normalized [0,1] region relative to the submitted image. */
    record Box(double x, double y, double width, double height) { }

    record Line(String lineId, String text, Box boundingRegion, Optional<Double> confidence, Optional<String> languageTag) { }

    record Block(String blockId, String kind, Box boundingRegion, List<Line> lines) {
        public Block {
            lines = List.copyOf(lines);
        }
    }

    record Page(int pageNumber, List<Block> blocks, int tableCount) {
        public Page {
            blocks = List.copyOf(blocks);
        }
    }

    record ParsedDocument(String protocolVersion, String operationId, String providerRef, Provenance providerProvenance,
                          List<Page> pages) {
        public ParsedDocument {
            pages = List.copyOf(pages);
        }
    }

    /** Cooperative cancellation; listeners fire once, immediately if already cancelled. */
    final class Cancellation {
        private final java.util.concurrent.atomic.AtomicBoolean cancelled = new java.util.concurrent.atomic.AtomicBoolean();
        private final java.util.List<Runnable> listeners = new java.util.concurrent.CopyOnWriteArrayList<>();

        public static Cancellation none() {
            return new Cancellation();
        }

        public void cancel() {
            if (cancelled.compareAndSet(false, true)) listeners.forEach(Runnable::run);
        }

        public boolean isCancelled() {
            return cancelled.get();
        }

        public Runnable onCancel(Runnable listener) {
            listeners.add(listener);
            if (cancelled.get()) listener.run();
            return () -> listeners.remove(listener);
        }
    }
}
