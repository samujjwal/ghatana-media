package com.ghatana.stt.detection;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;

/**
 * Automatic language detection service for the STT pipeline (AV-007.2).
 *
 * <p>Identifies the spoken language from a short audio or text excerpt using
 * a pluggable {@link LanguageDetectionModel}. Returns a ranked list of
 * candidate languages with confidence scores.
 *
 * <h3>Acceptance criteria (AV-007.2)</h3>
 * <ul>
 *   <li>Automatic language identification from audio/text.</li>
 *   <li>Detection accuracy &gt;95% (validated in quality tests).</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Automatic language detection for audio-video speech-to-text pipeline
 * @doc.layer product
 * @doc.pattern Service
 */
public final class LanguageDetectionService {

    private static final Logger LOG = LoggerFactory.getLogger(LanguageDetectionService.class);

    private final LanguageDetectionModel model;
    private final double confidenceThreshold;

    private LanguageDetectionService(LanguageDetectionModel model, double confidenceThreshold) {
        this.model = model;
        this.confidenceThreshold = confidenceThreshold;
    }

    /**
     * Creates a service with the given model and a default 70% confidence threshold.
     *
     * @param model the language detection model
     * @return a new service
     * @throws NullPointerException if model is null
     */
    public static LanguageDetectionService of(LanguageDetectionModel model) {
        Objects.requireNonNull(model, "model must not be null");
        return new LanguageDetectionService(model, 0.70);
    }

    /**
     * Creates a service with an explicit confidence threshold.
     *
     * @param model               the language detection model
     * @param confidenceThreshold minimum confidence to consider a detection reliable
     * @return a new service
     * @throws NullPointerException     if model is null
     * @throws IllegalArgumentException if threshold is not in [0, 1]
     */
    public static LanguageDetectionService of(LanguageDetectionModel model, double confidenceThreshold) {
        Objects.requireNonNull(model, "model must not be null");
        if (confidenceThreshold < 0 || confidenceThreshold > 1) {
            throw new IllegalArgumentException("confidenceThreshold must be in [0, 1]");
        }
        return new LanguageDetectionService(model, confidenceThreshold);
    }

    // ─── detect ───────────────────────────────────────────────────────────────

    /**
     * Detects the most likely language from a text excerpt.
     *
     * @param textSample a short text excerpt to analyse (at least 10 characters recommended)
     * @return a {@link DetectionResult} containing the ranked candidates
     * @throws NullPointerException     if textSample is null
     * @throws IllegalArgumentException if textSample is blank
     */
    public DetectionResult detect(String textSample) {
        Objects.requireNonNull(textSample, "textSample must not be null");
        if (textSample.isBlank()) {
            throw new IllegalArgumentException("textSample must not be blank");
        }
        List<LanguageCandidate> candidates = model.detect(textSample);
        LOG.debug("Language detection: sample_len={} top={}",
                textSample.length(), candidates.isEmpty() ? "none" : candidates.get(0).languageTag());
        return new DetectionResult(candidates, confidenceThreshold);
    }

    /**
     * Detects the most likely language from raw audio bytes using the underlying model.
     *
     * @param audioBytes raw PCM audio bytes
     * @return a {@link DetectionResult} with ranked candidates
     * @throws NullPointerException     if audioBytes is null
     * @throws IllegalArgumentException if audioBytes is empty
     */
    public DetectionResult detectFromAudio(byte[] audioBytes) {
        Objects.requireNonNull(audioBytes, "audioBytes must not be null");
        if (audioBytes.length == 0) {
            throw new IllegalArgumentException("audioBytes must not be empty");
        }
        List<LanguageCandidate> candidates = model.detectFromAudio(audioBytes);
        LOG.debug("Audio language detection: bytes={} top={}",
                audioBytes.length, candidates.isEmpty() ? "none" : candidates.get(0).languageTag());
        return new DetectionResult(candidates, confidenceThreshold);
    }

    // ─── Domain types ─────────────────────────────────────────────────────────

    /** Pluggable language detection model. */
    public interface LanguageDetectionModel {
        List<LanguageCandidate> detect(String textSample);

        default List<LanguageCandidate> detectFromAudio(byte[] audioBytes) {
            throw new UnsupportedOperationException(
                    "Audio language detection requires a LanguageDetectionModel implementation "
                            + "that supports acoustic language identification.");
        }
    }

    /**
     * A language detection result wrapping ranked candidates.
     *
     * @param candidates ordered list of language candidates (highest confidence first)
     * @param confidenceThreshold the minimum confidence to be considered reliable
     */
    public record DetectionResult(List<LanguageCandidate> candidates, double confidenceThreshold) {
        public DetectionResult {
            Objects.requireNonNull(candidates, "candidates must not be null");
            candidates = Collections.unmodifiableList(candidates);
        }

        /** @return the top-ranked language tag if any candidate exceeds the threshold */
        public Optional<String> topLanguageTag() {
            return candidates.stream()
                    .filter(c -> c.confidence() >= confidenceThreshold)
                    .map(LanguageCandidate::languageTag)
                    .findFirst();
        }

        /** @return the top-ranked candidate regardless of threshold */
        public Optional<LanguageCandidate> topCandidate() {
            return candidates.isEmpty() ? Optional.empty() : Optional.of(candidates.get(0));
        }

        /** @return true if the top candidate meets the confidence threshold */
        public boolean isReliable() {
            return topCandidate()
                    .map(c -> c.confidence() >= confidenceThreshold)
                    .orElse(false);
        }
    }

    /**
     * A language candidate with a confidence score.
     *
     * @param languageTag IETF language tag (e.g. {@code "en"}, {@code "fr-CA"})
     * @param confidence  detection confidence in [0, 1]
     * @param locale      the resolved Java {@link Locale}
     */
    public record LanguageCandidate(String languageTag, double confidence, Locale locale) {
        public LanguageCandidate {
            Objects.requireNonNull(languageTag, "languageTag must not be null");
            if (confidence < 0 || confidence > 1) {
                throw new IllegalArgumentException("confidence must be in [0, 1]");
            }
        }

        /** Factory: creates a candidate from a language tag and confidence. */
        public static LanguageCandidate of(String tag, double confidence) {
            return new LanguageCandidate(tag, confidence, Locale.forLanguageTag(tag));
        }
    }
}
