package com.ghatana.media.tts.engine.onnx;

import com.ghatana.media.common.InferenceError;
import com.ghatana.media.common.ModelLoadingError;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
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
    void acceptsOnlyTheDocumentedSingleBatchSingleChannelAudioTensorAndCopiesIt() {
        float[][][] output = {{{0.1f, -0.25f, 0.75f}}};

        float[] samples = PiperOnnxEngine.flattenAudioOutput(output);
        output[0][0][0] = 0.9f;

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
        assertThatThrownBy(() -> PiperOnnxEngine.flattenAudioOutput(new float[][][] {{{Float.NaN}}}))
                .isInstanceOf(InferenceError.class).hasMessageContaining("non-finite sample");
    }
}
