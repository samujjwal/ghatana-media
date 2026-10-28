package com.ghatana.stt.detection;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.IllformedLocaleException;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;

/**
 * Automatic language detection service for the STT pipeline (AV-007.2).
 *
 * <p>Delegates language identification for a short audio or text excerpt to a
 * pluggable {@link LanguageDetectionModel}. This class validates and exposes
 * the model's ranked candidates; it does not contain a classifier or qualify
 * model accuracy. An empty candidate list is an abstention (for example, an
 * unsupported language or an input without usable speech).
 *
 * <p>Language coverage, confidence calibration, and accuracy require a
 * separately admitted model and representative quality corpus; unit tests of
 * this adapter do not establish them.
 *
 * @doc.type class
 * @doc.purpose Automatic language detection for audio-video speech-to-text pipeline
 * @doc.layer product
 * @doc.pattern Service
 */
public final class LanguageDetectionService {

    private static final Logger LOG = LoggerFactory.getLogger(LanguageDetectionService.class);
    static final int MAX_CANDIDATES = 16;

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
        requireConfidence(confidenceThreshold, "confidenceThreshold");
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
        DetectionResult result = resultFromModel(model.detect(textSample));
        LOG.debug("Language detection: sample_len={} top={}",
                textSample.length(), result.candidates().isEmpty()
                        ? "none" : result.candidates().get(0).languageTag());
        return result;
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
        DetectionResult result = resultFromModel(model.detectFromAudio(audioBytes));
        LOG.debug("Audio language detection: bytes={} top={}",
                audioBytes.length, result.candidates().isEmpty()
                        ? "none" : result.candidates().get(0).languageTag());
        return result;
    }

    private DetectionResult resultFromModel(List<LanguageCandidate> candidates) {
        if (candidates == null) {
            throw new IllegalArgumentException(
                    "STT_LANGUAGE_CANDIDATE_INVALID: model returned a null candidate list");
        }
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
            requireConfidence(confidenceThreshold, "confidenceThreshold");
            // Reject an oversized provider declaration before allocating a copy. The bounded
            // iterator copy also protects against a collection whose reported size is stale or
            // understated, while ensuring validation and the immutable result use one snapshot.
            if (candidates.size() > MAX_CANDIDATES) {
                throw new IllegalArgumentException(
                        "STT_LANGUAGE_CANDIDATE_LIMIT: candidates cannot exceed " + MAX_CANDIDATES);
            }
            List<LanguageCandidate> snapshot = new ArrayList<>(Math.min(candidates.size(), MAX_CANDIDATES));
            Iterator<LanguageCandidate> iterator = candidates.iterator();
            while (iterator.hasNext()) {
                if (snapshot.size() == MAX_CANDIDATES) {
                    throw new IllegalArgumentException(
                            "STT_LANGUAGE_CANDIDATE_LIMIT: candidates cannot exceed " + MAX_CANDIDATES);
                }
                snapshot.add(iterator.next());
            }
            if (snapshot.stream().anyMatch(Objects::isNull)) {
                throw new IllegalArgumentException("STT_LANGUAGE_CANDIDATE_INVALID: candidates cannot contain null");
            }
            for (int index = 1; index < snapshot.size(); index++) {
                if (snapshot.get(index - 1).confidence() < snapshot.get(index).confidence()) {
                    throw new IllegalArgumentException(
                            "STT_LANGUAGE_CANDIDATE_ORDER_INVALID: candidates must be ordered by "
                                    + "confidence descending");
                }
            }
            // The validated snapshot keeps the result stable after this boundary and callers
            // cannot mutate its candidate ordering or contents.
            candidates = List.copyOf(snapshot);
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
            requireConfidence(confidence, "confidence");
            Objects.requireNonNull(locale, "locale must not be null");
            Locale parsedLocale = parseLanguageTag(languageTag);
            if (!parsedLocale.equals(locale)) {
                throw new IllegalArgumentException(
                        "STT_LANGUAGE_LOCALE_MISMATCH: locale must match languageTag");
            }
        }

        /** Factory: creates a candidate from a language tag and confidence. */
        public static LanguageCandidate of(String tag, double confidence) {
            return new LanguageCandidate(tag, confidence, Locale.forLanguageTag(tag));
        }

        private static Locale parseLanguageTag(String languageTag) {
            if (languageTag == null || languageTag.isBlank()) {
                throw new IllegalArgumentException(
                        "STT_LANGUAGE_TAG_INVALID: languageTag must be a valid IETF language tag");
            }
            try {
                return new Locale.Builder().setLanguageTag(languageTag).build();
            } catch (IllformedLocaleException exception) {
                throw new IllegalArgumentException(
                        "STT_LANGUAGE_TAG_INVALID: languageTag must be a valid IETF language tag", exception);
            }
        }
    }

    private static void requireConfidence(double value, String name) {
        if (!Double.isFinite(value) || value < 0.0d || value > 1.0d) {
            throw new IllegalArgumentException(name + " must be finite and in [0, 1]");
        }
    }
}
