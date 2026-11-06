# Production delivery slice

`MediaDeliveryEngine` is a bounded coordinator over injected authorization and destination ports. It has no network destination adapter and makes no claim that an export reached a real recipient.

## Finality and scope

An export binds tenant, authenticated principal, request ID, immutable artifact identity/version/digest, and exact destination. Transfer authorization must match that entire scope and remain current before every chunk. Destination chunk receipts and the final destination receipt must repeat the exact tenant, principal, request, artifact version/digest, and destination. The final receipt checksum must equal the artifact SHA-256 digest. HTTP status or local send completion never establishes confirmation.

`QUEUED`, `SENT`, `DESTINATION_CONFIRMED`, `OUTCOME_UNKNOWN`, `REVOKED`, and `UNAVAILABLE` distinguish local progress from destination evidence. A missing/lost acknowledgment requires explicit destination reconciliation before any resume. Unknown outcomes are not blindly resent.

Every `DeliveryResult` carries the exact tenant, principal, request, artifact ID, immutable version, digest, and destination tuple so callers can read back which export the status describes.

## Bounds and limitations

Artifacts are snapshotted and capped at 64 MiB; transfer chunks are capped at 1 MiB. The default engine constructor still uses an in-memory ledger. A `DeliveryOperationStore` SPI and PostgreSQL adapter now persist exact operation identity/status, and the additive V031 runtime migration creates that table. The adapter is not wired into the default launcher runtime. Its current update API is not an exclusive cross-process dispatch/resume claim, so concurrent resume workers are not safe for real destination effects.

A durable job/outbox integration, signed authorization resolver, authenticated destination adapter, and production destination reconciliation remain unimplemented. The test destination and its receipts are local fixtures only; the PostgreSQL ledger proves persisted operation readback, not delivery or destination finality.
