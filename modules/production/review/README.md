# Versioned review records

## Purpose and vision

This module records review comments and reviewer decision statements against one externally issued case and one exact immutable artifact version. It makes local review-record append and read behavior explicit, replay-safe, tenant-scoped, and fail-closed when the injected authority or retention observation is missing or stale.

The module does not establish that the reviewed artifact is approved. `ACCEPT` is a review statement; `HUMAN_REVIEW_APPROVAL` remains a separate read-only owner-authority observation. A receipt from this module is not permission to deliver, publish, or otherwise use the artifact.

## Non-goals and consumers

The current consumer is a host that supplies an authenticated `Actor`, an owner-issued `ReviewCaseRef`, an `AuthorizationPort`, a `ReviewStore`, and a `TextSanitizer`. This source-compatible development slice is not wired into the Media runtime or review UI.

It does not create review cases or reviewer roles, authenticate users, decide approval, mutate rights, bind review append atomically to a project-head edit, or qualify a durable provider. `InMemoryReviewStore` is a deterministic process-local fixture/adapter and is not durable or multi-host storage.

## Boundary, API, and configuration

The Java package `com.ghatana.media.production.review` exposes immutable records and interfaces in `ReviewContracts`, plus `VersionedReviewEngine`. Callers submit `AppendRequest` values with a case-revision CAS, expected authority version, tenant/principal-scoped request ID, exact target/effect confirmation, and typed `Comment` or `DecisionRecord`. `append` returns an `AppendReceipt`; `inspect` returns a sanitized `ReviewSnapshot` after authorization is checked again at the disclosure boundary.

No environment configuration or network endpoint is owned here. A production host must provide authenticated identity, an owner-verified case and scope, current reviewer authority/currentness/retention, a durable append-only store with the documented CAS and idempotency semantics, and a sanitizer. The module validates those injected observations; it does not mint them.

## Architecture and design

`VersionedReviewEngine` validates explicit confirmation, authority, currentness and retention, sanitizes text, then rechecks authority immediately before a new write. Store append receipts are checked against actor, tenant, case, exact subject, request, payload, authority version, and expected revision. A material-version change blocks a new decision. A stale retry may return only an exact already-committed decision receipt; it performs a fresh authorization/currentness/retention check after store readback before disclosing that receipt.

`ReviewStore` owns the compare-and-set and idempotent append transaction. Durable implementations must override lazy-ID replay so an exact prior request can be reconciled without allocating another record. The engine rejects malformed, duplicated, foreign-case, cross-tenant, wrong-version, noncontiguous, or payload/operation-mismatched readback. Unknown adapter/sanitizer/authorization failures map to generic typed errors without leaking private details.

## Requirements and current-state disposition

Required local behavior: exact immutable-version binding; role/authority-version CAS; review-case revision CAS; exact request replay; no new decision on stale material; redacted bounded disclosure; authorization recheck after storage readback; and typed fail-closed errors. These behaviors are implemented in the local engine/store contracts and focused tests.

Current gaps remain outside this local module slice: authentic owner-issued case and reviewer authority, atomic CAS shared with canonical project revision, hosted runtime/UI wiring, durable PostgreSQL replay/restart evidence in this task’s focused verification, and an independent current `HUMAN_REVIEW_APPROVAL` observation. Keep `media.dev.versioned-review-and-approval` OPEN until its owner boundaries and integration acceptance are satisfied.

Improvement backlog: none added by this local repair. Do not implement approval mutation or invent a substitute approval schema here.

## Example

```java
AppendRequest request = new AppendRequest(
    ownerIssuedCase,
    expectedCaseRevision,
    expectedAuthorityVersion,
    requestId,
    new Confirmation(
        "media.operation.action.record-version-review-decision",
        ownerIssuedCase.exactTargetRef(),
        true),
    new DecisionRecord(Decision.ACCEPT, "Reviewed the bound version"));

AppendReceipt receipt = engine.append(authenticatedActor, request);
// receipt.establishesApproval() is always false.
```

The example demonstrates only the local append contract. It does not create a case or grant approval.

## Testing and evidence

Run the owning focused test selector from the repository root:

```sh
./gradlew :services:media:modules:production:review:test \
  --tests com.ghatana.media.production.review.VersionedReviewEngineTest
```

The focused suite covers exact-version decisions, stale material, stale replay, authority revocation and expiry during readback, role/tenant binding, retention, redaction, revision/idempotency conflicts, and hostile store outcomes. The path-scoped evidence plan is `docs/implementation/verification/versioned-review-and-approval-evidence-plan-2026-11-10.md`; its companion 33-area audit is `docs/implementation/verification/versioned-review-and-approval-mandatory-surface-closure-matrix-2026-11-10.md`.

Local Gradle/JUnit output is engineering evidence only. This checkout has no repository-native Evidence Generator, so no canonical convergence score or lifecycle evidence is claimed. Hash the scoped source, test, build, and source-contract inputs and rerun the same command/environment for repeatability; a changed fingerprint is a separate run.

## Compatibility and change policy

Keep the source-level review record separate from owner approval and preserve existing typed errors, exact-version identity, and store replay semantics. Do not add a public wire version or runtime route without owner source and compatibility review. Any durable adapter must prove restart, concurrent CAS, and exact/conflicting replay. Changes affecting project-head semantics require the owning project/timeline contract and a shared transaction boundary.

This module is a source-compatible development slice for `media.dev.versioned-review-and-approval`.
It appends comments and reviewer decision statements to an externally issued review case for one exact
immutable version. Comments may carry a rational source/story time range and a normalized ROI. Every
append uses a caller-supplied case revision for compare-and-set, a tenant/principal-scoped request ID,
explicit target/effect confirmation, fresh injected authorization/currentness/retention evaluation,
and a text sanitizer before storage and disclosure.

An `ACCEPT` decision is only an append-only reviewer statement. The J-21 source contract explicitly
separates this record from `HUMAN_REVIEW_APPROVAL`; approval remains a read-only current authority
observation, and neither this record nor its receipt authorizes delivery or publication. A change to
the current material version makes prior records stale in subsequent observations. Missing or unknown
retention/currentness fails closed.

Append requests carry an expected authority version used as a CAS token for the reviewer's current
assignment/role state. The injected authority result must match the authenticated tenant/principal,
owner-issued case ID, exact target and declared scope. Authorization, currentness and retention are
checked once before sanitization and again immediately before the append; role/assignment version drift
or a material-version change between those checks prevents the write. The host authority adapter owns
the meaning and versioning of reviewer roles; the local module does not mint roles or approval grants.
Store append receipts are checked against the exact actor, case, target version, request, payload, authority
version and expected next case revision. Readback rejects cross-tenant/case/version records and requires
contiguous append revisions before disclosing the sanitized snapshot.

`InMemoryReviewStore` is process-local and accepts only externally supplied case references. It does
not mint owner review cases and is not a canonical, durable, or multi-host writer. The module is not
wired into Media runtime, UI, a rights authority, an owner receipt service, or a production review
workflow. The task remains in progress until those integrations and the authentic owner boundary are
available.

Source references: `.product-experience/pdp-3-product-experience/journey-contracts/review-exact-version-and-recheck-changes.yaml`;
`.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.record-version-review-decision`;
`.product-experience/pdp-2-design-interface-system/gui/patterns/review-approval.yaml`.
