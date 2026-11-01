# Media Infrastructure — Messaging Adapter

Prepared Media-specific broker integration source; not a competing Event Plane or Shared messaging engine. Production publication/finality must use the owning platform's admitted interface and independently verified effects.

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
```

The callback-bound consumer currently uses a bounded executor with at most
`min(8, available processors)` workers and a queue of 128 messages. When both
are full, dispatch propagates callback rejection to the configured queue
strategy. Whether that strategy retries, nacks, or acknowledges the delivery
must be verified against the actual strategy and broker; the in-memory tests
do not establish broker acknowledgement semantics. These executor limits are
defaults in code, not yet wired to the `messaging.consumer.concurrency` setting.

## Dependencies

- AMQP / Kafka client (depending on broker configuration in `libs/java/common`)
- `platform:java:observability` — metrics for queue depth and consumer lag

## Testing

```bash
./gradlew :services:media:modules:infrastructure:messaging:test
```

Integration tests use Testcontainers with a RabbitMQ or Kafka image.
