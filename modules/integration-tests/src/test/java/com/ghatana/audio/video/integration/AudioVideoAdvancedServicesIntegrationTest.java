package com.ghatana.audio.video.integration;

import com.ghatana.stt.diarization.SpeakerDiarizationService;
import com.ghatana.tts.ssml.SsmlProcessor;
import com.ghatana.audio.video.vision.ocr.OcrService;
import com.ghatana.audio.video.vision.recognition.FacialRecognitionService;
import com.ghatana.audio.video.vision.scene.SceneUnderstandingService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Cross-service integration tests for the Audio-Video module (AV-012). 
 *
 * <p>Verifies fail-closed behavior when rights or provider admission is absent.
 * Injected provider lambdas are sentinels and must not be called; their outputs
 * do not establish provider capability or model quality.
 *
 * @doc.type class
 * @doc.purpose Cross-service integration tests for advanced audio-video features
 * @doc.layer product
 * @doc.pattern Test
 */
@Tag("integration")
@DisplayName("Audio-Video Service Integration Tests — AV-012")
class AudioVideoAdvancedServicesIntegrationTest {

    // ─── STT advanced feature integration ────────────────────────────────────

    @Nested
    @DisplayName("STT Advanced Features Integration (AV-007)")
    class SttAdvancedIntegration {

        @Test
        @DisplayName("diarization is NOT_ADMITTED before the injected embedding provider runs")
        void diarizationWithoutRights_failsBeforeEmbedding() {
            AtomicInteger extractorCalls = new AtomicInteger();
            SpeakerDiarizationService diarizer = SpeakerDiarizationService.builder() 
                    .embeddingExtractor(bytes -> { extractorCalls.incrementAndGet(); return new float[]{1.0f, 0.0f}; })
                    .maxSpeakers(3) 
                    .similarityThreshold(0.80) 
                    .build(); 

            var segments = List.of( 
                    new SpeakerDiarizationService.AudioSegment(new byte[]{1, 2}, 0, 500, "Ghatana is awesome"), 
                    new SpeakerDiarizationService.AudioSegment(new byte[]{1, 2}, 500, 1000, "ActiveJ rocks") 
            );
            assertThatThrownBy(() -> diarizer.diarize(segments))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessageContaining("STT_DIARIZATION_NOT_ADMITTED");
            assertThat(extractorCalls).hasValue(0);
        }

        @Test
        @DisplayName("diarization does not fabricate speaker labels without rights admission")
        void diarizationWithoutRights_returnsNoSpeakerLabels() {
            AtomicInteger extractorCalls = new AtomicInteger();
            SpeakerDiarizationService diarizer = SpeakerDiarizationService.builder() 
                    .embeddingExtractor(bytes -> { 
                        extractorCalls.incrementAndGet();
                        float[] emb = new float[8];
                        emb[bytes.length % 8] = 1.0f;
                        return emb;
                    })
                    .maxSpeakers(5) 
                    .similarityThreshold(0.85) 
                    .build(); 

            var segments = List.of( 
                    new SpeakerDiarizationService.AudioSegment(new byte[3], 0, 1000, "Hello"), 
                    new SpeakerDiarizationService.AudioSegment(new byte[4], 1000, 2000, "Hi"), 
                    new SpeakerDiarizationService.AudioSegment(new byte[3], 2000, 3000, "Back") 
            );

            assertThatThrownBy(() -> diarizer.diarize(segments))
                    .isInstanceOf(SpeakerDiarizationService.DiarizationException.class)
                    .hasMessageContaining("STT_DIARIZATION_NOT_ADMITTED");
            assertThat(extractorCalls).hasValue(0);
        }
    }

    // ─── TTS SSML integration ─────────────────────────────────────────────────

    @Nested
    @DisplayName("TTS SSML Integration (AV-008)")
    class TtsAdvancedIntegration {

        @Test
        @DisplayName("complex SSML document is correctly parsed into ordered segments")
        void ssmlIntegration_complexDocument_correctSegments() { 
            SsmlProcessor processor = SsmlProcessor.create(); 
            String ssml = "<speak>"
                    + "Welcome to Ghatana."
                    + "<break time=\"500ms\"/>"
                    + "<prosody rate=\"80%\">Processing your request.</prosody>"
                    + "<break time=\"200ms\"/>"
                    + "<emphasis level=\"strong\">Done!</emphasis>"
                    + "</speak>";

            List<SsmlProcessor.SsmlSegment> segments = processor.parse(ssml); 

            assertThat(segments).hasSizeGreaterThanOrEqualTo(4); 
            assertThat(segments.stream() 
                    .filter(s -> s.type() == SsmlProcessor.SsmlSegment.SegmentType.PAUSE) 
                    .count()).isEqualTo(2); 
            assertThat(segments.stream() 
                    .filter(s -> s.type() == SsmlProcessor.SsmlSegment.SegmentType.PROSODY) 
                    .count()).isEqualTo(1); 
            assertThat(segments.stream() 
                    .filter(s -> s.type() == SsmlProcessor.SsmlSegment.SegmentType.EMPHASIS) 
                    .count()).isEqualTo(1); 
        }

        @Test
        @DisplayName("toPlainText strips all markup for fallback text-only rendering")
        void ssmlIntegration_plainText_fallback() { 
            SsmlProcessor processor = SsmlProcessor.create(); 
            String ssml = "<speak>Hello <emphasis level=\"strong\">World</emphasis></speak>";
            assertThat(processor.toPlainText(ssml)).isEqualTo("Hello World");
        }
    }

    // ─── Vision advanced features integration ────────────────────────────────

    @Nested
    @DisplayName("Vision Advanced Features Integration (AV-009)")
    class VisionAdvancedIntegration {

        @Test
        @DisplayName("local scene fixture is independent and makes no provider quality claim")
        void sceneClassification_localFixtureOnly() {
            byte[] imageBytes = new byte[512];
            SceneUnderstandingService sceneService = SceneUnderstandingService.of( 
                    bytes -> List.of(new SceneUnderstandingService.SceneLabel("office/meeting-room", 0.91))); 

            var scene = sceneService.classify(imageBytes); 

            assertThat(scene.hasTopScene()).isTrue(); 
            assertThat(scene.topSceneLabel()).isEqualTo("office/meeting-room");
        }

        @Test
        @DisplayName("OCR and biometric recognition fail closed before provider and audit effects")
        void visionIntegration_ocrAndFace_notAdmittedWithoutAuthorities() {
            byte[] imageBytes = new byte[256];
            AtomicInteger ocrProviderCalls = new AtomicInteger();
            AtomicInteger biometricProviderCalls = new AtomicInteger();
            AtomicInteger biometricAuditCalls = new AtomicInteger();

            OcrService ocrService = OcrService.of(bytes -> {
                ocrProviderCalls.incrementAndGet();
                return List.of(new OcrService.TextRegion("Meeting Agenda", new OcrService.BoundingBox(0, 0, 1, 0.1), 0.96, 0));
            });

            FacialRecognitionService faceService = FacialRecognitionService.of(
                    bytes -> {
                        biometricProviderCalls.incrementAndGet();
                        return List.of(FacialRecognitionService.FaceDetection.of(
                                new FacialRecognitionService.BoundingBox(0, 0.1, 0.3, 0.3), 0.95, new float[]{0.8f}));
                    }, 0.85, 0.5, true, event -> biometricAuditCalls.incrementAndGet());

            assertThatThrownBy(() -> ocrService.extractText(imageBytes))
                    .isInstanceOf(OcrService.NotAdmittedException.class)
                    .hasMessageContaining("NOT_ADMITTED: Document Intelligence public API adapter is unavailable");
            assertThatThrownBy(() -> faceService.detect(imageBytes))
                    .isInstanceOf(FacialRecognitionService.NotAdmittedException.class)
                    .hasMessageContaining("NOT_ADMITTED: trusted biometric rights authority is unavailable");
            assertThat(ocrProviderCalls).hasValue(0);
            assertThat(biometricProviderCalls).hasValue(0);
            assertThat(biometricAuditCalls).hasValue(0);
        }

        @Test
        @DisplayName("caller-supplied embeddings cannot bypass biometric rights admission")
        void visionIntegration_identityRecognition_notAdmitted() {
            AtomicInteger biometricAuditCalls = new AtomicInteger();
            float[] enrolledEmbedding = new float[]{0.7f, 0.7f, 0.0f};

            FacialRecognitionService service = FacialRecognitionService.of(
                    bytes -> {
                        throw new AssertionError("identity-only path must not call the face provider");
                    }, 0.85, 0.5, true, event -> biometricAuditCalls.incrementAndGet());

            assertThatThrownBy(() -> service.identify(enrolledEmbedding, Map.of("alice", enrolledEmbedding)))
                    .isInstanceOf(FacialRecognitionService.NotAdmittedException.class)
                    .hasMessageContaining("NOT_ADMITTED: trusted biometric rights authority is unavailable");
            assertThat(biometricAuditCalls).hasValue(0);
        }
    }
}

