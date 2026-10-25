package com.ghatana.stt.service;

import com.ghatana.audit.AuditEvent;
import com.ghatana.audit.AuditService;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.infrastructure.persistence.service.TranscriptionService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.stt.testutil.LogCapture;
import io.activej.promise.Promise;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class PersistentSttServiceLogPrivacyTest {
    @Test
    void persistenceFailureLogsOmitIdentifiersAndExceptionTextButKeepAuditIdentity() {
        String tenantId = "tenant-sensitive-marker";
        UUID userId = UUID.fromString("11111111-2222-3333-4444-555555555555");
        String exceptionDetail = "private-audio-content-and-storage-location";
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        AudioFileService audioFiles = mock(AudioFileService.class);
        TranscriptionService transcriptions = mock(TranscriptionService.class);
        AuditService audit = mock(AuditService.class);
        when(audioFiles.save(eq(tenantId), any()))
                .thenReturn(Promise.ofException(new IllegalStateException(exceptionDetail)));
        PersistentSttService service = new PersistentSttService(
                library, audioFiles, transcriptions, new SimpleMeterRegistry(), audit);

        try (LogCapture logs = LogCapture.capture(PersistentSttService.class)) {
            service.transcribeAndPersist(
                    tenantId, userId, pcmWav(), "private-upload.wav", AudioFormat.WAV, "en", 16_000);

            String output = logs.output();
            assertThat(output).contains("STT request failed failureType=ILLEGALSTATEEXCEPTION")
                    .doesNotContain(tenantId, userId.toString(), exceptionDetail, "requestId", "audioId");

            ArgumentCaptor<AuditEvent> event = ArgumentCaptor.forClass(AuditEvent.class);
            verify(audit).record(event.capture());
            assertThat(event.getValue().getTenantId()).isEqualTo(tenantId);
            assertThat(event.getValue().getPrincipal()).isEqualTo(userId.toString());
            assertThat(event.getValue().getEventType()).isEqualTo("stt.transcribe");
            assertThat(event.getValue().getSuccess()).isFalse();
            assertThat(event.getValue().getDetails()).containsKey("requestId");
            assertThat(event.getValue().getDetails()).doesNotContainKey("inputHash");
        }
    }

    private static byte[] pcmWav() {
        byte[] wav = new byte[48];
        ByteBuffer bytes = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        putAscii(bytes, 0, "RIFF");
        bytes.putInt(4, 40);
        putAscii(bytes, 8, "WAVE");
        putAscii(bytes, 12, "fmt ");
        bytes.putInt(16, 16).putShort(20, (short) 1).putShort(22, (short) 1);
        bytes.putInt(24, 16_000).putInt(28, 32_000).putShort(32, (short) 2).putShort(34, (short) 16);
        putAscii(bytes, 36, "data");
        bytes.putInt(40, 4).putShort(44, (short) 10).putShort(46, (short) -10);
        return wav;
    }

    private static void putAscii(ByteBuffer bytes, int offset, String value) {
        bytes.position(offset);
        bytes.put(value.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
    }
}
