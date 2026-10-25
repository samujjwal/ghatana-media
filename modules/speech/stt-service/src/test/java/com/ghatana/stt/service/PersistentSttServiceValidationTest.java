package com.ghatana.stt.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verifyNoInteractions;

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
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

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
    @DisplayName("blank tenant is rejected before persistence or inference")
    void blankTenantIsRejectedBeforeWork() {
        assertThatThrownBy(() -> service.transcribeAndPersist(
                "  ", USER, new byte[] {1}, "sample.wav", AudioFormat.WAV, "en", VALID_RATE))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("tenantId cannot be blank");
        verifyNoInteractions(audioFileService, transcriptionService, library);
    }

    @Test
    @DisplayName("tenant-only transcript read and delete APIs fail closed without a principal")
    void tenantOnlyReadAndDeleteApisFailClosed() {
        assertThatThrownBy(() -> service.getTranscription(TENANT, UUID.randomUUID()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("Principal-scoped");
        assertThatThrownBy(() -> service.getTranscriptions(TENANT))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("Principal-scoped");
        assertThatThrownBy(() -> service.deleteTranscription(TENANT, UUID.randomUUID()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("Principal-scoped");
        verifyNoInteractions(audioFileService, transcriptionService, library);
    }

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
            .hasMessageContaining("100 MiB input limit");
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
            .hasMessageContaining("STT_AUDIO_FORMAT_MISMATCH");
    }

    @Test
    @DisplayName("wav extension is accepted without exception")
    void wavExtensionAccepted() {
        byte[] audio = pcmWav(VALID_RATE, 4);
        assertVersionNotAdmitted(service.transcribeAndPersist(
                TENANT, USER, audio, "clip.wav", AudioFormat.WAV, "en", VALID_RATE));
    }

    @Test
    @DisplayName("MP3 fails closed until a decoder is admitted")
    void mp3IsNotAdmitted() {
        assertThatThrownBy(() -> service.transcribeAndPersist(
                TENANT, USER, new byte[] {(byte) 0xff, (byte) 0xfb}, "clip.mp3", AudioFormat.MP3, "en", VALID_RATE))
            .isInstanceOf(SttAudioInputDecoder.InputException.class)
            .hasMessageContaining("STT_AUDIO_FORMAT_NOT_ADMITTED");
    }

    // -----------------------------------------------------------------------
    // Sample-rate guard
    // -----------------------------------------------------------------------

    @Test
    @DisplayName("sample rate below 8000 Hz throws IllegalArgumentException")
    void sampleRateTooLowThrows() {
        byte[] audio = pcmWav(VALID_RATE, 4);
        assertThatThrownBy(() -> service.transcribeAndPersist(
                TENANT, USER, audio, "sample.wav", AudioFormat.WAV, "en", 7_999))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("STT_AUDIO_SAMPLE_RATE_INVALID");
    }

    @Test
    @DisplayName("sample rate above 48000 Hz throws IllegalArgumentException")
    void sampleRateTooHighThrows() {
        byte[] audio = pcmWav(VALID_RATE, 4);
        assertThatThrownBy(() -> service.transcribeAndPersist(
                TENANT, USER, audio, "sample.wav", AudioFormat.WAV, "en", 48_001))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("STT_AUDIO_SAMPLE_RATE_INVALID");
    }

    @Test
    @DisplayName("boundary sample rates 8000 and 48000 are accepted")
    void boundarySampleRatesAccepted() {
        assertVersionNotAdmitted(service.transcribeAndPersist(
                TENANT, USER, pcmWav(8_000, 4), "sample.wav", AudioFormat.WAV, "en", 8_000));
        assertVersionNotAdmitted(service.transcribeAndPersist(
                TENANT, USER, pcmWav(48_000, 4), "sample.wav", AudioFormat.WAV, "en", 48_000));
    }

    // -----------------------------------------------------------------------
    // Language guard
    // -----------------------------------------------------------------------

    @Test
    @DisplayName("unsupported language code throws IllegalArgumentException")
    void unsupportedLanguageThrows() {
        byte[] audio = pcmWav(VALID_RATE, 4);
        assertThatThrownBy(() -> service.transcribeAndPersist(
                TENANT, USER, audio, "sample.wav", AudioFormat.WAV, "klingon", VALID_RATE))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("Unsupported language");
    }

    @Test
    @DisplayName("null language is accepted (no language hint)")
    void nullLanguageAccepted() {
        byte[] audio = pcmWav(VALID_RATE, 4);
        assertVersionNotAdmitted(service.transcribeAndPersist(
                TENANT, USER, audio, "sample.wav", AudioFormat.WAV, null, VALID_RATE));
    }

    @Test
    @DisplayName("BCP-47 tag with region (en-US) resolves to supported base language")
    void bcp47TagWithRegionAccepted() {
        byte[] audio = pcmWav(VALID_RATE, 4);
        assertVersionNotAdmitted(service.transcribeAndPersist(
                TENANT, USER, audio, "sample.wav", AudioFormat.WAV, "en-US", VALID_RATE));
    }

    @Test
    @DisplayName("WAV container sample rate must match the request sample rate")
    void sampleRateMismatchRejected() {
        assertThatThrownBy(() -> service.transcribeAndPersist(
                TENANT, USER, pcmWav(16_000, 4), "sample.wav", AudioFormat.WAV, "en", 22_050))
            .isInstanceOf(SttAudioInputDecoder.InputException.class)
            .hasMessageContaining("STT_AUDIO_SAMPLE_RATE_MISMATCH");
        verifyNoInteractions(audioFileService, transcriptionService, library);
    }

    private static byte[] pcmWav(int sampleRate, int pcmBytes) {
        byte[] wav = new byte[44 + pcmBytes];
        ByteBuffer buffer = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        putAscii(wav, 0, "RIFF");
        buffer.putInt(4, wav.length - 8);
        putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt ");
        buffer.putInt(16, 16);
        buffer.putShort(20, (short) 1);
        buffer.putShort(22, (short) 1);
        buffer.putInt(24, sampleRate);
        buffer.putInt(28, sampleRate * 2);
        buffer.putShort(32, (short) 2);
        buffer.putShort(34, (short) 16);
        putAscii(wav, 36, "data");
        buffer.putInt(40, pcmBytes);
        return wav;
    }

    private static void putAscii(byte[] bytes, int offset, String text) {
        byte[] value = text.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(value, 0, bytes, offset, value.length);
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

    private static void assertVersionNotAdmitted(Promise<?> promise) {
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        promise.whenException(failure::set);
        assertThat(failure.get())
                .isInstanceOf(PersistentSttService.TranscriptVersionNotAdmittedException.class)
                .hasMessageStartingWith("STT_TRANSCRIPT_VERSION_NOT_ADMITTED:");
    }
}
