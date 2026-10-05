package com.ghatana.audio.video.common.observability;

import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.Status;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.slf4j.MDC;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Contract tests for {@link TracingServerInterceptor}.
 *
 * @doc.type class
 * @doc.purpose Verify trace propagation and MDC lifecycle for gRPC tracing interceptor
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("Tracing Server Interceptor Tests")
class TracingServerInterceptorTest {

    private static final Metadata.Key<String> TRACE_ID_KEY =
            Metadata.Key.of("x-trace-id", Metadata.ASCII_STRING_MARSHALLER);
    private static final Metadata.Key<String> SPAN_ID_KEY =
            Metadata.Key.of("x-span-id", Metadata.ASCII_STRING_MARSHALLER);

    @Test
    @DisplayName("Should propagate incoming trace id in response headers")
    void shouldPropagateIncomingTraceId() { 
        TracingServerInterceptor interceptor = new TracingServerInterceptor(); 
        Metadata headers = new Metadata(); 
        headers.put(TRACE_ID_KEY, "trace-incoming-123"); 

        @SuppressWarnings("unchecked")
        ServerCall<String, String> call = createServerCall("audio.Video/Transcribe"); 
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        interceptor.interceptCall(call, headers, next); 

        @SuppressWarnings("unchecked")
        ArgumentCaptor<ServerCall<String, String>> wrappedCallCaptor = ArgumentCaptor.forClass(ServerCall.class); 
        verify(next).startCall(wrappedCallCaptor.capture(), eq(headers)); 

        Metadata responseMetadata = new Metadata(); 
        wrappedCallCaptor.getValue().sendHeaders(responseMetadata); 

        ArgumentCaptor<Metadata> sentHeadersCaptor = ArgumentCaptor.forClass(Metadata.class); 
        verify(call).sendHeaders(sentHeadersCaptor.capture()); 

        Metadata sentHeaders = sentHeadersCaptor.getValue(); 
        assertThat(sentHeaders.get(TRACE_ID_KEY)).isEqualTo("trace-incoming-123");
        assertThat(sentHeaders.get(SPAN_ID_KEY)).isNotBlank();
    }

    @Test
    @DisplayName("Should generate trace id when request does not include one")
    void shouldGenerateTraceIdWhenMissing() { 
        TracingServerInterceptor interceptor = new TracingServerInterceptor(); 
        Metadata headers = new Metadata(); 

        @SuppressWarnings("unchecked")
        ServerCall<String, String> call = createServerCall("audio.Video/HealthCheck"); 
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        interceptor.interceptCall(call, headers, next); 

        @SuppressWarnings("unchecked")
        ArgumentCaptor<ServerCall<String, String>> wrappedCallCaptor = ArgumentCaptor.forClass(ServerCall.class); 
        verify(next).startCall(wrappedCallCaptor.capture(), eq(headers)); 

        wrappedCallCaptor.getValue().sendHeaders(new Metadata()); 

        ArgumentCaptor<Metadata> sentHeadersCaptor = ArgumentCaptor.forClass(Metadata.class); 
        verify(call).sendHeaders(sentHeadersCaptor.capture()); 

        Metadata sentHeaders = sentHeadersCaptor.getValue(); 
        assertThat(sentHeaders.get(TRACE_ID_KEY)).isNotBlank();
        assertThat(sentHeaders.get(TRACE_ID_KEY)).hasSize(32);
        assertThat(sentHeaders.get(SPAN_ID_KEY)).isNotBlank();
        assertThat(sentHeaders.get(SPAN_ID_KEY)).hasSize(16);
    }

    @Test
    @DisplayName("Should clear MDC context when gRPC call closes")
    void shouldClearMdcWhenCallCloses() { 
        TracingServerInterceptor interceptor = new TracingServerInterceptor(); 
        Metadata headers = new Metadata(); 

        @SuppressWarnings("unchecked")
        ServerCall<String, String> call = createServerCall("audio.Video/Analyze"); 
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        interceptor.interceptCall(call, headers, next); 

        assertThat(MDC.get("traceId")).isNotBlank();
        assertThat(MDC.get("spanId")).isNotBlank();
        assertThat(MDC.get("grpcService")).isEqualTo("audio.Video");
        assertThat(MDC.get("grpcMethod")).isEqualTo("Analyze");

        @SuppressWarnings("unchecked")
        ArgumentCaptor<ServerCall<String, String>> wrappedCallCaptor = ArgumentCaptor.forClass(ServerCall.class); 
        verify(next).startCall(wrappedCallCaptor.capture(), eq(headers)); 

        wrappedCallCaptor.getValue().close(Status.OK, new Metadata()); 

        assertThat(MDC.get("traceId")).isNull();
        assertThat(MDC.get("spanId")).isNull();
        assertThat(MDC.get("grpcService")).isNull();
        assertThat(MDC.get("grpcMethod")).isNull();
    }

    @SuppressWarnings("unchecked")
    private static ServerCall<String, String> createServerCall(String fullMethodName) { 
        ServerCall<String, String> call = mock(ServerCall.class); 
        when(call.getMethodDescriptor()).thenReturn(MethodDescriptor.<String, String>newBuilder() 
                .setType(MethodDescriptor.MethodType.UNARY) 
                .setFullMethodName(fullMethodName) 
                .setRequestMarshaller(new StringMarshaller()) 
                .setResponseMarshaller(new StringMarshaller()) 
                .build()); 
        return call;
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
            } catch (java.io.IOException exception) { 
                throw new IllegalStateException("Failed to parse gRPC payload", exception); 
            }
        }
    }
}
