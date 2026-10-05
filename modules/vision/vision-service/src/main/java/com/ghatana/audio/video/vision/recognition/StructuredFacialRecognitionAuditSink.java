package com.ghatana.audio.video.vision.recognition;

import tools.jackson.databind.ObjectMapper;
import com.ghatana.observability.MetricsCollector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.Objects;

/**
 * Structured persistent audit sink for facial recognition events (AV-P2-05).
 *
 * <p>Records every recognition decision as a structured JSON log entry and emits
 * a Prometheus counter so compliance teams can correlate events with the log
 * aggregation stack (Loki) and detect anomalies in Grafana.
 *
 * <h3>Log schema</h3>
 * <pre>
 * {
 *   "timestamp": "2026-04-21T12:00:00Z",
 *   "service": "vision-recognition",
 *   "outcome": "success|no_match|denied",
 *   "actorId": "...",
 *   "identityId": "...",
 *   "similarity": 0.97,
 *   "reason": "consent_missing|feature_disabled|below_threshold|"
 * }
 * </pre>
 *
 * @doc.type class
 * @doc.purpose Structured audit log sink for facial recognition decisions (AV-P2-05)
 * @doc.layer product
 * @doc.pattern Observer
 */
public class StructuredFacialRecognitionAuditSink
        implements FacialRecognitionService.FacialRecognitionAuditSink {

    private static final Logger AUDIT_LOG = LoggerFactory.getLogger(
            "com.ghatana.audit.facial-recognition");

    private final ObjectMapper objectMapper;
    private final MetricsCollector metricsCollector;

    public StructuredFacialRecognitionAuditSink(
            MetricsCollector metricsCollector) {
        this.objectMapper = new ObjectMapper();
        this.metricsCollector = Objects.requireNonNull(metricsCollector, "metricsCollector");
    }

    @Override
    public void record(FacialRecognitionService.FacialRecognitionAuditEvent event) {
        try {
            String json = objectMapper.writeValueAsString(new AuditEntry(
                    Instant.now().toString(),
                    "vision-recognition",
                    event.outcome(),
                    event.actorId(),
                    event.identityId(),
                    event.similarity(),
                    event.reason()
            ));
            AUDIT_LOG.info(json);
        } catch (Exception e) {
            // Never suppress audit log errors silently — escalate to warn
            AUDIT_LOG.warn("Failed to serialize facial recognition audit event: outcome={} actor={}",
                    event.outcome(), event.actorId(), e);
        }

        metricsCollector.incrementCounter(
                "av.facial_recognition.audit",
                "outcome", event.outcome(),
                "reason", event.reason().isBlank() ? "none" : event.reason()
        );
    }

    // ── Internal log entry schema ──────────────────────────────────────────

    private record AuditEntry(
            String timestamp,
            String service,
            String outcome,
            String actorId,
            String identityId,
            double similarity,
            String reason
    ) {}
}

