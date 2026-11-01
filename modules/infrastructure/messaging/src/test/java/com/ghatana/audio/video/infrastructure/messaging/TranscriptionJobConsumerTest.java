package com.ghatana.audio.video.infrastructure.messaging;

import com.ghatana.core.async.AsyncOperation;
import com.ghatana.messaging.EventEnvelope;
import com.ghatana.messaging.SimpleEventId;
import com.ghatana.messaging.strategy.QueueProducerStrategy;
import com.ghatana.messaging.strategy.QueueConsumerStrategy;
import com.ghatana.observability.MetricsCollector;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.Function;

import static com.ghatana.audio.video.infrastructure.messaging.AsyncOperationTestSupport.await;
import static com.ghatana.audio.video.infrastructure.messaging.AsyncOperationTestSupport.awaitFailure;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.ArgumentMatchers.any;

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
    private QueueProducerStrategy producerStrategy;

    @Mock
    private MetricsCollector metricsCollector;

    @Test
    @DisplayName("start fails when job processor is missing")
    void startFailsWithoutProcessor() {
        TranscriptionJobConsumer consumer = callbackConsumer(new AtomicReference<>());

        var operation = consumer.start();

        assertThat(awaitFailure(operation))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("Job processor not set");
    }

    @Test
    @DisplayName("start and stop delegate lifecycle to strategy")
    void startAndStopDelegateLifecycle() {
        TranscriptionJobConsumer consumer = callbackConsumer(new AtomicReference<>());
        consumer.setJobProcessor(job -> AsyncOperation.success(null));

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
        TranscriptionJobConsumer consumer = callbackConsumer(new AtomicReference<>());

        AsyncOperation<Void> firstStart = consumer.start();
        assertThat(awaitFailure(firstStart)).isInstanceOf(IllegalStateException.class);

        consumer.setJobProcessor(job -> AsyncOperation.success(null));
        when(consumerStrategy.start()).thenReturn(AsyncOperation.success(null));

        await(consumer.start());

        verify(consumerStrategy).start();
    }

    @Test
    @DisplayName("message handler rethrows processor failure for strategy nack/retry")
    void messageHandlerRethrowsProcessorFailure() {
        AtomicReference<Consumer<EventEnvelope<?>>> registeredHandler = new AtomicReference<>();
        TranscriptionJobConsumer consumer = callbackConsumer(registeredHandler);
        consumer.setJobProcessor(job -> AsyncOperation.failure(new RuntimeException("simulated failure")));

        when(consumerStrategy.start()).thenReturn(AsyncOperation.success(null));

        await(consumer.start());

        UUID jobId = UUID.randomUUID();
        String payload = "{\"jobId\":\"" + jobId
            + "\",\"tenantId\":\"tenant-1\",\"artifactId\":\"" + UUID.randomUUID()
            + "\",\"correlationId\":\"corr-1\",\"consentStatus\":\"GRANTED\""
            + ",\"retentionPolicy\":\"STANDARD\",\"language\":\"en\""
            + ",\"modelId\":\"m1\",\"submittedAt\":\"" + Instant.now() + "\"}";
        EventEnvelope<String> envelope = envelope(jobId, "tenant-1", payload,
            "media.transcription.job.submitted");

        assertThatThrownBy(() -> registeredHandler.get().accept(envelope))
            .isInstanceOf(RuntimeException.class)
            .hasMessageContaining("simulated failure");
    }

    @Test
    @DisplayName("rejects tenant identity mismatch before invoking processor")
    void rejectsTenantMismatchBeforeProcessing() {
        AtomicReference<Consumer<EventEnvelope<?>>> registeredHandler = new AtomicReference<>();
        TranscriptionJobConsumer consumer = callbackConsumer(registeredHandler);
        AtomicBoolean processorInvoked = new AtomicBoolean();
        consumer.setJobProcessor(job -> {
            processorInvoked.set(true);
            return AsyncOperation.success(null);
        });
        when(consumerStrategy.start()).thenReturn(AsyncOperation.success(null));
        await(consumer.start());

        UUID jobId = UUID.randomUUID();
        String payload = "{\"jobId\":\"" + jobId
            + "\",\"tenantId\":\"tenant-a\",\"artifactId\":\"" + UUID.randomUUID()
            + "\",\"consentStatus\":\"GRANTED\",\"submittedAt\":\"" + Instant.now() + "\"}";

        assertThatThrownBy(() -> registeredHandler.get().accept(
            envelope(jobId, "tenant-b", payload, "media.transcription.job.submitted")))
            .isInstanceOf(RuntimeException.class)
            .hasMessageContaining("Envelope tenant does not match");
        assertThat(processorInvoked.get()).isFalse();
    }

    @Test
    @DisplayName("processes a well-formed envelope whose event and tenant identities agree")
    void processesConsistentEnvelope() {
        AtomicReference<Consumer<EventEnvelope<?>>> registeredHandler = new AtomicReference<>();
        TranscriptionJobConsumer consumer = callbackConsumer(registeredHandler);
        AtomicReference<UUID> processed = new AtomicReference<>();
        consumer.setJobProcessor(job -> {
            processed.set(job.jobId());
            return AsyncOperation.success(null);
        });
        when(consumerStrategy.start()).thenReturn(AsyncOperation.success(null));
        await(consumer.start());

        UUID jobId = UUID.randomUUID();
        String payload = "{\"jobId\":\"" + jobId
            + "\",\"tenantId\":\"tenant-a\",\"artifactId\":\"" + UUID.randomUUID()
            + "\",\"consentStatus\":\"GRANTED\",\"submittedAt\":\"" + Instant.now() + "\"}";
        registeredHandler.get().accept(
            envelope(jobId, "tenant-a", payload, "media.transcription.job.submitted"));

        assertThat(processed.get()).isEqualTo(jobId);
    }

    @Test
    @DisplayName("accepts the envelope constructed by the canonical producer")
    void processesProducerConstructedEnvelope() {
        AtomicReference<Consumer<EventEnvelope<?>>> registeredHandler = new AtomicReference<>();
        TranscriptionJobConsumer consumer = callbackConsumer(registeredHandler);
        AtomicReference<UUID> processed = new AtomicReference<>();
        consumer.setJobProcessor(job -> {
            processed.set(job.jobId());
            return AsyncOperation.success(null);
        });
        when(consumerStrategy.start()).thenReturn(AsyncOperation.success(null));
        await(consumer.start());

        TranscriptionJobProducer producer = new TranscriptionJobProducer(
            "av.jobs", producerStrategy, metricsCollector);
        AtomicReference<EventEnvelope<?>> produced = new AtomicReference<>();
        when(producerStrategy.start()).thenReturn(AsyncOperation.success(null));
        when(producerStrategy.send(any(EventEnvelope.class))).thenAnswer(invocation -> {
            EventEnvelope<?> envelope = invocation.getArgument(0);
            produced.set(envelope);
            return AsyncOperation.success(envelope.id());
        });
        await(producer.start());
        var job = new TranscriptionJobProducer.TranscriptionJobMessage(
            UUID.randomUUID(), "tenant-a", UUID.randomUUID(), "corr-1", "GRANTED",
            "STANDARD", "en", "model-1", Instant.now());
        await(producer.submitJob(job));

        registeredHandler.get().accept(produced.get());

        assertThat(processed.get()).isEqualTo(job.jobId());
    }

    @Test
    @DisplayName("bounded processing rejects excess work so strategy can retry or nack")
    void boundedProcessingRejectsWhenWorkersAndQueueAreFull() throws Exception {
        AtomicReference<Consumer<EventEnvelope<?>>> registeredHandler = new AtomicReference<>();
        ThreadPoolExecutor processing = (ThreadPoolExecutor)
            TranscriptionJobConsumer.createBoundedProcessingExecutor(1, 1);
        TranscriptionJobConsumer consumer = new TranscriptionJobConsumer("av.jobs", handler -> {
            registeredHandler.set(handler);
            return consumerStrategy;
        }, metricsCollector, processing);
        CountDownLatch firstStarted = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        consumer.setJobProcessor(job -> {
            firstStarted.countDown();
            try {
                if (!release.await(2, TimeUnit.SECONDS)) {
                    return AsyncOperation.failure(new IllegalStateException("processor release timed out"));
                }
                return AsyncOperation.success(null);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return AsyncOperation.failure(interrupted);
            }
        });
        when(consumerStrategy.start()).thenReturn(AsyncOperation.success(null));
        when(consumerStrategy.stop()).thenReturn(AsyncOperation.success(null));
        await(consumer.start());

        try (ExecutorService callbacks = Executors.newFixedThreadPool(2)) {
            var firstId = UUID.randomUUID();
            var secondId = UUID.randomUUID();
            var first = callbacks.submit(() -> registeredHandler.get().accept(
                validEnvelope(firstId, "tenant-a")));
            assertThat(firstStarted.await(1, TimeUnit.SECONDS)).isTrue();
            var second = callbacks.submit(() -> registeredHandler.get().accept(
                validEnvelope(secondId, "tenant-a")));
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
            while (processing.getQueue().size() != 1 && System.nanoTime() < deadline) {
                Thread.onSpinWait();
            }
            assertThat(processing.getQueue()).hasSize(1);

            assertThatThrownBy(() -> registeredHandler.get().accept(
                validEnvelope(UUID.randomUUID(), "tenant-a")))
                .isInstanceOf(RejectedExecutionException.class);

            release.countDown();
            first.get(1, TimeUnit.SECONDS);
            second.get(1, TimeUnit.SECONDS);
        } finally {
            release.countDown();
            await(consumer.stop());
        }
    }

    private static EventEnvelope<String> validEnvelope(UUID jobId, String tenantId) {
        String payload = "{\"jobId\":\"" + jobId + "\",\"tenantId\":\"" + tenantId
            + "\",\"artifactId\":\"" + UUID.randomUUID()
            + "\",\"consentStatus\":\"GRANTED\",\"submittedAt\":\"" + Instant.now() + "\"}";
        return envelope(jobId, tenantId, payload, "media.transcription.job.submitted");
    }

    private static EventEnvelope<String> envelope(
            UUID jobId, String tenantId, String payload, String eventType) {
        return new EventEnvelope<>(SimpleEventId.of(jobId.toString()), payload,
            Instant.now().toEpochMilli(), "av.jobs", eventType,
            EventEnvelope.DEFAULT_EVENT_VERSION, "media", tenantId, "corr-1", null,
            null, jobId.toString(), java.util.Map.of(), EventEnvelope.DEFAULT_CONTENT_TYPE);
    }

    @Test
    @DisplayName("legacy strategy constructor fails clearly because public strategy API cannot bind a handler")
    void legacyStrategyConstructorCannotBindHandler() {
        TranscriptionJobConsumer consumer = new TranscriptionJobConsumer("av.jobs", consumerStrategy, metricsCollector);
        consumer.setJobProcessor(job -> AsyncOperation.success(null));

        assertThat(awaitFailure(consumer.start()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("callback factory constructor");
    }

    private TranscriptionJobConsumer callbackConsumer(
            AtomicReference<Consumer<EventEnvelope<?>>> registeredHandler) {
        Function<Consumer<EventEnvelope<?>>, QueueConsumerStrategy> factory = handler -> {
            registeredHandler.set(handler);
            return consumerStrategy;
        };
        return new TranscriptionJobConsumer("av.jobs", factory, metricsCollector);
    }
}
