package com.ghatana.audio.video.common.security;

import com.google.protobuf.MessageLite;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.Status;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The input-validation interceptor is the innermost defense against oversized
 * request payloads: a serialized size above the configured bound must close the
 * call INVALID_ARGUMENT before the message reaches the service, while
 * in-budget and non-protobuf messages pass through untouched.
 */
@DisplayName("Input Validation Server Interceptor Tests")
class InputValidationServerInterceptorTest {

    @SuppressWarnings("unchecked")
    private static ServerCall.Listener<Object> listenerFor(
            ServerCallHandler<Object, Object> handler) {
        ServerCall.Listener<Object> listener = mock(ServerCall.Listener.class);
        when(handler.startCall(any(), any())).thenReturn(listener);
        return listener;
    }

    private static MethodDescriptor<Object, Object> method() {
        return MethodDescriptor.<Object, Object>newBuilder()
                .setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName("ghatana.media.Test/Frobnicate")
                .setRequestMarshaller(mock(MethodDescriptor.Marshaller.class))
                .setResponseMarshaller(mock(MethodDescriptor.Marshaller.class))
                .build();
    }

    @Test
    @DisplayName("Oversized protobuf messages close the call INVALID_ARGUMENT and are never delivered")
    void rejectsOversizedMessageBeforeDelivery() {
        var interceptor = new InputValidationServerInterceptor();
        ServerCall<Object, Object> call = mock(ServerCall.class);
        when(call.getMethodDescriptor()).thenReturn(method());
        ServerCallHandler<Object, Object> handler = mock(ServerCallHandler.class);
        ServerCall.Listener<Object> delegate = listenerFor(handler);

        ServerCall.Listener<Object> listener =
                interceptor.interceptCall(call, new Metadata(), handler);

        MessageLite oversized = mock(MessageLite.class);
        // The default bound is 100 MiB; a larger serialized payload must be refused.
        when(oversized.getSerializedSize()).thenReturn(100 * 1024 * 1024 + 1);
        listener.onMessage(oversized);

        verify(call).close(
                argThat(status -> status.getCode() == Status.Code.INVALID_ARGUMENT),
                any(Metadata.class));
        verify(delegate, org.mockito.Mockito.never()).onMessage(any());
    }

    @Test
    @DisplayName("In-budget protobuf and non-protobuf messages are delivered untouched")
    void deliversInBudgetMessages() {
        var interceptor = new InputValidationServerInterceptor();
        ServerCall<Object, Object> call = mock(ServerCall.class);
        when(call.getMethodDescriptor()).thenReturn(method());
        ServerCallHandler<Object, Object> handler = mock(ServerCallHandler.class);
        ServerCall.Listener<Object> delegate = listenerFor(handler);

        ServerCall.Listener<Object> listener =
                interceptor.interceptCall(call, new Metadata(), handler);

        MessageLite small = mock(MessageLite.class);
        when(small.getSerializedSize()).thenReturn(1024);
        listener.onMessage(small);
        verify(delegate).onMessage(small);

        // Non-protobuf request types skip the serialized-size check entirely.
        listener.onMessage("plain-object");
        verify(delegate).onMessage("plain-object");
    }
}
