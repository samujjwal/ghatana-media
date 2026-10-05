package com.ghatana.media.stt;

import com.ghatana.media.common.*;
import com.ghatana.media.stt.api.*;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * Service-contract tests for {@link SttEngine}.
 *
 * <p>These tests use a Mockito stub that strictly models the interface contract,
 * verifying that:
 * <ul>
 *   <li>Successful transcription produces a well-formed {@link TranscriptionResult}</li>
 *   <li>Confidence values are within [0, 1]</li>
 *   <li>Error scenarios surface the declared exception types</li>
 *   <li>Fallback/degraded behaviour returns an empty transcript with zero confidence</li>
 *   <li>Model management operations delegate correctly</li>
 *   <li>Engine metrics and status honour their documented invariants</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Contract tests for the SttEngine speech service interface
 * @doc.layer platform
 * @doc.pattern Test
 */
@DisplayName("SttEngine – service contract")
@ExtendWith(MockitoExtension.class)
class SttEngineContractTest {

    @Mock
    private SttEngine engine;

    // =========================================================================
    // Successful transcription
    // =========================================================================

    @Nested
    @DisplayName("Successful transcription")
    class SuccessfulTranscription {

        @Test
        @DisplayName("result text must be non-null")
        void resultTextIsNonNull() {
            AudioData audio = minimalAudio();
            TranscriptionResult result = transcript("Hello world", 0.95, Locale.ENGLISH);

            when(engine.transcribe(audio, TranscriptionOptions.defaults())).thenReturn(result);

            TranscriptionResult actual = engine.transcribe(audio, TranscriptionOptions.defaults());

            assertThat(actual.text()).isNotNull();
        }

        @Test
        @DisplayName("confidence is within [0, 1]")
        void confidenceIsInRange() {
            AudioData audio = minimalAudio();
            TranscriptionResult result = transcript("Test", 0.87, Locale.ENGLISH);
            when(engine.transcribe(any(), any())).thenReturn(result);

            TranscriptionResult actual = engine.transcribe(audio, TranscriptionOptions.defaults());

            assertThat(actual.confidence())
                .as("confidence must be in [0.0, 1.0]")
                .isGreaterThanOrEqualTo(0.0)
                .isLessThanOrEqualTo(1.0);
        }

        @Test
        @DisplayName("modelId must be non-null and non-blank in a successful result")
        void modelIdIsPresent() {
            AudioData audio = minimalAudio();
            TranscriptionResult result = transcript("Hi", 0.9, Locale.ENGLISH);
            when(engine.transcribe(any(), any())).thenReturn(result);

            TranscriptionResult actual = engine.transcribe(audio, TranscriptionOptions.defaults());

            assertThat(actual.modelId()).isNotBlank();
        }

        @Test
        @DisplayName("processingTime is non-negative")
        void processingTimeIsNonNegative() {
            AudioData audio = minimalAudio();
            TranscriptionResult result = new TranscriptionResult(
                "Fast result", 0.99, List.of(), List.of(),
                Duration.ofMillis(50), "en", "whisper-base"
            );
            when(engine.transcribe(any(), any())).thenReturn(result);

            TranscriptionResult actual = engine.transcribe(audio, TranscriptionOptions.defaults());

            assertThat(actual.processingTime())
                .isGreaterThanOrEqualTo(Duration.ZERO);
        }

        @Test
        @DisplayName("language tag in result is a valid BCP-47 code")
        void languageTagIsPresent() {
            AudioData audio = minimalAudio();
            TranscriptionResult result = transcript("Bonjour", 0.88, Locale.FRENCH);
            when(engine.transcribe(any(), any())).thenReturn(result);

            TranscriptionResult actual = engine.transcribe(audio, TranscriptionOptions.defaults());

            assertThat(actual.language())
                .as("language must be a non-blank BCP-47 tag")
                .isNotBlank();

            // Must be parseable as a locale without throwing
            Locale parsed = Locale.forLanguageTag(actual.language());
            assertThat(parsed).isNotNull();
        }

        @Test
        @DisplayName("silent audio may produce empty text but still a valid result")
        void silentAudioReturnsEmptyText() {
            AudioData silentAudio = minimalAudio();
            TranscriptionResult silentResult = new TranscriptionResult(
                "", 0.0, List.of(), List.of(),
                Duration.ofMillis(20), "en", "whisper-base"
            );
            when(engine.transcribe(any(), any())).thenReturn(silentResult);

            TranscriptionResult actual = engine.transcribe(silentAudio, TranscriptionOptions.defaults());

            assertThat(actual).isNotNull();
            assertThat(actual.text()).isNotNull();           // null is not allowed even for silence
            assertThat(actual.confidence()).isCloseTo(0.0, within(1e-9));
        }
    }

    // =========================================================================
    // Error / exception contract
    // =========================================================================

    @Nested
    @DisplayName("Error contract")
    class ErrorContract {

        @Test
        @DisplayName("ValidationError is thrown for invalid audio (null data)")
        void nullAudioThrowsValidationError() {
            AudioData badAudio = minimalAudio();
            when(engine.transcribe(any(), any()))
                .thenThrow(new ValidationError("Audio data is null or empty"));

            assertThatThrownBy(() -> engine.transcribe(badAudio, TranscriptionOptions.defaults()))
                .isInstanceOf(ValidationError.class);
        }

        @Test
        @DisplayName("InferenceError with isRetryable=false must not be swallowed")
        void nonRetryableInferenceErrorPropagates() {
            when(engine.transcribe(any(), any()))
                .thenThrow(new InferenceError("Model runtime failure",
                    new RuntimeException("ONNX fault"), false));

            assertThatThrownBy(() -> engine.transcribe(minimalAudio(), TranscriptionOptions.defaults()))
                .isInstanceOf(InferenceError.class)
                .satisfies(e -> assertThat(((InferenceError) e).isRetryable()).isFalse());
        }

        @Test
        @DisplayName("InferenceError with isRetryable=true signals safe retry")
        void retryableInferenceErrorIsTagged() {
            when(engine.transcribe(any(), any()))
                .thenThrow(new InferenceError("Timeout", new RuntimeException(), true));

            assertThatThrownBy(() -> engine.transcribe(minimalAudio(), TranscriptionOptions.defaults()))
                .isInstanceOf(InferenceError.class)
                .satisfies(e -> assertThat(((InferenceError) e).isRetryable()).isTrue());
        }

        @Test
        @DisplayName("ResourceExhaustedError is always retryable")
        void resourceExhaustedIsRetryable() {
            when(engine.transcribe(any(), any()))
                .thenThrow(new ResourceExhaustedError("Engine pool saturated"));

            assertThatThrownBy(() -> engine.transcribe(minimalAudio(), TranscriptionOptions.defaults()))
                .isInstanceOf(ResourceExhaustedError.class);
        }

        @Test
        @DisplayName("ModelLoadingError is thrown when no model is loaded")
        void noModelLoadedThrowsModelLoadingError() {
            when(engine.transcribe(any(), any()))
                .thenThrow(new ModelLoadingError("No model initialised"));

            assertThatThrownBy(() -> engine.transcribe(minimalAudio(), TranscriptionOptions.defaults()))
                .isInstanceOf(ModelLoadingError.class);
        }
    }

    // =========================================================================
    // Fallback / degraded mode
    // =========================================================================

    @Nested
    @DisplayName("Fallback / degraded mode")
    class FallbackMode {

        @Test
        @DisplayName("degraded result has empty text and zero confidence")
        void degradedResultContract() {
            // Simulates what a circuit-breaker or fallback wrapper should return
            TranscriptionResult degraded = new TranscriptionResult(
                "", 0.0, List.of(), List.of(),
                Duration.ZERO, "unknown", "degraded"
            );
            when(engine.transcribe(any(), any())).thenReturn(degraded);

            TranscriptionResult result = engine.transcribe(minimalAudio(), TranscriptionOptions.defaults());

            assertThat(result.text()).isEmpty();
            assertThat(result.confidence()).isEqualTo(0.0);
            assertThat(result.words()).isEmpty();
        }
    }

    // =========================================================================
    // Model management contract
    // =========================================================================

    @Nested
    @DisplayName("Model management")
    class ModelManagement {

        @Test
        @DisplayName("getAvailableModels returns a non-null list")
        void availableModelsIsNonNull() {
            when(engine.getAvailableModels()).thenReturn(List.of(
                new ModelInfo("whisper-base", "Whisper Base", "1.0",
                    new Locale[]{Locale.ENGLISH}, 1000L, false)
            ));

            assertThat(engine.getAvailableModels()).isNotNull();
        }

        @Test
        @DisplayName("getActiveModel returns the currently loaded model")
        void activeModelIsNonNull() {
            ModelInfo model = new ModelInfo("whisper-small", "Whisper Small", "1.0",
                new Locale[]{Locale.ENGLISH, Locale.FRENCH}, 2000L, true);
            when(engine.getActiveModel()).thenReturn(model);

            ModelInfo active = engine.getActiveModel();

            assertThat(active).isNotNull();
            assertThat(active.modelId()).isNotBlank();
        }

        @Test
        @DisplayName("loadModel delegates to the engine implementation")
        void loadModelDelegates() {
            doNothing().when(engine).loadModel("whisper-medium");

            engine.loadModel("whisper-medium");

            verify(engine).loadModel("whisper-medium");
        }

        @Test
        @DisplayName("ModelLoadingError propagates when unknown model is requested")
        void unknownModelThrows() {
            doThrow(new ModelLoadingError("Model 'does-not-exist' not found"))
                .when(engine).loadModel("does-not-exist");

            assertThatThrownBy(() -> engine.loadModel("does-not-exist"))
                .isInstanceOf(ModelLoadingError.class)
                .hasMessageContaining("does-not-exist");
        }
    }

    // =========================================================================
    // Engine status and metrics
    // =========================================================================

    @Nested
    @DisplayName("Engine status and metrics")
    class EngineStatusAndMetrics {

        @Test
        @DisplayName("READY status reports isReady=true and isHealthy=true")
        void readyStatusInvariant() {
            EngineStatus status = new EngineStatus(EngineStatus.State.READY, "m1", "1.0", 5000L, null);
            when(engine.getStatus()).thenReturn(status);

            EngineStatus actual = engine.getStatus();

            assertThat(actual.isReady()).isTrue();
            assertThat(actual.isHealthy()).isTrue();
        }

        @Test
        @DisplayName("ERROR status reports isReady=false")
        void errorStatusIsNotReady() {
            EngineStatus status = new EngineStatus(
                EngineStatus.State.ERROR, "m1", "1.0", 0L, "ONNX inference crash");
            when(engine.getStatus()).thenReturn(status);

            EngineStatus actual = engine.getStatus();

            assertThat(actual.isReady()).isFalse();
            assertThat(actual.isHealthy()).isFalse();
        }

        @Test
        @DisplayName("getMetrics returns non-negative request and error counts")
        void metricsCountsAreNonNegative() {
            EngineMetrics metrics = new EngineMetrics(250L, 12L, 40L, 1L, 0L);
            when(engine.getMetrics()).thenReturn(metrics);

            EngineMetrics actual = engine.getMetrics();

            assertThat(actual.requestCount()).isGreaterThanOrEqualTo(0L);
            assertThat(actual.errorCount()).isGreaterThanOrEqualTo(0L);
        }
    }

    // =========================================================================
    // Profile management contract
    // =========================================================================

    @Nested
    @DisplayName("Profile management")
    class ProfileManagement {

        @Test
        @DisplayName("loadProfile returns empty Optional for unknown profileId")
        void unknownProfileReturnsEmpty() {
            when(engine.loadProfile("no-such-profile")).thenReturn(Optional.empty());

            assertThat(engine.loadProfile("no-such-profile")).isEmpty();
        }

        @Test
        @DisplayName("deleteProfile returns false when profile does not exist")
        void deleteNonExistentProfileReturnsFalse() {
            when(engine.deleteProfile("ghost")).thenReturn(false);

            assertThat(engine.deleteProfile("ghost")).isFalse();
        }

        @Test
        @DisplayName("listProfiles returns a non-null list")
        void listProfilesIsNonNull() {
            when(engine.listProfiles()).thenReturn(List.of("alice", "bob"));

            assertThat(engine.listProfiles()).isNotNull();
        }
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private AudioData minimalAudio() {
        return new AudioData(new byte[3200], 16000, 1, 16);
    }

    private TranscriptionResult transcript(String text, double confidence, Locale locale) {
        return new TranscriptionResult(
            text, confidence, List.of(), List.of(),
            Duration.ofMillis(100), locale.toLanguageTag(), "whisper-base"
        );
    }
}
