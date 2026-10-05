package com.ghatana.stt.service;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.infrastructure.persistence.service.TranscriptionService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioFormat;
import io.activej.promise.Promise;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.UUID;

/**
 * @doc.type class
 * @doc.purpose Unit tests for PersistentSttService input validation.
 *              Validates all illegal-argument branches without invoking real transcription.
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("PersistentSttService — input validation")
@ExtendWith(MockitoExtension.class)
class PersistentSttServiceValidationTest {

    @Mock
    private AudioVideoLibrary library;
    @Mock
    private AudioFileService audioFileService;
    @Mock
    private TranscriptionService transcriptionService;

    private PersistentSttService service;

    private static final String TENANT = "tenant-unit";
    private static final UUID USER   = UUID.randomUUID();
    private static final int VALID_RATE = 16_000;

    @BeforeEach
    void setUp() {
        service = new PersistentSttService(library, audioFileService, transcriptionService,
            new SimpleMeterRegistry());

        // Persist stub not needed for synchronous validation, but suppress "unnecessary stubbing"
        // warnings by using lenient stubs so the test class stays clean.
        lenient().when(audioFileService.save(anyString(), any()))
            .thenReturn(Promise.ofException(new RuntimeException("Should not reach persistence")));
        lenient().when(audioFileService.updateStatus(anyString(), any(), any(), anyString()))
            .thenReturn(Promise.of(false));
    }

    // -----------------------------------------------------------------------
    // Structural guard — empty audio
    // -----------------------------------------------------------------------

    @Test
    @DisplayName("empty audio bytes throw IllegalArgumentException")
    void emptyAudioThrows() {
        assertThatThrownBy(() -> service.transcribeAndPersist(
                TENANT, USER, new byte[0], "sample.wav", AudioFormat.WAV, "en", VALID_RATE))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("empty");
    }

    // -----------------------------------------------------------------------
    // Size guard — > 100 MB
    // -----------------------------------------------------------------------

    @Test
    @DisplayName("audio larger than 100 MB throws IllegalArgumentException")
    void oversizeAudioThrows() {
        // Allocate just over 100 MB; JVM can handle this in test heap.
        byte[] huge = new byte[100 * 1024 * 1024 + 1];
        assertThatThrownBy(() -> service.transcribeAndPersist(
                TENANT, USER, huge, "huge.wav", AudioFormat.WAV, "en", VALID_RATE))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("maximum size");
    }

    // -----------------------------------------------------------------------
    // Format guard
    // -----------------------------------------------------------------------

    @Test
    @DisplayName("unsupported file extension throws IllegalArgumentException")
    void unsupportedFormatThrows() {
        byte[] audio = new byte[1024];
        assertThatThrownBy(() -> service.transcribeAndPersist(
                TENANT, USER, audio, "clip.avi", AudioFormat.WAV, "en", VALID_RATE))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("Unsupported audio format");
    }

    @Test
    @DisplayName("wav extension is accepted without exception")
    void wavExtensionAccepted() {
        byte[] audio = new byte[1024];
        // Validation passes; persistence will be attempted — let the Promise propagate normally.
        assertThatCode(() -> service.transcribeAndPersist(
                TENANT, USER, audio, "clip.wav", AudioFormat.WAV, "en", VALID_RATE))
            .doesNotThrowAnyException();
    }

    @Test
    @DisplayName("mp3 extension is accepted without exception")
    void mp3ExtensionAccepted() {
        byte[] audio = new byte[1024];
        assertThatCode(() -> service.transcribeAndPersist(
                TENANT, USER, audio, "clip.mp3", AudioFormat.WAV, "en", VALID_RATE))
            .doesNotThrowAnyException();
    }

    // -----------------------------------------------------------------------
    // Sample-rate guard
    // -----------------------------------------------------------------------

    @Test
    @DisplayName("sample rate below 8000 Hz throws IllegalArgumentException")
    void sampleRateTooLowThrows() {
        byte[] audio = new byte[1024];
        assertThatThrownBy(() -> service.transcribeAndPersist(
                TENANT, USER, audio, "sample.wav", AudioFormat.WAV, "en", 7_999))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("Sample rate");
    }

    @Test
    @DisplayName("sample rate above 48000 Hz throws IllegalArgumentException")
    void sampleRateTooHighThrows() {
        byte[] audio = new byte[1024];
        assertThatThrownBy(() -> service.transcribeAndPersist(
                TENANT, USER, audio, "sample.wav", AudioFormat.WAV, "en", 48_001))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("Sample rate");
    }

    @Test
    @DisplayName("boundary sample rates 8000 and 48000 are accepted")
    void boundarySampleRatesAccepted() {
        byte[] audio = new byte[1024];
        assertThatCode(() -> service.transcribeAndPersist(
                TENANT, USER, audio, "sample.wav", AudioFormat.WAV, "en", 8_000))
            .doesNotThrowAnyException();
        assertThatCode(() -> service.transcribeAndPersist(
                TENANT, USER, audio, "sample.wav", AudioFormat.WAV, "en", 48_000))
            .doesNotThrowAnyException();
    }

    // -----------------------------------------------------------------------
    // Language guard
    // -----------------------------------------------------------------------

    @Test
    @DisplayName("unsupported language code throws IllegalArgumentException")
    void unsupportedLanguageThrows() {
        byte[] audio = new byte[1024];
        assertThatThrownBy(() -> service.transcribeAndPersist(
                TENANT, USER, audio, "sample.wav", AudioFormat.WAV, "klingon", VALID_RATE))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("Unsupported language");
    }

    @Test
    @DisplayName("null language is accepted (no language hint)")
    void nullLanguageAccepted() {
        byte[] audio = new byte[1024];
        assertThatCode(() -> service.transcribeAndPersist(
                TENANT, USER, audio, "sample.wav", AudioFormat.WAV, null, VALID_RATE))
            .doesNotThrowAnyException();
    }

    @Test
    @DisplayName("BCP-47 tag with region (en-US) resolves to supported base language")
    void bcp47TagWithRegionAccepted() {
        byte[] audio = new byte[1024];
        assertThatCode(() -> service.transcribeAndPersist(
                TENANT, USER, audio, "sample.wav", AudioFormat.WAV, "en-US", VALID_RATE))
            .doesNotThrowAnyException();
    }

    // -----------------------------------------------------------------------
    // Degraded mode
    // -----------------------------------------------------------------------

    @Test
    @DisplayName("isDegraded returns false by default")
    void isDegradedFalseByDefault() {
        org.assertj.core.api.Assertions.assertThat(service.isDegraded()).isFalse();
        org.assertj.core.api.Assertions.assertThat(service.getDegradationReason()).isNull();
    }

    @Test
    @DisplayName("setDegradedMode true causes isDegraded to return true")
    void setDegradedModeUpdatesState() {
        service.setDegradedMode(true, "model loading failed");
        org.assertj.core.api.Assertions.assertThat(service.isDegraded()).isTrue();
        org.assertj.core.api.Assertions.assertThat(service.getDegradationReason())
            .isEqualTo("model loading failed");
    }

    @Test
    @DisplayName("clearing degraded mode resets state")
    void clearingDegradedModeResetsState() {
        service.setDegradedMode(true, "temporary");
        service.setDegradedMode(false, null);
        org.assertj.core.api.Assertions.assertThat(service.isDegraded()).isFalse();
    }
}
