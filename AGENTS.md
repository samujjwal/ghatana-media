# Ghatana Media — agent instructions for backend engineering

**Applies to reviewers, implementers, test agents and coordinators.** This file intentionally separates **permission to perform useful engineering** from **formal lifecycle stage admission, PDP acceptance/closure, release and deployment**. It supersedes the former blanket prohibition on implementing a surface until all PDP status records and gtool phase gates are complete. Do not invent statuses or bypass real security, compatibility or deployment controls.

## 1. Owner direction and immediately permitted work

The owner directs **backend-first implementation now**. The current PDP-0 (Product Truth), PDP-1 (Domain/Data), PDP-2 (Interface/Design) and PDP-3 (Complete Experience) source materials are usable as implementation requirements **even when their formalization, source-current projection, exact mapping, native gtool integration, readiness or closure is unfinished**. Treat the described capabilities as product intent. Start with the granular backend foundation execution slice at:

- docs/implementation/MEDIA-BACKEND-FOUNDATION-DEEP-IMPLEMENTATION-2026-10-24.md
- docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md (the full canonical Build plan; current execution location is corrected by the focused slice and the owner addendum within that plan).

**Default action: inspect and implement in `ghatana-media` (not `ghatana/services/media`), test, integrate and report the changed unit. Do not request another routine approval, stop for an incomplete PDP checklist, or block engineering on a gtool host, receipt, stage transition, independent reviewer, unavailable service, or unrelated surface.** Work can start immediately on contracts, safety tests, adapters, performance harnesses and deterministic local integration. Use issue/task handoffs only for real missing semantics or external admission. Avoid generating a new planning proposal when the next implementable task is known.

Only safety-critical or irreversible **specific actions** must fail closed when requisite authority is absent: e.g. real personal data disclosure, biometric/voice consent, an external charge/effect, schema cutover, privilege escalation, production credential/provider activation, destructive purge or release. Continue independent implementation and bounded test-fixture work.

The **56-task PDP mapping and M01–M08 reconciliation** in the focused plan provide concrete source-to-task locations; known PDP-1/2/3 binding gaps are not false claims of complete contract coverage. Complete a task with tests, not a status label. This authorization allows engineering under a **development implementation lane**. It does **not** declare formal BUILD admission or KDEV-STAGE-IMPLEMENT, PDP DEV_COMPLETE for an unverified input, acceptance/closure, verified proof, trust-root approval, deployment or release.

## 2. Two separate tracks; no artificial dependency between them

| Track | What it permits | Its completion claim |
| --- | --- | --- |
| **A — backend engineering (active, not lifecycle-gated)** | Design within existing product meaning, code, refactor, unit/integration/fault/load tests, one-writer integration and logical package completion. Formal PDP status and gtool availability are inputs to track, **not prerequisites to starting**. | LOCAL_IMPLEMENTED / LOGICALLY_BACKEND_DEV_COMPLETE only after the package's executable and adverse-case checks pass. |
| **B — governed source/stage/closure/release (independently tracked)** | Source-native PDP-0→1→2→3 validation; Kernel/Work Planner formal stage transition; Lifecycle gtool native phase acceptance and closure; independent proof and receipts; later release admission. | Use only genuinely returned machine-readable source/status, authorized verification and authentic receipts. Never infer it from Track A or from agent text. |

**Formal BUILD progression remains surface-scoped:** the existing owner-approved policy permits eligible BUILD work to proceed per source-bound unit while other surfaces continue Discovery. An unrelated incomplete surface or aggregate Discovery status does not block an eligible independent surface. For this formal-stage classification, verify that a selected unit's applicable PDP records are source-current and validated `DEV_COMPLETE`, with no remaining phase-local definition tasks and passed declared predecessors, through the owning Kernel/Work Planner contract. **This is exclusively a rule for formal BUILD stage admission—not a prerequisite for the independent engineering lane A.** A surface with incomplete or unformalized PDP status may still be coded, tested, reviewed, and logically evaluated under lane A without falsely claiming a formal stage transition.

The formal lifecycle remains DISCOVERY → BUILD → DELIVER → ENHANCE, with the Kernel's detailed stages and Media's PhasePrograms and ClosureSurfaces. They are **formal state machines**, not an excuse to prevent ordinary source editing, feature construction or tests. Preserve the full registered surface denominator and closure obligations in Track B; selecting five backend modules for Track A does not narrow the product's declared PDP scope.

Formal status checks that fail or are unavailable should produce a **nonblocking status note** with exact missing input, not a halt or fake PASS. No native closure run is needed to call a backend package logically implementation-ready. Do not mutate gtool inputs, definition pins or status records to make code look admitted.

## 3. One product meaning, one implementation owner, one public contract

1. Source requirements in .product-experience/ remain the **single product-semantic authority**, by owning phase. Explicit source contradictions outrank this agent file. Prefer the exact PDP leaf, operation, state transition, interface and scenario over a historical plan summary. The Experience Explorer is a source projection, not production behavior or a fifth PDP.
2. The existing typed runtime Java contracts and admitted shared/public wire contracts **as reconciled into this `ghatana-media` repository** are the implementation targets. Do **not** fork a new contract/version solely because PDP phase mapping, a generated bridge or a tool is incomplete. Preserve stable IDs, schema compatibility and negative/error semantics. Keep the existing HTTP OpenAPI/route manifest, protobuf descriptors and provider manifest in their respective owning roles; do not create a second aggregate spec.
3. Reuse Shared identity, authorization, messaging/outbox, observability and policy primitives, Ghatana Event Plane/Data Cloud/AI Inference contracts, and Media's existing persistence/jobs/providers. Do not reimplement platform-owned engines inside Media. Never import product internals across the published dependency boundary.
4. **Media code writer effective now:** ALL new Media-owned runtime, Java/TS/Rust, domain contracts, schema migration source, backend tests, fixtures, provider wiring and build edits MUST be committed to `samujjwal/ghatana-media` (`main`). The original `samujjwal/ghatana/services/media` is historical **read-only** comparison/input; do not add Media implementation there. Until a separately verified M08 deployment/data cutover, a legacy Ghatana binary may still be the sole **active** database/worker/outbox/queue writer. Do not run the new Media process against that same state, publish duplicate events or run clashing Flyway scripts. Run Media development in isolated stores with source-composite/platform-only dependencies where required. This is a **source implementation ownership decision now**, not proof of runtime/data cutover.
5. Do not rewrite/rename existing public coordinates or reorder/replace Flyway migrations. The canonical applied migration history has priority over prepared-source copies. Follow expand → dual-read/backfill → verify → contract for changes.

### Incomplete or informally specified PDP features

Assume that planned features belong to the product even if they are not fully formalized. Bind each implementation task to **existing closest product source IDs and known input/output/state/error intent**. When exact detail is missing:
- Record the precise ambiguity, the conservative design assumption and the source/contract affected **in the task/PR**, not in a new competing requirements catalog.
- Prefer backwards-compatible, opt-in, typed and testable behavior; put risky or externally effective behavior behind an explicit capability/eligibility check with a truthful NOT_ADMITTED / UNAVAILABLE / OUTCOME_UNKNOWN path.
- Write positive, boundary and negative tests for the assumption; send a concise owner-of-semantics handoff for genuinely conflicting meaning. Keep developing other independent tasks while the meaning owner reconciles the PDP later.
- Never silently weaken consent, rights, tenant isolation, provider finality, reproducibility, retention or real-world safety. Do not assert that mock/fixture responses prove a provider effect.

**Historical source metadata:** `.product-experience/authority-map.yaml` and `.ghatana/repository.json` may still describe the original `ghatana/services/media` implementation binding, because operational/source migration has not completed. This is provenance, not an instruction to commit Media code there. Reconcile those source-bound projections using their owning migration/phase process after actual M01–M08 transfer proof; do not falsify the PDP or mutate historical pins merely to change a label.

## 4. Required backend development method

- **Inspect before changing:** read the owning Media repository source, legacy code as a **read-only** source-difference reference, tests and shared/public dependencies. Classify reuse, extension, obsolete compatibility path and genuine gap. Prefer surgical change to broad rewrite.
- **Ship vertical increments inside a focused foundation package:** request DTO → validation/auth → transaction/domain state → async effect/outbox → durable readback → negative/restart/concurrency tests. Preserve caller-visible finality, errors and correlation.
- **Correctness first:** precise tenant/principal ownership; strict request fingerprint/idempotency; immutable versions; compare-and-set; lease fencing; transaction and outbox atomicity; bounded retries/backpressure; cancellation truthful to provider outcome; crash/restart reconciliation; no duplicated external effect after UNKNOWN.
- **Performance and resilience:** bounded queues, streaming/chunked I/O, explicit resource ceilings, timeout budgets, connection pools, admission control, per-tenant fairness, predictable backoff, reproducible benchmarks. Profile real code; do not replace correctness with a faster unsafe shortcut.
- **Data and model boundaries:** classify content before egress; verify rights/consent for each sensitive dispatch and retry; prevent cross-tenant caches and deduplication; keep content/secrets out of logs, event payloads and error responses.
- **Testing:** run relevant unit + contract + adversarial/property tests, then PostgreSQL/S3-compatible integration, network and process fault injection, and measured load when the owning package needs it. Synthetic fixtures prove code paths, not real model quality; live external integrations require real admission. If Docker, credential, network or model hardware is missing, run all independent tests, report exact unrun cases, and continue without global blocking.
- **Execution control:** all Media-specific source writes land on **`ghatana-media/main`**; never patch the old `ghatana/services/media` runtime as a workaround. Main branch only where owner directs; preserve other work, never force push; one writer for each edited shared path. Small commits with current tests. GitHub CI, all-repository PDP closure, or a remote gtool service are not a prerequisite for focused local backend tests. Do not claim an unfiltered full build when tasks or modules were excluded.
- **Avoid loops:** reuse unchanged test results where inputs have not changed; rerun affected modules/contracts when they have; stop planning expansions when executable backlog is available. No arbitrary full campaign restart for a changed leaf.

## 5. Logical completion standard for each of the five backend packages

For the selected package, require all of:
1. Its declared feature/function scope is coded and reachable through the selected canonical runtime or a correctly exposed public SPI, **not just DTOs/proposals/stubs**.
2. Domain and wire contracts match owning PDP semantics with typed error, tenant, version, request and outcome handling. Every known material ambiguity has a safe explicit result and a traceable follow-up owner.
3. Unit, invariants/property, boundary/negative, and **real integration** tests pass for changed behavior. Restart/failure/parallel-worker tests are mandatory where durable effects exist.
4. No active duplicate contract, canonical writer, event publisher or migration; public compatibility checked. Missing downstream service capability is explicit and isolated rather than quietly mocked as successful.
5. Resource caps, metrics, privacy, performance benchmarks, fault behavior and operations documentation are validated against recorded test environment and specified threshold/baseline.
6. A concise per-package handoff names source paths, tested commit/cut, commands, pass/fail/skip details, feature coverage and residual exact blockers. A package is **LOGICALLY_BACKEND_DEV_COMPLETE** only when its tests/behavior actually meet these checks. Otherwise label it IN_PROGRESS or BLOCKED_EXTERNAL with precise independent work remaining.

This is **not** a gtool CLOSED/CURRENT or product release status. Package logical completion can precede and aid formal PDP acceptance and phase closure.

## 6. References, reporting and stage claims

Read README.md, BOUNDARY.md, docs/ARCHITECTURE.md, docs/TESTING.md, .product-experience/, the canonical Build plan and the focused backend foundation plan as relevant. For formal source or closure actions, additionally read the Media source-pinned PDP status files, config/closure/media-product-definition/, the Kernel lifecycle and the Lifecycle PhaseProgram; use the existing gtool structured I/O path rather than cloning it in this repo.

**An implementation update should be concise and actionable:** selected backend package/surface IDs; current executable owner and baseline; task IDs done/left; exact file/contract changes; tests including negative and restart cases; performance/limits observed; real blockers and next independent implementation. Do **not** demand a 54-row phase matrix, formal KDEV transition, native receipt or proof just to edit backend code. For a **formal review/closure/stage-admission request**, retain the full source/currentness/denominator, authentic gate matrix and next lawful transition with exact trusted evidence.

No agent may counterfeit a security review, external contract admission, third-party model license, trusted verifier or owner signature. A documented decision/assumption is not a verifiable independent proof.
