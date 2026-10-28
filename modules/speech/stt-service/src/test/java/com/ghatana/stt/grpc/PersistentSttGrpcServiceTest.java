package com.ghatana.stt.grpc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.google.protobuf.ByteString;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.ghatana.stt.core.grpc.proto.Transcription;
import com.ghatana.stt.core.grpc.proto.CreateProfileRequest;
import com.ghatana.stt.core.grpc.proto.GetProfileRequest;
import com.ghatana.stt.core.grpc.proto.ProfileResponse;
import com.ghatana.stt.core.grpc.proto.UpdateProfileRequest;
import com.ghatana.stt.service.PersistentSttService;
import com.ghatana.stt.testutil.VerifiedJwtContext;
import io.activej.promise.Promise;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.slf4j.MDC;

import java.time.Duration;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.TimeoutException;

@DisplayName("PersistentSttGrpcService")
@ExtendWith(MockitoExtension.class)
class PersistentSttGrpcServiceTest {

    @Mock
    private PersistentSttService persistentSttService;

    private PersistentSttGrpcService service;

    private static final ByteString AUDIO = ByteString.copyFrom(validPcmWav());
    private static final String USER_ID = "00000000-0000-0000-0000-000000000001";

    @BeforeEach
    void setUp() {
        service = new PersistentSttGrpcService(persistentSttService,
                request -> SttRequestAuthorization.Decision.ADMITTED); // Test-only authority fixture.
        MDC.clear();
    }

    @Test
    @DisplayName("default rights authority rejects malformed input before decoder or service access")
    void defaultAuthorizationPrecedesDecoderAndServiceAccess() {
        PersistentSttGrpcService unavailable = new PersistentSttGrpcService(persistentSttService);
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();

        runWithTenantContext("tenant-default", USER_ID, () -> unavailable.transcribe(
                TranscribeRequest.getDefaultInstance(), observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.error;
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(failure.getStatus().getDescription()).startsWith("STT_RIGHTS_NOT_ADMITTED:");
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        verifyNoInteractions(persistentSttService);
    }

    @Test
    @DisplayName("denied trusted owner decision precedes decoder and service access")
    void deniedAuthorizationPrecedesDecoderAndServiceAccess() {
        java.util.concurrent.atomic.AtomicReference<SttRequestAuthorization.Request> seen =
                new java.util.concurrent.atomic.AtomicReference<>();
        PersistentSttGrpcService denied = new PersistentSttGrpcService(persistentSttService, request -> {
            seen.set(request);
            return SttRequestAuthorization.Decision.DENIED;
        });
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();

        runWithTenantContext("tenant-denied", USER_ID, () -> denied.transcribe(
                TranscribeRequest.newBuilder().setArtifactId("untrusted-artifact")
                        .setAudioData(ByteString.EMPTY).build(), observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.error;
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.PERMISSION_DENIED.getCode());
        assertThat(failure.getStatus().getDescription()).startsWith("STT_RIGHTS_DENIED:");
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        assertThat(seen.get().identity().tenantId()).isEqualTo("tenant-denied");
        assertThat(seen.get().identity().subject()).isEqualTo(USER_ID);
        assertThat(seen.get().operation()).isEqualTo(SttRequestAuthorization.Operation.TRANSCRIBE);
        assertThat(seen.get().resourceId()).isEqualTo("untrusted-artifact");
        verifyNoInteractions(persistentSttService);
    }

    @Test
    @DisplayName("direct-service identity rejection maps to UNAUTHENTICATED")
    void identityRejectionMapsToUnauthenticated() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        service.reportFailure(new SecurityException("STT_IDENTITY_REQUIRED"), observer);

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.error;
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.Code.UNAUTHENTICATED);
        assertThat(failure.getStatus().getDescription()).isEqualTo("Authenticated identity required");
    }

    @Test
    @DisplayName("transcribe rejects requests without tenant context - UNAUTHENTICATED")
    void transcribeRejectsRequestsWithoutTenantContext() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        Context.current().withValue(JwtServerInterceptor.CTX_SUBJECT, USER_ID).run(() ->
                service.transcribe(TranscribeRequest.newBuilder().setAudioData(AUDIO).build(), observer));
        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
            .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(persistentSttService);
        assertThat(MDC.get("tenantId")).isNull();
        assertThat(MDC.get("userId")).isNull();
    }

    @Test
    @DisplayName("streamTranscribe remains unimplemented until authenticated runtime admission exists")
    void streamTranscribeDoesNotExposeUnauthenticatedProviderEffect() {
        CapturingObserver<Transcription> observer = new CapturingObserver<>();

        service.streamTranscribe(observer);

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
                .isEqualTo(Status.UNIMPLEMENTED.getCode());
        verifyNoInteractions(persistentSttService);
    }

    @Test
    @DisplayName("speaker profile operations fail closed before persistence access")
    void speakerProfileOperationsRequireTrustedAdmission() {
        CapturingObserver<ProfileResponse> create = new CapturingObserver<>();
        CapturingObserver<ProfileResponse> get = new CapturingObserver<>();
        CapturingObserver<ProfileResponse> update = new CapturingObserver<>();

        runWithTenantContext("tenant-test", USER_ID, () ->
                service.createProfile(CreateProfileRequest.newBuilder().addEnrollmentAudio(AUDIO).build(), create));
        runWithTenantContext("tenant-test", USER_ID, () ->
                service.getProfile(GetProfileRequest.newBuilder().setProfileId("profile").build(), get));
        runWithTenantContext("tenant-test", USER_ID, () ->
                service.updateProfile(UpdateProfileRequest.newBuilder().setProfileId("profile").build(), update));

        for (CapturingObserver<ProfileResponse> observer : java.util.List.of(create, get, update)) {
            assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
            StatusRuntimeException failure = (StatusRuntimeException) observer.error;
            assertThat(failure.getStatus().getCode()).isEqualTo(Status.FAILED_PRECONDITION.getCode());
            assertThat(failure.getStatus().getDescription()).startsWith("STT_SPEAKER_PROFILE_NOT_ADMITTED:");
        }
        verifyNoInteractions(persistentSttService);
    }

    @Test
    @DisplayName("speaker profile RPCs reject missing and invalid identity before admission or storage")
    void speakerProfileRpcIdentityPrecedesAdmission() {
        CapturingObserver<ProfileResponse> missing = new CapturingObserver<>();
        service.createProfile(CreateProfileRequest.getDefaultInstance(), missing);
        assertThat(missing.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) missing.error).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());

        CapturingObserver<ProfileResponse> invalid = new CapturingObserver<>();
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, "tenant-test")
                .withValue(JwtServerInterceptor.CTX_SUBJECT, "not-a-uuid")
                .run(() -> service.updateProfile(UpdateProfileRequest.getDefaultInstance(), invalid));
        assertThat(invalid.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) invalid.error).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(persistentSttService);
    }

    @Test
    @DisplayName("WAV and legacy raw PCM uploads validate then fail closed before provider or persistence")
    void supportedUploadShapesFailClosedBeforeProviderOrPersistence() {
        TranscribeRequest[] supportedUploads = {
            TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16_000).build(),
            // No encoding field exists: unknown bytes retain canonical mono S16LE PCM semantics.
            TranscribeRequest.newBuilder().setAudioData(ByteString.copyFrom(new byte[] {1, 2}))
                    .setLanguage("en").setSampleRate(16_000).build()
        };

        for (TranscribeRequest request : supportedUploads) {
            CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
            runWithTenantContext("tenant-abc", USER_ID, () -> service.transcribe(request, observer));
            assertTranscriptVersionNotAdmitted(observer);
        }
        verifyNoInteractions(persistentSttService);
    }

    @Test
    @DisplayName("malformed transcription requests fail validation before provider or source admission")
    void transcribeValidatesInputBeforeTranscriptVersionAdmission() {
        TranscribeRequest[] malformedRequests = {
            TranscribeRequest.getDefaultInstance(),
            TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").build(),
            TranscribeRequest.newBuilder().setAudioData(ByteString.copyFrom(new byte[] {1}))
                    .setLanguage("en").setSampleRate(16_000).build(),
            TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("xx").setSampleRate(16_000).build(),
            TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(7_999).build(),
            TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(-1).build()
        };

        for (TranscribeRequest request : malformedRequests) {
            CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
            runWithTenantContext("tenant-abc", USER_ID, () -> service.transcribe(request, observer));

            assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
            assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
                    .isEqualTo(Status.INVALID_ARGUMENT.getCode());
            assertThat(observer.value).isNull();
            assertThat(observer.completed).isFalse();
        }
        verifyNoInteractions(persistentSttService);
    }

    @Test
    @DisplayName("valid FLAC is reported as unsupported before WAV-only inspection")
    void transcribeReportsValidFlacAsNotAdmitted() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        runWithTenantContext("tenant-abc", USER_ID, () -> service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(ByteString.copyFrom(validFlacStreamInfoHeader()))
                        .setLanguage("en").setSampleRate(16_000).build(),
                observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.error;
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(failure.getStatus().getDescription()).isEqualTo("Audio input is not admitted");
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        verifyNoInteractions(persistentSttService);
    }

    @Test
    @DisplayName("malformed FLAC remains INVALID_ARGUMENT before source admission")
    void transcribeRejectsMalformedFlacHeader() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        runWithTenantContext("tenant-abc", USER_ID, () -> service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(ByteString.copyFrom(
                                new byte[] {'f', 'L', 'a', 'C', 0, 0}))
                        .setLanguage("en").setSampleRate(16_000).build(),
                observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.error;
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.INVALID_ARGUMENT.getCode());
        assertThat(failure.getStatus().getDescription()).isEqualTo("Invalid audio input");
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        verifyNoInteractions(persistentSttService);
    }

    @Test
    @DisplayName("transcribe with an artifact identifier still fails until governed version provenance exists")
    void transcribeArtifactIdFailsClosedWithoutVersionProvenance() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        runWithTenantContext("tenant-abc", USER_ID, () ->
            service.transcribe(
                TranscribeRequest.newBuilder().setArtifactId("artifact-1").setJobId("job-1")
                        .setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));
        assertTranscriptVersionNotAdmitted(observer);
    }

    @Test
    @DisplayName("transcribe does not invoke provider when source version is unavailable")
    void transcribeDoesNotInvokeProviderWithoutSourceVersion() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        runWithTenantContext("tenant-abc", USER_ID, () ->
            service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));
        assertTranscriptVersionNotAdmitted(observer);
    }

    @Test
    @DisplayName("transcribe does not claim a transcript revision from the legacy mutable entity")
    void transcribeDoesNotClaimLegacyTranscriptRevision() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        runWithTenantContext("tenant-abc", USER_ID, () ->
            service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));
        assertTranscriptVersionNotAdmitted(observer);
    }

    @Test
    @DisplayName("transcribe has no successful mutable persistence fallback")
    void transcribeHasNoMutablePersistenceFallback() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        runWithTenantContext("tenant-abc", USER_ID, () ->
            service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));
        assertTranscriptVersionNotAdmitted(observer);
    }

    @Test
    @DisplayName("transcribe rejects missing authenticated subject before any service work")
    void transcribeRejectsMissingSubjectWithoutServiceWork() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();

        Context ctx = Context.current().withValue(JwtServerInterceptor.CTX_TENANT, "tenant-xyz");
        ctx.run(() ->
            service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(persistentSttService);
        assertThat(MDC.get("tenantId")).isNull();
        assertThat(MDC.get("userId")).isNull();
    }

    @Test
    @DisplayName("transcribe rejects unsupported subject identifiers before any service work")
    void transcribeRejectsInvalidSubjectWithoutServiceWork() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();

        runWithTenantContext("tenant-xyz", "authenticated-user-42", () ->
            service.transcribe(
                TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en").setSampleRate(16000).build(),
                observer));

        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(persistentSttService);
        assertThat(MDC.get("tenantId")).isNull();
        assertThat(MDC.get("userId")).isNull();
    }

    @Test
    @DisplayName("transcribe does not treat caller tenant metadata as authenticated tenant-principal binding")
    void transcribeRejectsUntrustedTenantClaimWithoutServiceWork() {
        CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(AUDIO)
                .setSampleRate(16_000)
                .setTenantId("tenant-claimed-by-caller")
                .build();

        runWithTenantContext("tenant-from-authenticated-context", USER_ID,
                () -> service.transcribe(request, observer));

        assertTranscriptVersionNotAdmitted(observer);
        assertThat(observer.value).isNull();
        assertThat(observer.completed).isFalse();
        verifyNoInteractions(persistentSttService);
        assertThat(MDC.get("tenantId")).isNull();
        assertThat(MDC.get("userId")).isNull();
    }

    @Test
    @DisplayName("transcribe leaves caller MDC intact without adding tenant or subject identifiers")
    void transcribeDoesNotWriteRequestIdentityToMdc() {
        try {
            CapturingObserver<TranscribeResponse> observer = new CapturingObserver<>();
            runWithTenantContext("tenant-sensitive-marker", USER_ID, () -> {
                MDC.put("callerContext", "preserve-me");
                service.transcribe(
                        TranscribeRequest.newBuilder().setAudioData(AUDIO).setLanguage("en")
                                .setSampleRate(16_000).build(),
                        observer);

                assertTranscriptVersionNotAdmitted(observer);
                assertThat(MDC.get("tenantId")).isNull();
                assertThat(MDC.get("userId")).isNull();
                assertThat(MDC.get("cid")).isNull();
                assertThat(MDC.get("callerContext")).isEqualTo("preserve-me");
            });
        } finally {
            MDC.clear();
        }
    }

    private static void runWithTenantContext(String tenantId, String userId, Runnable action) {
        VerifiedJwtContext.create(tenantId, userId).run(action);
    }

    private void assertTranscriptVersionNotAdmitted(CapturingObserver<TranscribeResponse> observer) {
        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.error;
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(failure.getStatus().getDescription()).startsWith("STT_TRANSCRIPT_VERSION_NOT_ADMITTED:");
        verifyNoInteractions(persistentSttService);
    }

    private static byte[] validPcmWav() {
        byte[] wav = new byte[48];
        ByteBuffer bytes = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        putAscii(bytes, 0, "RIFF");
        bytes.putInt(4, 40);
        putAscii(bytes, 8, "WAVE");
        putAscii(bytes, 12, "fmt ");
        bytes.putInt(16, 16).putShort(20, (short) 1).putShort(22, (short) 1);
        bytes.putInt(24, 16_000).putInt(28, 32_000).putShort(32, (short) 2).putShort(34, (short) 16);
        putAscii(bytes, 36, "data");
        bytes.putInt(40, 4).putShort(44, (short) 10).putShort(46, (short) -10);
        return wav;
    }

    private static byte[] validFlacStreamInfoHeader() {
        byte[] flac = new byte[42];
        byte[] marker = "fLaC".getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(marker, 0, flac, 0, marker.length);
        flac[4] = (byte) 0x80; // Last metadata block, type STREAMINFO.
        flac[7] = 34; // STREAMINFO payload length.
        return flac;
    }

    private static void putAscii(ByteBuffer bytes, int offset, String value) {
        byte[] encoded = value.getBytes(StandardCharsets.US_ASCII);
        for (int index = 0; index < encoded.length; index++) bytes.put(offset + index, encoded[index]);
    }

    private static final class CapturingObserver<T> implements StreamObserver<T> {
        T value;
        Throwable error;
        boolean completed;

        @Override public void onNext(T v) { this.value = v; }
        @Override public void onError(Throwable t) { this.error = t; }
        @Override public void onCompleted() { this.completed = true; }
    }
}
