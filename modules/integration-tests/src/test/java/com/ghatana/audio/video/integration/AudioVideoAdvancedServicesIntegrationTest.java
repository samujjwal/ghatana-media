package com.ghatana.audio.video.integration;

import com.ghatana.stt.diarization.SpeakerDiarizationService;
import com.ghatana.tts.ssml.SsmlProcessor;
import com.ghatana.audio.video.vision.recognition.FacialRecognitionService;
import com.ghatana.audio.video.vision.scene.SceneUnderstandingService;
import com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp;
import com.ghatana.audio.video.multimodal.datacloud.MediaProcessingProvider;
import com.ghatana.audio.video.infrastructure.persistence.ledger.AudioVideoRunLedgerEntry;
import com.ghatana.audio.video.infrastructure.persistence.ledger.InMemoryAudioVideoRunLedgerAdapter;
import com.ghatana.testing.activej.EventloopTestBase;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.concurrent.atomic.AtomicInteger;
import java.time.Instant;

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
class AudioVideoAdvancedServicesIntegrationTest extends EventloopTestBase {

    @Test
    @DisplayName("Data Cloud media boundary exposes projection reads only")
    void dataCloudProviderContractIsReadOnly() {
        Set<String> operations = Arrays.stream(MediaProcessingProvider.class.getDeclaredMethods())
                .map(Method::getName)
                .collect(Collectors.toSet());

        assertThat(operations).containsExactlyInAnyOrder(
                "getJobStatus",
                "fetchTranscript",
                "fetchFrameIndex",
                "fetchExtractedEvents",
                "fetchEmbeddings",
                "listJobsForArtifact");
    }

    @Test
    @DisplayName("in-memory ledger round-trips labeled fixture outcomes and exact source provenance")
    void ledgerFixturePreservesOutcomeAndProvenance() {
        InMemoryAudioVideoRunLedgerAdapter ledger = new InMemoryAudioVideoRunLedgerAdapter();
        Instant startedAt = Instant.parse("2026-11-02T12:00:00Z");
        Instant endedAt = startedAt.plusSeconds(2);
        AudioVideoRunLedgerEntry success = AudioVideoRunLedgerEntry.builder()
                .runId("fixture-run-success")
                .sessionId("fixture-session")
                .mediaArtifactId("fixture-artifact-v1")
                .tenantId("fixture-tenant")
                .actorId("fixture-actor")
                .state(AudioVideoRunLedgerEntry.RunState.SUCCEEDED)
                .startedAt(startedAt)
                .endedAt(endedAt)
                .traceId("fixture-trace-success")
                .sttJobId("fixture-stt-job-v1")
                .providerKey("synthetic-fixture:local-v1")
                .systemMetadata(Map.of(
                        "evidenceKind", "SYNTHETIC_FIXTURE_ONLY",
                        "sourceArtifactVersion", "fixture-artifact-v1",
                        "transcriptVersion", "fixture-transcript-v1"))
                .build();
        AudioVideoRunLedgerEntry failure = AudioVideoRunLedgerEntry.builder()
                .runId("fixture-run-failure")
                .sessionId("fixture-session")
                .mediaArtifactId("fixture-artifact-v1")
                .tenantId("fixture-tenant")
                .actorId("fixture-actor")
                .state(AudioVideoRunLedgerEntry.RunState.FAILED)
                .startedAt(startedAt)
                .endedAt(endedAt)
                .traceId("fixture-trace-failure")
                .errorCode(4001)
                .errorMessage("synthetic fixture failure")
                .providerKey("synthetic-fixture:local-v1")
                .systemMetadata(Map.of(
                        "evidenceKind", "SYNTHETIC_FIXTURE_ONLY",
                        "sourceArtifactVersion", "fixture-artifact-v1"))
                .build();
        AudioVideoRunLedgerEntry otherTenant = AudioVideoRunLedgerEntry.builder()
                .runId("fixture-run-other-tenant")
                .sessionId("fixture-session-other-tenant")
                .mediaArtifactId("fixture-artifact-other-tenant-v1")
                .tenantId("other-fixture-tenant")
                .actorId("other-fixture-actor")
                .state(AudioVideoRunLedgerEntry.RunState.SUCCEEDED)
                .startedAt(startedAt)
                .endedAt(endedAt)
                .traceId("fixture-trace-other-tenant")
                .providerKey("synthetic-fixture:local-v1")
                .systemMetadata(Map.of("evidenceKind", "SYNTHETIC_FIXTURE_ONLY"))
                .build();

        runPromise(() -> ledger.recordRunCompletion(success));
        runPromise(() -> ledger.recordRunCompletion(failure));
        runPromise(() -> ledger.recordRunCompletion(otherTenant));

        List<AudioVideoRunLedgerEntry> readback = runPromise(() ->
                ledger.queryByTenant("fixture-tenant", startedAt, endedAt));
        assertThat(readback).hasSize(2);
        assertThat(readback).extracting(AudioVideoRunLedgerEntry::runId)
                .containsExactlyInAnyOrder("fixture-run-success", "fixture-run-failure");
        List<AudioVideoRunLedgerEntry> otherTenantReadback = runPromise(() ->
                ledger.queryByTenant("other-fixture-tenant", startedAt, endedAt));
        assertThat(otherTenantReadback).singleElement()
                .extracting(AudioVideoRunLedgerEntry::runId).isEqualTo("fixture-run-other-tenant");
        assertThat(readback).filteredOn(entry -> entry.runId().equals("fixture-run-success"))
                .singleElement()
                .satisfies(entry -> {
                    assertThat(entry.state()).isEqualTo(AudioVideoRunLedgerEntry.RunState.SUCCEEDED);
                    assertThat(entry.mediaArtifactId()).isEqualTo("fixture-artifact-v1");
                    assertThat(entry.getSttJobId()).contains("fixture-stt-job-v1");
                    assertThat(entry.getProviderKey()).contains("synthetic-fixture:local-v1");
                    assertThat(entry.systemMetadata()).containsEntry("evidenceKind", "SYNTHETIC_FIXTURE_ONLY")
                            .containsEntry("sourceArtifactVersion", "fixture-artifact-v1")
                            .containsEntry("transcriptVersion", "fixture-transcript-v1");
                });
        assertThat(readback).filteredOn(entry -> entry.runId().equals("fixture-run-failure"))
                .singleElement()
                .satisfies(entry -> {
                    assertThat(entry.state()).isEqualTo(AudioVideoRunLedgerEntry.RunState.FAILED);
                    assertThat(entry.getErrorCode()).contains(4001);
                    assertThat(entry.getErrorMessage()).contains("synthetic fixture failure");
                    assertThat(entry.systemMetadata())
                            .containsEntry("evidenceKind", "SYNTHETIC_FIXTURE_ONLY")
                            .containsEntry("sourceArtifactVersion", "fixture-artifact-v1")
                            .doesNotContainKey("transcriptVersion");
                });
    }

    @Nested
    @DisplayName("Source timebase integration")
    class SourceTimebaseIntegration {

        @Test
        @DisplayName("synthetic source sample clock stays exact and missing source time stays UNKNOWN")
        void sourceTimebase_preservesExactSamplePositionAndUnknownState() {
            MediaClockTimestamp sample = MediaClockTimestamp.audioSamples(
                    24_000, 48_000, "synthetic-fixture:audio-clock");

            assertThat(sample.status()).isEqualTo(MediaClockTimestamp.Status.KNOWN);
            assertThat(sample.ticks()).isEqualTo(24_000L);
            assertThat(sample.timeBaseNumerator()).isEqualTo(1L);
            assertThat(sample.timeBaseDenominator()).isEqualTo(48_000L);
            assertThat(sample.domain()).isEqualTo(MediaClockTimestamp.ClockDomain.SOURCE);
            assertThat(sample.clockId()).isEqualTo("synthetic-fixture:audio-clock");

            MediaClockTimestamp absent = MediaClockTimestamp.unknown("NO_SOURCE_PTS");
            assertThat(absent.status()).isEqualTo(MediaClockTimestamp.Status.UNKNOWN);
            assertThat(absent.ticks()).isNull();
            assertThat(absent.timeBaseNumerator()).isNull();
            assertThat(absent.timeBaseDenominator()).isNull();
            assertThat(absent.domain()).isNull();
            assertThat(absent.clockId()).isNull();
            assertThat(absent.unknownReason()).isEqualTo("NO_SOURCE_PTS");
        }
    }

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
        @DisplayName("biometric recognition fails closed before provider and audit effects")
        void visionIntegration_face_notAdmittedWithoutAuthorities() {
            byte[] imageBytes = new byte[256];
            AtomicInteger biometricProviderCalls = new AtomicInteger();
            AtomicInteger biometricAuditCalls = new AtomicInteger();

            FacialRecognitionService faceService = FacialRecognitionService.of(
                    bytes -> {
                        biometricProviderCalls.incrementAndGet();
                        return List.of(FacialRecognitionService.FaceDetection.of(
                                new FacialRecognitionService.BoundingBox(0, 0.1, 0.3, 0.3), 0.95, new float[]{0.8f}));
                    }, 0.85, 0.5, true, event -> biometricAuditCalls.incrementAndGet());

            assertThatThrownBy(() -> faceService.detect(imageBytes))
                    .isInstanceOf(FacialRecognitionService.NotAdmittedException.class)
                    .hasMessageContaining("NOT_ADMITTED: trusted biometric rights authority is unavailable");
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

