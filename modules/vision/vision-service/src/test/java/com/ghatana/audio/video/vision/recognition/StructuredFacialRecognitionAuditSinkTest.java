package com.ghatana.audio.video.vision.recognition;

import com.ghatana.observability.MetricsCollector;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verify;

/**
 * @doc.type class
 * @doc.purpose Unit tests for StructuredFacialRecognitionAuditSink (AV-P2-05) 
 * @doc.layer test
 * @doc.pattern Test
 */
@ExtendWith(MockitoExtension.class) 
@DisplayName("StructuredFacialRecognitionAuditSink Tests (AV-P2-05)")
class StructuredFacialRecognitionAuditSinkTest {

    @Mock
    private MetricsCollector metricsCollector;

    private StructuredFacialRecognitionAuditSink sink;

    @BeforeEach
    void setUp() { 
        sink = new StructuredFacialRecognitionAuditSink(metricsCollector); 
        lenient().doNothing().when(metricsCollector).incrementCounter( 
                org.mockito.ArgumentMatchers.anyString(), 
                org.mockito.ArgumentMatchers.any(String[].class)); 
    }

    @Test
    @DisplayName("Emits counter with outcome=success and reason=none on successful recognition")
    void shouldEmitSuccessCounterForSuccessfulRecognition() { 
        var event = FacialRecognitionService.FacialRecognitionAuditEvent.success("actor-1", "identity-1", 0.97); 

        sink.record(event); 

        verify(metricsCollector).incrementCounter( 
                "av.facial_recognition.audit",
                "outcome", "success",
                "reason", "none"
        );
    }

    @Test
    @DisplayName("Emits counter with outcome=no_match and reason=below_threshold")
    void shouldEmitNoMatchCounterWhenBelowThreshold() { 
        var event = FacialRecognitionService.FacialRecognitionAuditEvent.noMatch("actor-2", 0.40); 

        sink.record(event); 

        verify(metricsCollector).incrementCounter( 
                "av.facial_recognition.audit",
                "outcome", "no_match",
                "reason", "below_threshold"
        );
    }

    @Test
    @DisplayName("Emits counter with outcome=denied and reason=consent_missing")
    void shouldEmitDeniedCounterForConsentMissing() { 
        var event = FacialRecognitionService.FacialRecognitionAuditEvent.denied("consent_missing", "actor-3"); 

        sink.record(event); 

        verify(metricsCollector).incrementCounter( 
                "av.facial_recognition.audit",
                "outcome", "denied",
                "reason", "consent_missing"
        );
    }

    @Test
    @DisplayName("Emits counter with outcome=denied and reason=feature_disabled")
    void shouldEmitDeniedCounterForFeatureDisabled() { 
        var event = FacialRecognitionService.FacialRecognitionAuditEvent.denied("feature_disabled", "actor-4"); 

        sink.record(event); 

        verify(metricsCollector).incrementCounter( 
                "av.facial_recognition.audit",
                "outcome", "denied",
                "reason", "feature_disabled"
        );
    }
}

