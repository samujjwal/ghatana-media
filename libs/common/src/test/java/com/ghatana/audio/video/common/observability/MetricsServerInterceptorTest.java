package com.ghatana.audio.video.common.observability;

import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.Status;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@DisplayName("Metrics Server Interceptor Tests")
class MetricsServerInterceptorTest {

    @Test
    @DisplayName("Should record started handled and duration metrics in Prometheus format")
    void shouldRecordMetricsInPrometheusFormat() { 
        MetricsServerInterceptor interceptor = new MetricsServerInterceptor(); 
        Metadata headers = new Metadata(); 
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        interceptor.interceptCall(createServerCall("audio.Video/Transcribe"), headers, next);
        interceptor.interceptCall(createServerCall("audio.Video/Transcribe"), headers, next);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<ServerCall<String, String>> wrappedCallCaptor = ArgumentCaptor.forClass(ServerCall.class); 
        verify(next, org.mockito.Mockito.times(2)).startCall(wrappedCallCaptor.capture(), eq(headers)); 

        wrappedCallCaptor.getAllValues().get(0).close(Status.OK, new Metadata()); 
        wrappedCallCaptor.getAllValues().get(1).close(Status.INVALID_ARGUMENT, new Metadata()); 

        String scrape = interceptor.scrape(); 

        assertThat(scrape).contains("grpc_server_started_total{grpc_method=\"audio.Video/Transcribe\"} 2"); 
        assertThat(scrape).contains("grpc_server_handled_total{grpc_method=\"audio.Video/Transcribe\",grpc_code=\"OK\"} 1"); 
        assertThat(scrape).contains("grpc_server_handled_total{grpc_method=\"audio.Video/Transcribe\",grpc_code=\"INVALID_ARGUMENT\"} 1"); 
        assertThat(scrape).contains("grpc_server_handling_seconds_sum{grpc_method=\"audio.Video/Transcribe\"}"); 
        assertThat(scrape).contains("grpc_server_handling_seconds_count{grpc_method=\"audio.Video/Transcribe\"} 2"); 
    }

    @Test
    @DisplayName("Should clear collected metrics on reset")
    void shouldClearMetricsOnReset() { 
        MetricsServerInterceptor interceptor = new MetricsServerInterceptor(); 
        Metadata headers = new Metadata(); 
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        interceptor.interceptCall(createServerCall("audio.Video/Health"), headers, next);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<ServerCall<String, String>> wrappedCallCaptor = ArgumentCaptor.forClass(ServerCall.class); 
        verify(next).startCall(wrappedCallCaptor.capture(), eq(headers)); 
        wrappedCallCaptor.getValue().close(Status.OK, new Metadata()); 

        interceptor.reset(); 

        String scrape = interceptor.scrape(); 
        assertThat(scrape).doesNotContain("audio.Video/Health");
        assertThat(scrape).contains("# HELP grpc_server_started_total");
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
