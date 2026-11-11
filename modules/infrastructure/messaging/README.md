# Media Infrastructure — Messaging Adapter

Prepared Media-specific broker integration source; not a competing Event Plane or Shared messaging engine. Production publication/finality must use the owning platform's admitted interface and independently verified effects.

## Vision, consumers, and non-goals

This module keeps Media lifecycle intent durable and observable across broker
delivery without treating broker acknowledgement as consumer application, job
finality, or provider effect. Its consumers are Media runtime hosts and
authorized lifecycle projection consumers. The module adapts Shared messaging
primitives; it does not own a broker, durable outbox, durable projection store,
job state, provider effects, or Event Plane admission.

## Requirements and public contracts

`MediaLifecycleOutboxRelay` is the public adapter entry point. It uses Shared
`OutboxPublicationSource`, `ClaimedOutboxPublisher`, and `EventBusPort`, with the
stable `media-lifecycle` topic, `media-runtime` source identity, and lifecycle
v1 schema URI. The source must append intent in the same transaction as the
owning state change, persist fenced claims and publication attempts, and make
unacknowledged events retryable with their original identity. The relay's
published count means broker acceptance was durably recorded only.

`MediaLifecycleEventConsumer` validates the public v1 envelope and payload,
redacts identifiers, authorizes projection, and requires idempotent,
aggregate-version-aware projection storage. Projection failures are
`CONSUMPTION_UNKNOWN`; terminal job status requires separate authorized durable
readback. Existing legacy payload families still require an owner-approved
mapping and drain protocol before they can be combined or suppressed.

## Architecture and design

The module is an adapter layer. Durable claim/attempt/retry state belongs to the
PostgreSQL provider; broker acceptance belongs to the Shared publisher/broker
boundary; consumer receipts belong to the projection store; job finality belongs
to the canonical job store. All boundaries use stable event identity and keep
append, delivery, consumption, and effect facts distinct. Extension points are
the Shared source, event bus, authorization, redaction, projection, and terminal
readback ports. No provider or broker implementation should be added here.

## Example

Construct `MediaLifecycleOutboxRelay` with the durable source, `EventBusPort`,
owner identity, bounded batch size, lease duration, diagnostics, and a clock;
call `runOnce()` and persist broker acceptance through the source. A successful
batch does not confirm a consumer effect or terminal job state.

## Evidence and known gaps

The deterministic module tests cover relay replay after lost acknowledgement,
expired lease handling, envelope parity, consumer idempotency, ordering,
authorization, and non-final append semantics. They do not prove a real broker,
durable consumer receipt store, Event Plane receipt, or legacy-family migration.
Use the module test task below and the provider's H2/PostgreSQL source tests;
repository-native path-scoped convergence evidence is not currently registered
for this adapter.

## Purpose

Provides producer and consumer implementations for the transcription job queue. Decouples request ingestion from asynchronous transcription execution.

`MediaLifecycleOutboxRelay` binds the Shared `OutboxPublicationSource` and
`ClaimedOutboxPublisher` to Media's stable `media-lifecycle` topic, source
identity, and schema URI. The source must append lifecycle intent in the same
transaction as its owning state change and implement durable claim leases,
attempt/readback state, retry eligibility/backoff, and fenced acknowledgements.
The relay publishes one claimed batch at a time and persists broker acceptance
before returning a published count. A publish or acknowledgement failure keeps
the event eligible for retry with its original event ID, so broker delivery is
at least once. A publisher result does not mean a consumer applied the event or
that a job reached a terminal state.

This module does not own the durable event store, consumer-effect receipts, or
job finality. Its in-memory relay tests cover lost acknowledgement replay and
expired-lease fail-closed behavior; provider integration tests own persistence,
concurrent claims, and restart recovery. Durable retry/backoff eligibility and
consumer-effect deduplication remain separate source/consumer responsibilities
and are not implied by broker delivery.

The public lifecycle consumer validates the v1 schema/envelope binding, redacted
identifier shape, bounded aggregate/classification vocabulary, consumer
authorization, replay, and aggregate-version ordering. Projection persistence
must atomically deduplicate `(tenant, eventRef)` and reject stale aggregate
versions across restarts. An exception during projection is surfaced as
`CONSUMPTION_UNKNOWN`: the host must redeliver or reconcile through that
idempotent store before claiming consumption. Authorization failure/unavailability
occurs before projection. A terminal-shaped event is still a
`NON_FINAL_APPEND`; only an independently authorized terminal-job readback can
confirm a terminal status. A missing or failed readback is `UNAVAILABLE`, not
success. Event delivery, consumer application, job status, and provider effect
receipts remain distinct facts.

This consumer is a typed adapter boundary, not a broker subscription or durable
projection implementation. Existing legacy outbox payloads do not yet carry the
public v1 projection, and no admitted host wiring, durable consumer receipt
store, or migration/reconciliation protocol is included here. The tests use
in-memory ports and establish state-machine behavior only.

## Layer

`infrastructure` — adapter over the message broker; no domain logic. Consumed by `stt-service` and `multimodal-service`.

## Key Components

| Class | Responsibility |
|---|---|
| `TranscriptionJobProducer` | Publishes transcription job messages to the broker |
| `TranscriptionJobConsumer` | Consumes and dispatches transcription jobs for execution |
| `MediaLifecycleOutboxRelay` | Binds Media lifecycle events to Shared's durable claim-aware publisher |

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
