# infrastructure/messaging

Message-broker integration for the Audio-Video platform.

## Purpose

Provides producer and consumer implementations for the transcription job queue. Decouples request ingestion from asynchronous transcription execution.

## Layer

`infrastructure` — adapter over the message broker; no domain logic. Consumed by `stt-service` and `multimodal-service`.

## Key Components

| Class | Responsibility |
|---|---|
| `TranscriptionJobProducer` | Publishes transcription job messages to the broker |
| `TranscriptionJobConsumer` | Consumes and dispatches transcription jobs for execution |

## Configuration

```properties
messaging.broker.url=amqp://localhost:5672
messaging.queue.transcription=audio-video.transcription.jobs
messaging.consumer.concurrency=4
```

## Dependencies

- AMQP / Kafka client (depending on broker configuration in `libs/java/common`)
- `platform:java:observability` — metrics for queue depth and consumer lag

## Testing

```bash
./gradlew :services:media:modules:infrastructure:messaging:test
```

Integration tests use Testcontainers with a RabbitMQ or Kafka image.
