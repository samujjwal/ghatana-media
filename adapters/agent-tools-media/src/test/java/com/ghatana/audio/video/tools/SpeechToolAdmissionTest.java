/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.toolruntime.ToolHandler;
import com.ghatana.tools.testing.EventloopTestBase;
import io.activej.promise.Promise;
import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Configuration;
import org.apache.logging.log4j.core.config.LoggerConfig;
import org.apache.logging.log4j.core.config.Property;
import org.junit.jupiter.api.Test;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/** Focused AT-03 tests for the currently unadmitted STT and TTS boundaries. */
final class SpeechToolAdmissionTest extends EventloopTestBase {

    @Test
    void sttDoesNotDispatchEvenWithConfiguredDelegateOrArtifactInput() {
        AtomicInteger providerCalls = new AtomicInteger();
        ToolHandler delegate = countingDelegate(providerCalls);
        ToolExecutionEnvelope envelope = envelope("av.speech-to-text", Map.of(
                "audioSource", Map.of("mediaArtifactId", "artifact-v1"),
                "languageCode", "en-US"));

        ToolExecutionResult result = await(new SpeechToTextToolHandler(delegate).handle(envelope, contract(envelope)));

        assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(result.output()).isNull();
        assertThat(result.failure().kind()).isEqualTo(com.ghatana.agent.framework.tools.ToolExecutionFailure.Kind.UNAVAILABLE);
        assertThat(result.failure().stage()).isEqualTo(com.ghatana.agent.framework.tools.ToolExecutionFailure.Stage.ADMISSION);
        assertThat(result.failure().code()).isEqualTo("STT_NOT_ADMITTED");
        assertThat(result.invocationId()).isEqualTo(envelope.invocationId());
        assertThat(result.correlationId()).isEqualTo(envelope.invocationId());
        assertThat(result.sideEffectSummary()).isEmpty();
        assertThat(result.operationId()).isNull();
        assertThat(result.attemptId()).isNull();
        assertThat(providerCalls).hasValue(0);
    }

    @Test
    void ttsDoesNotDispatchWithoutConsentVoiceQualificationOrOutputReceipt() {
        AtomicInteger providerCalls = new AtomicInteger();
        ToolHandler delegate = countingDelegate(providerCalls);
        ToolExecutionEnvelope envelope = envelope("av.text-to-speech", Map.of(
                "text", "hello", "voiceId", "en-US-default", "storeAsArtifact", true));

        ToolExecutionResult result = await(new TextToSpeechToolHandler(delegate).handle(envelope, contract(envelope)));

        assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(result.output()).isNull();
        assertThat(result.failure().kind()).isEqualTo(com.ghatana.agent.framework.tools.ToolExecutionFailure.Kind.UNAVAILABLE);
        assertThat(result.failure().stage()).isEqualTo(com.ghatana.agent.framework.tools.ToolExecutionFailure.Stage.ADMISSION);
        assertThat(result.failure().code()).isEqualTo("TTS_NOT_ADMITTED");
        assertThat(result.invocationId()).isEqualTo(envelope.invocationId());
        assertThat(result.correlationId()).isEqualTo(envelope.invocationId());
        assertThat(result.sideEffectSummary()).isEmpty();
        assertThat(result.operationId()).isNull();
        assertThat(result.attemptId()).isNull();
        assertThat(providerCalls).hasValue(0);
    }

    @Test
    void unqualifiedModelAndUnreceiptedVoiceInputsCannotReachEitherSpeechDelegate() {
        AtomicInteger providerCalls = new AtomicInteger();
        ToolHandler delegate = countingDelegate(providerCalls);

        for (String toolId : Set.of("av.speech-to-text", "av.text-to-speech")) {
            Map<String, Object> input = toolId.equals("av.speech-to-text")
                    ? Map.of("audioSource", Map.of("mediaArtifactId", "artifact-v1"), "model", "enhanced")
                    : Map.of("text", "hello", "voiceId", "voice-v1");
            ToolExecutionEnvelope envelope = ToolExecutionEnvelope.of(
                    toolId, "1.0.0", "caller-agent", null, "tenant-at03",
                    ToolActionClass.CALL_EXTERNAL, "1.0", input);
            ToolContract mismatched = contract(envelope);

            ToolExecutionResult result = await((toolId.equals("av.speech-to-text")
                    ? new SpeechToTextToolHandler(delegate)
                    : new TextToSpeechToolHandler(delegate)).handle(envelope, mismatched));

            String expectedUnavailableCode = toolId.equals("av.speech-to-text")
                    ? "STT_NOT_ADMITTED" : "TTS_NOT_ADMITTED";
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.output()).isNull();
            assertThat(result.failure().kind()).isEqualTo(
                    com.ghatana.agent.framework.tools.ToolExecutionFailure.Kind.UNAVAILABLE);
            assertThat(result.failure().stage()).isEqualTo(
                    com.ghatana.agent.framework.tools.ToolExecutionFailure.Stage.ADMISSION);
            assertThat(result.failure().code()).isEqualTo(expectedUnavailableCode);
            assertThat(result.sideEffectSummary()).isEmpty();
            assertThat(providerCalls).hasValue(0);
        }
    }

    @Test
    void sensitiveSpeechInputsAndValidationExceptionsDoNotReachResultsOrLogs() {
        AtomicInteger providerCalls = new AtomicInteger();
        ToolHandler delegate = countingDelegate(providerCalls);
        List<String> capturedLogs = new ArrayList<>();
        CapturingAppender appender = attachCapture(capturedLogs);

        try {
            String audioSourceSecret = "audio-source-secret-" + "a".repeat(520);
            ToolExecutionEnvelope sttEnvelope = envelope("av.speech-to-text", Map.of(
                    "audioSource", Map.of("mediaArtifactId", audioSourceSecret),
                    "languageCode", "en-US"));
            ToolExecutionResult sttResult = await(new SpeechToTextToolHandler(delegate)
                    .handle(sttEnvelope, contract(sttEnvelope)));
            String validAudioSourceSecret = "audio-source-ref-private-sentinel";
            ToolExecutionEnvelope admittedSttEnvelope = envelope("av.speech-to-text", Map.of(
                    "audioSource", Map.of("mediaArtifactId", validAudioSourceSecret),
                    "languageCode", "en-US"));
            ToolExecutionResult admittedSttResult = await(new SpeechToTextToolHandler(delegate)
                    .handle(admittedSttEnvelope, contract(admittedSttEnvelope)));

            String textSecret = "private-transcript-sentinel";
            String voiceSecret = "voice-secret-" + "v".repeat(140);
            ToolExecutionEnvelope ttsEnvelope = envelope("av.text-to-speech", Map.of(
                    "text", textSecret, "voiceId", voiceSecret));
            ToolExecutionResult ttsResult = await(new TextToSpeechToolHandler(delegate)
                    .handle(ttsEnvelope, contract(ttsEnvelope)));
            String qualifiedVoiceSecret = "private-voice-id-sentinel";
            ToolExecutionEnvelope validTtsEnvelope = envelope("av.text-to-speech", Map.of(
                    "text", textSecret, "voiceId", qualifiedVoiceSecret));
            ToolExecutionResult validTtsResult = await(new TextToSpeechToolHandler(delegate)
                    .handle(validTtsEnvelope, contract(validTtsEnvelope)));

            assertThat(sttResult.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
            assertThat(sttResult.errorMessage()).isEqualTo("TOOL_EXECUTION_FAILED");
            assertThat(admittedSttResult.failure().code()).isEqualTo("STT_NOT_ADMITTED");
            assertThat(ttsResult.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
            assertThat(ttsResult.errorMessage()).isEqualTo("TOOL_EXECUTION_FAILED");
            assertThat(validTtsResult.failure().code()).isEqualTo("TTS_NOT_ADMITTED");
            assertThat(sttResult.toString()).doesNotContain(audioSourceSecret);
            assertThat(admittedSttResult.toString()).doesNotContain(validAudioSourceSecret);
            assertThat(ttsResult.toString()).doesNotContain(textSecret, voiceSecret);
            assertThat(validTtsResult.toString()).doesNotContain(textSecret, qualifiedVoiceSecret);
            assertThat(String.join("\n", capturedLogs))
                    .doesNotContain(audioSourceSecret, validAudioSourceSecret, textSecret, voiceSecret,
                            qualifiedVoiceSecret, "tenant-at03")
                    .contains("INVALID_MEDIAARTIFACTID", "INVALID_VOICEID")
                    .doesNotContain(sttEnvelope.invocationId(), admittedSttEnvelope.invocationId(),
                            ttsEnvelope.invocationId(), validTtsEnvelope.invocationId());
            assertThat(providerCalls).hasValue(0);
        } finally {
            detachCapture(appender);
        }
    }

    private ToolHandler countingDelegate(AtomicInteger calls) {
        return (envelope, contract) -> {
            calls.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(envelope.invocationId(), Map.of(), Map.of(),
                    envelope.invocationId(), Instant.now(), Duration.ZERO));
        };
    }

    private ToolExecutionEnvelope envelope(String toolId, Map<String, Object> input) {
        return ToolExecutionEnvelope.of(toolId, "1.0.0", "caller-agent", null,
                "tenant-at03", ToolActionClass.CALL_EXTERNAL, "1.0", input);
    }

    private ToolContract contract(ToolExecutionEnvelope envelope) {
        return new ToolContract(envelope.toolId(), envelope.toolVersion(), "test", "test",
                envelope.actionClass(), false, true, Map.of(), Map.of(), Set.of(),
                ToolTransport.IN_PROCESS, null, Map.of());
    }

    private ToolExecutionResult await(Promise<ToolExecutionResult> promise) {
        return runPromise(() -> promise);
    }

    private CapturingAppender attachCapture(List<String> messages) {
        LoggerContext context = (LoggerContext) LogManager.getContext(false);
        Configuration configuration = context.getConfiguration();
        LoggerConfig root = configuration.getRootLogger();
        CapturingAppender appender = new CapturingAppender(messages);
        appender.start();
        appender.previousRootLevel = root.getLevel();
        root.addAppender(appender, Level.ALL, null);
        root.setLevel(Level.ALL);
        context.updateLoggers();
        return appender;
    }

    private void detachCapture(CapturingAppender appender) {
        LoggerContext context = (LoggerContext) LogManager.getContext(false);
        LoggerConfig root = context.getConfiguration().getRootLogger();
        root.removeAppender(appender.getName());
        root.setLevel(appender.previousRootLevel);
        appender.stop();
        context.updateLoggers();
    }

    private static final class CapturingAppender extends AbstractAppender {
        private final List<String> messages;
        private Level previousRootLevel;

        private CapturingAppender(List<String> messages) {
            super("speech-tool-privacy-capture", null, null, true, Property.EMPTY_ARRAY);
            this.messages = messages;
        }

        @Override
        public void append(LogEvent event) {
            String message = event.getMessage().getFormattedMessage();
            Throwable thrown = event.getThrown();
            if (thrown == null) {
                messages.add(message);
            } else {
                StringWriter trace = new StringWriter();
                thrown.printStackTrace(new PrintWriter(trace));
                messages.add(message + " " + trace);
            }
        }
    }
}
