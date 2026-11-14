package com.ghatana.audio.video.vision.local;

import com.ghatana.media.runtime.MediaRuntimeContracts;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Canonical provider contract with FIXTURE_ONLY models and a fake sidecar (no real inference here). */
class LocalOpenModelVisionProviderTest {

    private static final String ANALYZE = "{\"results\":{\"caption\":\"A red square.\","
            + "\"detect\":{\"bboxes\":[[0,0,10,10]],\"labels\":[\"box\"]}},\"imageSize\":{\"width\":640,\"height\":480}}";
    private static final String ASK = "{\"answer\":\"Red.\",\"imageSize\":{\"width\":640,\"height\":480}}";

    @TempDir Path temp;

    private LocalOpenModelVisionProvider provider(LocalVisionTestFixtures.FakeSidecar sidecar, boolean qwen,
                                                  LocalVisionRightsAuthority rights,
                                                  LocalOpenModelVisionProvider.FrameExtractor frames) throws Exception {
        Path florenceDir = LocalVisionTestFixtures.modelDir(temp, "f" + System.nanoTime(),
                LocalVisionEngine.FLORENCE_MODEL_ID, "VISION", "MIT");
        Path qwenDir = qwen
                ? LocalVisionTestFixtures.modelDir(temp, "q" + System.nanoTime(), LocalVisionEngine.QWEN_MODEL_ID,
                        "MULTIMODAL_QA", "Apache-2.0")
                : temp.resolve("absent-q");
        return new LocalOpenModelVisionProvider(new LocalVisionEngine(sidecar.client(),
                LocalVisionTestFixtures.florence(florenceDir), LocalVisionTestFixtures.qwen(qwenDir), rights), frames);
    }

    @Test
    void productionEligibilityRequiresRealRightsAuthorityAndBothQualifiedModels() throws Exception {
        try (var sidecar = new LocalVisionTestFixtures.FakeSidecar((p, b) -> ANALYZE)) {
            var noRights = provider(sidecar, true, LocalVisionRightsAuthority.unavailable(), null);
            assertThat(noRights.ready()).isTrue();
            assertThat(noRights.productionEligible()).isFalse();
            assertThat(LocalVisionRightsAuthority.unavailable().reasonCode()).isEqualTo("RIGHTS_AUTHORITY_UNAVAILABLE");
            assertThat(noRights.capabilities()).containsExactly(MediaRuntimeContracts.JobType.VISION);
            assertThat(noRights.processingBoundary()).isEqualTo(MediaRuntimeContracts.ProcessingBoundary.LOCAL);
            assertThat(noRights.providerDataRetention()).isEqualTo(MediaRuntimeContracts.ProviderDataRetention.NONE);

            LocalVisionRightsAuthority fixtureAuthority = new LocalVisionRightsAuthority() {
                @Override public boolean productionReady() { return true; }
                @Override public String reasonCode() { return "FIXTURE_ONLY_RIGHTS_AUTHORITY"; }
            };
            assertThat(provider(sidecar, true, fixtureAuthority, null).productionEligible()).isTrue();
            // Rights alone do not qualify a model that is missing.
            assertThat(provider(sidecar, false, fixtureAuthority, null).productionEligible()).isFalse();
        }
    }

    @Test
    void notReadyWhenFlorenceDigestsOrSidecarFail() throws Exception {
        var sidecar = new LocalVisionTestFixtures.FakeSidecar((p, b) -> ANALYZE);
        var provider = provider(sidecar, true, LocalVisionRightsAuthority.unavailable(), null);
        assertThat(provider.ready()).isTrue();
        sidecar.close();
        var stopped = provider(sidecar, true, LocalVisionRightsAuthority.unavailable(), null);
        assertThat(stopped.ready()).isFalse();
    }

    @Test
    void successfulAnalysisIsBoundToTheExactSourceBytes() throws Exception {
        try (var sidecar = new LocalVisionTestFixtures.FakeSidecar((p, b) -> ANALYZE)) {
            var provider = provider(sidecar, true, LocalVisionRightsAuthority.unavailable(), null);
            byte[] png = LocalVisionTestFixtures.testImagePng();
            var submission = provider.processAttempt(context(png, "image/png", Map.of(
                    "analysisTypes", List.of("OBJECT_DETECTION", "SCENE_CLASSIFICATION")), true), attempt()).get();
            assertThat(submission.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
            assertThat(submission.provenanceDigest()).isEqualTo(LocalVisionTestFixtures.sha256(png));
            assertThat(submission.result()).containsKeys("caption", "objects", "models").containsEntry("sourceArtifactSha256",
                    LocalVisionTestFixtures.sha256(png));
        }
    }

    @Test
    void questionParameterUsesQwenAndYieldsAnAnswer() throws Exception {
        try (var sidecar = new LocalVisionTestFixtures.FakeSidecar((p, b) -> p.endsWith("/ask") ? ASK : ANALYZE)) {
            var provider = provider(sidecar, true, LocalVisionRightsAuthority.unavailable(), null);
            byte[] png = LocalVisionTestFixtures.testImagePng();
            var submission = provider.processAttempt(context(png, "image/png",
                    Map.of("question", "What color is the square?"), true), attempt()).get();
            assertThat(submission.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
            assertThat(submission.result()).containsEntry("answer", "Red.").containsEntry("description", "Red.")
                    .containsEntry("question", "What color is the square?");
        }
    }

    @Test
    void unsupportedAnalysisTypeAndNotQualifiedModelProveNoEffectWithoutCallingTheSidecar() throws Exception {
        try (var sidecar = new LocalVisionTestFixtures.FakeSidecar((p, b) -> ANALYZE)) {
            var provider = provider(sidecar, false, LocalVisionRightsAuthority.unavailable(), null);
            byte[] png = LocalVisionTestFixtures.testImagePng();
            var face = provider.processAttempt(context(png, "image/png",
                    Map.of("analysisTypes", List.of("FACE_DETECTION")), true), attempt()).get();
            assertThat(face.finality()).isEqualTo(AttemptFinality.NO_EFFECT_PROVEN);
            var question = provider.processAttempt(context(png, "image/png", Map.of("question", "What?"), true),
                    attempt()).get();
            assertThat(question.finality()).isEqualTo(AttemptFinality.NO_EFFECT_PROVEN);
            assertThat(sidecar.inferenceCalls.get()).isZero();
        }
    }

    @Test
    void nonImageWithoutFrameExtractorProvesNoEffect() throws Exception {
        try (var sidecar = new LocalVisionTestFixtures.FakeSidecar((p, b) -> ANALYZE)) {
            var provider = provider(sidecar, true, LocalVisionRightsAuthority.unavailable(), null);
            var submission = provider.processAttempt(context("RIFFxxxxAVI LIST....".getBytes(), "video/mp4", Map.of(), true),
                    attempt()).get();
            assertThat(submission.finality()).isEqualTo(AttemptFinality.NO_EFFECT_PROVEN);
            assertThat(sidecar.inferenceCalls.get()).isZero();
        }
    }

    @Test
    void videoFrameIsResolvedAtTheExactPositionAndBoundToBothDigests() throws Exception {
        byte[] frame = LocalVisionTestFixtures.testImagePng();
        var requested = new java.util.concurrent.atomic.AtomicLong(-1);
        try (var sidecar = new LocalVisionTestFixtures.FakeSidecar((p, b) -> ANALYZE)) {
            var provider = provider(sidecar, true, LocalVisionRightsAuthority.unavailable(), (video, time) -> {
                requested.set(time);
                return frame;
            });
            byte[] video = "FIXTURE_ONLY-not-really-a-video-but-not-an-image".getBytes();
            var submission = provider.processAttempt(context(video, "video/mp4",
                    Map.of("analysisTypes", List.of("OCR"), "frameTimeMs", 1500), true), attempt()).get();
            assertThat(submission.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
            assertThat(requested.get()).isEqualTo(1500);
            @SuppressWarnings("unchecked") var frameInfo = (Map<String, Object>) submission.result().get("frame");
            assertThat(frameInfo).containsEntry("sourceVideoSha256", LocalVisionTestFixtures.sha256(video))
                    .containsEntry("frameSha256", LocalVisionTestFixtures.sha256(frame));
            assertThat(submission.provenanceDigest()).isEqualTo(LocalVisionTestFixtures.sha256(frame));
        }
    }

    @Test
    void unprovableSourceReadOrSidecarOutageIsAmbiguousNotASuccess() throws Exception {
        var sidecar = new LocalVisionTestFixtures.FakeSidecar((p, b) -> ANALYZE);
        var provider = provider(sidecar, true, LocalVisionRightsAuthority.unavailable(), null);
        byte[] png = LocalVisionTestFixtures.testImagePng();
        var badRead = new AtomicBoolean();
        assertThatThrownBy(() -> provider.processAttempt(contextWithReader(png, (target, max) -> {
            badRead.set(true);
            throw new java.io.IOException("source object deleted");
        }), attempt()).join()).hasCauseInstanceOf(IllegalStateException.class);
        sidecar.close();
        assertThatThrownBy(() -> provider.processAttempt(context(png, "image/png", Map.of(), true), attempt()).join())
                .hasCauseInstanceOf(LocalVisionSidecarClient.SidecarUnavailableException.class);
        assertThat(provider.reconcileAttempt("t", "j", "r", 1)).isEmpty();
    }

    @Test
    void developmentMapChannelReturnsTheSameBoundResultAndNeverAFabricatedOne() throws Exception {
        try (var sidecar = new LocalVisionTestFixtures.FakeSidecar((p, b) -> ANALYZE)) {
            var provider = provider(sidecar, true, LocalVisionRightsAuthority.unavailable(), null);
            byte[] png = LocalVisionTestFixtures.testImagePng();
            var result = provider.process(context(png, "image/png",
                    Map.of("analysisTypes", List.of("OCR")), true)).get();
            assertThat(result).containsKeys("labels", "sceneText", "models").containsEntry("sourceArtifactSha256",
                    LocalVisionTestFixtures.sha256(png));
            assertThatThrownBy(() -> provider.process(context(png, "image/png",
                    Map.of("analysisTypes", List.of("FACE_DETECTION")), true)).join())
                    .hasCauseInstanceOf(IllegalStateException.class);
        }
    }

    // ---- fixtures ----

    private static MediaRuntimeContracts.ProcessingContext context(byte[] bytes, String contentType,
                                                                    Map<String, Object> parameters, boolean ok) {
        return build(bytes, contentType, parameters, (target, max) -> {
            target.write(bytes);
            return receipt(bytes);
        });
    }

    private static MediaRuntimeContracts.ProcessingContext contextWithReader(byte[] bytes,
            MediaRuntimeContracts.MediaArtifactContentReader reader) {
        return build(bytes, "image/png", Map.of(), reader);
    }

    private static MediaRuntimeContracts.ProcessingContext build(byte[] bytes, String contentType,
            Map<String, Object> parameters, MediaRuntimeContracts.MediaArtifactContentReader reader) {
        String sha = LocalVisionTestFixtures.sha256(bytes);
        var request = new MediaRuntimeContracts.ProcessingJobRequest("req-1", "tenant-a", "principal-a", "corr-1",
                "artifact-1", "sha256:" + sha, MediaRuntimeContracts.JobType.VISION, "", parameters);
        var artifact = new MediaRuntimeContracts.MediaArtifact("tenant-a", "principal-a", "artifact-1", "img",
                contentType, bytes.length, sha, "s3://bucket/img", "INTERNAL", Instant.now(),
                Instant.now().plusSeconds(3600), Map.of());
        return new MediaRuntimeContracts.ProcessingContext(request, artifact, new MediaRuntimeContracts.Cancellation(),
                null, reader);
    }

    private static MediaRuntimeContracts.ProviderAttemptContext attempt() {
        return new MediaRuntimeContracts.ProviderAttemptContext("tenant-a", "job-1", "req-1", 1, 1, "a".repeat(64));
    }

    private static MediaRuntimeContracts.ArtifactContentReadReceipt receipt(byte[] bytes) {
        String sha = LocalVisionTestFixtures.sha256(bytes);
        return new MediaRuntimeContracts.ArtifactContentReadReceipt(
                MediaRuntimeContracts.ArtifactVersion.fromSha256(sha), sha, bytes.length);
    }
}
