# Production delivery slice

`MediaDeliveryEngine` is a bounded coordinator over injected authorization and destination ports. It has no network destination adapter and makes no claim that an export reached a real recipient.

## Finality and scope

An export binds tenant, authenticated principal, request ID, immutable artifact identity/version/digest, and exact destination. Transfer authorization must match that entire scope and remain current before every chunk. Destination chunk receipts and the final destination receipt must repeat the exact tenant, principal, request, artifact version/digest, and destination. The final receipt checksum must equal the artifact SHA-256 digest. HTTP status or local send completion never establishes confirmation.

`QUEUED`, `SENT`, `DESTINATION_CONFIRMED`, `OUTCOME_UNKNOWN`, `REVOKED`, and `UNAVAILABLE` distinguish local progress from destination evidence. A missing/lost acknowledgment requires explicit destination reconciliation before any resume. Unknown outcomes are not blindly resent.

## Bounds and limitations

Artifacts are snapshotted and capped at 64 MiB; transfer chunks are capped at 1 MiB. The request ledger is in memory only and does not survive process restart. A durable job/outbox integration, durable idempotency store, authenticated destination adapter, and production authorization resolver remain unimplemented. The test destination is a local fixture only.
