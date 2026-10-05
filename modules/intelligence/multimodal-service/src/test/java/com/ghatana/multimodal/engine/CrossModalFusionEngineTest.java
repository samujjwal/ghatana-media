package com.ghatana.multimodal.engine;

import com.ghatana.multimodal.engine.CrossModalFusionEngine.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.*;

/**
 * Tests for {@link CrossModalFusionEngine}.
 *
 * @doc.type    class
 * @doc.purpose CrossModalFusionEngine: audio-visual fusion, text-image fusion, missing modality handling
 * @doc.layer   product
 * @doc.pattern Test
 */
@DisplayName("CrossModalFusionEngineTest")
class CrossModalFusionEngineTest {

    private static final int DIM = 64;

    private CrossModalFusionEngine engine;

    @BeforeEach
    void setUp() { 
        engine = new CrossModalFusionEngine("crossmodal-v1", DIM); 
    }

    // ── Audio-visual fusion ───────────────────────────────────────────────────

    @Test
    @DisplayName("fuseAudioVisual returns non-null result for valid inputs")
    void audioVisualFusionReturnsResult() { 
        AudioFeatures audio = makeAudio(DIM, 0.8); 
        VisualFeatures visual = makeVisual(DIM, 0.7); 
        FusionResult result = engine.fuseAudioVisual(audio, visual); 
        assertThat(result).isNotNull(); 
    }

    @Test
    @DisplayName("fused embeddings have the expected dimension")
    void fusedEmbeddingsDimension() { 
        AudioFeatures audio = makeAudio(DIM, 0.9); 
        VisualFeatures visual = makeVisual(DIM, 0.8); 
        FusionResult result = engine.fuseAudioVisual(audio, visual); 
        assertThat(result.fusedEmbeddings()).hasSize(DIM); 
    }

    @Test
    @DisplayName("fusion confidence is within [0, 1]")
    void audioVisualFusionConfidenceNormalized() { 
        AudioFeatures audio = makeAudio(DIM, 0.85); 
        VisualFeatures visual = makeVisual(DIM, 0.75); 
        FusionResult result = engine.fuseAudioVisual(audio, visual); 
        assertThat(result.fusionConfidence()).isBetween(0.0, 1.0); 
    }

    @Test
    @DisplayName("modality weights map contains audio and visual keys")
    void audioVisualWeightsPresent() { 
        AudioFeatures audio = makeAudio(DIM, 0.8); 
        VisualFeatures visual = makeVisual(DIM, 0.6); 
        FusionResult result = engine.fuseAudioVisual(audio, visual); 
        assertThat(result.modalityWeights()).containsKeys("audio", "visual"); 
    }

    @Test
    @DisplayName("fusion result is marked not missing modality when both present")
    void audioVisualBothPresentNotMissing() { 
        AudioFeatures audio = makeAudio(DIM, 0.8); 
        VisualFeatures visual = makeVisual(DIM, 0.7); 
        FusionResult result = engine.fuseAudioVisual(audio, visual); 
        assertThat(result.hadMissingModality()).isFalse(); 
    }

    @Test
    @DisplayName("missing audio modality is detected and flagged")
    void missingAudioFlagged() { 
        AudioFeatures emptyAudio = new AudioFeatures(new double[0], 0.0); 
        VisualFeatures visual = makeVisual(DIM, 0.7); 
        FusionResult result = engine.fuseAudioVisual(emptyAudio, visual); 
        assertThat(result.hadMissingModality()).isTrue(); 
    }

    @Test
    @DisplayName("missing visual modality is detected and flagged")
    void missingVisualFlagged() { 
        AudioFeatures audio = makeAudio(DIM, 0.8); 
        VisualFeatures emptyVisual = new VisualFeatures(new double[0], new double[0], 0.0); 
        FusionResult result = engine.fuseAudioVisual(audio, emptyVisual); 
        assertThat(result.hadMissingModality()).isTrue(); 
    }

    @Test
    @DisplayName("both modalities absent throws FusionException")
    void bothModalitiesAbsentThrows() { 
        AudioFeatures emptyAudio = new AudioFeatures(new double[0], 0.0); 
        VisualFeatures emptyVisual = new VisualFeatures(new double[0], new double[0], 0.0); 
        assertThatThrownBy(() -> engine.fuseAudioVisual(emptyAudio, emptyVisual)) 
                .isInstanceOf(CrossModalFusionEngine.FusionException.class); 
    }

    @Test
    @DisplayName("null audio argument throws NullPointerException")
    void nullAudioThrows() { 
        VisualFeatures visual = makeVisual(DIM, 0.7); 
        assertThatThrownBy(() -> engine.fuseAudioVisual(null, visual)) 
                .isInstanceOf(NullPointerException.class); 
    }

    @Test
    @DisplayName("null visual argument throws NullPointerException")
    void nullVisualThrows() { 
        AudioFeatures audio = makeAudio(DIM, 0.8); 
        assertThatThrownBy(() -> engine.fuseAudioVisual(audio, null)) 
                .isInstanceOf(NullPointerException.class); 
    }

    // ── Text-image fusion ─────────────────────────────────────────────────────

    @Test
    @DisplayName("fuseTextImage returns non-null result for valid inputs")
    void textImageFusionReturnsResult() { 
        TextFeatures text = makeText(DIM, "Hello world", 0.9); 
        VisualFeatures visual = makeVisual(DIM, 0.8); 
        FusionResult result = engine.fuseTextImage(text, visual); 
        assertThat(result).isNotNull(); 
    }

    @Test
    @DisplayName("text-image fused embeddings have expected dimension")
    void textImageFusedEmbeddingsDimension() { 
        TextFeatures text = makeText(DIM, "Caption text", 0.85); 
        VisualFeatures visual = makeVisual(DIM, 0.75); 
        FusionResult result = engine.fuseTextImage(text, visual); 
        assertThat(result.fusedEmbeddings()).hasSize(DIM); 
    }

    @Test
    @DisplayName("text-image fusion modality weights contain text and visual keys")
    void textImageWeightsPresent() { 
        TextFeatures text = makeText(DIM, "Photo of a cat", 0.9); 
        VisualFeatures visual = makeVisual(DIM, 0.8); 
        FusionResult result = engine.fuseTextImage(text, visual); 
        assertThat(result.modalityWeights()).containsKeys("text", "visual"); 
    }

    @Test
    @DisplayName("missing text modality is flagged in text-image fusion")
    void missingTextFlagged() { 
        TextFeatures emptyText = new TextFeatures(new double[0], "", 0.0); 
        VisualFeatures visual = makeVisual(DIM, 0.8); 
        FusionResult result = engine.fuseTextImage(emptyText, visual); 
        assertThat(result.hadMissingModality()).isTrue(); 
    }

    @Test
    @DisplayName("both text and visual absent throws FusionException in text-image fusion")
    void textImageBothAbsentThrows() { 
        TextFeatures emptyText = new TextFeatures(new double[0], "", 0.0); 
        VisualFeatures emptyVisual = new VisualFeatures(new double[0], new double[0], 0.0); 
        assertThatThrownBy(() -> engine.fuseTextImage(emptyText, emptyVisual)) 
                .isInstanceOf(CrossModalFusionEngine.FusionException.class); 
    }

    // ── Cross-modal attention (structural) ──────────────────────────────────── 

    @Test
    @DisplayName("different audio inputs produce different fused embeddings")
    void differentAudioProducesDifferentEmbeddings() { 
        VisualFeatures visual = makeVisual(DIM, 0.8); 
        AudioFeatures audio1 = makeAudio(DIM, 0.9); 
        AudioFeatures audio2 = makeAudioWithValues(DIM, 0.5, 42.0); 
        double[] fused1 = engine.fuseAudioVisual(audio1, visual).fusedEmbeddings(); 
        double[] fused2 = engine.fuseAudioVisual(audio2, visual).fusedEmbeddings(); 
        // At least one element should differ
        boolean differs = false;
        for (int i = 0; i < DIM; i++) { 
            if (fused1[i] != fused2[i]) { differs = true; break; } 
        }
        assertThat(differs).isTrue(); 
    }

    @Test
    @DisplayName("processing time is recorded and non-negative")
    void processingTimeIsNonNegative() { 
        AudioFeatures audio = makeAudio(DIM, 0.85); 
        VisualFeatures visual = makeVisual(DIM, 0.75); 
        FusionResult result = engine.fuseAudioVisual(audio, visual); 
        assertThat(result.processingTime().isNegative()).isFalse(); 
    }

    // ── Embedding dimension variants ──────────────────────────────────────────

    @ParameterizedTest(name = "dim={0}") 
    @ValueSource(ints = {8, 32, 64, 128, 256, 512}) 
    @DisplayName("various embedding dimensions produce correctly-sized fusion output")
    void variousDimensionsProduceCorrectOutput(int dim) { 
        CrossModalFusionEngine e = new CrossModalFusionEngine("crossmodal-v1", dim); 
        FusionResult result = e.fuseAudioVisual(makeAudio(dim, 0.8), makeVisual(dim, 0.7)); 
        assertThat(result.fusedEmbeddings()).hasSize(dim); 
    }

    // ── Engine metadata ───────────────────────────────────────────────────────

    @Test
    @DisplayName("engine reports correct model ID")
    void engineModelId() { 
        assertThat(engine.getModelId()).isEqualTo("crossmodal-v1");
    }

    @Test
    @DisplayName("engine reports correct embedding dimension")
    void engineEmbeddingDim() { 
        assertThat(engine.getEmbeddingDim()).isEqualTo(DIM); 
    }

    @Test
    @DisplayName("non-positive embedding dimension throws IllegalArgumentException")
    void nonPositiveDimThrows() { 
        assertThatThrownBy(() -> new CrossModalFusionEngine("m", 0)) 
                .isInstanceOf(IllegalArgumentException.class); 
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private AudioFeatures makeAudio(int dim, double confidence) { 
        double[] emb = new double[dim];
        for (int i = 0; i < dim; i++) emb[i] = (double) i / dim; 
        return new AudioFeatures(emb, confidence); 
    }

    private AudioFeatures makeAudioWithValues(int dim, double confidence, double fillValue) { 
        double[] emb = new double[dim];
        java.util.Arrays.fill(emb, fillValue); 
        return new AudioFeatures(emb, confidence); 
    }

    private VisualFeatures makeVisual(int dim, double confidence) { 
        double[] emb = new double[dim];
        double[] boxes = new double[4];
        for (int i = 0; i < dim; i++) emb[i] = 1.0 - (double) i / dim; 
        return new VisualFeatures(emb, boxes, confidence); 
    }

    private TextFeatures makeText(int dim, String text, double confidence) { 
        double[] emb = new double[dim];
        for (int i = 0; i < dim; i++) emb[i] = Math.sin(i); 
        return new TextFeatures(emb, text, confidence); 
    }
}
