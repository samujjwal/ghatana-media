# Launcher Metrics Probe Mandatory Surface Closure Matrix — 2026-11-10

## Scope and review basis

Scope: launcher `GET /metrics` content negotiation only, as the runtime consumer of `audio-video-observability` metrics. Owning build unit: `:services:media:launcher`. This is a local HTTP compatibility review; it does not establish deployed scrape/alert delivery, provider quality, or production qualification.

Reviewed: root `AGENTS.md`; `launcher/README.md`; `docs/surfaces/launcher/README.md`; `docs/surfaces/audio-video-observability/README.md`; `audio-video-observability/README.md`; the `media.dev.service-observability` task entry; `MediaHttpHandler`, `MediaRuntime.prometheusMetrics`, `MediaJobReconciliationReadTest`, route manifest and security filter. The current dirty changes in the handler/test add explicit Prometheus and OpenMetrics output negotiation and are preserved.

## Mandatory Surface Closure Matrix

| Area | Status | Evidence inspected/artifact | Findings | Action |
|---|---|---|---|---|
| Prompt/repo guidance | reviewed-no-gap | `AGENTS.md`; no nested launcher `AGENTS.md` | Local implementation is allowed; no formal acceptance or production claim follows. | Preserve boundary. |
| Recursive inventory | reviewed-no-gap | `rg --files launcher` and metrics route/test references | Handler, runtime registry, manifest, security allow-list, and read-path tests are the direct surface. | Keep change path-scoped. |
| Surface kind/build unit | reviewed-no-gap | `launcher/build.gradle.kts`; launcher docs | Java runtime host; Gradle launcher unit. | Focus launcher selector. |
| Ownership/boundary/placement | reviewed-no-gap | `MediaHttpHandler`, `MediaRuntime`, observability module docs | Launcher owns its process-local registry and HTTP route; metrics semantics/instruments remain observability-owned. | Negotiate representation only; do not add instruments. |
| Vision/non-goals/consumers | reviewed-no-gap | launcher and observability surface READMEs | `/metrics` serves scrapers; no new provider/render readiness is implied. | Keep scope to HTTP representation. |
| Architecture/design | reviewed-no-gap | `health` route and `MediaRuntime.prometheusMetrics(String)` | Request `Accept` chooses Prometheus text or OpenMetrics; no registry lifecycle changes. | Honor media ranges and q-values while preserving JSON fallback. |
| Documentation/examples | reviewed-no-gap | `docs/surfaces/launcher/README.md`; observability README | Existing docs state explicit OpenMetrics and Prometheus scrape behavior. | Keep content negotiation behavior aligned. |
| Requirements/current-state alignment | implemented | `MediaHttpHandler.metricsContentType`; real-handler regression | Substring matching selected a representation even when its `q=0`; weighted matching is implemented. | Keep implementation and docs aligned. |
| Gap/backlog classification | implemented | Initial finding F1 and focused test | Current-state correctness gap fixed; no backlog item was created. | Preserve the fix. |
| Feature completeness | reviewed-no-gap | `/metrics` route and runtime registry method | Both supported expositions already exist. | Do not add formats or metric families. |
| Correctness | implemented | `MediaHttpHandler.java:879-914`; q-value regression cases | Supported exact media ranges choose the highest positive q; invalid or zero qualities fail closed to existing JSON. | Keep protocol tests. |
| API/contracts/config | implemented | HTTP `Accept`; observability surface README; handler test | No route/schema change; explicit media-range preference is honored. | Keep fixed content types, status, and cache behavior. |
| Generated/source-of-truth parity | reviewed-no-gap | `MediaRouteManifest`, OpenAPI and source handler | No generated route or schema change. | No generated source edits. |
| Naming | reviewed-no-gap | Existing helper `metricsContentType` | Helper describes its output and has one caller. | Retain helper name. |
| Duplication | reviewed-no-gap | Handler's single negotiation helper | No second implementation. | Extend the existing helper. |
| Organization/placement | reviewed-no-gap | `MediaHttpHandler.health` | Negotiation belongs at HTTP representation boundary. | Keep local to handler. |
| Cohesion/coupling | reviewed-no-gap | Handler/runtime method signatures | Runtime already accepts the selected content type; no coupling change needed. | Reuse current registry path. |
| Tests/coverage | implemented | `MediaJobReconciliationReadTest.java:124-162`; JUnit XML | Tests q=0 rejection, q preference, deterministic tie, malformed q, and legacy behavior. | Retain real-handler regression. |
| Compatibility/migration/deprecation | reviewed-no-gap | Existing route is unchanged and no persisted data is involved. | Empty or unsupported Accept continues the JSON fallback. | Preserve existing default behavior. |
| Affected-scope verification | implemented | Focused FULL `MediaJobReconciliationReadTest` run | Targeted launcher test passed 8/8, zero skips/failures/errors. | Reuse unchanged module evidence. |
| Evidence Generator integration | blocked | `docs/EVIDENCE.md`; task register | Local launcher tests are engineering evidence only. | Retain OPEN status and owner evidence boundary. |
| Missing Evidence Generator capabilities | blocked | Lifecycle-owned generator is outside this module | No local collector can produce canonical scope fingerprint/receipt. | Route canonical evidence through its owner; do not hand-write `.evidence/**`. |
| Security | reviewed-no-gap | Route is read-only; security filter allows `/metrics`; no auth/config changes | Negotiation uses untrusted header text only for fixed-value selection. | Never echo or tag raw Accept text. |
| Privacy/data governance/compliance | reviewed-no-gap | Registry label policy and existing redaction assertions | Scrape values remain subject to existing bounded-cardinality rules. | No label or body changes. |
| Observability/diagnostics | reviewed-no-gap | `MediaRuntime.prometheusMetrics(String)` and metrics route | This change only affects representation selection. | Keep no-store and current metrics. |
| Reliability/resilience/operability | reviewed-no-gap | Existing fallback branch in `/metrics` | Unsupported/no acceptable type returns the established JSON health snapshot. | Preserve bounded non-error fallback. |
| Performance/scalability | reviewed-no-gap | Small fixed set of media ranges | Header parse is linear in small Accept header length. | No registry or payload overhead added. |
| Accessibility/internationalization | not-applicable | Headless HTTP scrape endpoint | No user interface or localized copy. | No UI work. |
| AI/ML applicability | not-applicable | Launcher representation negotiation only | No inference or model semantics. | No model behavior changes. |
| Build/dependency/release readiness | reviewed-no-gap | Existing Gradle module/dependencies | No dependency or release changes. | Use focused composite test. |
| Dependency/supply-chain/licensing | reviewed-no-gap | No dependency changes planned | Existing parser can be implemented with JDK APIs. | Add no dependency. |
| Repeatability/reproducibility | reviewed-no-gap | Deterministic pure helper and existing HTTP harness | Inputs yield fixed content type; tests run locally. | Record exact command and result. |
| Convergence/stability | blocked | `media.dev.service-observability` is OPEN | This route fix cannot establish deployed scrape, alerts, or task closure. | Keep task OPEN and list exact external gates. |

## Finding and pre-edit evidence plan

### F1 — `/metrics` ignores Accept quality values

- **Priority/areas:** P1; correctness, API contract, test coverage.
- **Location:** `launcher/src/main/java/com/ghatana/media/launcher/MediaHttpHandler.java`, `metricsContentType`.
- **Problem/root cause:** Substring matching returns OpenMetrics whenever its token occurs, even with `q=0`, and ignores a higher quality for `text/plain`.
- **Classification:** Current-state correctness gap in the existing HTTP representation negotiation.
- **Production-ready fix:** Parse comma-separated supported media ranges and their quality parameters; choose the supported representation with highest positive quality, using deterministic OpenMetrics preference on an exact tie. If neither supported range is acceptable, retain the existing JSON health-snapshot fallback.
- **Acceptance:** `application/openmetrics-text;q=0, text/plain` returns Prometheus text; a higher OpenMetrics q selects OpenMetrics; q=0 for both or unsupported Accept preserves JSON fallback; existing simple explicit Accept requests continue to pass.
- **Path-scoped tests:** `MediaJobReconciliationReadTest` direct HTTP requests through the real handler; cover q=0, preference, and existing legacy/no-Accept behavior.
- **Path-scoped evidence plan:** Run `./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE -Pghatana.media.compositeScope=FULL :services:media:launcher:test --tests com.ghatana.media.launcher.MediaJobReconciliationReadTest --no-daemon --no-parallel --max-workers=2 --console=plain`; inspect JUnit totals for zero skips/failures/errors and run `git diff --check`.
- **Implementation/evidence:** The existing helper now selects the highest positive quality across the two supported exact media types; malformed/duplicate quality is treated as unacceptable, ties retain OpenMetrics preference, and neither accepted type preserves the JSON fallback. `docs/surfaces/audio-video-observability/README.md` documents this behavior. The planned selector passed 8/8 with zero skips/failures/errors; `git diff --check` passed.
- **Evidence Generator:** No local collector for canonical scope fingerprints/receipts; not needed to validate the local HTTP regression.
- **Convergence impact:** Prevents a local scraper from receiving an explicitly refused representation; does not prove deployed scrape/alert delivery or close `media.dev.service-observability`.

## Closure decision

`not-converged-actionable` — this is one bounded local route gap. Provider/render producers, deployed alert delivery, named-host budgets, and Lifecycle evidence remain outside this change.
