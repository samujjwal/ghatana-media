package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.audio.video.common.observability.TracingServerInterceptor;
import com.ghatana.audio.video.multimodal.adapter.GrpcSttClientAdapter;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import io.grpc.Server;
import io.grpc.ServerBuilder;
import io.grpc.Status;
import io.grpc.stub.ServerCallStreamObserver;
import io.grpc.stub.StreamObserver;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.baggage.Baggage;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class MultimodalAnalysisEngineGrpcTracingTest {
    private static final String CLIENT_SPAN_NAME =
            "com.ghatana.audio.video.stt.grpc.STTService/Transcribe";
    private static final String PRIVATE_PROVIDER_MARKER = "private-provider-detail-marker";
    private static final String PRIVATE_TRANSCRIPT_MARKER = "private-transcript-marker";
    private static final String PRIVATE_TENANT_MARKER = "private-tenant-marker";
    private static final String PRIVATE_BAGGAGE_MARKER = "private-baggage-marker";

    private InMemorySpanExporter exporter;
    private SdkTracerProvider tracerProvider;
    private Server server;
    private GrpcSttClientAdapter adapter;

    @AfterEach
    void cleanup() throws Exception {
        if (adapter != null) adapter.close();
        if (server != null) {
            server.shutdownNow();
            server.awaitTermination(5, TimeUnit.SECONDS);
        }
        if (tracerProvider != null) tracerProvider.close();
        if (exporter != null) exporter.close();
        GlobalOpenTelemetry.resetForTest();
    }

    @Test
    void asyncEngineChildPropagatesTraceAndRedactsGenericSttFailure() throws Exception {
        OpenTelemetrySdk telemetry = installTelemetry();
        server = startServer(new STTServiceGrpc.STTServiceImplBase() {
            @Override
            public void transcribe(
                    com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                    StreamObserver<TranscribeResponse> observer) {
                observer.onError(Status.UNAVAILABLE
                        .withDescription(PRIVATE_PROVIDER_MARKER)
                        .asRuntimeException());
            }
        });
        adapter = GrpcSttClientAdapter.forLocalTesting(
                "127.0.0.1", server.getPort(), GrpcSttClientAdapter.SttMode.GRPC);

        Span root = telemetry.getTracer("media.multimodal.tracing.test")
                .spanBuilder("multimodal.failure.root").startSpan();
        MultimodalResult result;
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new SttGateway(adapter), AudioVideoRuntimeSettings.defaults(), TimeUnit.SECONDS.toNanos(5))) {
            Context caller = Context.current().with(root).with(Baggage.builder()
                    .put("tenant", PRIVATE_TENANT_MARKER)
                    .put("secret", PRIVATE_BAGGAGE_MARKER)
                    .build());
            try (Scope ignored = caller.makeCurrent()) {
                result = engine.analyse(MultimodalRequest.builder()
                        .audioData(PRIVATE_TRANSCRIPT_MARKER.getBytes(StandardCharsets.UTF_8))
                        .build());
                assertThat(Span.current().getSpanContext().getSpanId())
                        .isEqualTo(root.getSpanContext().getSpanId());
            }
            assertThat(Span.current().getSpanContext().isValid()).isFalse();
        }
        root.end();

        assertThat(result.getOutcome()).isEqualTo(MultimodalResult.Outcome.FAILED);
        assertThat(result.getAudioResult().isError()).isTrue();
        assertThat(result.getAudioResult().getError()).isEqualTo("Audio transcription unavailable");
        List<SpanData> spans = awaitFinishedSpans(3);
        assertTraceTree(spans, root, Status.UNAVAILABLE.getCode().name());
        assertNoPrivateTelemetry(spans);
    }

    @Test
    void engineDeadlineCancelsSttGrpcCallAndClosesTraces() throws Exception {
        OpenTelemetrySdk telemetry = installTelemetry();
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch providerCancelled = new CountDownLatch(1);
        server = startServer(new STTServiceGrpc.STTServiceImplBase() {
            @Override
            public void transcribe(
                    com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                    StreamObserver<TranscribeResponse> observer) {
                ServerCallStreamObserver<TranscribeResponse> serverObserver =
                        (ServerCallStreamObserver<TranscribeResponse>) observer;
                serverObserver.setOnCancelHandler(providerCancelled::countDown);
                providerStarted.countDown();
            }
        });
        adapter = GrpcSttClientAdapter.forLocalTesting(
                "127.0.0.1", server.getPort(), GrpcSttClientAdapter.SttMode.GRPC);

        Span root = telemetry.getTracer("media.multimodal.tracing.test")
                .spanBuilder("multimodal.cancel.root").startSpan();
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(
                new SttGateway(adapter), AudioVideoRuntimeSettings.defaults(), TimeUnit.MILLISECONDS.toNanos(500))) {
            Context caller = Context.current().with(root).with(Baggage.builder()
                    .put("tenant", PRIVATE_TENANT_MARKER)
                    .put("secret", PRIVATE_BAGGAGE_MARKER)
                    .build());
            try (Scope ignored = caller.makeCurrent()) {
                org.assertj.core.api.Assertions.assertThatThrownBy(() -> engine.analyse(
                                MultimodalRequest.builder()
                                        .audioData(PRIVATE_TRANSCRIPT_MARKER.getBytes(StandardCharsets.UTF_8))
                                        .build()))
                        .isInstanceOf(MultimodalException.class)
                        .hasMessage("Analysis outcome unavailable: deadline exceeded");
                assertThat(Span.current().getSpanContext().getSpanId())
                        .isEqualTo(root.getSpanContext().getSpanId());
            }
            assertThat(Span.current().getSpanContext().isValid()).isFalse();
        }
        root.end();

        assertThat(providerStarted.await(2, TimeUnit.SECONDS)).isTrue();
        assertThat(providerCancelled.await(2, TimeUnit.SECONDS)).as("STT server observes client cancellation").isTrue();
        List<SpanData> spans = awaitFinishedSpans(3);
        assertTraceTree(spans, root, Status.CANCELLED.getCode().name());
        assertNoPrivateTelemetry(spans);
    }

    private OpenTelemetrySdk installTelemetry() {
        exporter = InMemorySpanExporter.create();
        tracerProvider = SdkTracerProvider.builder()
                .addSpanProcessor(SimpleSpanProcessor.create(exporter))
                .build();
        OpenTelemetrySdk telemetry = OpenTelemetrySdk.builder()
                .setTracerProvider(tracerProvider)
                .setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance()))
                .build();
        GlobalOpenTelemetry.resetForTest();
        GlobalOpenTelemetry.set(telemetry);
        return telemetry;
    }

    private static Server startServer(STTServiceGrpc.STTServiceImplBase service) throws Exception {
        return ServerBuilder.forPort(0)
                .addService(service)
                .intercept(new TracingServerInterceptor())
                .build()
                .start();
    }

    private List<SpanData> awaitFinishedSpans(int expected) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (exporter.getFinishedSpanItems().size() < expected && System.nanoTime() < deadline) {
            Thread.sleep(2);
        }
        List<SpanData> spans = exporter.getFinishedSpanItems();
        assertThat(spans).hasSize(expected);
        return spans;
    }

    private static void assertTraceTree(List<SpanData> spans, Span root, String expectedClientStatus) {
        SpanData rootSpan = spans.stream()
                .filter(value -> value.getKind() == SpanKind.INTERNAL)
                .findFirst()
                .orElseThrow(() -> new AssertionError("Missing caller root span"));
        SpanData client = span(spans, CLIENT_SPAN_NAME, SpanKind.CLIENT);
        SpanData server = span(spans, CLIENT_SPAN_NAME, SpanKind.SERVER);
        assertThat(client.getTraceId()).isEqualTo(root.getSpanContext().getTraceId());
        assertThat(client.getParentSpanId()).isEqualTo(root.getSpanContext().getSpanId());
        assertThat(client.getAttributes().get(AttributeKey.stringKey("rpc.grpc.status_code")))
                .isEqualTo(expectedClientStatus);
        assertThat(server.getTraceId()).isEqualTo(client.getTraceId());
        assertThat(server.getParentSpanId()).isEqualTo(client.getSpanId());
        assertThat(rootSpan.getTraceId()).isEqualTo(client.getTraceId());
    }

    private static SpanData span(List<SpanData> spans, String name, SpanKind kind) {
        return spans.stream()
                .filter(value -> value.getName().equals(name) && value.getKind() == kind)
                .findFirst()
                .orElseThrow(() -> new AssertionError("Missing " + kind + " span " + name));
    }

    private static void assertNoPrivateTelemetry(List<SpanData> spans) {
        List<String> privateMarkers = List.of(
                PRIVATE_PROVIDER_MARKER, PRIVATE_TRANSCRIPT_MARKER,
                PRIVATE_TENANT_MARKER, PRIVATE_BAGGAGE_MARKER);
        spans.forEach(span -> {
            assertThat(span.getAttributes().asMap().values()).doesNotContainAnyElementsOf(privateMarkers);
            span.getEvents().forEach(event ->
                    assertThat(event.getAttributes().asMap().values()).doesNotContainAnyElementsOf(privateMarkers));
            span.getLinks().forEach(link ->
                    assertThat(link.getAttributes().asMap().values()).doesNotContainAnyElementsOf(privateMarkers));
            assertThat(span.getAttributes().asMap().keySet()).noneMatch(key -> {
                String name = key.getKey().toLowerCase(Locale.ROOT);
                return name.contains("tenant") || name.contains("baggage")
                        || name.contains("payload") || name.contains("transcript");
            });
        });
    }

    private static final class SttGateway implements MultimodalMediaGateway {
        private final GrpcSttClientAdapter adapter;

        private SttGateway(GrpcSttClientAdapter adapter) {
            this.adapter = adapter;
        }

        @Override
        public AudioResult transcribe(byte[] audioData) {
            return adapter.transcribe(audioData);
        }

        @Override
        public VisualResult analyseImage(byte[] imageData) {
            return VisualResult.error("Vision provider not configured in STT tracing test");
        }

        @Override
        public VisualResult analyseVideo(byte[] videoData, int sampleFps, int maxFrames) {
            return VisualResult.error("Vision provider not configured in STT tracing test");
        }

        @Override
        public String backendName() {
            return "loopback-stt-fixture";
        }

        @Override
        public boolean metricsEnabled() {
            return false;
        }

        @Override
        public void close() {
            // The enclosing test owns the adapter lifecycle.
        }
    }
}
