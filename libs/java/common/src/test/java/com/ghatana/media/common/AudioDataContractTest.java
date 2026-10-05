package com.ghatana.media.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

@DisplayName("AudioData contract")
class AudioDataContractTest {

    @Test
    @DisplayName("computes duration when omitted")
    void computesDurationWhenOmitted() { 
        AudioData audio = AudioData.builder() 
            .data(new byte[32_000]) 
            .sampleRate(16_000) 
            .channels(1) 
            .bitsPerSample(16) 
            .format(AudioFormat.PCM) 
            .build(); 

        assertEquals(Duration.ofSeconds(1), audio.duration()); 
        assertEquals(16_000, audio.getSampleCount()); 
    }

    @Test
    @DisplayName("defensively copies byte content")
    void defensivelyCopiesByteContent() { 
        byte[] raw = new byte[] {1, 2, 3, 4};
        AudioData audio = new AudioData(raw, 16_000, 1, 16); 

        raw[0] = 9;
        byte[] roundTrip = audio.data(); 
        roundTrip[1] = 8;

        assertArrayEquals(new byte[] {1, 2, 3, 4}, audio.data()); 
    }

    @Test
    @DisplayName("exposes canonical format descriptor")
    void exposesCanonicalFormatDescriptor() { 
        AudioData audio = new AudioData(new byte[8_000], 8_000, 1, 16, Duration.ofSeconds(1), AudioFormat.WAV); 

        CanonicalAudioFormat canonical = audio.canonicalFormat(); 

        assertNotNull(canonical); 
        assertEquals(8_000, canonical.sampleRate()); 
        assertEquals(AudioFormat.WAV, canonical.format()); 
    }
}
