package com.ghatana.audio.video.vision.provider;

import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.model.BoundingBox;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.media.runtime.MediaRuntimeContracts;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * W2-R02: the canonical Vision provider adapter produces typed SUCCEEDED attempts
 * bound to the exact consumed source bytes and fails honestly everywhere else.
 */
class CanonicalVisionMediaProcessingProviderTest {

    private static final byte[] IMAGE = "fixture-png-bytes".getBytes(StandardCharsets.UTF_8);

    @Test
    void successfulDetectionProducesSucceededSubmissionBoundToExactSourceBytes() throws Exception {
        var detector = fixtureDetector(List.of(object("person", 0.93)));
        var provider = provider(detector, false);
        var read = new AtomicBoolean();
        var bounded = new AtomicLong();
        var context = context((target, max) -> {
            read.set(true);
            bounded.set(max);
            target.write(IMAGE);
            return receipt();
        });

        var submission = provider.processAttempt(context, attempt()).get();
        assertThat(read).isTrue();
        assertThat(bounded).hasValue(32L * 1024 * 1024);
        assertThat(submission.finality())
                .isEqualTo(MediaRuntimeContracts.AttemptFinality.SUCCEEDED);
        assertThat(submission.providerOperationId()).contains("job-1");
        assertThat(submission.providerReceiptId()).contains("job-1");
        // The submission is bound to the exact consumed bytes — not an inferred digest.
        assertThat(submission.provenanceDigest())
                .isEqualTo(java.util.HexFormat.of().formatHex(
                        java.security.MessageDigest.getInstance("SHA-256").digest(IMAGE)));
        @SuppressWarnings("unchecked")
        var detections = (List<Map<String, Object>>) submission.result().get("detections");
        assertThat(detections).hasSize(1);
        assertThat(detections.get(0).get("label")).isEqualTo("person");
        assertThat(submission.result().get("detectedObjectCount")).isEqualTo(1);
    }

    @Test
    void failedSourceReadIsAmbiguousAndNeverAFabricatedResult() {
        var provider = provider(fixtureDetector(List.of()), false);
        var context = context((target, max) -> {
            throw new java.io.IOException("source object deleted");
        });

        assertThatThrownBy(() -> provider.processAttempt(context, attempt()).join())
                .satisfies(error -> assertThat(error.getCause())
                        .isInstanceOf(CanonicalVisionMediaProcessingProvider
                                .VisionEffectAmbiguousException.class));
    }

    @Test
    void emptySourceIsAmbiguousNotAZeroDetectionSuccess() {
        var provider = provider(fixtureDetector(List.of()), false);
        var context = context((target, max) -> receipt());

        assertThatThrownBy(() -> provider.processAttempt(context, attempt()).join())
                .satisfies(error -> assertThat(error.getCause())
                        .isInstanceOf(CanonicalVisionMediaProcessingProvider
                                .VisionEffectAmbiguousException.class));
    }

    @Test
    void missingSourceReaderFailsClosed() {
        var provider = provider(fixtureDetector(List.of()), false);
        var context = context(null);
        assertThatThrownBy(() -> provider.processAttempt(context, attempt()).join())
                .isInstanceOf(Throwable.class);
    }

    @Test
    void detectorFailurePropagatesAsAmbiguousNotSuccess() {
        var provider = provider(new VisionDetector() {
            @Override public boolean isInitialized() { return true; }
            @Override public List<DetectedObject> detectObjects(byte[] data, DetectionOptions options) {
                throw new VisionDetector.DetectionException("model inference failed");
            }
        }, false);
        var context = context((target, max) -> {
            target.write(IMAGE);
            return receipt();
        });
        assertThatThrownBy(() -> provider.processAttempt(context, attempt()).join())
                .satisfies(error -> assertThat(error.getCause())
                        .isInstanceOf(VisionDetector.DetectionException.class));
    }

    @Test
    void legacyMapChannelIsFailClosedAndEligibilityIsExplicit() {
        var ineligible = provider(fixtureDetector(List.of()), false);
        assertThatThrownBy(() -> ineligible.process(context(null)).join())
                .satisfies(error -> assertThat(error.getCause())
                        .isInstanceOf(UnsupportedOperationException.class));
        assertThat(ineligible.productionEligible()).isFalse();
        assertThat(provider(fixtureDetector(List.of()), true).productionEligible()).isTrue();
        assertThat(ineligible.ready()).isTrue();
        assertThat(ineligible.reconcileAttempt("t", "j", "r", 1)).isEmpty();
    }

    // ── Fixtures ────────────────────────────────────────────────────────────

    private static CanonicalVisionMediaProcessingProvider provider(
            VisionDetector detector, boolean eligible) {
        return new CanonicalVisionMediaProcessingProvider(
                detector, "vision-canonical-test", "v1", eligible, 32);
    }

    private static VisionDetector fixtureDetector(List<DetectedObject> detections) {
        return new VisionDetector() {
            @Override public boolean isInitialized() { return true; }
            @Override public List<DetectedObject> detectObjects(byte[] data, DetectionOptions options) {
                return detections;
            }
        };
    }

    private static DetectedObject object(String name, double confidence) {
        return DetectedObject.builder()
                .className(name).confidence(confidence)
                .boundingBox(BoundingBox.builder().x(0.1).y(0.1).width(0.5).height(0.5).build())
                .build();
    }

    private static MediaRuntimeContracts.ProcessingContext context(
            MediaRuntimeContracts.MediaArtifactContentReader reader) {
        var sha = "a".repeat(64);
        var request = new MediaRuntimeContracts.ProcessingJobRequest(
                "req-1", "tenant-a", "principal-a", "corr-1", "artifact-1",
                "sha256:" + sha, MediaRuntimeContracts.JobType.VISION, "", Map.of());
        var artifact = new MediaRuntimeContracts.MediaArtifact(
                "tenant-a", "principal-a", "artifact-1", "img.png", "image/png",
                IMAGE.length, sha, "s3://bucket/img", "INTERNAL",
                Instant.now(), Instant.now().plusSeconds(3600), Map.of());
        return new MediaRuntimeContracts.ProcessingContext(
                request, artifact, new MediaRuntimeContracts.Cancellation(), null, reader);
    }

    private static MediaRuntimeContracts.ProviderAttemptContext attempt() {
        return new MediaRuntimeContracts.ProviderAttemptContext(
                "tenant-a", "job-1", "req-1", 1, 1, "a".repeat(64));
    }

    private static MediaRuntimeContracts.ArtifactContentReadReceipt receipt() {
        String sha = "a".repeat(64);
        return new MediaRuntimeContracts.ArtifactContentReadReceipt(
                MediaRuntimeContracts.ArtifactVersion.fromSha256(sha), sha, IMAGE.length);
    }
}
