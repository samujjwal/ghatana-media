package com.ghatana.audio.video.common.observability;

import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.Status;
import io.opentelemetry.api.baggage.Baggage;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.api.baggage.propagation.W3CBaggagePropagator;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Verifies actual W3C parent extraction, callback context, and final gRPC outcome spans. */
class TracingServerInterceptorOpenTelemetryTest {

    private static final String PARENT_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
    private static final String PARENT_SPAN_ID = "b7ad6b7169203331";

    private final InMemorySpanExporter exporter = InMemorySpanExporter.create();
    private final SdkTracerProvider tracerProvider = SdkTracerProvider.builder()
            .addSpanProcessor(SimpleSpanProcessor.create(exporter))
            .build();
    private final OpenTelemetry telemetry = OpenTelemetrySdk.builder()
            .setTracerProvider(tracerProvider)
            .setPropagators(ContextPropagators.create(io.opentelemetry.context.propagation.TextMapPropagator.composite(
                    W3CTraceContextPropagator.getInstance(), W3CBaggagePropagator.getInstance())))
            .build();

    @AfterEach
    void closeTelemetry() {
        tracerProvider.close();
        exporter.close();
    }

    @Test
    @SuppressWarnings("unchecked")
    void extractsW3cParentAndKeepsServerContextAcrossCallbacksWithoutRecordingRequestMetadata() {
        TracingServerInterceptor interceptor = new TracingServerInterceptor(telemetry);
        Metadata requestHeaders = new Metadata();
        requestHeaders.put(Metadata.Key.of("traceparent", Metadata.ASCII_STRING_MARSHALLER),
                "00-" + PARENT_TRACE_ID + "-" + PARENT_SPAN_ID + "-01");
        requestHeaders.put(Metadata.Key.of("x-tenant-id", Metadata.ASCII_STRING_MARSHALLER), "tenant-secret");

        @SuppressWarnings("unchecked")
        ServerCall<String, String> call = mock(ServerCall.class);
        when(call.getMethodDescriptor()).thenReturn(method("media.grpc.VisionService/Detect"));
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        AtomicReference<String> startTrace = new AtomicReference<>();
        AtomicReference<String> callbackTrace = new AtomicReference<>();
        when(next.startCall(any(), eq(requestHeaders))).thenAnswer(invocation -> {
            startTrace.set(Span.current().getSpanContext().getTraceId());
            return new ServerCall.Listener<String>() {
                @Override
                public void onHalfClose() {
                    callbackTrace.set(Span.current().getSpanContext().getTraceId());
                }
            };
        });

        ServerCall.Listener<String> listener = interceptor.interceptCall(call, requestHeaders, next);
        org.mockito.ArgumentCaptor<ServerCall<String, String>> callCaptor =
                org.mockito.ArgumentCaptor.forClass(ServerCall.class);
        verify(next).startCall(callCaptor.capture(), eq(requestHeaders));
        ServerCall<String, String> wrappedCall = callCaptor.getValue();

        wrappedCall.sendHeaders(new Metadata());
        org.mockito.ArgumentCaptor<Metadata> responseCaptor = org.mockito.ArgumentCaptor.forClass(Metadata.class);
        verify(call).sendHeaders(responseCaptor.capture());
        assertThat(responseCaptor.getValue().get(Metadata.Key.of(
                "x-trace-id", Metadata.ASCII_STRING_MARSHALLER))).isEqualTo(PARENT_TRACE_ID);
        assertThat(responseCaptor.getValue().get(Metadata.Key.of(
                "x-span-id", Metadata.ASCII_STRING_MARSHALLER))).isNotEqualTo(PARENT_SPAN_ID);

        listener.onHalfClose();
        wrappedCall.close(Status.PERMISSION_DENIED, new Metadata());

        assertThat(startTrace.get()).isEqualTo(PARENT_TRACE_ID);
        assertThat(callbackTrace.get()).isEqualTo(PARENT_TRACE_ID);
        assertThat(Span.current().getSpanContext().isValid()).isFalse();
        verify(call).close(eq(Status.PERMISSION_DENIED), any());

        SpanData finished = exporter.getFinishedSpanItems().getFirst();
        assertThat(exporter.getFinishedSpanItems()).hasSize(1);
        assertThat(finished.getName()).isEqualTo("media.grpc.VisionService/Detect");
        assertThat(finished.getKind()).isEqualTo(SpanKind.SERVER);
        assertThat(finished.getTraceId()).isEqualTo(PARENT_TRACE_ID);
        assertThat(finished.getParentSpanId()).isEqualTo(PARENT_SPAN_ID);
        assertThat(finished.getStatus().getStatusCode()).isEqualTo(StatusCode.ERROR);
        assertThat(finished.getAttributes().asMap().values()).doesNotContain("tenant-secret");
    }

    @Test
    void endsCancelledStreamAndDoesNotExportBaggage() {
        TracingServerInterceptor interceptor = new TracingServerInterceptor(telemetry);
        Metadata requestHeaders = new Metadata();
        requestHeaders.put(Metadata.Key.of("traceparent", Metadata.ASCII_STRING_MARSHALLER),
                "00-" + PARENT_TRACE_ID + "-" + PARENT_SPAN_ID + "-01");
        requestHeaders.put(Metadata.Key.of("baggage", Metadata.ASCII_STRING_MARSHALLER), "token=private-secret");

        @SuppressWarnings("unchecked")
        ServerCall<String, String> call = mock(ServerCall.class);
        when(call.getMethodDescriptor()).thenReturn(method("media.grpc.STTService/StreamTranscribe"));
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        AtomicReference<String> extractedBaggage = new AtomicReference<>();
        when(next.startCall(any(), eq(requestHeaders))).thenAnswer(invocation -> {
            extractedBaggage.set(Baggage.current().getEntryValue("token"));
            return new ServerCall.Listener<String>() {};
        });

        ServerCall.Listener<String> listener = interceptor.interceptCall(call, requestHeaders, next);
        listener.onCancel();

        assertThat(extractedBaggage.get()).isNull();
        assertThat(exporter.getFinishedSpanItems()).hasSize(1);
        SpanData finished = exporter.getFinishedSpanItems().getFirst();
        assertThat(finished.getAttributes().get(
                io.opentelemetry.api.common.AttributeKey.stringKey("rpc.grpc.status_code")))
                .isEqualTo("CANCELLED");
        assertThat(finished.getAttributes().asMap().values()).doesNotContain("private-secret");
    }

    private static MethodDescriptor<String, String> method(String fullMethodName) {
        return MethodDescriptor.<String, String>newBuilder()
                .setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName(fullMethodName)
                .setRequestMarshaller(new StringMarshaller())
                .setResponseMarshaller(new StringMarshaller())
                .build();
    }

    private static final class StringMarshaller implements MethodDescriptor.Marshaller<String> {
        @Override
        public InputStream stream(String value) {
            return new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8));
        }

        @Override
        public String parse(InputStream stream) {
            try {
                return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            } catch (java.io.IOException failure) {
                throw new IllegalStateException("test marshalling failed", failure);
            }
        }
    }
}
