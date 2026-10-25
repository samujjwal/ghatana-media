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
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

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

    @Test
    @DisplayName("Should count a cancelled RPC once even when the call later closes")
    void shouldRecordCancellationOnce() {
        MetricsServerInterceptor interceptor = new MetricsServerInterceptor();
        Metadata headers = new Metadata();
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class);
        AtomicReference<ServerCall<String, String>> wrapped = new AtomicReference<>();
        when(next.startCall(any(), eq(headers))).thenAnswer(invocation -> {
            wrapped.set(invocation.getArgument(0));
            return new ServerCall.Listener<String>() {};
        });

        ServerCall.Listener<String> listener = interceptor.interceptCall(
                createServerCall("audio.Video/Stream"), headers, next);
        listener.onCancel();
        wrapped.get().close(Status.CANCELLED, new Metadata());

        String scrape = interceptor.scrape();
        assertThat(scrape).contains(
                "grpc_server_handled_total{grpc_method=\"audio.Video/Stream\",grpc_code=\"CANCELLED\"} 1",
                "grpc_server_handling_seconds_count{grpc_method=\"audio.Video/Stream\"} 1");
    }

    @Test
    @DisplayName("Should expose only bounded provider readiness and fail closed on probe errors")
    void shouldExposeBoundedReadinessAndFailClosedOnProbeErrors() {
        MetricsServerInterceptor interceptor = new MetricsServerInterceptor();
        AtomicBoolean ready = new AtomicBoolean();
        Runnable unregister = interceptor.registerServiceReadiness("stt-service", ready::get);
        interceptor.registerServiceReadiness("tenant-42-request-secret", () -> true);

        assertThat(interceptor.scrape()).contains("av_service_readiness{service=\"stt\"} 0")
                .doesNotContain("tenant-42", "request-secret");

        ready.set(true);
        assertThat(interceptor.scrape()).contains("av_service_readiness{service=\"stt\"} 1");

        unregister.run();
        assertThat(interceptor.scrape()).doesNotContain("av_service_readiness{service=\"stt\"");

        interceptor.registerServiceReadiness("vision-service", () -> {
            throw new IllegalStateException("sensitive provider detail");
        });
        assertThat(interceptor.scrape()).contains("av_service_readiness{service=\"vision\"} 0")
                .doesNotContain("sensitive provider detail");
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
