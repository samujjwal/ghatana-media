package com.ghatana.stt.functional;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.OptionalDouble;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

@DisplayName("STT quality evaluation harness")
class SttQualityEvaluationHarnessTest {

    @Test
    @DisplayName("scenario manifest includes Devanagari, silence, noise, overlap and segmentation without claiming audio corpus")
    void scenarioManifestIsExplicitAndUnqualified() {
        var fixtures = SttQualityEvaluationHarness.fixtures();

        assertThat(fixtures).extracting(SttQualityEvaluationHarness.FixtureDescriptor::id)
                .containsExactly("ne-devanagari-speech", "silence-16khz-mono", "seeded-noise-16khz-mono",
                        "accent-overlap-speech", "speech-segmentation-boundaries",
                        "punctuation-and-capitalization", "unsupported-language-abstention",
                        "fairness-stratified-speech");
        assertThat(fixtures.getFirst().languageTag()).isEqualTo("ne-NP");
        assertThat(fixtures.getFirst().referenceText()).isEqualTo("नमस्ते संसार");
        assertThat(fixtures).allMatch(fixture -> !fixture.licensedSpeechAudioAvailable());
    }

    @Test
    @DisplayName("generated silence is deterministic input only, not model output")
    void silenceFixtureHasBoundedZeroSamples() {
        var fixture = SttQualityEvaluationHarness.silenceFixture(16_000, 20);
        byte[] pcm = fixture.pcmS16Le();

        assertThat(fixture.sampleRateHz()).isEqualTo(16_000);
        assertThat(fixture.channels()).isEqualTo(1);
        assertThat(pcm).hasSize(640);
        assertThat(pcm).containsOnly((byte) 0);
    }

    @Test
    @DisplayName("seeded noise fixture is reproducible and bounded")
    void seededNoiseIsReproducible() {
        byte[] first = SttQualityEvaluationHarness.seededNoiseFixture(16_000, 20, 431L).pcmS16Le();
        byte[] replay = SttQualityEvaluationHarness.seededNoiseFixture(16_000, 20, 431L).pcmS16Le();
        byte[] otherSeed = SttQualityEvaluationHarness.seededNoiseFixture(16_000, 20, 432L).pcmS16Le();

        assertThat(first).hasSize(640).isNotEqualTo(new byte[640]);
        assertThat(Arrays.equals(first, replay)).isTrue();
        assertThat(Arrays.equals(first, otherSeed)).isFalse();
    }

    @Test
    @DisplayName("WER and Unicode CER calculators return edit counts only, not quality acceptance")
    void errorMetricArithmeticIsExplicit() {
        var wer = SttQualityEvaluationHarness.wordErrors("hello world", "hello there");
        var cer = SttQualityEvaluationHarness.characterErrors("नमस्ते संसार", "नमस्ते ससार");

        assertThat(wer.errors()).isEqualTo(1);
        assertThat(wer.referenceUnits()).isEqualTo(2);
        assertThat(wer.rate().isPresent()).isTrue();
        assertThat(wer.rate().getAsDouble()).isEqualTo(0.5);
        assertThat(cer.errors()).isEqualTo(1);
        assertThat(cer.referenceUnits()).isEqualTo("नमस्ते संसार".codePointCount(0, "नमस्ते संसार".length()));
        assertThat(cer.rate()).isPresent();
    }

    @Test
    @DisplayName("empty speech reference leaves WER and CER undefined")
    void emptyReferenceDoesNotBecomeZeroErrorRate() {
        OptionalDouble wer = SttQualityEvaluationHarness.wordErrors("", "false alarm").rate();
        OptionalDouble cer = SttQualityEvaluationHarness.characterErrors("", "false alarm").rate();

        assertThat(wer).isEmpty();
        assertThat(cer).isEmpty();
    }

    @Test
    @DisplayName("current report stays NOT_VERIFIED without admitted provider, hardware and licensed speech corpus")
    void currentReportDoesNotPublishSyntheticScores() {
        var report = SttQualityEvaluationHarness.currentReport();

        assertThat(report.status()).isEqualTo(SttQualityEvaluationHarness.QualityStatus.NOT_VERIFIED);
        assertThat(report.measuredSpeechSamples()).isZero();
        assertThat(report.requiredFixtureIds()).contains(
                "punctuation-and-capitalization",
                "unsupported-language-abstention",
                "fairness-stratified-speech");
        assertThat(report.wer()).isEmpty();
        assertThat(report.cer()).isEmpty();
        assertThat(report.der()).isEmpty();
        assertThat(report.unmetEvidence()).contains(
                "ADMITTED_STT_PROVIDER_NOT_WIRED",
                "MODEL_VERSION_AND_HARDWARE_RUN_NOT_AVAILABLE",
                "LICENSED_SPEECH_CORPUS_AND_AUDIO_FIXTURES_NOT_AVAILABLE",
                "PROVIDER_HYPOTHESES_AND_ALIGNMENT_OUTPUTS_NOT_AVAILABLE",
                "PUNCTUATION_GOLD_REFERENCES_NOT_AVAILABLE",
                "UNSUPPORTED_LANGUAGE_CASES_NOT_AVAILABLE",
                "FAIRNESS_STRATIFIED_LICENSED_CORPUS_NOT_AVAILABLE");
        assertThat(SttQualityEvaluationHarness.fixtures())
                .filteredOn(fixture -> fixture.id().equals("punctuation-and-capitalization")
                        || fixture.id().equals("unsupported-language-abstention")
                        || fixture.id().equals("fairness-stratified-speech"))
                .allMatch(fixture -> !fixture.licensedSpeechAudioAvailable());
    }

    @Test
    @DisplayName("fixture signal limits reject oversized generated samples")
    void signalFixtureLimitsAreBounded() {
        assertThatIllegalArgumentException()
                .isThrownBy(() -> SttQualityEvaluationHarness.seededNoiseFixture(48_001, 20, 1L));
        assertThatIllegalArgumentException()
                .isThrownBy(() -> SttQualityEvaluationHarness.silenceFixture(16_000, 60_001));
    }
}
