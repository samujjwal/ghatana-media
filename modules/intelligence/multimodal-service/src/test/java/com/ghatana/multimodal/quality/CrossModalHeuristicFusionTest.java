package com.ghatana.multimodal.quality;

import com.ghatana.multimodal.engine.CrossModalFusionEngine;
import com.ghatana.multimodal.engine.CrossModalFusionEngine.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.*;

/**
 * Deterministic heuristic-shape regression tests for {@link CrossModalFusionEngine}.
 *
 * <p>Uses synthetic vectors to check deterministic arithmetic behavior, missing-modality
 * handling, and finite output shape. These fixtures do not measure model quality or alignment.
 *
 * @doc.type    class
 * @doc.purpose Cross-modal heuristic-shape regression coverage with synthetic vectors
 * @doc.layer   product
 * @doc.pattern Test
 */
@DisplayName("CrossModalHeuristicFusionTest")
class CrossModalHeuristicFusionTest {

    private static final int DIM = 128;
    private CrossModalFusionEngine engine;

    @BeforeEach
    void setUp() { 
        engine = new CrossModalFusionEngine("crossmodal-heuristic-test-v1", DIM); 
    }

    // ── Synthetic vector fixtures ──────────────────────────────────────────────

    @Test
    @DisplayName("large synthetic inputs produce a larger heuristic score")
    void largerSyntheticInputsProduceLargerHeuristicScore() { 
        AudioFeatures audio = makeAudio(DIM, 0.95); 
        VisualFeatures visual = makeVisual(DIM, 0.92); 
        FusionResult result = engine.fuseAudioVisual(audio, visual); 
        // The arithmetic score describes input values only; it is not calibrated confidence.
        assertThat(result.fusionConfidence()).isGreaterThan(0.5); 
        assertUncalibrated(result);
    }

    @Test
    @DisplayName("lower synthetic audio score does not increase the heuristic score")
    void lowerAudioScoreDoesNotIncreaseHeuristicScore() { 
        VisualFeatures visual = makeVisual(DIM, 0.9); 
        FusionResult highAudio = engine.fuseAudioVisual(makeAudio(DIM, 0.95), visual); 
        FusionResult lowAudio = engine.fuseAudioVisual(makeAudio(DIM, 0.2), visual); 
        assertThat(lowAudio.fusionConfidence()).isLessThanOrEqualTo(highAudio.fusionConfidence()); 
        assertUncalibrated(highAudio);
        assertUncalibrated(lowAudio);
    }

    @Test
    @DisplayName("balanced modality weights when both have equal confidence")
    void balancedWeightsForEqualConfidence() { 
        double conf = 0.8;
        AudioFeatures audio = makeAudio(DIM, conf); 
        VisualFeatures visual = makeVisual(DIM, conf); 
        FusionResult result = engine.fuseAudioVisual(audio, visual); 
        assertUncalibrated(result);
        double audioW = result.modalityWeights().get("audio");
        double visualW = result.modalityWeights().get("visual");
        assertThat(audioW).isCloseTo(visualW, within(0.01)); 
    }

    // ── Missing modality degradation ──────────────────────────────────────────

    @Test
    @DisplayName("missing audio preserves the utility's arithmetic missing-input behavior")
    void missingAudioPreservesHeuristicMissingInputBehavior() { 
        VisualFeatures visual = makeVisual(DIM, 0.8); 
        AudioFeatures fullAudio = makeAudio(DIM, 0.8); 
        AudioFeatures emptyAudio = new AudioFeatures(new double[0], 0.0); 
        FusionResult fullResult = engine.fuseAudioVisual(fullAudio, visual); 
        FusionResult degradedResult = engine.fuseAudioVisual(emptyAudio, visual); 
        assertThat(degradedResult.fusionConfidence()) 
                .isLessThanOrEqualTo(fullResult.fusionConfidence()); 
        assertUncalibrated(fullResult);
        assertUncalibrated(degradedResult);
    }

    @Test
    @DisplayName("missing visual modality still produces valid fused embeddings")
    void missingVisualProducesValidEmbeddings() { 
        AudioFeatures audio = makeAudio(DIM, 0.85); 
        VisualFeatures emptyVisual = new VisualFeatures(new double[0], new double[0], 0.0); 
        FusionResult result = engine.fuseAudioVisual(audio, emptyVisual); 
        assertThat(result.fusedEmbeddings()).hasSize(DIM); 
        assertThat(result.hadMissingModality()).isTrue(); 
    }

    @Test
    @DisplayName("missing text modality in text-image fusion still produces valid result")
    void missingTextProducesValidTextImageFusion() { 
        TextFeatures emptyText = new TextFeatures(new double[0], "", 0.0); 
        VisualFeatures visual = makeVisual(DIM, 0.8); 
        FusionResult result = engine.fuseTextImage(emptyText, visual); 
        assertThat(result.fusedEmbeddings()).hasSize(DIM); 
        assertThat(result.hadMissingModality()).isTrue(); 
    }

    // ── Deterministic synthetic input-shape coverage ───────────────────────────

    @Test
    @DisplayName("noisy audio embeddings produce a valid fusion result")
    void noisyAudioEmbeddingsHandled() { 
        AudioFeatures noisy = makeNoisyAudio(DIM); 
        VisualFeatures visual = makeVisual(DIM, 0.8); 
        FusionResult result = engine.fuseAudioVisual(noisy, visual); 
        assertThat(result.fusedEmbeddings()).hasSize(DIM); 
        assertThat(result.fusionConfidence()).isBetween(0.0, 1.0); 
        assertUncalibrated(result);
    }

    @Test
    @DisplayName("noisy visual embeddings produce a valid fusion result")
    void noisyVisualEmbeddingsHandled() { 
        AudioFeatures audio = makeAudio(DIM, 0.8); 
        VisualFeatures noisy = makeNoisyVisual(DIM); 
        FusionResult result = engine.fuseAudioVisual(audio, noisy); 
        assertThat(result.fusedEmbeddings()).hasSize(DIM); 
    }

    @Test
    @DisplayName("both modalities noisy still produces valid fusion")
    void bothNoisyProducesValidFusion() { 
        AudioFeatures noisyAudio = makeNoisyAudio(DIM); 
        VisualFeatures noisyVisual = makeNoisyVisual(DIM); 
        assertThatCode(() -> engine.fuseAudioVisual(noisyAudio, noisyVisual)) 
                .doesNotThrowAnyException(); 
    }

    // ── Deterministic output regression ───────────────────────────────────────

    @Test
    @DisplayName("audio-visual fusion is deterministic for identical inputs")
    void fusionIsDeterministic() { 
        AudioFeatures audio = makeAudio(DIM, 0.85); 
        VisualFeatures visual = makeVisual(DIM, 0.75); 
        double[] fused1 = engine.fuseAudioVisual(audio, visual).fusedEmbeddings(); 
        double[] fused2 = engine.fuseAudioVisual(audio, visual).fusedEmbeddings(); 
        assertThat(fused1).containsExactly(fused2); 
    }

    @Test
    @DisplayName("audio-visual fusion keeps output dimension across synthetic inputs")
    void fusionOutputDimensionStable() { 
        for (int trial = 0; trial < 5; trial++) { 
            AudioFeatures audio = makeAudio(DIM, 0.7 + trial * 0.05); 
            VisualFeatures visual = makeVisual(DIM, 0.8 - trial * 0.05); 
            FusionResult result = engine.fuseAudioVisual(audio, visual); 
            assertThat(result.fusedEmbeddings()).hasSize(DIM); 
        }
    }

    // ── Embedding dimension variants ──────────────────────────────────────────

    @ParameterizedTest(name = "dim={0}") 
    @ValueSource(ints = {16, 64, 128, 256}) 
    @DisplayName("heuristic output shape is stable across configured dimensions")
    void dimensionScaling(int dim) { 
        CrossModalFusionEngine e = new CrossModalFusionEngine("crossmodal-heuristic-test-v1", dim); 
        FusionResult result = e.fuseAudioVisual(makeAudio(dim, 0.85), makeVisual(dim, 0.75)); 
        assertThat(result.fusedEmbeddings()).hasSize(dim); 
        assertThat(result.fusionConfidence()).isBetween(0.0, 1.0); 
        assertUncalibrated(result);
    }

    // ── Text-image heuristic shape ────────────────────────────────────────────

    @Test
    @DisplayName("larger text-image input values produce a larger heuristic score")
    void largerTextImageValuesProduceLargerHeuristicScore() { 
        TextFeatures text = makeText(DIM, "caption text", 0.92); 
        VisualFeatures visual = makeVisual(DIM, 0.88); 
        FusionResult result = engine.fuseTextImage(text, visual); 
        assertThat(result.fusionConfidence()).isGreaterThan(0.5); 
        assertUncalibrated(result);
    }

    @Test
    @DisplayName("text-image fusion produces distinct output from audio-visual fusion")
    void textImageDistinctFromAudioVisual() { 
        TextFeatures text = makeText(DIM, "image caption", 0.9); 
        VisualFeatures visual = makeVisual(DIM, 0.8); 
        AudioFeatures audio = makeAudio(DIM, 0.9); 
        FusionResult textImage = engine.fuseTextImage(text, visual);
        FusionResult audioVisual = engine.fuseAudioVisual(audio, visual);
        double[] textImageFused = textImage.fusedEmbeddings();
        double[] audioVisualFused = audioVisual.fusedEmbeddings();
        assertUncalibrated(textImage);
        assertUncalibrated(audioVisual);
        // Different input types should produce different outputs
        assertThat(textImageFused).isNotEqualTo(audioVisualFused); 
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static AudioFeatures makeAudio(int dim, double confidence) { 
        double[] emb = new double[dim];
        for (int i = 0; i < dim; i++) emb[i] = (double) i / dim * confidence; 
        return new AudioFeatures(emb, confidence, "heuristic-test-space");
    }

    private static VisualFeatures makeVisual(int dim, double confidence) { 
        double[] emb = new double[dim];
        double[] boxes = new double[4];
        for (int i = 0; i < dim; i++) emb[i] = (1.0 - (double) i / dim) * confidence; 
        return new VisualFeatures(emb, boxes, confidence, "heuristic-test-space");
    }

    private static TextFeatures makeText(int dim, String text, double confidence) { 
        double[] emb = new double[dim];
        for (int i = 0; i < dim; i++) emb[i] = Math.cos((double) i / dim) * confidence; 
        return new TextFeatures(emb, text, confidence, "heuristic-test-space");
    }

    private static AudioFeatures makeNoisyAudio(int dim) { 
        double[] emb = new double[dim];
        for (int i = 0; i < dim; i++) emb[i] = (i % 7 == 0) ? Double.MIN_VALUE : (double) i / dim; 
        return new AudioFeatures(emb, 0.4, "heuristic-test-space");
    }

    private static void assertUncalibrated(FusionResult result) {
        assertThat(result.confidenceDisposition())
                .isEqualTo(ConfidenceDisposition.HEURISTIC_UNCALIBRATED);
    }

    private static VisualFeatures makeNoisyVisual(int dim) { 
        double[] emb = new double[dim];
        double[] boxes = new double[4];
        for (int i = 0; i < dim; i++) emb[i] = (i % 5 == 0) ? 0.0 : (double) (dim - i) / dim; 
        return new VisualFeatures(emb, boxes, 0.3, "heuristic-test-space");
    }

    private static org.assertj.core.data.Offset<Double> within(double d) { 
        return org.assertj.core.data.Offset.offset(d); 
    }
}
