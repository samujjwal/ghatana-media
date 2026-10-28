package com.ghatana.media.stt.engine.onnx;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class WhisperDecoderPolicyTest {
    @Test
    void firstGeneratedTokenSuppressesBlankEndOfTextAndControlTokens() {
        float[] scores = scores();
        scores[(int) WhisperTokenizer.blankTokenId()] = 100.0f;
        scores[(int) WhisperTokenizer.endOfTextToken()] = 90.0f;
        scores[50_258] = 80.0f;
        scores[41] = 5.0f;
        float[] firstPromptPosition = scores();
        firstPromptPosition[(int) WhisperTokenizer.noSpeechToken()] = 12.0f;

        WhisperOnnxEngine.DecoderStep result = WhisperOnnxEngine.selectDecoderStep(
                new float[][][] {{firstPromptPosition, scores}}, true);

        assertThat(result.tokenId()).isEqualTo(41);
        assertThat(result.noSpeechProbability()).isLessThan(0.01d);
    }

    @Test
    void noSpeechProbabilityUsesFinalPromptPositionThatPredictsFirstGeneratedToken() {
        float[] firstPromptPosition = scores();
        firstPromptPosition[(int) WhisperTokenizer.noSpeechToken()] = 12.0f;
        float[] finalPromptPosition = scores();
        finalPromptPosition[41] = 3.0f;
        finalPromptPosition[(int) WhisperTokenizer.noSpeechToken()] = 2.0f;

        WhisperOnnxEngine.DecoderStep result = WhisperOnnxEngine.selectDecoderStep(
                new float[][][] {{firstPromptPosition, finalPromptPosition}}, true);

        assertThat(result.tokenId()).isEqualTo(41);
        assertThat(result.noSpeechProbability()).isCloseTo(0.2689d,
                org.assertj.core.data.Offset.offset(0.001d));
    }

    @Test
    void laterGeneratedTokenMayTerminateWithEndOfTextAndNoSpeechUsesSourceThresholds() {
        float[] scores = scores();
        scores[(int) WhisperTokenizer.endOfTextToken()] = 3.0f;
        scores[41] = 2.0f;

        WhisperOnnxEngine.DecoderStep result = WhisperOnnxEngine.selectDecoderStep(scores, false);

        assertThat(result.tokenId()).isEqualTo(WhisperTokenizer.endOfTextToken());
        assertThat(result.noSpeechProbability()).isNaN();
        assertThat(WhisperOnnxEngine.shouldSuppressAsNoSpeech(0.61d, -1.01d)).isTrue();
        assertThat(WhisperOnnxEngine.shouldSuppressAsNoSpeech(0.60d, -2.0d)).isFalse();
        assertThat(WhisperOnnxEngine.shouldSuppressAsNoSpeech(0.9d, -1.0d)).isFalse();
        assertThat(WhisperOnnxEngine.shouldSuppressAsNoSpeech(Double.NaN, -2.0d)).isFalse();
    }

    private static float[] scores() {
        float[] values = new float[51_865];
        java.util.Arrays.fill(values, -20.0f);
        return values;
    }
}
