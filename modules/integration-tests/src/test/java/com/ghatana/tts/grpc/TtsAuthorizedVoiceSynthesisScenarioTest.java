package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeResponse;
import com.ghatana.tts.core.grpc.proto.SynthesisOptions;
import com.ghatana.tts.core.grpc.proto.TTSServiceGrpc;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.Status;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.stub.MetadataUtils;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * Source-free J-04 boundary scenario. The verified JWT and voice request are local fixtures;
 * unavailable lawful voice/provider admission must not emit audio or invoke a synthesis engine.
 */
class TtsAuthorizedVoiceSynthesisScenarioTest {
    private static final String SECRET = "j04-unavailable-voice-fixture-secret";
    private static final String TENANT = "tenant-j04-fixture";
    private static final String PRINCIPAL = "00000000-0000-0000-0000-000000000004";
    private String previousSecret;
    private AudioVideoLibrary library;
    private TtsEngine engine;
    private Server server;
    private ManagedChannel channel;

    @BeforeEach
    void startInProcessService() throws Exception {
        previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", SECRET);
        library = mock(AudioVideoLibrary.class);
        engine = mock(TtsEngine.class);
        when(library.getTtsEngine()).thenReturn(engine);

        // This constructor selects the service's explicit NOT_ADMITTED defaults: no provider
        // capability and no owner/rights/consent resolver are supplied by the test.
        TtsGrpcService service = new TtsGrpcService(library, new SimpleMeterRegistry());
        String serverName = InProcessServerBuilder.generateName();
        server = InProcessServerBuilder.forName(serverName).directExecutor()
                .addService(service).intercept(new JwtServerInterceptor()).build().start();
        channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();
    }

    @AfterEach
    void stopInProcessService() throws Exception {
        if (channel != null) {
            channel.shutdownNow();
            channel.awaitTermination(5, TimeUnit.SECONDS);
        }
        if (server != null) {
            server.shutdownNow();
            server.awaitTermination(5, TimeUnit.SECONDS);
        }
        if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
        else System.setProperty("AV_JWT_SECRET", previousSecret);
    }

    @Test
    void selectedVoiceWithoutCurrentLawfulAdmissionReturnsUnavailableWithoutAudioOrProviderEffect() throws Exception {
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                "Bearer " + jwt(TENANT, PRINCIPAL));
        TTSServiceGrpc.TTSServiceStub client = TTSServiceGrpc.newStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));
        List<SynthesizeResponse> responses = new ArrayList<>();
        List<Throwable> errors = new ArrayList<>();

        client.synthesize(SynthesizeRequest.newBuilder()
                        .setText("J-04 local negative scenario input")
                        .setVoiceId("creator-selected-unqualified-voice")
                        .setOptions(SynthesisOptions.newBuilder().setLanguage("en-US").build())
                        .build(), new StreamObserver<>() {
                    @Override public void onNext(SynthesizeResponse response) { responses.add(response); }
                    @Override public void onError(Throwable error) { errors.add(error); }
                    @Override public void onCompleted() { }
                });

        assertThat(responses).isEmpty();
        assertThat(errors).singleElement().satisfies(error -> {
            io.grpc.Status status = io.grpc.Status.fromThrowable(error);
            assertThat(status.getCode()).isEqualTo(Status.Code.UNAVAILABLE);
            assertThat(status.getDescription()).contains("TTS_VOICE_AUTH_NOT_ADMITTED");
        });
        verify(library, never()).getTtsEngine();
        verifyNoInteractions(engine);
    }

    @Test
    void profileOnlySelectionReturnsUnavailableWithoutAudioOrModelLookup() throws Exception {
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                "Bearer " + jwt(TENANT, PRINCIPAL));
        TTSServiceGrpc.TTSServiceStub client = TTSServiceGrpc.newStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));
        List<SynthesizeResponse> responses = new ArrayList<>();
        List<Throwable> errors = new ArrayList<>();

        client.synthesize(SynthesizeRequest.newBuilder()
                        .setText("J-04 unqualified profile fixture input")
                        .setProfileId("unqualified-fixture-profile")
                        .setOptions(SynthesisOptions.newBuilder().setLanguage("en-US").build())
                        .build(), new StreamObserver<>() {
                    @Override public void onNext(SynthesizeResponse response) { responses.add(response); }
                    @Override public void onError(Throwable error) { errors.add(error); }
                    @Override public void onCompleted() { }
                });

        assertThat(responses).isEmpty();
        assertThat(errors).singleElement().satisfies(error -> {
            io.grpc.Status status = io.grpc.Status.fromThrowable(error);
            assertThat(status.getCode()).isEqualTo(Status.Code.UNAVAILABLE);
        });
        verify(library, never()).getTtsEngine();
        verifyNoInteractions(engine);
    }

    private static String jwt(String tenant, String principal) throws Exception {
        String header = Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String payload = Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("{\"sub\":\"" + principal + "\",\"tenantId\":\"" + tenant
                        + "\",\"exp\":" + (System.currentTimeMillis() / 1000 + 300) + "}")
                        .getBytes(StandardCharsets.UTF_8));
        String signingInput = header + "." + payload;
        javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
        mac.init(new javax.crypto.spec.SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }
}
