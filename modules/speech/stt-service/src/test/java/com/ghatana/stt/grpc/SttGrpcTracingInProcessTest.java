package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.google.protobuf.ByteString;
import io.grpc.ManagedChannel;
import io.grpc.Server;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.stub.ClientResponseObserver;
import io.grpc.stub.ClientCallStreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanBuilder;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.doAnswer;

class SttGrpcTracingInProcessTest {

    @Test
    void successfulTranscriptionEndsRedactedSuccessSpan() throws Exception {
        TraceHarness trace = new TraceHarness();
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.transcribe(any(AudioData.class), any())).thenReturn(result());

        try (InProcessCall call = new InProcessCall(new SttGrpcService(library,
                new SimpleMeterRegistry(), trace.tracer,
                request -> SttRequestAuthorization.Decision.ADMITTED))) {
            STTServiceGrpc.newBlockingStub(call.channel).transcribe(request("en", "opaque-marker"));
        }

        verify(trace.tracer).spanBuilder("audiovideo.stt.transcribe");
        verify(trace.builder).setAttribute("stt.language", "en");
        verify(trace.span).setStatus(StatusCode.OK);
        verify(trace.span).end();
    }

    @Test
    void invalidRequestEndsErrorSpanWithoutExportingInputOrErrorMessage() throws Exception {
        TraceHarness trace = new TraceHarness();
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        try (InProcessCall call = new InProcessCall(new SttGrpcService(library,
                new SimpleMeterRegistry(), trace.tracer,
                request -> SttRequestAuthorization.Decision.ADMITTED))) {
            try {
                STTServiceGrpc.newBlockingStub(call.channel).transcribe(request("sensitive-marker", "private"));
            } catch (io.grpc.StatusRuntimeException expected) {
                assertThat(expected.getStatus().getCode()).isEqualTo(io.grpc.Status.Code.INVALID_ARGUMENT);
            }
        }

        verify(trace.builder).setAttribute("stt.language", "other");
        verify(trace.builder, never()).setAttribute(anyString(), eq("sensitive-marker"));
        verify(trace.span).setStatus(StatusCode.ERROR, "Media operation failed");
        verify(trace.span).setAttribute("error.type", "StatusRuntimeException");
        verify(trace.span, never()).setAttribute(anyString(), eq("private"));
        verify(trace.span).end();
    }

    @Test
    void cancelledTranscriptionEndsUnknownSpan() throws Exception {
        TraceHarness trace = new TraceHarness();
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine engine = mock(SttEngine.class);
        CountDownLatch providerStarted = new CountDownLatch(1);
        CountDownLatch finishProvider = new CountDownLatch(1);
        CountDownLatch providerFinished = new CountDownLatch(1);
        when(library.getSttEngine()).thenReturn(engine);
        when(engine.transcribe(any(AudioData.class), any())).thenAnswer(invocation -> {
            providerStarted.countDown();
            try {
                if (!finishProvider.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("test provider wait expired");
                }
                return result();
            } finally {
                providerFinished.countDown();
            }
        });

        try (InProcessCall call = new InProcessCall(new SttGrpcService(library,
                new SimpleMeterRegistry(), trace.tracer,
                request -> SttRequestAuthorization.Decision.ADMITTED))) {
            AtomicReference<ClientCallStreamObserver<Object>> requestStream = new AtomicReference<>();
            STTServiceGrpc.newStub(call.channel).transcribe(request("en", "private-content"),
                    new ClientResponseObserver<Object, TranscribeResponse>() {
                        @Override
                        public void beforeStart(ClientCallStreamObserver<Object> stream) {
                            requestStream.set(stream);
                        }

                        @Override public void onNext(TranscribeResponse value) {}
                        @Override public void onError(Throwable failure) {}
                        @Override public void onCompleted() {}
                    });

            assertThat(providerStarted.await(5, TimeUnit.SECONDS)).isTrue();
            requestStream.get().cancel("private-cancel-reason", null);
            finishProvider.countDown();
            assertThat(providerFinished.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(trace.spanEnded.await(5, TimeUnit.SECONDS)).isTrue();
        }

        verify(trace.span).setAttribute("media.outcome", "unknown");
        verify(trace.span, never()).setAttribute(anyString(), eq("private-content"));
        verify(trace.span).end();
    }

    private static TranscribeRequest request(String language, String marker) {
        return TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(wav(marker)))
                .setSampleRate(16_000)
                .setLanguage(language)
                .build();
    }

    private static TranscriptionResult result() {
        return new TranscriptionResult("safe words", 0.9, Collections.emptyList(), Collections.emptyList(),
                Duration.ofMillis(1), "en", "test-model");
    }

    private static byte[] wav(String marker) {
        byte[] payload = marker.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (payload.length % 2 != 0) payload = java.util.Arrays.copyOf(payload, payload.length + 1);
        int dataSize = payload.length;
        ByteBuffer bytes = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN);
        bytes.put("RIFF".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        bytes.putInt(36 + dataSize);
        bytes.put("WAVEfmt ".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        bytes.putInt(16);
        bytes.putShort((short) 1);
        bytes.putShort((short) 1);
        bytes.putInt(16_000);
        bytes.putInt(32_000);
        bytes.putShort((short) 2);
        bytes.putShort((short) 16);
        bytes.put("data".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        bytes.putInt(dataSize);
        bytes.put(payload);
        return bytes.array();
    }

    private static final class TraceHarness {
        private final Tracer tracer = mock(Tracer.class);
        private final SpanBuilder builder = mock(SpanBuilder.class);
        private final Span span = mock(Span.class);
        private final CountDownLatch spanEnded = new CountDownLatch(1);

        private TraceHarness() {
            when(tracer.spanBuilder("audiovideo.stt.transcribe")).thenReturn(builder);
            when(builder.setSpanKind(SpanKind.INTERNAL)).thenReturn(builder);
            when(builder.setAttribute(anyString(), anyBoolean())).thenReturn(builder);
            when(builder.setAttribute(anyString(), anyString())).thenReturn(builder);
            when(builder.startSpan()).thenReturn(span);
            when(span.makeCurrent()).thenReturn(mock(Scope.class));
            doAnswer(invocation -> {
                spanEnded.countDown();
                return null;
            }).when(span).end();
        }
    }

    private static final class InProcessCall implements AutoCloseable {
        private final Server server;
        private final ManagedChannel channel;

        private InProcessCall(SttGrpcService service) throws Exception {
            String name = InProcessServerBuilder.generateName();
            server = InProcessServerBuilder.forName(name).addService(service).build().start();
            channel = InProcessChannelBuilder.forName(name).build();
        }

        @Override
        public void close() {
            channel.shutdownNow();
            server.shutdownNow();
        }
    }
}
