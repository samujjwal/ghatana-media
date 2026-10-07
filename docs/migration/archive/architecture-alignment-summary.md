# Media Architecture Alignment

**Status:** Migration-only local architecture summary; not a production-readiness claim.
**Service:** Media runtime
**Contract authority:** Source-specific HTTP, gRPC, provider, and Product Definition records.

## Boundary and composition

Media owns tenant-scoped artifacts and uploads, processing jobs, stream sessions,
consent, privacy maintenance, modality providers, and lifecycle state. The
`launcher` is the executable composition root; `runtime-contracts` contains the
domain boundary, while modules and providers contain implementations.

Media consumes, but does not own, Data Cloud governance, Event Plane durable
event truth, AI Inference provider routing, Action Plane effects, or Agents
execution. Their public contracts remain the integration boundary.

## Contract surfaces (CLEAN-2)

There is no active aggregate `service-contract.yaml`, authored aggregate source,
or generator in this checkout. The current contract surfaces are deliberately
source-specific:

- HTTP: `contracts/openapi/media.yaml` reconciled with `config/route-manifest.json`.
- gRPC: the service protobuf declarations under `modules/*/src/main/proto/`.
- Provider availability: `config/provider-manifest.json` and its provider records.
- Semantic and experience definitions: canonical PDP-1/PDP-3 registries under
  `.product-experience/`.

These surfaces have different responsibilities; none is represented as a
generated aggregate. Historical migration inventories that name the omitted
source-repository artifact remain provenance records, not active target paths
or build inputs. GAP-06 remains open where authored-source ownership, consumer
parity, or native qualification is still pending.

## Runtime and qualification boundary

The launcher composes provider operations, tenant and governance checks, and
lifecycle publication. Local publication is bounded and synchronous; it does
not establish durable queue/retry behavior. Production-like operation requires
the separately owned durable publication adapter and its evidence.

Durable profiles use PostgreSQL metadata/state and encrypted object storage.
Local profiles may use diagnostic file/in-memory providers and do not establish
restart durability. Confirmed, failed, and unknown external outcomes remain
distinct; unknown outcomes require reconciliation rather than blind replay.
Runtime qualification, owner acceptance, migration cutover, and deployment are
separate gates and are not claimed by this summary.
