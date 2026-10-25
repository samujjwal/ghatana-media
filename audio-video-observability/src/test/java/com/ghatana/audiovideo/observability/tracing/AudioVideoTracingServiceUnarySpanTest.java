package com.ghatana.audiovideo.observability.tracing;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanBuilder;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.Tracer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;

import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class AudioVideoTracingServiceUnarySpanTest {

    @AfterEach
    void clearMdc() {
        MDC.clear();
    }

    @Test
    void registeredVisionUnaryMethodUsesBoundedNameAndPresenceOnlyIdentifiers() {
        Tracer tracer = mock(Tracer.class);
        SpanBuilder builder = configuredBuilder(tracer);
        String tenantMarker = "private-tenant-marker-703";
        String correlationMarker = "private-correlation-marker-915";
        MDC.put("correlationId", correlationMarker);

        new AudioVideoTracingService(tracer).startVisionUnarySpan("analyzeImage", tenantMarker);

        verify(tracer).spanBuilder("audiovideo.vision.rpc");
        verify(builder).setAttribute("vision.rpc.method", "analyzeImage");
        verify(builder).setAttribute("tenant.present", true);
        verify(builder).setAttribute("correlation.present", true);
        verify(builder, never()).setAttribute(anyString(), eq(tenantMarker));
        verify(builder, never()).setAttribute(anyString(), eq(correlationMarker));
    }

    @Test
    void unknownMethodCollapsesToStaticLabel() {
        Tracer tracer = mock(Tracer.class);
        SpanBuilder builder = configuredBuilder(tracer);
        String marker = "unregistered-rpc-marker-402";

        new AudioVideoTracingService(tracer).startVisionUnarySpan(marker, null);

        verify(builder).setAttribute("vision.rpc.method", "unknown");
        verify(builder, never()).setAttribute(anyString(), eq(marker));
    }

    @Test
    void registeredSttStreamingMethodUsesExactBoundedName() {
        Tracer tracer = mock(Tracer.class);
        SpanBuilder builder = configuredStreamingBuilder(tracer);

        new AudioVideoTracingService(tracer).startGrpcStreamingSpan("StreamTranscribe", "private-tenant");

        verify(builder).setAttribute("method.name", "StreamTranscribe");
        verify(builder).setAttribute("tenant.present", true);
        verify(builder, never()).setAttribute(anyString(), eq("private-tenant"));
    }

    @Test
    void unknownStreamingMethodCollapsesToStaticLabel() {
        Tracer tracer = mock(Tracer.class);
        SpanBuilder builder = configuredStreamingBuilder(tracer);
        String marker = "unregistered-rpc-marker-402";

        new AudioVideoTracingService(tracer).startGrpcStreamingSpan(marker, null);

        verify(builder).setAttribute("method.name", "unknown");
        verify(builder, never()).setAttribute(anyString(), eq(marker));
    }

    private static SpanBuilder configuredBuilder(Tracer tracer) {
        SpanBuilder builder = mock(SpanBuilder.class);
        when(tracer.spanBuilder("audiovideo.vision.rpc")).thenReturn(builder);
        when(builder.setSpanKind(SpanKind.INTERNAL)).thenReturn(builder);
        when(builder.setAttribute(anyString(), anyBoolean())).thenReturn(builder);
        when(builder.setAttribute(anyString(), anyString())).thenReturn(builder);
        when(builder.startSpan()).thenReturn(mock(Span.class));
        return builder;
    }

    private static SpanBuilder configuredStreamingBuilder(Tracer tracer) {
        SpanBuilder builder = mock(SpanBuilder.class);
        when(tracer.spanBuilder("audiovideo.grpc.streaming")).thenReturn(builder);
        when(builder.setSpanKind(SpanKind.INTERNAL)).thenReturn(builder);
        when(builder.setAttribute(anyString(), anyBoolean())).thenReturn(builder);
        when(builder.setAttribute(anyString(), anyString())).thenReturn(builder);
        when(builder.startSpan()).thenReturn(mock(Span.class));
        return builder;
    }
}
