package com.ghatana.media.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * @doc.type class
 * @doc.purpose Tests shared audio conversion and metadata extraction utilities
 * @doc.layer platform
 * @doc.pattern TestCase
 */
@DisplayName("AudioConverter")
class AudioConverterTest {

    @Test
    @DisplayName("PCM16 round-trip keeps sample shape")
    void pcm16RoundTrip() { 
        float[] samples = new float[]{-1.0f, -0.5f, 0.0f, 0.5f, 1.0f};

        byte[] pcm = AudioConverter.floatSamplesToPcm16(samples); 
        float[] restored = AudioConverter.pcmToFloatSamples(pcm, 16); 

        assertThat(restored).hasSize(samples.length); 
        assertThat(restored[0]).isCloseTo(-1.0f, within(0.01f)); 
        assertThat(restored[1]).isCloseTo(-0.5f, within(0.01f)); 
        assertThat(restored[3]).isCloseTo(0.5f, within(0.01f)); 
        assertThat(restored[4]).isCloseTo(1.0f, within(0.01f)); 
    }

    @Test
    @DisplayName("non-finite float samples are rejected while finite out-of-range samples clamp")
    void rejectsNonFiniteSamplesAndClampsFiniteSamples() {
        List<Float> nonFinite = List.of(
                Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY);
        for (float sample : nonFinite) {
            assertThatIllegalArgumentException()
                    .isThrownBy(() -> AudioConverter.floatSamplesToPcm16(new float[]{sample}));
        }

        float[] restored = AudioConverter.pcmToFloatSamples(
                AudioConverter.floatSamplesToPcm16(new float[]{-2.0f, -1.0f, 1.0f, 2.0f}), 16);
        assertThat(restored).containsExactly(-32767 / 32768.0f, -32767 / 32768.0f,
                32767 / 32768.0f, 32767 / 32768.0f);
    }

    @Test
    @DisplayName("Signed 24-bit PCM values are sign-extended correctly")
    void pcm24SignExtension() { 
        byte[] data = new byte[]{0x00, 0x00, (byte) 0x80, (byte) 0xFF, (byte) 0xFF, 0x7F}; 

        float[] restored = AudioConverter.pcmToFloatSamples(data, 24); 

        assertThat(restored[0]).isCloseTo(-1.0f, within(0.01f)); 
        assertThat(restored[1]).isCloseTo(1.0f, within(0.01f)); 
    }

    @Test
    @DisplayName("PCM conversion supports exact 8 through 32 bit widths and scales 32 bit safely")
    void pcmWidthsHaveCorrectSignedScaling() {
        assertThat(AudioConverter.pcmToFloatSamples(new byte[] {(byte) 0x80, 0x7f}, 8))
                .containsExactly(-1.0f, 127 / 128.0f);
        assertThat(AudioConverter.pcmToFloatSamples(new byte[] {
                0, 0, 0, (byte) 0x80, (byte) 0xff, (byte) 0xff, (byte) 0xff, 0x7f}, 32))
                .containsExactly(-1.0f, 2147483647 / 2147483648.0f);
    }

    @Test
    @DisplayName("Unsupported widths and partial PCM samples are rejected")
    void rejectsUnsupportedPcmWidthsAndPartialSamples() {
        for (int bitsPerSample : new int[] {0, 1, 7, 12, 40, 64}) {
            assertThatIllegalArgumentException()
                    .isThrownBy(() -> AudioConverter.pcmToFloatSamples(new byte[8], bitsPerSample));
        }
        assertThatIllegalArgumentException()
                .isThrownBy(() -> AudioConverter.pcmToFloatSamples(new byte[] {1, 2, 3}, 16))
                .withMessageContaining("complete samples");
    }

    @Test
    @DisplayName("PCM decoding rejects sample counts above the bounded conversion limit")
    void rejectsPcmDecodeAboveSampleBoundBeforeAllocatingOutput() {
        byte[] oversized = new byte[AudioConverter.MAX_CONVERTED_SAMPLES + 1];
        assertThatIllegalArgumentException()
                .isThrownBy(() -> AudioConverter.pcmToFloatSamples(oversized, 8))
                .withMessageContaining("conversion limit");
    }

    @Test
    @DisplayName("Sample clock durations use exact integer rational rounding")
    void sampleClockUsesRationalRounding() {
        AudioData oneFrame = AudioConverter.fromFloatSamples(new float[] {0.0f}, 3, 1);
        AudioData twoFrames = AudioConverter.fromFloatSamples(new float[] {0.0f, 0.0f}, 3, 1);

        assertThat(oneFrame.duration()).isEqualTo(Duration.ofNanos(333_333_333L));
        assertThat(twoFrames.duration()).isEqualTo(Duration.ofNanos(666_666_667L));
    }

    @Test
    @DisplayName("Interleaved conversion rejects incomplete channel frames")
    void rejectsIncompleteMultichannelFrame() {
        assertThatIllegalArgumentException()
                .isThrownBy(() -> AudioConverter.fromFloatSamples(new float[] {0.25f}, 16000, 2))
                .withMessageContaining("complete channel frames");
    }

    @Test
    @DisplayName("Audio metadata is extracted from AudioData and WAV bytes")
    void extractsAudioMetadata() { 
        AudioData audioData = AudioConverter.fromFloatSamples(new float[]{0.0f, 0.5f, -0.5f, 0.25f}, 16000, 1); 

        AudioMetadata dataMetadata = AudioMetadataExtractor.fromAudioData(audioData); 
        AudioMetadata wavMetadata = AudioMetadataExtractor.fromWavBytes(createWavBytes(16000, 1, 16, 4)); 

        assertThat(dataMetadata.sampleRate()).isEqualTo(16000); 
        assertThat(dataMetadata.channels()).isEqualTo(1); 
        assertThat(dataMetadata.bitsPerSample()).isEqualTo(16); 
        assertThat(dataMetadata.sampleCount()).isEqualTo(4); 

        assertThat(wavMetadata.sampleRate()).isEqualTo(16000); 
        assertThat(wavMetadata.channels()).isEqualTo(1); 
        assertThat(wavMetadata.bitsPerSample()).isEqualTo(16); 
        assertThat(wavMetadata.sampleCount()).isEqualTo(4); 
        assertThat(wavMetadata.containerFormat()).isEqualTo("WAV");
    }

    @Test
    @DisplayName("Audio metadata rejects a payload ending inside a channel frame")
    void rejectsAudioDataWithPartialFrame() {
        AudioData partialFrame = AudioData.builder()
                .data(new byte[] {1, 2, 3})
                .sampleRate(16000)
                .channels(2)
                .bitsPerSample(16)
                .build();

        assertThatThrownBy(() -> AudioMetadataExtractor.fromAudioData(partialFrame))
                .isInstanceOf(ValidationError.class)
                .hasMessageContaining("complete sample frames");
    }

    @Test
    @DisplayName("WAV metadata parser rejects unsigned lengths outside the RIFF buffer")
    void wavParserRejectsUnsignedChunkAndContainerOverflow() {
        byte[] oversizedRiff = createWavBytes(16000, 1, 16, 4);
        oversizedRiff[4] = (byte) 0xFF;
        oversizedRiff[5] = (byte) 0xFF;
        oversizedRiff[6] = (byte) 0xFF;
        oversizedRiff[7] = (byte) 0xFF;
        assertThatThrownBy(() -> AudioMetadataExtractor.fromWavBytes(oversizedRiff))
                .isInstanceOf(ValidationError.class);

        byte[] oversizedChunk = createWavBytes(16000, 1, 16, 4);
        // The first chunk-size field is a little-endian uint at byte offset 16.
        oversizedChunk[16] = (byte) 0xFF;
        oversizedChunk[17] = (byte) 0xFF;
        oversizedChunk[18] = (byte) 0xFF;
        oversizedChunk[19] = (byte) 0xFF;
        assertThatThrownBy(() -> AudioMetadataExtractor.fromWavBytes(oversizedChunk))
                .isInstanceOf(ValidationError.class);
    }

    @Test
    @DisplayName("WAV metadata parser rejects incomplete PCM frames and unsupported encodings")
    void wavParserRejectsMalformedFrameAndCodecShape() {
        byte[] incompleteFrame = createWavBytes(16000, 2, 16, 3);
        // A 10-byte payload is not divisible by the 4-byte stereo frame size.
        incompleteFrame[40] = 10;
        incompleteFrame[41] = 0;
        incompleteFrame[42] = 0;
        incompleteFrame[43] = 0;
        // Keep RIFF chunk structure valid by shortening payload to 10 bytes and
        // setting the container length to include its required even boundary.
        byte[] shortened = java.util.Arrays.copyOf(incompleteFrame, 54);
        shortened[4] = 46;
        shortened[5] = 0;
        shortened[6] = 0;
        shortened[7] = 0;
        assertThatThrownBy(() -> AudioMetadataExtractor.fromWavBytes(shortened))
                .isInstanceOf(ValidationError.class);

        byte[] compressedEncoding = createWavBytes(16000, 1, 16, 4);
        compressedEncoding[20] = 3;
        compressedEncoding[21] = 0;
        assertThatThrownBy(() -> AudioMetadataExtractor.fromWavBytes(compressedEncoding))
                .isInstanceOf(ValidationError.class);
    }

    @Test
    @DisplayName("PCM WAV metadata rejects inconsistent block alignment and byte rate")
    void wavParserRejectsInconsistentPcmLayout() {
        byte[] wrongByteRate = createWavBytes(16000, 2, 16, 4);
        wrongByteRate[28] = 1;
        wrongByteRate[29] = 0;
        wrongByteRate[30] = 0;
        wrongByteRate[31] = 0;
        assertThatThrownBy(() -> AudioMetadataExtractor.fromWavBytes(wrongByteRate))
                .isInstanceOf(ValidationError.class)
                .hasMessageContaining("byte rate or block alignment");

        byte[] wrongBlockAlign = createWavBytes(16000, 2, 16, 4);
        wrongBlockAlign[32] = 2;
        wrongBlockAlign[33] = 0;
        assertThatThrownBy(() -> AudioMetadataExtractor.fromWavBytes(wrongBlockAlign))
                .isInstanceOf(ValidationError.class)
                .hasMessageContaining("byte rate or block alignment");
    }

    private static org.assertj.core.data.Offset<Float> within(float value) { 
        return org.assertj.core.data.Offset.offset(value); 
    }

    private static byte[] createWavBytes(int sampleRate, int channels, int bitsPerSample, int sampleCount) { 
        int dataSize = sampleCount * channels * (bitsPerSample / 8); 
        ByteBuffer buffer = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN); 
        buffer.put("RIFF".getBytes()); 
        buffer.putInt(36 + dataSize); 
        buffer.put("WAVE".getBytes()); 
        buffer.put("fmt ".getBytes()); 
        buffer.putInt(16); 
        buffer.putShort((short) 1); 
        buffer.putShort((short) channels); 
        buffer.putInt(sampleRate); 
        buffer.putInt(sampleRate * channels * (bitsPerSample / 8)); 
        buffer.putShort((short) (channels * (bitsPerSample / 8))); 
        buffer.putShort((short) bitsPerSample); 
        buffer.put("data".getBytes()); 
        buffer.putInt(dataSize); 
        for (int index = 0; index < dataSize; index++) { 
            buffer.put((byte) 0); 
        }
        return buffer.array(); 
    }
}
