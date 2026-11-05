# Surface: `modules-infrastructure-messaging`

Prepared Media-specific broker integration (`modules/infrastructure/
messaging`). It is an adapter over the message broker — **not** a
competing Event Plane or Shared messaging engine. Production
publication/finality must use the owning platform's admitted interface
and independently verified effects.

## Responsibility

- `TranscriptionJobProducer` — publishes transcription job messages to
  the broker.
- `TranscriptionJobConsumer` — consumes and dispatches transcription jobs
  for execution.
- `MediaLifecycleEventConsumer` — validates the versioned public lifecycle
  envelope, authorizes observations, and delegates replay/version fencing to
  an injected atomic projection store.

## Public operations

| Class | Role |
| --- | --- |
| `TranscriptionJobProducer` | Broker publication of transcription job messages |
| `TranscriptionJobConsumer` | Broker consumption and dispatch to execution |
| `MediaLifecycleEventConsumer` | Public v1 event validation, auth, dedupe/order and separate terminal readback |

## States and invariants

- The callback-bound consumer uses a bounded executor: at most
  `min(8, availableProcessors)` workers and a 128-message queue; when
  both are full, dispatch propagates callback rejection to the configured
  queue strategy.
- Whether that strategy retries, nacks or acknowledges must be verified
  against the actual strategy and broker — the in-memory tests do **not**
  establish broker acknowledgement semantics.
- Lifecycle event append and consumer projection are nonfinal observations.
  `ProjectionStore` must provide durable atomic event-ID dedupe and
  aggregate-version fencing in the host integration. A terminal-shaped event
  sets `terminalReadbackRequired`; only the separately authorized
  `TerminalJobReadback` can report a terminal job state.
- The public typed v1 consumer is not wired into the legacy map-payload
  outbox rows or an admitted broker subscription yet. Existing outbox relay
  acceptance records broker publication only. Consumer retries, durable
  checkpoints and source-row migration remain integration prerequisites.
- Executor limits are code defaults, not yet wired to the
  `messaging.consumer.concurrency` setting.

## Dependencies and configuration

```properties
messaging.broker.url=amqp://localhost:5672
messaging.queue.transcription=audio-video.transcription.jobs
```

Consumed by `stt-service` and `multimodal-service`; the owning platform
messaging contracts remain authoritative for production publication.

## Errors

Callback rejection propagates to the queue strategy; no fabricated
delivery/finality claims — ambiguous publication stays unresolved at the
broker boundary.

## Tests and commands

```bash
./gradlew :services:media:modules:infrastructure:messaging:test
```

Coverage: producer/consumer dispatch, bounded-executor backpressure,
strategy rejection propagation. Broker-level ack/retry semantics are
explicitly unverified by the in-memory suite.
