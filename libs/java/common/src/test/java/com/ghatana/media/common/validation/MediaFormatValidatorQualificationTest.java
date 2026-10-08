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

    @Test
    void acceptsCompleteAlignedPcmContainerWithoutClaimingDecodeQualification() {
        var result = MediaFormatValidator.validateAudio(pcmWav(4), "WAV", 16000);
        assertThat(result.valid).isTrue();
        assertThat(result.sampleRate).isEqualTo(16000);
        assertThat(result.channels).isEqualTo(1);
        assertThat(result.bitsPerSample).isEqualTo(16);
    }

    @Test
    void rejectsMissingDataAndIncompleteSampleFrames() {
        byte[] noData = java.util.Arrays.copyOf(pcmWav(4), 36);
        ByteBuffer.wrap(noData).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 28);
        // Keep enough input bytes to reach the container parser.
        noData = java.util.Arrays.copyOf(noData, 44);
        ByteBuffer.wrap(noData).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 36);
        putAscii(noData, 36, "JUNK");
        assertThat(MediaFormatValidator.validateAudio(noData, "WAV", 0).errorMessage).contains("missing data");
        assertThat(MediaFormatValidator.validateAudio(pcmWav(0), "WAV", 0).errorMessage).contains("nonempty sample frames");
        assertThat(MediaFormatValidator.validateAudio(pcmWav(3), "WAV", 0).errorMessage).contains("complete nonempty sample frames");
    }

    @Test
    void rejectsPcmRateAndAlignmentInconsistencies() {
        byte[] wav = pcmWav(4);
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putShort(32, (short) 1);
        assertThat(MediaFormatValidator.validateAudio(wav, "WAV", 0).errorMessage).contains("block alignment");
        wav = pcmWav(4);
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(28, 16000);
        assertThat(MediaFormatValidator.validateAudio(wav, "WAV", 0).errorMessage).contains("byte rate");
    }

    @Test
    void rejectsLayoutsWhoseExtensibleSemanticsAreNotImplemented() {
        byte[] wav = pcmWav(4);
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putShort(22, (short) 3);
        assertThat(MediaFormatValidator.validateAudio(wav, "WAV", 0).errorMessage).contains("Unsupported basic WAV PCM");
        wav = pcmWav(4);
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putShort(34, (short) 24);
        assertThat(MediaFormatValidator.validateAudio(wav, "WAV", 0).errorMessage).contains("Unsupported basic WAV PCM");
    }

    @Test
    void validatesChunksAfterFmtEvenWhenSampleRateDiffers() {
        byte[] wav = pcmWav(4);
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(40, 1000);
        var result = MediaFormatValidator.validateAudio(wav, "WAV", 8000);
        assertThat(result.valid).isFalse();
        assertThat(result.errorMessage).contains("exceeds available data");
    }

    @Test
    void rejectsTruncatedTrailingHeaderAndBytesOutsideContainer() {
        byte[] wav = java.util.Arrays.copyOf(pcmWav(4), 51);
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 43);
        assertThat(MediaFormatValidator.validateAudio(wav, "WAV", 0).errorMessage).contains("incomplete trailing chunk");
        wav = java.util.Arrays.copyOf(pcmWav(4), 50);
        assertThat(MediaFormatValidator.validateAudio(wav, "WAV", 0).errorMessage).contains("outside the RIFF");
    }

    private static byte[] pcmWav(int dataSize) {
        byte[] wav = new byte[44 + dataSize + (dataSize & 1)];
        ByteBuffer b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        putAscii(wav, 0, "RIFF"); b.putInt(4, wav.length - 8); putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt "); b.putInt(16, 16); b.putShort(20, (short) 1);
        b.putShort(22, (short) 1); b.putInt(24, 16000); b.putInt(28, 32000);
        b.putShort(32, (short) 2); b.putShort(34, (short) 16);
        putAscii(wav, 36, "data"); b.putInt(40, dataSize);
        return wav;
    }

    private static void putAscii(byte[] bytes, int offset, String text) {
        byte[] encoded = text.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(encoded, 0, bytes, offset, encoded.length);
    }
}
