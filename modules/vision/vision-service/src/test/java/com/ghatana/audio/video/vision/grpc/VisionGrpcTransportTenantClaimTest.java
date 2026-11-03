package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.grpc.proto.DetectRequest;
import com.ghatana.audio.video.vision.grpc.proto.DetectResponse;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceGrpc;
import com.ghatana.audio.video.vision.model.DetectedObject;
import com.ghatana.audio.video.vision.model.DetectionOptions;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.google.protobuf.ByteString;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.Mockito.mock;

/** Exercises the Vision RPC through the real server authentication interceptor. */
class VisionGrpcTransportTenantClaimTest {

    private static final String TEST_SECRET = "vision-transport-fixture-secret-not-for-production";

    @Test
    void callerTenantAndPurposeMetadataCannotReplaceMissingSignedJwtTenantClaim() throws Exception {
        String previousSecret = System.getProperty("AV_JWT_SECRET");
        String environmentSecret = System.getenv("AV_JWT_SECRET");
        String signingSecret = environmentSecret == null || environmentSecret.isBlank()
                ? TEST_SECRET : environmentSecret;
        Server server = null;
        ManagedChannel channel = null;
        try {
            if (environmentSecret == null || environmentSecret.isBlank()) {
                System.setProperty("AV_JWT_SECRET", signingSecret);
            }

            var detector = new RecordingDetector();
            EntryTrackingVisionGrpcService service = new EntryTrackingVisionGrpcService(
                    detector, mock(VideoFrameExtractor.class));
            String serverName = InProcessServerBuilder.generateName();
            server = InProcessServerBuilder.forName(serverName)
                    .directExecutor()
                    .addService(service)
                    .intercept(new JwtServerInterceptor())
                    .build()
                    .start();
            channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();

            Metadata callerMetadata = new Metadata();
            callerMetadata.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                    "Bearer " + signedJwtWithoutTenant(signingSecret));
            callerMetadata.put(Metadata.Key.of("x-tenant-id", Metadata.ASCII_STRING_MARSHALLER),
                    "tenant-from-untrusted-metadata");
            callerMetadata.put(Metadata.Key.of("x-processing-purpose", Metadata.ASCII_STRING_MARSHALLER),
                    "caller-asserted-purpose");

            VisionServiceGrpc.VisionServiceBlockingStub stub = VisionServiceGrpc.newBlockingStub(channel)
                    .withInterceptors(metadataInterceptor(callerMetadata));
            Throwable failure = catchThrowable(() -> stub.detectObjects(DetectRequest.newBuilder()
                    .setImageData(ByteString.copyFrom(new byte[] {1, 2, 3}))
                    .build()));

            assertThat(failure).isInstanceOf(StatusRuntimeException.class);
            Status status = Status.fromThrowable(failure);
            assertThat(status.getCode()).isEqualTo(Status.Code.UNAUTHENTICATED);
            assertThat(status.getDescription()).isEqualTo("Missing tenant claim");
            assertThat(service.methodEntries.get()).isZero();
            assertThat(detector.calls.get()).isZero();
        } finally {
            if (channel != null) {
                channel.shutdownNow();
                channel.awaitTermination(2, java.util.concurrent.TimeUnit.SECONDS);
            }
            if (server != null) {
                server.shutdownNow();
                server.awaitTermination(2, java.util.concurrent.TimeUnit.SECONDS);
            }
            restoreProperty("AV_JWT_SECRET", previousSecret);
        }
    }

    private static io.grpc.ClientInterceptor metadataInterceptor(Metadata metadata) {
        return new io.grpc.ClientInterceptor() {
            @Override
            public <ReqT, RespT> io.grpc.ClientCall<ReqT, RespT> interceptCall(
                    io.grpc.MethodDescriptor<ReqT, RespT> method,
                    io.grpc.CallOptions callOptions,
                    io.grpc.Channel next) {
                return new io.grpc.ForwardingClientCall.SimpleForwardingClientCall<>(next.newCall(method, callOptions)) {
                    @Override
                    public void start(io.grpc.ClientCall.Listener<RespT> listener, Metadata headers) {
                        headers.merge(metadata);
                        super.start(listener, headers);
                    }
                };
            }
        };
    }

    private static String signedJwtWithoutTenant(String secret) throws GeneralSecurityException {
        String header = base64Url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        long expiresAt = System.currentTimeMillis() / 1_000 + 60;
        String payload = "{\"sub\":\"vision-transport-test-subject\",\"exp\":" + expiresAt + "}";
        String signingInput = header + "." + base64Url(payload);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String signature = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.UTF_8)));
        return signingInput + "." + signature;
    }

    private static String base64Url(String value) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static void restoreProperty(String name, String previous) {
        if (previous == null) {
            System.clearProperty(name);
        } else {
            System.setProperty(name, previous);
        }
    }

    private static final class RecordingDetector implements VisionDetector {
        private final AtomicInteger calls = new AtomicInteger();

        @Override
        public java.util.List<DetectedObject> detectObjects(byte[] imageData, DetectionOptions options) {
            calls.incrementAndGet();
            return java.util.List.of();
        }

        @Override
        public boolean isInitialized() {
            return true;
        }
    }

    private static final class EntryTrackingVisionGrpcService extends VisionGrpcService {
        private final AtomicInteger methodEntries = new AtomicInteger();

        private EntryTrackingVisionGrpcService(RecordingDetector detector,
                                               VideoFrameExtractor frameExtractor) {
            super(detector, frameExtractor);
        }

        @Override
        public void detectObjects(DetectRequest request,
                                  io.grpc.stub.StreamObserver<DetectResponse> responseObserver) {
            methodEntries.incrementAndGet();
            super.detectObjects(request, responseObserver);
        }
    }
}
