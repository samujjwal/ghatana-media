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

@DisplayName("Circuit Breaker Server Interceptor Tests")
class CircuitBreakerServerInterceptorTest {

    @Test
    @DisplayName("Should open after consecutive transport failures and reject subsequent calls")
    void shouldOpenAfterConsecutiveTransportFailures() { 
        CircuitBreakerServerInterceptor interceptor = new CircuitBreakerServerInterceptor(2, 1_000); 
        Metadata headers = new Metadata(); 
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        ServerCall<String, String> firstCall = createServerCall("audio.Video/Transcribe");
        ServerCall<String, String> secondCall = createServerCall("audio.Video/Transcribe");
        ServerCall<String, String> rejectedCall = createServerCall("audio.Video/Transcribe");

        interceptor.interceptCall(firstCall, headers, next); 
        interceptor.interceptCall(secondCall, headers, next); 

        @SuppressWarnings("unchecked")
        ArgumentCaptor<ServerCall<String, String>> wrappedCallCaptor = ArgumentCaptor.forClass(ServerCall.class); 
        verify(next, times(2)).startCall(wrappedCallCaptor.capture(), eq(headers)); 

        wrappedCallCaptor.getAllValues().get(0).close(Status.INTERNAL, new Metadata()); 
        wrappedCallCaptor.getAllValues().get(1).close(Status.UNAVAILABLE, new Metadata()); 

        interceptor.interceptCall(rejectedCall, headers, next); 

        ArgumentCaptor<Status> statusCaptor = ArgumentCaptor.forClass(Status.class); 
        verify(rejectedCall).close(statusCaptor.capture(), any(Metadata.class)); 
        assertThat(statusCaptor.getValue().getCode()).isEqualTo(Status.Code.UNAVAILABLE); 
        assertThat(statusCaptor.getValue().getDescription()).contains("Circuit breaker OPEN");
        verify(next, times(2)).startCall(any(), eq(headers)); 
    }

    @Test
    @DisplayName("Should ignore business failures when tracking breaker state")
    void shouldIgnoreBusinessFailures() { 
        CircuitBreakerServerInterceptor interceptor = new CircuitBreakerServerInterceptor(1, 1_000); 
        Metadata headers = new Metadata(); 
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        ServerCall<String, String> firstCall = createServerCall("audio.Video/Analyze");
        ServerCall<String, String> secondCall = createServerCall("audio.Video/Analyze");

        interceptor.interceptCall(firstCall, headers, next); 

        @SuppressWarnings("unchecked")
        ArgumentCaptor<ServerCall<String, String>> wrappedCallCaptor = ArgumentCaptor.forClass(ServerCall.class); 
        verify(next).startCall(wrappedCallCaptor.capture(), eq(headers)); 
        wrappedCallCaptor.getValue().close(Status.INVALID_ARGUMENT, new Metadata()); 

        interceptor.interceptCall(secondCall, headers, next); 

        verify(next, times(2)).startCall(any(), eq(headers)); 
        verify(secondCall, never()).close(any(Status.class), any(Metadata.class)); 
    }

    @Test
    @DisplayName("Should transition through half-open and close again after success")
    void shouldRecoverFromHalfOpen() { 
        CircuitBreakerServerInterceptor interceptor = new CircuitBreakerServerInterceptor(1, 0); 
        Metadata headers = new Metadata(); 
        @SuppressWarnings("unchecked")
        ServerCallHandler<String, String> next = mock(ServerCallHandler.class); 
        when(next.startCall(any(), eq(headers))).thenReturn(new ServerCall.Listener<>() {}); 

        ServerCall<String, String> failingCall = createServerCall("audio.Video/Synthesize");
        ServerCall<String, String> probeCall = createServerCall("audio.Video/Synthesize");
        ServerCall<String, String> recoveredCall = createServerCall("audio.Video/Synthesize");

        interceptor.interceptCall(failingCall, headers, next); 

        @SuppressWarnings("unchecked")
        ArgumentCaptor<ServerCall<String, String>> wrappedCallCaptor = ArgumentCaptor.forClass(ServerCall.class); 
        verify(next).startCall(wrappedCallCaptor.capture(), eq(headers)); 
        wrappedCallCaptor.getValue().close(Status.INTERNAL, new Metadata()); 

        interceptor.interceptCall(probeCall, headers, next); 
        verify(next, times(2)).startCall(wrappedCallCaptor.capture(), eq(headers)); 
        wrappedCallCaptor.getAllValues().get(1).close(Status.OK, new Metadata()); 

        interceptor.interceptCall(recoveredCall, headers, next); 

        verify(next, times(3)).startCall(any(), eq(headers)); 
        verify(recoveredCall, never()).close(any(Status.class), any(Metadata.class)); 
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
