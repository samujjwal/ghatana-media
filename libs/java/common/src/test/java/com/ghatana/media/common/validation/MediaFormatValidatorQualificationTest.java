package com.ghatana.media.common.validation;

import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

class MediaFormatValidatorQualificationTest {
    @Test
    void recognizesCompressedAudioHeadersWithoutTreatingThemAsQualifiedDecodeProfiles() {
        byte[] mp3Header = new byte[44];
        byte[] id3 = "ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000".getBytes(StandardCharsets.ISO_8859_1);
        System.arraycopy(id3, 0, mp3Header, 0, id3.length);
        assertThat(MediaFormatValidator.detectAudioFormat(mp3Header)).isEqualTo("MP3");

        var validation = MediaFormatValidator.validateAudio(mp3Header, null, 0);
        assertThat(validation.valid).isFalse();
        assertThat(validation.errorMessage).contains("no complete decode profile is qualified");
    }

    @Test
    void rejectsRiffChunksWhoseUnsignedLengthExceedsTheInput() {
        byte[] wav = new byte[44];
        putAscii(wav, 0, "RIFF");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 36);
        putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt ");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(16, -1);

        var validation = MediaFormatValidator.validateAudio(wav, "WAV", 0);
        assertThat(validation.valid).isFalse();
        assertThat(validation.errorMessage).isEqualTo("WAV chunk exceeds available data");
    }

    @Test
    void rejectsFormatChunksTooShortToContainThePcmFields() {
        byte[] wav = new byte[44];
        putAscii(wav, 0, "RIFF");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 36);
        putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt ");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(16, 8);

        var validation = MediaFormatValidator.validateAudio(wav, "WAV", 0);
        assertThat(validation.valid).isFalse();
        assertThat(validation.errorMessage).isEqualTo("WAV fmt chunk is shorter than the PCM header");
    }

    @Test
    void rejectsRiffLengthThatClaimsBytesBeyondTheInput() {
        byte[] wav = new byte[44];
        putAscii(wav, 0, "RIFF");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(4, -1);
        putAscii(wav, 8, "WAVE");

        var validation = MediaFormatValidator.validateAudio(wav, "WAV", 0);
        assertThat(validation.valid).isFalse();
        assertThat(validation.errorMessage).isEqualTo("WAV RIFF chunk exceeds available data");
    }

    @Test
    void rejectsChunksThatFitTheArrayButExceedTheDeclaredRiffBoundary() {
        byte[] wav = new byte[44];
        putAscii(wav, 0, "RIFF");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 20);
        putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt ");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(16, 16);

        var validation = MediaFormatValidator.validateAudio(wav, "WAV", 0);
        assertThat(validation.valid).isFalse();
        assertThat(validation.errorMessage).isEqualTo("WAV chunk exceeds RIFF bounds");
    }

    @Test
    void rejectsOddSizedChunkWithoutItsRequiredPaddingByte() {
        byte[] wav = new byte[44];
        putAscii(wav, 0, "RIFF");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 29);
        putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt ");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(16, 17);

        var validation = MediaFormatValidator.validateAudio(wav, "WAV", 0);
        assertThat(validation.valid).isFalse();
        assertThat(validation.errorMessage).isEqualTo("WAV chunk padding exceeds RIFF bounds");
    }

    private static void putAscii(byte[] bytes, int offset, String text) {
        byte[] encoded = text.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(encoded, 0, bytes, offset, encoded.length);
    }
}
