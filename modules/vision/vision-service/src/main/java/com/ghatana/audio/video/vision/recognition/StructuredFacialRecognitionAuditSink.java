package com.ghatana.audio.video.vision.recognition;

import com.ghatana.observability.MetricsCollector;
import java.util.Objects;

/**
 * Legacy audit sink that rejects facial recognition events (AV-P2-05).
 *
 * <p>Biometric audit payloads are NOT_ADMITTED until a trusted rights authority
 * is available. This sink deliberately emits neither logs nor metrics.
 *
 * @doc.type class
 * @doc.purpose Structured audit log sink for facial recognition decisions (AV-P2-05)
 * @doc.layer product
 * @doc.pattern Observer
 */
public class StructuredFacialRecognitionAuditSink
        implements FacialRecognitionService.FacialRecognitionAuditSink {

    public StructuredFacialRecognitionAuditSink(MetricsCollector metricsCollector) {
        Objects.requireNonNull(metricsCollector, "metricsCollector");
    }

    @Override
    public void record(FacialRecognitionService.FacialRecognitionAuditEvent event) {
        Objects.requireNonNull(event, "event");
        // No trusted rights authority is available, so biometric audit records
        // are not admitted. In particular, never log caller/identity/template
        // related payload fields or convert arbitrary values into metric labels.
        throw new FacialRecognitionService.NotAdmittedException();
    }
}

