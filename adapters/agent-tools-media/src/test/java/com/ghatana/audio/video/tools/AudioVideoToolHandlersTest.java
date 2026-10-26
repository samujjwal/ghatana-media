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
import io.activej.promise.Promise;
import com.ghatana.tools.testing.EventloopTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.math.BigInteger;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Unit tests for all Audio-Video ToolHandler implementations and the factory.
 */
@DisplayName("AudioVideo ToolHandlers")
class AudioVideoToolHandlersTest extends EventloopTestBase {

    private ToolContract dummyContract;

    @BeforeEach
    void setUp() {
        dummyContract = new ToolContract(
                "test-tool", "1.0.0", "Test Tool", "description",
                ToolActionClass.CALL_EXTERNAL, false, true,
                Map.of(), Map.of(), Set.of(), ToolTransport.IN_PROCESS, null, Map.of());
    }

    private ToolExecutionEnvelope envelope(String toolId, Map<String, Object> input) {
        return ToolExecutionEnvelope.of(
                toolId, "1.0.0", "caller-agent", null,
                "tenant-test", ToolActionClass.CALL_EXTERNAL, "1.0", input);
    }

    private ToolContract contractFor(ToolExecutionEnvelope envelope) {
        return contractFor(envelope, Map.of("type", "object"));
    }

    private ToolContract contractFor(ToolExecutionEnvelope envelope, Map<String, Object> outputSchema) {
        return new ToolContract(envelope.toolId(), envelope.toolVersion(), "Test Tool", "description",
                envelope.actionClass(), false, true, Map.of(), outputSchema, Set.of(),
                ToolTransport.IN_PROCESS, null, Map.of());
    }

    private ToolExecutionResult await(Promise<ToolExecutionResult> p) {
        return runPromise(() -> p);
    }

    private com.ghatana.toolruntime.ToolHandler delegateReturning(Map<String, Object> output) {
        return (envelope, contract) -> Promise.of(ToolExecutionResult.succeeded(
                envelope.invocationId(),
                output,
                Map.of("provider", "test-delegate"),
                envelope.invocationId(),
                Instant.now(),
                Duration.ZERO));
    }

    private void assertForwardsOriginalEnvelopeAndContract(
            ToolExecutionEnvelope envelope,
            Function<com.ghatana.toolruntime.ToolHandler, com.ghatana.toolruntime.ToolHandler> wrap) {
        AtomicReference<ToolExecutionEnvelope> receivedEnvelope = new AtomicReference<>();
        AtomicReference<ToolContract> receivedContract = new AtomicReference<>();
        Promise<ToolExecutionResult> delegatedPromise = Promise.of(ToolExecutionResult.succeeded(
                envelope.invocationId(), Map.of(), Map.of(), envelope.invocationId(), Instant.now(), Duration.ZERO));
        com.ghatana.toolruntime.ToolHandler delegate = (actualEnvelope, actualContract) -> {
            receivedEnvelope.set(actualEnvelope);
            receivedContract.set(actualContract);
            return delegatedPromise;
        };

        Promise<ToolExecutionResult> returnedPromise = wrap.apply(delegate).handle(envelope, contractFor(envelope));

        assertThat(returnedPromise).isNotSameAs(delegatedPromise);
        assertThat(await(returnedPromise).invocationId()).isEqualTo(envelope.invocationId());
        assertThat(receivedEnvelope.get()).isSameAs(envelope);
        assertThat(receivedContract.get()).isEqualTo(contractFor(envelope));
    }

    @Test
    @DisplayName("preserves non-final outcome-unknown delegate results without output inference")
    void preservesOutcomeUnknownDelegateResult() {
        ToolExecutionEnvelope env = envelope("av.text-to-speech", Map.of("text", "hello"));
        ToolContract contract = contractFor(env, Map.of("type", "object", "required", List.of("audioBytes")));
        com.ghatana.toolruntime.ToolHandler delegate = (ignoredEnvelope, ignoredContract) -> Promise.of(
                ToolExecutionResult.outcomeUnknown(env.invocationId(), "operation-1", "attempt-1",
                        env.invocationId(), "PROVIDER_ACK_UNKNOWN", Instant.now(), Duration.ZERO));

        ToolExecutionResult result = await(AgentToolInput.dispatch(delegate, env, contract));

        assertThat(result.status()).isEqualTo(ToolExecutionStatus.OUTCOME_UNKNOWN);
        assertThat(result.isFinal()).isFalse();
    }

    private ToolExecutionResult runWithOutputSchema(Map<String, Object> schema, Object output) {
        ToolExecutionEnvelope env = envelope("av.text-to-speech", Map.of("text", "hello"));
        ToolContract contract = contractFor(env, schema);
        com.ghatana.toolruntime.ToolHandler delegate = (delegateEnvelope, ignoredContract) -> Promise.of(
                ToolExecutionResult.succeeded(delegateEnvelope.invocationId(), output, Map.of(),
                        delegateEnvelope.invocationId(), Instant.now(), Duration.ZERO));
        return await(AgentToolInput.dispatch(delegate, env, contract));
    }

    @Test
    @DisplayName("uses full local Draft 2020-12 validation with bounded values and no remote reference fetch")
    void validatesCompleteSchemaWithoutRemoteFetch() {
        Map<String, Object> strictSchema = Map.of(
                "$schema", "https://json-schema.org/draft/2020-12/schema",
                "type", "object",
                "required", List.of("count"),
                "additionalProperties", false,
                "properties", Map.of("count", Map.of("type", "integer", "minimum", new BigInteger("9007199254740993"),
                        "maximum", new BigInteger("9007199254740993"))));
        ToolExecutionResult exactLargeInteger = runWithOutputSchema(strictSchema,
                Map.of("count", new BigInteger("9007199254740993")));
        assertThat(exactLargeInteger.status()).isEqualTo(ToolExecutionStatus.SUCCESS);

        assertThatThrownBy(() -> runWithOutputSchema(strictSchema, Map.of(
                "count", new BigInteger("9007199254740993"), "extra", true)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        assertThatThrownBy(() -> runWithOutputSchema(strictSchema, Map.of()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        assertThatThrownBy(() -> runWithOutputSchema(Map.of(
                "oneOf", List.of(Map.of("type", "string"), Map.of("type", "integer"))), true))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        assertThatThrownBy(() -> runWithOutputSchema(Map.of("$ref", "https://invalid.example/schema.json"), Map.of()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        assertThatThrownBy(() -> runWithOutputSchema(Map.of("type", "not-a-json-schema-type"), Map.of()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        assertThatThrownBy(() -> runWithOutputSchema(Map.of("type", "object", "unrecognizedSchemaKeyword", true), Map.of()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        assertThatThrownBy(() -> runWithOutputSchema(Map.of("$schema", "http://json-schema.org/draft-07/schema#", "type", "object"), Map.of()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        assertThatThrownBy(() -> runWithOutputSchema(Map.of("type", "object"), Map.of("large", "x".repeat(1_100_000))))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        assertThatThrownBy(() -> runWithOutputSchema(Map.of("type", "array"), java.util.Collections.nCopies(20_000, 1)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        assertThatThrownBy(() -> runWithOutputSchema(Map.of("type", "object"), new Object())).isInstanceOf(RuntimeException.class);

        Map<String, Object> cyclic = new java.util.HashMap<>();
        cyclic.put("self", cyclic);
        assertThatThrownBy(() -> runWithOutputSchema(Map.of("type", "object"), cyclic)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> runWithOutputSchema(Map.of("type", "number"), Double.NaN)).isInstanceOf(RuntimeException.class);
    }

    @Test
    @DisplayName("rejects custom Number subclasses before invoking their methods")
    void rejectsUnsupportedNumberWithoutCallingMethods() {
        Number hostile = new Number() {
            @Override public int intValue() { throw new AssertionError("custom Number method must not run"); }
            @Override public long longValue() { throw new AssertionError("custom Number method must not run"); }
            @Override public float floatValue() { throw new AssertionError("custom Number method must not run"); }
            @Override public double doubleValue() { throw new AssertionError("custom Number method must not run"); }
            @Override public String toString() { throw new AssertionError("custom Number method must not run"); }
        };
        assertThat(AgentToolInput.isSupportedJsonNumber(hostile)).isFalse();
        assertThat(AgentToolInput.isSupportedJsonNumber(1)).isTrue();
        assertThat(AgentToolInput.isSupportedJsonNumber(new BigInteger("9007199254740993"))).isTrue();
    }

    // =========================================================================
    // SpeechToTextToolHandler
    // =========================================================================

    @Nested
    @DisplayName("SpeechToTextToolHandler")
    class SttTests {

        private SpeechToTextToolHandler handler;

        @BeforeEach
        void setUp() {
            handler = new SpeechToTextToolHandler(delegateReturning(Map.of(
                    "transcript", "hello",
                    "segments", List.of(),
                    "confidence", 0.95,
                    "languageDetected", "fr-FR")));
        }

        @Test
        @DisplayName("succeeds with mediaArtifactId in audioSource")
        void succeedsWithArtifactSource() {
            Map<String, Object> audioSource = Map.of("mediaArtifactId", "artifact-42");
            ToolExecutionEnvelope env = envelope("av.speech-to-text", Map.of("audioSource", audioSource));
            ToolExecutionResult result = await(handler.handle(env, contractFor(env)));
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS);
        }

        @Test
        @DisplayName("succeeds with audioBytes in audioSource")
        void succeedsWithBytesSource() {
            Map<String, Object> audioSource = Map.of("audioBytes", "AQID");
            ToolExecutionEnvelope env = envelope("av.speech-to-text", Map.of("audioSource", audioSource));
            ToolExecutionResult result = await(handler.handle(env, contractFor(env)));
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS);
        }

        @Test
        @DisplayName("fails when audioSource is missing")
        void failsWhenAudioSourceMissing() {
            ToolExecutionEnvelope env = envelope("av.speech-to-text", Map.of());
            ToolExecutionResult result = await(handler.handle(env, contractFor(env)));
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure()).isNotNull();
            assertThat(result.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
        }

        @Test
        @DisplayName("rejects malformed transcript segment fields against registered output types")
        void rejectsMalformedTranscriptSegmentFields() {
            SpeechToTextToolHandler invalid = new SpeechToTextToolHandler(delegateReturning(Map.of(
                    "transcript", "hello", "segments", List.of(Map.of("startMs", "zero")))));
            ToolExecutionEnvelope env = envelope("av.speech-to-text", Map.of("audioSource", Map.of("mediaArtifactId", "a-1")));
            Map<String, Object> schema = Map.of("type", "object", "properties", Map.of(
                    "transcript", Map.of("type", "string"),
                    "segments", Map.of("type", "array", "items", Map.of("type", "object", "properties", Map.of(
                            "text", Map.of("type", "string"), "startMs", Map.of("type", "integer"), "endMs", Map.of("type", "integer"))))));
            assertThatThrownBy(() -> await(invalid.handle(env, contractFor(env, schema)))
                    .status()).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        }

        @Test
        @DisplayName("rejects undeclared STT input fields")
        void rejectsUndeclaredSttInputFields() {
            Map<String, Object> input = new LinkedHashMap<>();
            input.put("audioSource", Map.of("mediaArtifactId", "artifact-1"));
            input.put("untrustedExtra", "must-not-reach-delegate");
            ToolExecutionEnvelope env = envelope("av.speech-to-text", input);
            ToolExecutionResult result = await(handler.handle(env, contractFor(env)));
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
        }

        @Test
        @DisplayName("fails closed when provider delegate is missing")
        void failsClosedWhenProviderDelegateMissing() {
            SpeechToTextToolHandler defaultHandler = new SpeechToTextToolHandler();
            ToolExecutionEnvelope env = envelope("av.speech-to-text", Map.of(
                    "audioSource", Map.of("mediaArtifactId", "artifact-1")));

            ToolExecutionResult result = await(defaultHandler.handle(env, contractFor(env)));

            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure()).isNotNull();
            assertThat(result.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
        }
    }

    @Test
    @DisplayName("all handlers reject null envelope and contract before returning a result promise")
    void nullArgumentsThrowDirectlyForEveryHandler() {
        List<com.ghatana.toolruntime.ToolHandler> handlers = List.of(
                new SpeechToTextToolHandler(delegateReturning(Map.of())),
                new TextToSpeechToolHandler(delegateReturning(Map.of())),
                new VisionAnalysisToolHandler(delegateReturning(Map.of())),
                new MultimodalInferenceToolHandler(delegateReturning(Map.of())));
        ToolExecutionEnvelope validEnvelope = envelope("av.speech-to-text", Map.of(
                "audioSource", Map.of("mediaArtifactId", "artifact-1")));

        for (com.ghatana.toolruntime.ToolHandler handler : handlers) {
            assertThatThrownBy(() -> handler.handle(null, dummyContract))
                    .isInstanceOf(NullPointerException.class)
                    .hasMessage("envelope must not be null");
            assertThatThrownBy(() -> handler.handle(validEnvelope, null))
                    .isInstanceOf(NullPointerException.class)
                    .hasMessage("contract must not be null");
        }
    }

    @Test
    @DisplayName("each handler forwards the original envelope and contract unchanged")
    void handlersForwardOriginalInvocationToDelegate() {
        assertForwardsOriginalEnvelopeAndContract(
                envelope("av.speech-to-text", Map.of("audioSource", Map.of("mediaArtifactId", "a"))),
                SpeechToTextToolHandler::new);
        assertForwardsOriginalEnvelopeAndContract(
                envelope("av.text-to-speech", Map.of("text", "hello")),
                TextToSpeechToolHandler::new);
        assertForwardsOriginalEnvelopeAndContract(
                envelope("av.vision-analysis", Map.of("mediaSource", Map.of("mediaArtifactId", "a"))),
                VisionAnalysisToolHandler::new);
        assertForwardsOriginalEnvelopeAndContract(
                envelope("av.multimodal-inference", Map.of("mediaArtifactId", "a")),
                MultimodalInferenceToolHandler::new);
    }

    @Test
    @DisplayName("all delegates preserve ambiguous post-dispatch failures and reject mismatched result identity")
    void delegatedAmbiguityAndIdentityMismatchRemainNonfinal() {
        List<Map.Entry<ToolExecutionEnvelope, Function<com.ghatana.toolruntime.ToolHandler, com.ghatana.toolruntime.ToolHandler>>> cases = List.of(
                Map.entry(envelope("av.speech-to-text", Map.of("audioSource", Map.of("mediaArtifactId", "a"))), SpeechToTextToolHandler::new),
                Map.entry(envelope("av.text-to-speech", Map.of("text", "hello")), TextToSpeechToolHandler::new),
                Map.entry(envelope("av.vision-analysis", Map.of("mediaSource", Map.of("mediaArtifactId", "a"))), VisionAnalysisToolHandler::new),
                Map.entry(envelope("av.multimodal-inference", Map.of("mediaArtifactId", "a")), MultimodalInferenceToolHandler::new));

        for (var entry : cases) {
            var input = entry.getKey();
            var wrap = entry.getValue();
            var syncThrow = wrap.apply((e, c) -> { throw new IllegalStateException("dispatch-ambiguous"); });
            assertThatThrownBy(() -> await(syncThrow.handle(input, contractFor(input))))
                    .hasMessage("dispatch-ambiguous");

            var asyncReject = wrap.apply((e, c) -> Promise.ofException(new IllegalStateException("async-ambiguous")));
            assertThatThrownBy(() -> await(asyncReject.handle(input, contractFor(input))))
                    .hasMessage("async-ambiguous");

            var nullPromise = wrap.apply((e, c) -> null);
            assertThatThrownBy(() -> await(nullPromise.handle(input, contractFor(input))))
                    .hasMessage("delegate returned null promise");

            var wrongIdentity = wrap.apply((e, c) -> Promise.of(ToolExecutionResult.succeeded(
                    "other-invocation", Map.of(), Map.of(), "other-invocation", Instant.now(), Duration.ZERO)));
            assertThatThrownBy(() -> await(wrongIdentity.handle(input, contractFor(input))))
                    .hasMessage("DELEGATE_INVOCATION_IDENTITY_MISMATCH");
        }
    }

    @Test
    @DisplayName("TTS accepts ordinary comparison and emoticon characters as plain text")
    void ttsAcceptsAngleBracketsAsOrdinaryText() {
        AtomicReference<Boolean> dispatched = new AtomicReference<>(false);
        ToolExecutionEnvelope input = envelope("av.text-to-speech", Map.of("text", "2 < 3 :) and a > b"));
        TextToSpeechToolHandler handler = new TextToSpeechToolHandler((e, c) -> {
            dispatched.set(true);
            return Promise.of(ToolExecutionResult.succeeded(e.invocationId(), Map.of(), Map.of(),
                    e.invocationId(), Instant.now(), Duration.ZERO));
        });
        assertThat(await(handler.handle(input, contractFor(input))).status()).isEqualTo(ToolExecutionStatus.SUCCESS);
        assertThat(dispatched.get()).isTrue();
    }

    @Test
    @DisplayName("rejects mismatched declared tool identity before delegate dispatch")
    void rejectsContractIdentityMismatch() {
        AtomicReference<Boolean> invoked = new AtomicReference<>(false);
        SpeechToTextToolHandler handler = new SpeechToTextToolHandler((envelope, contract) -> {
            invoked.set(true);
            return Promise.of(ToolExecutionResult.succeeded(envelope.invocationId(), Map.of(), Map.of(),
                    envelope.invocationId(), Instant.now(), Duration.ZERO));
        });
        ToolExecutionEnvelope request = envelope("av.speech-to-text", Map.of(
                "audioSource", Map.of("mediaArtifactId", "asset-1")));

        ToolExecutionResult result = await(handler.handle(request, dummyContract));

        assertThat(invoked.get()).isFalse();
        assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(result.output()).isNull();
    }

    @Test
    @DisplayName("rejects out-of-range synthesis and analysis bounds before delegation")
    void rejectsOutOfRangeArguments() {
        AtomicReference<Integer> dispatches = new AtomicReference<>(0);
        com.ghatana.toolruntime.ToolHandler delegate = (envelope, contract) -> {
            dispatches.set(dispatches.get() + 1);
            return Promise.of(ToolExecutionResult.succeeded(envelope.invocationId(), Map.of(), Map.of(),
                    envelope.invocationId(), Instant.now(), Duration.ZERO));
        };
        ToolExecutionEnvelope tts = envelope("av.text-to-speech", Map.of("text", "hello", "speakingRate", 9.0));
        ToolExecutionEnvelope vision = envelope("av.vision-analysis", Map.of(
                "mediaSource", Map.of("mediaArtifactId", "image-1"), "maxResults", 101));

        assertThat(await(new TextToSpeechToolHandler(delegate).handle(tts, contractFor(tts))).status())
                .isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(await(new VisionAnalysisToolHandler(delegate).handle(vision, contractFor(vision))).status())
                .isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(dispatches.get()).isZero();
    }

    @Test
    @DisplayName("local invalid-input results preserve only observed invocation metadata")
    void localFailuresHaveExactObservedResultShape() {
        List<Map.Entry<ToolExecutionEnvelope, com.ghatana.toolruntime.ToolHandler>> cases = List.of(
                Map.entry(envelope("av.speech-to-text", Map.of()), new SpeechToTextToolHandler()),
                Map.entry(envelope("av.text-to-speech", Map.of("text", "  ")), new TextToSpeechToolHandler()),
                Map.entry(envelope("av.vision-analysis", Map.of()), new VisionAnalysisToolHandler()),
                Map.entry(envelope("av.multimodal-inference", Map.of()), new MultimodalInferenceToolHandler()));

        for (Map.Entry<ToolExecutionEnvelope, com.ghatana.toolruntime.ToolHandler> testCase : cases) {
            ToolExecutionEnvelope input = testCase.getKey();
            ToolExecutionResult result = await(testCase.getValue().handle(input, contractFor(input)));

            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.invocationId()).isEqualTo(input.invocationId());
            assertThat(result.correlationId()).isEqualTo(input.invocationId());
            assertThat(result.output()).isNull();
            assertThat(result.sideEffectSummary()).isEmpty();
            assertThat(result.errorMessage()).isEqualTo("TOOL_EXECUTION_FAILED");
            assertThat(result.failure()).isNotNull();
            assertThat(result.failure().kind()).isEqualTo(com.ghatana.agent.framework.tools.ToolExecutionFailure.Kind.INTERNAL);
            assertThat(result.failure().stage()).isEqualTo(com.ghatana.agent.framework.tools.ToolExecutionFailure.Stage.EXECUTION);
            assertThat(result.failure().retryable()).isFalse();
            assertThat(result.failure().observedAt()).isEqualTo(result.completedAt());
            assertThat(result.executionDuration()).isGreaterThanOrEqualTo(Duration.ZERO);
        }
    }

    // =========================================================================
    // TextToSpeechToolHandler
    // =========================================================================

    @Nested
    @DisplayName("TextToSpeechToolHandler")
    class TtsTests {

        private TextToSpeechToolHandler handler;

        @BeforeEach
        void setUp() {
            handler = new TextToSpeechToolHandler(delegateReturning(Map.of(
                    "mediaArtifactId", "tts-artifact-1",
                    "audioEncoding", "MP3",
                    "durationMs", 1200,
                    "voiceId", "en-US-default")));
        }

        @Test
        @DisplayName("succeeds with valid text")
        void succeedsWithValidText() {
            ToolExecutionEnvelope env = envelope("av.text-to-speech", Map.of("text", "Hello world"));
            ToolExecutionResult result = await(handler.handle(env, contractFor(env)));
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS);
        }

        @Test
        @DisplayName("fails when text is missing")
        void failsWhenTextMissing() {
            ToolExecutionEnvelope env = envelope("av.text-to-speech", Map.of());
            ToolExecutionResult result = await(handler.handle(env, contractFor(env)));
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure()).isNotNull();
            assertThat(result.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
        }

        @Test
        @DisplayName("validates declared output fields without proving artifact storage")
        void validatesOutputFieldsWithoutProvingArtifactStorage() {
            Map<String, Object> input = Map.of("text", "Synthesize this", "storeAsArtifact", true);
            ToolExecutionEnvelope env = envelope("av.text-to-speech", input);
            Map<String, Object> schema = Map.of("type", "object", "properties", Map.of(
                    "mediaArtifactId", Map.of("type", "string"),
                    "audioEncoding", Map.of("type", "string"),
                    "durationMs", Map.of("type", "integer", "minimum", 0)));
            ToolExecutionResult result = await(handler.handle(env, contractFor(env, schema)));
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS);
            @SuppressWarnings("unchecked")
            Map<String, Object> output = (Map<String, Object>) result.output();
            assertThat(output).isEqualTo(Map.of(
                    "mediaArtifactId", "tts-artifact-1", "audioEncoding", "MP3", "durationMs", 1200, "voiceId", "en-US-default"));
        }

        @Test
        @DisplayName("rejects malformed successful delegate output on the ambiguous result channel")
        void rejectsMalformedSuccessfulOutput() {
            TextToSpeechToolHandler invalid = new TextToSpeechToolHandler(delegateReturning(Map.of("durationMs", "long")));
            ToolExecutionEnvelope env = envelope("av.text-to-speech", Map.of("text", "Synthesize this"));
            Map<String, Object> schema = Map.of("type", "object", "properties", Map.of(
                    "durationMs", Map.of("type", "integer", "minimum", 0)));
            assertThatThrownBy(() -> await(invalid.handle(env, contractFor(env, schema)))
                    .status()).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        }

        @Test
        @DisplayName("fails closed when provider delegate is missing")
        void failsClosedWhenProviderDelegateMissing() {
            TextToSpeechToolHandler defaultHandler = new TextToSpeechToolHandler();
            ToolExecutionEnvelope env = envelope("av.text-to-speech", Map.of("text", "Hello world"));

            ToolExecutionResult result = await(defaultHandler.handle(env, contractFor(env)));

            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure()).isNotNull();
            assertThat(result.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
        }
    }

    // =========================================================================
    // VisionAnalysisToolHandler
    // =========================================================================

    @Nested
    @DisplayName("VisionAnalysisToolHandler")
    class VisionTests {

        private VisionAnalysisToolHandler handler;

        @BeforeEach
        void setUp() {
            handler = new VisionAnalysisToolHandler(delegateReturning(Map.of(
                    "objects", List.of(),
                    "texts", List.of(),
                    "maxResults", 10,
                    "confidenceThreshold", 0.5)));
        }

        @Test
        @DisplayName("succeeds with mediaArtifactId source")
        void succeedsWithArtifact() {
            Map<String, Object> input = Map.of(
                    "mediaSource", Map.of("mediaArtifactId", "img-artifact-1"),
                    "analysisTypes", List.of("OBJECT_DETECTION"));
            ToolExecutionEnvelope env = envelope("av.vision-analysis", input);
            ToolExecutionResult result = await(handler.handle(env, contractFor(env)));
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS);
        }

        @Test
        @DisplayName("fails when mediaSource is absent")
        void failsWhenMediaSourceAbsent() {
            ToolExecutionEnvelope env = envelope("av.vision-analysis", Map.of("analysisTypes", List.of("OCR")));
            ToolExecutionResult result = await(handler.handle(env, contractFor(env)));
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure()).isNotNull();
            assertThat(result.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
        }

        @Test
        @DisplayName("accepts structurally valid delegate output while preserving open schema fields")
        void returnsDelegateVisionOutputWithoutSchemaValidation() {
            Map<String, Object> input = Map.of(
                    "mediaSource", Map.of("mediaArtifactId", "img-42"),
                    "analysisTypes", List.of("OBJECT_DETECTION", "OCR"));
            ToolExecutionEnvelope env = envelope("av.vision-analysis", input);
            Map<String, Object> objectSchema = Map.of("type", "object", "properties", Map.of(
                    "label", Map.of("type", "string"),
                    "confidence", Map.of("type", "number", "minimum", 0, "maximum", 1)));
            Map<String, Object> schema = Map.of("type", "object", "properties", Map.of(
                    "objects", Map.of("type", "array", "items", objectSchema),
                    "texts", Map.of("type", "array")));
            ToolExecutionResult result = await(handler.handle(env, contractFor(env, schema)));
            @SuppressWarnings("unchecked")
            Map<String, Object> output = (Map<String, Object>) result.output();
            assertThat(output).isEqualTo(Map.of(
                    "objects", List.of(), "texts", List.of(), "maxResults", 10, "confidenceThreshold", 0.5));
        }

        @Test
        @DisplayName("rejects nested malformed finding fields")
        void rejectsNestedMalformedFindingFields() {
            VisionAnalysisToolHandler invalid = new VisionAnalysisToolHandler(delegateReturning(Map.of(
                    "objects", List.of(Map.of("label", 42)))));
            ToolExecutionEnvelope env = envelope("av.vision-analysis", Map.of(
                    "mediaSource", Map.of("mediaArtifactId", "img-42"), "analysisTypes", List.of("OBJECT_DETECTION")));
            Map<String, Object> schema = Map.of("type", "object", "properties", Map.of(
                    "objects", Map.of("type", "array", "items", Map.of("type", "object", "properties", Map.of(
                            "label", Map.of("type", "string"))))));
            assertThatThrownBy(() -> await(invalid.handle(env, contractFor(env, schema)))
                    .status()).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        }

        @Test
        @DisplayName("fails closed when provider delegate is missing")
        void failsClosedWhenProviderDelegateMissing() {
            VisionAnalysisToolHandler defaultHandler = new VisionAnalysisToolHandler();
            ToolExecutionEnvelope env = envelope("av.vision-analysis", Map.of(
                    "mediaSource", Map.of("mediaArtifactId", "img-1")));

            ToolExecutionResult result = await(defaultHandler.handle(env, contractFor(env)));

            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure()).isNotNull();
            assertThat(result.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
        }
    }

    // =========================================================================
    // MultimodalInferenceToolHandler
    // =========================================================================

    @Nested
    @DisplayName("MultimodalInferenceToolHandler")
    class MultimodalTests {

        private MultimodalInferenceToolHandler handler;

        @BeforeEach
        void setUp() {
            handler = new MultimodalInferenceToolHandler(delegateReturning(Map.of(
                    "summary", "summary",
                    "processingMetadata", Map.of("framesAnalyzed", 12, "audioSegments", 3),
                    "confidence", 0.9)));
        }

        @Test
        @DisplayName("succeeds with mediaArtifactId")
        void succeedsWithArtifact() {
            Map<String, Object> input = Map.of("mediaArtifactId", "video-artifact-1");
            ToolExecutionEnvelope env = envelope("av.multimodal-inference", input);
            ToolExecutionResult result = await(handler.handle(env, contractFor(env)));
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS);
        }

        @Test
        @DisplayName("fails when mediaArtifactId is missing")
        void failsWhenArtifactMissing() {
            ToolExecutionEnvelope env = envelope("av.multimodal-inference", Map.of());
            ToolExecutionResult result = await(handler.handle(env, contractFor(env)));
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
        }

        @Test
        @DisplayName("validates declared multimodal output structure")
        void returnsDelegateMultimodalOutputWithoutComponentValidation() {
            Map<String, Object> input = Map.of("mediaArtifactId", "v-1", "inferenceMode", "FULL");
            ToolExecutionEnvelope env = envelope("av.multimodal-inference", input);
            Map<String, Object> schema = Map.of("type", "object", "properties", Map.of(
                    "summary", Map.of("type", "string"),
                    "confidence", Map.of("type", "number", "minimum", 0, "maximum", 1),
                    "processingMetadata", Map.of("type", "object", "properties", Map.of(
                            "framesAnalyzed", Map.of("type", "integer"), "audioSegments", Map.of("type", "integer")))));
            ToolExecutionResult result = await(handler.handle(env, contractFor(env, schema)));
            @SuppressWarnings("unchecked")
            Map<String, Object> output = (Map<String, Object>) result.output();
            assertThat(output).isEqualTo(Map.of(
                    "summary", "summary", "processingMetadata", Map.of("framesAnalyzed", 12, "audioSegments", 3), "confidence", 0.9));
        }

        @Test
        @DisplayName("rejects malformed processing metadata without manufacturing a terminal result")
        void rejectsMalformedProcessingMetadata() {
            MultimodalInferenceToolHandler invalid = new MultimodalInferenceToolHandler(delegateReturning(Map.of(
                    "processingMetadata", Map.of("framesAnalyzed", "many"))));
            ToolExecutionEnvelope env = envelope("av.multimodal-inference", Map.of("mediaArtifactId", "v-1"));
            Map<String, Object> schema = Map.of("type", "object", "properties", Map.of(
                    "processingMetadata", Map.of("type", "object", "properties", Map.of(
                            "framesAnalyzed", Map.of("type", "integer")))));
            assertThatThrownBy(() -> await(invalid.handle(env, contractFor(env, schema)))
                    .status()).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("DELEGATE_OUTPUT_SCHEMA_VIOLATION");
        }

        @Test
        @DisplayName("fails closed when provider delegate is missing")
        void failsClosedWhenProviderDelegateMissing() {
            MultimodalInferenceToolHandler defaultHandler = new MultimodalInferenceToolHandler();
            ToolExecutionEnvelope env = envelope("av.multimodal-inference", Map.of("mediaArtifactId", "video-1"));

            ToolExecutionResult result = await(defaultHandler.handle(env, contractFor(env)));

            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure()).isNotNull();
            assertThat(result.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
        }
    }

    // =========================================================================
    // AudioVideoToolHandlerFactory
    // =========================================================================

    @Nested
    @DisplayName("AudioVideoToolHandlerFactory")
    class FactoryTests {

        private AudioVideoToolHandlerFactory factory;

        @BeforeEach
        void setUp() {
            factory = new AudioVideoToolHandlerFactory();
        }

        @Test
        @DisplayName("creates STT handler")
        void createsSttHandler() {
            assertThat(factory.create("av.speech-to-text")).isInstanceOf(SpeechToTextToolHandler.class);
        }

        @Test
        @DisplayName("creates TTS handler")
        void createsTtsHandler() {
            assertThat(factory.create("av.text-to-speech")).isInstanceOf(TextToSpeechToolHandler.class);
        }

        @Test
        @DisplayName("creates vision handler")
        void createsVisionHandler() {
            assertThat(factory.create("av.vision-analysis")).isInstanceOf(VisionAnalysisToolHandler.class);
        }

        @Test
        @DisplayName("creates multimodal handler")
        void createsMultimodalHandler() {
            assertThat(factory.create("av.multimodal-inference")).isInstanceOf(MultimodalInferenceToolHandler.class);
        }

        @Test
        @DisplayName("throws for unknown toolId")
        void throwsForUnknownToolId() {
            assertThatThrownBy(() -> factory.create("av.unknown"))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("av.unknown");
        }

        @Test
        @DisplayName("toolIds returns all four capabilities")
        void toolIdsReturnsAllFour() {
            assertThat(factory.toolIds()).containsExactlyInAnyOrder(
                    "av.speech-to-text", "av.text-to-speech",
                    "av.vision-analysis", "av.multimodal-inference");
        }
    }
}
