package com.ghatana.audio.video.infrastructure.messaging;

import com.ghatana.core.async.AsyncOperation;
import com.ghatana.messaging.EventEnvelope;
import com.ghatana.messaging.strategy.QueueConsumerStrategy;
import com.ghatana.observability.MetricsCollector;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.UUID;
import java.util.function.Consumer;

import static com.ghatana.audio.video.infrastructure.messaging.AsyncOperationTestSupport.await;
import static com.ghatana.audio.video.infrastructure.messaging.AsyncOperationTestSupport.awaitFailure;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * @doc.type class
 * @doc.purpose Unit tests for transcription job consumer lifecycle and health semantics
 * @doc.layer test
 * @doc.pattern Test
 */
@ExtendWith(MockitoExtension.class)
@DisplayName("TranscriptionJobConsumer Tests")
class TranscriptionJobConsumerTest {

    @Mock
    private QueueConsumerStrategy consumerStrategy;

    @Mock
    private MetricsCollector metricsCollector;

    @Test
    @DisplayName("start fails when job processor is missing")
    void startFailsWithoutProcessor() {
        TranscriptionJobConsumer consumer = new TranscriptionJobConsumer("av.jobs", consumerStrategy, metricsCollector);

        var operation = consumer.start();

        assertThat(awaitFailure(operation))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("Job processor not set");
    }

    @Test
    @DisplayName("start and stop delegate lifecycle to strategy")
    void startAndStopDelegateLifecycle() {
        TranscriptionJobConsumer consumer = new TranscriptionJobConsumer("av.jobs", consumerStrategy, metricsCollector);
        consumer.setJobProcessor(job -> AsyncOperation.success(null));

        when(consumerStrategy.supportsMessageHandlerRegistration()).thenReturn(true);
        when(consumerStrategy.start()).thenReturn(AsyncOperation.success(null));
        when(consumerStrategy.stop()).thenReturn(AsyncOperation.success(null));
        when(consumerStrategy.isRunning()).thenReturn(true, false);

        await(consumer.start());
        assertThat(consumer.isHealthy()).isTrue();

        await(consumer.stop());
        assertThat(consumer.isHealthy()).isFalse();

        verify(consumerStrategy).start();
        verify(consumerStrategy).stop();
        verify(metricsCollector).incrementCounter("av.messaging.consumer.start", "queue", "av.jobs");
        verify(metricsCollector).incrementCounter("av.messaging.consumer.stop", "queue", "av.jobs");
    }

    @Test
    @DisplayName("start without processor does not move consumer to STARTED")
    void startWithoutProcessorDoesNotChangeState() {
        TranscriptionJobConsumer consumer = new TranscriptionJobConsumer("av.jobs", consumerStrategy, metricsCollector);

        AsyncOperation<Void> firstStart = consumer.start();
        assertThat(awaitFailure(firstStart)).isInstanceOf(IllegalStateException.class);

        consumer.setJobProcessor(job -> AsyncOperation.success(null));
        when(consumerStrategy.supportsMessageHandlerRegistration()).thenReturn(true);
        when(consumerStrategy.start()).thenReturn(AsyncOperation.success(null));

        await(consumer.start());

        verify(consumerStrategy).start();
    }

    @Test
    @DisplayName("message handler rethrows processor failure for strategy nack/retry")
    void messageHandlerRethrowsProcessorFailure() {
        TranscriptionJobConsumer consumer = new TranscriptionJobConsumer("av.jobs", consumerStrategy, metricsCollector);
        consumer.setJobProcessor(job -> AsyncOperation.failure(new RuntimeException("simulated failure")));

        when(consumerStrategy.supportsMessageHandlerRegistration()).thenReturn(true);
        when(consumerStrategy.start()).thenReturn(AsyncOperation.success(null));

        await(consumer.start());

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Consumer<EventEnvelope<?>>> handlerCaptor =
            (ArgumentCaptor<Consumer<EventEnvelope<?>>>) (ArgumentCaptor<?>) ArgumentCaptor.forClass(Consumer.class);
        verify(consumerStrategy).setMessageHandler(handlerCaptor.capture());

        String payload = "{\"jobId\":\"" + UUID.randomUUID()
            + "\",\"tenantId\":\"tenant-1\",\"artifactId\":\"" + UUID.randomUUID()
            + "\",\"correlationId\":\"corr-1\",\"consentStatus\":\"GRANTED\""
            + ",\"retentionPolicy\":\"STANDARD\",\"language\":\"en\""
            + ",\"modelId\":\"m1\",\"submittedAt\":\"" + Instant.now() + "\"}";
        EventEnvelope<String> envelope = EventEnvelope.of(
            "av.jobs", "media.transcription.job.submitted", "media", "tenant-1", payload);

        assertThatThrownBy(() -> handlerCaptor.getValue().accept(envelope))
            .isInstanceOf(RuntimeException.class)
            .hasMessageContaining("simulated failure");
    }
}
