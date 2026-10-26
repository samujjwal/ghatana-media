package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.stt.core.grpc.proto.AdaptRequest;
import com.ghatana.stt.core.grpc.proto.AdaptResponse;
import com.ghatana.stt.core.grpc.proto.CorrectionRequest;
import com.ghatana.stt.core.grpc.proto.CorrectionResponse;
import com.ghatana.stt.testutil.VerifiedJwtContext;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

/** Regression coverage for versioned transcript outputs whose required stores/providers are absent. */
class SttVersionedOutputAdmissionTest {

    @Test
    void adaptationAndCorrectionDefaultToUnavailableWithoutRightsAuthority() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        ProductionSttGrpcService service = new ProductionSttGrpcService(library, new SimpleMeterRegistry());
        CapturingObserver<AdaptResponse> adaptation = new CapturingObserver<>();
        CapturingObserver<CorrectionResponse> correction = new CapturingObserver<>();

        runWithVerifiedIdentity(() -> {
            service.adaptModel(AdaptRequest.newBuilder().setProfileId("profile").build(), adaptation);
            service.submitCorrection(CorrectionRequest.newBuilder().setProfileId("profile").build(), correction);
        });

        assertNotAdmitted(adaptation, "STT_ADAPTATION_NOT_ADMITTED:", "trusted rights admission and an admitted adaptation provider");
        assertNotAdmitted(correction, "STT_CORRECTION_NOT_ADMITTED:", "immutable transcript revision store and expected-version CAS");
        verifyNoInteractions(library);
    }

    @Test
    void adaptationAndCorrectionRemainTypedNoEffectWithoutVersionStore() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        ProductionSttGrpcService service = new ProductionSttGrpcService(library, new SimpleMeterRegistry(),
                (SttRequestAuthorization) (request -> SttRequestAuthorization.Decision.ADMITTED)); // Test-only authority.
        CapturingObserver<AdaptResponse> adaptation = new CapturingObserver<>();
        CapturingObserver<CorrectionResponse> correction = new CapturingObserver<>();

        runWithVerifiedIdentity(() -> {
            service.adaptModel(AdaptRequest.newBuilder().setProfileId("profile").build(), adaptation);
            service.submitCorrection(CorrectionRequest.newBuilder()
                    .setOriginalText("source text")
                    .setCorrectedText("changed text")
                    .setProfileId("profile")
                    .setContextId("transcript-version")
                    .build(), correction);
        });

        assertNotAdmitted(adaptation, "STT_ADAPTATION_NOT_ADMITTED:", "versioned transcript correction");
        assertNotAdmitted(correction, "STT_CORRECTION_NOT_ADMITTED:", "immutable transcript revision store");
        verifyNoInteractions(library);
    }

    private static void runWithVerifiedIdentity(Runnable action) {
        VerifiedJwtContext.create("tenant-fixture", "00000000-0000-0000-0000-000000000001").run(action);
    }

    private static void assertNotAdmitted(CapturingObserver<?> observer, String code, String requirement) {
        assertThat(observer.failure).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.failure;
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(failure.getStatus().getDescription()).startsWith(code).contains(requirement);
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
    }

    private static final class CapturingObserver<T> implements StreamObserver<T> {
        private T value;
        private Throwable failure;
        private boolean completed;

        @Override public void onNext(T next) { value = next; }
        @Override public void onError(Throwable error) { failure = error; }
        @Override public void onCompleted() { completed = true; }
    }
}
