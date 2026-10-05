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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Unit tests for all Audio-Video ToolHandler implementations and the factory.
 */
@DisplayName("AudioVideo ToolHandlers")
class AudioVideoToolHandlersTest {

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

    private ToolExecutionResult await(Promise<ToolExecutionResult> p) { 
        // ToolHandlers are synchronous — invoke directly via promise value
        try {
            return p.getResult(); 
        } catch (Exception e) { 
            throw new AssertionError("Promise failed unexpectedly", e); 
        }
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
            ToolExecutionResult result = await(handler.handle(env, dummyContract)); 
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS); 
        }

        @Test
        @DisplayName("succeeds with audioBytes in audioSource")
        void succeedsWithBytesSource() { 
            Map<String, Object> audioSource = Map.of("audioBytes", "BASE64=="); 
            ToolExecutionEnvelope env = envelope("av.speech-to-text", Map.of("audioSource", audioSource)); 
            ToolExecutionResult result = await(handler.handle(env, dummyContract)); 
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS); 
        }

        @Test
        @DisplayName("fails when audioSource is missing")
        void failsWhenAudioSourceMissing() { 
            ToolExecutionEnvelope env = envelope("av.speech-to-text", Map.of()); 
            ToolExecutionResult result = await(handler.handle(env, dummyContract)); 
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure()).isNotNull();
            assertThat(result.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
        }

        @Test
        @DisplayName("output contains required fields")
        void outputContainsRequiredFields() { 
            Map<String, Object> input = new LinkedHashMap<>(); 
            input.put("audioSource", Map.of("mediaArtifactId", "artifact-1")); 
            input.put("languageCode", "fr-FR"); 
            ToolExecutionEnvelope env = envelope("av.speech-to-text", input); 
            ToolExecutionResult result = await(handler.handle(env, dummyContract)); 
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS); 
            @SuppressWarnings("unchecked")
            Map<String, Object> output = (Map<String, Object>) result.output(); 
            assertThat(output).containsKey("transcript").containsKey("confidence").containsKey("languageDetected");
            assertThat(output.get("languageDetected")).isEqualTo("fr-FR");
        }

        @Test
        @DisplayName("fails closed when provider delegate is missing")
        void failsClosedWhenProviderDelegateMissing() {
            SpeechToTextToolHandler defaultHandler = new SpeechToTextToolHandler();
            ToolExecutionEnvelope env = envelope("av.speech-to-text", Map.of(
                    "audioSource", Map.of("mediaArtifactId", "artifact-1")));

            ToolExecutionResult result = await(defaultHandler.handle(env, dummyContract));

            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure()).isNotNull();
            assertThat(result.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
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
            ToolExecutionResult result = await(handler.handle(env, dummyContract)); 
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS); 
        }

        @Test
        @DisplayName("fails when text is missing")
        void failsWhenTextMissing() { 
            ToolExecutionEnvelope env = envelope("av.text-to-speech", Map.of()); 
            ToolExecutionResult result = await(handler.handle(env, dummyContract)); 
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure()).isNotNull();
            assertThat(result.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
        }

        @Test
        @DisplayName("storeAsArtifact flag is reflected in output")
        void storeAsArtifactFlagReflected() { 
            Map<String, Object> input = Map.of("text", "Synthesize this", "storeAsArtifact", true); 
            ToolExecutionEnvelope env = envelope("av.text-to-speech", input); 
            ToolExecutionResult result = await(handler.handle(env, dummyContract)); 
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS); 
            @SuppressWarnings("unchecked")
            Map<String, Object> output = (Map<String, Object>) result.output(); 
            assertThat(output).containsKey("mediaArtifactId").containsKey("audioEncoding");
        }

        @Test
        @DisplayName("fails closed when provider delegate is missing")
        void failsClosedWhenProviderDelegateMissing() {
            TextToSpeechToolHandler defaultHandler = new TextToSpeechToolHandler();
            ToolExecutionEnvelope env = envelope("av.text-to-speech", Map.of("text", "Hello world"));

            ToolExecutionResult result = await(defaultHandler.handle(env, dummyContract));

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
            ToolExecutionResult result = await(handler.handle(env, dummyContract)); 
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS); 
        }

        @Test
        @DisplayName("fails when mediaSource is absent")
        void failsWhenMediaSourceAbsent() { 
            ToolExecutionEnvelope env = envelope("av.vision-analysis", Map.of("analysisTypes", List.of("OCR")));
            ToolExecutionResult result = await(handler.handle(env, dummyContract)); 
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure()).isNotNull();
            assertThat(result.failure().code()).isEqualTo("TOOL_EXECUTION_FAILED");
        }

        @Test
        @DisplayName("output contains requested analysis type keys")
        void outputContainsRequestedAnalysisKeys() { 
            Map<String, Object> input = Map.of( 
                    "mediaSource", Map.of("mediaArtifactId", "img-42"), 
                    "analysisTypes", List.of("OBJECT_DETECTION", "OCR")); 
            ToolExecutionEnvelope env = envelope("av.vision-analysis", input); 
            ToolExecutionResult result = await(handler.handle(env, dummyContract)); 
            @SuppressWarnings("unchecked")
            Map<String, Object> output = (Map<String, Object>) result.output(); 
            assertThat(output).containsKey("objects").containsKey("texts");
        }

        @Test
        @DisplayName("fails closed when provider delegate is missing")
        void failsClosedWhenProviderDelegateMissing() {
            VisionAnalysisToolHandler defaultHandler = new VisionAnalysisToolHandler();
            ToolExecutionEnvelope env = envelope("av.vision-analysis", Map.of(
                    "mediaSource", Map.of("mediaArtifactId", "img-1")));

            ToolExecutionResult result = await(defaultHandler.handle(env, dummyContract));

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
            ToolExecutionResult result = await(handler.handle(env, dummyContract)); 
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS); 
        }

        @Test
        @DisplayName("fails when mediaArtifactId is missing")
        void failsWhenArtifactMissing() { 
            ToolExecutionEnvelope env = envelope("av.multimodal-inference", Map.of()); 
            ToolExecutionResult result = await(handler.handle(env, dummyContract)); 
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED); 
        }

        @Test
        @DisplayName("output includes processingMetadata")
        void outputIncludesProcessingMetadata() { 
            Map<String, Object> input = Map.of("mediaArtifactId", "v-1", "inferenceMode", "FULL"); 
            ToolExecutionEnvelope env = envelope("av.multimodal-inference", input); 
            ToolExecutionResult result = await(handler.handle(env, dummyContract)); 
            @SuppressWarnings("unchecked")
            Map<String, Object> output = (Map<String, Object>) result.output(); 
            assertThat(output).containsKey("summary").containsKey("processingMetadata");
        }

        @Test
        @DisplayName("fails closed when provider delegate is missing")
        void failsClosedWhenProviderDelegateMissing() {
            MultimodalInferenceToolHandler defaultHandler = new MultimodalInferenceToolHandler();
            ToolExecutionEnvelope env = envelope("av.multimodal-inference", Map.of("mediaArtifactId", "video-1"));

            ToolExecutionResult result = await(defaultHandler.handle(env, dummyContract));

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
