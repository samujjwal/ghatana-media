package com.ghatana.multimodal.quality;

import com.ghatana.multimodal.engine.CrossModalFusionEngine;
import com.ghatana.multimodal.engine.CrossModalFusionEngine.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.*;

/**
 * Cross-modal accuracy regression tests for {@link CrossModalFusionEngine}.
 *
 * <p>Validates fusion accuracy under benchmark conditions, including missing modality
 * degradation, noise tolerance, and temporal alignment properties.
 *
 * @doc.type    class
 * @doc.purpose Cross-modal accuracy: benchmark dataset, missing modality, noise robustness
 * @doc.layer   product
 * @doc.pattern Test
 */
@DisplayName("CrossModalAccuracyTest")
class CrossModalAccuracyTest {

    private static final int DIM = 128;
    private CrossModalFusionEngine engine;

    @BeforeEach
    void setUp() { 
        engine = new CrossModalFusionEngine("crossmodal-accuracy-v1", DIM); 
    }

    // ── Benchmark dataset fixtures ────────────────────────────────────────────

    @Test
    @DisplayName("high-quality benchmark fusion returns high confidence")
    void highQualityBenchmarkHighConfidence() { 
        AudioFeatures audio = makeAudio(DIM, 0.95); 
        VisualFeatures visual = makeVisual(DIM, 0.92); 
        FusionResult result = engine.fuseAudioVisual(audio, visual); 
        // With both modalities > 0.9, fusion confidence should be > 0.5
        assertThat(result.fusionConfidence()).isGreaterThan(0.5); 
    }

    @Test
    @DisplayName("low-quality audio reduces fusion confidence compared to high-quality")
    void lowQualityAudioReducesConfidence() { 
        VisualFeatures visual = makeVisual(DIM, 0.9); 
        FusionResult highAudio = engine.fuseAudioVisual(makeAudio(DIM, 0.95), visual); 
        FusionResult lowAudio = engine.fuseAudioVisual(makeAudio(DIM, 0.2), visual); 
        assertThat(lowAudio.fusionConfidence()).isLessThanOrEqualTo(highAudio.fusionConfidence()); 
    }

    @Test
    @DisplayName("balanced modality weights when both have equal confidence")
    void balancedWeightsForEqualConfidence() { 
        double conf = 0.8;
        AudioFeatures audio = makeAudio(DIM, conf); 
        VisualFeatures visual = makeVisual(DIM, conf); 
        FusionResult result = engine.fuseAudioVisual(audio, visual); 
        double audioW = result.modalityWeights().get("audio");
        double visualW = result.modalityWeights().get("visual");
        assertThat(audioW).isCloseTo(visualW, within(0.01)); 
    }

    // ── Missing modality degradation ──────────────────────────────────────────

    @Test
    @DisplayName("missing audio produces lower confidence than full audio-visual fusion")
    void missingAudioReducesConfidenceVsFullFusion() { 
        VisualFeatures visual = makeVisual(DIM, 0.8); 
        AudioFeatures fullAudio = makeAudio(DIM, 0.8); 
        AudioFeatures emptyAudio = new AudioFeatures(new double[0], 0.0); 
        FusionResult fullResult = engine.fuseAudioVisual(fullAudio, visual); 
        FusionResult degradedResult = engine.fuseAudioVisual(emptyAudio, visual); 
        assertThat(degradedResult.fusionConfidence()) 
                .isLessThanOrEqualTo(fullResult.fusionConfidence()); 
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

    // ── Noise robustness ──────────────────────────────────────────────────────

    @Test
    @DisplayName("noisy audio embeddings produce a valid fusion result")
    void noisyAudioEmbeddingsHandled() { 
        AudioFeatures noisy = makeNoisyAudio(DIM); 
        VisualFeatures visual = makeVisual(DIM, 0.8); 
        FusionResult result = engine.fuseAudioVisual(noisy, visual); 
        assertThat(result.fusedEmbeddings()).hasSize(DIM); 
        assertThat(result.fusionConfidence()).isBetween(0.0, 1.0); 
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

    // ── Temporal alignment accuracy ───────────────────────────────────────────

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
    @DisplayName("audio-visual fusion is commutative in terms of output dimension")
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
    @DisplayName("accuracy tests scale correctly across embedding dimensions")
    void dimensionScaling(int dim) { 
        CrossModalFusionEngine e = new CrossModalFusionEngine("crossmodal-accuracy-v1", dim); 
        FusionResult result = e.fuseAudioVisual(makeAudio(dim, 0.85), makeVisual(dim, 0.75)); 
        assertThat(result.fusedEmbeddings()).hasSize(dim); 
        assertThat(result.fusionConfidence()).isBetween(0.0, 1.0); 
    }

    // ── Text-image accuracy ───────────────────────────────────────────────────

    @Test
    @DisplayName("high-confidence text-image fusion has confidence > 0.5")
    void highConfidenceTextImageFusion() { 
        TextFeatures text = makeText(DIM, "caption text", 0.92); 
        VisualFeatures visual = makeVisual(DIM, 0.88); 
        FusionResult result = engine.fuseTextImage(text, visual); 
        assertThat(result.fusionConfidence()).isGreaterThan(0.5); 
    }

    @Test
    @DisplayName("text-image fusion produces distinct output from audio-visual fusion")
    void textImageDistinctFromAudioVisual() { 
        TextFeatures text = makeText(DIM, "image caption", 0.9); 
        VisualFeatures visual = makeVisual(DIM, 0.8); 
        AudioFeatures audio = makeAudio(DIM, 0.9); 
        double[] textImageFused = engine.fuseTextImage(text, visual).fusedEmbeddings(); 
        double[] audioVisualFused = engine.fuseAudioVisual(audio, visual).fusedEmbeddings(); 
        // Different input types should produce different outputs
        assertThat(textImageFused).isNotEqualTo(audioVisualFused); 
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static AudioFeatures makeAudio(int dim, double confidence) { 
        double[] emb = new double[dim];
        for (int i = 0; i < dim; i++) emb[i] = (double) i / dim * confidence; 
        return new AudioFeatures(emb, confidence); 
    }

    private static VisualFeatures makeVisual(int dim, double confidence) { 
        double[] emb = new double[dim];
        double[] boxes = new double[4];
        for (int i = 0; i < dim; i++) emb[i] = (1.0 - (double) i / dim) * confidence; 
        return new VisualFeatures(emb, boxes, confidence); 
    }

    private static TextFeatures makeText(int dim, String text, double confidence) { 
        double[] emb = new double[dim];
        for (int i = 0; i < dim; i++) emb[i] = Math.cos((double) i / dim) * confidence; 
        return new TextFeatures(emb, text, confidence); 
    }

    private static AudioFeatures makeNoisyAudio(int dim) { 
        double[] emb = new double[dim];
        for (int i = 0; i < dim; i++) emb[i] = (i % 7 == 0) ? Double.MIN_VALUE : (double) i / dim; 
        return new AudioFeatures(emb, 0.4); 
    }

    private static VisualFeatures makeNoisyVisual(int dim) { 
        double[] emb = new double[dim];
        double[] boxes = new double[4];
        for (int i = 0; i < dim; i++) emb[i] = (i % 5 == 0) ? 0.0 : (double) (dim - i) / dim; 
        return new VisualFeatures(emb, boxes, 0.3); 
    }

    private static org.assertj.core.data.Offset<Double> within(double d) { 
        return org.assertj.core.data.Offset.offset(d); 
    }
}
