package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.VoiceInfo;
import com.ghatana.tts.core.grpc.proto.AudioChunk;
import com.ghatana.tts.core.grpc.proto.CloneVoiceRequest;
import com.ghatana.tts.core.grpc.proto.CloneVoiceResponse;
import com.ghatana.tts.core.grpc.proto.CloneOptions;
import com.ghatana.tts.core.grpc.proto.CreateProfileRequest;
import com.ghatana.tts.core.grpc.proto.GetProfileRequest;
import com.ghatana.tts.core.grpc.proto.PrivacyLevel;
import com.ghatana.tts.core.grpc.proto.ProfileResponse;
import com.ghatana.tts.core.grpc.proto.ProfileSettings;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeResponse;
import com.ghatana.tts.core.grpc.proto.UpdateProfileRequest;
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

import java.util.ArrayList;
import java.util.Locale;
import java.util.List;
import java.util.UUID;
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
    private AudioFileService audioFileService;

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
        streamingService  = new PersistentTtsGrpcService(library, audioFileService, new SimpleMeterRegistry());
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
    @DisplayName("test-double result exercises response mapping only; it is not provider audio")
    void testDoubleResultExercisesResponseMappingOnly() {
        UUID audioFileId = UUID.randomUUID();
        // Test-only 440 Hz PCM validates response mapping and the signal-integrity floor; it is not speech.
        byte[] audioBytes = new byte[44_100];
        for (int frame = 0; frame < audioBytes.length / 2; frame++) {
            short sample = (short) Math.round(1_000 * Math.sin(2 * Math.PI * 440 * frame / 22_050));
            audioBytes[frame * 2] = (byte) sample;
            audioBytes[frame * 2 + 1] = (byte) (sample >>> 8);
        }
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

    @Test
    @DisplayName("profile and clone RPCs report NOT_ADMITTED without provider or persistence effects")
    void voiceProfileAndCloneOperationsFailClosedWithoutAuthorizationAuthority() {
        CapturingObserver<ProfileResponse> create = new CapturingObserver<>();
        streamingService.createProfile(CreateProfileRequest.newBuilder().setDisplayName("Alice").build(), create);
        assertThat(statusCode(create)).isEqualTo(Status.UNIMPLEMENTED.getCode());
        assertThat(description(create)).contains("NOT_ADMITTED", "ownership", "consent", "purpose", "retention");

        CapturingObserver<ProfileResponse> get = new CapturingObserver<>();
        streamingService.getProfile(GetProfileRequest.newBuilder().setProfileId("profile-1").build(), get);
        assertThat(statusCode(get)).isEqualTo(Status.UNIMPLEMENTED.getCode());
        assertThat(description(get)).contains("NOT_ADMITTED", "ownership", "consent", "purpose", "retention");

        CapturingObserver<ProfileResponse> update = new CapturingObserver<>();
        streamingService.updateProfile(UpdateProfileRequest.newBuilder().setProfileId("profile-1").build(), update);
        assertThat(statusCode(update)).isEqualTo(Status.UNIMPLEMENTED.getCode());
        assertThat(description(update)).contains("NOT_ADMITTED", "ownership", "consent", "purpose", "retention");

        CapturingObserver<CloneVoiceResponse> clone = new CapturingObserver<>();
        streamingService.cloneVoice(CloneVoiceRequest.newBuilder()
                .setVoiceName("Alice")
                .addAudioSamples(com.google.protobuf.ByteString.copyFrom(new byte[256]))
                .build(), clone);
        assertThat(statusCode(clone)).isEqualTo(Status.UNIMPLEMENTED.getCode());
        assertThat(description(clone)).contains("NOT_ADMITTED", "owner consent", "biometric purpose", "retention");
        assertThat(create.values).isEmpty();
        assertThat(get.values).isEmpty();
        assertThat(update.values).isEmpty();
        assertThat(clone.values).isEmpty();
        assertThat(create.completed || get.completed || update.completed || clone.completed).isFalse();
        verifyNoInteractions(persistentTtsService, library, audioFileService, engine);
    }

    @Test
    @DisplayName("empty clone request stays NOT_ADMITTED even with authenticated tenant and principal")
    void emptyCloneRequestDoesNotReachProviderOrStorage() {
        CapturingObserver<CloneVoiceResponse> clone = new CapturingObserver<>();

        withContext(TENANT_ID, USER_ID, () -> streamingService.cloneVoice(
                CloneVoiceRequest.getDefaultInstance(), clone));

        assertThat(statusCode(clone)).isEqualTo(Status.UNIMPLEMENTED.getCode());
        assertThat(description(clone)).contains("NOT_ADMITTED", "owner consent", "biometric purpose", "retention");
        assertThat(clone.values).isEmpty();
        assertThat(clone.completed).isFalse();
        verifyNoInteractions(persistentTtsService, library, audioFileService, engine);
    }

    @Test
    @DisplayName("profile and clone payload claims never substitute for trusted tenant, owner, consent, or purpose authority")
    void profileAndCloneClaimsNeverDispatchAcrossAuthorityContexts() {
        List<String[]> contexts = List.of(
                new String[] {null, null},
                new String[] {TENANT_ID, null},
                new String[] {TENANT_ID, "not-a-principal"},
                new String[] {TENANT_ID, USER_ID});

        for (String[] auth : contexts) {
            CapturingObserver<ProfileResponse> create = new CapturingObserver<>();
            runWithAuthorityContext(auth[0], auth[1], () -> streamingService.createProfile(
                    CreateProfileRequest.newBuilder().setDisplayName("owner-consented-profile")
                            .setSettings(ProfileSettings.newBuilder().setDefaultVoiceId("voice-owner-1")
                                    .setPrivacyLevel(PrivacyLevel.PRIVACY_LEVEL_HIGH))
                            .build(), create));
            assertNotAdmittedProfile(create);

            CapturingObserver<ProfileResponse> get = new CapturingObserver<>();
            runWithAuthorityContext(auth[0], auth[1], () -> streamingService.getProfile(
                    GetProfileRequest.newBuilder().setProfileId("other-tenant-private-profile").build(), get));
            assertNotAdmittedProfile(get);

            CapturingObserver<ProfileResponse> update = new CapturingObserver<>();
            runWithAuthorityContext(auth[0], auth[1], () -> streamingService.updateProfile(
                    UpdateProfileRequest.newBuilder().setProfileId("other-tenant-private-profile")
                            .setSettings(ProfileSettings.newBuilder().setDefaultVoiceId("voice-owner-1")
                                    .setPrivacyLevel(PrivacyLevel.PRIVACY_LEVEL_HIGH))
                            .build(), update));
            assertNotAdmittedProfile(update);

            CapturingObserver<CloneVoiceResponse> clone = new CapturingObserver<>();
            runWithAuthorityContext(auth[0], auth[1], () -> streamingService.cloneVoice(
                    CloneVoiceRequest.newBuilder().setVoiceName("owner-consented-voice")
                            .addAudioSamples(com.google.protobuf.ByteString.copyFrom(new byte[256]))
                            .setOptions(CloneOptions.newBuilder().setFineTuneEpochs(1).setLearningRate(0.001f))
                            .build(), clone));
            assertThat(statusCode(clone)).isEqualTo(Status.UNIMPLEMENTED.getCode());
            assertThat(description(clone)).contains("NOT_ADMITTED", "owner consent", "biometric purpose", "retention");
            assertThat(clone.values).isEmpty();
            assertThat(clone.completed).isFalse();
        }

        // Profile/clone protobufs cannot carry authoritative owner, consent, purpose, or tenant
        // bindings. Caller-selected settings and uploaded samples therefore remain untrusted.
        verifyNoInteractions(persistentTtsService, library, audioFileService, engine);
    }

    private static void assertNotAdmittedProfile(CapturingObserver<ProfileResponse> observer) {
        assertThat(statusCode(observer)).isEqualTo(Status.UNIMPLEMENTED.getCode());
        assertThat(description(observer)).contains("NOT_ADMITTED", "tenant/principal ownership", "consent", "purpose", "retention");
        assertThat(observer.values).isEmpty();
        assertThat(observer.completed).isFalse();
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
    @DisplayName("streamSynthesize rejects missing subject before delegate or provider access")
    void streamSynthesizeFailsClosedWithoutProviderAccess() {
        CapturingObserver<AudioChunk> observer = new CapturingObserver<>();
        withContext("tenant-a", null, () ->
            streamingService.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.UNAUTHENTICATED.getCode());
        assertThat(observer.value).isNull();
        assertThat(observer.values).isEmpty();
        assertThat(observer.completed).isFalse();
        verifyNoInteractions(library, engine, audioFileService);
    }

    @Test
    @DisplayName("streamSynthesize rejects blank subject before delegate or provider access")
    void streamSynthesizeRejectsBlankSubjectBeforeProviderAccess() {
        CapturingObserver<AudioChunk> observer = new CapturingObserver<>();
        withContext("tenant-a", "   ", () ->
            streamingService.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.UNAUTHENTICATED.getCode());
        assertThat(observer.values).isEmpty();
        assertThat(observer.completed).isFalse();
        verifyNoInteractions(library, engine, audioFileService);
    }

    @Test
    @DisplayName("streamSynthesize rejects malformed subject before delegate or provider access")
    void streamSynthesizeRejectsInvalidSubjectBeforeProviderAccess() {
        CapturingObserver<AudioChunk> observer = new CapturingObserver<>();
        withContext("tenant-a", "opaque-subject", () ->
            streamingService.streamSynthesize(SynthesizeRequest.newBuilder().setText("hello").build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.UNAUTHENTICATED.getCode());
        assertThat(observer.value).isNull();
        assertThat(observer.values).isEmpty();
        assertThat(observer.completed).isFalse();
        verifyNoInteractions(library, engine, audioFileService);
    }

    @Test
    @DisplayName("persistent synthesis is NOT_ADMITTED before provider lookup or artifact persistence")
    void persistentSynthesisFailsClosedWithoutAuthorityOrArtifacts() {
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();

        withContext(TENANT_ID, USER_ID, () -> streamingService.synthesize(
                SynthesizeRequest.newBuilder().setText(TEXT).build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.UNAVAILABLE.getCode());
        assertThat(observer.value).isNull();
        verifyNoInteractions(library, engine, audioFileService);
    }

    @Test
    @DisplayName("persistent synthesis reports the exact unsupported SSML control before persistence")
    void persistentSynthesisReportsExactUnsupportedPronunciationControl() {
        CapturingObserver<SynthesizeResponse> observer = new CapturingObserver<>();
        String markup = "<speak><phoneme alphabet=\"ipa\" ph=\"həˈloʊ\">hello</phoneme></speak>";

        withContext(TENANT_ID, USER_ID, () -> synthesisService.synthesize(
                SynthesizeRequest.newBuilder().setText(markup).build(), observer));

        assertThat(statusCode(observer)).isEqualTo(Status.UNIMPLEMENTED.getCode());
        assertThat(description(observer)).isEqualTo(
                "TTS_NOT_ADMITTED: control pronunciation has no qualified effect or mapping for the admitted provider");
        verifyNoInteractions(persistentTtsService);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private static Status.Code statusCode(CapturingObserver<?> observer) {
        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        return ((StatusRuntimeException) observer.error).getStatus().getCode();
    }

    private static String description(CapturingObserver<?> observer) {
        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        return ((StatusRuntimeException) observer.error).getStatus().getDescription();
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

    private static void runWithAuthorityContext(String tenantId, String subject, Runnable action) {
        Context ctx = Context.ROOT;
        if (tenantId != null) ctx = ctx.withValue(JwtServerInterceptor.CTX_TENANT, tenantId);
        if (subject != null) ctx = ctx.withValue(JwtServerInterceptor.CTX_SUBJECT, subject);
        Context previous = ctx.attach();
        try {
            action.run();
        } finally {
            ctx.detach(previous);
        }
    }

    private static final class CapturingObserver<T> implements StreamObserver<T> {
        private T value;
        private Throwable error;
        private boolean completed;
        private final List<T> values = new ArrayList<>();

        @Override public void onNext(T v)      { this.value = v; values.add(v); }
        @Override public void onError(Throwable t) { this.error = t; }
        @Override public void onCompleted()    { this.completed = true; }
    }
}
