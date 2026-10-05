package com.ghatana.audio.video.vision.recognition;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatNullPointerException;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Unit tests for {@link FacialRecognitionService} — AV-009.1.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the facial recognition service
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("FacialRecognitionService")
class FacialRecognitionServiceTest {

    /** Stub model: returns 1 face per image byte array length > 0. */
    private static final FacialRecognitionService.FaceRecognitionModel STUB_MODEL =
            imageBytes -> List.of( 
                    FacialRecognitionService.FaceDetection.of( 
                            new FacialRecognitionService.BoundingBox(0.1, 0.1, 0.3, 0.4), 
                            0.98,
                            new float[]{0.8f, 0.6f, 0.0f}));

    private FacialRecognitionService buildService() { 
        return FacialRecognitionService.of(STUB_MODEL); 
    }

    private FacialRecognitionService buildService(double detectionThreshold, boolean enabled, 
                                                  FacialRecognitionService.FacialRecognitionAuditSink auditSink) {
        return FacialRecognitionService.of(STUB_MODEL, 0.85, detectionThreshold, enabled, auditSink); 
    }

    // ─── of() ───────────────────────────────────────────────────────────────── 

    @Test
    @DisplayName("of(model): null model throws NullPointerException")
    void of_nullModel_throwsNPE() { 
        assertThatNullPointerException() 
                .isThrownBy(() -> FacialRecognitionService.of(null)); 
    }

    @Test
    @DisplayName("of(model, threshold > 1): throws IllegalArgumentException")
    void of_invalidThreshold_throwsIAE() { 
        assertThatIllegalArgumentException() 
                .isThrownBy(() -> FacialRecognitionService.of(STUB_MODEL, 1.5)); 
    }

    // ─── detect() ───────────────────────────────────────────────────────────── 

    @Nested
    @DisplayName("detect()")
    class Detect {

        @Test
        @DisplayName("returns detected faces from model")
        void detect_returnsDetections() { 
            FacialRecognitionService service = buildService(); 
            List<FacialRecognitionService.FaceDetection> faces = service.detect(new byte[]{1, 2, 3}); 
            assertThat(faces).hasSize(1); 
            assertThat(faces.get(0).confidence()).isEqualTo(0.98); 
        }

        @Test
        @DisplayName("null imageBytes throws NullPointerException")
        void detect_null_throwsNPE() { 
            FacialRecognitionService service = buildService(); 
            assertThatNullPointerException() 
                    .isThrownBy(() -> service.detect(null)); 
        }

        @Test
        @DisplayName("empty imageBytes throws IllegalArgumentException")
        void detect_empty_throwsIAE() { 
            FacialRecognitionService service = buildService(); 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> service.detect(new byte[0])); 
        }

        @Test
        @DisplayName("returned list is unmodifiable")
        void detect_unmodifiableList() { 
            FacialRecognitionService service = buildService(); 
            var faces = service.detect(new byte[]{1, 2}); 
            assertThatThrownBy(() -> faces.add(FacialRecognitionService.FaceDetection.of( 
                    new FacialRecognitionService.BoundingBox(0, 0, 1, 1), 0.5, new float[0]))) 
                    .isInstanceOf(UnsupportedOperationException.class); 
        }

        @Test
        @DisplayName("filters detections below configured confidence threshold")
        void detect_filtersByConfiguredThreshold() { 
            FacialRecognitionService service = buildService(0.99, true, 
                    FacialRecognitionService.FacialRecognitionAuditSink.noop()); 

            List<FacialRecognitionService.FaceDetection> faces = service.detect(new byte[]{1, 2, 3}); 

            assertThat(faces).isEmpty(); 
        }
    }

    // ─── identify() ─────────────────────────────────────────────────────────── 

    @Nested
    @DisplayName("identify()")
    class Identify {

        private static final float[] QUERY = new float[]{0.8f, 0.6f, 0.0f};
        private static final float[] ENROLLED_MATCH = new float[]{0.8f, 0.6f, 0.0f}; // identical
        private static final float[] ENROLLED_NO_MATCH = new float[]{-0.8f, -0.6f, 0.0f}; // opposite

        @Test
        @DisplayName("identical embeddings → identity matched")
        void identify_identical_matchFound() { 
            FacialRecognitionService service = buildService(); 
            Optional<FacialRecognitionService.IdentityMatch> match =
                    service.identify(QUERY, Map.of("person-1", ENROLLED_MATCH)); 

            assertThat(match).isPresent(); 
            assertThat(match.get().identityId()).isEqualTo("person-1");
            assertThat(match.get().similarity()).isGreaterThan(0.98); 
        }

        @Test
        @DisplayName("opposite embeddings → no match")
        void identify_opposite_noMatch() { 
            FacialRecognitionService service = FacialRecognitionService.of(STUB_MODEL, 0.85); 
            Optional<FacialRecognitionService.IdentityMatch> match =
                    service.identify(QUERY, Map.of("person-2", ENROLLED_NO_MATCH)); 

            assertThat(match).isEmpty(); 
        }

        @Test
        @DisplayName("empty enrolled map → no match")
        void identify_emptyEnrolled_noMatch() { 
            FacialRecognitionService service = buildService(); 
            Optional<FacialRecognitionService.IdentityMatch> match =
                    service.identify(QUERY, Map.of()); 
            assertThat(match).isEmpty(); 
        }

        @Test
        @DisplayName("null faceEmbedding throws NullPointerException")
        void identify_nullEmbedding_throwsNPE() { 
            FacialRecognitionService service = buildService(); 
            assertThatNullPointerException() 
                    .isThrownBy(() -> service.identify(null, Map.of())); 
        }

        @Test
        @DisplayName("null enrolledIdentities throws NullPointerException")
        void identify_nullEnrolled_throwsNPE() { 
            FacialRecognitionService service = buildService(); 
            assertThatNullPointerException() 
                    .isThrownBy(() -> service.identify(QUERY, null)); 
        }

        @Test
        @DisplayName("best match among multiple enrolled identities is returned")
        void identify_multipleEnrolled_bestMatch() { 
            FacialRecognitionService service = buildService(); 
            Optional<FacialRecognitionService.IdentityMatch> match = service.identify( 
                    QUERY,
                    Map.of( 
                            "person-near", new float[]{0.79f, 0.59f, 0.01f},
                            "person-exact", ENROLLED_MATCH,
                            "person-far", ENROLLED_NO_MATCH));
            assertThat(match).isPresent(); 
            assertThat(match.get().identityId()).isEqualTo("person-exact");
        }

        @Test
        @DisplayName("identify denied when recognition feature is disabled")
        void identify_disabledFeature_returnsEmptyAndAudits() { 
            AtomicReference<FacialRecognitionService.FacialRecognitionAuditEvent> auditEvent = new AtomicReference<>(); 
            FacialRecognitionService service = buildService(0.5, false, auditEvent::set); 

            Optional<FacialRecognitionService.IdentityMatch> match = service.identify( 
                    QUERY,
                    Map.of("person-1", ENROLLED_MATCH), 
                    true,
                    "actor-1");

            assertThat(match).isEmpty(); 
            assertThat(auditEvent.get()).isNotNull(); 
            assertThat(auditEvent.get().outcome()).isEqualTo("denied");
            assertThat(auditEvent.get().reason()).isEqualTo("feature_disabled");
        }

        @Test
        @DisplayName("identify denied when consent is missing")
        void identify_missingConsent_returnsEmptyAndAudits() { 
            AtomicReference<FacialRecognitionService.FacialRecognitionAuditEvent> auditEvent = new AtomicReference<>(); 
            FacialRecognitionService service = buildService(0.5, true, auditEvent::set); 

            Optional<FacialRecognitionService.IdentityMatch> match = service.identify( 
                    QUERY,
                    Map.of("person-1", ENROLLED_MATCH), 
                    false,
                    "actor-2");

            assertThat(match).isEmpty(); 
            assertThat(auditEvent.get()).isNotNull(); 
            assertThat(auditEvent.get().outcome()).isEqualTo("denied");
            assertThat(auditEvent.get().reason()).isEqualTo("consent_missing");
        }

        @Test
        @DisplayName("identify emits success audit for accepted match")
        void identify_successMatch_emitsAudit() { 
            AtomicReference<FacialRecognitionService.FacialRecognitionAuditEvent> auditEvent = new AtomicReference<>(); 
            FacialRecognitionService service = buildService(0.5, true, auditEvent::set); 

            Optional<FacialRecognitionService.IdentityMatch> match = service.identify( 
                    QUERY,
                    Map.of("person-1", ENROLLED_MATCH), 
                    true,
                    "actor-3");

            assertThat(match).isPresent(); 
            assertThat(auditEvent.get()).isNotNull(); 
            assertThat(auditEvent.get().outcome()).isEqualTo("success");
            assertThat(auditEvent.get().actorId()).isEqualTo("actor-3");
            assertThat(auditEvent.get().identityId()).isEqualTo("person-1");
        }
    }

    // ─── FaceDetection record validation ─────────────────────────────────────

    @Test
    @DisplayName("FaceDetection: confidence > 1 throws IllegalArgumentException")
    void faceDetection_invalidConfidence_throwsIAE() { 
        assertThatIllegalArgumentException() 
                .isThrownBy(() -> FacialRecognitionService.FaceDetection.of( 
                        new FacialRecognitionService.BoundingBox(0, 0, 1, 1), 1.1, new float[0])); 
    }

    @Test
    @DisplayName("FaceDetection.of: generates unique IDs for each call")
    void faceDetection_of_uniqueIds() { 
        var d1 = FacialRecognitionService.FaceDetection.of( 
                new FacialRecognitionService.BoundingBox(0, 0, 1, 1), 0.9, new float[1]); 
        var d2 = FacialRecognitionService.FaceDetection.of( 
                new FacialRecognitionService.BoundingBox(0, 0, 1, 1), 0.9, new float[1]); 
        assertThat(d1.faceId()).isNotEqualTo(d2.faceId()); 
    }
}
