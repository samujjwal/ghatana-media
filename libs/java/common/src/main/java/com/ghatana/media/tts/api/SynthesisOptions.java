package com.ghatana.media.tts.api;

import com.ghatana.media.common.AudioFormat;

import java.time.Duration;
import java.util.Locale;

/**
 * Synthesis options.
 *
 * @doc.type record
 * @doc.purpose Immutable TTS synthesis options
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record SynthesisOptions(
    String voiceId,
    double speed,
    double pitch,
    double volume,
    Locale language,
    AudioFormat outputFormat,
    int sampleRate,
    Emotion emotion,
    Duration timeout
) {
    public static SynthesisOptions defaults() {
        return new SynthesisOptions(null, 1.0, 1.0, 1.0, null, AudioFormat.WAV, 22050, Emotion.NEUTRAL, Duration.ofSeconds(30));
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String voiceId;
        private double speed = 1.0;
        private double pitch = 1.0;
        private double volume = 1.0;
        private Locale language;
        private AudioFormat outputFormat = AudioFormat.WAV;
        private int sampleRate = 22050;
        private Emotion emotion = Emotion.NEUTRAL;
        private Duration timeout = Duration.ofSeconds(30);

        public Builder voiceId(String value) { this.voiceId = value; return this; }
        public Builder speed(double value) { this.speed = Math.max(0.5, Math.min(2.0, value)); return this; }
        public Builder pitch(double value) { this.pitch = Math.max(0.5, Math.min(2.0, value)); return this; }
        public Builder volume(double value) { this.volume = Math.max(0.0, Math.min(2.0, value)); return this; }
        public Builder language(Locale value) { this.language = value; return this; }
        public Builder outputFormat(AudioFormat value) { this.outputFormat = value; return this; }
        public Builder sampleRate(int value) { this.sampleRate = value; return this; }
        public Builder emotion(Emotion value) { this.emotion = value; return this; }
        public Builder timeout(Duration value) { this.timeout = value; return this; }

        public SynthesisOptions build() {
            return new SynthesisOptions(voiceId, speed, pitch, volume, language, outputFormat, sampleRate, emotion, timeout);
        }
    }
}
