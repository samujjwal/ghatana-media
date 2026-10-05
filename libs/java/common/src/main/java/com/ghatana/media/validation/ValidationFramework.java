/**
 * @doc.type class
 * @doc.purpose Unified validation framework for audio-video inputs
 * @doc.layer platform
 * @doc.pattern Validation, ChainOfResponsibility
 */
package com.ghatana.media.validation;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.ValidationError;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;

/**
 * Unified validation framework for audio-video operations.
 *
 * <p>Addresses CONS-010: Provides standardized validation patterns
 * across the audio-video platform with composable validators.</p>
 *
 * @since 2026-03-27
 */
public final class ValidationFramework {

    private ValidationFramework() {} // Utility class

    /**
     * Creates a validator builder.
     */
    public static <T> ValidatorBuilder<T> validator(Class<T> type) {
        return new ValidatorBuilder<>();
    }

    /**
     * Validates audio data for common issues.
     *
     * @param audio the audio data to validate
     * @throws ValidationError if validation fails
     */
    public static void validateAudio(AudioData audio) {
        if (audio == null) {
            throw new ValidationError("Audio data cannot be null");
        }

        if (audio.sampleRate() <= 0) {
            throw new ValidationError("Invalid sample rate: " + audio.sampleRate());
        }

        if (audio.channels() <= 0 || audio.channels() > 32) {
            throw new ValidationError("Invalid channel count: " + audio.channels());
        }

        if (audio.bitsPerSample() != 8 && audio.bitsPerSample() != 16 &&
            audio.bitsPerSample() != 24 && audio.bitsPerSample() != 32) {
            throw new ValidationError("Invalid bits per sample: " + audio.bitsPerSample());
        }

        if (audio.data() == null || audio.data().length == 0) {
            throw new ValidationError("Audio data buffer is empty");
        }

        // Validate buffer size matches expected format
        long expectedSize = (long) audio.getSampleCount() * audio.channels() * (audio.bitsPerSample() / 8);
        if (audio.data().length < expectedSize) {
            throw new ValidationError(
                "Audio buffer size mismatch: expected " + expectedSize + " bytes, got " + audio.data().length);
        }
    }

    /**
     * Validates audio duration is within limits.
     *
     * @param audio the audio data
     * @param maxDurationSeconds maximum allowed duration
     * @throws ValidationError if too long
     */
    public static void validateAudioDuration(AudioData audio, int maxDurationSeconds) {
        validateAudio(audio);

        float durationSeconds = audio.getSampleCount() / (float) audio.sampleRate();
        if (durationSeconds > maxDurationSeconds) {
            throw new ValidationError(
                String.format("Audio duration %.1fs exceeds maximum %ds", durationSeconds, maxDurationSeconds));
        }
    }

    /**
     * Validates text input for TTS operations.
     *
     * @param text the text to validate
     * @throws ValidationError if invalid
     */
    public static void validateText(String text) {
        if (text == null || text.isBlank()) {
            throw new ValidationError("Text cannot be null or empty");
        }

        if (text.length() > 5000) {
            throw new ValidationError("Text too long: " + text.length() + " chars (max 5000)");
        }

        // Check for invalid characters
        if (text.contains("\u0000")) {
            throw new ValidationError("Text contains null characters");
        }
    }

    /**
     * Builder for creating composable validators.
     */
    public static class ValidatorBuilder<T> {
        private final List<ValidationRule<T>> rules = new ArrayList<>();

        /**
         * Adds a validation rule.
         *
         * @param name rule name
         * @param predicate validation predicate
         * @param errorMessage error message if validation fails
         * @return this builder
         */
        public ValidatorBuilder<T> rule(String name, Predicate<T> predicate, String errorMessage) {
            rules.add(new ValidationRule<>(name, predicate, errorMessage));
            return this;
        }

        /**
         * Adds a required field rule.
         *
         * @param name field name
         * @param extractor field extractor
         * @param <R> field type
         * @return this builder
         */
        public <R> ValidatorBuilder<T> required(String name, java.util.function.Function<T, R> extractor) {
            return rule(name + " required",
                obj -> extractor.apply(obj) != null,
                name + " is required");
        }

        /**
         * Adds a range validation rule for numeric fields.
         *
         * @param name field name
         * @param extractor field extractor
         * @param min minimum value
         * @param max maximum value
         * @return this builder
         */
        public ValidatorBuilder<T> range(String name, java.util.function.Function<T, Integer> extractor,
                                          int min, int max) {
            return rule(name + " in range [" + min + "," + max + "]",
                obj -> {
                    Integer value = extractor.apply(obj);
                    return value != null && value >= min && value <= max;
                },
                name + " must be between " + min + " and " + max);
        }

        /**
         * Builds the validator.
         *
         * @return validator function
         */
        public Validator<T> build() {
            return obj -> {
                List<String> errors = new ArrayList<>();
                for (ValidationRule<T> rule : rules) {
                    if (!rule.predicate.test(obj)) {
                        errors.add(rule.errorMessage);
                    }
                }
                if (!errors.isEmpty()) {
                    throw new ValidationError(String.join("; ", errors));
                }
            };
        }
    }

    /**
     * Single validation rule.
     */
    private static class ValidationRule<T> {
        final String name;
        final Predicate<T> predicate;
        final String errorMessage;

        ValidationRule(String name, Predicate<T> predicate, String errorMessage) {
            this.name = name;
            this.predicate = predicate;
            this.errorMessage = errorMessage;
        }
    }

    /**
     * Validator function interface.
     */
    @FunctionalInterface
    public interface Validator<T> {
        void validate(T obj) throws ValidationError;
    }
}
