package com.ghatana.stt.vocabulary;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * Custom vocabulary manager for the STT pipeline (AV-007.3).
 *
 * <p>Maintains a per-profile dictionary of user-defined terms and applies them
 * to transcription post-processing to improve domain-specific recognition accuracy.
 * Terms are case-insensitively deduplicated, normalised to lowercase, and can be
 * boosted with optional weight hints for the underlying model.
 *
 * <h3>Acceptance criteria (AV-007.3)</h3>
 * <ul>
 *   <li>User-defined term recognition.</li>
 *   <li>Custom vocabulary recognition quality tests.</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Custom vocabulary management for domain-specific STT term recognition
 * @doc.layer product
 * @doc.pattern Service
 */
public final class CustomVocabularyManager {

    private static final Logger LOG = LoggerFactory.getLogger(CustomVocabularyManager.class);

    /** Maximum term length in characters. */
    public static final int MAX_TERM_LENGTH = 120;

    /** Maximum number of terms per vocabulary. */
    public static final int MAX_TERMS = 5_000;

    private static final Pattern VALID_TERM_PATTERN = Pattern.compile("^[\\p{L}\\p{N}\\s'\\-]+$");

    private final LinkedHashSet<VocabularyTerm> terms;

    private CustomVocabularyManager(LinkedHashSet<VocabularyTerm> terms) {
        this.terms = terms;
    }

    /**
     * @return an empty vocabulary manager
     */
    public static CustomVocabularyManager empty() {
        return new CustomVocabularyManager(new LinkedHashSet<>());
    }

    /**
     * Creates a manager pre-populated with the given term strings (default weight = 1.0).
     *
     * @param termStrings raw term strings
     * @return a new manager
     * @throws NullPointerException if termStrings is null
     */
    public static CustomVocabularyManager of(List<String> termStrings) {
        Objects.requireNonNull(termStrings, "termStrings must not be null");
        CustomVocabularyManager mgr = empty();
        for (String term : termStrings) {
            mgr.addTerm(term, 1.0);
        }
        return mgr;
    }

    // ─── mutating API ─────────────────────────────────────────────────────────

    /**
     * Adds a vocabulary term with default weight 1.0.
     *
     * @param term the raw term string
     * @throws NullPointerException     if term is null
     * @throws IllegalArgumentException if term is blank, too long, or contains invalid characters
     * @throws IllegalStateException    if the vocabulary is full
     */
    public void addTerm(String term) {
        addTerm(term, 1.0);
    }

    /**
     * Adds a vocabulary term with an explicit weight hint.
     *
     * <p>Weight hints guide the underlying model's decoder: higher weights increase
     * the probability of recognising the term.
     *
     * @param term   the raw term string
     * @param weight boost weight in [0.1, 10.0]
     * @throws NullPointerException     if term is null
     * @throws IllegalArgumentException if term is invalid or weight is out of range
     * @throws IllegalStateException    if the vocabulary is full
     */
    public void addTerm(String term, double weight) {
        Objects.requireNonNull(term, "term must not be null");
        String normalised = term.trim().toLowerCase(Locale.ROOT);

        if (normalised.isBlank()) {
            throw new IllegalArgumentException("term must not be blank after normalisation");
        }
        if (normalised.length() > MAX_TERM_LENGTH) {
            throw new IllegalArgumentException(
                    "term exceeds maximum length of " + MAX_TERM_LENGTH + " characters");
        }
        if (!VALID_TERM_PATTERN.matcher(normalised).matches()) {
            throw new IllegalArgumentException(
                    "term contains invalid characters: '" + normalised + "'");
        }
        if (weight < 0.1 || weight > 10.0) {
            throw new IllegalArgumentException("weight must be in [0.1, 10.0]: " + weight);
        }
        if (terms.size() >= MAX_TERMS) {
            throw new IllegalStateException("Vocabulary is full (" + MAX_TERMS + " terms)");
        }

        // Remove old entry if exists (to update weight)
        terms.removeIf(t -> t.normalised().equals(normalised));
        terms.add(new VocabularyTerm(term, normalised, weight));
        LOG.debug("Vocabulary term added: '{}' weight={}", normalised, weight);
    }

    /**
     * Removes a term from the vocabulary.
     *
     * @param term the raw term string (matched case-insensitively)
     * @return true if the term was present and removed
     * @throws NullPointerException if term is null
     */
    public boolean removeTerm(String term) {
        Objects.requireNonNull(term, "term must not be null");
        String normalised = term.trim().toLowerCase(Locale.ROOT);
        boolean removed = terms.removeIf(t -> t.normalised().equals(normalised));
        if (removed) LOG.debug("Vocabulary term removed: '{}'", normalised);
        return removed;
    }

    /**
     * Applies the vocabulary to a transcript by highlighting recognised terms.
     *
     * <p>This method searches the transcript for each vocabulary term and returns a copy
     * of the transcript with the terms preserved. In a production model integration this
     * would inject the vocabulary into the decoder; here it validates presence.
     *
     * @param transcript the raw transcription text
     * @return the transcript with vocabulary terms applied (unchanged text — model handles boost)
     * @throws NullPointerException if transcript is null
     */
    public String apply(String transcript) {
        Objects.requireNonNull(transcript, "transcript must not be null");
        String lower = transcript.toLowerCase(Locale.ROOT);
        long matched = terms.stream()
                .filter(t -> lower.contains(t.normalised()))
                .count();
        LOG.debug("Vocabulary apply: matched {} of {} terms in transcript",
                matched, terms.size());
        return transcript; // text unchanged; model decoder uses term hints
    }

    // ─── query API ────────────────────────────────────────────────────────────

    /**
     * @return an unmodifiable snapshot of all registered vocabulary terms
     */
    public List<VocabularyTerm> terms() {
        return Collections.unmodifiableList(new ArrayList<>(terms));
    }

    /**
     * @return the number of registered terms
     */
    public int size() {
        return terms.size();
    }

    /**
     * @return true if the vocabulary contains no terms
     */
    public boolean isEmpty() {
        return terms.isEmpty();
    }

    /**
     * Checks whether a term is present in the vocabulary (case-insensitive).
     *
     * @param term the term to check
     * @return true if found
     * @throws NullPointerException if term is null
     */
    public boolean contains(String term) {
        Objects.requireNonNull(term, "term must not be null");
        String normalised = term.trim().toLowerCase(Locale.ROOT);
        return terms.stream().anyMatch(t -> t.normalised().equals(normalised));
    }

    /**
     * Exports the vocabulary as a list of term strings (without weight info).
     *
     * @return a flat list of normalised term strings
     */
    public List<String> exportTermStrings() {
        return terms.stream().map(VocabularyTerm::normalised).toList();
    }

    // ─── VocabularyTerm ───────────────────────────────────────────────────────

    /**
     * A normalised, weighted vocabulary term.
     *
     * @param original   the original (un-normalised) term as supplied by the user
     * @param normalised the lowercase, trimmed form used for deduplication
     * @param weight     decoder boost weight in [0.1, 10.0]
     */
    public record VocabularyTerm(String original, String normalised, double weight) {}
}
