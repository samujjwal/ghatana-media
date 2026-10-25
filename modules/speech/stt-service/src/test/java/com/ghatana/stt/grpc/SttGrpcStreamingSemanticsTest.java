package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.stt.core.grpc.proto.AudioChunk;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.Transcription;
import com.google.protobuf.ByteString;
import io.grpc.ClientInterceptor;
import io.grpc.Context;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

class SttGrpcStreamingSemanticsTest {
    private static final String TEST_SECRET = "stt-stream-fixture-secret-not-for-production";

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

    @Test
    void authenticatedGrpcStreamWithChunksFailsBeforeEngineOrTranscript() throws Exception {
        String previousSecret = System.getProperty("AV_JWT_SECRET");
        String previousGatewayUrl = System.getProperty("AUTH_GATEWAY_URL");
        Server server = null;
        ManagedChannel channel = null;
        try {
            System.setProperty("AV_JWT_SECRET", TEST_SECRET);
            System.setProperty("AUTH_GATEWAY_URL", "");
            String tenant = "tenant-stream-test";
            String subject = "00000000-0000-0000-0000-000000000001";
            String serverName = InProcessServerBuilder.generateName();
            AudioVideoLibrary library = mock(AudioVideoLibrary.class);
            SttGrpcService service = new SttGrpcService(library, new SimpleMeterRegistry());
            server = InProcessServerBuilder.forName(serverName)
                    .directExecutor()
                    .addService(service)
                    .intercept(new JwtServerInterceptor())
                    .build()
                    .start();
            channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();

            CountDownLatch completed = new CountDownLatch(1);
            AtomicReference<Throwable> failure = new AtomicReference<>();
            List<Transcription> responses = new ArrayList<>();
            STTServiceGrpc.STTServiceStub stub = STTServiceGrpc.newStub(channel)
                    .withInterceptors(authorization(signedTestJwt(tenant, subject)));
            StreamObserver<AudioChunk> request = stub.streamTranscribe(new StreamObserver<>() {
                @Override public void onNext(Transcription value) { responses.add(value); }
                @Override public void onError(Throwable error) { failure.set(error); completed.countDown(); }
                @Override public void onCompleted() { completed.countDown(); }
            });

            request.onNext(chunk());
            request.onNext(AudioChunk.newBuilder().setSessionId("client-session").setSequence(2)
                    .setSampleRate(16_000).setTimestampMs(100)
                    .setAudioData(ByteString.copyFrom(new byte[] {5, 6, 7, 8})).build());
            request.onCompleted();

            assertThat(completed.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(failure.get()).isInstanceOf(StatusRuntimeException.class);
            assertThat(Status.fromThrowable(failure.get()).getCode()).isEqualTo(Status.FAILED_PRECONDITION.getCode());
            assertThat(Status.fromThrowable(failure.get()).getDescription()).contains("STT_STREAM_CONSENT_NOT_ADMITTED");
            assertThat(responses).isEmpty();
            verifyNoInteractions(library);
        } finally {
            if (channel != null) {
                channel.shutdownNow();
                channel.awaitTermination(2, TimeUnit.SECONDS);
            }
            if (server != null) {
                server.shutdownNow();
                server.awaitTermination(2, TimeUnit.SECONDS);
            }
            restoreProperty("AV_JWT_SECRET", previousSecret);
            restoreProperty("AUTH_GATEWAY_URL", previousGatewayUrl);
        }
    }

    private static ClientInterceptor authorization(String token) {
        Metadata metadata = new Metadata();
        metadata.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + token);
        return new ClientInterceptor() {
            @Override
            public <ReqT, RespT> io.grpc.ClientCall<ReqT, RespT> interceptCall(
                    io.grpc.MethodDescriptor<ReqT, RespT> method, io.grpc.CallOptions callOptions, io.grpc.Channel next) {
                return new io.grpc.ForwardingClientCall.SimpleForwardingClientCall<ReqT, RespT>(
                        next.newCall(method, callOptions)) {
                    @Override public void start(io.grpc.ClientCall.Listener<RespT> listener, Metadata headers) {
                        headers.merge(metadata);
                        super.start(listener, headers);
                    }
                };
            }
        };
    }

    private static String signedTestJwt(String tenant, String subject) throws GeneralSecurityException {
        String header = base64Url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        long expiresAt = System.currentTimeMillis() / 1_000 + 60;
        String payload = "{\"sub\":\"" + subject + "\",\"tenantId\":\"" + tenant
                + "\",\"exp\":" + expiresAt + "}";
        String signingInput = header + "." + base64Url(payload);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(TEST_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String signature = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.UTF_8)));
        return signingInput + "." + signature;
    }

    private static String base64Url(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static void restoreProperty(String name, String previous) {
        if (previous == null) System.clearProperty(name);
        else System.setProperty(name, previous);
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
