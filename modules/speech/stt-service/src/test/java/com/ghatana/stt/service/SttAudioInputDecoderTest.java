package com.ghatana.stt.service;

import com.ghatana.media.common.AudioFormat;
import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SttAudioInputDecoderTest {
    @Test
    void decodesSupportedPcmWavToPcmWithRationalSampleClock() {
        byte[] pcm = new byte[] {1, 2, 3, 4};
        var decoded = SttAudioInputDecoder.decode(pcmWav(16_000, 1, 16, pcm), AudioFormat.WAV, 16_000);

        assertThat(decoded.format()).isEqualTo(AudioFormat.PCM);
        assertThat(decoded.data()).containsExactly(pcm);
        assertThat(decoded.sampleRate()).isEqualTo(16_000);
        assertThat(decoded.channels()).isEqualTo(1);
        assertThat(decoded.bitsPerSample()).isEqualTo(16);
        assertThat(decoded.duration().toNanos()).isEqualTo(125_000);
    }

    @Test
    void rejectsBadWavHeaderWithStableInvalidArgumentKind() {
        byte[] malformed = pcmWav(16_000, 1, 16, new byte[] {1, 2});
        malformed[0] = 'X';

        assertThatThrownBy(() -> SttAudioInputDecoder.decode(malformed, AudioFormat.WAV, 16_000))
                .isInstanceOfSatisfying(SttAudioInputDecoder.InputException.class, failure -> {
                    assertThat(failure.kind()).isEqualTo(SttAudioInputDecoder.FailureKind.INVALID_ARGUMENT);
                    assertThat(failure).hasMessageContaining("STT_AUDIO_INVALID_HEADER");
                });
    }

    @Test
    void rejectsForgedRiffAndDataLengthsWithStableMalformedStatus() {
        byte[] forgedRiff = pcmWav(16_000, 1, 16, new byte[] {1, 2});
        ByteBuffer.wrap(forgedRiff).order(ByteOrder.LITTLE_ENDIAN).putInt(4, Integer.MAX_VALUE);
        assertMalformedWav(forgedRiff);

        byte[] forgedData = pcmWav(16_000, 1, 16, new byte[] {1, 2});
        ByteBuffer.wrap(forgedData).order(ByteOrder.LITTLE_ENDIAN).putInt(40, Integer.MAX_VALUE);
        assertMalformedWav(forgedData);
    }

    @Test
    void rejectsTruncatedChunkHeaderAndMissingOddChunkPadding() {
        byte[] truncatedHeader = pcmWav(16_000, 1, 16, new byte[] {1, 2});
        byte[] truncated = java.util.Arrays.copyOf(truncatedHeader, 43);
        assertMalformedWav(truncated);

        byte[] oddJunkChunk = new byte[54];
        putAscii(oddJunkChunk, 0, "RIFF");
        ByteBuffer buffer = ByteBuffer.wrap(oddJunkChunk).order(ByteOrder.LITTLE_ENDIAN);
        buffer.putInt(4, oddJunkChunk.length - 8);
        putAscii(oddJunkChunk, 8, "WAVE");
        putAscii(oddJunkChunk, 12, "JUNK");
        buffer.putInt(16, 1);
        oddJunkChunk[20] = 7;
        // Missing the required pad byte shifts the following fmt/data chunk structure.
        putAscii(oddJunkChunk, 21, "fmt ");
        buffer.putInt(25, 16);
        assertMalformedWav(oddJunkChunk);
    }

    @Test
    void enforcesConfiguredDurationAtExactBoundaryAndOneFrameOver() {
        byte[] exact = pcmWav(8_000, 1, 16, new byte[16_000]);
        assertThat(SttAudioInputDecoder.decode(exact, AudioFormat.WAV, 8_000, 1).duration().getSeconds())
                .isEqualTo(1);

        byte[] over = pcmWav(8_000, 1, 16, new byte[16_002]);
        assertThatThrownBy(() -> SttAudioInputDecoder.decode(over, AudioFormat.WAV, 8_000, 1))
                .isInstanceOfSatisfying(SttAudioInputDecoder.InputException.class, failure -> {
                    assertThat(failure.kind()).isEqualTo(SttAudioInputDecoder.FailureKind.INVALID_ARGUMENT);
                    assertThat(failure).hasMessageContaining("STT_AUDIO_DURATION_EXCEEDED");
                });
    }

    private static void assertMalformedWav(byte[] input) {
        assertThatThrownBy(() -> SttAudioInputDecoder.decode(input, AudioFormat.WAV, 16_000))
                .isInstanceOfSatisfying(SttAudioInputDecoder.InputException.class, failure -> {
                    assertThat(failure.kind()).isEqualTo(SttAudioInputDecoder.FailureKind.INVALID_ARGUMENT);
                    assertThat(failure).hasMessageContaining("STT_AUDIO_INVALID_WAV");
                });
    }

    @Test
    void rejectsUnsupportedFlacInsteadOfPassingContainerBytesAsPcm() {
        assertThatThrownBy(() -> SttAudioInputDecoder.decode(
                new byte[] {'f', 'L', 'a', 'C', 0, 0}, AudioFormat.FLAC, 16_000))
                .isInstanceOfSatisfying(SttAudioInputDecoder.InputException.class, failure -> {
                    assertThat(failure.kind()).isEqualTo(SttAudioInputDecoder.FailureKind.NOT_ADMITTED);
                    assertThat(failure).hasMessageContaining("STT_AUDIO_FORMAT_NOT_ADMITTED");
                });
    }

    @Test
    void rejectsContainerSampleRateMismatchAndUnsupportedChannelOrSampleShapes() {
        assertThatThrownBy(() -> SttAudioInputDecoder.decode(
                pcmWav(16_000, 1, 16, new byte[] {1, 2}), AudioFormat.WAV, 48_000))
                .isInstanceOfSatisfying(SttAudioInputDecoder.InputException.class, failure ->
                        assertThat(failure).hasMessageContaining("STT_AUDIO_SAMPLE_RATE_MISMATCH"));

        assertThatThrownBy(() -> SttAudioInputDecoder.decode(
                pcmWav(16_000, 2, 16, new byte[] {1, 2, 3, 4}), AudioFormat.WAV, 16_000))
                .isInstanceOfSatisfying(SttAudioInputDecoder.InputException.class, failure ->
                        assertThat(failure.kind()).isEqualTo(SttAudioInputDecoder.FailureKind.NOT_ADMITTED));
        assertThatThrownBy(() -> SttAudioInputDecoder.decode(
                pcmWav(16_000, 1, 16, new byte[] {1, 2, 3}), AudioFormat.WAV, 16_000))
                .isInstanceOfSatisfying(SttAudioInputDecoder.InputException.class, failure -> {
                    assertThat(failure.kind()).isEqualTo(SttAudioInputDecoder.FailureKind.INVALID_ARGUMENT);
                    assertThat(failure).hasMessageContaining("STT_AUDIO_INVALID_WAV");
                });
    }

    @Test
    void enforcesSampleRateAndSizeBoundariesBeforeAllocation() {
        SttAudioInputDecoder.requireSampleRate(8_000);
        SttAudioInputDecoder.requireSampleRate(48_000);
        SttAudioInputDecoder.requireInputSize(SttAudioInputDecoder.MAX_INPUT_BYTES);

        assertThatThrownBy(() -> SttAudioInputDecoder.requireSampleRate(7_999))
                .isInstanceOf(SttAudioInputDecoder.InputException.class)
                .hasMessageContaining("STT_AUDIO_SAMPLE_RATE_INVALID");
        assertThatThrownBy(() -> SttAudioInputDecoder.requireSampleRate(48_001))
                .isInstanceOf(SttAudioInputDecoder.InputException.class)
                .hasMessageContaining("STT_AUDIO_SAMPLE_RATE_INVALID");
        assertThatThrownBy(() -> SttAudioInputDecoder.requireInputSize(
                SttAudioInputDecoder.MAX_INPUT_BYTES + 1))
                .isInstanceOfSatisfying(SttAudioInputDecoder.InputException.class, failure -> {
                    assertThat(failure.kind()).isEqualTo(SttAudioInputDecoder.FailureKind.RESOURCE_EXHAUSTED);
                    assertThat(failure).hasMessageContaining("STT_AUDIO_TOO_LARGE");
                });
    }

    @Test
    void rejectsIncompleteRawPcmFrames() {
        assertThatThrownBy(() -> SttAudioInputDecoder.decode(
                new byte[] {1, 2, 3}, AudioFormat.PCM, 16_000))
                .isInstanceOf(SttAudioInputDecoder.InputException.class)
                .hasMessageContaining("STT_AUDIO_INCOMPLETE_FRAME");
    }

    private static byte[] pcmWav(int sampleRate, int channels, int bitsPerSample, byte[] pcm) {
        int blockAlign = channels * bitsPerSample / 8;
        byte[] wav = new byte[44 + pcm.length + (pcm.length & 1)];
        ByteBuffer buffer = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        putAscii(wav, 0, "RIFF");
        buffer.putInt(4, wav.length - 8);
        putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt ");
        buffer.putInt(16, 16);
        buffer.putShort(20, (short) 1);
        buffer.putShort(22, (short) channels);
        buffer.putInt(24, sampleRate);
        buffer.putInt(28, sampleRate * blockAlign);
        buffer.putShort(32, (short) blockAlign);
        buffer.putShort(34, (short) bitsPerSample);
        putAscii(wav, 36, "data");
        buffer.putInt(40, pcm.length);
        System.arraycopy(pcm, 0, wav, 44, pcm.length);
        return wav;
    }

    private static void putAscii(byte[] bytes, int offset, String text) {
        byte[] value = text.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(value, 0, bytes, offset, value.length);
    }
}
