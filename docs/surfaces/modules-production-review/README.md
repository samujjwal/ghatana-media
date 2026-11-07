# Production review surface

## Responsibility

`modules/production/review/` records comments and reviewer decision statements against an externally issued review case bound to one exact immutable artifact, project, transcript, caption, or job version. It provides a typed engine and a store port. The production package currently has an in-memory store; the durable PostgreSQL implementation is in `providers/aws-postgresql/`.

An `ACCEPT` is an append-only reviewer statement. Neither the statement nor its append receipt is `HUMAN_REVIEW_APPROVAL`, an owner approval, or permission to deliver or publish. Review-case authenticity and authority are caller/host-owned: this module accepts supplied case references and does not mint or independently authenticate them.

## Public operations

`VersionedReviewEngine` exposes:

- `inspect(actor, reviewCase)`: authorize an inspect operation, read records, validate tenant/case/subject and contiguous revisions, sanitize text for disclosure, and return a snapshot with currentness.
- `append(actor, request)`: require explicit operation and exact-target confirmation; validate fresh authority, expected authority version, retention, and material currentness; sanitize text; repeat the authority/currentness check at the write boundary; append with case-revision CAS and request idempotency; validate the exact returned record; return a receipt that explicitly does not establish approval.

The payloads are comments (with disposition and optional rational time/normalized ROI annotation) and decisions (`ACCEPT`, `REJECT`, `REQUEST_CHANGES`, `DEFER`). Comments may be retained against an old exact version and are observed as stale when currentness says so. Decisions require the subject to be current at both authorization checks.

## States and invariants

- A case is identified by tenant and owner-issued case ID and is bound to one exact immutable subject reference and scope. The supplied target reference must equal that subject reference.
- Case revisions start at zero and advance by one for each successful append. `expectedCaseRevision` is compare-and-set input; concurrent appenders at the same revision cannot both win.
- The `(tenant, principal, requestId)` idempotency key returns the original record for an identical fingerprint and rejects reuse with a different payload/fingerprint.
- Store append and its case revision/idempotency/record writes are one PostgreSQL transaction. Readback requires the record revisions to be contiguous and match the stored case revision.
- Authorization must bind the actor, tenant, case, exact target, scope, authority version, validity window, active retention, and current material version. Unknown authority/currentness/retention fails closed.
- Unexpected authorization-adapter runtime failures become a generic
  `ReviewUnavailableException` without preserving provider/principal details;
  append and inspect stop before touching the review store.
- Text is sanitized before persistence and again on read disclosure. Time ranges use one declared clock and strictly increasing rational times; ROI coordinates are finite, positive, and contained in the normalized unit square.
- The project/material revision check and review append do **not** share an atomic CAS boundary. A material edit can race after the final authority check and before or during the review append. The implementation therefore cannot prove an edit-versus-approval winner; it does not claim to produce approval.

## Dependencies and integration boundary

The module depends on `:services:media:runtime-contracts` for shared runtime contracts. `AuthorizationPort`, `TextSanitizer`, `ReviewStore`, `Clock`, and ID supplier are injected; the host must provide trusted identity, owner case issuance/authenticity, reviewer assignment/role semantics, current material revision, retention, and safe sanitization.

`InMemoryReviewStore` is single-process development/test storage only. `PostgresqlReviewStore` persists records using the provider runtime state and migration `providers/aws-postgresql/src/main/resources/db/media-runtime/V033__media_versioned_review_records.sql`. Its constructor registers only the exact externally supplied case references and rejects conflicting registrations. This persistence is not itself an authorization or approval authority.

Runtime and UI wiring, authentic reviewer evidence, an authentic owner-issued case/reviewer authority integration, and an atomic material-revision/review decision boundary remain open. Do not represent a fixture or a caller-provided reference as authentic reviewer or owner evidence.

## Configuration

The review engine has no module-specific configuration file. Its host supplies the ports and clock. The PostgreSQL store uses the `MediaAwsPostgresqlRuntimeState` configuration owned by `providers/aws-postgresql`; consult that provider's documentation for runtime environment and secret-reference requirements. Tests install that state explicitly and apply the `db/media-runtime` Flyway location. This module does not activate a provider or production runtime by itself.

## Errors

The typed runtime exceptions include:

- `ReviewDeniedException`: confirmation or authorization binding/status is invalid, or retention is not active.
- `ReviewUnavailableException`: authority, currentness, retention, sanitization, receipt, or readback is unknown/incomplete; retry only after resolving the underlying availability condition.
- `StaleReviewException`: a decision targets a version no longer current.
- `ReviewConflictException`: case revision changed since the caller's expected revision.
- `ReviewAuthorityConflictException`: reviewer authority version changed.
- `ReviewIdempotencyConflictException`: the request ID was reused with a different fingerprint/payload.
- `ReviewCaseMismatchException`: supplied or stored case, tenant, target, subject, or record does not match.

Invalid value shapes (for example, malformed time ranges or out-of-bounds ROI) are rejected at contract construction. Persistence failures surface as an `IllegalStateException` with the provider operation context.

## Tests and runnable commands

`VersionedReviewEngineTest` covers exact-version comments/decisions, stale/currentness and authority changes, denial, unknown/expired state, exact receipt/readback validation, tenant/case isolation, idempotent replay and conflicting reuse, and concurrent same-revision appends. `PostgresqlReviewStoreTest` covers exact case registration, tenant isolation, durable replay, restart readback, idempotency conflict, and concurrent PostgreSQL CAS. The PostgreSQL test uses Testcontainers and is disabled when Docker is unavailable; that does not establish a passing database integration result.

Run the engine unit tests and durable store integration test from the repository root:

```bash
./gradlew :services:media:modules:production:review:test --no-daemon --console=plain
./gradlew :services:media:providers:aws-postgresql:test --tests com.ghatana.media.provider.aws.PostgresqlReviewStoreTest --no-daemon --console=plain
```

These commands are documented for repeatable verification; they were not run while authoring this surface document.

## Source references

- Product journey: `.product-experience/pdp-3-product-experience/journey-contracts/review-exact-version-and-recheck-changes.yaml` (J-21).
- Operation contract: `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.record-version-review-decision`.
- Interface intent: `.product-experience/pdp-2-design-interface-system/gui/patterns/review-approval.yaml`.
- Surface implementation plan: `docs/development/SURFACE-IMPLEMENTATION-PLAN.md` (quality and creative review row).
- Implementation: `modules/production/review/src/main/java/com/ghatana/media/production/review/` and `providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlReviewStore.java`.
- Schema: `providers/aws-postgresql/src/main/resources/db/media-runtime/V033__media_versioned_review_records.sql`.
- Tests: `modules/production/review/src/test/java/com/ghatana/media/production/review/VersionedReviewEngineTest.java` and `providers/aws-postgresql/src/test/java/com/ghatana/media/provider/aws/PostgresqlReviewStoreTest.java`.
