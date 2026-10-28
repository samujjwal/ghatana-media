package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.tts.engine.TtsSynthesisEngine;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.service.PersistentTtsService;
import io.activej.promise.Promise;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;
import org.junit.jupiter.api.Test;
import org.apache.logging.log4j.ThreadContext;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyFloat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class TtsGrpcLogPrivacyTest {
    private static final String TEXT_MARKER = "tts-text-secret-marker";
    private static final String VOICE_MARKER = "tts-voice-secret-marker";
    private static final String TENANT_MARKER = "tts-tenant-secret-marker";
    private static final String PROVIDER_MARKER = "tts-provider-exception-secret-marker";

    @Test
    void directServiceLogsAndClientErrorsOmitTextAndVoiceMarkers() {
        TtsGrpcService service = new TtsGrpcService(mock(AudioVideoLibrary.class), new SimpleMeterRegistry());
        CapturingObserver<com.ghatana.tts.core.grpc.proto.SynthesizeResponse> observer = new CapturingObserver<>();

        try (LogCapture logs = capture(TtsGrpcService.class)) {
            service.synthesize(SynthesizeRequest.newBuilder()
                    .setText(TEXT_MARKER)
                    .setVoiceId(VOICE_MARKER)
                    .build(), observer);

            assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
            assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(Status.Code.UNAVAILABLE);
            assertThat(Status.fromThrowable(observer.error).getDescription())
                    .contains("TTS locale/voice NOT_ADMITTED", "no exact admitted voice-language-rights profile")
                    .doesNotContain(TEXT_MARKER, VOICE_MARKER);
            assertMarkersAbsent(logs.output(), TEXT_MARKER, VOICE_MARKER);
        }
    }

    @Test
    void providerCannotForgeLocalAdmissionReasonWithPrefix() throws ReflectiveOperationException {
        String localeSecret = "provider-locale-reason-secret-marker";
        String streamSecret = "provider-stream-reason-secret-marker";
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        TtsEngine engine = mock(TtsEngine.class);
        when(library.getTtsEngine()).thenReturn(engine);
        TtsRequestAuthorization authorization = new TtsRequestAuthorization() {
            @Override public Decision authorize(Request request) { return Decision.ADMITTED; }
        };
        TtsGrpcService service = new TtsGrpcService(
                library, new SimpleMeterRegistry(), () -> true, () -> true, Duration.ofSeconds(1),
                authorization, (voice, language) -> true);
        when(engine.synthesize(any(), any())).thenThrow(new TtsSynthesisEngine.SynthesisException(
                "TTS locale/voice NOT_ADMITTED: " + localeSecret,
                TtsSynthesisEngine.FailureReason.NOT_ADMITTED));
        when(engine.startStreaming(any(), any(), any())).thenThrow(new TtsSynthesisEngine.SynthesisException(
                "TTS streaming is NOT_ADMITTED: " + streamSecret,
                TtsSynthesisEngine.FailureReason.NOT_ADMITTED));

        var verifiedIdentityField = JwtServerInterceptor.class.getDeclaredField("VERIFIED_IDENTITY");
        verifiedIdentityField.setAccessible(true);
        @SuppressWarnings("unchecked")
        Context.Key<JwtServerInterceptor.VerifiedIdentity> identityKey =
                (Context.Key<JwtServerInterceptor.VerifiedIdentity>) verifiedIdentityField.get(null);
        Context context = Context.current().withValue(identityKey,
                new JwtServerInterceptor.VerifiedIdentity("test-subject", "test-tenant"));
        Context previousContext = context.attach();
        try {
            CapturingObserver<com.ghatana.tts.core.grpc.proto.SynthesizeResponse> synthesis = new CapturingObserver<>();
            CapturingObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> streaming = new CapturingObserver<>();
            try (LogCapture logs = capture(TtsGrpcService.class)) {
                service.synthesize(SynthesizeRequest.newBuilder()
                        .setText(TEXT_MARKER).setVoiceId("test-voice").build(), synthesis);
                service.streamSynthesize(SynthesizeRequest.newBuilder()
                        .setText(TEXT_MARKER).setVoiceId("test-voice").build(), streaming);

                for (Throwable failure : List.of(synthesis.error, streaming.error)) {
                    assertThat(failure).isInstanceOf(StatusRuntimeException.class);
                    assertThat(Status.fromThrowable(failure).getCode()).isEqualTo(Status.Code.UNAVAILABLE);
                    assertThat(Status.fromThrowable(failure).getDescription())
                            .isEqualTo("TTS_NOT_ADMITTED: synthesis provider or capability is unavailable")
                            .doesNotContain(localeSecret, streamSecret, TEXT_MARKER);
                }
                assertMarkersAbsent(logs.output(), localeSecret, streamSecret, TEXT_MARKER);
            }
        } finally {
            context.detach(previousContext);
        }
    }

    @Test
    void persistentServiceOmitsRequestIdentityAndProviderExceptionFromLogsAndPreservesMdcScope() {
        PersistentTtsService persistence = mock(PersistentTtsService.class);
        when(persistence.synthesizeAndPersist(
                eq(TENANT_MARKER), any(UUID.class), eq(TEXT_MARKER), any(), anyFloat(), anyFloat(), isNull()))
                .thenReturn(Promise.ofException(new RuntimeException(PROVIDER_MARKER)));
        PersistentTtsGrpcService service = new PersistentTtsGrpcService(persistence);
        CapturingObserver<com.ghatana.tts.core.grpc.proto.SynthesizeResponse> observer = new CapturingObserver<>();
        String subjectId = UUID.randomUUID().toString();
        Context context = Context.current()
                .withValue(JwtServerInterceptor.CTX_TENANT, TENANT_MARKER)
                .withValue(JwtServerInterceptor.CTX_SUBJECT, subjectId);
        String previousScope = ThreadContext.get("testScope");
        Context previousContext = context.attach();
        ThreadContext.put("testScope", "caller-owned");

        try (LogCapture logs = capture(PersistentTtsGrpcService.class)) {
            service.synthesize(SynthesizeRequest.newBuilder().setText(TEXT_MARKER).build(), observer);

            assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
            assertThat(Status.fromThrowable(observer.error).getCode()).isEqualTo(Status.Code.INTERNAL);
            assertThat(Status.fromThrowable(observer.error).getDescription()).isEqualTo("TTS synthesis failed");
            assertMarkersAbsent(logs.output(), TEXT_MARKER, TENANT_MARKER, subjectId, PROVIDER_MARKER);
            assertThat(ThreadContext.get("testScope")).isEqualTo("caller-owned");
        } finally {
            context.detach(previousContext);
            if (previousScope == null) ThreadContext.remove("testScope");
            else ThreadContext.put("testScope", previousScope);
        }
    }

    private static void assertMarkersAbsent(String output, String... markers) {
        for (String marker : markers) assertThat(output).doesNotContain(marker);
    }

    private static LogCapture capture(Class<?> loggerClass) {
        LoggerContext context = (LoggerContext) org.apache.logging.log4j.LogManager.getContext(false);
        org.apache.logging.log4j.core.Logger logger = context.getLogger(loggerClass.getName());
        LogCapture appender = new LogCapture("tts-privacy-" + loggerClass.getSimpleName(), logger, logger.getLevel());
        appender.start();
        logger.addAppender(appender);
        logger.setLevel(Level.DEBUG);
        return appender;
    }

    private static final class LogCapture extends AbstractAppender implements AutoCloseable {
        private final List<String> entries = new ArrayList<>();
        private final org.apache.logging.log4j.core.Logger logger;
        private final Level previousLevel;

        LogCapture(String name, org.apache.logging.log4j.core.Logger logger, Level previousLevel) {
            super(name, null, null, true, Property.EMPTY_ARRAY);
            this.logger = logger;
            this.previousLevel = previousLevel;
        }

        @Override public void append(LogEvent event) {
            StringBuilder entry = new StringBuilder(event.getMessage().getFormattedMessage())
                    .append(' ').append(event.getContextData().toMap());
            if (event.getThrown() != null) {
                StringWriter stack = new StringWriter();
                event.getThrown().printStackTrace(new PrintWriter(stack));
                entry.append(' ').append(stack);
            }
            entries.add(entry.toString());
        }

        String output() { return String.join("\n", entries); }

        @Override public void close() {
            logger.removeAppender(this);
            logger.setLevel(previousLevel);
            stop();
        }
    }

    private static final class CapturingObserver<T> implements StreamObserver<T> {
        private Throwable error;
        @Override public void onNext(T value) { }
        @Override public void onError(Throwable failure) { error = failure; }
        @Override public void onCompleted() { }
    }
}
