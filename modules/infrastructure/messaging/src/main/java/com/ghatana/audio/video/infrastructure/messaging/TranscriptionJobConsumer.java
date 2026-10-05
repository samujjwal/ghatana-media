package com.ghatana.audio.video.infrastructure.messaging;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;
import com.ghatana.core.async.AsyncOperation;
import com.ghatana.messaging.EventEnvelope;
import com.ghatana.messaging.strategy.QueueConsumerStrategy;
import com.ghatana.observability.MetricsCollector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.util.Objects;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * @doc.type class
 * @doc.purpose Consumer for transcription job messages using platform messaging
 * @doc.layer infrastructure
 * @doc.pattern Consumer
 */
public class TranscriptionJobConsumer {
    
    private static final Logger LOG = LoggerFactory.getLogger(TranscriptionJobConsumer.class);
    
    private enum ConsumerState {
        CREATED, STARTED, STOPPED
    }
    
    private final String queueName;
    private final QueueConsumerStrategy consumerStrategy;
    private final MetricsCollector metricsCollector;
    private final ObjectMapper objectMapper;
    private final ExecutorService processingExecutor;
    private final boolean handlerBoundAtConstruction;
    private final AtomicReference<ConsumerState> state = new AtomicReference<>(ConsumerState.CREATED);
    private Function<TranscriptionJobProducer.TranscriptionJobMessage, AsyncOperation<Void>> jobProcessor;
    
    public TranscriptionJobConsumer(String queueName,
                                    QueueConsumerStrategy consumerStrategy,
                                    MetricsCollector metricsCollector) {
        this(queueName, consumerStrategy, metricsCollector,
            createDefaultObjectMapper(),
            Executors.newVirtualThreadPerTaskExecutor());
    }

    public TranscriptionJobConsumer(String queueName,
                                    QueueConsumerStrategy consumerStrategy,
                                    MetricsCollector metricsCollector,
                                    ObjectMapper objectMapper) {
        this(queueName, consumerStrategy, metricsCollector,
            objectMapper,
            Executors.newVirtualThreadPerTaskExecutor());
    }
    
    public TranscriptionJobConsumer(String queueName,
                                    QueueConsumerStrategy consumerStrategy,
                                    MetricsCollector metricsCollector,
                                    ExecutorService processingExecutor) {
        this(queueName, consumerStrategy, metricsCollector,
            createDefaultObjectMapper(),
            processingExecutor);
    }

    /** Creates a consumer with an explicit object mapper and processing executor. */
    public TranscriptionJobConsumer(String queueName,
                                    QueueConsumerStrategy consumerStrategy,
                                    MetricsCollector metricsCollector,
                                    ObjectMapper objectMapper,
                                    ExecutorService processingExecutor) {
        this.queueName = Objects.requireNonNull(queueName, "queueName cannot be null");
        this.consumerStrategy = Objects.requireNonNull(consumerStrategy, "consumerStrategy cannot be null");
        this.metricsCollector = Objects.requireNonNull(metricsCollector, "metricsCollector cannot be null");
        this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper cannot be null");
        this.processingExecutor = Objects.requireNonNull(processingExecutor, "processingExecutor cannot be null");
        this.handlerBoundAtConstruction = false;
    }

    /**
     * Creates a consumer around a canonical constructor-bound queue strategy.
     */
    public TranscriptionJobConsumer(
            String queueName,
            Function<Consumer<EventEnvelope<?>>, QueueConsumerStrategy> consumerStrategyFactory,
            MetricsCollector metricsCollector) {
        this.queueName = Objects.requireNonNull(queueName, "queueName cannot be null");
        this.metricsCollector = Objects.requireNonNull(metricsCollector, "metricsCollector cannot be null");
        this.objectMapper = createDefaultObjectMapper();
        this.processingExecutor = Executors.newVirtualThreadPerTaskExecutor();
        Function<Consumer<EventEnvelope<?>>, QueueConsumerStrategy> checkedFactory =
            Objects.requireNonNull(consumerStrategyFactory, "consumerStrategyFactory cannot be null");
        this.consumerStrategy = Objects.requireNonNull(
            checkedFactory.apply(this::dispatchEnvelope),
            "consumerStrategyFactory cannot return null");
        this.handlerBoundAtConstruction = true;
    }

    private static ObjectMapper createDefaultObjectMapper() {
        ObjectMapper mapper = new ObjectMapper();
        return mapper;
    }
    
    /**
     * Set the job processor function
     */
    public void setJobProcessor(Function<TranscriptionJobProducer.TranscriptionJobMessage, AsyncOperation<Void>> processor) {
        this.jobProcessor = Objects.requireNonNull(processor, "processor cannot be null");
    }
    
    /**
     * Start consuming messages
     */
    public AsyncOperation<Void> start() {
        if (jobProcessor == null) {
            return AsyncOperation.failure(new IllegalStateException("Job processor not set"));
        }
        if (!handlerBoundAtConstruction && !consumerStrategy.supportsMessageHandlerRegistration()) {
            return AsyncOperation.failure(new IllegalStateException(
                "Consumer strategy does not support message handler registration"));
        }

        if (!state.compareAndSet(ConsumerState.CREATED, ConsumerState.STARTED)) {
            LOG.warn("Consumer already started or stopped");
            return AsyncOperation.success(null);
        }

        if (!handlerBoundAtConstruction) {
            consumerStrategy.setMessageHandler(this::dispatchEnvelope);
        }

        return consumerStrategy.start().whenComplete((ignored, error) -> {
            if (error == null) {
                LOG.info("TranscriptionJobConsumer started for queue: {}", queueName);
                metricsCollector.incrementCounter("av.messaging.consumer.start",
                    "queue", queueName);
                LOG.debug("Consumer strategy started with canonical envelope callback wiring");
            } else {
                LOG.error("Failed to start consumer: {}", queueName, error);
                state.set(ConsumerState.CREATED);
            }
        });
    }
    
    /**
     * Stop consuming messages
     */
    public AsyncOperation<Void> stop() {
        if (!state.compareAndSet(ConsumerState.STARTED, ConsumerState.STOPPED)) {
            LOG.warn("Consumer not in STARTED state: {}", state.get());
            return AsyncOperation.success(null);
        }
        
        return consumerStrategy.stop().whenComplete((ignored, error) -> {
            if (error == null) {
                LOG.info("TranscriptionJobConsumer stopped for queue: {}", queueName);
                metricsCollector.incrementCounter("av.messaging.consumer.stop",
                    "queue", queueName);
                processingExecutor.shutdown();
            } else {
                LOG.error("Failed to stop consumer: {}", queueName, error);
                state.set(ConsumerState.STARTED);
            }
        });
    }
    
    private AsyncOperation<Void> processMessage(String key, String payload) {
        long startTime = System.currentTimeMillis();

        try {
            // Parse the job message
            TranscriptionJobProducer.TranscriptionJobMessage job = parseJob(payload);

            // K3: Validate Data Cloud metadata before processing
            if (job.consentStatus() == null || !"GRANTED".equals(job.consentStatus())) {
                LOG.warn("Transcription job rejected due to consent status: jobId={}, consentStatus={}",
                    job.jobId(), job.consentStatus());
                metricsCollector.incrementCounter("av.messaging.jobs.rejected",
                    "queue", queueName,
                    "tenant_id", job.tenantId(),
                    "reason", "consent");
                return AsyncOperation.success(null);
            }

            try (MDC.MDCCloseable ignored = MDC.putCloseable("jobId", job.jobId().toString())) {
                MDC.put("tenantId", job.tenantId());
                MDC.put("artifactId", job.artifactId().toString());
                MDC.put("correlationId", job.correlationId() != null ? job.correlationId() : "unknown");

                LOG.debug("Processing transcription job: jobId={}, artifactId={}", job.jobId(), job.artifactId());

                return jobProcessor.apply(job).whenComplete((ignoredResult, error) -> {
                    if (error == null) {
                        long latencyMs = System.currentTimeMillis() - startTime;
                        metricsCollector.incrementCounter("av.messaging.jobs.processed",
                            "queue", queueName,
                            "tenant_id", job.tenantId(),
                            "status", "success");
                        metricsCollector.recordTimer("av.messaging.process.latency_ms",
                            latencyMs,
                            "queue", queueName);

                        LOG.info("Transcription job completed: jobId={}, artifactId={}", job.jobId(), job.artifactId());
                    } else {
                        metricsCollector.incrementCounter("av.messaging.jobs.failed",
                            "queue", queueName,
                            "tenant_id", job.tenantId(),
                            "phase", "process");
                        LOG.error("Failed to process transcription job: jobId={}, artifactId={}",
                            job.jobId(), job.artifactId(), error);
                    }
                });
            }
        } catch (Exception e) {
            LOG.error("Failed to parse message: key={}", key, e);
            metricsCollector.incrementCounter("av.messaging.jobs.failed",
                "queue", queueName,
                "phase", "parse");
            return AsyncOperation.failure(e);
        }
    }
    
    private TranscriptionJobProducer.TranscriptionJobMessage parseJob(String payload) {
        try {
            return objectMapper.readValue(payload, TranscriptionJobProducer.TranscriptionJobMessage.class);
        } catch (JacksonException e) {
            LOG.error("Failed to deserialize TranscriptionJobMessage — payload may be malformed: {}", e.getMessage());
            throw new IllegalArgumentException("Malformed transcription job message: " + e.getMessage(), e);
        }
    }
    
    /**
     * Check if consumer is healthy
     */
    public boolean isHealthy() {
        if (state.get() != ConsumerState.STARTED) {
            return false;
        }
        return consumerStrategy.isRunning();
    }

    private void dispatchEnvelope(EventEnvelope<?> envelope) {
        try {
            processingExecutor.submit(() -> processMessageOrThrow(envelope)).get();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("Consumer message processing interrupted", interrupted);
        } catch (ExecutionException failed) {
            Throwable cause = failed.getCause() == null ? failed : failed.getCause();
            throw cause instanceof RuntimeException runtimeFailure
                ? runtimeFailure
                : new RuntimeException(cause);
        }
    }

    private void processMessageOrThrow(EventEnvelope<?> envelope) {
        AsyncOperation<Void> operation = processMessage(envelope.id(), payloadText(envelope));
        CompletableFuture<Void> completion = new CompletableFuture<>();
        operation.whenComplete((value, error) -> {
            if (error == null) {
                completion.complete(value);
            } else {
                completion.completeExceptionally(error);
            }
        });
        try {
            completion.get();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("Consumer message processing interrupted", interrupted);
        } catch (ExecutionException failed) {
            Throwable cause = failed.getCause() == null ? failed : failed.getCause();
            throw cause instanceof RuntimeException runtimeFailure
                ? runtimeFailure
                : new RuntimeException(cause);
        }
    }

    private static String payloadText(EventEnvelope<?> envelope) {
        Object payload = envelope.payload();
        if (payload instanceof String text) {
            return text;
        }
        if (payload instanceof byte[] bytes) {
            return new String(bytes, StandardCharsets.UTF_8);
        }
        if (payload instanceof ByteBuffer buffer) {
            ByteBuffer copy = buffer.asReadOnlyBuffer();
            byte[] bytes = new byte[copy.remaining()];
            copy.get(bytes);
            return new String(bytes, StandardCharsets.UTF_8);
        }
        throw new IllegalArgumentException(
            "Transcription job payload must be String, byte[], or ByteBuffer, but was "
                + payload.getClass().getName());
    }
}
