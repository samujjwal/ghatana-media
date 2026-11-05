# Logical surface: `media.surface.events`

Lifecycle event channel. Physical owners:
`modules/infrastructure/messaging` (broker adapter) and
`runtime-contracts` (`MediaLifecycleEvent`,
`MediaLifecycleEventPublisher`, `MediaLifecycleOutboxSource`,
`MediaLifecycleProjection`).

## Supported operations

Versioned lifecycle event schema; transactional-outbox publication;
ordered idempotent consumption. Distinct states: appended ≠ delivered ≠
effected ≠ final — each is reported truthfully, never collapsed.

## States and invariants

- Events project canonical Media attempts/jobs — they are not an
  independent job-status authority (same boundary as the ledger
  adapter).
- Publication/finality must use the owning platform's admitted
  interface; the messaging module is a prepared adapter, not a
  competing Event Plane.
- Broker ack/retry/nack semantics are strategy-dependent and
  unverified by in-memory tests; ambiguous publication stays
  unresolved.
- Postgres outbox source (`PostgresqlMediaLifecycleOutboxSource`,
  `PostgresqlMediaOutboxPublicationSource`) provides the durable side.

## Dependencies

`messaging.broker.url`/`messaging.queue.transcription` config;
`runtime-contracts` event types; `providers/aws-postgresql` outbox
stores.

## Errors

Callback rejection propagates to queue strategy; consumers must be
idempotent on redelivery.

## Tests

`./gradlew :services:media:modules:infrastructure:messaging:test`;
runtime-contracts outbox/event contract tests; publisher/consumer
integration coverage where broker fixtures exist.
