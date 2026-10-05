package com.ghatana.audio.video.common.resilience;

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
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * @doc.type class
 * @doc.purpose Verify audio-video gRPC throttling reuses the shared platform token bucket
 * @doc.layer product
 * @doc.pattern Unit Test
 */
@DisplayName("Rate Limiting Server Interceptor Tests")
class RateLimitingServerInterceptorTest {

    @Test
    @DisplayName("Should reject a second in-flight call when concurrency is exhausted")
    void shouldRejectWhenConcurrencyIsExhausted() { 
        RateLimitingServerInterceptor interceptor = new RateLimitingServerInterceptor(50.0, 10L, 1); 
        Metadata headers = new Metadata(); 
        ServerCall<String, String> firstCall = createServerCall("audio.Video/Recognize");
        ServerCall<String, String> secondCall = createServerCall("audio.Video/Recognize");
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        interceptor.interceptCall(firstCall, headers, next); 
        interceptor.interceptCall(secondCall, headers, next); 

        verify(secondCall).close(any(Status.class), any(Metadata.class)); 

        ArgumentCaptor<Status> statusCaptor = ArgumentCaptor.forClass(Status.class); 
        verify(secondCall).close(statusCaptor.capture(), any(Metadata.class)); 
        assertThat(statusCaptor.getValue().getCode()).isEqualTo(Status.Code.RESOURCE_EXHAUSTED); 
        assertThat(statusCaptor.getValue().getDescription()).contains("overloaded");
    }

    @Test
    @DisplayName("Should reject repeated calls when the per-method shared rate limit is exceeded")
    void shouldRejectWhenRateLimitIsExceeded() { 
        RateLimitingServerInterceptor interceptor = new RateLimitingServerInterceptor(1.0, 1L, 2); 
        Metadata headers = new Metadata(); 
        ServerCall<String, String> firstCall = createServerCall("audio.Video/Transcribe");
        ServerCall<String, String> secondCall = createServerCall("audio.Video/Transcribe");
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        interceptor.interceptCall(firstCall, headers, next); 

        @SuppressWarnings("unchecked")
        ArgumentCaptor<ServerCall<String, String>> wrappedCallCaptor = ArgumentCaptor.forClass(ServerCall.class); 
        verify(next).startCall(wrappedCallCaptor.capture(), eq(headers)); 
        wrappedCallCaptor.getValue().close(Status.OK, new Metadata()); 

        interceptor.interceptCall(secondCall, headers, next); 

        ArgumentCaptor<Status> statusCaptor = ArgumentCaptor.forClass(Status.class); 
        verify(secondCall).close(statusCaptor.capture(), any(Metadata.class)); 
        assertThat(statusCaptor.getValue().getCode()).isEqualTo(Status.Code.RESOURCE_EXHAUSTED); 
        assertThat(statusCaptor.getValue().getDescription()).contains("Rate limit exceeded");
    }

    @Test
    @DisplayName("Should allow separate methods to use independent shared rate buckets")
    void shouldAllowSeparateMethodsToUseIndependentBuckets() { 
        RateLimitingServerInterceptor interceptor = new RateLimitingServerInterceptor(1.0, 1L, 2); 
        Metadata headers = new Metadata(); 
        ServerCall<String, String> transcribeCall = createServerCall("audio.Video/Transcribe");
        ServerCall<String, String> synthesizeCall = createServerCall("audio.Video/Synthesize");
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        interceptor.interceptCall(transcribeCall, headers, next); 
        interceptor.interceptCall(synthesizeCall, headers, next); 

        verify(next, times(2)).startCall(any(), eq(headers)); 
        verify(synthesizeCall, never()).close(any(Status.class), any(Metadata.class)); 
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
