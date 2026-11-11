# Media AWS and PostgreSQL Providers

## Vision, consumers, and non-goals

This provider package supplies durable PostgreSQL runtime state and S3 object
storage for Media. The transactional lifecycle outbox is one provider-owned
persistence boundary consumed by the Media runtime and messaging relay. This
package does not own lifecycle event semantics, broker delivery, consumer
effects, canonical job finality, Event Plane admission, or production cutover.

## Requirements and contracts

Lifecycle append must occur in the same database transaction as its owning job
or attempt transition. Claims are leased and fenced before external publication;
acknowledgement, retry/backoff, and dead-letter state are persisted separately
from job outcome. The repository currently contains two historical families:
`media_lifecycle_outbox` (V011/V014) and
`media_processing_lifecycle_outbox` (V016/V018). V016/V018 is wired through
`MediaLifecycleOutboxSource`; V011/V014 is used by the Shared publication
source. Their event identity/version mapping and safe drain protocol remain
unresolved and must not be inferred from similar names.

## Architecture and design

The provider exposes runtime interfaces from `runtime-contracts` and stores
state in PostgreSQL with Flyway migrations under
`src/main/resources/db/media-runtime`. `PostgresqlMediaLifecycleOutboxSource`
claims V016 rows using `FOR UPDATE SKIP LOCKED`, publishes outside the claim
transaction, and persists fenced acknowledgement or bounded retry state.
`PostgresqlMediaOutboxPublicationSource` appends and claims the V011 family in
caller-owned transactions. Provider calls are not evidence that a broker or
consumer effect was admitted.

## Configuration and migration boundary

Provider configuration uses the repository's Media PostgreSQL/S3 runtime
environment. Migrations are append-only and applied history is authoritative;
do not reorder or rewrite V011/V014/V016/V018. Run this provider against an
isolated development store. The legacy Media process remains the only active
writer until separately verified cutover; this package does not establish a
production migration or ownership transfer.

## Example

Construct `PostgresqlMediaLifecycleOutboxSource` from the configured provider,
pass a ready `MediaLifecycleEventPublisher` to `publishPending`, then inspect
the returned attempted/published/failed counts and durable row state. A
published count represents persisted broker acceptance only. It does not mean
that a consumer applied the event or that the job is terminal.

## Testing and evidence

Use focused `PostgresqlMediaLifecycleOutboxSourceTest` and
`PostgresqlMediaOutboxPublicationSourceTest` selectors for claim fencing,
retry/dead-letter, atomic append, identity parity, and crash/lost-ack recovery.
Provider database integration tests use H2 or disposable PostgreSQL as named
by each test; LocalStack tests also require Docker. These are local development
checks and do not qualify a real production broker or cutover. See
`docs/implementation/verification/transactional-event-outbox-mandatory-surface-closure-matrix-2026-11-10.md`
for the scope matrix and evidence plan.
