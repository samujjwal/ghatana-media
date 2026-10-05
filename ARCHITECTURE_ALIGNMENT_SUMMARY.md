# Media Architecture Alignment

**Status:** Current local-closure architecture note
**Service:** Media runtime
**Canonical contract:** [`service-contract.yaml`](service-contract.yaml)

## Boundary

Media owns tenant-scoped artifact upload/finalization, processing jobs, stream
sessions, consent, privacy maintenance, modality providers, and the lifecycle
state for those concerns. The launcher is the executable composition root;
`runtime-contracts` contains the stable domain boundary and provider modules
contain durable/external implementations.

Media does not own Data Cloud governance, Event Plane durable event truth, AI
Inference provider routing, Action Plane effects, or Agent execution. Those
boundaries are consumed through typed public contracts.

## Repository and service layering

Repository/provider implementations expose the synchronous provider boundary
required by their storage technology. Launcher services compose those providers
into ActiveJ `Promise`-returning operations, enforce tenant and governance
invariants, and publish typed lifecycle events. This keeps blocking storage and
remote provider work out of the public domain contracts while preserving an
explicit asynchronous service boundary.

## Lifecycle publication and retry contract

The Media service contract declares `queue-and-retry` for the optional Event
Plane dependency in production-like operation. The current local launcher
publisher is deliberately narrower: it performs one bounded synchronous HTTP
publication, uses Event Plane idempotency keyed by the lifecycle event ID, and
reports a failed publication as unconfirmed. Local composition therefore does
not claim durable publication or restart-safe retry.

Production-like composition must select a durable publication queue/worker
adapter that persists the event before exposing the lifecycle transition and
retries only under the Event Plane contract's idempotency and failure rules. A
failed or uncertain publication must remain visible for reconciliation; callers
must not silently replay a remote operation or treat a best-effort local
publication as durable.

## Persistence and recovery

Durable profiles require PostgreSQL metadata/job/stream/consent state and
encrypted object storage. Upload claims, leases, fencing, idempotency, provider
outcomes, cancellation state, retention, and erasure remain explicit. Local
profiles may use file/in-memory providers for diagnosis, but local job and stream
state is not restart durable and must not be used to make production claims.

The implementation must preserve the contract's distinction between confirmed,
failed, and unknown external outcomes. Unknown provider or Event Plane outcomes
enter reconciliation rather than blind retry. Privacy purge failures retain
retryable metadata until object deletion is verified.
