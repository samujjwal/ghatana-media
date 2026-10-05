package com.ghatana.audio.video.vision.scene;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatNullPointerException;

/**
 * Unit tests for {@link SceneUnderstandingService} — AV-009.2.
 *
 * @doc.type class
 * @doc.purpose Unit tests for scene classification and scene understanding
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("SceneUnderstandingService")
class SceneUnderstandingServiceTest {

    /** Stub model: returns outdoor/park at 0.92 and indoor/office at 0.45. */
    private static final SceneUnderstandingService.SceneClassificationModel STUB_MODEL =
            imageBytes -> List.of( 
                    new SceneUnderstandingService.SceneLabel("outdoor/park", 0.92), 
                    new SceneUnderstandingService.SceneLabel("indoor/office", 0.45) 
            );

    // ─── of() ───────────────────────────────────────────────────────────────── 

    @Test
    @DisplayName("of(null) throws NullPointerException")
    void of_null_throwsNPE() { 
        assertThatNullPointerException() 
                .isThrownBy(() -> SceneUnderstandingService.of(null)); 
    }

    @Test
    @DisplayName("of(model, threshold > 1) throws IllegalArgumentException")
    void of_invalidThreshold_throwsIAE() { 
        assertThatIllegalArgumentException() 
                .isThrownBy(() -> SceneUnderstandingService.of(STUB_MODEL, 1.5)); 
    }

    // ─── classify() ─────────────────────────────────────────────────────────── 

    @Nested
    @DisplayName("classify()")
    class Classify {

        @Test
        @DisplayName("returns outdoor/park as top scene (0.92 > 0.60 default threshold)")
        void classify_topScene_outdoorPark() { 
            SceneUnderstandingService service = SceneUnderstandingService.of(STUB_MODEL); 
            SceneUnderstandingService.SceneDescription desc = service.classify(new byte[]{1, 2, 3}); 

            assertThat(desc.hasTopScene()).isTrue(); 
            assertThat(desc.topSceneLabel()).isEqualTo("outdoor/park");
        }

        @Test
        @DisplayName("low-confidence indoor/office is filtered by default threshold")
        void classify_indoorOffice_filtered() { 
            SceneUnderstandingService service = SceneUnderstandingService.of(STUB_MODEL); 
            SceneUnderstandingService.SceneDescription desc = service.classify(new byte[]{1}); 

            assertThat(desc.qualifyingScenes()).hasSize(1); 
            assertThat(desc.qualifyingScenes().get(0).label()).isEqualTo("outdoor/park");
        }

        @Test
        @DisplayName("threshold 0.0 includes all scene candidates")
        void classify_zeroThreshold_includesAll() { 
            SceneUnderstandingService service = SceneUnderstandingService.of(STUB_MODEL, 0.0); 
            SceneUnderstandingService.SceneDescription desc = service.classify(new byte[]{1}); 

            assertThat(desc.qualifyingScenes()).hasSize(2); 
        }

        @Test
        @DisplayName("imageSizeBytes matches the input array length")
        void classify_imageSizeBytes_correct() { 
            SceneUnderstandingService service = SceneUnderstandingService.of(STUB_MODEL); 
            SceneUnderstandingService.SceneDescription desc = service.classify(new byte[42]); 
            assertThat(desc.imageSizeBytes()).isEqualTo(42); 
        }

        @Test
        @DisplayName("null imageBytes throws NullPointerException")
        void classify_null_throwsNPE() { 
            SceneUnderstandingService service = SceneUnderstandingService.of(STUB_MODEL); 
            assertThatNullPointerException().isThrownBy(() -> service.classify(null)); 
        }

        @Test
        @DisplayName("empty imageBytes throws IllegalArgumentException")
        void classify_empty_throwsIAE() { 
            SceneUnderstandingService service = SceneUnderstandingService.of(STUB_MODEL); 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> service.classify(new byte[0])); 
        }

        @Test
        @DisplayName("model returning no labels above threshold still returns a description")
        void classify_noLabelsAboveThreshold_hasNoTopScene() { 
            SceneUnderstandingService.SceneClassificationModel noneModel =
                    bytes -> List.of(new SceneUnderstandingService.SceneLabel("x", 0.10)); 

            SceneUnderstandingService service = SceneUnderstandingService.of(noneModel, 0.99); 
            SceneUnderstandingService.SceneDescription desc = service.classify(new byte[]{1}); 

            // No qualifying scenes but best candidate is used as top
            assertThat(desc.hasTopScene()).isTrue(); 
            assertThat(desc.qualifyingScenes()).isEmpty(); 
        }
    }

    // ─── SceneLabel validation ────────────────────────────────────────────────

    @Test
    @DisplayName("SceneLabel: null label throws NullPointerException")
    void sceneLabel_nullLabel_throwsNPE() { 
        assertThatNullPointerException() 
                .isThrownBy(() -> new SceneUnderstandingService.SceneLabel(null, 0.8)); 
    }

    @Test
    @DisplayName("SceneLabel: confidence > 1 throws IllegalArgumentException")
    void sceneLabel_invalidConfidence_throwsIAE() { 
        assertThatIllegalArgumentException() 
                .isThrownBy(() -> new SceneUnderstandingService.SceneLabel("outdoor", 1.1)); 
    }
}
