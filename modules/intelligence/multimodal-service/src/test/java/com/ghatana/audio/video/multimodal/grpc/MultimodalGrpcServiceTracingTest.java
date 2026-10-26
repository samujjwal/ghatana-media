package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.multimodal.engine.AudioResult;
import com.ghatana.audio.video.multimodal.engine.MultimodalAnalysisEngine;
import com.ghatana.audio.video.multimodal.engine.MultimodalResult;
import com.ghatana.audio.video.multimodal.engine.PlatformMultimodalAdapter;
import com.ghatana.audio.video.multimodal.engine.VisualResult;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalRequest;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalResponse;
import com.ghatana.audiovideo.observability.tracing.AudioVideoTracingService;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.stub.ServerCallStreamObserver;
import io.grpc.stub.StreamObserver;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanBuilder;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Scope;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class MultimodalGrpcServiceTracingTest {

    private static final String TENANT = "tenant-private-multimodal-7401";
    private static final String SUBJECT = "d7fe98ce-75d3-4a2a-8a04-bb54e23a2f15";
    private static final String CONTENT = "content-private-multimodal-8832";

    @Test
    void dispatchSpanIsCurrentForEngineAndEndsOnSuccessWithoutExportingIdentityOrContent() {
        TraceFixture tracing = new TraceFixture();
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        AtomicReference<SpanContext> engineContext = new AtomicReference<>();
        when(engine.analyse(any())).thenAnswer(invocation -> {
            engineContext.set(Span.current().getSpanContext());
            return success();
        });
        MultimodalGrpcService service = service(engine, tracing);
        Observer<MultimodalResponse> observer = new Observer<>();

        withTenant(() -> service.processMultimodal(audioRequest(), observer));

        assertThat(observer.error).isNull();
        assertThat(observer.completed).isTrue();
        assertThat(engineContext.get()).isEqualTo(tracing.context);
        verify(tracing.builder).setAttribute("operation.present", true);
        verify(tracing.builder).setAttribute("tenant.present", true);
        verify(tracing.builder, never()).setAttribute(eq("tenant.id"), eq(TENANT));
        verify(tracing.builder, never()).setAttribute(eq("media.content"), eq(CONTENT));
        verify(tracing.span).setStatus(StatusCode.OK);
        verify(tracing.span).end();
        assertThat(Span.current().getSpanContext().isValid()).isFalse();
    }

    @Test
    void unavailableTypedProviderResultEndsSpanAsErrorWithOnlyGenericFailureMetadata() {
        TraceFixture tracing = new TraceFixture();
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        when(engine.analyse(any())).thenReturn(MultimodalResult.builder()
                .audioResult(AudioResult.error("provider-private-detail"))
                .combinedAnalysis("unavailable").build());
        MultimodalGrpcService service = service(engine, tracing);
        Observer<MultimodalResponse> observer = new Observer<>();

        withTenant(() -> service.processMultimodal(audioRequest(), observer));

        assertThat(observer.error).isNotNull();
        assertThat(observer.completed).isFalse();
        verify(tracing.span).setStatus(StatusCode.ERROR, "Media operation failed");
        verify(tracing.span).setAttribute("error.type", "StatusRuntimeException");
        verify(tracing.span).end();
        verify(tracing.span, never()).setAttribute(eq("provider.error"), anyString());
    }

    @Test
    void engineWorkerInheritsAnalysisSpanContext() {
        TraceFixture tracing = new TraceFixture();
        AtomicReference<SpanContext> childContext = new AtomicReference<>();
        com.ghatana.audio.video.multimodal.engine.MultimodalMediaGateway gateway =
                new com.ghatana.audio.video.multimodal.engine.MultimodalMediaGateway() {
                    @Override public AudioResult transcribe(byte[] audio) {
                        childContext.set(Span.current().getSpanContext());
                        return AudioResult.builder().transcription("fixture").build();
                    }
                    @Override public VisualResult analyseImage(byte[] image) { return VisualResult.builder().build(); }
                    @Override public VisualResult analyseVideo(byte[] video, int fps, int frames) {
                        return VisualResult.builder().build();
                    }
                    @Override public String backendName() { return "fixture"; }
                    @Override public boolean metricsEnabled() { return false; }
                    @Override public void close() { }
                };
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(gateway)) {
            MultimodalGrpcService service = service(engine, tracing);
            Observer<MultimodalResponse> observer = new Observer<>();

            withTenant(() -> service.processMultimodal(audioRequest(), observer));

            assertThat(childContext.get()).isEqualTo(tracing.context);
            assertThat(observer.completed).isTrue();
        }
    }

    @Test
    void cancellationFinishesUnknownOnceAndSuppressesLateResponseCallbacks() {
        TraceFixture tracing = new TraceFixture();
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<MultimodalResponse> observer = mock(ServerCallStreamObserver.class);
        AtomicReference<Runnable> cancelHandler = new AtomicReference<>();
        doAnswer(invocation -> {
            cancelHandler.set(invocation.getArgument(0));
            return null;
        }).when(observer).setOnCancelHandler(any(Runnable.class));
        when(engine.analyse(any())).thenAnswer(invocation -> {
            cancelHandler.get().run();
            return success();
        });
        MediaProcessingMetrics metrics = MediaProcessingMetrics.create();
        MultimodalGrpcService service = service(engine, tracing, metrics);

        withTenant(() -> service.processMultimodal(audioRequest(), observer));

        verify(observer, never()).onNext(any());
        verify(observer, never()).onCompleted();
        verify(observer, never()).onError(any());
        verify(tracing.span).setAttribute("media.outcome", "unknown");
        verify(tracing.span).end();
        assertThat(metrics.succeededCount("multimodal.analyse")).isZero();
    }

    @Test
    void cancellationAfterEngineReturnButBeforeFinalDeliverySkipsSuccessMetrics() {
        TraceFixture tracing = new TraceFixture();
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        when(engine.analyse(any())).thenReturn(success());
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<MultimodalResponse> observer = mock(ServerCallStreamObserver.class);
        AtomicReference<Runnable> cancelHandler = new AtomicReference<>();
        doAnswer(invocation -> {
            cancelHandler.set(invocation.getArgument(0));
            return null;
        }).when(observer).setOnCancelHandler(any(Runnable.class));
        PlatformMultimodalAdapter adapter = mock(PlatformMultimodalAdapter.class);
        when(adapter.backendName()).thenAnswer(invocation -> {
            cancelHandler.get().run();
            return "test-backend";
        });
        when(adapter.metricsEnabled()).thenReturn(false);
        MediaProcessingMetrics metrics = MediaProcessingMetrics.create();
        MultimodalGrpcService service = new MultimodalGrpcService(engine, adapter, metrics,
                request -> SourceAuthorization.Decision.ADMITTED,
                new AudioVideoTracingService(tracing.tracer), fixtureExecutor());

        withTenant(() -> service.processMultimodal(audioRequest(), observer));

        verify(observer, never()).onNext(any());
        verify(observer, never()).onCompleted();
        verify(observer, never()).onError(any());
        assertThat(metrics.succeededCount("multimodal.analyse")).isZero();
        assertThat(metrics.failedCount("multimodal.analyse")).isZero();
        verify(tracing.span).setAttribute("media.outcome", "unknown");
        verify(tracing.span).end();
    }

    @Test
    void observerErrorClosesSpanUnknown() {
        TraceFixture tracing = new TraceFixture();
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        when(engine.analyse(any())).thenReturn(success());
        StreamObserver<MultimodalResponse> observer = new StreamObserver<>() {
            @Override public void onNext(MultimodalResponse value) {
                throw new AssertionError("downstream observer failed");
            }
            @Override public void onError(Throwable error) { }
            @Override public void onCompleted() { }
        };

        MultimodalGrpcService service = service(engine, tracing);

        assertThatThrownBy(() -> withTenant(() -> service.processMultimodal(audioRequest(), observer)))
                .isInstanceOf(AssertionError.class)
                .hasMessage("downstream observer failed");

        verify(tracing.span).setAttribute("media.outcome", "unknown");
        verify(tracing.span).end();
    }

    @Test
    void onNextRuntimeExceptionNeverRecordsSuccessAndCountsAtMostOneFailure() {
        TraceFixture tracing = new TraceFixture();
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        when(engine.analyse(any())).thenReturn(success());
        MediaProcessingMetrics metrics = MediaProcessingMetrics.create();
        MultimodalGrpcService service = service(engine, tracing, metrics);
        StreamObserver<MultimodalResponse> observer = new StreamObserver<>() {
            @Override public void onNext(MultimodalResponse value) {
                throw new IllegalStateException("observer callback failed");
            }
            @Override public void onError(Throwable error) { }
            @Override public void onCompleted() { }
        };

        withTenant(() -> service.processMultimodal(audioRequest(), observer));

        assertThat(metrics.succeededCount("multimodal.analyse")).isZero();
        assertThat(metrics.failedCount("multimodal.analyse")).isEqualTo(1);
        verify(tracing.span).setAttribute("media.outcome", "unknown");
        verify(tracing.span).end();
    }

    @Test
    void reentrantCancellationDuringOnNextSuppressesCompletion() {
        TraceFixture tracing = new TraceFixture();
        MultimodalAnalysisEngine engine = mock(MultimodalAnalysisEngine.class);
        when(engine.analyse(any())).thenReturn(success());
        @SuppressWarnings("unchecked")
        ServerCallStreamObserver<MultimodalResponse> observer = mock(ServerCallStreamObserver.class);
        AtomicReference<Runnable> cancelHandler = new AtomicReference<>();
        doAnswer(invocation -> {
            cancelHandler.set(invocation.getArgument(0));
            return null;
        }).when(observer).setOnCancelHandler(any(Runnable.class));
        doAnswer(invocation -> {
            cancelHandler.get().run();
            return null;
        }).when(observer).onNext(any());
        MultimodalGrpcService service = service(engine, tracing);

        withTenant(() -> service.processMultimodal(audioRequest(), observer));

        verify(observer, never()).onCompleted();
        verify(observer, never()).onError(any());
        verify(tracing.span).setAttribute("media.outcome", "unknown");
        verify(tracing.span).end();
    }

    @Test
    void insightsFailClosedWithoutCreatingAnalysisSpan() {
        TraceFixture tracing = new TraceFixture();
        MultimodalGrpcService service = service(mock(MultimodalAnalysisEngine.class), tracing);
        Observer<com.ghatana.audio.video.multimodal.grpc.proto.InsightsResponse> observer = new Observer<>();

        withTenant(() -> service.getInsights(
                com.ghatana.audio.video.multimodal.grpc.proto.InsightsRequest.newBuilder()
                        .setAudioData(ByteString.copyFrom(new byte[] {1})).build(), observer));

        assertThat(observer.error).isNotNull();
        verify(tracing.tracer, never()).spanBuilder(anyString());
    }

    private static MultimodalGrpcService service(MultimodalAnalysisEngine engine, TraceFixture tracing) {
        return service(engine, tracing, MediaProcessingMetrics.noop());
    }

    private static MultimodalGrpcService service(MultimodalAnalysisEngine engine, TraceFixture tracing,
                                                  MediaProcessingMetrics metrics) {
        PlatformMultimodalAdapter adapter = mock(PlatformMultimodalAdapter.class);
        when(adapter.backendName()).thenReturn("test-backend");
        when(adapter.metricsEnabled()).thenReturn(false);
        return new MultimodalGrpcService(engine, adapter,
                metrics, request -> SourceAuthorization.Decision.ADMITTED,
                new AudioVideoTracingService(tracing.tracer), fixtureExecutor());
    }

    private static MultimodalRequest audioRequest() {
        return MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(CONTENT.getBytes(java.nio.charset.StandardCharsets.UTF_8)))
                .setOperationBinding(com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding.newBuilder()
                        .setOperationVersion(1)
                        .setCapabilityRef("media.multimodal.observe.source-grounded")
                        .setOperationRef("media.operation.capability.media-multimodal-observe-source-grounded")
                        .setRequestId("request-trace-test")
                        .setSourceArtifactId("artifact-trace-test")
                        .setSourceVersionId("version-trace-test")
                        .setPurpose("trace fixture")
                        .build())
                .build();
    }

    private static CanonicalOperationExecutor fixtureExecutor() {
        return new CanonicalOperationExecutor() {
            @Override
            public <T> T execute(com.ghatana.audio.video.multimodal.grpc.proto.CanonicalOperationBinding binding,
                                 String operationRef, java.util.concurrent.Callable<T> action) throws Exception {
                return action.call();
            }
        };
    }

    private static MultimodalResult success() {
        return MultimodalResult.builder()
                .audioResult(AudioResult.builder().transcription("fixture").build())
                .combinedAnalysis("fixture").build();
    }

    private static void withTenant(Runnable action) {
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, TENANT)
                .withValue(JwtServerInterceptor.CTX_SUBJECT, SUBJECT).run(action);
    }

    private static final class TraceFixture {
        private final Tracer tracer = mock(Tracer.class);
        private final SpanBuilder builder = mock(SpanBuilder.class);
        private final Span span = mock(Span.class);
        private final SpanContext context = SpanContext.create(
                "0123456789abcdef0123456789abcdef", "0123456789abcdef",
                TraceFlags.getSampled(), TraceState.getDefault());

        private TraceFixture() {
            when(tracer.spanBuilder(anyString())).thenReturn(builder);
            when(builder.setSpanKind(any(SpanKind.class))).thenReturn(builder);
            when(builder.setAttribute(anyString(), anyBoolean())).thenReturn(builder);
            when(builder.setAttribute(anyString(), anyString())).thenReturn(builder);
            when(builder.startSpan()).thenReturn(span);
            when(span.getSpanContext()).thenReturn(context);
            when(span.storeInContext(any(io.opentelemetry.context.Context.class)))
                    .thenAnswer(invocation -> Span.wrap(context)
                            .storeInContext(invocation.getArgument(0)));
            doAnswer(invocation -> io.opentelemetry.context.Context.current().with(span).makeCurrent())
                    .when(span).makeCurrent();
        }
    }

    private static final class Observer<T> implements StreamObserver<T> {
        private T value;
        private Throwable error;
        private boolean completed;
        @Override public void onNext(T next) { value = next; }
        @Override public void onError(Throwable failure) { error = failure; }
        @Override public void onCompleted() { completed = true; }
    }
}
