# Media verification history

> This page indexes dated verification material. It does not report current PDP status or establish implementation, qualification, closure, or release. Consult the [PDP source index](../.product-experience/README.md) and its source-pinned status records for the current phase state.

This page indexes local contract tests and runtime authority checks for media
artifacts, jobs, streams, consent, and privacy. Evidence is separated into
local implementation proof, repository-recorded observations, and owner-native
qualification/admission. Historical browser or terminal output is never
treated as current convergence evidence without a scope fingerprint,
provenance, and repeatability result. The repository does not hand-author
`.evidence/**` receipts; Lifecycle-owned generators remain the authority for
semantic currentness and convergence. This page is not a production-evidence
generator or release-readiness claim.

## Wave 2 testing and coverage evidence

The [Wave 2 plan](implementation/MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md) owns the 58 original task acceptance criteria. The [R7 directive](implementation/MEDIA-WAVE2-OWNER-IMPLEMENTATION-DIRECTIVE-2026-10-27.md) defines the evidence needed for promotion. Run the affected selectors in [TESTING](TESTING.md), then the applicable platform/integration lanes; a documentation index or schedule check cannot accept a runtime task.

```sh
# Structural parity of the plan, schedule and source inventories only.
pnpm test:backend-modality-wave2-plan

# Choose the affected platform lane after TESTING.md prerequisites are met.
./scripts/test-media-wave2-platform-matrix.sh mac-core
./scripts/test-media-wave2-platform-matrix.sh linux-arm64-core
./scripts/test-media-wave2-platform-matrix.sh mac-integration
```

Native lanes are `mac-native` and `linux-arm64-native`; follow the source-pinned codec and Docker image instructions in [TESTING](TESTING.md#wave-2-macos-and-linux-platform-matrix). The runner writes `<mode>.json`, its Gradle log and a run-stamped core resource-profile TSV under `MEDIA_MATRIX_REPORT_DIR` (default `${TMPDIR:-/tmp}/ghatana-media-wave2-platform-results`). Module JUnit XML is under each module's `build/test-results/test/`. Keep these actual outputs with the execution record; a temporary path alone is not durable evidence.

For each claimed criterion, retain the source cut and any dirty diff, affected sibling revisions, exact command/selectors and exit status, JVM/host/image/codec identity, JUnit pass/fail/error/skip counts and reasons. Positive modality claims additionally need authorized input/model/voice/corpus provenance, actual output bytes/digest/version and quality measurements. Durable effects require denied/stale/revoked zero-effect, restart, fencing/idempotency and `OUTCOME_UNKNOWN` checks. Fixture resource profiles remain harness observations until a named real modality workload supplies its own baseline and limits.

## Evidence and convergence

The Media runner produces local test observations; it does not compute a convergence score or issue Lifecycle receipts. A formal convergence claim requires the owning Lifecycle Evidence Generator command/run ID, normalized scope and fingerprint, evidence plan and selected tests, schema/gate results, score provenance and repeatability artifacts for the same inputs. No Wave 2 native convergence invocation or current receipt is established by this index. Resolve the registered owner route before making that claim; do not create a local substitute receipt or hand-author `.evidence/**`.

For repeatability, preserve source/tool/model/input digests and commands, rerun the same selected workload, and compare semantic outcomes with declared tolerances for timing/quality measurements. Explain changed inputs and skips. Historical green outputs cannot prove new code, a different host, an untested provider or unexecuted Compose cases. Formal evidence admission and task-wide logical completion remain separate checks.

## Experience browser audit

`pnpm test:experience-browser` runs the Media-owned Explorer preview through
all 29 scenarios, the generated Specification index, 47 valid Product proposal
routes, the inline artifact-verification specialization, Verify, keyboard
navigation, accessible-name checks, and six responsive viewports. A prior audit
report is present at `/tmp/media-experience-browser-audit/report.json`. It
records 29 scenarios, 47 routes, 296 indexed specification records, six
viewports, no assertion/console/page errors, and the listed responsive,
keyboard, zoom, forced-colors, reduced-motion, and touch-target observations.
It predates the latest Explorer package-consumer edits, so it is not current
browser proof for the present checkout; rerun the audit after those changes.
Screen-reader automation and independent visual review remain manual and
unverified, and no accepted canonical visual references were supplied.

The audit proves deterministic browser behavior and geometry. It does not
replace human visual/accessibility review, a pixel-reference comparison, or
lifecycle-owned Evidence Generator receipts.
