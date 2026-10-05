package com.ghatana.audio.video.infrastructure.messaging;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;
import com.ghatana.core.async.AsyncOperation;
import com.ghatana.messaging.EventEnvelope;
import com.ghatana.messaging.SimpleEventId;
import com.ghatana.messaging.strategy.QueueProducerStrategy;
import com.ghatana.observability.MetricsCollector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

/**
 * @doc.type class
 * @doc.purpose Producer for transcription job messages using platform messaging
 * @doc.layer infrastructure
 * @doc.pattern Producer
 */
public class TranscriptionJobProducer {
    
    private static final Logger LOG = LoggerFactory.getLogger(TranscriptionJobProducer.class);
    
    private enum ProducerState {
        CREATED, STARTED, STOPPED
    }
    
    private final String queueName;
    private final QueueProducerStrategy producerStrategy;
    private final MetricsCollector metricsCollector;
    private final ObjectMapper objectMapper;
    private final AtomicReference<ProducerState> state = new AtomicReference<>(ProducerState.CREATED);

    public TranscriptionJobProducer(String queueName,
                                    QueueProducerStrategy producerStrategy,
                                    MetricsCollector metricsCollector) {
        this(queueName, producerStrategy, metricsCollector, createDefaultObjectMapper());
    }

    public TranscriptionJobProducer(String queueName,
                                    QueueProducerStrategy producerStrategy,
                                    MetricsCollector metricsCollector,
                                    ObjectMapper objectMapper) {
        this.queueName = Objects.requireNonNull(queueName, "queueName cannot be null");
        this.producerStrategy = Objects.requireNonNull(producerStrategy, "producerStrategy cannot be null");
        this.metricsCollector = Objects.requireNonNull(metricsCollector, "metricsCollector cannot be null");
        this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper cannot be null");
    }

    private static ObjectMapper createDefaultObjectMapper() {
        ObjectMapper mapper = new ObjectMapper();
        return mapper;
    }
    
    /**
     * Start the producer
     */
    public AsyncOperation<Void> start() {
        if (!state.compareAndSet(ProducerState.CREATED, ProducerState.STARTED)) {
            LOG.warn("Producer already started or stopped");
            return AsyncOperation.success(null);
        }
        
        return producerStrategy.start().whenComplete((ignored, error) -> {
            if (error == null) {
                LOG.info("TranscriptionJobProducer started for queue: {}", queueName);
                metricsCollector.incrementCounter("av.messaging.producer.start",
                    "queue", queueName);
            } else {
                LOG.error("Failed to start producer: {}", queueName, error);
                state.set(ProducerState.CREATED);
            }
        });
    }
    
    /**
     * Stop the producer
     */
    public AsyncOperation<Void> stop() {
        if (!state.compareAndSet(ProducerState.STARTED, ProducerState.STOPPED)) {
            LOG.warn("Producer not in STARTED state: {}", state.get());
            return AsyncOperation.success(null);
        }
        
        return producerStrategy.stop().whenComplete((ignored, error) -> {
            if (error == null) {
                LOG.info("TranscriptionJobProducer stopped for queue: {}", queueName);
                metricsCollector.incrementCounter("av.messaging.producer.stop",
                    "queue", queueName);
            } else {
                LOG.error("Failed to stop producer: {}", queueName, error);
                state.set(ProducerState.STARTED);
            }
        });
    }

    /**
     * Submit a transcription job
     */
    public AsyncOperation<String> submitJob(TranscriptionJobMessage job) {
        Objects.requireNonNull(job, "job cannot be null");
        
        if (state.get() != ProducerState.STARTED) {
            return AsyncOperation.failure(new IllegalStateException("Producer not started"));
        }
        
        try (MDC.MDCCloseable ignored = MDC.putCloseable("jobId", job.jobId().toString())) {
            LOG.debug("Submitting transcription job: {}", job.jobId());
            
            long startTime = System.currentTimeMillis();
            String payload = serializeJob(job);
            EventEnvelope<String> envelope = createEnvelope(job, payload);
            
            return producerStrategy.send(envelope)
                .map(QueueProducerStrategy::requireMessageId)
                .map(messageId -> {
                    long latencyMs = System.currentTimeMillis() - startTime;
                    metricsCollector.incrementCounter("av.messaging.jobs.submitted",
                        "queue", queueName,
                        "tenant_id", job.tenantId());
                    metricsCollector.recordTimer("av.messaging.submit.latency_ms",
                        latencyMs,
                        "queue", queueName);
                    
                    LOG.info("Transcription job submitted: jobId={}, messageId={}", 
                        job.jobId(), messageId);
                    return messageId;
                })
                .whenComplete((ignoredResult, error) -> {
                    if (error != null) {
                        metricsCollector.incrementCounter("av.messaging.jobs.failed",
                            "queue", queueName,
                            "phase", "submit");
                        LOG.error("Failed to submit transcription job: {}", job.jobId(), error);
                    }
                });
        }
    }

    private EventEnvelope<String> createEnvelope(TranscriptionJobMessage job, String payload) {
        String mdcCorrelationId = MDC.get("correlationId");
        String correlationId = mdcCorrelationId == null || mdcCorrelationId.isBlank()
            ? job.correlationId()
            : mdcCorrelationId;
        return new EventEnvelope<>(
            SimpleEventId.of(job.jobId().toString()),
            payload,
            job.submittedAt().toEpochMilli(),
            queueName,
            "media.transcription.job.submitted",
            EventEnvelope.DEFAULT_EVENT_VERSION,
            "media",
            job.tenantId(),
            correlationId,
            null,
            job.artifactId() == null ? null : job.artifactId().toString(),
            job.jobId().toString(),
            Map.of(),
            EventEnvelope.DEFAULT_CONTENT_TYPE
        );
    }
    
    /**
     * Check if producer is healthy
     */
    public boolean isHealthy() {
        if (state.get() != ProducerState.STARTED) {
            return false;
        }
        return producerStrategy.getStatus() == QueueProducerStrategy.ProducerStatus.RUNNING;
    }
    
    private String serializeJob(TranscriptionJobMessage job) {
        try {
            return objectMapper.writeValueAsString(job);
        } catch (JacksonException e) {
            LOG.error("Failed to serialize TranscriptionJobMessage: {}", job.jobId(), e);
            throw new RuntimeException("Failed to serialize job message: " + e.getMessage(), e);
        }
    }
    
    /**
     * Transcription job message
     *
     * K3: Enhanced with Data Cloud integration fields for media processing events
     */
    public record TranscriptionJobMessage(
        UUID jobId,
        String tenantId,
        UUID artifactId,
        String correlationId,
        String consentStatus,
        String retentionPolicy,
        String language,
        String modelId,
        Instant submittedAt
    ) {
        public TranscriptionJobMessage {
            Objects.requireNonNull(jobId, "jobId cannot be null");
            Objects.requireNonNull(submittedAt, "submittedAt cannot be null");
            // tenantId, artifactId, correlationId, consentStatus, retentionPolicy, language, modelId can be null
            // and should be validated by the security validator
        }

        /** Creates a transcription job with generated identity and default governance metadata. */
        public static TranscriptionJobMessage create(String tenantId, UUID artifactId, String language) {
            return new TranscriptionJobMessage(
                UUID.randomUUID(),
                tenantId,
                artifactId,
                UUID.randomUUID().toString(),
                "GRANTED",
                "STANDARD",
                language,
                null,
                Instant.now()
            );
        }

        /** Creates a transcription job with caller-supplied governance metadata. */
        public static TranscriptionJobMessage createWithDataCloudMetadata(
                String tenantId,
                UUID artifactId,
                String correlationId,
                String consentStatus,
                String retentionPolicy,
                String language) {
            return new TranscriptionJobMessage(
                UUID.randomUUID(),
                tenantId,
                artifactId,
                correlationId,
                consentStatus,
                retentionPolicy,
                language,
                null,
                Instant.now()
            );
        }
    }
}
