package com.ghatana.audio.video.infrastructure.messaging;

import com.rabbitmq.client.Connection;
import com.rabbitmq.client.ConnectionFactory;
import com.ghatana.core.async.AsyncOperation;
import com.ghatana.testing.activej.EventloopTestBase;
import com.ghatana.messaging.strategy.rabbitmq.RabbitMQConfig;
import com.ghatana.messaging.strategy.rabbitmq.RabbitMQConsumerStrategy;
import com.ghatana.messaging.dlq.TerminalFailureSink;
import com.ghatana.observability.MetricsCollector;
import io.activej.promise.Promise;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.testcontainers.containers.RabbitMQContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;

/**
 * Integration tests for transcription job producer→consumer round-trip via RabbitMQ.
 *
 * <p>Covers:
 * <ul>
 *   <li>Happy-path: message produced → consumed, payload verified</li>
 *   <li>Retry: consumer nack → requeue → re-delivered</li>
 *   <li>DLQ: messages exceeding x-death-count are dead-lettered</li>
 *   <li>Idempotency: duplicate jobId is processed exactly once by a deduplication guard</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose RabbitMQ integration tests for transcription messaging flow (AV-P0-04)
 * @doc.layer test
 * @doc.pattern IntegrationTest
 */
@Testcontainers
@ExtendWith(MockitoExtension.class)
@DisplayName("Transcription Messaging Integration Tests (AV-P0-04)")
class TranscriptionMessagingIT extends EventloopTestBase {

    private static final int MAX_DELIVERY_ATTEMPTS = 2;

    @Container
    static final RabbitMQContainer RABBIT = new RabbitMQContainer(
            DockerImageName.parse("rabbitmq:3.13-management-alpine"));

    @Mock
    private MetricsCollector metricsCollector;

    private TranscriptionJobProducer producer;
    private TranscriptionJobConsumer consumer;
    private String queueName;
    private String dlqName;

    @BeforeEach
    void setUp() throws Exception {
        lenient().doNothing().when(metricsCollector).incrementCounter(anyString(), any(String[].class));
        lenient().doNothing().when(metricsCollector).recordTimer(anyString(), anyLong(), any(String[].class));

        String queueSuffix = UUID.randomUUID().toString();
        queueName = "av.jobs." + queueSuffix;
        dlqName = queueName + ".dlq";
        String deadLetterExchange = "dlx." + queueSuffix;

        // Declare queues with DLQ wiring via direct AMQP connection
        ConnectionFactory factory = new ConnectionFactory();
        factory.setHost(RABBIT.getHost());
        factory.setPort(RABBIT.getAmqpPort());
        factory.setUsername("guest");
        factory.setPassword("guest");
        factory.setVirtualHost("/");
        try (Connection conn = factory.newConnection();
             com.rabbitmq.client.Channel ch = conn.createChannel()) {
            ch.exchangeDeclare(deadLetterExchange, "direct", true);
            ch.queueDeclare(dlqName, true, false, false, java.util.Map.of());
            ch.queueBind(dlqName, deadLetterExchange, queueName);
            ch.queueDeclare(queueName, true, false, false, java.util.Map.of(
                    "x-dead-letter-exchange", deadLetterExchange,
                    "x-dead-letter-routing-key", queueName
            ));
        }

        RabbitMQConfig config = RabbitMQConfig.builder()
                .host(RABBIT.getHost())
                .port(RABBIT.getAmqpPort())
                .username("guest")
                .password("guest")
                .virtualHost("/")
                .queueName(queueName)
                .maxDeliveryAttempts(MAX_DELIVERY_ATTEMPTS)
                .build();

        producer = new TranscriptionJobProducer(queueName,
                new com.ghatana.messaging.strategy.rabbitmq.RabbitMQProducerStrategy(config),
                metricsCollector);

        TerminalFailureSink terminalFailureSink = TerminalFailureSink.of(
            TerminalFailureSink.Durability.DURABLE,
            failure -> TerminalFailureSink.DeliveryResult.DELIVERED);
        consumer = new TranscriptionJobConsumer(
            queueName,
            handler -> new RabbitMQConsumerStrategy(config, handler, terminalFailureSink),
            metricsCollector);
    }

    @AfterEach
    void tearDown() {
        try {
            if (producer != null) {
                runOperation(producer::stop);
            }
        } catch (Exception ignored) {
        }
        try {
            if (consumer != null) {
                runOperation(consumer::stop);
            }
        } catch (Exception ignored) {
        }
    }

    @Test
    @DisplayName("Should deliver message from producer to consumer (happy path)")
    void shouldDeliverMessageRoundTrip() throws InterruptedException {
        List<TranscriptionJobProducer.TranscriptionJobMessage> received =
                Collections.synchronizedList(new ArrayList<>());
        CountDownLatch latch = new CountDownLatch(1);

        consumer.setJobProcessor(job -> {
            received.add(job);
            latch.countDown();
            return AsyncOperation.success(null);
        });

        runOperation(producer::start);
        runOperation(consumer::start);

        TranscriptionJobProducer.TranscriptionJobMessage job =
                new TranscriptionJobProducer.TranscriptionJobMessage(
                        UUID.randomUUID(), "tenant-1", UUID.randomUUID(), "correlation-123", "GRANTED", "STANDARD", "en", "whisper-large-v3", Instant.now());

        String messageId = runOperation(() -> producer.submitJob(job));
        assertThat(messageId).isNotNull();

        boolean delivered = latch.await(10, TimeUnit.SECONDS);
        assertThat(delivered).isTrue();
        assertThat(received).hasSize(1);
        assertThat(received.get(0).jobId()).isEqualTo(job.jobId());
        assertThat(received.get(0).tenantId()).isEqualTo("tenant-1");
    }

    @Test
    @DisplayName("Should re-deliver on consumer nack (retry path)")
    void shouldRetryOnConsumerFailure() throws InterruptedException {
        AtomicInteger deliveryCount = new AtomicInteger(0);
        CountDownLatch latch = new CountDownLatch(2); // expect 2 deliveries

        consumer.setJobProcessor(job -> {
            int count = deliveryCount.incrementAndGet();
            latch.countDown();
            if (count == 1) {
                // Simulate failure on first delivery — triggers nack+requeue
                return AsyncOperation.failure(new RuntimeException("simulated processing failure"));
            }
            return AsyncOperation.success(null);
        });

        runOperation(producer::start);
        runOperation(consumer::start);

        TranscriptionJobProducer.TranscriptionJobMessage job =
                new TranscriptionJobProducer.TranscriptionJobMessage(
                        UUID.randomUUID(), "tenant-retry", UUID.randomUUID(), "correlation-456", "GRANTED", "STANDARD", "en", "whisper-large-v3", Instant.now());

        runOperation(() -> producer.submitJob(job));

        boolean delivered = latch.await(15, TimeUnit.SECONDS);
        assertThat(delivered).isTrue();
        assertThat(deliveryCount.get()).isGreaterThanOrEqualTo(2);
    }

    @Test
    @DisplayName("Should route poison messages to DLQ after max delivery count")
    void shouldDeadLetterPoisonMessage() throws Exception {
        AtomicInteger deliveryCount = new AtomicInteger(0);

        // Consumer always fails → strategy retries up to MAX_DELIVERY_ATTEMPTS, then dead-letters
        consumer.setJobProcessor(job -> {
            deliveryCount.incrementAndGet();
            return AsyncOperation.failure(new RuntimeException("always fails — DLQ test"));
        });

        // Subscribe to DLQ via direct AMQP channel
        ConnectionFactory factory = new ConnectionFactory();
        factory.setHost(RABBIT.getHost());
        factory.setPort(RABBIT.getAmqpPort());
        factory.setUsername("guest");
        factory.setPassword("guest");
        factory.setVirtualHost("/");

        List<String> dlqMessages = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch dlqLatch = new CountDownLatch(1);

        Connection dlqConn = factory.newConnection();
        com.rabbitmq.client.Channel dlqChannel = dlqConn.createChannel();
        dlqChannel.basicConsume(dlqName, true,
                (tag, delivery) -> {
                    dlqMessages.add(new String(delivery.getBody(), StandardCharsets.UTF_8));
                    dlqLatch.countDown();
                },
                tag -> { });

        runOperation(producer::start);
        runOperation(consumer::start);

        TranscriptionJobProducer.TranscriptionJobMessage job =
                new TranscriptionJobProducer.TranscriptionJobMessage(
                        UUID.randomUUID(), "tenant-dlq", UUID.randomUUID(), "correlation-dlq", "GRANTED", "STANDARD", "en", "whisper-large-v3", Instant.now());

        runOperation(() -> producer.submitJob(job));

        boolean receivedInDlq = dlqLatch.await(30, TimeUnit.SECONDS);
        assertThat(receivedInDlq).isTrue();
        assertThat(dlqMessages).hasSize(1);
        assertThat(deliveryCount.get()).isEqualTo(MAX_DELIVERY_ATTEMPTS);

        dlqChannel.close();
        dlqConn.close();
    }

    @Test
    @DisplayName("Duplicate jobId should be processed idempotently via seen-set guard")
    void shouldProcessDuplicateJobIdOnlyOnce() throws InterruptedException {
        // Idempotency guard: consumer tracks seen job IDs in a concurrent set
        java.util.Set<UUID> seen = Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());
        AtomicInteger processedCount = new AtomicInteger(0);
        CountDownLatch latch = new CountDownLatch(1);

        consumer.setJobProcessor(job -> {
            if (seen.add(job.jobId())) {
                processedCount.incrementAndGet();
                latch.countDown();
            }
            return AsyncOperation.success(null);
        });

        runOperation(producer::start);
        runOperation(consumer::start);

        UUID jobId = UUID.randomUUID();
        TranscriptionJobProducer.TranscriptionJobMessage job =
                new TranscriptionJobProducer.TranscriptionJobMessage(
                        jobId, "tenant-dedup", UUID.randomUUID(), "correlation-dedup", "GRANTED", "STANDARD", "en", "whisper-large-v3", Instant.now());

        // Submit same job twice
        runOperation(() -> producer.submitJob(job));
        runOperation(() -> producer.submitJob(job));

        boolean delivered = latch.await(10, TimeUnit.SECONDS);
        assertThat(delivered).isTrue();

        // Allow a brief window for potential duplicate delivery
        Thread.sleep(500);
        assertThat(processedCount.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("Data Cloud media event contract includes required metadata")
    void shouldIncludeDataCloudMetadataInEventContract() {
        // K3: Test that media event bridge contract includes Data Cloud metadata
        String tenantId = "tenant-123";
        UUID artifactId = UUID.randomUUID();
        String correlationId = UUID.randomUUID().toString();
        String consentStatus = "GRANTED";
        String retentionPolicy = "STANDARD";
        String language = "en-US";

        TranscriptionJobProducer.TranscriptionJobMessage message =
            TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                tenantId,
                artifactId,
                correlationId,
                consentStatus,
                retentionPolicy,
                language
            );

        assertThat(message.tenantId()).isEqualTo(tenantId);
        assertThat(message.artifactId()).isEqualTo(artifactId);
        assertThat(message.correlationId()).isEqualTo(correlationId);
        assertThat(message.consentStatus()).isEqualTo(consentStatus);
        assertThat(message.retentionPolicy()).isEqualTo(retentionPolicy);
        assertThat(message.language()).isEqualTo(language);
        assertThat(message.jobId()).isNotNull();
        assertThat(message.submittedAt()).isNotNull();
        assertThat(message.submittedAt()).isBefore(Instant.now().plusSeconds(1));
    }

    @Test
    @DisplayName("default message creation includes Data Cloud metadata")
    void shouldIncludeDataCloudMetadataInDefaultCreation() {
        // K3: Verify that default creation method includes required metadata
        String tenantId = "tenant-456";
        UUID artifactId = UUID.randomUUID();
        String language = "es-ES";

        TranscriptionJobProducer.TranscriptionJobMessage message =
            TranscriptionJobProducer.TranscriptionJobMessage.create(tenantId, artifactId, language);

        assertThat(message.tenantId()).isEqualTo(tenantId);
        assertThat(message.artifactId()).isEqualTo(artifactId);
        assertThat(message.correlationId()).isNotNull();
        assertThat(message.consentStatus()).isEqualTo("GRANTED");
        assertThat(message.retentionPolicy()).isEqualTo("STANDARD");
        assertThat(message.language()).isEqualTo(language);
    }

    @Test
    @DisplayName("message contract is serializable for event bridge")
    void shouldBeSerializableForEventBridge() {
        // K3: Verify that the message can be serialized for event bridge transmission
        TranscriptionJobProducer.TranscriptionJobMessage message =
            TranscriptionJobProducer.TranscriptionJobMessage.createWithDataCloudMetadata(
                "tenant-789",
                UUID.randomUUID(),
                UUID.randomUUID().toString(),
                "GRANTED",
                "STANDARD",
                "fr-FR"
            );

        // Verify all required fields are present for serialization
        assertThat(message.jobId()).isNotNull();
        assertThat(message.tenantId()).isNotNull();
        assertThat(message.artifactId()).isNotNull();
        assertThat(message.correlationId()).isNotNull();
        assertThat(message.consentStatus()).isNotNull();
        assertThat(message.retentionPolicy()).isNotNull();
        assertThat(message.submittedAt()).isNotNull();
    }

    private <T> T runOperation(Supplier<AsyncOperation<T>> supplier) {
        return runPromise(() -> Promise.ofCallback(callback -> {
            AsyncOperation<T> operation = supplier.get();
            operation.whenComplete((value, error) -> callback.accept(
                value,
                error == null ? null : error instanceof Exception exception
                    ? exception
                    : new RuntimeException(error)
            ));
        }));
    }
}
