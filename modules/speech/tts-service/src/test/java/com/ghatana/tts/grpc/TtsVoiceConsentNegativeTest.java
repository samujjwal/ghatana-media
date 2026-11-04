package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.tts.core.grpc.proto.CloneVoiceRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.TTSServiceGrpc;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.stub.MetadataUtils;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.any;
import static org.mockito.Mockito.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * TTS-05 (W2-R06) consent negatives: voice ownership, purpose, clone and revocation
 * denials must occur before any synthesis, output, or embedding reuse — no voice
 * model is required to prove the pre-effect gates.
 */
@DisplayName("TTS-05 voice consent negatives before any synthesis effect")
class TtsVoiceConsentNegativeTest {

    private static final String SECRET = "tts-voice-consent-negative-secret";
    private static final String OWNER_SUBJECT = "00000000-0000-0000-0000-000000000001";
    private static final String OTHER_SUBJECT = "00000000-0000-0000-0000-000000000099";

    private String previousSecret;
    private Path model;
    private Path sidecar;
    private AudioVideoLibrary guardedLibrary;
    private TtsEngine engine;
    private Server server;
    private ManagedChannel channel;
    private ProductionTtsGrpcService service;
    private List<TtsRequestAuthorization.Request> observed;

    @BeforeEach
    void setUp() throws Exception {
        previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", SECRET);
        model = Files.createTempFile(Path.of(".").toAbsolutePath().normalize(),
                "tts-consent-fixture", ".onnx");
        sidecar = Path.of(model.toString() + ".json");
        Files.writeString(model, "voice consent negative fixture bytes");
        Files.writeString(sidecar, "{\"phoneme_id_map\":{\"^\":[1],\"$\":[2],\"_\":[0]}}\n");
        guardedLibrary = mock(AudioVideoLibrary.class);
        engine = mock(TtsEngine.class);
        when(guardedLibrary.getTtsEngine()).thenReturn(engine);
        observed = new CopyOnWriteArrayList<>();
    }

    @AfterEach
    void tearDown() throws Exception {
        if (channel != null) channel.shutdownNow();
        if (server != null) server.shutdownNow();
        if (service != null) service.close();
        Files.deleteIfExists(sidecar);
        Files.deleteIfExists(model);
        if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
        else System.setProperty("AV_JWT_SECRET", previousSecret);
    }

    @Test
    @DisplayName("wrong principal cannot synthesize another owner's voice before any effect")
    void foreignPrincipalVoiceIsDeniedBeforeSynthesis() throws Exception {
        // The admitted profile voice is owned by OTHER_SUBJECT; the verified caller is
        // OWNER_SUBJECT, so the owner-consent resolver denies before any provider effect.
        start(request -> {
            if (!OTHER_SUBJECT.equals(request.identity().subject())) {
                return TtsRequestAuthorization.Decision.DENIED;
            }
            return TtsRequestAuthorization.Decision.ADMITTED;
        }, "owner-voice");

        var blocking = stub(OWNER_SUBJECT);
        assertError(() -> blocking.synthesize(synthesisRequest("hello", "owner-voice")),
                Status.Code.PERMISSION_DENIED, "TTS_VOICE_AUTH_DENIED");
        assertThat(observed).extracting(r -> r.identity().subject()).containsExactly(OWNER_SUBJECT);
        verifyNoInteractions(guardedLibrary, engine);
    }

    @Test
    @DisplayName("same principal in another tenant cannot reuse a tenant-owned voice")
    void foreignTenantVoiceIsDeniedBeforeSynthesis() throws Exception {
        start(request -> "tenant-owner".equals(request.identity().tenantId())
                && OWNER_SUBJECT.equals(request.identity().subject())
                ? TtsRequestAuthorization.Decision.ADMITTED
                : TtsRequestAuthorization.Decision.DENIED, "tenant-owned-voice");

        var blocking = stub(OWNER_SUBJECT, "tenant-attacker");
        assertError(() -> blocking.synthesize(synthesisRequest("hello", "tenant-owned-voice")),
                Status.Code.PERMISSION_DENIED, "TTS_VOICE_AUTH_DENIED");
        assertThat(observed).singleElement().satisfies(request -> {
            assertThat(request.identity().subject()).isEqualTo(OWNER_SUBJECT);
            assertThat(request.identity().tenantId()).isEqualTo("tenant-attacker");
        });
        verifyNoInteractions(guardedLibrary, engine);
    }

    @Test
    @DisplayName("purpose-restricted voice denies a mismatched purpose before synthesis")
    void purposeRestrictedVoiceIsDeniedBeforeSynthesis() throws Exception {
        // The voice is registered for streaming narration only; a one-shot SYNTHESIZE
        // operation outside its registered purpose is denied before the provider runs.
        start(request -> request.operation() == TtsRequestAuthorization.Operation.SYNTHESIZE
                && "narration-only-voice".equals(request.voiceId())
                ? TtsRequestAuthorization.Decision.DENIED
                : TtsRequestAuthorization.Decision.ADMITTED, "narration-only-voice");

        var blocking = stub(OWNER_SUBJECT);
        assertError(() -> blocking.synthesize(synthesisRequest("hello", "narration-only-voice")),
                Status.Code.PERMISSION_DENIED, "TTS_VOICE_AUTH_DENIED");
        verifyNoInteractions(guardedLibrary, engine);
    }

    @Test
    @DisplayName("revoked voice produces no reused embedding, output, or provider effect")
    void revokedVoiceProducesNoOutputOrReusedEmbedding() throws Exception {
        // The profile existed but is revoked; neither synthesis nor a cached voice
        // embedding may be reused for a new request.
        start(request -> "revoked-voice".equals(request.voiceId())
                ? TtsRequestAuthorization.Decision.REVOKED
                : TtsRequestAuthorization.Decision.ADMITTED, "revoked-voice");

        var blocking = stub(OWNER_SUBJECT);
        assertError(() -> blocking.synthesize(synthesisRequest("hello", "revoked-voice")),
                Status.Code.PERMISSION_DENIED, "TTS_VOICE_AUTH_REVOKED");
        assertError(() -> blocking.synthesize(synthesisRequest("hello again", "revoked-voice")),
                Status.Code.PERMISSION_DENIED, "TTS_VOICE_AUTH_REVOKED");
        verifyNoInteractions(guardedLibrary, engine);
    }

    @Test
    @DisplayName("authority-reported expired consent denies before synthesis or provider reuse")
    void authorityReportsExpiredConsentAsRevokedBeforeSynthesis() throws Exception {
        // Expiry is evaluated by the owner authority; Media must honor its current
        // REVOKED decision instead of letting a prior grant or profile override it.
        start(request -> "expired-voice".equals(request.voiceId())
                ? TtsRequestAuthorization.Decision.REVOKED
                : TtsRequestAuthorization.Decision.ADMITTED, "expired-voice");

        var blocking = stub(OWNER_SUBJECT);
        assertError(() -> blocking.synthesize(synthesisRequest("hello", "expired-voice")),
                Status.Code.PERMISSION_DENIED, "TTS_VOICE_AUTH_REVOKED");
        verifyNoInteractions(guardedLibrary, engine);
    }

    @Test
    @DisplayName("revocation after an admitted synthesis prevents the next provider effect")
    void revocationAfterAdmittedSynthesisBlocksRetryBeforeProvider() throws Exception {
        AtomicReference<TtsRequestAuthorization.Decision> decision =
                new AtomicReference<>(TtsRequestAuthorization.Decision.ADMITTED);
        start(request -> decision.get(), "admitted-voice");
        when(engine.synthesize(eq("hello"), any())).thenReturn(validPcmOutput());
        var blocking = stub(OWNER_SUBJECT);
        var request = synthesisRequest("hello", "admitted-voice");

        var first = blocking.synthesize(request);
        assertThat(first.getAudioData()).hasSize(128);
        // A successful request is authorized at ingress and rechecked immediately
        // before provider dispatch, so queued work cannot outlive its rights snapshot.
        assertThat(observed).hasSize(2);

        // The resolver models a live authority read: revocation becomes effective
        // between independent requests and cannot rely on a cached previous grant.
        decision.set(TtsRequestAuthorization.Decision.REVOKED);
        assertError(() -> blocking.synthesize(request),
                Status.Code.PERMISSION_DENIED, "TTS_VOICE_AUTH_REVOKED");

        // The revoked retry is denied at ingress and never reaches the dispatch recheck.
        assertThat(observed).hasSize(3);
        verify(engine).synthesize(eq("hello"), any());
    }

    @Test
    @DisplayName("clone attempt is denied before any owner consent or biometric effect")
    void cloneAttemptDeniedBeforeEffect() throws Exception {
        start(request -> TtsRequestAuthorization.Decision.ADMITTED, "default-voice");

        var blocking = stub(OWNER_SUBJECT);
        assertError(() -> blocking.cloneVoice(CloneVoiceRequest.newBuilder()
                        .setVoiceName("impersonation-target").build()),
                Status.Code.UNIMPLEMENTED, "NOT_ADMITTED");
        assertThat(observed).isEmpty();
        verifyNoInteractions(guardedLibrary, engine);
    }

    // ── Fixtures ────────────────────────────────────────────────────────────

    private void start(TtsRequestAuthorization resolver, String admittedVoice) throws Exception {
        observed.clear();
        TtsRequestAuthorization recording = request -> {
            observed.add(request);
            return resolver.authorize(request);
        };
        String digest = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(model)));
        String sidecarDigest = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(sidecar)));
        Map<String, String> environment = Map.ofEntries(
                Map.entry("TTS_PROVIDER_MODE", "LOCAL_ONNX"),
                Map.entry("TTS_MODEL_ID", "fixture-model"),
                Map.entry("TTS_MODEL_VERSION", "fixture-version"),
                Map.entry("TTS_MODEL_SHA256", digest),
                Map.entry("TTS_VOICE_SIDECAR_SHA256", sidecarDigest),
                Map.entry("TTS_MODEL_LICENSE", "test-fixture-placeholder"),
                Map.entry("TTS_MODEL_LANGUAGE", "en-US"),
                Map.entry("TTS_MODEL_REGION", "test-fixture-region"),
                Map.entry("TTS_MODEL_RETENTION", "test-fixture-placeholder"),
                Map.entry("TTS_MODEL_HARDWARE", "test-fixture-hardware"),
                Map.entry("TTS_MODEL_PATH", model.toString()),
                Map.entry("TTS_DEFAULT_VOICE", admittedVoice));
        TtsProviderAdmission providerFixture = candidate -> new TtsProviderAdmission.Decision(
                Set.of(TtsProviderAdmission.Capability.SYNTHESIS,
                        TtsProviderAdmission.Capability.PCM_STREAMING),
                "consent-negative-fixture:test-only", "controlled test fixture");
        service = new ProductionTtsGrpcService(
                environment, new SimpleMeterRegistry(), providerFixture, recording,
                (TtsConfig ignored) -> guardedLibrary);
        // Construction itself touches the library mock; the assertions cover RPC-time
        // effects only, so construction-time invocations are cleared here.
        org.mockito.Mockito.clearInvocations(guardedLibrary, engine);
        String name = InProcessServerBuilder.generateName();
        server = InProcessServerBuilder.forName(name).directExecutor()
                .addService(service).intercept(new JwtServerInterceptor()).build().start();
        channel = InProcessChannelBuilder.forName(name).directExecutor().build();
    }

    private TTSServiceGrpc.TTSServiceBlockingStub stub(String subject) throws Exception {
        return stub(subject, "tenant-test");
    }

    private TTSServiceGrpc.TTSServiceBlockingStub stub(String subject, String tenantId) throws Exception {
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                "Bearer " + jwt(subject, tenantId));
        return TTSServiceGrpc.newBlockingStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));
    }

    private static SynthesizeRequest synthesisRequest(String text, String voiceId) {
        return SynthesizeRequest.newBuilder()
                .setText(text)
                .setVoiceId(voiceId)
                .setOptions(com.ghatana.tts.core.grpc.proto.SynthesisOptions.newBuilder()
                        .setLanguage("en-US").build())
                .build();
    }

    private static void assertError(Runnable rpc, Status.Code code, String messagePart) {
        assertThatThrownBy(rpc::run)
                .isInstanceOf(StatusRuntimeException.class)
                .satisfies(error -> {
                    StatusRuntimeException status = (StatusRuntimeException) error;
                    assertThat(status.getStatus().getCode()).isEqualTo(code);
                    assertThat(status.getStatus().getDescription()).contains(messagePart);
                });
    }

    private static String jwt(String subject, String tenantId) throws Exception {
        String header = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String payload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("{\"sub\":\"" + subject + "\",\"tenantId\":\"" + tenantId + "\",\"exp\":"
                        + (System.currentTimeMillis() / 1000 + 3600) + "}")
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String unsigned = header + "." + payload;
        javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
        mac.init(new javax.crypto.spec.SecretKeySpec(
                SECRET.getBytes(java.nio.charset.StandardCharsets.UTF_8), "HmacSHA256"));
        return unsigned + "." + java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(unsigned.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    private static AudioData validPcmOutput() {
        byte[] pcm = new byte[128];
        for (int i = 0; i < pcm.length; i += 2) {
            short sample = (short) ((i / 2 % 2 == 0) ? 1_000 : -1_000);
            pcm[i] = (byte) sample;
            pcm[i + 1] = (byte) (sample >>> 8);
        }
        return new AudioData(pcm, 22_050, 1, 16, java.time.Duration.ofMillis(3), AudioFormat.PCM);
    }
}
