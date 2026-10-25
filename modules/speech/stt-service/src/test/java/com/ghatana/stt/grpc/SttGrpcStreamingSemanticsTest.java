package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.stt.core.grpc.proto.AudioChunk;
import com.ghatana.stt.core.grpc.proto.Transcription;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import com.ghatana.stt.core.grpc.proto.AudioChunk;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

class SttGrpcStreamingSemanticsTest {
    @Test
    void additiveSequenceFieldsPreserveExistingWireNumbersAndDoNotClaimDurableResume() {
        assertThat(AudioChunk.getDescriptor().findFieldByName("audio_data").getNumber()).isEqualTo(1);
        assertThat(AudioChunk.getDescriptor().findFieldByName("sample_rate").getNumber()).isEqualTo(2);
        assertThat(AudioChunk.getDescriptor().findFieldByName("timestamp_ms").getNumber()).isEqualTo(3);
        assertThat(AudioChunk.getDescriptor().findFieldByName("session_id").getNumber()).isEqualTo(4);
        assertThat(AudioChunk.getDescriptor().findFieldByName("sequence").getNumber()).isEqualTo(5);
        assertThat(Transcription.getDescriptor().findFieldByName("accepted_sequence_snapshot").getNumber())
                .isEqualTo(6);
        assertThat(Transcription.getDescriptor().findFieldByName("durable_resume_enabled").getNumber())
                .isEqualTo(9);
    }

    @Test
    void missingTenantOrSubjectFailsBeforeAnyEngineOrSessionAccess() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        RecordingObserver<Transcription> response = new RecordingObserver<>();
        SttGrpcService service = new SttGrpcService(library, new SimpleMeterRegistry());

        service.streamTranscribe(response);

        assertStatus(response, Status.UNAUTHENTICATED);
        assertThat(response.values).isEmpty();
        verifyNoInteractions(library);
    }

    @Test
    void invalidSubjectFailsBeforeAnyEngineOrSessionAccess() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        RecordingObserver<Transcription> response = new RecordingObserver<>();
        SttGrpcService service = new SttGrpcService(library, new SimpleMeterRegistry());

        withIdentity("tenant-a", "not-a-uuid", () -> service.streamTranscribe(response));

        assertStatus(response, Status.UNAUTHENTICATED);
        assertThat(response.values).isEmpty();
        verifyNoInteractions(library);
    }

    @Test
    void validIdentityStillFailsClosedWithoutTrustedPurposeAndConsentRuntime() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        RecordingObserver<Transcription> response = new RecordingObserver<>();
        SttGrpcService service = new SttGrpcService(library, new SimpleMeterRegistry());

        withIdentity("tenant-a", "00000000-0000-0000-0000-000000000001", () -> {
            StreamObserver<AudioChunk> request = service.streamTranscribe(response);
            request.onNext(chunk());
            request.onCompleted();
        });

        assertStatus(response, Status.FAILED_PRECONDITION);
        assertThat(response.error.getMessage()).contains("STT_STREAM_CONSENT_NOT_ADMITTED");
        assertThat(response.values).isEmpty();
        verifyNoInteractions(library);
    }

    private static AudioChunk chunk() {
        return AudioChunk.newBuilder().setSessionId("client-session").setSequence(1)
                .setSampleRate(16_000).setAudioData(ByteString.copyFrom(new byte[] {1, 2, 3, 4}))
                .build();
    }

    private static void withIdentity(String tenant, String subject, Runnable action) {
        Context context = Context.current()
                .withValue(JwtServerInterceptor.CTX_TENANT, tenant)
                .withValue(JwtServerInterceptor.CTX_SUBJECT, subject);
        context.run(action);
    }

    private static void assertStatus(RecordingObserver<?> observer, Status expected) {
        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(expected.getCode());
    }

    private static final class RecordingObserver<T> implements StreamObserver<T> {
        private final List<T> values = new ArrayList<>();
        private Throwable error;

        @Override public void onNext(T value) { values.add(value); }
        @Override public void onError(Throwable failure) { error = failure; }
        @Override public void onCompleted() { }
    }
}
