package com.ghatana.media.tts.api;

import java.util.List;

/**
 * TTS profile settings.
 *
 * @doc.type record
 * @doc.purpose Default TTS profile synthesis settings
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record ProfileSettings(
    double defaultSpeed,
    double defaultPitch,
    double defaultVolume,
    Emotion defaultEmotion,
    List<String> customPronunciations
) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private double defaultSpeed = 1.0;
        private double defaultPitch = 1.0;
        private double defaultVolume = 1.0;
        private Emotion defaultEmotion = Emotion.NEUTRAL;
        private List<String> customPronunciations = List.of();

        public Builder defaultSpeed(double value) { this.defaultSpeed = value; return this; }
        public Builder defaultPitch(double value) { this.defaultPitch = value; return this; }
        public Builder defaultVolume(double value) { this.defaultVolume = value; return this; }
        public Builder defaultEmotion(Emotion value) { this.defaultEmotion = value; return this; }
        public Builder customPronunciations(List<String> value) { this.customPronunciations = value; return this; }

        public ProfileSettings build() {
            return new ProfileSettings(defaultSpeed, defaultPitch, defaultVolume, defaultEmotion, customPronunciations);
        }
    }
}
