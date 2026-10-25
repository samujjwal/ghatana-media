package com.ghatana.audio.video.vision.recognition;

import com.ghatana.observability.MetricsCollector;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

class StructuredFacialRecognitionAuditSinkTest {

    @Test
    void refusesBiometricAuditPayloadBeforeMetricsOrLogging() {
        MetricsCollector metrics = mock(MetricsCollector.class);
        StructuredFacialRecognitionAuditSink sink = new StructuredFacialRecognitionAuditSink(metrics);
        var event = FacialRecognitionService.FacialRecognitionAuditEvent.success(
                "sensitive-actor", "sensitive-identity", 0.99);

        Throwable failure = catchThrowable(() -> sink.record(event));
        assertThat(failure)
                .isInstanceOf(FacialRecognitionService.NotAdmittedException.class)
                .hasMessage("NOT_ADMITTED: trusted biometric rights authority is unavailable");
        assertThat(failure.getMessage())
                .doesNotContain("sensitive-actor", "sensitive-identity", "0.99");

        verify(metrics, never()).incrementCounter(any(), any(String[].class));
    }
}
