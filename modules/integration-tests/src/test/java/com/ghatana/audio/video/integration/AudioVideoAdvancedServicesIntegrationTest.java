package com.ghatana.audio.video.integration;

import com.ghatana.stt.diarization.SpeakerDiarizationService;
import com.ghatana.stt.detection.LanguageDetectionService;
import com.ghatana.stt.vocabulary.CustomVocabularyManager;
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

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Cross-service integration tests for the Audio-Video module (AV-012). 
 *
 * <p>Verifies that the advanced STT, TTS, and Vision services interact correctly
 * when composed in a multi-step media analysis workflow without requiring the
 * underlying native AI libraries (all models are stubbed). 
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
        @DisplayName("diarizer → language detector → vocabulary manager pipeline works end-to-end")
        void sttPipeline_diarizationToVocabulary_endToEnd() { 
            // Step 1: Diarize
            SpeakerDiarizationService diarizer = SpeakerDiarizationService.builder() 
                    .embeddingExtractor(bytes -> new float[]{1.0f, 0.0f}) 
                    .maxSpeakers(3) 
                    .similarityThreshold(0.80) 
                    .build(); 

            var segments = List.of( 
                    new SpeakerDiarizationService.AudioSegment(new byte[]{1, 2}, 0, 500, "Ghatana is awesome"), 
                    new SpeakerDiarizationService.AudioSegment(new byte[]{1, 2}, 500, 1000, "ActiveJ rocks") 
            );
            List<SpeakerDiarizationService.SpeakerTurn> turns = diarizer.diarize(segments); 
            assertThat(turns).hasSize(2); 
            assertThat(turns.get(0).speakerId()).isNotNull(); 

            // Step 2: Language detection
            LanguageDetectionService langDetector = LanguageDetectionService.of( 
                    textSample -> List.of(LanguageDetectionService.LanguageCandidate.of("en", 0.98))); 
            LanguageDetectionService.DetectionResult langResult = langDetector.detect(turns.get(0).text()); 
            assertThat(langResult.topLanguageTag()).contains("en");

            // Step 3: Vocabulary enhancement
            CustomVocabularyManager vocab = CustomVocabularyManager.of(List.of("Ghatana", "ActiveJ")); 
            String enhanced = vocab.apply(turns.get(0).text()); 
            assertThat(enhanced).isEqualTo("Ghatana is awesome");
            assertThat(vocab.contains("ghatana")).isTrue();
        }

        @Test
        @DisplayName("multiple speakers with distinct audio signatures are correctly identified")
        void sttIntegration_multipleSpeakers_isolatedLabels() { 
            SpeakerDiarizationService diarizer = SpeakerDiarizationService.builder() 
                    .embeddingExtractor(bytes -> { 
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

            List<SpeakerDiarizationService.SpeakerTurn> turns = diarizer.diarize(segments); 

            assertThat(turns.get(0).speakerId()) 
                    .isEqualTo(turns.get(2).speakerId()); // same speaker 
            assertThat(turns.get(0).speakerId()) 
                    .isNotEqualTo(turns.get(1).speakerId()); // different speaker 
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
        @DisplayName("facial recognition and scene understanding run on same image bytes")
        void visionIntegration_faceAndScene_parallel() { 
            byte[] imageBytes = new byte[512]; // dummy image

            FacialRecognitionService faceService = FacialRecognitionService.of( 
                    bytes -> List.of(FacialRecognitionService.FaceDetection.of( 
                            new FacialRecognitionService.BoundingBox(0.1, 0.1, 0.3, 0.3), 
                            0.97, new float[]{0.9f, 0.1f})));

            SceneUnderstandingService sceneService = SceneUnderstandingService.of( 
                    bytes -> List.of(new SceneUnderstandingService.SceneLabel("office/meeting-room", 0.91))); 

            var faces = faceService.detect(imageBytes); 
            var scene = sceneService.classify(imageBytes); 

            assertThat(faces).hasSize(1); 
            assertThat(faces.get(0).confidence()).isGreaterThan(0.90); 
            assertThat(scene.hasTopScene()).isTrue(); 
            assertThat(scene.topSceneLabel()).isEqualTo("office/meeting-room");
        }

        @Test
        @DisplayName("OCR and facial recognition on same image return independent results")
        void visionIntegration_ocrAndFace_independent() { 
            byte[] imageBytes = new byte[256];

            OcrService ocrService = OcrService.of(bytes -> List.of( 
                    new OcrService.TextRegion("Meeting Agenda", new OcrService.BoundingBox(0, 0, 1, 0.1), 0.96, 0))); 

            FacialRecognitionService faceService = FacialRecognitionService.of( 
                    bytes -> List.of(FacialRecognitionService.FaceDetection.of( 
                            new FacialRecognitionService.BoundingBox(0, 0.1, 0.3, 0.3), 
                            0.95, new float[]{0.8f})));

            assertThat(ocrService.extractText(imageBytes)).isEqualTo("Meeting Agenda");
            assertThat(faceService.detect(imageBytes)).hasSize(1); 
        }

        @Test
        @DisplayName("identity identification with enrolled embeddings works for known person")
        void visionIntegration_identityRecognition_knownPerson() { 
            float[] enrolledEmbedding = new float[]{0.7f, 0.7f, 0.0f};

            FacialRecognitionService service = FacialRecognitionService.of( 
                    bytes -> List.of(FacialRecognitionService.FaceDetection.of( 
                            new FacialRecognitionService.BoundingBox(0, 0, 1, 1), 
                            0.99, enrolledEmbedding)));

            var faces = service.detect(new byte[]{1}); 
            assertThat(faces).hasSize(1); 

            var match = service.identify( 
                    faces.get(0).embedding(), 
                    Map.of("alice", enrolledEmbedding)); 
            assertThat(match).isPresent(); 
            assertThat(match.get().identityId()).isEqualTo("alice");
            assertThat(match.get().similarity()).isGreaterThan(0.99); 
        }
    }
}

