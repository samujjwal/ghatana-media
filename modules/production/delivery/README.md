# Production delivery slice

`MediaDeliveryEngine` is a bounded coordinator over injected authorization and destination ports. It has no network destination adapter and makes no claim that an export reached a real recipient.

## Finality and scope

An export binds tenant, authenticated principal, request ID, immutable artifact identity/version/digest, and exact destination. Transfer authorization must match that entire scope and remain current before every chunk. Destination chunk receipts and the final destination receipt must repeat the exact tenant, principal, request, artifact version/digest, and destination. The final receipt checksum must equal the artifact SHA-256 digest. HTTP status or local send completion never establishes confirmation.

`QUEUED`, `SENT`, `DESTINATION_CONFIRMED`, `OUTCOME_UNKNOWN`, `REVOKED`, and `UNAVAILABLE` distinguish local progress from destination evidence. A missing/lost acknowledgment requires explicit destination reconciliation before any resume. Unknown outcomes are not blindly resent.

Every `DeliveryResult` carries the exact tenant, principal, request, artifact ID, immutable version, digest, and destination tuple so callers can read back which export the status describes.

## Bounds and limitations

Artifacts are snapshotted and capped at 64 MiB; transfer chunks are capped at 1 MiB. The default engine constructor still uses an in-memory ledger. A `DeliveryOperationStore` SPI and PostgreSQL adapter persist exact operation identity/status; additive V031 creates that table and V032 adds an exact-scope, expiring claim with a monotonic fence. The adapter is not wired into the default launcher runtime.

`MediaDeliveryEngine` dispatches only through `FencedDestinationPort` and a store that advertises durable dispatch claims. Claims compare the exact stored operation state before acquisition, and stores reject illegal state regressions or decreasing acknowledged offsets. Legacy destination implementations remain source compatible but receive no calls; process-local stores also fail closed. The fenced destination contract carries the claim into each send and reconciliation call, and implementations must reject stale fences and deduplicate exact chunk identities. No real destination currently implements or qualifies that contract, so the claim ledger does not establish safe external delivery by itself.

A durable job/outbox integration, signed authorization resolver, authenticated destination adapter, and production destination reconciliation remain unimplemented. The test destination and its receipts are local fixtures only; the PostgreSQL ledger proves persisted operation readback, not delivery or destination finality.
