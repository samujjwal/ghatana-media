package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.VoiceInfo;
import com.ghatana.tts.core.grpc.proto.AudioChunk;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeResponse;
import com.ghatana.tts.service.PersistentTtsService;
import io.activej.promise.Promise;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.UUID;
import java.util.Locale;
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyFloat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
@DisplayName("PersistentTtsGrpcService")
class PersistentTtsGrpcServiceTest {

    // ─── Constants ────────────────────────────────────────────────────────────

    private static final String TENANT_ID = "tenant-alpha";
    private static final String USER_ID   = "00000000-0000-0000-0000-000000000001";
    private static final String TEXT      = "Hello, world!";

    // ─── Mocks ────────────────────────────────────────────────────────────────

    /** Used for synthesis path (injection constructor). */
    @Mock
    private PersistentTtsService persistentTtsService;

    /** Used for streaming path (public constructor). */
    @Mock
    private AudioVideoLibrary library;

    @Mock
    private TtsEngine engine;

    // ─── Services ─────────────────────────────────────────────────────────────

    /** Service under test for the synthesize() path — wired via injection constructor. */
    private PersistentTtsGrpcService synthesisService;

    /** Service under test for the streamSynthesize() path — wired via public constructor. */
    private PersistentTtsGrpcService streamingService;

    @BeforeEach
    void setUp() {
        synthesisService  = new PersistentTtsGrpcService(persistentTtsService);
        streamingService  = new PersistentTtsGrpcService(library, mock(AudioFileService.class), new SimpleMeterRegistry());
        lenient().when(library.getTtsEngine()).thenReturn(engine);
        lenient().when(engine.getActiveVoice()).thenReturn(new VoiceInfo(
                "test-voice",
                "Test Voice",
                "Test streaming voice",
                Locale.US,
                VoiceInfo.Gender.NEUTRAL,
                22_050,
                false,
                1L,
                1.0f));
    }

    // ─── synthesize() tests ───────────────────────────────────────────────────

    @Test
    @DisplayName("synthesize rejects requests without tenant context")
    void synthesizeRejectsRequestsWithoutTenantContext() {
        // No gRPC context set — JwtServerInterceptor.CTX_TENANT returns null
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        synthesisService.synthesize(SynthesizeRequest.newBuilder().setText(TEXT).build(), observer);

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(statusCode(observer)).isEqualTo(Status.UNAUTHENTICATED.getCode());
    }

    @Test
    @DisplayName("synthesize maps synchronous IllegalArgumentException to INVALID_ARGUMENT")
    void synthesizeMapsSynchronousValidationErrorToInvalidArgument() {
        when(persistentTtsService.synthesizeAndPersist(any(), any(), eq(TEXT), any(), anyFloat(), anyFloat(), isNull()))
            .thenThrow(new IllegalArgumentException("bad voice config"));

        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, USER_ID, () ->
            synthesisService.synthesize(SynthesizeRequest.newBuilder().setText(TEXT).build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.INVALID_ARGUMENT.getCode());
    }

    @Test
    @DisplayName("synthesize maps async IllegalArgumentException to INVALID_ARGUMENT")
    void synthesizeMapsAsyncValidationErrorToInvalidArgument() {
        when(persistentTtsService.synthesizeAndPersist(any(), any(), eq(TEXT), any(), anyFloat(), anyFloat(), isNull()))
            .thenReturn(Promise.ofException(new IllegalArgumentException("invalid lang")));

        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, USER_ID, () ->
            synthesisService.synthesize(SynthesizeRequest.newBuilder().setText(TEXT).build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.INVALID_ARGUMENT.getCode());
    }

    @Test
    @DisplayName("synthesize maps async TimeoutException to DEADLINE_EXCEEDED")
    void synthesizeMapsTimeoutToDeadlineExceeded() {
        when(persistentTtsService.synthesizeAndPersist(any(), any(), eq(TEXT), any(), anyFloat(), anyFloat(), isNull()))
            .thenReturn(Promise.ofException(new TimeoutException("synthesis timed out")));

        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, USER_ID, () ->
            synthesisService.synthesize(SynthesizeRequest.newBuilder().setText(TEXT).build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.DEADLINE_EXCEEDED.getCode());
    }

    @Test
    @DisplayName("synthesize maps async RuntimeException to INTERNAL")
    void synthesizeMapsRuntimeExceptionToInternal() {
        when(persistentTtsService.synthesizeAndPersist(any(), any(), eq(TEXT), any(), anyFloat(), anyFloat(), isNull()))
            .thenReturn(Promise.ofException(new RuntimeException("provider down")));

        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, USER_ID, () ->
            synthesisService.synthesize(SynthesizeRequest.newBuilder().setText(TEXT).build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.INTERNAL.getCode());
    }

    @Test
    @DisplayName("synthesize returns audio data on success")
    void synthesizeOnSuccessReturnsResponse() {
        UUID audioFileId = UUID.randomUUID();
        byte[] audioBytes = new byte[44_100];
        PersistentTtsService.SynthesisResult result =
            new PersistentTtsService.SynthesisResult(audioFileId, audioBytes, 22050, 123L,
                1_000L, 1, 16, "PCM_S16LE");
        when(persistentTtsService.synthesizeAndPersist(any(), any(), eq(TEXT), any(), anyFloat(), anyFloat(), isNull()))
            .thenReturn(Promise.of(result));

        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, USER_ID, () ->
            synthesisService.synthesize(SynthesizeRequest.newBuilder().setText(TEXT).build(), observer));

        assertThat(observer.error).isNull();
        assertThat(observer.completed).isTrue();
        assertThat(observer.value.getAudioData().toByteArray()).hasSize(44_100);
        assertThat(observer.value.getSampleRate()).isEqualTo(22050);
        assertThat(observer.value.getProcessingTimeMs()).isEqualTo(123L);
        assertThat(observer.value.getDurationMs()).isEqualTo(1_000L);
    }

    @Test
    @DisplayName("synthesize rejects persistent result with mismatched PCM duration")
    void synthesizeRejectsInvalidPersistentAudioResult() {
        UUID audioFileId = UUID.randomUUID();
        PersistentTtsService.SynthesisResult result = new PersistentTtsService.SynthesisResult(
                audioFileId, new byte[44_100], 22_050, 123L, 2_000L, 1, 16, "PCM_S16LE");
        when(persistentTtsService.synthesizeAndPersist(any(), any(), eq(TEXT), any(), anyFloat(), anyFloat(), isNull()))
                .thenReturn(Promise.of(result));

        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, USER_ID, () -> synthesisService.synthesize(
                SynthesizeRequest.newBuilder().setText(TEXT).build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(observer.value).isNull();
    }

    @Test
    @DisplayName("synthesize rejects missing subject before persistence")
    void synthesizeRejectsMissingSubjectBeforePersistence() {
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
        // Provide tenant but no subject
        withContext(TENANT_ID, null, () ->
            synthesisService.synthesize(SynthesizeRequest.newBuilder().setText(TEXT).build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(persistentTtsService);
    }

    @Test
    @DisplayName("synthesize rejects unsupported subject before persistence")
    void synthesizeRejectsInvalidSubjectBeforePersistence() {
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, "opaque-subject", () ->
            synthesisService.synthesize(SynthesizeRequest.newBuilder().setText(TEXT).build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(persistentTtsService);
    }

    @Test
    @DisplayName("synthesize rejects caller-selected voice before persistence without rights authority")
    void synthesizeRejectsUnadmittedVoiceSelectionBeforePersistence() {
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, USER_ID, () -> synthesisService.synthesize(
                SynthesizeRequest.newBuilder().setText(TEXT).setVoiceId("custom-voice").build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.UNIMPLEMENTED.getCode());
        verifyNoInteractions(persistentTtsService);
    }

    // ─── streamSynthesize() tests ─────────────────────────────────────────────

    @Test
    @DisplayName("streamSynthesize rejects requests without tenant context")
    void streamSynthesizeRejectsRequestsWithoutTenantContext() {
        CapturingObserver<AudioChunk> observer = new CapturingObserver<>();

        streamingService.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer);

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
            .isEqualTo(Status.UNAUTHENTICATED.getCode());
    }

    @Test
    @DisplayName("streamSynthesize fails closed without provider access or chunks")
    void streamSynthesizeFailsClosedWithoutProviderAccess() {
        CapturingObserver<AudioChunk> observer = new CapturingObserver<>();
        withContext("tenant-a", null, () ->
            streamingService.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.UNAVAILABLE.getCode());
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        verifyNoInteractions(library, engine);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private static Status.Code statusCode(CapturingObserver<?> observer) {
        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        return ((StatusRuntimeException) observer.error).getStatus().getCode();
    }

    /**
     * Runs {@code action} inside a gRPC {@link Context} that has the given tenant and optional
     * subject set — matching how {@link JwtServerInterceptor} wires values during real requests.
     */
    private static void withContext(String tenantId, String subject, Runnable action) {
        Context ctx = Context.current();
        if (tenantId != null) {
            ctx = ctx.withValue(JwtServerInterceptor.CTX_TENANT, tenantId);
        }
        if (subject != null) {
            ctx = ctx.withValue(JwtServerInterceptor.CTX_SUBJECT, subject);
        }
        ctx.run(action);
    }

    private static final class CapturingObserver<T> implements StreamObserver<T> {
        private T value;
        private Throwable error;
        private boolean completed;

        @Override public void onNext(T v)      { this.value = v; }
        @Override public void onError(Throwable t) { this.error = t; }
        @Override public void onCompleted()    { this.completed = true; }
    }
}
