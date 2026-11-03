package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.google.protobuf.ByteString;
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
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

/** Regression coverage for STT transport mapping after real JWT interceptor verification. */
class SttGrpcAuthorizationDecisionMappingTest {
    private static final String SECRET = "stt-authorization-parity-test-secret";
    private static final String SUBJECT = "00000000-0000-0000-0000-000000000001";
    private static final String TENANT = "tenant-stt-authorization-parity";

    private String previousSecret;
    private Server server;
    private ManagedChannel channel;
    private SttGrpcService service;

    @AfterEach
    void tearDown() {
        if (channel != null) channel.shutdownNow();
        if (server != null) server.shutdownNow();
        if (service != null) service.close();
        if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
        else System.setProperty("AV_JWT_SECRET", previousSecret);
    }

    @Test
    void rejectedAuthorizationDecisionsMapToGrpcFailuresAfterJwtVerification() throws Exception {
        previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", SECRET);

        AtomicReference<SttRequestAuthorization.Request> requestSeenByTransport = new AtomicReference<>();
        AtomicReference<SttRequestAuthorization.Decision> decision =
                new AtomicReference<>(SttRequestAuthorization.Decision.UNAVAILABLE);
        // Deterministic fixtures exercise fail-closed transport mapping only; they do not claim
        // provider rights, model quality, or an external authority decision.
        SttRequestAuthorization decisionFixture = request -> {
            requestSeenByTransport.set(request);
            return decision.get();
        };
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        service = new SttGrpcService(library, new SimpleMeterRegistry(), decisionFixture);

        String serverName = InProcessServerBuilder.generateName();
        server = InProcessServerBuilder.forName(serverName)
                .directExecutor()
                .addService(service)
                .intercept(new JwtServerInterceptor())
                .build()
                .start();
        channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();

        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                "Bearer " + signedJwt(SECRET, TENANT));
        STTServiceGrpc.STTServiceBlockingStub stub = STTServiceGrpc.newBlockingStub(channel)
                .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers));
        TranscribeRequest grpcRequest = TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1, 2, 3, 4}))
                .setSampleRate(16_000)
                .setArtifactId("artifact-fixture")
                .build();

        for (SttRequestAuthorization.Decision rejectedDecision : List.of(
                SttRequestAuthorization.Decision.DENIED,
                SttRequestAuthorization.Decision.REVOKED,
                SttRequestAuthorization.Decision.UNAVAILABLE)) {
            decision.set(rejectedDecision);
            requestSeenByTransport.set(null);
            AtomicReference<StatusRuntimeException> transportFailure = new AtomicReference<>();
            assertThatThrownBy(() -> stub.transcribe(grpcRequest))
                    .isInstanceOf(StatusRuntimeException.class)
                    .satisfies(error -> transportFailure.set((StatusRuntimeException) error));

            SttRequestAuthorization.Request capturedRequest = requestSeenByTransport.get();
            assertThat(capturedRequest).as("transport must reach domain authorization after JWT verification")
                    .isNotNull();
            JwtServerInterceptor.VerifiedIdentity verifiedIdentity = capturedRequest.identity();
            assertThat(verifiedIdentity.subject()).isEqualTo(SUBJECT);
            assertThat(verifiedIdentity.tenantId()).isEqualTo(TENANT);
            assertThat(capturedRequest.operation()).isEqualTo(SttRequestAuthorization.Operation.TRANSCRIBE);
            assertThat(capturedRequest.resourceId()).isEqualTo("artifact-fixture");

            StatusRuntimeException grpcFailure = transportFailure.get();
            Status.Code expectedCode = rejectedDecision == SttRequestAuthorization.Decision.UNAVAILABLE
                    ? Status.Code.FAILED_PRECONDITION : Status.Code.PERMISSION_DENIED;
            String expectedName = switch (rejectedDecision) {
                case DENIED -> "STT_RIGHTS_DENIED";
                case REVOKED -> "STT_RIGHTS_REVOKED";
                case UNAVAILABLE -> "STT_RIGHTS_NOT_ADMITTED";
                case ADMITTED -> throw new IllegalArgumentException("admitted is not a rejected decision");
            };
            String expectedDetail = rejectedDecision == SttRequestAuthorization.Decision.UNAVAILABLE
                    ? "trusted rights and ownership authority is unavailable"
                    : "trusted rights and ownership policy denied the request";
            assertThat(grpcFailure.getStatus().getCode()).isEqualTo(expectedCode);
            assertThat(grpcFailure.getStatus().getDescription()).isEqualTo(expectedName + ": " + expectedDetail);
        }
        verifyNoInteractions(library);
    }

    private static String signedJwt(String secret, String tenant) throws Exception {
        String header = Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String payload = Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("{\"sub\":\"" + SUBJECT + "\",\"tenantId\":\"" + tenant + "\",\"exp\":"
                        + (System.currentTimeMillis() / 1000 + 3600) + "}").getBytes(StandardCharsets.UTF_8));
        String unsigned = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return unsigned + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(unsigned.getBytes(StandardCharsets.UTF_8)));
    }
}
