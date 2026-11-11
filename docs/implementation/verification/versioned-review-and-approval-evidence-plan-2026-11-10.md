# Versioned review and approval — local evidence plan

Date: 2026-11-10<br>
Scope: local implementation in `modules/production/review` for task `media.dev.versioned-review-and-approval`. Companion: [33-area Mandatory Surface Closure Matrix](versioned-review-and-approval-mandatory-surface-closure-matrix-2026-11-10.md).<br>
Purpose: verify that stale exact-decision retry reconciliation rechecks authorization after store readback and does not disclose a prior receipt to a reviewer revoked during that read.

## Scope and authority boundary

Owning Gradle unit: `:services:media:modules:production:review`. Changed local files are:

- `modules/production/review/src/main/java/com/ghatana/media/production/review/VersionedReviewEngine.java`
- `modules/production/review/src/test/java/com/ghatana/media/production/review/VersionedReviewEngineTest.java`
- `modules/production/review/README.md`
- This plan and the companion matrix under `docs/implementation/verification/`.

The root worktree had concurrent unrelated edits before this scoped review. Do not infer their authorship or fold their paths into this run. No UI, launcher, runtime-contracts, task ledger, source PDP, public wire schema, or production authority files are changed here.

Source contracts inspected: J-21 at `.product-experience/pdp-3-product-experience/journey-contracts/review-exact-version-and-recheck-changes.yaml`; PDP-1 `record-version-review-decision` in `.product-experience/pdp-1-domain-data/operations.yaml`; and PDP-2 `gui/patterns/review-approval.yaml`. J-21 says an append receipt only confirms a review-record append; current `HUMAN_REVIEW_APPROVAL` is a separate read-only observation and approval mutation stays blocked.

This local scope ID is `media.production.review.versioned-review-and-approval`; it is a plan label, not a new canonical task or authority. Task `media.dev.versioned-review-and-approval` remains OPEN.

## Finding and acceptance

`RV-01`: a stale exact-decision retry reads an already committed record so it can reconcile a lost response after the reviewed subject changes. Authorization checked before the read may be revoked while `ReviewStore.read` is in flight. The engine must re-evaluate the actor, exact case/scope, expected authority version, retention and validity after readback and before returning the stored receipt.

Acceptance criteria:

1. Revoke the reviewer from inside the store read after returning the committed record; the retry fails with typed `ReviewDeniedException` and returns no receipt.
2. Advance the injected clock to authority expiry from inside the store read; the retry fails with typed `ReviewUnavailableException` and returns no receipt.
3. The stored record remains the only append in both cases; the retry does not create another append.
4. The existing exact stale retry still returns the original append ID/revision with currentness `STALE` and `establishesApproval=false` when reauthorization succeeds.
5. Preserve exact-payload conflict and rejection of new stale decisions.
6. Expired, unknown, denied, mismatched, or inactive authority remains fail-closed through the existing `authorize` path.
7. No code path treats a review receipt as approval or delivery authority.

## Fingerprint and environment record

Record `git rev-parse HEAD`, `git status --short -- <scoped paths>`, `java -version`, `./gradlew --version`, OS/architecture, exact command lines, and SHA-256 for each scoped source input after implementation. This is a dirty-worktree run; no clean pre-edit digest is available, so do not claim a source-level before/after fingerprint comparison.

Fingerprint inputs:

```sh
shasum -a 256 \
  modules/production/review/src/main/java/com/ghatana/media/production/review/VersionedReviewEngine.java \
  modules/production/review/src/main/java/com/ghatana/media/production/review/ReviewContracts.java \
  modules/production/review/src/main/java/com/ghatana/media/production/review/InMemoryReviewStore.java \
  modules/production/review/src/test/java/com/ghatana/media/production/review/VersionedReviewEngineTest.java \
  modules/production/review/build.gradle.kts \
  modules/production/review/README.md \
  .product-experience/pdp-3-product-experience/journey-contracts/review-exact-version-and-recheck-changes.yaml \
  .product-experience/pdp-1-domain-data/operations.yaml \
  .product-experience/pdp-2-design-interface-system/gui/patterns/review-approval.yaml \
  docs/implementation/verification/versioned-review-and-approval-mandatory-surface-closure-matrix-2026-11-10.md \
  .product-experience/pdp-2-design-interface-system/gui/patterns/review-approval.yaml
```

On repeat, retain the same scope, source revision, environment, and test selectors. A changed input hash or environment starts a different run; do not combine its results with the previous one.

Observed worktree metadata: HEAD `0a439def32fe213aae57d64bcd7f4fc2853d5921`; working tree was already broadly dirty; macOS Darwin 25.2 / arm64; Temurin OpenJDK `27.0.1.0.2`; Gradle `9.8.2` (from the Gradle run diagnostics). These are local observations, not canonical evidence metadata.

Post-edit scoped hashes:

| Path | SHA-256 |
|---|---|
| `VersionedReviewEngine.java` | `f187409b075f4c5847a3f58979f7047aea9e65fcf1296da74b057b44954937b7` |
| `ReviewContracts.java` | `8c3ab4aa3bef20b5374f5a3a6787c19ae9cf85e271d033465e2a495e1f904d46` |
| `InMemoryReviewStore.java` | `b9cbf9dde19f08c6ac1a91b06927bff3395cc43477ce31b684ad12311814b057` |
| `VersionedReviewEngineTest.java` | `229112b1365a486de57c27c39701586517a7148854dedbf1c753f1ef24964214` |
| `build.gradle.kts` | `b015ef64cca880590fe92b82e6ef4e7b95aa0e29936893b2bbae45d614a5700d` |
| module `README.md` | `e2621e1e076e048553c91f91f6780ddfd1c098fe1908426f068fe0681b4141d5` |
| J-21 review journey | `1c2cace7480250ef4b247f45e34e31efe5ff750217eff4f456eee389762ecfc3` |
| PDP-1 operations | `3e11254e703f6a827891f3523007144d93979ef009e41dec1ca2c1077e90516b` |
| PDP-2 review pattern | `f2d82a7b7a1f39b891b6357cc06a8b1758a70fe8faa3676aeaf22f0d4a42fa70` |
| companion matrix | `df7c22074e1c0f0e6d9030bc761ea206bc922bb739fd8dd4fa6e16028c4d4cb9` |

## Ordered local verification

| Order | Command | Proof | Matrix areas |
|---|---|---|---|
| 1 | `./gradlew :services:media:modules:production:review:compileJava` | Production module compiles with the existing public and runtime-contract dependencies. | surface-kind/build-unit, API/contracts, build readiness |
| 2 | `./gradlew :services:media:modules:production:review:test --tests com.ghatana.media.production.review.VersionedReviewEngineTest --rerun-tasks` | Full focused class checks normal and stale exact replay, revocation and expiry during readback, no duplicate append, typed fail-closed outcomes, exact identity and existing adjacent negative behavior. | requirements/current-state, correctness, tests/coverage, security, reliability |
| 3 | `git diff --check -- modules/production/review docs/implementation/verification/versioned-review-and-approval-mandatory-surface-closure-matrix-2026-11-10.md docs/implementation/verification/versioned-review-and-approval-evidence-plan-2026-11-10.md` | Whitespace/conflict-marker hygiene for the selected paths. | docs, affected-scope verification, repeatability |
| 4 | `shasum -a 256` over the listed inputs | Captures the local scope fingerprint. | repeatability/reproducibility |
| 5 | `./gradlew :services:media:modules:production:review:check` | Wider module checks including checkstyle, PMD, tests and intentional-public-API ownership. | build/dependency readiness, naming, security, test quality |

## Run result recorded for this worktree

- `:services:media:modules:production:review:compileJava`: PASS.
- `:services:media:modules:production:review:test --tests com.ghatana.media.production.review.VersionedReviewEngineTest --rerun-tasks`: PASS, 40 tests, 0 skipped, 0 failures, 0 errors.
- After the initial audit reported 39 unowned compiled types, the coordinator added the review package selector to root `config/intentional-public-api.json` mapped to existing `MEDIA-REQ-CAP-PROJECT`. Serialized `:services:media:modules:production:review:check` now PASSES; its verifier aligns all 39 types. `VersionedReviewEngineTest` passes 40/40 after the final fixture cleanup. Checkstyle/PMD complete with non-fatal style warnings. This is local build/API ownership evidence, not approval or runtime admission.
- No repository Evidence Generator command was available; generator schemas, score/provenance artifacts and a convergence result are NOT_RUN.

The engine source/test/build/doc scope is self-contained. No public runtime consumer or wire schema changed, so UI/launcher/runtime-contract integration, PostgreSQL Testcontainers, browser tests, and full repository tests are not selected. Broader tests become necessary if the public contract, durable adapter, runtime binding, UI, or build dependency graph changes.

## Evidence to retain

Retain actual Gradle compiler/test logs and JUnit XML, exact pass/fail/skip/error totals, environment versions, source diff, scoped status, and post-change SHA-256 outputs. The fixed-clock fixtures and explicit test IDs make both post-readback boundary regressions deterministic. The existing result files observed for this run report `tests=40`, `skipped=0`, `failures=0`, `errors=0`. Do not manually create `.evidence/**` or represent this plan/matrix as generated evidence.

## Repository Evidence Generator state

No local `tools/` directory, `discover-evidence-tools.mjs`, or path-scoped Evidence Generator command exists in this checkout. `docs/EVIDENCE.md` assigns canonical evidence artifacts to the Lifecycle-owned generator. Therefore no schema validation, scope collector, score input, gate result, score provenance, repeatability artifact, or convergence score can be reported from this local run.

Required owner enhancement: `EG-MEDIA-REVIEW-EXACT-REPLAY-AUTHORITY-001` (proposed routing key only). The owning generator should collect the scope fingerprint and selected Gradle results, validate exact replay receipt identity, authority-after-readback and no-second-append, reject stale/wrong-scope/manual artifacts, distinguish review receipt from current approval, and emit generator-owned schema/gate/score/provenance/repeatability artifacts. The generator's schemas, score policy, run ID, output directory and canonical status remain Lifecycle-owned; this plan creates none of them.

## Limits and unresolved gates

This verifies a local in-process engine behavior only. It cannot establish owner-issued case authenticity, authenticated human identity/role, durable multi-host behavior, atomic shared CAS with canonical project revision, hosted runtime/UI wiring, current owner approval, delivery authority, product admission, or lifecycle/task acceptance. No task state, approval, external admission, or qualification is changed by these commands.
