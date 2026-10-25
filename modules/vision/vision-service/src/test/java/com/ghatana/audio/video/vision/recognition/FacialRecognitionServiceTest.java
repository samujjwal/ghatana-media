package com.ghatana.audio.video.vision.recognition;

import com.ghatana.audio.video.vision.model.VisionCapabilityDisposition;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

class FacialRecognitionServiceTest {

    @Test
    void constructorAndValueValidationRemainEnforced() {
        org.assertj.core.api.Assertions.assertThatNullPointerException()
                .isThrownBy(() -> FacialRecognitionService.of(null));
        org.assertj.core.api.Assertions.assertThatIllegalArgumentException()
                .isThrownBy(() -> FacialRecognitionService.of(image -> List.of(), 1.1));
        org.assertj.core.api.Assertions.assertThatIllegalArgumentException()
                .isThrownBy(() -> FacialRecognitionService.of(image -> List.of(), 0.8, -0.1, true,
                        FacialRecognitionService.FacialRecognitionAuditSink.noop()));
        org.assertj.core.api.Assertions.assertThatIllegalArgumentException()
                .isThrownBy(() -> new FacialRecognitionService.FaceDetection(
                        "face-region", new FacialRecognitionService.BoundingBox(0, 0, 1, 1), 1.1, new float[0]));
        org.assertj.core.api.Assertions.assertThatIllegalArgumentException()
                .isThrownBy(() -> new FacialRecognitionService.FaceDetection(
                        "face-region", new FacialRecognitionService.BoundingBox(0, 0, 1, 1), Double.NaN, new float[0]));
        org.assertj.core.api.Assertions.assertThatIllegalArgumentException()
                .isThrownBy(() -> new FacialRecognitionService.BoundingBox(-0.01, 0, 0.5, 0.5));
        org.assertj.core.api.Assertions.assertThatIllegalArgumentException()
                .isThrownBy(() -> new FacialRecognitionService.BoundingBox(0.75, 0, 0.5, 0.5));
        org.assertj.core.api.Assertions.assertThatIllegalArgumentException()
                .isThrownBy(() -> new FacialRecognitionService.BoundingBox(0, 0, Double.NaN, 0.5));
        org.assertj.core.api.Assertions.assertThatIllegalArgumentException()
                .isThrownBy(() -> new FacialRecognitionService.FaceDetection(
                        "face-region", new FacialRecognitionService.BoundingBox(0, 0, 1, 1), 0.9,
                        new float[] {Float.POSITIVE_INFINITY}));
    }

    @Test
    void faceEmbeddingIsDefensivelyCopiedAtConstructionAndReadback() {
        float[] supplied = {0.25f, 0.75f};
        var face = new FacialRecognitionService.FaceDetection("face-region",
                new FacialRecognitionService.BoundingBox(0.1, 0.1, 0.5, 0.5), 0.9, supplied);

        supplied[0] = 99;
        float[] readback = face.embedding();
        readback[1] = 99;

        org.assertj.core.api.Assertions.assertThat(face.embedding()).containsExactly(0.25f, 0.75f);
    }

    @Test
    void sameTenantClaimAndConsentBooleanDoNotStandInForTrustedRights() {
        assertDeniedWithoutEffects(true, "tenant-a:purpose=identity:consent=valid");
    }

    @Test
    void otherTenantClaimCannotAuthorizeRestrictedFaceAnalysis() {
        assertDeniedWithoutEffects(true, "tenant-b:purpose=identity:consent=valid");
    }

    @Test
    void revokedConsentClaimBlocksRestrictedAnalysisWithoutEffects() {
        assertDeniedWithoutEffects(false, "tenant-a:purpose=identity:consent=revoked");
    }

    @Test
    void missingRightsClaimBlocksRestrictedAnalysisWithoutEffects() {
        assertDeniedWithoutEffects(true, "tenant-a:purpose=identity:rights=missing");
    }

    @Test
    void wrongPurposeClaimCannotAuthorizeRestrictedFaceAnalysis() {
        assertDeniedWithoutEffects(true, "tenant-a:purpose=analytics:consent=valid");
    }

    private static void assertDeniedWithoutEffects(boolean consentClaim, String callerSuppliedActorClaim) {
        AtomicInteger providerCalls = new AtomicInteger();
        FacialRecognitionService.FacialRecognitionAuditSink audit = mock(
                FacialRecognitionService.FacialRecognitionAuditSink.class);
        FacialRecognitionService service = FacialRecognitionService.of(image -> {
            providerCalls.incrementAndGet();
            return List.of();
        }, 0.85, 0.5, true, audit);

        assertThatThrownBy(() -> service.detect(new byte[]{1, 2}))
                .isInstanceOf(FacialRecognitionService.NotAdmittedException.class)
                .hasMessage("NOT_ADMITTED: trusted biometric rights authority is unavailable");
        // The legacy API has no trusted tenant/purpose input. A caller-authored
        // actor string and boolean are claims only and cannot authorize dispatch.
        assertThatThrownBy(() -> service.identify(
                new float[]{1, 0}, Map.of("subject", new float[]{1, 0}), consentClaim,
                callerSuppliedActorClaim))
                .isInstanceOf(FacialRecognitionService.NotAdmittedException.class)
                .hasMessage("NOT_ADMITTED: trusted biometric rights authority is unavailable");

        org.assertj.core.api.Assertions.assertThat(providerCalls).hasValue(0);
        verify(audit, never()).record(org.mockito.ArgumentMatchers.any());
    }

    @Test
    void boundingBoxIsGeometryAndNotAnIdentityAssertion() {
        var detection = new FacialRecognitionService.FaceDetection(
                "ephemeral-detection-1", new FacialRecognitionService.BoundingBox(0.1, 0.2, 0.3, 0.4),
                0.9, new float[0]);

        org.assertj.core.api.Assertions.assertThat(detection.boundingBox())
                .isEqualTo(new FacialRecognitionService.BoundingBox(0.1, 0.2, 0.3, 0.4));
        org.assertj.core.api.Assertions.assertThat(detection.faceId()).isEqualTo("ephemeral-detection-1");
        org.assertj.core.api.Assertions.assertThat(FacialRecognitionService.FaceDetection.class.getRecordComponents())
                .extracting(java.lang.reflect.RecordComponent::getName)
                .containsExactly("faceId", "boundingBox", "confidence", "embedding")
                .doesNotContain("identityId", "personId");
    }

    @Test
    void restrictedFaceLandmarkExpressionGazeCapabilitiesRemainNotAdmitted() {
        org.assertj.core.api.Assertions.assertThat(VisionCapabilityDisposition.forIntentId(
                "media.vision.estimate.face-landmarks").orElseThrow().status())
                .isEqualTo(VisionCapabilityDisposition.Status.NOT_ADMITTED);
        org.assertj.core.api.Assertions.assertThat(VisionCapabilityDisposition.forIntentId(
                "media.vision.analyze.expression").orElseThrow().status())
                .isEqualTo(VisionCapabilityDisposition.Status.NOT_ADMITTED);
        org.assertj.core.api.Assertions.assertThat(VisionCapabilityDisposition.forIntentId(
                "media.vision.analyze.gaze").orElseThrow().status())
                .isEqualTo(VisionCapabilityDisposition.Status.NOT_ADMITTED);
    }
}
