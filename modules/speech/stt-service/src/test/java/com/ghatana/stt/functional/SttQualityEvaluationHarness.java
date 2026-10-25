package com.ghatana.stt.functional;

import java.text.Normalizer;
import java.util.List;
import java.util.Locale;
import java.util.OptionalDouble;
import java.util.Random;

/**
 * Test-only STT quality evaluation scaffolding. It contains no ASR implementation and never
 * treats generated silence/noise, text examples, or injected predictions as model evidence.
 */
final class SttQualityEvaluationHarness {
    enum QualityStatus { NOT_VERIFIED }

    enum Scenario {
        DEVANAGARI_LANGUAGE,
        SILENCE,
        SEEDED_NOISE,
        ACCENT_AND_OVERLAP,
        SEGMENTATION_BOUNDARY,
        PUNCTUATION,
        UNSUPPORTED_LANGUAGE,
        FAIRNESS
    }

    record FixtureDescriptor(String id, Scenario scenario, String languageTag, String referenceText,
            boolean licensedSpeechAudioAvailable) {}

    record MetricCounts(long errors, long referenceUnits) {
        MetricCounts {
            if (errors < 0 || referenceUnits < 0) throw new IllegalArgumentException("metric counts must be nonnegative");
        }

        OptionalDouble rate() {
            return referenceUnits == 0 ? OptionalDouble.empty()
                    : OptionalDouble.of((double) errors / referenceUnits);
        }
    }

    record EvaluationReport(
            QualityStatus status,
            int measuredSpeechSamples,
            OptionalDouble wer,
            OptionalDouble cer,
            OptionalDouble der,
            List<String> requiredFixtureIds,
            List<String> unmetEvidence) {
        EvaluationReport {
            requiredFixtureIds = List.copyOf(requiredFixtureIds);
            unmetEvidence = List.copyOf(unmetEvidence);
        }
    }

    record SignalFixture(String id, int sampleRateHz, int channels, byte[] pcmS16Le) {
        SignalFixture {
            pcmS16Le = pcmS16Le.clone();
        }

        @Override public byte[] pcmS16Le() { return pcmS16Le.clone(); }
    }

    private static final List<FixtureDescriptor> FIXTURES = List.of(
            new FixtureDescriptor("ne-devanagari-speech", Scenario.DEVANAGARI_LANGUAGE,
                    "ne-NP", "नमस्ते संसार", false),
            new FixtureDescriptor("silence-16khz-mono", Scenario.SILENCE, "", "", false),
            new FixtureDescriptor("seeded-noise-16khz-mono", Scenario.SEEDED_NOISE, "", "", false),
            new FixtureDescriptor("accent-overlap-speech", Scenario.ACCENT_AND_OVERLAP,
                    "", "", false),
            new FixtureDescriptor("speech-segmentation-boundaries", Scenario.SEGMENTATION_BOUNDARY,
                    "", "", false),
            new FixtureDescriptor("punctuation-and-capitalization", Scenario.PUNCTUATION,
                    "", "", false),
            new FixtureDescriptor("unsupported-language-abstention", Scenario.UNSUPPORTED_LANGUAGE,
                    "", "", false),
            new FixtureDescriptor("fairness-stratified-speech", Scenario.FAIRNESS,
                    "", "", false));

    private SttQualityEvaluationHarness() {}

    static List<FixtureDescriptor> fixtures() {
        return FIXTURES;
    }

    static SignalFixture silenceFixture(int sampleRateHz, int durationMs) {
        int sampleCount = sampleCount(sampleRateHz, durationMs);
        return new SignalFixture("generated-silence", sampleRateHz, 1, new byte[sampleCount * 2]);
    }

    static SignalFixture seededNoiseFixture(int sampleRateHz, int durationMs, long seed) {
        int sampleCount = sampleCount(sampleRateHz, durationMs);
        Random random = new Random(seed);
        byte[] pcm = new byte[sampleCount * 2];
        for (int sample = 0; sample < sampleCount; sample++) {
            short value = (short) random.nextInt(Short.MIN_VALUE, Short.MAX_VALUE + 1);
            pcm[sample * 2] = (byte) value;
            pcm[sample * 2 + 1] = (byte) (value >>> 8);
        }
        return new SignalFixture("generated-noise-seed-" + seed, sampleRateHz, 1, pcm);
    }

    /**
     * Reports the currently available evidence. No provider, licensed speech corpus, or model
     * hardware run is wired into this module, so scores remain absent rather than synthetic zeroes.
     */
    static EvaluationReport currentReport() {
        return new EvaluationReport(
                QualityStatus.NOT_VERIFIED,
                0,
                OptionalDouble.empty(),
                OptionalDouble.empty(),
                OptionalDouble.empty(),
                FIXTURES.stream().map(FixtureDescriptor::id).toList(),
                List.of(
                        "ADMITTED_STT_PROVIDER_NOT_WIRED",
                        "MODEL_VERSION_AND_HARDWARE_RUN_NOT_AVAILABLE",
                        "LICENSED_SPEECH_CORPUS_AND_AUDIO_FIXTURES_NOT_AVAILABLE",
                        "PROVIDER_HYPOTHESES_AND_ALIGNMENT_OUTPUTS_NOT_AVAILABLE",
                        "PUNCTUATION_GOLD_REFERENCES_NOT_AVAILABLE",
                        "UNSUPPORTED_LANGUAGE_CASES_NOT_AVAILABLE",
                        "FAIRNESS_STRATIFIED_LICENSED_CORPUS_NOT_AVAILABLE"));
    }

    /** WER arithmetic over exact NFC-normalized whitespace tokens; corpus normalization is caller-owned. */
    static MetricCounts wordErrors(String reference, String hypothesis) {
        return editCounts(tokens(reference), tokens(hypothesis));
    }

    /** CER arithmetic over NFC-normalized Unicode code points, including combining sequences as normalized. */
    static MetricCounts characterErrors(String reference, String hypothesis) {
        return editCounts(codePoints(reference), codePoints(hypothesis));
    }

    private static int sampleCount(int sampleRateHz, int durationMs) {
        if (sampleRateHz < 8_000 || sampleRateHz > 48_000 || durationMs < 1 || durationMs > 60_000) {
            throw new IllegalArgumentException("fixture sample rate or duration is outside bounded test limits");
        }
        return Math.toIntExact((long) sampleRateHz * durationMs / 1_000);
    }

    private static List<String> tokens(String text) {
        String normalized = Normalizer.normalize(java.util.Objects.requireNonNull(text), Normalizer.Form.NFC)
                .toLowerCase(Locale.ROOT).strip();
        return normalized.isEmpty() ? List.of() : List.of(normalized.split("\\s+"));
    }

    private static List<Integer> codePoints(String text) {
        return Normalizer.normalize(java.util.Objects.requireNonNull(text), Normalizer.Form.NFC)
                .codePoints().boxed().toList();
    }

    private static <T> MetricCounts editCounts(List<T> reference, List<T> hypothesis) {
        int[] previous = new int[hypothesis.size() + 1];
        for (int j = 0; j <= hypothesis.size(); j++) previous[j] = j;
        for (int i = 1; i <= reference.size(); i++) {
            int[] current = new int[hypothesis.size() + 1];
            current[0] = i;
            for (int j = 1; j <= hypothesis.size(); j++) {
                int substitution = previous[j - 1] + (reference.get(i - 1).equals(hypothesis.get(j - 1)) ? 0 : 1);
                current[j] = Math.min(Math.min(previous[j] + 1, current[j - 1] + 1), substitution);
            }
            previous = current;
        }
        return new MetricCounts(previous[hypothesis.size()], reference.size());
    }
}
