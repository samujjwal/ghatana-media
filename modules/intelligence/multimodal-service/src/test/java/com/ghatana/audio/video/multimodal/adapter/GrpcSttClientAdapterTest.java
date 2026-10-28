/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.adapter;

import com.ghatana.audio.video.common.observability.TracingServerInterceptor;
import com.ghatana.audio.video.multimodal.engine.AudioResult;
import com.ghatana.stt.core.grpc.proto.ConfidenceCalibration;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.TimestampTimebase;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.ghatana.stt.core.grpc.proto.WordTiming;
import io.grpc.Context;
import io.grpc.Server;
import io.grpc.ServerBuilder;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Integration tests for {@link GrpcSttClientAdapter}.
 *
 * <p>Full live-service assertions run in the STT gRPC integration suite. These focused tests prove
 * that provider outages fail explicitly and can never fall through to a text-model transcription.
 *
 * @doc.type class
 * @doc.purpose Integration tests for grounded STT modes and provider failure behavior
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("GrpcSttClientAdapter Integration Tests")
@Tag("integration")
class GrpcSttClientAdapterTest {

    @Test
    @DisplayName("NOP mode returns unavailable and never contacts the gRPC endpoint")
    void nopModeReturnsUnavailableWithoutNetworkCall() throws Exception {
        AtomicInteger providerCalls = new AtomicInteger();
        Server server = ServerBuilder.forPort(0).addService(new STTServiceGrpc.STTServiceImplBase() {
            @Override
            public void transcribe(
                    com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                    StreamObserver<TranscribeResponse> observer) {
                providerCalls.incrementAndGet();
                observer.onNext(TranscribeResponse.newBuilder().setText("must-not-be-used").build());
                observer.onCompleted();
            }
        }).build().start();
        try (GrpcSttClientAdapter adapter = GrpcSttClientAdapter.forLocalTesting(
                "localhost", server.getPort(), GrpcSttClientAdapter.SttMode.NOP)) {
            AudioResult result = adapter.transcribe(new byte[1024]);

            assertThat(result).isNotNull();
            assertThat(result.isError()).isTrue();
            assertThat(result.getTranscription()).isEmpty();
            assertThat(result.getError()).contains("unavailable", "NOP mode");
            assertThat(result.hasConfidence()).isFalse();
            assertThat(result.getConfidenceCalibration()).isEqualTo(AudioResult.ConfidenceCalibration.UNKNOWN);
            assertThat(adapter.getCurrentMode()).isEqualTo(GrpcSttClientAdapter.SttMode.NOP);
            assertThat(providerCalls).hasValue(0);
        } finally {
            server.shutdownNow();
            server.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    @Test
    @DisplayName("GRPC mode reports provider outage instead of fabricating transcription")
    void grpcModeFailsClosedWhenEndpointUnavailable() {
        try (GrpcSttClientAdapter adapter = new GrpcSttClientAdapter(
                "localhost",
                1,
                GrpcSttClientAdapter.SttMode.GRPC)) {
            AudioResult result = adapter.transcribe(new byte[1024]);

            assertThat(result).isNotNull();
            assertThat(result.isError()).isTrue();
            assertThat(result.getTranscription()).isEmpty();
            assertThat(result.getError()).contains("STT provider unavailable");
            assertThat(adapter.getCurrentMode()).isEqualTo(GrpcSttClientAdapter.SttMode.GRPC);
        }
    }

    @Test
    @DisplayName("Empty audio is rejected before provider invocation")
    void emptyAudioFailsClosed() {
        try (GrpcSttClientAdapter adapter = new GrpcSttClientAdapter(
                "localhost", 50051, GrpcSttClientAdapter.SttMode.GRPC)) {
            AudioResult result = adapter.transcribe(new byte[0]);

            assertThat(result.isError()).isTrue();
            assertThat(result.getError()).contains("must not be empty");
        }
    }

    @Test
    @DisplayName("Default constructor uses grounded GRPC mode")
    void defaultConstructorUsesGrpcMode() {
        try (GrpcSttClientAdapter adapter = new GrpcSttClientAdapter("localhost", 1)) {
            AudioResult result = adapter.transcribe(new byte[1024]);

            assertThat(result.isError()).isTrue();
            assertThat(adapter.getCurrentMode()).isEqualTo(GrpcSttClientAdapter.SttMode.GRPC);
        }
    }

    @Test
    @DisplayName("Adapter rejects invalid provider coordinates")
    void adapterRejectsInvalidProviderCoordinates() {
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> new GrpcSttClientAdapter(" ", 50051))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("host");
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> new GrpcSttClientAdapter("localhost", 0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("port");
    }

    @Test
    @DisplayName("Adapter can be closed")
    void adapterCanBeClosed() {
        try (GrpcSttClientAdapter ignored = new GrpcSttClientAdapter("localhost", 50051)) {
            // Auto-close via try-with-resources.
        }
    }

    @Test
    @DisplayName("Preserves STT confidence availability and calibration over gRPC")
    void preservesConfidenceCalibrationOverGrpc() throws Exception {
        for (ConfidenceCalibration wireCalibration : ConfidenceCalibration.values()) {
            if (wireCalibration == ConfidenceCalibration.UNRECOGNIZED) continue;
            float score = wireCalibration == ConfidenceCalibration.CONFIDENCE_CALIBRATION_UNKNOWN
                    ? 0.0f : 0.73f;
            Server server = ServerBuilder.forPort(0)
                    .addService(new STTServiceGrpc.STTServiceImplBase() {
                        @Override
                        public void transcribe(
                                com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                                StreamObserver<TranscribeResponse> observer) {
                            observer.onNext(TranscribeResponse.newBuilder().setText("recognized")
                                    .setConfidence(score).setConfidenceCalibration(wireCalibration).build());
                            observer.onCompleted();
                        }
                    }).build().start();
            try (GrpcSttClientAdapter adapter = GrpcSttClientAdapter.forLocalTesting(
                    "localhost", server.getPort(), GrpcSttClientAdapter.SttMode.GRPC)) {
                AudioResult result = adapter.transcribe(new byte[] {1});
                switch (wireCalibration) {
                    case CONFIDENCE_CALIBRATION_UNKNOWN -> {
                        assertThat(result.hasConfidence()).isFalse();
                        assertThat(result.getConfidence()).isNull();
                        assertThat(result.getConfidenceCalibration()).isEqualTo(AudioResult.ConfidenceCalibration.UNKNOWN);
                    }
                    case CONFIDENCE_CALIBRATION_UNCALIBRATED -> {
                        assertThat(result.getConfidence()).isCloseTo(0.73, org.assertj.core.data.Offset.offset(0.00001));
                        assertThat(result.getConfidenceCalibration()).isEqualTo(AudioResult.ConfidenceCalibration.UNCALIBRATED);
                    }
                    case CONFIDENCE_CALIBRATION_CALIBRATED -> {
                        assertThat(result.getConfidence()).isCloseTo(0.73, org.assertj.core.data.Offset.offset(0.00001));
                        assertThat(result.getConfidenceCalibration()).isEqualTo(AudioResult.ConfidenceCalibration.CALIBRATED);
                    }
                    default -> throw new AssertionError("Unexpected calibration " + wireCalibration);
                }
            } finally {
                server.shutdownNow();
            }
        }
    }

    @Test
    @DisplayName("Preserves explicitly source-zero word timing without sharing clocks across requests")
    void preservesSourceZeroWordTimingOnAnIsolatedRequestClock() throws Exception {
        Server server = ServerBuilder.forPort(0)
                .addService(new STTServiceGrpc.STTServiceImplBase() {
                    @Override
                    public void transcribe(
                            com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                            StreamObserver<TranscribeResponse> observer) {
                        assertThat(request.getSampleRate()).isEqualTo(16_000);
                        assertThat(request.getOptions().getEnableWordTimings()).isTrue();
                        observer.onNext(TranscribeResponse.newBuilder().setText("hello world")
                                .setWordTimingTimebase(TimestampTimebase.TIMESTAMP_TIMEBASE_SOURCE_SAMPLE_ZERO)
                                .addWordTimings(WordTiming.newBuilder().setWord("hello")
                                        .setStartMs(0).setEndMs(420))
                                .addWordTimings(WordTiming.newBuilder().setWord("world")
                                        .setStartMs(430).setEndMs(900))
                                .build());
                        observer.onCompleted();
                    }
                }).build().start();
        try (GrpcSttClientAdapter adapter = GrpcSttClientAdapter.forLocalTesting(
                "localhost", server.getPort(), GrpcSttClientAdapter.SttMode.GRPC)) {
            byte[] oneSecondPcm = new byte[32_000];
            AudioResult first = adapter.transcribe(oneSecondPcm);
            AudioResult second = adapter.transcribe(oneSecondPcm);

            assertThat(first.getTimedSegments()).hasSize(2);
            assertThat(first.getTimedSegments().get(0).getText()).isEqualTo("hello");
            assertThat(first.getTimedSegments().get(0).getStartTime().ticks()).isZero();
            assertThat(first.getTimedSegments().get(1).getStartTime()
                    .sharesClock(first.getTimedSegments().get(0).getStartTime())).isTrue();
            assertThat(first.getTimedSegments().get(0).getStartTime()
                    .sharesClock(second.getTimedSegments().get(0).getStartTime())).isFalse();
        } finally {
            server.shutdownNow();
            server.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    @Test
    @DisplayName("Unknown STT word timing origin remains unassociated")
    void ignoresWordTimingWhenProviderDoesNotDeclareItsClockOrigin() throws Exception {
        Server server = ServerBuilder.forPort(0)
                .addService(new STTServiceGrpc.STTServiceImplBase() {
                    @Override
                    public void transcribe(
                            com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                            StreamObserver<TranscribeResponse> observer) {
                        observer.onNext(TranscribeResponse.newBuilder().setText("fixture")
                                .addWordTimings(WordTiming.newBuilder().setWord("fixture")
                                        .setStartMs(0).setEndMs(500))
                                .build());
                        observer.onCompleted();
                    }
                }).build().start();
        try (GrpcSttClientAdapter adapter = GrpcSttClientAdapter.forLocalTesting(
                "localhost", server.getPort(), GrpcSttClientAdapter.SttMode.GRPC)) {
            AudioResult result = adapter.transcribe(new byte[] {1});
            assertThat(result.getTranscription()).isEqualTo("fixture");
            assertThat(result.getTimedSegments()).isEmpty();
        } finally {
            server.shutdownNow();
            server.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    @Test
    @DisplayName("Invalid source-relative word bounds fail the child result instead of being aligned")
    void rejectsInvalidSourceRelativeWordBounds() throws Exception {
        Server server = ServerBuilder.forPort(0)
                .addService(new STTServiceGrpc.STTServiceImplBase() {
                    @Override
                    public void transcribe(
                            com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                            StreamObserver<TranscribeResponse> observer) {
                        observer.onNext(TranscribeResponse.newBuilder().setText("bad timing")
                                .setWordTimingTimebase(TimestampTimebase.TIMESTAMP_TIMEBASE_SOURCE_SAMPLE_ZERO)
                                .addWordTimings(WordTiming.newBuilder().setWord("bad")
                                        .setStartMs(500).setEndMs(100))
                                .build());
                        observer.onCompleted();
                    }
                }).build().start();
        try (GrpcSttClientAdapter adapter = GrpcSttClientAdapter.forLocalTesting(
                "localhost", server.getPort(), GrpcSttClientAdapter.SttMode.GRPC)) {
            AudioResult result = adapter.transcribe(new byte[] {1});
            assertThat(result.isError()).isTrue();
            assertThat(result.getTimedSegments()).isEmpty();
        } finally {
            server.shutdownNow();
            server.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    @Test
    @DisplayName("Rejects source word timing beyond the submitted PCM duration")
    void rejectsWordTimingBeyondSubmittedPcmDuration() throws Exception {
        Server server = ServerBuilder.forPort(0)
                .addService(new STTServiceGrpc.STTServiceImplBase() {
                    @Override
                    public void transcribe(
                            com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                            StreamObserver<TranscribeResponse> observer) {
                        observer.onNext(TranscribeResponse.newBuilder().setText("overlong timing")
                                .setWordTimingTimebase(TimestampTimebase.TIMESTAMP_TIMEBASE_SOURCE_SAMPLE_ZERO)
                                .addWordTimings(WordTiming.newBuilder().setWord("overlong")
                                        .setStartMs(950).setEndMs(1001))
                                .build());
                        observer.onCompleted();
                    }
                }).build().start();
        try (GrpcSttClientAdapter adapter = GrpcSttClientAdapter.forLocalTesting(
                "localhost", server.getPort(), GrpcSttClientAdapter.SttMode.GRPC)) {
            AudioResult result = adapter.transcribe(new byte[32_000]);
            assertThat(result.isError()).isTrue();
            assertThat(result.getTimedSegments()).isEmpty();
        } finally {
            server.shutdownNow();
            server.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    @Test
    @DisplayName("Rejects source word timings that move backward across segments")
    void rejectsBackwardWordTimingAcrossSegments() throws Exception {
        Server server = ServerBuilder.forPort(0)
                .addService(new STTServiceGrpc.STTServiceImplBase() {
                    @Override
                    public void transcribe(
                            com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                            StreamObserver<TranscribeResponse> observer) {
                        observer.onNext(TranscribeResponse.newBuilder().setText("backward timing")
                                .setWordTimingTimebase(TimestampTimebase.TIMESTAMP_TIMEBASE_SOURCE_SAMPLE_ZERO)
                                .addWordTimings(WordTiming.newBuilder().setWord("first")
                                        .setStartMs(400).setEndMs(500))
                                .addWordTimings(WordTiming.newBuilder().setWord("second")
                                        .setStartMs(300).setEndMs(600))
                                .build());
                        observer.onCompleted();
                    }
                }).build().start();
        try (GrpcSttClientAdapter adapter = GrpcSttClientAdapter.forLocalTesting(
                "localhost", server.getPort(), GrpcSttClientAdapter.SttMode.GRPC)) {
            AudioResult result = adapter.transcribe(new byte[32_000]);
            assertThat(result.isError()).isTrue();
            assertThat(result.getTimedSegments()).isEmpty();
        } finally {
            server.shutdownNow();
            server.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    @Test
    @DisplayName("Rejects invalid available scores and retains unknown default as absent")
    void validatesAvailableConfidence() {
        assertThatThrownBy(() -> AudioResult.builder().confidence(Double.NaN))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AudioResult.builder().confidence(1.01))
                .isInstanceOf(IllegalArgumentException.class);
        AudioResult absent = AudioResult.builder().build();
        assertThat(absent.hasConfidence()).isFalse();
        assertThat(absent.getConfidenceCalibration()).isEqualTo(AudioResult.ConfidenceCalibration.UNKNOWN);
    }

    @Test
    @DisplayName("Deadline and cancellation statuses propagate as ambiguous outcomes")
    void propagatesDeadlineAndCancellation() throws Exception {
        for (Status status : new Status[] {Status.DEADLINE_EXCEEDED, Status.CANCELLED}) {
            Server server = ServerBuilder.forPort(0)
                    .addService(new STTServiceGrpc.STTServiceImplBase() {
                        @Override
                        public void transcribe(
                                com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                                StreamObserver<TranscribeResponse> observer) {
                            observer.onError(status.asRuntimeException());
                        }
                    }).build().start();
            try (GrpcSttClientAdapter adapter = GrpcSttClientAdapter.forLocalTesting(
                    "localhost", server.getPort(), GrpcSttClientAdapter.SttMode.GRPC)) {
                assertThatThrownBy(() -> adapter.transcribe(new byte[] {1}))
                        .isInstanceOf(io.grpc.StatusRuntimeException.class)
                        .satisfies(failure -> assertThat(((io.grpc.StatusRuntimeException) failure)
                                .getStatus().getCode()).isEqualTo(status.getCode()));
            } finally {
                server.shutdownNow();
            }
        }
    }

    @Test
    @DisplayName("Interrupting a parent worker cancels the in-flight STT RPC")
    void parentInterruptionCancelsRpc() throws Exception {
        CountDownLatch callStarted = new CountDownLatch(1);
        CountDownLatch callCancelled = new CountDownLatch(1);
        Server server = ServerBuilder.forPort(0).addService(new STTServiceGrpc.STTServiceImplBase() {
            @Override
            public void transcribe(
                    com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                    StreamObserver<TranscribeResponse> observer) {
                Context.current().addListener(ignored -> callCancelled.countDown(), Runnable::run);
                callStarted.countDown();
            }
        }).build().start();
        try (GrpcSttClientAdapter adapter = GrpcSttClientAdapter.forLocalTesting(
                "localhost", server.getPort(), GrpcSttClientAdapter.SttMode.GRPC)) {
            FutureTask<AudioResult> call = new FutureTask<>(() -> adapter.transcribe(new byte[] {1}));
            Thread worker = new Thread(call, "test-stt-parent-worker");
            worker.start();
            assertThat(callStarted.await(2, TimeUnit.SECONDS)).isTrue();
            worker.interrupt();
            assertThatThrownBy(call::get)
                    .isInstanceOf(java.util.concurrent.ExecutionException.class)
                    .cause().isInstanceOf(CancellationException.class);
            assertThat(callCancelled.await(2, TimeUnit.SECONDS)).isTrue();
        } finally {
            server.shutdownNow();
            server.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    @Test
    @DisplayName("Propagates parent trace through the actual asynchronous STT gRPC client")
    void propagatesParentTraceThroughAsyncGrpcAdapter() throws Exception {
        InMemorySpanExporter exporter = InMemorySpanExporter.create();
        SdkTracerProvider tracerProvider = SdkTracerProvider.builder()
                .addSpanProcessor(SimpleSpanProcessor.create(exporter))
                .build();
        OpenTelemetrySdk telemetry = OpenTelemetrySdk.builder()
                .setTracerProvider(tracerProvider)
                .setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance()))
                .build();
        GlobalOpenTelemetry.resetForTest();
        GlobalOpenTelemetry.set(telemetry);

        AtomicInteger providerCalls = new AtomicInteger();
        Server server = null;
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            server = ServerBuilder.forPort(0)
                    .addService(new STTServiceGrpc.STTServiceImplBase() {
                        @Override
                        public void transcribe(
                                com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                                StreamObserver<TranscribeResponse> observer) {
                            providerCalls.incrementAndGet();
                            observer.onNext(TranscribeResponse.newBuilder()
                                    .setText("fixture transcript marker")
                                    .build());
                            observer.onCompleted();
                        }
                    })
                    .intercept(new TracingServerInterceptor())
                    .build()
                    .start();

            try (GrpcSttClientAdapter adapter = GrpcSttClientAdapter.forLocalTesting(
                    "127.0.0.1", server.getPort(), GrpcSttClientAdapter.SttMode.GRPC)) {
                Span root = telemetry.getTracer("media.test").spanBuilder("multimodal.child.parent").startSpan();
                io.opentelemetry.context.Context parent = io.opentelemetry.context.Context.current().with(root);
                FutureTask<AudioResult> call = new FutureTask<>(parent.wrap(() -> {
                    String parentSpanIdBefore = Span.current().getSpanContext().getSpanId();
                    AudioResult result = adapter.transcribe(new byte[] {7, 11, 13});
                    assertThat(Span.current().getSpanContext().getSpanId()).isEqualTo(parentSpanIdBefore);
                    return result;
                }));
                executor.execute(call);

                AudioResult result = call.get(5, TimeUnit.SECONDS);
                assertThat(result.isError()).isFalse();
                assertThat(result.getTranscription()).isEqualTo("fixture transcript marker");
                assertThat(providerCalls).hasValue(1);
                root.end();

                awaitFinishedSpans(exporter, 3);
                SpanData rootSpan = findSpan(exporter, "multimodal.child.parent", SpanKind.INTERNAL);
                SpanData clientSpan = findSpan(exporter,
                        "com.ghatana.audio.video.stt.grpc.STTService/Transcribe", SpanKind.CLIENT);
                SpanData serverSpan = findSpan(exporter,
                        "com.ghatana.audio.video.stt.grpc.STTService/Transcribe", SpanKind.SERVER);

                assertThat(clientSpan.getTraceId()).isEqualTo(rootSpan.getTraceId());
                assertThat(clientSpan.getParentSpanId()).isEqualTo(rootSpan.getSpanId());
                assertThat(serverSpan.getTraceId()).isEqualTo(clientSpan.getTraceId());
                assertThat(serverSpan.getParentSpanId()).isEqualTo(clientSpan.getSpanId());
                assertThat(clientSpan.getAttributes().get(AttributeKey.stringKey("rpc.service")))
                        .isEqualTo("com.ghatana.audio.video.stt.grpc.STTService");
                assertThat(clientSpan.getAttributes().get(AttributeKey.stringKey("rpc.method")))
                        .isEqualTo("Transcribe");
                assertThat(exporter.getFinishedSpanItems()).allSatisfy(span -> {
                    assertThat(span.getAttributes().asMap().values())
                            .doesNotContain("fixture transcript marker", "tenant-private-marker");
                    assertThat(span.getAttributes().asMap().keySet())
                            .noneMatch(key -> key.getKey().toLowerCase(java.util.Locale.ROOT).contains("tenant"));
                });
            }
        } finally {
            executor.shutdownNow();
            if (server != null) {
                server.shutdownNow();
                server.awaitTermination(5, TimeUnit.SECONDS);
            }
            tracerProvider.close();
            exporter.close();
            GlobalOpenTelemetry.resetForTest();
        }
    }

    private static void awaitFinishedSpans(InMemorySpanExporter exporter, int expected) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (exporter.getFinishedSpanItems().size() < expected && System.nanoTime() < deadline) {
            Thread.sleep(2);
        }
        assertThat(exporter.getFinishedSpanItems()).hasSize(expected);
    }

    private static SpanData findSpan(InMemorySpanExporter exporter, String name, SpanKind kind) {
        return exporter.getFinishedSpanItems().stream()
                .filter(span -> span.getName().equals(name) && span.getKind() == kind)
                .findFirst()
                .orElseThrow(() -> new AssertionError("Missing " + kind + " span " + name));
    }
}
