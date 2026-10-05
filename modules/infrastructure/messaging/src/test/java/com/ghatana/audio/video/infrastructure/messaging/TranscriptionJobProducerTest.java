package com.ghatana.audio.video.infrastructure.messaging;

import com.ghatana.core.async.AsyncOperation;
import com.ghatana.messaging.EventEnvelope;
import com.ghatana.messaging.strategy.QueueProducerStrategy;
import com.ghatana.observability.MetricsCollector;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.slf4j.MDC;

import java.time.Instant;
import java.util.UUID;

import static com.ghatana.audio.video.infrastructure.messaging.AsyncOperationTestSupport.await;
import static com.ghatana.audio.video.infrastructure.messaging.AsyncOperationTestSupport.awaitFailure;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * @doc.type class
 * @doc.purpose Unit tests for transcription job producer lifecycle, submission behavior, and correlation ID propagation
 * @doc.layer test
 * @doc.pattern Test
 */
@ExtendWith(MockitoExtension.class)
@DisplayName("TranscriptionJobProducer Tests")
class TranscriptionJobProducerTest {

    @Mock
    private QueueProducerStrategy producerStrategy;

    @Mock
    private MetricsCollector metricsCollector;

    @AfterEach
    void clearMdc() {
        MDC.clear();
    }

    private TranscriptionJobProducer.TranscriptionJobMessage testJob(String tenantId) {
        return new TranscriptionJobProducer.TranscriptionJobMessage(
            UUID.randomUUID(), tenantId, UUID.randomUUID(), "correlation-123", "GRANTED", "STANDARD", "en", "whisper-large-v3", Instant.now()
        );
    }

    @Nested
    @DisplayName("Lifecycle")
    class LifecycleTests {

        @Test
        @DisplayName("submitJob fails when producer has not started")
        void submitJobFailsWhenNotStarted() {
            TranscriptionJobProducer producer = new TranscriptionJobProducer("av.jobs", producerStrategy, metricsCollector);

            var operation = producer.submitJob(testJob("tenant-1"));

            assertThat(awaitFailure(operation))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Producer not started");
        }

        @Test
        @DisplayName("start then submitJob delegates a canonical event envelope")
        void startAndSubmitDelegatesToStrategy() {
            TranscriptionJobProducer producer = new TranscriptionJobProducer("av.jobs", producerStrategy, metricsCollector);
            when(producerStrategy.start()).thenReturn(AsyncOperation.success(null));
            when(producerStrategy.send(any(EventEnvelope.class))).thenAnswer(invocation -> {
                EventEnvelope<?> envelope = invocation.getArgument(0);
                return AsyncOperation.success(envelope.id());
            });

            await(producer.start());

            TranscriptionJobProducer.TranscriptionJobMessage job = testJob("tenant-1");

            String messageId = await(producer.submitJob(job));

            assertThat(messageId).isEqualTo(job.jobId().toString());
            @SuppressWarnings("unchecked")
            ArgumentCaptor<EventEnvelope<String>> envelopeCaptor =
                (ArgumentCaptor<EventEnvelope<String>>) (ArgumentCaptor<?>)
                    ArgumentCaptor.forClass(EventEnvelope.class);
            verify(producerStrategy).send(envelopeCaptor.capture());
            EventEnvelope<String> envelope = envelopeCaptor.getValue();
            assertThat(envelope.topic()).isEqualTo("av.jobs");
            assertThat(envelope.eventType()).isEqualTo("media.transcription.job.submitted");
            assertThat(envelope.sourceService()).isEqualTo("media");
            assertThat(envelope.tenantId()).isEqualTo("tenant-1");
            assertThat(envelope.payload()).contains(job.jobId().toString());
            verify(metricsCollector).incrementCounter(
                "av.messaging.jobs.submitted", "queue", "av.jobs", "tenant_id", "tenant-1");
        }
    }

    @Nested
    @DisplayName("Correlation ID propagation")
    class CorrelationIdTests {

        @Test
        @DisplayName("correlation identity is forwarded as a canonical envelope field")
        void correlationIdFieldPropagatedFromMdc() {
            TranscriptionJobProducer producer = new TranscriptionJobProducer("av.jobs", producerStrategy, metricsCollector);
            when(producerStrategy.start()).thenReturn(AsyncOperation.success(null));

            @SuppressWarnings("unchecked")
            ArgumentCaptor<EventEnvelope<String>> envelopeCaptor =
                (ArgumentCaptor<EventEnvelope<String>>) (ArgumentCaptor<?>)
                    ArgumentCaptor.forClass(EventEnvelope.class);
            when(producerStrategy.send(envelopeCaptor.capture())).thenAnswer(invocation ->
                AsyncOperation.success(((EventEnvelope<?>) invocation.getArgument(0)).id()));

            await(producer.start());
            MDC.put("correlationId", "trace-abc-123");

            await(producer.submitJob(testJob("tenant-2")));

            assertThat(envelopeCaptor.getValue().correlationId()).isEqualTo("trace-abc-123");
        }

        @Test
        @DisplayName("job correlation identity is used when MDC does not override it")
        void jobCorrelationIdUsedWhenNoMdcEntry() {
            TranscriptionJobProducer producer = new TranscriptionJobProducer("av.jobs", producerStrategy, metricsCollector);
            when(producerStrategy.start()).thenReturn(AsyncOperation.success(null));

            @SuppressWarnings("unchecked")
            ArgumentCaptor<EventEnvelope<String>> envelopeCaptor =
                (ArgumentCaptor<EventEnvelope<String>>) (ArgumentCaptor<?>)
                    ArgumentCaptor.forClass(EventEnvelope.class);
            when(producerStrategy.send(envelopeCaptor.capture())).thenAnswer(invocation ->
                AsyncOperation.success(((EventEnvelope<?>) invocation.getArgument(0)).id()));

            await(producer.start());
            TranscriptionJobProducer.TranscriptionJobMessage job = testJob("tenant-3");

            await(producer.submitJob(job));

            assertThat(envelopeCaptor.getValue().correlationId()).isEqualTo(job.correlationId());
        }
    }
}

