package com.ghatana.media.tts.engine.onnx;

import com.ghatana.media.common.InferenceError;
import com.ghatana.media.common.ModelLoadingError;
import com.ghatana.media.tts.phoneme.HeuristicPhonemeConverter;
import com.ghatana.media.tts.phoneme.TextToPhonemeConverter;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PiperOnnxEnginePhonemeMapTest {
    @TempDir Path tempDir;

    @Test
    void readsAdjacentVoiceSidecarAndUsesModelIdsIncludingBoundaryTokens() throws Exception {
        Path model = tempDir.resolve("voice.onnx");
        Files.writeString(PiperOnnxEngine.sidecarPath(model), """
            {"phoneme_id_map":{"^": [1], "$": [2], "_": [3], "a": [91, 92], "ɪ": [812]}}
            """);
        Map<String, java.util.List<Long>> map = PiperOnnxEngine.loadPhonemeIdMap(model);
        assertThat(PiperOnnxEngine.encodePhonemes("aɪ", map)).containsExactly(1, 3, 91, 92, 3, 812, 3, 2);
    }

    @Test
    void missingSidecarFailsModelLoad() {
        assertThatThrownBy(() -> PiperOnnxEngine.loadPhonemeIdMap(tempDir.resolve("missing.onnx")))
            .isInstanceOf(ModelLoadingError.class).hasMessageContaining("sidecar is missing");
    }

    @Test
    void readsSampleRateFromTheVoiceSidecar() throws Exception {
        Path model = tempDir.resolve("sample-rate.onnx");
        Files.writeString(PiperOnnxEngine.sidecarPath(model), """
                {"audio":{"sample_rate":22050}}
                """);

        assertThat(PiperOnnxEngine.loadVoiceSampleRate(model)).isEqualTo(22_050);
    }

    @Test
    void rejectsMissingMalformedOrOutOfRangeVoiceSampleRate() throws Exception {
        Path model = tempDir.resolve("bad-sample-rate.onnx");
        Path sidecar = PiperOnnxEngine.sidecarPath(model);
        Files.writeString(sidecar, "{}");
        assertThatThrownBy(() -> PiperOnnxEngine.loadVoiceSampleRate(model))
                .isInstanceOf(ModelLoadingError.class).hasMessageContaining("sample rate");
        Files.writeString(sidecar, "{\"audio\":{\"sample_rate\":7999}}");
        assertThatThrownBy(() -> PiperOnnxEngine.loadVoiceSampleRate(model))
                .isInstanceOf(ModelLoadingError.class);
        Files.writeString(sidecar, "{\"audio\":{\"sample_rate\":\"22050\"}}");
        assertThatThrownBy(() -> PiperOnnxEngine.loadVoiceSampleRate(model))
                .isInstanceOf(ModelLoadingError.class);
    }

    @Test
    void refusesToLabelUnresampledVoiceAudioAtARequestedRate() {
        PiperOnnxEngine.validateRequestedSampleRate(22_050, 22_050);
        PiperOnnxEngine.validateRequestedSampleRate(0, 22_050);
        assertThatThrownBy(() -> PiperOnnxEngine.validateRequestedSampleRate(16_000, 22_050))
                .isInstanceOf(com.ghatana.media.common.ValidationError.class)
                .hasMessageContaining("cannot resample");
    }

    @Test
    void productionPhonemizerMustBeNonHeuristicAndCompatibleWithVoiceSymbols() {
        Map<String, java.util.List<Long>> map = Map.of(
                "^", java.util.List.of(1L), "$", java.util.List.of(2L), "_", java.util.List.of(3L));
        assertThat(PiperOnnxEngine.supportsProductionVoicePhonemizer(
                new HeuristicPhonemeConverter(), map, Locale.ENGLISH)).isFalse();

        TextToPhonemeConverter mapped = new TextToPhonemeConverter() {
            @Override
            public String convert(String text, Locale locale) { return "ab"; }

            @Override
            public int qualityTier() { return 10; }
        };
        assertThat(PiperOnnxEngine.supportsProductionVoicePhonemizer(mapped, map, Locale.ENGLISH)).isFalse();

        Map<String, java.util.List<Long>> compatibleMap = Map.of(
                "^", java.util.List.of(1L), "$", java.util.List.of(2L), "_", java.util.List.of(3L),
                "a", java.util.List.of(4L), "b", java.util.List.of(5L));
        assertThat(PiperOnnxEngine.supportsProductionVoicePhonemizer(
                mapped, compatibleMap, Locale.ENGLISH)).isTrue();
    }

    @Test
    void malformedOrIncompleteSidecarFailsModelLoad() throws Exception {
        Path model = tempDir.resolve("bad.onnx");
        Files.writeString(PiperOnnxEngine.sidecarPath(model), "{\"phoneme_id_map\": [1,2]}");
        assertThatThrownBy(() -> PiperOnnxEngine.loadPhonemeIdMap(model)).isInstanceOf(ModelLoadingError.class);
        Files.writeString(PiperOnnxEngine.sidecarPath(model), "{\"phoneme_id_map\": {\"^\":[1],\"$\":[2],\"a\":[-1]}}");
        assertThatThrownBy(() -> PiperOnnxEngine.loadPhonemeIdMap(model)).isInstanceOf(ModelLoadingError.class);
        Files.writeString(PiperOnnxEngine.sidecarPath(model), "{\"phoneme_id_map\": {\"^\":[1],\"$\":[2],\"_\":[0],\"ab\":[3]}}");
        assertThatThrownBy(() -> PiperOnnxEngine.loadPhonemeIdMap(model)).isInstanceOf(ModelLoadingError.class);
    }

    @Test
    void undefinedVoiceSymbolFailsInferenceInsteadOfInventingCodePointId() {
        assertThatThrownBy(() -> PiperOnnxEngine.encodePhonemes("z", Map.of(
            "^", java.util.List.of(1L), "$", java.util.List.of(2L), "_", java.util.List.of(0L))))
            .isInstanceOf(InferenceError.class).hasMessageContaining("does not define phoneme token");
    }

    @Test
    void acceptsSupportedSingleBatchSingleChannelAudioTensorAndCopiesIt() {
        float[][][] output = {{{0.1f, -0.25f, 0.75f}}};

        float[] samples = PiperOnnxEngine.flattenAudioOutput(output);
        output[0][0][0] = 0.9f;

        assertThat(samples).containsExactly(0.1f, -0.25f, 0.75f);
    }

    @Test
    void forwardsRequestedSynthesisLocaleToThePhonemizer() {
        Locale requested = Locale.forLanguageTag("en-US");
        var actual = new java.util.concurrent.atomic.AtomicReference<Locale>();
        String result = PiperOnnxEngine.textToPhonemes("hello", requested, (text, locale) -> {
            actual.set(locale);
            return "həlˈoʊ";
        });

        assertThat(result).isEqualTo("həlˈoʊ");
        assertThat(actual.get()).isEqualTo(requested);
    }

    @Test
    void defaultsMissingSynthesisLocaleToEnglishForPhonemization() {
        var actual = new java.util.concurrent.atomic.AtomicReference<Locale>();
        PiperOnnxEngine.textToPhonemes("hello", null, (text, locale) -> {
            actual.set(locale);
            return "hello";
        });

        assertThat(actual.get()).isEqualTo(Locale.ENGLISH);
    }

    @Test
    void acceptsPiperFourDimensionalOutputAndCopiesIt() {
        float[][][][] output = {{{{0.1f, -0.25f, 0.75f}}}};

        float[] samples = PiperOnnxEngine.flattenAudioOutput(output);
        output[0][0][0][0] = 0.9f;

        assertThat(samples).containsExactly(0.1f, -0.25f, 0.75f);
    }

    @Test
    void rejectsEmptyWrongRankAndNonFiniteProviderOutput() {
        assertThatThrownBy(() -> PiperOnnxEngine.flattenAudioOutput(new float[0][][]))
                .isInstanceOf(InferenceError.class).hasMessageContaining("shape [1,1,samples]");
        assertThatThrownBy(() -> PiperOnnxEngine.flattenAudioOutput(new float[][][] {{{}}}))
                .isInstanceOf(InferenceError.class).hasMessageContaining("shape [1,1,samples]");
        assertThatThrownBy(() -> PiperOnnxEngine.flattenAudioOutput(new float[][][] {{{0.1f}, {0.2f}}}))
                .isInstanceOf(InferenceError.class).hasMessageContaining("shape [1,1,samples]");
        assertThatThrownBy(() -> PiperOnnxEngine.flattenAudioOutput(new float[][] {{0.1f}}))
                .isInstanceOf(InferenceError.class).hasMessageContaining("shape [1,1,samples]");
        assertThatThrownBy(() -> PiperOnnxEngine.flattenAudioOutput(new float[1][1][0][1]))
                .isInstanceOf(InferenceError.class).hasMessageContaining("shape [1,1,samples]");
        assertThatThrownBy(() -> PiperOnnxEngine.flattenAudioOutput(new float[][][][] {{{{}}}}))
                .isInstanceOf(InferenceError.class).hasMessageContaining("shape [1,1,samples]");
        assertThatThrownBy(() -> PiperOnnxEngine.flattenAudioOutput(new float[][][][] {{{{0.1f}, {0.2f}}}}))
                .isInstanceOf(InferenceError.class).hasMessageContaining("shape [1,1,samples]");
        assertThatThrownBy(() -> PiperOnnxEngine.flattenAudioOutput(new float[][][] {{{Float.NaN}}}))
                .isInstanceOf(InferenceError.class).hasMessageContaining("non-finite sample");
        assertThatThrownBy(() -> PiperOnnxEngine.flattenAudioOutput(new float[][][][] {{{{Float.POSITIVE_INFINITY}}}}))
                .isInstanceOf(InferenceError.class).hasMessageContaining("non-finite sample");
    }
}
