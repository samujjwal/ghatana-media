package com.ghatana.audio.video.multimodal.service;

import com.ghatana.audit.AuditEvent;
import com.ghatana.audit.AuditService;
import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.infrastructure.persistence.service.TranscriptionService;
import com.ghatana.testing.activej.EventloopTestBase;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.vision.api.VisionEngine;
import io.activej.promise.Promise;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class PersistentMultimodalServiceMetricPrivacyTest extends EventloopTestBase {

    @Test
    void providerFailureReturnsTypedUnavailableOutcomeAndRedactedAudit() {
        AudioFileService audioFileService = mock(AudioFileService.class);
        TranscriptionService transcriptionService = mock(TranscriptionService.class);
        AuditService auditService = mock(AuditService.class);
        SttEngine sttEngine = mock(SttEngine.class);
        String tenantMarker = "tenant-sensitive-marker";
        String fileMarker = "private-upload-marker.wav";
        String exceptionMarker = "private-content-/sensitive/path";
        when(audioFileService.save(anyString(), any(AudioFileEntity.class)))
                .thenAnswer(invocation -> Promise.of(invocation.getArgument(1)));
        doThrow(new IllegalStateException(exceptionMarker)).when(sttEngine).transcribe(any(AudioData.class));
        PersistentMultimodalService service = new PersistentMultimodalService(
                audioFileService, transcriptionService, sttEngine, null, new SimpleMeterRegistry(), auditService);

        try (LogCapture logs = LogCapture.capture(PersistentMultimodalService.class)) {
            PersistentMultimodalService.MultimodalResult result = runPromise(() -> service.processAndPersist(
                    tenantMarker, UUID.randomUUID(), new byte[] {1, 2}, null, fileMarker));
            assertThat(result.outcome()).isEqualTo(PersistentMultimodalService.Outcome.FAILED);
            assertThat(result.audioStatus()).isEqualTo(PersistentMultimodalService.ModalityStatus.UNAVAILABLE);
            assertThat(result.visualStatus()).isEqualTo(PersistentMultimodalService.ModalityStatus.NOT_REQUESTED);
            assertThat(result.transcription()).isNull();
            assertThat(logs.output())
                    .contains("failureType=IllegalStateException")
                    .doesNotContain(tenantMarker, fileMarker, exceptionMarker, "/sensitive/path");
            ArgumentCaptor<AuditEvent> event = ArgumentCaptor.forClass(AuditEvent.class);
            verify(auditService).record(event.capture());
            assertThat(event.getValue().getTenantId()).isEqualTo(tenantMarker);
            assertThat(event.getValue().getDetails()).containsEntry("audioStatus", "UNAVAILABLE")
                    .containsEntry("visualStatus", "NOT_REQUESTED")
                    .doesNotContainValue(exceptionMarker);
        }
    }

    @Test
    void audioSuccessAndVisionFailureReturnTypedPartialResult() {
        AudioFileService audioFileService = mock(AudioFileService.class);
        TranscriptionService transcriptionService = mock(TranscriptionService.class);
        SttEngine sttEngine = mock(SttEngine.class);
        VisionEngine visionEngine = mock(VisionEngine.class);
        when(audioFileService.save(anyString(), any(AudioFileEntity.class)))
                .thenAnswer(invocation -> Promise.of(invocation.getArgument(1)));
        when(transcriptionService.save(anyString(), any(TranscriptionEntity.class)))
                .thenAnswer(invocation -> Promise.of(invocation.getArgument(1)));
        when(sttEngine.transcribe(any(AudioData.class))).thenReturn(new TranscriptionResult(
                "grounded transcript", 0.91, List.of(), List.of(), Duration.ofMillis(20), "en", "fixture-model"));
        when(visionEngine.detectAsync(any(), any()))
                .thenReturn(Promise.ofException(new IllegalStateException("private vision marker")));
        PersistentMultimodalService service = new PersistentMultimodalService(
                audioFileService, transcriptionService, sttEngine, visionEngine, new SimpleMeterRegistry());

        PersistentMultimodalService.MultimodalResult result = runPromise(() -> service.processAndPersist(
                "tenant", UUID.randomUUID(), new byte[] {1, 2}, new byte[] {3, 4}, "meeting.mp4"));

        assertThat(result.outcome()).isEqualTo(PersistentMultimodalService.Outcome.PARTIAL);
        assertThat(result.audioStatus()).isEqualTo(PersistentMultimodalService.ModalityStatus.SUCCEEDED);
        assertThat(result.visualStatus()).isEqualTo(PersistentMultimodalService.ModalityStatus.UNAVAILABLE);
        assertThat(result.transcription()).isEqualTo("grounded transcript");
        assertThat(result.visualAnalysis().hasDetections()).isFalse();
        assertThat(result.visualAnalysis().detectedObjects()).isEmpty();
    }

    @Test
    void processAudioPersistsAvailableConfidenceAndAvailability() {
        AudioFileService audioFileService = mock(AudioFileService.class);
        TranscriptionService transcriptionService = mock(TranscriptionService.class);
        SttEngine sttEngine = mock(SttEngine.class);
        when(audioFileService.save(anyString(), any(AudioFileEntity.class)))
                .thenAnswer(invocation -> Promise.of(invocation.getArgument(1)));
        when(transcriptionService.save(anyString(), any(TranscriptionEntity.class)))
                .thenAnswer(invocation -> Promise.of(invocation.getArgument(1)));
        when(sttEngine.transcribe(any(AudioData.class))).thenReturn(new TranscriptionResult(
                "available score", 0.73, List.of(), List.of(), Duration.ofMillis(10), "en", "fixture-model"));
        PersistentMultimodalService service = new PersistentMultimodalService(
                audioFileService, transcriptionService, sttEngine, null, new SimpleMeterRegistry());

        runPromise(() -> service.processAndPersist(
                "tenant", UUID.randomUUID(), new byte[] {1}, null, "available.wav"));

        ArgumentCaptor<TranscriptionEntity> persisted = ArgumentCaptor.forClass(TranscriptionEntity.class);
        verify(transcriptionService).save(anyString(), persisted.capture());
        assertThat(persisted.getValue().getConfidence()).isEqualTo(0.73f);
        assertThat(persisted.getValue().getMetadata().getConfidenceStatus()).isEqualTo("AVAILABLE");
    }

    @Test
    void processAudioPersistsUnavailableConfidenceAsNullWithAvailability() {
        AudioFileService audioFileService = mock(AudioFileService.class);
        TranscriptionService transcriptionService = mock(TranscriptionService.class);
        SttEngine sttEngine = mock(SttEngine.class);
        when(audioFileService.save(anyString(), any(AudioFileEntity.class)))
                .thenAnswer(invocation -> Promise.of(invocation.getArgument(1)));
        when(transcriptionService.save(anyString(), any(TranscriptionEntity.class)))
                .thenAnswer(invocation -> Promise.of(invocation.getArgument(1)));
        when(sttEngine.transcribe(any(AudioData.class))).thenReturn(TranscriptionResult.withoutConfidence(
                "unavailable score", List.of(), List.of(), Duration.ofMillis(10), "en", "fixture-model"));
        PersistentMultimodalService service = new PersistentMultimodalService(
                audioFileService, transcriptionService, sttEngine, null, new SimpleMeterRegistry());

        runPromise(() -> service.processAndPersist(
                "tenant", UUID.randomUUID(), new byte[] {1}, null, "unavailable.wav"));

        ArgumentCaptor<TranscriptionEntity> persisted = ArgumentCaptor.forClass(TranscriptionEntity.class);
        verify(transcriptionService).save(anyString(), persisted.capture());
        assertThat(persisted.getValue().getConfidence()).isNull();
        assertThat(persisted.getValue().getMetadata().getConfidenceStatus()).isEqualTo("UNAVAILABLE");
    }

    @Test
    void processAudioRejectsInvalidAvailableConfidenceBeforePersistence() {
        for (double invalidConfidence : List.of(Double.NaN, -0.01, 1.01)) {
            AudioFileService audioFileService = mock(AudioFileService.class);
            TranscriptionService transcriptionService = mock(TranscriptionService.class);
            SttEngine sttEngine = mock(SttEngine.class);
            when(audioFileService.save(anyString(), any(AudioFileEntity.class)))
                    .thenAnswer(invocation -> Promise.of(invocation.getArgument(1)));
            when(sttEngine.transcribe(any(AudioData.class))).thenReturn(new TranscriptionResult(
                    "invalid confidence", invalidConfidence, List.of(), List.of(),
                    Duration.ofMillis(10), "en", "fixture-model"));
            PersistentMultimodalService service = new PersistentMultimodalService(
                    audioFileService, transcriptionService, sttEngine, null, new SimpleMeterRegistry());

            assertThatThrownBy(() -> runPromise(() -> service.processAndPersist(
                    "tenant", UUID.randomUUID(), new byte[] {1}, null, "invalid.wav")))
                    .hasMessage("Multimodal processing failed");
            verify(transcriptionService, never()).save(anyString(), any(TranscriptionEntity.class));
        }
    }

    @Test
    void transcriptPersistenceFailureStillFailsWholeOperation() {
        AudioFileService audioFileService = mock(AudioFileService.class);
        TranscriptionService transcriptionService = mock(TranscriptionService.class);
        SttEngine sttEngine = mock(SttEngine.class);
        when(audioFileService.save(anyString(), any(AudioFileEntity.class)))
                .thenAnswer(invocation -> Promise.of(invocation.getArgument(1)));
        when(sttEngine.transcribe(any(AudioData.class))).thenReturn(new TranscriptionResult(
                "transcript", 0.9, List.of(), List.of(), Duration.ofMillis(10), "en", "fixture-model"));
        when(transcriptionService.save(anyString(), any(TranscriptionEntity.class)))
                .thenReturn(Promise.ofException(new IllegalStateException("storage unavailable")));
        PersistentMultimodalService service = new PersistentMultimodalService(
                audioFileService, transcriptionService, sttEngine, null, new SimpleMeterRegistry());

        assertThatThrownBy(() -> runPromise(() -> service.processAndPersist(
                "tenant", UUID.randomUUID(), new byte[] {1, 2}, null, "meeting.wav")))
                .hasMessage("Multimodal processing failed")
                .hasNoCause();
    }

    @Test
    void callerSuppliedConsentStatusCannotAuthorizeDataCloudDispatchOrPersistence() {
        AudioFileService audioFileService = mock(AudioFileService.class);
        TranscriptionService transcriptionService = mock(TranscriptionService.class);
        SttEngine sttEngine = mock(SttEngine.class);
        VisionEngine visionEngine = mock(VisionEngine.class);
        AuditService auditService = mock(AuditService.class);
        SimpleMeterRegistry meterRegistry = new SimpleMeterRegistry();
        PersistentMultimodalService service = new PersistentMultimodalService(
                audioFileService, transcriptionService, sttEngine, visionEngine, meterRegistry, auditService);

        for (String callerSuppliedStatus : List.of("GRANTED", "AUTO_APPROVED")) {
            assertThatThrownBy(() -> runPromise(() -> service.processDataCloudJob(
                    "tenant", UUID.randomUUID(), "correlation", "request", callerSuppliedStatus,
                    "30-days", new byte[] {1}, new byte[] {2})))
                    .hasMessageStartingWith("DATACLOUD_MULTIMODAL_NOT_ADMITTED:");
        }

        verify(audioFileService, never()).save(anyString(), any(AudioFileEntity.class));
        verify(transcriptionService, never()).save(anyString(), any(TranscriptionEntity.class));
        verify(sttEngine, never()).transcribe(any(AudioData.class));
        verify(visionEngine, never()).detectAsync(any(), any());
        verify(auditService, never()).record(any(AuditEvent.class));
        assertThat(meterRegistry.find("multimodal.fuse.duration").timer().count()).isZero();
    }

    private static final class LogCapture extends AbstractAppender implements AutoCloseable {
        private final org.apache.logging.log4j.core.Logger logger;
        private final Level previousLevel;
        private final List<String> messages = new CopyOnWriteArrayList<>();

        private LogCapture(org.apache.logging.log4j.core.Logger logger) {
            super("multimodal-redaction-test", null, null, true, Property.EMPTY_ARRAY);
            this.logger = logger;
            this.previousLevel = logger.getLevel();
            start();
            logger.addAppender(this);
            logger.setLevel(Level.DEBUG);
        }

        static LogCapture capture(Class<?> loggerType) {
            LoggerContext context = (LoggerContext) org.apache.logging.log4j.LogManager.getContext(false);
            return new LogCapture(context.getLogger(loggerType.getName()));
        }

        @Override
        public void append(LogEvent event) {
            StringBuilder entry = new StringBuilder(event.getMessage().getFormattedMessage());
            if (event.getThrown() != null) {
                StringWriter stack = new StringWriter();
                event.getThrown().printStackTrace(new PrintWriter(stack));
                entry.append(' ').append(stack);
            }
            messages.add(entry.toString());
        }

        String output() { return String.join("\n", messages); }

        @Override
        public void close() {
            logger.removeAppender(this);
            logger.setLevel(previousLevel);
            stop();
        }
    }
}
