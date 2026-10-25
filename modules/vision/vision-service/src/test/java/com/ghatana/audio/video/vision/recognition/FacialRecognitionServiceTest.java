package com.ghatana.audio.video.vision.recognition;

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
    void sameTenantStillNeedsTrustedRightsAndHasNoRestrictedEffects() {
        assertDeniedWithoutEffects(true, "tenant-a", true);
    }

    @Test
    void foreignTenantIsNotAuthorizedByCallerSuppliedTenantClaim() {
        // This legacy API has no trusted tenant binding, so the supplied label
        // cannot authorize a restricted biometric operation.
        assertDeniedWithoutEffects(true, "tenant-b", true);
    }

    @Test
    void revokedConsentBlocksRestrictedAnalysisWithoutEffects() {
        assertDeniedWithoutEffects(false, "tenant-a", true);
    }

    @Test
    void missingRightsBlocksRestrictedAnalysisWithoutEffects() {
        assertDeniedWithoutEffects(true, "tenant-a", false);
    }

    private static void assertDeniedWithoutEffects(boolean consentClaim, String tenantClaim, boolean rightsClaim) {
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
        assertThatThrownBy(() -> service.identify(
                new float[]{1, 0}, Map.of("subject", new float[]{1, 0}), consentClaim,
                tenantClaim + (rightsClaim ? "-rights-claimed" : "-rights-missing")))
                .isInstanceOf(FacialRecognitionService.NotAdmittedException.class)
                .hasMessage("NOT_ADMITTED: trusted biometric rights authority is unavailable");

        org.assertj.core.api.Assertions.assertThat(providerCalls).hasValue(0);
        verify(audit, never()).record(org.mockito.ArgumentMatchers.any());
    }
}
