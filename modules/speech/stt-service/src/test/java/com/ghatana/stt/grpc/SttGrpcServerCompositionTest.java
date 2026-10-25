package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.AudioVideoGrpcServerBase;
import com.ghatana.audio.video.common.observability.MetricsServerInterceptor;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.stt.core.grpc.proto.AudioChunk;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.Transcription;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import io.grpc.Metadata;
import io.grpc.stub.MetadataUtils;
import io.grpc.health.v1.HealthCheckRequest;
import io.grpc.health.v1.HealthCheckResponse;
import io.grpc.health.v1.HealthGrpc;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanBuilder;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;

import java.net.ServerSocket;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;

class SttGrpcServerCompositionTest {
    private String previousSecret;

    @BeforeEach void configureLocalAuth() {
        previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", "composition-test-only-secret-for-root-tests");
    }

    @AfterEach void restoreLocalAuth() {
        if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
        else System.setProperty("AV_JWT_SECRET", previousSecret);
    }

    @Test
    void productionRootStartsNotServingAndRecordsBoundedHealthRpcThenDrains() throws Exception {
        var metrics = new SimpleMeterRegistry();
        var library = mock(AudioVideoLibrary.class);
        var trace = new TraceHarness();
        var service = new ProductionSttGrpcService(library, metrics, trace.tracer);
        int port = freePort();
        var server = new SttGrpcServer(port, AudioVideoGrpcServerBase.TransportSecurity.plaintext(), service);
        ManagedChannel channel = null;
        try {
            server.start();
            assertThat(server.isShutdown()).isFalse();
            assertThat(server.isReady()).isFalse();
            channel = ManagedChannelBuilder.forAddress("127.0.0.1", server.getPort()).usePlaintext().build();
            AtomicReference<Metadata> responseHeaders = new AtomicReference<>();
            var result = HealthGrpc.newBlockingStub(channel)
                    .withInterceptors(MetadataUtils.newCaptureMetadataInterceptor(responseHeaders, new AtomicReference<>()))
                    .check(HealthCheckRequest.getDefaultInstance());
            assertThat(result.getStatus()).isEqualTo(HealthCheckResponse.ServingStatus.NOT_SERVING);
            assertTraceHeaders(responseHeaders.get());
            String scrape = MetricsServerInterceptor.getInstance().scrape();
            assertThat(scrape).contains("av_service_readiness{service=\"stt\"} 0")
                    .contains("grpc_server_handled_total{grpc_method=\"grpc.health.v1.Health/Check\",grpc_code=\"OK\"}");

            long before = handledCount(scrape, "com.ghatana.audio.video.stt.grpc.STTService/StreamTranscribe", "FAILED_PRECONDITION");
            Metadata auth = authenticatedHeaders();
            CountDownLatch terminal = new CountDownLatch(1);
            AtomicReference<Throwable> failure = new AtomicReference<>();
            AtomicInteger emitted = new AtomicInteger();
            var request = STTServiceGrpc.newStub(channel)
                    .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(auth))
                    .streamTranscribe(new io.grpc.stub.StreamObserver<>() {
                        @Override public void onNext(Transcription value) { emitted.incrementAndGet(); }
                        @Override public void onError(Throwable error) { failure.set(error); terminal.countDown(); }
                        @Override public void onCompleted() { terminal.countDown(); }
                    });
            request.onNext(AudioChunk.getDefaultInstance());
            request.onCompleted();
            assertThat(terminal.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(trace.spanEnded.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(emitted).hasValue(0);
            assertThat(failure.get()).isInstanceOf(io.grpc.StatusRuntimeException.class)
                    .matches(error -> io.grpc.Status.fromThrowable(error).getCode() == io.grpc.Status.Code.FAILED_PRECONDITION)
                    .hasMessageContaining("STT_STREAM_CONSENT_NOT_ADMITTED");
            assertThat(service.isProviderReady()).isFalse();
            verify(library, never()).getSttEngine();
            verify(trace.tracer).spanBuilder("audiovideo.grpc.streaming");
            verify(trace.builder).setAttribute("method.name", "StreamTranscribe");
            verify(trace.builder).setAttribute("tenant.present", true);
            verify(trace.builder, never()).setAttribute(anyString(), eq("tenant-stt-root"));
            verify(trace.span).setStatus(StatusCode.ERROR, "Media operation failed");
            verify(trace.span).setAttribute("error", true);
            verify(trace.span).end();
            assertThat(handledCount(MetricsServerInterceptor.getInstance().scrape(),
                    "com.ghatana.audio.video.stt.grpc.STTService/StreamTranscribe", "FAILED_PRECONDITION"))
                    .isEqualTo(before + 1);
        } finally {
            if (channel != null) channel.shutdownNow().awaitTermination(5, TimeUnit.SECONDS);
            server.close();
        }
        assertThat(server.isShutdown()).isTrue();
        assertThat(server.isReady()).isFalse();

        var replacement = new SttGrpcServer(port, AudioVideoGrpcServerBase.TransportSecurity.plaintext(),
                new ProductionSttGrpcService(mock(AudioVideoLibrary.class), new SimpleMeterRegistry()));
        replacement.start();
        assertThat(replacement.isShutdown()).isFalse();
        assertThat(replacement.isReady()).isFalse();
        replacement.close();
        assertThat(replacement.isShutdown()).isTrue();
    }

    @Test
    void failedGrpcBindLeavesProductionRootDownAndClosed() throws Exception {
        try (ServerSocket occupied = new ServerSocket(0)) {
            var service = new ProductionSttGrpcService(mock(AudioVideoLibrary.class), new SimpleMeterRegistry());
            var server = new SttGrpcServer(occupied.getLocalPort(),
                    AudioVideoGrpcServerBase.TransportSecurity.plaintext(), service);
            assertThatThrownBy(server::start).isInstanceOf(java.io.IOException.class);
            assertThat(server.isShutdown()).isTrue();
            assertThat(server.isReady()).isFalse();
            server.close();
        }
    }

    private static int freePort() throws Exception {
        try (ServerSocket socket = new ServerSocket(0)) { return socket.getLocalPort(); }
    }

    private static Metadata authenticatedHeaders() throws Exception {
        String secret = "composition-test-only-secret-for-root-tests";
        String header = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String payload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("{\"sub\":\"00000000-0000-0000-0000-000000000001\",\"tenantId\":\"tenant-stt-root\",\"exp\":"
                        + (System.currentTimeMillis() / 1000 + 3600) + "}")
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String unsigned = header + "." + payload;
        javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
        mac.init(new javax.crypto.spec.SecretKeySpec(secret.getBytes(java.nio.charset.StandardCharsets.UTF_8), "HmacSHA256"));
        String token = unsigned + "." + java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(unsigned.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        Metadata auth = new Metadata();
        auth.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + token);
        auth.put(Metadata.Key.of("x-roles", Metadata.ASCII_STRING_MARSHALLER), "av:user");
        return auth;
    }

    private static long handledCount(String scrape, String method, String code) {
        String prefix = "grpc_server_handled_total{grpc_method=\"" + method + "\",grpc_code=\"" + code + "\"} ";
        return scrape.lines().filter(line -> line.startsWith(prefix)).map(line -> line.substring(prefix.length()))
                .mapToLong(Long::parseLong).findFirst().orElse(0L);
    }

    private static void assertTraceHeaders(Metadata headers) {
        assertThat(headers.get(Metadata.Key.of("x-trace-id", Metadata.ASCII_STRING_MARSHALLER)))
                .matches("[0-9a-f]{32}");
        assertThat(headers.get(Metadata.Key.of("x-span-id", Metadata.ASCII_STRING_MARSHALLER)))
                .matches("[0-9a-f]{16}");
    }

    private static final class TraceHarness {
        private final Tracer tracer = mock(Tracer.class);
        private final SpanBuilder builder = mock(SpanBuilder.class);
        private final Span span = mock(Span.class);
        private final CountDownLatch spanEnded = new CountDownLatch(1);

        private TraceHarness() {
            when(tracer.spanBuilder("audiovideo.grpc.streaming")).thenReturn(builder);
            when(builder.setSpanKind(SpanKind.INTERNAL)).thenReturn(builder);
            when(builder.setAttribute(anyString(), anyBoolean())).thenReturn(builder);
            when(builder.setAttribute(anyString(), anyString())).thenReturn(builder);
            when(builder.startSpan()).thenReturn(span);
            doAnswer(invocation -> {
                spanEnded.countDown();
                return null;
            }).when(span).end();
        }
    }
}
