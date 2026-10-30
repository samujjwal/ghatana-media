package com.ghatana.audio.video.vision.provider;

import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;

import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * W2-R02 canonical bridge: an admitted {@link VisionDetector} (e.g. the pinned
 * {@code YoloXNanoAdapter}) behind the {@link MediaProcessingProvider} contract so a
 * {@link JobType#VISION} job — including a multimodal child — runs through the same
 * source-authorized, fenced, attempt-receipted path as every other canonical job.
 *
 * <p>Source bytes are read only through the bounded {@code sourceReader}, which repeats
 * the current rights/policy check before each copy. The result is bound to the exact
 * input by a SHA-256 provenance digest of the consumed bytes; an undecodable or failing
 * read propagates as an ambiguous failure (OUTCOME_UNKNOWN), never a fabricated result.
 * Production eligibility is a constructor assertion tied to the model profile's
 * qualification state — it is never implied by construction alone.
 */
public final class CanonicalVisionMediaProcessingProvider implements MediaProcessingProvider {

    /** Hard byte ceiling for one image read; keeps memory bounded for huge artifacts. */
    private static final long MAX_SOURCE_BYTES = 32L * 1024 * 1024;

    private final VisionDetector detector;
    private final String providerId;
    private final String providerVersion;
    private final boolean productionEligible;
    private final int maxDetections;

    /**
     * @param detector           initialized detector backend (e.g. verified YOLOX-Nano)
     * @param providerId         stable provider identity for result governance
     * @param providerVersion    explicit provider version (required by {@link #verifyReady()})
     * @param productionEligible whether the bound model profile is genuinely
     *                           model/rights/host qualified for production dispatch —
     *                           must be {@code false} for unverified or fixture models
     */
    public CanonicalVisionMediaProcessingProvider(
            VisionDetector detector,
            String providerId,
            String providerVersion,
            boolean productionEligible,
            int maxDetections) {
        this.detector = Objects.requireNonNull(detector, "detector");
        if (providerId == null || providerId.isBlank()) {
            throw new IllegalArgumentException("providerId is required");
        }
        if (providerVersion == null || providerVersion.isBlank()) {
            throw new IllegalArgumentException("providerVersion is required");
        }
        this.providerId = providerId;
        this.providerVersion = providerVersion;
        this.productionEligible = productionEligible;
        this.maxDetections = maxDetections <= 0 ? 64 : maxDetections;
    }

    @Override public String providerId() { return providerId; }

    @Override public String providerVersion() { return providerVersion; }

    @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }

    @Override public boolean ready() { return detector.isInitialized(); }

    @Override public boolean productionEligible() { return productionEligible; }

    @Override public int priority() { return 0; }

    @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }

    @Override public String processingRegion() { return "local"; }

    @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }

    /**
     * The durable dispatch path requires the typed attempt channel; the legacy map
     * channel is deliberately fail-closed so results can never bypass the attempt
     * fencing/receipt machinery.
     */
    @Override
    public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
        return CompletableFuture.failedFuture(
                new UnsupportedOperationException("VISION jobs require the typed attempt path"));
    }

    @Override
    public CompletableFuture<ProviderSubmission> processAttempt(
            ProcessingContext context, ProviderAttemptContext attempt) {
        Objects.requireNonNull(context, "context");
        Objects.requireNonNull(attempt, "attempt");
        return CompletableFuture.supplyAsync(() -> {
            byte[] image;
            try {
                ByteArrayOutputStream sink = new ByteArrayOutputStream();
                // The reader re-validates rights, policy, tenant, principal and exact
                // immutable source version before any byte crosses this boundary.
                context.copySourceContentTo(sink, MAX_SOURCE_BYTES);
                image = sink.toByteArray();
            } catch (RuntimeException | java.io.IOException failure) {
                throw new VisionEffectAmbiguousException(
                        "VISION source read failed before detector dispatch", failure);
            }
            if (image.length == 0) {
                throw new VisionEffectAmbiguousException("VISION source produced no bytes", null);
            }
            List<DetectedObject> detections = detector.detectObjects(image, detectionOptions());
            Map<String, Object> result = Map.of(
                    "detections", toResultEntries(detections),
                    "detectedObjectCount", detections.size(),
                    "modelId", providerId,
                    "modelVersion", providerVersion);
            return new ProviderSubmission(
                    AttemptFinality.SUCCEEDED,
                    "vision-op:" + attempt.jobId() + ":" + attempt.attemptNumber(),
                    "vision-receipt:" + attempt.jobId() + ":" + attempt.attemptNumber(),
                    result, sha256(image), Instant.now());
        });
    }

    private DetectionOptions detectionOptions() {
        return DetectionOptions.builder().maxDetections(maxDetections).build();
    }

    private static List<Map<String, Object>> toResultEntries(List<DetectedObject> detections) {
        var entries = new ArrayList<Map<String, Object>>(detections.size());
        for (DetectedObject detection : detections) {
            var box = detection.getBoundingBox();
            var entry = new LinkedHashMap<String, Object>();
            entry.put("label", detection.getClassName());
            entry.put("confidence", detection.getConfidence());
            if (box != null) {
                entry.put("boundingBox", Map.of(
                        "x", box.getX(), "y", box.getY(),
                        "width", box.getWidth(), "height", box.getHeight()));
            }
            entries.add(Map.copyOf(entry));
        }
        return List.copyOf(entries);
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    /**
     * A source read that cannot be proven byte-exact is an ambiguous effect boundary:
     * the canonical path maps it to OUTCOME_UNKNOWN, never a successful empty result.
     */
    static final class VisionEffectAmbiguousException extends RuntimeException {
        VisionEffectAmbiguousException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    @Override public Optional<com.ghatana.media.runtime.MediaRuntimeContracts.ProviderObservation>
            reconcileAttempt(String tenantId, String jobId, String requestId, int attemptNumber) {
        // Local detection has no external receipt store; an honest UNKNOWN is returned
        // rather than an inferred result.
        return Optional.empty();
    }

    @Override public void close() { }
}
