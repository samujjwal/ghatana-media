# Ghatana Media — Build Implementation Planning Prompt

Copy and use the prompt below to start the next-stage planning work. This requests **BUILD / Plan Implementation only**. It does not authorize runtime implementation, PDP closure, release qualification, or delivery.

---

## Prompt

Act as the implementation-planning coordinator for the Ghatana Media repository at `/home/samujjwal/Developments/ghatana-media`. Produce a concrete, dependency-ordered Build implementation plan from the current, source-controlled product definition. Do not implement runtime features in this task.

### Campaign and stage

- Product/repository: Ghatana Media (`samujjwal/ghatana-media`).
- Campaign: complete the applicable product implementation represented by current PDP-0 through PDP-3 definitions across every currently registered physical leaf, meaningful composite, and root aggregate. Derive the denominator from current authority; do not reuse a count from an older plan.
- Macro stage: **BUILD**.
- Exact substage: **Plan Implementation** under the Kernel lifecycle (`KDEV-STAGE-PLAN-IMPLEMENTATION`).
- Release state: no Media app has been released. Plan only fresh product implementation; do not refer to the app as previously released or imply production operation.
- PDP closure, acceptance receipts, convergence, release, and delivery are separate lanes and out of scope for this planning task.

Begin the report with:

`Campaign scope | Source baseline | Macro stage | Exact substage | Physical/composite surface denominator | Prerequisite state | Permitted work`

Record the exact Git commit and worktree state used as the planning baseline. Record the current material-source fingerprint for the inputs you inspect. Do not report a plan as current if its source baseline is unknown.

### Mandatory entry checks

1. Read the repository `AGENTS.md`, `README.md`, `.product-experience/README.md`, and relevant nested agent instructions. Follow the repository's phase-locked protocol.
2. Read the canonical lifecycle stage definitions at `../ghatana-kernel/docs/spec-driven-development/kernel-development-lifecycle.yaml`, PDP authority at `../ghatana-kernel/docs/product-definition/README.md`, and PhaseProgram/ClosureUnit mechanics at `../ghatana-lifecycle/docs/architecture/PHASE_PROGRAM.md`. Use the repository's actual stage and phase identifiers; do not treat `PHASE-*` as a PDP phase.
3. Validate the Discovery exit barrier against all four current source-pinned status records:
   - `docs/implementation/pdp-0-phase-dev-status.json`
   - `docs/implementation/pdp-1-phase-dev-status.json`
   - `docs/implementation/pdp-2-phase-dev-status.json`
   - `docs/implementation/pdp-3-phase-dev-status.json`

   Use the repo's current readiness reporters and phase-specific validators, not the status label alone. Confirm each status is `DEV_COMPLETE`, its pins and required validation are current, and there are zero remaining definition tasks. Check current material sources, not generated reports alone. If any phase or surface is missing, stale, contradictory, or incomplete, stop Build planning for affected scope and report a read-only blocker with the owning PDP phase. Do not fix a PDP opportunistically inside Build planning.
4. If the barrier passes, treat the PDP definitions as frozen planning inputs. Reopen only the earliest materially affected PDP if direct inspection finds a real product-meaning or contract defect. Explain the exact defect and downstream impact separately; do not add implementation, testing, acceptance, or release work to a completed PDP.

### Sources to inspect

Read current authorities before relying on any previous plan or report:

- `.product-experience/surface-registry.yaml`, the physical/composite topology and crosswalk sources it references, `.product-experience/source-manifest.yaml`, `.product-experience/mandatory-surface-closure-matrix.yaml`, and the current applicability decisions.
- All current PDP source trees: `.product-experience/pdp-0-product-truth/`, `pdp-1-domain-data/`, `pdp-2-design-interface-system/`, and `pdp-3-product-experience/`, including stable capability, requirement, artifact, operation, screen, journey, step, channel, event, SDK, CLI, Agent Tool, service, and scenario identities.
- Current architecture and engineering guidance: `docs/ARCHITECTURE.md`, `docs/DESIGN.md`, `docs/REQUIREMENTS.md`, `docs/TESTING.md`, `docs/OPERATIONS.md`, and `docs/REPOSITORY-HYGIENE.md`.
- Actual implementation and build authorities: `settings.gradle.kts`, `build.gradle.kts`, Gradle version catalogs and properties, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `Cargo.toml`, `Cargo.lock`, module/package manifests, route manifests, OpenAPI contracts, protobuf definitions, migrations, Docker/compose definitions, and the code those files actually build.
- Existing tests and test fixtures that express behavior, but distinguish tests from product requirements and from runtime proof.
- Existing implementation plans only as leads to inspect. Reconcile every carried-forward claim against current code, current PDP identities, current build graph, and current repository policy. Older dates, completion labels, package IDs, counts, or plans are not authority by themselves. Keep the resulting plan self-contained and current; do not copy historical narrative into it.

Inspect the current canonical runtime/writer and any prepared mirror or composite checkout before assigning owners or file paths. Identify the one authorized implementation source for each runtime component and any required cutover/migration. Do not plan two competing writers or assume a proposed destination is authoritative.

### Required planning method

1. Inventory every current physical leaf, meaningful composite, root aggregate, and applicable consumer surface. Explicitly record applicability and source for any `N/A`; silence is not an exclusion. Deduplicate shared implementation dependencies without dropping consumer obligations.
2. Build a source-to-implementation trace from each applicable PDP capability/requirement and PDP-1/2/3 contract identity to its intended runtime, API, UI, SDK, CLI, event, service, or integration implementation. Include negative, unavailable, unauthorized, unknown, cancellation, retry, recovery, versioning, privacy, accessibility, and finality behavior wherever the source requires it.
3. Inventory existing implementation by source path and observed behavior. Classify each item as complete/reusable, partial, missing, conflicting, or unverified. Do not equate a package, UI preview, mock, simulator, generated client, or passing source validator with a functioning product capability.
4. Produce an acyclic dependency graph and executable sequence of thin end-to-end increments. Establish shared foundations before dependent verticals, but let independent verticals proceed in parallel where ownership and interfaces are clear. Every work package must have stable ID, exact PDP identities and surface IDs, accountable owner role, canonical source paths, dependency IDs, implementation outcomes, focused acceptance criteria, required test layers, external prerequisites, risks, and rollback/data-migration notes.
5. Re-derive and challenge any earlier package breakdown. Keep useful packages only when they still cover current definitions and source. Make the minimum number of packages needed for clear ownership and sequencing; do not preserve old IDs or counts for convenience.
6. Include cross-cutting plans for identity/authority and rights, artifact ingest/storage/versioning, durable jobs and cancellation/recovery, events/outbox, speech/audio, vision/video/multimodal, creation/rendering/simulation, UI and accessibility, public machine channels, privacy/retention/erasure, observability/security/performance/operations, and integration. Include a category only where current sources establish applicability.
7. Identify product behavior that cannot be implemented until a genuine owner, external provider, published dependency, hardware, data, or policy decision exists. Record its exact blocker and owner; do not invent approvals, SLO numbers, provider support, or attestations.
8. If using subagents, delegate bounded, non-overlapping read-only inventories or package analyses with explicit file ownership and source fingerprint. Reconcile all recommendations centrally before creating the final plan. Recommendations are not owner approvals or independent specialist certifications.

### Required deliverables

Create one current, canonical Build plan with:

- A short scope, baseline, Discovery barrier result, permitted stage, and out-of-scope transitions.
- A denominator table for physical leaves, composites, root aggregate, and consumer crosswalks, linked to their authority and showing applicability disposition.
- A per-surface implementation coverage matrix with: `surface ID/type | applicable PDP identities | implementation owner/package | current implementation state | remaining Build package IDs | dependency/blocker | acceptance criteria`.
- A requirement-to-package trace that covers every applicable current capability leaf, requirement, operation, screen, journey/step, and channel/consumer obligation. Report uncovered identities as explicit blockers, not implicit exclusions.
- A dependency-ordered work-package list and Mermaid DAG. Identify a first thin vertical slice that exercises the real authorized path end to end, followed by independent verticals and cross-cutting completion.
- For each package: stable ID, outcome, scope, exact source paths, inputs, dependencies, owner role, concurrency/write boundary, test levels and commands (as planning recommendations only), observable acceptance criteria, security/privacy/performance implications, external decisions, rollback/migration notes, and completion evidence expected during Build.
- A risk register focused on architectural seams, data migration, runtime ownership, missing dependencies, and testing environments. Distinguish planning uncertainty from a product-definition defect.
- A short execution sequence showing what can start first, what can run in parallel, what must wait, and what blocks later Build packages.
- A single source of truth for the plan. Identify documents that duplicate or contradict it; recommend removal or replacement only after checking links and repository hygiene requirements. Do not create another competing master plan.

Do not implement code, modify product definitions, run a release, claim acceptance or closure, or mark a surface `VERIFIED`, `PRODUCTION_QUALIFIED`, or `RELEASE_READY`. Build verification and development completion are future gates. Do not use `DEV_COMPLETE` as evidence that runtime implementation exists.

### Report ending

End with:

1. A per-surface Build planning matrix using the required fields above.
2. `Discovery barrier status: PASS/FAIL/UNKNOWN` with source record references.
3. `Build lane: PLANNED/NOT ENTERED/BLOCKED` and the exact reason.
4. `PDP closure lane: SEPARATE / NOT PERFORMED`.
5. `Delivery gate: BLOCKED / NOT ENTERED` until its independent prerequisites are met.
6. `Next allowed action` and the first package that may legally enter implementation.

Keep claims tied to current files and validators. Separate observed implementation, authored definition, validation, owner approval, PDP closure, Build completion, and release qualification.

---

## Current repository stack (manifest-derived orientation)

The coordinator should refresh these details from manifests during planning. Current evidence identifies a polyglot stack: Gradle Kotlin DSL and Java 21 JVM services; Node.js with pnpm 10 and TypeScript packages; React 19 and Vite for browser UI; a Rust 2021 Cargo audio utility crate; gRPC/Protocol Buffers and OpenAPI HTTP contracts; PostgreSQL/JPA-Hibernate/Flyway/HikariCP and AWS S3 providers; and tests using JUnit 5, Vitest, Node's test runner, Playwright, and Testcontainers. This is an orientation summary, not a substitute for inspecting the locked versions, actual dependency graph, or production-admitted runtime components.
