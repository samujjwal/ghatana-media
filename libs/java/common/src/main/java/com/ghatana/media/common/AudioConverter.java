package com.ghatana.media.common;

import java.time.Duration;
import java.util.Objects;

/**
 * Shared audio conversion utilities for PCM byte buffers and normalised float samples.
 *
 * @doc.type class
 * @doc.purpose Convert canonical AudioData PCM payloads to and from float samples
 * @doc.layer platform
 * @doc.pattern Utility
 */
public final class AudioConverter {

    private AudioConverter() {}

    /** Convert signed PCM bytes into normalised float samples in the range [-1, 1]. */
    public static float[] pcmToFloatSamples(byte[] data, int bitsPerSample) {
        Objects.requireNonNull(data, "data cannot be null");
        if (bitsPerSample <= 0 || bitsPerSample % 8 != 0) {
            throw new IllegalArgumentException("bitsPerSample must be a positive multiple of 8");
        }

        int bytesPerSample = bitsPerSample / 8;
        int numSamples = data.length / bytesPerSample;
        float[] floats = new float[numSamples];
        float maxAmplitude = (float) (1 << (bitsPerSample - 1));

        for (int sampleIndex = 0; sampleIndex < numSamples; sampleIndex++) {
            int sample = 0;
            int baseOffset = sampleIndex * bytesPerSample;
            for (int byteIndex = 0; byteIndex < bytesPerSample; byteIndex++) {
                sample |= (data[baseOffset + byteIndex] & 0xFF) << (byteIndex * 8);
            }
            int shift = Integer.SIZE - bitsPerSample;
            sample = (sample << shift) >> shift;
            floats[sampleIndex] = Math.max(-1.0f, Math.min(1.0f, sample / maxAmplitude));
        }

        return floats;
    }

    /** Convert normalised float samples into 16-bit PCM bytes. */
    public static byte[] floatSamplesToPcm16(float[] samples) {
        Objects.requireNonNull(samples, "samples cannot be null");
        byte[] bytes = new byte[samples.length * 2];
        for (int index = 0; index < samples.length; index++) {
            int sample = Math.round(Math.max(-1.0f, Math.min(1.0f, samples[index])) * 32767.0f);
            sample = Math.max(-32768, Math.min(32767, sample));
            bytes[index * 2] = (byte) (sample & 0xFF);
            bytes[index * 2 + 1] = (byte) ((sample >> 8) & 0xFF);
        }
        return bytes;
    }

    /** Create canonical AudioData from normalised float samples. */
    public static AudioData fromFloatSamples(float[] samples, int sampleRate, int channels) {
        if (sampleRate <= 0) {
            throw new IllegalArgumentException("sampleRate must be positive");
        }
        if (channels <= 0) {
            throw new IllegalArgumentException("channels must be positive");
        }

        long frameCount = samples.length / channels;
        long durationNanos = Math.round((frameCount * 1_000_000_000d) / sampleRate);
        return AudioData.builder()
            .data(floatSamplesToPcm16(samples))
            .sampleRate(sampleRate)
            .channels(channels)
            .bitsPerSample(16)
            .duration(Duration.ofNanos(Math.max(0L, durationNanos)))
            .format(AudioFormat.PCM)
            .build();
    }
}
