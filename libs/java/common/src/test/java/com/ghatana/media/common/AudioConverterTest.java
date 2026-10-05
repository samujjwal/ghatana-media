package com.ghatana.media.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

import static org.assertj.core.api.Assertions.assertThat;

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
    @DisplayName("Signed 24-bit PCM values are sign-extended correctly")
    void pcm24SignExtension() { 
        byte[] data = new byte[]{0x00, 0x00, (byte) 0x80, (byte) 0xFF, (byte) 0xFF, 0x7F}; 

        float[] restored = AudioConverter.pcmToFloatSamples(data, 24); 

        assertThat(restored[0]).isCloseTo(-1.0f, within(0.01f)); 
        assertThat(restored[1]).isCloseTo(1.0f, within(0.01f)); 
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
