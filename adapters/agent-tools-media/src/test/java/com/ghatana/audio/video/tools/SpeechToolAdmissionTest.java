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
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
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

            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(providerCalls).hasValue(0);
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
}
