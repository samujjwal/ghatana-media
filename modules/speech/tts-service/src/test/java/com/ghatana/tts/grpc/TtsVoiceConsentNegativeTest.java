package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.AudioVideoLibrary;
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
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
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
        assertError(() -> blocking.synthesize(SynthesizeRequest.newBuilder()
                        .setText("hello").setVoiceId("owner-voice").build()),
                Status.Code.PERMISSION_DENIED, "TTS_VOICE_AUTH_DENIED");
        assertThat(observed).extracting(r -> r.identity().subject()).containsExactly(OWNER_SUBJECT);
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
        assertError(() -> blocking.synthesize(SynthesizeRequest.newBuilder()
                        .setText("hello").setVoiceId("narration-only-voice").build()),
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
        assertError(() -> blocking.synthesize(SynthesizeRequest.newBuilder()
                        .setText("hello").setVoiceId("revoked-voice").build()),
                Status.Code.PERMISSION_DENIED, "TTS_VOICE_AUTH_REVOKED");
        assertError(() -> blocking.synthesize(SynthesizeRequest.newBuilder()
                        .setText("hello again").setVoiceId("revoked-voice").build()),
                Status.Code.PERMISSION_DENIED, "TTS_VOICE_AUTH_REVOKED");
        verifyNoInteractions(guardedLibrary, engine);
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
        Map<String, String> environment = Map.ofEntries(
                Map.entry("TTS_PROVIDER_MODE", "LOCAL_ONNX"),
                Map.entry("TTS_MODEL_ID", "fixture-model"),
                Map.entry("TTS_MODEL_VERSION", "fixture-version"),
                Map.entry("TTS_MODEL_SHA256", digest),
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
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                "Bearer " + jwt(subject, "tenant-test"));
        return TTSServiceGrpc.newBlockingStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));
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
}
