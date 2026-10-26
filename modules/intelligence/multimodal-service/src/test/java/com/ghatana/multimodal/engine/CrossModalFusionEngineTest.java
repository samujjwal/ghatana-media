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
    @DisplayName("feature records snapshot constructor and accessor arrays")
    void featureRecordsDefensivelySnapshotArrays() {
        double[] audioInput = new double[DIM];
        double[] visualInput = new double[DIM];
        audioInput[0] = 0.25; audioInput[1] = 0.75;
        java.util.Arrays.fill(visualInput, 0.5);
        double[] boxesInput = {1, 2, 3, 4};
        double[] textInput = {0.2, 0.8};
        AudioFeatures audio = new AudioFeatures(audioInput, 0.5, "space");
        VisualFeatures visual = new VisualFeatures(visualInput, boxesInput, 0.5, "space");
        TextFeatures text = new TextFeatures(textInput, "caption", 0.5, "space");

        audioInput[0] = 99;
        visualInput[0] = 99;
        boxesInput[0] = 99;
        textInput[0] = 99;
        assertThat(audio.embeddings()[0]).isEqualTo(0.25);
        assertThat(audio.embeddings()[1]).isEqualTo(0.75);
        assertThat(visual.embeddings()).hasSize(DIM).containsOnly(0.5);
        assertThat(visual.boundingBoxes()).containsExactly(1, 2, 3, 4);
        assertThat(text.embeddings()).containsExactly(0.2, 0.8);

        audio.embeddings()[0] = 88;
        visual.embeddings()[0] = 88;
        visual.boundingBoxes()[0] = 88;
        text.embeddings()[0] = 88;
        assertThat(audio.embeddings()[0]).isEqualTo(0.25);
        assertThat(audio.embeddings()[1]).isEqualTo(0.75);
        assertThat(visual.embeddings()).hasSize(DIM).containsOnly(0.5);
        assertThat(visual.boundingBoxes()).containsExactly(1, 2, 3, 4);
        assertThat(text.embeddings()).containsExactly(0.2, 0.8);
    }

    @Test
    @DisplayName("caller mutations cannot alter subsequent fusion")
    void featureArrayMutationsDoNotAlterFusion() {
        double[] audioInput = new double[DIM];
        double[] visualInput = new double[DIM];
        java.util.Arrays.fill(audioInput, 0.25);
        java.util.Arrays.fill(visualInput, 0.5);
        AudioFeatures audio = new AudioFeatures(audioInput, 0.5, "space");
        VisualFeatures visual = new VisualFeatures(visualInput, new double[0], 0.5, "space");
        double[] expected = engine.fuseAudioVisual(audio, visual).fusedEmbeddings();
        audioInput[0] = -10;
        visualInput[0] = 10;
        audio.embeddings()[1] = 100;
        visual.embeddings()[1] = -100;
        assertThat(engine.fuseAudioVisual(audio, visual).fusedEmbeddings()).containsExactly(expected);
    }

    @Test
    @DisplayName("direct FusionResult construction rejects malformed numeric values")
    void fusionResultConstructorValidatesNumericBoundary() {
        assertThatThrownBy(() -> new FusionResult(new double[] {Double.NaN}, 0.5,
                java.util.Map.of("audio", 1.0), java.time.Duration.ZERO, false))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("finite");
        assertThatThrownBy(() -> new FusionResult(new double[] {0.0}, Double.POSITIVE_INFINITY,
                java.util.Map.of("audio", 1.0), java.time.Duration.ZERO, false))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("confidence");
        assertThatThrownBy(() -> new FusionResult(new double[] {0.0}, 0.5,
                java.util.Map.of("audio", Double.NaN), java.time.Duration.ZERO, false))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("weights");
        assertThatThrownBy(() -> new FusionResult(new double[] {0.0}, 0.5,
                java.util.Map.of("audio", 1.1), java.time.Duration.ZERO, false))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("weights");
        assertThatThrownBy(() -> new FusionResult(new double[] {0.0}, 0.5,
                java.util.Map.of("audio", 0.4), java.time.Duration.ZERO, false))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("sum to 1");
    }

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
        assertThat(result.confidenceDisposition())
                .isEqualTo(ConfidenceDisposition.HEURISTIC_UNCALIBRATED);
    }

    @Test
    @DisplayName("modality weights map contains audio and visual keys")
    void audioVisualWeightsPresent() { 
        AudioFeatures audio = makeAudio(DIM, 0.8); 
        VisualFeatures visual = makeVisual(DIM, 0.6); 
        FusionResult result = engine.fuseAudioVisual(audio, visual); 
        assertThat(result.modalityWeights().get("audio")).isCloseTo(4.0 / 7.0,
                org.assertj.core.data.Offset.offset(1.0e-12));
        assertThat(result.modalityWeights().get("visual")).isCloseTo(3.0 / 7.0,
                org.assertj.core.data.Offset.offset(1.0e-12));
        assertThat(result.modalityWeights().values()).allMatch(Double::isFinite);
        assertThat(result.modalityWeights().values().stream().mapToDouble(Double::doubleValue).sum())
                .isEqualTo(1.0);
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
        assertThat(result.modalityWeights()).containsEntry("audio", 0.0).containsEntry("visual", 1.0);
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
    @DisplayName("short audio embeddings are rejected instead of zero-padded")
    void shortAudioEmbeddingRejected() {
        assertThatThrownBy(() -> engine.fuseAudioVisual(
                new AudioFeatures(new double[DIM - 1], 0.5, "shared-test-space"), makeVisual(DIM, 0.5)))
                .isInstanceOf(CrossModalFusionEngine.FusionException.class)
                .hasMessageContaining("dimension");
    }

    @Test
    @DisplayName("long visual embeddings are rejected instead of truncated")
    void longVisualEmbeddingRejected() {
        assertThatThrownBy(() -> engine.fuseAudioVisual(
                makeAudio(DIM, 0.5), new VisualFeatures(new double[DIM + 1], new double[4], 0.5, "shared-test-space")))
                .isInstanceOf(CrossModalFusionEngine.FusionException.class)
                .hasMessageContaining("dimension");
    }

    @Test
    @DisplayName("non-finite audio and visual components are rejected")
    void nonFiniteEmbeddingComponentRejected() {
        double[] audioValues = new double[DIM];
        audioValues[3] = Double.NaN;
        assertThatThrownBy(() -> engine.fuseAudioVisual(
                new AudioFeatures(audioValues, 0.5, "shared-test-space"), makeVisual(DIM, 0.5)))
                .isInstanceOf(CrossModalFusionEngine.FusionException.class)
                .hasMessageContaining("non-finite");

        double[] visualValues = new double[DIM];
        visualValues[5] = Double.POSITIVE_INFINITY;
        assertThatThrownBy(() -> engine.fuseTextImage(
                makeText(DIM, "text", 0.5), new VisualFeatures(visualValues, new double[4], 0.5, "shared-test-space")))
                .isInstanceOf(CrossModalFusionEngine.FusionException.class)
                .hasMessageContaining("non-finite");
    }

    @Test
    @DisplayName("non-finite and out-of-range confidences are rejected")
    void invalidConfidencesRejected() {
        assertInvalidAudioConfidence(Double.NaN);
        assertInvalidAudioConfidence(Double.POSITIVE_INFINITY);
        assertInvalidAudioConfidence(-0.01);
        assertInvalidAudioConfidence(1.01);
        assertThatThrownBy(() -> engine.fuseTextImage(
                makeText(DIM, "text", 0.5),
                new VisualFeatures(new double[0], new double[4], Double.NaN)))
                .isInstanceOf(CrossModalFusionEngine.FusionException.class)
                .hasMessageContaining("confidence");
    }

    @Test
    @DisplayName("confidence boundaries are accepted and result exposes finite defensive values")
    void confidenceBoundariesAndResultValuesAreSafe() {
        FusionResult result = engine.fuseAudioVisual(makeAudio(DIM, 0.0), makeVisual(DIM, 1.0));
        assertThat(result.fusionConfidence()).isBetween(0.0, 1.0);
        assertThat(result.modalityWeights()).containsEntry("audio", 0.0).containsEntry("visual", 1.0);
        assertThat(java.util.Arrays.stream(result.fusedEmbeddings()).allMatch(Double::isFinite)).isTrue();
        assertThat(result.modalityWeights().values()).allMatch(Double::isFinite);
        double[] returned = result.fusedEmbeddings();
        returned[0] = Double.NaN;
        assertThat(result.fusedEmbeddings()[0]).isFinite();
        assertThatThrownBy(() -> result.modalityWeights().put("extra", 0.5))
                .isInstanceOf(UnsupportedOperationException.class);
        assertThat(result.confidenceDisposition()).isEqualTo(ConfidenceDisposition.HEURISTIC_UNCALIBRATED);
    }

    @Test
    @DisplayName("sparse finite embeddings are fused without turning weights into confidence")
    void sparseEmbeddingsKeepNormalizedContributionWeightsAndUncalibratedScore() {
        double[] sparseAudio = new double[DIM];
        double[] sparseVisual = new double[DIM];
        sparseAudio[2] = 1.0;
        sparseVisual[17] = 1.0;

        FusionResult result = engine.fuseAudioVisual(
                new AudioFeatures(sparseAudio, 0.8, "shared-test-space"),
                new VisualFeatures(sparseVisual, new double[4], 0.2, "shared-test-space"));

        assertThat(result.modalityWeights()).containsEntry("audio", 0.8).containsEntry("visual", 0.2);
        assertThat(result.modalityWeights().values().stream().mapToDouble(Double::doubleValue).sum())
                .isEqualTo(1.0);
        assertThat(result.fusionConfidence()).isEqualTo(0.5);
        assertThat(result.confidenceDisposition()).isEqualTo(ConfidenceDisposition.HEURISTIC_UNCALIBRATED);
    }

    @Test
    @DisplayName("matching declared embedding spaces permit fusion")
    void matchingEmbeddingSpacesPermitFusion() {
        FusionResult result = engine.fuseAudioVisual(
                new AudioFeatures(new double[DIM], 0.5, "joint-space-v1"),
                new VisualFeatures(new double[DIM], new double[4], 0.5, "joint-space-v1"));
        assertThat(result.fusedEmbeddings()).hasSize(DIM);
        assertThat(result.confidenceDisposition()).isEqualTo(ConfidenceDisposition.HEURISTIC_UNCALIBRATED);
    }

    @Test
    @DisplayName("source-bound fusion abstains when ROI or source frame differs")
    void sourceBoundFusionAbstainsOnIncompatibleRegions() {
        var outcome = engine.fuseAudioVisual(makeAudio(DIM, 0.5), makeVisual(DIM, 0.5),
                region("source-v1", 10, 20), region("source-v1", 11, 20),
                mediaTime(100), mediaTime(100));

        assertThat(outcome.fusion()).isEmpty();
        assertThat(outcome.abstentionReason()).isEqualTo("SOURCE_FRAME_OR_REGION_MISMATCH");
        assertThat(outcome.confidenceDisposition()).isEqualTo(ConfidenceDisposition.HEURISTIC_UNCALIBRATED);
        assertThat(outcome.synchronizationDisposition())
                .isEqualTo(CrossModalFusionEngine.SynchronizationDisposition.SYNC_UNDETERMINED);
    }

    @Test
    @DisplayName("source-bound fusion accepts identical versioned ROI and exact shared-clock instant")
    void sourceBoundFusionAcceptsMatchingFramesAndInstant() {
        var outcome = engine.fuseAudioVisual(makeAudio(DIM, 0.5), makeVisual(DIM, 0.5),
                region("source-v1", 10, 20), region("source-v1", 10, 20),
                mediaTime(100), mediaTime(100));

        assertThat(outcome.fusion()).isPresent();
        assertThat(outcome.abstentionReason()).isNull();
        assertThat(outcome.confidenceDisposition()).isEqualTo(ConfidenceDisposition.HEURISTIC_UNCALIBRATED);
        assertThat(outcome.synchronizationDisposition())
                .isEqualTo(CrossModalFusionEngine.SynchronizationDisposition.SYNC_UNDETERMINED);
    }

    @Test
    @DisplayName("source-bound fusion abstains on invalid weights")
    void sourceBoundFusionAbstainsOnInvalidWeights() {
        var outcome = engine.fuseAudioVisual(makeAudio(DIM, Double.NaN), makeVisual(DIM, 0.5),
                region("source-v1", 10, 20), region("source-v1", 10, 20),
                mediaTime(100), mediaTime(100));

        assertThat(outcome.fusion()).isEmpty();
        assertThat(outcome.abstentionReason()).isEqualTo("INVALID_FUSION_INPUT");
        assertThat(outcome.confidenceDisposition()).isEqualTo(ConfidenceDisposition.HEURISTIC_UNCALIBRATED);
    }

    @Test
    @DisplayName("source-bound fusion abstains when stream clocks are not aligned")
    void sourceBoundFusionAbstainsOnUnalignedStreams() {
        var audioClock = new com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp(
                com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.Status.KNOWN,
                100L, 1L, 1000L,
                com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.ClockDomain.SOURCE,
                "audio-clock", null);
        var videoClock = new com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp(
                com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.Status.KNOWN,
                100L, 1L, 1000L,
                com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.ClockDomain.SOURCE,
                "video-clock", null);
        var outcome = engine.fuseAudioVisual(makeAudio(DIM, 0.5), makeVisual(DIM, 0.5),
                region("source-v1", 10, 20), region("source-v1", 10, 20), audioClock, videoClock);

        assertThat(outcome.fusion()).isEmpty();
        assertThat(outcome.abstentionReason()).isEqualTo("SYNC_UNDETERMINED");
        assertThat(outcome.synchronizationDisposition())
                .isEqualTo(CrossModalFusionEngine.SynchronizationDisposition.SYNC_UNDETERMINED);
    }

    @Test
    @DisplayName("mismatched coordinate spaces are rejected")
    void mismatchedEmbeddingSpacesRejected() {
        assertThatThrownBy(() -> engine.fuseAudioVisual(
                new AudioFeatures(new double[DIM], 0.5, "audio-space"),
                new VisualFeatures(new double[DIM], new double[4], 0.5, "visual-space")))
                .isInstanceOf(CrossModalFusionEngine.FusionException.class)
                .hasMessageContaining("incompatible coordinate spaces");
    }

    @Test
    @DisplayName("missing or blank coordinate-space provenance is rejected")
    void missingEmbeddingSpaceRejected() {
        assertThatThrownBy(() -> engine.fuseAudioVisual(
                new AudioFeatures(new double[DIM], 0.5),
                new VisualFeatures(new double[DIM], new double[4], 0.5, "joint-space-v1")))
                .isInstanceOf(CrossModalFusionEngine.FusionException.class)
                .hasMessageContaining("known embeddingSpaceId");
        assertThatThrownBy(() -> engine.fuseTextImage(
                new TextFeatures(new double[DIM], "caption", 0.5, "  "),
                new VisualFeatures(new double[DIM], new double[4], 0.5, "joint-space-v1")))
                .isInstanceOf(CrossModalFusionEngine.FusionException.class)
                .hasMessageContaining("known embeddingSpaceId");
    }

    @Test
    @DisplayName("coordinate-space validation does not replace dimension and finite-value validation")
    void matchingSpaceStillRequiresDimensionsAndFiniteValues() {
        assertThatThrownBy(() -> engine.fuseAudioVisual(
                new AudioFeatures(new double[DIM - 1], 0.5, "joint-space-v1"),
                new VisualFeatures(new double[DIM], new double[4], 0.5, "joint-space-v1")))
                .isInstanceOf(CrossModalFusionEngine.FusionException.class)
                .hasMessageContaining("dimension");
        double[] nonFinite = new double[DIM];
        nonFinite[0] = Double.NaN;
        assertThatThrownBy(() -> engine.fuseTextImage(
                new TextFeatures(new double[DIM], "caption", 0.5, "joint-space-v1"),
                new VisualFeatures(nonFinite, new double[4], 0.5, "joint-space-v1")))
                .isInstanceOf(CrossModalFusionEngine.FusionException.class)
                .hasMessageContaining("non-finite");
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
        return new AudioFeatures(emb, confidence, "shared-test-space");
    }

    private AudioFeatures makeAudioWithValues(int dim, double confidence, double fillValue) { 
        double[] emb = new double[dim];
        java.util.Arrays.fill(emb, fillValue); 
        return new AudioFeatures(emb, confidence, "shared-test-space");
    }

    private VisualFeatures makeVisual(int dim, double confidence) { 
        double[] emb = new double[dim];
        double[] boxes = new double[4];
        for (int i = 0; i < dim; i++) emb[i] = 1.0 - (double) i / dim; 
        return new VisualFeatures(emb, boxes, confidence, "shared-test-space");
    }

    private TextFeatures makeText(int dim, String text, double confidence) { 
        double[] emb = new double[dim];
        for (int i = 0; i < dim; i++) emb[i] = Math.sin(i); 
        return new TextFeatures(emb, text, confidence, "shared-test-space");
    }

    private CrossModalFusionEngine.RegionFrame region(String sourceVersion, int x, int y) {
        return new CrossModalFusionEngine.RegionFrame("source-id", sourceVersion, "frame-v1", x, y, 30, 40);
    }

    private com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp mediaTime(long millis) {
        return com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.mediaMilliseconds(millis);
    }

    private void assertInvalidAudioConfidence(double confidence) {
        assertThatThrownBy(() -> engine.fuseAudioVisual(
                makeAudio(DIM, confidence), makeVisual(DIM, 0.5)))
                .isInstanceOf(CrossModalFusionEngine.FusionException.class)
                .hasMessageContaining("confidence");
    }
}
