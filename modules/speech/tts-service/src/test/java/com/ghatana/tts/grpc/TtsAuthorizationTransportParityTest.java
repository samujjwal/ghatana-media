package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.AudioVideoLibrary;
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
import org.junit.jupiter.api.Test;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/** Regression for CT-02: direct and gRPC TTS authorization outcomes stay aligned. */
class TtsAuthorizationTransportParityTest {

    private static final String JWT_SECRET = "tts-ct02-transport-parity-test-secret";
    private static final String SUBJECT = "ct02-subject";
    private static final String TENANT = "ct02-tenant";
    private static final String VOICE_ID = "fixture-voice";

    private String previousJwtSecret;
    private Server server;
    private ManagedChannel channel;
    private TtsGrpcService service;

    @AfterEach
    void tearDown() {
        if (channel != null) channel.shutdownNow();
        if (server != null) server.shutdownNow();
        if (service != null) service.close();
        if (previousJwtSecret == null) System.clearProperty("AV_JWT_SECRET");
        else System.setProperty("AV_JWT_SECRET", previousJwtSecret);
    }

    @Test
    void directAndTransportAuthorizationHaveSameUnavailableStatus() throws Exception {
        previousJwtSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", JWT_SECRET);

        AtomicReference<JwtServerInterceptor.VerifiedIdentity> interceptedIdentity =
                new AtomicReference<>();
        TtsRequestAuthorization transportFixture = new TtsRequestAuthorization() {
            @Override
            public Decision authorize(Request request) {
                interceptedIdentity.set(request.identity());
                return Decision.UNAVAILABLE;
            }
        };
        service = new TtsGrpcService(
                org.mockito.Mockito.mock(AudioVideoLibrary.class),
                new SimpleMeterRegistry(),
                () -> true,
                () -> false,
                null,
                transportFixture,
                (voiceId, language) -> true);

        String serverName = InProcessServerBuilder.generateName();
        server = InProcessServerBuilder.forName(serverName).directExecutor()
                .addService(service)
                .intercept(new JwtServerInterceptor())
                .build()
                .start();
        channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();

        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                "Bearer " + signedJwt(SUBJECT, TENANT));
        var stub = TTSServiceGrpc.newBlockingStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));
        SynthesizeRequest request = SynthesizeRequest.newBuilder()
                .setText("fixture request")
                .setVoiceId(VOICE_ID)
                .build();

        Status transportStatus;
        try {
            stub.synthesize(request);
            throw new AssertionError("unavailable authorization fixture must fail closed");
        } catch (StatusRuntimeException failure) {
            transportStatus = failure.getStatus();
        }

        JwtServerInterceptor.VerifiedIdentity identity = interceptedIdentity.get();
        assertThat(identity).isNotNull();

        Status directStatus;
        try {
            TtsRequestAuthorization.requireAdmission(
                    transportFixture, identity,
                    TtsRequestAuthorization.Operation.SYNTHESIZE, VOICE_ID, null);
            throw new AssertionError("unavailable authorization must fail closed");
        } catch (TtsRequestAuthorization.AuthorizationException failure) {
            directStatus = failure.status();
        }

        assertThat(transportStatus.getCode()).isEqualTo(directStatus.getCode());
        assertThat(transportStatus.getDescription()).isEqualTo(directStatus.getDescription());
    }

    private static String signedJwt(String subject, String tenantId) throws Exception {
        Base64.Encoder encoder = Base64.getUrlEncoder().withoutPadding();
        String header = encoder.encodeToString(
                "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String payload = encoder.encodeToString(("{\"sub\":\"" + subject
                + "\",\"tenantId\":\"" + tenantId + "\",\"exp\":"
                + (System.currentTimeMillis() / 1000 + 3600) + "}").getBytes(StandardCharsets.UTF_8));
        String unsigned = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(JWT_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return unsigned + "." + encoder.encodeToString(mac.doFinal(unsigned.getBytes(StandardCharsets.UTF_8)));
    }
}
