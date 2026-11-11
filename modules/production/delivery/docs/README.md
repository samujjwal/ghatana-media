# Production delivery surface overview

This document is the source-of-truth overview for `modules/production/delivery`. It describes the current bounded local coordinator and separates its code behavior from owner-controlled production delivery authority.

## Vision and purpose

The surface makes an immutable media artifact export trackable by exact tenant, principal, request, artifact/version/digest, and destination identity. It represents local queueing, transfer progress, uncertainty, and destination evidence without treating transport completion as acceptance.

## Non-goals

- It does not implement a network destination, publication host, or UI.
- It does not mint or sign transfer authorization.
- It does not define or substitute for the destination owner's receipt schema or acknowledgment authority.
- It does not connect the operation ledger to a production job/outbox/runtime by itself.
- It does not claim production delivery, owner acceptance, or lifecycle status.

## Consumers and ownership boundary

The Gradle unit `:services:media:modules:production:delivery` owns the coordinator and local operation-store contract. Its public dependency is `:services:media:runtime-contracts`; authorization and destination implementations are injected ports. The in-memory store is development-only. `providers/aws-postgresql` contains a separate durable-store adapter, but it is not wired into the default launcher runtime. There is currently no qualified destination implementation of `FencedDestinationPort`.

The source requirements are task `media.dev.delivery-export-destination-ack` and its linked PDP-1 delivery request/result and acknowledgment definitions. The task remains OPEN. Host authorization, owner receipt semantics, destination-side fence enforcement, and production integration belong to their respective owning boundaries.

## Public API, contracts, and lifecycle

`MediaDeliveryEngine` exposes `enqueue(request)`, `dispatch(request)`, `export(request)`, `reconcileAndResume(...)`, and `find(...)`. `enqueue` creates or reads an exact request in `QUEUED` without calling authorization or the destination. `dispatch` attempts a queued exact request; non-queued requests are read back. `export` is the enqueue-then-dispatch convenience path.

Artifacts are immutable defensive byte snapshots bounded to 64 MiB; transfer chunks are bounded to 1 MiB. Authorization is rechecked before chunk effects. Delivery status is one of `QUEUED`, `SENT`, `DESTINATION_CONFIRMED`, `OUTCOME_UNKNOWN`, `REVOKED`, or `UNAVAILABLE`. A confirmation requires exact-scope destination receipt evidence and an artifact checksum match. Failed or ambiguous effects remain `OUTCOME_UNKNOWN` pending destination reconciliation; the engine does not infer acknowledgment from HTTP status or local transport completion.

`DeliveryOperationStore` persists the exact operation identity and monotonic state. Dispatch requires an implementation that advertises durable claims and a `FencedDestinationPort`; a store or legacy destination that cannot enforce that boundary fails closed. Implementations must reject stale fences and deduplicate exact request/chunk identities. These requirements are currently contract requirements only, not qualified behavior of an actual destination.

## Design and extension model

The engine coordinates exact-scope validation, authorization currentness, bounded chunk transfer, claim fencing, state persistence, and destination reconciliation. It keeps no network client or production credential. Hosts may implement the injected authorization, durable-store, and fenced-destination ports once the respective contract owners supply authentic semantics and admission. A caller must resolve uncertain outcomes before attempting another effect.

The compatibility `DestinationPort` remains source-compatible but is not invoked by the coordinator. The default constructor uses `InMemoryDeliveryOperationStore`, which does not advertise durable claims and therefore cannot dispatch. No schema/generated source is owned by this module; PostgreSQL migrations remain under the provider package and preserve their existing lineage.

## Examples

Observe queue state before scheduling an effect:

```java
DeliveryResult queued = engine.enqueue(request);
if (queued.status() == Status.QUEUED && hostIsReady) {
    DeliveryResult dispatched = engine.dispatch(request);
    // `dispatched` can be SENT, DESTINATION_CONFIRMED, OUTCOME_UNKNOWN,
    // REVOKED, or UNAVAILABLE. Only an exact reconciled destination receipt
    // makes DESTINATION_CONFIRMED truthful.
}
```

Use `export(request)` only when the host intentionally wants the combined enqueue-and-immediate-dispatch operation. A local fake receipt used by a unit test is not an owner acknowledgment or production delivery proof.

## Testing

From the repository root, run the owning module tests:

```bash
./gradlew :services:media:modules:production:delivery:test --rerun-tasks --no-daemon --console=plain
```

The focused test class covers immutable request binding, bounds, duplicate export/enqueue behavior, authorization revocation/currentness, destination scope and checksum mismatch, lost acknowledgment and reconciliation, restart/readback, monotonic claims/fences, and fail-closed unsupported ports. Provider database tests and launcher wiring are outside this module and are not implied by this unit-test command.

## Evidence and current gaps

Local module tests and PostgreSQL store tests prove local coordinator/store behavior only. They cannot prove an authentic owner acknowledgment, an admitted production destination, production runtime wiring, or destination-side fencing. The canonical lifecycle Evidence Generator has no registered producer/scope binding for this module in the current checkout; see the scoped evidence plan and closure matrix under `docs/implementation/verification/` for the specific evidence blocker and next owner inputs.

No `.evidence/**` artifact may be hand-authored. A valid convergence result requires a canonical repository-native run with a source fingerprint, selected tests, schema validation, provenance, gates, and repeatability from the owning Evidence Generator.
