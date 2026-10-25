package com.ghatana.audio.video.multimodal.service;

import com.ghatana.audit.AuditEvent;
import com.ghatana.audit.AuditService;
import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.infrastructure.persistence.service.TranscriptionService;
import com.ghatana.testing.activej.EventloopTestBase;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.stt.api.SttEngine;
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
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class PersistentMultimodalServiceMetricPrivacyTest extends EventloopTestBase {

    @Test
    void providerFailureLogsAndReturnsOnlyStableRedactedFailure() {
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
            assertThatThrownBy(() -> runPromise(() -> service.processAndPersist(
                    tenantMarker, UUID.randomUUID(), new byte[] {1, 2}, null, fileMarker)))
                    .hasMessage("Multimodal processing failed")
                    .hasNoCause();
            assertThat(logs.output())
                    .contains("failureType=IllegalStateException")
                    .doesNotContain(tenantMarker, fileMarker, exceptionMarker, "/sensitive/path");
            ArgumentCaptor<AuditEvent> event = ArgumentCaptor.forClass(AuditEvent.class);
            verify(auditService).record(event.capture());
            assertThat(event.getValue().getTenantId()).isEqualTo(tenantMarker);
            assertThat(event.getValue().getDetails()).containsEntry("error", "PROCESSING_FAILED")
                    .doesNotContainValue(exceptionMarker);
        }
    }

    @Test
    void dataCloudJobDoesNotExportTenantCorrelationOrRequestIdsAsMetricTags() {
        AudioFileService audioFileService = mock(AudioFileService.class);
        TranscriptionService transcriptionService = mock(TranscriptionService.class);
        SimpleMeterRegistry meterRegistry = new SimpleMeterRegistry();
        when(audioFileService.save(anyString(), any(AudioFileEntity.class)))
                .thenAnswer(invocation -> Promise.of(invocation.getArgument(1)));
        PersistentMultimodalService service = new PersistentMultimodalService(
                audioFileService, transcriptionService, null, null, meterRegistry);
        String tenantMarker = "tenant-marker-private";
        String correlationMarker = "correlation-marker-private";
        String requestMarker = "request-marker-private";

        runPromise(() -> service.processDataCloudJob(tenantMarker, UUID.randomUUID(),
                correlationMarker, requestMarker, "GRANTED", "30-days", null, null));

        var timer = meterRegistry.find("multimodal.fuse.duration").timer();
        assertThat(timer).isNotNull();
        assertThat(timer.getId().getTags()).isEmpty();
        assertThat(timer.getId().getTags().toString())
                .doesNotContain(tenantMarker, correlationMarker, requestMarker);
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
